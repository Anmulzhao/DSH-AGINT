# CHANGELOG

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)；破环性变更在顶部标注 (BREAKING)。

## [0.2.1] — Sprint 16 发布层 cron（2026-09-09）

### Added
- 新增 cron job `skill-autocreate-release`（daily 05:15）：调 agint.skillAutocreate.releaseQueue()，三道门自动发布队列检查（人工确认窗内全部被拦，拍板 2 语义）。
- 新增 cron job `skill-autocreate-observe`（daily 05:30）：调 agint.skillAutocreate.observe()，观察期 STABLE / 0 调用自动回滚 / 展期判定。
- 两 job 均在 skill-autocreate-aggregate(04:45) 之后；插件未挂载时 soft-skip。

## [0.2.0] — Sprint 12 B3 baseline-regression 真 cron hook

### Added
- 新增 cron job `baseline-regression-suite`：周节奏 Sun 03:15（夹在 wiki-lint 03:00 与 evolve-review 03:45 之间），调 `agint.evolve.recordBaselineRun({channel:'mount', passRate:1.0, passed:0, total:0, source:'cron:baseline-regression-suite'})`。
- **不动** `metrics-collect` / `evolve-review` / `night-dream` / `quality-eval-weekly` 4 个被 AGENTS.md §边界 锁的 cron（保持时间表与 action 不变）。
- 默认 job 列表：8 个（memory-decay / wiki-lint / metrics-collect / evolve-review / night-dream / tool-stats-backfill / prompt-static-check / baseline-regression-suite）。

### Notes
- 当前以"占位行"语义写 `baseline_history`（passRate=1.0、passed=0、total=0）；真实 passRate 由 Sprint 13 B4 接入回归 runner 注入（design Sprint12 §B3）。
- 完整测试入口：`eval/run-baseline-regression.mjs`（不通过 cron action，直接 import 真 plugin apply + recordBaselineRun）。

## [Unreleased]

### Added
- 新增 cron job `curriculum-weekly`（P7 自主课程生成器，Sprint 14 Part B）：**Sun 05:00**（老板拍板），排在周日全家桶（curator 02:00 / wiki-lint 03:00 / baseline-regression 03:15 / evolve-review 03:45）之后。流程：`agint.curriculum.probe()` 找待练域（UNCERTAIN / 校准失准 / CAN 超期未复验）→ 逐域 `generate({count:1})`（自带同域 24h 冷却 + 无模板域诚实留白）。挑战生成后**不自动执行**（P7 §4.5），由 agent 用 `curriculum_next` 领取。插件未挂载 / paused 时 soft-skip，不报错。
- `index.js` services map 增补 `agint.curriculum`（与既有 `agint.curator` 同款懒解析）。

### Added（前次）
- 新增 cron job `curator-weekly`（P0-2 技能策展，Sprint 14）：Sun 02:00，调 `agint.curator.run({trigger:'cron:curator-weekly'})`。刻意排在 `evolve-review`（03:45）**之前**，让周复盘能吃到本周策展报告。插件未挂载时 soft-skip，不报错。
  - 时间说明：Sprint14 设计稿 §3.5 写「周日 05:00」与其自述的「在 evolve-review 之前」互相矛盾（05:00 晚于 03:45），按后者 + P0-2 §8.1 默认 `0 2 * * 0` 取 02:00。
- `index.js` services map 增补 `agint.curator`（与既有 `agint.skillAutocreate` 同款懒解析）。
- 默认 job 列表：10 个（新增 `skill-autocreate-aggregate` / `curator-weekly`）。
- 持久化每个 cron job 的 `lastRunAt` / `lastResult` / `lastError` 到独立的 `agint_cron` storage domain（`cron_state` 表）。host 进程重启后 `cron_list` 能恢复真实的 last-run 时间戳，而不是显示 `never`（与 agint-dream 修复 lastSweep 同类问题）。存储域打开失败时降级为内存-only，不阻塞调度。
- `manifest.json`：按 PLUGIN-SPEC 8 维声明 injection（`timer` + `storageDomain`）、provides（`agint.cron`）、storage domain（`agint_cron`）与生命周期。
- `README.md`、`test/smoke.mjs`：补齐插件准入维度 7（docs）与维度 6（tests）。

## [0.1.0]

### Added
- 基于 `cordis-plugin-timer` 的 5 字段 cron 调度 host Service（`agint.cron`），60 秒 tick + per-job mutex 防重叠。
- 默认 job：memory-decay / wiki-lint / metrics-collect / evolve-review / night-dream / tool-stats-backfill / prompt-static-check。
- preset 侧工具：`cron_list` / `cron_run_now` / `cron_health`。
