# agint-metrics

> 进化指标：客观可度量的进化信号，按 kv 时间序列写。

## 职责

- 提供 `agint.metrics` host Service
- 提供 `metrics_*` model 工具（collect / summary / series）
- 独占 `agint_metrics` storage domain
- 每日由 `cron.metrics-collect` 触发

## 指标清单（v0）

| key | 来源 | delta 含义 |
|---|---|---|
| `cron.staleJobs` | agint.cron | + = 任务变陈旧 |
| `cron.overdue` | agint.cron | + = 错过的窗口 |
| `rules.adherencePct` | agint.rules | - = 改善 |
| `rules.denyHits` | agint.rules | + = 命中变多（不一定坏） |
| `wiki.brokenLinks` | agint.wiki | + = 变坏 |
| `wiki.orphans` | agint.wiki | + = 变坏 |
| `memory.bloat` | agint.memory | + = 膨胀 |
| `memory.coverage` | agint.memory | - = 变坏 |
| `dream.sweepCount` | agint.dream | 健康度信号 |
| `dream.promotedCount` | agint.dream | 学习量信号 |
| `tools.usageTotal` | agint.toolStats | 活跃度 |

## 采集策略

- 懒解析：metrics_collect 不依赖任何一个 plugin；缺失源跳过
- 写 kv 时间序列：每个 key 每天一行
- delta = 最新值 - 上一次值

## 模型接口

- `metrics_collect` 跑一次快照（写入 storage）
- `metrics_summary` 看最新值 + delta
- `metrics_series <key> --days 30` 看趋势

## 与其他插件的关系

- **`agint.cron`**：metrics-collect job 每日触发
- **`agint.evolve`**：复盘报告引用 metrics 数据
- **所有插件**：metrics 从它们的 Service 懒读取

## 测试

`test/metrics.test.js`：delta 计算 + series 序列化。

## 文件

```
lib/index.js    Cordis apply()：注册 agint.metrics + 收集器
lib/metrics.js  指标定义 + 懒采集逻辑
lib/tools.js    metrics_* model 工具
test/metrics.test.js
```