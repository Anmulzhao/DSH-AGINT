/**
 * agint-diagnosis diagnosis.completed publish tests — Sprint 12 / A6 (T1 影子期).
 * Run: node --test plugins/agint-diagnosis/test/diagnosis-completed-publish.test.mjs
 *
 * 覆盖：
 *   1. report() 在 bus 可用时 publish `diagnosis.completed`（topic/version/source + payload 各字段）
 *   2. payload 字段：reportId / targetIds / rootCauseDistribution / clusterCount / evaluatedAt
 *   3. bus 不可用（ctx.get 返回 null）→ 软降级，report 仍正常返回（不 throw）
 *   4. publish 抛错 → 软降级，report 仍正常返回
 *   5. publish 用单 service 接口（不用伞键）——即 topic 直接是 'diagnosis.completed'
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const plugin = require('../lib/index.js');

function makeCtx({ withBus = true, busThrows = false } = {}) {
  const services = {};
  const now = Date.now();
  const annotations = [
    { failureId: 'f-r-1', rootCause: 'TOOL_GAP', confidence: 0.7, evidence: '...', kind: 'annotation', createdAt: new Date(now - 1 * 86400_000).toISOString() },
    { failureId: 'f-r-2', rootCause: 'TOOL_GAP', confidence: 0.7, evidence: '...', kind: 'annotation', createdAt: new Date(now - 2 * 86400_000).toISOString() },
    { failureId: 'f-r-3', rootCause: 'TOOL_GAP', confidence: 0.7, evidence: '...', kind: 'annotation', createdAt: new Date(now - 3 * 86400_000).toISOString() },
    { failureId: 'f-r-4', rootCause: 'PROMPT_DEFICIENCY', confidence: 0.6, evidence: '...', kind: 'annotation', createdAt: new Date(now - 4 * 86400_000).toISOString() },
    { failureId: 'f-r-5', rootCause: 'PROMPT_DEFICIENCY', confidence: 0.6, evidence: '...', kind: 'annotation', createdAt: new Date(now - 5 * 86400_000).toISOString() },
  ];
  const published = [];
  const fakeCtx = {
    storageDomain: {
      open: async () => {
        const store = { annotations, clusters: [], reports: [] };
        return {
          table: (name) => ({
            entries: () => {
              const m = store[name];
              if (!m) return [];
              return m.map((rec, i) => [`k-${name}-${i}`, rec]);
            },
            put: async (id, entry) => { store[name] = store[name] || []; store[name].push(entry); },
          }),
          close: async () => undefined,
        };
      },
    },
    get: (name) => {
      if (name === 'agint.evolution') return { queryFailures: async () => [] };
      if (name === 'agint.wiki') return { write: async () => undefined };
      if (name === 'agint.memory') return { write: async () => undefined };
      if (name === 'agint.eventBus.publish') {
        if (!withBus) return null;
        if (busThrows) return async () => { throw new Error('bus down'); };
        return async (env) => { published.push(env); return { published: true, deliveredTo: ['x'] }; };
      }
      return null;
    },
    provide(name, fn) { services[name] = fn; },
    effect() { return () => undefined; },
  };
  plugin.apply(fakeCtx);
  return { services, published, report: services['agint.diagnosis.report'] };
}

test('report() 在 bus 可用时 publish diagnosis.completed（payload 各字段）', async () => {
  const { report, published } = makeCtx({ withBus: true });
  const r = await report({ windowDays: 7 });
  // report 正常返回
  assert.equal(r.windowDays, 7);
  assert.equal(typeof r.generatedAt, 'string');
  // publish 恰一次（diagnosis.completed）
  const env = published.find((e) => e.topic === 'diagnosis.completed');
  assert.ok(env, '应 publish diagnosis.completed');
  assert.equal(env.version, 1);
  assert.equal(env.source, 'agint-diagnosis');
  // payload 字段
  assert.equal(typeof env.payload.reportId, 'string');
  assert.ok(Array.isArray(env.payload.targetIds), 'targetIds 是数组');
  assert.equal(typeof env.payload.rootCauseDistribution, 'object');
  assert.equal(typeof env.payload.clusterCount, 'number');
  assert.equal(typeof env.payload.evaluatedAt, 'string');
  assert.equal(Object.keys(env.payload.rootCauseDistribution).length, 7);
  assert.equal(env.payload.rootCauseDistribution.TOOL_GAP, 3);
});

test('bus 不可用 → 软降级，report 仍正常返回', async () => {
  const { report, published } = makeCtx({ withBus: false });
  const r = await report({ windowDays: 7 });
  assert.equal(r.windowDays, 7);
  assert.equal(typeof r.generatedAt, 'string');
  assert.equal(published.length, 0, 'bus 不可用不 publish');
});

test('publish 抛错 → 软降级，report 仍正常返回', async () => {
  const { report, published } = makeCtx({ withBus: true, busThrows: true });
  const r = await report({ windowDays: 7 });
  assert.equal(r.windowDays, 7);
  assert.equal(typeof r.generatedAt, 'string');
  assert.equal(published.length, 0, 'publish 抛错不写 published');
});

test('publish 用单 service 接口（topic 直达，无伞键）', async () => {
  const { report } = makeCtx({ withBus: true });
  const r = await report({ windowDays: 7 });
  assert.equal(r.windowDays, 7);
});
