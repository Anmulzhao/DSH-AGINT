/**
 * agint-curriculum: replay-guard（提案 10d2d87f）——「换个说法填两遍」防复读护栏。
 *
 * 背景（生产实测 2026-11-17）：
 *   - clg_20261008 / clg_20261015 / clg_20261022 三个 challenge 的 prompt 逐字相同
 *     （integration D1「把「让前端表单调用后端 API 并处理失败」拆解成集成步骤清单。」），
 *     三个都 pass，连续 pass 把 integration 灌到 D5 上限、consecutivePass=6。
 *   - clg_20261112 两次 pass（10:33 / 10:48）的 steps 逐字完全相同 —— 原样复读。
 *   - 判定器 verdict.js:assertStepList 只查「步数 ≥ minLength + 拼串含全部关键词」，
 *     分不出「真解题」与「同义反复 / 原样复读」。
 *
 * 本模块是**纯函数**，不碰存储、不依赖 ctx，供 index.js 的 submit 路径调用。
 * 四道护栏（提案 4 方案）：
 *   [1] 题面实例去重（核心护栏，提案自认「真正的护栏」）：
 *       同 domain+level+prompt 的第 2 次及以后 pass 不计入能力成功数。
 *   [2] 语义多样性下界：关键词须分布在不同步骤（每步最多贡献一个关键词）。
 *       ⚠️ 有误杀风险 → 只作信号（flags），不改变 pass/fail；是否据此拒收由上层配置项
 *       strict_distribution 决定，默认关。
 *   [3] 承接关系线索（先/再/然后/若…则…）：同样只作信号，默认不否决。
 *       LLM 判据（提案原话「附加信号而非替换」）不在本模块实现 —— 违反纲领 §9.5
 *       「评分链路永久零 LLM」，留给将来单独拍板；本模块提供确定性替代信号。
 *   [4] 判据指纹：steps 规范化（小写/去标点/去空白/去数字串）后哈希，
 *       历史 pass 出现相同指纹 ⇒ 原样复读，不计成功。
 *
 * 存量兼容（提案风险章节硬要求）：
 *   本模块只对**本次新提交**判定，不回溯改写任何历史 attempt / difficulty。
 *   每个检测项都在 attempt 上留 `replay` 标记（result 仍是 pass，事实不变），
 *   由 index.js 决定该 pass 是否计入 consecutivePass / 能力成功数。
 */

import { createHash } from 'node:crypto';

// ── 规范化 / 指纹 ───────────────────────────────────────────────────────

/**
 * steps 规范化 → 稳定指纹。
 *
 * 规范化强度（提案方案 4「去标点、去空白、小写化」再加一层抗数字串噪声）：
 *   - 小写化（英文大小写差异不算新答案）
 *   - 去所有标点 / 符号 / 空白（含中日韩标点，用 Unicode 属性类）
 *   - 去纯数字串（生产 steps 里混入的实测毫秒数 / 计数会干扰指纹，如「50ms→100ms」）
 *
 * ⛔ 只挡「原样复读 / 轻微排版变化」，挡不住「同义改写」——这是设计边界，
 *    真正的护栏是方案 1（题面实例计数），不是指纹。别把指纹当万能。
 */
export function stepsFingerprint(steps) {
  if (!Array.isArray(steps) || !steps.every((s) => typeof s === 'string')) return null;
  const normalized = steps
    .join(' ')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '')   // 去标点 / 符号 / 空白
    .replace(/\d+/g, '');                 // 去纯数字串（实测计数噪声）
  if (!normalized) return null;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * 从一次提交的 evidence 里取 steps（兼容参数层的数组包装，与 tools.js 同口径）。
 */
export function stepsOf(evidence) {
  let raw = evidence?.steps;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const keys = Object.keys(raw);
    const arrayKeys = keys.filter((k) => Array.isArray(raw[k]));
    if (arrayKeys.length === 1) return raw[arrayKeys[0]];
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      return keys.sort((a, b) => Number(a) - Number(b)).map((k) => raw[k]);
    }
  }
  return null;
}

// ── 方案 2/3：确定性附加信号（只报 flags，不改 verdict）──────────────────

const TRANSITION_RE = /(先|再|然后|接着|随后|之后|之前|若|则|最后|第一步|第二步|第一步|phase|then|after|before|finally|if\b.*\bthen\b)/i;

/**
 * 计算语义多样性 / 承接关系的**信号**，不改 pass/fail（零误杀承诺）。
 * @returns {{ keywordSteps: object, maxPerStep: number, transitionHits: number, flags: string[] }}
 */
