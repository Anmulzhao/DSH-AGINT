# 设计稿 — agint-ov-strategy（AGINT × OpenViking 策略层）

> 日期：2026-09-27　作者：智　状态：已获老板拍板（架构定性）＋按本稿实现
> 上游依据：`D:/DSH/_dsh_openviking官方bundle评估与优化建议_20260927.md` §1.3 / §6 / §10.7

---

## 0. 结论先行

官方 `@openviking/dsh-memory-plugin@0.5.8`（bundle，已装已验）已经把「传输 + 生命周期」层
造好：6 个事件钩子、捕获、阈值提交、pending 队列 + 60s drainer、viking:// 守卫。
AGINT **不再造这些**，改为消费 bundle 暴露的 `openvikingMemory` runtime（`ctx.provide`，`package/index.mjs:23`）。

本插件 = AGINT 侧**唯一**的消费缝（单缝原则），职责只有三件：

1. **经验沉淀写入**：把 dream / diagnosis 等产物投影进 OV；
2. **按域过滤**：哪些值得记、打什么标签、噪声不入库；
3. **策略侧召回**：给 AGINT 插件一个不经过 pre-step 的显式查询入口。

## 1. 架构定性（老板 2026-09-27 拍板）

**对 DSH 深度融合，对 OV 薄缝解耦。** 判据：看「换掉它」的代价。

- 换掉 dsh = 放弃自进化命题（27 插件宿主习语全部重写，不可逆）⇒ 融合。
- 换掉 OV = 只丢一份语义索引（数据规则守住则一天可重建）⇒ 薄缝。

落成四条硬规则：

| # | 规则 | 在本插件的体现 |
|---|---|---|
| R1 | **单缝原则** | 全仓只允许本插件 `ctx.get('openvikingMemory')`；其他插件只消费 `agint.ovStrategy` |
| R2 | **正本与投影** | 本插件不持有任何存储域；被投影的数据先由生产者落自己的 domain，本插件只做 write-through |
| R3 | **召回是增益不是依赖** | `recall()` 软失败（返回 `{ok:false}`），绝不抛；消费方必须可脱 OV 运转 |
| R4 | **不重建传输** | 不直连 OV REST、不自建队列；一切经 `runtime.client` + `runtime.enqueueWrite/enqueuePending` |

## 2. 消费的官方接口（对 `runtime.mjs` v0.5.8 取证）

| runtime 方法 | 用途 | 本插件用法 |
|---|---|---|
| `stateFor(session)` | 建/取会话状态（键 = `session.id`，peer 由 `session.header.cwd` 解析） | 传**伪会话** `{ id, header:{cwd} }`，OV 侧落成 `dsh-agint-<scope>-<trace>`，与真人会话天然区分 |
| `ensureState(state)` | 健康检查 + ensureSession + pending 重放 + 画像 | 写入前调；`state.ready === false` 时按 `initializationRetryable` 决定兜底 |
| `enqueueWrite(state, op)` | 串行化写队列（官方 catch→log，不回抛） | op 内闭包捕获 addMessage 结果，随后 `await state.writes` 等完成 |
| `client.addMessage(ovSessionId, payload, peerId)` | 消息落盘 | payload = `{ role:'user', content:'[scope] text', peer_id }`（对齐 capture.mjs:92 形状） |
| `enqueuePending(state,'addMessage',payload)` | 失败入 pending 队列（drainer 60s 重放） | 仅 retryable 失败（0/408/429/5xx）时兜底 |
| `dispose(session)` | teardown commit（3s 超时，受全局 capture 开关门控）+ 清 states Map | 每次投影后调用，顺带完成提交与卫生清理 |
| `client.fetchJSON(path, init)` | 直连 OV REST 的唯一合法通道（经 bundle 客户端） | recall：`POST /api/v1/search/search` `{query, mode:'context'}` |

**明确不消费**（红线，写代码时不得触碰）：

- ⛔ `runtime.capture()` —— 官方已在真人会话上捕获；策略层再走它 = 同段对话双写（评估稿 §10.7 风险 2）。
- ⛔ `mcp__openviking__remember` MCP 工具 —— 官方自述存进 proxy 短命会话、不 session-scoped（§6.6）。
- ⛔ `ExternalProvider` 插槽 —— §10.7 已拍板「现在不接」，provider 与本插件职责正交。

## 3. Service：`agint.ovStrategy`

### 3.1 `remember(input) → { ok, reason?, ovSessionId? }`

```
input = { scope, text, traceId?, meta? }
```

守卫链（任一不过即软返回，绝不抛）：

1. `disposed` → `{ok:false, reason:'disposed'}`
2. kill-switch：config `enabled:false` 或 env `AGINT_OV_STRATEGY=off` → `'disabled'`
3. `ctx.get('openvikingMemory')` 为空（bundle 未装/未重启/被卸）→ `'bundle-unavailable'`
4. scope 不在白名单（默认 `dream / diagnosis / evolution / manual`）→ `'scope-not-allowed'`
5. `text` 长度 < `minTextLength`(20) → `'too-short'`；> `maxTextLength`(4000) → `'too-long'`

