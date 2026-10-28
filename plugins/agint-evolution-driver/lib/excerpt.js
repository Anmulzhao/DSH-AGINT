/**
 * excerpt.js — 把「一个大文件」压成「模型真能用的一小段」。
 *
 * ⛔ 2026-10-28 的背景：这里原来是 `fileText.slice(0, 20000)`，即**从头截断**。
 *   两个后果都实测到了：
 *   ① 锚点在 20000 字符之外 ⇒ 模型看不到它要改的那段，只能判 applicable=false
 *      或先花轮次去读文件（`agint-dream/lib/sweep.js` 有 80957 字符，而它要改的
 *      `collectSessionSignals` 在 15664 字符处 —— 这次侥幸在窗口内，下次不一定）；
 *   ② 提示词声称「verbatim text of one target file」，模型却看到被截断的文本，
 *      它自己会说「The file shown is truncated at the end」然后去读原文件。
 *      截断本想省 token，实际换来更多轮次。
 *
 * 本模块的契约（都可单测，不碰 ctx、不调 LLM）：
 *   - 全文 ≤ budget ⇒ 原文照给（mode='full'）；
 *   - 否则按**提案里的锚点**（反引号里的标识符 / 文件内定位到具体行）取窗口，
 *     附一份**带行号的结构大纲**，总长 ≤ budget；
 *   - 正文窗口**逐字原样**，绝不给行首加行号：模型要复制 oldText，加前缀就是
 *     必挂的幻觉（`anchorExists` 会判它编的）。行号只出现在大纲与省略标记里。
 */

/**
 * 反引号里的片段：提案里写标识符/路径/`file:line` 的主要形态。
 *
 * ⚠ 量词必须是 `{1,120}` 而不是 `{2,120}`：反引号是**成对**用的，一旦短片段
 *   （如 `` `x` ``）不匹配，引擎会从它**收尾的反引号**开始重新配，把后面整段
 *   都错位吞掉（实测 `x` 这种单字符标识符会让 `config.repoRoot` 直接消失）。
 *   太短的过滤放在 extractAnchors 里做，不放在正则里 —— 正则只管配对，判断归判断。
 */
const BACKTICK_RE = /`([^`\n]{1,120})`/g;
/** 纯标识符（允许 a.b.c 与 foo()）；太长的当句子扔掉。 */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*(?:\(\))?$/;
const PATHY_RE = /[/\\]/;
/** `foo.js:123` / `foo:12-34`（行区间取起点）。 */
const LINE_REF_RE = /^(.*?):(\d+)(?:-(\d+))?$/;

/** 太短的锚点（如 `x`）在文件里到处命中，等于没定位价值。 */
const MIN_ANCHOR_LEN = 4;
/** 单个锚点最多取几处出现（同名函数在文件里反复出现时别把预算吃光）。 */
const HITS_PER_ANCHOR = 3;

const DECL_PATTERNS = [
  /^\s{0,2}(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s{0,2}(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  /^\s{0,2}(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
];
const MD_HEADING_RE = /^#{1,4}\s+(.+?)\s*$/;

/**
 * 从提案正文里抽「要去文件里找什么」。
 *
 * 只认反引号包起来的片段 —— 这是本仓提案的书写惯例（`collectSessionSignals`、
 * `defineTool`、`file.js:793`）。⛔ 不做中文分词：那需要词典，且误召回的代价
 * （窗口跑到无关段落）比漏召回更高。
 *
 * @returns {Array<{kind:'ident'|'line'|'path', value:string, line?:number}>}
 */
export function extractAnchors(text, { limit = 12 } = {}) {
  const src = String(text ?? '');
  const out = [];
  const seen = new Set();
  const push = (a) => {
    const value = String(a.value ?? '').trim();
    if (value.length < MIN_ANCHOR_LEN) return;
    const key = `${a.kind}:${value}:${a.line ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...a, value });
  };
  let m;
  BACKTICK_RE.lastIndex = 0;
  while ((m = BACKTICK_RE.exec(src)) !== null) {
    const tok = m[1].trim();
    if (!tok) continue;
    const lineRef = LINE_REF_RE.exec(tok);
    if (lineRef && lineRef[1].trim()) {
      push({ kind: 'line', value: lineRef[1].trim(), line: Number(lineRef[2]) });
      continue;
    }
    if (PATHY_RE.test(tok)) {
      // 路径锚点只对「目标选择」有意义；文件内容里一般不会出现自己的路径。
      // 仍收进来：有些提案会把 `plugins/x/lib/y.js:10` 之外的上下文写在正文里。
      push({ kind: 'path', value: tok });
      continue;
    }
    if (IDENT_RE.test(tok)) push({ kind: 'ident', value: tok.replace(/\(\)$/, '') });
  }
  return out.slice(0, limit);
}

