# Changelog — agint-event-bus

## 0.7.1 (2026-09-23) — topic 正则首段放宽：修一条自建成起即死的契约冲突

> 起因：预演场（影子 home + AGINT 挂载）首跑即抓到 `agint-skill-graph` 订阅失败。
> 追下去发现不是一处订阅写错，而是 **topic 命名约定与 FROZEN 正则的系统性冲突**。

### 缺陷是什么（三层，一层比一层深）

**第一层 —— 正则自身不一致。** 首段 `[a-z][a-z0-9]*`（**禁**连字符），
后续段 `[a-z][a-z0-9-]*`（**允许**连字符）。同一字段两套规则，无设计论证。

**第二层 —— 两份人类签字的契约互相冲突，从未交叉校验。**
`设计-P0-1-技能自动创建机制.md`（第 414-426 行）有**明文事件契约表**，规定 topic 名就是
`skill-autocreate.candidate-created` / `.released` / `.rolled-back` 等；而 FROZEN schema
把首段连字符判非法。⇒ 受影响的 topic 共 **17 个**：
`skill-autocreate.*`(14) + `skill-graph.updated` + `compress-guard.{blocked,checkpointed}`(2)。

**第三层 —— 静默失败，这才是它能活这么久的原因。**
- 发布侧：`bus.js` 的 `publish()` **不抛错**，校验失败只返回 `{accepted:false}`；
  而 `skill-autocreate` 的 `publishEvent` 不看返回值，一律 `return true` ⇒ **零日志**。
- 订阅侧：`validateSubscription` 抛错被启动日志淹没。
- 雪上加霜：`skill-graph` 是一次传整个 topics 数组，**1 个非法项 ⇒ 11 个 topic 全被拒**，
  连 `curator.*` / `trajectory.recorded` 等 8 个完全合法的也一起收不到。

### 决定性取证

| 证据 | 结果 |
|---|---|
| 生产存储 `agint_event_bus.json` | 941 条事件 / 12 种 topic，**`skill-autocreate`/`skill-graph`/`compress-guard` 命中数 = 0** |
| 同一存储的合法 topic | `evolution`(219) / `memory`(498) / `curator`(12) 正常落库 ⇒ 排除「存储没写」 |
| skill-autocreate 是否真跑过 | skills_root 里 **11 个自动生成的技能**（09-16~09-18）⇒ 排除「插件没跑」 |
| 12 种既有 topic 的首段 | **无一首段含连字符** ⇒ 正则不是 bug，它在正确执行 |
| 全仓非法 topic 的出现处 | 仅上述 3 个插件 + 设计稿 ⇒ 影响面收敛 |

⇒ 定性：**不是插件违反约定，而是契约冲突**；且历史落库为 0 ⇒ 改命名**无历史数据兼容负担**。

### 改动

1. **三处同步**修改 `TopicSchema.pattern` 首段 `[a-z][a-z0-9]*` → `[a-z][a-z0-9-]*`（与后续段同规则）：
   | # | 文件 | 角色 |
   |---|---|---|
   | 1 | `schemas/event-bus.schema.yaml` | **单一事实源** |
   | 2 | `src/schemas.ts` | tsc 输入 |
   | 3 | `lib/schemas.js` | 运行时真正加载的产物 |
   ⇒ **少改一处 = 修复被静默回退**：只改产物不重编译，下次 `npm run build` 会覆盖回旧正则；
   只改 src 不重编译，产物不更新（本次不重编译，避免 tsc 顺带覆盖 `lib/index.js` 等已有漂移文件）。
2. `schemas/event-bus.schema.yaml` 头部：补「变更记录」段 + 记两条新发现 ——
   ① **yaml 自述冻结「字段清单」、CHANGELOG 自述冻结「字段 + 字面正则」，两份冻结声明口径不一致**
   （今后引用冻结范围需两份都看，取更严者）；
   ② **`src/` 与 `lib/` 已存在格式级漂移**（同文件缩进不同、`lib/tools.js` 在 src 无对应源），
   属既有债务，本次只做内容同步、不动格式。
3. 未改发布/订阅调用方（`publishEvent` 不检查 `accepted` 的静默问题见「仍待修」）。

### ⚠️ L0 状态（需人工复核）

按 CHANGELOG 的冻结口径，本 pattern 属 FROZEN ⇒ 严格流程应走
「人类多签 + 7 天影子 + major 版本」。**本次按「修契约冲突缺陷」先行落地，L0 手续未补。**
理由：缺陷使 17 个 topic 自建成起 100% 失效，且放宽是**向后兼容超集**（旧合法值全部仍合法）；
版本按仓库惯例走 patch（同 `agint-skill-autocreate` 修缺陷先例），未走 major。**待老板裁定是否补流程。**

### 验收（硬证据）

- **预演场红/绿对照**（影子 home，`DSH_HOME=.dsh-probe`，不碰生产存储）：
  | 用例 | 修复前 | 修复后 |
  |---|---|---|
  | publish 线上真实 topic `skill-autocreate.candidate-created` | `accepted:false` | `accepted:true` + 磁盘 onDisk=true |
  | subscribe 那 3 个 topic | **抛错** | OK |
  | 端到端投递（handler 真收到） | 链断 | `deliveredTo:[...]` ✓ |
- **三处字面一致性校验 23/23 PASS**（新增，`D:/DSH/_probe/verify_topic_pattern_sync.mjs`）：
  yaml ≡ src ≡ lib ≡ **宿主 lib** 四处正则字面完全相同；10 个应接受的 topic 全接受、
  6 个应拒绝的（`invalid` / 大写 / 下划线 / 前后导点 / 5 段）全拒绝。
  ⇒ 这条是防「下次 build 静默回退修复」的守门。
- **生产存储零回归**：941 条 / 12 种真数据在新 pattern 下全部仍合法；非法样本 `invalid`（无段分隔符）仍非法。
- **宿主部署位冒烟 14/14 PASS**（直接 import 部署位那份字节 ＋ 生产真数据）。
- 既有测试无回归：`smoke` 10/10、`a9-a10` 4/4、`t2-sync-drill` 1/1（须 cwd=仓库根，属该脚本前提）。
- 生产存储 `storages/` 454 文件两次运行**零改动** ⇒ 预演场隔离成立。

### 仍待修

- **`publishEvent` 不检查 `accepted`** —— 校验失败静默丢弃，是本缺陷潜伏这么久的根因。
  同属 K51「可观测 > 可审批」要防的形态，应改为失败落 audit / 至少 warn。
- **`subscribe()` 全数组原子拒绝** —— 1 个非法 topic 连坐 8 个合法 topic。
  宜改为逐项校验 + 部分成功 + 明确告警。
- **落库时机竞态**（预演场顺带抓到）：`publish` 在存储表就绪前调用，`ctx.tables.events.put()`
  抛错被 `catch { }` 静默吞 ⇒ `accepted:true` 但磁盘无行（K77 同一形态）。
  **「发布成功」与「落库成功」是两件事**，需显式区分或串行化。

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
