/**
 * agint-curator: state-engine — 纯函数状态转换引擎（无 LLM，无 I/O）。
 *
 * Sprint14 §3.3：state-engine 必须是纯函数（输入 → 输出），理由是可测性——
 * Sprint 15 往这里叠质量加速规则，纯函数才好加分支。
 *
 * 状态机（Sprint14 §3.3 + Sprint15 §3.2 质量扩展）：
 *   active ──30天未用──▶ stale ──90天未用──▶ archived
 *     ▲                   │                    │
 *     └──7天内有使用────────┘                    └──人工 unarchive──▶ active
 *     │
 *     └──人工 pin──▶ pinned（不参与任何自动转换）
 *   Sprint 15 质量路径（P0-2 §7.2 规则 1–3 + §3.2）：
 *     active ──质量下降──▶ quality_declining ──7天内有使用且质量恢复──▶ active
 *     active ──规则1 质量加速──▶ stale
 *     stale  ──规则2 质量加速(60天)──▶ archived
 *     stale  ──规则3 质量保护──▶ 不归档 + review 标记
 *     quality_declining ──陈旧达阈值──▶ archived
 *
 * 保护机制（P0-2 §9.1 / Sprint14 §3.4）—— 归档是破坏性操作，宁可漏不可错：
 *   1. pinned          ：人工固定，跳过所有自动转换
 *   2. protected       ：受保护内置技能白名单 + 策展自保护（§9.4）
 *   3. cron-referenced ：不自动归档（但可以 stale）
 *   4. 新技能保护期     ：创建 <14 天且 useCount=0 → 不参与 stale 转换
 */

import { MANAGED_SOURCES } from './schema.js';
import { qualityRules } from './quality.js';

const DAY_MS = 86_400_000;

/**
 * 单个技能的下一状态决策。
 *
 * @param {Object} input
 * @param {Object} input.skill   skill_states 记录（含 usage、quality、createdAt）
 * @param {Object} input.config  生效配置
 * @param {number} input.nowMs   当前时间（毫秒）
 * @returns {{ from:string, to:string, action:'keep'|'stale'|'archive'|'reactivate'|'declining',
 *             reason:string, daysSinceUse:number, usedForDecision:string, reviewSuggested?:boolean }}
 */
