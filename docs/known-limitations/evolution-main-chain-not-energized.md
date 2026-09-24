# 自进化主链路从未通电（2026-09-24 取证）

> 一句话：**AGINT 现在在跑的是「观测侧」，不是「进化侧」。**
> 变异引擎（`agint-mutator`）与种群选择引擎（`agint-population`）挂载了、代码完整、
> 测试全绿，但**在生产里一次都没运行过** —— 连它们的存储域文件都不存在。

建档人：智（自动盘点取证）｜判据脚本：`bin/check-wiring.mjs`｜自测：`bin/check-wiring.test.mjs`

---

## 一、事实

### 1.1 存储域通电检查（查 D）

插件用 `defineDomain({ name: 'agint_xxx' })` 声明独占存储域；存储域是**首次写入才落盘**的。
所以 `$DSH_HOME/storages/agint_xxx.json` 存不存在，就是这个插件有没有真跑过的**外部可观测判据**
—— 不需要进宿主进程，看磁盘就知道。

`$DSH_HOME/storages/` 实读（2026-09-24）：

| 状态 | 数量 | 域 |
| --- | --- | --- |
| ✅ 已通电 | 13 | abtest / compress_guard / cron / curator / diagnosis / event_bus / evolution / evolve / memory_provider / metrics / mount / rules / self_model / skill_autocreate / skill_graph / trajectory |
| ⛔ **从未通电** | **3（未豁免）** | **`agint_mutator` / `agint_population` / `agint_curriculum`** |
| 豁免 | 1 | `agint_search`（按需调用，无人调用不算故障） |

### 1.2 服务调用点检查（查 A）

光看磁盘还不够（也可能是写了但被清了）。交叉验证：**全仓生产代码里，这些服务的引用数为 0。**

`agint.mutator.*` 全仓生产零引用：
`propose` / `validate` / `commit` / `rollback` / `attributionDriven` / `dreamRandom` /
`evolutionReversed` / `limits` / `checkLimit` / `io` / `publishMountRequest`

`agint.population.*` 全仓生产零引用：
`ingest` / `promote` / `cull` / `fixate` / `rollback` / `recordEvaluation` /
`config` / `updateConfig` / `limits` / `checkLimit` / `publishProposed` / `publishMountRequest`

唯一"引用"是它们自己的 `ctx.provide(...)` 那一行。
工具侧也没开入口：`mutator/lib/tools.js` 只暴露 `stats` / `logMetric`，
`population/lib/tools.js` 只暴露 `stats` / `evaluate` —— **AI 也调不到 propose/commit/cull**。

---

## 二、⭐ 因果链：一条断链拖垮一整片

这不是两个孤立的死插件，是**一条链的第一环没接**：

```
agint-mutator 从未通电
   └─> agint.mutator.commit 从不执行
         └─> sandbox.runSmoke 从不被调用        （mutator/lib/index.js:596 是唯一调用点）
               └─> sandbox.passed / sandbox.failed 恒 0
                     └─> agint-diagnosis 的 analyzeFailedSmoke 订阅永远收不到消息
   └─> agint.population 拿不到 commit 产物
         └─> 种群选择 / 晋升 / 淘汰全部空转
```

**这解释了文档 §6.12 那个悬案**：2026-09-21 修了 `runSmoke` 接线（commit `1e0d9d0`），
但生产里 `sandbox.*` 至今仍是 0 条。
**修的是接线，可上游从来不跑** —— 接线修得再对也不会有数据。

> ⛔ 教训：**修「下游没数据」之前，先确认「上游有没有在跑」。**
> 否则会像这次一样，修完仍然 0 条，然后归因为"还没触发"，白等三年。

---

## 三、为什么四天没人发现

1. **K63 只盘到「服务级空壳」，没盘「插件级空转」。**
   K63 的三步法是「列 provide → 找生产调用点 → 对账数据」，粒度停在单个服务上。
   而这里的问题粒度是**整个插件**：插件挂载了、服务注册了、测试绿了，但插件从未运行。
2. **「挂载了 ≠ 跑过」这条既有教训没有被延伸到存储域层。**
   之前的判据是「到生产存储里核实有没有数据行」—— 这次是**连存储文件都没有**，
   说明比"有表没数据"还早一个阶段。
3. **每个 Sprint 都把责任推给了下一个 Sprint。**
   `docs/plugins/agint-mutator.md:113` 白纸黑字写着
   「Sprint 9 population manager | **未来消费方**（本 sprint 不写消费端）」。
   于是 mutator 等 population 来消费，population 等别人来调它 —— **谁都没接**。
   > ⛔ 「未来消费方」是一个会自我延续的死结：每个 sprint 都可以合理地把自己标成"等下游"。
   > **写"未来消费方"时必须同时写下"由谁、在什么时机来接"，否则等于永久挂起。**

---

## 四、处置选项（待老板拍板）

