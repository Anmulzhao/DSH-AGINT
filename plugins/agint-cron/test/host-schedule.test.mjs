/**
 * host-schedule bridge 测试（行动 #2a，2026-09-28）。
 * 覆盖：宿主模块懒加载、canonicalize 校验、批量 job 校验、catalog 只读镜像、
 * createHostBridge 降级路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadHostSchedule,
  canonicalizeWithHost,
  validateJobSchedules,
  mirrorCatalog,
  createHostBridge,
  _resetHostCache,
} from '../lib/host-schedule.js';

const HOST_OK = {
  canonicalizeCronExpression: (expr) => {
    if (String(expr) === 'bad') throw new Error('invalid cron: bad');
    if (String(expr) === '') throw new Error('invalid cron: empty');
    return String(expr);
  },
};

const JOBS = [
  { id: 'memory-decay', schedule: '30 2 * * 1' },
  { id: 'wiki-lint', schedule: '0 3 * * 0' },
  { id: 'bad-job', schedule: 'bad' },
];

test('loadHostSchedule: 注入 loader 成功 → ok:true + module', async () => {
  _resetHostCache();
  const r = await loadHostSchedule({ __loader: async () => HOST_OK });
  assert.equal(r.ok, true);
  assert.equal(r.module.canonicalizeCronExpression('30 2 * * 1'), '30 2 * * 1');
});

test('loadHostSchedule: loader 抛错 → ok:false + import-failed', async () => {
  _resetHostCache();
  const r = await loadHostSchedule({ __loader: async () => { throw new Error('boom'); } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /import-failed/);
});

test('loadHostSchedule: loader 返回缺 canonicalizeCronExpression → host-module-incomplete', async () => {
  _resetHostCache();
  const r = await loadHostSchedule({ __loader: async () => ({ foo: 1 }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'host-module-incomplete');
});

test('canonicalizeWithHost: host 为 null → host-unavailable（降级不抛）', () => {
  const r = canonicalizeWithHost('30 2 * * 1', null);
  assert.deepEqual(r, { ok: false, reason: 'host-unavailable' });
});

test('canonicalizeWithHost: 宿主抛错 → 返回 error 文本', () => {
  const r = canonicalizeWithHost('bad', HOST_OK);
  assert.equal(r.ok, false);
  assert.match(r.reason, /invalid cron: bad/);
});

test('canonicalizeWithHost: 合法表达式 → ok + 归一化', () => {
  const r = canonicalizeWithHost('30 2 * * 1', HOST_OK);
  assert.deepEqual(r, { ok: true, expression: '30 2 * * 1' });
});

test('validateJobSchedules: 宿主可用 → valid 计数 + invalid 明细', () => {
  const r = validateJobSchedules(JOBS, HOST_OK);
  assert.equal(r.hostAvailable, true);
  assert.equal(r.valid, 2);
  assert.equal(r.invalid.length, 1);
  assert.equal(r.invalid[0].id, 'bad-job');
  assert.match(r.invalid[0].error, /invalid cron/);
});

test('validateJobSchedules: 宿主不可用 → 全部 host-unavailable', () => {
  const r = validateJobSchedules(JOBS, null);
  assert.equal(r.hostAvailable, false);
  assert.equal(r.valid, 0);
  assert.equal(r.invalid.length, 3);
  assert.ok(r.invalid.every((i) => i.error === 'host-unavailable'));
});

test('validateJobSchedules: job spec 不完整 → invalid（id/schedule 缺失）', () => {
  const r = validateJobSchedules([{ id: 'x', schedule: '0 4 * * *' }, { id: 'y' }], HOST_OK);
  assert.equal(r.valid, 1);
  assert.equal(r.invalid[0].id, 'y');
  assert.equal(r.invalid[0].error, 'job spec incomplete');
});

test('mirrorCatalog: 过滤 agint-cron: 前缀条目', async () => {
  const service = {
    catalog: async () => [
      { title: 'agint-cron:memory-decay', id: 's1' },
      { title: 'agint-cron:wiki-lint', id: 's2' },
      { title: 'user-reminder', id: 's3' },
    ],
  };
  const r = await mirrorCatalog(service);
  assert.equal(r.ok, true);
  assert.equal(r.catalogSize, 3);
  assert.equal(r.entries.length, 2);
  assert.deepEqual(r.entries.map((e) => e.title), ['agint-cron:memory-decay', 'agint-cron:wiki-lint']);
});

test('mirrorCatalog: service 不可用 → 降级 ok:false', async () => {
  const r = await mirrorCatalog(null);
  assert.deepEqual(r, { ok: false, reason: 'schedule service unavailable' });
});

test('mirrorCatalog: catalog 抛错 → 降级 ok:false（不抛）', async () => {
  const service = { catalog: async () => { throw new Error('catalog boom'); } };
  const r = await mirrorCatalog(service);
  assert.equal(r.ok, false);
  assert.match(r.reason, /catalog boom/);
});

test('createHostBridge: 服务未接入 → status hostAvailable=false + validateSchedules 全 invalid', async () => {
  _resetHostCache();
  const bridge = createHostBridge({
    getService: () => null,
    jobs: JOBS,
    __loader: async () => { throw new Error('no host'); },
  });
  assert.equal(bridge.status().hostAvailable, false);
  assert.equal(bridge.status().jobs, 3);
  const v = await bridge.validateSchedules();
  assert.equal(v.hostAvailable, false);
  assert.equal(v.invalid.length, 3);
  const m = await bridge.mirrorCatalog();
  assert.equal(m.ok, false);
});

test('createHostBridge: 宿主可用 → validateSchedules 真实接入', async () => {
  _resetHostCache();
  const bridge = createHostBridge({
    getService: () => ({ catalog: async () => [] }),
    jobs: JOBS,
    __loader: async () => HOST_OK,
  });
  const v = await bridge.validateSchedules();
  assert.equal(v.hostAvailable, true);
  assert.equal(v.valid, 2);
  assert.equal(v.invalid[0].id, 'bad-job');
  assert.equal(bridge.status().hostAvailable, true);
});

test('createHostBridge: mirrorCatalog 走 getService 注入的 service', async () => {
  _resetHostCache();
  let serviceCalled = false;
  const bridge = createHostBridge({
    getService: (name) => {
      assert.equal(name, 'schedule');
      return {
        catalog: async () => {
          serviceCalled = true;
          return [{ title: 'agint-cron:memory-decay', id: 's1' }];
        },
      };
    },
    jobs: JOBS,
    __loader: async () => HOST_OK,
  });
  const m = await bridge.mirrorCatalog();
  assert.equal(serviceCalled, true);
  assert.equal(m.ok, true);
  assert.equal(m.entries.length, 1);
});
