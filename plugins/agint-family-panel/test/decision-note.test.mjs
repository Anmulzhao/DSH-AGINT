/**
 * 面板决策路由的 note 保真（W8-2 · 2026-11-03）。
 *
 * 事故形态（真实复现，不是推测）：
 *   提案 `a85ef850` 的 note 是 `人工审批（家族面板） · 2026-10-27T14:15:04.393Z · wontfix · 原方法…`
 *   —— 一段 300+ 字的**唯一人工证据**（记录了为什么原方法在 r2 后失效、附实测数据）。
 *   一次「改判回 proposed」的写请求（不带 note）之后，它变成了 48 字的
 *   `人工审批（家族面板） · <新时间> · proposed`，**原记录整段消失**。
 *
 * 根因在 `composeDecisionNote`：
 *   ```js
 *   const preserved = keep === '' || keep.startsWith(PANEL_NOTE_MARK) ? '' : ` ｜ 原记录：${keep}`;
 *   ```
 *   设计意图是「上一版已是面板写的就不叠加，免得连续改判让 note 无限膨胀」。
 *   但**面板自己写过的 note 恰恰是最可能含人工判断的那一段** —— 用「前缀相同」
 *   判断「是我写的、可以覆盖」，等于把「谁写的」误当成「有没有价值」。
 *
 *   前缀根本不携带「这条已经没用了」的信息。真正的膨胀保护应该是长度上限
 *   （`DECISION_NOTE_MAX` 已经是 1000），而不是按来源判废。
 *
 * 这一组钉死：
 *   D1 ⛔ 阴性对照：旧判据确实会丢记录（复刻那段三元表达式自证）
 *   D2 上一版是面板写的（带前缀）⇒ 仍然保留
 *   D3 连续改判 5 次 ⇒ 第一份记录一次都不丢
 *   D4 长度上限仍然生效（保留不得变成「无限膨胀」的借口）
 *   D5 上一版为空 ⇒ 不拼空的「原记录：」（不留垃圾前缀）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { apply } from '../lib/index.js';

const CTX_ALLOWED = new Set(['webServer', 'provide', 'get', 'effect', 'on', '_registered', '_provided']);

function makeCtx({ evolve = null } = {}) {
  const registered = [];
  const provided = {};
  const base = {
    loader: { entries: () => [] },
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
      throw new Error(`cannot get property ${String(p)} without proxy`);
    },
    has(t, p) { return p in t || CTX_ALLOWED.has(p); },
  });
}

const PATH = '/api/agint-family/proposal/decision';

function makeReq({ body = '', headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const stream = Readable.from(body === '' ? [] : [Buffer.from(body, 'utf8')]);
  stream.method = 'POST';
  stream.headers = { host: '127.0.0.1:3080', ...headers };
  stream.socket = { remoteAddress };
  return stream;
}

function makeRes() {
  const out = { head: null, body: null };
  return {
    out,
    setHeader() {},
    writeHead(status, headers) { out.head = { status, headers }; },
    end(body) { out.body = body; },
  };
}

async function call(ctx, reqOpts) {
  const route = ctx._registered.find((r) => r.path === PATH);
  assert.ok(route, '提案写路由必须注册');
  const res = makeRes();
  await route.handler(makeReq(reqOpts), res);
  return { status: res.out.head?.status, json: res.out.body ? JSON.parse(res.out.body) : null };
}

const goodHeaders = { 'content-type': 'application/json', 'x-agint-panel': '1' };

function fakeEvolve(rows = {}) {
  const store = { ...rows };
  return {
    store,
    listProposals: () => Object.values(store),
    getProposal: (id) => store[id] ?? null,
    setStatus(id, status, note, opts = {}) {
      if (!store[id]) return null;
      // 复刻 agint.evolve 的冻结语义：note 未传 = 保留现状（v0.19.0 起）
      const nextNote = note === undefined || note === null ? (store[id].note ?? '') : note;
      const patch = { status, note: nextNote, updatedAt: new Date().toISOString() };
      if (typeof opts.execMode === 'string') patch.execMode = opts.execMode;
      store[id] = { ...store[id], ...patch };
      return store[id];
    },
  };
}

const MARK = '人工审批（家族面板）';
/** 一段真实形态的人工证据：带面板前缀，且内容是唯一留痕。 */
const EVIDENCE = `${MARK} · 2026-10-27T14:15:04.393Z · wontfix · 原方法在 r2 后失效：`
  + 'f51d3280 把 Q2 排序改成 ratio(deduction/maxWeight)，权重被约掉。'
  + '实测 36 条样本、随机 500 组权重归因 0 变化；阈值 0.70→0.55 能翻 24/36。';

