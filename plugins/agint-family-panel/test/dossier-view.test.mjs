/**
 * 档案页渲染测试（lib/client.js 的 DossierView）。
 *
 * 为什么值得单独测：档案页的错误几乎都不是「崩了」，而是**少了一节、字段读错、
 * 把「取不到」画成 0**。这些在真宿主里要重启才能发现，在这里一条断言就能钉住。
 *
 * 判据来源都是本轮真实踩到的：
 *  1. `permissions.shell: []` 是空数组（truthy），曾把每个插件都标成「能起子进程」。
 *  2. 基础设施插件入边有 26 个，全展开会把一页拉成三页 → 前 8 条 + 折叠。
 *  3. 「仅注释」与「伞键」两条命中曾被塞进「提供方」列，语义错位。
 *  4. 无 manifest 的插件必须显式说「契约不可得」，不能给空数组冒充「什么都不依赖」。
 *  5. 「这一行在注释里」曾被直接当成文档腐化 —— 2026-10-22 实测 agint-mutator 两条
 *     解释伞键历史的注释（lib/index.js:1122 / 1189）被报成腐化候选，而它 1193 行
 *     provide、driver:557 行 dep 取用。腐化判据必须同时看「无提供方 + 无代码取用」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserHalf, treeText, findByTag } from './helpers/browser-half.mjs';
import { collectDossiers } from '../lib/v2-dossier.js';
import { ownersPayload } from '../lib/v2-owners.js';
import { makeDossierFixture } from './fixtures/dossier/make-fixture.mjs';

const mod = loadBrowserHalf();
const T = mod.__test__;
assert.ok(T, '浏览器半必须导出 __test__（档案渲染面）');

const pluginsDir = makeDossierFixture();
const dossiers = collectDossiers({ pluginsDir, repoPluginsDir: null }, { kinds: {}, mounted: new Set(['agint-normal']) });

/** 合成 payload：hits/provided/tools/cron/bus 都按 v2 的真实形状。 */
function makePayload(extraHits = []) {
  const hits = [
    ['agint-normal', 'lib/index.js', 2, 'agint.b', 'code'],
    ['agint-normal', 'lib/index.js', 4, 'agint.a', 'comment'],
    ['agint-shell', 'lib/index.js', 3, 'agint.a', 'code'],
    ...extraHits,
  ];
  return {
    ok: true,
    generatedAt: '2026-10-22T02:00:00.000Z',
    scan: { hits, provided: { 'agint.a': 'agint-normal', 'agint.b': 'agint-other' } },
    tools: { rows: [{ t: 'cron_run_now', n: 10, f: 1, last: Date.parse('2026-10-22T01:00:00Z') }], daily: { cron_run_now: [1, 2, 3, 4, 0, 0, 0] } },
    cron: { jobs: [{ j: 'oracle-daily', last: '2026-10-22T01:00:00Z', res: 'ok' }] },
    bus: { sources: [['agint-cron', 5]], daily: { 'agint-cron': [0, 0, 1, 1, 1, 1, 1] } },
    owners: ownersPayload(),
    dossiers,
  };
}

const render = (id, payload, over = {}) => treeText(T.DossierView({
  id, index: T.buildDossierIndex(payload), member: { id, status: 'active' },
  loading: false, error: null, onBack() {}, onOpen() {}, onRefresh() {}, ...over,
}));

test('正常插件：六节齐全，契约/自述/接线/产出/债/变更史都在', () => {
  const text = render('agint-normal', makePayload());
  for (const section of ['契约 · 它向外承诺什么', '接线 · 它与谁相连', '产出 · 它干了什么', '债 · 它与事实不符的地方', '变更史', '身份明细']) {
    assert.ok(text.includes(section), `缺分区：${section}`);
  }
  assert.ok(text.includes('服务 A 的自述'), '服务自述来自 manifest.docs.serviceDocs');
  assert.ok(text.includes('agint_a'), '存储域要显示');
  assert.ok(text.includes('0.2.0'));
});

test('空数组 shell 判成「否」，不得谎报能起子进程', () => {
  const text = render('agint-normal', makePayload());
  assert.ok(text.includes('权限 · shell否'), '空数组必须判否');
  assert.ok(!text.includes('能起子进程'), '不该出现误报文案');
});

test('无 manifest：契约显式不可得，并说明只剩身份与代码', () => {
  const text = render('agint-pkg-only', makePayload());
  assert.ok(text.includes('契约 · 它向外承诺什么不可得'));
  assert.ok(text.includes('只有 package.json'));
  assert.ok(!text.includes('不提供任何服务'), '不能把「没有契约」画成「不提供服务」');
});

test('无身份：说清既无 manifest 也无 package', () => {
  const text = render('agint-code-only', makePayload());
  assert.ok(text.includes('既无 manifest.json 也无 package.json'));
});

test('入边超过 8 个时前 8 条常显，其余进折叠且数量写全', () => {
  const extra = Array.from({ length: 12 }, (_, i) => [`agint-c${String(i).padStart(2, '0')}`, 'lib/x.js', i + 1, 'agint.a', 'code']);
  const text = render('agint-normal', makePayload(extra));
  // 已有 1 个真实消费者（agint-shell）+ 12 个合成 = 13
  assert.ok(text.includes('展开其余 5 个（共 13 个依赖它的插件）'), text.slice(0, 0) || '折叠行没写对');
  assert.ok(text.includes('依赖它的插件'));
});

