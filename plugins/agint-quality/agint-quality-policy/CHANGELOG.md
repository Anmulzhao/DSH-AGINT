# Changelog — agint-quality-policy

## 0.6.4 (2026-08-27) — Sprint 10 #10 收口

### Added

- **abtest 加权综合分接入**（设计稿 §二.6 + §七 L0-frozen）：
  - contract QualityConfigSchema 加 `abtest`块（ADJUSTABLE）：enabled/weight/minSamples/pValueThreshold
  - `abtestResultsToDimension({ abtestResults, abtestConfig })` helper：winner/pValue 映射为 abtest dimension score
  - `injectAbtestDimension(results, dim)` mutate-safe 注入到所有 results 的 dimensions
  - `decidePolicy` 在 config.abtest.enabled=true 时把 abtest dimension prepend 到 results，权重来自 config.abtest.weight（默认 0.10）
- **abtest dimension 不参与 safety/trust 一票否决**（设计稿 §十.2 + 简洁 > 冗余）
- **14 个新单测**（test/abtest-weighted.test.mjs）：覆盖 abtestResultsToDimension 4 映射分支 + injectAbtestDimension mutate-safe + decidePolicy 4 集成场景 + QualityConfigSchema 接受 abtest 块

### Compatibility

- abtest.enabled 默认 false（向后兼容）：现有 190 测试全过
- L0-frozen 接口签名（QualityEvaluator / QualityPolicy / QualityReporter / QualityLifecycle）未触动
- AGINT 工程文件 manifest.json + README.md + CHANGELOG.md + cordis.patch.yml 补齐（PLUGIN-SPEC 8 维度）

## 0.4.0 — Sprint 4 完整版（v0.4.0 / v0.5.x 沿用）

- 完整 4 决策 + 加权综合分 + 反和谐 + 元评估委员会 + HARM 报告
- 详见 git log v0.4.0 / Sprint 4 设计稿
## 0.7.4 (2026-08-29) — Sprint 12 / A2 evolution.evaluated 订阅

### Added

- **evolution.evaluated 边事件订阅**（per Sprint12 设计稿 §A3，唯一 sync 门禁边）：
  - `apply(ctx, config)` 初始化时挂订阅：`{subscriber:'agint-quality-policy', topics:['evolution.evaluated'], mode:'sync', reason:'policy gate edge: 门禁决策必须等评分确定后才推进 mount/sandbox 流水线（A2，唯一 sync 边，per Sprint12 设计稿 §A3）', timeoutMs:5000}`
  - **reason 必须非空**（schema + bus.ts 双 belt-and-suspenders）：
    - schema.ts SubscriptionSchema.superRefine：mode=sync 时 reason.trim() 长度 > 0
    - bus.ts subscribe()：validateSubscription 已通过则 reason 一定非空
  - **5s 超时降级**走直连，不抛错（保留原 decide() 直连路径；事件路径失败不阻断 policy 决策）
  - ctx.dispose 时退订（ctx.effect disposer 链）
- **manifest optionalInject**：`['agint.eventBus.subscribe']`（软依赖；事件总线缺失时静默跳过）
- **dependencies 增列** `agint-event-bus: ">=0.7.0"`
- **新增 top-level tests 字段**（PLUGIN-SPEC 维度 1 兼容）：指向现有 `test/abtest-weighted.test.mjs`

### Compatibility

- L0-frozen 接口签名（QualityPolicy / QualityPolicyIface.decide）未触动
- 决策主路径（decide）行为完全等价于 v0.6.4（事件路径 T1 影子期不参与）
- T1 影子期 sync 全局计数 == 1（其他 sync 订阅留给 Sprint 12 B/C 阶段）
