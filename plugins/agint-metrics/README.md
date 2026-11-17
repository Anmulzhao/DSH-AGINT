# agint-metrics (Sprint 12 A5)

AGINT evolution metrics host 服务（`agint.metrics`）：每日 `metrics-collect` cron 触发 `collect()`，把盲区/规则遵守/wiki/记忆等指标写入 `agint_metrics` 存储域（kv 时间序列）。`summary()` 返回每项最新值 + 与上次的 delta。`tools.js` 暴露 `metrics_summary` / `metrics_series` 给 model 平面。代码实现在 `plugins/agint-metrics/lib/`。

## Sprint 12 A5

- 顶层 stub 补建：`manifest.json` / `CHANGELOG.md` / `test/smoke.mjs`（准入补齐，与 `agint-quality-report` 顶层结构对齐）
- 影子订阅 `agint.eventBus` 的 `policy.deployed` / `policy.rolledback` 主题，写 `policy.deployedCount` / `policy.rolledbackCount` 计数（已实装在 `policyCounters.js`）
- **直连路径完整保留**：`collect()` / `summary()` / `computeMetrics()` 不变

## cron 失效两维度（v1.2.0 起，提案 cdf41d63）

| key | 口径 | 备注 |
|---|---|---|
| `cron.staleOverdue` | 过期未跑 | 源 `agint.cron.health().staleOverdue`；宿主旧版本回落 `issues` |
| `cron.staleInactive` | 久未活动（> 2 个调度周期） | 源 `agint.cron.health().staleInactive` |
| `cron.staleJobs` | ⛔ **已弃用** —— 上面两者的并集（按 id 去重） | 只为旧看板兜底，别用它判趋势 |

为什么拆：`cron.staleJobs` 单一口径是悬崖阈值，series 里同一分钟出现过 7 和 3 两个值，
delta 失去意义。拆开后每次变化都能归因到具体成因。

注意口径变了：汇总值从「单一过期计数」变成「两维度并集」，可能比历史值大 1~2
（「从未运行」的 job 只进久未活动维度）。判趋势请用两个新 key。
