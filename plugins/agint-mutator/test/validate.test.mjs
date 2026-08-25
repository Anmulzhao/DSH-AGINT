#!/usr/bin/env node
// agint-mutator / validate unit test — `node test/validate.test.mjs` 一行能跑。
// Sprint 8 #4：覆盖 validate 4 条硬约束（原子性 / 可证伪 / 回滚条件 / 必填 + payload 形态）。
// 设计：每条约束 1 happy + 1 fail = 8 用例；外加 1 个集成 happy + 1 个集成"输入不合法 proposal" 全拦截。
// 注：验证失败不抛错，写 findings 表 + 返回 { ok:false, findings:[...] }（设计稿 §二.3 末段）。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from '../lib/index.js';

const { LIMITS } = plugin;

// ── fixtures ────────────────────────────────────────────────────────
const baseValidProposal = {
  id: 'p-base',
  kind: 'PROMPT_MUTATION',
  atomicScope: 'prompt',
  source: 'attribution-driven',
  expectedEffect: 'baseline 通过率 >= 95% 在 7 天',
  rollbackCondition: 'regression -> rollback',
  payload: { promptId: 'sys-prompt', oldText: 'old', newText: 'new', diffStrategy: 'unified_diff' },
  failureId: 'f-base', rootCause: 'PROMPT_DEFICIENCY', status: 'PENDING', preimageHash: 'sha256:abc', createdAt: '2026-08-25T00:00:00.000Z',
};
const clone = (x) => JSON.parse(JSON.stringify(x));

function makeServices(opts = {}) {
  const tables = { proposals: new Map(), commits: new Map(), findings: new Map(), metrics_log: new Map() };
  const services = {};
  plugin.apply({
    storageDomain: { open: async () => ({
      table: (name) => {
        const s = tables[name] || (tables[name] = new Map());
        return {
          entries: () => Array.from(s, ([id, v]) => ({ id, ...v })),
          put: async (id, v) => { s.set(id, v); },
          close: async () => {},
        };
      },
      close: async () => {},
    }) },
    get: (n) => opts.get ? opts.get(n) : null,
    provide: (n, f) => { services[n] = f; },
    effect: () => () => {},
  });
  return { services, tables };
}

// ── Constraint 1 (atomicity)：kind 与 atomicScope 一致 ─────────────────

test('约束1 happy: PROMPT_MUTATION+atomicScope=prompt', async () => {
  const { services } = makeServices();
  const out = await services['agint.mutator.validate']({ proposal: clone(baseValidProposal) });
  assert.equal(out.ok, true);
  assert.deepEqual(out.findings, []);
});

test('约束1 fail: PROMPT_MUTATION+atomicScope=tool（kind 与 atomicScope 不一致）', async () => {
  const { services, tables } = makeServices();
  const bad = clone(baseValidProposal); bad.atomicScope = 'tool'; // kind=PROMPT_MUTATION 不配 tool
  const out = await services['agint.mutator.validate']({ proposal: bad });
  assert.equal(out.ok, false);
  assert.ok(out.findings.length >= 1);
  assert.ok(out.findings.some((f) => /原子性/.test(f.message)));
  // 写 findings 表
  assert.equal(tables.findings.size, 1);
  // proposal 状态未改（PENDING 不变；validate 不写 proposals 表）
  assert.equal(tables.proposals.size, 0);
});

// ── Constraint 2 (falsifiable)：expectedEffect 可被 D-QAF 证伪 ─────────

test('约束2 happy: baseline 通过率 >= 95% 在 7 天', async () => {
  const { services } = makeServices();
  const out = await services['agint.mutator.validate']({ proposal: clone(baseValidProposal) });
  assert.equal(out.ok, true);
});

test('约束2 fail: "prompt 更好"（含主观词但正则不匹配）', async () => {
  const { services, tables } = makeServices();
  const bad = clone(baseValidProposal); bad.expectedEffect = 'prompt 更好';
  const out = await services['agint.mutator.validate']({ proposal: bad });
  assert.equal(out.ok, false);
  assert.ok(out.findings.some((f) => /可证伪/.test(f.message)));
  assert.equal(tables.findings.size, 1);
});

