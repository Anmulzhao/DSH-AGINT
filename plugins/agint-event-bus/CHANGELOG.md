# Changelog — agint-event-bus

## 0.7.0 (2026-08-29) — Sprint 12 骨架交付

### FROZEN: EventEnvelope schema + Subscription.mode enum

> **冻结范围**（v0.7.0 发版日生效；变更走 L0 治理）：
> - `schemas/event-bus.schema.yaml` 顶层字段 + 字面正则
> - `Subscription.mode` enum: `sync | async`
> - `Subscription.reason` 仅在 `mode=sync` 时 `minLength ≥ 1`（空字符串硬抛错）

**冻结字段**（EventEnvelope 8 字段）：
- `id` — UUIDv4（总线或发布方生成）
- `topic` — 匹配 `^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$`
- `version` — integer ≥ 1
- `occurredAt` — ISO date-time（发布方记"事件发生"时间）
- `source` — 发布方插件名（与 cordis plugin name 对齐）
- `traceId` — 缺失时由总线生成 `crypto.randomUUID()`；同 traceId 内对同订阅者保序
- `correlationId` — 可选（关联上游事件因果链）
- `payload` — topic 自有 schema（**不冻结**；正交演进由发布方维护）

**冻结字段**（Subscription 5 字段）：
- `subscriber` — 订阅方插件名
- `topics` — array of topic（精确匹配；wildcard 留 v0.8+ 评估）
- `mode` — `sync | async`
- `reason` — 仅 sync 必填；空字符串硬抛错
- `timeoutMs` — 10000ms 默认；sync 模式超时降级 `PENDING_REVIEW`
- `retry` — `{maxAttempts: 3, backoffMs: 500}` 默认

### 新增

- 3 cordis Service（`agint.eventBus.publish` / `agint.eventBus.subscribe` / `agint.eventBus.inspect`）
- 8 个 src 模块：`envelope.ts` / `schemas.ts` / `types.ts` / `delivery.ts` / `deadletter.ts` / `observability.ts` / `bus.ts` / `index.ts`
- `RingBuffer`（2000 capacity；FIFO 淘汰）
- `deliverAsync` + `deliverSync`（指数退避封顶 8000ms）
- `recordDeadletter`（id 格式 `${envelope.id}:${sub.id}`；7 天 TTL）
- `mock EventBusContext` 测试支架
- 10 用例 smoke 覆盖 FROZEN 契约 + 多订阅者隔离 + sync 超时降级

### 全局约束（yaml `constraints`）

| 字段 | 值 | 含义 |
|---|---|---|
| `syncSubscriptionGlobalLimit` | 3 | 全系统 sync 订阅 ≤ 3（policy-boundary 专属） |
| `deadLetterRetentionMs` | 604800000 | 死信保留 7 天 |
| `ringBufferCapacity` | 2000 | inspect 内存视图上限 |

### 不变量

- mountOrder = 50（晚于 mount / 早于 audit 类）
- 存储域独占：`agint_event_bus`（不写 `agint_event_log`）
- `permissions.network = []`（不发起外部请求）
- 不持有 ambient timer（退避走 `setTimeoutPromise` + `ctx.effect` disposer）
- 不调 `agint.qualityEvaluator`（self-evaluate forbidden）

### 待办（v0.8+）

- [ ] wildcard topic 支持（`evolution.*`）
- [ ] per-trace fence（v0.7.0 简化版：FIFO 由 delivery 主循环自然实现）
- [ ] 死信衰减 / 重新入队接口
- [ ] `recordEvent` 兼容层（mount 已预留 `tools/post-execute` 占位）
