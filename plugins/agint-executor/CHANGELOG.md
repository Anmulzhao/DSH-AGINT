# agint-executor CHANGELOG

## v0.6.1（2026-11-07 · 环境故障与提案失败分开记账）

### 问题

LLM 子代理通道挂掉时 driver 抛错（`llm unavailable: stopReason=error`），执行器把它
当普通失败处理：排一次 5 分钟重试，第二次仍挂就 `finishExecution(ok:false)`。

实机（提案 `cdf41d63`，2026-11-07）：通道从 11-05 14:35 起全挂，当天 5 条执行行全部
同一个错；`cdf41d63` 在 07:52 与 08:10 两次批准，每次 9 秒内烧完 `maxAttempts=2`，
最后面板显示「已批准·执行失败」。提案一行代码没改、也一行没错 —— 是机器没跑起来。

三个结构性缺陷：

1. 抛错路径不分类：`driver 抛错：…` 既没有 deterministic 也没有 transient 判定，
   driver 里的 `classifyFailureKind()` 完全被绕过。
2. 环境故障消耗提案额度：`maxAttempts` 的语义是「这条提案值不值得再试」，
   而通道故障与提案无关。额度烧完后，通道恢复时提案已失去自动执行资格。
3. 没有熔断：`maxPerTick` 只限制一轮几条，挡不住「每 15 秒一轮」—— 故障期里
   整条队列被依次捡起来各撞一次墙。

### 改动

- 新增 `lib/env.js`：`isEnvironmentFailure()`（判据只收 LLM 通道/宿主能力/网络类）
  + `envBackoffMs()`（指数退避，封顶）。纯函数，无 IO、无时钟。
- `runJob` 在确定性失败分支之后、普通重试之前插入环境故障分支：顺延
  （`requeueExecution({deferred:true, refundAttempt:true})`）+ 指数退避，
  不调 `finishExecution(ok:false)` ⇒ 提案保持 `approved`、`execState=deferred`，
  面板显示「已顺延」而不是「执行失败·等处理」。
- 熔断：连续 `envBreakerThreshold`（默认 2）次环境故障 ⇒ 本轮立即停手并进入
  `envBreakerCooldownMs`（默认 10 分钟）冷却，冷却期内 tick 直接跳过。
  `force=true`（面板手动「立即执行」）允许穿透。
- 新增 config：`envBreakerThreshold` / `envBreakerCooldownMs` / `envMaxBackoffMs`。
- `status()` 新增 `envDeferred` / `envStreak` / `breakerUntil` / `breakerTrips`。

### 验证

- `test/env-failure.test.mjs`（新增 4 组）：环境故障顺延 + 退款 + 熔断 + 冷却恢复
  + 非环境失败不许被放行 + 判据正反例。
- 负控制：`oldText not found`（LLM 产出不合格）仍走原结算路径，不被环境判据放行。
- 部署位（`.agint-bundle` 与 `profiles/desktop` 两份）单跑同一用例通过。

## v0.6.0（2026-11-07 · 确定性不可执行时收口提案，不再留「已批准·执行失败」）

### 问题

driver 对「没有可改目标」的提案返回 `deterministic: true` 的 `not-actionable`。
执行器此前只把 job 记 failed 就返回，提案跟着 `execState=failed` 永久挂起（见
agint-evolve v0.22.0 的说明）。实机：11-04 一批 19 条、11-07 4 条。

### 改动

确定性失败分支（`verdict.deterministic === true`）在 `finishExecution` 之后调用
`evolve.markNotActionable(proposalId, reason)`：

- job 仍记 failed（审计：确实尝试过）。
- 提案退出自动队列：保留 approved、`execMode=manual`、`execState=idle`，
  面板落 `person/plan`（待定执行计划），人在那里决定 applied / wontfix / 拆分。
- 偶发失败（LLM 不可用等）**不收口**，仍按重试策略走 —— 下次可能就成功。
- 老版 evolve 没有该方法时退回原行为，不抛错；tick 结果带 `parked` 如实报告。

### 测试

新增 `test/deterministic-park.test.mjs`：确定性失败收口 / 偶发失败不收口 /
老版 evolve 回退，三条全过；`node --test` 14 项全过。

## v0.5.0（2026-11-03 · W8-3：执行前核审批凭据）

