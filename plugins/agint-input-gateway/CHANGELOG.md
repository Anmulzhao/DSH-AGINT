# Changelog

## 0.1.5 — 2026-10-09

修 C4 adversarial 的事件订阅**从未生效**，且 `health()` 报假绿。

### 问题

`lib/channels/adversarial.js` 的订阅注册：

```js
ctx.effect(() => { try { disposer(); } catch {} });   // ❌ 少一层箭头
```

`ctx.effect(fn)` 会**立即执行** `fn`，且只有 `fn` **返回函数**时该函数才被收集
为 disposer（cordis `src/fiber.ts:363-372`：`execute` 立即调用，
`typeof effect === 'function'` 才 `collect`）。原写法的函数体直接调用
`disposer()` 并返回 `undefined`，于是：

1. 订阅在 `initSubscriptions` 执行的那一刻就被自己撤掉；
2. 没有任何 disposer 被收集，卸载路径也无从清理。

**运行时旁证**：`eventBus_deliveryByTopic` 的 `orphanSubscriptions` 里有 4 个
`diagnosis.completed` 订阅者（`agint-mutator` / `agint-ov-strategy` /
`agint-self-model` / `agint-trajectory`），唯独没有
`agint-input-gateway/adversarial`。bus 的孤儿判据是「订阅的所有主题都无投递」，
而它那三个主题从未 publish —— 它本该在列表里，不在即说明没进订阅表。

**假绿**：`_subscribed = true` 在退订之前置位（`adversarial.js:178`），之后再无人
改回。`health()` 因此报 `status:ok` / `initError:null` / `detectors` 三项全
`active:true`，而实际功能整个瞎。生产数据佐证：`ingestedSignals` 为 0。

**测试为何没抓到**：`test/adversarial.test.mjs` 的 fake ctx 有两处失明 ——
`subscribe` 返回 `() => {}`（空 disposer）、`effect: () => {}`（不执行传入的
函数）。全文件 108 行测试全绿，而订阅在生产上从未生效。

### 改动

- `lib/channels/adversarial.js`：改为 `ctx.effect(() => () => { try { disposer(); } catch {} })`，
  与同插件 `lib/index.js` 的写法一致。
- `test/adversarial.test.mjs`：fake ctx 按 `fiber.ts:363-372` 复刻 `effect` 语义，
  `subscribe` 返回真退订 disposer；新增 2 条回归断言（订阅在初始化后仍存活 /
  卸载路径能退订）。

### 验证

- 全量 58 项 fail 0；`adversarial.test.mjs` 10/10。
- **注入 bug 后 8/10 变红**（含核心回归那条）—— 证明测试不是自证通过。
- lint 与基线一致（K19×1 / manifest×4 / package.json×1），无新增 FAIL。
- `check-wiring` PASS：58/58 双副本一致、248 个 lib 文件同步。
- BOM（`efbbbf`）与文件尾换行均未被编辑工具改动 —— 该文件带 BOM，
  编辑后逐字节核对并还原（diff 12 insert / 1 delete）。

### 仍未解决

订阅修好后，`diagnosis.completed` / `curriculum.challenge-verdicted` /
`curriculum.boundary-probed` 三个主题在 eventBus 上仍无 publisher（全量 eventBus
只有 `ov.session.flushed` / `memory.provider-activated` / `ov.recall.checked` 三个
topic）。即「订阅通了，但上游没人发」——属 event bus 转正议题，单独排期。

## 0.1.4 — 2026-10-06

本批做两件老板拍板的事：H1（adversarial 跨重启丢信号）方案②、C5 方案 B（sync-proposal 提案信号）。另修两处口径不一致。

### H1 方案②：事件到达即投，删内存队列

**根因**：adversarial 把订阅到的事件放进模块级内存 `_queue`，靠 `fetch()` 定期 drain。
重启清空队列 ⇒ drain 周期（周/日）与重启之间的窗口，事件永不可见。
生产实证：`diagnosis.completed` 全历史 37 条、`curriculum.boundary-probed` 5 条，
通道 drain 跑 7 次 `signalsEmitted=0`（`~/.dsh/storages/agint_input_gateway.json`），
2 个主题的信号因重启丢了（待做清单 H1）。

