/**
 * test/smoke.mjs — agint-quality-eval smoke test（Sprint 12 / A2 准入补齐）
 *
 * 覆盖：
 *   1) compositeScore 纯函数：正常 case 返回数值
 *   2) compositeScore 纯函数：safety 一票否决 → null
 *   3) compositeScore 纯函数：空 dimensions → null
 *
 * 不依赖 Cordis host（纯函数测试）；plugin load 走 dynamic import 单独验证。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_PATH = resolve(__dirname, '../lib/index.js');
const EVALUATORS_PATH = resolve(__dirname, '../lib/evaluators.js');

const { compositeScore } = await import(EVALUATORS_PATH);

// ─── plugin load 验证 ─────────────────────────────────────────────
test('plugin module loads without throwing', async () => {
  const mod = await import(EVAL_PATH);
  assert.equal(typeof mod.apply, 'function', 'must export apply(ctx, config)');
  assert.equal(typeof mod.name, 'string', 'must export name');
});

// ─── compositeScore 纯函数 ─────────────────────────────────────────
test('compositeScore: normal result returns number in [0, 100]', () => {
  const r = {
    targetId: 't1',
    dimensions: [
      { key: 'trust', score: { score: 0.8, raw: null, evidence: [], children: [] }, findings: [] },
      { key: 'reliability', score: { score: 0.9, raw: null, evidence: [], children: [] }, findings: [] },
      { key: 'effectiveness', score: { score: 0.7, raw: null, evidence: [], children: [] }, findings: [] },
      { key: 'safety', score: { score: 0.95, raw: null, evidence: [], children: [] }, findings: [] },
      { key: 'integrability', score: { score: 0.85, raw: null, evidence: [], children: [] }, findings: [] },
    ],
    findings: [],
  };
  const s = compositeScore(r);
  assert.equal(typeof s, 'number');
  assert.ok(s >= 0 && s <= 100, `composite=${s} must be in [0, 100]`);
});

test('compositeScore: safety veto (score < 0.5) returns null', () => {
  const r = {
    targetId: 't1',
    dimensions: [
      { key: 'safety', score: { score: 0, raw: null, evidence: [], children: [] }, veto: true, findings: [] },
    ],
    findings: [{ severity: 'blocker', message: 'safety veto', evidence: [] }],
  };
  const s = compositeScore(r);
  assert.equal(s, null, 'safety veto must return null (REJECT)');
});

test('compositeScore: empty dimensions returns null', () => {
  const r = { targetId: 't1', dimensions: [], findings: [] };
  const s = compositeScore(r);
  assert.equal(s, null, 'empty dimensions must return null');
});
