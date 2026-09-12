/**
 * agint-trajectory/lib/assemble.js — 输入 → 轨迹记录的组装（纯逻辑，可单测）。
 *
 * 顺序（每一步都对应设计稿条款）：
 *   归一化（observation 摘要化，不复存参数正文）
 *   → 用量聚合（工具级成败，v0.3）
 *   → 脱敏（范围覆盖参数正文）
 *   → 截断（保头 + 保尾，必留 truncated / droppedSteps）
 *   → schema 校验（schemaVersion 1，zeroth 一次定够）
 */

import { TrajectorySchema, DEFAULTS, makeTrajectoryId, clampText } from './schema.js';
import { redactSteps, redactValue, redactText } from './redact.js';
import { normalizeSteps, aggregateUsage, truncatePayload, estimateBytes } from './payload.js';

/**
 * @param {object} input record() 的入参
 * @param {object} cfg ConfigSchema 解析后的配置
 * @param {Array} rules 编译后的脱敏规则
 * @param {Date} [now]
 * @returns {{traj:object, truncated:boolean, droppedSteps:number, bytes:number}}
 */
export function assembleTrajectory(input = {}, cfg = {}, rules = [], now = new Date()) {
  const source = DEFAULTS.SAMPLE_RATES[input.source] === undefined ? 'task' : input.source;
  const kind = ['success', 'failure', 'aborted'].includes(input.kind) ? input.kind : 'success';

  const steps = normalizeSteps(input.steps, cfg);
  const usageAgg = aggregateUsage(steps);
  const usage = {
    tokensIn: Number(input.usage?.tokensIn) || 0,
    tokensOut: Number(input.usage?.tokensOut) || 0,
    toolCalls: input.usage?.toolCalls ?? usageAgg.toolCalls,
    toolStats: input.usage?.toolStats ?? usageAgg.toolStats,
    errorKinds: input.usage?.errorKinds ?? null,
  };

  const rd = redactSteps(steps, rules);
  const finalRd = redactValue(input.final ?? null, rules);
  const titleRd = redactText(input.title ?? '', rules);
  const outcomeMsg = input.outcome?.errorMsg
    ? redactText(clampText(input.outcome.errorMsg, DEFAULTS.ERROR_MSG_CHARS), rules).text
    : null;

  const { payload, truncated, droppedSteps, bytes } =
    truncatePayload({ steps: rd.steps, final: finalRd.value }, cfg.maxPayloadBytes);

  const startedAt = input.startedAt ?? now.toISOString();
  const endedAt = input.endedAt ?? now.toISOString();
  const durationMs = Number.isInteger(input.durationMs)
    ? input.durationMs
    : Math.max(0, Date.parse(endedAt) - Date.parse(startedAt) || 0);

  const traj = TrajectorySchema.parse({
    id: makeTrajectoryId(now, `${source}${kind}${input.title ?? ''}`),
    source,
    kind,
    title: clampText(titleRd.text || `${source}/${kind}`, 200),
    taskRef: input.taskRef ?? {},
    startedAt,
    endedAt,
    durationMs,
    usage,
    outcome: { ...(input.outcome ?? {}), errorMsg: outcomeMsg ?? undefined },
    payload,
    truncated,
    redacted: rd.hit || finalRd.hit || titleRd.hit,
    pinned: input.pinned === true,
    feedback: input.feedback ?? null,
    via: input.via === 'event' ? 'event' : 'explicit',
    bytes,
    createdAt: now.toISOString(),
  });

  return { traj, truncated, droppedSteps, bytes };
}

/** 只读估算一条入参的字节（拒记判定用，避免完整组装） */
export function estimateInputBytes(input = {}, cfg = {}) {
  return estimateBytes({ steps: normalizeSteps(input.steps, cfg), final: input.final ?? null });
}
