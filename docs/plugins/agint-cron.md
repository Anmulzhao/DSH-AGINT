# agint-cron

> 定时任务：5 字段 cron 解析 + 默认任务集 + 手动触发。

## 职责

- 提供 `agint.cron` host Service
- 提供 `cron_*` model 工具（list / run / create / remove / enable / disable）
- 依赖 `@deepseek-ai/cordis-plugin-timer` 的 tick 源
- 自带 5 字段 cron 表达式解析（`* / , - / step`）

## 内置任务（默认 seed）

| job | 表达式（UTC+8） | 触发 |
|---|---|---|
| `metrics-collect` | `17 0 * * *`（每日 00:17） | agint.metrics 采集快照 |
| `evolve-review` | `0 18 * * 0`（周日 18:00） | agint.evolve 写周复盘 |
| `night-dream` | `0 19 * * *`（每日 03:00，时区偏移） | agint.dream sweep |
| `wiki-lint` | `0 3 * * 0`（周日 03:00） | agint.wiki.lint + 写指标 |
| `memory-decay` | `0 4 * * 0`（周日 04:00） | agint.memory.forget_scan dry-run |

**AGENTS.md 红线**：改这些时间前必须 audit + 让老板确认。

## 模型接口

- `cron_list` 看全部
- `cron_run_now(id)` 手动跑一次（仅模型可见，user 触发）
- `cron_add / cron_remove / cron_set_enabled` 增删改

## 与其他插件的关系

- **`agint.metrics / dream / evolve / wiki / memory`**：都是被 cron 调度的下游
- **`agint.toolStats`**：cron 自身调用也进工具统计

## 测试

`test/cron.test.js`：5 字段解析 + 时区换算 + enable/disable。

## 文件

```
lib/index.js   Cordis apply()：timer + job registry
lib/cron.js    5 字段表达式解析（pure）
lib/jobs.js    内置 job 注册
lib/tools.js   cron_* model 工具
test/cron.test.js
```