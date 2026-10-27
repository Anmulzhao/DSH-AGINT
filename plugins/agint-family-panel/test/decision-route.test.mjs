/**
 * 提案审批写路由测试（lib/index.js 的 POST /api/agint-family/proposal/decision）。
 *
 * 这是全插件**唯一的写入口**，所以这里测的不是「能不能写」，而是「不该写的时侯
 * 有没有守住」。四道门 + 三条数据纪律，逐条钉住：
 *   门：回环 / 自定义头 / 同源 / JSON+体积
 *   纪律：状态白名单（approved ≠ applied）、拒绝必带理由、写入只经 agint.evolve.setStatus
 *
 * ctx 替身沿用 smoke.mjs 的严格代理：未声明的属性一律抛错，不静默给 undefined。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { apply } from '../lib/index.js';

const CTX_ALLOWED = new Set(['webServer', 'provide', 'get', 'effect', 'on', '_registered', '_provided']);

function makeCtx({ evolve = null, loader = null } = {}) {
  const registered = [];
  const provided = {};
  const base = {
    loader: loader ?? { entries: () => [] },
    webServer: { register(route) { registered.push(route); return () => {}; } },
    provide(key, value) { provided[key] = value; },
    get(service) { return service === 'agint.evolve' ? evolve : undefined; },
    effect() {},
    _registered: registered,
    _provided: provided,
  };
  return new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === 'symbol' || CTX_ALLOWED.has(p)) return undefined;
      throw new Error(`cannot get property ${String(p)} without inject`);
    },
    has(t, p) { return p in t || CTX_ALLOWED.has(p); },
  });
}

const PATH = '/api/agint-family/proposal/decision';

/** 造一条假请求：req 是可读流，够 readBody 用。 */
function makeReq({ method = 'POST', body = '', headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const stream = Readable.from(body === '' ? [] : [Buffer.from(body, 'utf8')]);
  stream.method = method;
  stream.headers = { host: '127.0.0.1:3080', ...headers };
  stream.socket = { remoteAddress };
  return stream;
}

function makeRes() {
  const out = { headersSent: null, head: null, body: null };
  return {
    out,
    setHeader(k, v) { out.headersSent = { ...(out.headersSent ?? {}), [k]: v }; },
    writeHead(status, headers) { out.head = { status, headers }; },
    end(body) { out.body = body; },
  };
}

async function call(ctx, reqOpts) {
  const route = ctx._registered.find((r) => r.path === PATH);
  assert.ok(route, '提案写路由必须注册');
  const res = makeRes();
  await route.handler(makeReq(reqOpts), res);
  return { status: res.out.head?.status, headers: res.out.head?.headers, json: res.out.body ? JSON.parse(res.out.body) : null, res };
}

const goodHeaders = { 'content-type': 'application/json', 'x-agint-panel': '1' };
const envelope = (payload) => JSON.stringify(payload);

/** 假 evolve：记录每次 setStatus，可指定已有行。 */
function fakeEvolve(rows = {}) {
  const calls = [];
  const store = { ...rows };
  return {
    calls,
    store,
    listProposals: () => Object.values(store),
    getProposal: (id) => store[id] ?? null,
    setStatus(id, status, note, opts = {}) {
      calls.push({ id, status, note, opts });
      if (!store[id]) return null;
      // 复刻 agint.evolve 的可见副作用：显式给了 execMode 才改计划，
      // 改了非 manual 的计划且状态是 approved ⇒ 进入 queued。
      const patch = { status, note, updatedAt: '2026-10-23T14:00:00.000Z' };
      if (typeof opts.execMode === 'string') {
        patch.execMode = opts.execMode;
        patch.execAt = opts.execMode === 'scheduled' ? (opts.execAt ?? '') : '';
        patch.execState = opts.execMode === 'manual' ? 'idle' : 'queued';
      }
      store[id] = { ...store[id], ...patch };
      return store[id];
    },
  };
}

const row = (over = {}) => ({ id: 'p1', title: '提案一', body: 'b', category: 'plugin', status: 'proposed', source: '', note: '', createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z', ...over });

test('门：非回环一律 403（载荷含路径与失败原因，不对局域网开放）', async () => {
  const ctx = makeCtx({ evolve: fakeEvolve({ p1: row() }) });
  apply(ctx, {});
  const r = await call(ctx, { remoteAddress: '192.168.1.9', headers: goodHeaders, body: envelope({ id: 'p1', status: 'approved' }) });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'loopback-only');
});

test('门：缺自定义头 403；GET 走 405 并给 Allow', async () => {
  const ctx = makeCtx({ evolve: fakeEvolve({ p1: row() }) });
  apply(ctx, {});
  const noHeader = await call(ctx, { headers: { 'content-type': 'application/json' }, body: envelope({ id: 'p1', status: 'approved' }) });
  assert.equal(noHeader.status, 403);
  assert.match(noHeader.json.error, /x-agint-panel/);

  const get = await call(ctx, { method: 'GET', headers: goodHeaders });
  assert.equal(get.status, 405);
  assert.equal(get.res.out.headersSent?.allow ?? get.headers?.allow, 'POST');
});

test('门：跨源 Origin 403（回环上任何网页都能发 POST，这是第二道锁）', async () => {
  const ctx = makeCtx({ evolve: fakeEvolve({ p1: row() }) });
  apply(ctx, {});
  const r = await call(ctx, { headers: { ...goodHeaders, origin: 'http://evil.example' }, body: envelope({ id: 'p1', status: 'approved' }) });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /cross-origin/);
});

test('门：content-type 必须是 JSON；body 超 4KB 走 413', async () => {
  const ctx = makeCtx({ evolve: fakeEvolve({ p1: row() }) });
  apply(ctx, {});
  const wrongType = await call(ctx, { headers: { 'x-agint-panel': '1', 'content-type': 'text/plain' }, body: envelope({ id: 'p1', status: 'approved' }) });
  assert.equal(wrongType.status, 415);

  const big = await call(ctx, { headers: goodHeaders, body: envelope({ id: 'p1', status: 'approved', note: 'x'.repeat(5000) }) });
  assert.equal(big.status, 413);
});

test('纪律：状态白名单 —— 面板不许写 unknown 之类自造状态', async () => {
  const ctx = makeCtx({ evolve: fakeEvolve({ p1: row() }) });
  apply(ctx, {});
  const r = await call(ctx, { headers: goodHeaders, body: envelope({ id: 'p1', status: 'done' }) });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /白名单/);
});

