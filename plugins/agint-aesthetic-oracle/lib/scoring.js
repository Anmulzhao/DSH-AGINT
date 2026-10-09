/**
 * agint-aesthetic-oracle: 评分纯函数模块（v2.3 方案 §3 / §4；公式 r2，2026-10-09）。
 *
 * 纯函数：输入原子值 → 输出四指标 + 美总分 + 美之三问。零 I/O、零服务访问、
 * 零 LLM——公式是确定性的，任何人拿到同样的原子值必须算出同样的分数。
 * 公式 r2 三处修复（提案 f51d3280，老板 2026-10-09 批准）：
 *   1. bloat 扣分加上界（BLOAT_SATURATION=1.5，修复无界线性罚）
 *   2. Q1 加效应量门槛（EFFECT_EPSILON，消除日抖动判定翻转）
 *   3. Q2 改 ratio 排序（归因与维度权重解耦）
 *
 * 分层纪律（方案 C / §9.4 的对偶面）：
 *   - 原子观测归 agint-metrics（summary()/series() 的 key + meta）
 *   - 复合派生（本文件）归神谕层；noise_ratio / aesthetic_score 永远不进 metrics
 *
 * v2.3 语义修复的落点（对照评审 P0/P1）：
 *   - §3.1 噪声比（P0-2）：分子 = 「在系统内」的无引用/无证据/重复条目；
 *     REJECTED 候选是门禁正常工作的证据，不进分子
 *   - §3.2 决策确信度：AVG(conf × evidence_compliance)，逐条相乘（不是均值×覆盖率）
 *   - §3.3 冗余度（P1-7）：三域合并公式，分子分母同口径
 *   - §3.4 臃肿度：预算 120KB = 11 技能 × 8-12KB（prompt 工程经验值）
 *   - §4 Q1（P1-4）：恶化≥2→丑；恶化<2 且改善≥3→美；其余→持平（全排序无洞）
 */

/**
 * 评分公式版本（2026-10-09 三连修复起引入）。广播 payload 透传，用于历史趋势
 * 分段解读：版本切换前后的总分不可直接比。
 *   r2：bloat 扣分加上界（min(...,1.5)，修复总分可为负的无界罚）；
 *       Q1 加效应量门槛 ε（消除日抖动导致的判定翻转）；
 *       Q2 改按 ratio（deduction/maxWeight）排序（归因与权重解耦）。
 */
export const FORMULA_VERSION = 'r2';

// ── 阈值常量（v2.3 §3 标定；改这里 = 改判尺，须走评审）────────────────────

export const THRESHOLDS = {
  /** 噪声比阈值（§3.1）。 */
  NOISE_RATIO: 0.30,
  /** 决策确信度下限（§3.2）。 */
  CONFIDENCE: 0.70,
  /** 冃度阈值（§3.3）。 */
  REDUNDANCY: 0.05,
  /** 臃肿度预算字节：120KB（§3.4，11 技能 × 8-12KB）。 */
  BLOAT_BUDGET_BYTES: 120 * 1024,
  /** 臃肿度扣分饱和倍数：b=2.5 倍预算后不再加倍扣（r2：修复无界罚）。 */
  BLOAT_SATURATION: 1.5,
};

/**
 * Q1 效应量门槛（r2）：|Δ| 低于该值的维度视为持平，不计入恶化/改善。
 * 取各维阈值的 10%——日频指标在阈值 10% 内的波动无行动意义。
 */
export const EFFECT_EPSILON = {
  noise: 0.03,
  confidence: 0.07,
  redundancy: 0.005,
  bloat: 0.1,
};

/** 四维权重（§3.6 权重累减结构：避免一项满分掩盖四项差）。 */
export const DIM_WEIGHTS = {
  noise: 30,
  confidence: 20,
  redundancy: 20,
  bloat: 30,
};

export const DIM_KEYS = ['noise', 'confidence', 'redundancy', 'bloat'];

/**
 * Q3 无真实证据可依时的诚实占位（§4 真实关：建议必须绑定 lint 证据，
 * 查不到就明说，不许兜底编一句）。调用方（renderReport / buildWeeklyProposals /
 * L1 措辞增强）见它即知「本日无可执行建议」——渲染原样透出，提案跳过，
 * LLM 不再拿它润色。
 */
