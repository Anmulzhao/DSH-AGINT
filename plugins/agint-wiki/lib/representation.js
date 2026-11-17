/**
 * agint-wiki 表示层构建器（阶段 3，2026-11-07）。
 *
 * 定位：`agint.wiki` 已经是「一个目录 + 一堆互相不认识的 .md」。本模块把它
 * 变成**表示层** —— 有入口页、有跨文档反查、有链接图。补的是「链接」和
 * 「聚合」，不是「再写一遍内容」。
 *
 * ⛔ 三条门槛都有原文依据，不是我自拟的数：
 *  1. `minSources = 2` —— 博客实测：标准可检索、多数条目能在一份文档里找到时，
 *     wiki 相对搜索「no clear gain」。所以只由 1 篇支撑的主题不单独成页，
 *     那是换个格式重排，不是抽象。
 *  2. `maxRatio = 1.0` —— 博客实测：10 份文档 115 KB，生成的 wiki 长到 203 KB
 *     （1.77 倍），评语是「effectively abstracted nothing」（博尔赫斯那张和帝国
 *     一样大的地图）。**生成量超过语料量 = 没有抽象**，设为硬门。
 *  3. **逐字引用，不摘要** —— 博客实测：多 agent 把条款摘要进共享表，57 条评分
 *     事实只活下来 41 条（72%）；改成每份合同单独一页 + 逐字引用，57/57（100%）。
 *     所以本构建器产出的每一条都是源文件里的**原文子串**，并带行号回链；
 *     模块自带 `verifyVerbatim` 把这条钉成可执行断言，不靠自觉。
 *
 * ⛔ 两条硬边界：
 *  - **纯函数**：本模块不写盘。落盘由调用方（`bin/wiki-build.mjs`）执行。
 *  - **不碰人工页**：目标文件存在但没有生成标记 ⇒ 拒绝覆盖。机器只改机器写的页。
 */

import { GEN_MARKER_PREFIX, genMarker, stripVolatile } from './marker.js';

export const BUILD_DEFAULTS = Object.freeze({
  minSources: 2,
  maxRatio: 1.0,
  maxSummaryChars: 90,
});

/**
 * 小节别名表。**这是本模块最容易腐坏的地方**，所以按真实文档归纳，不是猜的：
 *   结论：`## 一、结论（先给答案）` / `## 一、结论先行` / `## 结论` / `## 报备口径`
 *   依据：`## 二、制度依据（逐条可查）` / `## 依据文件` / `## 1. 依据文件与效力优先级`
 *   缺口：`## 六、⚠️ 口径缺口（必须提示）` / `## 口径冲突` / `## 三、尚未成文的口径缺口`
 *   待确认：`## 七、待确认项` / `## 七、⚠️ 待确认项（未取到原文，不得推定）` / `## 待确认口径`
 *   痕迹：`## 八、取证痕迹（可复现）` / `## 复现脚本`
 * 顺序有意义：先判 gaps 再判 pending，因为「尚未成文的口径缺口」同时含两种词。
 */
export const SECTION_ALIASES = Object.freeze({
  gaps: [/口径缺口/, /口径冲突/, /尚未成文/],
  pending: [/待确认/],
  conclusion: [/结论/, /报备口径/],
  basis: [/制度依据/, /依据文件/],
  trace: [/取证痕迹/, /复现脚本/],
});

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const ITEM_RE = /^(\s*)(?:[-*+]|\d+\.)\s+(.*\S)\s*$/;

const bytesOf = (s) => Buffer.byteLength(String(s), 'utf8');

/** 小节标题 → 规范键。命中顺序按 SECTION_ALIASES 的键序，先 gaps 后 pending。 */
export function canonicalKey(headingText) {
  const t = String(headingText ?? '');
  for (const [key, patterns] of Object.entries(SECTION_ALIASES)) {
    for (const re of patterns) if (re.test(t)) return key;
  }
  return null;
}

