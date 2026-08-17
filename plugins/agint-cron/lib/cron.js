/**
 * agint-cron: tiny 5-field cron expression parser (m h dom mon dow).
 *
 * Supports: *, single value, comma list, range a-b, step with slash n or a-b with slash n.
 * DOW: 0 = Sunday (matches JavaScript Date.getDay()).
 * Timezone: always local (matches the host process clock).
 *
 * Pure functions, no IO; unit-testable with node --test.
 */

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
  };
}

/**
 * Next Date matching the parsed cron expression strictly after `from`.
 * Searches at minute granularity up to ~1 year out; returns null if no match
 * (which should never happen for a valid expression).
 */
export function nextFire(parsed, from = new Date()) {
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