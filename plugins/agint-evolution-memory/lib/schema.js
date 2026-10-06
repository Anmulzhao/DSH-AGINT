/**
 * agint-evolution-memory: schema definitions for the three entry kinds.
 *
 * 三类 entry 共享三个字段（让 decay.js 能统一处理）：
 *   - id       唯一 id（hex hash 或 UUID）
 *   - level    L1/L2/L3/L4（衰减等级）
 *   - confidence 0..1（被命中频率的对等分数）
 *
 * 加上各自专属字段。所有 entry 都有 lastRecall / updatedAt / createdAt
 * 字段，供 recencyIso() 计算。
 */

import { z } from 'zod';

// ── 通用 entry 字段 ───────────────────────────────────────────────────────

const baseFields = {
  id: z.string().min(1),
  level: z.enum(['L1', 'L2', 'L3', 'L4']).default('L1'),
  confidence: z.number().min(0).max(1).default(0.5),
  lastRecall: z.string().default(() => new Date().toISOString()),
  recalls: z.number().int().min(0).default(0),
  evidence: z.string().default(''),
  resolved: z.boolean().default(false),
  replacedBy: z.string().nullable().default(null),
  createdAt: z.string().default(() => new Date().toISOString()),
  updatedAt: z.string().default(() => new Date().toISOString()),
};

// ── Evolution log entry（Phase 4 完成后追加） ──────────────────────────────

/**
 * evolution-log entry: 一次 D-QAF Phase 4 决策的完整记录。
 * 设计：每次 evaluateAll + decide + generate 走完时调用 logPhase4() 写入一行。
 */
export const evolutionLogEntrySchema = z.object({
  ...baseFields,
  kind: z.literal('evolution-log'),
  ts: z.string().default(() => new Date().toISOString()),
  targetId: z.string().min(1),
  // 2026-09-27：+oracle-daily/weekly/monthly/alert 四个静态档——美的神谕层
  // （agint-aesthetic-oracle）白名单写表 §9.1 的审计条目。保持**封闭枚举**
  // （不放开任意字符串）：shadow-ingest 回归测试静态扫描锁死 z.enum 形态，
  // 且封闭枚举本身就是"防任意写入"的守门。唯一性由 targetId 承担
  // （如 oracle-daily-2026-09-27）；activity 排除按 startsWith('oracle') 前缀匹配。
  targetKind: z.enum(['plugin', 'skill', 'preset', 'composite', 'oracle-daily', 'oracle-weekly', 'oracle-monthly', 'oracle-alert']),
  decision: z.enum(['AUTO_DEPLOY', 'PENDING_REVIEW', 'REJECT', 'ABSTAIN']),
  scores: z.record(z.string(), z.number()).default({}),
  // 触发决策的具体 findings（指向 EvalResult.findings 的子集）
  findings: z.array(z.object({
    ruleId: z.string(),
    severity: z.enum(['low', 'medium', 'high']),
    detail: z.string().optional(),
  })).default([]),
  tags: z.array(z.string()).default([]),
});

// ── Failure pattern entry（REJECT 决策自动 / 周复盘手工归纳） ────────────

/**
 * failure-pattern entry: 一个"出过错的进化模式"。
 * examples:
 *   - pattern: "打破 L0-frozen 字段" → severity: high
 *   - pattern: "未通过 Phase 1 静态检查" → severity: medium
 * 自动写入触发器：每次 REJECT 决策由 agint-quality-policy 调 addFailure
 * （Sprint 3 接入）；周复盘时 evolve 归纳。
 */

// ── addFailure 值域单一真源（方案 B，2026-10-06 立项）──────────────────────
//
// category 值域 = self-model 能力画像域词表 + mutator 硬编码过滤面
// （agint-mutator/lib/index.js:1062 只认 correctness/integration）+ curriculum
// 模板域对齐对象。扩枚举牵动三处下游 ⇒ 不扩，改在 addFailure 入口收口。
// bin/check-addfailure-callers.mjs 以本表为判据扫全仓调用点。