test('纪律：拒绝与 wontfix 服务端强制要求理由（不只靠前端拦）', async () => {
  const ev = fakeEvolve({ p1: row() });
  const ctx = makeCtx({ evolve: ev });
  apply(ctx, {});
  for (const status of ['rejected', 'wontfix', 'applied']) {
    const r = await call(ctx, { headers: goodHeaders, body: envelope({ id: 'p1', status }) });
    assert.equal(r.status, 400, `${status} 无理由必须被拒`);
    assert.match(r.json.error, /必须写|必须写落地证据/);
  }
  assert.equal(ev.calls.length, 0, '被拦下时一次写都不该发生');
});

test('纪律：agint.evolve 未挂载 → 503 并说明原因，不是假装成功', async () => {
  const ctx = makeCtx({ evolve: null });
  apply(ctx, {});
  const r = await call(ctx, { headers: goodHeaders, body: envelope({ id: 'p1', status: 'approved' }) });
  assert.equal(r.status, 503);
  assert.match(r.json.error, /未挂载/);
});

test('纪律：未知 id → 404', async () => {
  const ctx = makeCtx({ evolve: fakeEvolve({}) });
  apply(ctx, {});
  const r = await call(ctx, { headers: goodHeaders, body: envelope({ id: 'nope', status: 'approved' }) });
  assert.equal(r.status, 404);
});

