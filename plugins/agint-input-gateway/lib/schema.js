/**
 * agint-input-gateway — schema 与常量。
 *
 * ChannelType / SignalType / 默认配额 / topic 前缀 / 配置 schema。
 * 不存 ambient 依赖（process / Buffer / timer）；时间由 ctx 或外部传入。
 */

export const PLUGIN_NAME = 'agint-input-gateway';
export const SERVICE_NAME = 'agint.inputGateway';

/** 五类信息 Channel */
export const CHANNEL_TYPES = Object.freeze({
  HUMAN: 'human',
  SELF_OBSERVATION: 'self-observation',
  EXTERNAL: 'external',
  ADVERSARIAL: 'adversarial',
  CROSS_AGENT: 'cross-agent',
});

/** topic 前缀：input.signal.<channelType>.<signalType> */
export const TOPIC_PREFIX = 'input.signal';

/** 默认日配额（条/日） */
export const DEFAULT_QUOTAS = Object.freeze({
  [CHANNEL_TYPES.SELF_OBSERVATION]: 50,
  [CHANNEL_TYPES.EXTERNAL]: 20,
  [CHANNEL_TYPES.ADVERSARIAL]: 10,
  [CHANNEL_TYPES.CROSS_AGENT]: 15,
});

/** 默认阈值 */
export const DEFAULTS = Object.freeze({
  confidenceThreshold: 0.3,   // 低于此值直接丢弃
  relevanceLowQueue: 0.2,     // 低于此值进低优先队列（dream sweep）
  noiseWindowMs: 60 * 60 * 1000,  // 1h
  noiseMaxPerSource: 5,       // 同 source+signalType 在噪声窗口内最多发布 N 条
  dedupWindowMs: 24 * 60 * 60 * 1000,  // 24h 去重窗口
  fetchTimeoutMs: 30_000,      // 单 Channel fetch 超时
  cronCheckIntervalMs: 60 * 1000,  // 每分钟检查一次是否到 fetch 时间
  payloadMaxBytes: 2048,       // payload ≤2KB
});

/** C2 系统自观测 Channel 的 cron 表达式（每日 02:00） */
export const C2_CRON = '0 2 * * *';

/** 已注册 Channel 的 id 常量 */
export const CHANNEL_IDS = Object.freeze({
  SELF_OBSERVATION: 'self-observation',
});

/** eventBus topic 精确匹配——预定义的 topic 集合（不支持 wildcard） */
export const KNOWN_TOPICS = Object.freeze([
  'input.signal.self-observation.tool-anomaly',
  'input.signal.self-observation.metric-regression',
  'input.signal.self-observation.rule-hotspot',
  'input.signal.self-observation.compress-loss',
  'input.signal.self-observation.session-integrity',
]);
