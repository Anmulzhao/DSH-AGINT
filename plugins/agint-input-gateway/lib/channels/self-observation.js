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
import { join, isAbsolute } from 'node:path';
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
function detectToolAnomaly(report = null) {
  const recent = readRecentToolStats(200);
  if (recent.length < 20) {
    report?.({ skipped: 'insufficient-tool-stats', sampleSize: recent.length, minSample: 20 });
    return [];
  }

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

  report?.({
    sampleSize: recent.length,
    failedCalls: failed.length,
    failRate: Number(failRate.toFixed(3)),
    maxStreak: maxStreakCount,
    maxStreakTool,
  });

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
function detectMetricRegression(report = null) {
  const metrics = safeReadJson(join(storagesDir(), 'agint_metrics.json'));
  if (!metrics?.tables?.metric) {
    report?.({ skipped: 'no-metrics-data', file: join(storagesDir(), 'agint_metrics.json') });
    return [];
  }

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
  // trackedKeys 是把「守着一个恒 0 的指标」这种形状暴露出来的唯一办法：
  // 只看 produced=0 分不清「指标涨不动」和「压根没找到指标」。
  report?.({ trackedKeys: Object.keys(latestByKey), snapshotKeys: Object.keys(newSnap) });
  return signals;
}

/**
 * 子源 3：规则高频命中
 *
 * 从 tool_stats 统计 errorKind === 'denied' 的频率。
 * 真实数据：全量 9277 条里 denied=4（0.04%），基线 ≈ 0。
 * 阈值：最近 200 条里 denied ≥1 就报告——基线是 0，任何一次规则拒绝都值得注意。
 */
function detectRuleHotspot(report = null) {
  const recent = readRecentToolStats(200);
  if (recent.length === 0) {
    report?.({ skipped: 'no-tool-stats' });
    return [];
  }

  const denied = recent.filter((r) => r.errorKind === 'denied');
  if (denied.length < 1) {
    report?.({ sampleSize: recent.length, deniedCount: 0 });
    return [];
  }

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
function detectCompressLoss(ctx, report = null) {
  const compressGuard = ctx?.services?.compressGuard;
  if (!compressGuard || typeof compressGuard.stats !== 'function') {
    // 离线/少挂 compressGuard 时这里是「没检查」而不是「检查过没问题」——
    // 两者在 counters 上都是 produced=0，必须靠 report 分开。
    report?.({ skipped: 'compressGuard-unavailable' });
    return [];
  }

  try {
    const stats = compressGuard.stats();
    const signals = [];
    report?.({ guardStatus: stats?.status ?? null });

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
  } catch (e) {
    // 保持原行为（不抛，别让护栏自伤），但把故障记到 health 面上
    report?.({ error: String(e?.message ?? e).slice(0, 160) });
    return [];
  }
}

// ── 子源 5：session 完整性（v0.3.0 实装）──────────────────────────────────

/**
 * zstd 可执行文件的候选清单（按优先级）。
 *
 * 2026-11-01 修（v0.1.10）：原 fallback 只有 /usr/bin、/usr/local/bin、/bin 三处，
 * 而本机 zstd 装在 `~/.local/bin/zstd`（Debian/Ubuntu 上 pip/conda/手工装的常见位置）。
 * 三处全 miss 时旧实现 `return 'zstd'`（一个**命令名**），调用方却拿它去
 * `existsSync()` —— 那查的是 cwd 下的相对路径，不是 PATH 查找 ⇒ **恒 false** ⇒
 * sessionIntegrity 子源自 v0.3 上线起从未真正执行过一次（见 probeZstd 注释）。
 */
function zstdCandidatePaths() {
  const envBin = process.env.ZSTD_BIN;
  const list = process.platform === 'win32'
    ? ['D:/Tools/zstd/zstd.exe', 'C:/Tools/zstd/zstd.exe', 'D:/Tools/zstd/zstd', 'C:/Tools/zstd/zstd']
    : [
        '/usr/bin/zstd',
        '/usr/local/bin/zstd',
        '/bin/zstd',
        join(homedir(), '.local/bin/zstd'),   // 2026-11-01 补：本机实际位置
      ];
  // ZSTD_BIN 排最前：允许覆盖；它可以是绝对路径，也可以是命令名（交给 PATH）
  return envBin ? [envBin, ...list] : list;
}

/** 旧语义保留：只回答「最可能用哪个」，不做可用性判断。 */
function resolveZstdBin() {
  if (process.env.ZSTD_BIN) return process.env.ZSTD_BIN;
  for (const p of zstdCandidatePaths()) {
    try { if (existsSync(p)) return p; } catch { /* ignore */ }
  }
  return 'zstd';
}

/**
 * zstd 可用性探测（2026-11-01 新增）。
 *
 * 为什么不能只用 `existsSync`：
 *   ① 命令名（`zstd`）交给 PATH 解析时，`existsSync('zstd')` 查的是 cwd ⇒ 恒 false；
 *   ② 绝对路径存在 ≠ 可执行（无 x 位 / 架构不符 / 动态库缺失）。
 * 判据只能是「真跑一次 --version 并拿到退出码 0」。
 *
 * 结果缓存到模块级（cron 每周一次，没必要每次都起子进程）。
 * 安装了新的 zstd 后需要重启 dsh 才会重新探测 —— 用 `force` 可强制重探（测试用）。
 *
 * @returns {{ok: boolean, bin: string|null, reason: string|null, tried: Array<{bin:string,ok:boolean,reason:string}>}}
 */
let _zstdProbe = null;
function probeZstd({ force = false } = {}) {
  if (!force && _zstdProbe) return _zstdProbe;

  const tried = [];
  for (const cand of zstdCandidatePaths()) {
    // 绝对路径先看存在性，省一次 spawn；命令名直接交给 PATH
    if (isAbsolute(cand)) {
      let exists = false;
      try { exists = existsSync(cand); } catch { /* ignore */ }
      if (!exists) { tried.push({ bin: cand, ok: false, reason: 'not-found' }); continue; }
    }
    try {
      execFileSync(cand, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: 'ignore' });
      _zstdProbe = { ok: true, bin: cand, reason: null, tried };
      return _zstdProbe;
    } catch (e) {
      tried.push({ bin: cand, ok: false, reason: String(e?.code ?? e?.message ?? 'exec-failed').slice(0, 120) });
    }
  }

  _zstdProbe = {
    ok: false,
    bin: null,
    reason: `zstd 不可执行：试过 ${tried.length} 个候选（${tried.map((t) => t.bin).join(', ')}）`
      + '；设 ZSTD_BIN 指向可执行文件或把 zstd 装到候选路径后重启',
    tried,
  };
  return _zstdProbe;
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
    // 与 detectSessionIntegrity 共用同一份探测结果：不许出现「探测说行、执行却换另一个 bin」
    const probe = probeZstd();
    const bin = probe.ok ? probe.bin : resolveZstdBin();
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
async function detectSessionIntegrity({ ctx = null, onFallback = null, report = null } = {}) {
  // 2026-11-01 修：原来这里是 `if (!existsSync(resolveZstdBin())) return []` ——
  // 命令名交给 existsSync 查的是 cwd，恒 false，整个子源从未执行（静默失明）。
  // 现在必须真探测到可执行，且**跳过要出声**（report 把原因交给 health 面）。
  const probe = probeZstd();
  if (!probe.ok) {
    report?.({ skipped: 'zstd-unavailable', reason: probe.reason, tried: probe.tried });
    return [];
  }
  // 2026-10-19：listRecentSessions 改为异步（要走上游服务探测），调用方必须 await。
  const files = await listRecentSessions(8, { ctx, onFallback });
  if (files.length === 0) {
    report?.({ skipped: 'no-session-files', zstdBin: probe.bin, sessionsRoot: join(dshHome(), 'sessions') });
    return [];
  }

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

  // 正常路径也要留下「真扫了几个会话」的证据 —— 否则「扫了 0 个」和
  // 「扫了 8 个都没问题」在 health 面上长得一样（本项目最坏的一类失败）。
  report?.({ zstdBin: probe.bin, scannedSessions: files.length, flaggedSessions: issues.length });

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
 * 各子源上一次执行的真实结果（2026-11-01 新增）。
 *
 * 为什么要有它：`health()` 原本把 5 个检测器一律写成 `active: true`，
 * 于是「守着恒 0 的指标」和「压根没执行」在面板上长得一样 —— sessionIntegrity
 * 就靠这个假绿藏了整整一个版本（zstd 探测恒 false，从未扫过一次会话）。
 *
 * 记录形状：{ ran, produced, skipped, reason, error, at, ...统计字段 }
 *   ran      true=真执行了；false=被跳过（看 skipped/reason）；null=本 boot 还没跑过
 *   skipped  跳过原因码（zstd-unavailable / compressGuard-unavailable / ...）
 *   produced 该子源本次产出信号条数
 */
const _detectorRuns = Object.create(null);

const DETECTOR_META = {
  toolAnomaly: { schema: 'ok===false', threshold: 'failRate>15% or streak>=3' },
  metricRegression: { schema: 'error-metric snapshot diff', threshold: 'current>prev*1.5 & +5' },
  ruleHotspot: { schema: 'errorKind===denied', threshold: '>=1 in last 200 (baseline=0)' },
  compressLoss: { schema: 'agint.compressGuard.stats()', threshold: 'status in BLOCKED|DEGRADED' },
  sessionIntegrity: { schema: 'sessions/<ws>/<sid>/session.{v4,v3,}.jsonl.zstd', threshold: 'badLines>=5&>5% | seqGaps>=5 | missingContent>=3 | unpaired>20%' },
};

function nowIso() { return new Date().toISOString(); }

/**
 * 跑一个子源并记录它的执行事实。
 * ⛔ 子源抛错一律**原样抛出去**：旧行为是让 fetch 整体失败、由 gateway 记 lastError，
 *    这里若吞掉就把「子源故障」变成静默 —— 那正是本次要修的那类 bug。
 */
async function runDetector(key, fn) {
  const notes = {};
  const report = (n) => { if (n && typeof n === 'object') Object.assign(notes, n); };
  try {
    const out = await fn(report);
    const signals = Array.isArray(out) ? out : [];
    _detectorRuns[key] = {
      ran: notes.skipped ? false : true,
      produced: signals.length,
      skipped: notes.skipped ?? null,
      reason: notes.reason ?? null,
      error: null,
      at: nowIso(),
      ...notes,
    };
    return signals;
  } catch (e) {
    _detectorRuns[key] = {
      ran: true,
      produced: 0,
      skipped: null,
      error: String(e?.message ?? e).slice(0, 200),
      at: nowIso(),
      ...notes,
    };
    throw e;
  }
}

/**
 * C2 Channel 实例。
 */
export const selfObservationChannel = {
  id: CHANNEL_IDS.SELF_OBSERVATION,
  type: CHANNEL_TYPES.SELF_OBSERVATION,
  cron: C2_CRON,

  async fetch(ctx) {
    // 顺序执行（与原实现一致），但每个子源留下「真跑了 / 被跳过 / 出错」的证据
    const signals = [
      ...(await runDetector('toolAnomaly', (r) => detectToolAnomaly(r))),
      ...(await runDetector('metricRegression', (r) => detectMetricRegression(r))),
      ...(await runDetector('ruleHotspot', (r) => detectRuleHotspot(r))),
      ...(await runDetector('compressLoss', (r) => detectCompressLoss(ctx || {}, r))),
      // ctx 透传给会话源：上游 sessionQuery 可用就走它，不可用回落并出声
      ...(await runDetector('sessionIntegrity', (r) => detectSessionIntegrity({ ctx: ctx || null, report: r }))),
    ];
    return signals;
  },

  async health() {
    // 2026-11-01 重写：不再硬编码 active:true —— 每个子源报「上次真跑了没」。
    // status 语义：unknown=本 boot 还没 fetch 过；degraded=有子源被跳过或出错；
    //              ok=5 个子源都真跑过且无跳过。
    const keys = Object.keys(DETECTOR_META);
    const runs = keys.map((k) => _detectorRuns[k] ?? null);
    const ranCount = runs.filter((r) => r && r.ran).length;
    const skippedKeys = keys.filter((k) => _detectorRuns[k] && _detectorRuns[k].ran === false);
    const erroredKeys = keys.filter((k) => _detectorRuns[k] && _detectorRuns[k].error);

    const status = runs.every((r) => r === null)
      ? 'unknown'
      : ((skippedKeys.length || erroredKeys.length) ? 'degraded' : 'ok');

    const detectors = {};
    for (const k of keys) {
      const r = _detectorRuns[k] ?? null;
      detectors[k] = {
        ...DETECTOR_META[k],
        active: r ? r.ran === true : null,   // null = 本 boot 尚未执行（不是"正常"）
        ran: r ? r.ran : null,
        produced: r ? r.produced : null,
        skipped: r?.skipped ?? null,
        reason: r?.reason ?? null,
        error: r?.error ?? null,
        lastRunAt: r?.at ?? null,
        stats: r ? Object.fromEntries(Object.entries(r).filter(
          ([f]) => !['ran', 'produced', 'skipped', 'reason', 'error', 'at'].includes(f),
        )) : null,
      };
    }

    const zstd = probeZstd();
    return {
      channelId: this.id,
      status,
      subSources: 5,
      ranCount,
      skippedDetectors: skippedKeys,
      erroredDetectors: erroredKeys,
      zstd: { ok: zstd.ok, bin: zstd.bin, reason: zstd.reason },
      detectors,
      note: 'v0.4: 执行面自报 —— active=上次是否真执行（null=本 boot 未跑）；被跳过的子源会给出 skipped/reason',
    };
  },
};
