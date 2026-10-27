# Proposal: 事件总线接线盲区 —— 5 个应接入未接入的插件

> **状态**：⭐ **B1 / B3 / B4 / B5 已完成并上线（2026-10-26）** —— 见 §9 执行结果。
> B2（`agint-restart`）未在本轮范围。工作项 A（门禁加查 E'）已于更早批次落地，
> `check-wiring` 现有「查 E'：总线零感知」即为该工作项产物。
> 原状态：草案（draft） · 类别 `plugin` · **未提交** evolve plugin runtime storage
> **目标插件**：`agint-rules` / `agint-quality-contract` / `agint-restart` / `agint-abtest` / `agint-wiki` + `bin/check-wiring.mjs`
> **作者**：智进（agint preset 会话） · **日期**：2026-10-09
> **风险等级**：P1（新增 topic 与发布调用点，不改 FROZEN 的 EventEnvelope/Subscription schema；不动门禁边语义）

---

## 0. 结论先行

**`node bin/check-wiring.mjs` 当前报 `0 硬缺口 / 2 未触发 / 2 域从未通电 / PASS`，但这个 PASS 不足以支撑「总线接线已完成」的结论。**

原因是门禁有一个**结构性盲区**：它只检查**已经声明过**的主题（订阅注册 / publish 调用点），
一个「应该发布事件却连主题都没声明」的插件，在它眼里**根本不存在**。

本次盘点出 **5 个这类插件**，其中 3 个的缺失是总线自己的设计文档点名要求的：

| # | 插件 | 缺失性质 | 优先级 |
|---|---|---|---|
| 1 | `agint-rules` | README 点名的 sync 门禁边三方之一，实际零接线 | **P1** |
| 2 | `agint-restart` | 已有 P0 草案要求接总线，仍未接；metrics 已在等它的事件 | **P1** |
| 3 | `agint-quality-contract` | README 点名的 sync 边界三方之一，实际零接线 | **P2** |
| 4 | `agint-abtest` | 零接线 **且** 存储域从未通电（插件整体没跑过） | P2 |
| 5 | `agint-wiki` | 知识层写入在总线上完全无痕迹 | P3 |

**建议先做「工作项 A：给门禁加一查」**（成本低、收益是把盲区变成可回归的缺口），
再按 1→2→3 顺序接线。**不建议一次性铺开五个插件** —— 理由见 §5。

---

## 1. 背景与动机

### 1.1 门禁的判定口径

`bin/check-wiring.mjs` 的「查 B/C：主题接线 × 生产数据」以 **topic 字符串**为索引，
从订阅注册与 publish 调用点两侧收集 topic，再与生产存储的行数对账。
输出里 `DATA_ONLY` / `EXEMPTED` / `PUBLISHER_DYNAMIC` / `OK` / `NOT_YET_FIRED` 都是**已有 topic 的状态**。

⇒ **一个从未出现过的 topic 名，不会产生任何一行输出**，无论它该不该存在。

### 1.2 这不是理论风险，是已经发生过的真实事故

`docs/known-limitations/event-bus-shadow-publish-gap.md` §6.4 记录的 K63 同族教训：
「有 10 处调用点」不等于「调用成功」；§6.14 记录「外部直写不算落库」。
本提案要补的是同一族的**更早一步** —— 连调用点都没有，因此连「数调用点」这种验收都无从谈起。

---

## 2. 现状取证（2026-10-09 实测）

### 2.1 生产侧基线

| 观测项 | 值 | 来源 |
|---|---|---|
| 生产事件总数 | **12398**（死信 0） | `bin/check-wiring.mjs` |
| 宿主 bootAt | `2026-10-09T04:13:41.549Z` | `/api/agint-family/v2/data` → `subscriptions.bootAt` |
| 运行时订阅总数 | **17**（sync **1** / async 16），全局 sync 上限 3 | 同上 |
| 门禁结论 | `0 硬缺口 / 2 未触发 / 2 域从未通电` → **PASS** | `bin/check-wiring.mjs` |

