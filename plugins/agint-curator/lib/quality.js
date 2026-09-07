/**
 * lib/quality.js — Sprint 15 P0-2 T2 质量评估（设计稿 §7.2 / §7.4）
 *
 * 质量趋势来自两路数据，任一缺失即降级、绝不编造：
 *   1. 成功率趋势（curator 自有）：skill_states.qualityHistory 周快照
 *      [ { week, successRate, useCount } ]，最近 4 周内连续 2 周降幅 >10%
 *      → 成功率下降（successDeclining=true）。
 *   2. HARM 趋势（跨域，Sprint15 §4.3 B 路径）：从 evolution-log 读
 *      `phase3-provisional` tag 记录（P0-1 评估层写入），按 targetId 匹配。
 *      当前阶段 evolution 记录只到候选级（candidateId，未发布），技能级
 *      HARM 待 Sprint 16 release 链路补写 → HARM 缺失时 harmTrend=null，
 *      质量加速规则 1/2 不触发（安全降级，见 quality-rules）。
 *
 * qualityState：'declining' | 'stable' | null（无足够数据）。
 * 输出挂到 skill.quality，由 state-engine 消费（保持纯函数：质量模块只算数，
 * 状态机只做转换）。
 */

import { isoWeek } from './storage.js';

export const QUALITY_THRESHOLDS = Object.freeze({
  successDeclinePct: 0.10,   // 单周成功率降幅 >10% 记为下降
  successDeclineStreak: 2,   // 连续 2 周下降 → declining
  trendWindowWeeks: 4,       // 趋势窗口
  harmDecliningCount: 2,     // HARM 增量连续 2 次 <0 → declining
  harmReviewDelta: 1.0,      // 最近一次 HARM 增量 >1.0 → 质量保护（规则 3）
  qualityProtectSuccessRate: 0.8, // 规则 3 成功率门槛
});

export const QUALITY_STATES = Object.freeze(['declining', 'stable', 'unknown']);

/**
 * 成功率趋势：从 qualityHistory（按周升序）推断。
 * 规则：窗口内（最近 trendWindowWeeks 周）存在连续 successDeclineStreak 周
 * 降幅 > successDeclinePct → declining。
 */
export function successTrend(history = [], thresholds = QUALITY_THRESHOLDS) {
  const ws = (history ?? []).filter((h) => typeof h?.successRate === 'number').slice(-thresholds.trendWindowWeeks);
  if (ws.length < thresholds.successDeclineStreak + 1) return { state: 'unknown', reason: `成功率历史不足（${ws.length} 周 < ${thresholds.successDeclineStreak + 1}）` };
  let streak = 0;
  for (let i = 1; i < ws.length; i++) {
    const prev = ws[i - 1].successRate;
    const cur = ws[i].successRate;
    if (prev > 0 && (prev - cur) / prev > thresholds.successDeclinePct) {
      streak++;
      if (streak >= thresholds.successDeclineStreak) {
        return { state: 'declining', reason: `成功率连续 ${streak} 周下降超 ${thresholds.successDeclinePct * 100}%（${ws.map((w) => w.week).join('→')}）` };
      }
    } else {
      streak = 0;
    }
  }
  return { state: 'stable', reason: `成功率稳定（窗口 ${ws.map((w) => `${w.week}:${Math.round((w.successRate ?? 0) * 100)}%`).join(', ')}）` };
}

/**
 * HARM 趋势：从 evolution-log 记录（已按 phase3-provisional 过滤）推断。
 * @param {Array} entries evolution-log 记录（按时间升序）
 * @param {Object} thresholds
 * @returns {{ state:'declining'|'stable'|'unknown', reason:string, lastDelta:number|null, hasData:boolean }}
 */
export function harmTrend(entries = [], thresholds = QUALITY_THRESHOLDS) {
  const deltas = (entries ?? [])
    .map((e) => Number(e?.scores?.harmIncrementEstimate ?? e?.scores?.harm ?? NaN))
    .filter((x) => Number.isFinite(x));
  if (deltas.length === 0) {
    return { state: 'unknown', reason: '无 HARM 评估历史（evolution-log 无 phase3-provisional 记录），规则 1/2 不触发', lastDelta: null, hasData: false };
  }
  let streak = 0;
  for (const d of deltas.slice(-thresholds.trendWindowWeeks)) {
    if (d < 0) { streak++; if (streak >= thresholds.harmDecliningCount) break; }
    else streak = 0;
  }
  const last = deltas[deltas.length - 1];
  if (streak >= thresholds.harmDecliningCount) {
    return { state: 'declining', reason: `HARM 增量连续 ${streak} 次 <0`, lastDelta: last, hasData: true };
  }
  return { state: 'stable', reason: `HARM 增量未见连续下降（最近 ${deltas.length} 次）`, lastDelta: last, hasData: true };
}

