# Changelog — agint-quality-eval

## 0.3.0 (2026-08-29) — Sprint 12 / A2 evolution.evaluated 发布
## 0.3.1 (2026-09-28) — 行动 #5 权重外置可配置

### Added

- 新增 `lib/weights.js`：
  - `DEFAULT_DIMENSION_WEIGHTS`：内置权重表快照（单一事实源）。
  - `WEIGHT_KEYS` / `WEIGHTS_SCHEMA`：8 键权重 schema。
  - `validateWeights(patch)`：未知键 / 越界（非 0..1）/ 非数字 → invalid（含原因）。
  - `resolveWeights(patch)`：partial 覆盖内置默认；非法 patch **回退默认 + issues，不抛**。
  - `mergedWeights(patch)`：快捷合并。
- `compositeScore(evalResult, weights = DIMENSION_WEIGHTS)`：权重注入（缺省向后兼容）。
- Config 新增 `dimensionWeights`（zod partial，键 0..1 可选）。
- `evaluator.weights` 从手写硬编码改为单一事实源 `{ ...resolvedWeights.weights }`（消除与
  evaluators.js 的重复漂移）。
- `score()` / `currentSnapshot()` / `runBaselineSuite()` 均按配置权重计分。
- 新增服务面 `agint.qualityEvaluator.weights`：`{ get, validate, resolve, defaults }`。

### Compatibility

- 默认权重不变（trust .20 / reliability .20 / effectiveness .10 / safety .30 / integrability .20 / promptStatic .20 / convention 0 / adaptability 0）。
- safety 一票否决（<0.5 → composite null）不受权重配置影响。
- 非法 `dimensionWeights` → console.warn + 回退默认，评估主路径不受影响。

### 验证

- `test/weights.test.mjs` 14/14；quality-eval 全套 25/25。


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
