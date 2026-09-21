# Known Limitation: 影子发布接线缺口（event-bus shadow-publish gap）

> **状态（2026-09-20 更新）：老板拍板走方案 A —— 接线。本节缺口已按第六节清单接线完成。**
> 保留原文作取证记录；**当前状态一律以第六节为准**。
>
> 建档：2026-09-20。宿主版本基线：v0.7.1。
> 取证方式：源码全库 grep + 生产存储 `agint_event_bus.json` 实测（842 条事件）。
> 关联设计稿：`proposals/agint-mount-integrate-restart.md` §3.9（G10）、
> `AGENTS.md` §工作流 第 7 条。

## 缺口是什么（一句话）

**事件总线的「影子发布」有 3 个服务只注册、从不被生产调用；另有 4 个主题
只有订阅方、没有发布方。** 这两类缺口都不报错、不告警、测试全绿。

## 一、空壳服务（注册了，但只有测试调它）

| 服务 | 注册位置 | 生产调用点 | 唯一调用方 |
| --- | --- | --- | --- |
| `agint.population.publishProposed` | `agint-population/lib/index.js:528` | ❌ 无 | `eval/scenarios/driver.js:262` |
| `agint.population.publishMountRequest` | `agint-population/lib/index.js:529` | ❌ 无 | `eval/scenarios/driver.js:329` |
| `agint.mutator.publishMountRequest` | `agint-mutator/lib/index.js:950` | ❌ 无 | `eval/scenarios/driver.js:328` |

三者在生产侧的调用点数量均为 **0**。全库唯一调用它们的是 D-QAF 场景驱动器
`eval/scenarios/driver.js` —— **测试自己调它，所以测试通过；生产没人调它，
所以影子从未落下。**

### 直接后果

`agint-evolution-memory` 订阅 `evolution.proposed` → 写 `evolution_log`。
该订阅链路的唯一上游 `publishProposed` 无人调用，因此：

- `evolution_log` 的 168 行**不是事件驱动的**（走的是直连 `logPhase4Buffered`）；
- `evolution.proposed` 生产数据仅 3 条，**全部在 2026-09-04，且都是探针消息**
  （source 分别为 `agint-evolution-memory-probe` / `verify-after-fix` / `verify-final`）。

## 二、孤儿主题（有订阅方，无发布方）

| 主题 | 订阅方 | 生产数据 |
| --- | --- | --- |
| `memory.pre-compress-checkpoint` | `agint-compress-guard` | 0 条 |
| `sandbox.failed` | `agint-diagnosis`、`agint-quality-policy` | 0 条 |
| `sandbox.passed` | `agint-quality-policy` | 0 条 |
| `hmr.settled` | `agint-mount` | 0 条 |

这 4 个主题的订阅回调**永远不会被触发**。注意 `agint-mount` 订阅 `hmr.settled`
的 handler 是空函数 `(_env) => { }`，属于占位订阅——影响较小，但同样计入清单。

## 三、对照：真实在跑的链路（12 种主题 / 842 条）

```
292  metrics.snapshot          185  evolution.evaluated
123  memory.provider-activated 111  policy.rolledback
 44  policy.deployed            39  dream.completed
 37  self.model.updated          4  curator.run-completed
  3  evolution.proposed          2  diagnosis.completed
  2  curriculum.boundary-probed  1  dream.rejected
```

**已实证闭环**（订阅 → 落库时间戳吻合）：

- `agint-self-model` 订阅 `dream.completed` / `diagnosis.completed` / `metrics.snapshot`
  → 真实调用 `selfUpdate()` 写库。`capability_map.lastVerifiedAt` = `2026-09-20T05:06:13.350Z`，
  与总线最新 `self.model.updated` 时间戳**完全一致**。
- `agint-metrics` 影子计数 `policy.deployedCount` 有值。
- `agint-trajectory` 订阅 4 条合法主题（count-only 标定期）。

## 为什么这不是 bug，是未完成的接线

`publishProposed` / `publishMountRequest` 的源码注释均标注
「Sprint 12 A1 / A4 **T1 影子期**」，并写明红线：
**「直连路径完整保留」**——bus 侧只是影子副本，主路径继续走直连。

该设计的前提是「影子**会**被发布，只是消费方走异步通路」。实际状况是：
**影子这一侧从未被接入，主路径（`evolve.propose` 直连，生产 55 条提案）单独健在。**

`proposals/agint-mount-integrate-restart.md` 已把这一状态记为待办：

> `agint-event-bus` T2 真正切换 transport（G10）—— 等 T2 切换期
> T1 影子期：publish-only，不切流量；T2 切换后由 event bus transport 替代
> `mountEventBusPublish`（现有 T1 影子期函数）直连。

