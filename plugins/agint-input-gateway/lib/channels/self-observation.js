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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CHANNEL_IDS, CHANNEL_TYPES, C2_CRON } from '../schema.js';

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

  // b) 单工具连续失败（从后往前找）
  const streak = {};
  let maxStreakTool = null;
  let maxStreakCount = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const r = recent[i];
    if (r.ok === false) {
      streak[r.tool] = (streak[r.tool] || 0) + 1;
      if (streak[r.tool] > maxStreakCount) {
        maxStreakCount = streak[r.tool];
        maxStreakTool = r.tool;
      }
    } else {
      break;
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

/**
 * 子源 5：session 完整性
 * P2 留接口。需 session/event 事件流。
 */
function detectSessionIntegrity() {
  return [];
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
      ...detectSessionIntegrity(),
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
        sessionIntegrity: { active: false, reason: 'P2: needs session/event stream' },
      },
      note: 'v0.2: metricRegression implemented via snapshot diff; only sessionIntegrity remains P2',
    };
  },
};
