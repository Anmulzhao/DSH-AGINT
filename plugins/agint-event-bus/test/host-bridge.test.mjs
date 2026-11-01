/**
 * agint-event-bus — host-bridge 测试（B1，2026-11-02）
 * Run: node --test plugins/agint-event-bus/test/host-bridge.test.mjs
 *
 * 这个文件守的**不是**「桥接发了事件」，而是三条不许破的纪律：
 *   H1 不阻塞宿主：宿主 emit 时同步返回，不 await。
 *   H2 不把异常抛回宿主：publish 失败 / 抛错都必须被吞掉并计数。
 *      —— 这条最要紧：`domain/changed` 处在存储写入路径的尾部，
 *         桥接一抛，某次域写入就失败。这是本项目最不能犯的错。
 *   H3/H4 白名单 + 不带 value：非白名单域不许发，payload 不许夹带整行数据。
 *
 * 阴性对照：把 H2 的 catch 删掉，第 4 条用例必须红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { attachHostBridge, DOMAIN_WHITELIST, HOST_TOPICS } from '../lib/host-bridge.js';

/** 假 ctx：只实现 ctx.on（桥接只需要这一个能力） */
function makeCtx() {
  const handlers = new Map();
  const removed = [];
  return {
    on(evt, fn) {
      handlers.set(evt, fn);
      return () => { handlers.delete(evt); removed.push(evt); };
    },
    emit(evt, ...args) {
      const fn = handlers.get(evt);
      if (!fn) throw new Error(`no listener for ${evt}`);
      return fn(...args);
    },
    has(evt) { return handlers.has(evt); },
    removed,
  };
}

/** 收集 publish 调用的桩；behavior 可指定 resolved / rejected / throw */
function makePublisher(behavior = 'resolve') {
  const calls = [];
  const fn = (input) => {
    calls.push(input);
    if (behavior === 'throw') throw new Error('sync boom');
    if (behavior === 'rejected') return Promise.reject(new Error('async boom'));
    return Promise.resolve({ accepted: true, deliveredTo: ['x'], deadLettered: [] });
  };
  fn.calls = calls;
  return fn;
}

const tick = () => new Promise((r) => setTimeout(r, 10));

test('挂载两个宿主事件监听（domain/changed + workflow/end）', () => {
  const ctx = makeCtx();
  attachHostBridge(ctx, { publish: makePublisher() });
  assert.ok(ctx.has('domain/changed'), '必须订阅 domain/changed');
  assert.ok(ctx.has('workflow/end'), '必须订阅 workflow/end');
});

test('H3 白名单：非白名单域一个事件都不发', () => {
  const ctx = makeCtx();
  const pub = makePublisher();
  const metrics = [];
  attachHostBridge(ctx, { publish: pub, metrics: (k) => metrics.push(k) });
  // agint_metrics / agint_event_bus 是高频域，刻意不进白名单
  for (const domain of ['agint_metrics', 'agint_event_bus', 'agint_input_gateway', 'not_a_domain']) {
    ctx.emit('domain/changed', { domain, table: 't', key: 'k', operation: 'put' });
  }
  assert.equal(pub.calls.length, 0, '非白名单域不得发布 —— 否则总线会被高频写淹掉');
  // ⚠️ 这条断言同样重要：过滤必须留下痕迹。
  // 否则「没订阅上」与「订阅上了但全被过滤」在外部完全同形（都是计数 0、总线无新 topic），
  // 2026-11-02 首次部署后就撞上过这个歧义。
  assert.equal(
    metrics.filter((k) => k === 'eventBus.hostDomainIgnored').length,
    1,
    '被过滤必须留下痕迹（首次一条），但不能每条都写 —— 实测 5.5 次/秒会让 metrics 表每天涨 40 万行',
  );
});

test('被过滤的计数是采样的：首次一条 + 每 100 次一条（防淹没 metrics 表）', () => {
  const ctx = makeCtx();
  const metrics = [];
  attachHostBridge(ctx, { publish: makePublisher(), metrics: (k) => metrics.push(k) });
  for (let i = 0; i < 101; i += 1) {
    ctx.emit('domain/changed', { domain: 'agint_metrics', table: 't', key: 'k', operation: 'put' });
  }
  const n = metrics.filter((k) => k === 'eventBus.hostDomainIgnored').length;
  assert.equal(n, 2, `101 次被过滤应只计 2 条（首次 + 第 100 次），实际 ${n} 条`);
});

