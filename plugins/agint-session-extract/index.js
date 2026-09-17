/**
 * agint-session-extract — 中立会话提取器（纯函数模块，非 Cordis 插件）。
 *
 * 设计依据：2026-09-17《技能生成-分治架构设计.md》§4 / §7。
 * 目的：让 agint-dream 与 agint-skill-autocreate 各读各的、但读同一份真相
 * （~/.dsh/sessions/.../session.{v3,}.jsonl.zstd），从源头消除对
 * agint_tool_stats.jsonl「04:30 回填」的隐式时序依赖（静默漏检头号来源）。
 *
 * 不变量（约束 2）：
 *   - 不 import 任一插件（agint-dream / agint-skill-autocreate 一律不引）；
 *   - 无全局可变状态；
 *   - 允许 I/O（解压/列目录），但全部是「输入 path → 输出数据」的无副作用函数。
 * 两个插件只 import 本模块的函数，不 import 对方的 service —— 从根本上
 * 杜绝 Cordis 循环依赖。本模块是两条链唯一共享单点，故必须有单测锚定。
 *
 * 会话事件实测形状（2026-09-17 探针，v3 与 jsonl 两格式一致）：
 *   tool/call : { type:'tool/call', time:<ms>, seq,
 *                 data:{ turn, step, callId, name, arguments:<JSON字符串> } }
 *   tool/result: { type:'tool/result', time:<ms>, seq,
 *                 data:{ turn, step,
 *                   message:{ content:[{ type:'tool-result', toolCallId,
 *                     content:[...], isError:<bool> }] } } }
 * 故：tool/call 与 tool/result 经 callId/toolCallId 配对；ok = !isError；
 *     latencyMs = resultTime - callTime；arguments 是字符串需 JSON.parse。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * 解析 zstd 二进制路径。宿主环境不保证 zstd 在 PATH 里：
 *   - 本机 Windows：D:/Tools/zstd/zstd
 *   - gszx Linux 容器：/usr/bin/zstd
 * 故支持 ZSTD_BIN 环境变量覆盖，否则按平台兜底绝对路径，最后回退 'zstd'。
 */
export function resolveZstdBin() {
  if (process.env.ZSTD_BIN) return process.env.ZSTD_BIN;
  const fallback = process.platform === 'win32'
    ? ['D:/Tools/zstd/zstd', 'C:/Tools/zstd/zstd']
    : ['/usr/bin/zstd', '/usr/local/bin/zstd', '/bin/zstd'];
  for (const p of fallback) {
    try { if (require('node:fs').existsSync(p)) return p; } catch { /* ignore */ }
  }
  return 'zstd';
}

/** dsh 两种会话文件名；v3 较新，双格式并存时优先取 v3。 */
export const SESSION_FILE_NAMES = Object.freeze([
  'session.v3.jsonl.zstd',
  'session.jsonl.zstd',
]);

/**
 * 解压单个 zstd 会话文件 → 原始 jsonl 文本。
 * 宿主已装 zstd（本机 D:/Tools/zstd）；失败抛错由调用方 containment。
 */
export async function decompressSession(path, { maxBuffer = 64 * 1024 * 1024 } = {}) {
  const bin = resolveZstdBin();
  const { stdout } = await execFileAsync(bin, ['-dc', path], { maxBuffer, encoding: 'utf8' });
  return stdout;
}

/** 解析 jsonl 文本 → 事件数组（跳过坏行，不抛）。 */
export function parseSession(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip malformed line */ }
  }
  return out;
}

/** 解压 + 解析一步到位。 */
export async function loadSession(path) {
  return parseSession(await decompressSession(path));
}

/**
 * 列出某 sessions root 下所有会话日志。
 * 返回 [{ path, sessionId, format }]。同会话双格式并存时取 v3（更新）。
 * 结构：sessionsRoot/<workspace>/<sessionId>/session.{v3,}.jsonl.zstd
 */
export async function listSessionLogs(sessionsRoot) {
  const root = resolve(sessionsRoot);
  const logs = [];
  let workspaces;
  try { workspaces = await readdir(root, { withFileTypes: true }); }
  catch { return []; }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const wsDir = join(root, ws.name);
    let dirs;
    try { dirs = await readdir(wsDir, { withFileTypes: true }); }
    catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dirPath = join(wsDir, d.name);
      const v3 = join(dirPath, 'session.v3.jsonl.zstd');
      const jsonl = join(dirPath, 'session.jsonl.zstd');
      const hasV3 = await stat(v3).then(() => true).catch(() => false);
      if (hasV3) {
        logs.push({ path: v3, sessionId: d.name, format: 'v3' });
      } else {
        const hasJsonl = await stat(jsonl).then(() => true).catch(() => false);
        if (hasJsonl) logs.push({ path: jsonl, sessionId: d.name, format: 'jsonl' });
      }
    }
  }
  return logs;
}

