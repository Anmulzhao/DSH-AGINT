/**
 * agint-quality-eval: 轻量 cron 解析工具（自包含）
 *
 * 从 agint-cron 的 lib/cron.js 复制的 parseCron / nextFire 两个纯函数。
 * 不跨插件 import（避免 AGINT 仓库路径与 dsh 部署路径的差异）：
 *   仓库里 plugins/agint-quality/agint-quality-eval/lib/../../agint-cron 不存在
 *   部署后 ../../ 才指向 plugins/ —— 两种环境路径不一致。
 *
 * 自包含后：仓库环境可 node --test 直接测，部署环境直接跑。
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
    if (!Number.isFinite(step) || step < 1) throw new Error(`agint-quality-eval: invalid step in field spec "${spec}"`);
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) {
      [lo, hi] = range.split('-').map(Number);
    } else {
      lo = hi = Number(range);
    }
    if (![lo, hi].every(Number.isFinite)) throw new Error(`agint-quality-eval: invalid range in field spec "${spec}"`);
    if (lo < min || hi > max || lo > hi) throw new Error(`agint-quality-eval: range out of bounds in field spec "${spec}"`);
    for (let v = lo; v <= hi; v += step) accepted.add(v);
  }
  return (n) => accepted.has(n);
}

export function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`agint-quality-eval: expected 5 fields, got ${parts.length} in "${expr}"`);
  return {
    minute: parseField(parts[0], FIELD_RANGES.minute[0], FIELD_RANGES.minute[1]),
    hour: parseField(parts[1], FIELD_RANGES.hour[0], FIELD_RANGES.hour[1]),
    dom: parseField(parts[2], FIELD_RANGES.dom[0], FIELD_RANGES.dom[1]),
    month: parseField(parts[3], FIELD_RANGES.month[0], FIELD_RANGES.month[1]),
    dow: parseField(parts[4], FIELD_RANGES.dow[0], FIELD_RANGES.dow[1]),
  };
}

export function nextFire(parsed, from = new Date()) {
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 366; i++) {
    if (
      parsed.minute(start.getMinutes()) &&
      parsed.hour(start.getHours()) &&
      parsed.dom(start.getDate()) &&
      parsed.month(start.getMonth() + 1) &&
      parsed.dow(start.getDay())
    ) {
      return start;
    }
    start.setMinutes(start.getMinutes() + 1);
  }
  throw new Error(`agint-quality-eval: nextFire: no match within 1 year for "${JSON.stringify(parsed)}"`);
}
