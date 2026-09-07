/**
 * agint-curriculum: difficulty-ctl（§4.6）——每域难度调节。
 *
 * 规则（§4.6）：
 *   - 滚动窗口完成率 < 40%（passFloor）  → 降一档（D1 不再降）
 *   - 滚动窗口完成率 > 70%（passCeiling）→ 升一档（D5 不再升）
 *   - 单域连续 pass ≥ 3（forcePromoteStreak）→ **强制升档**（防停在舒适区刷分）
 *   - 单域连续 fail ≥ 3（forceDemoteStreak）→ 降档 + 标记该域为 CANNOT 候选
 *     （供 self-model 复验）
 *   - 滚动窗口默认 28 天（对齐 self-model 校准窗口）；样本 < 5 不调档
 *     （cold-start 守门，对齐 self-model「样本 <10 → UNCERTAIN」惯例）
 *
 * **纯函数**：输入（难度状态 + 判定结果 + 配置 + 时间）→ 输出新档位与动作。
 */

import { DIFFICULTY_LEVELS, DIFFICULTY_INDEX } from './schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 把一次判定结果并入难度状态（窗口滚动 + 连续序列维护）。
 * @param {object} state 当前难度状态（DifficultyStateSchema 业务字段）
 * @param {object} verdict { result: 'pass'|'fail', at: ISO 时间 }
 * @param {object} opts { windowDays, nowMs }
 * @returns {object} 更新后的状态
 */
export function recordVerdict(state, verdict, { windowDays = 28, nowMs = Date.now() } = {}) {
  const cutoff = nowMs - windowDays * DAY_MS;
  const keep = (r) => {
    const ts = Date.parse(r.at);
    return Number.isNaN(ts) ? false : ts >= cutoff;
  };
  const windowResults = [...(state.windowResults ?? []), {
    result: verdict.result,
    at: verdict.at,
  }].filter(keep);

  const consecutivePass = verdict.result === 'pass' ? (state.consecutivePass ?? 0) + 1 : 0;
  const consecutiveFail = verdict.result === 'fail' ? (state.consecutiveFail ?? 0) + 1 : 0;

  return {
    ...state,
    windowResults,
    consecutivePass,
    consecutiveFail,
  };
}

/**
 * 基于（已并入本次判定的）状态计算目标档位。
 * @param {object} state 见 recordVerdict 返回值
 * @param {object} opts 配置阈值
 * @returns {{ level, action, reason, windowStats, cannotCandidate }}
 */
export function adjustDifficulty(state, {
  minSamples = 5,
  passFloor = 0.40,
  passCeiling = 0.70,
  forcePromoteStreak = 3,
  forceDemoteStreak = 3,
} = {}) {
  const current = DIFFICULTY_INDEX[state.level] ?? 0;
  const total = state.windowResults?.length ?? 0;
  const passed = state.windowResults?.filter((r) => r.result === 'pass').length ?? 0;
  const rate = total > 0 ? passed / total : 0;
  const windowStats = { total, passed, rate: Number(rate.toFixed(3)) };

  const consecutivePass = state.consecutivePass ?? 0;
  const consecutiveFail = state.consecutiveFail ?? 0;

  // 行为信号优先于统计（防刷分/防挫败是显式设计意图，不受 cold-start 屏蔽）：
  // 连续 fail ≥ 3 → 降档 + CANNOT 候选（§4.6）
  if (consecutiveFail >= forceDemoteStreak) {
    const next = Math.max(0, current - 1);
    return {
      level: DIFFICULTY_LEVELS[next],
      action: 'force-demote',
      reason: `连续 fail ${consecutiveFail} ≥ ${forceDemoteStreak}（降档 + 标记 CANNOT 候选，供 self-model 复验）`,
      windowStats,
      cannotCandidate: true,
    };
  }

  // 连续 pass ≥ 3 → 强制升档（防停在舒适区刷分，§4.6）
  if (consecutivePass >= forcePromoteStreak) {
    const next = Math.min(DIFFICULTY_LEVELS.length - 1, current + 1);
    const clamped = next === current;
    return {
      level: DIFFICULTY_LEVELS[next],
      action: 'force-promote',
      reason: clamped
        ? `连续 pass ${consecutivePass} ≥ ${forcePromoteStreak}（已到 ${state.level} 上限）`
        : `连续 pass ${consecutivePass} ≥ ${forcePromoteStreak}（强制升档防刷分）`,
      windowStats,
      cannotCandidate: state.cannotCandidate ?? false,
    };
  }

  // cold-start：窗口样本 < minSamples → 不调档（§4.6；统计信号此时不可靠）
  if (total < minSamples) {
    return {
      level: state.level,
      action: 'keep',
      reason: `窗口样本 ${total} < ${minSamples}（cold-start 守门，不调档）`,
      windowStats,
      cannotCandidate: state.cannotCandidate ?? false,
    };
  }

  // 完成率护栏 40%–70%（§4.6）
  if (rate < passFloor) {
    const next = Math.max(0, current - 1);
    const clamped = next === current;
    return {
      level: DIFFICULTY_LEVELS[next],
      action: 'demote',
      reason: clamped
        ? `窗口完成率 ${(rate * 100).toFixed(0)}% < ${passFloor * 100}%（已到 ${state.level} 下限）`
        : `窗口完成率 ${(rate * 100).toFixed(0)}% < ${passFloor * 100}%（降档）`,
      windowStats,
      cannotCandidate: state.cannotCandidate ?? false,
    };
  }
  if (rate > passCeiling) {
    const next = Math.min(DIFFICULTY_LEVELS.length - 1, current + 1);
    const clamped = next === current;
    return {
      level: DIFFICULTY_LEVELS[next],
      action: 'promote',
      reason: clamped
        ? `窗口完成率 ${(rate * 100).toFixed(0)}% > ${passCeiling * 100}%（已到 ${state.level} 上限）`
        : `窗口完成率 ${(rate * 100).toFixed(0)}% > ${passCeiling * 100}%（升档）`,
      windowStats,
      cannotCandidate: state.cannotCandidate ?? false,
    };
  }

  return {
    level: state.level,
    action: 'keep',
    reason: `窗口完成率 ${(rate * 100).toFixed(0)}% 在 [${passFloor * 100}%, ${passCeiling * 100}%] 内`,
    windowStats,
    cannotCandidate: state.cannotCandidate ?? false,
  };
}
