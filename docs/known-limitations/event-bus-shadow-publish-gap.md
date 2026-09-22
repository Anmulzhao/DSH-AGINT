
---

### 6.14 ⭐⭐⭐ 外部直写生产存储不算落库 —— 宿主内存态全量落盘会把它回滚（2026-09-23 00:05）

**起因**：复核 T2 状态时例行数总线总条数，发现 **907 条里 `mount.` 一次都没出现** ——
而 §6.13（2026-09-21 20:06）明确记录过一条 `mount.requested` 落库（883 → 884）。
追下去：不是记错，是**那条事件被抹掉了**；而抹它的机制，波及我们**一整类验收手法**。

#### 6.14.1 现状取证（生产存储实读，非脚本自述）

| 观测项 | 结果 |
| --- | --- |
| 总线总条数 | **907**（死信 0） |
| 全文 grep `mount.` | **0 命中** |
| grep §6.13 记录的事件 id `11c38a57-…` | **0 命中** |
| grep §6.13 记录的 correlationId `6dd60c83-…` | **0 命中** |
| `agint_mount.json` 里那份 ticket | **仍在**（mtime `09-21T12:06:07.393Z`，原封不动） |

⇒ **同一次触发的两个副产品命运相反**：ticket 活着，事件没了。不是漏记，是**选择性消失**。

#### 6.14.2 算术闭环：907 = 883 + 24，外部那条不在任何一环里

宿主 pid 29168 启动于 **`2026-09-21T11:20:50Z`**（早于 §6.13 的触发 `12:06:07Z`）。
启动时它把**当时磁盘上的 883 条**读进内存；此后的磁盘写入都是**宿主内存态的全量落盘**。
宿主自产的事件逐条可列：

| 时刻（UTC） | 条数 | 主题 |
| --- | --- | --- |
| 09-21 19:01 | 11 | 9×`evolution.evaluated` + `dream.completed` + `self.model.updated` |
| 09-21 20:00 | 12 | `metrics.snapshot` |
| 09-22 15:48 | 1 | `memory.provider-activated` |
| **合计** | **24** | |

**883 + 24 = 907**，与磁盘实读**分毫不差**。⇒ 外部探针写的那条（§6.13 的 883→884）
**从未进入宿主内存**，因此在宿主第一次写盘（`09-21T19:01Z`，+11 条那次）时即被内存快照覆盖。

#### 6.14.3 机制与四组对照

> **存储写入 = 宿主内存态全量落盘。外部进程直写只停留在磁盘上，撑到宿主下次碰这个存储域为止。**

决定性因素**不是"什么时候写的"，而是两个条件的组合**：
① 写入方**是不是生产进程本身**；② 宿主**启动时磁盘上有没有它**。

| # | 案例 | 写入方 | 时机 | 是否存活 | 解释 |
| --- | --- | --- | --- | --- | --- |
| ① | `mount.requested`（§6.13） | **外部探针** | 宿主启动**之后** | ❌ **被回滚** | 启动时不在磁盘 ⇒ 不在内存 ⇒ 被覆盖 |
| ② | `evolution.proposed` ×3（09-04） | **外部探针**（`source` 自带 `-probe` / `verify-*`） | 宿主启动**之前** | ✅ 存活 | 启动时被读进内存 ⇒ 此后随内存态保留 |
| ③ | `evolution.proposed` ×2（§6.11） | ⭐ **宿主内**（老板在 dsh 界面真实发话） | 均可 | ✅ 存活 | **生产进程自身写入** ⇒ 本机制根本不适用 |
| ④ | `agint_mount.json` 的 ticket | **外部探针** | 宿主启动**之后** | ✅ 存活 | 该存储域宿主**从未打开**（§6.13 已证 tickets 表自上线为空）⇒ 无内存态可覆盖 |

⭐ **③ 是本机制唯一"免疫"的一类** —— 这也解释了为什么 §6.11（主进程内真实触发）
是本缺口文档里**唯一一类经得起新判据的验收**。

⚠️ **证据强度（不得含糊）**：机制是**推断**，依据是算术闭环 + 四组对照，
**没有直接观测到"覆盖写入"这个动作**（宿主无相应日志）。取硬证的路见 6.14.6。

#### 6.14.4 影响面：一整类验收手法是"借来的时间"

凡「外部脚本直写生产存储 → 断言落库」的验收，**都只证明了磁盘上曾经有过**，
**不证明它活到了现在**：

- §6.13 的「`mount.*` 点亮 1/6」 → **已归 0**（本节实测）。典型形态：外部探针直写。
- §6.9.6 的**隔离进程**端到端 → 结论**不受影响**（它自己已声明「不是 dsh 主进程」），
  但它**本来就不是生产落库证据**，今后**不得引用为「已落库」**。
