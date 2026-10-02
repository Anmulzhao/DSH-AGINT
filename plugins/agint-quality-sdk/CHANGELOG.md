# Changelog — agint-quality-sdk

> 本文件此前缺失（manifest 声明了 `CHANGELOG.md` 但文件不存在），2026-10-02 补建。
> 条目来源：`git log -- plugins/agint-quality-sdk`，只记录有提交可查的变更。

## 0.5.0

### Fixed

- **存量 eval fail 归因收口 + Windows 可移植性修复**（2026-09-09 `e54bb04`）：
  12 个存量 eval fail 100% 归因完成，归因报告见
  `docs/operations/eval-fail-attribution-20260909.md`；同时修掉 Windows 路径相关问题。

### Added

- **Sprint 6.1：cron job prompt-static-check + 批量 Static-check**
  （2026-08-21 `c64dd9c`）—— D-QAF 流水线接入 1/3。
- **Sprint 5.1-5.3：Prompt SDK @0.5.0**（2026-08-21 `88bd2be`）——
  manifest schema + 模板引擎 + static-check + CLI + 3 个示例 preset 一并落地。
- **补 manifest.json**（2026-09-07 `6101540`）。

## 说明：本插件没有 smoke 测试入口

manifest **不声明** `spec.tests.entry` —— 该插件是分发型 SDK
（目录构成为 `README.md` / `bin/` / `examples/` / `lib/`，无 `test/` 目录），
验证方式是 `examples/` 下的示例脚本而非 smoke 测试。

此前它声明了 `test/smoke.mjs`（该文件并不存在）。这比不声明更糟：
`bin/check-wiring.mjs` 查 I 会拿着这个入口去跑，一旦该插件进入漂移集合，
保护要么静默跳过、要么报「入口不存在」。故 2026-10-02 删除该声明，
并在 `docs/manifest-declared-file-exemptions.json` 登记豁免（带理由与反转条件）。

**反转条件**：若将来新增 `test/` 目录并落地可执行 smoke，删除豁免、恢复声明。
