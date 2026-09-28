/**
 * agint-evolution-driver goal bridge —— 行动 #2b：把"本轮改进目标"变成宿主一等概念。
 *
 * ## 落地目标（对报告 §6.1-4 的实现）
 *
 * dsh-goal-round-driver 已在宿主挂载（dsh-base bundle），它会自动驱动"同一 agent
 * 会话的连续轮次"，直到目标完成或轮次预算耗尽。本桥把 AGINT 的进化提案转成
 * dsh goal（`goals.create(agent, { objective })`），让 goal-round-driver 接管
 * 后续改进轮次 —— 而不是 AGINT 在 host 平面自己 for 循环挑候选。
 *
 * ## 边界（先读再改）
 *
 * 1. **影子接入，默认关**：`AGINT_EVOLUTION_DRIVER_GOAL=on` 才启用。goal 语义
 *    会改变进化轮次的驱动主体（agent 会话驱动 vs host cron 直调），先验证链路
 *    再切换，避免无人值守 job 行为漂移。
 * 2. **全软依赖**：goals 服务调用时 ctx.get，未挂载 / 无 create / 抛错 →
 *    `{ created:false, reason }`，不影响 runOnce 既有路径。
 * 3. **只创建、不接管**：本桥只负责 create goal；轮次驱动完全由宿主
 *    goal-round-driver 承担（AGINT 不重复实现）。
 */

// kill-switch 环境变量：只有显式 'on' 才开（影子期惯例，默认关）。
export const GOAL_BRIDGE_ENV = 'AGINT_EVOLUTION_DRIVER_GOAL';

/** objective 里 body 的截断长度（保持 objective 短而可执行）。 */
export const GOAL_BODY_SNIPPET = 280;

/**
 * kill-switch 判定：只有显式 'on' 才开（大小写不敏感 + 去空格）。
 * @param {object} [env] process.env 或测试注入
 * @returns {boolean}
 */
export function isGoalBridgeEnabled(env = {}) {
  const v = String(env?.[GOAL_BRIDGE_ENV] ?? '').trim().toLowerCase();
  return v === 'on';
}

/**
 * 纯函数：从一条进化提案生成 dsh goal objective 文本。
 * objective 必须自含上下文（goal-round-driver 只把它作为 agent 的轮次目标），
 * 所以拼入 title + 截断 body + 来源 + 提案 id，并写明完成标准。
 * @param {{ id?: string, title?: string, body?: string, source?: string }} candidate
 * @returns {string}
 */
export function buildGoalObjective(candidate = {}) {
  const title = String(candidate.title ?? '').trim() || '<untitled proposal>';
  const body = String(candidate.body ?? '').trim();
  const snippet = body.length > GOAL_BODY_SNIPPET
    ? `${body.slice(0, GOAL_BODY_SNIPPET)}…`
    : body;
  const source = String(candidate.source ?? '').trim();
  const id = String(candidate.id ?? '').trim();
  const parts = [
    `AGINT 进化目标：${title}`,
    snippet ? `背景：${snippet}` : null,
    source ? `来源：${source}` : null,
    id ? `提案：${id}` : null,
    '完成标准：将提案转化为已合入仓库的原子改动（可回滚），并给出可证伪的 rationale。',
  ].filter(Boolean);
  return parts.join('。');
}

/**
 * 创建进化 goal（由宿主 goal-round-driver 接管后续轮次）。
 * @param {object} deps
 * @param {object} deps.agent 宿主 live agent（goals.create 的 owner）
 * @param {object} deps.candidate 进化提案 { id, title, body, source }
 * @param {object|null} deps.goals 宿主 goals 服务实例（调用时 ctx.get）
 * @param {object} [deps.env] process.env 或测试注入
 * @param {object} [deps.opts] { maxGoalRounds?: number } 透传给 goals.create
 * @returns {Promise<{ created: boolean, goalId?: string, phase?: string, reason?: string }>}
 */
export async function createEvolutionGoal({ agent, candidate, goals, env = {}, opts = {} }) {
  if (!isGoalBridgeEnabled(env)) {
    return { created: false, reason: 'kill-switch-off' };
  }
  if (!goals || typeof goals.create !== 'function') {
    return { created: false, reason: 'goals-unavailable' };
  }
  const objective = buildGoalObjective(candidate);
  const request = { objective };
  if (Number.isInteger(opts?.maxGoalRounds) && opts.maxGoalRounds > 0) {
    request.maxGoalRounds = opts.maxGoalRounds;
  }
  try {
    const view = await goals.create(agent, request);
    return {
      created: true,
      goalId: view?.id,
      phase: view?.phase,
    };
  } catch (error) {
    return { created: false, reason: error?.message ?? String(error) };
  }
}