### 2.2 五个目标插件的 eventBus 引用数

```
agint-rules                refs=0
agint-restart              refs=0
agint-abtest               refs=0
agint-wiki                 refs=0
agint-quality-contract     refs=0     <- 真实路径见下方警告
```

（口径：`grep -rl "eventBus" plugins/<p>/lib/` 命中的文件数，剔除 `agint-event-bus` 自身。）

> ⚠️ **路径陷阱（写代码前必读）**：`agint-quality-contract` 的**真实源码**在
> `plugins/agint-quality/agint-quality-contract/lib/index.js`（提供 `agint.quality`），
> 由 `cordis.patch.yml:125` 以该路径挂载。
> 顶层 `plugins/agint-quality-contract/` **只剩 `node_modules/`，无源码、无 manifest**，
> 是 v0.6.3 插件剥离后的残留壳。
> ⇒ 按顶层路径 grep 会得出「该插件不存在」的错误结论（本次盘点第一轮就踩了，已更正）。

### 2.3 逐项证据

#### ① `agint-rules` — 总线文档点名的门禁边，实际缺席

`plugins/agint-event-bus/README.md` 写明：

> sync 模式仅限**门禁边专属**（quality-contract / **rules** / evolution-memory 之间）

而全系统**唯一**的 sync 订阅是：

```
agint-quality-policy  [sync]  topics=[evolution.evaluated]   deliveries=0
```

⇒ 三方里只有 quality-policy 侧在跑，**rules 从未参与过 sync 边**。

rules 目前的跨插件消费是**硬编码直连**：

```
plugins/agint-evolve/lib/index.js:234      const rules = ctx.get('agint.rules');
plugins/agint-metrics/lib/service.js:47    rules: ctx.get('agint.rules'),
```

⇒ 规则集变更（尤其 deny 门禁增删）对下游是**不可见**的：evolve / metrics 只能在被调用时
现场拉一次快照，没有变更通知、没有 traceId、无法归因。

#### ② `agint-restart` — 订阅方已就位，发布方不存在

`agint-restart/lib/index.js:859-860` 提供：

```
agint.restart          { detect, status, request, cancel }
agint.restart.detect   detect
```

事件总线侧，`agint-metrics` **已经订阅**了它应该发的三个主题：

```
agint-metrics  [async]  topics=[mount.requested, mount.succeeded, mount.failed,
                             mount.restart-requested, mount.restart-completed, mount.restart-failed]
```

但 `agint-restart` 自身 **eventBus 引用为 0**，一个事件都不发。

且 `proposals/agint-mount-integrate-restart.md`（P0 草案，作者 MiniMax，**2026-09-16 至今未动**）
正是要求把 mount 与 restart 接起来 —— 与本提案同向。

> 判据补强：**宿主重启会摧毁总线全部内存态**（订阅表 + 环形缓冲，`disposeBus()` 清空）。
> 「重启」是全系统里最该事件化、也最不能靠进程内通知传递的事实。

#### ③ `agint-quality-contract` — 点名的边界方，零接线

真实路径 `plugins/agint-quality/agint-quality-contract/lib/index.js:246` 提供 `agint.quality`，
全文件 **eventBus 引用 0**。作为 README 点名的 sync 边界三方之一，它当前对总线**完全无感知**。

#### ④ `agint-abtest` — 零接线，且插件整体从未通电

- eventBus 引用 **0**
- 存储域文件 **不存在**：`AGINT-data/storages/agint_abtest.json` 无此文件
- 门禁「查 D：存储域通电」判定：**DEAD** —— 声明于 `plugins/agint-abtest/lib/index.js:74`

⇒ `agint.abtest.start / report` 的 A/B 结论**从未产生过**，更谈不上送达 quality-eval 或 metrics。
**注意**：本项在「接线」之外还缺「通电」这一层，**接线不等于修复**。

#### ⑤ `agint-wiki` — 知识层在总线上无痕迹

