/**
 * agint-cron: tiny 5-field cron expression parser (m h dom mon dow).
 *
 * Supports: *, single value, comma list, range a-b, step with slash n or a-b with slash n.
 * DOW: 0 = Sunday (matches JavaScript Date.getDay()).
 * Timezone: always local (matches the host process clock).
 *
 * Pure functions, no IO; unit-testable with node --test.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * D5 迁移（2026-10-21，老板令「复用 dsh ctx.schedule」）：
 *
 * 本模块原先**自研**整套 cron 规则引擎（解析 + nextFire + lastFire），属宿主层能力
 * —— 上游 `@deepseek-ai/dsh-schedule` 已有等价且更强的实现：
 *   · canonicalizeCronExpression  表达式归一化 + 方言校验
 *   · createCronScheduleRecord    构造 cron 记录，内部算 scheduledAt（= 下一次）
 *   · resolveCronOccurrence       同时给 occurrenceAt（≤ 决策时刻的最近一次）
 *                                  与 nextScheduledAt（下一次）
 *
 * 自研版 lastFire/nextFire 是**分钟粒度暴力扫描**（上限 1 年 ⇒ 最坏 525,600 次
 * Date 构造）。上游用 Temporal 日历算，复杂度 O(天)，且带 IANA 时区 + DST 正确性。
 *
 * 落地形状（重要，别改）：
 *   · **规则与时刻计算 → 交给上游**（宿主层）
 *   · **补跑/幂等策略（isDue）→ 保留本模块**（进化层：这是 agint 的调度语义，
 *     不是宿主的提醒投递语义）
 *   · **不调用 ctx.schedule.create()**：宿主 create() 语义是"往绑定 Session 注入
 *     提醒消息"，且投递需 Session 承认 session/flush；agint-cron 的 27 个 job 是
 *     host 平面无人值守直调，没有可绑定的 Session。强行 create() 会把无人值守
 *     job 变成 agent 消息 —— 行为变更。此处复用的是宿主的**规则引擎**，不是投递。
 *
 * 上游缺席 ⇒ 回落本模块的自研实现（软依赖，行为与迁移前一致）。
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * 上游 cron 引擎句柄（由 host-schedule 桥在加载成功后注入）。
 * 形状：{ resolveNext(expression, timeZone, fromMs): number|null,
 *         resolveLast(expression, timeZone, atMs): number|null }
 * null = 上游不可用 ⇒ 全程走本模块的自研实现。
 */
let _hostEngine = null;

/** 注入上游 cron 引擎（host-schedule 桥在 loadHostSchedule 成功后调用）。 */
export function setHostCronEngine(engine) {
  _hostEngine = engine && typeof engine.resolveNext === 'function' ? engine : null;
}

/** 取当前上游引擎（null = 未接入）。测试可直接看它是否就位。 */
export function getHostCronEngine() {
  return _hostEngine;
}

/** 宿主本地 IANA 时区名（上游 cron 规则需要显式时区）。取不到则退回 'UTC'。 */
export function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const FIELD_RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6],
};

export function parseField(spec, min, max) {
  if (spec === void 0 || spec === null) return () => true;
  const parts = String(spec).split(',');
  const accepted = new Set();
  for (const part of parts) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    if (!Number.isFinite(step) || step < 1) throw new Error(`agint-cron: invalid step in field spec "${spec}"`);
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) {
      [lo, hi] = range.split('-').map(Number);
    } else {
      lo = hi = Number(range);
    }
    if (![lo, hi].every(Number.isFinite)) throw new Error(`agint-cron: invalid range in field spec "${spec}"`);
    if (lo < min || hi > max || lo > hi) throw new Error(`agint-cron: range out of bounds in field spec "${spec}" (allowed ${min}-${max})`);
    for (let v = lo; v <= hi; v += step) accepted.add(v);
  }
  return (n) => accepted.has(n);
}

