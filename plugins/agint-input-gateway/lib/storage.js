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

const ConfigSchema = z.object({
  id: z.literal('config'),
  enabled: z.boolean(),
  confidenceThreshold: z.number(),
  relevanceLowQueue: z.number(),
  noiseMaxPerSource: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CountersSchema = z.object({
  channelId: z.string().min(1),
  fetchCount: z.number().int(),
  signalsEmitted: z.number().int(),
  signalsFiltered: z.number().int(),
  signalsDeduplicated: z.number().int(),
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