export const FAILURE_CATEGORIES = Object.freeze(['security', 'correctness', 'integration', 'perf', 'other']);
export const FAILURE_SEVERITIES = Object.freeze(['low', 'medium', 'high']);

/** 已知越界值 → 语义归属映射（立项档 §4 方案 B，逐条经老板认可） */
export const FAILURE_CATEGORY_MAP = Object.freeze({
  mount: 'integration',        // 挂载后插件未生效 = 集成故障
  population: 'integration',   // 种群生命周期异常 = 集成
  'self-model': 'correctness', // 校准失准 = 预测与事实不符
  prompt: 'other',             // prompt 静态检查违规，无既有语义类
  governance: 'other',         // 部署预算等治理约束
  harmony: 'other',            // 假和谐检出
});

/** severity 越界值映射（mount/health-probe 历史上写 'critical'） */
export const FAILURE_SEVERITY_MAP = Object.freeze({ critical: 'high' });

export const failurePatternSchema = z.object({
  ...baseFields,
  kind: z.literal('failure-pattern'),
  pattern: z.string().min(1),       // 模式描述（短句）
  category: z.enum(FAILURE_CATEGORIES).default('other'),
  severity: z.enum(FAILURE_SEVERITIES).default('medium'),
  // v0.6.14：归一化留痕（越界原值）。optional ⇒ 旧记录照读（CountersSchema 事故教训）。
  coercedFrom: z.string().optional(),
  occurrences: z.number().int().min(1).default(1),  // 累计出现次数
  // 自动去重：同 pattern 第二次 add 时 occurrences++ 而非新建条目
});

// ── Success template entry（周复盘蒸馏） ──────────────────────────────────

/**
 * success-template entry: 一个"被反复验证有效的进化策略"。
 * examples:
 *   - template: "先写 eval 场景再写 plugin" → confidence: 0.9
 *   - template: "agint-rules 先 deny 再逐步放" → confidence: 0.8
 * 写入触发器：周复盘时由 evolve 蒸馏；不会自动生成。
 */
export const successTemplateSchema = z.object({
  ...baseFields,
  kind: z.literal('success-template'),
  template: z.string().min(1),      // 模板描述（短句）
  // 蒸馏时的样本量（多少次 Phase 4 AUTO_DEPLOY 验证此模板有效）
  sampleSize: z.number().int().min(1).default(1),
  // 适用场景（plugin / skill / preset / 通用）
  appliesTo: z.array(z.string()).default([]),
});

// ── Contract 预测锁（Phase 1 交付物 1 §2.4.2）──────────────────────────

/**
 * contract_locks 表 entry：在 mutation 执行**之前**锁定的预测摘要。
 *
 * ## 这张表是整条证据链的信任根
 *
 * Phase 0 的 Contract 允许 `hypothesis.predictedDelta = null` +
 * `predictedDeltaNote: "NOT_PREDICTED"`。若预测可以事后补写，
 * 「预测 vs 实际」的配对数据就全是自我吹嘘 —— 看到结果再补一个
 * 「我早就预测会涨 4%」，校准分能刷到 0.96，而系统其实什么都没预测到。
 *
 * 所以锁定必须**先于**执行：driver 在构造 mutation 之前算出
 * `hypothesisLock = sha256(canonical({hypothesis, contractId, createdAt}))`
 * 写进本表并发布 `evolution.contract.locked` 事件（不可撤回）。
 * 归档时重算比对，不一致 ⇒ CONTRACT_TAMPERED，该 Contract 不计入任何统计。
 *
 * ## 为什么字段这么少
 *
 * 只存「锁」与「何时锁的」，**不存 hypothesis 全文**（全文在 Contract 里）。
 * 理由：本表要能被独立校验，若把 hypothesis 也存一份，就出现两个真相源，
 * 攻击者改 Contract 而不改本表时二者会「互相印证」—— 反而削弱了校验能力。
 *
 * ⚠️ schema 保持封闭（不放开任意字段）：`lockAlgorithm` 是 enum，
 * 防「换算法绕过校验」—— 存一个 `algorithm: "md5"` 的锁来躲开 sha256 复核。
 */