- §6.11 的两次**主进程内**触发 → **不受影响，且是新判据下的模范**：写入方 = 生产进程本身，
  属 ① 类。**这是本缺口文档里唯一一类经得起新判据的验收。**
- §6.12.3 的「宿主字节端到端」（直接 import 宿主那份跑 `apply()`）→ 结论**不受影响**：
  它验的是**字节可用性**，从未声称落库持久。

⚠️ **别把幸存者当成规律**：② 类（外部写、恰好赶在宿主启动前）能活下来，
靠的是宿主启动时刻这个**不可控**变量，等同抛硬币 —— 它**不是可依赖的机制保证**。

⭐ **修正后的判据**：
> **要称「落库」必须满足其一**：① 写入方**就是生产进程本身**；
> ② 外部写入后**等宿主重启一次**再核对。两者都不满足时，只能说「**磁盘暂存**」。

#### 6.14.5 T2 判据的更新

§6.13.4 把分子从 0 抬到 1；本节把它**按回 0**：

| 主题 | 真实数据（09-23 00:05 实读） | 说明 |
| --- | --- | --- |
| `evolution.proposed` | **5**（**自然流量 0**） | 3 条 09-04 探针 + 2 条 09-21 宿主内人工触发（§6.9/§6.11），**全部人工** |
| `sandbox.passed/failed` | **0** | 接线已修且**已生效**（见 6.14.7），但触发条件到不了 |
| `mount.*`（6 个） | **0** | 曾 1，已回滚 |
| `hmr.settled` | 0 | 需真挂载 |
| `memory.pre-compress-checkpoint` | 0 | 需真压缩 |

**T2 仍不可切**，且理由比 §6.13 更硬：可切性分子不是「停在 1」，而是**回到了 0**。

#### 6.14.6 待授权实验（唯一能拿到硬证的路）

在宿主**运行期间**由外部写入一条哨兵事件，等宿主下次写盘后核对是否消失。
预期：消失 —— 这能把上面的「推断」升级为「直接观测」。
代价：写一次生产存储（若宿主在观察窗口内写盘，该哨兵会被自动回滚，等于自清理）。
**需老板单独授权，本节不执行。**

#### 6.14.7 顺带更正：§6.12.4「需重启才生效」已是过时结论

- host 部署位 `plugins/agint-quality-sandbox/lib/index.js` mtime = **09-21 18:28**（含 `withPublish` ×4），
  宿主启动 **19:20:50** —— **晚 52 分钟，修复已被加载**。
- `sandbox.*` 仍为 0 的真因是**触发条件未达成**，不是代码没生效：
  autocreate 仅在候选带 `scripts/` 时才调 `runSmoke`，而生产 **42 个候选全部**
  `phase2: skipped (no executable)`，且**最新候选停在 09-18**。
- §6.12.4 建议的「观察重启后 autocreate 04:45 点亮」**已观察**：09-22 04:45 聚合 job 已执行，
  **空转、无新候选、未点亮**。

#### 6.14.8 关联

- 更正：§6.13.3 / §6.13.4 / §6.13.5（「点亮 1/6」结论）｜§6.12.4（「需重启才生效」）
- 同族：K63（测过 ≠ 接上了）｜K64（三类静默故障）｜K72（探针存储域核对）｜K73（接线漏被沿用的旧入口）
- 共同点：**用「我做了什么」替代「生产实际走哪条路、最后留下了什么」**

---

### 6.13 ⭐⭐ `mount.*` 首次点亮：走 PENDING_REVIEW 早退分支（2026-09-21 20:06）

> ⚠️ **本节「点亮」结论已于 2026-09-23 被 §6.14 更正**：该事件**已从生产存储消失**
> （外部直写被宿主内存态回滚）。本节记录的过程与副作用核验**仍然有效**，
> 但**不得再作为「`mount.*` 通路的可用性证据」引用**。判据以 §6.14 为准。

**背景**：6.10–6.12 之后，`mount.*` 六个主题仍是全 0。深挖发现**根因不是接线问题**：

> `storages/` 下**不存在 `agint_mount.json`** —— mount 存储域**自上线从未打开过**。
> tickets 表恒空 ⇒ **这台机器上从未真实挂载过任何一个插件**。
> 所以 6.10 里「10 处调用点都接好了」是真的，但**一次都没执行过**。

#### 6.13.1 为什么能零副作用点亮

`orchestrator.js:230` 的早退分支：

```js
if (isPendingReview(verdict)) {           // verdict.policyDecision === 'PENDING_REVIEW'
    const ticket = await writeTicket(...);  // 唯一写入
    await mountEventBusPublish(ctx, 'mount.requested', {...});
    return unpackTicket(ticket);            // ← 到此返回
}
```

判据函数（`orchestrator.js:37`）：`verdict.policyDecision === 'PENDING_REVIEW' || verdict.decision === 'PENDING_REVIEW'`。