export const NO_ADVICE = '本日无可执行建议';

const round = (n, d = 4) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ── §3 派生：原子值 → 四个复合比率 ─────────────────────────────────────────

/**
 * 从原子值派生四指标。任一所需原子缺席 → 该指标 { na: true }（广播降 N/A，
 * 总分权重归一，AC-4）。
 *
 * @param {object} a 原子值
 * @param {number} [a.wikiOrphans] wiki 无入链条目数
 * @param {number} [a.wikiContradictions] wiki 矛盾标记数
 * @param {number} [a.ruleDuplicates] rule_lint 命中的 duplicate-pattern 数
 * @param {number} [a.memoryNoEvidence] memory evidence 顶层字段为空的条数
 * @param {number} [a.wikiTotal] wiki 全量页数
 * @param {number} [a.rulesTotal] 规则全量数
 * @param {number} [a.memoryTotal] memory 全量条数
 * @param {number} [a.avgConfXCompliance] Σ(conf×[evidence非空])/N（metrics meta 增补）
 * @param {number} [a.curatorOverlaps] curator 判定的技能重叠对数（可缺省 0；
 *   Day 0 未入 metrics 原子表，当前实测恒 0，接入路径 = metrics-ext 后续增 key）
 * @param {number} [a.skillsTotal] SKILL.md 个数（冗余度分母）
 * @param {number} [a.skillsBytes] Σ SKILL.md 字节（臃肿度分子）
 * @returns {{noise: object, confidence: object, redundancy: object, bloat: object}}
 */
export function deriveComposites(a = {}) {
  const na = (reason) => ({ value: null, na: true, reason });

  // noise = (orphans + contradictions + duplicates + noEvidence) / (wiki+rules+memory)
  let noise;
  {
    const numParts = [a.wikiOrphans, a.wikiContradictions, a.ruleDuplicates, a.memoryNoEvidence];
    const denParts = [a.wikiTotal, a.rulesTotal, a.memoryTotal];
    if (numParts.every(isNum) && denParts.every(isNum)) {
      const num = numParts.reduce((s, v) => s + v, 0);
      const den = denParts.reduce((s, v) => s + v, 0);
      noise = den > 0
        ? { value: round(num / den), na: false, numerator: num, denominator: den }
        : na('分母为 0（wiki/rules/memory 全空）');
    } else {
      noise = na('原子值缺席（wiki.orphans / wiki.contradictions / rules.lintIssues / memory.total）');
    }
  }

  // confidence = AVG(conf × compliance)——metrics 已按逐条口径聚合（avgConfXCompliance）
  const confidence = isNum(a.avgConfXCompliance)
    ? { value: round(a.avgConfXCompliance), na: false }
    : na('avgConfXCompliance 缺席（memory.list 不可用）');

  // redundancy = (duplicates + contradictions + curator_overlaps) / (rules+wiki+skills)
  let redundancy;
  {
    const overlaps = a.curatorOverlaps ?? 0;
    const numParts = [a.ruleDuplicates, a.wikiContradictions, overlaps];
    const denParts = [a.rulesTotal, a.wikiTotal, a.skillsTotal];
    if (numParts.every(isNum) && denParts.every(isNum)) {
      const num = numParts.reduce((s, v) => s + v, 0);
      const den = denParts.reduce((s, v) => s + v, 0);
      redundancy = den > 0
        ? { value: round(num / den), na: false, numerator: num, denominator: den }
        : na('分母为 0（rules/wiki/skills 全空）');
    } else {
      redundancy = na('原子值缺席（rulesTotal / wikiTotal / skillsTotal）');
    }
  }

  // bloat = Σbytes / 120KB（不 clamp：超预算线性扣分）
  const bloat = isNum(a.skillsBytes)
    ? { value: round(a.skillsBytes / THRESHOLDS.BLOAT_BUDGET_BYTES), na: false, bytes: a.skillsBytes, budget: THRESHOLDS.BLOAT_BUDGET_BYTES }
    : na('skillsBytes 缺席（skills 文件系统不可达）');

  return { noise, confidence, redundancy, bloat };
}