export const contractLockEntrySchema = z.object({
  // 锁摘要本体：`sha256:<64 hex>`（computeHypothesisLock 产出）
  hypothesisLock: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  // 锁定算法标识。封闭 enum：换算法等于绕过校验，故不接受任意字符串。
  lockAlgorithm: z.literal('sha256'),
  // Contract ID（同时是主键，显式保留一份便于人工排查与交叉对账）
  contractId: z.string().min(1),
  // 锁定时刻（ISO）。由调用方从 Contract 读取后传入 —— 纯函数不取时钟。
  lockedAt: z.string().min(1),
  // 预测来源标注（KNOWLEDGE_BASE / ANALOGY / DEFAULT_RULE）。
  // 留档意义：报告要能区分「知识库先验」与「规则缺省」，
  // 不允许把 Level 1 的缺省猜测当作系统预测能力宣传（设计 §2.4.1）。
  // ⚠️ `.nullable().default(null)` 而非只用 `.nullable()`：后者在**字段缺失**时
  //    仍会校验失败（zod 的 nullable 只放宽值，不给缺省）。实际踩到过 ——
  //    第一次写完 schema 直接 parse 一个不带该字段的对象，抛 invalid_value。
  //    缺省必须是「字段可以整个不写」。
  predictionSource: z.enum(['KNOWLEDGE_BASE', 'ANALOGY', 'DEFAULT_RULE']).nullable().default(null),
  // 锁事件的 id（evolution.contract.locked），供交叉查事件总线。
  // 可空：总线不可用时锁定仍要能落表（观测失败不阻断主流程）。
  lockEventId: z.string().nullable().default(null),
});

// ── Evolution Ledger 条目（Phase 1 交付物 3 §4.3）──────────────────────

/**
 * evolution_ledger 表 entry：进化历史的**链式**索引（一条 = 一个 Contract）。
 *
 * ## 这张表证明的是「序列与顺序」
 *
 * 同域已有的 hash 各管一件事（设计 §4.2.2）：`contract_locks.hypothesisLock`
 * 证明预测先于执行、Contract 的 `audit.contractHash` 证明单份内容完整，
 * 而本表的 `entryHash` / `batchRoot` / `merkleRoot` 证明**ledger 序列完整且
 * 顺序未变**。三者正交，缺任一层都留一个洞（只锁内容 ⇒ 可整链重写；
 * 只锁序列 ⇒ 可无痕补写单份 Contract）。
 *
 * ## 为什么条目里只有摘要和引用，不存 Contract 全文
 *
 * 继承本文件 `contractLockEntrySchema` 的纪律：存一份全文就出现两个真相源，
 * 改 Contract 而不改本表时二者会「互相印证」，反而削弱校验能力。
 *
 * ## ⛔ 分隔线以下的字段不参与 entryHash
 *
 * `anchorStatus` / `anchorSeq` / `integrity` / `reconstructed` /
 * `evidenceCompleteness` 是**条目追加之后才成立的事实**（v1.2 勘误 #8）。
 * §4.4.2 步骤 6 锚定成功后要回写 `anchorStatus` —— 若它参与哈希，
 * 锚定那一刻条目就自证为被篡改。清单由 `ledger-hash.js`
 * 的 `ENTRY_HASH_FIELD_ORDER` 单点定义，边界由
 * `test/ledger-canonical.test.mjs` 断言。
 */
const sha256String = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const nullableSha256 = sha256String.nullable().default(null);

/**
 * summary 子 schema。**单独导出**是因为写入侧必须在算 entryHash **之前**
 * 拿到归一后的值：z.object 默认**静默丢弃未知键**，若先算 hash 再 parse，
 * 落盘条目的 summary 少几个键 ⇒ 校验侧从存储重算得到的 entryHash 与
 * 存的不一致 ⇒ 一条正常写入的条目自证为 TAMPERED（假阳性，而且每周都假）。
 * 所以顺序是「先归一 → 用归一值算 hash → 再整体 parse 落盘」。
 */
