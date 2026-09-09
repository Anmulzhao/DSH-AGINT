# Changelog — agint-skill-autocreate

## 0.3.2 (2026-09-09 晚) — v0.3.1 紧急修复：autocreate_modify JSON Schema

- 修 v0.3.1 引入的 preset mount 失败：dsh loader 严格 JSON Schema 校验
  要求每个 `type:"object"` 显式声明 `additionalProperties`，`autocreate_modify`
  的 `skillDraft` 参数漏写导致整条 agint preset 挂载失败，UI 冒泡成
  "agentPresets/list failed: Failed to fetch"（实际是 mount 异常）。
- 永久护栏：新增 `test/schema-guard.test.mjs`（K19），扫描 `lib/tools.js`
  所有 `type:"object"` schema，缺 `additionalProperties` 直接 fail；附
  brace-balancing 状态机处理字符串/注释/嵌套。
- 测试 103 → 104 全 PASS。

## 0.3.1 (2026-09-09 晚) — 拍板 2 改口：不接入中间环节，全自动发布

- `require_human_approval_until` 默认 `null`（原 2026-10-07）：门 2 人工确认窗默认关闭，
  候选过 policy 门 + 周预算即自动挂载，事后由外部日报汇报（不再等 autocreate_release 点头）。
- 逃生通道保留：运行时把 `require_human_approval_until` 设为未来时间（或
  `require_human_approval=true`）即可重新开窗，代码无需改。
- 新增默认语义测试（DEFAULT_CONFIG 无确认窗 + 显式开窗仍有效）；测试 102 → 103。

## 0.3.0 (2026-09-09) — Sprint 16 发布层（设计稿 §3，老板拍板 3 项）

**P0-1 全链路收口**：检测 → 评估 → 发布 → 观察 → 回滚全自动闭环（M3）。

### 新增：`lib/release-manager.js`

- **三道门**（全过才落盘，任何一道不过 → 候选停 `BUDGET_WAIT` + `release-held` 事件）：
  1. `release_enabled` 总开关（auto/manual 都拦）；
  2. 人工确认窗：`require_human_approval=true` 或 `now < require_human_approval_until`
     （拍板 2：默认开到 **2026-10-07**，`manual=true` 绕过）；
  3. policy 门：同步问询 `agint.qualityPolicy.decide`，仅 `AUTO_DEPLOY` 放行，
     ABSTAIN / PENDING_REVIEW / REJECT / 超时（5s）/ 异常一律 **fail-closed**（manual 也不绕）；
  4. 周预算：`weekly_deploy_budget`（默认 3），**回滚也算消耗**（`manual` 绕过）。
- **原子落盘**：staging 物料 → `skills_root` 先写 `.tmp-<ts>` 再整目录 rename
  （同盘原子；watcher 自动发现——Sprint16 设计稿 §1.2 源码级核实：无需重启 dsh、
  无需改 agent.cordis.yml）。重名硬防线 + 发布后自检。
- **观察期**（数据源 = tool-stats 的 `skill` 工具调用，零新采集）：
  窗满 14 天 + ≥5 次调用 → `STABLE`；最近 3 个 3 天子窗 0 调用 → 自动回滚；
  窗满不达标 → 展期一次（`extensions≥1` 后仍不达标 → 回滚）；
  **tool-stats 数据源失效 → 顺延判定不回滚**（09-09 停摆排查教训落地）。
- **回滚**：目录归档 `rollback_archive_dir`（只归档不删除）+ candidate/release
  标记 `ROLLED_BACK` + **30 天冷却**（同名禁重发，防振荡）。
- **记忆固化**：发布成功 → evolution-memory `addSuccess`（软依赖，失败不阻断）。
- 5 个新事件：`released` / `rolled-back` / `budget-exceeded` / `release-held` / `release-stable`。

### 变更

