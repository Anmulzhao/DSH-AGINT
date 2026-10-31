/**
 * agint-input-gateway: tool execute() runtime return value vs output.schema conformance guard.
 *
 * Copied from the sample in plugins/agint-self-model/test/tool-output-conformance.test.mjs
 * (proposal 1255b37a, follow-up action 1: copy this file pattern to the remaining tool modules).
 *
 * Module facts (each with file:line evidence):
 *   - The six tools are all defined in plugins/agint-input-gateway/lib/tools.js, and all read the
 *     ctx['agint.inputGateway'] service (tools.js:17).
 *   - output.schema is one shared constant 
 *     out = { type: 'object', additionalProperties: true } (tools.js:19), so the only violation
 *     possible is 'not an object'.
 *   - The service is a thin wrapper over the real InputGateway
 *     (plugins/agint-input-gateway/lib/index.js:129-137), so this file builds the fixture from
 *     the REAL InputGateway class (lib/gateway.js) + in-memory table, NOT a generic stub.
 *   - Signal shape follows the real pipeline fields read by gateway.js:439-455
 *     (signalId / signalType / source / payload / confidence / relevance / occurredAt).
 *
 * Assertion convention (same as the sample, point 4):
 *   validateJsonSchemaValue(tool.output.schema, await tool.execute(...)) must return an empty
 *   array; the raw schema must NOT be passed through valueSchemaSpecToJsonSchema again.
 *
 * Run: node --test plugins/agint-input-gateway/test/tool-output-conformance.test.mjs
 *      (cwd = repo root)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { InputGateway } from '../lib/gateway.js';
import { apply as applyTools } from '../lib/tools.js';

/** In-memory table: the gateway only uses put / get / delete / entries. */
function memTable() {
  const m = new Map();
  return {
    async put(k, v) { m.set(k, v); },
    async get(k) { return m.get(k); },
    async delete(k) { return m.delete(k); },
    entries() { return m.entries(); },
    get size() { return m.size; },
  };
}

/** One real-shaped channel (gateway.js registerChannel expects id + fetch). */
function makeChannel(id, type, signals) {
  return {
    id,
    type,
    cron: '*/5 * * * *',
    fetch: async () => signals,
    health: async () => ({ status: 'ok', note: 'fixture channel' }),
  };
}

/** One real-shaped input signal (fields read by gateway.js processSignals/_publish). */
function makeSignal(id, type) {
  return {
    signalId: id,
    signalType: type,
    source: 'fixture-source',
    payload: { note: 'fixture payload for ' + id },
    confidence: 0.8,
    relevance: 0.7,
    occurredAt: '2026-10-27T00:00:00.000Z',
  };
}

/**
 * Real fixture: the REAL InputGateway class + two channels + a publish function that
 * really accepts (so emitted > 0 and the positive branch is not empty).
 * The service facade mirrors index.js:129-137 exactly.
 */
function makeService() {
  const tables = new Map();
  const table = (n) => {
    if (!tables.has(n)) tables.set(n, memTable());
    return tables.get(n);
  };
  const gateway = new InputGateway({
    table,
    getPublish: () => async () => ({ accepted: true }),
    config: {
      enabled: true,
      confidenceThreshold: 0.3,
      relevanceLowQueue: 0.2,
      noiseMaxPerSource: 5,
      securityAction: 'flag',
      forwardEmptyDiagnosis: true,
    },
    debug: () => {},
    now: () => Date.parse('2026-10-27T00:00:00.000Z'),
  });
  gateway.registerChannel(makeChannel('self-observation', 'self-observation', [makeSignal('sig-1', 'tool-anomaly')]));
  gateway.registerChannel(makeChannel('external-git', 'external', [makeSignal('sig-2', 'repo-diff')]));
  return {
    registerChannel: (ch) => gateway.registerChannel(ch),
    fetchAll: () => gateway.fetchAll(),
    forceFetch: (channelId) => gateway.forceFetch(channelId),
    getStatus: () => gateway.getStatus(),
    getChannelStatus: (channelId) => gateway.getChannelStatus(channelId),
    setQuota: (channelId, quota) => gateway.setQuota(channelId, quota),
    setChannelEnabled: (channelId, enabled) => gateway.setChannelEnabled(channelId, enabled),
  };
}

/** Capture the tools registered by the real lib/tools.js. */
function captureTools(service) {
  const registered = [];
  const ctx = {
    tools: { register: (t) => { registered.push(t); return () => {}; } },
    'agint.inputGateway': service,
  };
  applyTools(ctx);
  return Object.fromEntries(registered.map((t) => [t.name, t]));
}

/** Host-side gate call convention: validateJsonSchemaValue returns the VIOLATION array (empty = pass). */
function violationsOf(tool, value, label) {
  return validateJsonSchemaValue(tool.output.schema, value, 'value(' + label + ')');
}

function assertConforms(tool, value, label) {
  const violations = violationsOf(tool, value, label);
  assert.deepEqual(violations, [], label + ' does not pass the output schema of ' + tool.name + ':\n' + violations.join('\n'));
}

