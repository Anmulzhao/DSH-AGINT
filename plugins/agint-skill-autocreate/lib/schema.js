/**
 * agint-skill-autocreate: FROZEN schema + LIMITS + 配置默认值。
 *
 * 设计稿 §4（数据结构）/ §8（配置项），版本 v0.1-draft（Sprint 14 检测层）。
 *
 * 红线：
 *   - 状态枚举 / LIMITS 与设计稿 §3.2 状态机、§4 表上限一一对应。
 *   - 自我评估禁止（§9.4）：技能名/描述含 autocreate/自动创建 关键词 → 候选
 *     生成阶段直接跳过（proposer.guardSelfReference），Phase 1 正式拦截在
 *     Sprint 15 由 agint-quality-static 落地。
 */

import { z } from 'zod';

// ── 上限（设计稿 §4.2–§4.5）─────────────────────────────────────────────

export const LIMITS = Object.freeze({
  TASK_PATTERNS: 500,   // 超限 warn，不自动 prune（策展人 P0-2 接手）
  CANDIDATES: 200,      // 超限 warn
  RELEASES: 100,        // 超限 warn（Sprint 16 使用）
  AUDIT_LOG: 1000,      // 超限自动滚动清理最旧的（唯一例外）
});

// ── 枚举（设计稿 §3.2 状态机 / §4.2 §4.3 §4.5）──────────────────────────

/** task_patterns.status（设计稿 §4.2） */
export const PATTERN_STATUSES = Object.freeze([
  'active', 'candidate', 'proposed', 'released', 'dismissed',
]);

/** candidates.status（设计稿 §3.2 / §4.3）
 *
 * Sprint 16 兼容：磁盘上 5 条 Sprint 14 老记录 status="REJECTED"（裸值），
 * Sprint 15 升级时枚举改成了 REJECTED_STATIC/SANDBOX/EVAL 三种带后缀但
 * 没迁移老数据 → autocreate domain open 抛 "does not match its schema"。
 * 临时把 'REJECTED' 加回枚举作为兼容值（语义上等价于 REJECTED_STATIC，
 * 都表示评估失败且不会复活）。等这些记录被清理或自然过期后再移除。
 */
export const CANDIDATE_STATUSES = Object.freeze([
  'PENDING_EVAL',
  'PHASE1_PASS', 'PHASE2_PASS', 'PHASE3_PASS',
  'REJECTED',            // Sprint 14 兼容值（等价 REJECTED_STATIC）
  'REJECTED_STATIC', 'REJECTED_SANDBOX', 'REJECTED_EVAL',
  'QUEUED_FOR_RELEASE', 'BUDGET_WAIT',
  'RELEASED', 'STABLE', 'ROLLED_BACK',
]);

/** 可标准化的根因（设计稿 §3.1 [4]）—— Sprint 15 接 diagnosis 后由引擎填充 */
export const STANDARDIZABLE_ROOT_CAUSES = Object.freeze([
  'TOOL_GAP', 'KNOWLEDGE_GAP', 'PROMPT_DEFICIENCY',
]);

/** 不可标准化根因 → 标记「需人工判断」，写周复盘 */
export const NON_STANDARDIZABLE_ROOT_CAUSES = Object.freeze([
  'REASONING_ERROR', 'PLANNING_FAILURE', 'ENVIRONMENT_SHIFT', 'UNCERTAIN',
]);

// ── FROZEN data schema（设计稿 §4.2 / §4.3 / §4.5）──────────────────────

export const TaskPatternSchema = z.object({
  toolSequence: z.array(z.string().min(1)).min(1),
  paramSignature: z.record(z.string()),
  // 工具 → 该工具在某次真实调用中的 args（提案层 renderBody/extractTriggers 用，
  // 渲染「参数参考」与触发器；修复 K45.4 静默丢字段——此前未声明被 zod strip）。
  // 存量行无此字段 → default({}) 保证向后 parse 安全。
  sampleArgs: z.record(z.any()).default({}),
  // ── Phase 2：语义窗口锚点（2026-09-17 分治架构设计 §5.2）─────────────────
  // 提案层据此回查会话日志、用本地文本窗口填 `## 为什么` / `## 避坑`。
  // **必须在此声明**——未声明字段会被 zod .parse() 静默 strip（K45.4 的教训）。
  // 存量行/无锚点场景 → null，提案降级为纯模板（不阻断）。
  sampleAnchor: z.object({
    sessionId: z.string().nullable(),
    turn: z.number().int().nullable(),
    step: z.number().int().nullable(),
  }).nullable().default(null),
  description: z.string().min(1),

  occurrenceCount: z.number().int().min(1),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  avgDurationMs: z.number().nullable().default(null),
  avgTokenCost: z.number().nullable().default(null), // tool-stats 暂无 token 数据，恒 null
  successRate: z.number().min(0).max(1),

  status: z.enum(PATTERN_STATUSES).default('active'),
  standardizable: z.boolean().nullable().default(null),
  standardizableConfidence: z.number().nullable().default(null),
  linkedCandidateId: z.string().nullable().default(null),
});