test('写入：批准 → approved，note 留人工审批标记与理由，返回 previousStatus', async () => {
  const ev = fakeEvolve({ p1: row() });
  const ctx = makeCtx({ evolve: ev });
  apply(ctx, {});
  const r = await call(ctx, { headers: goodHeaders, body: envelope({ id: 'p1', status: 'approved', note: '值得做，排下个 sprint' }) });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.changed, true);
  assert.equal(r.json.previousStatus, 'proposed');
  assert.equal(r.json.proposal.status, 'approved');
  assert.equal(ev.calls.length, 1);
  assert.equal(ev.calls[0].status, 'approved');
  assert.match(ev.calls[0].note, /人工审批（家族面板）/);
  assert.match(ev.calls[0].note, /值得做，排下个 sprint/);
});

test('写入：原有 note 是落地证据时不能被冲掉（applied 行的账要留着）', async () => {
  const ev = fakeEvolve({ p1: row({ status: 'applied', note: '已落地：改了 lib/index.js' }) });
  const ctx = makeCtx({ evolve: ev });
  apply(ctx, {});
  await call(ctx, { headers: goodHeaders, body: envelope({ id: 'p1', status: 'proposed', note: '误标，重回待批' }) });
  assert.match(ev.calls[0].note, /已落地：改了 lib\/index\.js/, '原记录必须保留');
  assert.match(ev.calls[0].note, /原记录/);
});

test('写入：目标态与现状相同 → changed:false 且不落库（幂等，不刷 updatedAt）', async () => {
  const ev = fakeEvolve({ p1: row({ status: 'approved' }) });
  const ctx = makeCtx({ evolve: ev });
  apply(ctx, {});
  const r = await call(ctx, { headers: goodHeaders, body: envelope({ id: 'p1', status: 'approved' }) });
  assert.equal(r.status, 200);
  assert.equal(r.json.changed, false);
  assert.equal(ev.calls.length, 0);
});

test('写入：连续改判不会让 note 无限膨胀（上一版是面板记录时替换而非叠加）', async () => {
  const ev = fakeEvolve({ p1: row({ status: 'proposed' }) });
  const ctx = makeCtx({ evolve: ev });
  apply(ctx, {});
  await call(ctx, { headers: goodHeaders, body: envelope({ id: 'p1', status: 'approved', note: '第一次' }) });
  await call(ctx, { headers: goodHeaders, body: envelope({ id: 'p1', status: 'wontfix', note: '第二次' }) });
  const note = ev.calls[1].note;
  assert.ok(note.length < 200, `note 应保持简短，实际 ${note.length}`);
  assert.ok(!note.includes('第一次'), '上一版是面板记录时不该叠进去');
});

test('kill-switch 关闭时写通道同时关闭（不是只关读）', async () => {
  const ev = fakeEvolve({ p1: row() });
  const ctx = makeCtx({ evolve: ev });
  apply(ctx, { enabled: false });
  const r = await call(ctx, { headers: goodHeaders, body: envelope({ id: 'p1', status: 'approved' }) });
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, false);
  assert.equal(ev.calls.length, 0);
});


// ── 2026-10-27：批准即执行（execMode/execAt）────────────────────────────
test('批准带 execMode=immediate ⇒ 计划落库并回执「已入队」（不是又一张工作单）', async () => {
  const ev = fakeEvolve({ p1: row() });
  const ctx = makeCtx({ evolve: ev });
  apply(ctx, {});
  const r = await call(ctx, {
    headers: goodHeaders,
    body: envelope({ id: 'p1', status: 'approved', note: '批', execMode: 'immediate' }),
  });
  assert.equal(r.status, 200);
  assert.equal(ev.calls[0].opts.execMode, 'immediate', '执行方式必须传到 setStatus（入队的唯一出口）');
  assert.equal(r.json.execution.mode, 'immediate');
  assert.equal(r.json.execution.state, 'queued');
  assert.equal(r.json.execution.auto, true, '面板据此告诉人「已经自动在跑」');
});

