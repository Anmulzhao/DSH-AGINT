/**
 * agint-wiki 表示层构建器单测（阶段 3，2026-11-07）。
 *
 * 重点不是「函数能跑」，而是四条门槛真的会拦人：
 *   ① 单篇支撑的主题不出聚合页（博客：单文档可检索时 wiki 无增益）；
 *   ② 生成量超过语料量直接拒绝（博客：1.77 倍 = 没抽象）；
 *   ③ 每一条都必须是源文件里的原文子串（博客：摘要化 41/57，逐字 57/57）；
 *   ④ 人工页永不覆盖。
 * 每条门槛都配 negative control —— 把门槛调松，同样的输入必须能出结果，
 * 否则「拦住了」可能只是「根本没实现」。
 *
 * 跑法：node --test plugins/agint-wiki/test/representation.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  canonicalKey,
  splitSections,
  parseDoc,
  parseItemLine,
  extractItems,
  collectCitations,
  buildPlan,
  verifyVerbatim,
  checkLinks,
  planWrites,
  BUILD_DEFAULTS,
} from '../lib/representation.js';
import { isGenerated, stripVolatile, genMarker, GEN_MARKER_PREFIX } from '../lib/marker.js';
import { apply } from '../lib/index.js';

// ───────────────────────── 真实小节的别名覆盖 ─────────────────────────

test('① 别名表认全 7 种真实小节写法', () => {
  const cases = [
    ['一、结论（先给答案）', 'conclusion'],
    ['一、结论先行', 'conclusion'],
    ['结论', 'conclusion'],
    ['报备口径', 'conclusion'],
    ['二、制度依据（逐条可查）', 'basis'],
    ['依据文件', 'basis'],
    ['1. 依据文件与效力优先级', 'basis'],
    ['六、⚠️ 口径缺口（必须提示）', 'gaps'],
    ['口径冲突', 'gaps'],
    ['三、尚未成文的口径缺口（待补条目候选）', 'gaps'],
    ['七、待确认项', 'pending'],
    ['七、⚠️ 待确认项（未取到原文，不得推定）', 'pending'],
    ['7. 待确认口径', 'pending'],
    ['八、取证痕迹（可复现）', 'trace'],
    ['复现脚本', 'trace'],
    ['五、使用提示 / 已知坑', null],
    ['三、软压板 vs 硬压板：为什么是这个顺序', null],
  ];
  for (const [heading, want] of cases) {
    assert.equal(canonicalKey(heading), want, `「${heading}」应判为 ${want}`);
  }
});

test('② 小节切分只认 level 2，且同键以第一处为准', () => {
  const md = [
    '# 标题',
    '## 一、结论（先给答案）',
    '- 第一条结论',
    '### 2.1 子节不算小节',
    '- 子节条目',
    '## 五、⚠️ 口径缺口（必须提示）',
    '- 缺口一',
    '## 六、待确认项',
    '- [ ] 待确认一',
    '',
  ].join('\n');
  const doc = parseDoc('生产运维/x.md', md);
  assert.deepEqual(Object.keys(doc.sections).sort(), ['conclusion', 'gaps', 'pending']);
  assert.equal(doc.sections.conclusion.line, 2);
  assert.equal(doc.domain, '生产运维');
  assert.equal(doc.isIndex, false);
});

test('③ 首个 H1 是路径占位时不当作标题', () => {
  const md = '# 调度管理/台账.md\n\n# 等保测评采购台账（三级系统）\n\n正文\n';
  const doc = parseDoc('调度管理/台账.md', md);
  assert.equal(doc.title, '等保测评采购台账（三级系统）');
});

test('④ 条目解析保留缩进深度，文本是原文子串', () => {
  const src = '  - 非电量保护沿用厂家值';
  const parsed = parseItemLine(src);
  assert.equal(parsed.depth, 1);
  assert.equal(parsed.text, '非电量保护沿用厂家值');
  assert.ok(src.includes(parsed.text), '去列表符后必须仍是子串');

  assert.equal(parseItemLine('普通段落不算条目'), null);
});

test('⑤ 缺口小节写成表格时抽不出条目（这是能力边界，要能被观察到）', () => {
  const md = ['## 二、六站覆盖对照（待确认）', '| 场站 | 是否覆盖 |', '|---|---|', '| A | 是 |', ''].join('\n');
  const doc = parseDoc('调度管理/x.md', md);
  assert.equal(doc.sections.pending !== undefined, true, '小节要认出来');
  assert.equal(extractItems(doc, ['gaps', 'pending']).length, 0, '表格行不是条目');
});

// ───────────────────────── 门槛 1：单篇不出聚合页 ─────────────────────────

// ⚠️ 夹具必须接近真实文档体积。第一版每条只有 126 B，生成页（带 marker、
//    sources 清单、标题、说明）反而比语料大，直接被 no-abstraction-gain 拦掉 ——
//    三条断言因此失败。那不是门槛写错，是夹具不真实：两句话的语料确实不需要
//    聚合页。这里按真实文档的量级（每篇数百字节）造。
const FILLER = '本段为测试填充正文，用于让语料体积接近真实文档，避免生成页误触发占比门槛。'
  .repeat(5);

const gapDoc = (name, extra = '') => ({
  path: `${name}.md`,
  content: [
    `# ${name}`,
    '',
    '## 一、结论（先给答案）',
    '',
    `- ${name} 的结论：本文件只用于验证表示层构建器。`,
    '',
    FILLER,
    '',
    '## 六、⚠️ 口径缺口（必须提示）',
    '',
    `- ${name} 的缺口一，原文照抄。`,
    `- ${name} 的缺口二，原文照抄。`,
    extra,
    '',
  ].join('\n'),
});

const plainDoc = (name) => ({
  path: `${name}.md`,
  content: `# ${name}\n\n## 一、结论（先给答案）\n\n- ${name} 的结论。\n\n${FILLER}\n`,
});

test('⑥ 只有 1 篇有缺口 ⇒ 不出缺口总览，并给出 min-sources-not-met', () => {
  const plan = buildPlan([gapDoc('a'), plainDoc('b')]);
  assert.equal(plan.pages.some((p) => p.path === '_口径缺口总览.md'), false);
  const rej = plan.rejects.find((r) => r.page === '_口径缺口总览.md');
  assert.equal(rej.reason, 'min-sources-not-met');
  assert.equal(plan.pages.some((p) => p.path === 'README.md'), true, '入口页不受这条限制');
});

test('⭐ ⑥ 负控制：门槛降到 1，同样的输入必须出缺口总览', () => {
  const files = [gapDoc('a'), plainDoc('b')];
  const plan = buildPlan(files, { minSources: 1 });
  const page = plan.pages.find((p) => p.path === '_口径缺口总览.md');
  assert.ok(page, `门槛放松后必须能出页 —— 否则之前不是被门槛拦住，而是根本没实现；rejects=${JSON.stringify(plan.rejects)}`);
  assert.match(page.content, /a 的缺口一/);
});

// ───────────────────────── 门槛 2：不许没有抽象 ─────────────────────────

test('⑦ 生成量超过语料量 ⇒ 拒绝（no-abstraction-gain）', () => {
  const files = [gapDoc('a'), gapDoc('b')];
  const plan = buildPlan(files, { maxRatio: 0.0001 });
  const rej = plan.rejects.find((r) => r.reason === 'no-abstraction-gain');
  assert.ok(rej, `应被判无抽象增益，实际拒绝项：${JSON.stringify(plan.rejects)}`);
  assert.match(rej.detail, /等于没抽象/);
});

test('⭐ ⑦ 负控制：正常门槛下同一输入产出页，且总占比 < 1', () => {
  const plan = buildPlan([gapDoc('a'), gapDoc('b')]);
  const noGain = plan.rejects.filter((r) => r.reason === 'no-abstraction-gain');
  assert.equal(noGain.length, 0, `不该判无抽象增益：${JSON.stringify(noGain)}`);
  assert.ok(plan.pages.some((p) => p.path === '_口径缺口总览.md'), '应产出缺口总览');
  assert.ok(plan.metrics.corpusRatio < 1, `总占比 ${plan.metrics.corpusRatio} 应远小于 1`);
});

// ───────────────────────── 门槛 3：逐字，不摘要 ─────────────────────────

test('⑧ 逐字校验：聚合页里被改写过的条目必须被抓出来', () => {
  const files = [gapDoc('a'), gapDoc('b')];
  const good = buildPlan(files, { at: new Date('2026-11-07T00:00:00Z') });
  assert.ok(good.pages.some((p) => p.path === '_口径缺口总览.md'), JSON.stringify(good.rejects));
  assert.equal(verifyVerbatim(good, files).length, 0, '正常生成不该有违规');

  const bad = {
    pages: [{
      path: '_口径缺口总览.md',
      kind: 'derived',
      sources: ['a.md'],
      content: `${GEN_MARKER_PREFIX} v1 at=x sources=1 -->\n\n- 原文是「可以推定」。\n`,
    }],
  };
  const v = verifyVerbatim(bad, files);
  assert.equal(v.length, 1, '摘要化/改写必须被拦下');
  assert.match(v[0].text, /可以推定/);
});

test('⑨ 逐字校验：索引页的一句话摘要也必须能在源文件里找到', () => {
  const files = [gapDoc('a'), gapDoc('b')];
  const plan = buildPlan(files);
  assert.equal(verifyVerbatim(plan, files).length, 0, '正常生成不该有违规');

  const tampered = {
    pages: [{
      path: 'README.md',
      kind: 'index',
      sources: ['a.md'],
      content: `${GEN_MARKER_PREFIX} v1 at=x sources=1 -->\n\n- [a](a.md) — 真正的原因是模型能力不足。\n`,
    }],
  };
  const v = verifyVerbatim(tampered, files);
  assert.equal(v.length, 1);
  assert.match(v[0].text, /摘要非原文/);
});

test('⑩ 链接完整性：指向不存在页的链接要被报出来', () => {
  const plan = {
    pages: [{
      path: 'README.md',
      content: '- [x](nope.md)\n- [y](exists.md)\n- [外链](https://example.com/a)\n',
    }],
  };
  const broken = checkLinks(plan, ['exists.md']);
  assert.deepEqual(broken.map((b) => b.target), ['nope.md']);
});

// ───────────────────────── 门槛 4：人工页不可覆盖 ─────────────────────────

test('⑪ 人工页（无生成标记）永不覆盖；生成页可更新；内容相同算未变', () => {
  const pages = [
    { path: 'README.md', content: `${GEN_MARKER_PREFIX} v1 at=2026-11-07T00:00:00.000Z sources=1 -->\n\n# A\n` },
    { path: '_x.md', content: `${GEN_MARKER_PREFIX} v1 at=z sources=1 -->\n\n# B\n` },
    { path: '人工.md', content: '# 人写的\n' },
  ];
  const existing = new Map([
    ['_x.md', `${GEN_MARKER_PREFIX} v1 at=old sources=1 -->\n\n# 旧\n`],
    ['人工.md', '# 人写的\n'],
  ]);
  const r = planWrites(pages, existing);
  assert.deepEqual(r.writes.map((w) => w.path).sort(), ['README.md', '_x.md']);
  assert.deepEqual(r.refused.map((x) => x.reason), ['human-page-exists']);
  assert.deepEqual(r.unchanged, []);
});

test('⑪b 生成页内容未变 ⇒ unchanged，不算漂移', () => {
  const content = `${GEN_MARKER_PREFIX} v1 at=2026-11-07T00:00:00.000Z sources=1 -->\n\n# A\n`;
  const r = planWrites([{ path: 'README.md', content }], new Map([['README.md', content]]));
  assert.deepEqual(r.unchanged, ['README.md']);
  assert.equal(r.writes.length, 0);
});

// ───────────────────────── 幂等与可重建 ─────────────────────────

test('⑫ 同一输入两次构建字节一致；只有时间戳变时 stripVolatile 后一致', () => {
  const files = [gapDoc('a'), gapDoc('b')];
  const t1 = new Date('2026-11-07T00:00:00Z');
  const t2 = new Date('2026-11-08T00:00:00Z');
  const p1 = buildPlan(files, { at: t1 });
  const p2 = buildPlan(files, { at: t1 });
  for (let i = 0; i < p1.pages.length; i++) {
    assert.equal(p1.pages[i].content, p2.pages[i].content, '同输入必须同字节');
  }
  const p3 = buildPlan(files, { at: t2 });
  for (let i = 0; i < p1.pages.length; i++) {
    assert.equal(stripVolatile(p1.pages[i].content), stripVolatile(p3.pages[i].content), '只应时间戳不同');
  }
});

test('⑬ 制度反查只收被 2 篇以上引用的名称', () => {
  const files = [
    gapDoc('a', '\n依据《共同制度》与《单独制度》。\n'),
    gapDoc('b', '\n依据《共同制度》。\n'),
  ];
  const cites = collectCitations(files.map((f) => parseDoc(f.path, f.content)));
  assert.deepEqual([...cites.get('共同制度')].sort(), ['a.md', 'b.md']);
  assert.deepEqual([...cites.get('单独制度')], ['a.md']);

  const plan = buildPlan(files);
  const page = plan.pages.find((p) => p.path === '_依据反查.md');
  assert.ok(page, `有共享引用就该出反查页：${JSON.stringify(plan.rejects)}`);
  assert.match(page.content, /共同制度/);
  assert.equal(/单独制度/.test(page.content), false, '只被 1 篇引用的不进反查页');
});

test('⑭ marker：识别、去时间戳、非生成页为 false', () => {
  const m = genMarker({ at: new Date('2026-11-07T00:00:00Z'), sources: 3 });
  assert.equal(isGenerated(`${m}\n\n正文`), true);
  assert.equal(isGenerated('# 人写的'), false);
  assert.equal(stripVolatile(`${m}\n\nX`), stripVolatile(`${genMarker({ at: new Date('2027-01-01T00:00:00Z'), sources: 3 })}\n\nX`));
});

// ───────────────────────── linter 豁免（接真插件） ─────────────────────────

async function withWikiRoot(files, fn) {
  const root = await mkdtemp(join(tmpdir(), 'agint-wiki-rep-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
    }
    const ctx = {
      _provides: new Map(),
      logger: { warn() {} },
      effect(f) { f(); },
      provide(k, v) { this._provides.set(k, v); },
      get(k) { return this._provides.get(k) ?? null; },
      on() {},
    };
    apply(ctx, { root });
    return await fn({ wiki: ctx.get('agint.wiki') });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('⭐ ⑮ 生成页里引用的 ⚠️ 不算本页的矛盾；人工页里同样的行照算', async () => {
  const quoted = '⚠️ 原页写 15m＜h≤30m，更正为 15m≤h＜30m。';
  const generated = `${GEN_MARKER_PREFIX} v1 at=x sources=1 -->\n\n# 总览\n\n- ${quoted}\n`;
  const human = `# 人工页\n\n- ${quoted}\n`;

  await withWikiRoot({ '_gen.md': generated, 'human.md': human }, async ({ wiki }) => {
    const r = await wiki.lint();
    assert.equal(r.contradictions.length, 1, `只应有人工页那 1 条，实际 ${JSON.stringify(r.contradictions)}`);
    assert.equal(r.contradictions[0].path, 'human.md');
  });
});

test('⭐ ⑯ 生成页链接照常计入（README 之外的生成页也能被引用）', async () => {
  const index = `${GEN_MARKER_PREFIX} v1 at=x sources=2 -->\n\n# 索引\n\n- [a](a.md)\n- [g](_g.md)\n`;
  const g = `${GEN_MARKER_PREFIX} v1 at=x sources=1 -->\n\n# 聚合\n\n- [a](a.md)\n`;
  await withWikiRoot({ 'README.md': index, 'a.md': '# a\n', '_g.md': g }, async ({ wiki }) => {
    const r = await wiki.lint();
    assert.deepEqual(r.orphans, [], 'README 链接到的页都不该是孤儿');
    assert.deepEqual(r.brokenLinks, []);
  });
});

test('⑰ 门槛默认值来自原文，改动会被这里拦住', () => {
  assert.equal(BUILD_DEFAULTS.minSources, 2, '2 = 单文档无增益这条实验结论');
  assert.equal(BUILD_DEFAULTS.maxRatio, 1.0, '1.0 = 超过语料量等于没抽象');
});

test('⭐ ⑱ 二次构建幂等：生成页进语料后再校验，不许把自己判成违规', () => {
  // 首轮：只有人工文档
  const first = [gapDoc('a', '\n依据《共同制度》。\n'), gapDoc('b', '\n依据《共同制度》。\n')];
  const plan1 = buildPlan(first);
  assert.equal(verifyVerbatim(plan1, first).length, 0);

  // 次轮：磁盘上已经有上轮生成的 3 页（真实场景就是这样）
  const second = [...first, ...plan1.pages.map((p) => ({ path: p.path, content: p.content }))];
  const plan2 = buildPlan(second);
  const v = verifyVerbatim(plan2, second);
  assert.deepEqual(v, [], `二次校验不许有违规，实际：${JSON.stringify(v)}`);
  assert.equal(plan2.metrics.corpusDocs, 2, '生成页不该被算成语料文档');
  assert.equal(plan2.pages.length, plan1.pages.length, '页数应稳定，不随重跑增长');
  for (let i = 0; i < plan1.pages.length; i++) {
    assert.equal(
      stripVolatile(plan2.pages[i].content),
      stripVolatile(plan1.pages[i].content),
      `${plan1.pages[i].path} 二次构建内容应一致`,
    );
  }
});
