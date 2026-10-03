/**
 * agint-evolution-driver —— 闭环引擎的驱动源（变异构造器）
 *
 * ## 它补的是哪个洞
 *
 * `agint-mutator` 的设计红线是「不调真 LLM」：它只负责**登记与执行**变异，
 * 变异内容（`oldText → newText`）必须由 caller 提供。而全仓从来没有人写过这个
 * caller —— 于是 mutator / population 两个插件挂载了、测试绿了，生产里一次都没跑过
 * （见 `docs/known-limitations/evolution-main-chain-not-energized.md`）。
 *
 * 本插件就是那个 **caller**：
 *
 * ```
 * agint.evolve 的 proposed 提案（真实、人工审核过的改进点）
 *   → 定位目标资产（preset skills 的 SKILL.md ／ 仓库文件 —— 2026-09-27 老板拍板开放改仓库代码）
 *   → spawn subagent（真 LLM）生成 oldText → newText
 *   → 硬校验：oldText 必须真实存在于原文（防幻觉）
 *   → agint.mutator.propose()  → validate()
 *   → agint.population.ingest()   （走 policy gate）
 *   → 发布 evolution.mutation.proposed
 *   → commit：写回仓库正本（preimage 备份 + git 可回滚 + 事件留痕）
 * ```
 *
 * ## 边界（三条红线，改代码前先读）
 *
 * 1. **commit 写仓库正本，不写部署位**（部署位 install.sh 会镜像覆盖，写了白写）。
 *    仓库根 repoRoot 解析优先级：env `AGINT_EVOLUTION_DRIVER_REPO_ROOT` > patch config
 *    `repoRoot` > 不 commit。落盘四保险：**preimage 备份**（`.agint-preimage/`）、
 *    git 工作区天然可 diff/checkout 回滚、事件 `evolution.mutation.committed` 留痕、
 *    以及 2026-09-29 补上的**写入后 D-QAF 验证**（`sandbox.runSmoke` → `policy.decide`
 *    → REJECT/ABSTAIN 从 preimage 回滚）。
 *    总开关 `AGINT_EVOLUTION_DRIVER_COMMIT=off` 可关（2026-09-27 老板拍板开放改仓库后
 *    默认开 —— K51「可回滚 > 可审批、kill-switch ≠ 默认关」）。
 *
 *    ⛔ **fail-closed**：`sandbox` / `policy` 任一不可用 ⇒ 根本不写仓库，只发
 *    `evolution.mutation.commit-skipped`。理由：本插件的 commitToRepo 走的是自己的落盘
 *    路径（不经过 `mutator.commit`），若验证通道缺失还照写，就等于 AGENTS.md 明令禁止的
 *    「绕过 D-QAF 任意阶段直接部署」。「没有验证能力就不改仓库」是硬约束，不是降级策略。
 * 2. **不自己造变异内容。** 内容一律来自 LLM 的结构化输出，且 oldText 必须能在原文里
 *    找到（且唯一）；找不到就放弃本次（记 degraded），绝不写入"看起来像"的文本。
 * 3. **全软依赖。** inject=[]，bundle apply 顺序不保证 ⇒ runtime 必须**调用时** ctx.get，
 *    不许在 apply() 里缓存。
 *
 * ## kill-switch
 *
 * `AGINT_EVOLUTION_DRIVER=off` → runOnce 直接返回 skipped。出厂即开。
 */

import { randomUUID } from 'node:crypto';

import { findFabricatedEntities, buildCodeIndex } from './entity-gate.js';
import { createLedgerWriter, pluginFromPath } from './ledger-writer.js';
import { createPredictionLocker } from './prediction-locker.js';
import { createOutcomeMeasurer, DEFAULT_OUTCOME_LIMIT } from './outcome-measurer.js';
import { expectedEffectForTarget } from './expected-effect.js';
import { resolveTargetMetric } from './metric-resolver.js';
import {
  isGoalBridgeEnabled,
  buildGoalObjective,
  createEvolutionGoal,
  GOAL_BRIDGE_ENV,
} from './goal-bridge.js';

// ── 常量 ────────────────────────────────────────────────────────────────

const KILL_ENV = 'AGINT_EVOLUTION_DRIVER';
const COMMIT_ENV = 'AGINT_EVOLUTION_DRIVER_COMMIT';
const REPO_ENV = 'AGINT_EVOLUTION_DRIVER_REPO_ROOT';
const ENTITY_GATE_ENV = 'AGINT_EVOLUTION_DRIVER_ENTITY_GATE';
const DEFAULT_TIMEOUT_MS = 120_000;
// 2026-09-27 v0.2.2：6000 → 20000。实测 metrics.js 7334B 被截断，而提示词声称
// "verbatim text of one target file" —— LLM 看不到尾部却以为看全了，会误判
// not applicable；若 oldText 恰在截断点之后还会触发幻觉闸门误伤。
const DEFAULT_SNIPPET = 20_000;
const MAX_CANDIDATES = 5;
/** commit 拒绝写入的路径（任何位置命中即拒）：挂载配置与 git 内部绝不碰。 */
const COMMIT_DENYLIST = ['cordis.patch.yml', '.git/', 'node_modules/'];
const REPO_SCAN_IGNORES = new Set([
  '.git', 'node_modules', '.workbuddy', 'dist', 'build', 'coverage',
  '.agint-preimage', '.DS_Store',
]);
const REPO_SCAN_MAX_FILES = 3000;
// 实体存在性门（v0.2.4 / 抽模块 v0.2.5）：判据与代码索引在 ./entity-gate.js（单一事实源）。

/**
 * ⭐⭐ 子代理必须显式带 preset —— 这是 2026-09-27 用 30 个空壳会话换来的硬知识。
 *
 * 现象：`agents.create()` 只传 `{sessionId, meta:{cwd,origin}, signal}` 也能成功，
 * 会话文件照样落盘、subagent.identity.label 照样写上 —— **看起来完全正常**。
 * 但 child 的 `agentPreset=null` ⇒ `modelSelection={lastUsed:null}` ⇒
 * 没有任何模型路由 ⇒ turnOutline 的 prompt/response 都是空串、contextPressure=0。
 * 结果：会话建得出来，一步都跑不动，且**不报错**（静默空壳）。
 *
 * 本机实证：成功会话 `agentPreset:"agint"` + `modelSelection: minimax-cn/MiniMax-M3`；
 * 空壳 `agentPreset:null` + `modelSelection:null`。差别只有这一个字段。
 *
 * ⛔ 不要因为这个字段"看着像可选"就省掉它：meta.agentPreset 在类型上是可选的，
 *    但对 host plane 凭空 create 的临时 parent 来说，它是模型路由的唯一来源。
 */
export const DEFAULT_AGENT_PRESET = 'agint';
// 兜底 provider/model：仅在宿主服务 agentDefaultModel 不可用时使用。
// 值与 dream 的 DEFAULT_PROVIDER/MODEL 同源（本机 ~/.dsh 实测 minimax-cn / MiniMax-M3），
// ⛔ deepseek 在本机只是 fallback adapter，别写它（K99）。
const DEFAULT_LLM_PROVIDER = 'minimax-cn';
// 2026-09-28：host 已把 minimax-cn 注册模型换成 MiniMax-M3.1-Flash-Preview
// （cordis.patch.yml llm-pi-ai.providers.minimax-cn.models 只剩这一条）。
const DEFAULT_LLM_MODEL = 'MiniMax-M3.1-Flash-Preview';

/** 结构化输出契约（subagents.start 方言：required 挂在父对象数组上，K70） */
export const MUTATION_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['applicable', 'targetSkill', 'oldText', 'newText', 'rationale'],
  properties: {
    applicable: {
      type: 'boolean',
      description:
        'Whether this proposal can be expressed as a concrete, atomic edit to the target file shown. ' +
        'Answer false if the proposal is too vague, needs new files, or belongs in a different file.',
    },
    targetSkill: {
      type: 'string',
      description:
        'Echo back the target identifier given in the prompt (the skill name or the repo-relative path).',
    },
    oldText: {
      type: 'string',
      description:
        'EXACT verbatim excerpt from the target file that should be replaced. Copy it character for ' +
        'character, including whitespace and line breaks. Never paraphrase, never compose new text here.',
    },
    newText: {
      type: 'string',
      description: 'The replacement text for oldText. Same language as the original file.',
    },
    rationale: {
      type: 'string',
      description: 'One paragraph: why this edit implements the proposal, and how to falsify it.',
    },
  },
});

const SYSTEM_PROMPT = Object.freeze(
  'You are the mutation constructor of an agent framework called AGINT. ' +
  'You are given an improvement proposal that a human has already reviewed, plus the verbatim text of ' +
  'one target file (a skill document, a source file, or a doc). Your ONLY job: turn the proposal into ' +
  'ONE atomic edit of that file.\n\n' +
  'HARD RULES:\n' +
  '1. oldText MUST be a verbatim substring of the file you were shown — copy, never paraphrase.\n' +
  '2. The edit must be atomic: one coherent block, no unrelated changes.\n' +
  '3. If the proposal needs several edits, apply the FIRST coherent atomic step of THIS file and ' +
  'name the remaining steps in rationale — do not refuse just because the full proposal is bigger ' +
  'than one edit. Reply applicable=false only when the proposal is vague, requires creating new ' +
  'files, or belongs in a completely different file.\n' +
  '4. Do not invent APIs, commands, or text that does not appear in the file.',
);

// ── 纯函数（可单测，不碰 ctx）────────────────────────────────────────────

