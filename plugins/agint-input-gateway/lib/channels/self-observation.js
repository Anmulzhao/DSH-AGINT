/**
 * C2 系统自观测 Channel — v0.2（2026-09-29 实现 metrics 退化检测）。
 *
 * 从现有 AGINT 状态文件提取异常信号，不引入新数据源。
 * 文件路径基于 DSH_HOME 环境变量，不存在时静默返回空。
 *
 * 5 个子源：
 *   1. toolStats 异常    — ok===false 失败率突增 + 单工具连续失败
 *   2. metrics 退化      — error 类指标快照对比，涨幅 >50% 报告
 *   3. 规则高频命中      — 从 tool_stats 统计 errorKind==='denied' 频率
 *   4. 压缩丢失          — 调用 agint.compressGuard.stats()
 *   5. session 完整性    — P2 留接口（需 session/event 事件流）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CHANNEL_IDS, CHANNEL_TYPES, C2_CRON } from '../schema.js';
// 跨插件引用走相对路径（与 `agint-skill-autocreate/lib/semantic-window.js:24`
// 引 `../../agint-session-extract/index.js` 同形）。
// ⛔ 不用裸包名 'agint-session-source'：全仓 grep 命中 **0 行** 这种写法，
//    插件间依赖在部署位不是 npm 包树，裸包名解析不到。
import { createSessionSource, findSessionLogFile } from '../../../agint-session-source/lib/index.mjs';

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function storagesDir() {
  return join(dshHome(), 'storages');
}

function safeReadJson(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeReadLines(filePath) {
  try {
    if (!existsSync(filePath)) return [];
    return readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** 读取最近 N 条 tool_stats 记录 */
