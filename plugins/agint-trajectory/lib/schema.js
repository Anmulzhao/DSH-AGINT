/**
 * agint-trajectory: FROZEN schema + 治理参数 + 配置（P2-1 §3.2 / §7.2 / §7.4）。
 *
 * 上游设计：`设计-P2-1-进化轨迹记录.md` v0.3。
 *
 * 红线与取舍（与 §3.2 / §8bis 一一对应）：
 *   1. 独立域 `agint_trajectory`，schemaVersion 1 —— dsh-storage-json 版本
 *      不匹配会拒绝打开且无自动迁移（curator v0.2.0 教训），首版一次定够。
 *   2. `payload.steps[].content` 的 observation 轮**只存结果摘要**，
 *      不复存工具参数正文（权威源在 agint_tool_stats.jsonl 的 args）。
 *   3. `usage.toolStats` / `usage.errorKinds`（v0.3 新增，对齐 Hermes
 *      batch_runner.py:344-360）是**聚合标量**，不是原始记录副本。
 *   4. counters 只记「异常丢弃」，采样未命中属预期行为，不计入丢弃（§7.3）。
 */

import { z } from 'zod';

// ── 域与版本 ──────────────────────────────────────────────────────────────

export const DOMAIN_NAME = 'agint_trajectory';
export const SCHEMA_VERSION = 1;

// ── 枚举（§3.2）──────────────────────────────────────────────────────────

/** 五类轨迹源（§2.1 R1） */
export const SOURCES = Object.freeze(['task', 'dream', 'eval', 'evolution', 'subagent']);

/** 结局三态 */
export const KINDS = Object.freeze(['success', 'failure', 'aborted']);

/** 复用 diagnosis 六类 + 兜底，不新造枚举（§3.2） */
export const ERROR_CLASSES = Object.freeze([
  'PROMPT_DEFICIENCY', 'TOOL_GAP', 'KNOWLEDGE_GAP',
  'REASONING_ERROR', 'PLANNING_FAILURE', 'ENVIRONMENT_SHIFT', 'UNCERTAIN',
]);

/** ShareGPT 角色（§6.1 映射源头） */
export const ROLES = Object.freeze(['system', 'human', 'gpt', 'observation']);

/** 落盘档位（§7.1 三态之一） */
export const RECORD_MODES = Object.freeze(['count-only', 'live']);

/** 轨迹进入记录器的通道（§5.1 v0.3 降级路径：event-bus 不可用时退回 explicit） */
export const VIAS = Object.freeze(['explicit', 'event']);

// ── 治理参数默认值（§7.2 / §7.4）──────────────────────────────────────────

export const DEFAULTS = Object.freeze({
  /** 单条 payload 内联上限，超限截断并置 truncated=true */
  MAX_PAYLOAD_BYTES: 256 * 1024,
  /** 整条拒记阈值（异常兜底；实测轨迹 MAX 439KB < 1MB，预期恒 0） */
  REJECT_BYTES: 1024 * 1024,
  /** 日配额 = 防异常洪峰的护栏，不参与容量规划 */
  MAX_PER_DAY: 200,
  /** 保留期（天） */
  RETENTION_DAYS: 90,
  /**
   * 条数/字节容量初值。⚠️ 这是**带标注的初值**：§7.4 要求由标定期报告按
   * 方程推导（maxCount = 保留期 × 日均 × 安全系数；maxBytes = maxCount × P95）。
   * 实测推算 maxBytes 约 117MB 对 dsh-storage-json（全量读入内存）偏大，
   * 首版取 64MB 护栏；标定期报告产出后按 `computeBudget()` 重拍。
   */
  MAX_COUNT: 1800,
  MAX_BYTES: 64 * 1024 * 1024,
  /** 连续写失败达此数 → 自动熔断 setEnabled(false) */
  FAIL_STREAK_LIMIT: 5,
  /** observation 轮 content 摘要上限（§3.2「不复存参数正文」） */
  OBSERVATION_SUMMARY_CHARS: 200,
  /** outcome.errorMsg 截断长度 */
  ERROR_MSG_CHARS: 500,
  /** 采样率：failure/evolution/dream 全记；task 待标定，初值 10%（§7.1） */
  SAMPLE_RATES: Object.freeze({
    task: 0.1, dream: 1, eval: 1, evolution: 1, subagent: 1,
  }),
  /** 标定样本滚动窗口（P50/P95 的样本池） */
  CALIBRATION_SAMPLES: 500,
  /** prune cron（周日 06:00，T10；本版只暴露 prune()，调度由外部 cron 接） */
  PRUNE_CRON: '0 6 * * 0',
  /** 容量规划安全系数（§7.4） */
  SAFETY_FACTOR: 2,
});