eventBus 引用 **0**。`agint.wiki`（`plugins/agint-wiki/lib/index.js:88` 提供）的写入
不产生任何事件 ⇒ 没有任何插件能对 wiki 变化做反应（如 quality-eval 无法消费
`wiki.contradictions` 一类信号）。

> 旁证（**独立议题，不在本提案范围**）：另据 `待办核销报告-20261009.md` 第三节，
> 生产 wiki root 指向空目录，真内容在 `wiki/AGINT/`，导致 `wiki.contradictions` / orphan 指标恒 0。
> 那是配置问题，**即使修好配置，没有订阅方这些指标依然不会被总线送到任何地方** —— 两件事分开记账。

---

## 3. 反向缺口（同时记录，避免只盯「没接的」）

本次一并测了「接了但收不到」的方向，结果如下（**⚠️ 有重要限制条件**）：

| 观测项 | 值 |
|---|---|
| 本 boot 发布 / 投递 | 23 / **1** |
| 17 条订阅中零投递的 | **16** |
| 确认的孤儿发布方（发了无人订阅） | `ov.recall.checked`、`ov.session.flushed` |

> ⚠️ **不得过度解读**：宿主 `04:13:41` 才启动，取数时仅运行约 24 分钟。
> 「16 条订阅零投递」在如此短的窗口内**主要是流量不足**，不能据此断言这 16 条订阅已损坏。
> 真正可信的只有两条：**确认的孤儿发布方**（`ov.recall.checked` / `ov.session.flushed`）。
>
> 这也正是 §6 验收口径要求「跨一个完整业务周期再看」的原因。

**这一节不构成接线工作项**，单独记账，避免与本提案的五个插件混为一谈。

---

## 4. 方案

### 工作项 A（先做）：给门禁加一查 ——「查 E'：已挂载但总线零感知的插件」

在 `bin/check-wiring.mjs` 增加一查，判定规则：

1. 集合一 = host 已挂载的 `agint-*` 插件（从 `AGENTS.local.md` / `cordis.patch.yml` 取）
2. 集合二 = 对应 `lib/` 下 **eventBus 引用数 = 0** 的插件
3. 集合三 = 上面两个集合里，**manifest 或 `ctx.provide` 声明了跨插件 service** 的（纯工具插件豁免）
4. 输出 集合三 − 豁免清单 ⇒ 这就是「应接入未接入」名单

豁免走现有 `docs/wiring-exemptions.json`，**必须写全三件事**（该文件已有的规则）：
`reason`（为什么不接，一句话讲清因果）/ `evidence`（出处）/ `since`（判定日期）。

> 价值：把本次这种「靠人工盘点才发现」的盲区，变成**每次跑门禁都会复现的缺口**。
> 成本：一个新查法 + 一份豁免清单，远低于逐个插件接线的成本。

### 工作项 B（按序）：逐插件接线

| 序 | 插件 | 建议新增主题 | 建议模式 | 备注 |
|---|---|---|---|---|
| B1 | `agint-rules` | `rules.changed` | 发布 async；门禁边按需 sync | 先发 async 观察，**sync 配额（全局上限 3，当前用了 1）不要一次占满** |
| B2 | `agint-restart` | `restart.requested` / `restart.settled` | async | 与 `proposals/agint-mount-integrate-restart.md` 合并推进，避免两次改同一处 |
| B3 | `agint-quality-contract` | 视 B1 结果定 | — | 先确认它是否真需要事件，还是只需 B1 的订阅侧 |
| B4 | `agint-abtest` | — | — | ⚠️ **先修通电，再谈接线**（见 §5.2） |
| B5 | `agint-wiki` | `wiki.updated` | async | 低优先级；注意 §2.3⑤ 的配置问题分开修 |

**接线纪律（沿用既有教训，不重犯）**：

- 发布侧一律走 `resolveBusPublish()` 三形态探测（分服务名 → 伞键 getService → 伞键 get），
  **不得**只查伞键 `agint.eventBus` —— §6.4 的 K63 同族事故就是这么来的。