test('约束2 fail: 空字符串 expectedEffect', async () => {
  const { services } = makeServices();
  const bad = clone(baseValidProposal); bad.expectedEffect = '';
  const out = await services['agint.mutator.validate']({ proposal: bad });
  assert.equal(out.ok, false);
  assert.ok(out.findings.some((f) => /可证伪/.test(f.message)));
});

// ── Constraint 3 (rollback)：rollbackCondition 含触发器 (regression|harm|manual) ─

test('约束3 happy: regression -> rollback', async () => {
  const { services } = makeServices();
  const out = await services['agint.mutator.validate']({ proposal: clone(baseValidProposal) });
  assert.equal(out.ok, true);
});

test('约束3 fail: "看效果"（缺触发器）', async () => {
  const { services } = makeServices();
  const bad = clone(baseValidProposal); bad.rollbackCondition = '看效果';
  const out = await services['agint.mutator.validate']({ proposal: bad });
  assert.equal(out.ok, false);
  assert.ok(out.findings.some((f) => /回滚条件/.test(f.message)));
});

test('约束3 fail: 空字符串 rollbackCondition', async () => {
  const { services } = makeServices();
  const bad = clone(baseValidProposal); bad.rollbackCondition = '';
  const out = await services['agint.mutator.validate']({ proposal: bad });
  assert.equal(out.ok, false);
  assert.ok(out.findings.some((f) => /回滚条件/.test(f.message)));
});

// ── Constraint 4 (payload shape)：必填 + FROZEN 类型 ──────────────────

test('约束4 happy: 合法 payload（promptId 匹配正则 + diffStrategy 白名单）', async () => {
  const { services } = makeServices();
  const out = await services['agint.mutator.validate']({ proposal: clone(baseValidProposal) });
  assert.equal(out.ok, true);
});

test('约束4 fail: toolName 空字符串（必填字段校验）', async () => {
  const { services } = makeServices();
  // 切到 TOOL_SYNTHESIS，但 toolName 空
  const bad = {
    id: 'p-4', kind: 'TOOL_SYNTHESIS', atomicScope: 'tool', source: 'attribution-driven',
    expectedEffect: 'tool OK >= 80% within 7 天', rollbackCondition: 'harm >10% rollback',
    payload: { toolName: '', signature: 'sig', stubs: ['x'], intent: 'i' },
    failureId: 'f', rootCause: 'TOOL_GAP', status: 'PENDING', preimageHash: 'sha256:abc', createdAt: '2026-08-25T00:00:00.000Z',
  };
  const out = await services['agint.mutator.validate']({ proposal: bad });
  assert.equal(out.ok, false);
  assert.ok(out.findings.some((f) => /payload/.test(f.message)));
});

test('约束4 fail: strategyPayload newSteps 空数组', async () => {
  const { services } = makeServices();
  const bad = {
    id: 'p-5', kind: 'STRATEGY_REWRITE', atomicScope: 'strategy', source: 'evolution-reversed',
    expectedEffect: 'reorder OK >= 80% within 7 天', rollbackCondition: 'manual rollback after 3 failures',
    payload: { strategyId: 'default-strategy', oldSteps: ['a'], newSteps: [], ordering: 'replace' },
    failureId: 'f', rootCause: 'PLANNING_FAILURE', status: 'PENDING', preimageHash: 'sha256:abc', createdAt: '2026-08-25T00:00:00.000Z',
  };
  const out = await services['agint.mutator.validate']({ proposal: bad });
  assert.equal(out.ok, false);
  assert.ok(out.findings.some((f) => /payload|newSteps/.test(f.message)));
});

test('约束4 fail: promptId 不匹配正则^[a-z][a-z0-9-]{2,30}$', async () => {
  const { services } = makeServices();
  const bad = clone(baseValidProposal);
  bad.payload.promptId = 'X'; // 大写，违规
  const out = await services['agint.mutator.validate']({ proposal: bad });
  assert.equal(out.ok, false);
  assert.ok(out.findings.some((f) => /payload|promptId|正则/.test(f.message)));
});

