# CHANGELOG

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)；破环性变更在顶部标注 (BREAKING)。

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
- 持久化每个 cron job 的 `lastRunAt` / `lastResult` / `lastError` 到独立的 `agint_cron` storage domain（`cron_state` 表）。host 进程重启后 `cron_list` 能恢复真实的 last-run 时间戳，而不是显示 `never`（与 agint-dream 修复 lastSweep 同类问题）。存储域打开失败时降级为内存-only，不阻塞调度。
- `manifest.json`：按 PLUGIN-SPEC 8 维声明 injection（`timer` + `storageDomain`）、provides（`agint.cron`）、storage domain（`agint_cron`）与生命周期。
- `README.md`、`test/smoke.mjs`：补齐插件准入维度 7（docs）与维度 6（tests）。

## [0.1.0]

### Added
- 基于 `cordis-plugin-timer` 的 5 字段 cron 调度 host Service（`agint.cron`），60 秒 tick + per-job mutex 防重叠。
- 默认 job：memory-decay / wiki-lint / metrics-collect / evolve-review / night-dream / tool-stats-backfill / prompt-static-check。
- preset 侧工具：`cron_list` / `cron_run_now` / `cron_health`。