### 新增第七道闸

`decideRun()` 现在收一个 `mandate` 参数（`agint.evolve.checkMandate()` 的结果），
在**驱动可用之后、周额度之前**核验：

```
① 提案还在不在 → ② 还是不是 approved → ③ blocker → ④ 驱动在不在
→ ★ 审批凭据 → ⑤ 周额度 → ⑥ 重试次数
```

**为什么在周额度之前**：越权不是「这次不该跑」，是「这次没资格跑」。
让它去顺延会把一份无效授权排到下周，而下周凭据照样无效 —— 等于无限拖延。
也不该算失败消耗重试次数。

**为什么在驱动之后**：能力缺失是配置问题，比授权问题更前置。

### ⛔ 只有明确的 mismatch 才拦

| mandate.state | 判决 |
|---|---|
| `mismatch` | `cancel`，理由写明超出的路径与「需重新审批」 |
| `unknown` | **放行**（老提案没凭据不是越权） |
| `ok` / `null` | 放行 |

把 `unknown` 当 mismatch 拦下来 = 升级瞬间 90+ 条历史提案集体停摆。
但放行不等于安心：`checkMandate` 取不到（老版 evolve / 调用抛错）时
**不拦**，避免把 evolve 的临时故障变成「所有提案疑似越权」的一次性停摆。

### 用例

`test/mandate-gate.test.mjs`（新，7 例）：

- G0 无凭据信息 ⇒ 照常 run（不改变既有行为）
- G1 mismatch ⇒ cancel，理由含越权路径与「重新审批」
- G2 ⛔ unknown ⇒ 放行 / G2b ok ⇒ 放行
- G3 **越权 + 周额度已满 ⇒ 仍是 cancel 而非 defer**（钉判据顺序）
- G4 越权但驱动没挂载 ⇒ 先报驱动缺失（钉顺序）
- G5 越权但状态已变 ⇒ 撤单理由是状态，不能被凭据盖掉（钉顺序）

### 阴性对照（实测变红）

| 拆掉什么 | 谁红 |
|---|---|
| 删掉 mismatch 拦截（`if (false)`） | G1 / G3 |
| 把拦截条件改成 `state !== 'ok'`（即把 unknown 也拦） | G2 |

两个方向都试了 —— 拦太松和拦太紧都能被抓到，这是三态设计的意义所在。

### 全量

`agint-executor` 13/13 通过。

## v0.4.0（2026-11-03 · 结算失败不再静默吞 + 挂载即回收孤儿执行）

### 起因（实机取证）

提案 `a6e6e1d9` 的执行行 `exec-1793280728689-kmy9h1` 停在 `state='running'`
一整天，面板显示「已批准·执行中」，而没有任何东西在跑。
driver 会话转储的最后一条事件是
`{"type":"agent/inbox/spliced","data":{"outcome":"canceled"}}` ⇒ 执行被取消；
而同一宿主进程在 2 分钟后还成功落地了另一条（`exec-1793446896075-or1m5x`，
16:06:23Z succeeded）⇒ 执行器没被占死，**是结算那一步没落地**。

根因在两处：
- `lib/index.js` 的 tick 捕获段里，结算失败走 `catch { /* noop */ }` ⇒ 错误被吞，
  执行行永远停在 running；
- 队列不自愈（`agint-evolve/lib/execution.js:46` 的 `CLAIMABLE` 不含 running）。

⛔ 吞掉的代价不是「少一条日志」，是「一条提案永久卡死」。

### 改动

- **结算失败不再静默**：tick 的兜底结算抛错时，改为 `warn` + 记
  `evolution.failure_pattern`（`executor-settle-failed`）。
- **挂载即回收**：插件挂载后立刻调 `agint.evolve.reapOrphanExecutions()` ——
  上一进程遗留的 running 行此刻就是孤儿，它们会**挡路**（占着活跃 job 名额），
  不必等第一个 tick。
- **每轮 tick 前回收**：`reap` 在 `claim` **之前** —— 否则孤儿行让真正该跑的提案排不进去。
- 判据用本进程挂载时刻（`mountedAt`）与超时兜底（`config.orphanStaleMs`，默认 30 分钟）；
  本进程正在跑的 job id 进 `excludeIds`，不会被误判。
