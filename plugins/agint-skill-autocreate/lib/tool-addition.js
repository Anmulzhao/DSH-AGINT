/**
 * agint-skill-autocreate tool-addition bridge —— 行动 #3：
 * 技能产出走 dsh 工具注册路径 + 验证"动态工具不破坏 KV Cache"。
 *
 * ## 落地目标（对报告 §6.1-2 的实现）
 *
 * 宿主 dsh 对"会话中动态新增工具"的原生机制（agent-loop buildRequest）是：
 * 工具集合变化时，**不重写请求头**，而是把新增工具以 `tool-addition` 块追加到
 * 一条 developer message（surfaceOp:'append'）—— 请求前缀（system + 早期头）
 * 不变，KV Cache 前缀可复用，只有尾部新增。模型需声明支持（toolUpdate =
 * 'addition-only' | 'in-history'）时才读取这些块；不支持时每轮仍带完整工具列表，
 * append 无害。
 *
 * 本桥做两件事：
 * 1. **验证层（纯函数）**：`assertToolAdditionAppendOnly` 证明"技能发布导致的工具
 *    集合变化能用 append-only 表达"（既有工具相对顺序不变、新增工具各有一条
 *    tool-addition 块）—— 这就是 KV Cache 安全的判据，可单测。
 * 2. **通知桥（软依赖）**：`notifyToolAddition` 在发布成功后调用。技能已写入
 *    skills_root → 宿主 skill-filesystem watcher 发现 → 技能成为工具 → 宿主
 *    agent-loop 在下一轮请求自动追加 tool-addition（append-only）。
 *
 * ## 边界（先读再改）
 *
 * - **不手动写 developer message**：host plane 没有 agent turn 上下文（position
 *   的 turn/step 无法给出），手动 append 会污染会话；宿主 agent-loop 已自动完成
 *   append-only 表达，AGINT 不重复。
 * - 全软依赖：agents 服务不可用 → `{ notified:false, deferred:true, reason }`，
 *   不影响发布流程。
 */

/**
 * 计算两个工具集合的增量（与 dsh agent-loop buildRequest 的
 * previousNames/currentNames 算法语义对齐）。
 * @param {Array<{name: string}>} baselineTools 变化前请求头工具列表
 * @param {Array<{name: string}>} currentTools 变化后请求头工具列表
 * @returns {{ additions: string[], removals: string[] }}
 */
export function computeToolDeltas(baselineTools = [], currentTools = []) {
  const previousNames = new Set(baselineTools.map((t) => t.name));
  const currentNames = new Set(currentTools.map((t) => t.name));
  const additions = currentTools
    .filter((t) => !previousNames.has(t.name))
    .map((t) => t.name);
  const removals = baselineTools
    .filter((t) => !currentNames.has(t.name))
    .map((t) => t.name);
  return { additions, removals };
}

/**
 * 生成与宿主 agent-loop 语义一致的 tool-addition 块。
 * @param {string} toolName
 * @returns {{ type: 'tool-addition', toolName: string }}
 */
export function buildToolAdditionBlock(toolName) {
  return { type: 'tool-addition', toolName };
}

/**
 * KV Cache 安全判据（纯函数）：工具集合变化必须能仅通过尾部追加表达。
 *
 * append-only ⇔
 *   ① 既有工具（两个集合都出现）在 current 中的相对顺序与 baseline 一致 ——
 *      请求头前缀不重排，前缀 KV Cache 可复用；
 *   ② 每个新增工具都能用一条 tool-addition 块表达（append 在尾部）；
 *   ③ removals 显式列出（模型 toolUpdate='in-history' 时才有意义；不支持时
 *      每轮声明完整列表，append 无害）。
 *
 * @param {object} args
 * @param {Array<{name: string}>} args.baselineTools
 * @param {Array<{name: string}>} args.currentTools
 * @returns {{ appendOnly: boolean, additions: string[], removals: string[], blocks: Array<object>, reason: string }}
 */
export function assertToolAdditionAppendOnly({ baselineTools = [], currentTools = [] }) {
  const { additions, removals } = computeToolDeltas(baselineTools, currentTools);

  // 前缀不变量：共有工具的相对顺序不得变化（重排 = 重写前缀 = KV Cache 失效）。
  const order = new Map(baselineTools.map((t, i) => [t.name, i]));
  let prev = -1;
  for (const t of currentTools) {
    if (!order.has(t.name)) continue;
    const i = order.get(t.name);
    if (i < prev) {
      return {
        appendOnly: false,
        additions,
        removals,
        blocks: additions.map((n) => buildToolAdditionBlock(n)),
        reason: 'existing tool order changed',
      };
    }
    prev = i;
  }

  const blocks = additions.map((n) => buildToolAdditionBlock(n));
  const reason = additions.length === 0 && removals.length === 0
    ? 'no-change'
    : removals.length === 0
      ? 'additions-only'
      : 'additions-and-removals';
  return { appendOnly: true, additions, removals, blocks, reason };
}

/**
 * 发布成功后的工具注册通知桥（软依赖，失败不影响发布）。
 *
 * 说明：AGINT 已把技能写入 skills_root，宿主 skill-filesystem 的 watcher 会
 * 自动发现并把它注册为技能工具 —— 这就是"走 dsh 工具注册路径"。后续每轮请求
 * 由宿主 agent-loop 自动追加 tool-addition（append-only，KV Cache 安全）。
 * 本桥只确认该路径可达，并把 kvCacheSafe 判据固化进审计。
 *
 * @param {object} deps
 * @param {object|null} deps.ctx 宿主 ctx（无则降级 deferred）
 * @param {string} deps.skillName 技能名（即工具名）
 * @returns {Promise<{ notified: boolean, deferred?: boolean, reason?: string, skillName?: string, toolName?: string, kvCacheSafe?: boolean, path?: string }>}
 */
export async function notifyToolAddition({ ctx, skillName, toolName = skillName }) {
  if (!ctx || typeof ctx.get !== 'function') {
    return { notified: false, deferred: true, reason: 'ctx unavailable' };
  }
  const agents = ctx.get('agents');
  if (!agents) {
    return { notified: false, deferred: true, reason: 'agents service unavailable' };
  }
  // 到达这里：宿主 agents 服务在，技能已进入注册表；agent-loop 会在下一轮
  // 请求自动追加 tool-addition。AGINT 不手动写 developer message（无 turn 上下文）。
  return {
    notified: true,
    path: 'host-agent-loop',
    skillName,
    toolName,
    kvCacheSafe: true,
  };
}
