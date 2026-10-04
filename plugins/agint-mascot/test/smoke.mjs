// SPDX-License-Identifier: MIT
// Copyright (c) 2026 anmul
// AGINT 新增文件。许可见 DSH-AGINT/LICENSE（MIT）。

/**
 * agint-mascot smoke tests. Plain node, no framework — `node test/smoke.mjs`.
 *
 * The load-bearing assertion is NEGATIVE: there must be no input for which an
 * unreadable source produces a green verdict. That is the property the whole
 * plugin exists to keep, so it is asserted directly rather than inferred from
 * the happy path.
 */

import assert from 'node:assert/strict';
import { aggregateHealth } from '../lib/health.js';
import { toAnnouncePayload, clampTtl, KIND, SOURCE } from '../lib/announce.js';
import { collectProbes } from '../lib/index.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err && err.message}`);
    process.exitCode = 1;
  }
}

const ok = (id) => ({ id, state: 'ok' });

console.log('agint-mascot smoke');

/* ---- health aggregation ---- */

test('all ok reads ok at 100', () => {
  const h = aggregateHealth([ok('cron'), ok('metrics'), ok('selfModel'), ok('plugins')]);
  assert.equal(h.tone, 'ok');
  assert.equal(h.percent, 100);
  assert.equal(h.unknownCount, 0);
  assert.equal(h.errorCount, 0);
});

test('one absent reads warn at 85 and is named', () => {
  const h = aggregateHealth([ok('cron'), ok('metrics'), ok('selfModel'), { id: 'plugins', state: 'absent' }]);
  assert.equal(h.tone, 'warn');
  assert.equal(h.percent, 85);
  assert.match(h.headline, /plugins/);
});

test('one error floors the tone at low even when the rest are perfect', () => {
  const h = aggregateHealth([ok('cron'), ok('metrics'), ok('selfModel'), { id: 'plugins', state: 'error' }]);
  assert.equal(h.tone, 'low');
  assert.equal(h.errorCount, 1);
  assert.match(h.headline, /plugins/);
});

test('three errors cannot be averaged away into warn', () => {
  const h = aggregateHealth([
    ok('cron'),
    { id: 'a', state: 'error' },
    { id: 'b', state: 'error' },
    { id: 'c', state: 'error' },
  ]);
  assert.equal(h.tone, 'low');
});

test('an empty probe list is low, not healthy', () => {
  const h = aggregateHealth([]);
  assert.equal(h.tone, 'low');
  assert.equal(h.percent, 0);
});

test('a non-array probe input is low, not healthy', () => {
  assert.equal(aggregateHealth(undefined).tone, 'low');
  assert.equal(aggregateHealth(null).tone, 'low');
});

test('malformed probes are dropped, never guessed at', () => {
  const h = aggregateHealth([ok('cron'), { id: 'x' }, { state: 'ok' }, null, 'nope', 7]);
  assert.equal(h.sources.length, 1);
  assert.equal(h.tone, 'ok');
});

test('an unknown state string is not accepted as ok', () => {
  const h = aggregateHealth([{ id: 'cron', state: 'fine' }]);
  assert.equal(h.sources.length, 0);
  assert.equal(h.tone, 'low');
});

test('percent never leaves 0..100', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, state: 'error' }));
  assert.equal(aggregateHealth(many).percent, 0);
});

/* ---- the negative property, asserted over the whole state space ---- */

test('NO input makes an absent or error source read as tone=ok', () => {
  const states = ['ok', 'warn', 'absent', 'error'];
  for (const a of states) {
    for (const b of states) {
      for (const c of states) {
        for (const d of states) {
          const probes = [
            { id: 'a', state: a },
            { id: 'b', state: b },
            { id: 'c', state: c },
            { id: 'd', state: d },
          ];
          const h = aggregateHealth(probes);
          const anyUnread = probes.some((p) => p.state !== 'ok');
          if (anyUnread) {
            assert.notEqual(h.tone, 'ok', `${a}/${b}/${c}/${d} must not be ok`);
          }
        }
      }
    }
  }
});

/* ---- announce mapping ---- */

test('payload uses the borrowed plan kind and the mascot source', () => {
  const payload = toAnnouncePayload(aggregateHealth([ok('cron')]), 30000);
  assert.equal(payload.kind, KIND);
  assert.equal(KIND, 'plan');
  assert.equal(payload.source, SOURCE);
});

test('tone passes through unchanged', () => {
  for (const tone of ['ok', 'warn', 'low']) {
    const h = aggregateHealth([
      { id: 'a', state: tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'error' },
    ]);
    assert.equal(toAnnouncePayload(h, 30000).tone, h.tone);
  }
});

test('ttl is clamped into the pet contract window', () => {
  assert.equal(clampTtl(0), 1000);
  assert.equal(clampTtl(-5), 1000);
  assert.equal(clampTtl(1e12), 7_200_000);
  assert.equal(clampTtl(NaN), 1000);
  assert.equal(clampTtl(30000), 30000);
});

test('payload carries percent, which the plan kind requires', () => {
  const payload = toAnnouncePayload(aggregateHealth([ok('cron')]), 30000);
  assert.equal(typeof payload.percent, 'number');
  assert.ok(payload.percent >= 0 && payload.percent <= 100);
});

/* ---- probe collection against a fake context ---- */

function fakeCtx(services) {
  return { get: (key, optional) => (optional ? services[key] : services[key]) };
}