/** kill-switch：只有显式 'off' 才关（大小写不敏感 + 去空格）。 */
export function isDisabled(env = {}) {
  const v = String(env?.[KILL_ENV] ?? '').trim().toLowerCase();
  return v === 'off';
}

/**
 * commit 开关：默认开（2026-09-27 老板拍板「开放改仓库代码」+ K51 出厂即开），
 * 显式 'off' 才关。回滚靠 git 工作区（diff/checkout），不靠审批。
 */
export function isCommitEnabled(env = {}) {
  const v = String(env?.[COMMIT_ENV] ?? '').trim().toLowerCase();
  return v !== 'off';
}

/**
 * 仓库根解析：env > patch config > null。null ⇒ commit 关闭（skills 模式照旧）。
 */
export function resolveRepoRoot(env = {}, config = {}) {
  const fromEnv = String(env?.[REPO_ENV] ?? '').trim();
  if (fromEnv) return fromEnv;
  const fromCfg = String(config?.repoRoot ?? '').trim();
  if (fromCfg) return fromCfg;
  return null;
}

/** 从提案文本里提取反引号包裹的仓库相对路径（`plugins/x/lib/y.js` 形态）。 */
export function extractRepoPaths(text) {
  const out = [];
  const re = /`([A-Za-z0-9_\-./]+\.(?:js|mjs|cjs|json|md|yml|yaml|txt|sh))`/g;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    const p = m[1].replace(/^\.\//, '');
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * 定位失败时的诊断串：提案文本里到底提了哪些反引号路径、几条真实命中仓库。
 * 2026-09-27 观测升级：summary 的 failures 只留前 10 条，隐藏条目让「路径命中了却报
 * no target」这类矛盾无法取证 —— 把关键判据直接写进失败串本身。
 */
export function resolutionDiag(candidate, repoFiles = []) {
  const hay = `${candidate?.title ?? ''}\n${candidate?.body ?? ''}\n${candidate?.source ?? ''}`;
  const mentioned = extractRepoPaths(hay);
  const set = new Set(repoFiles);
  const hits = mentioned.filter((p) => set.has(p));
  return `mentioned:${mentioned.length} inRepo:${hits.length} bodyLen:${String(candidate?.body ?? '').length}`;
}

/**
 * 目标资产定位（2026-09-27 边界扩展）：技能名命中 → 提案内仓库路径命中 → null。
 * 返回 {type:'skill', id} | {type:'repo', id} | null。repoFiles = 仓库相对路径集合。
 */
export function resolveTargetAsset(candidate, availableSkills = [], repoFiles = []) {
  const skill = resolveTargetSkill(candidate, availableSkills);
  if (skill) return { type: 'skill', id: skill };
  if (Array.isArray(repoFiles) && repoFiles.length) {
    const hay = `${candidate?.title ?? ''}\n${candidate?.body ?? ''}`;
    const mentioned = extractRepoPaths(`${hay}\n${(candidate?.source ?? '')}`);
    const set = new Set(repoFiles);
    // 长路径优先：`plugins/a/lib/x.js` 应优先于片段 `a/lib/x.js`
    const hits = mentioned.filter((p) => set.has(p)).sort((a, b) => b.length - a.length);
    if (hits.length) return { type: 'repo', id: hits[0] };
  }
  return null;
}

/**
 * 从提案标题/正文里定位目标技能名。
 * @returns {string|null} 命中的技能名；无命中返回 null（不猜）
 */
export function resolveTargetSkill(candidate, availableSkills = []) {
  if (!candidate || !Array.isArray(availableSkills) || !availableSkills.length) return null;
  const hay = `${candidate.title ?? ''}\n${candidate.body ?? ''}`.toLowerCase();
  // 长名优先：`plugin-preflight` 应优先于 `plugin`
  const sorted = [...availableSkills].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const needle = String(name).toLowerCase();
    if (!needle) continue;
    // 词边界命中：前后不能是 [a-z0-9-]，避免 `push` 命中 `github-push` 的半截
    const re = new RegExp(`(?<![a-z0-9-])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`);
    if (re.test(hay)) return name;
  }
  return null;
}

/** 硬校验：oldText 必须是原文的真实子串（防 LLM 幻觉的第一道闸）。 */
export function anchorExists(fileText, oldText) {
  if (typeof fileText !== 'string' || typeof oldText !== 'string') return false;
  if (!oldText.trim()) return false;
  return fileText.includes(oldText);
}

/**
 * 实体存在性门 —— 实现已抽到 ./entity-gate.js（v0.2.5，单一事实源）。
 * 此处 re-export 保持既有导入面不变（测试与消费方无需改）。
 * 跨插件消费请走服务：`ctx.get('agint.evolutionDriver').checkEntities(text)`。
 */
export { findFabricatedEntities };

/**
 * mutator 的 promptPayload.promptId 要求 kebab slug（^[a-z][a-z0-9-]{2,30}$），
 * 而 repo 目标是带斜杠/点的相对路径。取末段 slug 化；不合规时加 'evo-' 前缀兜底。
 * 2026-09-27 v0.2.3：18:18 实跑 52542886 因 promptId='plugins/.../x.mjs' 被 zod 拒。
 */
export function slugifyPromptId(relPath) {
  const base = String(relPath ?? '').split('/').pop() ?? '';
  let slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
  if (!/^[a-z][a-z0-9-]{2,29}$/.test(slug)) {
    const rest = (slug || 'target').replace(/[^a-z0-9-]/g, '').replace(/^-+/, '').slice(0, 26);
    slug = `evo-${rest}`;
  }
  return slug;
}

/** 挑候选：最老的未处理提案（避免每次都挑同一条，也避免随机）。 */
export function pickCandidate(proposals = [], seen = new Set()) {
  const open = (Array.isArray(proposals) ? proposals : [])
    .filter((p) => p && p.status === 'proposed' && p.id && !seen.has(p.id));
  if (!open.length) return null;
  return open.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))[0];
}

// ── 插件主体 ────────────────────────────────────────────────────────────