test('白名单域：topic / source / payload 形状正确，且 H4 不带 value', async () => {
  const ctx = makeCtx();
  const pub = makePublisher();
  attachHostBridge(ctx, { publish: pub });

  ctx.emit('domain/changed', {
    domain: 'agint_evolve', table: 'proposal', key: 'p-1', operation: 'put',
    value: { huge: 'x'.repeat(5000) }, // 宿主 put 事件会带整行数据
  });
  await tick(); // H1：发布是 detach 的，落点在下一次微/宏任务
  assert.equal(pub.calls.length, 1);
  const input = pub.calls[0];
  assert.equal(input.topic, HOST_TOPICS.DOMAIN_CHANGED);
  assert.equal(input.source, 'agint-event-bus');
  assert.deepEqual(input.payload, {
    hostEvent: 'domain/changed',
    domain: 'agint_evolve',
    table: 'proposal',
    key: 'p-1',
    operation: 'put',
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(input.payload, 'value'),
    false,
    'H4：payload 不得夹带 value（整行数据进 events 表会把单条记录撑爆）',
  );
});

test('workflow/end：payload 带 stopReason，error 截断到 200', async () => {
  const ctx = makeCtx();
  const pub = makePublisher();
  attachHostBridge(ctx, { publish: pub });
  ctx.emit('workflow/end',
    { id: 'wf-1', meta: { name: 'upgrade-check', description: 'd' } },
    { stopReason: 'error', error: 'E'.repeat(1000), agentsStarted: 3 },
  );
  await tick();
  assert.equal(pub.calls.length, 1);
  const p = pub.calls[0].payload;
  assert.equal(p.workflowId, 'wf-1');
  assert.equal(p.name, 'upgrade-check');
  assert.equal(p.stopReason, 'error');
  assert.equal(p.agentsStarted, 3);
  assert.equal(p.error.length, 200, '错误串必须截断，否则长栈会撑大 events 表');
});

test('H2 红线：publish 同步抛错不得冒泡到宿主（域写入不能被桥接带崩）', () => {
  const ctx = makeCtx();
  const metrics = [];
  attachHostBridge(ctx, { publish: makePublisher('throw'), metrics: (k) => metrics.push(k) });
  // 关键断言：这一行不抛。若桥接把异常抛回，宿主的一次域写入就失败了。
  assert.doesNotThrow(() => {
    ctx.emit('domain/changed', { domain: 'agint_evolve', table: 't', key: 'k', operation: 'put' });
  });
});

test('H2 红线：payload 构造阶段抛错（宿主换了契约形状）也不得冒泡', () => {
  // 模拟宿主哪天把 DomainChanged 改成 getter 驱动的形状，或字段类型变成会抛的对象。
  // 这条走的是 listener 体内 try/catch，与上一条（publish 自身抛错）是两条不同路径。
  const ctx = makeCtx();
  const metrics = [];
  attachHostBridge(ctx, { publish: makePublisher(), metrics: (k) => metrics.push(k) });
  assert.doesNotThrow(() => {
    ctx.emit('domain/changed', {
      domain: 'agint_evolve',
      get table() { throw new Error('shape changed'); },
      key: 'k',
      operation: 'put',
    });
  });
  assert.ok(metrics.includes('eventBus.hostBridgeThrow'), '构造失败必须计数，不能静默');
});

test('H2 红线：publish 返回 rejected 时吞掉并计数', async () => {
  const ctx = makeCtx();
  const metrics = [];
  attachHostBridge(ctx, {
    publish: makePublisher('rejected'),
    metrics: (k) => metrics.push(k),
  });
  ctx.emit('domain/changed', { domain: 'agint_evolve', table: 't', key: 'k', operation: 'put' });
  await tick();
  assert.ok(
    metrics.includes('eventBus.hostBridgeFailed'),
    `异步失败必须计数（实际：${JSON.stringify(metrics)}）`,
  );
});

test('H1 不阻塞：宿主 emit 同步返回，不等待 publish 完成', () => {
  const ctx = makeCtx();
  let resolved = false;
  // 永不 resolve 的 publish：若桥接 await 它，emit 会挂住
  attachHostBridge(ctx, { publish: () => new Promise(() => {}) });
  const t0 = Date.now();
  ctx.emit('domain/changed', { domain: 'agint_evolve', table: 't', key: 'k', operation: 'put' });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 50, `emit 必须立刻返回（实际 ${elapsed}ms）`);
  assert.equal(resolved, false);
});

test('dispose 后不再发布（监听被摘掉）', () => {
  const ctx = makeCtx();
  const pub = makePublisher();
  const detach = attachHostBridge(ctx, { publish: pub });
  detach();
  assert.equal(ctx.has('domain/changed'), false, 'dispose 必须摘掉域监听');
  assert.equal(ctx.has('workflow/end'), false, 'dispose 必须摘掉工作流监听');
});

test('ctx 缺 on 能力时安全返回空 dispose（不抛）', () => {
  assert.doesNotThrow(() => {
    const d = attachHostBridge({}, { publish: makePublisher() });
    assert.equal(typeof d, 'function');
    d();
  });
});

test('白名单非空且不含高频域（防有人手滑加进去）', () => {
  assert.ok(DOMAIN_WHITELIST.length > 0);
  for (const hot of ['agint_event_bus', 'agint_metrics', 'agint_input_gateway', 'agint_cron']) {
    assert.equal(
      DOMAIN_WHITELIST.includes(hot),
      false,
      `${hot} 是高频写域，进白名单会把总线淹掉`,
    );
  }
});

test('常量与源码字面量必须一致（门禁扫的是字面量，漂移 = 门禁瞎）', () => {
  // bin/verify-event-topics.mjs 靠 `/topic\s*:\s*['"]…['"]/` 逐行扫源码。
  // 若有人把 publish 里的 topic 改成引用 HOST_TOPICS 常量，那两条主题就对门禁
  // **不可见**了 —— 清单不更新、门禁照样报绿，正是本项目反复被咬的假绿形态。
  const src = readFileSync(new URL('../lib/host-bridge.js', import.meta.url), 'utf8');
  const literals = new Set([...src.matchAll(/topic\s*:\s*'([^']+)'/g)].map((m) => m[1]));
  assert.ok(literals.size >= 2, '至少应扫到两条 topic 字面量');
  for (const [key, value] of Object.entries(HOST_TOPICS)) {
    assert.ok(
      literals.has(value),
      `HOST_TOPICS.${key} = "${value}" 必须同时以 topic: '<字面量>' 出现在源码里`,
    );
  }
});
