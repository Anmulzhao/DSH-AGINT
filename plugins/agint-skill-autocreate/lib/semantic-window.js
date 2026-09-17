/**
 * semantic-window — 用「本地会话文本窗口」给技能提案填语义（Phase 2）。
 *
 * 设计依据：2026-09-17《技能生成-分治架构设计.md》§5.2 —
 *   「Phase 1/2（dream LLM 未证实时先本地做）：autocreate 直接
 *     extractTextWindows(sessionLog, anchor) 取文本窗口，喂给本地提案器填
 *     `## 为什么 / 坑` 段落。」
 *
 * 为什么现在就要本地兜底：dream 的 Deep/LLM 通路至今 `promoted=0`、从未真跑过
 * （论证 §2.3）。在它证实前把提案语义质量押上去 = 把未验证路径当依赖。
 *
 * 两条硬约束：
 *   ① **零 LLM、零外部服务**：只做「会话日志 → 文本片段 → markdown 段」的
 *      确定性变换。判据外部化（正则/集合），可单测锚定。
 *   ② **只搬运、不编造**：渲染进正文的每一句都必须是窗口里**真实出现过**的
 *      文本片段（裁剪过、但未改写）。这是与旧模板（固定话术 + 工具名）的本质
 *      区别，也是 A3 判据 `non-informative-body` / `tool-recap-only` 能过的前提。
 *
 * 分层：
 *   - `createWindowLoader` / `loadSemanticWindow` —— I/O 层（读会话日志）
 *   - `extractSemanticEvidence` / `renderSemanticSections` —— 纯函数层（可单测）
 */

import { loadSession, extractTextWindows, findSessionLog } from '../../agint-session-extract/index.js';

// ── 纯函数层 ────────────────────────────────────────────────────────────

/** 人类意图句特征（WHY 的候选来源：用户在说「要做什么/为什么」） */
export const INTENT_RE = /(帮我|请你?|麻烦|需要|要|想要|检查|确认|核实|修|改|加|去掉|为什么|目的|目标|为了|先.{0,24}(?:再|然后)|然后|接下来|注意|务必|必须|别|不要|please|need to|should|want to|why|goal|make sure|instead of)/i;

/** 助手侧「为什么这么做」的解释句特征（次选来源） */
export const RATIONALE_RE = /(因为|所以|原因是|原因是|目的是|为了|否则|会导致|关键在于|本质|根因|注意|坑|风险|这里的问题|why|because|so that|the reason|root cause|the catch)/i;

/** 工具结果里的「坑」特征（错误行） */
export const PITFALL_RE = /(\bError\b|\berror:|\bERROR\b|exit code\s+\d+|\b(?:ENOENT|EACCES|EPERM|EADDRINUSE|ECONNREFUSED|ETIMEDOUT)\b|\bERR_[A-Z_]+\b|Traceback|not found|No such file|command not found|(?:失败|报错|异常|不生效|拒绝访问))/;

/** 无信息量行（工具结果的模板噪声，不该进正文） */
const NOISE_RE = /^(?:<path>.*<\/path>|<type>.*<\/type>|Updated todo list:|Todo written|\s*)$/;

/**
 * 机器写的「伪人类消息」开场白。
 *
 * ⚠️ 实测（2026-09-17 Phase 2 验收）：`data.source.kind === 'user'` **不等于**「人说的话」——
 * memory-consolidation 等 subagent 的提示词同样以 `user/message` + `kind:'user'` 落盘
 * （真实样本开头："You are a memory consolidation agent for the 智进 (Zhijin) AI worker."，
 * 2514/34321 字符）。结构上与真人类消息无法区分，只能落到文本形态：
 * 这些开场白是人不会写的。**宁可漏掉一条罕见真消息**（退回助手侧兜底），
 * 也不能把机器提示词当用户意图写进技能正文。
 */
export const MACHINE_PROMPT_RE = /^(?:<skill_content|<path>|You are\b|Your job\b|Your task\b|You must\b|Current runtime context\b|System prompt\b)/i;

/** 意图句里的「泛化问句」——回答「好不好/要不要」的问题句不含可复用方法 */
const QUESTION_ONLY_RE = /^[^。！？\n]{0,80}[？?]\s*$/;

const MIN_SENTENCE_CHARS = 8;