**但「publish-only」这个措辞有误导性**：它读出「只在发布、尚未消费」，
实际是「**连发布都没接上**」。建议设计稿把该项措辞改为
「shadow-publish **未接线**（service 已注册，调用点待接）」。

## 这个缺口的隐蔽性（值得记住的一点）

四重伪装同时成立，导致常规手段全部失明：

1. **不报错**：软降级设计，`eventBus-unavailable` 静默返回 `published: false`；
2. **无告警**：没人调用 = 没日志 = 监控看不到；
3. **测试全绿**：`driver.js` 覆盖到位，因为**测试自己调用了它**；
4. **面板正常**：`evolution.evaluated` 天天跑，给出「进化在动」的错觉。

→ **「测过」≠「接上了」**。与既有教训「挂载了 ≠ 跑过」同族，但更深一层：
测试的绿灯会让人误以为接线已完工。**「在跑」≠「在产出」。**

## 处置建议（待拍板）

两条路，建议**先扫后决**：

- **A. 接线**：把 `publishProposed` 接入 `evolve.propose` 的调用点，
  补齐 T2 transport 切换。收益 = 订阅侧（quality-eval / evolution-memory /
  trajectory）的异步通路真正可用；代价 = 新增一条需要维护的并发路径。
- **B. 砍掉**：`evolve.propose` 直连已满足需求且生产验证 55 条。
  若判定 bus 路径无独立价值，应**删除 3 个空壳服务 + 4 个孤儿订阅**，
  避免"看似存在的能力"继续误导后续设计与排障。

> 倾向：**先做 B 的判定**——`publishMountRequest` / `evolve.propose` 直连既然够用，
> 多一条影子路径属于未兑现的复杂度。但需老板拍板，因为 A 可能是 P7.5 的既定目标。

## 附：措辞债清理记录（2026-09-20）

本次一并修正了 6 处**具有误导性的现役状态描述**（历史 CHANGELOG 不动，改了等于篡改历史）：

| 文件 | 旧措辞 | 新措辞 |
| --- | --- | --- |
| `AGENTS.md` §工作流 7 | 「prod 当前 T1 影子期」 | 指向本文档的缺口清单 |
| `proposals/agint-mount-integrate-restart.md` §3.9 | 「T1 影子期：publish-only，不切流量」 | 「实际状态」段 + 注明旧措辞已废弃 |
| 同上 L159（G10） | 「接入 T2 切换期」 | +「现状：已发但订阅方为 0」 |
| 同上 L482 / L536 / L584 / L638 | 「（目前 publish-only）」等 | 改为实测状态描述 |
| `plugins/agint-self-model/README.md` | 「（T1 影子期 publish-only）」 | 「影子发布，已接生产」+ 禁用声明 |
| `plugins/agint-quality-eval/README.md` | 「Sprint 12 A1（T1 影子期）」 | 「⚠️ 上游未接线，当前收不到消息」 |
| `plugins/agint-dream.md` ×2 | 「（T1 影子期）」 | 「影子发布，已接生产，有消费方」 |

另修正 1 处**注释与实现脱节**：

- `plugins/agint-self-model/lib/index.js:360` —— 原注释写「audit-only」，
  但 handler 实际调用 `selfUpdate()` **会落库**。已更正为准确描述。

### ⭐ 通用教训

**「publish-only」这类术语是状态判定的陷阱。** 它读起来像
「已完成一半（发布侧 ✅ / 消费侧 ⏳）」，实际上发布侧也可能**根本没接**。
同样地，「T1 影子期」听起来像「正在观察」，实际可能是「从未启动」。

→ **判定接线状态，永远去数调用点与生产数据行，不要读设计稿的措辞。**
一个能自动化的检查：对所有 `ctx.provide('agint.*')` 的服务名，
grep 生产目录（剔除 `test/` 与 `eval/scenarios/`）确认调用点非空。

## 未覆盖/待查

- `mountEventBusPublish`（`agint-mount/lib/orchestrator.js:56`）**有 10 处真实
  调用点**，是三个「影子发布」中唯一接上生产的。但其 7 个 topic
  （`mount.requested` / `succeeded` / `failed` / `restart-*`）**订阅方为 0、
  生产数据为 0 条** → 属于「发了没人收」，与本文档第二节同类，待并案评估。
- 4 个 topic 名的合法性已逐一用 `TopicSchema` 正则验证，**全部合法** ——
  即它们收不到消息**不是** K48 那类「非法 topic 连坐」问题，是纯粹无人发布。

---

## 六、接线处置记录（2026-09-20 · 方案 A）

老板决策：**长远考虑，走 A（接线）**。本节是当前状态的唯一事实源。

### 6.1 已接线（4 处）