/** 把 args 收敛成一行短串（行为切片 / Pipe A 物化用）。 */
export function argsToHead(args, maxLen = 120) {
  if (args == null || typeof args !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    let s;
    if (typeof v === 'string') s = v;
    else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
    else s = JSON.stringify(v);
    parts.push(`${k}=${s}`);
    if (parts.join(' ').length > maxLen) break;
  }
  const joined = parts.join(' ');
  return joined.length > maxLen ? joined.slice(0, maxLen) + '…' : joined;
}

/**
 * 结构提取：归一化工具调用，输出与 aggregator 输入兼容的 record。
 *   { ts, sessionId, turn, step, tool, callId, latencyMs, ok, errorKind, args, argsHead }
 * 配对规则：tool/call → tool/result（经 callId/toolCallId），ok=!isError，
 *   latencyMs=resultTime-callTime。无 result 事件时 ok=null（诚实缺失，不猜成功）。
 *
 * 设计稿 §5.1 三个收益的前提：这里直接拿到 turn/step/args，**无需回填**。
 */
export function extractToolCalls(events, { sessionId = null } = {}) {
  // 1) 建 result 索引：toolCallId → { isError, time }
  const results = new Map();
  for (const e of events) {
    if (e?.type !== 'tool/result') continue;
    const d = e.data || {};
    const content = Array.isArray(d?.message?.content) ? d.message.content : [];
    for (const blk of content) {
      if (blk?.type === 'tool-result' && blk.toolCallId) {
        results.set(blk.toolCallId, { isError: blk.isError === true, time: e.time ?? null });
      }
    }
  }

  const out = [];
  for (const e of events) {
    if (e?.type !== 'tool/call') continue;
    const d = e.data || {};
    const callId = d.callId ?? null;
    const name = d.name ?? d.tool ?? null;
    if (!name) continue; // 无名调用无法归属工具，跳过

    let args = {};
    try {
      args = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : (d.arguments ?? {});
    } catch { args = {}; }

    const callTime = typeof e.time === 'number' ? e.time : null;
    const res = callId ? results.get(callId) : null;
    const resultTime = res?.time ?? null;
    const ok = res ? (res.isError !== true) : null;
    let latencyMs = null;
    if (callTime != null && resultTime != null && resultTime >= callTime) {
      latencyMs = resultTime - callTime;
    }

    out.push({
      ts: callTime ?? resultTime, // 排序键：调用时刻优先
      sessionId,
      turn: d.turn ?? null,
      step: d.step ?? null,
      tool: name,
      callId,
      latencyMs,
      ok,
      errorKind: ok === false ? 'tool-result-isError' : null,
      args,
      argsHead: argsToHead(args),
    });
  }
  return out;
}

/**
 * 文本窗口：给定锚点 {turn, step}，取前后 radius 条「人话」文本（提案语义原料）。
 * 收集带可读文本的事件（user/assistant 消息、tool/result 文本），按与锚点的距离
 * 选最近锚点，切片返回 before/after。
 *
 * opts.withMeta=true（Phase 2 新增，向后兼容）：
 *   返回条目为对象 `{ text, role, kind, type, turn, step }` 而非裸字符串。
 *   提案层据此区分「真人类消息」与 subagent prompt / plugin 注入原文
 *   （后者 data.source.kind 为 plugin/skill-catalog/agent-instructions 等），
 *   避免把系统注入当用户意图写进技能正文。
 *   不传时返回形态与 Phase 1 完全一致（裸字符串数组）。
 */
export function extractTextWindows(events, anchor, radius = 4, opts = {}) {
  const withMeta = opts.withMeta === true;
  const texts = [];
  for (const e of events) {
    const t = eventToText(e);
    if (!t) continue;
    texts.push({
      turn: e?.data?.turn ?? null,
      step: e?.data?.step ?? null,
      text: t,
      meta: {
        type: e?.type ?? null,
        role: eventRole(e),
        kind: e?.data?.source?.kind ?? null,
        time: typeof e?.time === 'number' ? e.time : null,
      },
    });
  }
  if (texts.length === 0) return { before: [], after: [] };
  const aTurn = anchor?.turn;
  const aStep = anchor?.step ?? 0;
  let idx = -1;
  let best = Infinity;
  texts.forEach((t, i) => {
    if (t.turn == null) return;
    const dist = Math.abs(t.turn - (aTurn ?? -1)) + Math.abs((t.step ?? 0) - aStep) * 0.001;
    if (dist < best) { best = dist; idx = i; }
  });
  if (idx < 0) return { before: [], after: [] };
  const shape = (arr) => (withMeta
    ? arr.map((t) => ({ text: t.text, turn: t.turn, step: t.step, ...t.meta }))
    : arr.map((t) => t.text));
  const before = shape(texts.slice(Math.max(0, idx - radius), idx));
  const after = shape(texts.slice(idx + 1, idx + 1 + radius));
  return { before, after };
}

