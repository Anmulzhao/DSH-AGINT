/**
 * agint-family-panel smoke test.
 *
 * Exercises the host half against a stub context: the route must register,
 * answer a well-formed snapshot, degrade instead of throwing when the roster or
 * a signal source misbehaves, and refuse non-loopback callers. The browser half
 * is checked statically (it is a browser artifact, not a node module).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { apply, name, inject, fiberStateToStatus } from '../lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** Minimal stub loader row. cordis-plugin-loader 的 entry 真实结构：
 *  `options` + `disabled` + `fiber.state`（FiberState 枚举），没有 runtime.status。 */
function row(id, fiberState = 2, disabled = false) {
  return { options: { id, name: `./plugins/${id}/lib/index.js` }, disabled, fiber: { state: fiberState } };
}

/**
 * Build a stub host context.
 *
 * ⛔ 用 Proxy 复刻 cordis 语义：**读未注入的属性会抛**（`cannot get property X
 * without inject`），而不是返回 undefined。v0.1.0 的 apply 写成 `ctx.config`
 * 就是被「普通对象假 ctx 静默返回 undefined」放过去的——本地 11 组全绿，真宿主
 * 直接拒绝加载。假 ctx 必须比真宿主更严格，否则测试是装饰品。
 *
 * 白名单 = manifest 声明的 inject/optionalInject + cordis Context 内建方法。
 * 注意 `config` **不在**白名单：它是 apply 的第二参数，绝不能从 ctx 上读。
 */
const CTX_ALLOWED = new Set([
  'webServer', 'loader', // inject / 本插件实际声明
  'provide', 'get', 'effect', 'on', // cordis Context 内建
  '_registered', '_provided', // 测试侧探针
]);

function makeCtx(overrides = {}) {
  const registered = [];
  const provided = {};
  const entries = overrides.entries ?? [row('agint-memory'), row('agint-cron'), row('agint-preset'), row('agint-ops-preset'), row('agint-mystery'), row('other-plugin')];
  const base = {
    loader: { entries: () => entries },
    webServer: {
      register(route) {
        registered.push(route);
        return () => {};
      },
    },
    provide(key, value) { provided[key] = value; },
    get(service) { return (overrides.services ?? {})[service]; },
    effect() {},
    _registered: registered,
    _provided: provided,
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return undefined;
      if (CTX_ALLOWED.has(prop)) return undefined;
      throw new Error(`cannot get property ${String(prop)} without inject`);
    },
    has(target, prop) {
      return prop in target || CTX_ALLOWED.has(prop);
    },
  });
}

/** Call a registered route handler and capture the response. */
async function callRoute(ctx, { method = 'GET', remoteAddress = '127.0.0.1', path } = {}) {
  const route = ctx._registered.find((r) => r.path === (path ?? '/api/agint-family/status'));
  assert.ok(route, 'status route registered');
  let captured = null;
  const res = {
    writeHead(status, headers) { captured = { status, headers }; },
    end(body) { captured.body = body; },
  };
  await route.handler({ method, socket: { remoteAddress } }, res);
  return captured;
}

// 1. manifest shape ---------------------------------------------------------
assert.equal(name, 'agint-family-panel');
assert.ok(inject.includes('webServer'), 'host half declares webServer');