export const SkillDraftSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  category: z.string().default('productivity'),
  template: z.string().min(1),
  frontmatter: z.object({
    name: z.string(),
    description: z.string(),
    triggers: z.array(z.string()),
    tools: z.array(z.string()),
  }),
  body: z.string().min(1),
  references: z.array(z.string()).default([]),
  scripts: z.array(z.string()).default([]),
});

export const CandidateSchema = z.object({
  sourcePatternId: z.string().min(1),
  source: z.enum(['auto', 'manual']),
  triggerEvent: z.string().min(1),

  skillDraft: SkillDraftSchema,

  estimatedBenefit: z.object({
    successRateImprovement: z.number().min(0).max(1),
    timeSavingsPct: z.number().min(0).max(1),
    tokenSavingsPct: z.number().min(0).max(1),
    harmIncrementEstimate: z.number().min(0).max(1),
  }),

  status: z.enum(CANDIDATE_STATUSES).default('PENDING_EVAL'),
  evalResults: z.record(z.any()).default({}), // Sprint 15 填充 phase1/2/3
  rejectionReason: z.string().nullable().default(null),

  releasedAt: z.string().nullable().default(null),
  releasedVersion: z.string().nullable().default(null),
  rollbackReason: z.string().nullable().default(null),
});

export const AuditLogSchema = z.object({
  timestamp: z.string(),
  actor: z.string().min(1), // "system" | "human:username"
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string(),
  details: z.record(z.any()).default({}),
  reason: z.string().nullable().default(null),
});

// ── 配置（设计稿 §8.1）───────────────────────────────────────────────────