export function diversitySignals(spec, steps) {
  const flags = [];
  const keywords = Array.isArray(spec?.expected) ? spec.expected.map(String) : [];
  const joined = steps.map((s) => s.toLowerCase());

  // 关键词 → 命中的步骤下标集合（同一步重复命中只算 1 步）
  const keywordSteps = {};
  for (const kw of keywords) {
    const needle = kw.toLowerCase();
    keywordSteps[kw] = [];
    joined.forEach((line, i) => {
      if (line.includes(needle)) keywordSteps[kw].push(i);
    });
  }

  // 每步贡献了几个不同关键词 → maxPerStep
  const perStep = steps.map((_, i) => keywords.filter((kw) => keywordSteps[kw].includes(i)).length);
  const maxPerStep = perStep.reduce((m, n) => Math.max(m, n), 0);
  if (keywords.length >= 2 && maxPerStep >= 2) {
    flags.push(`关键词集中：单一步骤贡献了 ${maxPerStep} 个必需关键词（疑似同义反复）`);
  }

  // 承接线索命中数（弱信号：只记数，不设阈值否决）
  const transitionHits = steps.filter((s) => TRANSITION_RE.test(s)).length;

  return { keywordSteps, maxPerStep, transitionHits, flags };
}

// ── 方案 1 + 4：复读判定（核心）─────────────────────────────────────────

/**
 * 判定一次 pass 是否为「复读」（应不计入能力成功数）。
 *
 * @param {object} args
 * @param {object} args.challenge      当前提交的 challenge（含 id/domain/level/prompt）
 * @param {object} args.evidence       当前 evidence（已由 verdict 规范化）
 * @param {Array}  args.priorPasses    历史 pass attempt 列表，每条需含
 *                                     { id, challengeId, domain, level, prompt, evidence, verifiedAt }
 *                                     —— 由 index.js 从 attempts 表 join challenges 表组装
 * @param {object} args.spec           challenge.verifySpec（方案 2 信号用）
 * @param {object} args.config          { fingerprintEnabled, promptDedupEnabled }
 * @returns {{ isReplay:boolean, kind:string|null, reasons:string[], fingerprint:string|null,
 *             signals:object|null, matchedAttemptId:string|null }}
 */
export function detectReplay({
  challenge,
  evidence,
  priorPasses = [],
  spec = {},
  config = {},
} = {}) {
  const { fingerprintEnabled = true, promptDedupEnabled = true } = config;
  const reasons = [];
  const result = {
    isReplay: false,
    kind: null,
    reasons,
    fingerprint: null,
    signals: null,
    matchedAttemptId: null,
  };

  const steps = stepsOf(evidence);
  const fp = stepsFingerprint(steps);

  // ── 方案 4：判据指纹（原样复读）──────────────────────────────────────
  if (fingerprintEnabled && fp) {
    result.fingerprint = fp;
    const sameFp = priorPasses.find((p) => stepsFingerprint(stepsOf(p.evidence)) === fp);
    if (sameFp) {
      result.isReplay = true;
      result.kind = 'fingerprint';
      result.matchedAttemptId = sameFp.id ?? sameFp.challengeId ?? null;
      reasons.push(`原样复读：steps 指纹 ${fp} 与历史 pass ${result.matchedAttemptId ?? '（未知）'} 相同`);
    }
  }

  // ── 方案 1：题面实例去重（换说法填两遍，核心护栏）────────────────────
  // 口径：同 domain+level+prompt 的第 2 次及以后的 pass 不计成功。
  // 注意：history 里不含本次（index.js 在判定前查表），故「已有 1 条 = 本次是第 2 次」。
  if (promptDedupEnabled && !result.isReplay) {
    const samePrompt = priorPasses.filter((p) =>
      p.domain === challenge?.domain
      && p.level === challenge?.level
      && p.prompt === challenge?.prompt);
    if (samePrompt.length >= 1) {
      result.isReplay = true;
      result.kind = 'duplicate-prompt';
      result.matchedAttemptId = samePrompt[0].id ?? samePrompt[0].challengeId ?? null;
      reasons.push(
        `题面复读：同题面（${challenge?.domain}·${challenge?.level}）已有 ${samePrompt.length} 条历史 pass`
        + `（逐字相同 prompt），本次为第 ${samePrompt.length + 1} 次，不计能力成功`,
      );
    }
  }

  // ── 方案 2/3：确定性附加信号（默认只记 flags，不改 isReplay）──────────
  if (Array.isArray(steps)) {
    result.signals = diversitySignals(spec, steps);
  }

  return result;
}

export const REPLAY_KINDS = Object.freeze(['fingerprint', 'duplicate-prompt']);