function readRecentToolStats(n = 200) {
  const lines = safeReadLines(join(storagesDir(), 'agint_tool_stats.jsonl'));
  if (lines.length === 0) return [];
  return lines.slice(-n).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/**
 * 子源 1：toolStats 异常
 *
 * 真实 schema：{ts, sessionId, turn, step, tool, callId, latencyMs, ok, errorKind, ...}
 * 失败判定：ok === false（不管 errorKind 是否为空——空是"未分类失败"，仍是失败）
 *
 * 两个检测条件（任一触发）：
 *   a) 失败率突增：最近 200 条失败率 > 15%（基线 ~5-7%，3 倍突增）
 *   b) 单工具连续失败：同一 tool 连续 ≥3 次 ok===false
 */
function detectToolAnomaly() {
  const recent = readRecentToolStats(200);
  if (recent.length < 20) return [];

  const signals = [];

  // a) 失败率突增
  const failed = recent.filter((r) => r.ok === false);
  const failRate = failed.length / recent.length;
  if (failRate > 0.15) {
    const byKind = {};
    for (const f of failed) {
      const k = f.errorKind || '(unclassified)';
      byKind[k] = (byKind[k] || 0) + 1;
    }
    signals.push({
      signalId: `tool-anomaly-rate-${Date.now()}`,
      source: 'tool-stats',
      signalType: 'tool.anomaly',
      payload: {
        detection: 'fail_rate_spike',
        recentCalls: recent.length,
        failedCalls: failed.length,
        failRate: Number(failRate.toFixed(3)),
        threshold: 0.15,
        byErrorKind: byKind,
        note: `最近 ${recent.length} 次工具调用失败率 ${(failRate * 100).toFixed(1)}%，超过阈值 15%（基线 ~6%）`,
      },
      confidence: 0.8,
      relevance: 0.7,
      occurredAt: new Date().toISOString(),
      rawRef: join(storagesDir(), 'agint_tool_stats.jsonl'),
    });
  }

  // b) 单工具连续失败（窗口内同一 tool 的最长失败游程）
  //
  // 2026-10-14 修复：原实现在遇到第一条成功记录时 `break` —— 那测的是
  // 「文件末尾的失败游程」，不是「窗口内的最长游程」。真实数据末尾那条
  // 几乎总是成功的 ⇒ maxStreakCount 恒为 0 ⇒ 该判据从未生效过。
  // 实测（agint_tool_stats.jsonl，16822 行）：最近 200 条里 pwsh 有连续
  // 16 次 ok===false（阈值 ≥3），而修复前产出 0 条信号 —— 检测器全 active
  // 却静默漏检，正是「看起来健康实则失明」。
  //
  // 正确语义：同一 tool 的**相邻**失败才算连续；中间夹一次成功即断链。
  // 所以逐条维护「当前游程」（遇成功归零），并取历史最大值。
  const cur = {};          // tool → 当前连续失败数
  const best = {};         // tool → 窗口内最长连续失败数
  let maxStreakTool = null;
  let maxStreakCount = 0;
  for (let i = 0; i < recent.length; i++) {
    const r = recent[i];
    const t = r.tool;
    if (r.ok === false) {
      cur[t] = (cur[t] || 0) + 1;
      if (cur[t] > (best[t] || 0)) best[t] = cur[t];
      if (best[t] > maxStreakCount) {
        maxStreakCount = best[t];
        maxStreakTool = t;
      }
    } else {
      cur[t] = 0;          // 成功 ⇒ 该 tool 的游程断链
    }
  }
  if (maxStreakCount >= 3 && maxStreakTool) {
    signals.push({
      signalId: `tool-anomaly-streak-${Date.now()}`,
      source: 'tool-stats',
      signalType: 'tool.anomaly',
      payload: {
        detection: 'consecutive_failures',
        tool: maxStreakTool,
        consecutiveFailures: maxStreakCount,
        note: `工具 ${maxStreakTool} 连续 ${maxStreakCount} 次调用失败`,
      },
      confidence: 0.85,
      relevance: 0.75,
      occurredAt: new Date().toISOString(),
      rawRef: join(storagesDir(), 'agint_tool_stats.jsonl'),
    });
  }

  return signals;
}

// ── 子源 2：metrics 退化 ──────────────────────────────────────────────────

const ERROR_METRIC_KEYS = /blocked|rejected|fail|error|deny|stale|anomaly/i;

function metricsSnapshotFile() {
  return join(dshHome(), 'storages', 'agint_input_gateway_metrics_snapshot.json');
}

function loadMetricsSnapshot() {
  try {
    if (!existsSync(metricsSnapshotFile())) return {};
    return JSON.parse(readFileSync(metricsSnapshotFile(), 'utf8'));
  } catch { return {}; }
}

function saveMetricsSnapshot(snap) {
  try {
    const dir = join(dshHome(), 'storages');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(metricsSnapshotFile(), JSON.stringify(snap, null, 2), 'utf8');
  } catch { /* 软降级 */ }
}

/**
 * 子源 2：metrics 退化
 *
 * tables.metric 下按时间追加 {id, key, label, value, unit, meta, ts}。
 * 取 error 类指标的最新值，与上次快照对比。
 * 触发：当前值 > 上次值 × 1.5 且差值 > 5。
 */
function detectMetricRegression() {
  const metrics = safeReadJson(join(storagesDir(), 'agint_metrics.json'));
  if (!metrics?.tables?.metric) return [];

  // 取每个 error 类 key 的最新记录
  const latestByKey = {};
  for (const [, rec] of Object.entries(metrics.tables.metric)) {
    if (!ERROR_METRIC_KEYS.test(rec.key)) continue;
    const existing = latestByKey[rec.key];
    if (!existing || (rec.ts || '') > (existing.ts || '')) {
      latestByKey[rec.key] = rec;
    }
  }

  const prev = loadMetricsSnapshot();
  const newSnap = {};
  const signals = [];

  for (const [key, rec] of Object.entries(latestByKey)) {
    newSnap[key] = rec.value;
    const old = prev[key];
    if (typeof old !== 'number' || old === 0) continue; // 首次记录不报告
    const increase = rec.value - old;
    if (increase > 5 && rec.value > old * 1.5) {
      signals.push({
        signalId: `metric-regression-${key}-${Date.now()}`,
        source: 'metrics',
        signalType: 'metric.regression',
        payload: {
          metricKey: key,
          previousValue: old,
          currentValue: rec.value,
          increase: Math.round(increase * 100) / 100,
          ratio: Math.round((rec.value / old) * 100) / 100,
          note: `指标 ${key} 从 ${old} 涨到 ${rec.value}（×${(rec.value / old).toFixed(1)}）`,
        },
        confidence: 0.6,
        relevance: 0.6,
        occurredAt: new Date().toISOString(),
        rawRef: join(storagesDir(), 'agint_metrics.json'),
      });
    }
  }

  saveMetricsSnapshot(newSnap);
  return signals;
}

/**
 * 子源 3：规则高频命中
 *
 * 从 tool_stats 统计 errorKind === 'denied' 的频率。
 * 真实数据：全量 9277 条里 denied=4（0.04%），基线 ≈ 0。
 * 阈值：最近 200 条里 denied ≥1 就报告——基线是 0，任何一次规则拒绝都值得注意。
 */
function detectRuleHotspot() {
  const recent = readRecentToolStats(200);
  if (recent.length === 0) return [];

  const denied = recent.filter((r) => r.errorKind === 'denied');
  if (denied.length < 1) return [];

  const byTool = {};
  for (const d of denied) {
    byTool[d.tool] = (byTool[d.tool] || 0) + 1;
  }

  return [{
    signalId: `rule-hotspot-${Date.now()}`,
    source: 'tool-stats',
    signalType: 'rule.hotspot',
    payload: {
      deniedCount: denied.length,
      windowSize: recent.length,
      byTool,
      note: `最近 ${recent.length} 次工具调用中 ${denied.length} 次被规则拒绝（基线 0，任何 1 次即报告）`,
    },
    confidence: 0.7,
    relevance: 0.6,
    occurredAt: new Date().toISOString(),
    rawRef: join(storagesDir(), 'agint_tool_stats.jsonl'),
  }];
}

/**
 * 子源 4：压缩丢失
 * 通过 ctx 获取 agint.compressGuard service，调用 stats()。
 */
function detectCompressLoss(ctx) {
  const compressGuard = ctx?.services?.compressGuard;
  if (!compressGuard || typeof compressGuard.stats !== 'function') return [];

  try {
    const stats = compressGuard.stats();
    const signals = [];

    if (stats.status === 'BLOCKED' || stats.status === 'DEGRADED') {
      signals.push({
        signalId: `compress-loss-${Date.now()}`,
        source: 'compress-guard',
        signalType: 'compress.loss',
        payload: {
          status: stats.status,
          note: `压缩护栏状态异常: ${stats.status}`,
        },
        confidence: 0.9,
        relevance: 0.8,
        occurredAt: new Date().toISOString(),
      });
    }

    return signals;
  } catch {
    return [];
  }
}

// ── 子源 5：session 完整性（v0.3.0 实装）──────────────────────────────────

/** zstd 二进制解析（对齐 agint-session-extract 的 resolveZstdBin 语义） */
function resolveZstdBin() {
  if (process.env.ZSTD_BIN) return process.env.ZSTD_BIN;
  const fallback = process.platform === 'win32'
    ? ['D:/Tools/zstd/zstd.exe', 'C:/Tools/zstd/zstd.exe', 'D:/Tools/zstd/zstd', 'C:/Tools/zstd/zstd']
    : ['/usr/bin/zstd', '/usr/local/bin/zstd', '/bin/zstd'];
  for (const p of fallback) {
    try { if (existsSync(p)) return p; } catch { /* ignore */ }
  }
  return 'zstd';
}

/**
 * 会话日志发现：2026-10-19 起走 `agint-session-source` 统一入口。
 *
 * 原状是本文件**硬编码三个名字**（v4/v3/无版本）且**无后缀兜底**，
 * `cross-agent.js` 还持着第二份一模一样的副本。宿主下次改名（v5）这里会再瞎一次 ——
 * 09-22 改 v4 时同类事故让 autocreate 供料断了 12 天（M1 断链）。
 *
 * 新形状：上游 `sessionQuery` 服务可用 ⇒ 走它；不可用 ⇒ 回落下面的本地发现层，
 * **且回落必须出声**（onFallback）。静默 skip 是这个项目最坏的一类失败。
 *
 * 2026-10-19（F5 收口二步）：本文件与 cross-agent.js 的两份名字表**都删了**，
 * 统一用 session-source 的 `findSessionLogFile`（候选名优先 + 后缀兜底）。
 */

/** 回落发现层：候选名优先，其次按后缀兜底（不再因宿主改名而静默归零）。 */
function listRecentSessionsFallback(maxCount = 8) {
  const root = join(dshHome(), 'sessions');
  let workspaces;
  try { workspaces = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const wsDir = join(root, ws.name);
    let dirs;
    try { dirs = readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dirPath = join(wsDir, d.name);
      // 候选名 + 后缀兜底都在 session-source（唯一真相源）
      const hit = findSessionLogFile(dirPath, { statSync, readdirSync });
      if (!hit) continue;
      // 形状契约（2026-10-19）：回落层必须与适配器出口同形 { dir, path, mtimeMs }。
      // 上一版这里写 sessionId: d.name，而 listRecentSessions 出口 mapper 读 r.dir ⇒
      // 回落时 sessionId 全变 undefined（被 session-integrity 测试抓出：
      // actual [undefined, undefined] vs expected [sid-1, sid-2]）。
      try { found.push({ dir: d.name, path: hit, mtimeMs: statSync(hit).mtimeMs }); }
      catch { /* stat 失败跳过 */ }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, maxCount);
}

/**
 * 拿一个会话源。ctx 由调用方注入（channel 拿不到 ctx ⇒ 传 null 走回落）。
 * ⛔ 回落的出声回调必需：没它就抛错，不静默降级。
 */
export function createSessionSourceForSelfObservation({ ctx = null, onFallback }) {
  return createSessionSource({
    ctx,
    fallback: ({ maxCount = 8 } = {}) => listRecentSessionsFallback(maxCount),
    onFallback,
    source: 'input-gateway/self-observation',
  });
}

/**
 * 列出最近 maxCount 个会话文件（mtime 排序；同会话多格式只取最新存在者）。
 * 结构：sessionsRoot/<workspace>/<sessionId>/session.{v3,v4,}.jsonl.zstd
 *
 * 2026-10-19 改：走 `agint-session-source`（上游优先 + 回落出声）。
 * 既有调用方不用改签名；ctx 缺省时走回落并出声。
 */
export async function listRecentSessions(maxCount = 8, { ctx = null, onFallback = null } = {}) {
  // ⚠️ 2026-10-21 回退（运行态取证）——本通道**按设计走本地原始日志**，不走上游。
  //
  // 为什么必须回退（D1 迁移把这条链接上上游后，它反而瞎了）：
  //   ① **检测对象不同**：完整性检查查的是磁盘上的**原始日志**（坏行 / seq 断裂 /
  //      缺 content / 未配对 call）。上游 `readSession` 给的是**重放校验后**的
  //      事件流 —— 缺陷在校验阶段就被抹平 ⇒ 拿它做完整性检查，检测能力直接归零。
  //   ② **上游不给磁盘路径**：`listSessions` 的记录没有 path ⇒ 下游拿到的
  //      `path` 是空串 ⇒ 解压必然失败 ⇒ 全部会话被判为 undecompressible。
  //
  // 宿主若再改会话日志命名，本通道靠 `findSessionLogFile` 的候选名 + 后缀兜底兜住
  // （2026-09-22 改名致 12 天断供的教训）。
  //
  // 代价要说清：这仍是 B-008 登记的「宿主层能力自建」（自拉 zstd 解压），
  // 本轮**不**消除 —— 完整性检查需要原始字节，上游目前不提供该形态。
  void ctx;
  const notify = onFallback ?? ((reason) => {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`[input-gateway/self-observation] 会话源降级: ${reason}`);
    }
  });
  notify('local-by-design: session 完整性检查必须读原始日志（上游是重放校验后的产物，且不含磁盘路径）');
  // 对齐既有形状：{ path, sessionId, mtimeMs }
  return listRecentSessionsFallback(maxCount).map((r) => ({
    path: r.path ?? '', sessionId: r.dir, mtimeMs: r.mtimeMs,
  }));
}