/** 事件的角色归类：区分人类/助手/工具/系统/其他（其余含 plugin 注入等）。 */
export function eventRole(e) {
  const t = e?.type;
  if (typeof t !== 'string' || !t) return 'unknown';
  if (t.startsWith('user/')) return 'user';
  if (t.startsWith('assistant/')) return 'assistant';
  if (t.startsWith('tool/')) return 'tool';
  if (t.startsWith('system/')) return 'system';
  return 'other';
}

/**
 * 按 sessionId 定位会话日志（语义窗口回查用）。
 * 找不到 → null（调用方降级，不抛）。
 */
export async function findSessionLog(sessionsRoot, sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  const logs = await listSessionLogs(sessionsRoot);
  return logs.find((l) => l.sessionId === sessionId) ?? null;
}

/** 从一条事件提取可读文本（无则返回 null）。 */
export function eventToText(e) {
  if (!e || typeof e !== 'object') return null;
  const d = e.data || {};
  // tool/result：取 content 文本
  if (e.type === 'tool/result') {
    const content = Array.isArray(d?.message?.content) ? d.message.content : [];
    const txt = content
      .filter((b) => b?.type === 'tool-result')
      .map((b) => blockText(b))
      .filter(Boolean)
      .join('\n');
    return txt || null;
  }
  // user/assistant 消息：message.content[].text
  const mc = Array.isArray(d?.message?.content) ? d.message.content : null;
  if (mc) {
    const txt = mc.map(blockText).filter(Boolean).join('\n');
    if (txt) return txt;
  }
  // ⚠️ 实测（2026-09-17，Phase 2 验收）：真实 `user/message` **没有** `data.message`
  // 包装，正文直接挂在 `data.content`（`dataKeys = [content, source, role, id]`，
  // 内容形如 `[{type:'text', text:'…'}]`）。
  // 只认 `data.message.content` 会让**全部人类消息不可见**（实测 401/401 返 null），
  // 直接掐死「WHY 取人类意图句」这条主通道——表象正常（助手侧兜底仍在出内容），
  // 故属静默失效。assistant/message 走 `data.message.content`，两种形态并存。
  const dc = d?.content;
  if (Array.isArray(dc)) {
    const txt = dc.map(blockText).filter(Boolean).join('\n');
    if (txt) return txt;
  }
  if (typeof dc === 'string' && dc) return dc;
  if (typeof d?.text === 'string' && d.text) return d.text;
  return null;
}

function blockText(b) {
  if (!b) return null;
  if (typeof b.text === 'string') return b.text;
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) return b.content.map(blockText).filter(Boolean).join('\n');
  return null;
}

/**
 * 记忆信号提取（Phase 3 / dream 复用）：仅认 memory_write 类调用。
 * 纯函数版，等价于 dream 现存 collectSessionSignals 的「memory 分支」。
 * 返回 [{ tool, args, turn, step, callId }]。
 */
export function extractMemorySignals(events) {
  const out = [];
  for (const e of events) {
    if (e?.type !== 'tool/call') continue;
    const d = e.data || {};
    const name = d.name ?? d.tool ?? '';
    if (!/memory/i.test(name)) continue;
    let args = {};
    try { args = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : (d.arguments ?? {}); }
    catch { args = {}; }
    out.push({ tool: name, args, turn: d.turn ?? null, step: d.step ?? null, callId: d.callId ?? null });
  }
  return out;
}

/**
 * 高层 I/O：读某 sessions root 下所有会话，产出聚合器兼容的 record 数组。
 * 仅 autocreate 的 detect 用；带 mtime 预过滤避免解压旧会话（性能护栏）。
 *
 * opts: { sinceMs, limit, signal }
 *   sinceMs — 仅取 mtime >= sinceMs 的会话（默认不过滤）
 *   limit   — 最多返回多少条 record（默认不限）
 */
export async function readSessionRecords(sessionsRoot, opts = {}) {
  const sinceMs = typeof opts.sinceMs === 'number' ? opts.sinceMs : null;
  const limit = opts.limit ?? Infinity;
  const logs = await listSessionLogs(sessionsRoot);
  const out = [];
  for (const log of logs) {
    if (out.length >= limit) break;
    // mtime 预过滤：会话文件最后修改晚于窗口起点才值得解压
    if (sinceMs != null) {
      const m = await stat(log.path).then((s) => s.mtimeMs).catch(() => null);
      if (m != null && m < sinceMs) continue;
    }
    let events;
    try { events = await loadSession(log.path); }
    catch { continue; }
    const recs = extractToolCalls(events, { sessionId: log.sessionId });
    for (const r of recs) {
      if (sinceMs != null && typeof r.ts === 'number' && r.ts < sinceMs) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  return out;
}
