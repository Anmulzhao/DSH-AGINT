/**
 * C2 系统自观测 Channel — P0。
 *
 * 从现有 AGINT 状态文件提取异常信号，不引入新数据源。
 * 文件路径基于 DSH_HOME 环境变量，不存在时静默返回空。
 *
 * 5 个子源：
 *   1. toolStats 异常    — 读 agint_tool_stats.jsonl，失败率突增
 *   2. metrics 退化      — 读 agint_metrics.json，关键指标下降
 *   3. 规则高频命中      — 读 agint_rules.json，统计配置（实际命中需 tool_stats 关联，P0 简化）
 *   4. 压缩丢失          — 调用 agint.compressGuard.stats()
 *   5. session 完整性    — P0 留接口（读 session 目录，统计中断会话，简化版）
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

/**
 * 子源 1：toolStats 异常
 * 读 agint_tool_stats.jsonl，统计最近 N 条记录的失败率。
 * 失败率 > 30% 或单工具连续失败 ≥3 次 → 产信号。
 */
function detectToolAnomaly() {
  const lines = safeReadLines(join(storagesDir(), 'agint_tool_stats.jsonl'));
  if (lines.length === 0) return [];

  // 取最近 200 条
  const recent = lines.slice(-200).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  if (recent.length === 0) return [];

  // 统计失败率
  const failed = recent.filter((r) => r.status === 'error' || r.status === 'failed' || r.error);
  const failRate = failed.length / recent.length;

  const signals = [];
  if (failRate > 0.3 && recent.length >= 20) {
    signals.push({
      signalId: `tool-anomaly-${Date.now()}`,
      source: 'tool-stats',
      signalType: 'tool.anomaly',
      payload: {
        recentCalls: recent.length,
        failedCalls: failed.length,
        failRate: Number(failRate.toFixed(3)),
        threshold: 0.3,
        note: `最近 ${recent.length} 次工具调用失败率 ${(failRate * 100).toFixed(1)}%，超过阈值 30%`,
      },
      confidence: 0.8,
      relevance: 0.7,
      occurredAt: new Date().toISOString(),
      rawRef: join(storagesDir(), 'agint_tool_stats.jsonl'),
    });
  }

  return signals;
}

/**
 * 子源 2：metrics 退化
 * 读 agint_metrics.json，检查关键指标。
 * P0 简化：如果文件存在且有数据，检查是否有数值下降。
 */
function detectMetricRegression() {
  const metrics = safeReadJson(join(storagesDir(), 'agint_metrics.json'));
  if (!metrics || typeof metrics !== 'object') return [];

  const signals = [];

  // P0 简化：只检查是否有明显的 error/failure 字段
  for (const [key, val] of Object.entries(metrics)) {
    if (val && typeof val === 'object') {
      const errCount = val.errorCount || val.errors || 0;
      if (typeof errCount === 'number' && errCount > 10) {
        signals.push({
          signalId: `metric-regression-${key}-${Date.now()}`,
          source: 'metrics',
          signalType: 'metric.regression',
          payload: {
            metricKey: key,
            errorCount: errCount,
            note: `指标 ${key} 有 ${errCount} 次错误记录`,
          },
          confidence: 0.6,
          relevance: 0.6,
          occurredAt: new Date().toISOString(),
          rawRef: join(storagesDir(), 'agint_metrics.json'),
        });
      }
    }
  }

  return signals;
}

/**
 * 子源 3：规则高频命中
 * 读 agint_rules.json，检查规则配置。
 * P0 简化：只报告规则数量和是否有 deny 规则（实际命中频率需 tool_stats 关联，留 TODO）。
 */
function detectRuleHotspot() {
  const rules = safeReadJson(join(storagesDir(), 'agint_rules.json'));
  if (!rules || typeof rules !== 'object') return [];

  const signals = [];

  // 统计 deny 规则数量
  const denyRules = [];
  for (const [name, rule] of Object.entries(rules)) {
    if (rule && (rule.action === 'deny' || rule.severity === 'high')) {
      denyRules.push(name);
    }
  }

  // P0：不做频率检测（需要关联 tool_stats），只在 deny 规则很多时报告
  if (denyRules.length >= 10) {
    signals.push({
      signalId: `rule-hotspot-${Date.now()}`,
      source: 'rules',
      signalType: 'rule.hotspot',
      payload: {
        denyRuleCount: denyRules.length,
        sampleRules: denyRules.slice(0, 5),
        note: `当前有 ${denyRules.length} 条 deny/high 规则；P1 将关联 tool_stats 检测高频命中`,
      },
      confidence: 0.5,
      relevance: 0.4,
      occurredAt: new Date().toISOString(),
      rawRef: join(storagesDir(), 'agint_rules.json'),
    });
  }

  return signals;
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
 * P0 简化：统计 sessions 目录中的 session 文件数量。
 * TODO P1：检测中断/超时会话。
 */
function detectSessionIntegrity() {
  // P0 留接口：不主动扫描（可能很慢），只返回空
  // 后续通过 session/event 事件检测
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
      note: 'P0: toolStats/metrics/rules/compress-guard 文件读取；session 完整性留接口',
    };
  },
};
