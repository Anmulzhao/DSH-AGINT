/**
 * 上游分区渲染测试（assets/panel-v2.html 的脚本半）。
 *
 * 为什么单独测：这一节最容易犯的错**不是崩**，而是**四种状态长得一样**。
 *   - 本机没启用插件（存储域不存在）
 *   - 启用了但还没跑过（首跑只建基线）
 *   - 跑了，LLM 判读失败（有事实无结论）
 *   - 跑了，没有问题
 * 前三种若都渲染成一张空表，读的人会得出「一切正常」—— 这正是待办节当年踩过的坑。
 * 在真宿主里验要重启 dsh（bundle 层不热更新），这里一条断言就钉住。
 *
 * 替身只做到够用：不实现真实 DOM 树，`closest()` 由用例应答；被测的是渲染分支与文案。
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
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
    },
    _h: {},
    addEventListener(t, fn) { (this._h[t] || (this._h[t] = [])).push(fn); },
    dispatch(t, ev) { return Promise.all((this._h[t] || []).map((fn) => fn(ev))); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    setAttribute() {}, remove() {}, focus() {}, appendChild() {}, prepend() {},
    dispatchEvent() { return true; },
  };
}

function boot(payload) {
  const src = /<script>([\s\S]*)<\/script>/.exec(readFileSync(PAGE, 'utf8'))[1];
  const els = {};
  const idOf = (id) => els[id] || (els[id] = makeEl(id));
  for (const m of readFileSync(PAGE, 'utf8').matchAll(/id="([\w.-]+)"/g)) idOf(m[1]);

  const sandbox = {
    console, URL,
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
    fetch: async () => ({ ok: true, json: async () => payload }),
    Event: class { constructor(t) { this.type = t; } },
    setTimeout: () => 1, clearTimeout: () => {},
  };
  for (const [id, el] of Object.entries(els)) sandbox[id] = el;
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { sandbox, els };
}

/** 最小可用 payload：其它源给空但不报错，测试只关心 upstream 段 */
const basePayload = (upstream) => ({
  ok: true, enabled: true,
  scan: { hits: [], provided: {}, familyDirs: [], units: [] },
  tools: { rows: [], daily: {} },
  cron: { jobs: [] },
  bus: { total: 0, deadletter: 0, topics: [], sources: [], daily: {}, range: [null, null] },
  pending: { queues: [] },
  owners: { hostKeys: [], toolPrefixes: {}, cronJobs: {}, hostTools: [] },
  proposals: { state: 'ok', items: [], counts: { total: 0, byStatus: {}, queueCount: 0, byCategory: {}, byCategoryAll: {}, sources: [], sourceKinds: 0, aging: null } },
  ...(upstream === undefined ? {} : { upstream }),
  // 让 render() 不走进「全空页」分支：至少有一条工具记录
  ...(upstream === undefined ? {} : {}),
});

const digest = (over = {}) => ({
  tag: 'dsh-v0.2.2-alpha.2', targetVersion: '0.2.2-alpha.2', level: 'patch', preStageChange: 'regressed',
  llmStatus: 'judged', verdict: 'risk', confidence: 0.7,
  headline: '引擎下限抬高，本机满足；工具流水线重构与 AGINT 无关',
  factsSummary: '本机 dsh 0.2.1-rc.3；目标 0.2.2-alpha.2（patch）',
  proposalCount: 1,
  impact: { blocking: 1, breaking: 0, elsewhere: 1, additive: 2, unknown: 0 },
  semantic: { blocker: 0, warn: 8, info: 15 },
  host: { from: '0.2.1-rc.3', to: '0.2.2-alpha.2', semanticImpact: 'warn',
    deltas: [{ kind: 'engine-raised', symbol: 'engines.node', severity: 'warn', before: '(unset)', after: '>=24.9.0', note: '本机 node 24.21.0 满足新下限 24.9.0' }] },
  updatedAt: '2026-10-28T12:00:00.000Z',
  ...over,
});

const okUpstream = (over = {}) => ({
  state: 'ok', source: 'storages', observedAt: '2026-10-28T12:00:00.000Z',
  digests: [digest()],
  counts: { digests: 1, judged: 1, failed: 0, blockers: 1, semanticWarn: 8 },
  latest: { tag: 'dsh-v0.2.2-alpha.2', publishedAt: '2026-10-28T02:50:00Z', prerelease: true, entryCount: 116, breakingHits: 7 },
  releases: { total: 1, fetchedAt: '2026-10-28T06:00:00.000Z' },
  baselineOnly: false,
  serviceAvailable: true, serviceReason: null,
  lag: { installed: '0.2.1-rc.3', latestTag: 'dsh-v0.2.2-alpha.2', latestVersion: '0.2.2-alpha.2', behind: true, level: 'patch' },
  calibration: null, stats: null, notes: [],
  ...over,
});

test('缺 upstream 段 ⇒ 明说「取不到」，不显示成「没有上游」', async () => {
  const { els, sandbox } = boot(basePayload(undefined));
  await sandbox.load();
  assert.match(els.upHead.innerHTML, /取不到/);
  assert.equal(els.upBadge.textContent, '—');
});