export const LEDGER_MUTATION_TYPES = Object.freeze(['PROMPT_MUTATION', 'TOOL_SYNTHESIS', 'STRATEGY_REWRITE']);
export const LEDGER_DECISIONS = Object.freeze(['AUTO_DEPLOY', 'PENDING_REVIEW', 'REJECT', 'ABSTAIN']);

export const ledgerSummarySchema = z.object({
  // ⛔ 生产 FROZEN 枚举只有这三类（agint-mutator/lib/schema.js:21）。
  // 设计 v1.0 示例里的 "MEMORY" 永远不会产生数据（勘误 #5）。
  // 常量导出给 lib/ledger-rebuild.js 共用：重建侧判「这个历史字段有没有证据」
  // 必须问同一个清单，自己抄一份就是第二个真相源。
  mutationType: z.enum(LEDGER_MUTATION_TYPES),
  changedPlugins: z.array(z.string()).default([]),
  targetMetric: z.string().min(1),
  hypothesisDigest: z.string().min(1),
  predictedDelta: z.number().nullable().default(null),
  actualDelta: z.number().nullable().default(null),
  predictionQuality: z.number().min(0).max(1).nullable().default(null),
  predictionSource: z.enum(['KNOWLEDGE_BASE', 'ANALOGY', 'DEFAULT_RULE']).nullable().default(null),
  // REJECT / ABSTAIN 同样入链：Ledger 记的是「进化发生过什么」，
  // 不是「进化成功过什么」（§4.3.4 末段）。
  decision: z.enum(LEDGER_DECISIONS),
});

/** references 子 schema：归一纪律同 ledgerSummarySchema（外层字段参与哈希）。 */
export const ledgerReferencesSchema = z.object({
  contractHash: nullableSha256,
  lockEventId: z.string().nullable().default(null),
  eventBusIds: z.array(z.string()).default([]),
  populationCandidateId: z.string().nullable().default(null),
  mountTicketId: z.string().nullable().default(null),
  abTestId: z.string().nullable().default(null),
  preimagePath: z.string().nullable().default(null),
  gitCommit: z.string().nullable().default(null),
}).default({});

export const ledgerEntrySchema = z.object({
  // 全局递增序号：永不复用、永不跳号（§4.3.2）。表主键即 String(seq)。
  seq: z.number().int().min(1),
  // 幂等键：同 contractId 不重复追加（§4.3.4 纪律 5）。
  contractId: z.string().min(1),
  generation: z.string().min(1),

  summary: ledgerSummarySchema,

  chain: z.object({
    entryHash: sha256String,
    // seq=1 恒为 GENESIS_PARENT_HASH（sha256:0*64），由代码常量写入
    parentHash: sha256String,
    // 批内树根；首条写入前由 service 计算，永不为 null（null 只在读旧数据
    // 且该字段是后加的场合出现，故不给 default —— 写入侧必须显式提供）
    batchRoot: sha256String,
    merkleRoot: sha256String,
  }),

  references: ledgerReferencesSchema,

  // §4.3.1 ①：UTC + 毫秒 + Z。落库前由 assertUtcMillisIso 再校验一次
  // （zod 只管形状，「是不是真实时刻」交给哈希层拒收，两处都不放行）。
  timestamp: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),

  // ── 以下字段不参与 entryHash（事后回写 / 派生）────────────────────────
  anchorStatus: z.enum(['PENDING', 'ANCHORED', 'ANCHOR_MISMATCH']).default('PENDING'),
  anchorSeq: z.number().int().min(0).nullable().default(null),
  integrity: z.enum(['OK', 'TAMPERED', 'UNVERIFIED', 'GAP_BEFORE']).default('OK'),
  // 历史重建标记（§4.3.5）：原始条目恒为 false。
  reconstructed: z.boolean().default(false),
  evidenceCompleteness: z.enum(['FULL', 'PARTIAL']).nullable().default(null),
});

