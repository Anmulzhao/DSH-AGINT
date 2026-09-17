# CHANGELOG — agint-trajectory

## 0.1.1 — 2026-09-17（修复：非法 topic 连坐整批订阅）

**修复**

- **事件订阅曾整体失效**：`SUBSCRIPTIONS` 里两条预留 topic 原名 `evo-orch.task-started` /
  `evo-orch.task-completed`，**首段含连字符**，违反 event-bus 契约
  `^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$`（连字符只允许出现在第二段及之后）。
  而 `attachSubscriptions` 一次性把 6 条 topics 交给 `subscribeFn`，bus 侧
  `z.array(TopicSchema)` 是**整批**校验 —— 一条非法即整体抛错，导致 4 条合法订阅
  （`dream.completed` / `evolution.proposed` / `evolution.evaluated` / `diagnosis.completed`）
  **一并失效**：自动记录通道归零、只剩显式 `record()`。启动日志只提示
  「降级：仅显式 record()」，掩盖了其中 4 条本可恢复。

**改动**

- `lib/subscribers.js`：`evo-orch.*` → `evoorch.*`；新增 `TOPIC_RE` / `isValidTopic` /
  `partitionValidTopics`，**订阅前逐条过滤**，非法项只丢自己（`dropped` 字段回报），
  不再整批降级；`degraded` 语义细化为「部分降级」时仍带 `subscribed` 列表。
- `lib/index.js`：降级日志区分「全降级 / 部分降级」，后者列出仍生效的订阅。
- `test/event-contract.test.mjs`：补两道护栏 —— ① 每个订阅 topic 必须合法；
  ② 本地 `TOPIC_RE` 与 `agint-event-bus/lib/schemas.js` 的 `TopicSchema` 字面一致（防漂移）。
- `test/subscribers.test.mjs`：新增 `isValidTopic` 边界 / `partitionValidTopics` /
  「全合法时不整批降级」三组回归。
- 同步改 `manifest.json`（`cordis.subscribes`）、`README.md`、`cordis.patch.yml` 注释、
  `docs/plugins/agint-trajectory.md`。

**⚠️ P2-3 实施提醒**：子代理编排发布事件时**必须用 `evoorch.task-started` /
`evoorch.task-completed`**（原 `evo-orch.*` 在 publish 侧同样会被契约拒绝）。

## 0.1.0 — 2026-09-13（P2-1 实施，Sprint 18 T1–T7 + T8/T10 主体）

**新增**

- 独立存储域 `agint_trajectory`（schemaVersion 1，3 表：`trajectories` / `counters` / `calibration`）
- FROZEN 5 Service：`record` / `get` / `list` / `export` / `stats`
- 非 FROZEN：`linkAttribution` / `prune` / `setEnabled` / `setSample` / `setRecordMode` / `calibration` / `state`
- 五源记录：`task` / `dream` / `eval` / `evolution` / `subagent`
- 治理六件套：采样 / 脱敏 / 截断 / 预算 / prune / 熔断
- 事件：订阅 6 个（async，含 P2-3 未实施的 `evo-orch.*`），发布 3 个（`trajectory.recorded` / `trajectory.pruned` / `trajectory.budget-exhausted`）
- ShareGPT + JSONL 双格式导出 + 逐行自检 + sidecar 索引
- 标定期（count-only 干跑 → 报告 → 切 live 硬门禁）

**相对设计稿的实现决策（有意偏离，均已在 README 标注）**

1. **容量初值 1800 条 / 64MB**：设计稿 §7.4 要求由方程推导，但标定期未跑；
   外推值 117MB 对 dsh-storage-json 偏大，首版取护栏值，待报告出来按 `computeBudget()` 重拍。
2. **截断策略先做「保头 + 保尾丢中段」**：设计稿 §7bis.2 候选 ③ 是尾部截断、④ 是 LLM
   中段摘要。v0.3 的 Hermes 对照指出「砍尾巴 = 砍掉最终输出与结局」，故本版按最小损失
   实现保头保尾；完整中段摘要留待截断率 > 5% 时启用（需 LLM 调用）。
3. **标定期截断率用估算样本算**：否则 count-only 期 `counters.truncatedCount` 恒 0，
   不变量 #5 的切档门禁永远无法满足（死锁）。
4. **日配额只算实际落盘条数**（新增 `counters.dayPersisted`）：count-only 的计数用于
   标定日均，不应占用落盘配额。
5. **指标上报降级为事件 + counters**：`agint-metrics` 无外部 record 接口，跨域写域违反
   不变量 #1；若未来暴露 `agint.metrics.record` 会自动接上。
6. **不注册 model-visible 工具**：观察层无模型平面入口需求。
7. **prune cron 不自注册**：`agint-cron` 只有 `list()`，本版只暴露 `prune()`。

**测试**

- `test/smoke.mjs` 冒烟通过；单测 8 文件 / 60+ 用例通过
- `test/event-contract.test.mjs` 为设计稿 §十要求的静态契约测试（防「订阅虚构事件」复发）
