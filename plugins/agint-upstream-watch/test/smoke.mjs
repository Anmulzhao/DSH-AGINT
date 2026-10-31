/**
 * agint-upstream-watch — apply 冒烟（mock ctx，不碰网络不碰真实存储）。
 *
 * ## 为什么需要这个文件
 *
 * 2026-10-28 首次部署的实况：单测 26 条全绿，真宿主一启动就红 ——
 * `inject` 里漏了 `tools`，宿主访问 `ctx.tools` 直接抛 `cannot get property "tools" without inject`，
 * 整个 apply 失败，日志里只有一行 `1 required plugin did not activate`。
 *
 * 根因是**替身比真宿主宽松**：单测只测纯函数，从来没跑过 `apply()`。
 * 这个文件补的就是那一环 —— 用接近真宿主脾气的 mock（缺 inject 的服务**在访问时抛错**），
 * 保证 apply 与一次 digest 全流程在提交前就跑过。
 *
 * ⛔ mock 的 storageDomain 用内存 Map，不是真 dsh 存储 —— 它验的是**调用形状**对不对
 *    （表名、主键、字段名、有没有 await），不验持久化格式。后者靠真机部署核验。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, name, inject } from '../lib/index.js';
import { defineTool } from './_stub-storage-domain.mjs';

/** 造一个内存 storage domain，形状与 dsh-storage-domain 一致：table().get/put/entries() */
function fakeStorageDomain() {
  const tables = new Map();
  const open = async () => ({
    table(n) {
      if (!tables.has(n)) tables.set(n, new Map());
      const m = tables.get(n);
      return {
        get: (k) => m.get(k),
        put: async (k, v) => { m.set(k, v); },
        entries: () => [...m.entries()],
      };
    },
    close: async () => {},
  });
  return { open, _tables: tables };
}

/**
 * 造 ctx。**关键设计**：访问未 inject 的服务要像真宿主一样抛错。
 * 如果 mock 对什么都返回 undefined，`inject` 漏写这类 bug 永远测不出来。
 */
function fakeCtx({ storageDomain, services = {}, registers = {} }) {
  const injected = new Set(inject);
  const provided = {};
  const tools = [];
  const effects = [];
  const subscribeCalls = [];

  const guard = (key) => {
    if (!injected.has(key)) {
      throw new Error(`cannot get property "${key}" without inject`);
    }
  };

  const ctx = {
    // 直接属性访问：真宿主同样会检查 inject
    get storageDomain() { guard('storageDomain'); return storageDomain; },
    get tools() {
      guard('tools');
      return { register: (t) => { tools.push(t); return () => {}; } };
    },
    /**
     * `timer` 故意做成 guard getter —— 本插件不 inject 它，
     * 用来给「未 inject 的服务访问必须抛」提供一条**真的会抛**的阴性对照。
     * （2026-10-27 agint-executor 就是因为漏写 timer 而整个插件没挂上。）
     */
    get timer() {
      guard('timer');
      return { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0 };
    },
    get(name_) {
      if (name_ === 'agint.eventBus.subscribe') {
        guard('agint.eventBus.subscribe');
        return (spec, handler) => {
          subscribeCalls.push({ spec, handler });
          return () => {};
        };
      }
      return services[name_] ?? null;
    },
    effect(fn) {
      const d = fn();
      effects.push(d);
      return () => {};
    },
    provide(k, v) { provided[k] = v; },
  };

  return { ctx, provided, tools, effects, subscribeCalls, injected };
}

/** 等 ready.then 链跑完（apply 里的订阅注册是异步的） */
const flush = () => new Promise((r) => setTimeout(r, 60));

test('inject 必须声明 tools —— 这是 2026-10-28 首次部署翻车的根因', () => {
  assert.ok(inject.includes('tools'), 'inject 缺 tools 会让 apply 直接抛错');
  assert.ok(inject.includes('storageDomain'));
  assert.ok(inject.includes('agint.eventBus.subscribe'));
});

test('mock 的守卫本身有效（阴性对照：未 inject 的服务访问必须抛）', () => {
  const { ctx } = fakeCtx({ storageDomain: fakeStorageDomain() });
  // agents 不在 inject 里，但走 ctx.get 是软依赖，不抛
  assert.equal(ctx.get('agents'), null);
  // 而直接属性访问未 inject 的服务必须抛
  assert.throws(() => ctx.timer, /without inject/);
});

test('apply 不抛错，且注册了 service / 工具 / 事件订阅', async () => {
  const storage = fakeStorageDomain();
  const { ctx, provided, tools, subscribeCalls } = fakeCtx({ storageDomain: storage });

  assert.doesNotThrow(() => apply(ctx, {}));
  await flush();

  // service
  assert.ok(provided['agint.upstreamWatch'], 'agint.upstreamWatch 未 provide');
  for (const m of ['status', 'digest', 'runNow', 'listDigests', 'calibration', 'backfill']) {
    assert.equal(typeof provided['agint.upstreamWatch'][m], 'function', `service.${m} 缺失`);
  }

  // 工具
  // v0.3 起三个：状态 / 手动判读 / 校准（判读准不准）
  assert.equal(tools.length, 3, `应注册 3 个工具，实际 ${tools.length}`);
  const names = tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ['upstream_calibration', 'upstream_digest', 'upstream_status']);

  // 订阅
  assert.equal(subscribeCalls.length, 1);
  assert.deepEqual(subscribeCalls[0].spec.topics, ['input.signal.external.release-published']);
  assert.equal(subscribeCalls[0].spec.subscriber, name);
});