**该分支只写 1 条 ticket + 发 1 个事件，不碰 `plugins/`、不碰 `cordis.patch.yml`、不触发重启。**

#### 6.13.2 执行与取证

手法沿用 `_e2e_shadow_verify_0921.mjs` 的模式（宿主部署位字节 + 真实生产存储）：
脚本 `D:\DSH\_mount_early_exit_probe.mjs`，先 `--dry` 过 zod 校验，再真跑。

| 观测项 | 触发前 | 触发后 |
| --- | --- | --- |
| 总线总数 | 883 | **884**（+1） |
| `mount.requested` | **0** | **1** ★ |
| 其余五个 mount 主题 | 0 | 0（**未覆盖，见 6.13.4**） |
| tickets 表 | 0 条 | **1 条**（`phase=PREPARED`、`decision=PENDING_REVIEW`） |
| `agint_mount.json` | **不存在** | 已创建（932 B） |
| emitEvent fallback 调用数 | — | **0**（bus 路径接管，未降级） |

落库事件（总线文件实读，非脚本自述）：

```json
{
  "id": "11c38a57-2cbd-41bf-b383-e95bca9f6e37",
  "topic": "mount.requested",
  "version": 1,
  "occurredAt": "2026-09-21T12:06:07.398Z",
  "source": "agint-mount",
  "traceId": "df64498f-0eb3-4217-8152-d4eff72fefdf",
  "correlationId": "6dd60c83-8b43-4af9-8bcb-76fd342ccf3d",
  "payload": { "ticketId": "6dd60c83-…", "proposalId": "probe-mount-…", "decision": "PENDING_REVIEW" }
}
```

**副作用核验（三项全 null）**：

| 项 | 结果 |
| --- | --- |
| `cordis.patch.yml` mtime | `2026-09-17 23:38:56` —— **未被改动** ✅ |
| `plugins/agint-7ccf2a88/` | **不存在**（未写产物）✅ |
| 重启 | 未触发 ✅ |

备份：`D:\DSH\_backup_mount_probe_0921\agint_event_bus.json.before`。

#### 6.13.3 这一趟证明了什么

- ✅ `mount.requested` 的**发布接线在工作**（`resolveBusPublish` 拿得到、envelope 结构合法）
  —— ⚠️ 但「**真落总线库**」应改为「**曾暂存于磁盘**」：该事件此后被宿主回滚，见 §6.14。
- ✅ mount **存储域能正常打开**（`agint_mount.json` 首次生成，schema 校验通过）
- ✅ `PENDING_REVIEW` **决策门生效**（`decision` 正确落为 `PENDING_REVIEW`，未走 `AUTO_DEPLOY`）
- ✅ **没有静默降级**（`emitEvent` 调用数 = 0，说明走的是 bus 而非 fallback）

#### 6.13.4 ⚠️ 这一趟**没有**证明什么（不得含糊）

**走的是早退分支，六个主题里只点亮 1 个。** 以下五个仍需**真挂载**才会发出：

`mount.succeeded` / `mount.failed` / `mount.restart-requested` / `mount.rolled-back` / `mount.activated`

它们分别在 `:383`（succeeded）、`:270/305/311/325/358/371/392`（failed）、`:336`（restart-requested）
等**早退分支之后**的路径上。**未真挂载 ⇒ 这些发布点仍从未执行过。**

⇒ **T2 前置判据的更新**：`mount.*` 从「全 0」变为「**1/6**」。
**不足以判定该主题通路可用** —— 一个只跑过一条早退分支的通路，不能拿来替换主路径。
> ⚠️ **2026-09-23 更正**：该「1」已被宿主内存态回滚，**实测归 0**（§6.14）。

#### 6.13.5 与 6.10.4 判据的关系

6.10.4 写「T2 的前置条件不是接线完成，是 T1 拿到真实数据」——本节**不改变该判据**，只是把分子从 0 抬到 1。
当前七项指标（`evolution.proposed` / `sandbox.*` / `hmr.settled` / `mount.*` / `memory.pre-compress-checkpoint`）中：

| 主题 | 真实数据 | 说明 |
| --- | --- | --- |
| `evolution.proposed` | **3**（人工触发） | 无自然流量 |
| `sandbox.passed/failed` | 0 | 接线已修（`1e0d9d0`），**待真实沙箱调用** |
| `hmr.settled` | 0 | 需真挂载 |
| `mount.*` | **1 → 0**（本节曾点亮，**已回滚** → §6.14） | 六个里曾点亮 1 个，**现已消失** |
| `memory.pre-compress-checkpoint` | 0 | 需真实压缩事件 |

**结论不变：T2 仍不可切。**

---

### 6.10 三次复核「T2 切流量完成了吗」—— 未完成，且代码从未存在（2026-09-21 17:38）

**结论：T2 未实现、未排期。T1 仍是双轨并行，主路径从未被替换。**