export function apply(ctx, config = {}) {
  const state = {
    runs: 0,
    proposed: 0,
    ingested: 0,
    degraded: 0,
    // §4.3.4：Ledger 写入的两个计数器。`ledgerFailed` 非 0 = 有决定的进化没留下链上证据，
    // 这是事故而不是性能问题，必须走 summary 事件外部可读（warn→stdout 常驻读不到）。
    ledgerWritten: 0,
    ledgerFailed: 0,
    // 1a：预测锁定的两个计数器。`predictionSkipped` 非 0 = 这一期的进化
    // 没有留下「当时预测了什么」的不可篡改证据，Ledger 的 predictedDelta 就是 null。
    // 与 ledger 计数器同理：**必须能从 summary 看到是哪个状态跳的**，
    // 否则「没指标所以没预测」与「锁服务挂了」在事后长得一模一样。
    predictionLocked: 0,
    predictionSkipped: 0,
    // 1b R1′：实测的三个计数器。`outcomeAttention` 非 0 = 有测量没核过复原护栏
    // （仓库可能仍处基线态，或 sha 对不上）—— 这是需要人看的，不是统计噪声。
    outcomeMeasured: 0,
    outcomeRefused: 0,
    outcomeAttention: 0,
    lastRunAt: null,
    lastError: null,
    lastProposalId: null,
    seen: new Set(),
  };
  // 仓库根（patch config 静态部分）；env 优先级在 resolveRepoRoot 里
  const cfgRepoRoot = String(config?.repoRoot ?? '').trim() || null;

  // 可观测出口（2026-09-27 补）：本插件第一条 job 跑完（evolution-cycle
  // 06:32Z，lastResult ok）却零产出、零留痕 —— 静默失败是本项目头号杀手，
  // 每一条 skipped / continue 都必须留下一句话，否则「跑过但没产出」和
  // 「根本没跑」在生产上无法区分。logger 可能不存在 ⇒ 全链路可选调用。
  const logger = ctx?.logger ?? null;
  const warn = (msg, extra) => {
    try {
      logger?.warn?.(`evolution-driver: ${msg}`, extra ?? {});
    } catch {
      /* 日志失败绝不阻断主流程 */
    }
  };

  // 软依赖：调用时取，不缓存（bundle apply 顺序不保证）
  const dep = (name) => (ctx && typeof ctx.get === 'function' ? ctx.get(name) : null);
  const publish = async (topic, payload) => {
    const bus = dep('agint.eventBus.publish');
    if (typeof bus !== 'function') return null;
    try {
      // ⛔ 单参数，别再传三个：`agint.eventBus.publish` 的签名是
      // `(input) => publish(busCtx, input)`，input = { topic, source, payload }。
      // 传 (topic, payload, opts) 时 bus.js 的 `'id' in input` 对**字符串**抛
      // TypeError，被它内部 catch 成 accepted:false 静默丢弃 —— 2026-09-27
      // 两轮触发零 evolution.* 事件，全部丢在这里。
      // topic 正则（schemas.js）：^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,3}$，本插件三个 topic 均合法。
      const res = await bus({ topic, payload, source: 'agint-evolution-driver' });
      // accepted:false 是 bus 内部校验失败的唯一信号，不能当成功。
      // §4.3.4：返回 envelopeId 而不是布尔 —— Ledger 条目的 `references.eventBusIds`
      // 要靠它把「链上这条决定」接到「总线里那条真实事件」。失败即 null（不猜 id）。
      return res?.accepted === true ? (res.envelopeId ?? null) : null;
    } catch {
      return null; // 观测失败绝不影响主流程
    }
  };

  // §4.3.4 写入侧接线：决策 → Ledger 条目（⛔ 唯一写入口是 agint.evolution.ledger.append）。
  // 实例在 apply() 建，但依赖**调用时**取（同上「全软依赖」红线 #3）。
  const ledgerWriter = createLedgerWriter(ctx, { warn });

  // Phase 1.1 支点 1a：预测锁定（§2.4.2「锁定必须先于执行」）。
  // ⛔ 调用点在 commitToRepo **之前**（见下面的 lock 调用），不在写 Ledger 的时候 ——
  // 那时 policy 结果已经出来，再算预测就是事后编造，锁也就白锁。
  // 外壳是软失败（warn + 计数 + predictedDelta 留 null），理由见 prediction-locker.js 头部。
  const predictionLocker = createPredictionLocker(ctx, { warn });

  // Phase 1.1 支点 1b / R1′：actualDelta 的测量器（双态跑改动面测试子集）。
  // `listRepoFiles` 用本文件那份（带 fs.scanRepo 注入位）—— 判据单一源，⛔ 不在 measurer 里再抄一份扫描。
  const outcomeMeasurer = createOutcomeMeasurer(ctx, { listRepoFiles, warn });

  /**
   * measureOutcomes —— 给 cron `outcome-measure` 用的服务入口。
   *
   * 与 runOnce 分开的理由：一个是"往前做进化"，一个是"往后量账"，
   * 排期窗口、成本、失败影响面都不同（量账要真跑测试，一次双态 ≈ 2× 子集耗时）。
   *
   * 永不抛（外壳在 outcome-measurer 里已经做完，这里只加计数与截断）。
   * @param {object} [opts] { repoRoot?, env?, limit?, inject? }
   *   `inject.measurer` = 测试缝（与 runOnce 的 `inject.fs/llm` 同一条约定）：
   *   给定形状 `{ measurePending }` 即用它，生产不传 ⇒ 用 apply() 建的那个。
   * @returns {Promise<object>} 本轮测量概览
   */
  async function measureOutcomes(opts = {}) {
    const env = opts.env ?? process.env;
    const repoRoot = opts.repoRoot ?? resolveRepoRoot(env, { repoRoot: cfgRepoRoot });
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_OUTCOME_LIMIT;
    const measurer = opts.inject?.measurer ?? outcomeMeasurer;
    const out = await measurer.measurePending({ repoRoot, limit });
    for (const r of out.results ?? []) {
      if (r.status === 'MEASURED') state.outcomeMeasured += 1;
      else state.outcomeRefused += 1;
      if (r.needsAttention === true) {
        state.outcomeAttention += 1;
        warn('outcome: 护栏未核过，需人工确认仓库状态', { contractId: r.contractId, status: r.status, changedPath: r.changedPath ?? null });
      }
    }
    // results 里塞不进日志的一行摘要：每条只留判读字段，整份留给 cron 落盘文件。
    return { ...out, repoRoot: repoRoot ?? null, limit };
  }

  /**
   * 让 LLM 把提案变成一次原子编辑。
   * 注入点：opts.llm（测试用），否则走 agents.create + subagents.start。
   * @param {object} [opts.entityGate] 实体存在性门：{ repoFiles, getCodeIndex }；
   *   缺省/null = 不启用（旧测试兼容）。getCodeIndex() 返回 null = 索引不可用 → snake 类放行并降级告警。
   */
  async function construct({ candidate, targetId, fileText, timeoutMs = DEFAULT_TIMEOUT_MS, llm = null, entityGate = null }) {
    const build = llm ?? ((args) => spawnLlm(ctx, args));
    const out = await build({
      system: SYSTEM_PROMPT,
      user: [
        '## Improvement proposal',
        `Title: ${candidate.title ?? ''}`,
        `Category: ${candidate.category ?? 'other'}`,
        `Source: ${candidate.source ?? ''}`,
        '',
        candidate.body ?? '',
        '',
        `## Target file: ${targetId}`,
        '```',
        String(fileText).slice(0, DEFAULT_SNIPPET),
        '```',
        '',
        'Reply with the structured output: one atomic edit, or applicable=false.',
      ].join('\n'),
      schema: MUTATION_OUTPUT_SCHEMA,
      timeoutMs,
    });
    if (!out || out.ok !== true) {
      return { ok: false, reason: out?.reason ?? 'llm unavailable', degraded: true };
    }
    const v = out.value ?? {};
    if (v.applicable !== true) {
      return { ok: false, reason: 'llm judged not applicable', rationale: v.rationale ?? null };
    }
    if (!anchorExists(fileText, v.oldText)) {
      // ⛔ 幻觉闸门：oldText 不在原文里 ⇒ 这条变异是编的，丢弃而不是"修一修"
      return { ok: false, reason: 'oldText not found in target file (hallucination guard)', degraded: true };
    }
    if (!v.newText || v.newText === v.oldText) {
      return { ok: false, reason: 'empty or no-op edit' };
    }
    if (entityGate && typeof entityGate.getCodeIndex === 'function') {
      const codeText = await entityGate.getCodeIndex();
      if (codeText === null) {
        // 索引构建失败 → snake 类无从验证，放行但必须留痕（K113：每条分支都有出口）
        warn('entity gate: code index unavailable; snake-class checks skipped');
      }
      const fabricated = findFabricatedEntities(v.newText, {
        repoFiles: entityGate.repoFiles ?? [],
        // ⚠️ 必须显式传 null：undefined 会触发解构默认 ''（=严格空索引）而非「跳过」语义
        codeText: codeText ?? null,
      });
      if (fabricated.length > 0) {
        // ⛔ 实体门：newText 引用了仓库里不存在的实体 ⇒ 内容级编造，落盘前拦死。
        //   注意不算 degraded —— LLM 通道本身是好的，是产出不合格。
        return {
          ok: false,
          reason: `fabricated entities in newText: ${fabricated.join(', ')} (entity gate)`,
          fabricated,
        };
      }
    }
    return { ok: true, value: v };
  }

  /**
   * 跑一轮：挑候选 → 构造 → propose → validate → ingest。
   * @param {object} opts
   * @param {object} [opts.inject] 测试注入：{ evolve, mutator, population, skills, fs, llm }
   */
  async function runOnce(opts = {}) {
    // 全路径出口：每条 return 都发一条 summary（2026-09-27 三修）。
    // 前两版只覆盖了「走到循环末尾」的情况，早期 return（依赖缺失等）照样静默。
    const emitSummary = async (exitReason, extra = {}) =>
      publish('evolution.cycle.summary', {
        exitReason,
        runs: state.runs,
        seen: state.seen.size,
        proposed: state.proposed,
        ingested: state.ingested,
        degraded: state.degraded,
        // §4.3.4 纪律 3：Ledger 写入结果必须外部可读。ledgerFailed>0 = 有决定没留下
        // 链上证据（事件总线是本插件唯一读得到的出口）。
        ledgerWritten: state.ledgerWritten,
        ledgerFailed: state.ledgerFailed,
        lastError: state.lastError,
        failures: [],
        failuresTotal: 0,
        commitEnabled: isCommitEnabled(opts.env ?? process.env),
        ...extra,
      });

    if (isDisabled(opts.env ?? process.env)) {
      await emitSummary('paused');
      return { skipped: true, reason: `paused（${KILL_ENV}=off）` };
    }
    state.runs += 1;
    state.lastRunAt = new Date().toISOString();

    const inj = opts.inject ?? {};
    const evolve = inj.evolve ?? dep('agint.evolve');
    const mutator = inj.mutator ?? dep('agint.mutator');
    const population = inj.population ?? dep('agint.population');
    // 2026-09-29（B 方案）：commit 的「写入后验证」通道。sandbox 跑 smoke、policy 给决策，
    // 与 mutator.commit 步骤 5/6 同语义。两者的存在性是 commit 的**前置条件**（fail-closed），
    // 不是可选项 —— 见下方 `if (commitOn && repoRoot)` 分支。
    const sandbox = inj.sandbox ?? dep('agint.qualitySandbox');
    const policy = inj.policy ?? dep('agint.qualityPolicy');
    // v0.2.8：失败原因留痕用。注意这**不是**上面那个 `agint.evolve` ——
    // addFailure 由 agint-evolution-memory 提供，挂在 agint.evolution 命名空间下
    // （sandbox / policy / mount / population 等插件都是这么调的）。
    const evolutionLog = inj.evolution ?? dep('agint.evolution');
    const fs = inj.fs ?? null;

    if (!evolve || typeof evolve.listProposals !== 'function') {
      state.degraded += 1;
      state.lastError = 'agint.evolve unavailable';
      warn('runOnce skipped', { reason: state.lastError, hasEvolve: Boolean(evolve) });
      await emitSummary('evolve-unavailable');
      return { skipped: true, reason: 'agint.evolve unavailable' };
    }
    if (!mutator || typeof mutator.propose !== 'function') {
      state.degraded += 1;
      state.lastError = 'agint.mutator unavailable';
      warn('runOnce skipped', { reason: state.lastError, hasMutator: Boolean(mutator) });
      await emitSummary('mutator-unavailable');
      return { skipped: true, reason: 'agint.mutator unavailable' };
    }

    let proposals = [];
    try {
      proposals = await evolve.listProposals({ status: 'proposed' });
    } catch (error) {
      state.degraded += 1;
      state.lastError = `listProposals failed: ${error?.message ?? String(error)}`;
      warn('runOnce skipped', { reason: state.lastError });
      await emitSummary('listProposals-failed');
      return { skipped: true, reason: state.lastError };
    }

    // 可用技能清单：注入优先；否则按插件自身位置列出 bundle 内 preset skills
    let available = Array.isArray(inj.skillNames) ? inj.skillNames : null;
    if (!available) {
      try {
        available = await listSkillNames({ roots: inj.skillRoots });
      } catch {
        available = [];
      }
    }
    const pool = Array.isArray(proposals) ? proposals.slice(0, MAX_CANDIDATES * 4) : [];
    // ⭐ 失败清单（2026-09-27 二修）：warn 走宿主 stdout，常驻进程下**读不到**；
    // cron 持久化只写死字符串 "ok"，统计也不落盘。唯一外部可读的出口是事件总线。
    // 每轮结束必发一条 evolution.cycle.summary，把「跑了几个 / 卡在哪」写进去。
    const failures = [];

    // 仓库根 + 仓库文件清单（2026-09-27 边界扩展：开放改仓库代码）
    const repoRoot = resolveRepoRoot(opts.env ?? process.env, { repoRoot: cfgRepoRoot });
    const commitOn = isCommitEnabled(opts.env ?? process.env);
    let repoFiles = [];
    if (repoRoot) {
      try {
        repoFiles = await listRepoFiles(repoRoot, { fs: inj.fs });
      } catch (error) {
        warn('repo scan failed; falling back to skills-only', { error: error?.message ?? String(error) });
      }
    }

    // 实体存在性门（v0.2.4）：默认开，ENTITY_GATE_ENV=off 可关（K51：出厂即开）。
    // 代码索引懒构建：首个走到门的候选才扫，全程只建一次。
    const entityGateOn =
      String((opts.env ?? process.env)[ENTITY_GATE_ENV] ?? 'on') !== 'off' && Boolean(repoRoot);
    let codeIndexCache;
    let codeIndexBuilt = false;
    const getCodeIndex = async () => {
      if (codeIndexBuilt) return codeIndexCache;
      codeIndexBuilt = true;
      try {
        codeIndexCache = await buildCodeIndex(repoRoot, repoFiles, { fs: inj.fs });
      } catch (error) {
        warn('entity gate: code index build failed', { error: error?.message ?? String(error) });
        codeIndexCache = null;
      }
      return codeIndexCache;
    };
    const entityGate = entityGateOn ? { repoFiles, getCodeIndex } : null;

    for (const candidate of pool) {
      if (state.seen.has(candidate.id)) continue;
      state.seen.add(candidate.id);

      const target = resolveTargetAsset(candidate, available, repoFiles);
      if (!target) {
        // 定位不到目标资产 → 换下一条，不硬凑。留痕：这是「有提案但没目标」的静默路径。
        warn('candidate skipped: no target asset resolved', {
          candidateId: candidate.id,
          title: candidate.title ?? '',
          availableCount: Array.isArray(available) ? available.length : 0,
          repoFilesCount: repoFiles.length,
        });
        failures.push(`${candidate.id}: no target asset resolved (${resolutionDiag(candidate, repoFiles)})`);
        continue;
      }
      const targetId = target.id;

      let fileText = null;
      try {
        fileText =
          target.type === 'skill'
            ? await readSkillText({ skillName: targetId, fs, roots: inj.skillRoots })
            : await readRepoText({ repoRoot, relPath: targetId, fs: inj.fs });
      } catch (error) {
        fileText = null;
        warn('candidate skipped: target file unreadable', {
          candidateId: candidate.id,
          targetId,
          error: error?.message ?? String(error),
        });
      }
      if (typeof fileText !== 'string' || !fileText) {
        failures.push(`${candidate.id}: target file unreadable (${targetId})`);
        continue;
      }

      const built = await construct({ candidate, targetId, fileText, llm: inj.llm ?? null, entityGate });
      if (built.ok !== true) {
        if (built.degraded) state.degraded += 1;
        warn('candidate skipped: construct failed', {
          candidateId: candidate.id,
          targetId,
          reason: built.reason ?? 'unknown',
          degraded: built.degraded === true,
          fabricated: built.fabricated ?? undefined,
        });
        failures.push(`${candidate.id}: construct failed — ${built.reason ?? 'unknown'}`);
        continue;
      }
      const v = built.value;

      let proposal = null;
      try {
        proposal = await mutator.propose({
          source: 'evolution-reversed',
          failureId: candidate.id,
          rootCause: `PROMPT_DEFICIENCY: ${candidate.category ?? 'other'}`,
          atomicScope: 'prompt',
          // v0.2.14：期望按目标类型声明（⛔ 不再对所有变异写同一句"通过率"）。
          // 判据见 lib/expected-effect.js —— 只声明有仪器能兑现的期望。
          expectedEffect: expectedEffectForTarget({ targetType: target.type }),
          rollbackCondition: 'regression → auto-rollback',
          promptPayload: {
            promptId: slugifyPromptId(targetId),
            oldText: v.oldText,
            newText: v.newText,
            diffStrategy: 'unified_diff',
          },
          failureContext: {
            proposalTitle: candidate.title ?? '',
            rationale: v.rationale ?? '',
            source: candidate.source ?? '',
          },
        });
      } catch (error) {
        state.lastError = `propose failed: ${error?.message ?? String(error)}`;
        warn('candidate skipped: mutator.propose threw', {
          candidateId: candidate.id,
          targetId,
          reason: state.lastError,
        });
        failures.push(`${candidate.id}: propose threw — ${state.lastError}`);
        continue;
      }
      state.proposed += 1;
      state.lastProposalId = proposal?.id ?? null;

      // validate 是"不通过不抛错"的形态：写 findings + 返回 {ok, findings}
      // 2026-09-27 v0.2.3：mutator.validate 入参是 { proposal }（整个对象），
      // 传 { proposalId } 会报「入参缺 proposal.id」（18:18 实跑 531e2631 实证）。
      let verdict = { ok: true, findings: [] };
      if (typeof mutator.validate === 'function') {
        try {
          verdict = await mutator.validate({ proposal });
        } catch (error) {
          verdict = { ok: false, findings: [String(error?.message ?? error)] };
        }
      }
      if (verdict && verdict.ok === false) {
        await publish('evolution.mutation.rejected', {
          proposalId: proposal.id,
          candidateId: candidate.id,
          findings: (verdict.findings ?? []).slice(0, 5),
        });
        failures.push(`${candidate.id}: validate rejected — ${(verdict.findings ?? []).slice(0, 2).join(' | ')}`);
        continue;
      }

      let variant = null;
      if (population && typeof population.ingest === 'function') {
        try {
          variant = await population.ingest({ proposal, generation: 0 });
          state.ingested += 1;
        } catch (error) {
          state.lastError = `ingest failed: ${error?.message ?? String(error)}`;
        }
      }

      await publish('evolution.mutation.proposed', {
        proposalId: proposal.id,
        candidateId: candidate.id,
        target: { type: target.type, id: targetId },
        skill: target.type === 'skill' ? targetId : null,
        variantId: variant?.variant_id ?? null,
        policyDecision: variant?.policy_decision ?? null,
        stage: variant?.stage ?? null,
        commitEnabled: commitOn,
      });

      // ── commit：写回仓库正本（2026-09-27 老板拍板开放改仓库代码后默认开）。
      //    三保险：denylist + oldText 唯一性 + preimage 备份；git 工作区天然可回滚。
      //
      //    2026-09-29（B 方案）补上第 4 道：**写入后验证**。改动前本分支只做「写入前闸门」
      //    （denylist / oldText 唯一性 / preimage），写完就发 committed 事件直接结束 ——
      //    全程不过 D-QAF，等于 AGENTS.md 明令禁止的「绕过 D-QAF 直接部署」。
      //    现在写入后强制走 verifyTargetFile → policy.decide，REJECT/ABSTAIN 即从 preimage 回滚。
      //
      //    2026-09-29 v0.2.8 两处修正（均由生产实跑暴露）：
      //    ① 验证器从 sandbox.runSmoke 换成 verifyTargetFile —— runSmoke 是「插件结构冒烟」，
      //       对任意仓库文件恒返回 package-json-missing，导致 policy 恒拒、commit 100% 失败。
      //    ② 三条失败路径全部写 evolve.addFailure —— 此前只有 warn 走 stdout（常驻进程读不到），
      //       cron 又只写死 "ok"，失败原因完全不可见。
      //
      //    ⛔ fail-closed：policy 或验证能力不可用时**根本不写**，不是「写了再想办法验」。
      //    没有验证能力就不改仓库，这是 B 方案与 mutator.commit 的关键差异
      //    （后者写完才发现 sandbox 缺失，只能抛错留下半成品）。
      let commit = null;
      // 2026-09-29：commit 阶段的审计信息，交给返回值里的 summary 通道落盘。
      // 必须声明在**这个层级**（与 commit 同级）—— policy 决策与 verify 结果都产生在
      // 下面更深的 try 内部，而 runOnce 的 return 在那一层之外。
      // 没有它，「policy 到底是 AUTO_DEPLOY 还是 PENDING_REVIEW」在进程退出后永远无从查证。
      let commitAudit = null;
      // 1a 的观测段声明在这一层（与 commitAudit 同级）：commit 被跳过时 commitAudit
      // 是 null，summary 会只剩一句 note —— 那一刻已经落表的锁就成了"表里有 hash、
      // 别处查不到预测内容"的孤行。把 predictionAudit 提到外层，跳过分支也带得出去。
      let predictionAudit = null;
      if (commitOn && repoRoot) {
        const commitPath =
          target.type === 'skill' ? `presets/agint/skills/${targetId}/SKILL.md` : targetId;
        // fail-closed 判据 v0.2.8：policy 必须有；sandbox 只在「目标是目录」时才必需
        // （verifyTargetFile 对文件走语法检查，不碰 sandbox）。
        const sandboxMissing = typeof sandbox?.runSmoke !== 'function';
        if (typeof policy?.decide !== 'function' || sandboxMissing) {
          // 不可用即不写：留痕但不落盘，避免出现「无验证的仓库改动」。
          const reason = `verify-unavailable (sandbox=${sandboxMissing ? 'missing' : 'ok'}, policy=${typeof policy?.decide})`;
          state.lastError = `commit skipped: ${reason}`;
          warn('commit skipped (fail-closed)', { proposalId: proposal.id, path: commitPath, reason });
          await recordFailure({
            evolve: evolutionLog,
            pattern: 'evolution-commit-skipped:verify-unavailable',
            evidence: `proposalId=${proposal.id} path=${commitPath} ${reason}`,
          });
          await publish('evolution.mutation.commit-skipped', {
            proposalId: proposal.id,
            candidateId: candidate.id,
            path: commitPath,
            reason,
          });
        } else {
          // ── Phase 1.1 支点 1a：预测锁定（§2.4.2「锁定必须先于执行」）
          //    放在 commitToRepo 之前：这一刻 policy / verify / 写入结果**都还不存在**，
          //    锁进去的数字不可能是照着一个还没发生的结果编的。
          //
          // 1a 补片（方案②）：先定这次要预测哪个指标。variant 行本来就记着就用它；
          // 落兜底 'unspecified' 时才去读**提案自己声明的** expectedEffect 串
          // （lib/metric-resolver.js）。读不出就留 null ⇒ 外壳判 NO_PREDICTION、不落锁。
          // ⛔ 同一个 metric 必须同时喂给锁和条目：hypothesisLock 把它折进了摘要。
          const metricResolution = resolveTargetMetric({
            variantMetric: variant?.expected_effect?.metric ?? null,
            expectedEffect: proposal.expectedEffect,
          });
          let prediction = null;
          const lockRes = await predictionLocker.lock({
            contractId: proposal.id,
            mutationType: proposal.kind,
            targetMetric: metricResolution.metric,
            changedComponents: pluginFromPath(commitPath),
          });
          if (lockRes.ok === true) {
            state.predictionLocked += 1;
            prediction = lockRes; // ⛔ 只把「已入库」的那一份交给 Ledger
          } else {
            state.predictionSkipped += 1;
          }
          predictionAudit = {
            status: lockRes.status,
            predictedDelta: lockRes.ok === true ? lockRes.predictedDelta : null,
            predictionSource: lockRes.predictionSource ?? null,
            lockEventId: lockRes.lockEventId ?? null,
            // 指标出处必须落盘可查：报告要能分清「variant 记过指标」与
            // 「从期望串解析出来的」两类预测，不能靠读代码反推。
            targetMetric: metricResolution.metric,
            targetMetricSource: metricResolution.source,
            targetMetricReason: metricResolution.reason,
          };
          try {
            commit = await commitToRepo({
              repoRoot,
              relPath: commitPath,
              oldText: v.oldText,
              newText: v.newText,
              fs: inj.fs,
            });
            if (commit.ok !== true) {
              warn('commit skipped', { proposalId: proposal.id, path: commitPath, reason: commit.reason });
            } else {
              // ── 写入后验证：按文件类型选验证器 → policy（语义对齐 mutator.commit 步骤 5/6）
              const sandboxResult = await verifyTargetFile({
                repoRoot, relPath: commit.path, sandbox,
              });
              const synthEval = {
                target: { id: commit.path, kind: 'plugin-postimage' },
                // ⭐ v0.2.9：必须带 `key`，且与 `name` 并存。
                // policy 的 computeComposite（agint-quality-policy/lib/decide.js:88/96-97）
                // 全程只按 `d.key` 取权重与判 veto：`weights[d.key] ?? 0` 在只给 name 时
                // 得到 0 → continue → den===0 → return null → **恒 REJECT**，与分数无关。
                //
                // 这不是笔误：agint-mutator/lib/index.js:609 至今仍只传 `name`，
                // 所以 mutator.commit 一旦被真正启用也会恒被拒。driver 是照抄来的，
                // 2026-09-29 首次实跑才暴露（本轮 decision=REJECT / verifyOk=true）。
                //
                // 两个字段都写：key 满足 policy 契约，name 兼容任何按 name 读的旧调用方。
                // 这**不是**改 FROZEN 契约 —— key 才是契约字段，这里是回到契约。
                dimensions: sandboxResult?.ok
                  ? [
                      { key: 'safety', name: 'safety', score: { score: 1.0, veto: false } },
                      { key: 'trust', name: 'trust', score: { score: 1.0, veto: false } },
                    ]
                  : [
                      { key: 'safety', name: 'safety', score: { score: 0.0, veto: true } },
                      { key: 'trust', name: 'trust', score: { score: 0.0, veto: true } },
                    ],
                ok: Boolean(sandboxResult?.ok),
                reason: sandboxResult?.ok ? undefined : sandboxResult?.reason,
              };
              // 2026-09-29：保留完整决策对象而不只取 .kind —— reason 字段（如
              // policy-abstain:empty-results / safety-veto:below-0.5）才是排障的抓手，
              // 丢了它就只能看到「被拒了」，看不到「为什么」。
              const decisionRaw = await policy.decide({ results: [synthEval] });
              const decision = decisionRaw?.kind ?? 'ABSTAIN';
              // 执行事实事件的 envelopeId ⇒ Ledger 的 references.eventBusIds
              let outcomeEventId = null;

              if (decision === 'REJECT' || decision === 'ABSTAIN') {
                // 决策为拒 → 从 preimage 回滚，绝不把没验证过的改动留在仓库里。
                const restored = await restoreFromPreimage({
                  repoRoot,
                  relPath: commit.path,
                  preimagePath: commit.preimagePath,
                  fs: inj.fs,
                });
                commit = {
                  ...commit,
                  ok: false,
                  reverted: restored.ok,
                  policyDecision: decision,
                  sandboxOk: Boolean(sandboxResult?.ok),
                  reason: `policy=${decision}${restored.ok ? '' : ` (回滚失败: ${restored.reason})`}`,
                };
                state.lastError = `commit rejected: ${commit.reason}`;
                warn('commit rejected', {
                  proposalId: proposal.id, path: commit.path,
                  decision, reverted: restored.ok, sandboxOk: sandboxResult?.ok,
                });
                // v0.2.8：失败原因落 evolve.failure_pattern（此前只有 stdout warn，事后查不到）
                await recordFailure({
                  evolve: evolutionLog,
                  pattern: `evolution-commit-rejected:${sandboxResult?.ok ? 'policy' : 'verify'}`,
                  severity: sandboxResult?.ok ? 'medium' : 'high',
                  evidence: `proposalId=${proposal.id} path=${commit.path} decision=${decision} `
                    + `verifyMode=${sandboxResult?.mode} verifyOk=${sandboxResult?.ok} `
                    + `reason=${sandboxResult?.reason ?? 'n/a'} reverted=${restored.ok}`,
                });
                commitAudit = {
                  path: commit.path,
                  policyDecision: decision,
                  policyReason: decisionRaw?.reason ?? null,
                  verifyMode: sandboxResult?.mode ?? null,
                  verifyOk: Boolean(sandboxResult?.ok),
                  verifyReason: sandboxResult?.reason ?? null,
                  // 回滚**结果**而不是回滚意图：此前这里写死 true，于是
                  // 「policy 拒了但 preimage 没恢复回去」（改动还在仓库里）在
                  // cron 落盘的 summary 里长得和成功回滚一模一样。
                  reverted: restored.ok,
                  sandboxOk: Boolean(sandboxResult?.ok),
                  bytesBefore: commit.bytesBefore ?? null,
                  bytesAfter: commit.bytesAfter ?? null,
                  preimagePath: commit.preimagePath ?? null,
                };
                outcomeEventId = await publish('evolution.mutation.rolledback', {
                  proposalId: proposal.id,
                  candidateId: candidate.id,
                  path: commit.path,
                  policyDecision: decision,
                  sandboxOk: Boolean(sandboxResult?.ok),
                  verifyMode: sandboxResult?.mode ?? null,
                  reason: sandboxResult?.reason ?? null,
                  reverted: restored.ok,
                });
              } else {
                commitAudit = {
                  path: commit.path,
                  policyDecision: decision,
                  policyReason: decisionRaw?.reason ?? null,
                  verifyMode: sandboxResult?.mode ?? null,
                  verifyOk: Boolean(sandboxResult?.ok),
                  verifyReason: sandboxResult?.reason ?? null,
                  reverted: false,
                  sandboxOk: Boolean(sandboxResult?.ok),
                  bytesBefore: commit.bytesBefore ?? null,
                  bytesAfter: commit.bytesAfter ?? null,
                  preimagePath: commit.preimagePath ?? null,
                };
                outcomeEventId = await publish('evolution.mutation.committed', {
                  proposalId: proposal.id,
                  candidateId: candidate.id,
                  path: commit.path,
                  preimagePath: commit.preimagePath,
                  bytesBefore: commit.bytesBefore,
                  bytesAfter: commit.bytesAfter,
                  policyDecision: decision,
                  sandboxOk: Boolean(sandboxResult?.ok),
                  verifyMode: sandboxResult?.mode ?? null,
                });
              }

              // ── §4.3.4：这次决策入链。REJECT / ABSTAIN 同样入 ——
              //    Ledger 记的是「进化发生过什么」，不是「进化成功过什么」；
              //    只记 AUTO_DEPLOY 等于在证据层又把历史美化了一遍。
              const ledgerRes = await ledgerWriter.writeDecision({
                evolution: evolutionLog,
                proposal,
                variant,
                outcome: {
                  decision,
                  path: commitAudit.path,
                  preimagePath: commitAudit.preimagePath,
                  bytesBefore: commitAudit.bytesBefore,
                  bytesAfter: commitAudit.bytesAfter,
                  verifyMode: commitAudit.verifyMode,
                  sandboxOk: commitAudit.sandboxOk,
                  reverted: commitAudit.reverted,
                  reason: commitAudit.policyReason ?? commitAudit.verifyReason,
                  eventIds: [outcomeEventId],
                },
                prediction,
                // ⛔ 与锁定时同一个指标：条目写另一个值，1b 归档重算必判假篡改。
                targetMetric: metricResolution.metric,
              });
              if (ledgerRes.ok) {
                state.ledgerWritten += 1;
              } else {
                state.ledgerFailed += 1;
                state.lastError = `ledger write failed: ${ledgerRes.status}`;
                // 纪律 3：写入失败必须外部可读。warn 只到 stdout（常驻进程读不到），
                // 所以再落一条 failure_pattern —— 这是 cron / 周报查得动的通道。
                await recordFailure({
                  evolve: evolutionLog,
                  pattern: `evolution-ledger-${ledgerRes.status}`,
                  severity: 'high',
                  evidence: `proposalId=${proposal.id} decision=${decision} `
                    + `path=${commitAudit.path} ${ledgerRes.error ?? ledgerRes.reason ?? '未知原因'}`,
                });
              }
              commitAudit = {
                ...commitAudit,
                ledgerSeq: ledgerRes.seq,
                ledgerStatus: ledgerRes.status,
              };
            }
          } catch (error) {
            // 写入后异常：已经落盘了就必须回滚，否则留下「未验证改动」在仓库里。
            let revertNote = null;
            if (commit?.ok === true && commit.preimagePath) {
              const restored = await restoreFromPreimage({
                repoRoot, relPath: commit.path, preimagePath: commit.preimagePath, fs: inj.fs,
              });
              revertNote = restored.ok ? 'reverted' : `revert-failed: ${restored.reason}`;
            }
            state.lastError = `commit failed: ${error?.message ?? String(error)}`;
            warn('commit threw', {
              proposalId: proposal.id, path: commitPath, reason: state.lastError, revert: revertNote,
            });
            // v0.2.8：异常路径同样要留痕，否则「为什么没落库」永远查不到
            await recordFailure({
              evolve: evolutionLog,
              pattern: 'evolution-commit-threw',
              evidence: `proposalId=${proposal.id} path=${commitPath} `
                + `error=${error?.message ?? String(error)} revert=${revertNote ?? 'n/a'}`,
            });
          }
        }
      }

      return {
        skipped: false,
        candidateId: candidate.id,
        target: { type: target.type, id: targetId },
        skill: target.type === 'skill' ? targetId : null,
        proposalId: proposal.id,
        variantId: variant?.variant_id ?? null,
        policyDecision: variant?.policy_decision ?? null,
        rationale: v.rationale ?? '',
        // 2026-09-29（B 方案）：ok=false 时把决策与回滚结果一并带出，否则调用方
        // （cron 持久化只写死 "ok"）无从区分「写入被拒」与「路径不合法」两类失败。
        // v0.2.10 补齐成功分支：此前 policyDecision 只在**失败**分支带出，成功时
        // 恰恰查不到 commit 阶段的决策 —— 而顶层那个是提案阶段的，两回事。
        commit: commit?.ok === true
          ? {
              ok: true,
              path: commit.path,
              preimagePath: commit.preimagePath,
              policyDecision: commitAudit?.policyDecision ?? null,
              verifyMode: commitAudit?.verifyMode ?? null,
            }
          : commit
            ? { ok: false, path: commit.path, policyDecision: commit.policyDecision ?? null, sandboxOk: commit.sandboxOk ?? null, reverted: commit.reverted ?? false, reason: commit.reason ?? null }
            : null,
        // 2026-09-29：走 cron 的约定式 summary 通道落盘（见 agint-cron/lib/index.js
        // summarizeResult）。不落盘的话，policy 到底是 AUTO_DEPLOY 还是 PENDING_REVIEW
        // 在进程退出后就永久不可知 —— 只能从「改动有没有留在仓库」反推。
        summary: {
          proposalId: proposal.id,
          candidateId: candidate.id,
          commitAttempted: commit != null,
          ...(commitAudit ?? { note: commit == null ? 'no-commit-attempted' : 'commit-ok-unknown' }),
          // 1a：锁的观测段独立于 commitAudit —— 跳过 commit 时也要看得见。
          prediction: predictionAudit,
        },
      };
    }

    // ⭐ 无论有没有产出都发一条 summary：这是本插件唯一「外部可读」的出口
    // （warn→stdout 常驻读不到；cron 持久化只写死 "ok"）。零产出时更要发。
    await emitSummary('no-actionable-candidate', {
      poolSize: pool.length,
      availableSkills: Array.isArray(available) ? available.length : 0,
      repoFiles: repoFiles.length,
      repoRoot: repoRoot ?? null,
      failures: failures.slice(0, 30), // 2026-09-27 观测升级：pool 上限 20，10 条 cap 会藏住诊断尾巴
      failuresTotal: failures.length,
    });

    // 跑完一轮什么都没产出 —— 必须留痕，否则与「根本没跑」无法区分。
    const summary = {
      poolSize: pool.length,
      availableSkills: Array.isArray(available) ? available.length : 0,
      repoFiles: repoFiles.length,
      repoRoot: repoRoot ?? null,
      seen: state.seen.size,
      degraded: state.degraded,
      lastError: state.lastError,
    };
    warn('runOnce ended with no actionable candidate', summary);
    return {
      skipped: true,
      reason: 'no actionable candidate（无候选 / 定位不到目标 / LLM 判定不适用）',
      ...summary,
    };
  }

  function status() {
    return {
      runs: state.runs,
      proposed: state.proposed,
      ingested: state.ingested,
      degraded: state.degraded,
      ledgerWritten: state.ledgerWritten,
      ledgerFailed: state.ledgerFailed,
      predictionLocked: state.predictionLocked,
      predictionSkipped: state.predictionSkipped,
      outcomeMeasured: state.outcomeMeasured,
      outcomeRefused: state.outcomeRefused,
      outcomeAttention: state.outcomeAttention,
      lastRunAt: state.lastRunAt,
      lastError: state.lastError,
      lastProposalId: state.lastProposalId,
      seenCandidates: state.seen.size,
      commitEnabled: isCommitEnabled(process.env),
      repoRoot: cfgRepoRoot,
      killSwitch: isDisabled(process.env) ? 'off' : 'on',
    };
  }

  // 实体存在性门的**只读扩展点**（2026-09-27 v0.2.5）：让别的插件（如 skill-autocreate
  // 发布前的内容检查）复用同一份判据与同一份代码索引，避免各插件各抄一份 → 漂移 → 假绿。
  // 走软依赖调用（`ctx.get('agint.evolutionDriver').checkEntities(text)`）：不缓存、无跨插件 import。
  // ⚠️ 查询口径：`checked:false` = **缺证据**（没 repoRoot / 门被关），调用方应放行而不是当失败。
  let svcRepoFiles = null;
  let svcCodeIndex;
  let svcCodeBuilt = false;
  const checkEntities = async (text, opts = {}) => {
    const env = opts.env ?? process.env;
    if (String(env[ENTITY_GATE_ENV] ?? 'on') === 'off') {
      return { checked: false, reason: 'entity gate off', fabricated: [] };
    }
    const repoRoot = opts.repoRoot ?? resolveRepoRoot(env, { repoRoot: cfgRepoRoot });
    if (!repoRoot) return { checked: false, reason: 'no repoRoot', fabricated: [] };
    try {
      // fs 可注入（测试用 hermetic mock；生产调用方不传即走真实文件系统）
      const injFs = opts.fs ?? {};
      if (svcRepoFiles === null) svcRepoFiles = await listRepoFiles(repoRoot, { fs: injFs });
      if (!svcCodeBuilt) {
        svcCodeBuilt = true;
        try {
          svcCodeIndex = await buildCodeIndex(repoRoot, svcRepoFiles, { fs: injFs });
        } catch (error) {
          warn('checkEntities: code index build failed; snake tokens will pass', {
            error: error?.message ?? String(error),
          });
          svcCodeIndex = null;
        }
      }
      const fabricated = findFabricatedEntities(text, { repoFiles: svcRepoFiles, codeText: svcCodeIndex });
      return { checked: true, repoFiles: svcRepoFiles.length, fabricated, ok: fabricated.length === 0 };
    } catch (error) {
      // 门自己出错 ⇒ 放行 + 留痕（绝不让观测装置变成新的单点故障）
      return { checked: false, reason: `gate error: ${error?.message ?? error}`, fabricated: [] };
    }
  };

  const goalsSvc = () => (typeof ctx.get === 'function' ? ctx.get('goals') : null);
  const goalBridgeStatus = () => ({
    enabled: isGoalBridgeEnabled(process.env),
    goalsAvailable: goalsSvc() !== undefined && goalsSvc() !== null,
    env: GOAL_BRIDGE_ENV,
  });
  const driveAsGoal = async ({ agent, candidate, opts = {} }) =>
    createEvolutionGoal({ agent, candidate, goals: goalsSvc(), env: process.env, opts });

  ctx.provide('agint.evolutionDriver', {
    runOnce, status, construct, checkEntities, driveAsGoal, goalBridgeStatus, buildGoalObjective,
    // Phase 1.1 支点 1b：给 cron `outcome-measure` 的测量入口
    measureOutcomes,
  });

  ctx.effect(() => () => {
    /* 无 interval / 无订阅：生命周期干净 */
  });
}

