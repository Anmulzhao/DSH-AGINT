/**
 * 提案台渲染与审批流程测试（assets/panel-v2.html 的脚本半）。
 *
 * 为什么值得单独测：这一节是**整页唯一能写的地方**。这类代码的错不是「崩了」，
 * 而是「点了一下，界面说成功了，库里什么都没变」，或者「批准被写成 applied」。
 * 在真宿主里验一次要重启 dsh（bundle 层不热更新），在这里一条断言就能钉住。
 *
 * 替身只做到「够用」：不实现真实 DOM 树，`closest()` 由用例按选择器应答。
 * 被测的是**事件处理逻辑**（谁能写、写成什么、失败了说什么），不是浏览器排版。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(HERE, '..', 'assets', 'panel-v2.html');

function makeEl(id) {
  const classes = new Set();
  return {
    id, innerHTML: '', textContent: '', className: '', value: '', disabled: false,
    style: {}, dataset: {},
    classList: {
      toggle: (c, on) => { const next = on === undefined ? !classes.has(c) : on; if (next) classes.add(c); else classes.delete(c); },
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    _h: {},
    addEventListener(t, fn) { (this._h[t] || (this._h[t] = [])).push(fn); },
    dispatch(t, ev) { return Promise.all((this._h[t] || []).map((fn) => fn(ev))); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {}, remove() {}, focus() {}, appendChild() {}, prepend() {},
    dispatchEvent() { return true; },
  };
}

/** 建一个 vm 沙箱，把页面脚本跑起来，返回元素表与 fetch 记录。
 *  opts.timers=true 时才给 setInterval/clearInterval：默认沙箱没有定时器，
 *  用来钉住「离线渲染不因缺定时器整块崩」（2026-10-27 踩过）。
 *  opts.postReply 覆盖决策接口的响应，用来演「入队后追终态」。 */
