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

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
// v0.2 (task 2 / C2 / 2026-09-06)：REM 阶段调 qualityEvaluator 评估核心 plugin
import { resolveEvalTargets, evaluatePlugins } from './quality-bridge.js';
// v0.3 (task 3 / 2026-09-06)：Deep 阶段读 success-templates 作为评分参考
import { collectEvolutionSummary, computeEvolutionBoost } from './evolution-bridge.js';
// 2026-09-18：零命中健康度（连续 N 次扫不到会话 → degraded 告警）
import {
  DEFAULT_ZERO_HIT_THRESHOLD,
  evaluateZeroHitHealth,
  readHealthState,
  updateZeroHitState,
  writeHealthState,
} from './health.js';
import {
  recordRecalls as recallStoreRecord,
  readStoreRobust as recallStoreRead,
  markPromoted as recallStoreMarkPromoted,
  pruneStore as recallStorePrune,
  defaultRecallPath,
  recallKey,
} from './recall-store.js';
import { validateAndApply, planToWriteCalls } from './validation-gate.js';
import { consolidate, consolidateBatched, DEFAULT_BATCH_SIZE } from './consolidation.js';
// D1 迁移（2026-10-21）：会话内容读统一走 session-source（上游优先 + 回落出声）
import { createSessionSource } from '../../agint-session-source/lib/index.mjs';

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
  // Threshold gates — 2026-09-18 recalibrated from OpenClaw alignment (0.75/3/2).
  // 依据：09-17/09-18 只读复算，候选 score 实际区间 0.483~0.608，0.75 在本机
  // 数据形态下不可达（无检索 relevance、无 phaseBoost，relevance 封顶 0.195），
  // 自 09-08 起 0 过门 → LLM consolidation 一次都没被触发（排在门槛之后）。
  // 0.60 只放行「≥3 信号 + 跨 ≥2 会话 + 新鲜」的真重复候选（今日实测 1/20），
  // 单会话低频候选仍被 minRecall/minUniqueSessions 拦住。可回滚：cordis.patch.yml
  // agint-dream config.minScore 可覆盖；观察期 1 周，量级异常（>5/日 或持续 0）再调。
  minScore: 0.6,
  minRecall: 3,             // signal occurrences across messages
  minUniqueSessions: 2,     // distinct sessions that surfaced it
  // Dedupe
  dedupeTokenOverlap: 0.6,  // normalized token overlap → considered covered
  // ── 分级去重（2026-09-21，proposals/agint-dream-dedupe-lineage.md 方案 B）──
  // 背景：候选从会话日志抽，而生产记忆本身就是这些会话沉淀的产物 —— 两者共享
  // 同一份文本来源。单一 0.6 阈值下，existing 越全命中率越高，实测生产 406 条
  // 记忆把 83 条过门候选 **100% 吃掉**（gated 0）。这不是参数调错，是设计闭包。
  //
  // 解法：不替换判据，把「命中后果」从布尔拆成三档 ——
  //   高相似（≥ dedupeHigh）  → 真重复，丢弃（现状行为）
  //   中相似（[mid, high)）   → 疑似重复，**放行**但标 dedupeSuspicion，
  //                             交给本来就在做 add/merge/supersede 判定的
  //                             LLM consolidation 去裁（它已有 loss budget 兜底）
  //   低相似（< dedupeMid）   → 新候选，直接放行
  // kill-switch：dedupeTieredEnabled=false → 完全回退到现状（单一 0.6 布尔判定）。
  dedupeTieredEnabled: true,
  dedupeHigh: 0.85,         // ≥ 此值 = 真重复 → 丢弃
  dedupeMid: 0.6,           // ≥ 此值 = 疑似 → 放行 + 标记（= 原 dedupeTokenOverlap）
  // ── 2026-09-28：工具错误信号「诊断化」过滤（噪音治理）──
  // 背景：extractCandidates 此前把 `session.errors`（工具 stderr 原文）**零过滤**
  // 转成 lesson 候选。09-28 实测：23 条错误信号 → 196 候选里大量是
  // 「工具执行报错：(no output) [exit code: 1]」这类原始输出，score=0.00，
  // 仍被 recall store 收走并 promoted 进长期记忆，稀释 367 条记忆的信噪比。
  // 判据（见 classifyToolError）：原始 stderr 不是主张，**只有说清「为什么 /
  // 应该怎样」的报错才配当教训**。默认开；kill-switch 设 false 即完全回退旧行为。
  //
  // 2026-10-19 收紧：判据从「出现任一诊断关键词」改为「必须出现因果句式」。
  // 旧关键词（schema / invalid / expected / enoent…）在真实 stderr 里几乎必然
  // 出现 —— 10-19 夜里 3 条过门候选全是原始残骸（invalid arguments /
  // GBK 乱码 ParserError / schema 名列表），并以原文进了长期记忆。
  // 状态描述（现在是什么样）不是主张；只有「为什么 / 应该怎样」才配当教训。
  toolErrorDiagnosticOnly: true,
};

const DAY_MS = 24 * 60 * 60 * 1000;

const clamp = (v) => Math.max(0, Math.min(1, v));

// ── Light: session signal collection ───────────────────────────────────────

// 2026-09-17：宿主自 2026-09-10 起把会话日志命名为 `session.v3.jsonl.zstd`，
// 原先的精确名匹配让 Light 通道静默失效 7 天（2 天窗口内扫到 0 个会话，
// 而 dream_status 仍报 validation=OK）。改为候选名优先 + 后缀兜底，
// 使宿主再次改名时不会静默失效。
//
// ⛔ 2026-10-21 修：本表原先只有 v3，**缺 v4**。宿主 2026-09-22 起已用 v4，
// 于是「先试候选名」这一步恒落空，一路走后缀兜底 —— 能发现文件，但同目录并存
// v3/v4 时取哪个变成 readdir 顺序偶然，light/rem/deep 三通道可能读旧格式。
// 这跟 09-22 那次 12 天断供是同一类错：名字表比宿主落后。
// 现在名字表与后缀常量的**唯一真相源**是 agint-session-source（全仓一处），
// 本地不再持有副本 —— 宿主下次改 v5 只需要改那一个文件。
import {
  SESSION_LOG_NAMES_BY_RANK as SESSION_LOG_NAMES,
  SESSION_LOG_SUFFIX,
} from '../../agint-session-source/lib/index.mjs';

/** 定位会话目录下的日志文件：候选名优先，其次按 .jsonl.zstd 后缀兜底。 */
export async function resolveSessionLogPath(wsDir, sessionDirName) {
  const dirPath = join(wsDir, sessionDirName);
  for (const name of SESSION_LOG_NAMES) {
    const p = join(dirPath, name);
    if (await stat(p).catch(() => null)) return p;
  }
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  const hit = entries.find((e) => e.isFile() && e.name.endsWith(SESSION_LOG_SUFFIX));
  return hit ? join(dirPath, hit.name) : null;
}

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
      const logPath = await resolveSessionLogPath(wsDir, dir.name);
      if (!logPath) continue;
      const st = await stat(logPath).catch(() => null);
      if (!st) continue;
      if (st.mtimeMs < cutoff) continue;
      logs.push({ dir: dir.name, path: logPath, mtimeMs: st.mtimeMs });
    }
  }
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return logs.slice(0, maxSessions);
}

// Detect whether `zstd` CLI is available; cache result for the sweep.
// Used by readSessionLog to surface a friendly error instead of letting
// execFileAsync fail with ENOENT for every single session file.
// Exported for smoke testing (test/smoke.mjs exercises the missing-zstd path).
//
// 2026-09-17：本次「会话日志改名」修复（resolveSessionLogPath）在宿主侧重构本文件时
// 曾把这段守卫一并删掉 —— 那等于回退 2026-09-12 的修复（zstd 缺失时静默产出空信号
// 约两周）。反向同步回仓库时补回，并由 test/smoke.mjs 的 sad path 守着。
export function isZstdAvailable() {
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
let zstdMissingWarned = false;

/**
 * 只解压、不解析：返回会话日志的**原始文本**。
 *
 * ⛔ 2026-10-21 修（运行态取证）：这层必须与"解析"分开。
 *   起因：session-source 的 `readLocal` 契约是「返回文本」，而 dream 之前把
 *   `readSessionLog`（返回**已解析事件数组**）当 readLocal 注入 ⇒
 *   `readEventsFromDisk` 里 `String(text).split('\n')` 把数组 toString 成逗号串
 *   ⇒ `JSON.parse` 全部失败 ⇒ **拿到 0 个事件**。
 *   症状：dream 扫到 60 个会话，用户消息信号 / memWrites / 工具错误**全部归零**
 *   （迁移前同窗口分别是 105 / 20 / 565）⇒ 进化闭环的输入瞎了。
 *
 * @param {string} logPath 会话日志路径
 * @returns {Promise<string>} 解压后的文本
 */
export async function readSessionLogText(logPath) {
  if (!isZstdAvailable()) {
    if (!zstdMissingWarned) {
      // Warn once per sweep; the diary will record this as the root cause
      // for sessions=0 if no candidate surfaces.
      console.warn('[agint-dream] zstd CLI not found in PATH. Run install/agint-zstd-bootstrap.sh to install. Sweep will produce empty signals until resolved.');
      zstdMissingWarned = true;
    }
    throw new Error(`zstd CLI not found in PATH (run install/agint-zstd-bootstrap.sh to install)`);
  }
  const { stdout } = await execFileAsync('zstd', ['-dc', logPath], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  }).catch((err) => {
    throw new Error(`zstd -dc ${basename(logPath)} failed: ${err.message}`);
  });
  return stdout;
}

