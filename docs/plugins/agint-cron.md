# agint-cron

> 定时任务：5 字段 cron 解析 + 默认任务集 + 手动触发。

## 职责

- 提供 `agint.cron` host Service
- 提供 `cron_*` model 工具：`cron_list` / `cron_run_now` / `cron_health`
  （**没有** add / remove / enable / disable —— 任务集是 `lib/jobs.js` 里的静态表）
- 依赖 `@deepseek-ai/cordis-plugin-timer` 的 tick 源
- 自带 5 字段 cron 表达式解析（`* / , - / step`）

## 内置任务（19 个，`lib/jobs.js` 的 `defaultJobs`）

排期于 **2026-09-28 全体重排**（去周日单点 + 解 2 组同分钟撞车）。完整表与
「为什么是这个点」见 [`plugins/agint-cron/README.md`](../../plugins/agint-cron/README.md)，
排期原则与操作步骤见 [`../operations/cron-schedule-principles.md`](../operations/cron-schedule-principles.md)。

| 时刻 | job | 频率 |
|---|---|---|
| Mon 02:30 | memory-decay | weekly |
| daily 03:00 | night-dream | daily |
| daily 04:00 | metrics-collect | daily |
| daily 04:30 | tool-stats-backfill | daily |
| daily 04:45 | prompt-static-check | daily |
| daily 05:15 | skill-autocreate-aggregate | daily |
| daily 05:45 | skill-autocreate-release | daily |
| daily 06:15 | skill-autocreate-observe | daily |
| Mon 07:00 | curator-weekly | weekly |
| Mon 07:30 | evolve-review | weekly |
| Mon 08:00 | oracle-weekly | weekly |
| Mon 09:30 | wiki-lint | weekly |
| Tue 07:00 | evolution-cycle | weekly |
| Tue 09:30 | baseline-regression-suite | weekly |
| Thu 09:30 | curriculum-weekly | weekly |
| Fri 09:30 | skill-graph-weekly | weekly |
| daily 09:00 | oracle-daily | daily |
| 每月 1 日 10:00 | oracle-monthly | monthly |
| 每 30 分钟 | diagnosis-watchdog | high-freq |

**红线（已自动化）**：改排期前必须跑 `node --test plugins/agint-cron/test/schedule-layout.test.mjs`，
并把「为什么是这个点」写进 `lib/jobs.js` 的时机注释。原则违反 = 测试红。
⚠️ 改完**必须重启 dsh** 才生效（boot 期插件，热重载不覆盖）。

## 模型接口

- `cron_list` 看全部（schedule / lastRunAt / nextRunAt / lastOk / lastResultSummary）
- `cron_run_now(id)` 手动跑一次（回写 `lastRunAt`，不用改 schedule、不用重启）
- `cron_health` 看逾期 job 与错过窗口

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