#### 6.10.1 `transport` 取证（修正 6.8 的「零命中」口径）

全库 `plugins/**/lib/*.js` grep `transport` → **3 处命中，全部是注释**：

| 位置 | 内容 |
| --- | --- |
| `agint-mount/lib/orchestrator.js:47` | `mount 内部点对点 transport → bus publish（A4 / B4）`（小节说明标题） |
| `agint-mount/lib/orchestrator.js:50` | ⭐ **「不切流量：`ctx.emitEvent`（cordis point-to-point）保留作为 fallback；bus 不可用 / publish 抛错时静默降级，原路径不受影响」** |
| `agint-mount/lib/rollback.js:8, 121` | 「点对点先到 evolution；Sprint 12 Event Bus **替换** transport」（将来时，是计划） |

→ **无任何 T2 实现代码。** 6.8 节所写「零命中」不准确，已改为「3 处命中且全为注释」。

#### 6.10.2 ⭐ T1 的真实形态 = 双轨，不是切换

`agint-mount/lib/orchestrator.js:100-128` 的 `mountEventBusPublish()`：

```js
// ── 双轨 1：agint.eventBus.publish（影子/正式通路）──
try { ... await publish(envelope); } catch { /* 降级：保留原 ctx.emitEvent 路径 */ }
return;
// ── 双轨 2：ctx.emitEvent fallback（cordis point-to-point；原路径保留）──
try { ctx.emitEvent?.(topic, payload); } catch { /* ignore */ }
```

**bus 抛错即静默降级回原路径，且返回前不区分成败。两条路一直并行。**

> 这就是 T2 无从谈起的原因：**T1 连「独占」都不是。**
> 讨论「用 transport 替换直连」的前提是「总线已是唯一通路」，而现状是两条路同时活着。

#### 6.10.3 生产数据（总线 882 条事件 / 死信 0）

| 主题 | 条数 | 说明 |
| --- | --- | --- |
| `evolution.proposed` | **6** | 3 条 09-04 探针 + **3 条 09-21 主进程真实触发**（17:15 `3c988611` / 17:49 `be30cddd` / 见 6.11）⇒ **真实触发 3 条**。⚠️ 原记 17:33 那条**不在总线文件里**（体外探针用内存总线，从未写入），已在 6.11.4 更正 |
| `sandbox.passed` | **0** | — |
| `sandbox.failed` | **0** | — |
| `hmr.settled` | **0** | — |
| `mount.*`（六主题） | **0** | — |

#### 6.10.4 判据（决策口径）

T2 的前置条件**不是「接线完成」，是「T1 拿到真实数据」**。
现状 = 四项里三项恒 0，唯一非零的那项真实触发只有 1 条。

**拿一条只跑过 1 次的通路，去替换天天在跑的主路径 —— 不能做。**
（该主题虽小，但同样计入清单。）

### 6.11 ⭐⭐⭐ 主进程内真实触发实测 —— 断点已闭环（2026-09-21 17:49）

**背景**：6.9.6 结尾留了一个口子 —— 「本次端到端在**隔离进程**跑，**不是 dsh 主进程**」
「主进程内验证需真实走一次 `evolve_propose`」。

**本节把这一环补上。** 老板在 dsh 界面实际发话，触发真实 `agint.evolve.propose`。
两次触发恰好跨在修复前后，构成**天然对照实验**：

| # | 北京时间 | proposalId | 修复状态 | 总线事件 | proposal 落库 | 影子落库 |
|---|---|---|---|---|---|---|
| ① | 17:15:53 | `3c988611-…` | **修复前** | ✅ 有 | ✅ 有 | ❌ **MISS** |
| ② | 17:49:14 | `be30cddd-…` | **修复后** | ✅ 有 | ✅ 有 | ✅ **OK** |

修复落位时间：`2026-09-21 17:29:49`（宿主 `agint-evolution-memory/lib/index.js`，
备份 `_backup_evomem_0921/index.js.host-before-fix`）。

#### 6.11.1 三条通路逐层证实

1. **发布侧（主进程内）✅**
   `agint.evolve.propose` → `publishProposed` → 真实总线。两次触发均落库（`evolution.proposed` 4 → 6）。
   事件 `source=agint-evolve`、`origin=agint-evolve`，与体外探针的 `source=e2e-verify` 可区分。
2. **订阅侧（主进程内）✅**
   修复后影子写入成功：`evolution_log` 出现 `tags` 含 `shadow-ingest` 的行，
   `targetId=be30cddd-…`、`origin:agint-evolve`、`kind:service`。
