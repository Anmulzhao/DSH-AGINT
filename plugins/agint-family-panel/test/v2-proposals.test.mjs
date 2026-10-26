/**
 * 提案台数据层测试（lib/v2-proposals.js）。
 *
 * 这里钉的四类错误，都是在真宿主里要重启才看得到的：
 *  1. 正文分节解析把「缺这一节」画成「有这一节」—— 那会把不可评审的提案装成可评审。
 *  2. 引用提取把 `index.js` 当符号（早前取 last segment，得到 `js`），命中率 100% 的线索全废。
 *  3. 证据核对把「我没法核对」写成「不存在」—— wiki 仓路径就是这一类。
 *  4. 域缺失被返回成 total=0，把「没开这个域」显示成「没有提案」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSections,
  extractRefs,
  normalizeRefPath,
  probeEvidence,
  summarizeProposals,
  collectProposals,
} from '../lib/v2-proposals.js';

// ── 1. 分节解析 ────────────────────────────────────────────
test('分节解析：五节齐全时逐节取出，标题不进正文', () => {
  const body = [
    '## 现状问题',
    '- cron 任务状态不落盘',
    '## 改动方案',
    '在 jobs.js 加 lastResult',
    '## 预期收益',
    '排查不用再猜',
    '## 风险与边界',
    '零',
    '## 关联',
    '提案 1234',
  ].join('\n');
  const { sections, matched } = parseSections(body);
  assert.equal(matched, 5);
  assert.ok(sections.problem.includes('状态不落盘'));
  assert.ok(!sections.problem.includes('现状问题'), '标题不该留在正文里');
  assert.ok(sections.plan.includes('lastResult'));
  assert.ok(sections.benefit.includes('不用再猜'));
  assert.equal(sections.risk, '零');
  assert.ok(sections.links.includes('1234'));
});

test('分节解析：缺节返回 null，不拿首段冒充「目的」', () => {
  const { sections, matched } = parseSections('这条提案只有一段话，没有任何标题。');
  assert.equal(matched, 0);
  for (const k of ['problem', 'plan', 'benefit', 'risk', 'links']) assert.equal(sections[k], null);
});

test('分节解析：三级标题与同义标题都认（实测 95 条里有 46 条不写「现状问题」）', () => {
  const body = ['### 背景', '为什么提这条', '### 实施方案', '分两步'].join('\n');
  const { sections, matched } = parseSections(body);
  assert.equal(matched, 2);
  assert.ok(sections.problem.includes('为什么'));
  assert.ok(sections.plan.includes('两步'));
});

// ── 2. 引用提取 ────────────────────────────────────────────
test('引用提取：路径识别正确，`package.json` 不会被截成 `package.js`', () => {
  const { paths } = extractRefs('改 `plugins/agint-evolve/lib/index.js` 与 `package.json` 两处。');
  const raws = paths.map((p) => p.raw);
  assert.ok(raws.includes('plugins/agint-evolve/lib/index.js'));
  assert.ok(raws.includes('package.json'), `实际：${raws.join(',')}`);
  assert.ok(!raws.includes('package.js'));
});

test('引用提取：README.md:85 带行号', () => {
  const { paths } = extractRefs('见 `README.md:85` 那句。');
  assert.equal(paths[0].raw, 'README.md');
  assert.equal(paths[0].line, 85);
});

test('引用提取：文件名不当符号（早前会把 index.js 拆出 `js`）', () => {
  const { symbols } = extractRefs('把 `index.js` 里的 `setStatus` 与 `CANDIDATE_OPEN_STATUSES` 一起改。');
  assert.ok(!symbols.includes('js'));
  assert.ok(!symbols.includes('index'));
  assert.ok(symbols.includes('setStatus'));
  assert.ok(symbols.includes('CANDIDATE_OPEN_STATUSES'));
});

test('引用提取：通用词不收（status / note / VERSION 全仓都命中，收了等于没线索）', () => {
  const { symbols } = extractRefs('看 `status`、`note`、`VERSION`、`HARM` 四个词。');
  assert.deepEqual(symbols, []);
});

// ── 3. 路径归一化 ──────────────────────────────────────────
test('路径归一化：三种历史写法都收敛到仓库相对路径', () => {
  assert.equal(normalizeRefPath('project\\DSH-AGINT\\README.md:85').rel, 'README.md');
  assert.equal(normalizeRefPath('D:\\DSH\\project源码\\DSH-AGINT\\AGENTS.md').rel, 'AGENTS.md');
  assert.equal(normalizeRefPath('plugins/agint-evolve/lib/index.js').rel, 'plugins/agint-evolve/lib/index.js');
});

// ── 4. 证据核对 ────────────────────────────────────────────
test('证据核对：只核对仓库内路径，缺失即 false；同名不同写法的路径只算一次', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agint-prop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'plugins', 'x', 'lib'), { recursive: true });
  writeFileSync(join(root, 'plugins', 'x', 'lib', 'index.js'), 'export function persistJobState(){}\n', 'utf8');
  writeFileSync(join(root, 'README.md'), '# x\n', 'utf8');

  const refs = extractRefs('改 `plugins/x/lib/index.js` 的 `persistJobState`，见 `README.md` 与 `project\\DSH-AGINT\\README.md`。');
  const ev = probeEvidence(refs, root);
  const rels = ev.paths.map((p) => p.rel);
  assert.equal(rels.filter((r) => r === 'README.md').length, 1, '同一文件两种写法只能算一条');
  assert.equal(ev.summary.pathExists, 2);
  assert.equal(ev.summary.symFound, 1);
  assert.equal(ev.hint.level, 'maybe-done', '符号命中只给「疑似」，不给「已落地」');
});

test('证据核对：wiki 仓路径标「不可核」，不判成「不存在」', () => {
  const refs = extractRefs('见 `AGINT.wiki/路线图.md`。');
  const ev = probeEvidence(refs, '/nonexistent-root');
  assert.equal(ev.paths[0].exists, null);
  assert.ok(ev.paths[0].unverifiable.includes('wiki'));
});

test('证据核对：引用路径全不存在 → stale；差异必须能指向具体路径', () => {
  const refs = extractRefs('改 `plugins/gone/lib/index.js` 与 `docs/gone.md`。');
  const ev = probeEvidence(refs, '/nonexistent-root');
  assert.equal(ev.hint.level, 'stale');
  assert.equal(ev.summary.pathExists, 0);
  assert.equal(ev.summary.pathChecked, 2);
});

test('证据核对：仓库位不可得 → state=unavailable，证据留 null 不装成 false', () => {
  const refs = extractRefs('改 `plugins/x/lib/index.js`。');
  const ev = probeEvidence(refs, null);
  assert.equal(ev.state, 'unavailable');
  assert.equal(ev.paths[0].exists, null);
  assert.equal(ev.hint.level, 'unknown');
  assert.ok(ev.hint.text.includes('仓库位不可得'));
});

// ── 5. 统计 ────────────────────────────────────────────────
test('统计：队列口径只算 proposed，年龄分桶合计等于队列数', () => {
  const now = Date.parse('2026-10-23T00:00:00Z');
  const mk = (status, days, cat = 'plugin') => ({
    status, category: cat, source: 's', ageDays: days,
    createdAt: new Date(now - days * 86400000).toISOString(),
  });
  const items = [mk('proposed', 2), mk('proposed', 20), mk('proposed', 40), mk('applied', 40), mk('approved', 1)];
  const c = summarizeProposals(items, now);
  assert.equal(c.total, 5);
  assert.equal(c.queueCount, 3);
  assert.equal(c.aging.oldestDays, 40);
  assert.equal(c.aging.medianDays, 20);
  assert.deepEqual(c.aging.buckets, { le7: 1, d8to30: 1, gt30: 1 });
  assert.equal(c.byStatus.approved, 1);
});

// ── 6. 取数降级 ────────────────────────────────────────────
test('取数：既无服务也无文件 → unavailable，绝不返回空表冒充「没有提案」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agint-prop-empty-'));
  try {
    const r = await collectProposals({}, { storagesDir: dir, repoPluginsDir: null });
    assert.equal(r.state, 'unavailable');
    assert.equal(r.items.length, 0);
    assert.equal(r.counts, null, '取不到时不能给 counts');
    assert.ok(r.reason.includes('agint_evolve.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('取数：存储面兜底可用，服务面抛错不吞原因', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agint-prop-store-'));
  try {
    writeFileSync(join(dir, 'agint_evolve.json'), JSON.stringify({
      unit: { name: 'agint_evolve', version: 2 },
      global: null,
      tables: {
        proposal: {
          a: { id: 'a', title: 'T1', body: '## 改动方案\n改 `plugins/x/lib/index.js`', category: 'plugin', status: 'proposed', source: 's', note: '', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
        },
      },
    }), 'utf8');
    const ctx = { get: () => ({ listProposals: () => { throw new Error('domain closed'); } }) };
    const r = await collectProposals(ctx, { storagesDir: dir, repoPluginsDir: null });
    assert.equal(r.state, 'ok');
    assert.equal(r.source, 'storage');
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].sectionMatched, 1);
    assert.equal(r.items[0].evidence.state, 'unavailable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('取数：服务面优先于存储面（写完立刻读到的必须是服务面那一版）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agint-prop-svc-'));
  try {
    writeFileSync(join(dir, 'agint_evolve.json'), JSON.stringify({
      unit: { name: 'agint_evolve', version: 2 }, global: null, tables: { proposal: {} },
    }), 'utf8');
    const rec = { id: 'b', title: '来自服务面', body: 'x', category: 'doc', status: 'proposed', source: '', note: '', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' };
    const ctx = { get: () => ({ listProposals: () => [rec] }) };
    const r = await collectProposals(ctx, { storagesDir: dir, repoPluginsDir: null });
    assert.equal(r.source, 'service');
    assert.equal(r.items[0].title, '来自服务面');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('取数：默认排序待批在前、老的在前（队列腐化先看最老那条）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agint-prop-sort-'));
  try {
    const row = (id, status, createdAt) => ({ id, title: id, body: 'b', category: 'doc', status, source: '', note: '', createdAt, updatedAt: createdAt });
    writeFileSync(join(dir, 'agint_evolve.json'), JSON.stringify({
      unit: { name: 'agint_evolve', version: 2 }, global: null,
      tables: { proposal: {
        old: row('old', 'proposed', '2026-08-01T00:00:00Z'),
        newp: row('newp', 'proposed', '2026-10-20T00:00:00Z'),
        done: row('done', 'applied', '2026-07-01T00:00:00Z'),
      } },
    }), 'utf8');
    const r = await collectProposals({}, { storagesDir: dir, repoPluginsDir: null });
    assert.deepEqual(r.items.map((i) => i.id), ['old', 'newp', 'done']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
