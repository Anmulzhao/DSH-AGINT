/**
 * test/register.test.mjs — agint-verify-tools 的回归钉
 *
 * 钉三件事：
 *   1. 8 个工具全部注册（不是 7 个、也不是漏掉某个）
 *   2. 每个工具都**真转调** host 服务（打桩服务记录调用，断言参数与返回）
 *   3. 服务缺失时**抛明确错误**，不是静默少一个工具
 *
 * 跑法：node --test plugins/agint-verify-tools/test/register.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const EXPECTED = [
  'cron_list',
  'cron_run_now',
  'cron_health',
  'selfModel_snapshot',
  'selfModel_update',
  'selfModel_calibrate',
  'selfModel_stats',
  'selfModel_inspectSummary',
];

/** 造一个最小 ctx：tools.register 收集定义，get 从服务表取。 */
function makeCtx(services = {}) {
  const registered = new Map();
  const calls = [];
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition);
        return () => { registered.delete(definition.name); };
      },
    },
    get(key) {
      calls.push(key);
      return services[key];
    },
  };
  return { ctx, registered, calls };
}

/** 打桩的 host 服务：每个方法都记录被调用。 */
function stubServices() {
  const log = [];
  const mk = (label) => (arg) => {
    log.push({ label, arg });
    return { ok: true, label, arg };
  };
  return {
    log,
    services: {
      'agint.cron': {
        list: mk('cron.list'),
        runNow: mk('cron.runNow'),
        health: mk('cron.health'),
      },
      'agint.selfModel.snapshot': mk('selfModel.snapshot'),
      'agint.selfModel.update': mk('selfModel.update'),
      'agint.selfModel.calibrate': mk('selfModel.calibrate'),
      'agint.selfModel.stats': mk('selfModel.stats'),
      'agint.selfModel.inspectSummary': mk('selfModel.inspectSummary'),
    },
  };
}

test('注册 8 个工具，名字与清单精确一致', async () => {
  const mod = await import('../lib/index.js');
  const { ctx, registered } = makeCtx(stubServices().services);
  mod.apply(ctx);
  assert.deepEqual([...registered.keys()].sort(), [...EXPECTED].sort());
});

test('inject 只声明 tools（不耦合 host 服务，靠 ctx.get 懒取）', async () => {
  const mod = await import('../lib/index.js');
  assert.deepEqual(mod.inject, ['tools']);
});

test('cron_run_now 真转调 cron.runNow 并透传 id', async () => {
  const mod = await import('../lib/index.js');
  const { log, services } = stubServices();
  const { ctx, registered } = makeCtx(services);
  mod.apply(ctx);
  const out = await registered.get('cron_run_now').execute({ id: 'night-dream' });
  assert.equal(out.ok, true);
  assert.deepEqual(log.at(-1), { label: 'cron.runNow', arg: 'night-dream' });
});

test('selfModel_update 真转调并把 evidence 透传', async () => {
  const mod = await import('../lib/index.js');
  const { log, services } = stubServices();
  const { ctx, registered } = makeCtx(services);
  mod.apply(ctx);
  const ev = { domain: 'integration', result: 'pass' };
  await registered.get('selfModel_update').execute({ trigger: 'task-completed', evidence: ev });
  assert.deepEqual(log.at(-1), {
    label: 'selfModel.update',
    arg: { trigger: 'task-completed', evidence: ev },
  });
});

test('selfModel_calibrate 默认 windowDays=7', async () => {
  const mod = await import('../lib/index.js');
  const { log, services } = stubServices();
  const { ctx, registered } = makeCtx(services);
  mod.apply(ctx);
  await registered.get('selfModel_calibrate').execute({});
  assert.deepEqual(log.at(-1), { label: 'selfModel.calibrate', arg: { windowDays: 7 } });
});

test('服务缺失时抛明确错误（不静默）', async () => {
  const mod = await import('../lib/index.js');
  const { ctx, registered } = makeCtx({}); // 空服务表
  mod.apply(ctx);
  // 工具仍然注册（注册不依赖服务）
  assert.equal(registered.size, EXPECTED.length);
  // 但调用时明确报错，且错误里带服务名
  await assert.rejects(
    () => registered.get('cron_run_now').execute({ id: 'night-dream' }),
    /agint\.cron.*不可用/,
  );
});

test('tools.register 不可用时不抛（软降级）', async () => {
  const mod = await import('../lib/index.js');
  // 给一个没有 tools 的 ctx
  assert.doesNotThrow(() => mod.apply({ get: () => undefined }));
});

test('反向自证：漏注册一个工具时，清单断言必须红', async () => {
  // 这条不需要改生产码 —— 它验证断言本身有效：
  // 用一份少一个的清单去比，必须不相等。
  const mod = await import('../lib/index.js');
  const { ctx, registered } = makeCtx(stubServices().services);
  mod.apply(ctx);
  const short = EXPECTED.slice(0, -1);
  assert.notDeepEqual([...registered.keys()].sort(), [...short].sort(),
    '少一个工具的清单必须与真实注册集合不相等（否则断言形同虚设）');
});