/**
 * 检测单个会话文件的完整性（解压 + 解析 + 结构检查）。
 * 真实 v4 事件形状（2026-09-29 探针）：
 *   首行 {type:'session', version, id, createdAt, ...}（无 seq）
 *   后续 {type, seq:0,1,2..., time, data:{...}}
 * 检测项：
 *   - 坏行：JSON.parse 失败的行
 *   - seq 断裂：相邻事件 seq 跳跃次数
 *   - 缺 content：有 content/message 字段但内容为空的事件
 *   - 未配对 call：tool/call 的 callId 无对应 tool/result
 * 解压失败（zstd 缺失/文件损坏）返回 { decompressError }。
 *
 * ⚠️ 2026-10-21 回退（运行态取证）：**只读本地原始日志**，不走上游。
 *   ① 完整性检查查的就是原始日志的缺陷（坏行 / seq 断裂 / 缺 content / 未配对 call）；
 *      上游 `readSession` 给的是**重放校验后**的事件流 ⇒ 缺陷已被抹平，
 *      拿它检查等于拿干净数据找脏东西 —— 检测能力直接归零。
 *   ② 上游记录不含磁盘路径，本函数却必须拿到日志文件才能解压。
 *   ⇒ 本函数签名不再接受 sessionSource（2026-10-21 之前接受过，见 git 史）。
 */