// ── 副作用：读技能文件 + 起子 agent（与纯逻辑分离，便于注入测试）─────────

async function readSkillText({ skillName, fs, roots }) {
  const read = fs?.readSkill;
  if (typeof read === 'function') return await read(skillName);
  const list = roots ?? null;
  if (typeof list === 'function') return await list(skillName);
  // 默认：按插件自身位置定位 bundle 内的 presets（K83：包内相对路径锚包根）
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const base = fileURLToPath(new URL('../../../presets/agint/skills/', import.meta.url));
  return await readFile(join(base, String(skillName), 'SKILL.md'), 'utf8');
}

/** 列出 bundle 内 preset skills 的目录名（默认发现路径，生产靠它拿到可用技能清单）。 */
async function listSkillNames({ roots } = {}) {
  if (typeof roots === 'function') return await roots();
  const { readdir } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const base = fileURLToPath(new URL('../../../presets/agint/skills/', import.meta.url));
  const entries = await readdir(base, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && !String(e.name).startsWith('.')).map((e) => e.name);
}

/** 读仓库文件（repoRoot + 相对路径；fs.readRepo 可注入测试）。 */
async function readRepoText({ repoRoot, relPath, fs }) {
  const read = fs?.readRepo;
  if (typeof read === 'function') return await read(relPath);
  const { readFile } = await import('node:fs/promises');
  const { join, resolve: pathResolve } = await import('node:path');
  const abs = pathResolve(repoRoot, relPath);
  return await readFile(abs, 'utf8');
}