// ── §3.6 评分：四比率 → 美总分（N/A 权重归一）──────────────────────────────

/**
 * 扣分计算（单维）。返回 null 表示该维 N/A 不参与。
 *   noise      : 30 × min(nr / 0.30, 1)
 *   confidence : 20 × max((0.70 − c) / 0.70, 0)
 *   redundancy : 20 × min(r / 0.05, 1)
 *   bloat      : 30 × min(max(0, b − 1), 1.5)（r2：饱和于 2.5 倍预算，
 *                修复无界线性罚——旧公式 b=3 扣 60、b=4 扣 90，总分可为负
 *                且 bloat 以绝对优势碾压 Q2 归因）
 */
export function dimDeduction(key, value) {
  const T = THRESHOLDS;
  switch (key) {
    case 'noise': return DIM_WEIGHTS.noise * Math.min(value / T.NOISE_RATIO, 1);
    case 'confidence': return DIM_WEIGHTS.confidence * Math.max((T.CONFIDENCE - value) / T.CONFIDENCE, 0);
    case 'redundancy': return DIM_WEIGHTS.redundancy * Math.min(value / T.REDUNDANCY, 1);
    case 'bloat': return DIM_WEIGHTS.bloat * Math.min(Math.max(0, value - 1), T.BLOAT_SATURATION);
    default: return null;
  }
}

/**
 * 美总分（§3.6）。可用维度扣分按权重占比归一回 100 分制（AC-4：缺 key 时
 * 广播仍输出，公式重新归一到剩余维度）：
 *   score = 100 − Σded × (100 / ΣmaxWeight_available)
 * 全维可用时 ΣmaxWeight=100，退化为原公式。
 *
 * @returns {{score: number, dims: object, availableDims: string[], naDims: string[], renormalized: boolean}}
 */
export function computeAestheticScore(composites) {
  let sumDed = 0;
  let sumMaxW = 0;
  const dims = {};
  const availableDims = [];
  const naDims = [];
  for (const key of DIM_KEYS) {
    const c = composites?.[key];
    if (!c || c.na || !isNum(c.value)) {
      dims[key] = { available: false, deduction: null, maxWeight: DIM_WEIGHTS[key] };
      naDims.push(key);
      continue;
    }
    const ded = dimDeduction(key, c.value);
    dims[key] = { available: true, value: c.value, deduction: round(ded), maxWeight: DIM_WEIGHTS[key] };
    sumDed += ded;
    sumMaxW += DIM_WEIGHTS[key];
    availableDims.push(key);
  }
  if (availableDims.length === 0) {
    return { score: null, dims, availableDims, naDims, renormalized: false, note: '四维全部 N/A，无分可打' };
  }
  const renormalized = sumMaxW !== 100;
  const score = round(100 - sumDed * (100 / sumMaxW), 1);
  return { score, dims, availableDims, naDims, renormalized };
}

// ── §4 美之三问 ─────────────────────────────────────────────────────────────

/**
 * Q1：这件事让系统更美了吗？（§4 v2.3 判定，P1-4 修复）
 *
 *   恶化项数 ≥ 2            → 「在变丑」
 *   恶化项数 < 2 且改善 ≥ 3  → 「在变美」
 *   其余                     → 「持平」
 *
 * 恶化/改善按维定义：noise ↑ = 恶化；confidence ↓ = 恶化；redundancy ↑ = 恶化；
 * bloat ↑ = 恶化。N/A 维不参与计数。基线缺席 → 持平（附注）。
 *
 * r2 效应量门槛：|Δ| < EFFECT_EPSILON[key] 的维度视为持平，不计入恶化/改善
 * ——旧公式 4 位小数非零即计数，噪声比 0.0405→0.0406 就算「恶化一维」，
 * 日频指标天然抖动会让 Q1 在「持平/变丑」间随机翻转。
 *
 * @param {object} current composites（deriveComposites 输出）
 * @param {object|null} baseline composites（首周基线；null = 未建立）
 */