export const ConfigSchema = z.object({
  // 检测阈值
  min_occurrence_count: z.number().int().min(2).default(3),
  param_similarity_threshold: z.number().min(0).max(1).default(0.8),
  min_standardizable_confidence: z.number().min(0).max(1).default(0.6),

  // ── 成功率准入门（2026-09-13 新增；Hermes 对照 §六ter 建议 B）───────────
  // 目的：堵住「把反复失败的固化成技能」。次数门槛只证明「经常发生」，
  // 不证明「做对了」——一个稳定失败的序列重复 3 次同样会跨过
  // min_occurrence_count，而这恰恰是最不该被沉淀的东西。
  // 语义：occurrenceCount 达标 **且** successRate >= 本阈值 → 才进 newRepeat
  // （→ 发 pattern-detected / 判定可标准化 / 生成候选）。
  // 被拦下的模式**照常入库**（可观测），只是不成候选；拦截写审计留痕。
  min_pattern_success_rate: z.number().min(0).max(1).default(0.6),

  // ── A1 特异性门（2026-09-18；质量门方案 §2 A1 + K51「可回滚 > 可审批」）──
  // 判据（lib/detector.js `classifySpecificity`）：工具序列里既无领域工具
  // 也无未知工具（= 纯脚手架，如 `glob → read → pwsh`）→ 拦下：仍入库留痕，
  // 但不发 pattern-detected、不生成候选。
  // 为什么需要：次数门槛只证明「经常发生」。脚手架序列恰恰频次最高，
  // 因为任何任务都要读写执行 —— 2026-09-17 上线的 `glob-glob-glob-glob`
  // 就是这道门缺失的直接产物。
  // 默认 **开**（K42：这是拦错误的门，不是放大错误的门）。
  // 置 false 整门关闭，退回 2026-09-17 及之前的行为。
  pattern_specificity_gate_enabled: z.boolean().default(true),

  // 追加的**脚手架黑名单**（与 detector.js 的 SCAFFOLD_TOOLS 取**并集**，不替换）。
  // 为什么扩展的是黑名单而不是白名单：判据是黑名单（序列全是脚手架才拦），
  // 需要能补的是「宿主新出现的一种通用动作」（如新 shell 工具、新的通用检索工具），
  // 而不是「新业务工具」——后者本来就不在黑名单里，天然放行，无需登记。
  // 该补什么，看审计 `pattern_specificity_unknown_tools` 里那些实为通用动作的高频项。
  scaffold_tools_extra: z.array(z.string()).default([]),

  // 发布前特异性复检（2026-09-18）。与 A1 同一套黑名单判据，但作用点在**发布**
  // 而非生成：A1 只管候选产生那一刻，管不到它上线前累积的存量队列 —— 实测 37 个
  // 待发候选里 36 个是纯脚手架，且当日已自动发布出 `pwsh-pwsh-pwsh-pwsh`。发布是
  // 最后一道闸，放这里才能同时覆盖存量与未来。
  // 关掉：置 false（退回「只靠 A1 入口门」的行为）。
  release_specificity_gate_enabled: z.boolean().default(true),

  // ── 语义准入总开关（2026-09-13 新增；P2-2 §六ter 建议 A + C）───────────
  // 默认 **开**——这是「防垃圾」的门，不是可选增强（与 Hermes 那边"更聪明的
  // 机制默认关"相反：那是放大错误的，这个是拦错误的）。
  // 置 false 可整体退回旧行为（仅走 quality-static 的安全/格式四族）。
  // 规则词表与判据见 lib/semantics.js，改动均有单测覆盖。
  semantics_check_enabled: z.boolean().default(true),

  // ── A3 信息量门（2026-09-17 Phase 2；质量门方案 §2 A3）────────────────────
  // 四判据：non-informative-body / no-concrete-value / tool-recap-only /
  //         one-off-narrative（详见 lib/semantics.js）。
  // 与 semantics_check_enabled 的分工：后者管整段语义检查的**总开关**，
  // 本项只管 A3 那四条「有没有信息量」的判据——两者正交（一组问危不危险，
  // 一组问是不是垃圾）。独立开关是为了 A3 万一误杀时能单独回滚，
  // 而不丢掉安全向的既有四条。
  semantics_quality_gate_enabled: z.boolean().default(true),

  // ── [4] 可标准化判断（2026-09-09 补齐；详见 lib/standardizable.js）──────
  // 硬否决阈值：低于任一即判定「明确不可标准化」
  standardizable_min_steps: z.number().int().min(1).default(2),
  standardizable_min_distinct_tools: z.number().int().min(1).default(2),
  // 轨道 A（diagnosis 归因）开关：'auto' = 有失败证据才启用；
  // 'off' = 恒走启发式；'on' = 强制走 diagnosis（无证据时退化为 false）
  standardizable_route: z.enum(['auto', 'on', 'off']).default('auto'),

  // 评估阈值（Sprint 15 使用，先冻结默认值）
  phase2_min_success_improvement: z.number().default(0.1),
  phase3_min_harm_increment: z.number().default(0.5),

  // ── Sprint 15 T1/T3/T4：评估层运行参数（设计稿 §7.3）────────────────────
  // Q2 拍板：E0（无可执行物 / 沙箱证据不足）也放行，provisional 标记留给
  // Sprint 16 观察期；phase3_evidence_gate 恒 'E0'（未来收紧改配置即可）
  phase3_evidence_gate: z.enum(['E0', 'E1']).default('E0'),
  // ABSTAIN / 未决后冷却天数（T4：冷却期内禁止重评）
  eval_cooldown_days: z.number().int().min(0).default(7),
  // 单候选最大评估尝试次数（超限转人工：保持 PENDING_EVAL + audit）
  max_eval_attempts: z.number().int().min(1).default(3),
  // staging 终态后 TTL 清理天数（设计稿 §5.1：7 天）
  staging_ttl_days: z.number().int().min(1).default(7),
  // Phase 2 沙箱超时（毫秒）
  sandbox_timeout_ms: z.number().int().min(1000).default(30000),

  // 发布预算（Sprint 16 使用；回滚也算消耗——防「发了又滚」刷总量）
  weekly_deploy_budget: z.number().int().min(1).default(20),
  observation_period_days: z.number().int().min(1).default(14),
  rollback_threshold: z.number().min(0).max(1).default(0.2),

  // ── Sprint 16 发布层（设计稿 §5；2026-09-09 老板拍板 3 项）──────────────
  // 门 1 总开关（独立于 auto_create_enabled）
  release_enabled: z.boolean().default(true),
  // 门 3 policy 门放行语义（2026-09-13 B 修复）：
  //   'veto'  （默认）只拦 REJECT/ABSTAIN，放行 AUTO_DEPLOY / PENDING_REVIEW ——
  //            即「保留 policy 门拦错、放行其余进观察期」（K42 原则）。新候选 D-QAF
  //            综合分恒 ~71.4 < pendingReview 75，原「仅 AUTO_DEPLOY 放行」会一律
  //            fail-closed，故默认改 veto，让自演化闭环真正闭合。
  //   'strict' 仅 AUTO_DEPLOY 放行（旧行为；若未来想强制 policy 全绿再发布可切回）。
  release_policy_mode: z.enum(['veto', 'strict']).default('veto'),
  // 门 3 policy 门同步超时（超时 = fail-closed 不发布）
  release_policy_timeout_ms: z.number().int().min(100).default(5000),
  // 门 2 人工确认窗：require_human_approval=true 或 now < until 即不自动发布；
  // 2026-09-09 19:11 老板改口：不接入中间环节 → 默认 null（全自动发布，事后日报）。
  // 想重新开窗：运行时把 require_human_approval_until 设为未来时间即可，代码无需改。
  require_human_approval_until: z.string().nullable().default(null),
  // 观察期（拍板 3）：窗 14 天 + ≥5 次调用判 STABLE
  observation_min_calls: z.number().int().min(1).default(5),
  // 自动回滚：连续 N 个 M 天子窗 0 调用（三重确认）
  rollback_window_days: z.number().int().min(1).default(3),
  rollback_zero_call_windows: z.number().int().min(1).default(3),
  // 回滚冷却：同名技能被回滚后 N 天内不得重发（防振荡）
  rollback_cooldown_days: z.number().int().min(0).default(30),
  // 发布目标目录（agint preset skill root —— 目录即注册，watcher 自动发现）；
  // 测试用 skills_root 覆盖指向临时目录
  skills_root: z.string().default(
    () => (process.env.DSH_HOME || (process.env.HOME + '/.dsh')) + '/.agent-presets/agint/skills',
  ),
  // 回滚归档区（只归档不删除，任何时刻可人工放回）
  rollback_archive_dir: z.string().default(
    () => (process.env.DSH_HOME || (process.env.HOME + '/.dsh')) + '/storages/agint_skill_autocreate_rolled_back',
  ),

  // 去重（Sprint 15 使用）
  dedup_similarity_threshold: z.number().default(0.9),

  // 调度（agint-cron 侧读取，本插件仅透出）
  aggregate_cron: z.string().default('45 4 * * *'),

  // 安全
  auto_create_enabled: z.boolean().default(true),
  require_human_approval: z.boolean().default(false),
  dangerous_tools_blocklist: z.array(z.string()).default(['terminal:rm -rf', 'terminal:dd']),

  // 数据源（tool-stats JSONL，与 agint-tool-stats 默认值一致）
  jsonlPath: z.string().default(
    () => (process.env.DSH_HOME || (process.env.HOME + '/.dsh')) + '/storages/agint_tool_stats.jsonl',
  ),
  aggregate_window_hours: z.number().int().min(1).default(24),

  // ── Phase 1 数据源切换（2026-09-17 分治架构设计 §4 Pipe A）──────────────
  // 背景：tool_stats.jsonl 是会话日志的二级派生物，靠 04:30 backfill 回填；
  // 回填一挂 → unmatched 丢弃 → 静默漏检。会话日志本身已含 turn/step/args，
  // 直读可彻底消除这条隐式时序依赖（静默漏检头号来源）。
  //   'session'    （默认）—— 直读 ~/.dsh/sessions 会话日志，不再依赖回填
  //   'tool_stats'         —— 旧行为，仅读 tool-stats JSONL（回滚用）
  //   'both'               —— 两会话源合并去重（过渡期灰度）
  sessions_root: z.string().default(
    () => (process.env.DSH_HOME || (process.env.HOME + '/.dsh')) + '/sessions',
  ),
  session_source: z.enum(['session', 'tool_stats', 'both']).default('session'),

  // ── Phase 2：本地语义窗口（2026-09-17 分治架构设计 §5.2）────────────────
  // 提案层拿 pattern 的 sampleAnchor 回查会话日志，用「本地文本窗口」填
  // `## 为什么` / `## 避坑` 两段——零 LLM 调用，不依赖 dream 的通路
  // （dream 的 Deep/LLM 通路至今 promoted=0，未证实，不能押注）。
  // 置 false → 提案退回纯模板（旧行为，可运行时回滚）。
  semantic_window_enabled: z.boolean().default(true),
  // 窗口半径：锚点前后各取多少条「人话」事件
  semantic_window_radius: z.number().int().min(1).max(20).default(4),
  // 喂给提案器的窗口文本总字符上限（防单个大会话把草稿撑爆）
  semantic_window_max_chars: z.number().int().min(200).default(4000),

  // ── LLM 接入（2026-09-18 LLM 接入 autocreate 方案 §6）─────────────────
  // 两个接入点：判定闸门（要不要固化）+ 提案生成（怎么写）。**默认全 off
  // ⟹ 合入即零行为变化**——off 时 judgeViaLLM 根本不被调用（不是调了再忽略）。
  //
  // 判定闸门三档（照抄同文件 cross_session_aggregation 的现成范式，见下）：
  //   'off'     不调用任何 LLM，完全走既有硬否决 + 轨道 B 打分（默认）
  //   'shadow'  照常调用，但**不改变任何结论**，只把规则判定与 LLM 判定的
  //             分歧写进 audit（llm_judge_shadow）——Phase A 的取证档
  //   'primary' 采用 LLM 判定（LLM 不可用时回落轨道 B）
  // 为什么必须独立于 standardizable_route：后者语义是「轨道 A（diagnosis
  // 归因）开关」，**没有 shadow 档**；而本方案第一版必须 shadow（K58：dream
  // 的 LLM 通路至今 promoted=0，不能把未验证路径当依赖）。
  llm_judge_mode: z.enum(['off', 'shadow', 'primary']).default('off'),
  // 提案生成（接入点 2，独立启停）。Phase A/B 期间即使一次调用已产出
  // authoring，也**直接丢弃不用**、只写 audit 留存 —— 这样「一次调用两个产出」
  // 不会强迫两件事一起上线（方案 §2 D1「保留退路」）。
  llm_authoring_mode: z.enum(['off', 'on']).default('off'),
  // provider / model：**空字符串 = 跟随宿主默认**，不硬编码任何值。
  // 刻意不照抄 dream 的 DEFAULT_PROVIDER='minimax-cn' / DEFAULT_MODEL='MiniMax-M3'
  // 常量——那是从 ~/.dsh/settings.yaml 实测抄来的值，换模型那天会变成静默故障
  // （K59 那条被固化 12 天的错误归因就是这么来的）。形态照抄 dream，短板不照抄。
  // ⚠️ 绝不硬编码 'deepseek'：DSH 把 deepseek 仅作 fallback adapter。
  llm_provider: z.string().default(''),
  llm_model: z.string().default(''),
  // 单次调用超时（双保险之一；另一道是 AbortController）
  llm_timeout_ms: z.number().int().min(1000).default(60_000),
  // 硬预算：每日调用上限（**含 shadow**——shadow 期同样花钱）。
  // 只在过了 5 条硬否决的 pattern 上调用，量级是「过门槛的模式数/天」，
  // 不是全量会话。预算耗尽不报错，静默跳回轨道 B，但记
  // llm_budget_exhausted（否则又变成「分不清是没有还是被拦了」，K59）。
  llm_daily_budget: z.number().int().min(0).default(20),
  // 提案生成是否要求判定先通过（默认 true：判定说不要，就不浪费一次撰写）
  llm_authoring_requires_judge: z.boolean().default(true),

  // ── 跨会话聚合（2026-09-17 提案 d5124051；老板拍板走完整 preflight）────
  // 背景：原实现 key = (sessionId, turn)，跨会话重复的工作流被切成 N 份
  // x1，min_occurrence_count 几乎跨不过去。13.5 天 / 9088 条数据回放：
  //   session+turn: 11 个跨门槛模式；跨会话: 21 个（+91%）。
  // 模式：
  //   'off'         — 旧行为，按 (sessionId, turn) 切分（v0.3.4 默认等价）
  //   'shadow'      — 新旧并行算，结果 diff 写审计，**不发候选**（灰度期）
  //   'primary'     — 用跨会话结果作为唯一任务边界
  // 任务边界启发式：30s idle 切分（与历史 max 30 tools 降噪正交）；
  //   任一工具序列内的会话数 > cross_session_max_sessions_per_task 即弃
  //   （防"恰好用同一工具序列"的无关会话被误合并）。
  cross_session_aggregation: z.enum(['off', 'shadow', 'primary']).default('primary'), // 2026-09-17 老板拍板：切 primary 一步到位
  cross_session_idle_ms: z.number().int().min(1000).default(30_000),
  cross_session_max_sessions_per_task: z.number().int().min(1).default(20),
});

