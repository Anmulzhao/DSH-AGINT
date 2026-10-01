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
  // security 门禁（v0.3.0）：外部信号 prompt injection 检测
  //   action=flag（默认，命中标记放行）| drop（命中丢弃）| off（不检测）
  securityAction: 'flag',
  // C4 对抗 Channel（v0.3.0）：diagnosis.completed 空壳事件（clusterCount=0）
  // 是否也转发——让"诊断链空转"对下游可见，而不是静默过滤
  forwardEmptyDiagnosis: true,
});

/** C2 系统自观测 Channel 的 cron（每周日 02:00，在 dream 03:00 之前） */
export const C2_CRON = '0 2 * * 0';

/** C3 外部世界 Channel 的 cron（每周日 04:00，错峰） */
export const C3_CRON = '0 4 * * 0';

/** C5 跨 Agent Channel 的 cron（每周日 05:00，错峰；C3 04:00 之后 1h） */
export const C5_CRON = '0 5 * * 0';

/** C4 对抗挑战 Channel 的 cron（每天 03:30，dream 03:00 之后半小时，事件最多压 24h） */
export const C4_CRON = '30 3 * * *';

/**
 * C3 git 仓库列表（本地快照路径，不做网络 fetch）
 *
 * 2026-10-01 本机收敛：原为 4 条硬编码 Windows 路径 D:/DSH/project源码/{dsh,openclaw,Hermes,DSH-AGINT}。
 * 本机实测后只保留 DSH-AGINT —— 判据是「能 rev-parse 且至少 1 个 commit」：
 *   - DSH-AGINT  → /home/kylin/projects/DSH/DSH-AGINT（423 commits，origin Anmulzhao/DSH-AGINT）✅
 *   - dsh        → 本机无本地仓库，仅 npm 全局安装 @deepseek-ai/dsh            ❌
 *   - openclaw   → ~/.openclaw/workspace 是 0-commit / 无 origin 的空壳，getHead 取不到 ❌
 *   - Hermes     → 本机不存在                                                  ❌
 * 保留 3 条无效路径只会让 getHead 静默失败，故删除。
 * 附带：C3 external-git channel 目前未启用（channel_state 仅 adversarial），本改动当前零运行时影响。
 */
export const C3_GIT_REPOS = Object.freeze([
  { id: 'dsh-agint', path: '/home/kylin/projects/DSH/DSH-AGINT', label: 'DSH-AGINT (self)' },
]);

/** 已注册 Channel 的 id 常量 */
export const CHANNEL_IDS = Object.freeze({
  SELF_OBSERVATION: 'self-observation',
  EXTERNAL: 'external-git',
  ADVERSARIAL: 'adversarial',
  CROSS_AGENT: 'cross-agent',
});

/** eventBus topic 精确匹配——预定义的 topic 集合（不支持 wildcard） */
export const KNOWN_TOPICS = Object.freeze([
  'input.signal.self-observation.tool-anomaly',
  'input.signal.self-observation.metric-regression',
  'input.signal.self-observation.rule-hotspot',
  'input.signal.self-observation.compress-loss',
  'input.signal.self-observation.session-integrity',
  'input.signal.external.repo-diff',
  'input.signal.adversarial.counterfactual-result',
  'input.signal.adversarial.curriculum-result',
  'input.signal.adversarial.boundary-divergence',
  'input.signal.cross-agent.diff',
  'input.signal.cross-agent.pattern',
]);