test('约束4 fail: source 缺（空字符串）', async () => {
  const { services } = makeServices();
  const bad = clone(baseValidProposal); bad.source = '';
  const out = await services['agint.mutator.validate']({ proposal: bad });
  assert.equal(out.ok, false);
  // source 必填归约到约束 4
  assert.ok(out.findings.some((f) => /source/.test(f.message)));
});

// ── 集成：多约束同时违规 → findings 数组含多条，不抛错 ──────────────

test('集成：多约束同时违规 → findings 数组有 ≥2 条，不写 proposals 表', async () => {
  const { services, tables } = makeServices();
  const bad = {
    id: 'p-multi', kind: 'PROMPT_MUTATION', atomicScope: 'tool', // 原子性错
    source: '',                                                    // source 缺
    expectedEffect: 'prompt 更好',                                  // 可证伪错
    rollbackCondition: '看效果',                                    // rollback 缺触发器
    payload: { promptId: 'sys-prompt', oldText: 'a', newText: 'b', diffStrategy: 'unified_diff' },
    failureId: 'f', rootCause: 'PROMPT_DEFICIENCY', status: 'PENDING', preimageHash: 'sha256:abc', createdAt: '2026-08-25T00:00:00.000Z',
  };
  const out = await services['agint.mutator.validate']({ proposal: bad });
  assert.equal(out.ok, false);
  assert.ok(out.findings.length >= 3, `expected ≥3 findings, got ${out.findings.length}`);
  // 同时不抛错（已跑完说明没抛）
  // 不写 proposals 表（validate 不动 status）
  assert.equal(tables.proposals.size, 0);
});

test('集成：4 约束全过 → findings 空数组', async () => {
  const { services, tables } = makeServices();
  const out = await services['agint.mutator.validate']({ proposal: clone(baseValidProposal) });
  assert.equal(out.ok, true);
  assert.deepEqual(out.findings, []);
  // validate 通过不写 findings 表
  assert.equal(tables.findings.size, 0);
});

// ── 边界 case 扩展（设计稿 §2.3 末段 + §3.2 验收 ≥2 fixture）────────────

// 约束1 扩展：TOOL_SYNTHESIS+atomicScope=tool → PASS（与 PROMPT_MUTATION+prompt 对称）
test('C1-2 约束1 happy: TOOL_SYNTHESIS+atomicScope=tool', async () => {
  const { services } = makeServices();
  const good = {
    id: 'p-tool', kind: 'TOOL_SYNTHESIS', atomicScope: 'tool', source: 'attribution-driven',
    expectedEffect: 'tool OK >= 80% within 7 天', rollbackCondition: 'harm >10% rollback',
    payload: { toolName: 'fetch-weather-api', signature: 'sig', stubs: ['x'], intent: 'i' },
    failureId: 'f', rootCause: 'TOOL_GAP', status: 'PENDING', preimageHash: 'sha256:abc', createdAt: '2026-08-25T00:00:00.000Z',
  };
  const out = await services['agint.mutator.validate']({ proposal: good });
  assert.equal(out.ok, true);
});
// 约束1 扩展：STRATEGY_REWRITE+atomicScope=prompt（跨 scope）
test('C1-4 约束1 fail: STRATEGY_REWRITE+atomicScope=prompt（跨 scope 拦截）', async () => {
  const { services } = makeServices();
  const bad = clone(baseValidProposal); bad.kind = 'STRATEGY_REWRITE'; bad.atomicScope = 'prompt';
  const out = await services['agint.mutator.validate']({ proposal: bad });
  assert.equal(out.ok, false);
  assert.ok(out.findings.some((f) => /原子性/.test(f.message)));
});

