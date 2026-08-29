# Changelog — agint-quality-policy

## 0.8.0 (2026-09-01) — Sprint 12 / A5 policy.deployed / policy.rolledback 事件化（T1 影子期）

### Added

- **policy.deployed 事件化**：decide() 末尾当 kind === 'AUTO_DEPLOY' → publish envelope `{topic:'policy.deployed', version:1, source:'agint-quality-policy', payload:{targetId, decision, score, reason}}`。perTarget[*].kind === 'AUTO_DEPLOY' 每条各发一条。
- **policy.rolledback 事件化**：decide() 末尾当 kind === 'REJECT' 且 `committee.shouldRollback` 触发 → publish envelope `{topic:'policy.rolledback', version:1, source:'agint-quality-policy', payload:{targetId, decision, score, reason, rollbackTarget}}`。同步调 `committee.recordRollback` 落 storage（与原直连路径一致）。
- **publish 走单 service 接口** `ctx.get('agint.eventBus.publish')`（A3 已确认伞键 `ctx.get('agint.eventBus').publish` bug——上层 envelope 字段会被中间层覆盖；不再用伞键）
- **schema v1 不冻结**：`schemas/policy-deployed.schema.yaml` + `schemas/policy-rolledback.schema.yaml`；影子期允许新增 optional 字段，破坏性变更走 L0 治理
- **manifest optionalInject** 加 `agint.eventBus.publish`（软依赖；event-bus 不可用 → 静默跳过 publish，原直连路径完全保留）
- **dependencies 维持** `agint-event-bus: ">=0.7.0"`

### Compatibility

- L0-frozen 接口签名（QualityPolicy / QualityPolicyIface.decide）未触动
- decide() 决策主路径行为完全等价于 v0.7.4（事件路径 T1 影子期不参与）
- event-bus 缺失 / publish 失败 / schema 不匹配 → log 不抛，决策照常返回
- 调 `committee.recordRollback` 与原 `committee.shouldRollback` 行为不变（仅多了一次 publish 副作用）

### Subscriber（本期不本插件内挂；记入 sprint 看板由对应插件 owner 接管）

- `agint-quality-report` → 观测行（console + audit），不进 HARM 报告输出
- `agint-metrics` → policy.deployed / policy.rolledback 计数器（写入 agint_metrics 域）
- `agint-diagnosis` → rollback pattern 标注（订阅方 B 可选；本期跳过，写此条 CHANGELOG 说明）

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
