# Changelog — agint-self-model

## 2026-09-26 — 诊断自激环熔断（修复闭合正反馈环）
- **修复诊断事件风暴的真因（闭合正反馈环）**：A6 订阅 `diagnosis.completed`
  → `selfUpdate()` → 内部回调 `diagnosis.report()` → report() 末尾重新
  publish 同一 topic ⇒ 再次进入本订阅。环上**无重入保护、无深度计数、无熔断**，
  且三处 `catch` 全吞异常（handler `catch{}` / `recomputeObservation` 降级 /
  订阅 `mode:'async'`），所以能一直转下去。
  现场表相：`agint-mutator` **持续输出** `[agint-mutator.observe] diagnosis.completed
  ... observationCount=21681` —— 注意 mutator 是 A6 的旁路观察者，**只 console.log、
  不产生任何报告**，它是「显示屏」不是「源头」，修 bug 别找错插件。
- **`selfUpdate()` 内部有「两处」调用点，只堵一处仍会转**：
  1) `aggregateCapabilityEvidence()`（`windowDays: 7`，算非环境根因占比）
  2) `recomputeObservation()`（`windowDays: 28`，算推理画像）
  ⭐ 两个窗口口径不同，**不是重复调用、不可合并**（这正是端到端测试量到的基线 2 次）。
  故熔断做在 `selfUpdate` 层，按来源统一关掉两条路径。
- **熔断判据取「来源」而非「是否带载荷」**：`trigger === 'diagnosis-completed'`
  ⇒ 本次刷新禁止回调 `report()`，根因分布改取**事件 payload**（就是刚发布的那份
  报告，语义更准，且零新增写路径）。若按载荷有无判定，一条畸形事件就能让环重新闭合。
- **不丢数据**：熔断路径照常写推理画像，只是分布来源从「再查一次」换成「用刚到的
  这份」；`reasoning_profile` 内容与熔断前一致（有测试断言）。
- **可回滚**：新增 `Config.diagnosis_loop_guard`（默认 `true`，K51 出厂即开）；
  置 `false` 恢复 2026-09-26 之前的行为，供回滚 / 对照实验。
- **可观测**：熔断触发时打首条 `console.warn`（后续静默累计，避免风暴期刷屏），
  计数经 `stats()` / `inspectSummary()` 的 `diagnosisLoopGuard: {enabled, trips}` 暴露。
- 测试 `test/diagnosis-loop-guard.test.mjs` **22/22 PASS**，含**端到端闭环对照**
  （真 `report()` 会 publish → 真 bus 分发 → 真 A6 handler）：熔断开时调用次数收敛；
  对照关闭熔断时同一链路失控。后者是证明前者「真抓得住这个 bug」而非碰巧通过的关键。
  回归：`smoke` 19/19、`a7-ingest` 48/48、`real-compat` 10/10，全绿。
- ⚠️ **本改动未覆盖的独立待查项**：`report()` 的 reports 表容量刹车
  （`LIMITS.REPORTS = 50`，`agint-diagnosis/lib/index.js:321`）为何在此前风暴中
  未生效 —— 现场 `observationCount` 远超 50，说明刹车没按预期触发。**未查清，另案。**
- ⚠️ **未验证部分**：静态测试只证明代码路径正确；生产侧事件量是否回落，
  **必须真实重启宿主**后才能观测（参见验收公式：静态 PASS + 宿主端到端 PASS + 真的重启过）。

## v0.7.6 (T2 A7 结算触发修复 · 2026-09-24)
- **修复「批永远不结算」——A7 一致率恒为 null 的真因**：结算原本只在「批切换
  （`generatedAt` 变化）」与 `flush()`（dispose）时触发。但一次采集是在**同一个
  `generatedAt` 下连发多条**，`generatedAt` 从头到尾不变 ⇒ **批永远不会切换**，
  也就永远等不到结算。生产实读：`batches:0 / compared:0 / consistencyRate:null`，
  而事件侧照常在发 —— A7 是唯一已切流量的边，却拿不到任何对账证据。