// 约束2 扩展：多种操作符 PASS（≤, ==, within, <）
test('C2-2 约束2 happy: 多种操作符 ≤/== / within 都 PASS', async () => {
  const { services } = makeServices();
  for (const eff of [
    'metric-X <= 80% within 14 天',
    'counter Y == 42 在 3 天',
    'token < 1000 在 5 天',
  ]) {
    const good = clone(baseValidProposal); good.expectedEffect = eff;
    const out = await services['agint.mutator.validate']({ proposal: good });
    assert.equal(out.ok, true, `expectedEffect="${eff}" 应 PASS`);
  }
});
// 约束2 反例 fixture 2（设计稿 §2.3 末段）
test('C2-4 约束2 fail: "任务更快"（设计稿 §2.3 反例 fixture）', async () => {
  const { services } = makeServices();
  const bad = clone(baseValidProposal); bad.expectedEffect = '任务更快';
  const out = await services['agint.mutator.validate']({ proposal: bad });
  assert.equal(out.ok, false);
  assert.ok(out.findings.some((f) => /可证伪/.test(f.message)));
});

// 约束3 扩展：harm / manual 触发器都 PASS
test('C3-2 约束3 happy: harm / manual 触发器都 PASS', async () => {
  const { services } = makeServices();
  for (const rc of ['harm threshold exceeded', 'manual override', '重大 harm 触发立即 rollback']) {
    const good = clone(baseValidProposal); good.rollbackCondition = rc;
    const out = await services['agint.mutator.validate']({ proposal: good });
    assert.equal(out.ok, true, `rollbackCondition="${rc}" 应 PASS`);
  }
});

// 约束4 扩展：source 不在枚举白名单（MutationSource 3 值）
test('C4-3 约束4 fail: source 不在 MutationSource 枚举 → 拦截', async () => {
  const { services } = makeServices();
  const bad = clone(baseValidProposal); bad.source = 'manual-foo';
  const out = await services['agint.mutator.validate']({ proposal: bad });
  assert.equal(out.ok, false);
  assert.ok(out.findings.some((f) => /source|payload|invalid_option/.test(f.message)));
});
// 约束4 扩展：diffStrategy 不在白名单
test('C4-6 约束4 fail: diffStrategy 不在白名单 → 拦截', async () => {
  const { services } = makeServices();
  const bad = clone(baseValidProposal);
  bad.payload.diffStrategy = 'random-ai';
  const out = await services['agint.mutator.validate']({ proposal: bad });
  assert.equal(out.ok, false);
  assert.ok(out.findings.some((f) => /payload|diffStrategy/.test(f.message)));
});

// 联动：happy path 不改 proposal.status（PENDING 保留）
test('联动：validate happy path 不改 proposal.status（PENDING 保留）', async () => {
  // 用 propose 真造一条 proposal，再 validate
  const tables = { proposals: new Map(), commits: new Map(), findings: new Map(), metrics_log: new Map() };
  const services = {};
  plugin.apply({
    storageDomain: { open: async () => ({ table: (n) => { const s = tables[n] || (tables[n] = new Map()); return { entries: () => Array.from(s, ([id, v]) => ({ id, ...v })), put: async (id, v) => { s.set(id, v); } }; } }) },
    get: (n) => {
      if (n === 'agint.diagnosis') return { queryAnnotations: async () => [], report: async () => ({}) };
      if (n === 'agint.evolution') return { queryFailures: async () => [] };
      return null;
    },
    provide(n, f) { services[n] = f; },
    effect: () => () => {},
  });
  await new Promise((r) => setImmediate(r));
  const proposal = await services['agint.mutator.propose']({
    source: 'attribution-driven', failureId: 'f-validate-status', rootCause: 'PROMPT_DEFICIENCY',
    expectedEffect: 'baseline >= 95% 在 7 天', rollbackCondition: 'regression -> rollback',
    atomicScope: 'prompt', promptPayload: { promptId: 'sys-prompt', oldText: 'a', newText: 'b', diffStrategy: 'unified_diff' },
  });
  const out = await services['agint.mutator.validate']({ proposal });
  assert.equal(out.ok, true);
  assert.equal(tables.proposals.get(proposal.id).status, 'PENDING', 'status 保持 PENDING（validate 不改 status）');
});
