/**
 * agint-skill-autocreate: detector — 重复任务模式检测。
 *
 * 设计稿 §3.1 [3]：
 *   - 匹配规则：工具组合序列相同 + 参数结构相似度 ≥0.8 → 同一模式
 *   - 同一模式累计次数 ≥3 → 标记为「重复模式」
 *   - 重复模式写入 task_patterns 表
 *
 * 2026-09-13 新增成功率准入门（Hermes 对照 §六ter 建议 B）：
 *   次数门槛只证明「经常发生」，不证明「做对了」。稳定失败的序列重复
 *   3 次同样会跨过 minOccurrence，而它恰是最不该被沉淀成技能的东西。
 *   故新增：occurrenceCount 达标 **且** successRate ≥ minSuccessRate 才进
 *   newRepeat。被拦下的模式照常入库（可观测），只是不成候选。
 *
 * 纯函数模块，无 I/O。existingPatterns 为已入库 pattern 的业务字段数组。
 */

import { signatureOf } from './aggregator.js';

/** 成功率准入门默认值（配置键 min_pattern_success_rate，见 schema.js） */
export const DEFAULT_MIN_SUCCESS_RATE = 0.6;

/**
 * 领域工具：携带「这件事到底在干什么」语义的工具（质量门方案 §2 A1）。
 *
 * ⚠️ **本集合不参与判定，只用于观测分类。** 判据是黑名单（见 classifySpecificity）。
 * 保留它的唯一用途：让审计能区分「已知业务语义」与「没见过的工具」，
 * 从而回答「真实产出里有多少带业务语义」。
 *
 * 别费劲维护它：它是开放集合，永远补不全，补不全也不影响判定正确性。
 */
export const DOMAIN_TOOLS = new Set([
  'ssh_exec', 'ssh_upload', 'ssh_download', 'ssh_tunnel',
  'wiki_write', 'memory_write',
  'abtest_start', 'abtest_report',
  'curriculum_next', 'curriculum_submit',
  'skill',
]);
// 2026-09-18 移出（改归 SCAFFOLD_TOOLS，见下）：
//   - 第一批控制面：cron_run_now / eventBus_publish / restart_request / dream_run_now /
//     selfModel_update / evolution_logPhase4 / autocreate_release / curator_run_now /
//     wiki_lint / diagnosis_annotate
//   - 第二批（2026-09-18 修 schema 错配后，04:45 cron 触发发现）：
//     web_search / web_fetch / agint_search —— 「跨上下文查东西」是通用动作，
//     跟 memory_search / wiki_search 同性质（已归 SCAFFOLD_TOOLS），它们才是
//     业务写动作（写知识/写记忆）。注释与代码 09-17 脱节，今天才修正：
//     DOMAIN_TOOLS 误放这 3 个 → A1 门判 scaffoldOnly=false → 04:45 cron
//     自动发布了 2 个空壳（agintsearch-pwsh-askuserquestion-pwsh + pwsh-glob-webfetch-webfetch）。
// 原因：它们是「通用查询」/「操作 AGINT 自身」的动作，不携带业务领域语义。

/**
 * 通用脚手架黑名单 —— **A1 的真正判据，这是唯一需要维护的集合**。
 *
 * 为什么判据用黑名单而不是白名单（2026-09-18 定）：
 *   1. **封闭性**：通用动作是封闭小集合（读/写/编/搜/执行/待办），穷举得完；
 *      领域工具是开放集合，每加一个插件就多一批 —— 用开放集合当准入门槛，
 *      等于要求「每长出一个新工具就来登记一次」，那是人工参与，不是自动化。
 *   2. **失败方向**：黑名单误放（噪声溜进候选）下游还有 A2 具体值门、A3 信息量门、
 *      质量门、观察期兜底；白名单误杀（好模式永远不成技能）**没有任何下游能救**，
 *      且这种死法不可见 —— 与「可观测 > 可审批」直接冲突。
 *   3. **维护频率**：宿主新增通用动作（如一种新的 shell 工具）才需要动，极少发生。
 *
 * 它是否仍然封闭，靠审计 `pattern_specificity_unknown_tools` 兜底：
 * 那份列表里若混进大量"其实是通用动作"的工具，说明黑名单该补了。
 */
