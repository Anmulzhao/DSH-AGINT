# agint-skill-autocreate

P0-1 技能自动创建机制（Sprint 14 检测层）。把「技能创建」从「人驱动」变成「系统驱动 + 人审核」的第一段：**自动检测重复任务模式，生成技能候选提案**。

设计稿：`wiki/设计-P0-1-技能自动创建机制.md`（v0.1-draft，作者：智进）。

## 当前能力（Sprint 14 检测层）

```
agint_tool_stats.jsonl ──▶ 聚合任务实例 ──▶ 模式检测 ──▶ 技能候选提案
   (tool-stats 落盘)        (同一 turn 内        (序列全等 +      (纯模板，
                             连续调用)            相似度≥0.8      零 LLM)
                                                  + 累计≥3)
```

- **detect()**：读 tool-stats JSONL 过去 24h → 按 `(sessionId, turn)` 聚合任务实例 → 与历史 `task_patterns` 比对（工具序列严格全等 + 参数结构相似度 ≥0.8）→ 累计 ≥3 次跨过「重复门槛」→ 选匹配模板生成 SKILL.md 草稿候选，状态 `PENDING_EVAL`。
- **不评估、不发布**：`triggerEval` / `release` / `rollback` 显式抛「未实现」（Sprint 15 接 D-QAF Phase 1-3，Sprint 16 接灰度发布），绝不静默。
- **自我评估禁止**（设计稿 §9.4）：技能名/描述含 `autocreate` / `自动创建` 等关键词 → 不生成候选，防递归自改。
- **事件**（软依赖 agint-event-bus，不可用降级为仅 audit）：`skill-autocreate.pattern-detected`、`skill-autocreate.candidate-created`。
- **每日调度**：agint-cron 新增 `skill-autocreate-aggregate` job（daily 04:45，设计稿指定时刻）。插件未挂载时 job soft-skip 不报错。

## Service：`agint.skillAutocreate`

| 方法 | 说明 | 状态 |
|---|---|---|
| `detect(args)` | 手动触发检测（`{force, windowHours}`）；返回聚合/检测/候选统计 | ✅ |
| `listPatterns(args)` | 列模式（`{status, repeatedOnly, limit}`，按次数降序） | ✅ |
| `listCandidates(args)` | 列候选（`{status, limit}`，按时间降序） | ✅ |
| `getCandidate(id)` | 单个候选详情（含 SKILL.md 草稿） | ✅ |
| `rejectCandidate({id, reason, actor})` | 人工拒绝（候选 REJECTED + pattern dismissed + audit） | ✅ |
| `modifyCandidate({id, skillDraft, actor})` | 人工改草稿（自我指涉草稿拒绝） | ✅ |
| `stats()` | 各状态数量/上限/暂停态/配置快照 | ✅ |
| `pause(actor)` / `resume(actor)` | 暂停/恢复自动创建（内存态，重启还原） | ✅ |
| `config(patch?)` | 读配置；patch 只接受 §8.2 子集（enabled/budget/min_occurrence/require_approval） | ✅ |
| `triggerEval(id)` | 触发 D-QAF 评估 | Sprint 15 |
| `release(id)` / `rollback(id)` | 发布 / 回滚 | Sprint 16 |

## preset 工具（Sprint 14：3 个只读裸调）

| 工具 | 说明 |
|---|---|
| `autocreate_list_patterns` | 列重复任务模式 |
| `autocreate_list_candidates` | 列候选提案 |
| `autocreate_stats` | 自动创建统计（周复盘直接引用） |

写类工具（reject/modify/trigger_eval/release/rollback/pause/resume）随 Sprint 15/16 状态机与发布层一起上，届时按设计稿 §6 配 ask 门禁。

## 存储域：`agint_skill_autocreate`（独占，schemaVersion 1）

| 表 | 上限 | 说明 |
|---|---|---|
| `task_patterns` | 500（超限 warn 不 prune） | 重复任务模式 |
| `candidates` | 200（超限 warn） | 技能候选（含 SKILL.md 草稿） |
| `proposals` | — | Sprint 15 写入（Phase 3 通过后转正） |
| `releases` | 100 | Sprint 16 写入 |
| `audit_log` | 1000（**自动滚动清理最旧**） | 全流程审计 |

## 配置（cordis.patch.yml config 或运行时 config()）

默认值即设计稿 §8.1：`min_occurrence_count: 3`、`param_similarity_threshold: 0.8`、`auto_create_enabled: true`、`aggregate_cron: "45 4 * * *"` 等。运行时可改子集见 `config()`。

## 已知边界（如实标注）

- **token 成本恒 null**：tool-stats 不记录 token，`avgTokenCost` 字段保留待其增补。
- **sessionId/turn 缺失的记录**不参与检测（宁可漏检，不可错检）。
- **可标准化判断（diagnosis 集成）**：`standardizable` 恒 null，Sprint 15 接 `agint.diagnosis` 后填充；本层由「模板匹配 + 人工拒绝」兜底。
- **参数签名 v1**：顶层 key + 粗类型 + 扩展名；扩展名不同视为不同模式（有意为之——批量 .md 和 .js 是不同任务）。
- **预估收益是启发式**：公式集中在 `lib/proposer.js`，Sprint 15/16 实测后校准。
- **paused / 运行时 config 是内存态**：重启还原为 cordis 配置默认值（设计稿未要求持久化，刻意保持简单）。

## 测试

```sh
node --test "test/*.test.mjs" test/smoke.mjs   # 34 tests，零外部依赖可跑
```

覆盖：aggregator（聚合/签名/窗口）、detector（相似度/阈值/增量）、proposer+templates（模板选择/草稿格式/自我指涉拦截）、smoke（契约/schema/LIMITS/spec）、pipeline（mock ctx + 内存 domain + 临时 JSONL 端到端：检测→候选→事件→audit→增量去重→pause→人工拒绝）。

## 挂载

见 `cordis.patch.yml` 模板注释（host 行 + preset tools 行 + safe-update SOP）。cron job 已在 `agint-cron/lib/jobs.js` 注册（`skill-autocreate-aggregate`），插件未挂载时自动 soft-skip。
