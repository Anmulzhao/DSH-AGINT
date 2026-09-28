/**
 * agint-input-gateway — 存储域定义。
 *
 * 4 表：
 *   config       — 全局配置（enabled / 阈值覆盖 / channel 开关）
 *   counters     — 每 Channel 计数器（fetch_count / signals_emitted / signals_filtered / error_count）
 *   dedup        — 去重窗口（channelId:signalId → ISO 时间），24h 滚动
 *   channel_state — 每 Channel 运行时状态（lastFetchAt / enabled / quotaOverride）
 */

import { CHANNEL_IDS, DEFAULT_QUOTAS, DEFAULTS } from './schema.js';

export const spec = {
  name: 'agint_input_gateway',
  version: 1,
  tables: {
    config: {
      primaryKey: 'id',
      indexes: [],
    },
    counters: {
      primaryKey: 'channelId',
      indexes: [],
    },
    dedup: {
      primaryKey: 'dedupKey',
      indexes: [],
    },
    channel_state: {
      primaryKey: 'channelId',
      indexes: [],
    },
  },
};

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
    quotaOverride: null,  // null = 用 DEFAULT_QUOTAS
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