export function q1Verdict(current, baseline) {
  if (!baseline) {
    return { verdict: 'flat', worseCount: 0, betterCount: 0, note: '基线未建立（首周起算）' };
  }
  const worseDims = { noise: 'up', confidence: 'down', redundancy: 'up', bloat: 'up' };
  let worseCount = 0;
  let betterCount = 0;
  const worseList = [];
  const betterList = [];
  for (const key of DIM_KEYS) {
    const c = current?.[key];
    const b = baseline?.[key];
    if (!c || c.na || !isNum(c.value) || !b || b.na || !isNum(b.value)) continue;
    const diff = round(c.value - b.value);
    const eps = EFFECT_EPSILON[key] ?? 0;
    if (Math.abs(diff) < eps) continue; // r2：阈下波动视为持平
    const worsening = worseDims[key] === 'up' ? diff > 0 : diff < 0;
    if (worsening) { worseCount += 1; worseList.push(key); } else { betterCount += 1; betterList.push(key); }
  }
  let verdict;
  if (worseCount >= 2) verdict = 'ugly';
  else if (worseCount < 2 && betterCount >= 3) verdict = 'beautiful';
  else verdict = 'flat';
  return { verdict, worseCount, betterCount, worseList, betterList, note: null };
}

export const Q1_VERDICT_TEXT = {
  beautiful: '在变美',
  ugly: '在变丑',
  flat: '持平',
};

/**
 * Q2：这件事最丑的地方在哪？（§4：指到指标级 + 来源）
 * r2：排序键 = **偏离度 ratio**（deduction / maxWeight），不是绝对扣分。
 * 旧口径按绝对扣分排序，noise/bloat（权重 30）天然压过 confidence/redundancy
 * （权重 20）——归因被权重差绑架。ratio 让「最丑」= 离自己阈值最远，
 * 与维度权重解耦。N/A 维不参与。
 */
export function q2Worst(composites, dims) {
  let worst = null;
  for (const key of DIM_KEYS) {
    const d = dims?.[key];
    const c = composites?.[key];
    if (!d?.available || !c || !isNum(c.value)) continue;
    const ratio = d.deduction / DIM_WEIGHTS[key];
    if (!worst || ratio > worst.ratio) {
      worst = {
        key,
        value: c.value,
        deduction: d.deduction,
        maxWeight: DIM_WEIGHTS[key],
        ratio: round(ratio),
      };
    }
  }
  return worst;
}

/**
 * Q3：建议怎么做才能更美？（§4 映射表，四条全量；纯机械动作 + 必附证据）
 *
 * ⛔ §4 真实关（2026-09-29 修复）：建议必须绑定真实 lint 证据——
 * 每条建议先查 ctx 里的实际清单，查不到就输出 NO_ADVICE（「本日无可执行
 * 建议」），不许兜底编一句。例：redundancy 最丑但 rule_lint 0 命中时，旧
 * 逻辑仍输出「合并 rule_lint 命中的 duplicate 规则」（编造）；现在先看
 * wiki 矛盾 / curator 重叠的真实分子，全空才回 NO_ADVICE。
 *
 * @param {string} worstKey q2Worst().key
 * @param {object} ctx 证据上下文（各清单；缺了相应字段就降级为机制引用）
 */
