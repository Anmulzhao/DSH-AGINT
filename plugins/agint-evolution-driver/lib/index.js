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
import { createContractAuditor } from './contract-audit.js';
import { expectedEffectForTarget } from './expected-effect.js';
import { resolveTargetMetric } from './metric-resolver.js';
import { requestSynthMount } from './deploy-bridge.js';
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
// 2026-10-28：120s → 600s。实机取证（提案 2f91b72b / 846f4fbb 各失败 2 次）：
//   孩子会话的 turn 本身就要 100~120s（含定位文件），而成功案例耗时 58s / 92s
//   ＝ 已吃掉 48%~77% 预算 ⇒ 稍难一条必撞墙，且撞墙时**结果同时被丢弃**
//   （报错统一成 `timeout after 120000ms`，看不出「其实是模型跑完了但没交结构化输出」）。
//   ⛔ 这个闸门是**兜底**，不是节流阀：真正的成本闸是执行器的 maxAttempts + 周上限，
//   拿它当「省 token」的手段只会把可执行提案变成永久失败。
//   可用 env `AGINT_EVOLUTION_DRIVER_TIMEOUT_MS` 或 patch config `llmTimeoutMs` 覆盖。
const DEFAULT_TIMEOUT_MS = 600_000;
const TIMEOUT_ENV = 'AGINT_EVOLUTION_DRIVER_TIMEOUT_MS';
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
// 2026-10-25：host 注册模型已是 MiniMax-M3.1-Flash（-Preview 不可路由）。
const DEFAULT_LLM_MODEL = 'MiniMax-M3.1-Flash';
// MiniMax-M3.1-Flash 强制 adaptive thinking；不传档位会 400。
const DEFAULT_REASONING_EFFORT = 'high';

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
  '4. Do not invent APIs, commands, or text that does not appear in the file.\n' +
  // ⛔ 2026-10-28 实测（提案 2f91b72b）：孩子会话跑满 119s、最后一句是「Now I will construct the edit」，
  //    全程没调 structured_output ⇒ 父侧什么也拿不到，只能等超时。规则本身没人告诉过它。
  '5. You MUST deliver the answer as the structured-output tool call. Plain assistant text is NOT an answer: ' +
  'the caller cannot read it and the whole run will be recorded as failed.\n' +
  // ⛔ 同批实测：孩子会话的 cwd 曾是进程 cwd（家目录），于是 13/15 次工具调用都在 `ls`/`find` 找仓库。
  //    现在 cwd 已改成 repoRoot，但仍要在提示里封住「顺手探索」这条路。
  '6. The working directory IS the repository. Never go hunting for the project: the target path is given in ' +
  'the prompt and is relative to the working directory — read that exact path if you need text beyond the excerpt.',
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

/**
 * LLM 调用超时解析：env > patch config > 常量默认（600s）。
 *
 * ⛔ 2026-10-28 教训：这个值原先是写死的常量，于是「模型慢」这种环境差异
 *    只能靠改代码解决；而它的失败形态是**把已经跑完的 turn 一起丢掉**，
 *    从面板上看只剩下一个 `llm unavailable`，根因彻底不可见。
 *    非数字 / ≤0 一律当没配，别让一条脏 env 把闸门变成 0ms。
 */
export function resolveLlmTimeout(env = {}, config = {}) {
  const fromEnv = Number(env?.[TIMEOUT_ENV]);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.trunc(fromEnv);
  const fromCfg = Number(config?.llmTimeoutMs);
  if (Number.isFinite(fromCfg) && fromCfg > 0) return Math.trunc(fromCfg);
  return DEFAULT_TIMEOUT_MS;
}

/** 从提案文本里提取反引号包裹的仓库路径（`plugins/x/lib/y.js` 形态）。
 *
 *  2026-10-27 两处补：
 *  ① 字符集补 `~ $ { }` —— 提案里常写部署位路径
 *     `` `~/.dsh/.agint-bundle/plugins/agint-evolve/lib/index.js:793` ``，
 *     旧字符集不认 `~`，捕获会从 `/` 开始（`/.dsh/.agint-bundle/...`）。
 *  ② 允许路径后面跟行号/区间再收尾 —— 否则 `index.js:793` 因为结尾不是反引号
 *     而**整条抽不出来**（实机 `mentioned:1` 抽到的是正文里那个 `agint_evolve.json`，
 *     真正要改的 index.js 根本没进候选）。行号由 normalizeRepoPath 剥。
 *  归一化在 normalizeRepoPath 里做，这里只管「抽出来」。 */
