# Changelog — agint-quality-eval

## 0.4.0 (2026-10-26) — D-QAF §5.3 有效进化增量（token 项首次可算）

### Added

- **`agint.qualityEvaluator.effectiveDelta({ windowDays, minTokenCoverage })`** ——
  有效进化增量 = Δ任务完成率 / Δ(token + 步数 + 耗时)，数据源是
  `agint.toolStats.resourceWindow()` 的**相邻两窗**（当期 vs 上一周期，同天数同口径）。
- **`lib/effectiveDelta.js`** —— 纯函数判定 + 三种 verdict：
  `effective` / `ineffective`（⇒ `shouldBlockDeploy`）/ `unknown`（护栏未生效）。
  **fail-closed**：token 覆盖率 < 0.5 ⇒ `unknown` + `reason='token-unmeasured'`，
  绝不把分母悄悄退化成「步数 + 耗时」冒充完整读数。
- `weeklyTask` 的 Phase 3 新增该检查（`console.warn` 出声 + 返回值新增 `effectiveDelta`）。
- 测试 16 条：`test/effective-delta.test.mjs`（判定表 12 条，含 3 条阴性对照）
  + `test/effective-delta-service.test.mjs`（服务面接线 4 条：注册 / 两窗参数 / toolStats 缺席 /
  60s TTL 缓存）。

### 为什么（背景）

宪法 `docs/evolution-framework.md` §5.3 写着「有效进化增量 ≤ 0 ⇒ 即使 HARM 提升也拒绝部署」，
但分母的 token 项恒缺（capability-boundary.md §4 F3）⇒ 这条约束从未执行过。
本版把判定补上；**真正拦部署**在 agint-quality-policy 0.9.0（把 `ineffective`
读成 AUTO_DEPLOY 封顶）。

### 注意（口径边界）

- 比值**没有**「收益太小也算无效」的门槛：宪法只写 ≤ 0。完成率微涨、资源涨 3 倍时
  比值仍为正（判 effective），「值不值」留给上层阈值/人工。
- token 项来自 tool-stats 的 `deltaTokens`（工具调用前后累计 token 的差值，**含该轮
  模型回复**，是压力估计而非调用级精确计费）。要 billing 级精确值，上游另有
  `@deepseek-ai/dsh-token-meter/client` 的 `deriveTurnTokenUsage(events)`（provider 上报的
  usage，可回溯历史会话）—— 见本文档 §已知限制。

## 0.3.5 (2026-10-14) — 评估池纳入已挂载 plugin（老板拍板方案 2）

### Added

- **weekly 评估池从「只扫技能目录」扩到「已挂载 plugin + 技能」**。
- 新文件 `lib/plugin-targets.js`：从 `ctx.loader.entries()` 枚举 plugin 目标。
  选 loader 名册而不扫目录的理由：patch 只说"要什么"，**loader 才说明挂上了什么**
  （`agint-family-panel/lib/index.js:176` 同款口径）；且部署位有三个副本，
  扫目录无法判断哪个是活的。
- 新配置位：
  - `includePlugins`（默认 `true`）—— 设 false 回到纯技能枚举；
  - `pluginIdPrefix`（默认 `'agint-'`）—— 宿主其它 plugin 不在本系统评估范围；
  - `maxTargets`（默认不限）—— 若单次耗时不可接受，在这里设上限，
    **而不是回头收窄枚举口径**；截断会 `console.warn` 点名丢弃数（静默截断 = 假覆盖率）。

### 修复的问题（实测）

此前 weekly 只枚举技能目录里名字含 `agint` 的技能：

| 技能根 | 总目录 | 含 agint |
|---|---|---|
| `$DSH_HOME/skills` | 6 | 0 |
| `$DSH_HOME/.agent-presets/agint/skills` | 10 | 1 |

⇒ 枚举到 **1 个**，`quality_eval_run_now` 返回 `evaluated=1`，
与老板 2026-08-20 拍板的 9 个 core plugin 口径不符。

修后用本机真实挂载名单（38 个 agint-* plugin）实测：枚举到 **37 个**
（排除自评），加技能源共 38 个目标。