// 2. package.json dual-face declaration -------------------------------------
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'agint-family-panel');
assert.equal(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform is web');
assert.equal(pkg.exports?.['./client'], './lib/client.js', 'exports ./client');

// 3. browser half is a well-formed module-loader artifact --------------------
const clientSrc = readFileSync(join(root, 'lib/client.js'), 'utf8');
assert.ok(clientSrc.includes('window.__ModuleLoader__.load('), 'uses the module loader');
assert.ok(clientSrc.includes(`id: 'agint-family-panel'`), 'factory id equals the package name');
assert.ok(!/\brequire\(['"]@deepseek-ai\/dsh-client-ui-primitives['"]\)/.test(clientSrc), 'imports no Harness client package');
assert.ok(clientSrc.includes('var(--dsw-alias-'), 'styles through host theme tokens');
assert.ok(clientSrc.includes('var(--dsh-frame-top-clearance'), 'honours the window-chrome clearance');
// 0.2.1：v2 默认内嵌在停靠面板里（iframe 走文档相对路径），v1 名册保留可切换
assert.ok(clientSrc.includes(`const V2_PATH = 'api/agint-family/v2'`), 'v2 路径为文档相对（base-href 纪律）');
assert.match(clientSrc, /h\('iframe'/, 'v2 视图走 iframe 内嵌');
assert.match(clientSrc, /window\.open\(V2_PATH/, '新标签页打开按钮指向 V2_PATH');
assert.match(clientSrc, /切换到 v1 名册/, 'v1/v2 视图切换按钮就位');
// syntax check in a child process (the artifact references window)
execFileSync(process.execPath, ['--check', join(root, 'lib/client.js')], { stdio: 'pipe' });

// 4. route answers a snapshot ------------------------------------------------
const ctx = makeCtx();
apply(ctx, {});
const ok = await callRoute(ctx);
assert.equal(ok.status, 200, 'status 200');
const payload = JSON.parse(ok.body);
assert.equal(payload.ok, true);
assert.equal(payload.enabled, true);
assert.equal(payload.counts.total, 5, 'counts only agint-* rows');
assert.equal(payload.counts.active, 5, 'fiber.state=2 → active（真实 loader 结构）');
assert.equal(payload.counts.unknown, 0, '不再全部 unknown');
assert.ok(payload.groups.some((g) => g.id === 'memory'), 'memory group present');
const presetGroup = payload.groups.find((g) => g.id === 'preset');
assert.ok(presetGroup && presetGroup.label === 'AGENT预设', 'preset group present with label');
assert.equal(presetGroup.members.length, 2, 'preset members present');
assert.equal(presetGroup.members[0].declared, true, 'preset member declared');
// v0.1.4：生产运维子 preset（智进·生产运维）此前落在 unmapped 兜底组。
assert.ok(
  presetGroup.members.some((m) => m.id === 'agint-ops-preset' && m.declared === true),
  'agint-ops-preset 归入 AGENT预设 组且 declared:true',
);
const unmappedGroup = payload.groups.find((g) => g.id === 'unmapped');
assert.ok(unmappedGroup && unmappedGroup.members.length === 1 && unmappedGroup.members[0].id === 'agint-mystery' && unmappedGroup.members[0].declared === false, 'unmapped holds only an agint-* row absent from the label map');
assert.deepEqual(payload.unmappedIds, ['agint-mystery'], 'unmappedIds lists the leftover id');
assert.equal(payload.hostRowCount, 6, 'reports the whole host roster');
assert.equal(payload.signals.length, 3, 'three signal probes');

// 12. fiber state mapping (v0.1.1) --------------------------------------------
assert.equal(fiberStateToStatus(2), 'active');
assert.equal(fiberStateToStatus(3), 'failed');
assert.equal(fiberStateToStatus(0), 'loading');
assert.equal(fiberStateToStatus(1), 'loading');
assert.equal(fiberStateToStatus(4), 'disposed');
assert.equal(fiberStateToStatus(5), 'unloading');
assert.equal(fiberStateToStatus(undefined), 'unknown');
assert.equal(fiberStateToStatus(null), 'unknown');
// counts 只认 active/failed/disabled，其余归 unknown（loading 是瞬态）
const mixedCtx = makeCtx({ entries: [row('agint-a', 2), row('agint-b', 3), row('agint-c', 0), row('agint-d', 2, true)] });
apply(mixedCtx, {});
const mixedPayload = JSON.parse((await callRoute(mixedCtx)).body);
assert.equal(mixedPayload.counts.active, 1, 'a active、d disabled 不计 active');
assert.equal(mixedPayload.counts.failed, 1, 'b failed');
assert.equal(mixedPayload.counts.disabled, 1, 'd disabled');
assert.equal(mixedPayload.counts.unknown, 1, 'c loading → unknown（瞬态归位）');

// 5. non-loopback is refused -------------------------------------------------
const denied = await callRoute(ctx, { remoteAddress: '10.0.0.7' });
assert.equal(denied.status, 403, 'non-loopback refused');

// 6. wrong method is refused -------------------------------------------------
const badMethod = await callRoute(ctx, { method: 'POST' });
assert.equal(badMethod.status, 405, 'POST refused');

// 7. a throwing loader degrades, never crashes -------------------------------
const brokenCtx = makeCtx({ entries: undefined });
brokenCtx.loader = { entries: () => { throw new Error('loader exploded'); } };
apply(brokenCtx, {});
const degraded = await callRoute(brokenCtx);
assert.equal(degraded.status, 200, 'degrades to 200');
const degradedBody = JSON.parse(degraded.body);
assert.ok(degradedBody.rosterError, 'roster failure is reported');
assert.equal(degradedBody.counts.total, 0, 'empty roster, not a fabricated one');

// 8. a missing signal source is reported as unavailable ----------------------
const noSignalsCtx = makeCtx({ services: {} });
apply(noSignalsCtx, {});
const noSignals = JSON.parse((await callRoute(noSignalsCtx)).body);
assert.ok(noSignals.signals.every((s) => s.state === 'unavailable'), 'absent services read unavailable');
assert.ok(noSignals.signals.every((s) => typeof s.reason === 'string' && s.reason.length > 0), 'with a reason');

// 9. a throwing signal source is reported as error ---------------------------
const throwingCtx = makeCtx({
  services: {
    'agint.cron': { list() { throw new Error('cron down'); } },
    'agint.metrics': { summary: () => ({ metrics: [1, 2], meta: { a: 1 } }) },
    'agint.selfModel': { stats: () => ({ count: 7 }) },
  },
});
apply(throwingCtx, {});
const mixed = JSON.parse((await callRoute(throwingCtx)).body);
const cronSignal = mixed.signals.find((s) => s.key === 'cron');
assert.equal(cronSignal.state, 'error', 'throwing probe reads error');
assert.ok(cronSignal.reason.includes('cron down'), 'reason preserved');
assert.equal(mixed.signals.find((s) => s.key === 'metrics').value, 2, 'metrics reduced');
assert.equal(mixed.signals.find((s) => s.key === 'selfModel').value, 7, 'self-model reduced');

// 10. kill-switch keeps the route alive but empty ----------------------------
const offCtx = makeCtx();
apply(offCtx, { enabled: false });
const off = JSON.parse((await callRoute(offCtx)).body);
assert.equal(off.enabled, false, 'reports switched off');
assert.equal(off.counts, undefined, 'no data served while off');

// 11. service face -----------------------------------------------------------
assert.equal(typeof ctx._provided['agint.familyPanel']?.status, 'function', 'provides agint.familyPanel');

// 13. cordis 契约：config 只能来自 apply 第二参数 ------------------------------
// v0.1.0 事故：apply 写成 `ctx.config`，本测试用的普通对象假 ctx 静默返回
// undefined ⇒ 本地全绿、真宿主抛 `cannot get property config without inject`
// ⇒ 面板挂上去了但宿主半没起来（接口 401）。这里先确认陷阱已武装，再确认
// apply 在陷阱之上仍能跑完——两者缺一都说明测试在放水。
const trapCtx = makeCtx();
assert.throws(() => trapCtx.config, /without inject/, '假 ctx 对未注入属性必须抛（陷阱已武装）');
assert.doesNotThrow(() => { apply(trapCtx, { enabled: true }); }, 'apply 不得从 ctx 上读 config');
assert.doesNotThrow(() => { apply(makeCtx(), {}); }, '默认参下 apply 亦不得触碰 ctx.config');

// 14. 终止开关并入家族（v0.1.3）----------------------------------------------
// 照抄实机那一行的真实形状：loader 给 patch 插入行加了 `include:` 前缀，
// name 是 @local/ 包名。判据若写成 id 前缀匹配，这里会当场露馅。
const KILL_ROW = {
  options: { id: 'include:dsh-kill-switch', name: '@local/dsh-kill-switch' },
  disabled: false,
  fiber: { state: 2 },
};
const killCtx = makeCtx({ entries: [KILL_ROW, row('agint-memory'), row('other-plugin')] });
apply(killCtx, {});
const killPayload = JSON.parse((await callRoute(killCtx)).body);
const lifecycle = killPayload.groups.find((g) => g.id === 'host-lifecycle');
assert.ok(lifecycle, '宿主生命周期组存在');
assert.ok(
  lifecycle.members.some((m) => m.id === 'include:dsh-kill-switch' && m.declared === true),
  '终止开关归入宿主生命周期组（loader 的 include: 前缀不影响归族）',
);
assert.equal(killPayload.counts.total, 2, '家族计数 = 终止开关 + agint-memory（增量恰好 1）');
assert.equal(killPayload.hostRowCount, 3, 'host roster 分母含全部三行，归族不改分母');
assert.equal(killPayload.unmappedIds.length, 0, '已被分组表认领，不落未归类');
assert.equal(
  killPayload.groups.find((g) => g.id === 'infra').members.some((m) => m.id === 'agint-restart'),
  false,
  'agint-restart 已从观测与基础设施移出（与终止开关同组，不再重复计数）',
);

// 负样本：前缀相近但不在白名单里的 host 行不得被拖进家族 —— 白名单是精确
// module 名匹配，放宽成前缀就会把别的 bundle 一并吞掉。
for (const [label, id] of [['同前缀的另一个 bundle', 'dsh-twin-preset'], ['白名单名的变体', 'dsh-kill-switch-extra']]) {
  const c = makeCtx({ entries: [row(id), row('agint-memory')] });
  apply(c, {});
  const p = JSON.parse((await callRoute(c)).body);
  assert.equal(p.counts.total, 1, `${label}（${id}）不进家族，只有 agint-memory 算`);
  assert.equal(p.hostRowCount, 2, `${label} 仍计入 host roster`);
}

const restartCtx = makeCtx({ entries: [row('agint-restart'), row('agint-self-model')] });
apply(restartCtx, {});
const restartPayload = JSON.parse((await callRoute(restartCtx)).body);
assert.ok(
  restartPayload.groups.find((g) => g.id === 'host-lifecycle').members.some((m) => m.id === 'agint-restart'),
  'agint-restart 归入宿主生命周期组',
);
assert.equal(
  restartPayload.groups.find((g) => g.id === 'infra').members.some((m) => m.id === 'agint-restart'),
  false,
  '同一行不会同时出现在两组（分组表重复列会导致重复计数）',
);

// ── 15. v2 路由（0.2.0）────────────────────────────────────────────
{
  const { makeStorages } = await import('./fixtures/make-storages.mjs');
  process.env.DSH_HOME = join(here, 'fixtures', 'v2-home');
  makeStorages(process.env.DSH_HOME);
  delete process.env.AGINT_HOME;
  const v2ctx = makeCtx();
  apply(v2ctx, {});
  // 三条路由都注册
  for (const p of ['/api/agint-family/status', '/api/agint-family/v2', '/api/agint-family/v2/data'])
    assert.ok(v2ctx._registered.some((r) => r.path === p), `route ${p} registered`);
  // data 路由：JSON、ok:true、scan/tools/cron/bus 四块就位（fixture 数据）
  const d = await callRoute(v2ctx, { path: '/api/agint-family/v2/data' });
  assert.equal(d.status, 200);
  const body = JSON.parse(d.body);
  assert.equal(body.ok, true);
  assert.equal(body.enabled, true);
  assert.ok(body.scan.hits.length > 0, 'fixture 扫描有命中');
  assert.ok(body.tools.rows.some((r) => r.t === 'alpha_do'), 'fixture tool_stats 进聚合');
  assert.equal(body.cron.count, 2);
  assert.equal(body.bus.total, 3);
  // HTML 路由：text/html + 200
  const h = await callRoute(v2ctx, { path: '/api/agint-family/v2' });
  assert.equal(h.status, 200);
  assert.match(h.headers['content-type'], /text\/html/);
  // 非回环 → 403（两条新路由同守卫）
  for (const p of ['/api/agint-family/v2', '/api/agint-family/v2/data']) {
    const f = await callRoute(v2ctx, { path: p, remoteAddress: '8.8.8.8' });
    assert.equal(f.status, 403, `${p} 非回环 403`);
  }
  // kill-switch：enabled=false → data 不吐家族数据
  const off2 = makeCtx();
  apply(off2, {});
  off2._provided['agint.familyPanel'].setEnabled(false);
  const offBody = JSON.parse((await callRoute(off2, { path: '/api/agint-family/v2/data' })).body);
  assert.equal(offBody.enabled, false);
  assert.equal(offBody.scan, undefined, '关闭时不吐数据');
  // 服务面新增 v2Data 方法
  assert.equal(typeof v2ctx._provided['agint.familyPanel'].v2Data, 'function', 'agint.familyPanel.v2Data 存在');
  delete process.env.DSH_HOME;
}

console.log('agint-family-panel smoke: PASS (15 groups)');