export function q3Advice(worstKey, ctx = {}) {
  switch (worstKey) {
    case 'noise': {
      const ids = Array.isArray(ctx.memoryNoEvidenceIds) ? ctx.memoryNoEvidenceIds : null;
      const orphanList = Array.isArray(ctx.wikiOrphanFiles) ? ctx.wikiOrphanFiles : null;
      const noEvCount = isNum(ctx.memoryNoEvidenceCount) ? ctx.memoryNoEvidenceCount : 0;
      if (noEvCount > 0) {
        const detail = ids
          ? `（id 清单${ids.length >= 50 ? '前 50 条' : ''}：${ids.slice(0, 50).join(', ')}）`
          : '';
        return { advice: `为 ${noEvCount} 条无 evidence 记忆补证据${detail}`, evidence: 'memory 表 evidence 字段扫描' };
      }
      if (orphanList && orphanList.length > 0) {
        return {
          advice: `归档 wiki orphans（${orphanList.slice(0, 10).join('、')}${orphanList.length > 10 ? ' …' : ''}）`,
          evidence: 'wiki_lint 报告（orphans 明细）',
        };
      }
      return {
        advice: NO_ADVICE,
        evidence: `noise 分子实测：${noEvCount} 条无证据记忆 / ${orphanList?.length ?? 0} 个 wiki 孤儿 / 0 条重复规则`,
      };
    }
    case 'redundancy': {
      const issues = Array.isArray(ctx.ruleLintIssues) ? ctx.ruleLintIssues : [];
      const dups = issues.filter((i) => i?.kind === 'duplicate-pattern');
      if (dups.length > 0) {
        const pairs = dups.map((i) => `${i.ruleId}+${i.with}`).join(', ');
        return {
          advice: `合并 rule_lint 命中的 duplicate 规则${pairs ? `：${pairs}` : ''}`,
          evidence: 'rule_lint issues 明细',
        };
      }
      const contradFiles = Array.isArray(ctx.wikiContradictionFiles) ? ctx.wikiContradictionFiles : [];
      if (contradFiles.length > 0) {
        const names = contradFiles.slice(0, 5).join('、');
        return {
          advice: `解决 wiki 矛盾标记（${contradFiles.length} 处：${names}${contradFiles.length > 5 ? ' …' : ''}）`,
          evidence: 'wiki_lint contradictions 明细',
        };
      }
      const overlaps = isNum(ctx.curatorOverlaps) ? ctx.curatorOverlaps : 0;
      if (overlaps > 0) {
        return { advice: `归档 curator 判定的 ${overlaps} 对重叠技能`, evidence: 'curator overlaps 明细' };
      }
      return {
        advice: NO_ADVICE,
        evidence: `redundancy 分子实测：${dups.length} 条重复规则 / ${contradFiles.length} 处 wiki 矛盾 / ${overlaps} 对 curator 重叠`,
      };
    }
    case 'confidence': {
      const rows = Array.isArray(ctx.lowConfidenceNoEvidence) ? ctx.lowConfidenceNoEvidence : [];
      if (rows.length === 0) {
        return { advice: NO_ADVICE, evidence: '无证据条目清单为空，无具体条目可复核' };
      }
      // 口径对齐（2026-10-08）：rows 来自 metrics 的 noEvidence.ids，即
      // 「evidence 为空」的条目 id，**不含逐条 confidence**（avgConfXCompliance
      // 只给均值）。故此处只承诺「无证据」，不得升格为「低置信且无证据」。
      const head = '定向复核无证据的记忆条目';
      const detail = `（${rows.slice(0, 10).join(', ')}${rows.length > 10 ? ' …' : ''}）`;
      return { advice: `${head}${detail}`, evidence: 'memory id 清单（evidence 为空；confidence 未逐条下发，故不宣称低置信）' };
    }
    case 'bloat': {
      const bytes = isNum(ctx.skillsBytes) ? ctx.skillsBytes : null;
      if (bytes === null || bytes <= THRESHOLDS.BLOAT_BUDGET_BYTES) {
        return { advice: NO_ADVICE, evidence: `skillsBytes 实测 ${bytes ?? '?'} / 预算 ${THRESHOLDS.BLOAT_BUDGET_BYTES}，未超限` };
      }
      return {
        advice: `归档 curator 判定陈旧/重叠的技能（当前 ${bytes} 字节 / 预算 ${THRESHOLDS.BLOAT_BUDGET_BYTES}）`,
        evidence: 'curator overlaps / 陈旧检测输出',
      };
    }
    default:
      return { advice: NO_ADVICE, evidence: `未知最丑维度 ${worstKey}，无可执行建议` };
  }
}

/**
 * 一步到位：原子值 → 完整美评结构（派生 + 总分 + 三问）。
 * 供 broadcast.js 与标定脚本共用——保证「测的就是跑的」。
 */
export function evaluateAesthetics(atomic, { baseline = null, adviceCtx = {} } = {}) {
  const composites = deriveComposites(atomic);
  const scored = computeAestheticScore(composites);
  const verdict = q1Verdict(composites, baseline);
  const worst = scored.score !== null ? q2Worst(composites, scored.dims) : null;
  const advice = worst ? q3Advice(worst.key, adviceCtx) : { advice: null, evidence: null };
  return { composites, scored, verdict, worst, advice };
}