export const SCAFFOLD_TOOLS = new Set([
  'read', 'write', 'edit', 'glob', 'grep',
  'read_image',           // read 的图片变体（2026-09-18 依生产审计补入）
  'pwsh', 'bash',
  'todo_write', 'ask_user_question',
  'structured_output',    // 纯输出格式化，不携带任务语义（2026-09-18 依生产审计补入）
  'sidebar_open', 'job_output', 'job_list', 'list_agents',
  'memory_search', 'wiki_search',
  // ── 第三批（2026-09-18 修 schema 错配后，04:45 cron 触发发现）──
  // web_search / web_fetch / agint_search：跨上下文查东西的通用查询动作，
  // 跟 memory_search / wiki_search 同性质。DOMAIN_TOOLS 把它们误归「领域工具」
  // → A1 门判 scaffoldOnly=false → 让纯脚手架序列带个 web_fetch 就逃过门。
  // 跟 memory_search / wiki_search 并排放，方便对照理解「查询 = 通用」。
  'web_search', 'web_fetch', 'agint_search',

  // ── 第二批（2026-09-18 首次真实运行后，依审计 pattern_specificity_unknown_tools 补入）──
  // 判据：**操作 AGINT 自身**的控制面动作 —— 看状态、重启、触发内部任务、查自己
  // 的数据。任何 AGINT 任务都可能顺手做一步，它们不携带「这件事在干什么」的业务
  // 语义。实测证据：这批名字在审计里占满前 20 位，且已让两个噪声模式（含
  // restart_request 的序列）逃过门并生成候选。
  // 它们本来被误列在 DOMAIN_TOOLS（当作领域工具），现改归此处。
  'restart_status', 'restart_request',
  'autocreate_stats', 'autocreate_list_candidates', 'autocreate_list_patterns',
  'autocreate_list_releases', 'autocreate_get_candidate', 'autocreate_trigger_eval',
  'autocreate_release',
  'cron_list', 'cron_run_now',
  'dream_status', 'dream_diary', 'dream_run_now',
  'memory_read', 'memory_stats', 'memory_forget_scan',
  'evolve_propose', 'evolve_proposals', 'evolve_set_status', 'evolution_logPhase4',
  'curator_list', 'curator_run_now',
  'wiki_list', 'wiki_lint',
  'rule_check', 'recall_store_inspect',
  'selfModel_update', 'diagnosis_annotate',
  'eventBus_publish',
]);

/**
 * 特异性分类（纯函数）。**判据是黑名单**：序列里只要有一个工具不属于脚手架，
 * 就认为这段行为带有专属语义。
 *
 * @param {string[]} toolSequence 工具序列
 * @param {string[]} extraScaffoldTools 追加的脚手架名（与内置 SCAFFOLD_TOOLS 取并集，不替换）
 * @returns {{domain: string[], unknown: string[], scaffold: string[], scaffoldOnly: boolean}}
 *   domain   : 命中 DOMAIN_TOOLS 的业务工具（**仅观测**，不参与判定）
 *   unknown  : 两个名单都没有的工具 —— 判据上**等同于领域工具**（放行）
 *   scaffold : 命中的通用脚手架
 *   scaffoldOnly : 序列非空且每个工具都是脚手架 —— 唯一被拦的情形
 */
export function classifySpecificity(toolSequence, extraScaffoldTools = []) {
  const extra = new Set(extraScaffoldTools ?? []);
  const domain = [];
  const unknown = [];
  const scaffold = [];
  const tools = [...new Set(toolSequence ?? [])];
  for (const tool of tools) {
    if (SCAFFOLD_TOOLS.has(tool) || extra.has(tool)) scaffold.push(tool);
    else if (DOMAIN_TOOLS.has(tool)) domain.push(tool);
    else unknown.push(tool);
  }
  return {
    domain,
    unknown,
    scaffold,
    // 边界：空序列按「无特异性」处理 —— 一个工具都没用，没有任何证据表明
    // 它有专属语义。与 passesSuccessGate「缺数据就不猜」同向（宁可这次不沉淀）。
    scaffoldOnly: tools.length === 0 || scaffold.length === tools.length,
  };
}

/**
 * 特异性门判定。默认**开**（K42：这是拦错误的门，不是放大错误的门）。
 * opts.enabled === false 时恒放行（kill-switch）。
 */
export function passesSpecificityGate(toolSequence, opts = {}) {
  if (opts.enabled === false) return true;
  return !classifySpecificity(toolSequence, opts.scaffoldTools).scaffoldOnly;
}