export async function readSessionLog(log, sessionSource = null) {
  // D1 迁移（2026-10-21）：log 参数改为对象 { path, sessionId }（兼容旧的纯路径字符串）。
  // 传入 sessionSource ⇒ 读内容优先走上游 sessionQuery.readSession(sessionId)。
  // 上游缺席时回落本地 zstd 解压。
  //
  // ⛔ 为什么要 sessionId：上游 readSession(id) 需要 id，光有磁盘路径不够。
  //   2026-10-19 那次"接上游"失败的根因之一就是没把 sessionId 传下去。
  const logPath = typeof log === 'string' ? log : log?.path;
  // 本地目录名就是 session id（sessions/<ws>/<session-id>/）；listSessionLogs 给的
  // 字段名是 `dir`（不是 `sessionId`）—— 传错会让上游分支永远不触发。
  const logSessionId = typeof log === 'object' ? (log.sessionId ?? log.dir ?? null) : null;

  if (sessionSource) {
    const read = await sessionSource.readEvents({
      dir: logSessionId, path: logPath, upstream: true,
    });
    return read.events;
  }
  const text = await readSessionLogText(logPath);
  return text.split('\n').filter((l) => l.trim()).map((l) => {
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
 * 判定一条 user/message 记录是不是真人说的话。
 *
 * 背景（提案 0f6c69bc，2026-10-23 实测）：宿主把主 agent 发给 subagent 的
 * prompt **也记成 kind='user'**。老的 `kind !== 'user'` 过滤挡得住
 * skill-catalog / agent-instructions 注入，**挡不住它**。这些 prompt 被 dream
 * 当成"用户偏好/教训"提进候选，一旦门槛调松就会写进长期记忆。
 *
 * 判据（实测 60 个会话，kind='user' 记录 163 条）：
 *   - source 带 rpcId / clientTimeZone：155 条 → 全部真人
 *   - source 只有 kind：                8 条 → 全部 subagent prompt
 * 两个标记**任一存在**即判 human —— 只用其中一个会漏掉宿主只给另一个的情况。
 *
 * ⛔ 不要用文本特征（"你是"/"只读"等）做判据：155 条真人里有 4 条命中这类
 * 特征词（"你现在是什么模型、推理等级是什么"），误杀的是真人问句。
 * 误杀率 2.6%，且误杀对象恰好是最该保留的那类消息。
 *
 * @returns {'human'|'subagent-prompt'|'other-kind'}
 */
export function classifyUserSource(rec) {
  const src = rec?.data?.source ?? null;
  // 老格式（v3 及更早）的 user/message 没有 source 字段。**保守收**：
  // 把它判成 subagent prompt 会让老会话的 Light 通道整轮归零 —— 那正是
  // 提案 4734bc97 修掉的「静默失效 7 天」同型错。无法判定时不拦。
  if (!src || typeof src !== 'object') return 'unknown-source';
  const kind = src?.kind ?? null;
  if (kind && kind !== 'user') return 'other-kind';
  const markers = [src?.rpcId, src?.clientTimeZone]
    .filter((v) => typeof v === 'string' && v.trim() !== '').length;
  return markers > 0 ? 'human' : 'subagent-prompt';
}

/**
 * 工具结果的「严格错误前缀」—— 老格式（无 isError 字段）兜底用。
 *
 * 判据刻意**只认开头/结尾**，不再看全文是否含关键词：正文里出现 "error" 字样的
 * **成功**输出（dream_status / grep / read 返回 / ls 输出）曾被整批当成工具错误
 * （见 classifyToolResultError 的实测数据）。
 */
const STRICT_ERROR_PREFIX_RE = /^\s*(?:error\b|fatal\b|traceback|错误[：:]|失败[：:]|stderr\b|\[stderr\])/i;
// ⚠️ 只认**非零**退出码：`exit code: 0` 是成功。2026-10-28 复算时发现，
// 早期版本写成 `exit code\s*:\s*-?\d+` ⇒ 把一批「[status: completed, exit code: 0]」
// 的**成功**输出判成了失败（复算里 legacy 桶 36 条中有 12 条是这种）。
const STRICT_ERROR_SUFFIX_RE = /\s*[\[(]?\s*exit code\s*:\s*-?[1-9]\d*\s*[\])]?\s*$/i;

/**
 * 判定一条 tool/result 是不是「一次失败」（2026-10-28 重做）。
 *
 * 旧判据：正文正则 `/error|failed|denied|sandbox|exit code: [1-9]|deny/i`
 * ——「正文出现 error 字样就算失败」。
 *
 * 实测（7 天 / 49 会话 / 1150 条 tool/result）：
 *   - 旧正则命中：**243** 条
 *   - 结构化标记（`message.isError === true` 或 `data.error` 存在）：**39** 条
 *   ⇒ **204 条（84%）是误判**：成功的 dream_status / recall_store_inspect /
 *     grep 输出 / read 工具的 `<path>…<content>` 包装 / ls 输出，只要正文里出现
 *     "error" 字样就被当成「工具报错」。
 *
 * 这才是候选池被污染的**根**：那些「工具执行报错：…」大半根本不是错误，
 * 而是**别的工具的成功输出**被正则误抓。后面再加多少关键词闸都是在错层打转。
 *
 * 新判据（分层）：
 *   1. `structured`  —— 宿主写了结构化标记（isError / error 对象）⇒ 失败。
 *   2. `legacy-prefix` —— 老格式没有该字段时，只认**严格前缀/后缀**
 *      （Error: / 错误： / [stderr] / Traceback / 以 exit code 结尾）。
 *   3. 其余 —— 不是错误。
 *
 * @returns {{ isError: boolean, source: 'structured'|'legacy-prefix'|'none', text: string }}
 */
export function classifyToolResultError(rec) {
  const msg = rec?.data?.message;
  const text = extractText(msg) || extractText(rec?.data) || '';
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return { isError: false, source: 'none', text: '' };
  const structured = msg?.isError === true || rec?.data?.error != null;
  if (structured) return { isError: true, source: 'structured', text: trimmed.slice(0, 260) };
  const core = trimmed.replace(STRICT_ERROR_SUFFIX_RE, '').trim();
  if (STRICT_ERROR_PREFIX_RE.test(core) || STRICT_ERROR_SUFFIX_RE.test(trimmed)) {
    return { isError: true, source: 'legacy-prefix', text: trimmed.slice(0, 260) };
  }
  return { isError: false, source: 'none', text: trimmed.slice(0, 260) };
}

/**
 * 数一句文本里有几句「因果句式」（2026-10-28，提案「让 agint-dream 采集
 * assistant 正文里的主张」第 1 步 · 观测先行）。
 *
 * 口径**复用**既有判据，不另立一套（两把尺子必须同口径）：
 *   - 强档 = TOOL_ERROR_CAUSE_RE（为什么/因此/所以/导致/because…）—— 单独够；
 *   - 弱档 = TOOL_ERROR_IMPERATIVE_RE（必须/应该/改成/must…）—— 要中文语境
 *     （CJK_RE）且至少 CJK_MIN_CHARS 个汉字。
 * 这与 classifyToolError 的强/弱分档完全一致；名字里的 TOOL_ERROR 是历史遗留，
 * 这里借它的口径，判据本身不复制、不改写。
 *
 * 句子切分复用 splitSentences（与候选抽取同口径）⇒ 计数是**下界**：
 * 长度不在 6~160 之间的句子不计。宁可少报，不虚报「可捞取量」。
 *
 * 前向引用说明：TOOL_ERROR_CAUSE_RE / TOOL_ERROR_IMPERATIVE_RE / CJK_RE /
 * CJK_MIN_CHARS 定义在本函数之后，但它们是模块级 const —— 本函数只在 sweep
 * 运行期被调用，那时模块已求值完毕，不会撞 TDZ。
 */
function countCausalSentences(text) {
  let n = 0;
  for (const s of splitSentences(String(text ?? ''))) {
    const strong = TOOL_ERROR_CAUSE_RE.test(s);
    const weak = TOOL_ERROR_IMPERATIVE_RE.test(s);
    if (!strong && !(weak && CJK_RE.test(s))) continue;
    if ((s.match(/[\u4e00-\u9fff]/g) ?? []).length < CJK_MIN_CHARS) continue;
    n += 1;
  }
  return n;
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
  let humanKept = 0;
  let subagentDropped = 0;
  let unknownKept = 0;
  // 2026-10-28（提案「让 agint-dream 采集 assistant 正文里的主张」第 1 步 · 观测先行）：
  // assistant 正文**只统计、不进候选**。失败之后的「教训」真身是助手自己写下的
  // 那句解释（「所以以后必须先确认 X」），此前 dream 完全看不见它 —— 修完
  // 「候选池工具报错污染」之后，「失败 → 教训」这条链在中间是断的。
  //
  // 关键约束：assistantTexts 与 userTexts **分开存放**。extractCandidates 只遍历
  // session.userTexts ⇒ 本步不改变候选池口径（先看可捞取量，再决定动不动提取
  // 口径 —— 不重复「先造判据再找材料」的老错）。
  const assistantTexts = [];
  let assistantChars = 0;
  let assistantCausalSentences = 0;
  for (const rec of records) {
    const t = rec?.time ?? rec?.seq ?? 0;
    if (rec?.type === 'user/message') {
      // Only real human utterances are signals. DSH injects skill-catalog /
      // system-reminder blocks as user/message events with other source kinds,
      // and records subagent prompts with kind='user' but no rpcId/clientTimeZone.
      const cls = classifyUserSource(rec);
      if (cls === 'other-kind') continue;
      if (cls === 'subagent-prompt') { subagentDropped += 1; continue; }
      const text = extractText(rec.data).trim();
      if (text) {
        userTexts.push({ text, time: t });
        if (cls === 'human') humanKept += 1; else unknownKept += 1;
      }
    } else if (rec?.type === 'assistant/message') {
      // 事件形态已取证（2026-10-28 实测 session.v4.jsonl.zstd）：
      //   type='assistant/message'，正文在 data.message.content[]，块类型有
      //   'reasoning' / 'tool-call' / 'text'。
      // 只取 type='text' 的块：reasoning（模型内思考）与 tool-call（调用参数）
      // 不是「助手写下的主张」；不算进来，本数才与用户正文同口径。
      const content = rec.data?.message?.content ?? rec.data?.content;
      const text = extractText({ content }).trim();
      if (text) {
        assistantTexts.push({ text, time: t });
        assistantChars += text.length;
        assistantCausalSentences += countCausalSentences(text);
      }
    } else if (rec?.type === 'tool/call' && rec.data?.name === 'memory_write') {
      let args = {};
      try { args = JSON.parse(rec.data.arguments ?? '{}'); } catch { /* ignore */ }
      if (args?.content) memWrites.push({ content: String(args.content), time: t });
    } else if (rec?.type === 'tool/result') {
      // 2026-10-28：改用结构化字段判定（见 classifyToolResultError）。
      // 旧判据是正文正则「含 error 字样就算失败」⇒ 84% 的"错误信号"是误判。
      const verdict = classifyToolResultError(rec);
      if (verdict.isError && verdict.text) {
        errors.push({ text: verdict.text, time: t, source: verdict.source });
      }
    }
    if (t) times.push(t);
  }
  const userKindTotal = humanKept + subagentDropped;
  return {
    sessionKey,
    userTexts,
    memWrites,
    errors,
    // 2026-10-28 第 1 步：assistant 正文的采集结果（**统计口径**，不进候选）。
    // 供日记/状态面回答「可捞取量有多少」；候选化留给第 2 步。
    assistantTexts,
    assistantStats: {
      messages: assistantTexts.length,
      chars: assistantChars,
      causalSentences: assistantCausalSentences,
    },
    startTime: times.length ? Math.min(...times) : 0,
    endTime: times.length ? Math.max(...times) : 0,
    sourceFilter: {
      userKindTotal,
      humanKept,
      unknownKept,
      subagentDropped,
      // 判据失效护栏：整轮 kind='user' 的记录一条都不带人类标记 ⇒
      // 宿主多半改了记录方式。标记出来，让零命中告警有东西可报（K54/K116）。
      degraded: userKindTotal > 0 && humanKept === 0,
    },
  };
}

/**
 * 聚合一轮 sweep 里所有会话的信号源过滤统计（提案 0f6c69bc）。
 *
 * 存在的理由：只拦不报 = 下一次又是「静默失效」。拦了多少 subagent prompt、
 * 判据有没有失效，这两个数必须进 diary / dream_status / 宿主日志（K116）。
 *
 * @returns {{humanKept:number, unknownKept:number, subagentDropped:number,
 *            userKindTotal:number, degradedSessions:number, judgeFailed:boolean}}
 */
export function aggregateSourceFilterStats(signals) {
  const acc = {
    humanKept: 0,
    unknownKept: 0,
    subagentDropped: 0,
    degradedSessions: 0,
  };
  for (const s of signals ?? []) {
    const f = s?.sourceFilter;
    if (!f) continue;
    acc.humanKept += f.humanKept ?? 0;
    acc.unknownKept += f.unknownKept ?? 0;
    acc.subagentDropped += f.subagentDropped ?? 0;
    if (f.degraded) acc.degradedSessions += 1;
  }
  acc.userKindTotal = acc.humanKept + acc.subagentDropped;
  // 判据失效：有 kind='user' 的消息，却一条人类消息都没收到，也没有老格式兜底。
  // 说明宿主改了记录方式（比如不再写 rpcId）⇒ 过滤器正在误杀真人消息。
  acc.judgeFailed = acc.degradedSessions > 0 && acc.humanKept === 0 && acc.unknownKept === 0;
  return acc;
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

// Quoted/reference material, not a durable claim of its own.
// 2026-09-21：贴给老板看的日记正文、记忆条目、工具输出常以
// `> - (id=..., type=lesson) ...` 这类引用块形态出现在会话里，被
// extractCandidates 当候选抽出后会把前缀连同内容写进 memory 本体
// （实测已有 15 条污染，且 `>` 会逐轮叠加）。这里在候选入口直接拦掉。
const QUOTED_RE = /^\s*(?:>\s*)+/;                    // 任意层引用块前缀
const PREFIXED_ENTRY_RE = /^\s*>?\s*-?\s*\(id=[^)]*\)/u;  // `(id=..., type=...)` 头部

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

// ── 2026-09-28：工具错误信号诊断化过滤 ─────────────────────────────────────

// 宿主追加在工具结果尾部的退出码标记。判定形态前先剥掉，否则它会挡住形态匹配
// （`Lines Chars ----- ----- 0 45 [exit code: 1]` 里真正要判的是前半截）。
const EXIT_CODE_SUFFIX_RE = /\s*[\[(]?\s*exit code\s*:\s*-?\d+\s*[\])]?\s*$/i;

/**
 * 噪音**形态** —— 「形态即证据」。
 * 这些是输出被截断 / 转义后的残骸，不是报错本身：裸空输出、单侧标记残片、
 * 表格残片、纯框线。命中任一即判噪音，不因为后面还有内容而放行。
 */
const TOOL_ERROR_NOISE_SHAPE_RE = new RegExp([
  /^\(no output\)\s*$/i,                            // 裸空输出
  /^\(no such file or directory\)\s*$/i,           // 裸系统错误
  /^<[!?/]?[\w.!?/:=-]*\s*>?\s*$/,                 // 单个 XML/HTML 标记残片
  /^[\w.-]+(?:\s{2,}[\w.-]+){1,}\s*$/,             // 表格残片（多列空格分隔）
  /^[-+|=\s]+$/,                                    // 纯分隔线 / 表格框线
].map((r) => `(?:${r.source})`).join('|'), 'i');

/**
 * 因果**句式** —— 文本里说出了「为什么 / 应该怎样」。
 *
 * 2026-10-19 收紧。旧判据是「出现任一诊断关键词即放行」，而那批关键词
 * （schema / invalid / expected / enoent / eacces…）在真实 stderr 里几乎必然
 * 出现 —— 于是 10-19 夜里的 3 条过门候选全是原始残骸：
 *   ① Error: invalid arguments: missing required property "file_path" …（命中 invalid）
 *   ② [stderr] …TerminatorExpectedAtEndOfString [exit code: 1]（命中 Expected）
 *   ③ · DimensionScoreSchema · DreamPhaseSchema … [PASS] L0 FROZEN 契约未变更（命中 schema）
 * 三条都以原文进了长期记忆。
 *
 * **状态描述不是主张**：schema 不匹配、参数缺失、端口占用说的是「现在是什么样」，
 * 不是「以后该怎么做」。新判据只认两种句式：
 *   - 因果连接：说清了「为什么」（因为 / 由于 / 根因 / because / due to …）
 *   - 祈使语气：说清了「应该怎样」（必须 / 应该 / 改成 / must / should / instead of …）
 * 两者都没有 ⇒ 拦下。
 *
 * 代价（明说）：「EACCES: permission denied」这类纯 syscall 报错不再进池。
 * 它是工具机制；要沉淀就由人 / LLM 写成主张再 memory_write。
 */
const TOOL_ERROR_CAUSAL_RE = new RegExp([
  // 因果连接：说清了「为什么」
  /因为|由于|原因是|根因(?:是|在于)?|其实是|实际(?:是|为)|因此|所以|才会|导致/,
  /because|due to|root cause|therefore|so that/i,
  // 祈使语气：说清了「应该怎样」
  /必须|应该|应当|务必|切记|记得|不要|别再|改成|改用|应改为|才能|需要先/,
  /must(?: not)?\b|should(?: not|'t)?\b|instead of|rather than|\bnever\b|\balways\b|need to/i,
].map((r) => `(?:${r.source})`).join('|'), 'i');

/**
 * 因果句式的**两个档**（2026-10-28）。
 *
 * 为什么要分档：旧判据把「因果连接」和「祈使语气」并成一个关键词桶，
 * 而祈使档的英文词（must / should / never / always / rather than）在**工具契约类
 * 报错**里几乎必然出现 ——
 *   "Error: old_string and new_string must differ"     ← must 是契约，不是处方
 *   "Error: tool X returned invalid output"              ← 工具机制
 * 于是「祈使词」这档事实上拦不住任何东西：2026-10-28 真实语料里 11 条放行的
 * 「因果型」报错，10 条是转录文本。
 *
 * 分档后：
 *   - **强档**（明确因果连接：为什么/因此/所以/导致/否则/because/…）：单独够。
 *   - **弱档**（只有祈使：必须/应该/改成/must/should/…）：单独**不够**，
 *     还要**中文语境**。理由不是"英文不重要"，而是**口径一致**：
 *     本插件的主张抽取（SIGNAL_RULES）整体就是中文语境——英文原话同样进不了候选池。
 *     两把尺子必须同口径，否则「错误路径比原话路径宽松」就成了漏洞。
 */
const TOOL_ERROR_CAUSE_RE = new RegExp([
  /因为|由于|原因是|根因(?:是|在于)?|其实是|实际(?:是|为)|因此|所以|才会|导致|否则/,
  /because|due to|root cause|therefore|so that/i,
].map((r) => `(?:${r.source})`).join('|'), 'i');

const TOOL_ERROR_IMPERATIVE_RE = new RegExp([
  /必须|应该|应当|务必|切记|记得|不要|别再|改成|改用|应改为|才能|需要先/,
  /must(?: not)?\b|should(?: not|'t)?\b|instead of|rather than|\bnever\b|\balways\b|need to/i,
].map((r) => `(?:${r.source})`).join('|'), 'i');

/** 中文语境判定（弱档祈使的附加条件）。 */
const CJK_RE = /[\u4e00-\u9fff]/;

/** 主张必须是「一句话」：中文汉字至少这么多个才算一句中文陈述。 */
const CJK_MIN_CHARS = 4;

/**
 * 代码 / 日志**骨架符号** —— 一句中文陈述里不该出现这些。
 *
 * 这是「不是转录」的**正面判据**，比形态黑名单稳：黑名单要穷举代码/diff/JSON/日志
 * 的表面特征（漏一个就漏一条），而「中文陈述里不该有 { } ; = ( ) [ ] < > | `」
 * 只有一条，且可被单条样本证伪/证实。
 *
 * 实测 9 条真实污染样本里，**每一条**都含其中至少一个符号：
 *   `F=./test/…`（=）｜`<path>…</path>`（< >）｜`z.enum(EXEC_MODES)`（( )）｜
 *   `defineTool(options) {`（{ }）｜`Object.hasOwn(…)`（( )）｜`pid=2485212`（=）
 */
const STRUCTURAL_SYMBOL_RE = /[{}()\[\]<>|=`]/;

/**
 * 转录**形态**闸（2026-10-28）——「说清了因果」也不等于「是主张」。
 *
 * 真实语料里放行的 11 条「因果型报错」，形态上是这些（括号内是实测样本）：
 *   - read 工具的 `<path>…<content>` 包装
 *   - diff hunk 头/行（`14,19d13` / `25- * …`）
 *   - file:line（`index.js types 838:function …`）
 *   - 代码注释块（`// execError 最近一次失败/顺延的原因 …`）
 *   - 代码记号（`const engines = Object.hasOwn(…)`）
 *   - JSON / 对象 dump（`{ "id": "9d9697cf-…", "title": "…" }`）
 *   - 日志行（`[agint-restart] restart requested … pid=2485212`）
 *   - CLI help（`help: Run "pnpm approve-builds" …`）
 *   - sweep 自己的产物（正文里含「工具执行报错：」）
 * 这些是**机器痕迹**，不是「以后该怎么做」。
 *
 * 形态判据比关键词判据可靠：代码/日志/JSON 有各自稳定的表面特征，
 * 而关键词在正常文本里也会偶然出现。
 */
const TOOL_ERROR_TRANSCRIPT_SHAPE_RE = new RegExp([
  /^<path>/,                                          // read 工具的 <path>…<content> 包装
  /^\s*\d+(?:,\d+)?[acd]\d+/m,                        // diff hunk 头（14,19d13）
  /^\s*\d+\s*[-*]\s/m,                                // diff hunk 行（25- * …）
  /^\s*\d+:\s*\S/m,                                   // file:line（28:export function）
  /^\s*(?:\/\/|\*|\*\/|\/\*)/m,                       // 代码注释块
  /\b(?:const|let|var|function|return|throw new|void 0|undefined)\b|=>/, // 代码记号
  /^\s*[{[]/,                                         // JSON / 对象 dump 起头
  /^\s*\[[a-z][a-z0-9-]*\]\s/i,                       // 日志行前缀（[agint-restart] …）
  /\b(?:pid|fingerprint|request_id|uuid)\s*=\s*\S/i,  // key=value 日志
  /^(?:help|usage)\s*:/im,                            // CLI help
].map((r) => `(?:${r.source})`).join('|'), 'i');

/**
 * 自我污染判据：sweep 自己的产物（上一轮生成的「工具执行报错：…」文本）
 * 被当成输入又当成输出，滚雪球。单独判，与形态闸分开计数。
 */
const SELF_POLLUTION_MARKER = '工具执行报错：';

/**
 * 判定一条工具错误信号是否值得进候选池。
 *
 * 取舍（错杀 vs 误放，代价不对称）：
 *   - **错杀**（漏一条教训）：这条根因下次靠人 / 我手工 memory_write 补。
 *   - **误放**（灌原始 stderr）：永久污染长期记忆，且这类候选 score 恒为 0.00，
 *     稀释所有真信号的召回 —— 09-28 实测的 23 条错误信号就是这么烂进来的。
 *   → 因此默认**拒绝**：无因果句式 = 拦下。
 *
 * 2026-10-28 三处收紧（实测语料 7 天 / 49 会话 / 1150 条 tool/result）：
 *   1. **信号层**：错误与否改用结构化字段判（见 classifyToolResultError）。
 *      旧正则「正文含 error 字样即算失败」误判率 84%（243 vs 39）。
 *   2. **档位**：因果句式拆强/弱两档，弱档（纯祈使）需中文语境 ——
 *      工具契约类报错（"must differ" / "must be a positive finite number"）
 *      满身祈使词，旧判据对它们形同虚设。
 *   3. **形态**：新增转录形态闸 + 自我污染判据 ——
 *      说清了因果的转录文本（diff / 代码 / JSON / 日志 / help）同样不是主张。
 *
 * 开关 `opts.toolErrorDiagnosticOnly=false` 时完全回退旧行为（全部放行）。
 *
 * @returns {{ keep: boolean, reason: string }} reason：
 *   'causal-clause'（放行）｜'filter-disabled'（开关关）｜'empty'｜
 *   'noise-shape'（噪音形态）｜'no-causal-clause'（无因果句式）｜
 *   'weak-imperative-only'（只有祈使、无明确因果）｜
 *   'no-chinese-context'（不是中文陈述）｜'structural-symbol'（含代码/日志骨架符号）｜
 *   'transcript-shape'（是转录文本，不是主张）｜'self-pollution'（sweep 自己的产物）
 */
export function classifyToolError(text, opts = {}) {
  const diagnosticOnly = opts.toolErrorDiagnosticOnly ?? DEFAULTS.toolErrorDiagnosticOnly;
  if (!diagnosticOnly) return { keep: true, reason: 'filter-disabled' };
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return { keep: false, reason: 'empty' };
  const core = line.replace(EXIT_CODE_SUFFIX_RE, '').trim() || line;
  if (TOOL_ERROR_NOISE_SHAPE_RE.test(core)) return { keep: false, reason: 'noise-shape' };
  // 自我污染：正文里已经是「工具执行报错：…」⇒ 是上一轮 sweep 的产物，不是新信号。
  if (core.includes(SELF_POLLUTION_MARKER)) return { keep: false, reason: 'self-pollution' };
  // 因果句式分两档（2026-10-28）：强档单独够；弱档（纯祈使）还要中文语境。
  const strong = TOOL_ERROR_CAUSE_RE.test(core);
  const weak = TOOL_ERROR_IMPERATIVE_RE.test(core);
  if (!strong && !(weak && CJK_RE.test(core))) {
    return { keep: false, reason: weak ? 'weak-imperative-only' : 'no-causal-clause' };
  }
  // 正面判据：必须是一句**中文陈述**。
  // 口径与 SIGNAL_RULES 对齐 —— 本插件的主张抽取整体就是中文语境，
  // 英文原话同样进不了候选池；错误路径若比原话路径宽松，就是个洞。
  const cjkCount = (core.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (cjkCount < CJK_MIN_CHARS) return { keep: false, reason: 'no-chinese-context' };
  // 正面判据：一句话，不该有代码/日志骨架符号。
  if (STRUCTURAL_SYMBOL_RE.test(core)) return { keep: false, reason: 'structural-symbol' };
  // 转录形态闸：说清了因果也不等于「是主张」。
  if (TOOL_ERROR_TRANSCRIPT_SHAPE_RE.test(core)) return { keep: false, reason: 'transcript-shape' };
  return { keep: true, reason: 'causal-clause' };
}

/**
 * 提升边界闸（2026-10-19）。
 *
 * 抽取层的判据作用在**原始 stderr** 上，而写进长期记忆的是截断到
 * `maxCandidateChars` 之后的文本。截断可能把因果句式切掉 —— 于是「过了抽取闸
 * 的残骸」仍可能以残骸形态进本体（10-19 的 3 条就是这么进的）。
 *
 * 这道闸独立于 classifyToolError：它检查的是**将要写入本体的那串文本**。
 * 只对工具错误来源的候选生效 —— 用户原话天然是主张，用因果句式去卡它会误杀。
 *
 * kill-switch：`toolErrorDiagnosticOnly=false` 时两道闸一起让路（完全回退旧行为）。
 *
 * @returns {string|null} 拦截原因；null = 放行
 */
export function promotionBlockReason(candidate, opts = {}) {
  const diagnosticOnly = opts.toolErrorDiagnosticOnly ?? DEFAULTS.toolErrorDiagnosticOnly;
  if (!diagnosticOnly) return null;
  if (!candidate?.rawToolError) return null;
  const stored = String(candidate.text ?? '');
  // 2026-10-28：形态闸也要在**将要写入本体的那串文本**上再跑一次。
  // 抽取层判的是原始 stderr；截断后的残骸可能仍保留因果词，但形态已经碎了。
  // 先剥掉候选自带的来源前缀（它本身含「工具执行报错：」，会被自我污染判据误伤）。
  const storedCore = stored.replace(/^工具执行报错：/, '').replace(EXIT_CODE_SUFFIX_RE, '').trim();
  if (TOOL_ERROR_TRANSCRIPT_SHAPE_RE.test(storedCore)) return 'transcript-shape-in-stored-text';
  if (TOOL_ERROR_CAUSAL_RE.test(storedCore)) return null;
  return 'no-causal-clause-in-stored-text';
}

/** 单个 extractCandidates 结果上的过滤统计（由 extractCandidates 挂载）。 */
export function toolErrorStatsOfOne(candidates) {
  const s = candidates?.toolErrorStats;
  if (s && typeof s === 'object') {
    return {
      ...s,
      byReason: { ...s.byReason },
      structured: s.structured ?? 0,
      legacy: s.legacy ?? 0,
    };
  }
  return { enabled: DEFAULTS.toolErrorDiagnosticOnly, total: 0, kept: 0, dropped: 0, byReason: {}, structured: 0, legacy: 0 };
}

/**
 * 跨会话聚合过滤统计（runSweep 用；flatMap 会丢非枚举属性，只能事后聚合）。
 * 返回值形状刻意保持扁平 —— tools.js 的 output schema 是
 * additionalProperties:false，byReason 这种开放字典不好声明。
 */
export function aggregateToolErrorStats(candidateLists) {
  const out = {
    enabled: DEFAULTS.toolErrorDiagnosticOnly,
    total: 0,
    kept: 0,
    dropped: 0,
    byReason: {},
    structured: 0,
    legacy: 0,
  };
  for (const list of candidateLists ?? []) {
    const s = toolErrorStatsOfOne(list);
    out.total += s.total;
    out.kept += s.kept;
    out.dropped += s.dropped;
    out.structured += s.structured ?? 0;
    out.legacy += s.legacy ?? 0;
    for (const [k, v] of Object.entries(s.byReason ?? {})) {
      out.byReason[k] = (out.byReason[k] ?? 0) + v;
    }
  }
  return out;
}

/**
 * Extract durable candidates from one session's collected signals.
 * Each candidate: { text, type, sessionKey, time, signals: [...] }.
 * memWrites are returned separately (already consolidated; diary-only).
 *
 * opts.toolErrorDiagnosticOnly: 工具错误是否走诊断化过滤（默认开，DEFAULTS）。
 * 返回数组上挂**非枚举** `toolErrorStats`（同 dedupeStats 的既有约定：
 * 数组语义不变，埋点/日记侧单独读）。
 */
export function extractCandidates(session, nowMs = Date.now(), opts = {}) {
  const diagnosticOnly = opts.toolErrorDiagnosticOnly ?? DEFAULTS.toolErrorDiagnosticOnly;
  const candidates = [];
  const seen = new Set();
  for (const { text, time } of session.userTexts) {
    if (NOISE_RE.test(text.trim())) continue;
    // 引用块 / 带 (id=...) 前缀的记忆条目形态 → 不是本人主张，且会把污染写进本体
    if (QUOTED_RE.test(text) || PREFIXED_ENTRY_RE.test(text)) continue;
    const base = text.replace(/^老板[，,\s]*/, '').trim();
    if (base.length < 6) continue;
    for (const sentence of splitSentences(base)) {
      if (/[?？]$/.test(sentence)) continue;         // questions are not statements
      if (QUESTION_RE.test(sentence)) continue;      // interrogatives without '?'
      if (VAGUE_RE.test(sentence)) continue;         // vague filler, no durable claim
      if (QUOTED_RE.test(sentence)) continue;        // 行内引用块残留
      if (PREFIXED_ENTRY_RE.test(sentence)) continue; // `(id=..., type=...) …` 头部
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
  // 工具错误信号：09-28 起走诊断化过滤（见 classifyToolError）。
  // 此前是无条件 push，等于把 stderr 原文当教训灌进长期记忆。
  // 2026-10-28 追加：统计里区分「结构化判定」与「严格前缀兜底」两种来源 ——
  // 旧判据（正文含 error 字样即算失败）误判率 84%，这个分档是那段误判的证词。
  const errorStats = {
    enabled: diagnosticOnly,
    total: session.errors.length,
    kept: 0,
    dropped: 0,
    byReason: {},
    structured: 0,
    legacy: 0,
  };
  for (const { text, time, source } of session.errors) {
    if (source === 'structured') errorStats.structured += 1;
    else if (source === 'legacy-prefix') errorStats.legacy += 1;
    const verdict = classifyToolError(text, { toolErrorDiagnosticOnly: diagnosticOnly });
    if (!verdict.keep) {
      errorStats.dropped += 1;
      errorStats.byReason[verdict.reason] = (errorStats.byReason[verdict.reason] ?? 0) + 1;
      continue;
    }
    errorStats.kept += 1;
    candidates.push({
      text: `${SELF_POLLUTION_MARKER}${text}`.slice(0, DEFAULTS.maxCandidateChars),
      type: 'lesson',
      sessionKey: session.sessionKey,
      time: time || nowMs,
      signals: [text],
      // 2026-10-19：标记来源。提升边界闸（promotionBlockReason）据此判断
      // 「这条候选是不是原始 stderr 残骸」—— 它不来自用户原话。
      rawToolError: true,
    });
  }
  // 非枚举：保持数组语义（`deepEqual(candidates, [...])` / `.length` 不变），
  // 但 runSweep / 日记可读 `.toolErrorStats` 做观测。
  Object.defineProperty(candidates, 'toolErrorStats', { value: errorStats, enumerable: false });
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
 *
 * opts.qualityEvalSummary: v0.2 (task 2 / C2 / 2026-09-06) — REM 阶段 qualityEvaluator
 * 评估核心 plugin 后的摘要。shape: { status, compositeMean, harmMean, targets, reason }.
 * 当 status='ok' 时，用 compositeMean 作为全局信号调整候选 score：
 *   - compositeMean >= 0.7 → 加权 +0.02（plugin 健康 → 候选更可信）
 *   - compositeMean <= 0.3 → 加权 -0.02（plugin 衰退 → 候选更可疑）
 *   - 其他 → 不调整（中性）
 * 状态非 'ok'（degraded/error/unavailable）→ 不影响打分（不阻断 sweep）。
 * 设计依据：AGINT/dream C1 memory（id=e7f0290e-...）—— qualityEval 是 plugin 级评估，
 * 不是 candidate 级；只能作为全局 signalBoost，不能 per-candidate 加权。
 */
export function scoreCandidates(candidates, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const w = { ...DEFAULTS.weights, ...(opts.weights ?? {}) };
  const halfLife = opts.recencyHalfLifeDays ?? DEFAULTS.recencyHalfLifeDays;
  const reinforcement = opts.reinforcement ?? [];
  // v0.2 / C2: qualityEval global boost（仅 status='ok' 且 compositeMean 是有限数时生效）
  const qualityBoost = computeQualityBoost(opts.qualityEvalSummary);
  // group by recallKey(normalized text) — 与 recall store 写入 key 对齐
  const groups = new Map();
  for (const c of candidates) {
    const key = recallKey(normalizeForCompare(c.text));
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { key, ...c, signals: [], sessions: new Set(), days: new Set(), reinforced: false });
    const g = groups.get(key);
    g.signals.push(...c.signals);
    g.sessions.add(c.sessionKey);
    g.days.add(new Date(c.time).toISOString().slice(0, 10));
    if (c.time < g.time || g.time === 0) g.time = c.time;
  }
  // REM reinforcement: same-claim signals from the wider window strengthen
  // frequency/consolidation but never create a candidate on their own.
  for (const c of reinforcement) {
    const key = recallKey(normalizeForCompare(c.text));
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
      w.conceptual * conceptual +
      // v0.2 / C2：qualityEval 全局调整（±0.02 上限，避免单信号颠覆 6 维评分）
      qualityBoost,
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
      components: { relevance, frequency, diversity, recency, consolidation, conceptual, qualityBoost },
    });
  }
  scored.sort((a, b) => b.score - a.score || b.signalCount - a.signalCount);
  return scored;
}

/**
 * v0.2 (task 2 / C3 / 2026-09-06)：从 qualityEval 摘要算全局 score boost。
 *
 * 设计：
 * - 仅 status='ok' 且 compositeMean 是有限数时返回非 0 值
 * - compositeMean >= 70 → +0.02（plugin 健康 → 候选更可信）
 * - compositeMean <= 30 → -0.02（plugin 衰退 → 候选更可疑）
 * - 其它（30 < mean < 70）→ 0（中性）
 * - 上限 ±0.02，避免单信号颠覆 6 维评分
 * - **注意**：compositeMean 现在是 0-100 标量（C3 真值接入，用 quality-eval score() 真值），
 *   之前 0.7/0.3 是 safety proxy 的 0-1 标量，已废弃。
 *
 * 输入 shape：{ status, compositeMean, harmMean, targets?, reason? }
 * 返回 number ∈ [-0.02, 0.02]
 */
export function computeQualityBoost(summary) {
  if (!summary || typeof summary !== 'object') return 0;
  if (summary.status !== 'ok') return 0;
  const m = summary.compositeMean;
  if (typeof m !== 'number' || !Number.isFinite(m)) return 0;
  if (m >= 70) return 0.02;
  if (m <= 30) return -0.02;
  return 0;
}

/**
 * v0.2 (task 2 / C2 / 2026-09-06)：REM 阶段调 qualityEvaluator 评估核心 plugin，
 * 聚合成全局 summary。**永不抛错**。
 *
 * 输入：{ ctx, enabled, errors } —— errors 数组会被 push 错误但不阻断 sweep
 * 输出：{ status, compositeMean, harmMean, targets, reason }
 *   - status: 'ok' | 'degraded' | 'unavailable'
 *   - compositeMean: 9 个 target 的 compositeScore 均值（status='ok' 时才是有效数字）
 *   - harmMean: harm 4 维均值
 *   - targets: [{ id, status, compositeScore, harmScore, reason }] 评估明细
 *
 * 降级路径：
 * - enabled=false → { status: 'unavailable', compositeMean: null, targets: [], reason: 'disabled' }
 * - ctx 不可用 / qualityEvaluator service 不可用 → 同上 + reason 不同
 * - 部分 target 评估失败 → status='degraded'，compositeMean 用成功的子集均值
 * - 全部失败 → status='degraded'，compositeMean=null
 */
export async function collectQualityEvalSummary({ ctx, enabled = true, errors = [] } = {}) {
  if (enabled === false) {
    return { status: 'unavailable', compositeMean: null, harmMean: null, targets: [], reason: 'disabled by sweep opts' };
  }
  if (!ctx || typeof ctx.get !== 'function') {
    return { status: 'unavailable', compositeMean: null, harmMean: null, targets: [], reason: 'ctx unavailable' };
  }

  let targets;
  try {
    targets = resolveEvalTargets();
  } catch (err) {
    errors.push(`quality-eval resolveEvalTargets threw: ${err?.message ?? String(err)}`);
    return { status: 'unavailable', compositeMean: null, harmMean: null, targets: [], reason: 'resolveEvalTargets failed' };
  }

  if (!Array.isArray(targets) || targets.length === 0) {
    return { status: 'unavailable', compositeMean: null, harmMean: null, targets: [], reason: 'no eval targets' };
  }

  let results;
  try {
    results = await evaluatePlugins(ctx, targets);
  } catch (err) {
    errors.push(`quality-eval evaluatePlugins threw: ${err?.message ?? String(err)}`);
    return { status: 'unavailable', compositeMean: null, harmMean: null, targets: [], reason: 'evaluatePlugins threw' };
  }

  // 聚合：compositeScore / harmScore 是数字的算均值
  const composites = [];
  const harms = [];
  const targetSummary = [];
  let anyOk = false;
  let anyDegraded = false;
  for (const r of results || []) {
    if (!r) continue;
    targetSummary.push({
      id: r.targetId,
      status: r.status,
      compositeScore: r.compositeScore,
      harmScore: r.harmScore,
      reason: r.reason,
    });
    if (r.status === 'ok') {
      anyOk = true;
      if (typeof r.compositeScore === 'number' && Number.isFinite(r.compositeScore)) composites.push(r.compositeScore);
      if (typeof r.harmScore === 'number' && Number.isFinite(r.harmScore)) harms.push(r.harmScore);
    } else {
      anyDegraded = true;
    }
  }

  const compositeMean = composites.length > 0 ? composites.reduce((a, b) => a + b, 0) / composites.length : null;
  const harmMean = harms.length > 0 ? harms.reduce((a, b) => a + b, 0) / harms.length : null;

  // status 语义：
  // - 全部 unavailable / evaluate 全失败 → 'unavailable'
  // - 有 ok 但也有 degraded/error → 'degraded'
  // - 全部 ok → 'ok'
  let summaryStatus;
  if (!anyOk && !anyDegraded) summaryStatus = 'unavailable';
  else if (anyOk && anyDegraded) summaryStatus = 'degraded';
  else if (anyOk && !anyDegraded) summaryStatus = 'ok';
  else summaryStatus = 'degraded'; // 全 degraded 也没 ok

return {
    status: summaryStatus,
    compositeMean,
    harmMean,
    targets: targetSummary,
    reason: null,
  };
}

/**
 * Filter candidates through threshold gates and existing-memory dedupe.
 * existing: array of { content, type, id } from agint.memory.list().
 *
 * 2026-09-21（方案 B 分级去重，proposals/agint-dream-dedupe-lineage.md）：
 * `covered` 从布尔拆成三档。高相似仍丢弃（现状），中相似**放行但标记**
 * `dedupeSuspicion`，把「是不是同一件事」的判断交还给 LLM consolidation。
 *
 * 返回：`kept` 数组（附 `dedupeStats` 非枚举属性 —— 数组语义不变，
 * 消费方按数组用，埋点侧读 `kept.dedupeStats`）。
 */
export function gateCandidates(scored, existing = [], opts = {}) {
  const minScore = opts.minScore ?? DEFAULTS.minScore;
  const minRecall = opts.minRecall ?? DEFAULTS.minRecall;
  const minUnique = opts.minUniqueSessions ?? DEFAULTS.minUniqueSessions;
  const overlap = opts.dedupeTokenOverlap ?? DEFAULTS.dedupeTokenOverlap;
  // 分级去重旋钮。dedupeMid 的**默认值**跟 dedupeTokenOverlap 走（不是写死 0.6），
  // 否则 cordis.patch.yml 里只改了 dedupeTokenOverlap 时会静默失配。
  const tiered = opts.dedupeTieredEnabled ?? DEFAULTS.dedupeTieredEnabled;
  const dedupeHigh = opts.dedupeHigh ?? DEFAULTS.dedupeHigh;
  const dedupeMid = opts.dedupeMid ?? overlap;
  const existingNorm = existing
    .map((e) => ({ id: e.id, type: e.type, content: e.content, norm: normalizeForCompare(e.content) }))
    .filter((e) => e.norm);
  const kept = [];
  // 可观测性（K51）：被丢弃的候选必须计数，否则分不清「没有候选」和「全被挡了」。
  const dedupeStats = { enabled: Boolean(tiered), dropped: 0, suspicious: 0, checked: 0, maxSimilarity: 0 };
  for (const c of scored) {
    if (c.score < minScore) continue;
    if (c.signalCount < minRecall) continue;
    if (c.uniqueSessions < minUnique) continue;
    dedupeStats.checked += 1;
    const norm = normalizeForCompare(c.text);
    let covered = false;
    let suspicion = null;      // 'substring' | 'similarity'
    let maxSim = 0;
    let matchedId = null;
    for (const e of existingNorm) {
      if (!norm || !e.norm) continue;
      if (norm.includes(e.norm) || e.norm.includes(norm)) {
        if (!tiered) { covered = true; break; }
        // 互含：长度比例决定档位。短条目被长条目完全包含（比例高）→ 更像真重复；
        // 长条目吞下短条目（比例低）→ 只是共享一段子串，够不上「同一件事」。
        const ratio = Math.min(norm.length, e.norm.length) / Math.max(norm.length, e.norm.length);
        if (ratio > maxSim) { maxSim = ratio; matchedId = e.id; }
        if (ratio >= dedupeHigh) { covered = true; suspicion = null; break; }
        suspicion = 'substring';
        continue;
      }
      const ov = tokenOverlap(c.text, e.content);
      if (ov > maxSim) { maxSim = ov; matchedId = e.id; }
      if (!tiered) {
        if (ov >= overlap) { covered = true; break; }
        continue;
      }
      if (ov >= dedupeHigh) { covered = true; suspicion = null; break; }
      if (ov >= dedupeMid) suspicion = 'similarity';
    }
    if (maxSim > dedupeStats.maxSimilarity) dedupeStats.maxSimilarity = maxSim;
    if (covered) { dedupeStats.dropped += 1; continue; }
    if (suspicion) {
      dedupeStats.suspicious += 1;
      c.dedupeSuspicion = { kind: suspicion, similarity: Number(maxSim.toFixed(4)), againstId: matchedId };
    }
    kept.push(c);
  }
  // 非枚举：保持数组语义（`deepEqual(kept, [...])` 与 `kept.length` 不变），
  // 但调用方可读 `dedupeStats` 做观测。
  Object.defineProperty(kept, 'dedupeStats', { value: dedupeStats, enumerable: false });
  return kept;
}

/**
 * 读 `gateCandidates` 附在数组上的去重统计；没有（旧调用方 / 桩数据）时给兜底。
 * 单独导出，方便 runSweep 与测试共用同一套兜底语义。
 */
export function dedupeStatsOf(gated) {
  const s = gated?.dedupeStats;
  if (s && typeof s === 'object') return { ...s };
  return { enabled: false, dropped: 0, suspicious: 0, checked: 0, maxSimilarity: 0 };
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
 *           errors, durationMs, windows?, skippedPromoted?, skippedRawToolError?,
 *           validationOk?, validationReason?, recallWrite?, pruneResult? }.
 */
export function renderDiary({ day, signals, memWrites, candidates, gated, promoted, recovered = [], errors = [], durationMs, windows, skippedPromoted = 0, skippedRawToolError = 0, validationOk = true, validationReason, recallWrite, pruneResult, consolidationMode = 'failed', consolidationReason = null, qualityEvalSummary = null, evolutionSummary = null, evolutionBoost = 0, health = null, dedupeStats = null, toolErrorStats = null, sourceFilterStats = null, apply = true }) {
  const lines = [];
  lines.push(`# 梦境日记 ${day}`);
  lines.push('');
  // 2026-09-28：预览件必须自带声明，否则日后回看会把它当真实夜间记录
  // （它写着 promoted=0，看起来像「那天一条都没提升」）。
  if (!apply) {
    lines.push('> ⚠️ **dry-run 预览（apply=false）**：候选未提升进记忆，未写 recall store，');
    lines.push('> 未剪枝。本文件**不是**当天的真实夜间 sweep 记录。');
  }
  lines.push(`> 智进夜间梦境 · sweep 耗时 ${(durationMs / 1000).toFixed(1)}s · 模式：后台记忆整合（light→REM→deep）`);
  if (windows) lines.push(`> 窗口：Light ${windows.light}d / REM ${windows.rem}d / Deep恢复 ${windows.deep}d`);
  lines.push('');
  lines.push('## Light — 信号采集');
  lines.push('');
  lines.push(`- 扫描会话：${signals.length} 个`);
  lines.push(`- 用户消息信号：${signals.reduce((n, s) => n + s.userTexts.length, 0)} 条`);
  lines.push(`- 会话内 memory_write（已沉淀，不再重复提升）：${memWrites.length} 条`);
  lines.push(`- 工具错误信号：${signals.reduce((n, s) => n + s.errors.length, 0)} 条`
    + (toolErrorStats ? `（结构化 ${toolErrorStats.structured ?? 0} · 严格前缀兜底 ${toolErrorStats.legacy ?? 0}）` : ''));
  // 2026-09-28：过滤器必须**可见**。否则「拦了多少」无从判断，噪音治理就退化成
  // 一个看不见的黑洞 —— 跟当初 Light 通道静默失效 7 天是同一类盲区。
  if (toolErrorStats && toolErrorStats.total > 0) {
    const reasons = Object.entries(toolErrorStats.byReason ?? {})
      .map(([k, v]) => `${k}×${v}`).join(' · ');
    lines.push(`- 工具错误因果过滤：留 ${toolErrorStats.kept} / 拦 ${toolErrorStats.dropped}`
      + `${reasons ? `（${reasons}）` : ''}${toolErrorStats.enabled ? '' : ' · 过滤已关闭(kill-switch)'}`);
  }
  // 2026-10-23（提案 0f6c69bc）：信号源过滤必须**可见**。
  // 挡住 subagent prompt 是本次目标，但判据一旦失效（宿主改了记录方式），
  // 症状是「一条用户消息都收不到」—— 与 Light 静默失效 7 天同型，必须出声。
  if (sourceFilterStats && (sourceFilterStats.subagentDropped > 0 || sourceFilterStats.judgeFailed)) {
    const f = sourceFilterStats;
    lines.push(`- 信号源过滤：真人 ${f.humanKept} 条 · 老格式 ${f.unknownKept} 条 · 拦 subagent prompt ${f.subagentDropped} 条`
      + (f.judgeFailed ? ' · ⚠️ **判据可能失效**（无人类标记消息，需复核 source 记录方式）' : ''));
  }
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
  if (skippedPromoted > 0) lines.push(`- 已 promote 跳过：${skippedPromoted} 条`);
  // 2026-10-19：提升边界闸的拦截数必须可见 —— 拦下来的东西不能是黑洞。
  if (skippedRawToolError > 0) {
    lines.push(`- 提升边界闸拦截：${skippedRawToolError} 条工具错误残骸（写进本体的文本不含因果句式）`);
  }
  // 2026-09-21（方案 B）：去重分档统计。此前页面只显示「门槛通过候选：0 条」，
  // 无法区分「本来就没候选」和「候选全被 existing 去重吃掉」—— 这正是闭包
  // 藏了这么久的原因。
  if (dedupeStats && dedupeStats.checked > 0) {
    const rate = dedupeStats.checked > 0
      ? ((dedupeStats.dropped / dedupeStats.checked) * 100).toFixed(0)
      : '0';
    const mode = dedupeStats.enabled ? '分级' : '单一阈值（已回退）';
    lines.push(`- 去重（${mode}）：丢弃 ${dedupeStats.dropped} 条（高相似） · 疑似放行 ${dedupeStats.suspicious} 条 · 命中率 ${rate}% · 最高相似度 ${Number(dedupeStats.maxSimilarity ?? 0).toFixed(3)}`);
  }
  if (!validationOk) {
    lines.push(`- **P0 validation gate REJECTED**: ${validationReason || 'unknown'}`);
  }
  // P1: consolidation mode (llm / not-attempted / failed)
  if (consolidationMode === 'llm') {
    lines.push(`- **P1 LLM consolidation**: ✅ LLM 决策 add/merge/supersede${consolidationReason ? `（${consolidationReason}）` : ''}`);
  } else if (consolidationMode === 'not-attempted') {
    // 2026-09-18 C 项：区别「没触发」（门槛没放行 / ctx 缺失）和「触发了但 LLM 失败」
    lines.push(`- P1 LLM consolidation: ➖ 未触发${consolidationReason ? `（${consolidationReason}）` : ''}`);
  } else {
    lines.push(`- P1 LLM consolidation: ❌ failed（本轮不提升任何候选，无启发式回退）${consolidationReason ? `：${consolidationReason}` : ''}`);
  }
  lines.push(`- 提升写入记忆：${promoted.length} 条`);
  if (recallWrite) {
    lines.push(`- P2 recall store：append ${recallWrite.appended ?? 0} 条`);
  }
  if (pruneResult) {
    lines.push(`- P2 30 天剪枝：保留 ${pruneResult.kept} / 剪掉 ${pruneResult.dropped}`);
  }
  // v0.2 (task 2 / C2 / 2026-09-06)：REM 阶段 qualityEvaluator 评估摘要
  if (qualityEvalSummary && qualityEvalSummary.targets && qualityEvalSummary.targets.length > 0) {
    const qe = qualityEvalSummary;
    const compositeStr = typeof qe.compositeMean === 'number' ? qe.compositeMean.toFixed(1) : 'n/a';
    const harmStr = typeof qe.harmMean === 'number' ? qe.harmMean.toFixed(1) : 'n/a';
    let qeLine = `- v0.2 qualityEval: status=${qe.status} · compositeMean=${compositeStr} · harmMean=${harmStr} · 评估 ${qe.targets.length} 个 plugin (${qe.targets.filter((t) => t.status === 'ok').length} ok)`;
    if (qe.status !== 'ok') {
      qeLine += ` · ${qe.reason ?? 'no reason'}`;
    }
    lines.push(qeLine);
  } else if (qualityEvalSummary) {
    lines.push(`- v0.2 qualityEval: status=${qualityEvalSummary.status ?? 'unavailable'} · ${qualityEvalSummary.reason ?? 'no targets'}`);
  }
  // v0.3 (task 3 / 2026-09-06)：Deep 阶段 evolution success-templates 摘要
  if (evolutionSummary) {
    const evoStr = typeof evolutionSummary.topConfidence === 'number'
      ? evolutionSummary.topConfidence.toFixed(2)
      : 'n/a';
    const boostStr = evolutionBoost ? ` · boost=${evolutionBoost.toFixed(2)}` : '';
    lines.push(`- v0.3 evolution: status=${evolutionSummary.status ?? 'unavailable'} · templates=${evolutionSummary.count ?? 0}· topConfidence=${evoStr}${boostStr}`);
  }
  // 2026-09-18：零命中告警 —— 没扫到会话必须写在 diary 里，否则人读日记也看不出来
  if (health && health.status === 'degraded') {
    lines.push('');
    lines.push(`> ⚠️ **dream 健康度 degraded**：${health.reason}`);
    lines.push(`> 连续零命中 ${health.consecutiveZeroHit} 次 · 阈值 ${health.threshold} · 最后有数据：${health.lastNonZeroAt ?? '从未'}`);
  }
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
  // 2026-09-21（方案 B 分级去重）运行时旋钮 —— 见 DEFAULTS 处的长注释
  dedupeTieredEnabled,
  dedupeHigh,
  dedupeMid,
  // 2026-09-28：工具错误信号诊断化过滤（kill-switch；默认开）
  toolErrorDiagnosticOnly = DEFAULTS.toolErrorDiagnosticOnly,
  // P2 (Sprint 13 / 2026-09-05)：short-term recall store 路径
  recallPath,
  // P0：validation gate 调优（loss fraction budget 等）
  operations = null,            // 来自 P1 LLM consolidation；显式传时跳过 consolidation 调用
  maxPriorEntryLossFraction,    // 默认 0.25（与 openclaw 对齐）
  // P1：LLM consolidation 配置（host-plane 通过 ctx 自动建临时 subagent）
  consolidation = null,         // 显式 consolidation runner { run(gated, existing) → { mode, operations, reason } }
                                //  null 时 sweep 内部按需调默认 consolidate()
  // 不传 ⇒ 落 consolidation.js 的 DEFAULT_PROVIDER / DEFAULT_MODEL（实测 minimax-cn /
  // MiniMax-M3，由 ~/.dsh/settings.yaml 的 agent-default-model 决定）。
  // ⛔ 注释曾写"默认 deepseek"，deepseek 在本机只是 fallback adapter —— 别照抄那个默认值。
  consolidationProvider,
  consolidationModel,
  consolidationTimeoutMs,       // 默认 60000
  // 2026-10-07：单批送 LLM 的候选条数上限。默认 8（DEFAULT_BATCH_SIZE）。
  // 实测 43 条单批必超 60s → 整批降级 → 当晚 76 条记忆里 33 条是重复/碎片。
  // 不传 ⇒ 落 consolidation.js 的 DEFAULT_BATCH_SIZE。
  consolidationBatchSize,
  // 可选：sweep 完成时 publish dream.rejected 事件（默认不 publish，保持向后兼容）
  publishReject = null,         // function: (reason, count) => Promise<void>
  // 可选：cordis host ctx — 供内部 consolidation 调用 ctx.agents / ctx.subagents
  ctx = null,
  // v0.2 (task 2 / C2 / 2026-09-06)：REM 阶段调 qualityEvaluator 评估核心 plugin
  // 默认开；显式 false 可关闭（用于测试 / 应急回滚）
  qualityEval = true,
  // v0.3 (task 3 / 2026-09-06)：Deep 阶段读 success-templates 作为评分参考
  // 默认开；显式 false 可关闭
  evolution = true,
  // 2026-09-18：零命中告警。`zeroHitAlert=false` → 只记数不告警（kill-switch）；
  // 阈值可调，默认 3 次（1 次可能只是这两天没活动，3 次基本是通道坏了）。
  zeroHitAlert = true,
  zeroHitAlertThreshold = DEFAULT_ZERO_HIT_THRESHOLD,
}) {
  const startedAt = Date.now();
  const errors = [];
  const day = fmtDay(nowMs);
  const lightDays = lookbackDays ?? DEFAULTS.lookbackDays;
  const remDays = remLookbackDays ?? DEFAULTS.remLookbackDays;
  const cap = maxSessions ?? DEFAULTS.maxSessions;
  const rPath = recallPath ?? defaultRecallPath();

  // ── D1 迁移：会话内容读优先走上游 sessionQuery ───────────────────────────
  // 2026-10-21：原先 `readSessionLog(log.path)` 走本地 zstd 解压。
  // 上游 `sessionQuery.readSession(id)` 直接给重放校验过的事件流 ⇒ 不碰磁盘。
  // 上游缺席时回落本地（session-source 注入的 readLocal = 这里复用 readSessionLog 的 zstd 路径）。
  const sessionSource = ctx ? createSessionSource({
    ctx,
    fallback: async () => [],
    onFallback: (reason) => errors.push(`session-source: ${reason}`),
    source: 'dream/sweep',
    // ⛔ readLocal 的契约是「返回**文本**」，不是返回已解析的事件数组。
    //   传错类型会让 readEventsFromDisk 拿到数组 → toString → JSON.parse 全失败
    //   → 事件数 0（2026-10-21 运行态事故，见 readSessionLogText 的注释）。
    readLocal: (path) => readSessionLogText(path),
  }) : null;

  // ── Light: candidate extraction window (2d) ─────────────────────────────
  const lightLogs = await listSessionLogs(sessionsRoot, lightDays, cap);
  const signals = [];
  for (const log of lightLogs) {
    try {
      signals.push(collectSessionSignals(await readSessionLog(log, sessionSource)));
    } catch (err) {
      errors.push(`${log.dir}: ${err.message}`);
    }
  }
  // ── 零命中健康度（2026-09-18）────────────────────────────────────────
  // 判据是「本次有没有扫到**可解析**的会话」（signals.length），不是日志条数：
  // 文件都在但全解析失败同样是「没数据」，按日志条数判定会漏掉这类失效。
  const zeroHit = signals.length === 0;
  const prevHealth = await readHealthState(diaryRoot);
  const healthState = updateZeroHitState(prevHealth, {
    hit: !zeroHit,
    nowIso: new Date(nowMs).toISOString(),
  });
  await writeHealthState(diaryRoot, healthState);
  const health = evaluateZeroHitHealth(healthState, {
    threshold: zeroHitAlertThreshold,
    enabled: zeroHitAlert !== false,
  });
  if (health.status === 'degraded') {
    // 打日志：dream_status 之外还得能在宿主日志里 grep 到（可观测 > 静默）
    console.warn(`[agint-dream] ${health.reason}`);
  }

  // ── 信号源过滤统计（2026-10-23 / 提案 0f6c69bc）───────────────────────
  // 拦了 subagent prompt 多少条、判据有没有失效，两个都要出声。
  const sourceFilterStats = aggregateSourceFilterStats(signals);
  if (sourceFilterStats.judgeFailed) {
    const reason = `source-filter 判据失效：${sourceFilterStats.degradedSessions} 个会话里 kind='user' 的消息全部没有 rpcId/clientTimeZone，过滤器正在误收或误杀，需复核 source 判据`;
    console.warn(`[agint-dream] ${reason}`);
    errors.push(reason);
  }

  const memWrites = signals.flatMap((s) => s.memWrites.map((m) => ({ ...m, session: s.sessionKey })));
  // 2026-09-28：先按会话产出再 flat()，因为过滤统计挂在每个数组的非枚举属性上，
  // flatMap 会把它丢掉 —— 统计必须事后聚合（aggregateToolErrorStats）。
  const candidateLists = signals.map((s) => extractCandidates(s, nowMs, { toolErrorDiagnosticOnly }));
  const candidates = candidateLists.flat();
  const toolErrorStats = aggregateToolErrorStats(candidateLists);

  // ── P2 Light: 把候选写入 recall store（带 recallKey 归一化）──────────
  // 2026-09-28：apply=false（dry-run preview）不再写 recall store。
  // 此前 dry-run 也照写 —— 09-28 实测一次预览 append 286 条，把「没过门槛、
  // 也永远不会被 promote」的候选混进了跨日累积池。预览的定义就是不改状态；
  // 下方读 storeEntries 的逻辑不受影响（本来就不写）。
  let recallWriteResult = null;
  if (apply) {
    try {
      const writeCandidates = candidates.map((c) => ({
        key: recallKey(normalizeForCompare(c.text)),
        text: c.text,
        type: c.type,
        path: c.path,
        startLine: c.startLine,
        endLine: c.endLine,
        signalCount: 1,
        dailyCount: 0,
        groundedCount: 0,
        queryHashes: [],
        days: [day],
      }));
      recallWriteResult = await recallStoreRecord(rPath, writeCandidates, { nowMs, dayBucket: day });
    } catch (err) {
      errors.push(`recall-store write failed: ${err.message}`);
    }
  }

  // ── P2 Deep 阶段前：读 store 获取 promotedAt 集合，用于过滤已提 ──
  let storeEntries = new Map();
  try {
    const r = await recallStoreRead(rPath, nowMs);
    storeEntries = r.entries;
    if (r.skippedPartial > 0) errors.push(`recall-store: skipped ${r.skippedPartial} partial lines`);
  } catch (err) {
    errors.push(`recall-store read failed: ${err.message}`);
  }

  // ── REM: reinforcement window (7d) — cross-day strength, no new claims ──
  let reinforcement = [];
  if (remDays > lightDays) {
    const remLogs = await listSessionLogs(sessionsRoot, remDays, cap);
    const remSignals = [];
    for (const log of remLogs) {
      try {
        remSignals.push(collectSessionSignals(await readSessionLog(log, sessionSource)));
      } catch (err) {
        errors.push(`${log.dir}(rem): ${err.message}`);
      }
    }
    reinforcement = remSignals.flatMap((s) => extractCandidates(s, nowMs, { toolErrorDiagnosticOnly }));
  }

  // ── v0.2 / C2: REM 阶段 qualityEvaluator 评估核心 plugin ──────────────
  // 设计（提案 ba3e1800-... task 2 / C2）：
  // - 调 ctx.get('agint.qualityEvaluator').evaluate(BASELINE_TARGETS[i])
  // - 结果用 computeQualityCompositeSummary 聚合（compositeMean / harmMean / status）
  // - 失败强降级：qualityEval 不可用 → summary.status='unavailable'，不阻断 sweep
  // - 默认开；qualityEval=false 可关闭（应急回滚 / 测试）
  const qualityEvalSummary = await collectQualityEvalSummary({ ctx, enabled: qualityEval, errors });

  const scored = scoreCandidates(candidates, { nowMs, reinforcement, qualityEvalSummary });

  // ── v0.3 / task 3: Deep 阶段读 success-templates 作为评分参考 ──────────
  // 设计（提案 ba3e1800-... task 3 + 老板拍板 A「按 plugin id 精确匹配」）：
  // - 调 ctx.get('agint.evolution').queryTemplates({ appliesTo: plugin ids })
  // - 结果用 computeEvolutionBoost 算全局 boost（对称 qualityEval）
  // - 失败强降级：summary.status='unavailable'，不阻断 sweep
  // - 默认开；evolution=false 可关闭（应急回滚 / 测试）
  const evolutionSummary = await collectEvolutionSummary({ ctx, enabled: evolution, errors });
  const evolutionBoost = computeEvolutionBoost(evolutionSummary);

  // v0.3 / task 3：把 evolutionBoost 应用到已评分 candidate（在 gate 判定之前，
  // 让提升后的 score 影响 minScore 门槛——否则 boost 只改展示不改判定）
  // candidate.components.evolutionBoost 记录供 dream_diary 展示
  for (const c of scored) {
    c.score = clamp(c.score + evolutionBoost);
    if (!c.components) c.components = {};
    c.components.evolutionBoost = evolutionBoost;
  }

  // ── Deep: gate + P0 validation gate + promote ────────────────────────
  const existing = memory ? await memory.list({}) : [];
  const dedupeOpts = { dedupeTieredEnabled, dedupeHigh, dedupeMid };
  const gated = gateCandidates(scored, existing, { minScore, minRecall, minUniqueSessions, ...dedupeOpts });
  // 2026-09-21：去重埋点（K51 可观测 > 可审批）—— 被丢弃的候选也要计数，
  // 否则分不清「没有候选」和「全被去重挡了」。
  const dedupeStats = dedupeStatsOf(gated);
  // P2: 过滤掉已 promoted 的候选（在 validation/consolidation 之前过滤，避免重复写）
  const unpromotedGated = gated.filter((c) => {
    const k = recallKey(normalizeForCompare(c.text));
    return !storeEntries.get(k)?.promotedAt;
  });
  const skippedPromoted = gated.length - unpromotedGated.length;

  // P1: LLM consolidation —— 决定 add/merge/supersede。
  // 优先级：显式传入 operations > 显式传入 consolidation runner > sweep 内部默认调 consolidate(ctx)
  // 2026-10-25 无降级：LLM 失败不再退回「见一条推一条」。失败即跳过本轮提升并留痕。
  let consolidationMode = Array.isArray(operations) ? 'llm' : 'not-attempted';
  let consolidationReason = Array.isArray(operations) ? 'explicit operations' : null;
  let consolidationFailed = false;
  let resolvedOps = operations;
  if (resolvedOps == null && unpromotedGated.length > 0) {
    const runner = consolidation ?? (ctx
      ? (g, e) => consolidateBatched({
          ctx,
          gated: g,
          existing: e,
          day,
          provider: consolidationProvider,
          model: consolidationModel,
          timeoutMs: consolidationTimeoutMs,
          // 2026-10-07：候选堆到 43 条时单批必超 60s 超时，闸门敞开产垃圾。
          // 分批让每批的 prompt 体量有界；批数写进 reason，失败时能定位到第几批。
          batchSize: consolidationBatchSize,
        })
      : null);
    if (runner) {
      try {
        const result = await runner(unpromotedGated, existing);
        consolidationMode = result?.mode ?? 'failed';
        consolidationReason = result?.reason ?? null;
        resolvedOps = result?.operations ?? null;
        if (result?.ok === false || consolidationMode !== 'llm' || !Array.isArray(resolvedOps)) {
          consolidationMode = 'failed';
          consolidationReason = result?.reason ?? 'LLM result missing operations array';
          resolvedOps = null;
          consolidationFailed = true;
          errors.push(`consolidation failed: ${consolidationReason}`);
        }
      } catch (err) {
        consolidationMode = 'failed';
        consolidationReason = `runner threw: ${err?.message ?? String(err)}`;
        resolvedOps = null;
        consolidationFailed = true;
        errors.push(`consolidation runner failed: ${consolidationReason}`);
      }
    } else {
      // 有候选但拿不到 LLM 通路 = 失败；不再用「not-attempted」掩盖。
      consolidationMode = 'failed';
      consolidationReason = 'no consolidation runner (ctx unavailable)';
      consolidationFailed = true;
      errors.push(`consolidation failed: ${consolidationReason}`);
    }
  } else if (resolvedOps == null) {
    // 0 过门候选 → LLM 根本没被调用。'not-attempted' = 「门槛没放行任何候选」。
    consolidationMode = 'not-attempted';
    consolidationReason = '0 gated candidates — LLM 未触发';
  }

  // P0: LLM consolidation 失败 ⇒ 本轮不提升任何候选（无启发式回退）。
  // 候选留在原地，下一次 sweep 会重新尝试；错误已进 errors / diary。
  const validationFinal = consolidationFailed
    ? {
      ok: false,
      reason: `LLM consolidation failed: ${consolidationReason}`,
      stats: {},
      plan: [],
    }
    : validateAndApply({
      gated: unpromotedGated,
      existing,
      operations: resolvedOps,
      maxPriorEntryLossFraction: maxPriorEntryLossFraction ?? 0.25,
    });

  // P0 reject 事件（如有 publishReject 钩子）
  if (!validationFinal.ok && typeof publishReject === 'function') {
    try {
      await publishReject({
        reason: validationFinal.reason,
        gatedCount: unpromotedGated.length,
        stats: validationFinal.stats,
        day,
        nowMs,
      });
    } catch (err) {
      errors.push(`dream.rejected publish failed: ${err.message}`);
    }
  }

  const promoted = [];
  let skippedRawToolError = 0;
  if (apply && memory && validationFinal.ok) {
    const writeCalls = planToWriteCalls(validationFinal.plan);
    for (let i = 0; i < writeCalls.length; i += 1) {
      const wc = writeCalls[i];
      const candidate = unpromotedGated[i];
      // 2026-10-19 提升边界闸：工具错误来源的候选，写进本体的文本必须自带因果句式。
      // 抽取层的判据作用在原始 stderr 上；这里判的是「实际写进本体的那串文本」。
      const blocked = promotionBlockReason(candidate, { toolErrorDiagnosticOnly });
      if (blocked) {
        skippedRawToolError += 1;
        continue;
      }
      try {
        const saved = await wc.write(
          memory,
          `agint-dream ${day} from ${candidate.sessionKey} [${wc.action}]`,
        );
        promoted.push({ candidate, entry: { id: saved.id, type: saved.type, content: saved.content, confidence: saved.confidence, evidence: saved.evidence } });
        // P2: 回写 promotedAt
        try {
          await recallStoreMarkPromoted(rPath, candidate.key ?? recallKey(normalizeForCompare(candidate.text)), { nowMs, snippet: candidate.text?.slice(0, 140) });
        } catch (err) {
          errors.push(`recall-store markPromoted failed: ${err.message}`);
        }
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
          recSignals.push(collectSessionSignals(await readSessionLog(log, sessionSource)));
        } catch (err) {
          errors.push(`${log.dir}(recover): ${err.message}`);
        }
      }
      const recScored = scoreCandidates(
        recSignals.flatMap((s) => extractCandidates(s, nowMs, { toolErrorDiagnosticOnly })),
        { nowMs },
      );
      // 2026-10-09 修：recovery 通道必须看得到「本轮主通道刚提升的条目」。
      // 原实现两处漏洞叠加 ⇒ 每晚必然重写刚写的候选：
      //   ① existing 在 sweep.js:1166 只 memory.list() 一次，主循环 promote 后不回灌；
      //   ② recovery 没有主通道（1173-1176）那道 promotedAt 过滤。
      // 生产证据：agint.json tables.memory 里 6 条同内容重复，evidence 带
      // `deep-recovery from` 的就是第二次写入，跨 09-30 / 10-01 / 10-08 三晚。
      // 两道都补：existing 补上本轮 promoted 的 entry（给 gateCandidates 做文本去重），
      // 再用 promotedKeys 过滤（抓 similarity 低于 dedupeHigh 但 recall key 完全相同的）。
      const promotedKeys = new Set();
      for (const p of promoted) {
        if (p.candidate) promotedKeys.add(p.candidate.key ?? recallKey(normalizeForCompare(p.candidate.text)));
      }
      const existingForRecovery = existing.concat(
        promoted.map((p) => ({ id: p.entry?.id, type: p.entry?.type, content: p.entry?.content })),
      );
      const recEligible = recScored.filter((c) => {
        if (c.signalCount < 3 || c.uniqueDays < 2) return false;
        const k = c.key ?? recallKey(normalizeForCompare(c.text));
        return !promotedKeys.has(k);
      });
      const recGated = gateCandidates(
        recEligible,
        existingForRecovery,
        { minScore: minScore ?? DEFAULTS.minScore, minRecall: 3, minUniqueSessions: 2, ...dedupeOpts },
      );
      // P0: recovery 也走 validation gate
      const recValidation = validateAndApply({
        gated: recGated,
        existing: existingForRecovery,
        operations: null,
        maxPriorEntryLossFraction: maxPriorEntryLossFraction ?? 0.25,
      });
      if (apply && recValidation.ok) {
        const recWriteCalls = planToWriteCalls(recValidation.plan);
        for (let i = 0; i < recWriteCalls.length; i += 1) {
          const wc = recWriteCalls[i];
          const candidate = recGated[i];
          // 2026-10-19：recovery 通道走同一条提升边界闸（它同样不经过 LLM 挑选）。
          const blocked = promotionBlockReason(candidate, { toolErrorDiagnosticOnly });
          if (blocked) {
            skippedRawToolError += 1;
            continue;
          }
          try {
            const saved = await wc.write(
              memory,
              `agint-dream ${day} deep-recovery from ${candidate.sessionKey} [${wc.action}]`,
            );
            promoted.push({ candidate, entry: { id: saved.id, type: saved.type, content: saved.content, confidence: saved.confidence, evidence: saved.evidence } });
            try {
              await recallStoreMarkPromoted(rPath, candidate.key ?? recallKey(normalizeForCompare(candidate.text)), { nowMs, snippet: candidate.text?.slice(0, 140) });
            } catch (err) {
              errors.push(`recall-store markPromoted (recovery) failed: ${err.message}`);
            }
          } catch (err) {
            errors.push(`recover promote failed: ${err.message}`);
          }
        }
      }
      recovered.push(...recGated);
    }
  }

  // ── P2 30 天剪枝（每个 sweep 完跑一次）──────────────────────────────
  let pruneResult = null;
  if (apply) {
    try {
      pruneResult = await recallStorePrune(rPath, { nowMs, retentionDays: 30 });
    } catch (err) {
      errors.push(`recall-store prune failed: ${err.message}`);
    }
  }

  // ── Diary ───────────────────────────────────────────────────────────────
  const diary = renderDiary({
    day,
    apply,
    signals,
    memWrites,
    candidates,
    gated,
    promoted,
    recovered,
    errors,
    durationMs: Date.now() - startedAt,
    windows: { light: lightDays, rem: remDays, deep: deepRecoveryDays ?? DEFAULTS.deepRecoveryDays },
    // P0/P2 扩展字段（renderDiary 内部可选展示）
    skippedPromoted,
    // 2026-10-19：提升边界闸拦截数
    skippedRawToolError,
    validationOk: validationFinal.ok,
    validationReason: validationFinal.reason,
    recallWrite: recallWriteResult,
    pruneResult,
    // P1 LLM consolidation 模式（llm / not-attempted / failed）
    consolidationMode,
    consolidationReason,
    // v0.2 (task 2 / C2 / 2026-09-06)：REM 阶段 qualityEvaluator 评估摘要
    qualityEvalSummary,
    // v0.3 (task 3 / 2026-09-06)：Deep 阶段 evolution 摘要
    evolutionSummary,
    evolutionBoost,
    // 2026-09-18：零命中健康度（degraded 时 diary 里会出现醒目告警块）
    health,
    // 2026-09-21（方案 B）：去重分档统计
    dedupeStats,
    // 2026-09-28：工具错误诊断过滤统计
    toolErrorStats,
    // 2026-10-23（提案 0f6c69bc）：信号源过滤统计
    sourceFilterStats,
  });
  await mkdir(resolve(diaryRoot), { recursive: true });
  // 2026-09-28：dry-run 写 `<day>.preview.md`，不碰 `<day>.md`。
  // 此前两者共用一个文件名 ⇒ 一次预览就把当天真实 sweep 的日记覆盖成
  // 「promoted=0」的预览（09-28 实测：24 条提升明细被冲掉）。
  // 预览文件名不匹配 `^\d{4}-\d{2}-\d{2}\.md$`，因此不会被 dream_diary 的
  // 「取最新一篇」和 index.js 的 readLatestDiaryMtime 误认成真实记录。
  const diaryPath = join(resolve(diaryRoot), apply ? `${day}.md` : `${day}.preview.md`);
  await writeFile(diaryPath, diary, 'utf8');

  const result = {
    day,
    diaryPath,
    apply,
    counts: {
      sessions: signals.length,
      userMessages: signals.reduce((n, s) => n + s.userTexts.length, 0),
      memWrites: memWrites.length,
      toolErrors: signals.reduce((n, s) => n + s.errors.length, 0),
      // 2026-09-28：过滤统计（扁平形状 —— tools.js 的 output schema 是
      // additionalProperties:false，byReason 开放字典没法声明，故不进工具返回）
      toolErrorFilter: {
        enabled: toolErrorStats.enabled,
        total: toolErrorStats.total,
        kept: toolErrorStats.kept,
        dropped: toolErrorStats.dropped,
        // 2026-10-28：来源分档（结构化判定 vs 严格前缀兜底）。
        // 旧判据误判率 84%（243 vs 39，7 天实测）——这两个数字是那段误判的证词。
        structured: toolErrorStats.structured ?? 0,
        legacy: toolErrorStats.legacy ?? 0,
      },
      // 2026-10-23（提案 0f6c69bc）：信号源过滤统计。形状扁平（与 toolErrorFilter 同款），
      // 因为 tools.js 的 output schema 是 additionalProperties:false，
      // 漏声明会让 dream_status / dream_run_now 整体不可用（K164 同形状事故）。
      sourceFilter: {
        humanKept: sourceFilterStats.humanKept,
        unknownKept: sourceFilterStats.unknownKept,
        subagentDropped: sourceFilterStats.subagentDropped,
        judgeFailed: sourceFilterStats.judgeFailed,
      },
      candidates: scored.length,
      gated: gated.length,
      skippedPromoted,
      // 2026-10-19：提升边界闸拦下的工具错误残骸数（0 = 没有残骸想进本体）
      skippedRawToolError,
      // 2026-09-21（方案 B）：去重分档统计 —— { enabled, dropped, suspicious, checked, maxSimilarity }
      dedupeStats,
      validationOk: validationFinal.ok,
      validationReason: validationFinal.reason ?? null,
      recovered: recovered.length,
      promoted: promoted.length,
      recallAppended: recallWriteResult?.appended ?? 0,
      recallPruned: pruneResult?.dropped ?? 0,
      // P1 LLM consolidation mode
      consolidationMode,
      consolidationReason,
      // v0.2 (task 2 / C2 / 2026-09-06)：REM qualityEvaluator 评估摘要
      // shape: { status, compositeMean, harmMean, targetCount, okCount }
      qualityEval: {
        status: qualityEvalSummary?.status ?? 'unavailable',
        compositeMean: qualityEvalSummary?.compositeMean ?? null,
        harmMean: qualityEvalSummary?.harmMean ?? null,
        targetCount: qualityEvalSummary?.targets?.length ?? 0,
        okCount: (qualityEvalSummary?.targets ?? []).filter((t) => t.status === 'ok').length,
      },
      // v0.3 (task 3 / 2026-09-06)：Deep 阶段 evolution success-templates 摘要
      // shape: { status, count, topConfidence, boost }
      evolutionTemplates: {
        status: evolutionSummary?.status ?? 'unavailable',
        count: evolutionSummary?.count ?? 0,
        topConfidence: evolutionSummary?.topConfidence ?? null,
        boost: evolutionBoost ?? 0,
      },
    },
    // 2026-09-18：零命中健康度。形状见 lib/health.js 的 evaluateZeroHitHealth：
    // { status, consecutiveZeroHit, threshold, enabled, lastNonZeroAt, reason }
    health,
    promoted: promoted.map((p) => ({ type: p.entry.type, content: p.entry.content, score: p.candidate.score ?? 0, id: p.entry.id })),
    errors,
    durationMs: Date.now() - startedAt,
  };

  // 返回前做 JSON 安全化：递归把 undefined → null，避免 DSH "not lossless JSON"
  // 严格模式因 undefined 拒绝整个返回值。Set/Map 已在上游转 array。
  return sanitizeJson(result);
}

function sanitizeJson(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeJson(v);
    return out;
  }
  // Set/Map/函数/符号 等：转成可序列化表示或 null
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Set) return [...value].map(sanitizeJson);
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [k, sanitizeJson(v)]));
  return String(value);
}