| # | 缺口 | 接法 | 位置 | 验证 |
|---|---|---|---|---|
| A1 | `evolution.proposed` 无发布方 | 落库后发事件，`source='agint-evolve'` | `agint-evolve/lib/index.js` propose() | `test/shadow-publish.test.mjs` 4/4 |
| A2 | `mount.*` 六 topic 零订阅方 | 计数订阅 → `agint_metrics` 表 | `agint-metrics/lib/mountCounters.js` | `test/mount-counters.test.mjs` 6/6 |
| A3 | `sandbox.passed/failed` 无发布方 | runVerify/runExplore 每个出口发事件 | `agint-quality-sandbox/lib/index.js` | `test/shadow-publish.test.mjs` 4/4 |
| A4 | `hmr.settled` 无发布方 | settle 成功后发事件 | `agint-mount/lib/orchestrator.js` | `test/bus-resolve.test.mjs` 6/6 |

### 6.2 判定为「不接」并说明理由（1 处）

**`agint.population.publishMountRequest` / `agint.mutator.publishMountRequest` 不接调用点。**

理由不是"没时间"，而是**接上会制造错误数据**：

1. `mount.requested` **已经有发布方** —— `agint-mount/orchestrator.js:190` 在挂载流程起点就发。
   population/mutator 再发一遍，同一件事在总线上出现两条，订阅方无法区分来源。
2. 这两个服务的语义前提是"population / mutator 会主动发起挂载请求"，但**生产里它们根本不发起**
   （`agint-mutator/lib/index.js` 全文除注册处外无 `mount` 字样；population 的
   ingest/promote/cull/fixate/rollback 在 `plugins/**/lib/` 里调用点为 0）。
   给一个没有真实语义的位置接调用点 = 造流量，不是接线。
3. **正解**：等 population / mutator 真需要请求挂载时，应调 `agint.mount.request` 由 mount 统一发事件，
   而不是自己 publish。

→ 两个服务保留，注释已标注备用通道语义。

### 6.3 顺带修掉的两个真 bug（都是排查时挖出来的）

1. **`agint-quality-sandbox/lib/index.js:29` 硬编码依赖路径**
   `import { z } from '../../agint-quality/node_modules/zod/index.js'` —— v0.6.3 把插件从
   `agint-quality/` 剥离到顶层时忘了改，指向一个已删除的目录。
   **后果**：该插件 20 个既有测试里 9 个失败（一直没人修）。改为 `from 'zod'` 后 20/20 通过。
2. **`agint-metrics` disposer 早退**
   `if (domain) return domain.close();` 在 domain 打开后会**跳过** bus 订阅注销。已改为先注销再关闭。

### 6.4 ⭐⭐ 本轮最大的发现：mount 一直在空转（推翻昨日记录）

昨日 K63 写「`mountEventBusPublish` 有 10 处真实调用点，是三个影子发布中唯一接上生产的」。
**这条是错的。** 实际它一条都没发出去：

- 它取 bus 用 `ctx.getService('agint.eventBus')`（**伞键**）；
- 而 `agint-event-bus` 用 spec.provides 注册的是**三个分服务名**
  （`agint.eventBus.publish` / `.subscribe` / `.inspect`，见其 manifest.json:24-28 + lib/index.js:138-151），
  **根本没有伞键** → 恒 `undefined` → 静默降级到 `ctx.emitEvent`；
- 与生产「mount.* 六 topic 0 条」完全吻合。

已改为 `resolveBusPublish()` 三形态探测（分服务名 → 伞键 getService → 伞键 get），订阅侧同理。

> **教训（与 K30/K34 同族）**：「有 10 处调用点」不等于「调用成功」。
> 数调用点只证明**有人喊**，不证明**有人应**。判断接线是否真的通，
> 最终只能看生产存储里的行数。

### 6.5 仍未接线（不在本轮范围）

- **`memory.pre-compress-checkpoint`**：发布方 `runPreCompressCheckpoint` 无生产调用者
  （K33 ⑦），整个 pre_compress 机制从未通电。属于**压缩流程改造**议题，不是总线接线能解决的，
  单独立项。订阅方 `agint-compress-guard` 继续保持占位。

### 6.6 验收口径（下次怎么确认真的通了）

重启后检查生产 `agint_event_bus.json`：

- `evolution.proposed` 条数 > 3（突破 09-04 那批探针）
- `sandbox.passed` / `sandbox.failed` > 0（有沙箱跑过才有）
- `mount.*` 六 topic > 0，且 `agint_metrics` 表出现 `mount.succeededCount` 等 key
- `hmr.settled` > 0（需真实挂载重启才会出现）

> ⚠️ 「改完代码」≠「接线生效」。以上四项**必须读到生产数据行**才算数。

### 6.7 首次验收：2026-09-21 07:52 重启后

**结论：四项仍为 0，但判定为「触发条件未发生」，不是接线失败。**

