/**
 * agint-dream: dreaming sweep core.
 *
 * A nightly (or manual) background consolidation pass over DSH session logs,
 * adapted from OpenClaw memory-core's dreaming model to 智进's own reality:
 *
 *   Light  — read recent session logs (zstd jsonl), collect raw signals:
 *            user utterances, in-session memory_write records, tool errors.
 *   REM    — heuristic extraction of durable candidates (preference/decision/
 *            lesson/pattern sentences) from user utterances, deduped against
 *            existing memory.
 *   Deep   — weighted scoring (OpenClaw six-signal formula, adapted weights),
 *            threshold gates, optional promotion into agint.memory, and a
 *            human-readable dream diary under <diaryRoot>/YYYY-MM-DD.md.
 *
 * Everything here is deterministic and dependency-light: session parsing uses
 * the `zstd` CLI (present on this host), scoring is pure arithmetic, and the
 * only external service touched is `agint.memory` (injected at sweep time).
 * The intelligence stays in the model — this pass catches what explicit
 * memory_write missed, and the diary is written for a human/agent to read.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';

const execFileAsync = promisify(execFile);

// ── defaults (OpenClaw-adapted; see wiki/参考/openclaw-dreaming.md) ────────

export const DEFAULTS = {
  // Session log discovery. sessionsRoot defaults to ~/.dsh/sessions.
  // Three lookback windows mirror OpenClaw dreaming phases:
  //   lightLookbackDays   (Light, 2d)  — candidate extraction window
  //   remLookbackDays     (REM, 7d)    — reinforcement: cross-day consolidation
  //   deepRecoveryDays    (Deep, 30d)  — historical backfill for high-frequency
  //                                      candidates that were never promoted
  lookbackDays: 2,          // alias for lightLookbackDays (kept for compat)
  lightLookbackDays: 2,
  remLookbackDays: 7,
  deepRecoveryDays: 30,
  maxSessions: 60,          // cap on scanned sessions per sweep
  // Candidate extraction
  maxCandidateChars: 220,   // trimmed candidate sentence length cap
  // Scoring weights — OpenClaw formula, weights unchanged.
  weights: {
    relevance: 0.30,
    frequency: 0.24,
    diversity: 0.15,
    recency: 0.15,
    consolidation: 0.10,
    conceptual: 0.06,
  },
  recencyHalfLifeDays: 14,  // e^(-ln2 * ageDays / halfLife)
  // Threshold gates — aligned with OpenClaw per 2026-08-18 老板决策
  // (0.75 / 3 / 2). 启发式候选仍提，过门控的更精。
  minScore: 0.75,
  minRecall: 3,             // signal occurrences across messages
  minUniqueSessions: 2,     // distinct sessions that surfaced it
  // Dedupe
  dedupeTokenOverlap: 0.6,  // normalized token overlap → considered covered
};

const DAY_MS = 24 * 60 * 60 * 1000;

const clamp = (v) => Math.max(0, Math.min(1, v));

// ── Light: session signal collection ───────────────────────────────────────

const SESSION_LOG_GLOB = 'session.jsonl.zstd';

export async function listSessionLogs(sessionsRoot, lookbackDays, maxSessions) {
  const root = resolve(sessionsRoot);
  const workspaces = await readdir(root, { withFileTypes: true }).catch(() => []);
  const logs = [];
  const cutoff = Date.now() - lookbackDays * DAY_MS;
  // Sessions are stored two levels deep: <root>/<workspace>/<session-id>/session.jsonl.zstd
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const wsDir = join(root, ws.name);
    const sessionDirs = await readdir(wsDir, { withFileTypes: true }).catch(() => []);
    for (const dir of sessionDirs) {
      if (!dir.isDirectory()) continue;
      const logPath = join(wsDir, dir.name, SESSION_LOG_GLOB);
      const st = await stat(logPath).catch(() => null);
      if (!st) continue;
      if (st.mtimeMs < cutoff) continue;
      logs.push({ dir: dir.name, path: logPath, mtimeMs: st.mtimeMs });
    }
  }
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return logs.slice(0, maxSessions);
}

export async function readSessionLog(logPath) {
  const { stdout } = await execFileAsync('zstd', ['-dc', logPath], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  }).catch((err) => {
    throw new Error(`zstd -dc ${basename(logPath)} failed: ${err.message}`);
  });
  return stdout.split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function extractText(record) {
  if (typeof record?.text === 'string') return record.text;
  if (Array.isArray(record?.content)) {
    return record.content
      .map((c) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .join(' ');
  }
  return '';
}

/**
 * Collect per-session signals from one parsed log.
 * Returns { sessionKey, title, time, userTexts, memWrites, errors, toolCalls }.
 */