test('a service that is not on the context reads absent, not ok', async () => {
  const probes = await collectProbes(fakeCtx({}));
  assert.equal(probes.length, 4);
  assert.ok(probes.every((p) => p.state === 'absent'));
});

test('a service that throws reads error and does not stop the other probes', async () => {
  const ctx = fakeCtx({
    'agint.cron': {
      list() {
        throw new Error('boom');
      },
    },
    'agint.metrics': { summary: async () => ({ metrics: [{ key: 'a', value: 1 }] }) },
    'agint.selfModel': { stats: async () => ({ entries: 3 }) },
    loader: { entries: async () => [{ id: 'p1', runtime: { status: 'running' } }] },
  });
  const probes = await collectProbes(ctx);
  const byId = Object.fromEntries(probes.map((p) => [p.id, p]));
  assert.equal(byId.cron.state, 'error');
  assert.equal(byId.metrics.state, 'ok');
  assert.equal(byId.selfModel.state, 'ok');
  assert.equal(byId.plugins.state, 'ok');
});

test('a service answering the wrong shape reads warn, not ok', async () => {
  const ctx = fakeCtx({
    'agint.cron': { list: async () => 'not a list' },
    'agint.metrics': { summary: async () => ({ metrics: [] }) },
  });
  const probes = await collectProbes(ctx);
  const byId = Object.fromEntries(probes.map((p) => [p.id, p]));
  assert.equal(byId.cron.state, 'warn');
  assert.equal(byId.metrics.state, 'warn', 'an empty metric list is not healthy');
});

/**
 * A loader entry in the REAL shape of `cordis-plugin-loader`:
 * `options.id` for the id, `fiber.state` as a NUMBER (FiberState), no
 * `runtime` field at all. Transcribed from `agint-family-panel/lib/index.js:160-167`.
 * ACTIVE=2, FAILED=3, DISPOSED=4, LOADING=1.
 */
function loaderEntry(id, state) {
  return { options: { id, name: `./plugins/${id}/lib/index.js` }, fiber: { state }, disabled: false };
}

test('loader entries arriving as an ITERATOR are not misread as a wrong shape', async () => {
  // Regression: entries() is an iterator, not an array. The v0.1.0 shape check
  // used Array.isArray and reported a perfectly healthy host as warn.
  const ctx = fakeCtx({
    loader: {
      entries: () => [loaderEntry('agint-metrics', 2), loaderEntry('agint-cron', 2)].values(),
    },
  });
  const probes = await collectProbes(ctx);
  const plugins = probes.find((p) => p.id === 'plugins');
  assert.equal(plugins.state, 'ok', plugins.detail);
  assert.match(plugins.detail, /全部通电/);
});

test('a FAILED loader row (fiber.state === 3) reads warn and names it', async () => {
  const ctx = fakeCtx({
    loader: { entries: () => [loaderEntry('agint-metrics', 2), loaderEntry('agint-broken', 3)].values() },
  });
  const probes = await collectProbes(ctx);
  const plugins = probes.find((p) => p.id === 'plugins');
  assert.equal(plugins.state, 'warn');
  assert.match(plugins.detail, /agint-broken/);
});

test('a DISPOSED or LOADING row is not counted as failed', async () => {
  const ctx = fakeCtx({
    loader: { entries: () => [loaderEntry('a', 4), loaderEntry('b', 1), loaderEntry('c', 0)].values() },
  });
  const probes = await collectProbes(ctx);
  assert.equal(probes.find((p) => p.id === 'plugins').state, 'ok');
});

test('an entry without a numeric fiber.state is not silently read as failed', async () => {
  const ctx = fakeCtx({ loader: { entries: () => [{ options: { id: 'x' }, fiber: {} }].values() } });
  const probes = await collectProbes(ctx);
  assert.equal(probes.find((p) => p.id === 'plugins').state, 'ok');
});

test('cron jobs arriving as an iterator are accepted', async () => {
  const ctx = fakeCtx({ 'agint.cron': { list: () => [{ id: 'a', lastRun: 1 }, { id: 'b', lastRun: 2 }].values() } });
  const probes = await collectProbes(ctx);
  assert.equal(probes.find((p) => p.id === 'cron').state, 'ok');
});

test('metrics arriving as an iterator are accepted', async () => {
  const ctx = fakeCtx({ 'agint.metrics': { summary: () => [{ key: 'a', value: 1 }].values() } });
  const probes = await collectProbes(ctx);
  assert.equal(probes.find((p) => p.id === 'metrics').state, 'ok');
});

test('a string is not accepted as a collection', async () => {
  const ctx = fakeCtx({ 'agint.cron': { list: async () => 'not a list' } });
  const probes = await collectProbes(ctx);
  assert.equal(probes.find((p) => p.id === 'cron').state, 'warn');
});

test('a cron job with no run field counts as never run', async () => {
  const ctx = fakeCtx({ 'agint.cron': { list: async () => ({ jobs: [{ id: 'a' }, { id: 'b', lastRun: 123 }] }) } });
  const probes = await collectProbes(ctx);
  const cron = probes.find((p) => p.id === 'cron');
  assert.equal(cron.state, 'warn');
  assert.match(cron.detail, /1 个从未跑过/);
});

console.log(`\n${passed} passed`);
if (process.exitCode) console.error('agint-mascot: FAILED');
