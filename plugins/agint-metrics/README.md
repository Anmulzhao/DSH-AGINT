# agint-metrics (Sprint 12 A5)

AGINT evolution metrics host 服务（`agint.metrics`）：每日 `metrics-collect` cron 触发 `collect()`，把盲区/规则遵守/wiki/记忆等指标写入 `agint_metrics` 存储域（kv 时间序列）。`summary()` 返回每项最新值 + 与上次的 delta。`tools.js` 暴露 `metrics_summary` / `metrics_series` 给 model 平面。代码实现在 `plugins/agint-metrics/lib/`。

## Sprint 12 A5

- 顶层 stub 补建：`manifest.json` / `CHANGELOG.md` / `test/smoke.mjs`（准入补齐，与 `agint-quality-report` 顶层结构对齐）
- 影子订阅 `agint.eventBus` 的 `policy.deployed` / `policy.rolledback` 主题，写 `policy.deployedCount` / `policy.rolledbackCount` 计数（已实装在 `policyCounters.js`）
- **直连路径完整保留**：`collect()` / `summary()` / `computeMetrics()` 不变
