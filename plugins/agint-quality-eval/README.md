# agint-quality-eval (Sprint 12 A1)

AGINT D-QAF 评估引擎（5 维 + safety 硬门控）。代码实现在 `plugins/agint-quality/agint-quality-eval/`（monorepo 形式），本目录为 plugin-check 入口。

## Sprint 12 A1（影子订阅 —— ⚠️ 上游未接线，当前收不到消息）

- 订阅 `agint.eventBus` 的 `evolution.proposed` 主题（`mode: async`）
- Handler 把 proposal 写入内部 `shadowProposals` ring（仅 host 可见，不进 model 工具）
- **直连路径完整保留**：`evaluator.runNow()` / `runBaselineSuite()` 等原有方法不变
- 软降级：bus 不可用 → 静默跳过，不报错

> ⚠️ **实测状态（2026-09-20）**：本订阅的**上游从未接线** ——
> `evolution.proposed` 的生产发布方 `agint.population.publishProposed`
> **生产调用点为 0**（全库唯一调用者在 `eval/scenarios/driver.js` 测试里），
> 生产数据仅 3 条且均为 09-04 的探针消息。
> **即：下面的 handler 与 `shadowProposals` ring 至今未被真实事件触发过。**
> 详见 `docs/known-limitations/event-bus-shadow-publish-gap.md`。
> 本文档原「T1 影子期」措辞已废弃 —— 它掩盖了「连发布都没接上」这一事实。

详细说明见 monorepo 内 README。