写入链：伪会话 → `ensureState` → `enqueueWrite(addMessage)` → retryable 失败 `enqueuePending`
→ `dispose`（teardown commit + 清 Map）。全程 await，返回 `{ok:true, ovSessionId}`。

观测出口：成功后 publish `ov.strategy.remembered`（v1，软失败）；失败 publish
`ov.strategy.write-failed`（v1，软失败）。两 topic 符合总线正则（2-4 段小写）。

### 3.2 `recall(query, opts) → { ok, entries? , status? }`

经 `client.fetchJSON` 调 `POST /api/v1/search/search`。返回原始 `result.entries`（不做压缩/渲染，
那是 pre-step 的事）。任何异常软失败。**R3：消费方拿到 `{ok:false}` 必须能继续干活。**

### 3.3 `status()`

`{ enabled, runtimeAvailable, scopes, autoTopics, counters }` —— counters 内存计数
（attempted/succeeded/failed），给 metrics/诊断一个免费抓手。

## 4. 总线订阅（自动沉淀，零侵入生产者插件）

订阅 `{ subscriber:'agint-ov-strategy', topics:autoTopics, mode:'async' }`
（sync 模式有全系统 ≤3 配额且需 reason，本插件不占）。

默认 `autoTopics = ['dream.completed', 'diagnosis.completed']`，payload → 文本策略：

| topic | 触发条件 | 记什么 |
|---|---|---|
| `dream.completed` | `countPromoted > 0`（空转 sweep 不记） | sweepId、候选/门禁/晋升计数、diaryPath、dedupe.dropped |
| `diagnosis.completed` | 恒记（诊断低频高价值） | reportId、clusterCount、rootCauseDistribution（紧凑 JSON） |

文本打 `[dream]` / `[diagnosis]` 前缀作为 scope 标签，随 `traceId`（= sweepId / reportId）写入，
OV 侧抽取时可溯源。**订阅失败（bus 不可用）静默降级**——本插件核心服务 remember/recall 仍可用。

## 5. 失败域隔离（R3 的落实）

| 故障 | 行为 |
|---|---|
| bundle 未装 / 老版 dsh | `remember/recall` 返回 `{ok:false, reason:'bundle-unavailable'}`；订阅不建立；插件照常 apply |
| OV 服务端宕机 | ensureState 失败：retryable → 入 pending（drainer 兜底）；否则软返回 |
| 总线不可用 | 自动沉淀失效，手动 remember 不受影响 |
| 本插件自身挂 | 只有本插件死；不拖累宿主 boot（apply 全程无硬依赖注入） |

kill-switch：`AGINT_OV_STRATEGY=off`（env）或 config `enabled:false`。**出厂即开**（K51：
kill-switch ≠ 默认关）。注意官方全局 `syncTurns:false` 会同时停掉 teardown commit——
这是有意的：它就是官方的「全局只读」总闸，本插件尊重它，不自建第二套开关语义。

## 6. 已知限制（诚实清单）

1. **提交依赖 capture 开关**：dispose 的 teardown commit 被 `isCaptureEnabled` 门控；
   `syncTurns:false` 时投影只写不提交（消息仍在，等下次 commit 周期）。
2. **teardown commit 3s 超时**：OV 远端 ~0.8s，正常裕量足够；失败自动入 pending。
3. **检索价值暂时为零**：K112 —— OV embedding 队列 50% requeue、`memories_extracted.total=0`；
   端到端闭环（写入→抽取→可召回）**待 OV 队列恢复后验收**。本插件先通电写入侧。
4. **peer 依赖启动目录**：伪会话 cwd 默认 `process.cwd()`；dsh 须从 `D:/DSH` 启动
   （`D:/DSH/.openviking/config.json` 已写 `peer.id:"agint"`）。cwd 漂移时用 config `peerCwd` 钉死。
5. **订阅是精确匹配**：总线无 wildcard（v0.8+ 评估中），新 topic 要显式加进 `autoTopics`。

## 7. 验收口径（对应 §6.3 的限制）

- [x] 插件级：`node test/smoke.mjs` 全 PASS（软降级 / kill-switch / 写入链 / 过滤 / 订阅）。
- [ ] 挂载级：老板 safe-update 挂载 + 重启后，`dump-config` 可见本插件。
- [ ] 通电级：`agint_event_bus.json` 出现 `ov.strategy.remembered`；OV 侧出现 `dsh-agint-*` 会话。
- [ ] 闭环级（等 OV 队列恢复）：`dsh-agint-*` 会话 commit 后 `memories_extracted.total > 0`，
      且 `recall()` 能召回自己写入的内容。

## 8. 挂载行（老板 safe-update 用，本文件不自行改 cordis.patch.yml）

```yaml
- insert:
    - id: agint-ov-strategy
      name: ./plugins/agint-ov-strategy/lib/index.js
      config: {}
```