test('批准带 execMode=scheduled + execAt ⇒ 计划带时刻；缺时刻/非法时刻一律 400', async () => {
  const ev = fakeEvolve({ p1: row() });
  const ctx = makeCtx({ evolve: ev });
  apply(ctx, {});
  const at = new Date(Date.now() + 3600_000).toISOString();
  const ok = await call(ctx, {
    headers: goodHeaders,
    body: envelope({ id: 'p1', status: 'approved', execMode: 'scheduled', execAt: at }),
  });
  assert.equal(ok.status, 200);
  assert.equal(ev.calls[0].opts.execAt, at);

  const missing = await call(ctx, {
    headers: goodHeaders,
    body: envelope({ id: 'p1', status: 'approved', execMode: 'scheduled' }),
  });
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /execAt/);

  const bogus = await call(ctx, {
    headers: goodHeaders,
    body: envelope({ id: 'p1', status: 'approved', execMode: 'scheduled', execAt: '明天早上' }),
  });
  assert.equal(bogus.status, 400);
  assert.equal(ev.calls.length, 1, '被拒的请求一律不许落库');
});

test('execMode 不在白名单 ⇒ 400（别把拼错的模式当成 manual 静默降级）', async () => {
  const ev = fakeEvolve({ p1: row() });
  const ctx = makeCtx({ evolve: ev });
  apply(ctx, {});
  const r = await call(ctx, { headers: goodHeaders, body: envelope({ id: 'p1', status: 'approved', execMode: 'asap' }) });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /execMode/);
  assert.equal(ev.calls.length, 0);
});

