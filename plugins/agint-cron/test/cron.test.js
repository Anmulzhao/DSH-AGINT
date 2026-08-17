import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, parseField, nextFire, lastFire } from '../lib/cron.js';

// Use local-time Date constructor so the parser (which uses local time per
// its contract) and the test inputs are in the same frame.
// Jan 1 2026 = Thursday; Jan 11 = Sunday; Jan 15 = Thursday; Jan 16 = Friday;
// Jan 18 = Sunday. (See Python datetime verification.)

const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

// ---- parseField ----
test('parseField: * matches everything in range', () => {
  const f = parseField('*', 0, 59);
  assert.equal(f(0), true);
  assert.equal(f(30), true);
  assert.equal(f(59), true);
});

test('parseField: single value', () => {
  assert.equal(parseField('6', 0, 23)(6), true);
  assert.equal(parseField('6', 0, 23)(5), false);
  assert.equal(parseField('6', 0, 23)(7), false);
});

test('parseField: range a-b', () => {
  const f = parseField('1-5', 1, 31);
  assert.equal(f(1), true);
  assert.equal(f(5), true);
  assert.equal(f(6), false);
});

test('parseField: comma list', () => {
  const f = parseField('1,3,5', 1, 12);
  assert.equal(f(1), true);
  assert.equal(f(3), true);
  assert.equal(f(5), true);
  assert.equal(f(2), false);
  assert.equal(f(4), false);
});

test('parseField: step */n', () => {
  const f = parseField('*/15', 0, 59);
  assert.equal(f(0), true);
  assert.equal(f(15), true);
  assert.equal(f(30), true);
  assert.equal(f(45), true);
  assert.equal(f(14), false);
});

test('parseField: range with step', () => {
  const f = parseField('0-30/10', 0, 59);
  assert.equal(f(0), true);
  assert.equal(f(10), true);
  assert.equal(f(20), true);
  assert.equal(f(30), true);
  assert.equal(f(15), false);
});

test('parseField: rejects out-of-range', () => {
  assert.throws(() => parseField('60', 0, 59), /out of bounds/);
  assert.throws(() => parseField('5-10', 0, 4), /out of bounds/);
});

// ---- parseCron ----
test('parseCron: rejects wrong field count', () => {
  assert.throws(() => parseCron('* * *'), /expected 5 fields/);
  assert.throws(() => parseCron('* * * * * *'), /expected 5 fields/);
});

// ---- nextFire / lastFire: plan's jobs ----
test('nextFire: 0 6 * * * — every day at 06:00', () => {
  const p = parseCron('0 6 * * *');
  // from Jan 15 12:00 local → next Jan 16 06:00 local
  assert.equal(nextFire(p, new Date(local(2026, 1, 15, 12))).getTime(), local(2026, 1, 16, 6));
  // from exactly 06:00 → strictly after, so next day
  assert.equal(nextFire(p, new Date(local(2026, 1, 15, 6))).getTime(), local(2026, 1, 16, 6));
});

test('nextFire: 30 3 * * 1,3,5 — Mon/Wed/Fri 03:30', () => {
  const p = parseCron('30 3 * * 1,3,5');
  // from Jan 15 (Thu) 00:00 → next is Fri Jan 16 03:30
  assert.equal(nextFire(p, new Date(local(2026, 1, 15, 0))).getTime(), local(2026, 1, 16, 3, 30));
});

test('nextFire: 30 2 * * 1 — Monday 02:30', () => {
  const p = parseCron('30 2 * * 1');
  // from Jan 11 (Sun) 06:00 → next is Mon Jan 12 02:30
  assert.equal(nextFire(p, new Date(local(2026, 1, 11, 6))).getTime(), local(2026, 1, 12, 2, 30));
});

test('nextFire: 0 3 * * 0 — Sunday 03:00', () => {
  const p = parseCron('0 3 * * 0');
  // from Jan 15 (Thu) 12:00 → next is Sun Jan 18 03:00
  assert.equal(nextFire(p, new Date(local(2026, 1, 15, 12))).getTime(), local(2026, 1, 18, 3));
});

test('lastFire: returns most recent matching minute at or before at', () => {
  const p = parseCron('0 6 * * *');
  // at Jan 16 12:00 → last was Jan 16 06:00
  assert.equal(lastFire(p, new Date(local(2026, 1, 16, 12))).getTime(), local(2026, 1, 16, 6));
  // at exactly 06:00 → that minute itself
  assert.equal(lastFire(p, new Date(local(2026, 1, 16, 6))).getTime(), local(2026, 1, 16, 6));
});