**改法**（老板 2026-10-06 拍板「按顺序直接执行」，选项②优于①：上游低频，攒批无收益）：

- `lib/channels/adversarial.js`：删 `_queue`；订阅回调改为在事件到达时直接调
  `gateway.ingestImmediate(CHANNEL_ID, [sig])`。签名新增第三参 `gateway`，缺它即
  `degraded` 且不吞事件（fail-visible，不静默）。
- `lib/gateway.js`：新增 `ingestImmediate(channelId, signals)` —— 复用 `processSignals`
  全管线（security → 置信 → 去重 → 噪声 → 配额 → 发布），计数即时持久化。
  不占 `fetchCount`（即投不是 fetch）。
- `lib/index.js:122`：`initSubscriptions(ctx, cfg)` → `initSubscriptions(ctx, cfg, gateway)`。
- `fetch()` 保留为空 drain ⇒ 通道在 `channel_status` / `getStatus()` 仍有心跳，观测面不变。
- 丢失窗口从「drain 周期 × 重启频率」缩到毫秒级；重启后的事件重放由 dedup 表拦（新增用例锁住）。

### C5 方案 B：新增 `cross-agent.sync-proposal` 提案信号

`cross-agent.js` 增第 4 个子源：把 OV 检索到的外部 preset 条目发成提案信号
（`items[]` = entryId/title/source）。**通道仍不写 OV、不写 preset** —— 采纳动作留给
agent/老板（自动双向同步与 P8 校准「团队能力用 dsh 官方的」冲突，本轮未做，见
`docs/agint-input-gateway-未竟方案论证-20261006.md` §2）。
新增状态位 `state.proposedEntryIds`（滚动 100 条）保证同一条目只提案一次。
`KNOWN_TOPICS` 补 `input.signal.cross-agent.sync-proposal`。

### 顺带修的两处口径不一致

1. **adversarial cron 双口径**：通道声明 `0 3 * * 0`（周日），调度器实跑 `C4_CRON`（每日 03:30）。
   `_tick()` 用**通道字段**算下一次时间 ⇒ 首轮 fetch 之后节奏会漂成周频。现统一取 `C4_CRON`。
   与 playbook §3.13「第二套时间口径」同族。
2. **cross-agent 主题名与枚举不符**：`_buildTopic` = `input.signal.<channelType>.<signalType>`，
   旧 `signalType='cross.agent.diff'` 实发成 `...cross-agent.cross-agent-diff`，
   与 `KNOWN_TOPICS`（订阅面/面板的参照）不符 —— 生产已实证 1 条
   `input.signal.cross-agent.cross-agent-pattern`。改发布侧对齐枚举：signalType 去前缀
   （`diff` / `pattern` / `sync-proposal`）。无订阅方受影响（全历史仅 1 条，且无人订 cross-agent）。

### 噪声抑制隐性封死（同批修）

`processSignals` 第 5 步计数从不按时间复位 ⇒ 同一 `source:signalType` 在一个 boot 内累计
到 5 条后**永久**被过滤，与注释宣称的「1h 滚动窗口」不符。改为 `{count, windowStart}`
滚动窗口。影响面：即投模式下更关键（事件不再攒批，长期运行的 boot 会先撞这个上限）。
新增用例：窗口滚动后同键必须重新放行。

### 测试

- 新增 `test/adversarial.test.mjs` 8 用例（即投四类事件/过滤条件/dedup 重放/counters 即时落盘/cron 口径/fetch 心跳）。
- 新增 `test/cross-agent.test.mjs` sync-proposal 用例；原 4 用例断言随 signalType 改名更新。
- `test/gateway.test.mjs` 加噪声窗口复位用例。
- 全量 `node --test "test/*.test.mjs" test/smoke.mjs` → 56/56 通过（改前基线 46，实测于 stash 回退态；本批 +10：adversarial 8、sync-proposal 1、噪声窗口复位 1；另有 4 条 cross-agent 断言随 signalType 改名更新）。

## 0.1.3 — 2026-10-05


### manifest 删 `agint.memory` 悬空声明（纯契约，无代码改动）

**依据（这次是白纸黑字的反证，不是「找不到用法」）**：本插件的分工从来是「只发事件、不自己消费」——

