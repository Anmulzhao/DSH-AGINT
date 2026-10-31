/**
 * agint-mascot: tool execute() runtime return value vs output.schema conformance guard.
 *
 * Copied from the sample in plugins/agint-self-model/test/tool-output-conformance.test.mjs
 * (proposal 1255b37a, follow-up action 1: copy this file pattern to the remaining tool modules).
 *
 * Module facts (each with file:line evidence):
 *   - This module registers exactly ONE tool, mascot_status, through
 *     registerMascotTools(ctx, api) (plugins/agint-mascot/lib/tools.js:44-115).
 *     It is NOT the usual apply(ctx) shape, so the capture helper below reproduces what
 *     the host does: ctx.get('tools') returns the tool registry.
 *   - output.schema is STRICT: additionalProperties:false and every field required
 *     (tools.js:57-95) => a drifted return value really fails the host gate.
 *   - The api object handed to the tool is the real one from
 *     plugins/agint-mascot/lib/index.js:304-316:
 *     collect() = collectProbes(ctx) + aggregateHealth(probes) (index.js:135, health.js:65).
 *   - The four probe sources use the REAL service shapes read by collectProbes:
 *     agint.cron.list() (job rows), agint.metrics.summary() ({ metrics: [] }),
 *     agint.selfModel.stats() (object holding a numeric field), loader.entries()
 *     (cordis loader rows with options.id + fiber.state; FiberState ACTIVE = 2).
 *
 * Assertion convention (sample point 4):
 *   validateJsonSchemaValue(tool.output.schema, await tool.execute(...)) must return an
 *   empty array; the raw schema must NOT be recompiled.
 *
 * Run: node --test plugins/agint-mascot/test/tool-output-conformance.test.mjs (cwd = repo root)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { collectProbes } from '../lib/index.js';
import { aggregateHealth } from '../lib/health.js';
import { registerMascotTools } from '../lib/tools.js';

/**
 * ctx with the four real probe sources plus the host tool registry.
 * The probe rows use real shapes: a cron job carries a run timestamp, a metrics
 * summary carries a metrics array, selfModel stats is an object with numeric fields,
 * and loader entries carry options.id + fiber.state.
 */
function makeCtx() {
  const services = {
    'agint.cron': {
      list: () => [
        { id: 'job-a', lastRun: '2026-10-27T00:00:00.000Z' },
        { id: 'job-b', lastRun: '2026-10-27T00:05:00.000Z' },
      ],
    },
    'agint.metrics': {
      summary: () => ({ metrics: [{ key: 'a', value: 1 }, { key: 'b', value: 2 }, { key: 'c', value: 3 }] }),
    },
    'agint.selfModel': {
      stats: () => ({ capabilityMap: 12, calibrationRuns: 3 }),
    },
    loader: {
      entries: () => [
        { options: { id: 'agint-memory' }, fiber: { state: 2 } },
        { options: { id: 'agint-metrics' }, fiber: { state: 2 } },
      ],
    },
  };
  const registered = [];
  return {
    registered,
    ctx: {
      get: (key) => (key === 'tools'
        ? { register: (t) => { registered.push(t); return () => {}; } }
        : services[key]),
    },
  };
}

/** Build the api object exactly like lib/index.js:304-316 does. */
function makeApi(ctx) {
  return {
    collect: () => collectProbes(ctx).then((probes) => aggregateHealth(probes)),
    lastPush: () => ({ at: 0, result: 'not-run' }),
    lastSkinPush: () => ({ at: 0, result: 'not-run' }),
    currentSkin: () => null,
    pollMs: () => 30000,
    isEnabled: () => true,
  };
}

/** Capture the tool registered by the real lib/tools.js. */
function captureTools() {
  const { registered, ctx } = makeCtx();
  registerMascotTools(ctx, makeApi(ctx));
  assert.equal(registered.length, 1, 'expected exactly 1 registered tool, got ' + registered.length);
  return registered[0];
}

/** Host-side gate call convention: validateJsonSchemaValue returns the VIOLATION array (empty = pass). */
function violationsOf(tool, value, label) {
  return validateJsonSchemaValue(tool.output.schema, value, 'value(' + label + ')');
}

function assertConforms(tool, value, label) {
  const violations = violationsOf(tool, value, label);
  assert.deepEqual(violations, [], label + ' does not pass the output schema of ' + tool.name + ':\n' + violations.join('\n'));
}

test('Precondition: mascot_status is captured and its output.schema is strict', () => {
  const tool = captureTools();
  assert.equal(tool.name, 'mascot_status');
  assert.equal(tool.output.schema.type, 'object');
  assert.equal(tool.output.schema.additionalProperties, false, 'the schema must be strict, otherwise drift cannot fail');
  for (const key of ['tone', 'percent', 'headline', 'note', 'errorCount', 'unknownCount', 'pollMs', 'enabled', 'lastPush', 'skin', 'lastSkinPush', 'sources']) {
    assert.ok(tool.output.schema.properties[key], 'output.schema.properties is missing ' + key);
  }
});
