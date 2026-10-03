/**
 * agint-input-gateway — 存储域定义。
 *
 * 4 表：
 *   config       — 全局配置（enabled / 阈值覆盖）
 *   counters     — 每 Channel 计数器（primaryKey: channelId）
 *   dedup        — 去重窗口（primaryKey: dedupKey）
 *   channel_state — 每 Channel 运行时状态（primaryKey: channelId）
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { DEFAULTS } from './schema.js';

// ── Zod valueSchema ────────────────────────────────────────────────────────

export const ConfigSchema = z.object({
  id: z.literal('config'),
  enabled: z.boolean(),
  confidenceThreshold: z.number(),
  relevanceLowQueue: z.number(),
  noiseMaxPerSource: z.number(),
  // v0.1.1：新增配置键 optional —— 生产 config 可能为空或旧格式，向后兼容。
  securityAction: z.enum(['flag', 'drop', 'off']).optional(),
  forwardEmptyDiagnosis: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CountersSchema = z.object({
  channelId: z.string().min(1),
  fetchCount: z.number().int(),
  signalsEmitted: z.number().int(),
  signalsFiltered: z.number().int(),
  signalsDeduplicated: z.number().int(),
  // v0.1.1：新增计数键 optional —— 生产 counters 旧记录不含 security* 字段，
  // 必填会令 dsh-storage-domain open 校验失败（domain 整体拒绝，gateway 初始化中断）。
  // v0.3.1：改 nullish —— 生产 adversarial 记录曾把 security* 三字段写成 null（非缺失），
  // .optional() 只认 undefined 不认 null，仍致整域 open 失败（2026-10-03 现场取证）。
  securityScanned: z.number().int().nullish(),
  securityFlagged: z.number().int().nullish(),
  securityDropped: z.number().int().nullish(),
  errorCount: z.number().int(),
  lastFetchAt: z.string().nullable(),
  createdAt: z.string(),
});

const DedupSchema = z.object({
  dedupKey: z.string().min(1),
  channelId: z.string().min(1),
  signalId: z.string().min(1),
  firstSeenAt: z.string(),
});

const ChannelStateSchema = z.object({
  channelId: z.string().min(1),
  channelType: z.string(),
  enabled: z.boolean(),
  quotaOverride: z.number().int().nullable(),
  lastFetchAt: z.string().nullable(),
  lastFetchDurationMs: z.number().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});

// ── defineDomain ──────────────────────────────────────────────────────────

export const spec = defineDomain({
  name: 'agint_input_gateway',
  version: 1,
  tables: {
    config: { valueSchema: ConfigSchema },
    counters: { valueSchema: CountersSchema },
    dedup: { valueSchema: DedupSchema },
    channel_state: { valueSchema: ChannelStateSchema },
  },
});

// ── pack / empty helpers ──────────────────────────────────────────────────

export function emptyConfig() {
  return {
    id: 'config',
    enabled: true,
    confidenceThreshold: DEFAULTS.confidenceThreshold,
    relevanceLowQueue: DEFAULTS.relevanceLowQueue,
    noiseMaxPerSource: DEFAULTS.noiseMaxPerSource,
    securityAction: DEFAULTS.securityAction,
    forwardEmptyDiagnosis: DEFAULTS.forwardEmptyDiagnosis,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function packConfig(patch) {
  return { ...emptyConfig(), ...patch, id: 'config', updatedAt: new Date().toISOString() };
}

export function emptyCounters(channelId) {
  return {
    channelId,
    fetchCount: 0,
    signalsEmitted: 0,
    signalsFiltered: 0,
    signalsDeduplicated: 0,
    securityScanned: 0,
    securityFlagged: 0,
    securityDropped: 0,
    errorCount: 0,
    lastFetchAt: null,
    createdAt: new Date().toISOString(),
  };
}

export function packCounters(channelId, patch = {}) {
  return { ...emptyCounters(channelId), ...patch };
}

export function emptyChannelState(channelId, channelType) {
  return {
    channelId,
    channelType,
    enabled: true,
    quotaOverride: null,
    lastFetchAt: null,
    lastFetchDurationMs: null,
    lastError: null,
    createdAt: new Date().toISOString(),
  };
}

export function packDedup(channelId, signalId) {
  return {
    dedupKey: `${channelId}:${signalId}`,
    channelId,
    signalId,
    firstSeenAt: new Date().toISOString(),
  };
}