- **保留原有 `ctx.emitEvent` fallback**，本提案**不涉及 T2 切流量**（T2 未实现、未排期，见 gap 文档 §6.10）。
- bus 不可用时**静默降级**，不得让总线故障阻断主业务路径。

---

## 5. 风险与红线

### 5.1 红线（不得触碰）

- ⛔ **不改 FROZEN schema**：`EventEnvelope`（8 字段）/ `Subscription`（5 字段）保持冻结，
  新增 topic 名不构成 schema 变更，但**不得**为接线便利增删字段。
- ⛔ **不切 T2 流量**：主路径继续直连，总线保持影子/双轨形态。切流量需老板单独签字。
- ⛔ **不动 `dsh` 安装目录**；本提案全部改动落在本仓库。
- ⛔ **不评估自己**：接线验证不得引入 `agint.qualityEvaluator` 自评。

### 5.2 明确不做 / 做不到的事（如实声明）

1. **`agint-abtest` 接线 ≠ 修复**。它的存储域从未打开，接上事件发布也只是发布一个
   永远不会触发的事件。**通电是前置条件**，本提案只登记该依赖顺序，不承诺接线能带活它。
2. **接线完成 ≠ 通路可用**。gap 文档 §6.7 / §6.9.2 / §6.11.3 已反复证明：
   「订阅注册成功」≠「handler 收到」≠「落库可查」。
   本提案的验收必须落到**生产数据行**，不能只跑测试。
3. **本提案不承诺 sync 配额用满**。全局上限 3、当前已用 1，剩余 2 个位置留给真正的门禁边。

---

## 6. 验收口径（怎么确认真的通了）

### 工作项 A

```
node bin/check-wiring.mjs
```

- 新查 E' 必须能**复现本提案列出的 5 个插件**（先证明盲区存在）；
- 加入豁免清单后 E' 转绿，且豁免条目三要素齐全。
- 回归：现有 A/B/C/D/E/F/G/H/I 九查结论**不得因本次改动而变化**。

### 工作项 B（每个插件）

必须**同时**满足，缺一不可：

1. `subscriptions.entries` 里出现该订阅方，且 `deliveries > 0`；
2. 生产 `agint_event_bus.json` 的 `tables.events` 能 grep 到对应 topic 的 envelope；
3. `tables.deadletter` **0 行**新增；
4. 重启一次后**再次核对** —— 外部直写会被宿主内存态回滚（gap 文档 §6.14），
   写入方必须是**生产进程本身**，否则只算「磁盘暂存」。

> ⚠️ 时间窗：本次取数时宿主仅运行 24 分钟即出现「16/17 零投递」。
> **验收必须跨一个完整业务周期**（至少一个 cron 周期），否则会把「流量不足」误判成「接线失败」。

---

## 7. 未覆盖 / 待查（如实列出，不含糊）

1. **`agint-quality-contract` 是否真需要发布侧** —— 未定。本提案只确认它「零感知」，
   它在 sync 边界里究竟该当发布方还是纯订阅方，需读 D-QAF 设计文档后再定。
2. **`agint-wiki` 的配置问题**（root 指向空目录）**不在本提案范围**，见 §2.3⑤。
3. **弱候选未逐个论证**：`agint-mascot` / `agint-tool-stats` / `agint-search-tools` /
   `agint-session-extract` / `agint-quality-static` / `agint-quality-sdk` / `agint-quality-report`
   同样 eventBus 引用为 0，但**暂无跨插件语义刚需**，本提案**不主张**接线。
   它们将在工作项 A 的 E' 查中浮现，由豁免清单显式收口。
4. **孤儿发布方**（`ov.recall.checked` / `ov.session.flushed`）**另案**，见 §3，未纳入本提案工作项。

---

## 8. 关联

- `docs/known-limitations/event-bus-shadow-publish-gap.md` —— §6.4（伞键探测事故）、
  §6.5（`memory.pre-compress-checkpoint` 豁免被证伪的先例）、§6.7（验收口径）、
  §6.10（T2 未实现）、§6.14（外部直写不算落库）