### 设计取舍

- `entries()` 是**迭代器不是数组** —— 照 `agint-mascot/lib/index.js:123` 的
  `toArray()` 先例处理（v0.1.1 踩过：用 `Array.isArray` 会把健康宿主读成 warn）。
- id 取 `entry.options.id`，fallback `entry.id`（family-panel 同款取值顺序）。
- 显式 `disabled` 的不评估（它没在跑）。
- 自评在**枚举层**就剔除（不只靠 `evaluate()` 的 `SELF_PLUGIN_ID` 拒绝兜底）
  —— 否则会多出一条"拒绝自评"的失败记录。
- 读不到一律返回空数组 + `reason`，并 `console.warn`：
  空名册（`reason=null`）与读不到（`reason=loader-*`）必须可区分。

### 验证

- 新增 `test/plugin-targets.test.mjs`（11 项），用真实 loader 形状
  （迭代器 + `options.id`）造 mock，覆盖：迭代器非数组 / id fallback /
  命名空间过滤 / disabled / 自评排除 / 去重 / 三种降级 reason / 空名册。
- 红绿自证：撤掉命名空间过滤 ⇒ 变红；恢复 ⇒ 11/11 绿。
- 全插件回归 41/41 PASS，`test/smoke.mjs` exit 0。

## 0.3.4 (2026-10-14) — quality_eval_status 首次评估后报 invalid output

### Fixed

- **`quality_eval_status` 在跑过评估之后稳定报错**
  `invalid output: value is not lossless JSON`。
  根因：`lib/scheduler.js:58` 把 `at` 存成 **Date 对象**
  （`this.lastRun = { at, result, error }`），Date 不是 JSON 原生类型，
  宿主对工具返回值做 lossless-JSON 校验 ⇒ 拒绝整个返回值。
  **`lastRun` 未跑过时是 `null`，所以这个 bug 只在首次评估之后才现形** ——
  这正是它从落地起一直没被发现的原因（评估从未跑过）。
- 修法：在 `tools.js` 的序列化边界加 `sanitizeForJson()`
  （Date → ISO 字符串，Error → `{name, message}`，深递归带 depth 上限）。
  ⛔ 不动 scheduler 语义，只动序列化边界。

### 实测时间线（2026-10-14）

| 步骤 | 结果 |
|---|---|
| 触发前 `quality_eval_status` | 正常（`lastRun: <never>`） |
| `quality_eval_run_now` | `triggered` · `evaluated=1 persisted=1 loggedToEvo=0` |
| 触发后 `quality_eval_status` | `invalid output: value is not lossless JSON` |

### 验证

- 新增 `test/json-sanitize.test.mjs`（5 项）：用真实 scheduler 产出的
  lastRun 形状（`{at: Date, result, error}`）喂给真实 `execute()`，
  断言返回值是纯 JSON（自实现 `isLosslessJson` 判定，含 NaN/Infinity 检查）。
- 红绿自证：撤掉 `sanitizeForJson` ⇒ 变红；恢复 ⇒ 5/5 绿。
- 全插件回归 30/30 PASS，`test/smoke.mjs` exit 0。

### 附带发现（未修，需老板拍板）

**weekly 评估实际只跑了 1 个目标，与「9 个 core plugin」的拍板口径不符。**
- 老板 2026-08-20 拍板的 9 个 plugin 在 `lib/regression.js:33-43`
  的 `BASELINE_TARGETS`，只被 `runBaselineSuite()` 使用。
- weekly 路径走的是 `enumerateTargets()`（`lib/index.js:211`），
  它只扫**技能目录**、且只收**名字含 `agint` 的技能**。
  本机实测：`$DSH_HOME/skills` 6 个目录含 agint 的 0 个；
  `$DSH_HOME/.agent-presets/agint/skills` 10 个目录含 agint 的 1 个
  （`agint-install-bootstrap-rescue`）⇒ 枚举到 **1 个**目标。
- 这与 `evaluated=1` 的返回一致，也与 `dream_status` 显示的
  「计划评估 9 个 plugin」不一致 —— 后者读的是另一条路径。

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