/** 把 markdown 切成小节。返回的行号是 1-based，指向标题所在行。 */
export function splitSections(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (m) {
      if (cur) out.push(cur);
      cur = { level: m[1].length, title: m[2].trim(), line: i + 1, lines: [] };
      continue;
    }
    if (cur) cur.lines.push({ no: i + 1, text: lines[i] });
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 解析一篇文档。`sections` 只收 level-2 小节 —— 现有文档的规范小节都在 level 2，
 * level 3 是展开说明（`### 2.1 山东公司手册侧` 之类），收进来会把说明当条目。
 */
export function parseDoc(path, content) {
  const raw = String(content ?? '');
  const lines = raw.split(/\r?\n/);
  const all = splitSections(raw);

  const title = (() => {
    const h1 = all.filter((s) => s.level === 1);
    // 实测有两篇文档第一行是 `# 调度管理/xxx.md` 这种路径占位，不是真标题
    const real = h1.find((s) => !/\.md\s*$/.test(s.title));
    return (real ?? h1[0])?.title ?? path.split('/').pop().replace(/\.md$/, '');
  })();

  const sections = {};
  for (const s of all) {
    if (s.level !== 2) continue;
    const key = canonicalKey(s.title);
    if (!key) continue;
    if (sections[key]) continue; // 同键多小节时以第一处为准，避免条目重复
    sections[key] = { title: s.title, line: s.line, body: s.lines };
  }

  return {
    path,
    domain: path.includes('/') ? path.split('/')[0] : '',
    title,
    bytes: bytesOf(raw),
    lines,
    sections,
    isIndex: /索引$/.test(path.split('/').pop().replace(/\.md$/, '')),
  };
}

/** 去掉列表符号，保留缩进深度。返回的 text 一定是源文件里的子串。 */
export function parseItemLine(text) {
  const m = ITEM_RE.exec(text);
  if (!m) return null;
  const depth = Math.min(Math.floor(m[1].replace(/\t/g, '  ').length / 2), 2);
  return { depth, text: m[2] };
}

/**
 * 从一篇文档的指定小节里抽条目。
 * 只抽能构成条目的行：列表项 / 编号项。正文段落不算 —— 段落抽出来会丢上下文。
 */
export function extractItems(doc, keys) {
  const out = [];
  for (const key of keys) {
    const sec = doc.sections[key];
    if (!sec) continue;
    for (const ln of sec.body) {
      const parsed = parseItemLine(ln.text);
      if (!parsed) continue;
      out.push({ source: doc.path, line: ln.no, section: key, depth: parsed.depth, text: parsed.text });
    }
  }
  return out;
}

/** 全文中《》包住的制度名称 → 引用它的文档集合。只用来做反查，不解读内容。 */
export function collectCitations(docs) {
  const map = new Map();
  const RE = /《([^》\n]{2,60})》/g;
  for (const doc of docs) {
    const raw = doc.lines.join('\n');
    RE.lastIndex = 0;
    let m;
    const seen = new Set();
    while ((m = RE.exec(raw)) !== null) {
      const name = m[1].trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(doc.path);
    }
  }
  return map;
}

const escLink = (p) => p; // 中文路径不需要转义；空格在 markdown 里也合法
// 末尾冒号是「下面是清单」的引子，摘到索引页上会变成悬空的「…会出错：」。
// 只去掉这一个标点，前面每个字仍是原文。
const trimTail = (s) => s.replace(/[：:]\s*$/, '');
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n)}…`);

/**
 * 一行能不能当「摘要片段」。
 * ⛔ 实测踩过：`等保测评采购台账` 的第一行正文是表格表头 `| 场站 | 2026 年采购是否覆盖 |`，
 *    `周期体系` 的首个非空行是分隔线 `---`。两种都被当成摘要挂上去了，
 *    索引页上出现 `— ---` 这种废条目。摘要必须是**成句的散文或列表项**。
 */
function looksLikeProse(t) {
  if (!t) return false;
  if (t.startsWith('#')) return false;
  if (t.startsWith('>')) return false;
  if (t.startsWith('|')) return false;
  if (/^([-*_])\1{2,}$/.test(t)) return false; // --- / *** / ___
  return true;
}

function firstSummaryLine(doc) {
  // 1) 有「结论 / 报备口径」小节就用它 —— 那是作者自己写的答案
  const sec = doc.sections.conclusion;
  if (sec) {
    for (const ln of sec.body) {
      const parsed = parseItemLine(ln.text);
      const text = parsed ? parsed.text : ln.text.trim();
      if (looksLikeProse(text)) return { text, line: ln.no, section: 'conclusion' };
    }
  }
  // 2) 没有结论小节 → 用第一个 H2 之前的引言段（散文优先）
  const firstH2 = doc.lines.findIndex((l) => /^##\s+/.test(l));
  const upto = firstH2 < 0 ? doc.lines.length : firstH2;
  for (let i = 0; i < upto; i++) {
    const t = doc.lines[i].trim();
    if (looksLikeProse(t) && !parseItemLine(t)) return { text: t, line: i + 1, section: 'intro' };
  }
  // 3) 再退：缺口 / 待确认的第一条（仍是原文）
  for (const key of ['gaps', 'pending']) {
    const s = doc.sections[key];
    if (!s) continue;
    for (const ln of s.body) {
      const parsed = parseItemLine(ln.text);
      const text = parsed ? parsed.text : ln.text.trim();
      if (looksLikeProse(text)) return { text, line: ln.no, section: key };
    }
  }
  // 4) 最后兜底：全文第一个像样的散文行
  for (let i = 0; i < doc.lines.length; i++) {
    const t = doc.lines[i].trim();
    if (looksLikeProse(t) && !parseItemLine(t)) return { text: t, line: i + 1, section: 'body' };
  }
  return null;
}

function renderGapsPage(docs, items, sources, at) {
  const lines = [];
  lines.push(genMarker({ at, sources: sources.length }));
  lines.push(`<!-- sources: ${sources.join(', ')} -->`);
  lines.push('');
  lines.push('# 口径缺口总览（自动生成）');
  lines.push('');
  lines.push('> 本页由 `bin/wiki-build.mjs` 生成，**不要手改** —— 改源文件后重跑。');
  lines.push('> 每条都是源文件的**逐字引用**；行号只标到小节起始行，逐条核对请从那里进去看。缺口不是结论，别当已定论的口径对外说。');
  lines.push('');

  const byDomain = new Map();
  for (const doc of docs) {
    const own = items.filter((it) => it.source === doc.path);
    if (own.length === 0) continue;
    if (!byDomain.has(doc.domain || '（无领域）')) byDomain.set(doc.domain || '（无领域）', []);
    byDomain.get(doc.domain || '（无领域）').push({ doc, items: own });
  }

  for (const [domain, group] of byDomain) {
    lines.push(`## ${domain || '（无领域）'}`);
    lines.push('');
    for (const { doc, items: own } of group) {
      const gaps = own.filter((i) => i.section === 'gaps').length;
      const pend = own.filter((i) => i.section === 'pending').length;
      // 行号只标到「小节起始行」：条目级锚点在本地文件里点不开，标了也点不动，
      // 反而是句空承诺。要逐行核，按这个起始行进去看即可。
      const where = [
        gaps ? `缺口（源 L${doc.sections.gaps.line} 起）` : null,
        pend ? `待确认（源 L${doc.sections.pending.line} 起）` : null,
      ].filter(Boolean).join(' · ');
      lines.push(`### [${doc.title}](${escLink(doc.path)})`);
      lines.push('');
      lines.push(`${where}`);
      lines.push('');
      for (const it of own) {
        lines.push(`${'  '.repeat(it.depth)}- ${it.text}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

function renderCitationsPage(pairs, sources, at) {
  const lines = [];
  lines.push(genMarker({ at, sources: sources.length }));
  lines.push(`<!-- sources: ${sources.join(', ')} -->`);
  lines.push('');
  lines.push('# 制度依据反查（自动生成）');
  lines.push('');
  lines.push('> 本页由 `bin/wiki-build.mjs` 生成，**不要手改**。');
  lines.push(`> 只收**被至少 ${BUILD_DEFAULTS.minSources} 篇**文档引用的制度名称 —— 只被 1 篇引用的不进本页（单篇内可检索，聚合没有增量）。`);
  lines.push('> 口径：只认 `《》` 包住的名称。条款号（如 `手册 2.18.9.4`）与文号（如 `27号细则`）**不在本页** —— 它们不带书名号，混进来会把「同一份制度的不同写法」当成不同制度。');
  lines.push('');
  for (const { name, docs: citing } of pairs) {
    lines.push(`## 《${name}》`);
    lines.push('');
    lines.push(`被 ${citing.length} 篇引用：`);
    lines.push('');
    for (const d of citing) lines.push(`- [${d.title}](${escLink(d.path)})`);
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

function renderIndexPage(docs, generated, summaries, at) {
  const lines = [];
  lines.push(genMarker({ at, sources: docs.length }));
  lines.push(`<!-- sources: ${docs.map((d) => d.path).join(', ')} -->`);
  lines.push('');
  lines.push('# 知识库索引（自动生成）');
  lines.push('');
  lines.push('> 本页由 `bin/wiki-build.mjs` 生成，**不要手改** —— 新增文档后重跑即可挂上。');
  lines.push('> 每条的一句话摘要都是该文档里的**原文片段**（截断处标 `…`），不是改写。');
  lines.push('');

  // 领域顺序 = 该领域首篇文档在路径序里的位置。刻意不用 localeCompare：
  // 中英文混排时它把 AGINT 排到最末，读起来像漏了一项。插入序可复现。
  const byDomain = new Map();
  const indexDocs = [];
  for (const doc of docs) {
    if (doc.isIndex) { indexDocs.push(doc); continue; }
    const key = doc.domain || '（无领域）';
    if (!byDomain.has(key)) byDomain.set(key, []);
    byDomain.get(key).push(doc);
  }
  for (const [domain, group] of byDomain) {
    lines.push(`## ${domain}`);
    lines.push('');
    for (const doc of group) {
      const s = summaries.get(doc.path);
      const tail = s ? ` — ${s.text}` : '';
      lines.push(`- [${doc.title}](${escLink(doc.path)})${tail}`);
    }
    lines.push('');
  }

  if (indexDocs.length) {
    lines.push('## 人工维护的入口页（权威）');
    lines.push('');
    lines.push('> 这几页是人手写的，不是本构建器产出；内容比本页细，冲突时以它们为准。');
    lines.push('');
    for (const doc of indexDocs) lines.push(`- [${doc.title}](${escLink(doc.path)})`);
    lines.push('');
  }

  lines.push('## 自动生成页');
  lines.push('');
  for (const g of generated) lines.push(`- [${g.title}](${escLink(g.path)}) — ${g.note}`);
  lines.push('');
  return lines.join('\n').replace(/\n+$/, '\n');
}

/**
 * 生成整个计划。纯函数：返回内容，不落盘。
 *
 * @param {Array<{path:string, content:string}>} files 语料（含人工写的页）
 * @param {{at?:Date, minSources?:number, maxRatio?:number, maxSummaryChars?:number}} opts
 */
export function buildPlan(files, opts = {}) {
  const minSources = opts.minSources ?? BUILD_DEFAULTS.minSources;
  const maxRatio = opts.maxRatio ?? BUILD_DEFAULTS.maxRatio;
  const maxSummaryChars = opts.maxSummaryChars ?? BUILD_DEFAULTS.maxSummaryChars;
  const at = opts.at ?? new Date();

  const corpusFiles = files.filter((f) => !String(f.content).startsWith(GEN_MARKER_PREFIX));
  const docs = corpusFiles.map((f) => parseDoc(f.path, f.content));
  const docsByPath = new Map(docs.map((d) => [d.path, d]));
  const corpusBytes = docs.reduce((s, d) => s + d.bytes, 0);
  const rejects = [];
  const pages = [];

  // ── 聚合页：缺口总览 ──────────────────────────────────────────────
  // 索引页排除在外：`口径索引.md` 自己第三节就在手工做同一件事，
  // 把它算进来会让生成页复述人工页，制造第二个事实源。
  const aggregatable = docs.filter((d) => !d.isIndex);
  const gapItems = aggregatable.flatMap((d) => extractItems(d, ['gaps', 'pending']));
  const gapSources = [...new Set(gapItems.map((i) => i.source))].sort();

  if (gapSources.length < minSources) {
    rejects.push({
      page: '_口径缺口总览.md',
      reason: 'min-sources-not-met',
      detail: `${gapSources.length} < ${minSources}：涉及的文档不足，聚合无增量（单篇内可检索）`,
    });
  } else {
    const content = renderGapsPage(aggregatable.filter((d) => gapSources.includes(d.path)), gapItems, gapSources, at);
    const pageBytes = bytesOf(content);
    const ratio = corpusBytes === 0 ? 0 : pageBytes / corpusBytes;
    if (ratio > maxRatio) {
      rejects.push({
        page: '_口径缺口总览.md',
        reason: 'no-abstraction-gain',
        detail: `${pageBytes} B / 语料 ${corpusBytes} B = ${ratio.toFixed(2)} > ${maxRatio}（超过语料量等于没抽象）`,
      });
    } else {
      pages.push({
        path: '_口径缺口总览.md',
        title: '口径缺口总览',
        note: `${gapItems.length} 条，跨 ${gapSources.length} 篇`,
        content,
        bytes: pageBytes,
        sources: gapSources,
        ratio,
      });
    }
  }

  // ── 反查页：制度名称 → 引用它的文档 ────────────────────────────────
  const citations = collectCitations(aggregatable);
  const pairs = [...citations.entries()]
    .map(([name, set]) => ({ name, paths: [...set].sort() }))
    .filter((p) => p.paths.length >= minSources)
    .sort((a, b) => b.paths.length - a.paths.length || a.name.localeCompare(b.name))
    .map((p) => ({ name: p.name, docs: p.paths.map((x) => docsByPath.get(x)).filter(Boolean) }));

  if (pairs.length === 0) {
    rejects.push({
      page: '_依据反查.md',
      reason: 'no-shared-citation',
      detail: `没有一部制度被 ${minSources} 篇以上文档引用，反查无内容`,
    });
  } else {
    const citeSources = [...new Set(pairs.flatMap((p) => p.docs.map((d) => d.path)))].sort();
    const content = renderCitationsPage(pairs, citeSources, at);
    const pageBytes = bytesOf(content);
    const ratio = corpusBytes === 0 ? 0 : pageBytes / corpusBytes;
    if (ratio > maxRatio) {
      rejects.push({
        page: '_依据反查.md',
        reason: 'no-abstraction-gain',
        detail: `${pageBytes} B / 语料 ${corpusBytes} B = ${ratio.toFixed(2)} > ${maxRatio}`,
      });
    } else {
      pages.push({
        path: '_依据反查.md',
        title: '制度依据反查',
        note: `${pairs.length} 部制度被至少 ${minSources} 篇引用`,
        content,
        bytes: pageBytes,
        sources: citeSources,
        ratio,
      });
    }
  }

  // ── 入口页：README.md ────────────────────────────────────────────
  // 入口页不受 minSources 约束 —— 它是地图本身，不是主题聚合。
  // 而且它是 lint 里唯一豁免「孤儿」判定的文件名，必须存在，否则所有页都是孤儿。
  const summaries = new Map();
  for (const d of docs) {
    const s = firstSummaryLine(d);
    if (s) summaries.set(d.path, { text: clip(trimTail(s.text), maxSummaryChars), line: s.line, section: s.section });
  }
  const generated = pages.map((p) => ({ path: p.path, title: p.title, note: p.note }));
  const readme = renderIndexPage(docs, generated, summaries, at);
  const readmeBytes = bytesOf(readme);
  const readmeRatio = corpusBytes === 0 ? 0 : readmeBytes / corpusBytes;

  const plan = {
    pages: [
      { path: 'README.md', title: '知识库索引', note: `${docs.length} 篇`, content: readme, bytes: readmeBytes, sources: docs.map((d) => d.path), ratio: readmeRatio, kind: 'index' },
      ...pages.map((p) => ({ ...p, kind: 'derived' })),
    ],
    metrics: {
      corpusDocs: docs.length,
      corpusBytes,
      generatedPages: pages.length + 1,
      generatedBytes: readmeBytes + pages.reduce((s, p) => s + p.bytes, 0),
      indexPages: docs.filter((d) => d.isIndex).map((d) => d.path),
      coverage: {
        gapsItems: gapItems.length,
        gapsSources: gapSources.length,
        citationsShared: pairs.length,
        docsWithGaps: aggregatable.filter((d) => d.sections.gaps).length,
        docsWithPending: aggregatable.filter((d) => d.sections.pending).length,
        // 有缺口/待确认小节、但条目全写成表格 ⇒ 抽不出条目。必须报出来，
        // 否则「某篇明明写了缺口，总览里却没有」会被误读成那篇没缺口。
        tableOnlyDocs: aggregatable
          .filter((d) => (d.sections.gaps || d.sections.pending) && extractItems(d, ['gaps', 'pending']).length === 0)
          .map((d) => d.path),
      },
    },
    rejects,
    docs: docs.map((d) => ({
      path: d.path,
      title: d.title,
      bytes: d.bytes,
      isIndex: d.isIndex,
      sections: Object.keys(d.sections),
    })),
  };
  plan.metrics.corpusRatio = corpusBytes === 0 ? 0 : plan.metrics.generatedBytes / corpusBytes;
  return plan;
}

/**
 * 逐字校验：每一条聚合条目必须是源文件里的**子串**。
 * 这是「不摘要」这条门槛的可执行形态 —— 摘要会改写用词，改写就过不了这一关。
 *
 * 索引页的「一句话摘要」同样校验：它才是最容易被写成漂亮但失真的那句话。
 * 摘要带 `…` 截断尾，比较前先去掉；末尾冒号在渲染时被 trimTail 去掉，这里也允许。
 */
export function verifyVerbatim(plan, files) {
  const raw = new Map(files.map((f) => [f.path, String(f.content)]));
  const violations = [];
  if (!raw.size) return violations;
  for (const page of plan.pages) {
    if (page.kind === 'derived') {
      for (const line of page.content.split('\n')) {
        const m = /^\s*-\s+(.*\S)\s*$/.exec(line);
        if (!m) continue;
        const text = m[1];
        if (text.startsWith('[')) continue; // 链接行不是引用条目
        const hit = page.sources.some((p) => raw.get(p)?.includes(text));
        if (!hit) violations.push({ page: page.path, text: text.slice(0, 80) });
      }
      continue;
    }
    // 索引页：`- [标题](路径) — 摘要`
    for (const line of page.content.split('\n')) {
      const m = /^\s*-\s+\[[^\]]*\]\(([^)]+)\)\s+—\s+(.*\S)\s*$/.exec(line);
      if (!m) continue;
      const target = m[1].split('#')[0].trim();
      // 只校验**语料文档**的摘要。索引页末尾「自动生成页」那一节的说明是
      // 计数（「40 条，跨 7 篇」），本来就不是任何文档里的原文 ——
      // 拿它去比对会把自己写的检查器打成违规（第二次运行实测踩到）。
      if (!page.sources.includes(target)) continue;
      const body = raw.get(target);
      if (body === undefined) continue; // 断链由 checkLinks 负责
      const summary = m[2].replace(/…$/, '');
      const ok = body.includes(summary) || body.includes(`${summary}：`) || body.includes(`${summary}:`);
      if (!ok) violations.push({ page: page.path, text: `摘要非原文：${summary.slice(0, 70)}` });
    }
  }
  return violations;
}

/** 链接完整性：生成页里的相对链接必须指向真实存在的页（含本次计划里的页）。 */
export function checkLinks(plan, existingPaths) {
  const known = new Set([...existingPaths, ...plan.pages.map((p) => p.path)]);
  const broken = [];
  for (const page of plan.pages) {
    for (const line of page.content.split('\n')) {
      const RE = /\]\(([^)]+)\)/g;
      let m;
      while ((m = RE.exec(line)) !== null) {
        const target = m[1].split('#')[0].trim();
        if (!target || /^https?:/.test(target)) continue;
        if (!known.has(target)) broken.push({ page: page.path, target });
      }
    }
  }
  return broken;
}