test('status() 在空库上可用（不能因为没数据就报错）', async () => {
  const { ctx, provided } = fakeCtx({ storageDomain: fakeStorageDomain() });
  apply(ctx, {});
  await flush();
  const s = await provided['agint.upstreamWatch'].status();
  assert.equal(s.plugin, name);
  assert.equal(s.digestCount, 0);
  assert.deepEqual(s.recent, []);
});

test('digest() 在模型不可用时不产提案，且事实照落（事实与结论分离）', async () => {
  const storage = fakeStorageDomain();
  const proposed = [];
  const { ctx, provided } = fakeCtx({
    storageDomain: storage,
    services: {
      // 故意不给 agents / subagents ⇒ 段 2 必失败
      'agint.evolve': {
        propose: async (input) => { proposed.push(input); return { id: 'p1' }; },
      },
    },
  });
  apply(ctx, {});
  await flush();

  const r = await provided['agint.upstreamWatch'].digest('dsh-v0.2.2-alpha.2', {
    body: [
      '<h3 id="cn-x">新增功能</h3>',
      '- 新增某能力',
      '- DSH 的最低 Node.js 版本提高至 24.9',
    ].join('\n'),
    versionTracks: { alpha: '0.2.2-alpha.2' },
    via: 'test',
  });

  assert.equal(r.ok, true, `digest 应成功（段 1 永不失败）：${r.error ?? ''}`);
  const d = r.digest;
  assert.equal(d.llmStatus, 'failed', 'agents 不可用时段 2 必须 failed');
  assert.ok(d.llmReason, 'failed 必须带原因');
  assert.equal(d.verdict, null, '⛔ 失败时不许有结论');
  assert.deepEqual(d.proposalIds, [], '⛔ 失败时不许产提案');
  assert.equal(proposed.length, 0, '⛔ evolve.propose 一次都不该被调用');

  // 事实必须留下来
  assert.ok(d.facts, '失败也必须落事实');
  assert.ok(d.factsSummary.length > 0);
  assert.equal(d.facts.body.breakingHits >= 1, true, 'Node 24.9 那条应命中破坏性关键词');
  assert.equal(d.level, 'patch');
  assert.equal(d.preStageChange, 'regressed');

  // 释放记录也落了
  assert.ok(storage._tables.get('releases')?.has('dsh-v0.2.2-alpha.2'));
});

test('digest() 幂等：已有 judged 记录时直接返回缓存', async () => {
  const storageDomain = fakeStorageDomain();
  const { ctx, provided } = fakeCtx({ storageDomain });
  apply(ctx, {});
  await flush();
  // 预置一条"上次判读成功"的记录。⛔ 不靠"跑一次再跑一次"来造缓存：
  // 离线环境下第一次必然 llmStatus=failed（依赖面 unknown 会触发 LLM），
  // 而 failed 是**刻意不缓存**的（见下一条用例）。靠跑两次造缓存会测成另一件事。
  storageDomain._tables.set('digests', new Map([['dsh-v0.0.9', {
    tag: 'dsh-v0.0.9', targetVersion: '0.0.9', level: 'patch', llmStatus: 'judged',
    verdict: 'no-impact', headline: 'x', factsSummary: '', proposalIds: [],
    createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z',
  }]]));

  const r = await provided['agint.upstreamWatch'].digest('dsh-v0.0.9', { body: 'x', via: 'test' });
  assert.equal(r.cached, true, '已判读过的 tag 应返回缓存');
  assert.equal(r.digest.tag, 'dsh-v0.0.9');
});

test('digest() 的失败结果不进缓存（失败不能被当成"已判读"）', async () => {
  // 离线环境下所有包实测 unknown ⇒ 触发 LLM ⇒ 模型不可用 ⇒ failed。
  // 这条钉的是：failed 不能写进缓存，否则下一次上游真出问题时我们会读到旧失败。
  const { ctx, provided } = fakeCtx({ storageDomain: fakeStorageDomain() });
  apply(ctx, {});
  await flush();
  const body = '<h3 id="cn-x">问题修复</h3>\n- 修了一个小问题';
  const first = await provided['agint.upstreamWatch'].digest('dsh-v0.0.8', { body, via: 'test' });
  assert.equal(first.ok, true);
  assert.equal(first.digest.llmStatus, 'failed', '离线时 LLM 段应当失败（事实照落）');
  const second = await provided['agint.upstreamWatch'].digest('dsh-v0.0.8', { body, via: 'test' });
  assert.equal(second.cached, undefined, '失败结果不该被当缓存返回');
});

