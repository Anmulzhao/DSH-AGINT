import test from 'node:test';
import assert from 'node:assert/strict';
import { LAMBDA_BASE, THRESHOLDS, decayFactor, decayScan, effectiveConfidence, nextLevel, shouldClear } from '../lib/decay.js';

const DAY = 86_400_000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

test('decayFactor: fresh entry keeps full confidence', () => {
  assert.ok(Math.abs(decayFactor(0) - 1) < 1e-12);
});

test('decayFactor: decays exponentially with λ=0.0015/day', () => {
  assert.ok(Math.abs(decayFactor(30) - Math.exp(-LAMBDA_BASE * 30)) < 1e-12);
  assert.ok(decayFactor(365) < decayFactor(30));
  assert.ok(decayFactor(365) > 0.5); // e^-0.5475 ≈ 0.578 — gentle long tail
});

test('effectiveConfidence: stale entry loses confidence', () => {
  const fresh = { confidence: 0.8, lastRecall: iso(0) };
  const stale = { confidence: 0.8, lastRecall: iso(100) };
  assert.ok(effectiveConfidence(fresh) > effectiveConfidence(stale));
});

test('nextLevel: transitions at 90/180/365 days', () => {
  assert.equal(nextLevel({ level: 'L1', lastRecall: iso(10) }), 'L1');
  assert.equal(nextLevel({ level: 'L1', lastRecall: iso(90) }), 'L2');
  assert.equal(nextLevel({ level: 'L1', lastRecall: iso(180) }), 'L3');
  assert.equal(nextLevel({ level: 'L1', lastRecall: iso(365) }), 'L4');
  // never downgrades
  assert.equal(nextLevel({ level: 'L3', lastRecall: iso(10) }), 'L3');
});

test('shouldClear: requires L4 + resolved/replaced + 730d stale', () => {
  assert.equal(shouldClear({ level: 'L3', resolved: true, lastRecall: iso(800) }), false);
  assert.equal(shouldClear({ level: 'L4', resolved: false, lastRecall: iso(800) }), false);
  assert.equal(shouldClear({ level: 'L4', resolved: true, lastRecall: iso(700) }), false);
  assert.equal(shouldClear({ level: 'L4', resolved: true, lastRecall: iso(800) }), true);
  assert.equal(shouldClear({ level: 'L4', replacedBy: 'm-2', lastRecall: iso(800) }), true);
});

test('decayScan: reports downgrades and clears without mutating', () => {
  const entries = [
    ['a', { level: 'L1', confidence: 0.8, lastRecall: iso(100), updatedAt: iso(100) }],
    ['b', { level: 'L4', confidence: 0.2, resolved: true, lastRecall: iso(800), updatedAt: iso(800) }],
    ['c', { level: 'L1', confidence: 0.9, lastRecall: iso(0), updatedAt: iso(0) }],
  ];
  const { actions, report } = decayScan(entries);
  assert.equal(report.scanned, 3);
  const downgrades = actions.filter((a) => a.action === 'downgrade');
  const clears = actions.filter((a) => a.action === 'clear');
  assert.equal(downgrades.length, 1);
  assert.equal(downgrades[0].id, 'a');
  assert.equal(downgrades[0].to, 'L2');
  assert.equal(clears.length, 1);
  assert.equal(clears[0].id, 'b');
  // input untouched
  assert.equal(entries[0][1].level, 'L1');
});