/**
 * 单技能质量评估：成功率趋势（自有数据）+ HARM 趋势（跨域数据）。
 * 任一为 declining → 技能 qualityState=declining。
 * @returns {{ qualityState, successTrend, harmTrend, reasons: string[] }}
 */
export function evaluateQuality(skill, { evolutionEntries = [] } = {}) {
  const history = skill?.quality?.history ?? [];
  const st = successTrend(history);
  const ht = harmTrend(evolutionEntries);
  const reasons = [];
  if (st.state === 'declining') reasons.push(st.reason);
  if (ht.state === 'declining') reasons.push(ht.reason);
  const qualityState = reasons.length > 0 ? 'declining' : (st.state === 'unknown' && ht.state === 'unknown' ? 'unknown' : 'stable');
  return { qualityState, successTrend: st, harmTrend: ht, reasons };
}

/**
 * 质量加速规则（P0-2 §7.2）—— 供 state-engine 消费的纯判定函数。
 * 规则 1 质量加速 stale：active + HARM 连续 2 次<0 + 成功率<0.5 → 直接 stale
 * 规则 2 质量加速 archive：stale + HARM 持续下降 → 60 天未用即 archive（非 90）
 * 规则 3 质量保护：stale + 最近 HARM>1.0 + 成功率>0.8 → 不自动 archive，标记 review
 * 规则 4 新技能保护期：state-engine 已实现（不在此重复）
 *
 * @param {Object} skill    带 quality 字段的技能记录
 * @param {Object} config   生效配置（含 quality_archive_after_days）
 * @returns {{ accelerateStale:boolean, accelerateArchive:boolean, protectFromArchive:boolean, reviewSuggested:boolean, reason:string|null }}
 */
export function qualityRules(skill, config = {}) {
  const q = skill?.quality ?? {};
  const sRate = skill?.usage?.successRate;
  const thresholds = QUALITY_THRESHOLDS;
  const out = {
    accelerateStale: false,
    accelerateArchive: false,
    protectFromArchive: false,
    reviewSuggested: false,
    reason: null,
  };

  const harmDeclining = q.harmTrend?.state === 'declining';
  const lastDelta = q.harmTrend?.lastDelta ?? null;

  // 规则 1：active + HARM 连续 2 次<0 + 成功率<0.5 → 加速 stale
  if (skill.state === 'active' && harmDeclining && typeof sRate === 'number' && sRate < 0.5) {
    out.accelerateStale = true;
    out.reason = '规则1 质量加速 stale：HARM 连续 2 次<0 且成功率<50%';
    return out;
  }

  // 规则 3 优先于规则 2 判定（保护 > 加速）：stale + HARM>1.0 + 成功率>0.8
  if (skill.state === 'stale' && typeof lastDelta === 'number' && lastDelta > thresholds.harmReviewDelta && typeof sRate === 'number' && sRate > thresholds.qualityProtectSuccessRate) {
    out.protectFromArchive = true;
    out.reviewSuggested = true;
    out.reason = `规则3 质量保护：最近 HARM 增量 ${lastDelta.toFixed(2)}>1.0 且成功率 ${Math.round(sRate * 100)}%>80%，疑似高质量储备技能，不自动归档`;
    return out;
  }

  // 规则 2：stale + HARM 持续下降 → 60 天未用即归档（quality_archive_after_days）
  if (skill.state === 'stale' && harmDeclining) {
    out.accelerateArchive = true;
    out.reason = `规则2 质量加速 archive：HARM 持续下降，归档阈值降为 ${config.quality_archive_after_days ?? 60} 天`;
    return out;
  }

  return out;
}

/** 周快照 append：每周聚合后调用，保留最多 maxWeeks 周（默认 8） */
export function appendQualitySnapshot(skill, snapshot, maxWeeks = 8) {
  const history = Array.isArray(skill?.quality?.history) ? [...skill.quality.history] : [];
  const week = snapshot.week ?? isoWeek();
  const withoutSameWeek = history.filter((h) => h.week !== week);
  withoutSameWeek.push({ week, ...snapshot });
  withoutSameWeek.sort((a, b) => String(a.week).localeCompare(String(b.week)));
  return withoutSameWeek.slice(-maxWeeks);
}