/** 按句末标点切句（保留中文标点） */
function sentences(text) {
  return String(text ?? '')
    .split(/(?<=[。；;！？!?])|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 收敛空白 + 裁剪（保留可读性） */
export function condense(text, maxChars = 180) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars - 1)}…`;
}

/** 条目 → 纯文本 */
function entryText(e) {
  return typeof e === 'string' ? e : String(e?.text ?? '');
}

/** 条目角色（withMeta 时可用；裸字符串视为 unknown） */
function entryRole(e) {
  return typeof e === 'string' ? 'unknown' : (e?.role ?? 'unknown');
}

/** 条目来源 kind（user/message 的 data.source.kind） */
function entryKind(e) {
  return typeof e === 'string' ? null : (e?.kind ?? null);
}

/**
 * 该条目是否可当作「人类说的话」。
 * 关键：user/message 里混着 subagent prompt、plugin 注入、skill-catalog 等
 * （实测 kind 分布 user / plugin / skill-catalog / agent-instructions /
 *   subagent-settled / agent-message）。只认 kind===null（旧格式）或 'user'，
 * 否则会把系统注入当用户意图写进技能正文——这正是 dream 侧踩过的坑。
 */
export function isHumanUtterance(e, text = entryText(e)) {
  if (entryRole(e) !== 'user') return false;
  const k = entryKind(e);
  if (k != null && k !== 'user') return false;
  const t = String(text ?? '').trim();
  if (!t) return false;
  return !MACHINE_PROMPT_RE.test(t);
}

/**
 * 从文本窗口抽取语义证据（纯函数）。
 *
 * @param {{before?: any[], after?: any[]}} win  extractTextWindows(withMeta) 的输出
 * @param {object} [opts] { maxWhy, maxPitfalls, maxChars }
 * @returns {{why: string[], pitfalls: string[], humanTurns: number, hasWindow: boolean}}
 */
export function extractSemanticEvidence(win, opts = {}) {
  const maxWhy = opts.maxWhy ?? 3;
  const maxPitfalls = opts.maxPitfalls ?? 3;
  const maxChars = opts.maxChars ?? 180;
  const entries = [...(win?.before ?? []), ...(win?.after ?? [])];
  const why = [];
  const pitfalls = [];
  const seen = new Set();
  let humanTurns = 0;

  const push = (arr, line) => {
    const t = condense(line, maxChars);
    if (!t || t.length < MIN_SENTENCE_CHARS) return;
    const key = t.slice(0, 60);
    if (seen.has(key)) return;
    seen.add(key);
    arr.push(t);
  };

  // ── WHY：优先真人类消息的意图句 ──
  for (const e of entries) {
    if (why.length >= maxWhy) break;
    if (!isHumanUtterance(e, entryText(e))) continue;
    humanTurns++;
    // 先剔掉「纯问句」再选——注意 fallback 也必须落在这个过滤后的集合里，
    // 否则被过滤掉的问句会被 `?? sents[0]` 又捡回来（踩过）。
    const candidates = sentences(entryText(e)).filter((s) => !NOISE_RE.test(s) && !QUESTION_ONLY_RE.test(s));
    const hit = candidates.find((s) => INTENT_RE.test(s)) ?? candidates[0];
    if (hit) push(why, hit);
  }

  // ── WHY 次选：助手侧解释「为什么这么做」的句子 ──
  if (why.length < maxWhy) {
    for (const e of entries) {
      if (why.length >= maxWhy) break;
      if (entryRole(e) !== 'assistant') continue;
      const sents = sentences(entryText(e)).filter((s) => !NOISE_RE.test(s));
      const hit = sents.find((s) => RATIONALE_RE.test(s));
      if (hit) push(why, hit);
    }
  }

  // ── 坑：工具结果里的错误行 ──
  for (const e of entries) {
    if (pitfalls.length >= maxPitfalls) break;
    if (entryRole(e) !== 'tool') continue;
    for (const line of String(entryText(e)).split('\n')) {
      if (pitfalls.length >= maxPitfalls) break;
      const t = line.trim();
      if (!t || NOISE_RE.test(t)) continue;
      if (PITFALL_RE.test(t)) push(pitfalls, t);
    }
  }

  return { why, pitfalls, humanTurns, hasWindow: entries.length > 0 };
}

/**
 * 语义证据 → markdown 段（纯函数）。
 * **无内容则返回空串**——宁缺毋滥，绝不拿固定话术凑字数
 * （那正是被 A3 `non-informative-body` 拦下的形态）。
 */
export function renderSemanticSections(evidence) {
  const why = evidence?.why ?? [];
  const pitfalls = evidence?.pitfalls ?? [];
  const out = [];
  if (why.length) {
    out.push('## 为什么', ...why.map((w) => `- ${w}`), '');
  }
  if (pitfalls.length) {
    out.push('## 避坑', ...pitfalls.map((p) => `- 曾遇到：${p}`), '');
  }
  return out.join('\n');
}

// ── I/O 层 ──────────────────────────────────────────────────────────────

/**
 * 单次窗口加载（无缓存）。返回
 * { ok, reason?, before, after, sessionId, turn }。
 * 任何失败都降级返回 `ok:false`，绝不抛——提案层据此退回纯模板。
 */
export async function loadSemanticWindow({
  sessionsRoot, anchor, radius = 4, maxChars = 4000, loader = null,
} = {}) {
  if (!anchor?.sessionId) return { ok: false, reason: 'no-anchor', before: [], after: [] };
  try {
    if (loader) return await loader(anchor, { radius, maxChars });
    const log = await findSessionLog(sessionsRoot, anchor.sessionId);
    if (!log) return { ok: false, reason: 'session-log-not-found', before: [], after: [] };
    const events = await loadSession(log.path);
    const win = extractTextWindows(events, { turn: anchor.turn, step: anchor.step }, radius, { withMeta: true });
    return clipWindow({ ...win, ok: true, sessionId: anchor.sessionId, turn: anchor.turn }, maxChars);
  } catch (e) {
    return { ok: false, reason: `load-error:${e?.message ?? e}`, before: [], after: [] };
  }
}

/** 总字符预算裁剪：先保 before 尾部（紧邻锚点），再补 after 头部。 */
export function clipWindow(win, maxChars) {
  const budget = Math.max(200, maxChars ?? 4000);
  let used = 0;
  const take = (arr, reverse) => {
    const out = [];
    const seq = reverse ? [...arr].reverse() : arr;
    for (const e of seq) {
      const len = entryText(e).length;
      if (used + len > budget) break;
      used += len;
      out.push(e);
    }
    return reverse ? out.reverse() : out;
  };
  const before = take(win.before ?? [], true);
  const after = take(win.after ?? [], false);
  return { ...win, before, after, chars: used };
}

/**
 * 带会话缓存的窗口加载器（detect 一次要处理多个 pattern，
 * 同一会话反复解压是纯浪费）。
 *
 * 返回 { load(anchor) → Promise<window>, stats(), reset() }。
 */
export function createWindowLoader({ sessionsRoot, radius = 4, maxChars = 4000, maxSessions = 40 } = {}) {
  const cache = new Map();          // sessionId → { events } | { error }
  const stat = { requested: 0, hit: 0, miss: 0, loaded: 0, failed: 0 };

  async function eventsOf(sessionId) {
    if (cache.has(sessionId)) return cache.get(sessionId);
    if (cache.size >= maxSessions) cache.clear();   // 简单容量护栏
    let rec;
    try {
      const log = await findSessionLog(sessionsRoot, sessionId);
      if (!log) rec = { error: 'session-log-not-found' };
      else { rec = { events: await loadSession(log.path) }; stat.loaded++; }
    } catch (e) {
      rec = { error: `load-error:${e?.message ?? e}` };
      stat.failed++;
    }
    cache.set(sessionId, rec);
    return rec;
  }

  return {
    async load(anchor) {
      stat.requested++;
      if (!anchor?.sessionId) return { ok: false, reason: 'no-anchor', before: [], after: [] };
      const rec = await eventsOf(anchor.sessionId);
      if (rec.error) return { ok: false, reason: rec.error, before: [], after: [] };
      stat.hit++;
      const win = extractTextWindows(rec.events, { turn: anchor.turn, step: anchor.step }, radius, { withMeta: true });
      return clipWindow({ ...win, ok: true, sessionId: anchor.sessionId, turn: anchor.turn }, maxChars);
    },
    stats: () => ({ ...stat, cached: cache.size }),
    reset: () => { cache.clear(); stat.requested = 0; stat.hit = 0; stat.miss = 0; stat.loaded = 0; stat.failed = 0; },
  };
}