export function evaluateSkill({ skill, config, nowMs }) {
  const from = skill.state ?? 'active';
  const keep = (reason, extra = {}) => ({
    from, to: from, action: 'keep', reason,
    daysSinceUse: daysSinceUseOf(skill, nowMs).days,
    usedForDecision: daysSinceUseOf(skill, nowMs).basis,
    ...extra,
  });

  // ── 保护 1：pinned ──────────────────────────────────────────────────
  if (from === 'pinned') return keep('pinned：人工固定，不参与任何自动转换');

  // ── archived 不自动恢复（设计稿：避免 archive/unarchive 抖动）─────────
  if (from === 'archived') return keep('archived：不自动恢复，需人工 unarchive');

  // ── 保护 2：protected ───────────────────────────────────────────────
  if (skill.protected === true) return keep('protected：受保护内置技能，不参与自动转换');

  // ── 非本地管理的技能（bundled/hub/external）只读不碰（P0-2 §1.3）─────
  if (!MANAGED_SOURCES.includes(skill.source ?? 'manual')) {
    return keep(`source=${skill.source}：非 AGINT 管理的技能，不参与策展`);
  }

  const { days, basis } = daysSinceUseOf(skill, nowMs);
  const useCount = skill.usage?.useCount ?? 0;

  // ── 保护 4：新技能保护期（P0-2 §7.2 规则 4）──────────────────────────
  const ageDays = ageInDays(skill.createdAt, nowMs);
  const protectionDays = config.new_skill_protection_days ?? 14;
  if (useCount === 0 && ageDays !== null && ageDays < protectionDays) {
    return {
      from, to: from, action: 'keep',
      reason: `新技能保护期：创建 ${Math.floor(ageDays)} 天 < ${protectionDays} 天且从未使用`,
      daysSinceUse: days, usedForDecision: basis,
    };
  }

  // ── Sprint 15：质量加速规则（P0-2 §7.2，纯判定，见 quality.js）────────
  const qr = qualityRules(skill, config);
  if (qr.reviewSuggested) {
    return {
      ...keep(`质量保护（规则3）：${qr.reason}`, { reviewSuggested: true }),
    };
  }

  // 规则 1：active + HARM 连续2次<0 + 成功率<0.5 → 质量加速 stale
  if (qr.accelerateStale) {
    return {
      from, to: 'stale', action: 'stale',
      reason: qr.reason,
      daysSinceUse: days, usedForDecision: basis,
    };
  }

  // 规则 2：stale + HARM 持续下降 → 60 天未用即 archive（quality_archive_after_days）
  if (qr.accelerateArchive) {
    if (skill.cronReferenced === true && config.cron_referenced_protection !== false) {
      return {
        from, to: from, action: 'keep',
        reason: `cron-referenced：只标记不归档（${qr.reason}）`,
        daysSinceUse: days, usedForDecision: basis,
      };
    }
    if (days >= (config.quality_archive_after_days ?? 60)) {
      return {
        from, to: 'archived', action: 'archive',
        reason: `${qr.reason}（${Math.floor(days)} 天未用 ≥ quality_archive_after_days(${config.quality_archive_after_days ?? 60})）`,
        daysSinceUse: days, usedForDecision: basis,
      };
    }
    return keep(`质量加速 archive 未达阈值：${Math.floor(days)} 天 < quality_archive_after_days(${config.quality_archive_after_days ?? 60})（${qr.reason}）`);
  }

  // ── Sprint 15：质量下降标记（P0-2 §3.2）──────────────────────────────
  // active/stale + 质量下降（成功率连续 2 周降>10% 或 HARM 连续 2 次<0）
  // → quality_declining（规则 1/2/3 已优先处理，这里只处理纯质量下降标记）
  const qualityDeclining = skill.quality?.qualityState === 'declining';
  if ((from === 'active' || from === 'stale') && qualityDeclining) {
    return {
      from, to: 'quality_declining', action: 'declining',
      reason: `质量下降：${(skill.quality?.successTrend?.reason ?? '')}${skill.quality?.harmTrend?.reason ? '；' + skill.quality.harmTrend.reason : ''}`.replace(/^质量下降：/,'质量下降：') || '质量下降（成功率/HARM 趋势）',
      daysSinceUse: days, usedForDecision: basis,
    };
  }

  // ── quality_declining 状态处理 ───────────────────────────────────────
  if (from === 'quality_declining') {
    // 最近 7 天有使用 + 质量恢复 → 回到 active
    if (days < (config.reactivate_within_days ?? 7) && qualityDeclining === false) {
      return {
        from, to: 'active', action: 'reactivate',
        reason: `质量恢复且最近 ${Math.floor(days)} 天内有使用（< ${config.reactivate_within_days ?? 7} 天）`,
        daysSinceUse: days, usedForDecision: basis,
      };
    }
    // 最近 7 天有使用但质量仍下降 → 保持标记（继续观察）
    if (days < (config.reactivate_within_days ?? 7)) {
      return keep(`质量仍下降，观察中（最近 ${Math.floor(days)} 天有使用）`);
    }
    // 陈旧达阈值 → 归档（90 天，或质量加速 60 天）
    const threshold = qualityDeclining ? (config.quality_archive_after_days ?? 60) : (config.archive_after_days ?? 90);
    if (days >= threshold) {
      if (skill.cronReferenced === true && config.cron_referenced_protection !== false) {
        return {
          from, to: from, action: 'keep',
          reason: `cron-referenced：只标记不归档（质量下降且 ${Math.floor(days)} 天未用）`,
          daysSinceUse: days, usedForDecision: basis,
        };
      }
      return {
        from, to: 'archived', action: 'archive',
        reason: `质量下降且 ${Math.floor(days)} 天未使用 ≥ ${threshold} 天`,
        daysSinceUse: days, usedForDecision: basis,
      };
    }
    return keep(`质量下降：${Math.floor(days)} 天未用 < ${threshold} 天，继续观察`);
  }

  // ── 转换 1：stale + 最近 7 天有使用 → reactivate ──────────────────────
  if (from === 'stale' && days < (config.reactivate_within_days ?? 7)) {
    return {
      from, to: 'active', action: 'reactivate',
      reason: `最近 ${Math.floor(days)} 天内有使用（< ${config.reactivate_within_days ?? 7} 天）`,
      daysSinceUse: days, usedForDecision: basis,
    };
  }

  // ── 转换 2：stale + ≥90 天未用 → archive ─────────────────────────────
  if (from === 'stale' && days >= (config.archive_after_days ?? 90)) {
    // 保护 3：cron-referenced 不归档（但可 stale）
    if (skill.cronReferenced === true && config.cron_referenced_protection !== false) {
      return {
        from, to: from, action: 'keep',
        reason: `cron-referenced：被 cron job 引用，只标记 stale 不自动归档（${Math.floor(days)} 天未用）`,
        daysSinceUse: days, usedForDecision: basis,
      };
    }
    return {
      from, to: 'archived', action: 'archive',
      reason: `${Math.floor(days)} 天未使用 ≥ archive_after_days(${config.archive_after_days ?? 90})`,
      daysSinceUse: days, usedForDecision: basis,
    };
  }

  // ── 转换 3：active + ≥30 天未用 → stale ──────────────────────────────
  // 注意：即使 days 已超过 archive 阈值，active 也**一次只走一步**（active→stale）。
  // 安全 > 效率：让陈旧技能先被"看见"一周（进 stale 列表 + 事件），下周才归档。
  if (from === 'active' && days >= (config.stale_after_days ?? 30)) {
    return {
      from, to: 'stale', action: 'stale',
      reason: `${Math.floor(days)} 天未使用 ≥ stale_after_days(${config.stale_after_days ?? 30})`,
      daysSinceUse: days, usedForDecision: basis,
    };
  }

  return {
    from, to: from, action: 'keep',
    reason: `未达阈值：${Math.floor(days)} 天未使用（basis=${basis}）`,
    daysSinceUse: days, usedForDecision: basis,
  };
}