- **修法：新增空闲结算 `settleIdleMs`（默认 30s，`0` = 禁用）**。批打开后若这么久
  没有新事件流入，视为「这批发完了」→ 自动结算并强制落盘。每来一条事件重新计时。
  ⭐ 选择「空闲超时」而非「让发布端在最后一条事件上打标记」，是因为它**不需要发布端配合**，
  订阅侧单方面即可收批；代价是最多延迟 `settleIdleMs` 才出一致率（对账场景可接受）。
  定时器 `unref()` —— 否则一个挂着的 timer 会吊住进程不让它退出。
- 生产验证前置事实（2026-09-24 23:47）：靠 v0.7.5 新加的 `lastIngestAt` 完成二分 ——
  手动触发一次采集后 `lastIngestAt` 从「09-12 孤本」跳到 `15:45:55`，**证明事件投到了
  订阅方**，排除投递/订阅故障，把问题收敛到结算语义。这就是 v0.7.5 那个诊断字段的价值。
- 测试 48/48 PASS（新增 8 条：超时前后状态 / 批关闭 / 两条都进重建 / 自动落盘 /
  一致率可算出 / `settleIdleMs=0` 保留旧行为）；smoke 19/19 无回归。

## v0.7.5 (T2 A7 对账可观测性修复 · 2026-09-24)
- **修复「落盘只在批切换时发生」导致的观测黑洞**：`createSnapshotIngest` 原先只有
  `settle()`（批切换）与 `flush()`（dispose）会触发 `onPersist`。批迟迟不切换时，
  外部读到的是一份**几周前的死快照**，与「handler 根本没被调用」在数据上无法区分。
  现改为：每收到一条未触发结算的事件也（按 5 分钟节流）落盘一次。
- **新增诊断字段 `stats.lastIngestAt`**（最后一次收到事件的时刻，区别于 `lastComparedAt`
  最后一次结算时刻）。两者组合即可判定停滞性质：
  - `lastIngestAt` 在涨 + `compared` 不涨 ⇒ 收到了，但批切换语义没触发；
  - `lastIngestAt` 也不涨 ⇒ handler 没被调用（订阅/投递侧问题）。
- `bin/t2-reconcile.mjs` 同步：输出 `shadowLastIngestAt`，并新增停滞诊断行
  （拿事件侧最新一条 `occurredAt` 与 `lastIngestAt` 对比，直接给出"疑似未收到"提示）。
- 触发本修复的实读事实（2026-09-24）：生产 `metrics_ingest` 停在 `compared=1`、
  落盘 `2026-09-12T18:15:26Z`，而事件侧 09-13~09-23 仍发了 108 条 `metrics.snapshot`
  ⇒ A7 是唯一已切流量的边，却 12 天拿不到任何对账证据。
- 测试 40/40 PASS（新增 5 条：收到事件即落盘 / 不重复写 / lastIngestAt 三态）；smoke 19/19 无回归。

## v0.7.4 (Sprint 16 / T2 A7 切换) — ⚠️ 本段为 2026-09-24 补记
（package.json 当时已升到 0.7.4，但 CHANGELOG 漏记；内容据 wiki `T2-切边清单.md` §3 摘录。）
- **A7 切流量**：`metricsIngest` 启用 `mode='apply'`，结算批次重建的快照经 `getLastSnapshot()`
  成为 `resource_baseline` 的 `latency-ms` 权威数据源；直连 `metrics.summary()` 保留作对账与兜底。
- **修静默缺陷**：真实存储域热切换漏 `metrics_ingest` 表（v0.7.3 生产落盘静默失败）。
- **修契约 bug**：`agint.metrics` 的 FROZEN 契约只有 `collect()/summary()`，`snapshot()` 从未存在，
  导致 apply 后对账空转（`compared=0/skipped=1`）。改用 `summary()`。