export async function inspectSessionFile(file) {
  let events;
  let decompressError = null;
  let badLinesSeen = null;   // zstd 路径读入时累计的坏行数

  {
    const bin = resolveZstdBin();
    try {
      const text = execFileSync(bin, ['-dc', file.path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      // ⛔ 不能 .filter(Boolean) 丢坏行 —— 那等于把"坏行计数"这个检测项废掉。
      // 旧代码是在循环里 try/catch 计数。这里必须保留坏行数。
      const lines = text.split('\n').filter((l) => l.trim());
      const parsed = [];
      let zstdBadLines = 0;
      for (const line of lines) {
        try { parsed.push(JSON.parse(line)); } catch { zstdBadLines += 1; }
      }
      events = parsed;
      badLinesSeen = zstdBadLines;
    } catch (e) {
      return { decompressError: String(e?.message || e).slice(0, 200) };
    }
  }

  if (decompressError) return { decompressError };

  let badLines = badLinesSeen ?? 0;
  let prevSeq = null;
  let seqGaps = 0;
  let missingContent = 0;
  const callIds = new Set();
  const resultIds = new Set();

  for (const ev of events) {
    const seq = ev?.seq;
    if (typeof seq === 'number') {
      if (prevSeq !== null && seq !== prevSeq + 1) seqGaps += 1;
      prevSeq = seq;
    }
    const data = ev?.data;
    if (data && typeof data === 'object') {
      const hasContentField = data.content !== undefined || data.message !== undefined;
      if (hasContentField) {
        const content = data.content ?? data.message?.content;
        const empty = content == null
          || (typeof content === 'string' && content.trim() === '')
          || (Array.isArray(content) && content.length === 0);
        if (empty) missingContent += 1;
      }
    }
    if (ev?.type === 'tool/call') {
      const callId = data?.callId;
      if (callId) callIds.add(callId);
    }
    if (ev?.type === 'tool/result') {
      const tcId = data?.message?.content?.[0]?.toolCallId;
      if (tcId) resultIds.add(tcId);
    }
  }

  const unpairedCalls = [...callIds].filter((id) => !resultIds.has(id)).length;
  const isRecent = Date.now() - file.mtimeMs < 24 * 60 * 60 * 1000;
  return {
    sessionId: file.sessionId,
    path: file.path,
    totalLines: events.length,
    badLines,
    badLineRate: events.length ? badLines / events.length : 0,
    seqGaps,
    missingContent,
    unpairedCalls,
    isRecent,
  };
}

/**
 * 子源 5：session 完整性（v0.3.0）。
 * 数据源：~/.dsh/sessions/<workspace>/<sessionId>/session.{v3,v4,}.jsonl.zstd
 * 最近 8 个会话（mtime 排序）。zstd 不可用时整体软降级返回 []（不误报"全会话损坏"）。
 */
async function detectSessionIntegrity({ ctx = null, onFallback = null } = {}) {
  if (!existsSync(resolveZstdBin())) return [];     // zstd 缺失 → 软降级
  // 2026-10-19：listRecentSessions 改为异步（要走上游服务探测），调用方必须 await。
  const files = await listRecentSessions(8, { ctx, onFallback });
  if (files.length === 0) return [];

  const issues = [];
  for (const f of files) {
    const insp = await inspectSessionFile(f);
    if (insp.decompressError) {
      issues.push({ sessionId: f.sessionId, flags: ['undecompressible'], totalLines: 0, badLines: 0, badLineRate: 0, seqGaps: 0, missingContent: 0, unpairedCalls: 0, path: f.path });
      continue;
    }
    const flags = [];
    if (insp.badLines >= 5 && insp.badLineRate > 0.05) flags.push('malformed-lines');
    if (insp.seqGaps >= 5) flags.push('seq-gaps');
    if (insp.missingContent >= 3) flags.push('missing-content');
    if (!insp.isRecent && insp.totalLines > 0 && insp.unpairedCalls / insp.totalLines > 0.2) {
      flags.push('unpaired-calls');
    }
    if (flags.length) issues.push({ ...insp, flags });
  }

  if (issues.length === 0) return [];
  return issues.map((i) => ({
    signalId: 'session-integrity-' + i.sessionId + '-' + Date.now(),
    source: 'sessions',
    signalType: 'session.integrity',
    payload: {
      sessionId: i.sessionId,
      flags: i.flags,
      totalLines: i.totalLines,
      badLines: i.badLines,
      badLineRate: Number(Number(i.badLineRate).toFixed(4)),
      seqGaps: i.seqGaps,
      missingContent: i.missingContent,
      unpairedCalls: i.unpairedCalls,
      note: '会话 ' + i.sessionId + ' 完整性异常：' + i.flags.join('；'),
    },
    confidence: 0.7,
    relevance: 0.7,
    occurredAt: new Date().toISOString(),
    rawRef: i.path,
  }));
}

/**
 * C2 Channel 实例。
 */
export const selfObservationChannel = {
  id: CHANNEL_IDS.SELF_OBSERVATION,
  type: CHANNEL_TYPES.SELF_OBSERVATION,
  cron: C2_CRON,

  async fetch(ctx) {
    const signals = [
      ...detectToolAnomaly(),
      ...detectMetricRegression(),
      ...detectRuleHotspot(),
      ...detectCompressLoss(ctx || {}),
      // ctx 透传给会话源：上游 sessionQuery 可用就走它，不可用回落并出声
      ...(await detectSessionIntegrity({ ctx: ctx || null })),
    ];
    return signals;
  },

  async health() {
    return {
      channelId: this.id,
      status: 'ok',
      subSources: 5,
      detectors: {
        toolAnomaly: { active: true, schema: 'ok===false', threshold: 'failRate>15% or streak>=3' },
        metricRegression: { active: true, schema: 'error-metric snapshot diff', threshold: 'current>prev*1.5 & increase>5' },
        ruleHotspot: { active: true, schema: 'errorKind===denied', threshold: '>=1 in last 200 (baseline=0)' },
        compressLoss: { active: true, depends: 'agint.compressGuard' },
        sessionIntegrity: { active: true, schema: '~/.dsh/sessions/<ws>/<sid>/session.{v3,v4,}.jsonl.zstd', threshold: 'badLines>=5&>5% | seqGaps>=5 | missingContent>=3 | unpaired>20%(非进行中)' },
      },
      note: 'v0.3: sessionIntegrity 实装（zstd 解压最近 8 会话，检测坏行/seq 断裂/缺 content/未配对 call）',
    };
  },
};
