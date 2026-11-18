// agint-evolve 提案 → dsh 原生自动化任务桥（2026-11-17）。
// 钉的是「批准能形成 dsh 任务」与三条不许破的边界：
//   ① 幂等：同提案反复 sync 只建一条；② 开关/软依赖关掉时零副作用；
//   ③ 双触发安全：prompt 明确带提案 id + 幂等护栏，cancel 能删干净。
// 运行：node --test plugins/agint-evolve/test/schedule-bridge.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROPOSAL_TASK_PREFIX, taskTitle, proposalIdFromTitle, executionPrompt,
  buildTiming, buildCreateRequest, createBridge,
} from '../lib/schedule-bridge.js';

const NOW = Date.parse('2026-11-17T10:00:00.000Z');
const rec = (over = {}) => ({ id: 'p-abc', title: '补一个门禁', execMode: 'immediate', ...over });

/** 假 dsh Schedule 服务：内存 catalog + create/edit。 */
function fakeService() {
  const rows = new Map();
  let seq = 0;
  return {
    _rows: rows,
    async catalog() { return [...rows.values()]; },
    async list({ limit = 100 } = {}) { return { items: [...rows.values()].slice(0, limit), total: rows.size }; },
    async create(request) {
      const id = `task-${++seq}`;
      rows.set(id, { id, ...request });
      return { id, title: request.title };
    },
    async edit(req) {
      if (req.action === 'delete') {
        const existed = rows.delete(req.id);
        return { id: req.id, deleted: existed };
      }
      throw new Error('unexpected action');
    },
  };
}

test('title 幂等键稳定且可反解', () => {
  assert.equal(taskTitle('p-1'), `${PROPOSAL_TASK_PREFIX}p-1`);
  assert.equal(proposalIdFromTitle(taskTitle('p-1')), 'p-1');
  assert.equal(proposalIdFromTitle('unrelated task'), null);
  assert.ok(taskTitle('x'.repeat(500)).length <= 120);
});

test('prompt 带提案 id 与幂等/护栏，不让 agent 自由改仓库', () => {
  const p = executionPrompt(rec());
  assert.match(p, /evolve_executions/);
  assert.match(p, /action=run/);
  assert.match(p, /"p-abc"/);
  assert.match(p, /不要自己改仓库文件/);
  assert.match(p, /已落地/);
});

test('timing: immediate → after；manual / scheduled 分支正确', () => {
  assert.deepEqual(buildTiming(rec(), NOW), { ok: true, timing: { kind: 'after', after_seconds: 10 } });
  assert.equal(buildTiming(rec({ execMode: 'manual' }), NOW).ok, false);
  assert.deepEqual(
    buildTiming(rec({ execMode: 'scheduled', execAt: '2026-11-17T12:00:00.000Z' }), NOW),
    { ok: true, timing: { kind: 'at', at: '2026-11-17T12:00:00.000Z' } },
  );
  // 过点定时不建 dsh 任务，交回 executor 补跑。
  assert.equal(buildTiming(rec({ execMode: 'scheduled', execAt: '2026-11-16T00:00:00.000Z' }), NOW).ok, false);
  assert.equal(buildTiming(rec({ execMode: 'scheduled' }), NOW).ok, false);
});

test('buildCreateRequest: new_once target + agint preset + cwd', () => {
  const r = buildCreateRequest(rec(), { nowMs: NOW, cwd: '/repo', agentPreset: 'agint' });
  assert.equal(r.ok, true);
  assert.equal(r.request.target.kind, 'new_once');
  assert.equal(r.request.target.create.agentPreset, 'agint');
  assert.equal(r.request.target.create.cwd, '/repo');
});

test('① 幂等：同提案 sync 两次只建一条 dsh 任务', async () => {
  const s = fakeService();
  const bridge = createBridge({
    getScheduleService: () => s,
    enabled: true,
    createOpts: { nowMs: NOW, cwd: '/repo', agentPreset: 'agint' },
  });
  const a = await bridge.sync(rec());
  const b = await bridge.sync(rec());
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.skipped, true, '第二次应命中 already-scheduled');
  assert.equal(s._rows.size, 1);
});

test('② 开关关闭 / 服务缺席 / create 抛错 —— 全部软降级，不抛不建', async () => {
  const s = fakeService();
  const off = createBridge({ getScheduleService: () => s, enabled: false });
  assert.equal((await off.sync(rec())).skipped, true);
  assert.equal(s._rows.size, 0);

  const missing = createBridge({ getScheduleService: () => null, enabled: true });
  assert.equal((await missing.sync(rec())).skipped, true);

  const boom = createBridge({
    getScheduleService: () => ({ create: async () => { throw new Error('host down'); }, catalog: async () => [] }),
    enabled: true,
  });
  const r = await boom.sync(rec());
  assert.equal(r.ok, false);
  assert.match(r.reason, /host down/);
});

test('③ cancel 删掉幂等键对应的全部任务，且幂等', async () => {
  const s = fakeService();
  const bridge = createBridge({
    getScheduleService: () => s,
    enabled: true,
    createOpts: { nowMs: NOW, cwd: '/repo' },
  });
  await bridge.sync(rec());
  await bridge.sync(rec({ id: 'p-other' }));
  assert.equal(s._rows.size, 2);

  const out = await bridge.cancel('p-abc');
  assert.equal(out.ok, true);
  assert.equal(out.deleted, 1);
  assert.equal(s._rows.size, 1);
  const again = await bridge.cancel('p-abc');
  assert.equal(again.deleted, 0, '重复 cancel 幂等');
});

test('manual 提案 sync 不建任务（soft skipped）', async () => {
  const s = fakeService();
  const bridge = createBridge({ getScheduleService: () => s, enabled: true });
  const r = await bridge.sync(rec({ execMode: 'manual' }));
  assert.equal(r.skipped, true);
  assert.equal(s._rows.size, 0);
});