- 重启后手动采集终验：首轮 `compared=1/matched=1`，一致率 100%，`t2-reconcile` 判 A7 PASS。

## v0.7.3 (Sprint 16 / T2 准备件补强)
- **A7 统计落盘**：新增 `metrics_ingest` 单行观测表（id='latest'，spec 仍为 version 1，
  参照 skill-autocreate 加表先例）。影子对账统计经 `onPersist` 钩子节流落盘
  （默认 5 分钟一次 + dispose 强制兜底），`bin/t2-reconcile.mjs` 可在 dsh 进程外
  读到运行时一致率 —— 此前统计只在内存，重启清零且外部不可见，09-25 决策无取数路径。
  影子期「不写业务表」红线不变：capability/reasoning/resource/calibration 四张业务表零写入。
- **flush 挂进 dispose**：此前 dispose 只退订不结算，尾部批次（最多一整批事件）丢弃。
- `maybePersist` 永不抛：落盘失败只吞掉，影子主流程不受影响（测试覆盖）。
- 测试 34/34 PASS（新增 5 个落盘用例）；smoke 19/19 无回归。

## v0.7.2 (Sprint 16 / T2 准备件)
- A7 `metrics.snapshot` 消费方落地（此前订阅方为 0，见 wiki `T2-切边清单.md` §3）。
- 新模块 `lib/metricsIngest.js`：影子对账器 —— 订阅 A7（async，不占 sync 配额），
  按 `generatedAt` 攒批，批切换时用事件重建 snapshot 与直连 `metrics.snapshot()` 对账。
- **影子期纪律**：只记数不写任何表；资源基线权威路径仍是直连（observation.js 不动）。
  `mode='apply'` 留给 T2 拍板后启用，本版不实现写库。
- 判定口径：只判结构不对称（latency 条目单侧缺失）；值漂移仅记录不判定
  （事件批次与直连快照有时差，按值相等判定会让一致率永远不达标）。
- 对账统计经 `inspectSummary()` 的 `metricsIngest` 字段暴露（events / batches /
  compared / matched / mismatched / valueDrift / consistencyRate / lastMismatch）。
- 消费方落点修正：设计稿建议 evolve/dream，实际落 self-model —— 唯一有直连可切
  且在 prod 有流量的位置（observation.js:119 的 `metrics.snapshot()` 直连）。
- 测试：`test/a7-ingest.test.mjs` 28/28 PASS；原 smoke 19/19 无回归。

## v0.7.1 (Sprint 13 / Part 2)
- 全新插件：只读观察者自我模型。
- FROZEN schema：`self-model.schema.yaml`（CapabilityEntry / SelfModelSnapshot / CalibrationResult）+ `self-model-updated.schema.yaml`（A11 payload）。
- 独占存储域 `agint_self_model`（4 表：capability_map / reasoning_profile / resource_baseline / calibration_log）。
- 5 Service：snapshot / update / calibrate / stats / inspectSummary。
- 四大模块：capability（CAN/CANNOT/UNCERTAIN + lastVerifiedAt）、observation（推理画像 + 资源 p50/p90）、calibration（误差 ≤10% 护栏 + cold-start 守门）。
- 事件集成：影子消费 A6 diagnosis.completed / A8 dream.completed；发布 A11 self.model.updated（T1 publish-only）。
- 写路径隔离：禁止 inject/write `qualityPolicy` / `mutator` / `population`（由 `self-model-isolation` 静态检查强制，§4.7）。

## 诚实代价（边界）
- 首版是统计聚合画像，非真元认知；推理链断裂检测复用 diagnosis REASONING_ERROR 特征。
- 资源感知不含系统级测量（只统计工具调用时长/token/上下文）。
- 校准为启发式预测（历史滑动平均），样本 <10 输出 UNCERTAIN。
- A11 payload 在 T1 期影子运行，未经真实消费者检验（Sprint 14 预留 ADJUSTABLE 扩展）。