/**
 * 「可哈希核」schema：entryHash 输入那 7 个字段的校验形状（§4.3.1 约束 1-4）。
 *
 * 由 ledgerEntrySchema **派生**（omit chain + 把 parentHash 摊平成一个普通字段），
 * 而不是另写一份字段清单 —— 否则「哪些字段参与哈希」会出现两个真相源，
 * 加字段时改了一处忘另一处，正是本交付物要防的那类漂移。
 *
 * 写入侧的用法（lib/ledger.js）：先用本 schema 归一 + 校验 → 用归一值算 entryHash
 * → 再用完整 schema 落盘。顺序不能反，理由见 ledgerSummarySchema 的注释。
 *
 * ⚠️ 派生形状里 `parentHash` 是平铺的（chain 里的派生摘要此时还不存在），
 * 而 `projectEntryHashInput()` 读的是 `entry.chain.parentHash` ——
 * 两者的对应由 ENTRY_HASH_FIELD_ORDER 单点定义，并由
 * test/ledger-canonical.test.mjs 的「哈希入参字段集合」断言锁死。
 */
export const ledgerEntryCoreSchema = ledgerEntrySchema
  .omit({ chain: true })
  .extend({ parentHash: sha256String });

// ── 上限常量（owner：plugin index.js 引用） ────────────────────────────────
/**
 * prediction_outcomes 表 entry（Phase 1.1 支点 1b / R1′，Sprint 24 计划的度量表）。
 *
 * ## 它与链的关系：只交叉引用，不参与哈希
 *
 * §4.3.4 已裁定「度量不回填链」：Ledger 条目记的是「这一期进化做了什么决定」，
 * 事后测到的 actual 写在这张表里，用 `contractId` 交叉引用。
 * 好处：链的 entryHash 永不因度量而变（否则一条记录要被重写多次，纪律 9 直接崩）；
 * 代价：这张表**可以合法地晚于链**，读侧必须能处理"有锁、有条目、还没测"。
 *
 * ## 为什么字段这样收
 *
 * - `baseline` / `candidate` 两侧都存**原始计数**（passed/total）而不只存 passRate：
 *   90.9% 是 10/11 还是 100/110，可信度完全不同。只留比率会把样本量信息抹掉，
 *   而 Phase 2 学派生指标时要按样本量加权。
 * - `restoreVerified` 必填：双态对照要把被改文件临时换回 preimage 再换回来。
 *   护栏没核过（假）的那条测量**不可信**，必须在数据里带着这个标记，
 *   而不是靠"事后有人记得这条是异常窗口跑的"。
 * - `actualDelta` 单位 = **百分点**（与 `TAU_METRIC.SUCCESS_RATE = 3.0`「3.0pp」同量纲）。
 *   跨单位换算由读侧负责，这里不做归一 —— 归一会把 τ 表的语义绑到存储上。
 * - ⛔ 不存 `NO_EVIDENCE` 之类的"测不到"记录：测不到不是度量。
 *   那种状态走 `cycle.summary` + `failure_pattern`，表里每一行都必须是一次真测量。
 */
/**
 * 两把尺子（2026-10-03）：
 * - `TEST_CORPUS_PAIR_RUN`（R1′）：按被改文件筛出的 node:test 子集，双态各跑一遍。
 * - `SKILL_GATE_PAIR_RUN`（R2）：技能文件的双态内容断言集，判据见 driver 的 `lib/skill-gate.js`。
 *   分母 = **人工签核**的 case 条数；签核为空 ⇒ 上层记 NO_EVIDENCE，走不到这里。
 */
export const OUTCOME_METHODS = Object.freeze(['TEST_CORPUS_PAIR_RUN', 'SKILL_GATE_PAIR_RUN']);
export const OUTCOME_METRICS = Object.freeze(['SUCCESS_RATE', 'TOKEN_EFFICIENCY', 'LATENCY', 'REGRESSION']);

const outcomeSideSchema = z.object({
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  total: z.number().int().min(1),
  passRate: z.number().min(0).max(1),
});