3. **断点根因坐实 ✅**
   ① 的 MISS 正是 6.9.3 定位的**异步赋值竞态**：
   `logBuffer` 由 `ready.then()` 延迟赋值，而 `logPhase4Buffered` 不 await ready 即
   `logBuffer.enqueue(entry)` ⇒ `TypeError: Cannot read properties of null` ⇒
   被 shadow handler 的 `catch { warn }` 吞掉 ⇒ **事件永久丢失**。
   修复（`ensureLogBuffer()` 显式 await + 拿不到实例时降级同步 `logPhase4` + 计数）**在生产主进程内被验证有效**。

#### 6.11.2 ⭐ 方法论：修复前后各一次真实触发 = 最强证据

本次的价值不在于「修好了」，而在于**修复前后各有一条真实触发**，形成对照：

```
17:15 MISS（修复前）  →  17:29 修复落位  →  17:49 OK（修复后）
```

**应固化为标准动作**：任何「影子链路修复」的验收，都必须给出
「**修前一次 MISS + 修后一次 OK**」的对照。单边证据（只有修后 OK）无法排除
「本来就能跑」或「环境碰巧不同」的可能。

#### 6.11.3 ⚠️ 更正 6.10.3 的一处事实错误

6.10.3 原记：`evolution.proposed` 5 条，其中「1 条为 17:33 **验证探针所写（假触发，不计）**」。

**此说错误。** `_e2e_shadow_verify_0921.mjs` 创建总线时用的是 `memDomain()`
（**内存存储**，见该脚本 `:87`），只有 `evolution-memory` 一侧接的是 `realEvoDomain()`（真实存储）。
⇒ 那条探针事件**从未写入真实总线文件**，只污染了 `evolution_log`（真实存储那一侧）。

正确口径：总线里 `evolution.proposed` 的 5 条（17:49 之前）中
**3 条是 09-04 探针、1 条是 17:15 真实触发**，**不存在**所谓「17:33 假触发」。
表已更正为 6 条。

> ⭐ **教条（与 6.9 同源）**：探针脚本必须**逐个存储域核对真实/内存**，
> 不能用「脚本名字里有 e2e」推断它写到了生产。**看 storageDomain 的实参，不看脚本名。**

#### 6.11.4 取证脚本与判据

- **新增只读脚本**：`_bus_live_verify_0921.mjs`（不做任何触发，只读三处生产存储做交叉对账：
  总线 `events` ↔ 提案 `proposal` ↔ 影子 `evolution_log`）。
- 其 `[4]` 段的 `MISS` 对 **09-04 三条历史探针属预期正常** ——
  那三条发生在本插件订阅接线之前，且 `source` 为探针，本就不应有影子写入。
- **判据**：`evolution.proposed` 三条真实触发中，**修复后的 ② 成功落影子** = 通路成立；
  ① 的 MISS = 修复前缺陷的实证。

#### 6.11.5 仍未覆盖（不得含糊）

- 本节仅覆盖 **`evolution.proposed` 一条通路**。
  `sandbox.passed/failed`、`hmr.settled`、`mount.*`、`memory.pre-compress-checkpoint`
  **全部仍为 0** —— 需真实沙箱 / 真实挂载 / 压缩事件才会通电，**提提案覆盖不到**。
- **cron 仍全线停摆**：`agint_cron.json > tables.cron_state` 14 条 `lastRunAt`
  全部停在 `2026-09-20T21:30:42Z`（北京 09-21 05:30），观察不到自然增补。
  故「影子标记能否**自行**增长」**仍无自然流量证据**，现有 1 条系人工触发所得。

#### 6.11.6 判据更新：T2 是否可切

**仍然不可切，且理由比 6.8 / 6.10 更硬**：
7 个 T1 主题中 **6 个恒 0**；唯一通电的 `evolution.proposed`
**3 条真实触发全部是「验证本链路」性质的人工提案**，不是业务自然流量。

把这样的通路顶替天天在跑的主路径 = **用刚修好、且只有人工样本的管子换掉主动脉**。

### 6.12 ⭐⭐⭐ `sandbox.*` 恒 0 的真因：`runSmoke` 漏接线（2026-09-21 18:2x，已修 `1e0d9d0`）

**6.11.5 记的「`sandbox.passed/failed` 仍为 0，需真实沙箱才会通电」——只对了一半。**
真因不是「没触发」，而是**高频路径压根不记账**。

#### 6.12.1 根因：接线只包了新入口，漏了被沿用的旧入口

A3 接线（2026-09-20）把 `publishSandboxEvent()` 包进了 **`runVerify` / `runExplore`** 两个**新**入口。
但全仓 grep 调用分布显示，**三个上游里有两个走的是旧入口 `runSmoke`**：

| 上游调用点 | 调的方法 | 走发布？ |
|---|---|---|
| `agint-mount/lib/orchestrator.js:308` | `runVerify` | ✅ |
| `agint-mutator/lib/index.js:596` | **`runSmoke`** | ❌ **不发布** |
| `agint-skill-autocreate/lib/evaluator.js:108` | **`runSmoke`** | ❌ **不发布** |

