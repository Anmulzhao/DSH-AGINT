/**
 * agint-evolution-memory: L1-L4 forgetting model (pure functions, unit-testable).
 *
 * 纯复制自 plugins/agint-memory/lib/decay.js（决策记录：老板 2026-08-20
 * 拍板"纯复制定制化"——跨 storage domain 不能直接复用 decay.js，因为
 * schema 不一样：task memory 是 id/type/content/level/confidence/lastRecall，
 * evolution entry 是 phase4 log / failure pattern / success template。
 *
 * Schema adapter 在 schema.js 暴露，decay.js 内部用通用 recencyIso / level /
 * confidence 字段。三个 domain 的 entry 必须自洽提供这三个字段才能被
 * decayScan 处理。
 *
 * 衰减规则（与 task memory 一致）：
 *   L1 → L2  90 days
 *   L2 → L3 180 days
 *   L3 → L4 365 days
 *   L4 clear 730 days (仅当 resolved/replaced)
 */

export const LAMBDA_BASE = 0.0015; // per day

export const LEVEL_ORDER = { L1: 1, L2: 2, L3: 3, L4: 4 };

export const THRESHOLDS = { L1: 90, L2: 180, L3: 365, L4: 730 };

export const TRANSITIONS = [
  { from: 'L1', to: 'L2', days: THRESHOLDS.L1 },
  { from: 'L2', to: 'L3', days: THRESHOLDS.L2 },
  { from: 'L3', to: 'L4', days: THRESHOLDS.L3 },
];

export const CLEAR_DAYS = THRESHOLDS.L4;

const DAY_MS = 86_400_000;

export function daysSince(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (now - t) / DAY_MS);
}

export function decayFactor(days, lambda = LAMBDA_BASE) {
  return Math.exp(-lambda * days);
}

export function effectiveConfidence(entry, now = Date.now()) {
  const days = daysSince(recencyIso(entry), now);
  return (entry.confidence ?? 0.5) * decayFactor(days);
}

function recencyIso(entry) {
  return entry.lastRecall || entry.updatedAt || entry.createdAt || new Date(0).toISOString();
}

/** Next level an entry should be at, given staleness. Never downgrades below current. */
export function nextLevel(entry, now = Date.now()) {
  const days = daysSince(recencyIso(entry), now);
  const current = LEVEL_ORDER[entry.level] ?? 1;
  let target = entry.level ?? 'L1';
  for (const t of TRANSITIONS) {
    if (LEVEL_ORDER[t.to] > current && days >= t.days) target = t.to;
  }
  return target;
}

/**
 * Whether an L4 entry should be cleared: it must already be at L4, be stale
 * past the clear threshold, and be marked resolved or replaced.
 */
export function shouldClear(entry, now = Date.now()) {
  if ((entry.level ?? 'L1') !== 'L4') return false;
  if (!entry.resolved && !entry.replacedBy) return false;
  return daysSince(recencyIso(entry), now) >= CLEAR_DAYS;
}

/**
 * Run a decay scan over entries (array of [id, entry] pairs).
 * Returns { actions, report } — never mutates the entries.
 * action: { id, action: 'downgrade'|'clear', from?, to?, reason }
 */
export function decayScan(entries, now = Date.now()) {
  const actions = [];
  const counts = { downgrade: 0, clear: 0 };
  for (const [id, entry] of entries) {
    const target = nextLevel(entry, now);
    if (target !== (entry.level ?? 'L1')) {
      const trans = TRANSITIONS.find((t) => t.to === target);
      actions.push({ id, action: 'downgrade', from: entry.level, to: target, reason: `${target} threshold (${trans ? trans.days : THRESHOLDS[target]}d) reached` });
      counts.downgrade += 1;
    }
    if (shouldClear({ ...entry, level: target }, now)) {
      actions.push({ id, action: 'clear', level: 'L4', reason: 'L4 + resolved/replaced + 730d stale' });
      counts.clear += 1;
    }
  }
  return {
    actions,
    report: { scanned: entries.length, counts, generatedAt: new Date(now).toISOString() },
  };
}