export const DEFAULT_CONFIG = Object.freeze(ConfigSchema.parse({}));

/** §8.2 运行时可配置子集（autocreate_config 工具允许改的字段） */
export const RUNTIME_CONFIG_KEYS = Object.freeze([
  'auto_create_enabled',
  'weekly_deploy_budget',
  'min_occurrence_count',
  'require_human_approval',
  // Sprint 16：发布层运行时旋钮
  'release_enabled',
  'require_human_approval_until',
  'release_policy_mode',
  'observation_min_calls',
  // Sprint 17：跨会话聚合（2026-09-17 解封，老板拍板切 primary）
  'cross_session_aggregation',
  'cross_session_idle_ms',
  'cross_session_max_sessions_per_task',
  // Phase 1：数据源切换（可运行时回滚到 tool_stats）
  'session_source',
  'sessions_root',
  // A1 特异性门（2026-09-18）
  'pattern_specificity_gate_enabled',
  'scaffold_tools_extra',
  // 发布前特异性复检（2026-09-18）
  'release_specificity_gate_enabled',
  // Phase 2：本地语义窗口（可运行时关掉，退回纯模板）
  'semantic_window_enabled',
  'semantic_window_radius',
  'semantics_quality_gate_enabled',
  // ── LLM 接入（2026-09-18）：两个接入点全部可运行时启停（K51 kill-switch）
  // 出问题先关再查，不用改代码不用重启。注意运行时改的是**内存态**，
  // 重启还原为 patch.yml 的值。
  'llm_judge_mode',
  'llm_authoring_mode',
  'llm_provider',
  'llm_model',
  'llm_timeout_ms',
  'llm_daily_budget',
  'llm_authoring_requires_judge',
]);