export function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`agint-cron: expected 5 fields, got ${parts.length} in "${expr}"`);
  return {
    minute: parseField(parts[0], FIELD_RANGES.minute[0], FIELD_RANGES.minute[1]),
    hour: parseField(parts[1], FIELD_RANGES.hour[0], FIELD_RANGES.hour[1]),
    dom: parseField(parts[2], FIELD_RANGES.dom[0], FIELD_RANGES.dom[1]),
    month: parseField(parts[3], FIELD_RANGES.month[0], FIELD_RANGES.month[1]),
    dow: parseField(parts[4], FIELD_RANGES.dow[0], FIELD_RANGES.dow[1]),
    // D5：带上原始表达式与时区，上游引擎需要它们（上游按显式 IANA 时区算）
    expression: String(expr).trim(),
    timeZone: localTimeZone(),
  };
}

/**
 * Next Date matching the parsed cron expression strictly after `from`.
 * Searches at minute granularity up to ~1 year out; returns null if no match
 * (which should never happen for a valid expression).
 *
 * D5：上游引擎就位时走上游（Temporal 日历算，O(天) + IANA 时区 + DST 正确）；
 * 上游缺席才走下面的自研暴力扫描。
 */
export function nextFire(parsed, from = new Date()) {
  // D5：上游优先
  if (_hostEngine && parsed?.expression) {
    try {
      const ms = _hostEngine.resolveNext(parsed.expression, parsed.timeZone, from.getTime());
      return ms === null || ms === undefined ? null : new Date(ms);
    } catch {
      // 上游算不出来 ⇒ 落回自研（不能因为上游异常就丢调度）
    }
  }
  // Start from the next minute boundary strictly after `from`.
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const cap = new Date(start.getTime() + 366 * 24 * 60 * 60 * 1000);
  for (let t = start.getTime(); t <= cap.getTime(); t += 60_000) {
    const d = new Date(t);
    if (
      parsed.month(d.getMonth() + 1) &&
      parsed.dom(d.getDate()) &&
      parsed.dow(d.getDay()) &&
      parsed.hour(d.getHours()) &&
      parsed.minute(d.getMinutes())
    ) {
      return d;
    }
  }
  return null;
}

/** Last Date matching the parsed cron expression at or before `at`. */
export function lastFire(parsed, at = new Date()) {
  // D5：上游优先
  if (_hostEngine && parsed?.expression) {
    try {
      const ms = _hostEngine.resolveLast(parsed.expression, parsed.timeZone, at.getTime());
      return ms === null || ms === undefined ? null : new Date(ms);
    } catch {
      // 同上：上游异常不丢调度
    }
  }
  const start = new Date(at.getTime());
  start.setSeconds(0, 0);
  for (let t = start.getTime(); t >= 0; t -= 60_000) {
    const d = new Date(t);
    if (
      parsed.month(d.getMonth() + 1) &&
      parsed.dom(d.getDate()) &&
      parsed.dow(d.getDay()) &&
      parsed.hour(d.getHours()) &&
      parsed.minute(d.getMinutes())
    ) {
      return d;
    }
    // Safety: stop after scanning back ~1 year
    if (start.getTime() - t > 366 * 24 * 60 * 60 * 1000) break;
  }
  return null;
}

/**
 * Whether a job is due to fire at `now`.
 *
 * `lastRunAt` is the epoch-ms of the previous run, or `null` if the job has
 * never run. Backfill-aware: a job is due when the most recent scheduled
 * occurrence at or before `now` is strictly after the last recorded run.
 *
 *   - A never-run job (lastRunAt null) is always due → backfills once on the
 *     next tick after boot.
 *   - A daily that hasn't run today, and a weekly whose narrow fire window
 *     already slipped by while the host was offline, are both due.
 *   - Once fired, lastRunAt moves past `due`, so the same occurrence is never
 *     fired twice — a month of missed weekly windows yields exactly one
 *     catch-up run, not a flood.
 */
export function isDue(parsed, lastRunAt, now = Date.now()) {
  const due = lastFire(parsed, new Date(now));
  if (due === null) return false;
  if (lastRunAt !== null && due.getTime() <= lastRunAt) return false;
  return true;
}