/**
 * 参数结构相似度：两个 paramSignature map（tool → sig）的加权 Jaccard。
 * - 只在两边共有的工具上比较签名 token 集合的 Jaccard
 * - 工具集合本身不一致时按共有工具比例折减
 * 返回 [0,1]。
 */
export function paramSimilarity(sigA, sigB) {
  const toolsA = Object.keys(sigA ?? {});
  const toolsB = Object.keys(sigB ?? {});
  if (!toolsA.length || !toolsB.length) return 0;
  const setB = new Set(toolsB);
  const shared = toolsA.filter((t) => setB.has(t));
  if (!shared.length) return 0;
  const toolCoverage = shared.length / new Set([...toolsA, ...toolsB]).size;
  let sum = 0;
  for (const t of shared) {
    sum += jaccard(tokenize(sigA[t]), tokenize(sigB[t]));
  }
  return +((sum / shared.length) * (0.5 + 0.5 * toolCoverage)).toFixed(4);
}

function tokenize(sig) {
  return new Set(String(sig ?? '').split('|').flatMap((part) => part.split(':')));
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
}

/** 工具序列是否相同（设计稿：「工具组合序列相同」——严格全等） */
export function sequenceEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((t, i) => t === b[i]);
}

/**
 * 成功率门判定。
 *
 * 数据缺失（successRate 非有限数）时**不放行**，也不折算——宁可这次不沉淀，
 * 也不编造一个成功率去放行。与「真实 > 讨好」同向：缺数据就不猜。
 */
export function passesSuccessGate(successRate, minRate = DEFAULT_MIN_SUCCESS_RATE) {
  if (!Number.isFinite(successRate)) return false;
  return successRate >= minRate;
}

/**
 * 模式检测主入口。
 *
 * opts:
 *   existingPatterns : 已入库 pattern 业务字段数组（含 id/统计）
 *   minOccurrence    : 重复判定阈值（默认 3）
 *   similarityThreshold : 参数相似度阈值（默认 0.8）
 *   minSuccessRate   : 成功率准入门（默认 0.6）— 传 0 可关闭
 *   specificityGate  : 特异性门总开关（默认 true；传 false 整体退回旧行为）
 *   scaffoldTools    : 追加的脚手架黑名单（与内置 SCAFFOLD_TOOLS 取并集，不替换）
 *   nowMs            : 时间基准
 *
 * 返回 { upserts, newRepeat, blockedBySuccessRate, blockedByLowSpecificity }：
 *   upserts    : 本次要写入/更新的 pattern 业务字段数组（不含 storage metadata）
 *   newRepeat  : 其中「本次跨过 minOccurrence 门槛、过成功率门、且过特异性门」的 pattern（发事件用）
 *   blockedBySuccessRate : 跨过次数门槛但被成功率门拦下的（仍入库，不生成候选；供审计留痕）
 *   blockedByLowSpecificity : 过了成功率门但被特异性门拦下的（仍入库；纯脚手架序列）
 *
 * 三个桶互斥，判定顺序固定为 成功率 → 特异性：成功率是更硬的否决，
 * 一个模式不会同时出现在两个 blocked 桶里（避免审计重复计数）。
 */