test('digest() 缺 tag 时明确失败，不静默', async () => {
  const { ctx, provided } = fakeCtx({ storageDomain: fakeStorageDomain() });
  apply(ctx, {});
  await flush();
  const r = await provided['agint.upstreamWatch'].digest('', { body: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /tag/);
});

test('信号回调用 tag 触发 digest（订阅链真的接上了）', async () => {
  const { ctx, provided, subscribeCalls } = fakeCtx({ storageDomain: fakeStorageDomain() });
  apply(ctx, {});
  await flush();

  const handler = subscribeCalls[0].handler;
  assert.equal(typeof handler, 'function');

  // 不真调 digest 的网络部分：只断言 handler 存在且接受标准 envelope 形状不炸
  await assert.doesNotReject(handler({ topic: 'input.signal.external.release-published', payload: {} }));

  const s = await provided['agint.upstreamWatch'].status();
  assert.equal(s.stats.signaled, 1, '收到信号应计数（即使 payload 没 tag）');
});

// ── 2026-10-28 追加：工具入口必须是 execute ────────────────────────────────
//
// 真 dsh-tools 的 defineTool **只读 options.execute**
// （dsh-tools/lib/index.js:839 `const userExecute = options.execute;`，
//  :869 `return userExecute(args, exec);`），并把结果包成 tool.execute。
// 插件若把入口写成 `handler`：工具**照样注册成功**，名字和 schema 都在工具表里，
// 但真宿主调用时抛 `TypeError: userExecute is not a function`。
//
// ⛔ 本文件原有的冒烟只断言「注册了 2 个工具、名字对」，**从不调用**注册后的工具
//    ⇒ 这类错注册能一路全绿通过（v0.1.0 → v0.3.0 三个版本就是这么上线的）。
//    ⇒ 下面这条测试补的就是「真调一次」。

test('工具入口必须是 execute：真调一次 upstream_status', async () => {
  const { ctx, tools } = fakeCtx({ storageDomain: fakeStorageDomain() });
  apply(ctx, {});
  await flush();

  const statusTool = tools.find((t) => t.name === 'upstream_status');
  assert.ok(statusTool, 'upstream_status 未注册');

  let err = null;
  let value = null;
  try {
    value = await statusTool.execute({});
  } catch (e) {
    err = e;
  }
  // 先把「入口写错」这一类单独判出来：它长得跟别的错不一样
  assert.ok(
    !(err instanceof TypeError && /userExecute is not a function/.test(err.message)),
    `upstream_status 的入口不是 execute（真宿主会抛 userExecute is not a function）：${err?.message ?? ''}`,
  );
  assert.equal(err, null, `upstream_status 调用失败：${err?.message ?? ''}`);
  assert.equal(value.plugin, name, '返回值应符合 output.schema 的 plugin 字段');

  // 真宿主是「先校验 schema、再调 output.render」⇒ 只写 schema 不写 render 的缺陷
  // 晚到这一步才炸（2026-10-28 v0.3.0 的第二个现场）。
  let renderErr = null;
  let rendered = null;
  try {
    rendered = statusTool.output.render({}, value);
  } catch (e) {
    renderErr = e;
  }
  assert.ok(
    !(renderErr instanceof TypeError && /userRender is not a function/.test(renderErr.message)),
    `upstream_status 缺 output.render（真宿主会抛 userRender is not a function）：${renderErr?.message ?? ''}`,
  );
  assert.equal(renderErr, null, `output.render 调用失败：${renderErr?.message ?? ''}`);
  assert.ok(Array.isArray(rendered), 'output.render 应返回内容块数组');
  assert.equal(rendered[0]?.type, 'text', '内容块应有 type=text');
});

test('阴性对照：替身对 handler 版定义必须抛 userExecute is not a function', async () => {
  const bad = defineTool({
    name: 'bad_tool',
    description: '故意把入口写成 handler 的错版本',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} } },
    async handler() { return { ok: true }; },
  });
  // 替身与真宿主同紧 ⇒ 这条断言成立，上面那条才有判据价值
  await assert.rejects(() => bad.execute({}), /userExecute is not a function/);
});

test('阴性对照：替身对缺 output.render 的定义必须抛 userRender is not a function', async () => {
  const noRender = defineTool({
    name: 'no_render_tool',
    description: '故意不写 output.render 的错版本',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: {} } },
    async execute() { return { ok: true }; },
  });
  // ⚠️ 真 dsh-tools 的 render 是**同步**函数（:856 `render(args, value) { return userRender(args, value); }`），
  //    所以这里必须用 assert.throws 而不是 assert.rejects —— 后者只吃 rejected promise，
  //    同步抛出会被判成「测试自己挂了」（这条阴性对照第一版就栽在这）。
  assert.throws(() => noRender.output.render({}, { ok: true }), /userRender is not a function/);
});