/**
 * 递归列仓库相对路径（跳过 REPO_SCAN_IGNORES，封顶 REPO_SCAN_MAX_FILES）。
 * fs.scanRepo 可注入测试；无 repoRoot 返回 []。
 */
async function listRepoFiles(repoRoot, { fs } = {}) {
  if (!repoRoot) return [];
  const scan = fs?.scanRepo;
  if (typeof scan === 'function') return await scan(repoRoot);
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const out = [];
  const walk = async (dir) => {
    if (out.length >= REPO_SCAN_MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= REPO_SCAN_MAX_FILES) return;
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      if (REPO_SCAN_IGNORES.has(e.name)) continue;
      const rel = join(dir, e.name).slice(repoRoot.length + 1).split('\\').join('/');
      if (e.isDirectory()) await walk(join(dir, e.name));
      else out.push(rel);
    }
  };
  await walk(repoRoot);
  return out;
}

export { buildCodeIndex };

/**
 * 把一次原子编辑写回仓库正本（commit 落盘本体）。
 * 三保险：preimage 备份 + oldText 唯一性校验 + denylist。
 * fs.writeRepo 可注入测试。返回 {ok, path, preimagePath, bytes} 或 {ok:false, reason}。
 */
export async function commitToRepo({ repoRoot, relPath, oldText, newText, fs, now = new Date() }) {
  const norm = String(relPath ?? '').split('\\').join('/').replace(/^\.\//, '');
  if (!repoRoot) return { ok: false, reason: 'no repoRoot' };
  if (!norm || norm.includes('..')) return { ok: false, reason: `unsafe path: ${norm}` };
  if (COMMIT_DENYLIST.some((d) => norm === d || norm.includes(d))) {
    return { ok: false, reason: `denylist hit: ${norm}` };
  }
  let text;
  try {
    text = await readRepoText({ repoRoot, relPath: norm, fs });
  } catch (error) {
    return { ok: false, reason: `read failed: ${error?.message ?? error}` };
  }
  const count = text.split(oldText).length - 1;
  if (count !== 1) {
    return { ok: false, reason: `oldText occurs ${count} times (need exactly 1)` };
  }
  const postimage = text.replace(oldText, newText);
  const { writeFile, mkdir, copyFile } = await import('node:fs/promises');
  const { join, dirname, resolve: pathResolve } = await import('node:path');
  const abs = pathResolve(repoRoot, norm);
  // preimage 备份：.agint-preimage/<路径扁平化>-<ISO 时间>.bak
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backupRel = `.agint-preimage/${norm.split('/').join('__')}__${stamp}.bak`;
  const backupAbs = join(repoRoot, backupRel);
  await mkdir(dirname(backupAbs), { recursive: true });
  if (typeof fs?.writeRepo === 'function') {
    await fs.writeRepo(norm, postimage);
  } else {
    await copyFile(abs, backupAbs);
    await writeFile(abs, postimage, 'utf8');
  }
  return {
    ok: true,
    path: norm,
    preimagePath: backupRel,
    bytesBefore: Buffer.byteLength(text, 'utf8'),
    bytesAfter: Buffer.byteLength(postimage, 'utf8'),
  };
}

/**
 * 按文件类型选择验证器（v0.2.8）。
 *
 * ## 为什么不能只用 sandbox.runSmoke
 *
 * `agint-quality-sandbox` 的 `runSmoke` 是**插件结构冒烟**：dynamic import
 * `lib/index.js` + 校验 `package.json` 含 name/main/type + exports 含 apply/inject
 * （见该插件 lib/smoke.js 头注释）。而本插件的 commit 目标是**任意仓库文件** ——
 * SKILL.md / cordis.patch.yml / bin/*.sh / 任何 subagent 指名的文件。
 *
 * 2026-09-29 实测：把 `bin/plugin-check.sh` 交给 runSmoke，返回
 * `ok:false reason=package-json-missing`（去 `bin/plugin-check.sh/package.json`
 * 找插件清单）。即 runSmoke 对非插件目录**恒失败** ⇒ policy 恒 REJECT/ABSTAIN ⇒
 * commit 恒被拒。这是语义不匹配，不是配置问题，调 allowInProcessFallback 修不好。
 *
 * ## 一个必须绕开的坑：node --check 对 ESM 漏检
 *
 * 2026-09-29 实测（本机 node v22+）：
 *
 * | 文件内容 | 扩展名 | `node --check` 退出码 |
 * | --- | --- | --- |
 * | `export const a = ;`（明显语法错） | `.js` | **0 —— 漏检** |
 * | `const a = ;` | `.js` | 1 ✅ |
 * | `export const a = ;` | `.mjs` | 1 ✅ |
 *
 * 即 `node --check` 按 CJS 规则解析 `.js`，遇到顶层 ESM 标记就不报错。
 * 而 AGINT 仓库里几乎所有 `lib/*.js` 都是 ESM —— **不处理这一条，第 4 道闸恰好在
 * 最需要它的场景上完全失灵**，比没有闸更危险（看起来绿了，其实什么都没验）。
 *
 * 修法：`.js` 先按内容判是不是 ESM（含顶层 import/export 形式），是则复制成临时
 * `.mjs` 再 `--check`（实测可检出）；不是则直接 `--check`（CJS 保持原路径，避免把
 * 合法 CJS 判死 —— 那样会产生假阳性）。`.mjs` / `.cjs` 扩展名自带语义，直接检。
 *
 * ## 现在的策略
 *
 * | 目标 | 验证器 |
 * | --- | --- |
 * | 目录（插件目录） | `sandbox.runSmoke`（它唯一擅长的场景，保留） |
 * | `.sh` / `.bash` | `bash -n` 语法检查（只解析，不执行） |
 * | `.js` / `.mjs` / `.cjs` | `node --check`（`.js` 按 ESM/CJS 分流，见上） |
 * | 其他（`.md` / `.yaml` / `.json` / `.txt` …） | 跳过 —— 纯数据/文档无「语法可用」概念 |
 *
 * 语义对齐「这个文件改完还解析得了吗」，而非「这个插件结构完不完整」。
 * 结果仍交 `policy.decide` 定夺，本函数不自行决定去留。
 *
 * 返回 `{ ok, mode, reason?, exitCode?, skipped? }`。
 * 验证器缺失（PATH 里没有 bash 等）不静默当通过 —— 返回 `ok:false` 并说明。
 */
export async function verifyTargetFile({ repoRoot, relPath, sandbox }) {
  const norm = String(relPath ?? '').split('\\').join('/').replace(/^\.\//, '');
  if (!repoRoot) return { ok: false, mode: 'none', reason: 'no repoRoot' };
  if (!norm || norm.includes('..')) return { ok: false, mode: 'none', reason: `unsafe path: ${norm}` };
  // 本文件顶层没有 node:path 静态导入（commitToRepo 等一律函数内动态 import），这里保持一致。
  const { join: pathJoin } = await import('node:path');
  const abs = pathJoin(repoRoot, norm);

  let isDir = false;
  try {
    const { statSync } = await import('node:fs');
    isDir = statSync(abs).isDirectory();
  } catch (error) {
    return { ok: false, mode: 'none', reason: `stat failed: ${error?.message ?? error}` };
  }

  // 目录 = 插件目录，交给 runSmoke（它唯一擅长的场景）
  if (isDir) {
    if (typeof sandbox?.runSmoke !== 'function') {
      return { ok: false, mode: 'sandbox', reason: 'directory target but sandbox.runSmoke unavailable' };
    }
    try {
      const r = await sandbox.runSmoke({ target: { path: abs, name: norm } });
      return { ok: Boolean(r?.ok), mode: 'sandbox', reason: r?.reason, exitCode: r?.exitCode };
    } catch (error) {
      return { ok: false, mode: 'sandbox', reason: `runSmoke threw: ${error?.message ?? error}` };
    }
  }

  const dot = norm.lastIndexOf('.');
  const ext = dot < 0 ? '' : norm.slice(dot).toLowerCase();
  const isShell = ext === '.sh' || ext === '.bash';
  const isJs = ext === '.js' || ext === '.mjs' || ext === '.cjs';
  if (!isShell && !isJs) {
    return {
      ok: true, mode: 'skip', skipped: true,
      reason: `no syntax concept for '${ext || "(no ext)"}' — 交给 policy.decide 定夺`,
    };
  }

  // `.js` 若是 ESM，复制成临时 `.mjs` 再检（见文件头「node --check 对 ESM 漏检」）
  let checkPath = abs;
  let tmpPath = null;
  if (ext === '.js') {
    try {
      const { readFile, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const source = await readFile(abs, 'utf8');
      const looksEsm = /^[ \t]*(?:import[ \t{*'"]|export[ \t{*])/m.test(source);
      if (looksEsm) {
        tmpPath = pathJoin(tmpdir(), `agint-verify-${randomUUID()}.mjs`);
        await writeFile(tmpPath, source, 'utf8');
        checkPath = tmpPath;
      }
    } catch (error) {
      return { ok: false, mode: 'syntax:.js', reason: `ESM sniff failed: ${error?.message ?? error}` };
    }
  }

  try {
    const { spawnSync } = await import('node:child_process');
    const [cmd, args] = isShell
      ? ['bash', ['-n', checkPath]]
      : [process.execPath, ['--check', checkPath]];
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000 });
    if (r.error) {
      // 验证器本身不可用（PATH 里没有 bash 等）—— 不静默当通过。
      return { ok: false, mode: `syntax:${ext}`, reason: `runner unavailable: ${r.error.message}` };
    }
    const ok = r.status === 0;
    return {
      ok,
      mode: `syntax:${ext}`,
      exitCode: r.status ?? null,
      reason: ok ? undefined : `${cmd} exited ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 500)}`,
    };
  } catch (error) {
    return { ok: false, mode: `syntax:${ext}`, reason: `spawn failed: ${error?.message ?? error}` };
  } finally {
    if (tmpPath) {
      try {
        const { rm } = await import('node:fs/promises');
        await rm(tmpPath, { force: true });
      } catch { /* 临时文件残留无害，不影响判定 */ }
    }
  }
}

/**
 * 把失败原因记进 `agint.evolution` 的 failure_pattern 表（v0.2.8）。
 *
 * ## 为什么落在 evolve 而不是 mutator.findings
 *
 * `agint.mutator` 没有暴露 findings 的直接写入口 —— 唯一写 `findings` 表的是
 * `validate()`，而它的 4 条约束全是**提案形态**校验（原子性 / 可证伪 / 回滚条件 /
 * payload 形态，见 agint-mutator/lib/index.js:453-461）。把「commit 写入后验证失败」
 * 塞进去属于滥用该表语义，会让 findings 表混入两种互不相干的含义。
 *
 * `agint.evolution.addFailure` 才是这个用途的正路：**sandbox 插件自己就在用**
 * （agint-quality-sandbox/lib/index.js:296-299 写 `sandbox-smoke-failed:*`），
 * 有 pattern / category / severity / evidence 四个字段，且直接喂给 self-model 与
 * evolve 循环 —— 失败因此能变成下次改进的输入，而不是躺在没人看的表里。
 *
 * 软依赖：evolve 不可用时静默跳过（记录失败不该反过来打断主流程）。
 */
export async function recordFailure({ evolve, pattern, category = 'integration', severity = 'high', evidence = '' }) {
  if (!evolve || typeof evolve.addFailure !== 'function') return { ok: false, reason: 'agint.evolution unavailable' };
  try {
    await evolve.addFailure({ pattern, category, severity, evidence });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
}

/**
 * 从 preimage 备份恢复文件（B 方案的回滚本体）。
 *
 * commitToRepo 每次写入前都 copyFile 到 `.agint-preimage/<扁平化路径>-<时间>.bak`，
 * 所以回滚不需要 git、不需要额外快照 —— 直接把那份备份拷回原位即可。
 *
 * 与 `commitToRepo` 的 fs 注入约定保持一致：注入 `fs.writeRepo` 的测试场景不碰真实磁盘，
 * 这里同样直接返回 ok（测试自己维护虚拟文件系统状态）。
 *
 * 返回 `{ok:true, restoredBytes}` 或 `{ok:false, reason}`。
 */
export async function restoreFromPreimage({ repoRoot, relPath, preimagePath, fs }) {
  const norm = String(relPath ?? '').split('\\').join('/').replace(/^\.\//, '');
  if (!repoRoot) return { ok: false, reason: 'no repoRoot' };
  if (!norm || norm.includes('..')) return { ok: false, reason: `unsafe path: ${norm}` };
  if (COMMIT_DENYLIST.some((d) => norm === d || norm.includes(d))) {
    return { ok: false, reason: `denylist hit: ${norm}` };
  }
  if (!preimagePath) return { ok: false, reason: 'no preimagePath' };
  if (typeof fs?.writeRepo === 'function') {
    // 注入虚拟 fs：写回内容由调用方测试夹具处理，这里只做形状校验后放行。
    return { ok: true, restoredBytes: null, injected: true };
  }
  try {
    const { readFile, writeFile, mkdir } = await import('node:fs/promises');
    const { join: j, dirname: d, resolve: r } = await import('node:path');
    const backup = await readFile(j(repoRoot, preimagePath));
    const abs = r(repoRoot, norm);
    await mkdir(d(abs), { recursive: true });
    await writeFile(abs, backup);
    return { ok: true, restoredBytes: backup.length, preimagePath };
  } catch (error) {
    return { ok: false, reason: `restore failed: ${error?.message ?? error}` };
  }
}

export async function spawnLlm(ctx, {
  system,
  user,
  schema,
  timeoutMs,
  preset = DEFAULT_AGENT_PRESET,
  provider = null,
  model = null,
}) {
  const agents = ctx?.get?.('agents');
  const subagents = ctx?.get?.('subagents');
  if (!agents || typeof agents.create !== 'function') return { ok: false, reason: 'agents unavailable' };
  if (!subagents || typeof subagents.start !== 'function') return { ok: false, reason: 'subagents unavailable' };
  // 前置自检：provider 没注册就别建会话了 —— 否则每次跑都在磁盘上多一个空壳会话。
  if (typeof subagents.getProvider === 'function' && !subagents.getProvider('spawn')) {
    return { ok: false, reason: 'spawn provider not registered' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('evolution-driver-timeout'), timeoutMs);
  let handle = null;
  let run = null;
  try {
    // ⭐⭐ 第二个根因（2026-09-27 二次取证）：只给 meta.agentPreset **还不够**。
    //   实测对照：dream 的 child 跑通（modelSelection=minimax-cn/MiniMax-M3、outTok=409），
    //   driver 的 child 空壳（modelSelection=null、surfaceTokens=0、outTok=0），
    //   两边 parent 字段完全一致 —— 唯一差异是 dream 额外传了 agentOptions:{provider, model}。
    //   即：preset 管 persona/工具，**provider+model 才是模型路由本身**；不传 ⇒ 无路由 ⇒ 空壳。
    //   来源优先级：显式入参 > 宿主服务 agentDefaultModel.currentSelection() > 兜底常量。
    //   走宿主服务是为了**不硬编码模型名**（K99：配错比不配更糟，模型名会随部署漂移）。
    const selection = typeof ctx?.get === 'function'
      ? ctx.get('agentDefaultModel')?.currentSelection?.() ?? null
      : null;
    const resolvedProvider = provider ?? selection?.provider ?? DEFAULT_LLM_PROVIDER;
    const resolvedModel = model ?? selection?.model ?? DEFAULT_LLM_MODEL;
    const agentOptions = { provider: resolvedProvider, model: resolvedModel };

    handle = await agents.create({
      sessionId: `evolution-driver-${randomUUID()}`,
      // ⭐ agentPreset 不能省：省了 ⇒ child 无模型路由 ⇒ 建得出会话、跑不动一步（30 个空壳的血债）
      meta: { cwd: process.cwd(), origin: 'subagent', ...(preset ? { agentPreset: preset } : {}) },
      // ⭐ agentOptions 同样不能省：它是 provider/model 的载体（第二个空壳根因）
      agentOptions,
      signal: controller.signal,
    });
    run = await subagents.start('spawn', {
      parent: handle.agent,
      prompt: [{ type: 'text', text: `${system}\n\n${user}` }],
      outputSchema: schema,
      signal: controller.signal,
      label: 'agint-evolution-driver mutation',
    });
    const result = await run.result;
    if (result?.stopReason !== 'completed') {
      return { ok: false, reason: `stopReason=${result?.stopReason ?? 'unknown'}` };
    }
    // ⭐ 结果在 `structured`，不在 `output`（第二处血泪 bug）。
    //    readResult() 的契约：带 outputSchema 时，结构化产出挂在 result.structured；
    //    result.output 只是 assistant 的最终文本。读 output ⇒ applicable 恒 undefined
    //    ⇒ 每条都被判「不适用」⇒ 又是一种零产出，且同样不报错。
    const structured = result?.structured;
    if (structured === undefined || structured === null) {
      return {
        ok: false,
        reason: `structured output missing (stopReason=${result?.stopReason ?? 'unknown'})`,
        degraded: true,
      };
    }
    return { ok: true, value: structured };
  } catch (error) {
    return { ok: false, reason: `llm error: ${error?.message ?? String(error)}` };
  } finally {
    clearTimeout(timer);
    try {
      await run?.dispose?.();
    } catch {
      /* dispose 失败不阻断 */
    }
    try {
      await handle?.dispose?.();
    } catch {
      /* 同上 */
    }
  }
}

export default { apply };
