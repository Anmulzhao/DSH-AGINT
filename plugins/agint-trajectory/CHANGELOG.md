# CHANGELOG — agint-trajectory

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