const EXPECTED_TOOLS = [
  'input_gateway_status', 'input_gateway_channel_status', 'input_gateway_force_fetch',
  'input_gateway_set_quota', 'input_gateway_channel_enable', 'input_gateway_channel_disable',
];

test('Precondition: all six input-gateway tools are captured and every output.schema root is object', () => {
  const tools = captureTools(makeService());
  for (const name of EXPECTED_TOOLS) {
    assert.ok(tools[name], 'missing tool ' + name);
    assert.equal(tools[name].output.schema.type, 'object', name + '.output.schema root is not object');
  }
});

test('Negative control: an array return value is rejected by the SAME schema (the guard has discriminating power)', () => {
  const tool = captureTools(makeService()).input_gateway_status;
  const raw = [{ channelId: 'self-observation' }];
  const violations = violationsOf(tool, raw, 'nc-bare-array');
  assert.ok(violations.length > 0, 'Guard is spinning: the bare array passed the object schema');
  assert.ok(violations.some((v) => /must be an object/.test(v)), 'the host message must be an object is missing: ' + JSON.stringify(violations));
  assert.throws(() => assertConforms(tool, raw, 'nc-bare-array'), /must be an object/, 'assertConforms did not throw on the bare array: the assertion was weakened');
});

test('Positive: input_gateway_status real return value passes its own schema (non-empty branch)', async () => {
  const tools = captureTools(makeService());
  const value = await tools.input_gateway_status.execute({});
  assert.ok(Array.isArray(value.channels), 'status.channels is not an array');
  assert.equal(value.channels.length, 2, 'expected 2 registered channels, got ' + value.channels.length);
  const ch = value.channels[0];
  assert.equal(ch.channelId, 'self-observation');
  assert.equal(ch.channelType, 'self-observation');
  assert.equal(typeof ch.quota, 'number');
  assert.ok(ch.counters && typeof ch.counters === 'object', 'channel counters missing');
  assert.ok(value.security && Array.isArray(value.security.checkedTypes), 'security.checkedTypes missing');
  assert.ok(value.security.checkedTypes.includes('external'), 'security.checkedTypes has no external channel type');
  assertConforms(tools.input_gateway_status, value, 'status');
});

test('Positive: input_gateway_channel_status real return value passes its own schema (counters + zeroHit + health)', async () => {
  const tools = captureTools(makeService());
  const value = await tools.input_gateway_channel_status.execute({ channelId: 'self-observation' });
  assert.equal(value.channelId, 'self-observation');
  assert.ok(value.counters && typeof value.counters === 'object', 'counters missing');
  assert.ok(value.zeroHit && typeof value.zeroHit.status === 'string', 'zeroHit missing');
  assert.ok(value.health && value.health.status === 'ok', 'channel self-reported health missing');
  assertConforms(tools.input_gateway_channel_status, value, 'channel-status');
});

test('Positive: input_gateway_force_fetch real return value passes its own schema (emitted > 0, not the empty branch)', async () => {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => { const t = realSetTimeout(fn, ms, ...rest); if (typeof t.unref === 'function') t.unref(); return t; };
  try {
  const tools = captureTools(makeService());
  const value = await tools.input_gateway_force_fetch.execute({ channelId: 'self-observation' });
  assert.equal(value.ok, true, 'force_fetch failed: ' + JSON.stringify(value));
  assert.equal(value.in, 1, 'in is not 1');
  assert.equal(value.emitted, 1, 'emitted is not 1 (an empty branch would be a false green)');
  assert.equal(value.filtered, 0);
  assertConforms(tools.input_gateway_force_fetch, value, 'force-fetch');
  } finally { globalThis.setTimeout = realSetTimeout; }
});

test('Positive: input_gateway_set_quota / channel_disable / channel_enable real return values pass their own schemas', async () => {
  const tools = captureTools(makeService());
  const quota = await tools.input_gateway_set_quota.execute({ channelId: 'self-observation', quota: 42 });
  assert.equal(quota.channelId, 'self-observation');
  assert.equal(quota.quota, 42);
  assertConforms(tools.input_gateway_set_quota, quota, 'set-quota');

  const off = await tools.input_gateway_channel_disable.execute({ channelId: 'self-observation' });
  assert.equal(off.enabled, false);
  assertConforms(tools.input_gateway_channel_disable, off, 'channel-disable');

  const on = await tools.input_gateway_channel_enable.execute({ channelId: 'self-observation' });
  assert.equal(on.enabled, true);
  assertConforms(tools.input_gateway_channel_enable, on, 'channel-enable');
});

test('Convention check: tool.output.schema is already raw JSON Schema and must not be recompiled', () => {
  const tools = captureTools(makeService());
  for (const name of EXPECTED_TOOLS) {
    assert.doesNotThrow(
      () => validateJsonSchemaValue(tools[name].output.schema, {}, 'value(' + name + ')'),
      name + '.output.schema is not a directly usable raw schema',
    );
  }
});
