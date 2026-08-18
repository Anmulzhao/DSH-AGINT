# agint-quality-eval

> D-QAF 评估引擎：实现 `QualityEvaluatorIface.evaluate(target)`。
> 数据源只读 `agint.toolStats` / `agint.memory` / `agint.rules` / `agint.metrics` ——**不执行代码、不扫描文件**（v0.2 初版切片；sandbox 评估留给 v0.3）。

## 职责

- 提供 `agint.qualityEvaluator` host Service
- 实现 `QualityEvaluatorIface`（contract 定义）的 `evaluate(target)` 方法
- 7 维评分：`trust` / `reliability` / `effectiveness` / `safety` / `convention` / `adaptability` / `integrability`
- 综合分计算（v0.2 简版）：safety 权重 0.30（最高），< 0.5 一票否决
- HARM 简版：H/M 中性 0.5；A ≈ trust；R ≈ reliability
- 周日凌晨自动批量评估所有 AGINT Skills + Plugins，写 `agint.memory`

## 与 contract 的关系

`agint-quality-contract`（FROZEN 层）定义了接口，本插件是它的**第一个实现**。后续如果需要不同算法实现（如 sandbox 静态扫描版），可以并存：

- `agint-quality-eval`（本插件）：read-only 数据评估
- `agint-quality-eval-sandbox`（v0.3 计划）：sandbox 静态扫描 + 动态执行
- `agint-quality-eval-llm`（v0.4 计划）：用 LLM 作为 judge

三个都实现 `QualityEvaluatorIface`，用 `qualifierId` 字段区分。

## 7 维评分算法

| 维度 | 数据源 | 算法 | 无数据时 |
|---|---|---|---|
| **trust** | `agint.memory.search(targetId)` | 历史决策分布：`(AUTO_DEPLOY*1 + PENDING_REVIEW*0.5) / total` | 无历史 → 0.5 |
| **reliability** | `agint.toolStats.failureRate({tool})` | `1 - failureRate` | 无记录 → null + info |
| **effectiveness** | `agint.toolStats.summary()` | `usage * speed`（usage = calls/100, speed = 1 - avgLatency/5000 * 0.3） | 无记录 → null + info |
| **safety** | `agint.rules.list({tool})` | `1 - 0.2*L1_deny - 0.05*L2_deny`，L3+ 不扣 | 无 deny → 1.0 |
| **convention** | 无（v0.3 sandbox 补） | null | null + info |
| **adaptability** | 无（v0.3 sandbox 补） | null | null + info |
| **integrability** | `agint.metrics.summary()` | 找到相关 key → 1.0；否则 0.5 | 无 metrics → 0.5 |

**任一维度 score === null → 整个 EvalResult 倾向 ABSTAIN**。

## 综合分（v0.2 简版）

```
score = 100 * sum(weight_i * score_i) / sum(weight_i for non-null scores)
weight: trust=0.20, reliability=0.20, effectiveness=0.10, safety=0.30, integrability=0.20
safety < 0.5 → score = null（caller 走 REJECT 路径）
```

## HARM（简版）

```
H = 0.5     // 没有模式聚类数据
A = trust   // 策略-执行-结果连贯性 ≈ 历史决策分布
R = reliability // 最小结构复杂度 ≈ 失败率反向
M = 0.5     // 没有适应性数据
HARM = 0.2*H + 0.3*A + 0.3*R + 0.2*M
```

## 调度

- 自持 `WeeklyScheduler`（lib/scheduler.js）
- 每 5 分钟 tick 一次检查
- 下次触发 = cron `30 4 * * 0`（每周日 04:30，metrics-collect 04:00 之后）
- 触发后：枚举 AGINT Skills → 逐个 evaluate → 写 memory
- 也提供 `runNow()` Service 方法供手动触发

## Service 接口

```js
ctx.agint.qualityEvaluator.evaluate(target)        // → EvalResult
ctx.agint.qualityEvaluator.evaluateAll(targets)    // → EvalResult[]
ctx.agint.qualityEvaluator.score(evalResult)        // → number | null (REJECT 时 null)
ctx.agint.qualityEvaluator.runNow()                // → { evaluated, persisted }
ctx.agint.qualityEvaluator.nextFire()               // → Date
ctx.agint.qualityEvaluator.lastRun()                // → { at, result, error } | null
ctx.agint.qualityEvaluator.weights                  // → { trust: 0.20, ... }
ctx.agint.qualityEvaluator.dimensionKeys            // → ['trust', 'reliability', ...]
```

## 文件

```
agint-quality-eval/
├── lib/
│   ├── index.js         Cordis apply()：提供 agint.qualityEvaluator Service + 调度
│   ├── evaluators.js    7 维评分算法 + compositeScore
│   └── scheduler.js     WeeklyScheduler（用 agint-cron 的 parseCron/nextFire）
├── package.json
└── README.md
```

## 本切片边界

- **不评估 self**（避免递归）：`evaluate({ id: 'agint-quality-eval' })` 抛错
- **不修改 dsh host**：纯只读 Service 调用
- **sandbox / LLM-judge 评估**留给 v0.3 / v0.4（按 contract 的 QualityLifecycle 接口预留）
- **plugin 枚举**：当前只枚举 AGINT skills（用 dsh skills service）；plugin 列表留待 dsh 暴露 plugin registry Service 后再补