/**
 * 批量评估。归档候选按「最久未用优先」排序（预算受限时先处理最陈旧的）。
 * @returns {{ decisions: Array, toStale: Array, toArchive: Array, toReactivate: Array, toDeclining: Array, kept: Array }}
 */
export function evaluateAll(skills, { config, nowMs }) {
  const decisions = (skills ?? []).map((s) => ({ skillName: s.skillName, ...evaluateSkill({ skill: s, config, nowMs }) }));
  const pick = (action) => decisions.filter((d) => d.action === action);
  const toArchive = pick('archive').sort((a, b) => b.daysSinceUse - a.daysSinceUse);
  const toStale = pick('stale').sort((a, b) => b.daysSinceUse - a.daysSinceUse);
  return {
    decisions,
    toStale,
    toArchive,
    toReactivate: pick('reactivate'),
    toDeclining: pick('declining'),
    kept: pick('keep'),
  };
}

// ── helper ───────────────────────────────────────────────────────────────

/**
 * 未使用天数。无使用数据时以技能创建时间（SKILL.md birthtime）为基准——
 * 从未被使用的技能照样要参与陈旧判定，否则新技能永远不会被归档。
 * @returns {{ days:number, basis:'lastUsedAt'|'createdAt' }}
 */
export function daysSinceUseOf(skill, nowMs) {
  const last = skill?.usage?.lastUsedAt;
  if (typeof last === 'string' && last) {
    const t = Date.parse(last);
    if (Number.isFinite(t)) return { days: Math.max(0, (nowMs - t) / DAY_MS), basis: 'lastUsedAt' };
  }
  const created = skill?.createdAt;
  if (typeof created === 'string' && created) {
    const t = Date.parse(created);
    if (Number.isFinite(t)) return { days: Math.max(0, (nowMs - t) / DAY_MS), basis: 'createdAt' };
  }
  // 既无使用数据也无创建时间：视为"刚出现"，不判定陈旧（宁可漏）
  return { days: 0, basis: 'unknown' };
}

function ageInDays(iso, nowMs) {
  if (typeof iso !== 'string' || !iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (nowMs - t) / DAY_MS);
}

export { DAY_MS };