/**
 * 决定哪些页要写。人工页（存在但没有生成标记）一律拒绝覆盖。
 * @param {Array} pages plan.pages
 * @param {Map<string,string>} existing path → 现有内容（不存在则不放键）
 */
export function planWrites(pages, existing) {
  const writes = [];
  const unchanged = [];
  const refused = [];
  for (const page of pages) {
    const cur = existing.get(page.path);
    if (cur === undefined) {
      writes.push({ ...page, action: 'create' });
      continue;
    }
    if (!cur.startsWith(GEN_MARKER_PREFIX)) {
      refused.push({ path: page.path, reason: 'human-page-exists' });
      continue;
    }
    // 比对时抹掉 marker 里的时间戳：内容没变、只是重跑了一次，不算漂移。
    // 否则 `--check` 永远报红，人就不看了（假警报训练人忽略告警）。
    const same = stripVolatile(cur.replace(/\r\n/g, '\n')) === stripVolatile(page.content);
    if (same) unchanged.push(page.path);
    else writes.push({ ...page, action: 'update' });
  }
  return { writes, unchanged, refused };
}

export function summarizePlan(plan) {
  return {
    corpusDocs: plan.metrics.corpusDocs,
    corpusBytes: plan.metrics.corpusBytes,
    generatedPages: plan.pages.length,
    generatedBytes: plan.metrics.generatedBytes,
    corpusRatio: Number(plan.metrics.corpusRatio.toFixed(3)),
    rejects: plan.rejects.length,
    perPage: plan.pages.map((p) => ({
      path: p.path,
      bytes: p.bytes,
      ratio: Number((p.ratio ?? 0).toFixed(3)),
      sources: p.sources.length,
    })),
  };
}