/**
 * 结构大纲：只列顶层声明（代码）或各级标题（Markdown），带行号。
 *
 * 作用不是「让模型读完全局」，而是给它一张地图 —— 当它发现窗口里没有自己要的
 * 那段时，可以直接 `read <targetId> offset=<行号>`，一次到位，而不是全文翻。
 */
export function buildOutline(lines, { limit = 80 } = {}) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const md = MD_HEADING_RE.exec(line);
    if (md) {
      out.push({ line: i + 1, label: `${'#'.repeat(line.match(/^#+/)[0].length)} ${md[1]}`.slice(0, 90) });
      if (out.length >= limit) return out;
      continue;
    }
    if (/^\s{1,}\S/.test(line)) continue; // 只看顶层，缩进的不进大纲
    for (const re of DECL_PATTERNS) {
      const hit = re.exec(line);
      if (hit) {
        out.push({ line: i + 1, label: `decl ${hit[1]}` });
        break;
      }
    }
    if (out.length >= limit) return out;
  }
  return out;
}

/** 行号窗口 → 合并后的有序区间（1-based，闭区间）。 */
function mergeRanges(ranges) {
  const sorted = ranges.filter(([a, b]) => a <= b).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * 生成 excerpt。
 *
 * @param {string} fileText  目标文件全文（oldText 的判据仍在全文上，见 anchorExists）
 * @param {object} opts
 * @param {string} [opts.targetId]  展示用（相对仓库根的路径）
 * @param {Array}  [opts.anchors]   extractAnchors() 的结果
 * @param {number} [opts.budget]    excerpt 总字符上限
 * @param {number} [opts.window]    每个锚点前后各取多少行
 * @returns {{text:string, mode:'full'|'windows'|'outline', chars:number,
 *            ranges:Array<[number,number]>, totalLines:number,
 *            anchorHits:number, outlineSize:number, hint:string}}
 */
export function buildExcerpt(fileText, {
  targetId = '',
  anchors = [],
  budget = 20_000,
  window = 30,
  headLines = 60,
  tailLines = 15,
  outlineLimit = 80,
} = {}) {
  const text = String(fileText ?? '');
  const totalLines = text ? text.split('\n').length : 0;
  if (text.length <= Math.max(1, budget)) {
    return {
      text,
      mode: 'full',
      chars: text.length,
      ranges: totalLines ? [[1, totalLines]] : [],
      totalLines,
      anchorHits: 0,
      outlineSize: 0,
      hint: 'the COMPLETE file — oldText may be copied verbatim from it',
    };
  }

  const lines = text.split('\n');
  // 前缀长度表：算窗口字符数 O(1)，避免每次 join 一遍
  const prefix = new Array(lines.length + 1);
  prefix[0] = 0;
  for (let i = 0; i < lines.length; i += 1) prefix[i + 1] = prefix[i] + lines[i].length + 1;
  const charSpan = (a, b) => prefix[Math.min(b, lines.length)] - prefix[Math.max(a - 1, 0)];

  // ── 1. 锚点 → 行号 ────────────────────────────────────────────────
  const hits = [];
  for (const anchor of Array.isArray(anchors) ? anchors : []) {
    if (anchor.kind === 'line' && Number.isFinite(anchor.line)) {
      hits.push({ line: Math.min(Math.max(1, anchor.line), lines.length), value: anchor.value });
      continue;
    }
    if (anchor.kind === 'path') continue; // 路径搜正文命中率极低，纯噪声
    const needle = String(anchor.value ?? '');
    if (needle.length < MIN_ANCHOR_LEN) continue;
    let found = 0;
    for (let i = 0; i < lines.length && found < HITS_PER_ANCHOR; i += 1) {
      if (lines[i].includes(needle)) {
        hits.push({ line: i + 1, value: needle });
        found += 1;
      }
    }
  }
  // 稀有锚点更具体 ⇒ 先给它们分配窗口（同权重按行号靠前）
  const freq = new Map();
  for (const h of hits) freq.set(h.value, (freq.get(h.value) ?? 0) + 1);
  hits.sort((a, b) => (freq.get(a.value) - freq.get(b.value)) || (a.line - b.line));

  // ── 2. 预算内选窗口 ───────────────────────────────────────────────
  const budgetChars = Math.max(1, budget);
  const outline = buildOutline(lines, { limit: outlineLimit });
  const outlineText = outline.length
    ? [`⟪outline (top-level declarations, 1-based line numbers)⟫`,
      ...outline.map((o) => `${String(o.line).padStart(6)}  ${o.label}`),
      '⟪end outline⟫'].join('\n')
    : '';

  // header + outline + 分隔标记的固定开销先扣掉，剩下的才是正文预算
  const MARKER_RESERVE = 120;
  const headerText = `⟪excerpt of ${targetId || 'target'} — ${totalLines} lines / ${text.length} chars total; NOT the whole file⟫`;
  let remaining = budgetChars - headerText.length - outlineText.length - MARKER_RESERVE;

  const picked = [];
  const take = (a, b) => {
    const cost = charSpan(a, b);
    if (cost > remaining) return false;
    picked.push([a, b]);
    remaining -= cost;
    return true;
  };

  // 先保住头尾（import/shebang 与文件尾声的收尾括号，是「改动合法性」的必需上下文）
  take(1, Math.min(headLines, lines.length));
  if (lines.length > headLines + tailLines) take(lines.length - tailLines + 1, lines.length);
  let anchorHits = 0;
  for (const hit of hits) {
    const a = Math.max(1, hit.line - window);
    const b = Math.min(lines.length, hit.line + window);
    // 已被已有窗口覆盖 ⇒ 计为命中但不再花预算
    if (picked.some(([x, y]) => a >= x && b <= y)) {
      anchorHits += 1;
      continue;
    }
    if (take(a, b)) anchorHits += 1;
  }

  const ranges = mergeRanges(picked);
  // ── 3. 逐字渲染（正文不加任何前缀）─────────────────────────────────
  const parts = [headerText];
  if (outlineText) parts.push(outlineText);
  let cursor = 1;
  for (const [a, b] of ranges) {
    if (a > cursor) parts.push(`⟪omitted lines ${cursor}-${a - 1}⟫`);
    parts.push(...lines.slice(a - 1, b));
    cursor = b + 1;
  }
  if (cursor <= lines.length) parts.push(`⟪omitted lines ${cursor}-${lines.length}⟫`);
  const rendered = parts.join('\n');

  const mode = anchorHits > 0 ? 'windows' : 'outline';
  const hint = anchorHits > 0
    ? `NOT the whole file: ${anchorHits} anchor window(s) + outline. If your anchor is not in the text below, ` +
      `read the outline's line number and re-read that range`
    : 'NOT the whole file: no anchor from the proposal was found in it — only the outline and the head/tail are shown';
  return {
    text: rendered.length <= budgetChars ? rendered : rendered.slice(0, budgetChars),
    mode,
    chars: Math.min(rendered.length, budgetChars),
    ranges,
    totalLines,
    anchorHits,
    outlineSize: outline.length,
    hint,
  };
}

export default { extractAnchors, buildOutline, buildExcerpt };