⇒ **改插件（mutator）/ 生成技能（autocreate）这两条日常高频路径，
沙箱真跑了也永不计事件** → `sandbox.*` 生产长期为 0。

**缺陷形态（值得单列）**：*接线依赖实现细节* —— 包了"我认为该包的"新方法，
而**真正在生产跑的是沿用下来的旧方法**。
> ⭐ **教条：给某个 Service 加发布/埋点接线时，必须先 grep「谁在调这个 Service」，
> 把所有**实际被调用的**入口列全，而不是只包当前正在开发的那几个。
> 「有哪些方法」≠「哪些方法真的被调」。**

#### 6.12.2 修法（`1e0d9d0`）

抽出通用包装 `withPublish(fn, meta)`，**三个入口共用**，从结构上消除入口差异：

```js
const runVerify  = (args) => withPublish(() => runInMode({...args, mode:'verify'}),  {...});
const runExplore = (args) => withPublish(() => runInMode({...args, mode:'explore'}), {...});
const runSmokePublished = (args) => withPublish(() => runSmoke(args), {...});  // ← 补上
// 成功 → publishSandboxEvent({ result })
// 抛错 → 先记一次 failed，再把原错误**原样抛回**
```

**兼容性（FROZEN Service 契约）**：`runSmoke` 是 mutator 注释点名的冻结接口，
故**签名、返回形态、抛错语义一律不变**，对调用方完全透明，仅追加一次 best-effort 影子发布。

#### 6.12.3 验收（三层 + 变异）

| 层 | 结果 |
|---|---|
| 单元测试 | 新增 `test/runSmoke-publish.test.mjs` 5 条；全插件 **38/38 绿**（6 文件逐个跑），零回归 |
| **变异测试** | 把实现退回未包装 → **4 红 / 1 绿** ⇒ 测试有判定力（非装饰） |
| **宿主字节端到端** | 直接 import 宿主那份跑 `apply()`：`runSmoke` → 发 `sandbox.passed` ✅（修前 0 条）；`runVerify` 对照同样发 ✅ |

**新增测试覆盖的出口**：`runSmoke` 成功 / 失败 / 抛错 / bus 缺失 四个出口，
外加一条**入口一致性不变量**（`runVerify` 与 `runSmoke` 同等输入必须发同 topic）。
> 老的 `shadow-publish.test.mjs` 只覆盖 `runVerify` —— **这正是缺陷溜过去的原因**：
> 测试与实现犯的是同一个盲区（都只认新入口）。

#### 6.12.4 ⛔ 尚未生效，且仍未达标

- **必须重启 dsh 才生效**（`apply()` boot 期加载，宿主字节已更新但进程内存是旧版）。
- 重启后 `sandbox.*` 的预计点亮点 = **autocreate 每日聚合（04:45）** 或 **mutator commit 流程**。
- **连带收益**：`sandbox.*` 通了之后，`agint-diagnosis` 的 `sandbox.failed` 订阅方
  （早已就位、但自上线起从未收到过消息）**也才有机会首次收到真实事件**。
- **`hmr.settled` / `mount.*` 仍未通电** —— 它们只能由**真挂载**点亮，
  而真挂载会写产物目录 + 改 `cordis.patch.yml` + 可能触发重启，属**生产写操作**，
  需老板单独授权。**不建议为凑指标去做。**

#### 6.12.5 T2 判据（不变）

本次修复**没有改变 T2 可切性**：7 个 T1 主题中，此前 6 个恒 0；
本次修的是其中 2 个（`sandbox.passed/failed`）的**接线缺陷**，
但**它们要重启后跑出真实数据才算通电** —— 在那之前仍是 0。
**T2 依然不可切。**

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

1. **T2 的代码从未存在。** 全库 `plugins/**/lib/*.js` grep `transport` → **3 处命中，
   且全部是注释/说明，无任何实现代码**（`agint-mount/lib/orchestrator.js:47,50` 与
   `rollback.js:8,121`；均为「点对点 transport → bus publish」的说明与
   「不切流量 / 原路径保留」的红线声明）。
   T2 的定义就是「由 event bus transport 替代直连」，故 T2 不是「切了没切」，是「尚未开始」。
   > 📌 **2026-09-21 17:38 修正**：本条此前写作「零命中」，**不准确** —— 应为
   > 「3 处命中但全是注释」。结论（T2 未实现）不变，但取证口径必须精确。

1b. ⭐ **T1 的真实形态是「双轨」，不是「切换」** —— 见 `orchestrator.js:100-128`
   `mountEventBusPublish()`：双轨 1 = `agint.eventBus.publish`（bus 抛错即静默降级），
   双轨 2 = `ctx.emitEvent`（注释明写「fallback；原路径保留」）。
   **两条路一直并行在跑，且返回前不区分成败。**
   → 这解释了为什么 T2 无从谈起：**T1 连「独占」都不是。**
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

