/**
 * provider 注册表测试（行动 #5，2026-09-28）。
 * 覆盖：内置 provider、register/unregister/list/setActive/getActive、
 * resolveAndEvaluate 的成功/未注册回退/evaluate 抛错回退、provider 形状校验。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_PROVIDER_ID,
  builtinPolicyProvider,
  validateProviderShape,
  createProviderRegistry,
} from '../lib/provider.js';
import { decidePolicy } from '../lib/decide.js';

const SAMPLE_RESULTS = [
  {
    targetId: 'skill-x',
    dimensions: [
      { key: 'trust', score: { score: 0.8 } },
      { key: 'reliability', score: { score: 0.8 } },
      { key: 'effectiveness', score: { score: 0.6 } },
      { key: 'safety', score: { score: 0.9 } },
      { key: 'integrability', score: { score: 0.7 } },
    ],
  },
];

const fakeProvider = (id, behavior) => ({
  id,
  version: '1.0.0',
  describe: () => ({ id, version: '1.0.0', kind: 'fake' }),
  evaluate: behavior ?? (async ({ results }) => ({
    kind: 'AUTO_DEPLOY',
    score: 99,
    reason: `fake:${id}`,
    triggeredBy: ['fake'],
    decidedAt: new Date().toISOString(),
    policyId: `fake@${id}`,
  })),
});

test('builtinPolicyProvider: 包装 decidePolicy，id/version/describe 齐全', async () => {
  const p = builtinPolicyProvider();
  assert.equal(p.id, BUILTIN_PROVIDER_ID);
  assert.equal(p.version, '0.4.0');
  assert.equal(p.describe().kind, 'threshold-composite');
  const d = await p.evaluate({ results: SAMPLE_RESULTS, config: {}, options: {} });
  assert.equal(d.kind, 'AUTO_DEPLOY'); // 0.8/0.8/0.6/0.9/0.7 加权 ≥70
  assert.equal(typeof d.score, 'number');
});

test('validateProviderShape: 非法形状 → invalid', () => {
  assert.equal(validateProviderShape(null).valid, false);
  assert.equal(validateProviderShape({}).valid, false);
  assert.equal(validateProviderShape({ id: '', evaluate: () => {} }).valid, false);
  assert.equal(validateProviderShape({ id: 'x' }).valid, false);
});

test('registry: 默认 active = builtin，list 含内置', () => {
  const r = createProviderRegistry();
  assert.equal(r.getActive(), BUILTIN_PROVIDER_ID);
  const ids = r.list().map((p) => p.id);
  assert.deepEqual(ids, [BUILTIN_PROVIDER_ID]);
  assert.equal(r.list()[0].active, true);
});

test('registry: register 外部 provider + setActive 切换', () => {
  const r = createProviderRegistry();
  const p = fakeProvider('external-llm');
  r.register(p);
  assert.equal(r.getActive(), BUILTIN_PROVIDER_ID);
  r.setActive('external-llm');
  assert.equal(r.getActive(), 'external-llm');
  const list = r.list();
  assert.equal(list.length, 2);
  assert.equal(list.find((x) => x.id === 'external-llm').active, true);
  assert.equal(list.find((x) => x.id === BUILTIN_PROVIDER_ID).active, false);
});

test('registry: register 非法 provider → 抛错', () => {
  const r = createProviderRegistry();
  assert.throws(() => r.register({ id: 'bad' }), /evaluate must be a function/);
});

test('registry: setActive 未注册 → 抛错（显式失败，不静默回退）', () => {
  const r = createProviderRegistry();
  assert.throws(() => r.setActive('nope'), /not registered/);
});

test('registry: unregister 内置 → 拒绝', () => {
  const r = createProviderRegistry();
  assert.deepEqual(r.unregister(BUILTIN_PROVIDER_ID), { ok: false, reason: 'builtin provider cannot be unregistered' });
});

test('registry: unregister 外部 provider → 成功且 active 回退内置', () => {
  const r = createProviderRegistry();
  r.register(fakeProvider('ext'));
  r.setActive('ext');
  const u = r.unregister('ext');
  assert.equal(u.ok, true);
  assert.equal(r.getActive(), BUILTIN_PROVIDER_ID);
});

test('resolveAndEvaluate: 用 active provider 决策（无 fallback）', async () => {
  const r = createProviderRegistry();
  const out = await r.resolveAndEvaluate({ results: SAMPLE_RESULTS, config: {}, options: {} });
  assert.equal(out.fallback, false);
  assert.equal(out.providerId, BUILTIN_PROVIDER_ID);
  assert.equal(out.decision.kind, 'AUTO_DEPLOY');
});

test('resolveAndEvaluate: 指定 providerId（active 之外的已注册 provider）', async () => {
  const r = createProviderRegistry();
  r.register(fakeProvider('ext'));
  const out = await r.resolveAndEvaluate({ results: SAMPLE_RESULTS, config: {}, options: {}, providerId: 'ext' });
  assert.equal(out.fallback, false);
  assert.equal(out.providerId, 'ext');
  assert.equal(out.decision.reason, 'fake:ext');
});

test('resolveAndEvaluate: providerId 未注册 → 回退内置 + fallback 标记', async () => {
  const r = createProviderRegistry();
  const out = await r.resolveAndEvaluate({ results: SAMPLE_RESULTS, config: {}, options: {}, providerId: 'ghost' });
  assert.equal(out.fallback, true);
  assert.equal(out.providerId, BUILTIN_PROVIDER_ID);
  assert.match(out.fallbackReason, /"ghost" not registered/);
  assert.equal(out.decision.kind, 'AUTO_DEPLOY'); // 决策不丢
});

test('resolveAndEvaluate: provider.evaluate 抛错 → 回退内置 + fallback 标记（决策不丢）', async () => {
  const r = createProviderRegistry();
  r.register(fakeProvider('broken', async () => { throw new Error('llm down'); }));
  r.setActive('broken');
  const out = await r.resolveAndEvaluate({ results: SAMPLE_RESULTS, config: {}, options: {} });
  assert.equal(out.fallback, true);
  assert.equal(out.providerId, BUILTIN_PROVIDER_ID);
  assert.match(out.fallbackReason, /"broken" evaluate failed: llm down/);
  assert.equal(out.decision.kind, 'AUTO_DEPLOY');
});

test('registry: initialActiveId 从 config 进入（未注册时回退内置）', async () => {
  const r = createProviderRegistry({ initialActiveId: 'ghost' });
  assert.equal(r.getActive(), BUILTIN_PROVIDER_ID); // 未注册 → 回退内置
  const r2 = createProviderRegistry({ initialActiveId: 'ext', extraProviders: { ext: fakeProvider('ext') } });
  assert.equal(r2.getActive(), 'ext');
});
