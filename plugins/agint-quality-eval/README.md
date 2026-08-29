# agint-quality-eval (Sprint 12 A1)

AGINT D-QAF 评估引擎（5 维 + safety 硬门控）。代码实现在 `plugins/agint-quality/agint-quality-eval/`（monorepo 形式），本目录为 plugin-check 入口。

## Sprint 12 A1（T1 影子期）

- 订阅 `agint.eventBus` 的 `evolution.proposed` 主题（`mode: async`）
- Handler 把 proposal 写入内部 `shadowProposals` ring（仅 host 可见，不进 model 工具）
- **直连路径完整保留**：`evaluator.runNow()` / `runBaselineSuite()` 等原有方法不变
- 软降级：bus 不可用 → 静默跳过，不报错

详细说明见 monorepo 内 README。