- `lib/gateway.js:8`：「不自己消费信号（memory/evolve/dream 通过 eventBus subscribe 消费）」；
- `README.md:12` 管道图：`Channels → Gateway → eventBus → memory/...`；
- `CHANGELOG.md:98`（0.1.0 P0 边界）：「不修改 memory/evolve/dream 的消费端订阅」；
- 对端**早已实装**：`plugins/agint-memory/lib/index.js:206-228` 订阅 8 个 `input.signal.*` 主题自动沉淀记忆；
- 本插件唯一的取服务点是 `lib/index.js:67` 的 `ctx.get('agint.eventBus.publish')`，`_publish` 也只有总线一个出口。

所以 optionalInject 里那行 `agint.memory` 若真去补接线，效果是同一条信号写两份记忆，直接违背上面的分工。
判据出处：家族面板 0.2.4 起把「声明了却从不取用」的键列为悬空声明（见 `plugins/agint-family-panel/CHANGELOG.md`）。

## 0.1.2 — 2026-10-03

> 生产故障修复：CountersSchema 的 security* 三字段此前为 `.optional()`，只认 undefined 不认 null；
> 生产 adversarial 记录的 security* 字段值为 null（非字段缺失），导致整域 open 失败、gateway 空转。

### 修复

- **CountersSchema security* 改 `.nullish()`**（`lib/storage.js`）——生产 `counters.adversarial` 的
  `securityScanned/securityFlagged/securityDropped` 曾写成 `null`（security 门禁落地期间写入），
  `.optional()` 校验拒绝 null → `dsh-storage-domain` open 整体失败 → input-gateway 未初始化
  （4 通道未注册、调度未启动，`input_gateway_status` 返回 fallback channels=0）。
  改为 `.nullish()`（同时接受 undefined 与 null），并对现场存储数据做 null→0 修正
  （备份 `agint_input_gateway.json.bak-20261003-124612`，无 BOM 写回）。
- **补回归测试**（`test/storage-schema.test.mjs`）——新增「生产 adversarial 旧记录（security* 为 null）可解析」
  用例；红绿自证：改前红（5 选 4 过 1 红）、改后全绿（5/5），全量 46/46 通过。

## 0.1.1 — 2026-09-29

> 0.1.0（`8dee9a9`）之后至今的改动，此前未记录，一并补上；本轮定稿为 0.1.1。

### 新增

- **C2 sessionIntegrity 检测器实装**（`lib/channels/self-observation.js`）——0.1.0 留接口 P1 实现
  - `detectSessionIntegrity`：zstd 解压最近 8 个会话（复用 agint-session-extract 探测逻辑），检测坏行 / seq 断裂 / 缺 content / 未配对 call，产出 session-integrity 信号
  - 导出 `listRecentSessions` / `inspectSessionFile` 供复用与测试；zstd 缺失软降级返回空
  - `health()` 更新为 `active: true`
- **security 模块**（`lib/security.js` 新建）：8 条外部信号 prompt injection 规则（中英指令劫持 / 覆盖 / 身份劫持 / 系统提示词探测 / 伪造标签 / 紧急施压）
  - `checkExternalText` / `checkSignal` / `getSecurityRules` 导出
  - gateway 流程插入 2.5 security 门禁：`securityAction=flag`（默认，命中标记放行）/ `drop`（命中丢弃）/ `off`（跳过）；检查范围 external / adversarial / cross-agent 三类外部信号
  - 计数面 `securityScanned/securityFlagged/securityDropped` + `getStatus().security{action,ruleCount,checkedTypes}`
- **C5 跨 Agent Channel**（`lib/channels/cross-agent.js` 新建）：OV 检索增量 diff + 会话聚类 pattern + 跨 preset 只读概览
  - 增量去重状态 `DSH_HOME/storages/agint_input_gateway_cross_agent_state.json`
  - 调度 `C5_CRON=0 5 * * 0`（每周日 05:00）
- **adversarial 空壳事件转发**：`forwardEmptyDiagnosis=true`（默认）时 clusterCount=0 空壳 diagnosis 事件转发为 `counterfactual-empty-<reportId>` 信号（影子期诊断链空转可观测）
- schema/storage 扩展：`CHANNEL_IDS.CROSS_AGENT`、`KNOWN_TOPICS` 加 cross-agent.diff/pattern、`ConfigSchema.securityAction/forwardEmptyDiagnosis`、CountersSchema 加 security* 计数

