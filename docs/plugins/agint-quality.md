# agint-quality-contract

> D-QAF 评估框架的核心契约：**只定义 Seam（接口与 Schema），不写实现**。
> 实现由 sibling 插件（`agint-quality-{eval,sandbox,policy,report}`）承担，本切片仅落契约层。

## 职责

- 提供 `agint.quality` host Service
- 暴露 FROZEN 接口签名（`EvalTarget` / `EvalResult` / `Decision` / `HARM` / `DimensionScore` / `DreamPhase`）和 ADJUSTABLE 配置 schema（`QualityConfig`）
- 提供 L0/L1 字段层级查询（`getLayer` / `isFrozen`）和 patch 校验（`validatePatch`），作为 sibling 实现插件改契约的守门人
- 写入 `setConfig` 审计日志到 `agint.memory`（如果可用；不可用则降级为 `console.warn`）

## 设计原则

1. **自身不评估**（递归陷阱由外部 CI 兜底）
2. **仅定义接口，不写实现**
3. **FROZEN 字段永不修改**，需人类多签；ADJUSTABLE 字段由 policy 自调并记审计日志

## 二元边界（提案 3d6cc063）

| 层 | 内容 | 修改门槛 |
|---|---|---|
| **L0-frozen** | 接口签名、Safety 红线、决策枚举、维度定义 | 人类多签 + CI 禁改 |
| **L1-adjustable** | HARM 权重、评分阈值、梦境预算、沙箱限制 | policy 自调 + 审计日志 |
| **L2-implementation** | 实现细节 | sibling 自治；未登记默认 L2 |

## 提供的 Service 方法

```js
ctx.agint.quality.getConfig()                              // → QualityConfig
ctx.agint.quality.setConfig(patch)                         // → QualityConfig; 含 L0 抛 L0_FROZEN_VIOLATION
ctx.agint.quality.schemas                                  // → { EvalTarget, EvalResult, Decision, ... }
ctx.agint.quality.interfaces                               // → { QualityEvaluator, QualityPolicy, QualityReporter, QualityLifecycle }
ctx.agint.quality.getLayer(fieldPath)                      // → 'L0-frozen' | 'L1-adjustable' | 'L2-implementation'
ctx.agint.quality.isFrozen(fieldPath)                      // → boolean (back-compat alias for getLayer === 'L0-frozen')
ctx.agint.quality.validatePatch(patch)                     // → { ok, violations[] }
```

## Schema 核心字段（EvalTarget）

```yaml
id:       string  # 唯一；pluginId / skill name
kind:     plugin | skill | preset | composite
version:  string  # 默认 '0.0.0'；用于评估历史溯源
path:     string? # 源码位置，供 sandbox 执行
tags:     string[]# 例 ['light-dream', 'manual-review']
```

## 决策枚举（`DecisionKind`，FROZEN）

| 值 | 含义 |
|---|---|
| `AUTO_DEPLOY` | 综合分 ≥ `autoDeploy` 阈值（默认 90），安全门通过 |
| `PENDING_REVIEW` | 综合分 ≥ `pendingReview` 阈值（默认 75），待人工 review |
| `REJECT` | 未达阈值或安全门失败 |
| `ABSTAIN` | 评估不充分，信号不足 |

## 默认配置（ADJUSTABLE，启动时载入）

```js
{
  harmWeights:  { H: 0.2, A: 0.3, R: 0.3, M: 0.2 },          // 公式: 0.2·H + 0.3·A + 0.3·R + 0.2·M
  thresholds:   { autoDeploy: 90, pendingReview: 75 },
  dreamBudgetSec: { light: 60, rem: 1200, deep: 300 },
  sandboxLimits: { timeoutMs: 30000, memoryMB: 512, networkDisabled: true, readOnly: true },
}
```

## 与其他插件的关系

- **`agint.rules`**：规则门禁中的 `frozenness` 字段（`L0-frozen` / `L1-revocable` / `L2-delegable`）概念来自本契约的 L0/L1/L2 划分（提案 a6ba79a3）
- **`agint.memory`**：`setConfig` 审计日志落点；读取历史评估记录
- **`agint.metrics`**：HARM 维度作为质量子维度采集
- **`agint.dream`**：梦境阶段（`light` / `rem` / `deep`）触发对应评估预算
- **`agint.evolve`**：周复盘时拉取评估汇总生成进化提案
- **`agint-tool-stats`**：评估引擎读工具调用画像计算 Effectiveness / Reliability

## 验证（与 K18/K19 一致）

仅做 mount-validate **不足以** 证明可用性。最低验证（待 `scripts/verify-quality-contract.mjs` 补足）：

1. 启动 DSH web
2. 真实调用 `agint.quality.getConfig()` → 返回默认 QualityConfig
3. `setConfig({ harmWeights: { H: 0.5 } })` → 成功，且 `agint.memory` 写一条审计
4. `setConfig({ EvalTarget: {...} })`（含 L0 字段）→ 抛 `L0_FROZEN_VIOLATION`
5. `getLayer('harmWeights.H')` → `'L1-adjustable'`；`getLayer('EvalTarget')` → `'L0-frozen'`

## 本切片边界

v0.1.1 **仅落 contract**：剩余 4 个 sibling（`agint-quality-eval` / `agint-quality-policy` / `agint-quality-sandbox` / `agint-quality-report`）按 ROADMAP 留给 v0.2/v0.3。

这与 AGINT 哲学「先把 Seam 钉死，再补实现」一致——契约是 FROZEN 层，越早稳定越好；实现可在策略与数据充分后迭代。

## 文件

```
agint-quality-contract/
├── lib/index.js    Cordis apply()：提供 agint.quality Service + Zod schemas + interface defs
├── package.json    dsh-plugin metadata；peerDependency zod
└── README.md       插件自述（mount 行 + 二元边界）
```