---

### 6.9 T1 真实触发实验：发布侧通了、订阅侧没通（2026-09-21 17:15）

老板指示「先制造一次真实触发」。已执行，结果**只通了一半**，并暴露第二层缺口。

#### 6.9.1 发布侧 ✅ 已实证

用宿主部署位字节 + 真实生产 `storages/` 触发一次 `evolve_propose` 等价调用：

| 观测项 | 触发前 | 触发后 |
| --- | --- | --- |
| `evolution.proposed` 事件数 | 3 | **4** ✅ |
| `agint_evolve` 提案表行数 | 55 | **56** ✅ |

新增那条：`source=agint-evolve`、`traceId=966ed87a-…`、
`envelopeId=e502d113-01ed-4a51-bbb7-c31a5bc6739f`，按 `proposalId` 精确匹配到 1 条。
**突破 09-04 三条历史探针的僵局，发布接线确认有效。**

#### 6.9.2 订阅侧 ❌ 仍为 0 —— 第二层缺口

`agint_evolution` 域 `evolution_log` 表**无任何增量**，仍为 168 条。
**且 168 条里 `shadow-ingest` / `event-bus` 标记 = 0 条** —— 即影子订阅路径
**自上线至今一次都没成功写入过**（168 条全部来自直连 `phase3-provisional` / `policy-decision`）。

> ⚠️ 这直接回答了 6.7 节留下的疑问：`eventBus.syncSubscriptions` 恒为 1
> **不是**「sync 只有 1 个」这么简单 —— 影子订阅是 **async** 模式（不计入 sync 计数），
> 所以那个恒 1 **与影子订阅无关**，不能用作本节任何结论的依据。

#### 6.9.3 隔离复现：定位到一条真实的静默丢事件路径

用宿主部署位字节 + mock ctx 做隔离复现（`_evo_mem_live_probe.mjs` 等），结论：

| 验证项 | 结果 |
| --- | --- |
| `subscribe` 注册 | ✅ 成功，`publish` 返回 `deliveredTo: ['agint-evolution-memory']` |
| handler 被调用 | ✅ 调用 |
| `logBuffer` 就绪后调用 | ✅ 入 buffer → 5 秒后 flush → **落盘成功** |
| **`logBuffer` 未就绪时调用** | ❌ **`TypeError: Cannot read properties of null (reading 'enqueue')`** |

**根因（代码层，已复现）**：`plugins/agint-evolution-memory/lib/index.js:86-96`
的 `logBuffer` 由 `ready.then(...)` **异步赋值**，而 `logPhase4Buffered`（L141-155）
**既不检查 null、也不 `await ready`**，直接 `logBuffer.enqueue(entry)`。

一旦调用早于 storage domain 就绪 → 抛 TypeError → 被 L409 的
`catch (err) { warn('shadow ingest failed', …) }` **吞掉**。
**订阅注册成功、投递成功、handler 执行成功，但事件永久丢失。**

> 这是 09-07 那次修复（L352-359 注释记录的 zod 枚举吞异常）的**同型复发**：
> 病灶都在「handler 内的异常被 warn 吞掉」，只是这次的错误源从 schema.parse
> 换成了 `logBuffer === null`。

#### 6.9.4 未证实项（不得含糊）

生产那次（17:15:53）触发时进程已启动 **77 秒**（`lastBootAt` = 17:14:36），
远长于隔离环境里 2 秒的 domain 初始化延迟。
**故「竞态」能解释隔离复现，但尚不能解释生产那次的直接原因。**

**已排除的伪故障**：`evolution_log` 的直连路径确实停在 `2026-09-18T04:46:03Z`，
初看像第二条故障，但经上游核对 **是正常静默、非故障**：

| 表（`agint_skill_autocreate`） | 最后一条 |
| --- | --- |
| `candidates` | 2026-09-18T02:11:29Z |
| `proposals` | 2026-09-18T04:45:58Z |
| `evolution_log`（下游） | 2026-09-18T04:46:03Z（+5 秒，**时间链吻合**） |

即：autocreate 自 09-18 起未再产出新候选（技能候选依赖真实任务会话）→
下游 `evolution_log` 无输入可写。**「没有数据」不等于「链路坏了」。**
→ 6.9.3 的竞态仍是订阅侧 0 写入的**唯一**已复现解释。

**下一步取证方向**：
1. 在真实 dsh 内 `grep` 日志 `shadow ingest failed`，确认生产是否走了同一分支（需先找到当日日志）。
2. 修法建议（待老板定）：`logPhase4Buffered` 改为 `await ready` 后再 enqueue，
   并把 `catch` 从 `warn` 升级为「warn + 计数指标」，让静默失败可观测。

#### 6.9.5 修复已落地（2026-09-21 17:3x，老板批准两条修法）