| 档 | 做法 | 代价 | 我的看法 |
| --- | --- | --- | --- |
| **A. 通电** | 给 mutator / population 一个真实触发点（cron 作业或 dream/evaluate 联动），让闭环真跑起来 | 新增一条需要维护的自主变更路径；**会真的去改代码**，需要沙箱/回滚兜底 | 这是 AGINT 存在的理由。但**必须先想清楚"谁批准一次真实变异"**，否则等于让 AI 随意改自己 |
| **B. 降级为库** | 承认当前不做自主代码变更，把 mutator/population 标记为「能力储备」，从 patch 里摘掉或保留不挂 | 少一层复杂度；但"自进化"这个卖点要改口径 | 诚实，但等于砍掉 P7/P7.5 的一条主线 |
| **C. 维持现状** | 继续挂着，不动 | 零成本 | ⛔ 不建议：它们现在**只产生误导**（面板上挂着、文档里写着，实际是死的） |

> **倾向：先回答一个前置问题 —— AGINT 到底要不要「自主改自己的代码」？**
> 要 → 档 A，且必须先有沙箱 + 自动回滚 + 人工否决口（记忆第七条：可回滚 > 可审批）。
> 不要 → 档 B，把口径改干净，别让两个死引擎继续占着"自进化"的叙事。

---

## 五、已固化成门禁（不会再腐坏）

- `bin/check-wiring.mjs` —— 四查：A 空壳服务 / B 主题接线 / C 生产数据对账 / **D 存储域通电**。
  `--json` 给 CI，`--strict` 让"从未触发"也算失败，退出码 0/1/2。
- `bin/check-wiring.test.mjs` —— 门禁自测（12 项）。**测的不是能不能跑，是判据对不对**：
  已知健康的链路不许被误报（防误报回归）、豁免必须真生效、
  以及"mutator/population 尚未通电"这条状态断言 —— **修好后这里会红，提醒你回来改文档与豁免**。
- `docs/wiring-exemptions.json` —— 豁免清单，每条必须写 `reason` + `evidence` + `since`，
  缺任一条不许加。带 `unblockWhen` 的（如 `sandbox.*`）在上游通电后必须复查。

> 之前这类盘点结论写进文档就开始腐坏（09-20 记的 3 个空壳服务，到 09-24 已处理了 2 个，
> 文档却还写着未处理）。**现在判据是脚本，跑一次 3 秒，不再依赖人肉 grep 和记忆。**

---

## 六、关联

- `docs/known-limitations/event-bus-shadow-publish-gap.md` —— K63 的原型；本文是它的**上游根因**
- K77 / 文档 §6.14 —— 外部直写生产存储不算落库（本次查 D 依赖该结论：磁盘文件是可信判据）
- `docs/plugins/agint-mutator.md:113` —— "未来消费方"死结的出处

---

## 七、2026-09-24 修复进展（未完 —— 差一次重启）

### 7.1 根因层已修：5 个 umbrella 键

`commit 5a0…`（详见历史）给 5 个插件补了命名空间键（纯加法，全名子键一个没动）：
`agint.eventBus` / `agint.diagnosis` / `agint.mutator` / `agint.population` / `agint.selfModel`。

**判据变化**：`bin/verify-umbrella.mjs` 用 mock ctx 真跑 `apply()`，不再靠 grep 证伪。
当前 bundle + mirror 双位置 **10/10 PASS**，两条真实依赖链已通电：
`agint-mutator → agint.eventBus.publish/subscribe`（此前必降级到 `ctx.emitEvent`）、
`agint-population → agint.mutator`（此前 `softDep` 恒空）。

### 7.2 ⚠ 尚未生效 —— 部署晚于 boot

| 时间 (UTC+8) | 事件 |
|---|---|
| 09-24 00:35 | 宿主 boot（pid 4860，见 `.agint-restart/marker.json`）|
| 09-24 02:20 | umbrella 键 6 个文件部署到 bundle + 镜像位 |
| 09-24 08:40 | metrics / dreamCounters 补齐部署 |

**部署晚于启动 ⇒ 当前宿主进程里跑的仍是旧代码**，
`verify-umbrella` 全绿只能证明"磁盘上的字节码是对的"，证明不了"进程加载的是它"。
→ **必须再重启一次**，之后按 §7.3 验收。

这条险些漏掉：门禁、自测、以及"已重启"这句话当时全部看起来正常。
固化判据见同批新增的门禁**查 H**（`check-wiring.mjs`）——仓库与部署位 191 个 lib 文件逐 hash 比对，
待上线清单直接输出，专治"改了没上线"的静默失败。

### 7.3 重启后验收清单

1. `bin/check-wiring.mjs` → PASS（0 硬缺口，查 H 报"已全部同步"）
2. `bin/verify-umbrella.mjs` → 10/10 PASS
3. 隔一段时间后复查 Topics 计数：
   - `mount.requested / mount.succeeded` 是否**从 0 变成非 0**（此前因缺 umbrella 键全降级）
   - `agint_mount` / `agint_population` 域文件是否出现（此前查 D 判 DEAD）
4. 若 3 仍为 0：说明还有下游触发链条没通，回到本文 §二重新盘点 —— 别直接认定"修好了"
