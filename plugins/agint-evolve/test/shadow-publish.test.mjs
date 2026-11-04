/**
 * agint-evolve — evolution.proposed 发布接线测试（Sprint 12 A1 接线，2026-09-20）
 * Run: node --test plugins/agint-evolve/test/
 *
 * 背景：evolution.proposed 此前只有订阅方（evolution-memory / quality-eval /
 * trajectory）、没有生产发布方，生产数据只有 3 条 09-04 的历史探针。
 * 本测试锁死"接线后"的契约：
 *   1. bus 可用 → propose() 必须真实发出一条 envelope；
 *   2. bus 不可用 / publish 抛错 → propose() 照常落库并返回（直连路径完整保留）。
 * ⚠️ 不要写成"插件注册了服务就算通过"——那正是旧缺口能隐身四个月的原因。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

function makeMockCtx({ publish } = {}) {
  const tables = new Map();
  const ctx = {
    storageDomain: {
      async open(spec) {
        return {
          name: spec.name,
          version: spec.version,
          table(name) {
            let t = tables.get(name);
            if (!t) { t = new Map(); tables.set(name, t); }
            return {
              get: (id) => t.get(id) ?? null,
              put: async (id, value) => { t.set(id, value); return true; },
              delete: async (id) => t.delete(id),
              entries: () => [...t.entries()],
            };
          },
          async close() {},
        };
      },
    },
    _tables: tables,
    _effects: [],
    _provides: new Map(),
    _warns: [],
    logger: {
      warn: (msg, extra) => { ctx._warns.push({ msg, extra }); },
    },
    effect(fn) { this._effects.push(fn()); },
    provide(k, v) { this._provides.set(k, v); },
    get(k) { return this._provides.get(k) ?? null; },
    on() {},
    setInterval() { return { dispose() {} }; },
  };
  if (publish) ctx.provide('agint.eventBus.publish', publish);
  return ctx;
}

async function makeEvolve(ctxOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agint-evolve-publish-'));
  const ctx = makeMockCtx(ctxOverrides);
  apply(ctx, { root });
  return { ctx, evo: ctx.get('agint.evolve') };
}

const PROPOSAL = {
  title: '把事件总线影子发布接上',
  body: 'evolution.proposed 缺生产发布方',
  category: 'plugin',
  source: 'manual-audit',
};

test('bus 可用时 propose() 真实发布 evolution.proposed，envelope 字段符合订阅方契约', async () => {
  const envelopes = [];
  const { ctx, evo } = await makeEvolve({
    publish: async (env) => {
      envelopes.push(env);
      return { envelopeId: 'env-1', deliveredTo: 3, deadLettered: 0 };
    },
  });

  const rec = await evo.propose({ ...PROPOSAL, id: 'p-1' });

  assert.equal(envelopes.length, 1, 'propose 应发出且只发出一条 envelope');
  const env = envelopes[0];
  assert.equal(env.topic, 'evolution.proposed');
  assert.equal(env.version, 1);
  assert.equal(env.source, 'agint-evolve', 'source 必须是真实发布方，不是 agint-population');
  // 订阅方 agint-evolution-memory 的 handler 依赖这三个字段
  assert.equal(env.payload.proposalId, 'p-1');
  assert.equal(env.payload.origin, 'agint-evolve');
  assert.equal(env.payload.kind, 'plugin', 'kind 取 proposal.category');
  assert.equal(env.payload.payload.source, 'manual-audit', '原始 source 仍保留在 payload 内');
  assert.deepEqual(ctx._warns, [], '发布成功不应产生告警');
  // 返回值结构不被发布逻辑污染（tool render 依赖 proposalSchema 字段）
  assert.equal(rec.id, 'p-1');
  assert.equal(rec.status, 'proposed');
});

test('bus 不可用时 propose() 照常落库并返回，只告警不抛错', async () => {
  const { ctx, evo } = await makeEvolve(); // 不注入 publish
  const rec = await evo.propose({ ...PROPOSAL, id: 'p-2' });

  assert.equal(rec.id, 'p-2', '直连路径完整保留：落库+返回不受影响');
  const listed = await evo.listProposals({});
  assert.equal(listed.length, 1, '提案已入库');

  assert.equal(ctx._warns.length, 1, 'bus 缺失必须留痕（不能静默）');
  assert.match(ctx._warns[0].msg, /evolution\.proposed/);
  assert.match(ctx._warns[0].extra.reason, /unavailable/);
});

test('publish 抛错时 propose() 照常返回，异常被吞掉但留告警', async () => {
  const { ctx, evo } = await makeEvolve({
    publish: async () => { throw new Error('bus exploded'); },
  });
  const rec = await evo.propose({ ...PROPOSAL, id: 'p-3' });

  assert.equal(rec.id, 'p-3', 'publish 抛错不影响返回值');
  assert.equal(ctx._warns.length, 1);
  assert.match(ctx._warns[0].msg, /publish failed/);
  assert.match(ctx._warns[0].extra.error, /bus exploded/);
});

// 2026-11-02：本条此前断言「setStatus / removeProposal 不触发发布（只有 propose 是发布点）」。
// 那个设计已被推翻 —— 提案的**决定**（批准 / 驳回 / 落地 / 暂不处理）在事件侧完全不可见，
// 「谁在什么时候判了什么」只能翻 agint_evolve.json 的行尾 note（实测：把 3c988611 从
// approved 改成 rejected，总线前后零新行）。改为：决定要发，幂等写不发。
test('setStatus 改状态发一条 evolution.status-changed（带 from/to）', async () => {
  const envelopes = [];
  const { evo } = await makeEvolve({
    publish: async (env) => { envelopes.push(env); return { envelopeId: 'e', deliveredTo: 1 }; },
  });
  await evo.propose({ ...PROPOSAL, id: 'p-4' });
  await evo.setStatus('p-4', 'applied', '已落地');

  assert.equal(envelopes.length, 2, 'propose 一条 + 状态变更一条');
  assert.equal(envelopes[0].topic, 'evolution.proposed');
  const env = envelopes[1];
  assert.equal(env.topic, 'evolution.status-changed');
  assert.equal(env.source, 'agint-evolve');
  assert.equal(env.version, 1);
  assert.equal(env.payload.proposalId, 'p-4');
  assert.equal(env.payload.from, 'proposed', 'from 必须是**旧**状态（写反了审计链就倒着走）');
  assert.equal(env.payload.to, 'applied');
  assert.equal(env.payload.kind, 'plugin', 'kind 取 proposal.category');
});

test('状态不变（只补 blocker / 执行计划）不发事件 —— 幂等写不是一次决定', async () => {
  const envelopes = [];
  const { evo } = await makeEvolve({
    publish: async (env) => { envelopes.push(env); return { envelopeId: 'e', deliveredTo: 1 }; },
  });
  await evo.propose({ ...PROPOSAL, id: 'p-5' });
  envelopes.length = 0;
  await evo.setStatus('p-5', 'proposed', '补一句为什么还不能动手', { blocker: '等 X 就绪' });
  assert.equal(envelopes.length, 0, '状态未变 ⇒ 一条都不发');
});

test('bus 缺失时 setStatus 照常落库（直连路径完整保留，只告警）', async () => {
  const { ctx, evo } = await makeEvolve(); // 不注入 publish
  await evo.propose({ ...PROPOSAL, id: 'p-6' });
  ctx._warns.length = 0; // 只关心状态变更这一次
  const rec = await evo.setStatus('p-6', 'rejected', '评估后不做');
  assert.equal(rec.status, 'rejected', '发布失败不得影响状态写入');
  assert.equal(ctx._warns.length, 1, 'bus 缺失必须留痕（不能静默）');
  assert.match(ctx._warns[0].msg, /evolution\.status-changed/);
});