const row = (over = {}) => ({
  id: 'p1', title: '提案一', body: 'b', category: 'plugin',
  status: 'wontfix', source: '', note: '', createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z',
  ...over,
});

/** 旧判据的复刻：`keep === '' || keep.startsWith(MARK) ? '' : ...` */
function oldPreserved(prevNote) {
  const keep = String(prevNote ?? '').trim();
  return keep === '' || keep.startsWith(MARK) ? '' : ` ｜ 原记录：${keep}`;
}

// ── D1 ⛔ 阴性对照 ────────────────────────────────────────────────────
test('D1 阴性对照：旧判据对「面板自己写过的记录」判空（证明 D2/D3 在测真问题）', () => {
  assert.equal(oldPreserved(EVIDENCE), '',
    '旧判据必须把带前缀的记录判成「不用保留」——这就是 a85ef850 被清空的原因');
  assert.equal(oldPreserved('人工手写的普通理由'), ' ｜ 原记录：人工手写的普通理由',
    '旧判据对无前缀的反而保留 —— 差别只在前缀，与价值无关');
});

// ── D2 带前缀的上一版记录必须保留 ──────────────────────────────────
test('D2 上一版是面板写的（带前缀）⇒ 改判后原记录仍在新 note 里', async () => {
  const evolve = fakeEvolve({ p1: row({ note: EVIDENCE }) });
  const ctx = makeCtx({ evolve });
  apply(ctx, { root: '/tmp/unused-notes' });

  const out = await call(ctx, {
    headers: goodHeaders,
    body: JSON.stringify({ id: 'p1', status: 'proposed', note: '重新评审' }),
  });
  assert.equal(out.status, 200);
  assert.equal(out.json.ok, true);
  const note = out.json.proposal.note;
  assert.ok(note.includes(EVIDENCE),
    `⛔ 原记录必须完整保留。实际 note：${note}`);
  assert.ok(note.includes('proposed'), '新抬头要在');
});

// ── D3 连续改判不丢记录 ─────────────────────────────────────────────
test('D3 连续改判 5 次 ⇒ 第一份证据一次都不丢', async () => {
  const evolve = fakeEvolve({ p1: row({ note: EVIDENCE }) });
  const ctx = makeCtx({ evolve });
  apply(ctx, { root: '/tmp/unused-notes-d3' });

  const flow = ['proposed', 'approved', 'wontfix', 'proposed', 'wontfix'];
  let i = 0;
  for (const status of flow) {
    i += 1;
    const out = await call(ctx, {
      headers: goodHeaders,
      body: JSON.stringify({ id: 'p1', status, note: `第 ${i} 次改判` }),
    });
    assert.equal(out.status, 200, `改判到 ${status} 失败：${JSON.stringify(out.json)}`);
    assert.ok(out.json.proposal.note.includes('f51d3280'),
      `改判到 ${status} 之后原证据丢了：${out.json.proposal.note.slice(0, 120)}`);
  }
});

// ── D4 长度上限仍然生效 ────────────────────────────────────────────
test('D4 保留旧记录不得突破长度上限（膨胀保护换个正确的实现）', async () => {
  const huge = `${MARK} · 2026-10-01T00:00:00.000Z · wontfix · ${'证'.repeat(2000)}`;
  const evolve = fakeEvolve({ p1: row({ note: huge }) });
  const ctx = makeCtx({ evolve });
  apply(ctx, { root: '/tmp/unused-notes-d4' });

  const out = await call(ctx, {
    headers: goodHeaders,
    body: JSON.stringify({ id: 'p1', status: 'proposed', note: 'xx' }),
  });
  assert.equal(out.status, 200);
  const note = out.json.proposal.note;
  assert.ok(note.length <= 1001, `note 超上限：${note.length} 字`);
  assert.ok(note.endsWith('…'), '截断要有明确标记，不能悄悄切');
});

// ── D5 上一版为空不拼垃圾前缀 ──────────────────────────────────────
test('D5 上一版 note 为空 ⇒ 不出现空的「原记录：」', async () => {
  const evolve = fakeEvolve({ p1: row({ note: '' }) });
  const ctx = makeCtx({ evolve });
  apply(ctx, { root: '/tmp/unused-notes-d5' });

  const out = await call(ctx, {
    headers: goodHeaders,
    body: JSON.stringify({ id: 'p1', status: 'proposed', note: '首次批准' }),
  });
  const note = out.json.proposal.note;
  assert.ok(!note.includes('原记录：'), `空记录不该拼前缀，实际：${note}`);
});
