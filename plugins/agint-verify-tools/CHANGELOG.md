# Changelog — agint-verify-tools

## 0.1.0 (2026-10-21) — 初版：把 AGINT 验证入口注册为全局工具

**解决的问题**：AGINT 的 cron / self-model 工具只在 `agint` preset 的 25 个工具行里。
会话实际可能跑在其他 preset（本机实测被切到 `cordis`）⇒ 工具一个都不出现 ⇒
验证一次修复必须等一个 cron 周期。

**为什么不用「覆盖 preset-cordis」**：那是第一版做法，整段替换 `config.plugins`。
`dsh-app-boot/lib/index.js:104-106` 的 `target[key] = value` 是整体赋值、不深合并
⇒ 官方升级后新增插件被冻结快照挡住不再出现；官方改名还会导致 preset 起不来。

**做法**：host 平面 `ctx.tools.register` ⇒ 进 global 层（`dsh-scope/lib/index.js:189-195`
的 `if (scope === void 0) layer = this.global`）⇒ 每个 preset 可见。
先例：同层 `agint-tool-stats` 的 `tool_stats_summary`。

**注册 8 个工具**：`cron_list` / `cron_run_now` / `cron_health` /
`selfModel_snapshot` / `selfModel_update` / `selfModel_calibrate` /
`selfModel_stats` / `selfModel_inspectSummary`。全部只转调 host 服务，不复制 schema。

**测试**：`test/register.test.mjs` 8 用例，含一条反向自证。
红绿自证已做（撤掉 `cron_health` 的注册 ⇒ 2 条精确变红，还原后 8/8 绿）。