- `docs/wiring-exemptions.json` —— 工作项 A 的豁免清单落点
- `plugins/agint-event-bus/README.md` —— sync 模式「门禁边专属」定义（FROZEN 语义来源）
- `proposals/agint-mount-integrate-restart.md` —— 与工作项 B2 同向，应合并推进
- `待办核销报告-20261009.md` 第三节 —— wiki root 配置问题（独立议题）

---

## 9. 执行结果（2026-10-26）

### 9.1 工作项逐条

| 序 | 插件 | 结果 | 落点 |
|---|---|---|---|
| A | `bin/check-wiring.mjs` 加查 E' | ✅ **已于更早批次完成** | 现输出「查 E'：总线零感知（已挂载 + 提供跨插件服务，却从不碰事件总线）」 |
| B1 | `agint-rules` | ✅ 发布侧 10-09 已在（生产 2 条）；本轮**补订阅侧** | `agint-metrics/lib/eventCounters.js` |
| B2 | `agint-restart` | ⬜ **未做**（不在 2026-10-26 的 4 处缺口内） | — |
| B3 | `agint-quality-contract` | ✅ 发布 `quality.contract.violated`（**仅** L0 拒绝分支）+ 订阅 | 同上 |
| B4 | `agint-abtest` | ✅ 发布 `abtest.started` / `abtest.concluded` + 订阅。⚠️ **通电仍未做**（见 §5.2-1） | 同上 |
| B5 | `agint-wiki` | ✅ 发布 `wiki.updated`（write/remove 落盘后）+ 订阅 | 同上 |

**订阅侧统一落 metrics 而非各业务插件**：5 条主题共用一个模块、一张表，
理由是 metrics 已是全系统遥测出口（policy.* / dream.rejected 同形态），
这样「规则改了没 / wiki 写了没 / 契约被拦了没 / A/B 出结论没」能用同一条
`metrics_series` 并排看。

### 9.2 门禁前后对照

| 观测项 | 前 | 后 |
|---|---|---|
| 硬缺口 | 4 | **0** |
| 查 E' 零感知 | 3 | **0** |
| `rules.changed` | `NO_SUBSCRIBER`（1 发 / 0 订 / 2 条） | **`OK`**（1/1 / 2 条） |
| 查 H 仓库↔部署位 | 9 待上线 + 3 仓库独有 | **已全部同步** |

### 9.3 §7.1「quality-contract 到底该发还是该订」—— 已定：**只发违例**

读 D-QAF 设计后判定：它**不需要**发「调参成功」（L1 调参已写 `agint.memory` 审计，
那条通路完整），也**不该**做纯订阅方（它没有需要响应外部状态的行为）。
唯一值得上总线的时刻是 **L0 守卫拒绝** —— 因为 `validatePatch` 不通过即 throw，
`memory.write` 根本没执行，错误随调用栈消失。

### 9.4 本轮暴露的两个新问题（未修，已记账）

1. **文本扫描型门禁会被抽象写法骗瞎**：订阅写成 `topics: SOME_CONST` 时，
   `check-wiring` 的正则看不见 ⇒ 代码对、门禁仍报缺口。详见 gap 文档 §6.15.3。
2. **查 H 漏检嵌套目录插件**：`plugins/agint-quality/agint-quality-contract/lib/`
   改了但查 H 全程未报漂移（改前仓库/部署位 md5 明确不同）。
   意味着以后改 contract / eval / policy / sandbox 源码，漂移不会被门禁发现。
   详见 gap 文档 §6.15.4。

### 9.5 未覆盖

- **变异测试欠一笔**：新增 30 条单测，但未做「退回未接线 → 测试转红」的对照（§6.11.2 的标准）。
- `agint-abtest` 存储域仍 DEAD；`agint-wiki` root 指向空目录 —— 两者都在本提案范围外。
