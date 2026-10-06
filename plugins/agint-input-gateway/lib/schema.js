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
 * ⚠ 机器级绝对路径不在此硬编码（Phase -1.4）：旧值 `/home/kylin/projects/DSH/DSH-AGINT`
 *   是麒麟机路径，Windows 机每次装会覆盖且本机取不到。此处只声明「仓库槽位」（id + label），
 *   path 一律留空，由消费者 external-git.js 的 resolveGitRepos() 从环境变量注入：
 *     DSH_PROJECT_ROOT         → 填 dsh-agint 槽位（DSH-AGINT checkout 根）
 *     DSH_INPUT_GATEWAY_REPOS  → 追加/覆盖额外仓库，格式 `id=path;path2`（`;` 或 `,` 分隔）
 *   两者优先级与校验见 bin/validate-env-config.mjs。未配置时该列表解析为空，channel 空转
 *   （C3 external-git 当前本就未启用，零运行时影响）。
 */
export const C3_GIT_REPOS = Object.freeze([
  { id: 'dsh-agint', path: '', label: 'DSH-AGINT (self)' },
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
  'input.signal.cross-agent.sync-proposal',
]);