export function collectSessionSignals(records) {
  const sessionKey = records.find((r) => r?.type === 'session')?.id ?? 'unknown';
  const userTexts = [];
  const memWrites = [];
  const errors = [];
  const times = [];
  for (const rec of records) {
    const t = rec?.time ?? rec?.seq ?? 0;
    if (rec?.type === 'user/message') {
      // Only real human utterances are signals. DSH injects skill-catalog /
      // system-reminder blocks as user/message events with other source kinds.
      const kind = rec.data?.source?.kind;
      if (kind && kind !== 'user') continue;
      const text = extractText(rec.data).trim();
      if (text) userTexts.push({ text, time: t });
    } else if (rec?.type === 'tool/call' && rec.data?.name === 'memory_write') {
      let args = {};
      try { args = JSON.parse(rec.data.arguments ?? '{}'); } catch { /* ignore */ }
      if (args?.content) memWrites.push({ content: String(args.content), time: t });
    } else if (rec?.type === 'tool/result') {
      const text = extractText(rec.data?.message) || extractText(rec.data);
      if (/error|failed|denied|sandbox|exit code: [1-9]|deny/i.test(text)) {
        const line = text.replace(/\s+/g, ' ').trim().slice(0, 260);
        if (line) errors.push({ text: line, time: t });
      }
    }
    if (t) times.push(t);
  }
  return {
    sessionKey,
    userTexts,
    memWrites,
    errors,
    startTime: times.length ? Math.min(...times) : 0,
    endTime: times.length ? Math.max(...times) : 0,
  };
}

// ── REM: candidate extraction (heuristic, deterministic) ───────────────────

// Preference/decision/lesson keyword buckets. A sentence is only promoted if
// it matches at least one bucket; the matched bucket steers the memory type.
const SIGNAL_RULES = [
  {
    type: 'preference',
    weight: 1.0,
    re: /(我喜欢|我希望|我偏好|更喜欢|希望以后|以后就|记得|别忘了|称呼|叫我|讨厌|不喜欢|更愿意|愿意|要求)/,
  },
  {
    type: 'decision',
    weight: 1.0,
    re: /(决定|决定用|采用|选用|换成|改用|用.*方案|方案.*用|以后用|改成|命名|叫它|从今往后|弃用|停用|不再用|统一用|迁移到|搬到)/,
  },
  {
    type: 'lesson',
    weight: 1.0,
    re: /(禁止|不要|别|千万别|切记|务必|一定不要|不可以|不能.*就|教训|踩坑|危险|小心|注意.*不要)/,
  },
  {
    type: 'pattern',
    weight: 0.8,
    re: /(习惯|规律|每次|总是|通常|一般会|先.*再|流程|套路|方法论|思路|工作模式|思维模式|行为模式)/,
  },
];

const NOISE_RE = /^(你好|hi|hello|谢谢|好的|嗯|嗯嗯|再见|bye|在吗|ok|okay|收到|明白了?)$/i;

// Questions often carry no '？' in Chinese; any interrogative word marks the
// utterance as a request, not a durable statement.
const QUESTION_RE = /(什么|怎么|为什么|如何|哪[些个]|是不是|能不能|可不可以|有没有|可不可以|多少|谁|吗$|呢$|吧$|能.*吗)/;

// Vague filler that carries no durable claim.
const VAGUE_RE = /(某种|一些|类似|好像是|大概是|某种程度|什么的)/;