export const predictionOutcomeEntrySchema = z.object({
  contractId: z.string().min(1),
  // UTC 毫秒串（与 Ledger 同一条判据：时间形状不统一，跨源对账就得靠猜）
  measuredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  method: z.enum(OUTCOME_METHODS),
  targetMetric: z.enum(OUTCOME_METRICS),
  changedPath: z.string().min(1),
  // 实际跑了哪些文件（覆盖门的产物）—— 语义是**触达面文件**，两把尺子都填这里（老板 2026-10-03 拍 7-3=1）：
  // R1′ 填测试文件；R2 填 `[SKILL.md, <skill>.cases.json]`。空数组到不了这里 —— 覆盖门先拦掉。
  testFiles: z.array(z.string().min(1)).min(1),
  baseline: outcomeSideSchema,
  candidate: outcomeSideSchema,
  actualDelta: z.number(),
  predictedDelta: z.number().nullable().default(null),
  predictionQuality: z.number().min(0).max(1).nullable().default(null),
  pqReason: z.string().nullable().default(null),
  isDeadZone: z.boolean().default(false),
  deadZoneThreshold: z.number().nullable().default(null),
  baselineNoiseStd: z.number().nullable().default(null),
  restoreVerified: z.boolean(),
  // ⚠️ 内层默认值必须**逐个写全**，不能只给 `.default({})`。
  // 实测（zod 4.6.5）：对象字段的 `.default({})` 只在 key 缺失时塞进 `{}`，
  // **不再把 `{}` 送回内层 schema 跑一遍** ⇒ 内层的 `.default(null)` 不生效，
  // 读出来是 `undefined` 而不是 `null`。
  // 这条纪律要保住的正是「缺失显式为 null」，所以这里手写全量默认值。
  evidence: z.object({
    preimagePath: z.string().nullable().default(null),
    baselineSha: z.string().nullable().default(null),
    candidateSha: z.string().nullable().default(null),
    ledgerSeq: z.number().int().nullable().default(null),
    hypothesisLock: z.string().nullable().default(null),
    /**
     * R2 留证：条目链上原话的 `targetMetric`（技能类现在多是 `'unspecified'`）。
     * 门禁集按构造产出通过率 ⇒ 记录的 `targetMetric` 写 SUCCESS_RATE；
     * 没有这一栏，读的人只看见"指标被改过"，看不见依据。⛔ 不做成推断字段。
     */
    entryTargetMetric: z.string().nullable().default(null),
  }).default({
    preimagePath: null, baselineSha: null, candidateSha: null, ledgerSeq: null, hypothesisLock: null,
    entryTargetMetric: null,
  }),
});

export const LIMITS = {
  FAILURE_PATTERNS: 100,
  SUCCESS_TEMPLATES: 50,
  EVOLUTION_LOG_LINES_PER_DAY: 1000,
  /**
   * contract_locks 上限。
   * 依据：设计 §3.2 定义 1 Generation = 1 期 evolution-cycle（当前排期每周 1 期），
   * 一期可产生 0~N 个 Contract。取 1000 意味着即使每周 5 个 Contract
   * 也能存 ~200 期（近 4 年）不轮转。**锁定记录永不删除** ——
   * 删一条就等于给一段历史开一个后门（防篡改机制自身被消解）。
   */
  CONTRACT_LOCKS: 1000,
  /**
   * evolution_ledger 条目上限（**只 warn 不 prune**）。
   * 依据：设计 §4.3.3 按 <1k 条量级设计，Phase 1 目标 ≥20 条 + 重建 ≥5 条。
   * ⛔ 条目永不删除（继承 contract_locks 纪律）：删一条等于给一段历史开后门；
   * 删尾造成 head 倒退、删中间造出 GAP，两者都是篡改级事件（§4.4.4）。
   * 超限的正确动作是升 Ledger 规格版本并启用分卷，不是就地轮转。
   */
  LEDGER_ENTRIES: 2000,
  /**
   * prediction_outcomes 上限（**只 warn 不 prune**）。
   * 依据：设计 §9 的 Phase 1 收口门槛是「非死区记录 ≥20 条」，每周 1 期、
   * 一期 0~N 个 Contract ⇒ 2000 条够跑几十年。
   * 与 contract_locks 同一条纪律：度量记录是历史事实，删一条等于把一段校准史抹掉；
   * 超限的正确动作是分卷或升规格，不是轮转。
   */
  PREDICTION_OUTCOMES: 2000,
  /**
   * benchmark_frozen_set 上限（**只 warn 不 prune**）。
   * 依据：Frozen 集每次入账一条，一次进化周期至多几次（重生成清单 / Frozen 增长）。
   * 取 500 够跑多年。⛔ 与 contract_locks 同一条纪律：**永不删除** ——
   * 删一条就抹掉一段「当时冻结集是什么」的历史，防篡改比对随之失去基线。
   */
  BENCHMARK_FROZEN_SETS: 500,
};