**提交 `b2d9edb`，已推送。**

**修法 1 — 显式 await（根治竞态）**
- 新增 `ensureLogBuffer()`：惰性 + 单例 promise，并发调用只开一次域。
- `logPhase4Buffered` 改 `await ensureLogBuffer()`；拿不到实例 → **降级同步 `logPhase4`**（不丢事件）。
- `enqueue` 抛错同样降级同步 + warn，不静默。
- `readLogRangeMerged` / `flushLogBufferNow` 同步跟进（原实现同样会撞 null）。
- ⭐ dispose 钩子 `if (logBuffer)` → `await ensureLogBuffer()`：原写法在实例未就绪时
  **静默跳过 shutdown**，缓冲残留随进程消失。

**修法 2 — 让失败可观测（计数指标）**
- `shadowIngest.ok` / `.failed` / `.skippedNoId`：**成功也计数**，与 failed 配对，
  使「收到事件数 = ok + failed」恒等式可校验。
- `logPhase4Buffered.degraded` / `.enqueueFailed`、`readLogRangeMerged.degraded`、
  `flushLogBufferNow.noBuffer`、`shadowSubscribe.initFailed`。

**验收（三层 + 变异）**

| 层 | 结果 |
| --- | --- |
| 仓库单测 | 10/10 绿（`domain-race` 4 + `shadow-ingest` 6） |
| 权威冒烟 `smoke.mjs` | **13/13 绿**（11 工具注册 + 跨平台 fixture + 9 buffer 契约） |
| 部署位端到端 | **4/4 绿**（用宿主字节跑，非仓库） |
| 变异测试 | 退回旧写法 → **3 红 / 1 绿**，证明测试有判定力 |
| schema 护栏 | 25 文件 / 109 schema / **0 invalid** |

新增 `test/domain-race.test.mjs` 作为该竞态回归防线（真插件 + mock ctx + 慢 domain）。

> ⚠️ **生效前提：`lib/index.js` 属 boot 期加载，必须重启 dsh。**
> 重启后验收口径：`evolution_log` 出现**首条 `shadow-ingest` 标记**（历史恒 0）。
> 探针：`D:\DSH\_verify_evomem_fix_0921.mjs --go`。

#### 6.9.6 ⭐⭐ 重启后验收通过 —— 影子订阅**首次通电**（2026-09-21 17:34）

**重启确认**：`lastBootAt` = `2026-09-21T09:33:18Z`（北京时间 17:33:18），PID **15364**。

**结果**：

```
evolution_log      : 168 → 169
shadow-ingest 标记 : 0 → 1      ← 上线以来首次非零
本次 proposalId 命中: 1 条（targetId 精确匹配）
tags: ["event-bus","shadow-ingest","stage:proposed","origin:e2e-verify","kind:other"]
warns: [] / deadLettered: []
```

**这条影子订阅链路自上线以来第一次真正写入了数据。**

##### ⚠️ 同时纠正 6.9.1 / 6.9.2 的方法论错误

6.9.1 声称「发布侧通了」、6.9.2 声称「订阅侧没通」—— **后一个结论不成立**。

**缺陷**：当时两个探针都跑在**独立进程**里，自己 `apply` 了一份 event-bus。
该进程内**没有插件来 subscribe**，订阅表本身为空 ⇒ `deliveredTo: []` 是**必然结果**，
与订阅方是否正常**毫无关系**。

**我的误读**：① 把「字段正确、能落库」当成「dsh 进程内发布路径通」；
② 把「独立进程无订阅者」当成「订阅侧坏了」。

> ⭐ **教条：验证订阅链路时，pub/sub 必须共享同一模块实例。**
> 独立进程里 publish **只能**验证「字段 / schema / 拒绝路径 / 能否落库」，
> **永远验证不了订阅**。正确做法是把「发布方 + 订阅方」装进**同一进程**，
> 并让它们共享同一份服务表（模拟 cordis `ctx.get` / `ctx.provide`）。

**修正后的探针** `_e2e_shadow_verify_0921.mjs`（同进程 + 宿主字节 + 共享服务表），
支持 `--dry`（storage put 变 no-op，用于分离「链路通不通」与「落没落盘」）。

##### 验收判据（组合才完整，缺一不可）

`deliveredTo` 含订阅者 **+** 目标存储出现**链路专属标记** **+** `metrics` 有成功计数
**+** `warns` 为空。**只看其中一项就下结论 → 就是本次犯的错。**

##### 边界（如实）

本次端到端在**隔离进程**用宿主字节跑，**不是 dsh 主进程**。它证明的是
「代码与部署位字节本身没问题」——此前唯一未被证明的一环。
主进程内验证需真实走一次 `evolve_propose`（挂 preset 但不在我当前工具集），
**路径已打通**：等一次自然提案或 cron，观察 `shadow-ingest` 标记是否自行增长。