test('已批准的提案再批准一次（计划不变）⇒ 幂等短路，不重复入队', async () => {
  const ev = fakeEvolve({ p1: row({ status: 'approved', execMode: 'immediate', execState: 'queued' }) });
  const ctx = makeCtx({ evolve: ev });
  apply(ctx, {});
  const r = await call(ctx, {
    headers: goodHeaders,
    body: envelope({ id: 'p1', status: 'approved', execMode: 'immediate' }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.changed, false);
  assert.equal(ev.calls.length, 0, '重复批准不得再写一次（否则会多排一条执行）');
});

test('拒绝/撤销时顺手把自动执行计划清回 manual（不留「还会跑」的错觉）', async () => {
  const ev = fakeEvolve({ p1: row({ status: 'approved', execMode: 'scheduled', execAt: new Date(Date.now() + 60_000).toISOString(), execState: 'queued' }) });
  const ctx = makeCtx({ evolve: ev });
  apply(ctx, {});
  await call(ctx, { headers: goodHeaders, body: envelope({ id: 'p1', status: 'rejected', note: '不做' }) });
  assert.equal(ev.calls[0].opts.execMode, 'manual', '非批准判定必须清计划，否则队列里还挂着定时');
});

test('setStatus 抛校验错（execAt 在过去等）⇒ 400 而不是 500（是参数问题，不是服务坏了）', async () => {
  const ev = fakeEvolve({ p1: row() });
  ev.setStatus = () => { throw new Error('agint-evolve: execAt 在过去'); };
  const ctx = makeCtx({ evolve: ev });
  apply(ctx, {});
  const r = await call(ctx, { headers: goodHeaders, body: envelope({ id: 'p1', status: 'approved', execMode: 'immediate' }) });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /在过去/);
});


// ── 2026-10-27：不可自动执行的提案 ⇒ 不许排立即/定时（a 的服务端闸）─────
//
// 实机反例：oracle 的「美谕提案」正文自述「永不 auto-apply」，却被默认的
// immediate 排进队列 ⇒ driver 两次各 1 秒失败。这道闸必须在**服务端**，
// 不能只靠前端置灰（前端可以被绕过，工具也能直接调）。
test('autoExecutable=false 的提案排立即执行 ⇒ 400（语义闸，服务端兜底）', async () => {
  const ev = fakeEvolve({ p1: row({ autoExecutable: false }) });
  const ctx = makeCtx({ evolve: ev });
  apply(ctx, {});
  const r = await call(ctx, {
    headers: goodHeaders,
    body: envelope({ id: 'p1', status: 'approved', execMode: 'immediate' }),
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /不可自动执行/);
  assert.equal(ev.calls.length, 0, '被拒的请求一律不许落库');
});

test('autoExecutable=false 的提案排定时执行 ⇒ 同样 400', async () => {
  const ev = fakeEvolve({ p1: row({ autoExecutable: false }) });
  const ctx = makeCtx({ evolve: ev });
  apply(ctx, {});
  const r = await call(ctx, {
    headers: goodHeaders,
    body: envelope({
      id: 'p1', status: 'approved', execMode: 'scheduled',
      execAt: new Date(Date.now() + 3600_000).toISOString(),
    }),
  });
  assert.equal(r.status, 400);
  assert.equal(ev.calls.length, 0);
});

test('autoExecutable=false 的提案「只批准」⇒ 放行（批准本身仍然成立）', async () => {
  const ev = fakeEvolve({ p1: row({ autoExecutable: false }) });
  const ctx = makeCtx({ evolve: ev });
  apply(ctx, {});
  const r = await call(ctx, {
    headers: goodHeaders,
    body: envelope({ id: 'p1', status: 'approved', execMode: 'manual' }),
  });
  assert.equal(r.status, 200);
  assert.equal(ev.calls.length, 1, '只批准必须能写进去 —— 语义闸拦的是「自动执行」，不是「批准」');
});

test('autoExecutable 缺席（老提案）⇒ 仍允许立即执行', async () => {
  const ev = fakeEvolve({ p1: row() });
  const ctx = makeCtx({ evolve: ev });
  apply(ctx, {});
  const r = await call(ctx, {
    headers: goodHeaders,
    body: envelope({ id: 'p1', status: 'approved', execMode: 'immediate' }),
  });
  assert.equal(r.status, 200, '字段缺席 = 可执行（老提案不能因这次改动集体失去自动执行能力）');
});


// ── 2026-10-27：人工可以把一条提案标成「不可自动执行」─────────────────────
//
// 存量提案没有 autoExecutable 字段（默认 true）。人工要能补标 ——
// 否则「这条其实不能自动跑」这件事永远改不了。
test('autoExecutable=false ⇒ 写进 setStatus 的 opts（人工兜底闸）', async () => {
  const ev = fakeEvolve({ p1: row() });
  const ctx = makeCtx({ evolve: ev });
  apply(ctx, {});
  const r = await call(ctx, {
    headers: goodHeaders,
    body: envelope({ id: 'p1', status: 'approved', execMode: 'manual', autoExecutable: false }),
  });
  assert.equal(r.status, 200);
  assert.equal(ev.calls[0].opts.autoExecutable, false, '标记必须传到 setStatus（唯一的写入口）');
});

test('autoExecutable 非布尔 ⇒ 400（不猜：猜错 = 钉死一条能跑的提案）', async () => {
  const ev = fakeEvolve({ p1: row() });
  const ctx = makeCtx({ evolve: ev });
  apply(ctx, {});
  const r = await call(ctx, {
    headers: goodHeaders,
    body: envelope({ id: 'p1', status: 'approved', autoExecutable: 'false' }),
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /autoExecutable/);
  assert.equal(ev.calls.length, 0, '被拒的请求不许落库');
});

test('autoExecutable 缺席 ⇒ 不动原值（冻结语义，与 blocker 一致）', async () => {
  const ev = fakeEvolve({ p1: row({ autoExecutable: false }) });
  const ctx = makeCtx({ evolve: ev });
  apply(ctx, {});
  const r = await call(ctx, {
    headers: goodHeaders,
    body: envelope({ id: 'p1', status: 'approved', execMode: 'manual' }),
  });
  assert.equal(r.status, 200);
  assert.equal(ev.calls[0].opts.autoExecutable, undefined, '没传就不许改 —— 否则补一句理由就把闸打开了');
});