// ── 脱敏规则（§7.2 / §7.3，规则不追求穷举，诚实标注边界）─────────────────

export const DEFAULT_REDACT_RULES = Object.freeze([
  { name: 'openai-key', pattern: 'sk-[A-Za-z0-9_-]{16,}' },
  { name: 'bearer', pattern: 'Bearer\\s+[A-Za-z0-9._~+/=-]{8,}' },
  { name: 'aws-akid', pattern: 'AKIA[0-9A-Z]{12,}' },
  { name: 'generic-token', pattern: '(?:api[_-]?key|access[_-]?token|secret|password)\\s*[:=]\\s*["\\\']?[A-Za-z0-9._~+/=-]{6,}' },
  { name: 'email', pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}' },
  { name: 'private-key-block', pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----' },
]);

export const REDACTED = '[REDACTED]';

// ── 记录 schema ──────────────────────────────────────────────────────────

export const StepSchema = z.object({
  seq: z.number().int().nonnegative(),
  role: z.enum(ROLES),
  content: z.string(),
  tool: z.string().optional().nullable(),
  toolCallId: z.string().optional().nullable(),
  toolOk: z.boolean().optional().nullable(),
  toolLatencyMs: z.number().int().nonnegative().optional().nullable(),
}).passthrough();

export const UsageSchema = z.object({
  tokensIn: z.number().int().nonnegative().default(0),
  tokensOut: z.number().int().nonnegative().default(0),
  toolCalls: z.number().int().nonnegative().default(0),
  /** 工具级成败聚合 { [tool]: { count, ok, fail } }（v0.3 / Hermes 对齐） */
  toolStats: z.record(z.object({
    count: z.number().int().nonnegative(),
    ok: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
  })).optional().nullable(),
  /** 工具级错误分类计数 { [errorKind]: n } */
  errorKinds: z.record(z.number().int().nonnegative()).optional().nullable(),
}).passthrough();

export const TaskRefSchema = z.object({
  sessionId: z.string().optional().nullable(),
  cronJob: z.string().optional().nullable(),
  candidateId: z.string().optional().nullable(),
  variantId: z.string().optional().nullable(),
  round: z.number().int().nonnegative().optional().nullable(),
  subagentTaskId: z.string().optional().nullable(),
  batchId: z.string().optional().nullable(),
}).passthrough();

export const OutcomeSchema = z.object({
  errorClass: z.enum(ERROR_CLASSES).optional().nullable(),
  errorMsg: z.string().optional().nullable(),
  attributionId: z.string().optional().nullable(),
}).passthrough();

export const PayloadSchema = z.object({
  steps: z.array(StepSchema).default([]),
  final: z.record(z.unknown()).optional().nullable(),
  /** 中段丢弃的步数（截断实现保头 + 保尾，见 lib/payload.js） */
  droppedSteps: z.number().int().nonnegative().optional().nullable(),
}).passthrough();

export const TrajectorySchema = z.object({
  id: z.string().min(1),
  source: z.enum(SOURCES),
  kind: z.enum(KINDS),
  title: z.string().default(''),
  taskRef: TaskRefSchema.default({}),
  startedAt: z.string(),
  endedAt: z.string(),
  durationMs: z.number().int().nonnegative().default(0),
  usage: UsageSchema.default({ tokensIn: 0, tokensOut: 0, toolCalls: 0 }),
  outcome: OutcomeSchema.default({}),
  payload: PayloadSchema.default({ steps: [] }),
  truncated: z.boolean().default(false),
  redacted: z.boolean().default(false),
  pinned: z.boolean().default(false),
  feedback: z.record(z.unknown()).optional().nullable(),
  via: z.enum(VIAS).default('explicit'),
  /** 落盘字节数（stats/预算用） */
  bytes: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
});

/**
 * 域内记录 schema。本域三张表各存一种类型（trajectories / counters /
 * calibration），因此**不需要 curator 那种 `kind` 判别字段**——若加 `kind`
 * 会与 Trajectory.kind（success|failure|aborted，业务语义）撞名。
 */
export const TrajectoryEntrySchema = TrajectorySchema;

export const CountersSchema = z.object({
  day: z.string().default(''),
  /** 当日进入记录器的次数（含 count-only，供标定期算日均） */
  dayCount: z.number().int().nonnegative().default(0),
  /** 当日**实际落盘**条数 —— 日配额只认它（count-only 不占配额） */
  dayPersisted: z.number().int().nonnegative().default(0),
  droppedFull: z.number().int().nonnegative().default(0),
  droppedDisabled: z.number().int().nonnegative().default(0),
  droppedPayload: z.number().int().nonnegative().default(0),
  truncatedCount: z.number().int().nonnegative().default(0),
  writeFailures: z.number().int().nonnegative().default(0),
  /** 记录总数（截断率/丢弃率的分母） */
  total: z.number().int().nonnegative().default(0),
  /** 采样未命中（不计入丢弃，仅观测；§7.3 注释 4） */
  sampledOut: z.number().int().nonnegative().default(0),
  updatedAt: z.string().default(''),
});

export const CalibrationReportSchema = z.object({
  generatedAt: z.string(),
  /** 标定起止（自然日） */
  fromDay: z.string().default(''),
  toDay: z.string().default(''),
  days: z.number().int().nonnegative().default(0),
  samples: z.number().int().nonnegative().default(0),
  /** 日均落盘条数（估算，count-only 期也统计） */
  perDay: z.number().nonnegative().default(0),
  p50Bytes: z.number().int().nonnegative().default(0),
  p95Bytes: z.number().int().nonnegative().default(0),
  maxBytes: z.number().int().nonnegative().default(0),
  /** 截断率 = truncatedCount / total */
  truncateRate: z.number().nonnegative().default(0),
  /** 按 §7.4 方程外推的 90 天域体积 */
  estimatedRetentionBytes: z.number().int().nonnegative().default(0),
  /** 不变量 #5 切档凭证：四项齐备才允许 live */
  ready: z.boolean().default(false),
  missing: z.array(z.string()).default([]),
  /** 按方程推导出的建议容量（切档后回填到 config 用） */
  suggested: z.object({
    maxCount: z.number().int().nonnegative().default(0),
    maxBytes: z.number().int().nonnegative().default(0),
  }).default({ maxCount: 0, maxBytes: 0 }),
});

export const CalibrationStateSchema = z.object({
  startedDay: z.string().default(''),
  /** 每日条数（count-only 期也累加，用于算日均） */
  byDay: z.record(z.number().int().nonnegative()).default({}),
  /** 最近 N 条估算字节样本（滚动窗口） */
  sampleBytes: z.array(z.number().int().nonnegative()).default([]),
  /**
   * 估算样本中被截断的条数。
   * 为什么单独记：count-only 期没有真实落盘记录，`counters.truncatedCount`
   * 恒为 0——若用它算截断率，不变量 #5 的切档门禁永远无法满足（死锁）。
   * 标定期的截断率用**估算样本**算，语义上就是「预测截断率」。
   */
  truncatedSamples: z.number().int().nonnegative().default(0),
  lastReport: CalibrationReportSchema.optional().nullable(),
});

// ── 配置（cordis patch config）───────────────────────────────────────────

const dshHome = () => process.env.DSH_HOME || `${process.env.HOME ?? ''}/.dsh`;

export const ConfigSchema = z.object({
  /** 导出目录（runtime，gitignored；禁止写死盘符/斜杠） */
  exportDir: z.string().default(() => `${dshHome()}/trajectories/export`),
  /** tool-stats JSONL 路径（离线聚合 toolStats/errorKinds 用，不存在则降级） */
  toolStatsPath: z.string().default(() => `${dshHome()}/storages/agint_tool_stats.jsonl`),
  recordMode: z.enum(RECORD_MODES).default('count-only'),
  enabled: z.boolean().default(true),
  maxPayloadBytes: z.number().int().positive().default(DEFAULTS.MAX_PAYLOAD_BYTES),
  rejectBytes: z.number().int().positive().default(DEFAULTS.REJECT_BYTES),
  maxPerDay: z.number().int().positive().default(DEFAULTS.MAX_PER_DAY),
  retentionDays: z.number().int().positive().default(DEFAULTS.RETENTION_DAYS),
  maxCount: z.number().int().positive().default(DEFAULTS.MAX_COUNT),
  maxBytes: z.number().int().positive().default(DEFAULTS.MAX_BYTES),
  failStreakLimit: z.number().int().positive().default(DEFAULTS.FAIL_STREAK_LIMIT),
  observationSummaryChars: z.number().int().positive().default(DEFAULTS.OBSERVATION_SUMMARY_CHARS),
  sampleRates: z.record(z.number().min(0).max(1)).default(() => ({ ...DEFAULTS.SAMPLE_RATES })),
  /** 事件订阅总开关（§5.1 v0.3 降级路径：关掉后只接受显式 record()） */
  enableEventSubscribe: z.boolean().default(true),
  /** 附加脱敏规则（正则字符串，追加在默认规则之后） */
  extraRedactRules: z.array(z.object({
    name: z.string().default('custom'),
    pattern: z.string(),
    flags: z.string().default('g'),
  })).default([]),
  /** 默认规则开关（关闭后仅用 extraRedactRules） */
  useDefaultRedactRules: z.boolean().default(true),
  /** 导出时是否把 observation 折叠进 human（§6.1 Q4） */
  foldObservation: z.boolean().default(false),
  pruneCron: z.string().default(DEFAULTS.PRUNE_CRON),
  safetyFactor: z.number().positive().default(DEFAULTS.SAFETY_FACTOR),
}).passthrough();

// ── 预算方程（§7.4）──────────────────────────────────────────────────────

/**
 * 由标定期报告推导容量参数。三者职责分离：
 *   MAX_PER_DAY = 护栏（防单日洪峰，不参与容量规划）
 *   maxCount    = 保留期 × 日均 × 安全系数
 *   maxBytes    = maxCount × 单条 P95（用 P95 不用均值，防长尾撑爆域）
 *
 * @param {{perDay:number,p95Bytes:number}} report
 * @param {{retentionDays?:number,safetyFactor?:number}} opts
 */
export function computeBudget(report, opts = {}) {
  const retentionDays = opts.retentionDays ?? DEFAULTS.RETENTION_DAYS;
  const safetyFactor = opts.safetyFactor ?? DEFAULTS.SAFETY_FACTOR;
  const perDay = Math.max(0, Number(report?.perDay) || 0);
  const p95 = Math.max(0, Number(report?.p95Bytes) || 0);
  const maxCount = Math.ceil(retentionDays * perDay * safetyFactor);
  return { maxCount, maxBytes: maxCount * p95 };
}

/** 轨迹 id：traj_<YYYYMMDD>_<8位hash> */
export function makeTrajectoryId(date = new Date(), seed = '') {
  const day = date.toISOString().slice(0, 10).replace(/-/g, '');
  const src = `${seed}${date.toISOString()}${Math.random().toString(36).slice(2)}`;
  let h = 0;
  for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) >>> 0;
  return `traj_${day}_${h.toString(16).padStart(8, '0').slice(0, 8)}`;
}

/** 自然日标签 YYYY-MM-DD（日配额 / 标定按天分桶） */
export function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function clampText(text, max) {
  if (typeof text !== 'string') return '';
  return text.length <= max ? text : text.slice(0, max);
}
