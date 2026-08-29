# Changelog — agint-quality-eval

## 0.3.0 (2026-08-29) — Sprint 12 / A2 evolution.evaluated 发布

### Added

- **evolution.evaluated 边事件发布**（per Sprint12 设计稿 §A3，唯一 sync 门禁边的发布方）：
  - `score(evalResult)` 出口 await publish({topic:'evolution.evaluated', version:1, source:'agint-quality-eval', payload:{targetId, decision, scores, findings}})
  - payload 子 schema v1：schemas/evolution-evaluated.schema.yaml（不冻结，正交演进）
  - 缺 agint.eventBus.publish → 软降级（不抛错，保留原 composite return）
  - publish 失败 → log error，不阻断评分主路径
- **manifest optionalInject**：`['agint.eventBus.publish']`（软依赖；事件总线缺失时静默跳过）
- **dependencies 增列** `agint-event-bus: ">=0.7.0"`
- **新增 `test/smoke.mjs`**（PLUGIN-SPEC 维度 6）：冒烟加载 + compositeScore 纯函数断言
- **新增 manifest.json**（PLUGIN-SPEC 维度 1）

### Compatibility

- L0-frozen 接口签名（QualityEvaluator / QualityEvaluatorIface.evaluate）未触动
- compositeScore 数值 / 一票否决语义不变
- 不评估自己（递归陷阱）；self 在 evaluateAll 排除
- 缺事件总线时评分主路径完全等价于 v0.2.0

## 0.2.0 (2026-08-21) — 初版

- D-QAF 评估引擎：7 维评分 + safety 一票否决 + 反自评
