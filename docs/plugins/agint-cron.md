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
| `quality-eval-weekly` | `30 4 * * 0`（周日 04:30） | agint.qualityEvaluator 批量评估所有 AGINT Skills + Plugins（v0.2 起） |

**AGENTS.md 红线**：改这些时间前必须 audit + 让老板确认。

## 进化健康度联动（v0.2 起）

`agint-cron` 在每次 `quality-eval-weekly` 触发后调用 `agint.metrics` 写：
- `quality.evaluatedCount`：本周评估任务数
- `quality.harm`：综合 HARM 趋势（HARM 公式见 `docs/evolution-framework.md` 第三章）

`agint-evolve` 周复盘时读这些指标，写入护栏报告（详见 `路线图` 节奏章节）。

**自动部署上限**：每周自动部署 ≤ 3 次（进化健康度护栏之一），超限必须人工审核。

## 模型接口

- `cron_list` 看全部
- `cron_run_now(id)` 手动跑一次（仅模型可见，user 触发）
- `cron_add / cron_remove / cron_set_enabled` 增删改

## 与其他插件的关系

- **`agint.metrics / dream / evolve / wiki / memory / qualityEvaluator`**：都是被 cron 调度的下游
- **`agint.toolStats`**：cron 自身调用也进工具统计

## 测试

`test/cron.test.js`：5 字段解析 + 时区换算 + enable/disable。

## 宿主 schedule 桥（v0.2.2，行动 #2，2026-09-28）

`lib/host-schedule.js` 桥接宿主 `@deepseek-ai/dsh-schedule`（0.1.7-rc.2，宿主已带）：

- 全部 job 用宿主 `canonicalizeCronExpression` 校验（非法表达式在桥层即暴露，不等到触发）。
- catalog 只读镜像：宿主 schedule 存储只读访问，AGINT 不写宿主存储。
- 懒加载：首次访问才 import 宿主包；宿主缺失时降级 `hostAvailable:false`，既有 cron 行为不变。
- **有意不调用宿主 `create()`**：宿主投递语义是"提醒注入 agent session"，与 cron 的 action 直调不同，投递策略留待拍板。

Service 面新增只读 `agint.cron.hostSchedule` → `{ hostAvailable, jobs, hostPackage }`。

对应《三仓库对比分析报告_20260928.md》§7.1 行动 #2。

## 文件

```
lib/index.js   Cordis apply()：timer + job registry
lib/cron.js    5 字段表达式解析（pure）
lib/jobs.js    内置 job 注册
lib/tools.js   cron_* model 工具
test/cron.test.js
```
