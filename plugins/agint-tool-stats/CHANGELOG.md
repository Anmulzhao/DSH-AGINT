# Changelog — agint-tool-stats

> 本文件此前缺失（manifest 声明了 `CHANGELOG.md` 但文件不存在），2026-10-02 补建。
> 条目来源：`git log -- plugins/agint-tool-stats`，只记录有提交可查的变更。

## 0.3.0 (2026-11-12) — 参数指纹化 + 保留机制（30 天明细 + 周 rollup）

### Added

- **`storeArgs` 配置（默认 `false`）** —— 不再把 args 原文写进 JSONL。
  `false` 时每行写 `argFingerprint` / `argsHash`（本来就有）+ **新增**
  `argsBytes`（原 args JSON 字节数）/ `argsPreview`（原 args JSON 前 120 字符，
  超出截断），**不写 `args` 字段**；`true` 时行为与 0.2.0 完全一致（回退开关）。
- **`agint.toolStats.prune({ maxAgeDays = 30, dryRun = false })`** —— 保留机制：
  删 `ts` 早于 30 天的明细行，**先按「工具 × 周」rollup 再删**，rollup 写进同目录
  `agint_tool_stats_rollup.jsonl`（一行一周一工具，不带 args）。
  返回 `{ removed, freedBytes, rolled, dryRun, applied, kept, maxAgeDays, cutoff }`。
- **`lib/prune.js`** —— prune + rollup 的口径只在该文件定义一次（周口径 = UTC 周一
  00:00；p95 = 升序取 `min(n-1, floor(n*0.95))`，与 `aggregate.js` 同口径）。
- **`toolStats.pruned` 事件** —— prune 落地后经 `ctx.get('agint.eventBus.publish')`
  发布，payload `{ removed, freedBytes }`；总线缺席/抛错 ⇒ 静默跳过（不抛错）。
- **`test/smoke.mjs`** —— 新增 smoke 入口（13 个用例）：参数指纹化 ① ②、
  prune ③、dryRun ④、读侧降级 ⑤、apply 级配置通路 ⑥ ⑦。

### Changed

- **读侧优雅降级** —— `repeatPatterns()` 在记录没有 `args` 时返回
  `sampleArgs: undefined` + `argsUnavailable: true`，`suggestedSkillName` 降级为
  `${tool}-pattern`；**不抛错**。
- `summarize()` / `slowest()` / `failureRate()` / `timeseries()` 经逐字段核对
  **完全不读 `args`**（只用 `ts` / `tool` / `ok` / `latencyMs`）⇒ 指纹化对统计口径零影响。

### 不变（明确承诺）

- **存量行不回填改写**：已落盘的旧行仍带 `args`，prune / backfill 都不改它们
  （改写等于毁证）。同一份文件里新旧两种形态并存是常态。
- **30 天内的行不被 prune 触碰**（原样保留，含旧行的 args 原文）。

### 依据（生产实测）

明细文件 7.9 MB / 7331 行，**args 正文占全文件 84%**（bash 1.94 MB / 4210 次，
edit 653 KB / 545 次，write 646 KB / 136 次）；而每行**已经**带
`argFingerprint`(sha256) + `argsHash` ⇒ 正文对统计口径零增量，纯体积 + 明文负担。

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
