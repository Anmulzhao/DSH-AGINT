# agint-event-bus v0.7.0

> AGINT 跨插件事件总线 · 基础设施层 · Sprint 12 通信架构解耦

## 它是什么

`agint-event-bus` 是 AGINT 的**纯基础设施插件**（第 20 个），把跨插件通信从"硬编码 import" 解耦到"声明式订阅" + "at-least-once 投递"。**不承载进化语义**，不做评估、不打 owner。

## 3 Service（cordis provides）

| Service | 一句话 |
|---|---|
| `agint.eventBus.publish` | 发布一个 EventEnvelope 到总线，按订阅表路由；返回 `{accepted, deliveredTo, deadLettered, envelopeId, traceId}`；不等待 async 订阅者完成 |
| `agint.eventBus.subscribe` | 声明式订阅（subscriber + topics + mode）+ handler；返回 Unsubscribe 函数；sync 模式要求 reason 非空（哲学对齐审查前置） |
| `agint.eventBus.inspect` | 只读查询：按 topic / traceId / source / since / until / limit 过滤，返回 `EventLogEntry[]`；供排障 / 仪表盘 |

## FROZEN Schema（v0.7.0 发版日冻结）

```
schemas/event-bus.schema.yaml:
  EventEnvelope: 8 字段（id / topic / version / occurredAt / source / traceId / correlationId / payload）
  Subscription:  5 字段（subscriber / topics / mode / reason / timeoutMs + retry）
  mode:          enum {sync, async}
  reason:        sync 模式必填 + 非空字符串（空字符串硬抛错）
```

冻结范围：参见 `schemas/event-bus.schema.yaml`。变更走 L0 治理（人类多签 + 7 天影子 + major 版本）。

## 不变量

- **第 20 个 host 插件**（mountOrder=50）
- **存储域**：`agint_event_bus`（events 表 + deadletter 表；schemaVersion=1；atomic=json）
- **不写** `agint_event_log` 之类朝外暴露的域
- **sync 全局上限 3**（yaml constraints；policy-boundary edge 专用）
- **死信保留 7 天**（604800000ms；超出由 EvolutionLogBuffer 衰减路径清理）
- **inspection 内存视图 ≤ 2000 条**（环形淘汰；FIFO）
- **不持有 ambient timer**（仅 delivery 内的 `setTimeoutPromise` 一次性退避；必须 ctx.effect 注册 disposer）
- **不调** `agint.qualityEvaluator`（self-evaluation forbidden）

## 路由语义

- publish 时按 `envelope.topic` 精确匹配订阅表的 `topics` 列表（无 wildcard；v0.8+ 评估）
- 多订阅者**硬隔离**：每个订阅者独立 Promise；单订阅者抛错 / 超时不击穿 publish 主路径
- 失败重试：`maxAttempts` 次（默认 3），指数退避 `backoffMs × 2^n`，封顶 8000ms
- 超限 → 落死信 + 写 `eventBus.deadletter` metric

## sync 模式（policy-boundary edge）

仅限**门禁边专属**（quality-contract / rules / evolution-memory 之间）。`reason` 必填 + 非空字符串，总线硬抛错。

超时降级（默认 10000ms / 用户可配 100-60000）：
- 同步等待 handler 返回
- 超时 → 调 `agint.qualitySandbox.pendingReview` 记录人类否决权触发
- 记 `eventBus.syncTimeout` metric
- 返回 `PENDING_REVIEW` 状态（不抛、不进 deliveredTo / deadLettered）

## 资源管理（PLUGIN-SPEC 维度 5）

- 订阅表 + 环形缓冲：在 `plugin dispose` 时由 `disposeBus()` 清空
- 监听器：`ctx.on` 自动 dispose
- 退避 timer：每次调用由 `disposers[]` 收集；publish 完成时统一 cleanup

## 测试

```
cd plugins/agint-event-bus
./node_modules/.bin/tsc -p .   # 退出 0
node test/smoke.mjs            # 10/10 PASS
```

10 用例覆盖：envelope 校验 / 多订阅者隔离 / sync 超时降级 / Unsubscribe / traceId 自动生成 / inspect 过滤 / FROZEN schema 字面 / manifest 8 维度 / assertEnvelope / dispose 清空。

## 文件清单

```
src/
  envelope.ts          # EventEnvelope 构造（makeEnvelope + assertEnvelope + previewEntry）
  schemas.ts           # zod 校验（TopicSchema / EventEnvelopeSchema / SubscriptionSchema）
  types.ts             # 公共类型（Subscription / EventLogEntry / EventBusContext / TableHandle）
  delivery.ts          # 投递引擎（deliverAsync + deliverSync + assertSyncReason + backoffDelay）
  deadletter.ts        # 死信落库（recordDeadletter + DeadLetterEntry）
  observability.ts     # ring buffer + 过滤 + 聚合（RingBuffer + filterEntries + summarize）
  bus.ts               # 总线编排（publish + subscribe + inspect + inspectSummary + disposeBus）
  index.ts             # cordis 入口（apply 注册 3 service + storageDomain + lifecycle）
schemas/
  event-bus.schema.yaml  # FROZEN EventEnvelope + Subscription 字面
test/
  smoke.mjs            # 10 用例（不依赖 dsh host；mock EventBusContext）
```
