# agint-evolve

智进 (`agint`) 自进化环：周复盘报告写入 + proposal 追踪 + baseline-regression gate 读取。

## Storage

- 域：`agint_evolve`，schemaVersion：`2`
- 表：
  - `proposal` —— 改进提案
  - `baseline_history` —— Sprint 12 B3 新增，由 `agint-cron` 的 `baseline-regression-suite` 写入

## Services

- `agint.evolve.dataSnapshot` —— 采集 memory / wiki / cron / rules / metrics / sessionQuery 快照
- `agint.evolve.writeReview` —— 写 `reviews/<date>-周复盘.md`
- `agint.evolve.listReviews` —— 列出 reviews/ 文件
- `agint.evolve.readReview` —— 读指定报告
- `agint.evolve.propose` —— 写入一条 proposal
- `agint.evolve.listProposals` —— 按 status/category 过滤
- `agint.evolve.getProposal` —— 读单条
- `agint.evolve.setStatus` —— 更新状态
- `agint.evolve.removeProposal` —— 删除
- `agint.evolve.stats` —— proposal 计数
- `agint.evolve.baselineGate(channel, opts)` —— **Sprint 12 B3**：返回上一周期 `{frozen, lastRunAt, since, source}`
- `agint.evolve.recordBaselineRun(input)` —— **Sprint 12 B3**：写一行 `baseline_history`
- `agint.evolve.listBaselineHistory(filter)` —— **Sprint 12 B3**：调试 / 报告用

## Tools (model plane)

- `evolve_read` / `evolve_propose` / `evolve_set_status` / `evolve_proposals`

## 配对

- `plugins/agint-cron` 周节奏任务 `baseline-regression-suite` 调 `recordBaselineRun`
- `eval/scenarios/driver.js` mount dispatcher 调 `baselineGate('mount')` 判定通道 frozen

## 兼容性

- v0.1.0 起的 proposal / review 行为不变
- storage schema v1 → v2 兼容升级（旧 proposal 数据继续可读）