- **C4 对抗挑战 Channel**（`lib/channels/adversarial.js`）——0.1.0 的「不做什么」把 C4 列为 P2，本次提前落地
  - 订阅 `diagnosis.completed` / `curriculum.challenge-verdicted` / `curriculum.boundary-probed`，只转发失败与不可验证边界
  - 入队条件：`clusterCount > 0` / `result === 'fail'` / `unverifiable` 非空；不满足者静默丢弃
  - cron `30 3 * * *`（每日 03:30），排在 C2 `0 2 * * 0` 之后、C3 `0 4 * * 0` 之前
  - `health()` 自报 `status` / `initError` / `queuedSignals` / `detectors`

### 修复

- `inject` 补 `agint.compressGuard`——此前压缩丢失子源恒为空（`6155611`）
- `optionalInject` 补 `agint.eventBus.subscribe`（`bc92c21`）及 `publish`（`ff620ee`）
- adversarial 的 `_subscribed` 移到 `subscribe()` 成功后才置位——取到函数不足以说明订阅成立，否则 `health()` 假绿（`ff620ee`）
- `getChannelStatus` 附加 Channel 自报 `health`（`babbda4`）
- `input_gateway_channel_status` 的 render 输出 `health` 段——gateway 已挂上该字段但工具未渲染，导致 `initError` 不可见，订阅失败与成功在输出里无法区分（`5553e5f`）
- 注册 Channel 改用 `emptyChannelState` 替代手工构造（`c10e469`）

### 已知问题

- `package.json` 的 `exports` 未列出 `./lib/channels/adversarial.js`（C4 落地时漏更），按该子路径 import 会解析失败
- adversarial 的真实总线投递未验证：其三个订阅 topic 在生产总线上尚无发布记录，handler 逻辑已单测覆盖（23 项），端到端投递待验

## 0.1.0 — 2026-09-29

### 新增

- **agint-input-gateway** 插件 v0.1.0（P0）：多源输入网关核心框架
  - Gateway 七模块：scheduler / normalizer / filter / router / quota / security / observability
  - C2 系统自观测 Channel（5 子源）：
    - toolStats 异常检测（失败率 >30% 触发信号）
    - metrics 退化检测（错误计数 >10 触发信号）
    - 规则高频命中（deny 规则 ≥10 条报告）
    - 压缩丢失（调用 agint.compressGuard.stats() 检测 BLOCKED/DEGRADED）
    - session 完整性（P0 留接口，P1 实现）
  - eventBus 集成：信号归一化为 `input.signal.<channelType>.<signalType>` topic 发布
  - 软降级：eventBus 不可用时静默，不影响主流程
  - publish accepted 检查：历史教训（skill-autocreate 不检查导致静默丢弃）
  - 去重：24h 滚动窗口，channelId+signalId 唯一
  - 噪声抑制：同 source+signalType 1h 内最多 5 条
  - 配额：每 Channel 日上限（C2 默认 50 条/日）
  - payload 截断：超过 2KB 自动截断为 summary

- **6 个 model 工具**：
  - 只读：`input_gateway_status` / `input_gateway_channel_status`
  - 写操作（ask 门禁）：`input_gateway_force_fetch` / `input_gateway_set_quota` / `input_gateway_channel_enable` / `input_gateway_channel_disable`

- **存储域**：`agint_input_gateway`（4 表：config / counters / dedup / channel_state，schemaVersion 1）

### 设计决策（v1.1 方案确认）

- Q1=B：人类意图不经过 Gateway，反馈旁路发布
- Q2=C：Channel 初评 relevance，Gateway 调整
- Q3=C：主动拉为主，事件驱动用推送（P0 全拉模式）
- Q4=B：写操作工具 P0 即暴露，走 rule_check ask 门禁
- Q5=A：payload ≤2KB

### 不做什么（P0 边界）

- 不接 C3 外部世界（git/web/依赖）——P1
- 不接 C4 对抗挑战——P2
- 不接 C5 跨 Agent/OpenViking——P3
- 不修改 memory/evolve/dream 的消费端订阅——P1
- security 模块为接口预留（C2 是内部信号，不需要 rules 门禁；P1 C3 外部信号启用）