export function detectPatterns(taskInstances, opts = {}) {
  const minOccurrence = opts.minOccurrence ?? 3;
  const simThreshold = opts.similarityThreshold ?? 0.8;
  const minSuccessRate = opts.minSuccessRate ?? DEFAULT_MIN_SUCCESS_RATE;
  const nowIso = opts.nowIso ?? new Date().toISOString();
  // 特异性门默认开（A1）；opts.scaffoldTools 为追加黑名单，不替换内置集合。
  const specificityGate = opts.specificityGate !== false;
  const scaffoldTools = opts.scaffoldTools;
  const existing = Array.isArray(opts.existingPatterns) ? opts.existingPatterns : [];

  // 已有 pattern 的工作副本（按 id 索引；保持入库统计可累计）
  const byId = new Map(existing.map((p) => [p.id, { ...p }]));
  // 本次新增（内存中累计，同一批内相同序列的任务也互相合并）
  const batchNew = [];

  function findMatch(task) {
    for (const p of byId.values()) {
      if (sequenceEqual(p.toolSequence, task.toolSequence)
        && paramSimilarity(p.paramSignature, task.paramSignature) >= simThreshold) {
        return p;
      }
    }
    for (const p of batchNew) {
      if (sequenceEqual(p.toolSequence, task.toolSequence)
        && paramSimilarity(p.paramSignature, task.paramSignature) >= simThreshold) {
        return p;
      }
    }
    return null;
  }

  const crossed = new Set();
  // 跨过次数门槛但被成功率门拦下的——仍需入库与留痕（见文件头说明）
  const blocked = new Set();
  // 过了成功率门但被特异性门拦下的（纯脚手架序列）——同样入库留痕
  const lowSpec = new Set();

  for (const task of taskInstances) {
    if (!task?.toolSequence?.length) continue;
    let p = findMatch(task);
    const wasBelow = p ? p.occurrenceCount < minOccurrence : false;
    if (!p) {
      p = {
        toolSequence: task.toolSequence,
        paramSignature: task.paramSignature,
        sampleArgs: task.sampleArgs ?? {},
        // Phase 2：语义窗口锚点（sessionId/turn/step）。提案层据此回查会话文本，
        // 用本地窗口填 `## 为什么` / `## 避坑`（不依赖 dream 的 LLM 通路）。
        // 缺此字段 → 提案降级为纯模板；不阻断链路。
        sampleAnchor: task.anchor ?? null,
        description: describe(task),
        occurrenceCount: 0,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        avgDurationMs: task.durationMs ?? null,
        avgTokenCost: null,
        successRate: task.successRate,
        status: 'active',
        standardizable: null,
        standardizableConfidence: null,
        linkedCandidateId: null,
        _isNew: true,
      };
      batchNew.push(p);
    } else {
      // 增量更新统计（ occurrence 累计；均值滚动；firstSeen 保留旧值）
      // 刷新 sampleArgs 为最新一次真实调用的样本（修复 K45.4：让提案层拿到具体值）
      p.sampleArgs = task.sampleArgs ?? p.sampleArgs ?? {};
      // 锚点同 sampleArgs 策略：刷新为最新一次真实调用的位置（语义窗口取最新现场）
      if (task.anchor) p.sampleAnchor = task.anchor;
      p.avgDurationMs = p.avgDurationMs == null && task.durationMs == null
        ? null
        : Math.round(((p.avgDurationMs ?? 0) * p.occurrenceCount + (task.durationMs ?? 0)) / (p.occurrenceCount + 1));
      p.successRate = Number.isFinite(task.successRate)
        ? +(((p.successRate * p.occurrenceCount + task.successRate) / (p.occurrenceCount + 1))).toFixed(4)
        : p.successRate;
      p.lastSeenAt = nowIso;
    }
    p.occurrenceCount += 1;
    // 只在「本次刚跨过次数门槛」那一次判定，避免每批重复记账
    if ((wasBelow || p._isNew) && p.occurrenceCount >= minOccurrence) {
      if (!passesSuccessGate(p.successRate, minSuccessRate)) blocked.add(p);
      else if (!passesSpecificityGate(p.toolSequence, { enabled: specificityGate, scaffoldTools })) lowSpec.add(p);
      else crossed.add(p);
    }
  }

  // 标记 dirty：被命中的 existing（occurrence 变了）才需要回写。
  const inCount = new Map(existing.map((p) => [p.id, p.occurrenceCount]));
  for (const p of byId.values()) {
    delete p._isNew;
    if (inCount.get(p.id) !== p.occurrenceCount) p._dirty = true;
  }
  const dirtyExisting = [...byId.values()]
    .filter((p) => p._dirty)
    .map((p) => { const { _dirty, ...rest } = p; return rest; });
  const newBusiness = batchNew.map((p) => { const { _isNew, ...rest } = p; return rest; });

  return {
    upserts: [...dirtyExisting, ...newBusiness],
    newRepeat: [...crossed],
    blockedBySuccessRate: [...blocked].map((p) => { const { _isNew, ...rest } = p; return rest; }),
    blockedByLowSpecificity: [...lowSpec].map((p) => { const { _isNew, ...rest } = p; return rest; }),
  };
}

/** 模式描述：人类可读一句话（给老板/周复盘看） */
export function describe(task) {
  const seq = task.toolSequence.join(' → ');
  const argKeys = Object.entries(task.sampleArgs ?? {})
    .map(([tool, args]) => (args && typeof args === 'object' ? Object.keys(args) : []))
    .flat()
    .filter(Boolean);
  const keys = [...new Set(argKeys)].slice(0, 4).join('/');
  return keys ? `${seq}（参数：${keys}）` : seq;
}

/** 给 detector 测试/补跑用：把 args 转签名的转发导出 */
export { signatureOf };