- `modifyCandidate`：`QUEUED_FOR_RELEASE`/`BUDGET_WAIT` 状态修改草稿 →
  回 `PENDING_EVAL` 重跑评估（防人工改动引入未评估内容直接挂载）。
- releases 表收紧：新增 `releasedBy`（auto/human）+ `budgetWeek`。
- 配置新增：`release_enabled` / `release_policy_timeout_ms` /
  `require_human_approval_until`（默认 2026-10-07）/ `observation_min_calls`（5）/
  `rollback_window_days`（3）/ `rollback_zero_call_windows`（3）/
  `rollback_cooldown_days`（30）/ `skills_root` / `rollback_archive_dir`；
  `observation_period_days` 默认 7 → **14**（拍板 3）。
- 新 preset 工具 4 个：`autocreate_release` / `autocreate_rollback` /
  `autocreate_list_releases` / `autocreate_modify`（write 类均走 agint-rules 门禁）。
- cron 新 job 2 个（agint-cron）：`skill-autocreate-release`（daily 05:15）+
  `skill-autocreate-observe`（daily 05:30）。
- 测试 102/102 PASS（新增 `test/release.test.mjs` 17 用例：三道门各分支 /
  重名防御 / 回滚归档 / 冷却 / 观察期四分支 / modify 重评）。

## 0.2.1 (2026-09-09) — 补齐 [4] 可标准化判断 + 修 [5] 模板工具名错配

2026-09-09 门槛离线回放时发现的**两处链路断裂**（详见
`docs/operations/p0-1-detector-replay-20260909.md` §7 及
`docs/operations/p0-1-standardizable-20260909.md`）。

### 新增：`lib/standardizable.js`（设计稿 §3.1 [4]，此前整段缺失）

- `judgeStandardizable(pattern, opts)` → `{ standardizable, confidence, route,
  rootCause, reason, signals }`
- **双轨判定**：
  - 轨道 A（diagnosis 归因）：需 `failureEvidence` + `diagnosis.classify`。
    **当前不激活**——aggregator 只落 `successRate`、不聚合 `errorKind`，
    且 `agint-diagnosis` v0.6.0 只暴露需要 `failureId` 的
    `annotate`/`counterfactual`。接口已预留。
  - 轨道 B（启发式，默认）：硬否决 + 正向信号打分。
- **硬否决**（`standardizable: false`，明确低价值，不需人工）：
  `EMPTY_SEQUENCE` / `TOO_FEW_STEPS` / `TRIVIAL_SINGLE_TOOL` /
  `META_TOOL` / `NO_PARAM_STRUCTURE`
- **软判定**（`standardizable: null`，证据不足 → 需人工，写周复盘）：
  `LOW_CONFIDENCE`
- 元工具黑名单：Agent 自我运维动作（自指红线 §9.4）。
  `rule_check` **不在**其中——它是业务输入环节，做成 `rule_` 前缀会误杀
  「先查规范再执行」这类真实流程（回放实测确认）。

### 修复：`lib/templates.js` 工具名归一化（[5] 此前 100% 落空）

- 模板 `requiredTools` 用设计稿抽象名（terminal / file_read / file_write），
  而生产 tool-stats 记录宿主真实工具名（pwsh / read / write / edit / glob /
  grep / ssh_exec…）。两者零交集 → `selectTemplate()` 在**全部真实模式上
  恒返回 null** → 即使过了 [4] 也产不出候选。
- 加 `TOOL_CANONICAL_MAP` / `canonicalTool()` / `canonicalToolSet()`：匹配前
  归一化，渲染（`renderBody`）仍用原始工具名，信息不丢。

### 变更：pipeline 接入

- `index.js` `detect()`：跨门槛 pattern **先过 [4] 再进 [5]**，判定结果
  （含被拒）**一律回写** `task_patterns.standardizable /
  standardizableConfidence`，供周复盘直接扫表。
- 被拒时写 `audit_log`（`standardizable_rejected` / `standardizable_uncertain`）。
- `detect()` 返回新增 `standardizable: { judged, pass, rejected, uncertain }`。