// ── D4：数据来源黑名单（三处副本之一）─────────────────────────────────────
//
// Sprint14 §2.1 D2：curriculum 的挑战执行是「同一类任务反复练」，天然命中
// 本插件的「工具序列全等 + 累计 ≥3 次」判定。不过滤的话 Sprint 14 结束后
// 会开始批量产出「做挑战」的垃圾技能候选。
//
// 判定优先 sessionId 前缀（tool-stats 记录**不支持**自定义 source 字段，
// 已确认）；若未来 tool-stats 增补 source 字段，sourceTags 分支自动生效。
//
// 冗余是有意的：AGINT 存储域互斥，不建共享模块；一致性由
// plugins/agint-curator/test/const-consistency.test.mjs 自动扫描断言。
// 改动任一副本 → 必须同步三处 + bump DATA_SOURCE_BLACKLIST_VERSION。

export const EXCLUDED_DATA_SOURCES = Object.freeze({
  sessionIdPrefixes: Object.freeze(['curriculum-']),
  sourceTags: Object.freeze(['curriculum']),
});

export const DATA_SOURCE_BLACKLIST_VERSION = '2026-09-14.v1';

/**
 * 判定一条 tool-stats 记录是否来自被排除的数据源。
 * 向后兼容：无 sessionId / 无 source 字段的旧记录 → false（照常处理）。
 */
export function isExcludedRecord(record) {
  if (!record || typeof record !== 'object') return false;
  const sid = record.sessionId;
  if (typeof sid === 'string' && sid) {
    for (const p of EXCLUDED_DATA_SOURCES.sessionIdPrefixes) {
      if (sid.startsWith(p)) return true;
    }
  }
  const src = record.source;
  if (typeof src === 'string' && src) {
    for (const t of EXCLUDED_DATA_SOURCES.sourceTags) {
      if (src === t) return true;
    }
  }
  return false;
}

// ── 自我评估禁止（设计稿 §9.4）───────────────────────────────────────────

const SELF_REF_RE = /autocreate|auto-create|自动创建|skill-autocreate/i;

/** 技能草稿名/描述命中自我指涉关键词 → true（不得生成候选，防递归自改） */
export function isSelfReferential(skillName, description) {
  return SELF_REF_RE.test(skillName ?? '') || SELF_REF_RE.test(description ?? '');
}