// ── Frozen 基准集快照（Phase 0.1 / Sprint 19）────────────────────────────

/**
 * benchmark_frozen_set 表 entry：某一时刻**冻结集是什么**的防篡改留证。
 *
 * ## 它回答的问题
 *
 * 三层隔离（Evolution / Validation / Frozen）的全部价值押在一句话上：
 * **Frozen 集自冻结以来没被改过**。这句话以前只是文档里的一句承诺 ——
 * 没有任何 artifact 记录过「当时的冻结集是哪些单元、各自内容是什么」。
 * 本表就是那个 artifact：每次清单重生成 / Frozen 集增长时落一条。
 *
 * ## 为什么存聚合 hash 而不存 123 个单元
 *
 * 存全集会让每一行随单元数线性膨胀，且比对的复杂度转移到读侧。
 * 聚合 hash（`frozenAggregateHash`，算法在 `bin/lib/scenario-tier.mjs`）
 * 把「名单 + 各单元 contentHash」压成一个值：增删任一 Frozen 单元、
 * 或改任一 Frozen 单元的内容，hash 必变。
 *
 * ⚠️ hash **不含** `labelAuthority`：HELDOUT → GOLD 是合法的一次性降级，
 *    算进来会让合法降级被判成篡改（假阳性，而且每周都假）。
 *
 * ## ⛔ 只增不改（与 contract_locks 同一条纪律）
 *
 * 同 `setId` 二次写入 ⇒ 拒绝并抛错。允许覆盖 = 重算一遍新 hash 盖掉旧值
 * ⇒ 篡改不留痕 ⇒ 这张表也就名存实亡。
 */
export const benchmarkFrozenSetSchema = z.object({
  /** 主键。`frozen-<ISO>` 形态，由 caller 传（本方法不取时钟）。 */
  setId: z.string().min(1),
  /** 快照时刻（ISO，caller 传）。 */
  capturedAt: z.string().min(1),
  /** sidecar 格式版本。版本变了 ⇒ 比对口径变了，必须显式标注而不是混着比。 */
  tieringVersion: z.string().min(1),
  frozenCount: z.number().int().min(0),
  /** Frozen 单元名单（排序后）。空集是合法值 —— 首期还没分配 Frozen 就是空。 */
  frozenUnitIds: z.array(z.string().min(1)).default([]),
  /** `sha256:<64 hex>`，见文件头注释。 */
  frozenAggregateHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** 当时的清单单元总数（123）—— 让「分母变了」这件事可读。 */
  inventoryTotalUnits: z.number().int().min(0),
  failCount: z.number().int().min(0),
  /** H1 下限 = ⌈0.6 × failCount⌉。fail 数变化时它必须跟着重算。 */
  h1EvolutionMinFail: z.number().int().min(0),
  /** H3 上限 = failCount − h1EvolutionMinFail。同上。 */
  h3FrozenFailProbeCap: z.number().int().min(0),
  /** 谁写的（如 `bin/anchor-frozen-set.mjs`）。无 provenance 的留证不可信。 */
  source: z.string().min(1),
  note: z.string().default(''),
});

// ── 内容子串匹配（queryFailures / queryTemplates 用） ─────────────────────

export function matchesQuery(text, query) {
  if (!query) return true;
  const q = String(query).toLowerCase().trim();
  if (!q) return true;
  return text.toLowerCase().includes(q);
}