test('存储域不存在 ⇒ 明说「未启用」并给原因', async () => {
  const { els, sandbox } = boot(basePayload({
    state: 'unavailable', source: 'storages',
    reason: '上游判读存储域不存在（agint_upstream_watch.json 不在 storages/）',
    observedAt: null, digests: [], counts: { digests: 0, judged: 0, failed: 0, blockers: 0, semanticWarn: 0 },
    latest: null, releases: null, baselineOnly: false, calibration: null,
  }));
  await sandbox.load();
  assert.match(els.upHead.innerHTML, /未启用/);
  assert.equal(els.upRows.innerHTML, '', '未启用不渲染空表 —— 空表会被读成「判过没有问题」');
});

test('首跑只建基线 ⇒ 说明这是设计行为，不是故障', async () => {
  const { els, sandbox } = boot(basePayload(okUpstream({
    digests: [], baselineOnly: true,
    counts: { digests: 0, judged: 0, failed: 0, blockers: 0, semanticWarn: 0 },
  })));
  await sandbox.load();
  assert.match(els.upNotes.innerHTML, /已建基线/);
  assert.match(els.upRows.innerHTML, /等频道拉到下一个版本/);
});

test('正常记录：影响/语义/落后 三列分别落位', async () => {
  const { els, sandbox } = boot(basePayload(okUpstream()));
  await sandbox.load();
  const head = els.upHead.innerHTML;
  assert.match(head, /0\.2\.1-rc\.3/, '本机版本要出现');
  assert.match(head, /0\.2\.2-alpha\.2/, '上游最新要出现');
  assert.match(head, /有新版/, '落后判定要显式说出来');
  const rows = els.upRows.innerHTML;
  assert.match(rows, /dsh-v0\.2\.2-alpha\.2/);
  assert.match(rows, /阻断 1/, 'blocking 不能藏进 breaking');
  assert.match(rows, /警示 8/, '语义面警示要单独显示');
  assert.match(rows, /阶段倒退/, 'release 阶段倒退必须标出来（rc→alpha 是版本号在涨、成熟度在退）');
});

test('LLM 失败但有事实 ⇒ 仍列出该行，llm 列显示 failed', async () => {
  const { els, sandbox } = boot(basePayload(okUpstream({
    digests: [digest({ llmStatus: 'failed', verdict: null, headline: null })],
    counts: { digests: 1, judged: 0, failed: 1, blockers: 0, semanticWarn: 8 },
  })));
  await sandbox.load();
  assert.match(els.upRows.innerHTML, /failed/);
  assert.match(els.upRows.innerHTML, /无结论 headline/, '没有结论要说清是没有结论，不是没事');
});

test('运行态不可得（服务未挂载）⇒ 落后列写「不猜」而不是 0', async () => {
  const { els, sandbox } = boot(basePayload(okUpstream({
    serviceAvailable: false, serviceReason: '上游判读器未挂载（agint.upstreamWatch 不可得）', lag: null,
  })));
  await sandbox.load();
  const head = els.upHead.innerHTML;
  assert.match(head, /不猜|不可得/);
  assert.match(els.upNotes.innerHTML, /未挂载/);
});

test('已是最新 ⇒ 「已是最新」，不误报有新版', async () => {
  const { els, sandbox } = boot(basePayload(okUpstream({
    lag: { installed: '0.2.2-alpha.2', latestTag: 'dsh-v0.2.2-alpha.2', latestVersion: '0.2.2-alpha.2', behind: false, level: 'same' },
  })));
  await sandbox.load();
  assert.match(els.upHead.innerHTML, /已是最新/);
  assert.doesNotMatch(els.upHead.innerHTML, /有新版/);
});

// ── v0.3 判读对拍格 ──
test('有对拍样本 ⇒ 显示包数与误报/漏报，漏报触发 alert', async () => {
  const { els, sandbox } = boot(basePayload(okUpstream({
    calibration: { state: 'ok', packagesChecked: 5, counts: { falsePositive: 1, falseNegative: 2, confirmed: 2, unverifiable: 0 }, falsePositiveRate: 0.2, falseNegativeRate: 0.4 },
  })));
  await sandbox.load();
  const head = els.upHead.innerHTML;
  assert.match(head, /判读对拍/);
  assert.match(head, /5 个包/);
  assert.match(head, /误报 1 · 漏报 2/);
  assert.match(head, /alert/, '有误报或漏报时这一格要标出来');
});

test('没有对拍样本 ⇒ 「尚无样本」，不是 0（阴性对照）', async () => {
  const { els, sandbox } = boot(basePayload(okUpstream({
    calibration: { state: 'empty', packagesChecked: 0, counts: { falsePositive: 0, falseNegative: 0, confirmed: 0, unverifiable: 0 } },
  })));
  await sandbox.load();
  const head = els.upHead.innerHTML;
  assert.match(head, /尚无样本/);
  assert.doesNotMatch(head, /误报 0/);
});

test('判过但还没升级 ⇒ 「等升级」，说明是时机未到', async () => {
  const { els, sandbox } = boot(basePayload(okUpstream({
    calibration: { state: 'pending', packagesChecked: 0, pending: 3, counts: { falsePositive: 0, falseNegative: 0, confirmed: 0, unverifiable: 0 } },
  })));
  await sandbox.load();
  assert.match(els.upHead.innerHTML, /等升级/);
  assert.match(els.upHead.innerHTML, /3 个版本/);
});
