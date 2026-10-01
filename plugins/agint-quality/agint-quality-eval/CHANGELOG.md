# Changelog — agint-quality-eval

## 0.3.3 (2026-10-01) — 注入声明与运行时对齐：评估池取数改目录扫描

### Fixed

- **0.3.2 的修复不完整**：它只在 manifest.json 声明层补了 `skills`，但
  1. `'skills'` 根本不是 cordis 服务——dsh 全仓（host 本体 + @deepseek-ai/* 插件集）
     没有任何 `set('skills')` 注册方。运行时等待一个永不存在的服务，插件会永久
     pending（PLUGIN-SPEC §1），比评估池恒空更糟。
  2. manifest 是纸面契约（plugin-check 层），cordis 运行时读的是 lib/index.js 导出的
     `inject` 数组——那里面没有 `skills`，`ctx.get('skills')` 照旧恒 undefined。
- `enumerateTargets()` 改为**技能目录扫描**（口径同 agint-curator v0.2.1 的
  `skills_dir` 多根）：默认扫 `$DSH_HOME/skills`（投放位）+
  `$DSH_HOME/.agent-presets/agint/skills`（手工位），子目录含 SKILL.md 视为技能，
  name 取 frontmatter `name`、缺省用目录名，多根按 name 去重（声明顺序在前者优先）。
  可用 config `skillsDirs` 覆盖（zod optional string[]）。
- 运行时 `inject` 导出与 manifest `spec.cordis.inject` 收敛为同一份事实：
  `['timer', 'agint.evolution', 'agint.qualitySandbox']`——全部是真实存在的服务。
  `optionalInject` 补 `agint.eventBus.subscribe`（lib:subscribe 软获取早已存在，声明缺失）。
- manifest 移除 `'agint.quality'`：代码从未 `ctx.get('agint.quality')`，属多写的契约。

### Impact

- 评估目标从「恒 0」（ctx.get('skills') 恒 undefined）恢复为枚举本机技能根下名字含
  `agint` 的技能（本机命中 `agint-install-bootstrap-rescue`）。
- 目标产出形态保持 `{ id, kind: 'skill', version: '0.0.0' }`——不带 `path`，
  不触发 sandbox gate；**只恢复取数能力，不扩大评估行为面**（0.3.2 原则沿用）。

## 0.3.2 (2026-10-01) — 修复评估池恒空：manifest 漏声明 `skills` 注入

> ⚠️ 0.3.3 勘误：本条目「修复后」段落的取数链路（`skills.list()`）实际不可达——
> `'skills'` 非 cordis 服务，且 manifest 声明不被运行时读取。真正的修复见 0.3.3。
> 本条目对「症状」（评估池恒空 / evolution_log 零记录）的诊断仍然有效。

### Fixed

- `manifest.json` 的 `spec.cordis.inject` 补上 `skills`。`lib/index.js` 的 `enumerateTargets()`
  一直调用 `ctx.get('skills')`，但 `skills` 从未出现在 `inject` 列表里。按 PLUGIN-SPEC §1
  「缺 `inject`：硬依赖会永远 pending，调度不起来」，`ctx.get('skills')` 恒为 `undefined`，
  函数在 `if (skills && typeof skills.list === 'function')` 处整段跳过，评估目标数组恒为空，
  `runWeekly()` 走 early return 返回 `{ evaluated: 0, persisted: 0, loggedToEvo: 0,
  baseline: null, stagnation: null }` —— **调用成功、产出恒 0、且不报错**。

### Impact

- 修复前：`quality_eval_run_now` 与 weekly scheduler 一律 `evaluated=0`，`evolution_log`
  30 天零记录（D-QAF 形同虚设）。
- 修复后：评估目标取自 `skills.list()`，经 `name.toLowerCase().includes('agint')` 过滤后
  命中 `agint-install-bootstrap-rescue`。
- **枚举口径本身未改** —— 仍只评名字含 `agint` 的技能。本次只恢复取数能力，不扩大评估范围。

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
