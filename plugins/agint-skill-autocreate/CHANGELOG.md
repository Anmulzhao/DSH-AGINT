# Changelog — agint-skill-autocreate

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
