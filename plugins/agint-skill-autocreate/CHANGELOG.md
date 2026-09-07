# Changelog — agint-skill-autocreate

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
