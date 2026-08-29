# agint-quality-report (Sprint 12 A5)

AGINT D-QAF Phase 4 报告生成插件（`generate({results, decision, meta?}) → {markdown, json}`，可选写入 `agint.wiki` + `agint.memory`）。代码实现在 `plugins/agint-quality/agint-quality-report/`（monorepo 形式），本目录为 plugin-check 入口。

## Sprint 12 A5

- 顶层 stub 补建：`manifest.json` / `package.json` / `CHANGELOG.md` / `test/smoke.mjs`（准入补齐，与 `agint-quality-eval` 顶层结构对齐）
- 影子订阅 `agint.eventBus` 的 `policy.deployed` / `policy.rolledback` 主题
- 软降级：bus 不可用 → 静默跳过
- **直连路径完整保留**：`generate()` / `generateAndPersist()` 不变

详细说明见 monorepo 内 README。