- 回收失败同样不吞：记 `executor-reap-orphans-failed`。
- `state.reaped` 计数上报到 `agint.executor.status()`，排障一眼可见。

### 测试

`test/executor.test.mjs` 新增 4 组用例：结算抛错时必须有 warn + failure_pattern /
回收必须带 `mountedAt` / 回收必须排在 claim 之前 / 回收失败必须落 failure_pattern。

## v0.3.1（2026-11-01 · 修代码注释里的红线旧值，零行为改动）

`lib/index.js` 的配置注释仍写着「`weeklyCommitCap` 默认 3，对齐 AGENTS.md『不要跨周累计
自动部署超过 **3** 次』」—— 那条红线 2026-10-29 已由老板改成 **5**（commit `a3b9b48`），
`AGENTS.md:57` 也同步了，只有这段注释没跟。

⛔ 这不是简单把 3 改成 5：**代码默认值确实是 3，红线是 5，两者刻意不同**。
默认值只在新部署没写 config 时生效；本机与 NAS 的 `cordis.patch.yml` 都显式写了 `5`。
注释现在把这件事写清楚 —— 否则下一个人改红线时会顺手把默认值也改成 5，
于是新机器拿着一个未经裁定的数字开始自动改代码。

无代码逻辑改动。`node test/executor.test.mjs` 仍全绿。

## v0.3.0（2026-10-29 · 撤掉「不可自动执行」语义闸：批准即执行）

### 老板的裁定

「我批准后就要自动去执行，而不是让我去执行或者标个无法自动执行这种的。」
⇒ v0.17.0（2026-10-27）加的第 ③ 闸（`proposal.autoExecutable === false` ⇒ `cancel`）
**整条删除**。判据顺序从 7 道变 6 道。

### 为什么这个代价可承受（不是「老板说了就算」）

那道闸的理由是「复核类提案没有可改目标，排进去必然秒失败」。但 2026-10-29 实测：
`resolveTargetAssets()` 在**起 LLM 之前**跑（`agint-evolution-driver/lib/index.js:1001`
`targets.length === 0 ⇒ warn + continue`），零目标时连模型都不调。
所以「照排」的真实成本 = 一条 execution 行 + 毫秒级确定性失败，
**不烧 token、不占周额度**（`weeklyUsage` 只数 `ok&&succeeded`）。

而保留那道闸的成本是：面板长期挂着「已批准（不可自动执行）」，
读的人以为系统在等他动手，实际没有任何机制会来——这比一条失败记录贵得多。

### 行为变化

- `decideRun()`：`autoExecutable === false` 不再 `cancel`，与其它已批准提案一致处理。
- 字段仍在存储里（历史数据 + oracle/upstream-watch 的产出），但**不参与任何判据**。
  ⛔ 若某条提案确实不该跑，正确表达是 `blocker`（第 ③ 闸，仍生效），不是这个标记。

### 验收

`test/executor.test.mjs` 两条改成「不再撤单」；smoke 输出尾巴改为「六道闸」。

## v0.2.1（2026-10-28 · 部分落地：job 成功不等于提案做完）

### 为什么又要改这里

上一版（`v0.2.0`）把「driver 返回 → 是否真的落地」收敛成一句话：`commit.ok === true ⇒ ok`。
这个判据对**单文件提案**是对的，对多文件提案是错的：一次 mutation 结构上只能覆盖一个原子单元，
把它按「落地」报上去，agint-evolve 就把提案标成 `applied` —— 账面上这条提案从此做完了。

实机（提案 `846f4fbb`）：3~4 个单元只落地 `agint-evolve` 的替身，台账却写成
`status=applied · execError=''`。第二次的事故往往比第一次贵：假死刑只是没推进，
假完成是**宣布完成**。

### 改了什么

- `interpret()`：commit.ok 为真时再读 driver v0.9.0 起的 `out.scope`；
  `complete===false ∧（有剩余目标 ∨ 要求新建资产）` ⇒ `partial=true`，并带出
  `unitsApplied/unitsTotal/remainingUnits/reason`。
  ⛔ 老 driver 不带 `scope` 时 `partial=false`，行为与原来逐字一致（靠新字段，不猜返回形状）。
