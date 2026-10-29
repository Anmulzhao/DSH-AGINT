# agint-executor CHANGELOG

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