function splitSentences(text) {
  return text
    .split(/[。！？!?；;\n]+/)
    .map((s) => s.replace(/[“”"']/g, '').trim())
    .filter((s) => s.length >= 6 && s.length <= 160);
}

function normalizeForCompare(text) {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

// Character-bigram Jaccard for similarity: works on CJK (no whitespace) and
// Latin (treated as character bag). Whitespace and punctuation are stripped
// so the comparison is shape-based, not implementation-based.
function tokenOverlap(a, b) {
  const grams = (s) => {
    const cleaned = s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
    const out = new Set();
    if (cleaned.length < 2) { if (cleaned) out.add(cleaned); return out; }
    for (let i = 0; i < cleaned.length - 1; i++) out.add(cleaned.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let hit = 0;
  for (const t of ga) if (gb.has(t)) hit += 1;
  const union = ga.size + gb.size - hit;
  return union === 0 ? 0 : hit / union;
}

/**
 * Extract durable candidates from one session's collected signals.
 * Each candidate: { text, type, sessionKey, time, signals: [...] }.
 * memWrites are returned separately (already consolidated; diary-only).
 */
export function extractCandidates(session, nowMs = Date.now()) {
  const candidates = [];
  const seen = new Set();
  for (const { text, time } of session.userTexts) {
    if (NOISE_RE.test(text.trim())) continue;
    const base = text.replace(/^老板[，,\s]*/, '').trim();
    if (base.length < 6) continue;
    for (const sentence of splitSentences(base)) {
      if (/[?？]$/.test(sentence)) continue;         // questions are not statements
      if (QUESTION_RE.test(sentence)) continue;      // interrogatives without '?'
      if (VAGUE_RE.test(sentence)) continue;         // vague filler, no durable claim
      if (/\b(为什么|怎么|如何|能否|能不能|可以吗)\b/.test(sentence)) continue;
      const key = normalizeForCompare(sentence);
      if (seen.has(key)) continue;
      seen.add(key);
      for (const rule of SIGNAL_RULES) {
        if (rule.re.test(sentence)) {
          candidates.push({
            text: sentence.slice(0, DEFAULTS.maxCandidateChars),
            type: rule.type,
            sessionKey: session.sessionKey,
            time: time || nowMs,
            signals: [sentence],
          });
          break;
        }
      }
    }
  }
  for (const { text, time } of session.errors) {
    candidates.push({
      text: `工具执行报错：${text}`.slice(0, DEFAULTS.maxCandidateChars),
      type: 'lesson',
      sessionKey: session.sessionKey,
      time: time || nowMs,
      signals: [text],
    });
  }
  return candidates;
}

// ── Deep: scoring, gating, dedupe, promotion ───────────────────────────────

function ageDays(ms, nowMs) {
  return Math.max(0, (nowMs - ms) / DAY_MS);
}

function recencyComponent(ms, nowMs, halfLifeDays, maxAgeDays = 180) {
  const age = ageDays(ms, nowMs);
  // Clamp to a max age so a missing/zero/future timestamp degrades to "recent"
  // rather than exp(-∞) = 0. Without this, time=0 candidates score as ancient.
  if (age > maxAgeDays) return 0;
  return Math.exp((-Math.LN2 * age) / halfLifeDays);
}

function conceptualComponent(text) {
  const tags = text.match(/[\u4e00-\u9fffA-Za-z]{2,}/g) ?? [];
  return clamp(tags.length / 6);
}

/**
 * Merge per-message candidates into per-claim candidates (group by normalized
 * text across messages/sessions), then score each with the six-signal formula.
 *
 * opts.reinforcement: extra candidates from a wider window (REM, 7d). Their
 * signals join the group for frequency/consolidation but a `reinforced` flag
 * is kept so callers can tell a Light-window candidate from REM-only noise.
 */
export function scoreCandidates(candidates, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const w = { ...DEFAULTS.weights, ...(opts.weights ?? {}) };
  const halfLife = opts.recencyHalfLifeDays ?? DEFAULTS.recencyHalfLifeDays;
  const reinforcement = opts.reinforcement ?? [];
  // group by normalized text
  const groups = new Map();
  for (const c of candidates) {
    const key = normalizeForCompare(c.text);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { ...c, signals: [], sessions: new Set(), days: new Set(), reinforced: false });
    const g = groups.get(key);
    g.signals.push(...c.signals);
    g.sessions.add(c.sessionKey);
    g.days.add(new Date(c.time).toISOString().slice(0, 10));
    if (c.time < g.time || g.time === 0) g.time = c.time;
  }
  // REM reinforcement: same-claim signals from the wider window strengthen
  // frequency/consolidation but never create a candidate on their own.
  for (const c of reinforcement) {
    const key = normalizeForCompare(c.text);
    if (!key || !groups.has(key)) continue;
    const g = groups.get(key);
    g.reinforced = true;
    g.signals.push(...c.signals);
    g.sessions.add(c.sessionKey);
    g.days.add(new Date(c.time).toISOString().slice(0, 10));
    if (c.time < g.time || g.time === 0) g.time = c.time;
  }
  const scored = [];
  for (const g of groups.values()) {
    const signalCount = g.signals.length;
    const uniqueSessions = g.sessions.size;
    const uniqueDays = g.days.size;
    const frequency = clamp(Math.log1p(signalCount) / Math.log1p(10));
    const diversity = clamp(uniqueSessions / 5);
    const recency = recencyComponent(g.time, nowMs, halfLife);
    const consolidation = clamp(Math.min(1, (uniqueDays - 1) * 0.3 + 0.2));
    const conceptual = conceptualComponent(g.text);
    const relevance = 0.65; // heuristic prior; no retrieval scores in DSH
    const score = clamp(
      w.relevance * relevance +
      w.frequency * frequency +
      w.diversity * diversity +
      w.recency * recency +
      w.consolidation * consolidation +
      w.conceptual * conceptual,
    );
    scored.push({
      ...g,
      sessions: [...g.sessions],
      days: [...g.days].sort(),
      signalCount,
      uniqueSessions,
      uniqueDays,
      frequency,
      diversity,
      recency,
      consolidation,
      conceptual,
      relevance,
      score,
      reinforced: Boolean(g.reinforced),
      components: { relevance, frequency, diversity, recency, consolidation, conceptual },
    });
  }
  scored.sort((a, b) => b.score - a.score || b.signalCount - a.signalCount);
  return scored;
}

/**
 * Filter candidates through threshold gates and existing-memory dedupe.
 * existing: array of { content, type, id } from agint.memory.list().
 */
export function gateCandidates(scored, existing = [], opts = {}) {
  const minScore = opts.minScore ?? DEFAULTS.minScore;
  const minRecall = opts.minRecall ?? DEFAULTS.minRecall;
  const minUnique = opts.minUniqueSessions ?? DEFAULTS.minUniqueSessions;
  const overlap = opts.dedupeTokenOverlap ?? DEFAULTS.dedupeTokenOverlap;
  const existingNorm = existing
    .map((e) => ({ id: e.id, type: e.type, content: e.content, norm: normalizeForCompare(e.content) }))
    .filter((e) => e.norm);
  const kept = [];
  for (const c of scored) {
    if (c.score < minScore) continue;
    if (c.signalCount < minRecall) continue;
    if (c.uniqueSessions < minUnique) continue;
    const norm = normalizeForCompare(c.text);
    let covered = false;
    for (const e of existingNorm) {
      if (!norm || !e.norm) continue;
      if (norm.includes(e.norm) || e.norm.includes(norm)) { covered = true; break; }
      if (tokenOverlap(c.text, e.content) >= overlap) { covered = true; break; }
    }
    if (covered) continue;
    kept.push(c);
  }
  return kept;
}

/** Build the memory entry payload for a gated candidate. */
export function entryFor(candidate, evidence) {
  return {
    type: candidate.type,
    content: candidate.text,
    confidence: clamp(Math.round(candidate.score * 10) / 10),
    evidence: evidence || `agint-dream sweep from ${candidate.sessionKey}`,
  };
}

// ── Diary ──────────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Render the dream diary markdown for one sweep.
 * stages: { day, signals, memWrites, candidates, gated, promoted, recovered,
 *           errors, durationMs, windows? }.
 */
export function renderDiary({ day, signals, memWrites, candidates, gated, promoted, recovered = [], errors = [], durationMs, windows }) {
  const lines = [];
  lines.push(`# 梦境日记 ${day}`);
  lines.push('');
  lines.push(`> 智进夜间梦境 · sweep 耗时 ${(durationMs / 1000).toFixed(1)}s · 模式：后台记忆整合（light→REM→deep）`);
  if (windows) lines.push(`> 窗口：Light ${windows.light}d / REM ${windows.rem}d / Deep恢复 ${windows.deep}d`);
  lines.push('');
  lines.push('## Light — 信号采集');
  lines.push('');
  lines.push(`- 扫描会话：${signals.length} 个`);
  lines.push(`- 用户消息信号：${signals.reduce((n, s) => n + s.userTexts.length, 0)} 条`);
  lines.push(`- 会话内 memory_write（已沉淀，不再重复提升）：${memWrites.length} 条`);
  lines.push(`- 工具错误信号：${signals.reduce((n, s) => n + s.errors.length, 0)} 条`);
  lines.push('');
  if (memWrites.length > 0) {
    lines.push('### 当日已沉淀记忆（会话中显式写入）');
    lines.push('');
    for (const m of memWrites.slice(0, 20)) lines.push(`- ${m.content.slice(0, 140)}`);
    lines.push('');
  }
  lines.push('## REM — 候选提炼');
  lines.push('');
  lines.push(`- 启发式候选：${candidates.length} 条（偏好/决策/教训/规律）`);
  lines.push('- REM 强化：跨 7 天窗口的信号并入评分（提高 frequency/consolidation），不单独产生候选');
  lines.push('');
  lines.push('## Deep — 评分与提升');
  lines.push('');
  lines.push(`- 门槛通过候选：${gated.length} 条`);
  lines.push(`- 提升写入记忆：${promoted.length} 条`);
  lines.push('');
  if (gated.length > 0) {
    lines.push('| # | 类型 | 得分 | 信号 | 天数 | 强化 | 候选内容 |');
    lines.push('|---|------|------|------|------|------|----------|');
    gated.forEach((c, i) => {
      lines.push(`| ${i + 1} | ${c.type} | ${c.score.toFixed(2)} | ${c.signalCount} | ${c.uniqueDays} | ${c.reinforced ? '✓' : ''} | ${c.text.replace(/\|/g, '\\|').slice(0, 80)} |`);
    });
    lines.push('');
  }
  if (recovered.length > 0) {
    lines.push('### Deep 恢复通道（30 天回填，信号≥3 且跨天≥2）');
    lines.push('');
    lines.push('| # | 类型 | 得分 | 信号 | 天数 | 候选内容 |');
    lines.push('|---|------|------|------|------|----------|');
    recovered.forEach((c, i) => {
      lines.push(`| ${i + 1} | ${c.type} | ${c.score.toFixed(2)} | ${c.signalCount} | ${c.uniqueDays} | ${c.text.replace(/\|/g, '\\|').slice(0, 80)} |`);
    });
    lines.push('');
  }
  if (promoted.length > 0) {
    lines.push('### 提升明细');
    lines.push('');
    for (const p of promoted) {
      lines.push(`- **[${p.entry.type}]** (conf ${p.entry.confidence}) ${p.entry.content}`);
      lines.push(`  - evidence: ${p.entry.evidence} · score=${p.candidate.score.toFixed(2)}`);
    }
    lines.push('');
  }
  if (errors.length > 0) {
    lines.push('## 本次 sweep 异常');
    lines.push('');
    for (const e of errors) lines.push(`- ${e}`);
    lines.push('');
  }
  lines.push('## 次日建议');
  lines.push('');
  lines.push('- 读一遍上表候选：值得进记忆但启发式漏掉的，手动 memory_write 补上');
  lines.push('- 低分候选（< 门槛）若反复出现，说明是稳定偏好，提高权重或手动固化');
  lines.push('');
  lines.push('_由 agint-dream 自动生成 · 来源会话日志 ~/.dsh/sessions_');
  return lines.join('\n');
}

// ── Sweep orchestrator (used by the host service and by tests) ─────────────

/**
 * Run one full sweep with the OpenClaw three-window phase model:
 *
 *   Light — extract candidates from sessions in the last `lightLookbackDays`
 *           (default 2d).
 *   REM   — reinforce the same claims from sessions in the last
 *           `remLookbackDays` (default 7d): cross-day signals strengthen
 *           frequency/consolidation but never create candidates on their own.
 *   Deep  — gate + promote, then a historical recovery lane scans
 *           `deepRecoveryDays` (default 30d) and re-considers claims that
 *           accumulated >= 3 signals across >= 2 days but were never promoted.
 *
 * ctx: { sessionsRoot, diaryRoot, nowMs?, apply?: boolean, lookbackDays?,
 *        remLookbackDays?, deepRecoveryDays?, recover?, maxSessions?,
 *        minScore?, minRecall?, minUniqueSessions? }
 * memory: agint.memory service (or a stub with list()/write()).
 * Returns a structured report (JSON-safe; no live handles).
 */
export async function runSweep({
  sessionsRoot,
  diaryRoot,
  memory,
  nowMs = Date.now(),
  apply = false,
  lookbackDays,
  remLookbackDays,
  deepRecoveryDays,
  recover = true,
  maxSessions,
  minScore,
  minRecall,
  minUniqueSessions,
}) {
  const startedAt = Date.now();
  const errors = [];
  const day = fmtDay(nowMs);
  const lightDays = lookbackDays ?? DEFAULTS.lookbackDays;
  const remDays = remLookbackDays ?? DEFAULTS.remLookbackDays;
  const cap = maxSessions ?? DEFAULTS.maxSessions;

  // ── Light: candidate extraction window (2d) ─────────────────────────────
  const lightLogs = await listSessionLogs(sessionsRoot, lightDays, cap);
  const signals = [];
  for (const log of lightLogs) {
    try {
      signals.push(collectSessionSignals(await readSessionLog(log.path)));
    } catch (err) {
      errors.push(`${log.dir}: ${err.message}`);
    }
  }
  const memWrites = signals.flatMap((s) => s.memWrites.map((m) => ({ ...m, session: s.sessionKey })));
  const candidates = signals.flatMap((s) => extractCandidates(s, nowMs));

  // ── REM: reinforcement window (7d) — cross-day strength, no new claims ──
  let reinforcement = [];
  if (remDays > lightDays) {
    const remLogs = await listSessionLogs(sessionsRoot, remDays, cap);
    const remSignals = [];
    for (const log of remLogs) {
      try {
        remSignals.push(collectSessionSignals(await readSessionLog(log.path)));
      } catch (err) {
        errors.push(`${log.dir}(rem): ${err.message}`);
      }
    }
    reinforcement = remSignals.flatMap((s) => extractCandidates(s, nowMs));
  }
  const scored = scoreCandidates(candidates, { nowMs, reinforcement });

  // ── Deep: gate + promote ────────────────────────────────────────────────
  const existing = memory ? await memory.list({}) : [];
  const gated = gateCandidates(scored, existing, { minScore, minRecall, minUniqueSessions });
  const promoted = [];
  if (apply && memory) {
    for (const candidate of gated) {
      try {
        const entry = entryFor(candidate, `agint-dream ${day} from ${candidate.sessionKey}`);
        const saved = await memory.write(entry);
        promoted.push({ candidate, entry: { id: saved.id, type: saved.type, content: saved.content, confidence: saved.confidence, evidence: saved.evidence } });
      } catch (err) {
        errors.push(`promote failed: ${err.message}`);
      }
    }
  }

  // ── Deep recovery lane (30d backfill): high-frequency claims never promoted
  const recovered = [];
  if (recover && memory) {
    const recDays = deepRecoveryDays ?? DEFAULTS.deepRecoveryDays;
    if (recDays > remDays) {
      const recLogs = await listSessionLogs(sessionsRoot, recDays, cap);
      const recSignals = [];
      for (const log of recLogs) {
        try {
          recSignals.push(collectSessionSignals(await readSessionLog(log.path)));
        } catch (err) {
          errors.push(`${log.dir}(recover): ${err.message}`);
        }
      }
      const recScored = scoreCandidates(recSignals.flatMap((s) => extractCandidates(s, nowMs)), { nowMs });
      const recGated = gateCandidates(
        recScored.filter((c) => c.signalCount >= 3 && c.uniqueDays >= 2),
        existing,
        { minScore: minScore ?? DEFAULTS.minScore, minRecall: 3, minUniqueSessions: 2 },
      );
      if (apply) {
        for (const candidate of recGated) {
          try {
            const entry = entryFor(candidate, `agint-dream ${day} deep-recovery from ${candidate.sessionKey}`);
            const saved = await memory.write(entry);
            promoted.push({ candidate, entry: { id: saved.id, type: saved.type, content: saved.content, confidence: saved.confidence, evidence: saved.evidence } });
          } catch (err) {
            errors.push(`recover promote failed: ${err.message}`);
          }
        }
      }
      recovered.push(...recGated);
    }
  }

  // ── Diary ───────────────────────────────────────────────────────────────
  const diary = renderDiary({
    day,
    signals,
    memWrites,
    candidates,
    gated,
    promoted,
    recovered,
    errors,
    durationMs: Date.now() - startedAt,
    windows: { light: lightDays, rem: remDays, deep: deepRecoveryDays ?? DEFAULTS.deepRecoveryDays },
  });
  await mkdir(resolve(diaryRoot), { recursive: true });
  const diaryPath = join(resolve(diaryRoot), `${day}.md`);
  await writeFile(diaryPath, diary, 'utf8');

  return {
    day,
    diaryPath,
    apply,
    counts: {
      sessions: signals.length,
      userMessages: signals.reduce((n, s) => n + s.userTexts.length, 0),
      memWrites: memWrites.length,
      toolErrors: signals.reduce((n, s) => n + s.errors.length, 0),
      candidates: scored.length,
      gated: gated.length,
      recovered: recovered.length,
      promoted: promoted.length,
    },
    promoted: promoted.map((p) => ({ type: p.entry.type, content: p.entry.content, score: p.candidate.score, id: p.entry.id })),
    errors,
    durationMs: Date.now() - startedAt,
  };
}