### 新增配置（均带默认值，`config: {}` 无需改动即可生效）

- `standardizable_min_steps`（默认 2）
- `standardizable_min_distinct_tools`（默认 2）
- `standardizable_route`（`auto` / `on` / `off`，默认 `auto`）

### 测试

- 新增 `test/standardizable.test.mjs`（18 项）、`test/template-alias.test.mjs`（6 项）
- 含设计稿 §14.2 的 **50 个已知模式准确率验证**（25 通过 + 25 拒绝，50/50）
- 含**生产回放 7 个真实模式 → 7/7 被拒**（唯一有独立 ground truth 的子集）
- 全量测试 **78/78 PASS**

### 已知局限（诚实标注）

- 50 模式集是**按规则设计的回归集**，不是独立 ground truth；用它的 100%
  不代表真实准确率（目前无任何已发布自动创建技能可当标注样本）。
- 补完 [4]+[5] 后，**生产当前数据下产出仍为 0**——瓶颈已从代码转移到
  数据量（tool-stats 自 09-08 14:50Z 后无新记录，日记录量持续衰减）。

## 0.2.0 (2026-09-08) — Sprint 15 P0-1 评估层（T1–T8）

用户 2026-09-08 拍板（设计稿 §12 五问全定，Q1=A 保 P0-1+P0-2），提前启动
Sprint 15 第一项 P0-1 评估层。A 路径分流评估：复用 D-QAF 执行层但**不复用
综合分决策**（新候选 composite 恒 71.4 < pendingReview 75 的语义错配，§3）。

### 新增

- **`lib/staging.js`（T1）**：候选物化 `$DSH_HOME/storages/agint_skill_autocreate/
  staging/<candidateId>/`（SKILL.md + manifest.json + scripts/），幂等重建；
  TTL 7 天兜底清理（`cleanupStale`）；candidateId 白名单防路径穿越
- **`lib/evaluator.js`（T3）**：`evaluateCandidate()` 三阶段编排
  - Phase 1 静态准入：`qualityStatic.checkPlugin`（真实 10 族，skill-candidate
    profile 组合）→ blocker ⇒ REJECTED_STATIC
  - Phase 2 沙箱门：有 scripts/ 走 `qualitySandbox.runSmoke`（实测通过 ⇒ E1，
    失败 ⇒ REJECTED_SANDBOX）；无可执行物 ⇒ skipped（不标 pass，E0）
  - Phase 3 硬门 + 排序：硬门 = Phase1 无 blocker ∧ Phase2 未失败 ⇒
    PHASE3_PASS（provisional / compositeTrusted:false）；综合分只记录不决策；
    `rankingScore = 0.5×收益均值 + 0.3×min(1,频次/10) + 0.2×(1−harm)`；
    evaluate 抛错 ⇒ REJECTED_EVAL（可重试）
- **`lib/similarity.js`（T5）**：归一化编辑距离去重（与 `skills.list()` 比对，
  相似度 ≥ `dedup_similarity_threshold`(0.9) ⇒ REJECTED_STATIC dedup）
- **`triggerEval()`（T4）**：状态机 PENDING_EVAL → PHASE1_PASS →
  PHASE2_PASS（skipped 不落）→ PHASE3_PASS / REJECTED_STATIC /
  REJECTED_SANDBOX / REJECTED_EVAL（attempts+1 + cooldown，超
  `max_eval_attempts` 转人工）
- **proposals 表写入（§7.2）**：`rankingScore / evidenceLevel / provisional /
  status='QUEUED_FOR_RELEASE' / estimatedBenefit`（P0-2 策展人排序消费）
- **T7 evolution 写入**：Phase 3 通过时 `logPhase4({targetKind:'skill',
  decision:'PENDING_REVIEW', tags:['phase3-provisional',...]})`（枚举受限，
  见 lib/evaluator.js 注释）