已满足的条件（证据链）：

| 项 | 证据 |
| --- | --- |
| 插件已挂载 | 4 个插件均在 host `profiles/web/cordis.patch.yml`（32 个插件内） |
| 代码已部署 | md5 对账 6/6 一致；宿主字节级冒烟 4/4 |
| 重启已生效 | 07:52 `agint_event_bus.json` 有写入（`memory.provider-activated` ×1） |
| **同机制旁证** | `agint_metrics` 表 `policy.rolledbackCount` **111** / `policy.deployedCount` **44**，与总线 `policy.rolledback` **111** / `policy.deployed` **44** 条数完全对齐 → metrics 的订阅→计数机制在生产是通的（新增的 mount 订阅走同一条代码路径） |

四项 0 条的原因（每条的第一条数据要等什么）：

- `evolution.proposed` —— 等**有人提一条提案**（`evolve_propose`）。生产既有 3 条全是 09-04 探针。
- `sandbox.passed` / `failed` —— 等**跑一次沙箱**（skill-autocreate 发布技能时会调 `runVerify`）。
- `mount.*` 六主题 —— 等**一次真实挂载**。旁证：`storages/` 下**没有 `agint_mount.json`**，
  说明 `mount.request` 从未真正执行过（不只是发布失败）。
- `hmr.settled` —— 等一次挂载触发重启。

> ⚠️ **顺带推论（待实证）**：`agint-quality-sandbox` 修复前在 host 上是**坏的**
> （`lib/index.js:29` zod 路径指向已删目录）→ 启动即加载失败 →
> `agint.qualitySandbox` 服务缺失 → mount 流程按设计**降级 PENDING_REVIEW**、
> 永不 ACTIVATED。这与「无 `agint_mount.json` + `mount.*` 0 条」互相印证。
> 即：**修 zod 路径可能顺带解锁了整条挂载链路**，不只是修好 9 个测试。
> 实证方式：下一次真实挂载发生时看是否还走 `sandbox-unavailable` 降级。

**下一个可观测点（不需真实挂载事件）**：下次 `metrics-collect` cron 跑
（上次 `2026-09-20T20:00:41Z`）时，`eventBus.syncSubscriptions` 应从 N 变为 **N+1**
—— 我新增了 `agint-metrics` 对 mount 六主题的订阅（1 个 subscriber）。

**最快的硬证据**：在 dsh 里提一条提案（`evolve_propose`），`evolution.proposed` 应立刻 +1。

### 6.8 二次复核：2026-09-21 17:0x（老板问「T2 切流量完成了吗」）

**结论：T2 未实现、未排期；T1 四项仍为 0。** 本次复核新增三条硬事实：

1. **T2 的代码从未存在。** 全库 `plugins/**/lib/*.js` grep `transport` → **零命中**。
   T2 的定义就是「由 event bus transport 替代直连」，故 T2 不是「切了没切」，是「尚未开始」。
   → 请勿把 09-20 方案 A 的**接线**（publish-only，仍属 T1）读成 T2。
2. **T1 四项仍为 0 条**（生产存储 878 条事件、死信 0）：

   | 主题 | 条数 |
   | --- | --- |
   | `evolution.proposed` | **3**（全部为 09-04 探针：`agint-evolution-memory-probe` / `verify-after-fix` / `verify-final`） |
   | `sandbox.passed` / `sandbox.failed` | **0** / **0** |
   | `hmr.settled` | **0** |
   | `mount.*`（六个） | **全 0** |
   | `memory.pre-compress-checkpoint` | **0** |

   → 判定「触发条件未发生」成立，**但 4 处新接线至今未获得任何一次真实执行机会**。
3. **6.7 节留的「下一个可观测点」未兑现。** 文中预期下次 `metrics-collect` 时
   `eventBus.syncSubscriptions` 从 N 变 N+1；实测该指标**近 8 次采样恒为 1**
   （2026-09-16 23:21 → 2026-09-20 20:00），未出现增量。
   `mount.succeededCount` 等新指标**在 `agint_metrics` 表中根本不存在**。

> ⚠️ **推论（证据不足以定论）**：恒为 1 可能是「注册的 sync 订阅确实只有 1 个」（计数器语义），
> 也可能是一次**未被察觉的静默失败**（与本文档主题同类）。**未实测前不得当作已通。**
> 下一步验收口径不变：拿到该指标出现 ≥2，或四项主题出现真实数据行。

> **切 T2 的前置条件（我的建议，待老板定）**：先制造一次真实触发
> （提一条提案 / 跑一次沙箱），读到四项中至少一项 > 0，证明 T1 通路真的通，
> 再讨论用 transport 替代直连主路径。**不要拿一条从未通电的通路去替换天天在跑的主路径。**
