/**
 * C2 系统自观测 Channel — P0.1（2026-09-29 修复 schema 错配）。
 *
 * 从现有 AGINT 状态文件提取异常信号，不引入新数据源。
 * 文件路径基于 DSH_HOME 环境变量，不存在时静默返回空。
 *
 * 5 个子源：
 *   1. toolStats 异常    — ok===false 失败率突增 + 单工具连续失败
 *   2. metrics 退化      — P0 需历史基线，暂留空（P1 实现环比）
 *   3. 规则高频命中      — 从 tool_stats 统计 errorKind==='denied' 频率
 *   4. 压缩丢失          — 调用 agint.compressGuard.stats()
 *   5. session 完整性    — P0 留接口
 */

import { readFileSync, existsSync } from 'node:fs';
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
    // 按 errorKind 分组，提供上下文
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
      // 连续失败被成功调用打断
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

/**
 * 子源 2：metrics 退化
 *
 * 真实 schema：{unit, global, tables: {tableName: {recordId: {id,key,label,value,unit,meta,ts}}}}
 * P0：时间序列数据需要历史基线才能检测"退化"，当前没有环比能力。
 * TODO P1：对比最近两条同 key 记录，value 下降 >20% 时报告。
 */
function detectMetricRegression() {
  // P0 暂留空——没有历史基线就检测"退化"是伪信号
  return [];
}

/**
 * 子源 3：规则高频命中
 *
 * 从 tool_stats 统计 errorKind === 'denied' 的频率。
 * 真实数据：全量 11125 条里 denied=5，最近 200 条里 denied=0。
 * 阈值：最近 200 条里 denied ≥3 次才报告（当前基线 ~0）。
 *
 * 不再扫描 rules.json 的静态配置数量——那是配置状态，不是异常。
 */
function detectRuleHotspot() {
  const recent = readRecentToolStats(200);
  if (recent.length === 0) return [];

  const denied = recent.filter((r) => r.errorKind === 'denied');
  if (denied.length < 3) return [];

  // 看被 denied 的是什么工具
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
      note: `最近 ${recent.length} 次工具调用中 ${denied.length} 次被规则拒绝（阈值 3）`,
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
 * 如果 service 不可用，返回空。
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
 * P0 留接口。TODO P1：通过 session/event 事件检测中断/超时会话。
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

  /**
   * @param {object} ctx
   * @param {object} [ctx.services] — 可选的 host services（compressGuard 等）
   */
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
        metricRegression: { active: false, reason: 'P1: needs historical baseline' },
        ruleHotspot: { active: true, schema: 'errorKind===denied', threshold: '>=3 in last 200' },
        compressLoss: { active: true, depends: 'agint.compressGuard' },
        sessionIntegrity: { active: false, reason: 'P1: needs session/event' },
      },
      note: 'v0.1.1: fixed schema mismatch (ok field not status/error; denied from tool_stats not rules.json)',
    };
  },
};