- `runJob()`：把 `partial` 与剩余单元交回 `evolve.finishExecution`；`status()` 新增 `partial` 计数器
  —— 「本周自动落地 N 条」不能把只做完 1/3 的那条也数进去。
- ⛔ 仍然 `state.succeeded += 1`：单元确实落地了，partial 不是成功也不是失败，
  是「成功的一部分」，所以计数分开记、但两边都算。

### 验收

- `node --import ../agint-evolve/test/_stub-register.mjs` 集成用例第 4 节 ⇒
  `result.partial === true`、`executor.status().partial === 1`、提案留在 `approved`。
- 阴性对照：同一份 driver 返回把 `scope.complete` 改 true ⇒ 提案照旧标 applied（第 1 节），
  ⇒ 新分支没有污染原路径。

## v0.2.0（2026-10-27 · 语义闸 + 确定性失败不重试）

### 为什么

首跑实测：一条 oracle 复核类提案被面板默认的「立即执行」排进队列，driver 两次各 1 秒
失败（attempts 1 → 2），产出逐字相同。两个缺口：

1. **提案没有「我不可自动执行」的声明位** ⇒ 复核类提案被当成代码变更去跑；
2. **失败一律重试** ⇒ 确定性失败白烧一次 LLM，还让人以为「它在努力」。

### 变更

1. `decideRun` 增**语义闸**（七道闸的第 ③ 道，排在 blocker 之前）：
   `proposal.autoExecutable === false` ⇒ `action: 'cancel'`（撤单，不是 fail）——
   「这次不该跑」与「跑了但没跑成」是两回事。
2. `interpret(out)` 带出 `deterministic`；`runJob` 见 `deterministic` ⇒ **一次收尾，
   不排重试**，失败模式单列为 `executor-run-not-actionable`（周报查得动）。
   ⛔ 偶发失败（LLM 挂了、网络断了）**照常重试** —— 别把这条做成「一律不重试」。
3. 失败文案的取值优先级：**确定性 ⇒ 用 `reason`**（带 `not-actionable` 结论），
   **偶发 ⇒ 用 `failures[0]`**（比泛化文案具体，排查靠它）。顺序反了两头都吃亏。

### 红绿自证

`test/executor.test.mjs` 增 5 组：确定性失败不重试（requeue=0、finish=1、失败模式单列）/
偶发失败仍重试 / autoExecutable=false ⇒ 撤单 / decideRun 两态 / 字段缺席仍可跑。

## v0.1.1（2026-10-27 · 修：`inject` 漏声明 `timer`，首次部署插件根本没挂上）

### 症状

首次 `install/redeploy.sh` 全绿（装 + 核验 + 重启都通过），但 dsh 日志：

```
agint-executor (...plugins/agint-executor/lib/index.js): Error: cannot get property "timer" without inject
    at new apply (.../lib/index.js:277:7)
```

### 根因

`ctx.setInterval` / `ctx.setTimeout` 由宿主的 `timer` 服务提供，**必须写进 `inject`**。
v0.1.0 写的是 `inject = []`，而 wake 去重里用了 `ctx.setTimeout` ⇒ apply 抛错 ⇒
整个插件不挂载。判据与 `agint-cron` 同源（`const inject = ['timer', 'storageDomain']`）。

### 为什么本地用例没抓到

假 ctx 把 `setTimeout` / `setInterval` 直接给了出去，**比真宿主宽松** ——
「替身复刻契约」这条纪律在这里被违反了：真宿主对未注入的服务是**抛错**，不是返回 undefined。

### 修法

1. `inject = ['timer']`，manifest `spec.cordis.inject` 同步。
2. 补两条回归：`inject` 必须含 `timer`（并用源码反向校验代码确实在用宿主定时器，
   否则断言会退化成摆设）；`enabled=true` 时 apply 必须注册恰好一个 interval。

### 教训

「部署位核验全绿」不等于「插件真起来了」：redeploy 的启动后核验看的是
「无 skipping profile bundle + 有 agint 日志行 + cron job 数」，
一个插件 apply 失败不会让这些判据变红。**判「新插件是否真挂上」要看运行时**：
宿主 loader 的 `{total, active, failed}`（apply 成功才 active、抛错进 failed）
＋ 日志里没有该插件的 `Error:`，或 `ctx.get('agint.executor')` 是否非空。