test('仅注释与伞键命中不冒充提供方', () => {
  const payload = makePayload();
  payload.scan.hits.push(['agint-normal', 'lib/index.js', 9, 'agint.zzz', 'umbrella']);
  const text = render('agint-normal', payload);
  assert.ok(text.includes('—（仅注释）'));
  assert.ok(text.includes('—（伞键不可达）'));
});

test('声明了但代码里没取的服务要报出来（声明与代码对差）', () => {
  const text = render('agint-normal', makePayload());
  assert.ok(text.includes('声明了但代码里没取：agint.neverUsed'));
});

test('档案没采集到的 id：说清是目录没扫到，不是空档案', () => {
  const text = render('agint-does-not-exist', makePayload());
  assert.ok(text.includes('目录里没有这个插件'));
});

test('取数失败：给原因 + 需要重启的提示，不显示空表', () => {
  const text = render('agint-normal', makePayload(), { error: '宿主半不可达（档案数据端点未挂载）' });
  assert.ok(text.includes('读不到档案'));
  assert.ok(text.includes('需要重启 dsh'));
});

test('派生：工具/cron/bus 按归因表落到位，7 天曲线求和正确', () => {
  const index = T.buildDossierIndex(makePayload());
  const a = index.activityOf('agint-cron');
  assert.equal(a.n, 10);
  assert.equal(a.f, 1);
  assert.equal(a.bus, 5);
  // cron 归属走显式表：oracle-daily 归 aesthetic-oracle，不是 cron 插件
  assert.equal(a.jobs.length, 0, 'cron_run_now 是工具，不是 cron 任务');
  assert.equal(index.activityOf('agint-aesthetic-oracle').jobs.length, 1);
  assert.equal(a.daily.reduce((s, v) => s + v, 0), 15, '工具 10 + bus 5');
  // 没有归因的插件必须是 0 而不是崩溃
  const none = index.activityOf('agint-does-not-exist');
  assert.equal(none.n, 0);
});

test('首句截断到第一个句号，不把第二句拖进来', () => {
  assert.equal(T.firstSentence('第一句。第二句。', 100), '第一句。');
  assert.equal(T.firstSentence('没有句号但是很长的一段话', 6), '没有句号但是…');
});

test('7 天曲线：全 0 返回 null（不画一条假线）', () => {
  assert.equal(T.sparkline([0, 0, 0, 0, 0, 0, 0], 10), null);
  assert.notEqual(T.sparkline([0, 1, 0, 0, 0, 0, 0], 10), null);
});

test('注释命中：服务有提供方 → 不是腐化，只提示「已有依据」', () => {
  const text = render('agint-normal', makePayload());
  assert.ok(text.includes('1 处注释提及已有依据'), `应报有依据：${text.slice(text.indexOf('债 ·'))}`);
  assert.ok(!text.includes('文档腐化候选'), 'agint.a 有提供方（agint-normal 自己 provide），不能算腐化候选');
});

test('注释命中：服务被别的插件 code 取用但无提供方 → 仍不算腐化', () => {
  const extra = [
    ['agint-other', 'lib/index.js', 9, 'agint.noProviderButUsed', 'code'],
    ['agint-normal', 'lib/index.js', 7, 'agint.noProviderButUsed', 'comment'],
  ];
  const index = T.buildDossierIndex(makePayload(extra));
  assert.equal(index.isCommentRot('agint.noProviderButUsed'), false, '有 code 态取用就不是「只出现在注释里」');
  const text = render('agint-normal', makePayload(extra));
  assert.ok(!text.includes('agint.noProviderButUsed@lib/index.js:7'), '该行只能作为「仅注释」证据行，不能进腐化候选清单');
});

test('注释命中：无提供方、无代码取用、非宿主服务 → 真腐化候选必须报', () => {
  const extra = [['agint-normal', 'lib/index.js', 6, 'agint.ghost', 'comment']];
  const index = T.buildDossierIndex(makePayload(extra));
  assert.equal(index.isCommentRot('agint.ghost'), true, '三条件全满足才判腐化');
  const text = render('agint-normal', makePayload(extra));
  assert.ok(text.includes('文档腐化候选'), '真阳性不能丢');
  assert.ok(text.includes('agint.ghost@lib/index.js:6'));
});

test('宿主服务键的注释命中不算腐化（本仓不可能 provide 它们）', () => {
  const extra = [['agint-normal', 'lib/index.js', 8, 'layout', 'comment']];
  const index = T.buildDossierIndex(makePayload(extra));
  assert.equal(index.isHostService('layout'), true);
  assert.equal(index.isCommentRot('layout'), false);
});

test('整页视图仍能找到服务表头（结构没被打散）', () => {
  const tree = T.DossierView({ id: 'agint-normal', index: T.buildDossierIndex(makePayload()), member: null, loading: false, error: null, onBack() {}, onOpen() {}, onRefresh() {} });
  const heads = findByTag(tree, 'th').map((n) => treeText(n));
  assert.ok(heads.includes('服务'), `表头缺「服务」：${heads.join('|')}`);
  assert.ok(heads.includes('提供方'));
  assert.ok(heads.includes('证据'));
});