- **工具（T6）**：`autocreate_trigger_eval`（write，门禁由 agint-rules 接管）、
  `autocreate_get_candidate`（read，详情含三阶段结果）、`autocreate_list_candidates`
  增强（evidenceLevel / provisional 过滤）
- **配置键（§7.3）**：`phase3_evidence_gate`(E0) / `eval_cooldown_days`(7) /
  `max_eval_attempts`(3) / `staging_ttl_days`(7) / `sandbox_timeout_ms`(30000)
- **测试**：`test/staging.test.mjs`(7)、`test/evaluator.test.mjs`(8)、
  pipeline 集成扩展 4 case（含 **T8 核心验收：零历史正常候选走完 Phase 1-3 →
  PHASE3_PASS，71.4 不死锁**，真实 quality-static checker + 真实 staging）

### 修改

- `lib/storage.js`：`proposalEntrySchema` 扩展 §7.2 字段
- `lib/index.js`：顶部注释 Sprint 14→15；`release/rollback` 仍显式抛
  not implemented（Sprint 16 发布层接力）；stats.sprint → `15-eval-layer`

## 0.1.1 (2026-09-07)

Sprint 14 §2.1 D2：数据源隔离（与 `agint-curator` 配套，防 curriculum 挑战调用污染检测）。

### 修改

- `schema.js` 新增 `EXCLUDED_DATA_SOURCES` / `DATA_SOURCE_BLACKLIST_VERSION` /
  `isExcludedRecord()`（D4 三处副本之一；curator 侧 `const-consistency.test.mjs`
  自动扫描比对）。
- `aggregator.js`：`aggregateTasks()` 丢弃黑名单记录（sessionId 前缀
  `curriculum-`，或未来 `source === 'curriculum'`），返回值新增 `excluded` 计数；
  `detect()` 结果透出该计数。
- 向后兼容：无 `sessionId`/`source` 字段的旧记录照常处理，行为零变化。

### 测试

- 新增 `test/datasource-filter.test.mjs`（5 项）：前缀过滤 / 只靠挑战重复 3 次
  不成模式 / source 标签 / 旧记录兼容 / 常量形状。套件 34 → **39 PASS**。

---

## 0.1.0 (2026-09-07)

Sprint 14 检测层初版（设计稿：wiki/设计-P0-1-技能自动创建机制.md v0.1-draft）。

### 新增

- Service `agint.skillAutocreate`：detect / listPatterns / listCandidates /
  getCandidate / rejectCandidate / modifyCandidate / stats / pause / resume / config。
- 检测管线：aggregator（任务实例聚合 + 参数签名 v1）→ detector（序列全等 +
  参数 Jaccard 相似度 ≥0.8 + 累计 ≥3）→ proposer（纯模板 SKILL.md 草稿 +
  启发式收益预估）。
- 技能模板库：shell-automation / file-processing / api-calling /
  report-generation / code-lint / git-workflow（设计稿 §7.1 全 6 个）。
- 存储域 `agint_skill_autocreate`（5 表：task_patterns / candidates /
  proposals / releases / audit_log；后两者 Sprint 15/16 写入）。
- 事件：skill-autocreate.pattern-detected / candidate-created（软依赖
  event-bus）。
- preset 只读工具：autocreate_list_patterns / autocreate_list_candidates /
  autocreate_stats。
- 自我评估禁止（§9.4）：自我指涉草稿不生成、不可经 modify 注入。

### 关联修改（现有插件，均为加法）

- agint-cron：jobs.js 新增 `skill-autocreate-aggregate` job（daily 04:45，
  插件未挂载时 soft-skip）；index.js services map 增补 `agint.skillAutocreate`。

### 明确未实现（绝不静默）

- triggerEval / release / rollback → 抛「Sprint 15/16 交付」。
- diagnosis 可标准化判断 → standardizable 恒 null。
- D-QAF Phase 1-3 评估、灰度发布、观察期回滚 → Sprint 15/16。
