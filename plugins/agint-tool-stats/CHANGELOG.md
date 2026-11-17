# Changelog — agint-tool-stats

> 本文件此前缺失（manifest 声明了 `CHANGELOG.md` 但文件不存在），2026-10-02 补建。
> 条目来源：`git log -- plugins/agint-tool-stats`，只记录有提交可查的变更。

## 0.2.0 (2026-10-26) — D2 收口：资源窗口聚合（给「有效进化增量」供料）

### Added

- **`toolStats.resourceWindow({ days, offsetDays, nowMs })`** —— 时间窗内的资源读数：
  任务数 / 完成任务数 / 完成率 / 步数 / 耗时 / token 求和 + **token 覆盖率**。
  窗口语义 `[now-(offsetDays+days), now-offsetDays)`，左闭右开。
- **`lib/resource-window.js`** —— 纯函数 `summarizeResourceWindow()` + `taskKeyOf()`，
  口径只在文件头定义一次：
  - 任务 = `(sessionId, turn)`；缺一半的记录**计步数、不计任务**（不可归属就不猜）
  - 完成任务 = 组内**全部** ok（与 curator / skill-autocreate 的 `groupTaskCalls` 同构）
  - token 只累加**测得**值；`null`（没测）与 `0`（测得零）严格分开，并给出覆盖率
- 测试 `test/resource-window.test.mjs`（9 条，含 3 条阴性对照）。

### 为什么（背景）

D-QAF §5.2 的有效进化增量 = Δ完成率 / Δ(token + 步数 + 时间)，其中 token 项
自 v0.1.0 起恒缺（`docs/capability-boundary.md` §4 F3）⇒ 公式算不出来 ⇒
「无效进化拒绝部署」这条宪法约束从未生效。窗口读数由 tool-stats 出是刻意的：
JSONL 字段与口径是本插件的契约，让下游自己解析文件会让同一口径出现两份实现。

## 0.1.0

### Fixed

- **数组字段去掉 `required`**（2026-09-20 `062b1b5`）：tool output schema 里
  数组字段带 `required` 不合法，导致校验失败。

### Changed

- **会话解析改走中立提取器**（2026-09-17 `3bdd453`，随 skill-autocreate Phase 0/1/2 落地）：
  双格式（v3 / jsonl）+ 去重。**修了 backfill 只认 `session.jsonl.zstd`、
  漏读全部 v3 会话的历史 bug** —— 该 bug 会让工具画像持续偏小而不报错。

### Added

- **补 manifest.json**（2026-09-07 `6101540`）：此前该插件无 manifest，
  `install.sh` 的 manifest 同步校验与 `plugin-check` 对它失明。

## 初始

- 2026-08-18 `319e87f` — `feat(v0.1.1)`: D-QAF evaluation contract + integration patches。
- 2026-08-17 `bc28ee8` — `feat(v0.1)`: AGINT 自演化框架首发。
