/**
 * test/curriculum-pull.test.mjs
 *
 * 2026-10-21 修「evidence 一次性 push 导致读数振荡」的回归钉。
 *
 * 背景：0.7.8 第一版把 evidence 从 selfUpdate 传进聚合，解决了「成绩不进画像」。
 * 但 evidence **不落库**，所以：
 *   T1 curriculum 推 3 条 pass ⇒ integration = CAN
 *   T2 dream 触发 update（不传 evidence）⇒ 同一域重算成 UNCERTAIN
 * 能力读数随「哪个触发器最后跑」来回拉，不可用。
 *
 * 修法：改成 pull —— self-model 每次聚合主动读 curriculum 的 attempts 明细。
 * 本文件钉三件事：
 *   1. pull 源必须是 listAttempts（不是 list —— list 返 challenges，无 result 字段）
 *   2. 两次连续 update（一次带 evidence、一次不带）结果必须一致（不振荡）
 *   3. windowDays 之外的 attempt 不计入
 *
 * 跑法：node --test plugins/agint-self-model/test/curriculum-pull.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── 用真插件 apply()，不复刻逻辑 ─────────────────────────────────────────
async function buildEnv({ attempts = [], failures = [], templates = [], boot } = {}) {
  const mod = await import('../lib/index.js');

  // 内存 storage domain
  const tables = new Map();
  const getTable = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  const makeTable = (name) => {
    const t = getTable(name);
    return {
      put: async (id, v) => { t.set(id, v); return true; },
      get: (id) => t.get(id) ?? null,
      delete: async (id) => { t.delete(id); return true; },
      entries: () => Array.from(t.entries()),
      size: async () => t.size,
    };
  };

  const services = new Map();
  services.set('agint.evolution', {
    queryFailures: async () => failures,
    queryTemplates: async () => templates,
    addFailure: async () => ({}),
    getLogRange: async () => [],
    stats: async () => ({}),
  });
  services.set('agint.curriculum', {
    // 关键：只提供 listAttempts，故意**不**提供 list（防止实现偷偷用 list）
    listAttempts: async ({ limit } = {}) => (limit ? attempts.slice(-limit) : attempts),
  });
  services.set('agint.eventBus.publish', async () => ({ accepted: true }));
  services.set('agint.eventBus.subscribe', () => () => {});

  // ⛔ storageDomain.open 的契约（storage.js:270-281 实证）：
  //    open() 返回 handle，handle.table(name) 是**同步**调用，返回 TableHandle；
  //    TableHandle 需有 put/get/delete/entries，且 size 是 **getter 不是函数**。
  const ctx = {
    storageDomain: {
      open: async () => ({
        table: (name) => makeTable(name),
        close: async () => {},
      }),
    },
    effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {}; } catch { return () => {}; } },
    get: (k) => services.get(k) ?? null,
    provide: (k, v) => services.set(k, v),
    on: () => () => {},
  };
  mod.apply(ctx, {});
  // 等 storageDomain.open 的 then 链跑完（adaptTable 热切换）
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));

  return {
    update: services.get('agint.selfModel.update'),
    snapshot: services.get('agint.selfModel.snapshot'),
  };
}

const isoDaysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();

const PASS_ATTEMPTS = [
  { id: 'att1', challengeId: 'clg1', domain: 'integration', result: 'pass', verifiedAt: isoDaysAgo(2) },
  { id: 'att2', challengeId: 'clg2', domain: 'integration', result: 'pass', verifiedAt: isoDaysAgo(2) },
  { id: 'att3', challengeId: 'clg3', domain: 'integration', result: 'pass', verifiedAt: isoDaysAgo(2) },
];

test('pull：curriculum 的 3 条 pass 应让 integration 判成 CAN', async () => {
  const env = await buildEnv({ attempts: PASS_ATTEMPTS });
  // ⛔ 必须先 update：snapshot() 只读 capability_map，不触发聚合。
  await env.update({ trigger: 'dream-completed' });
  const snap = await env.snapshot();
  const row = snap.capabilities.find((c) => c.domain === 'integration');
  assert.ok(row, 'integration 应出现在能力画像里');
  assert.equal(row.status, 'CAN', '累计 3 条 pass ⇒ CAN（SUCCESS_THRESHOLD=3）');
});

test('核心：两次连续 update 结果必须一致（不振荡）', async () => {
  const env = await buildEnv({ attempts: PASS_ATTEMPTS });
  // T1：带 evidence 调用（模拟 curriculum 提交后立刻回调）
  await env.update({
    trigger: 'task-completed',
    evidence: { domain: 'integration', result: 'pass', challengeId: 'clg_new' },
  });
  const s1 = await env.snapshot();
  const st1 = s1.capabilities.find((c) => c.domain === 'integration')?.status;

  // T2：不带 evidence 调用（模拟 dream.completed 触发）
  await env.update({ trigger: 'dream-completed' });
  const s2 = await env.snapshot();
  const st2 = s2.capabilities.find((c) => c.domain === 'integration')?.status;

  assert.equal(st1, st2,
    `两次触发必须得到同样的能力判定（T1=${st1} / T2=${st2}）。`
    + '不一致就说明 evidence 不落库导致振荡，pull 没生效');
});

test('windowDays 之外的 attempt 不计入', async () => {
  const old = [
    { id: 'o1', challengeId: 'c1', domain: 'integration', result: 'pass', verifiedAt: isoDaysAgo(40) },
    { id: 'o2', challengeId: 'c2', domain: 'integration', result: 'pass', verifiedAt: isoDaysAgo(40) },
    { id: 'o3', challengeId: 'c3', domain: 'integration', result: 'pass', verifiedAt: isoDaysAgo(40) },
  ];
  const env = await buildEnv({ attempts: old });
  await env.update({ trigger: 'dream-completed' });
  const snap = await env.snapshot();
  const row = snap.capabilities.find((c) => c.domain === 'integration');
  assert.notEqual(row?.status, 'CAN', '40 天前的成绩不该判 CAN（窗口 7 天）');
});

test('软降级：curriculum 服务不可用时不得抛错', async () => {
  const mod = await import('../lib/index.js');
  const tables = new Map();
  const getTable = (n) => { if (!tables.has(n)) tables.set(n, new Map()); return tables.get(n); };
  const makeTable = (n) => {
    const t = getTable(n);
    return {
      put: async (id, v) => { t.set(id, v); return true; },
      get: (id) => t.get(id) ?? null,
      delete: async () => true,
      entries: () => Array.from(t.entries()),
      size: async () => t.size,
    };
  };
  const services = new Map();
  services.set('agint.evolution', {
    queryFailures: async () => [], queryTemplates: async () => [],
    addFailure: async () => ({}), getLogRange: async () => [], stats: async () => ({}),
  });
  // 故意不提供 agint.curriculum
  services.set('agint.eventBus.publish', async () => ({ accepted: true }));
  services.set('agint.eventBus.subscribe', () => () => {});
  const ctx = {
    storageDomain: {
      open: async () => ({ table: (n) => makeTable(n), close: async () => {} }),
    },
    effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {}; } catch { return () => {}; } },
    get: (k) => services.get(k) ?? null,
    provide: (k, v) => services.set(k, v),
    on: () => () => {},
  };
  mod.apply(ctx, {});
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
  const update = services.get('agint.selfModel.update');
  // 不抛即通过
  const r = await update({ trigger: 'dream-completed' });
  assert.ok(r && r.ok === true, 'curriculum 缺失时应软降级成功');
});

test('protect：不提供 list 时也要能工作（防止实现偷偷用 list）', async () => {
  // buildEnv 只提供 listAttempts，没有 list。
  // 若实现改用 list()，本文件所有用例都会拿到 undefined attempts ⇒ 第一个用例必红。
  const env = await buildEnv({ attempts: PASS_ATTEMPTS });
  await env.update({ trigger: 'dream-completed' });
  const snap = await env.snapshot();
  const row = snap.capabilities.find((c) => c.domain === 'integration');
  assert.equal(row?.status, 'CAN', '只用 listAttempts 就必须能算出 CAN');
});