export function extractRepoPaths(text) {
  const out = [];
  const re = /`([~$A-Za-z0-9_\-./{}]+\.(?:js|mjs|cjs|json|md|yml|yaml|txt|sh)(?::\d+(?:-\d+)?)?)`/g;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    const p = m[1].replace(/^\.\//, '');
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * 部署位路径 → 仓库相对路径。
 *
 * 2026-10-27 实机：提案「修复 agint-evolve 提案台 schema…」正文写的是面板里看到的
 * **部署位**路径（`~/.dsh/.agint-bundle/plugins/agint-evolve/lib/index.js:793`），
 * 而 `repoFiles` 是仓库相对路径（`plugins/agint-evolve/lib/index.js`）⇒ 求交恒空
 * ⇒ 一条**真能改**的提案被判 `not-actionable`，1.5 秒白跑一次，还要起一次 LLM。
 *
 * 归一化只剥**已知的壳**，不做模糊猜测：剥完还不认识就原样返回，让上层判「定位不到」。
 */
export function normalizeRepoPath(raw) {
  let p = String(raw ?? '').trim();
  if (!p) return '';
  p = p.replace(/:\d+(?:-\d+)?$/, ''); // 行号：index.js:793 / index.js:107-167
  p = p.replace(/\\/g, '/');           // Windows 分隔符
  p = p.replace(/^\.\//, '');
  p = p.replace(/^\$\{?DSH_HOME\}?\/?/, ''); // $DSH_HOME / ${DSH_HOME}
  p = p.replace(/^~\//, '');
  // ① 部署 bundle：<任意>/.agint-bundle/plugins/x → plugins/x
  let m = p.match(/\.agint-bundle\/(.+)$/);
  if (m) return m[1].replace(/^\.\//, '');
  // ② host 包位：<任意>/node_modules/@agint/host/plugins/x → plugins/x
  //    ⛔ 必须排在 ③ 之前：这条路径里也含 `plugins/`，先命中会把 node_modules 前缀留下。
  m = p.match(/node_modules\/@agint\/host\/(.+)$/);
  if (m) return m[1];
  // ③ profile 实体位：profiles/<名>/plugins/x → plugins/x
  m = p.match(/(?:^|\/)profiles\/[^/]+\/plugins\/(.+)$/);
  if (m) return `plugins/${m[1]}`;
  // ④ 绝对路径带仓库根：/…/DSH-AGINT/plugins/x → plugins/x
  m = p.match(/\/(?:DSH-AGINT|DSH-AGINT\.wiki)\/(.+)$/);
  if (m) return m[1];
  return p;
}

/**
 * 从抽到的路径里挑出仓库里真实存在的那个文件。返回 null = 定位不到（**不猜**）。
 *
 * 两级：先归一等值命中；再后缀兜底（提案只写半截 `lib/index.js`、或多一层父目录）。
 * ⛔ 后缀兜底有歧义就返回 null：`lib/index.js` 在多个插件里都有，改错文件比不改更糟。
 */
export function matchRepoFile(mentioned = [], repoFiles = []) {
  const set = new Set(repoFiles);
  const norm = [...new Set(mentioned.map(normalizeRepoPath).filter(Boolean))];
  const exact = norm.filter((p) => set.has(p));
  if (exact.length) return exact.sort((a, b) => b.length - a.length)[0];

  const cands = new Set();
  for (const p of norm) {
    if (!p.includes('/')) continue; // 单段太泛（`index.js` 能匹配半个仓库）
    for (const f of set) {
      if (f === p) { cands.add(f); continue; }
      if (f.endsWith(`/${p}`) || p.endsWith(`/${f}`)) cands.add(f);
    }
  }
  const uniq = [...cands];
  if (uniq.length === 1) return uniq[0];
  if (!uniq.length) return null;
  // 多个候选：只有其中一个**完整包含**其余路径时才算确定，否则算歧义。
  const sorted = uniq.sort((a, b) => b.length - a.length);
  const top = sorted[0];
  return sorted.every((x) => x === top || top.endsWith(`/${x}`)) ? top : null;
}

/**
 * 一次失败是「确定性的」还是「偶发的」。
 *
 * 2026-10-27 实机教训：自动执行失败后一律重试，但有些失败**重试也不会变** ——
 * 提案描述的目标在仓库里根本不存在（定位不到）、LLM 判定这条提案不适用、
 * 幻觉闸门判定 oldText 对不上、实体闸门判定捏造了实体。这类失败重试 = 每次
 * 再烧一遍 LLM，且结果逐字相同。实机那次：一条 oracle 复核类提案两次各 1 秒
 * 失败（attempts=1 → 2），第二次的产出与第一次完全一致。
 *
 * ⛔ 默认 transient（宁可多重试一次，也不要把偶发失败判成死刑）：判错方向的后果
 *    不对称 —— 把偶发当确定 = 提案永远不再自动跑；把确定当偶发 = 多烧一次 token。
 *    显式的 transient 标记优先于 deterministic（LLM 挂了就该重试）。
 */
const DETERMINISTIC_FAILURE_PATTERNS = [
  /no target asset resolved/,
  /llm judged not applicable/,
  /oldText not found in target file/,
  /oldText occurs \d+ times/,
  /empty or no-op edit/,
  /fabricated entities in newText/,
  /validate rejected/,
  /unsafe path/,
  /denylist hit/,
];
const TRANSIENT_FAILURE_PATTERNS = [
  /llm unavailable/,
  /llmFailure/,
  /propose threw/,
  /read failed/,
  /timeout/i,
  /ECONNRESET|ETIMEDOUT|ENOTFOUND/,
];

/**
 * @param {string} text failures 里的一行
 * @returns {'deterministic'|'transient'}
 */
export function classifyFailureKind(text) {
  const s = String(text ?? '');
  if (TRANSIENT_FAILURE_PATTERNS.some((re) => re.test(s))) return 'transient';
  if (DETERMINISTIC_FAILURE_PATTERNS.some((re) => re.test(s))) return 'deterministic';
  return 'transient';
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
  // 归一化后仍要报「部署位路径被认出来了没有」—— 只看原始串求交会把
  // 「写法不对」误报成「仓库里没有这个文件」，2026-10-27 就是这么误判的。
  const norm = [...new Set(mentioned.map(normalizeRepoPath).filter(Boolean))];
  const exact = norm.filter((p) => set.has(p));
  const hit = exact.length ? null : matchRepoFile(mentioned, repoFiles);
  return `mentioned:${mentioned.length} inRepo:${exact.length}`
    + `${hit ? ` suffix:${hit}` : ''} bodyLen:${String(candidate?.body ?? '').length}`;
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
    // 2026-10-27：先归一再求交。提案里写部署位路径（`~/.dsh/.agint-bundle/…`）
    // 是常态，直接 `set.has(raw)` 会恒 0 命中 ⇒ 真能改的提案被判不可执行。
    const hit = matchRepoFile(mentioned, repoFiles);
    if (hit) return { type: 'repo', id: hit };
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
    // A5：mutator 记账的两个计数器。`mutatorRecorded` = 写进 mutator.commits 的条数
    // （这条 commit 因此可被 mutator.rollback 回滚）；`mutatorRecordFailed` 非 0 =
    // 改动已落盘但账没记上 —— 后果是「改动能回滚、却查不到该回滚哪一条」。
    // 与 ledger 计数器同理，必须从 summary 外部可读。
    mutatorRecorded: 0,
    mutatorRecordFailed: 0,
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
    // §2.4.2 归档校验：扫过多少把锁、发现多少把对不上（含"链上有预测但锁行没了"）。
    // 非 0 就是安全事件，⛔ 不是统计噪声 —— 报告与 cron 都要看得见它。
    auditChecked: 0,
    auditTampered: 0,
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

  // 设计 §2.4.2 第 6 步「归档校验」的**调用点**。校验本体一直有
  // （`predictor.verifyHypothesisLock`，纯函数 + 单测），但全仓没有一个 caller ⇒
  // 那把锁只防"改 predictedDelta 数值"，不防"改完 hypothesis 内容让摘要对不上"，
  // 更不防"直接把 contract_locks 的行删掉"。sweep 把这三向都补上。
  const contractAuditor = createContractAuditor(ctx, { warn });

  /** 给报告用的截断版审计结论（verdicts 全表可能上百条，不进 summary）。 */
  function auditBrief(audit) {
    if (!audit) return null;
    return {
      ok: audit.ok,
      status: audit.status,
      checked: audit.checked ?? 0,
      counts: audit.counts ?? {},
      tampered: (audit.tampered ?? []).slice(0, 10),
      orphanPredictions: (audit.orphanPredictions ?? []).slice(0, 10),
      unverifiable: (audit.unverifiable ?? []).length,
      reason: audit.reason ?? null,
    };
  }

  /**
   * measureOutcomes —— 给 cron `outcome-measure` 用的服务入口。
   *
   * 与 runOnce 分开的理由：一个是"往前做进化"，一个是"往后量账"，
   * 排期窗口、成本、失败影响面都不同（量账要真跑测试，一次双态 ≈ 2× 子集耗时）。
   *
   * **先验锁，再量账**：篡改过的预测不许喂进 PQ 与知识桶。per-entry 的校验在
   * measurer 里（每条测之前重算一次），这里的 sweep 是**全表**的 ——
   * 它看得见那些本轮根本没被测量的锁（例如从没有条目接得上的、或历史遗留的）。
   *
   * 永不抛（外壳在 outcome-measurer / contract-audit 里已经做完，这里只加计数与截断）。
   * @param {object} [opts] { repoRoot?, env?, limit?, inject? }
   *   `inject.measurer` / `inject.auditor` = 测试缝（与 runOnce 的 `inject.fs/llm` 同一约定）。
   * @returns {Promise<object>} 本轮测量概览（含 `audit` 块）
   */
  async function measureOutcomes(opts = {}) {
    const env = opts.env ?? process.env;
    const repoRoot = opts.repoRoot ?? resolveRepoRoot(env, { repoRoot: cfgRepoRoot });
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_OUTCOME_LIMIT;
    const measurer = opts.inject?.measurer ?? outcomeMeasurer;
    const auditor = opts.inject?.auditor ?? contractAuditor;

    const audit = await auditor.sweep();
    state.auditChecked += audit?.checked ?? 0;
    state.auditTampered += (audit?.tampered ?? []).length + (audit?.orphanPredictions ?? []).length;
    for (const v of audit?.tampered ?? []) {
      warn('contract-audit: ⛔ 锁重算对不上（该条不计入任何统计）', {
        contractId: v.contractId, status: v.status, storedLock: v.storedLock, recomputed: v.recomputed,
      });
    }
    for (const o of audit?.orphanPredictions ?? []) {
      warn('contract-audit: ⛔ 链上有预测却没有锁行（证据被删？）', {
        contractId: o.contractId, seq: o.seq, predictedDelta: o.predictedDelta,
      });
    }

    const out = await measurer.measurePending({ repoRoot, limit });
    for (const r of out.results ?? []) {
      if (r.status === 'MEASURED') state.outcomeMeasured += 1;
      else state.outcomeRefused += 1;
      if (r.status === 'CONTRACT_TAMPERED') state.auditTampered += 1;
      if (r.needsAttention === true) {
        state.outcomeAttention += 1;
        warn('outcome: 护栏未核过，需人工确认仓库状态', { contractId: r.contractId, status: r.status, changedPath: r.changedPath ?? null });
      }
    }
    // results 里塞不进日志的一行摘要：每条只留判读字段，整份留给 cron 落盘文件。
    return { ...out, repoRoot: repoRoot ?? null, limit, audit: auditBrief(audit) };
  }

  /**
   * 让 LLM 把提案变成一次原子编辑。
   * 注入点：opts.llm（测试用），否则走 agents.create + subagents.start。
   * @param {object} [opts.entityGate] 实体存在性门：{ repoFiles, getCodeIndex }；
   *   缺省/null = 不启用（旧测试兼容）。getCodeIndex() 返回 null = 索引不可用 → snake 类放行并降级告警。
   * @param {number} [opts.timeoutMs] 显式超时；缺省按 env/config/常量（见 resolveLlmTimeout）。
   * @param {string} [opts.cwd] 孩子会话的工作目录（＝仓库根）。缺省回落 cfgRepoRoot → process.cwd()。
   */
  async function construct({
    candidate,
    targetId,
    fileText,
    timeoutMs = null,
    llm = null,
    entityGate = null,
    cwd = null,
  }) {
    const build = llm ?? ((args) => spawnLlm(ctx, args));
    const effectiveTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Math.trunc(Number(timeoutMs))
      : resolveLlmTimeout(process.env, config);
    const workDir = (typeof cwd === 'string' && cwd.trim()) ? cwd.trim() : (cfgRepoRoot ?? null);
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
        '## Working directory',
        workDir ?? '(the repository root that contains the target path below)',
        '',
        `## Target file: ${targetId}`,
        // ⛔ 别再只说「verbatim text」：sweep.js 有 96.5KB，20000 字符必被截断，而模型察觉截断后
        //    会去全盘找仓库（2026-10-28 实测 13 次 bash 全用在 ls/find）。这里把「去哪读剩下的」写成一句话。
        `(excerpt below may be truncated. The full file is \`${targetId}\` relative to the working directory — ` +
        'if your anchor lies beyond the excerpt, read THAT exact path. Do not search the filesystem for it.)',
        '```',
        String(fileText).slice(0, DEFAULT_SNIPPET),
        '```',
        '',
        'Reply with the structured output: one atomic edit, or applicable=false.',
        'Do not reply with prose only — the caller only receives the structured-output call.',
      ].join('\n'),
      schema: MUTATION_OUTPUT_SCHEMA,
      timeoutMs: effectiveTimeout,
      cwd: workDir,
    });
    if (!out || out.ok !== true) {
      // LLM 通路失败 = 硬失败，由 runOnce 中止本轮并抛错；⛔ 不再静默计入 degraded。
      return { ok: false, llmFailure: true, reason: out?.reason ?? 'llm unavailable' };
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
   * @param {string} [opts.proposalId] 定向执行这一条提案（2026-10-27）。
   *   不带 = 老行为（挑 status:'proposed' 的一批）。
   *   带 = **允许 approved**、只处理这一条、且不受 `state.seen` 影响。
   *   为什么必须允许 approved：批准之后由 agint-executor 自动执行，
   *   若这里还只认 proposed，执行器永远挑不到东西（这正是本次要补的断链）。
   */
  async function runOnce(opts = {}) {
    const onlyId = typeof opts.proposalId === 'string' && opts.proposalId !== '' ? opts.proposalId : null;

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
        // A5：mutator 记账结果同理外部可读。
        mutatorRecorded: state.mutatorRecorded,
        mutatorRecordFailed: state.mutatorRecordFailed,
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
      if (onlyId) {
        // 定向执行：直接取那一条。状态门在这里显式判，不用 listProposals 过滤 ——
        // 「批了才跑」是执行器的前置条件，driver 只是不主动拒绝 approved。
        const one = typeof evolve.getProposal === 'function' ? await evolve.getProposal(onlyId) : null;
        if (!one) {
          await emitSummary('proposal-not-found', { proposalId: onlyId });
          return { skipped: true, reason: `proposal not found: ${onlyId}`, proposalId: onlyId };
        }
        const allowed = opts.allowAnyStatus === true || one.status === 'approved';
        if (!allowed) {
          await emitSummary('proposal-not-approved', { proposalId: onlyId, status: one.status ?? null });
          return {
            skipped: true,
            reason: `proposal ${onlyId} status=${one.status} 不是 approved（定向执行只跑已批准的提案）`,
            proposalId: onlyId,
            status: one.status ?? null,
          };
        }
        proposals = [one];
      } else {
        proposals = await evolve.listProposals({ status: 'proposed' });
      }
    } catch (error) {
      state.degraded += 1;
      state.lastError = `listProposals failed: ${error?.message ?? String(error)}`;
      warn('runOnce skipped', { reason: state.lastError });
      await emitSummary('listProposals-failed');
      return { skipped: true, reason: state.lastError };
    }

    // 可用技能清单：注入优先；否则按多候选根解析（repoRoot → DSH_HOME → 包内相对）。
    // 2026-10-13：解析失败不再静默返回 []。原因是「路径算错」与「真没有技能」
    // 在 summary 上必须可区分 —— 此前 availableSkills 恒 0 且无任何原因，
    // 让「闭环没产出」与「技能清单读不到」看起来一模一样。
    let available = Array.isArray(inj.skillNames) ? inj.skillNames : null;
    // skills 根解析留痕（供 summary 用；注入 skillNames 时也记一份，便于核对）
    let skillsRootInfo = { base: null, attempts: [] };
    if (!available) {
      try {
        // repoRoot 此时尚未解析（在下方 612 行），先用同样的口径算一遍拿给 skills 用
        const skillsRepoRoot = resolveRepoRoot(opts.env ?? process.env, { repoRoot: cfgRepoRoot });
        skillsRootInfo = await resolveSkillRoot(skillsRepoRoot);
        available = await listSkillNames({ roots: inj.skillRoots, repoRoot: skillsRepoRoot });
      } catch (error) {
        warn('skill names unavailable; evolution-cycle will have no target', {
          error: error?.message ?? String(error),
        });
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
      // 定向执行不看 seen：`seen` 的作用是「一轮里别重复试同一条」，
      // 而这里本来就只有一条，且失败重试必须能再跑（否则第一次失败后永久哑火）。
      if (!onlyId) {
        if (state.seen.has(candidate.id)) continue;
        state.seen.add(candidate.id);
      }

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
            ? await readSkillText({ skillName: targetId, fs, roots: inj.skillRoots, repoRoot })
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

      // ⛔ 必须显式传 cwd＝repoRoot（2026-10-28 取证：不传则孩子会话拿 process.cwd()，
      //    实机是 `~/桌面` 或 `~`，于是 15 次工具调用里 13 次在 `ls`/`find` 找仓库，
      //    turn 烧到 119s 才结束，撞 120s 闸门后连结果一起丢）。
      const built = await construct({
        candidate, targetId, fileText, llm: inj.llm ?? null, entityGate, cwd: repoRoot ?? null,
      });
      if (built.llmFailure) {
        // 无降级：LLM 通路失败就不再往下试（继续试只会重复失败且可能重复计费）。
        // 发 summary + 抛错，让 cron 的 lastError 亮起来。
        state.lastError = `llm unavailable: ${built.reason ?? 'unknown'}`;
        failures.push(`${candidate.id}: ${state.lastError}`);
        await emitSummary('llm-unavailable', {
          poolSize: pool.length,
          availableSkills: Array.isArray(available) ? available.length : 0,
          repoFiles: repoFiles.length,
          repoRoot: repoRoot ?? null,
          failures: failures.slice(0, 30),
          failuresTotal: failures.length,
          lastError: state.lastError,
        });
        throw new Error(`evolution-driver aborted: ${state.lastError}`);
      }
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
                // 这不是笔误：agint-mutator/lib/index.js:871 那条注释说
                // 「mutator 至今仍只传 name，所以 mutator.commit 一旦被真正启用也会恒被拒」。
                // **该注释已于2026-10-03 复核为过期**（A5 取证）：mutator 侧早已在
                // commit() 里同时传 key 与 name（agint-mutator/lib/index.js:877-885
                // 同形），sandbox 的绝对路径传参也已修好（:658-660 传 absTarget）。
                // driver 是照抄来的，两边现在口径一致。留此注记以防照着过期注释去"修"好的代码。
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
                // ── A5（2026-10-03）：把这次 commit 记进 mutator 的 commits 表。
                //   此前 driver 走自己的 commitToRepo 落盘路径，commits 表恒空 ⇒
                //   (1) mutator_stats.commits 恒 0（reconcile 的 mutatorDegraded 恒告警）；
                //   (2) 更要紧的是 mutator.rollback 读不到这条 commit ⇒ driver 产出的
                //       改动在 mutator 侧不可回滚。
                //   ⛔ 幂等键**不**直接用 outcomeEventId（2026-10-03 修正）。publish() 在事件总线
                //   不可用 / accepted:false 时返回 null（:349/:361），而 commitId 是
                //   recordExternalCommit 的必填项 —— 用它当键会让「总线恰好坏了」这一次
                //   commit 永远记不上账。第一版真会如此：mock 用错 publish 签名 ⇒
                //   envelopeId 全 null ⇒ 10 条用例 5 条红。改成「有 envelopeId 就用它
                //   （能与事件对账），没有就本地生成」—— 记账不该依赖观测通道是否可用。
                //   ⛔ 记账失败**不**回滚已落盘的改动，也不改 policyDecision：
                //     改动已经过了 sandbox + policy 两道闸，记账是账目问题不是安全问题。
                //     但必须外部可读 —— 发一条 accounting-failed 事件（纪律 3）。
                try {
                  if (typeof mutator?.recordExternalCommit !== 'function') {
                    throw new Error('recordExternalCommit unavailable（mutator 版本过旧）');
                  }
                  const commitId = outcomeEventId
                    || `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
                  // postimageHash 必须是内容哈希，不能拿 bytesAfter 顶替 ——
                  // 字段名叫 hash，填字节数会让日后任何"比对 postimage 是否被改过"
                  // 的判据静默失效（K138：函数/字段名承诺的覆盖面 = 实际覆盖面）。
                  const postimageHash = await contentHashOf(commit.postimageContent);
                  const recorded = await mutator.recordExternalCommit({
                    commitId,
                    proposalId: proposal.id,
                    targetPath: commit.path,
                    preimageContent: commit.preimageContent,
                    postimageHash,
                    policyDecision: decision,
                    audit: {
                      proposalId: proposal.id,
                      commitId,
                      kind: proposal.kind ?? 'PROMPT_MUTATION',
                      source: proposal.source ?? 'evolution-reversed',
                      timestamp: new Date().toISOString(),
                      // driver 的 verify 语义与 mutator.commit 的 sandbox 同名不同源，
                      // 这里记实际跑出来的 mode，不假装成 mutator 的 sandboxResult。
                      sandboxResult: sandboxResult?.ok ? 'ok' : (sandboxResult?.reason ?? 'fail'),
                      rollbackTrigger: proposal.rollbackCondition ?? 'manual',
                    },
                  });
                  state.mutatorRecorded += (recorded?.recorded === true ? 1 : 0);
                  if (!outcomeEventId) {
                    // 事件没发出去但账记上了 —— 记账成功、观测失败。
                    // 必须留痕：否则事后「commits 表里有这条、事件总线里查不到」看着像数据不一致。
                    state.mutatorRecordFailed += 1;
                    state.lastError = 'committed event not published (accounting recorded without envelopeId)';
                    warn('committed event missing', {
                      proposalId: proposal.id, path: commit.path, commitId,
                    });
                  }
                } catch (recErr) {
                  state.mutatorRecordFailed += 1;
                  state.lastError = `mutator record failed: ${recErr?.message ?? String(recErr)}`;
                  warn('mutator record failed', {
                    proposalId: proposal.id, path: commit.path, reason: state.lastError,
                  });
                  // ⛔ 刻意**不**走 evolve.addFailure（2026-10-03 改判）。此前第一版
                  //   记在 addFailure 上，driver smoke 的「成功路径不应记录 failure」
                  //   立刻变红（T25/T25d）—— 那条红灯是对的：addFailure 是**进化失败模式**
                  //   通道，喂给 failure 归因与后续进化决策。账目没记上是运维/接线问题，
                  //   混进去会让「进化失败原因」被账目故障污染，归因器（A4）的读数跟着失真。
                  //   改走事件总线：这是本插件唯一外部可读的出口（纪律 3，warn→stdout读不到），
                  //   且 ledger-rebuild 只认 4 个固定 outcome topic（ledger-rebuild.js:68-72），
                  //   新 topic 不会混进 Ledger 重建。
                  await publish('evolution.mutation.accounting-failed', {
                    proposalId: proposal.id,
                    path: commit.path,
                    committedEventId: outcomeEventId,
                    policyDecision: decision,
                    reason: recErr?.message ?? String(recErr),
                  });
                }
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
      // 2026-10-13：skills 根的解析留痕。availableSkills=0 时必须能回答
      // 「是真没有技能，还是路径算错」——此前这里只有一个 0。
      skillsRoot: skillsRootInfo.base ?? null,
      skillsRootAttempts: skillsRootInfo.attempts,
      seen: state.seen.size,
      degraded: state.degraded,
      lastError: state.lastError,
    };
    warn('runOnce ended with no actionable candidate', summary);
    // 2026-10-27：区分「这次没候选」与「这条提案没有可执行语义」。
    //
    // 定向模式（proposalId 指定）下，候选**就是那一条** —— 跑不出东西意味着
    // 这条提案没有可改的目标，而不是「暂时没合适的候选」。这两种混在一起，
    // 执行器就会当成偶发失败去重试（实机：oracle 复核类提案两次各 1 秒失败，
    // 第二次产出与第一次逐字相同，纯浪费）。
    //
    // 判「确定性」只看失败原因本身：定位不到目标 / LLM 判定不适用 / 幻觉闸门
    // 拒绝 / 实体闸门捏造 —— 这些重试不会变。sweep 模式（不指定 proposalId）
    // 仍按原语义：以后可能有新候选，不算确定性失败。
    const kinds = failures.map((f) => classifyFailureKind(f));
    const deterministic = onlyId !== null && failures.length > 0 && kinds.every((k) => k === 'deterministic');
    return {
      skipped: true,
      reason: deterministic
        ? `not-actionable（这条提案没有可改的目标，重试也不会变）：${String(failures[0] ?? '').slice(0, 300)}`
        : 'no actionable candidate（无候选 / 定位不到目标 / LLM 判定不适用）',
      deterministic,
      failures: failures.slice(0, 30),
      ...summary,
    };
  }

  /**
   * 定向执行一条已批准的提案（agint-executor 的唯一入口，2026-10-27）。
   *
   * 与 runOnce 的差别只有三点，其余流水线完全一致（构造 → mutator → D-QAF →
   * commit → 预测锁定 → ledger）：
   *   ① 只处理传入的 proposalId，且允许 status='approved'
   *   ② 不写 `state.seen`，失败重试能再跑
   *   ③ 返回里补 `proposalId` 与 `ok`，让执行器不必自己解释 driver 的返回形状
   *
   * ⛔ 不在这里做「状态 → applied」：写提案状态是 agint.evolve 的事，
   *    driver 只回执行事实。两边都写 = 两套口径。
   */
  async function runForProposal(proposalId, opts = {}) {
    if (typeof proposalId !== 'string' || proposalId === '') {
      return { skipped: true, ok: false, reason: 'runForProposal: proposalId 必填' };
    }
    const out = await runOnce({ ...opts, proposalId });
    const ok = out?.skipped === false && out?.commit?.ok === true;
    return { ...out, proposalId, ok };
  }

  function status() {
    return {
      runs: state.runs,
      proposed: state.proposed,
      ingested: state.ingested,
      degraded: state.degraded,
      ledgerWritten: state.ledgerWritten,
      ledgerFailed: state.ledgerFailed,
      // A5：记账计数器与 ledger 计数器同处status()（成功路径唯一的结构化出口）。
      // cycle.summary 只在跳过/降级路径发（见下方 emitSummary 的 5 个调用点），
      // 所以成功路径的记账结果**只能**从 status() 读到 —— 挂在 summary 上是读不到的。
      mutatorRecorded: state.mutatorRecorded,
      mutatorRecordFailed: state.mutatorRecordFailed,
      predictionLocked: state.predictionLocked,
      predictionSkipped: state.predictionSkipped,
      outcomeMeasured: state.outcomeMeasured,
      outcomeRefused: state.outcomeRefused,
      outcomeAttention: state.outcomeAttention,
      auditChecked: state.auditChecked,
      auditTampered: state.auditTampered,
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
    // A 段「通电不上膛」：合成产物 ⇒ mount 的部署桥。
    // ⛔ 恒 PENDING_REVIEW，不自动 ACTIVATE（4 态里有 RESTART_REQUESTED，触碰重启红线）。
    requestSynthMount: (input) => requestSynthMount({ ctx, ...input }),
    // 2026-10-27：给 agint-executor 的「按提案定向执行」入口 —— 批准即执行的落点。
    runForProposal,
  });

  ctx.effect(() => () => {
    /* 无 interval / 无订阅：生命周期干净 */
  });
}

// ── 副作用：读技能文件 + 起子 agent（与纯逻辑分离，便于注入测试）─────────

/**
 * 解析 preset skills 根目录（2026-10-13 修）。
 *
 * 原实现：`new URL('../../../presets/agint/skills/', import.meta.url)`。
 * 部署位 `plugins/agint-evolution-driver/lib/index.js` 上三级 = `.agint-bundle/`，
 * 而 `.agint-bundle/presets/` **整个目录不存在** ⇒ readdir 抛 ENOENT ⇒
 * 被 runOnce 的 catch 吞成 `[]` ⇒ `availableSkills=0` ⇒
 * evolution-cycle 恒 skipped 'no actionable candidate'。
 * （实测：`.agint-bundle/presets/agint/skills` MISSING；真实 skills 在
 *   `D:\DSH\project源码\DSH-AGINT\presets\agint\skills` 与
 *   `D:\DSH\AGINT-date\.agent-presets\agint\skills`，各 10 个目录。）
 *
 * 候选根按序尝试，返回第一个存在的；全不存在时返回 null + 尝试过的清单
 * —— 调用方必须把 attempts 带进 summary，不许再静默返回空数组。
 *
 * @param {string} [repoRoot]  已解析的仓库根（含 presets/agint/skills）
 * @returns {{ base: string|null, attempts: string[] }}
 */
async function resolveSkillRoot(repoRoot) {
  const attempts = [];
  const { access } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { join } = await import('node:path');

  const candidates = [];
  // ① 仓库正本（最可靠：与 repoRoot 同源，随 repoRoot override 一起配）
  if (repoRoot) candidates.push(join(repoRoot, 'presets', 'agint', 'skills'));
  // ② DSH_HOME 下的 preset 部署位（$DSH_HOME/.agent-presets/agint/skills）
  if (process.env.DSH_HOME) {
    candidates.push(join(process.env.DSH_HOME, '.agent-presets', 'agint', 'skills'));
  }
  // ③ 原实现：相对插件自身位置（麒麟机 / 其他布局下可能成立）
  try {
    candidates.push(fileURLToPath(new URL('../../../presets/agint/skills/', import.meta.url)));
  } catch { /* URL 解析失败就跳过这一个候选 */ }

  for (const c of candidates) {
    attempts.push(c);
    try {
      await access(c);
      return { base: c, attempts };
    } catch { /* 不存在，试下一个 */ }
  }
  return { base: null, attempts };
}

async function readSkillText({ skillName, fs, roots, repoRoot }) {
  const read = fs?.readSkill;
  if (typeof read === 'function') return await read(skillName);
  const list = roots ?? null;
  if (typeof list === 'function') return await list(skillName);
  // 默认：多候选根解析（2026-10-13 修，原为单一硬编码相对路径）
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { base, attempts } = await resolveSkillRoot(repoRoot);
  if (!base) {
    throw new Error(`readSkillText: preset skills 根不存在（试过 ${attempts.length} 个：${attempts.join(' | ')}）`);
  }
  return await readFile(join(base, String(skillName), 'SKILL.md'), 'utf8');
}

/** 列出 preset skills 的目录名（默认发现路径，生产靠它拿到可用技能清单）。 */
async function listSkillNames({ roots, repoRoot } = {}) {
  if (typeof roots === 'function') return await roots();
  const { readdir } = await import('node:fs/promises');
  const { base, attempts } = await resolveSkillRoot(repoRoot);
  if (!base) {
    // 2026-10-13：不再静默返回 []。「真的没有技能」与「路径算错」在输出上
    // 必须可区分 —— 前者是正常空态，后者是配置故障。
    throw new Error(`listSkillNames: preset skills 根不存在（试过 ${attempts.length} 个：${attempts.join(' | ')}）`);
  }
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
 * 内容 SHA-256（十六进制裸串，无前缀）。
 *
 * A5：mutator.commits.postimageHash 的口径必须与 mutator.contentHash() 一致
 * （agint-mutator/lib/storage.js:103），否则两个插件写出的 hash 无法互相校验。
 * 拿不到 crypto.subtle 时**抛错而不是退化到 djb2** —— 退化算法写出的值会被
 * 当成真 SHA-256 用，让「比对内容是否被改过」静默失效（K138）。
 * mutator 侧有 djb2 兜底是因为它是展示性占位；这里是记账字段，不能有占位。
 */
async function contentHashOf(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  const c = globalThis.crypto;
  if (!c?.subtle?.digest) {
    throw new Error('contentHashOf: crypto.subtle.digest 不可用 —— 不写占位 hash');
  }
  const buf = await c.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
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
    // A5（2026-10-03）：把 preimage **内容**一并带出去。
    // 此前只给 preimagePath，导致 mutator.recordExternalCommit 拿不到 commits.preimageContent
    // —— 而那是 `mutator.rollback` 唯一的还原凭据（agint-mutator/lib/index.js:770 读表、
    // :786 用 SHA-256 校验、然后把 preimageContent 写回文件）。少这一项，driver 产出的
    // commit 在 mutator 侧**不可回滚**，且 mutator_stats.commits 恒为 0。
    // ⛔ 不返回 postimage：记账方需要的是「回退到什么」，不是「现在是什么」。
    preimageContent: text,
    postimageContent: postimage,
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
  cwd = null,
  preset = DEFAULT_AGENT_PRESET,
  provider = null,
  model = null,
  reasoningEffort = null,
}) {
  const agents = ctx?.get?.('agents');
  const subagents = ctx?.get?.('subagents');
  if (!agents || typeof agents.create !== 'function') {
    return { ok: false, reason: 'agents service missing (create() not callable)' };
  }
  if (!subagents) return { ok: false, reason: 'subagents service missing' };
  const hasActivation = typeof subagents.startActivation === 'function';
  const hasLegacyStart = typeof subagents.start === 'function';
  if (!hasActivation && !hasLegacyStart) {
    return {
      ok: false,
      reason: `subagents method missing (startActivation=${hasActivation}, start=${hasLegacyStart})`,
    };
  }
  // 前置自检：provider 没注册就别建会话了 —— 否则每次跑都在磁盘上多一个空壳会话。
  if (typeof subagents.getProvider === 'function') {
    let providerEntry = null;
    try {
      providerEntry = subagents.getProvider('spawn');
    } catch (error) {
      return { ok: false, reason: `getProvider('spawn') failed: ${error?.message ?? String(error)}` };
    }
    if (!providerEntry) return { ok: false, reason: 'spawn provider not registered' };
  }

  const controller = new AbortController();
  let rejectOnTimeout = null;
  const timeoutGuard = new Promise((_, reject) => { rejectOnTimeout = reject; });
  const timer = setTimeout(() => {
    controller.abort('evolution-driver-timeout');
    rejectOnTimeout?.(new Error(`timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  let handle = null;
  let activation = null;
  let cancelled = false;
  const disposeLate = (resource) => {
    try { Promise.resolve(resource?.dispose?.()).catch(() => { /* ignore */ }); } catch { /* ignore */ }
  };
  try {
    // ⭐⭐ 第二个根因（2026-09-27 二次取证）：只给 meta.agentPreset **还不够**。
    //   即：preset 管 persona/工具，**provider+model+reasoningEffort 才是模型路由本身**。
    //   来源优先级：显式入参 > 宿主服务 agentDefaultModel.currentSelection() > 兜底常量。
    let selection = null;
    try {
      selection = typeof ctx?.get === 'function'
        ? ctx.get('agentDefaultModel')?.currentSelection?.() ?? null
        : null;
    } catch { selection = null; }
    const agentOptions = {
      provider: provider ?? selection?.provider ?? DEFAULT_LLM_PROVIDER,
      model: model ?? selection?.model ?? DEFAULT_LLM_MODEL,
      reasoningEffort: reasoningEffort ?? selection?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    };
    const resolvedPreset = preset || DEFAULT_AGENT_PRESET;
    // ⛔ 孩子会话的 cwd 必须是仓库根，不能是进程 cwd（2026-10-28 实测见 construct 调用点注释）。
    const workDir = (typeof cwd === 'string' && cwd.trim()) ? cwd.trim() : process.cwd();

    const createPromise = agents.create({
      sessionId: `evolution-driver-${randomUUID()}`,
      // ⭐ agentPreset 不能省：省了 ⇒ child 无模型路由 ⇒ 建得出会话、跑不动一步（30 个空壳的血债）
      meta: { cwd: workDir, origin: 'subagent', agentPreset: resolvedPreset },
      // ⭐ agentOptions 同样不能省：它是 provider/model/reasoningEffort 的载体
      agentOptions,
      signal: controller.signal,
    }).then((h) => {
      if (cancelled) disposeLate(h);
      return h;
    });
    handle = await Promise.race([createPromise, timeoutGuard]);
    const prompt = [{ type: 'text', text: `${system}\n\n${user}` }];
    const startPromise = (hasActivation
      ? Promise.resolve().then(() => subagents.startActivation({
        provider: 'spawn',
        label: 'agint-evolution-driver mutation',
        request: {
          parent: handle.agent,
          prompt,
          agentPreset: resolvedPreset,
          agentOptions,
          outputSchema: schema,
        },
        signal: controller.signal,
        // caller：后台进化循环不回写父会话
        delivery: 'caller',
      }))
      : Promise.resolve().then(() => subagents.start('spawn', {
        parent: handle.agent,
        prompt,
        outputSchema: schema,
        signal: controller.signal,
        label: 'agint-evolution-driver mutation',
      }))).then((act) => {
      if (cancelled) disposeLate(act);
      return act;
    });
    startPromise.catch(() => { /* handled by race */ });
    activation = await Promise.race([startPromise, timeoutGuard]);
    const result = await Promise.race([activation.result, timeoutGuard]);
    if (result?.stopReason !== 'completed') {
      return { ok: false, reason: `stopReason=${result?.stopReason ?? 'unknown'}` };
    }
    // ⭐ 结果在 `structured`，不在 `output`（第二处血泪 bug）。
    const structured = result?.structured;
    if (structured === undefined || structured === null) {
      return {
        ok: false,
        reason: `structured output missing (stopReason=${result?.stopReason ?? 'unknown'})`,
      };
    }
    return { ok: true, value: structured };
  } catch (error) {
    return { ok: false, reason: `llm error: ${error?.message ?? String(error)}` };
  } finally {
    cancelled = true;
    clearTimeout(timer);
    try { await activation?.dispose?.(); } catch { /* dispose 失败不阻断 */ }
    try { await handle?.dispose?.(); } catch { /* 同上 */ }
  }
}

export default { apply };
