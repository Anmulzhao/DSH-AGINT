# agint-skill-autocreate

P0-1 技能自动创建机制（检测+评估+发布全链路）。把「技能创建」从「人驱动」变成「系统驱动 + 人审核」：**自动检测重复任务模式，生成技能候选提案，三道门发布**。v0.4.0 起可选接入 LLM（判定轨道 C + 提案撰写），默认全 off。

设计稿：`wiki/设计-P0-1-技能自动创建机制.md`（v0.1-draft，作者：智进）。

## 当前能力（Sprint 14 检测层）

```
agint_tool_stats.jsonl ──▶ 聚合任务实例 ──▶ 模式检测 ──▶ 技能候选提案
   (tool-stats 落盘)        (同一 turn 内        (序列全等 +      (模板为主体，
                             连续调用)            相似度≥0.8      可选 LLM 判定
                                                  + 累计≥3)        与撰写，默认 off)
```

- **detect()**：读 tool-stats JSONL 过去 24h → 按 `(sessionId, turn)` 聚合任务实例 → 与历史 `task_patterns` 比对（工具序列严格全等 + 参数结构相似度 ≥0.8）→ 累计 ≥3 次跨过「重复门槛」→ 选匹配模板生成 SKILL.md 草稿候选，状态 `PENDING_EVAL`。
- **评估与发布**：`triggerEval`（D-QAF）与 `release`/`rollback`/`observe`（Sprint 16 三道门 + 14 天观察期 + 归档式回滚）已接入，流程见 Service 表与设计稿 §6。
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
| `stats()` | 各状态数量/上限/暂停态/配置快照（含 LLM 配置与当日用量） | ✅ |
| `verifyLlmJudge(args?)` | **真模型**验证判定通路（两个反向样本，只读；⚠️ 消耗 token，手动跑，不进 CI） | ✅ |
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
| `autocreate_verify_llm` | **真模型**验证 LLM 判定通路（只读；⚠️ 消耗 token，手动跑） |

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

### LLM 配置（v0.4.0，默认全 off ⟹ 零行为变化）

| 键 | 默认 | 说明 |
|---|---|---|
| `llm_judge_mode` | `off` | 可标准化判定的轨道 C：`off` / `shadow`（LLM 只陪跑写审计，不改结论）/ `primary`（LLM 结论生效，轨道 B 兜底） |
| `llm_authoring_mode` | `off` | 提案撰写走 LLM：`off` / `on`。判定先通过才撰写（`llm_authoring_requires_judge`，默认 true） |
| `llm_provider` / `llm_model` | `""` | 空 = 跟随宿主默认，不硬编码任何模型名 |
| `llm_timeout_ms` | 60000 | 单次调用超时（与 AbortController 双保险） |
| `llm_daily_budget` | 20 | 每日调用硬上限（**含 shadow**，shadow 期同样花钱）；按本地日切，从当日 `llm_judge_called` 审计恢复；0 = 全禁 |
| `llm_authoring_requires_judge` | `true` | 判定说不要，就不浪费一次撰写 |

- **合成顺序**（`lib/standardizable.js`）：硬否决 5 条 → 轨道 C（LLM）→ 轨道 A（diagnosis）→ 轨道 B（启发式兜底）。LLM 与规则共用同一 `min_standardizable_confidence`。
- **LLM 只在过了 5 条硬否决的 pattern 上调用**——那五条是结构性事实，让 LLM 重判等于白付一次调用。
- **本地校验兜底**：LLM 撰写的 name/description 过宿主 SKILL_NAME 正则 + 工具链名判据 + 自我指涉检查，任一不过整条丢弃（audit `llm_authoring_rejected`）。
- **审计**：`llm_judge_called` / `llm_judge_degraded`（必带 reason）/ `llm_judge_shadow`（含 agree 分歧样本）/ `llm_budget_exhausted` / `llm_authoring_rejected`。
- **schema 约束下移**：宿主 enforced JSON Schema 子集不支持 `pattern`/`maxLength`/`minimum`（不支持会在子 agent 创建前抛错），相关约束全部在 `lib/llm-verdict.js` 本地校验执行。

## 已知边界（如实标注）

- **token 成本恒 null**：tool-stats 不记录 token，`avgTokenCost` 字段保留待其增补。
- **sessionId/turn 缺失的记录**不参与检测（宁可漏检，不可错检）。
- **可标准化判断**：默认走轨道 B 启发式（true/false/null 三态，null=需人工）；LLM 轨道 C 默认 `off`，开启后见上文 LLM 配置一节。
- **参数签名 v1**：顶层 key + 粗类型 + 扩展名；扩展名不同视为不同模式（有意为之——批量 .md 和 .js 是不同任务）。
- **预估收益是启发式**：公式集中在 `lib/proposer.js`，Sprint 15/16 实测后校准。
- **paused / 运行时 config 是内存态**：重启还原为 cordis 配置默认值（设计稿未要求持久化，刻意保持简单）。

## 测试

```sh
node --test "test/*.test.mjs" test/smoke.mjs   # 321 tests，零外部依赖可跑
```

覆盖：aggregator（聚合/签名/窗口）、detector（相似度/阈值/增量）、proposer+templates（模板选择/草稿格式/自我指涉拦截）、standardizable（双轨判定+LLM 合成顺序）、llm-verdict（mock ctx：正常/不可用/超时/schema 不合/dispose/永不抛）、llm-budget（预算/日切/恢复）、skill-authoring-llm（中文名拒/工具链名拒/合法通过/整条回落）、smoke（契约/schema/LIMITS/spec）、pipeline（mock ctx + 内存 domain + 临时 JSONL 端到端）。护栏做过变异测试（5 处护栏改坏各自变红）。

真模型验证（不进 CI，手动）：调 `autocreate_verify_llm` 工具或 `svc.verifyLlmJudge()`。

## 挂载

见 `cordis.patch.yml` 模板注释（host 行 + preset tools 行 + safe-update SOP）。cron job 已在 `agint-cron/lib/jobs.js` 注册（`skill-autocreate-aggregate`），插件未挂载时自动 soft-skip。