function bootBoard(payload, opts = {}) {
  const src = /<script>([\s\S]*)<\/script>/.exec(readFileSync(PAGE, 'utf8'))[1];
  const els = {};
  const idOf = (id) => els[id] || (els[id] = makeEl(id));
  // 页面里所有 id 先建出来：脚本直接拿裸标识符当全局元素用（浏览器行为）
  for (const m of readFileSync(PAGE, 'utf8').matchAll(/id="([\w.-]+)"/g)) idOf(m[1]);

  const calls = { get: [], post: [] };
  const timers = { started: [], cleared: [] };
  const postReply = opts.postReply || { ok: true, changed: true, at: '2026-10-23T14:00:00.000Z', previousStatus: 'proposed',
    proposal: { id: 'p1', title: '提案一', status: 'approved' } };

  const sandbox = {
    console,
    URL,
    document: {
      getElementById: (id) => els[id] || null,
      createElement: (tag) => makeEl(`#${tag}`),
      querySelector: () => makeEl('#q'),
      querySelectorAll: () => [],
      addEventListener() {},
      documentElement: { dataset: {} },
      body: { appendChild(el) { if (el && el.id) els[el.id] = el; } },
    },
    location: { href: 'http://127.0.0.1:3080/api/agint-family/v2' },
    fetch: async (url, opts2) => {
      if (opts2 && opts2.method === 'POST') { calls.post.push({ url: String(url), ...opts2 }); return { ok: true, json: async () => postReply }; }
      calls.get.push(String(url));
      return { ok: true, json: async () => payload };
    },
    Event: class { constructor(t) { this.type = t; } },
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
  if (opts.timers) {
    let seq = 0;
    sandbox.setInterval = (fn, ms) => { const id = ++seq; timers.started.push({ id, fn, ms }); return id; };
    sandbox.clearInterval = (id) => { timers.cleared.push(id); };
  }
  for (const [id, el] of Object.entries(els)) sandbox[id] = el;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { sandbox, els, idOf, calls, timers };
}

const proposal = (over = {}) => ({
  id: 'p1', title: '提案一', category: 'plugin', status: 'proposed', source: 'reviews/周复盘.md',
  note: '', createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z',
  ageDays: 43, body: '## 现状问题\n- 队列只进不出\n## 改动方案\n- 补 approved\n## 预期收益\n- 可审批',
  bodyTruncated: false, bodyChars: 60,
  sections: { problem: '- 队列只进不出', plan: '- 补 approved', benefit: '- 可审批', risk: null, links: null },
  sectionMatched: 3, sameSourceCount: 2,
  // 2026-10-27（提案 567dabed）：成立条件字段。默认「没记口径」= 空串，
  // 与 evolve 侧「历史行读成空串、不据此判失效」同口径。
  formulaVersion: '', assumedBy: '', conflictsWith: [], staleSince: '',
  evidence: {
    state: 'ok', reason: null,
    paths: [{ raw: 'plugins/x/lib/index.js', rel: 'plugins/x/lib/index.js', exists: true, mtime: '2026-10-01T00:00:00.000Z', line: null },
            { raw: 'docs/gone.md', rel: 'docs/gone.md', exists: false, mtime: null, line: null }],
    symbols: [{ name: 'persistJobState', found: true, generic: false, where: 'plugins/x/lib/index.js', hits: 1 }],
    summary: { pathTotal: 2, pathChecked: 2, pathExists: 1, symTotal: 1, symFound: 1, symGeneric: 0, unverifiable: 0 },
    hint: { level: 'maybe-done', text: '1 个符号已在引用文件命中 —— 可能已落地，需人工确认' },
  },
  ...over,
});

const payload = (over = {}) => ({
  ok: true, enabled: true,
  scan: { hits: [['agint-x', 'lib/index.js', 1, 'agint.a', 'code']], provided: { 'agint.a': 'agint-x' }, familyDirs: [], units: [] },
  tools: { rows: [{ t: 'evolve_proposals', n: 3, f: 0, last: Date.parse('2026-10-22T00:00:00Z') }], daily: {} },
  cron: { jobs: [] },
  bus: { total: 1, deadletter: 0, topics: [], sources: [], daily: {}, range: [null, null] },
  pending: { queues: [] },
  owners: { hostKeys: [], toolPrefixes: {}, cronJobs: {}, hostTools: [] },
  proposals: {
    state: 'ok', reason: null, source: 'service', observedAt: '2026-10-23T14:00:00.000Z', repoRoot: 'D:/repo',
    items: [
      proposal(),
      proposal({ id: 'p2', title: '提案二', status: 'applied', ageDays: 60, note: '已落地：改了 lib/index.js' }),
      proposal({ id: 'p3', title: '提案三', status: 'approved', ageDays: 1 }),
    ],
    counts: {
      total: 3, byStatus: { proposed: 1, approved: 1, applied: 1 }, queueCount: 1,
      byCategory: { plugin: 1 }, byCategoryAll: { plugin: 3 }, sources: [{ source: 'reviews/周复盘.md', count: 1 }],
      sourceKinds: 1, aging: { oldestDays: 43, medianDays: 43, buckets: { le7: 0, d8to30: 0, gt30: 1 } },
    },
  },
  ...over,
});

/** 点行 / 点按钮的替身：只回答被测代码用到的选择器。 */
const clickTarget = (dataset) => ({
  dataset,
  closest(sel) {
    if (sel === '[data-pact]' && dataset.pact) return this;
    if (sel === 'tr.prow' && dataset.id && (!dataset.pact)) return this;
    return null;
  },
});
const typeReason = (els, id, text) => els.propRows.dispatch('input', {
  target: { dataset: { note: id }, value: text, closest: (s) => (s === 'textarea[data-note]' ? { dataset: { note: id }, value: text } : null) },
});

test('渲染：待批列表出标题、状态、年龄；待批计数进页签徽标', async () => {
  const { sandbox, els } = bootBoard(payload());
  await sandbox.load();
  const html = els.propRows.innerHTML;
  assert.ok(html.includes('提案一'));
  assert.ok(!html.includes('提案二'), '默认只显示待批，已落地的折叠在别的页签');
  assert.ok(html.includes('43d'), '年龄要显示出来（队列腐化的第一信号）');
  assert.equal(els.propBadge.textContent, '1');
  assert.ok(els.propStats.innerHTML.includes('已批准待执行'), '统计条必须区分「已批准」与「已落地」');
});

test('渲染：展开行显示五节与证据栏，缺节明确写「没有这一节」', async () => {
  const { sandbox, els } = bootBoard(payload());
  await sandbox.load();
  await els.propRows.dispatch('click', { target: clickTarget({ id: 'p1' }) });
  const html = els.propRows.innerHTML;
  assert.ok(html.includes('目的 · 解决什么问题'));
  assert.ok(html.includes('队列只进不出'));
  assert.ok(html.includes('风险与边界'), '缺节也要占位');
  assert.ok(html.includes('正文没有这一节'));
  assert.ok(html.includes('证据 · 只报事实，不下判定'));
  assert.ok(html.includes('疑似已落地'), '线索措辞必须带「疑似」');
});

test('渲染：取不到提案数据时说「不可用」，不画成 0 条', async () => {
  const { sandbox, els } = bootBoard(payload({ proposals: { state: 'unavailable', reason: 'agint.evolve 未挂载', items: [], counts: null } }));
  await sandbox.load();
  assert.ok(els.propNotes.innerHTML.includes('不可用'));
  assert.ok(els.propNotes.innerHTML.includes('agint.evolve 未挂载'));
  assert.equal(els.propBadge.textContent, '—');
  assert.equal(els.propStats.innerHTML, '');
});

test('渲染：host 半是旧版（无 proposals 段）要提示重启，不是静默空白', async () => {
  const { sandbox, els } = bootBoard(payload({ proposals: undefined }));
  await sandbox.load();
  assert.ok(els.propNotes.innerHTML.includes('重启 dsh'));
  assert.equal(els.propBadge.textContent, '—');
});

test('审批：拒绝不写理由就拦下，且不发任何请求', async () => {
  const { sandbox, els, calls } = bootBoard(payload());
  await sandbox.load();
  await els.propRows.dispatch('click', { target: clickTarget({ pact: 'ask', id: 'p1', status: 'rejected' }) });
  assert.equal(calls.post.length, 0, '没理由不能发请求');
  assert.ok(els.pToast.innerHTML.includes('必须写理由'));
});

test('审批：有理由时进入确认条，不直接写；确认后才 POST', async () => {
  const { sandbox, els, calls } = bootBoard(payload());
  await sandbox.load();
  await typeReason(els, 'p1', '这条与 10-23 已落地的 X 重复');
  await els.propRows.dispatch('click', { target: clickTarget({ pact: 'ask', id: 'p1', status: 'rejected' }) });
  assert.equal(calls.post.length, 0, '第一步只是出确认条');
  assert.ok(els.propRows.innerHTML.includes('确认写入'));

  await els.propRows.dispatch('click', { target: clickTarget({ pact: 'confirm', id: 'p1' }) });
  assert.equal(calls.post.length, 1);
  const body = JSON.parse(calls.post[0].body);
  assert.equal(body.id, 'p1');
  assert.equal(body.status, 'rejected');
  assert.equal(body.note, '这条与 10-23 已落地的 X 重复');
  assert.equal(calls.post[0].headers['x-agint-panel'], '1', '自定义头是回环外的第二道锁');
});

test('审批：批准写 approved，不写 applied（决定与事实必须分开记）', async () => {
  const { sandbox, els, calls } = bootBoard(payload());
  await sandbox.load();
  await els.propRows.dispatch('click', { target: clickTarget({ pact: 'ask', id: 'p1', status: 'approved' }) });
  await els.propRows.dispatch('click', { target: clickTarget({ pact: 'confirm', id: 'p1' }) });
  assert.equal(JSON.parse(calls.post[0].body).status, 'approved');
  assert.ok(!JSON.parse(calls.post[0].body).status.includes('applied'));
});

test('审批：完成后重取权威数据（不能就地改本地状态冒充成功）', async () => {
  const { sandbox, els, calls } = bootBoard(payload());
  await sandbox.load();
  const before = calls.get.length;
  await els.propRows.dispatch('click', { target: clickTarget({ pact: 'ask', id: 'p1', status: 'approved' }) });
  await els.propRows.dispatch('click', { target: clickTarget({ pact: 'confirm', id: 'p1' }) });
  assert.ok(calls.get.length > before, '写后必须重新拉一次数据');
  assert.ok(els.pToast.innerHTML.includes('已写入'));
});

// ── 2026-10-29：语义闸撤了 ⇒「立即/定时」一律可选，默认立即 ─────────────
//
// 2026-10-27 曾在确认条里把「立即/定时」置灰（autoExecutable=false），并在文案里
// 写「它要的动作是人工复核」。老板裁定撤销：批准即自动执行，跑不动由执行器报原因。
test('审批：autoExecutable=false 也不再置灰，默认立即执行', async () => {
  const p4 = proposal({ id: 'p4', title: '美谕提案：决策确信度 扣 1.7 分', status: 'proposed', autoExecutable: false });
  const pay = payload();
  pay.proposals.items.push(p4);
  const { sandbox, els, calls } = bootBoard(pay);
  await sandbox.load();
  await els.propRows.dispatch('click', { target: clickTarget({ pact: 'ask', id: 'p4', status: 'approved' }) });
  const html = els.propRows.innerHTML;
  assert.ok(!html.includes('不可自动执行'), '这个标签已经不存在了');
  assert.ok(!/value="immediate"[^>]*disabled/.test(html), '「立即自动执行」必须可选');
  assert.ok(!/value="scheduled"[^>]*disabled/.test(html), '「定时自动执行」必须可选');
  assert.ok(/value="immediate"[^>]*selected/.test(html), '默认落在「立即自动执行」');

  await els.propRows.dispatch('click', { target: clickTarget({ pact: 'confirm', id: 'p4' }) });
  const body = JSON.parse(calls.post[0].body);
  assert.equal(body.execMode, 'immediate', '提交时也不许降级成 manual');
});

// ── 2026-10-27：普通提案仍默认「立即自动执行」（不能被误伤）───────────────
test('审批：autoExecutable 缺席 ⇒ 仍默认立即自动执行', async () => {
  const { sandbox, els, calls } = bootBoard(payload());
  await sandbox.load();
  await els.propRows.dispatch('click', { target: clickTarget({ pact: 'ask', id: 'p1', status: 'approved' }) });
  await els.propRows.dispatch('click', { target: clickTarget({ pact: 'confirm', id: 'p1' }) });
  const body = JSON.parse(calls.post[0].body);
  assert.equal(body.execMode, 'immediate', '老提案不能因这次改动集体失去「批准即执行」');
});

test('审批：服务端报错时明确说「状态未变」，不装作成功', async () => {
  const { sandbox, els, calls } = bootBoard(payload());
  sandbox.fetch = async (url, opts) => {
    if (opts && opts.method === 'POST') { calls.post.push({ url: String(url), ...opts }); return { ok: false, status: 503, json: async () => ({ ok: false, error: 'agint.evolve 未挂载 —— 提案写不了' }) }; }
    return { ok: true, json: async () => payload() };
  };
  await sandbox.load();
  await els.propRows.dispatch('click', { target: clickTarget({ pact: 'ask', id: 'p1', status: 'approved' }) });
  await els.propRows.dispatch('click', { target: clickTarget({ pact: 'confirm', id: 'p1' }) });
  assert.ok(els.pToast.innerHTML.includes('写入失败'));
  assert.ok(els.pToast.innerHTML.includes('状态未变'));
});

// ── 2026-10-27：blocker 优先于执行态 ─────────────────────────────────────
//
// 实机 a85ef850「权重真标定」：approved + execMode=immediate + execState=idle
// + 有 blocker。旧标签写「已批准·待入队」，读的人以为再等等就会自己跑 ——
// 而它被前置条件挡着，永远不会入队。待办那边同一份数据写的是「阻塞中」。
test('标签：approved + blocker ⇒ 「已批准·阻塞中」，不许写「待入队」', () => {
  const { sandbox } = bootBoard(payload());
  assert.equal(
    sandbox.plabel({ status: 'approved', execMode: 'immediate', execState: 'idle', blocker: '样本未标注' }),
    '已批准·阻塞中');
  assert.equal(
    sandbox.plabel({ status: 'approved', execMode: 'immediate', execState: 'idle', blocker: '   ' }),
    '已批准·待入队', '空白 blocker 不算阻塞');
  assert.equal(
    sandbox.plabel({ status: 'approved', execMode: 'immediate', execState: 'queued', blocker: '样本未标注' }),
    '已批准·阻塞中', 'blocker 优先于执行态');
  assert.ok(
    sandbox.execText({ status: 'approved', execMode: 'immediate', execState: 'idle', blocker: '样本未标注', unblockCondition: '满 8-12 周' })
      .includes('解锁：满 8-12 周'), '阻塞要写明怎么解锁');
});

// ── 2026-10-27（提案 567dabed）：成立条件已变要看得见 ──────────────────────
//
// a85ef850 在 r2 落地后静默失效，却在台账里挂了 18 天「待批」，期间它和任何一条
// 正常提案长得一模一样。`staleSince` 就是那个「长得一样」的破口。
test('成立条件：staleSince 非空 ⇒ 行上标「口径已变」，并在黄条里计数', async () => {
  const { sandbox, els } = bootBoard(payload({
    proposals: {
      ...payload().proposals,
      items: [
        proposal({ id: 'p-old', title: '旧口径提案', staleSince: 'r2→r4', formulaVersion: 'r2' }),
        proposal({ id: 'p-new', title: '新口径提案', staleSince: '', formulaVersion: 'r4' }),
      ],
    },
  }));
  await sandbox.load();
  const html = els.propRows.innerHTML;
  assert.ok(html.includes('口径已变 r2→r4'), '口径变了的提案必须在行上标出来');
  assert.equal(html.match(/口径已变/g).length, 1, '口径一致的提案不许被标（未知 ≠ 失效）');
  assert.ok(els.propNotes.innerHTML.includes('成立条件已被判尺口径的变更甩在身后'), '黄条要提醒先重新评审');});

test('成立条件：空 staleSince（历史行没记口径）不标黄、不计数', async () => {
  const { sandbox, els } = bootBoard(payload());
  await sandbox.load();
  assert.equal(els.propRows.innerHTML.includes('口径已变'), false);
  assert.equal(els.propNotes.innerHTML.includes('成立条件已被'), false);
});

test('筛选：切到「已落地」页签才显示 applied 行', async () => {
  const { sandbox, els } = bootBoard(payload());
  await sandbox.load();
  await els.propStatus.dispatch('click', { target: { dataset: { pst: 'applied' }, closest: (s) => (s === '[data-pst]' ? { dataset: { pst: 'applied' } } : null) } });
  assert.ok(els.propRows.innerHTML.includes('提案二'));
  assert.ok(!els.propRows.innerHTML.includes('提案一'));
});

// ── 2026-10-27：自动刷新 —— 「已批准·排队中」不许永久钉在屏幕上 ────────────
//
// 事故原貌：submitDecision 写完只 load() 一次，而那一拍 execution 必然还是
// queued（窗口不足 1 秒）⇒ 页面画上「已批准·排队中」；1 秒后转 failed，
// 页面再也不重绘 ⇒ 执行态永久停在入队那一刻。老板看到的就是「我早就让它
// 立即执行了，面板还说在排队」。两件事必须成立：①加载后有轮询表；
// ②入队后追终态，不能等满 15 秒。
test('自动刷新：加载后起 15s 轮询表（否则执行态停在入队那一刻）', async () => {
  const { sandbox, timers } = bootBoard(payload(), { timers: true });
  await sandbox.load();
  assert.equal(timers.started.length, 1, '加载完应注册一个轮询表');
  assert.equal(timers.started[0].ms, 15000, '兜底节奏是 15 秒');
});

test('自动刷新：批准入队后追终态（2 秒一拍，不等 15 秒）', async () => {
  const { sandbox, els, timers } = bootBoard(payload(), {
    timers: true,
    postReply: {
      ok: true, changed: true, at: '2026-10-27T13:00:00.000Z', previousStatus: 'proposed',
      proposal: { id: 'p1', title: '提案一', status: 'approved', execMode: 'immediate', execState: 'queued' },
      execution: { mode: 'immediate', state: 'queued', auto: true, autoExecutable: true },
    },
  });
  await sandbox.load();
  const base = timers.started.length;
  await els.propRows.dispatch('click', { target: clickTarget({ pact: 'ask', id: 'p1', status: 'approved' }) });
  await els.propRows.dispatch('click', { target: clickTarget({ pact: 'confirm', id: 'p1' }) });
  assert.equal(timers.started.length, base + 1, '入队后应多一张追终态的表');
  assert.equal(timers.started[timers.started.length - 1].ms, 2000, '追终态的间隔是 2 秒');
});

test('自动刷新：只批准（manual）不入队，就不该起追终态的表', async () => {
  const { sandbox, els, timers } = bootBoard(payload(), {
    timers: true,
    postReply: {
      ok: true, changed: true, at: '2026-10-27T13:00:00.000Z', previousStatus: 'proposed',
      proposal: { id: 'p1', title: '提案一', status: 'approved', execMode: 'manual', execState: 'idle' },
      execution: { mode: 'manual', state: 'idle', auto: false, autoExecutable: true },
    },
  });
  await sandbox.load();
  const base = timers.started.length;
  await els.propRows.dispatch('click', { target: clickTarget({ pact: 'ask', id: 'p1', status: 'approved' }) });
  await els.propRows.dispatch('click', { target: clickTarget({ pact: 'confirm', id: 'p1' }) });
  assert.equal(timers.started.length, base, '手动批准没有队可追，多起一张表就是空转');
});