### 更正（同日复核）：`pluginKinds` 的 `kind` 不能当挂载探针

本节最初写的是「面板 `pluginKinds` 里它是 `kind: sdk`（= 有源码、未挂载）」——
**这句是错的**，2026-10-27 复核运行时后更正：

- `sdk` 的真实含义是「`tools === 0` 且 `provides > 0` ⇒ 服务库」（`v2-data.js:1092`），
  是**正常形态**，跟挂载与否无关。零工具、只提供服务正是执行器该有的样子。
- 反过来 `unmounted` 也不可靠：复查时 `agint-evolve` 与 `agint-cron` 都被标成
  `unmounted`，而这两个明显在跑（cron 27 个 job、evolve 服务被面板写通道正常调用）。
  该标签依赖面板传入的 `mounted` Set，而那个 Set 与运行时 loader 的身份命名不同源 ⇒
  对不上的插件会被一律标成「已移除」。
- 所以当时那条「未挂载」结论**成立，但证据不是 kind 标签**，而是日志里 apply 抛的
  `cannot get property "timer" without inject`（apply 阶段抛错，必然没挂上）。

留在上面的原结论不改（结论对），但把这条推理纠正掉：拿 `kind` 判挂载会得出
两个方向的错误答案（把正常服务库当没挂上、把在跑的东西当已移除）。


## v0.1.0（2026-10-27 · 批准即执行：approved 之后由它动手）

### 为什么

`approved` 这一档 2026-10-23 加进来时只解决了「点过头」与「已落地」分开记，
**没解决谁来动手**：`agint-evolution-driver.runOnce()` 只挑 `status:'proposed'`，
`approved` 的行它一眼不看。结果是批准完的提案在家族面板里挂成一张
「已批准待执行（工作单）」，等老板自己想起来去改代码 —— 而 2026-10-26 批准、
2026-10-27 又补了 `blocker` 的 `a85ef850` 正是这一族的实证：批了、卡住、没人动、
也没有任何机制会在解锁后把它捡起来。

老板 2026-10-27 的要求：**批准即进执行流程，可选立即或定时，不要再让我去执行。**

### 新增

- 新插件 `agint-executor`（host 平面，`inject: []`，全软依赖）：
  - `ctx.setInterval` 轮询 `agint.evolve.claimDueExecutions()`（默认 15s，入队时 `wake()` 立即触发）
  - 六道闸按固定顺序判：状态 → blocker → 驱动可用 → 周上限 → 重试次数 → 跑
  - 调 `agint.evolutionDriver.runForProposal(proposalId)`，成功把提案标 `applied`（带落地证据），
    失败留原因、按 `maxAttempts` 有限重试，额度用尽落 `evolution.failure_pattern`
  - 服务 `agint.executor`：`tick / wake / status / runNow / runTick`
  - kill-switch `AGINT_EXECUTOR=off`

### 红线（写进代码，不是写进文档）

- `weeklyCommitCap` 默认 **3**：把 AGENTS.md「不要跨周累计自动部署超过 3 次」变成可执行判据。
  到顶 → `deferred` 顺延到**下周起点**（自然周，不是滚动 7 天 —— 滚动窗口下周一的第 3 次
  会压到下周一才释放，实际限流成 3 次/14 天，那不是那句话的意思）。
- `maxAttempts` 默认 **2**：失败重试有上限，不无限烧 token。
- `maxPerTick` 默认 **1**：串行执行，不在一个 tick 里爆发多条。

### 刻意不做

- **不接管老提案**：`execMode` 默认 `manual`，加字段之前批准的 50+ 条不会因这次升级
  突然开始自动改代码。
- **不造变异、不写仓库、不做 D-QAF 决策**：全部沿用 driver 既有路径，
  本插件只判「该不该跑」和「算不算数」。
- **不自己存状态**：队列正本在 `agint_evolve.execution`，两边各存一份必然对不上。

### 测试

`node test/executor.test.mjs`：六道闸逐条、顺延目标、重试上限、`commit` 未发生不算落地、
kill-switch、`runNow`，以及自然周口径与 `agint-evolve` 的一致性（跨插件不 import，
各自一份 `startOfWeek`，由用例钉等价）。
