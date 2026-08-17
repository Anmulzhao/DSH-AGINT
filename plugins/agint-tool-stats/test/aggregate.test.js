/**
 * agint-tool-stats aggregate.test.js — pure-function unit tests.
 * Run: node --test ~/.dsh/profiles/web/plugins/agint-tool-stats/test/aggregate.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSince,
  summarize,
  slowest,
  failureRate,
  repeatPatterns,
  stableStringify,
  classifyError,
  classifyOk,
} from '../lib/aggregate.js';

const T0 = Date.UTC(2026, 7, 17, 10, 0, 0); // 2026-08-17T10:00:00Z

function rec(overrides) {
  return {
    ts: T0,
    sessionId: 's1',
    turn: 1,
    step: 1,
    tool: 'bash',
    callId: 'c1',
    latencyMs: 10,
    ok: true,
    errorKind: null,
    argFingerprint: 'fp1',
    args: {},
    ...overrides,
  };
}

test('parseSince: handles s/m/h/d', () => {
  const now = T0 + 100000;
  assert.equal(parseSince('1s', now), now - 1000);
  assert.equal(parseSince('5m', now), now - 5 * 60000);
  assert.equal(parseSince('2h', now), now - 2 * 3600000);
  assert.equal(parseSince('1d', now), now - 86400000);
});

test('summarize: aggregates per tool', () => {
  const recs = [
    rec({ tool: 'bash', latencyMs: 100, ok: true }),
    rec({ tool: 'bash', latencyMs: 200, ok: true }),
    rec({ tool: 'bash', latencyMs: 300, ok: false, errorKind: 'sandbox' }),
    rec({ tool: 'read', latencyMs: 5, ok: true }),
  ];
  const out = summarize(recs);
  assert.equal(out.length, 2);
  const bash = out.find((s) => s.tool === 'bash');
  assert.equal(bash.calls, 3);
  assert.equal(Math.round(bash.failRate * 100), 33); // 1/3
  assert.equal(bash.avgMs, 200); // (100+200+300)/3
});

test('slowest: returns top N by p95 desc', () => {
  const recs = [
    rec({ tool: 'a', latencyMs: 10 }),
    rec({ tool: 'a', latencyMs: 20 }),
    rec({ tool: 'b', latencyMs: 100 }),
    rec({ tool: 'b', latencyMs: 200 }),
  ];
  const sum = summarize(recs);
  const top = slowest(sum, 1);
  assert.equal(top[0].tool, 'b');
});

test('failureRate: filters low-sample noise', () => {
  const sum = [
    { tool: 'a', calls: 10, failRate: 0.5 },
    { tool: 'b', calls: 2,  failRate: 1.0 }, // 应被过滤（<3）
    { tool: 'c', calls: 5,  failRate: 0.3 },
  ];
  const top = failureRate(sum, 10);
  assert.equal(top.length, 2); // b 被过滤
  assert.equal(top[0].tool, 'a');
});

test('repeatPatterns: groups same fingerprint', () => {
  const recs = [
    rec({ ts: T0,        tool: 'bash', argFingerprint: 'fp-same', sessionId: 's1' }),
    rec({ ts: T0 + 1000, tool: 'bash', argFingerprint: 'fp-same', sessionId: 's1' }),
    rec({ ts: T0 + 2000, tool: 'bash', argFingerprint: 'fp-same', sessionId: 's2' }),
    rec({ ts: T0 + 3000, tool: 'bash', argFingerprint: 'fp-diff', sessionId: 's3' }),
  ];
  const out = repeatPatterns(recs, { sinceMs: 0, minRepeats: 3 });
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 3);
  assert.equal(out[0].sessions.length, 2);
});

test('repeatPatterns: respects minRepeats', () => {
  const recs = [
    rec({ ts: T0,        tool: 'bash', argFingerprint: 'fp-same' }),
    rec({ ts: T0 + 1000, tool: 'bash', argFingerprint: 'fp-same' }),
  ];
  const out = repeatPatterns(recs, { sinceMs: 0, minRepeats: 3 });
  assert.equal(out.length, 0);
});

test('stableStringify: key order invariant', () => {
  const a = stableStringify({ b: 2, a: 1 });
  const b = stableStringify({ a: 1, b: 2 });
  assert.equal(a, b);
});

test('classifyError: detects sandbox', () => {
  assert.equal(classifyError('bash', 'sandbox: file access denied under workspace-write mode'), 'sandbox');
  assert.equal(classifyError('bash', 'exit code: 1'), 'exit_nonzero');
  assert.equal(classifyError('bash', 'no errors here'), null);
});

test('classifyOk: returns false for errors', () => {
  const msg = { content: [{ type: 'text', text: 'sandbox: file access denied' }] };
  assert.equal(classifyOk(msg), false);
  assert.equal(classifyOk({ content: [{ type: 'text', text: 'success' }] }), true);
});