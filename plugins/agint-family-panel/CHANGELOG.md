## 0.8.2 — 2026-10-27

### 标签分档补上 blocker：不许把「被前置挡住」写成「待入队」

**为什么**：老板看到一条提案写着「已批准·待入队」来问「什么时候执行」。查下去它是
`a85ef850`「权重真标定」—— `status=approved`、`execMode=immediate`、`execState=idle`，
但身上挂着 blocker（31/31 样本未人工标注 + 8-12 周内冻结 `THRESHOLDS/DIM_WEIGHTS`）。

自动入队闸 `autoEnqueueBlocker` 返回 `blocked` ⇒ `syncExecutionQueue` **不入队**，
只把 `execState` 置回 `idle`。于是提案台标签按 `execState=idle` 渲染成「已批准·待入队」——
读起来像「再等等就会自己跑」，实际它**永远不会入队**，要等人清 blocker。

更刺眼的是同一份数据在待办里被正确归到「已批准·阻塞中（等前置）」，两处口径打架。

**变更**

1. `v2-proposals` 的 items 带出 `blocker` / `unblockCondition`（原本只有待办那边有）。
2. `plabel()`：`approved` 且 blocker 非空 ⇒ 一律「已批准·阻塞中」，
   **优先于任何 execState**（blocker 在时执行态没有意义：它根本排不进去）。
   空白/纯空格不算阻塞（与 evolve 侧 `blocker.trim() !== ''` 同一口径）。
3. `execText()`：阻塞时直接给原因 + `（解锁：<unblockCondition>）` —— 一行说清
   「为什么不动、等什么」。

**测试**：`proposal-board` 15 → 16、`v2-proposals` 18 → 19，两条合计 34/34 通过。

## 0.8.1 — 2026-10-27

### 面板会自动刷新了 —— 「已批准·排队中」不再永久钉在屏幕上

**为什么**：老板点「立即执行」后，面板一直显示「已批准·排队中」，可他早就执行过了。
查下去发现执行**确实发生了**，而且是失败：

- `c629019a`（决策确信度 扣 1.7）19:54:54 入队 → 20:00:02 第 2 次尝试失败（`no actionable candidate`）；
- `8a4abaae`（扣 1.8）20:58:07 入队 → **1 秒后** 失败（`not-actionable … no target asset resolved`）。

失败原因本身是设计内的（复核类提案没有可改的代码目标，v0.8.0 的语义闸已能拦新的）。
真正的问题是**显示**：`submitDecision` 写完只 `load()` 一次，而那一拍 execution 必然还是
`queued`（窗口不足 1 秒）⇒ 页面把「已批准·排队中」画上去；1 秒后转 failed，**页面再也不重绘**。
于是执行态永久停在入队那一刻，读的人以为系统一直没动手。

**变更**

1. **取数收敛成一处**：新增 `refreshData({silent})`，手动「刷新」与自动轮询共用。
   两份 fetch 必然漂移 —— 手动那份校验 `ok`/报错，自动那份忘了校验，就变成「静默画旧数据」。
2. **15s 静默轮询**（`AUTO_MS`）：兜底刷新所有信号，包括执行态与待办分档。
   - 输入框聚焦 / 页面在后台 ⇒ 这一拍跳过（重绘会重建输入框，正在输的搜索词会丢焦点）。
   - 切回标签页立刻补一拍（`visibilitychange`）：后台不刷，回来不能还是十分钟前的画面。
   - 静默失败不覆盖画面：偶发取数失败把整页刷成错误页，比数据晚 15 秒更烦人。
     手点「刷新」时才把错误摆出来。
   - 静默重绘恢复原 `scrollY`：轮询不能把人从正在看的位置弹走。
3. **入队后追终态**（`chaseExecTerminal`）：`execution.state` 为 `queued|running` 时，
   2s 一拍追 6 次，追到非活跃态即停。执行器的确定性失败通常 1 秒内落定，不必等满 15 秒；
   也不无限轮询烧服务端。
4. **toast 不再谎报**：`已入执行队列（queued），由执行器自动动手` →
   `已入执行队列（queued）—— 结果会自动刷新到提案行`。入队只是开始，1 秒后可能就是失败。
5. **离线渲染测试兼容**：`test/proposal-board.test.mjs` 把本页脚本放进 vm 里跑，
   沙箱没有定时器 ⇒ `load()` 抛 `setInterval is not defined`，整块提案台渲染不出来。
   加 `TIMERS_OK` 探测（`typeof setInterval === 'function'`）后才起表。

**顺带修**：`evolve-exec-failed` 队列的 `note` 恒印「0 次尝试后仍失败」（实测那条是第 1 次）。
`spec.note(r.tables)` 收到的是**整份域的表**，而 attempts 在每一行上 ⇒ 取 `t.attempts` 永远 undefined。
改为从 `proposal` 表里真正失败的行取最大值，一条都没有就不编数字。

**测试**：`proposal-board` 12 → **15 条**（新增三条钉住这次事故：加载后起 15s 轮询表 /
入队后 2s 一拍追终态 / 只批准不入队就不许起追踪表）。
改动前该文件因定时器未探测有 4 条失败（`setInterval is not defined`）。
`v2-scan`（code 键基线 184→211）与 `q3-verdicts`（`agint-mutator` 声明了
`agint.eventBus.publish` 却无调用）两条失败与本次改动无关，属仓库/部署位既有漂移。

## 0.8.0 — 2026-10-27

### 提案台按「能不能自动执行」分档

**为什么**：老板要的是「批准即执行，不要再让我去执行」。但**不是每条提案都能被执行** ——
复核类提案（如 oracle 的「美谕提案」）要的动作是人去复核一条记忆条目，没有可改的代码目标。
首跑实测：它被默认的「立即执行」排进队列，driver 两次各 1 秒失败。

**变更**
1. `POST /proposal/decision`：提案 `autoExecutable === false` 时，排「立即/定时」一律
   **400**（`该提案声明不可自动执行（复核类提案）—— 只能「只批准」`）。
   ⛔ 这道闸在**服务端**：前端置灰可以被绕过，工具也能直接调。
   「只批准」照常放行 —— 拦的是「自动执行」，不是「批准」本身。
2. 提案台确认条：`autoExecutable === false` ⇒ 「立即/定时」两项 **disabled**、默认落到
   「只批准」、并写明原因；提交时同样按「只批准」发（与服务端同一口径）。
3. `v2-proposals` 带出 `autoExecutable`（⛔ 缺席 = true：老提案不能因这次改动集体
   失去被批准后自动跑的能力）。
4. 响应 `execution` 段补 `autoExecutable`，前端据此决定置灰。
5. `POST /proposal/decision` 另接受可选 `autoExecutable`（布尔）：**人工可以把一条提案
   标成「不可自动执行」**（存量提案没有这个字段，默认仍可执行 ⇒ 这件事以前改不了）。
   ⛔ 非布尔一律 400（猜错的后果不对称：钉死一条能跑的提案 vs 放走一条只会白跑的）；
   省略 = 不动原值（冻结语义，与 blocker 一致）；改这个标记算一次真实变更（不被幂等短路）。

**测试**：`decision-route` 19 → **29 条**、proposal-board 10 → **12 条**。

**同日实机复检又修三处**（v0.8.0 部署后拿真实提案试出来的）：
1. **闸门按「请求后的有效值」判**，不是只看现值 —— 同一个请求里既标 `autoExecutable=false`
   又排 `immediate` 是自相矛盾的请求（实机放行过），现在一律 400。
2. **标成不可执行 ⇒ 执行计划一并归位 `manual`** —— 否则留下一条「立即执行」的僵尸计划：
   它永远不会跑，但面板一直显示「执行 立即」，读的人以为它还在队列里。
3. **响应 `execution.auto` 不许谎报** —— 必须与「真的进了队列」一致（queued/running），
   否则 toast 会对着一条没入队的提案说「已入执行队列」。
4. 面板文案：`approved` + 不可执行 ⇒ 单列一档「已批准（不可自动执行）」，不落进
   「已批准·执行失败」（那是「试过没成功」，而它压根没被允许试）。
5. **待办分档**：不可自动执行的提案归「已批准·等手动执行（工作单）」——它要的动作是
   人去复核；从「自动执行失败（待处理）」里**排除**（那一档的含义是「自动执行试过了、
   没成功」，而它压根没被允许试，放着会让人以为系统还在替它跑）。


### 批准即执行：审批时选「立即 / 定时 / 只批准」，待办按执行态拆档

**为什么**：0.6.0 把「已批准待执行」拆成了「工作单」与「阻塞中」两档，但那一版的前提是
「没有执行器，执行=改源码，不该由状态字段代劳」。老板 2026-10-27 明确否掉了这个前提：
批准之后应当自己进执行流程，**可选立即或定时，不要再让人去执行**。
于是这边要做的就变成：把选择权做进审批动作里，并把「已批准」按执行处境拆开显示。

**变更**
1. `POST /proposal/decision` 接受可选 `execMode`（manual/immediate/scheduled）与 `execAt`：
   - 白名单校验；`scheduled` 必须给合法 `execAt`（缺/非法一律 400）
   - 省略 = 冻结原计划（不兜底成 manual —— 否则补一句理由就把定时计划静默降级了）
   - 非批准判定（rejected / wontfix / proposed）时顺手把计划清回 manual，不留「还会跑」的错觉
   - `setStatus` 的校验错（如 execAt 在过去）回 400 而不是 500
   - 响应补 `execution: { mode, at, state, auto }`，面板据此在 toast 里说清「已入队」还是「只批准」
2. 提案台：确认条增加「批准后怎么执行」选择器 + `datetime-local`（定时时出现），
   默认「立即自动执行」；选择器变更不重渲染日期控件（否则点一下就收掉）。
3. 待办口径拆三档（原 `evolve-approved` 收窄）：
   - `evolve-approved`「已批准·等手动执行（工作单）」= approved + 无 blocker + **未交给自动执行**
   - `evolve-exec-active`「自动执行中」= queued / running / deferred（kind: supply，人只能等）
   - `evolve-exec-failed`「自动执行失败（待处理）」= approved + execState=failed（kind: action）
   ⛔ 交给自动执行的提案**不再进工作单** —— 那是拿催办单去催一个已经在跑的东西。
4. 提案项与详情页带出执行计划与执行态（`execText()`：手动 / 定时·排队中·第 N 次·失败原因）。

**测试**：`decision-route` 13 → 19 条（exec 计划落库、400 分支、幂等、非批准清计划、400 而非 500）；
`v2-pending` 补「执行中不是工作单」「失败要带原因」两组断言，声明表 7 → 9 条。

**已知（改动前即红，与本次无关）**：`q3-verdicts`（agint-mutator 声明 publish 但同族无调用）、
`v2-scan`（家族 code 键 203 vs 基线 184，本次新增插件再 +5 → 208；基线待重新对账冻结）。

## 0.6.0 — 2026-10-27

### 待办表拆出「已批准·阻塞中（等前置）」：批准的是方向，不是「现在动手」

**为什么**：2026-10-27 老板问「我已经批准的提案为什么还在待办挂着，不该去执行吗」。
查下来两件事叠在一起：

1. `approved` 档按设计只统计、不自动执行（没有执行器，执行=改源码，不该由状态字段代劳）。
2. 更糟的是那条提案**不该被执行**：`a85ef850` 自己的 note 写「第 3 步客观不可行」，
   当周周报又明确「31/31 样本未人工标注，8-12 周内不得改权重常量」。
   于是「工作单」催人去撞自家门禁 —— 缺的是「为什么还不能做」的表达位。

**改动**：

- `PENDING_SPECS` 的 `evolve-approved` 收窄为「`approved` 且无 `blocker`」，仍是 `action`。
- 新增 `evolve-approved-blocked`（`kind: 'supply'`）：阻塞中的提案此刻人能做的只有等，
  与 `failure-supply` 同类；**不隐藏**，卡在哪/等什么必须一眼看见。
- 待办表条目渲染 `⛔ 卡在：…` 与 `⏳ 解锁：…` 两行。
- 唯一写通道 `POST /decision` 接受可选 `blocker` / `unblockCondition`（各 ≤200 字）：
  省略=不动原值，空串=解除。状态不变但阻塞信息变化时**不再被幂等短路**，
  且不拼「批准/拒绝」抬头（那会把一条注释伪装成一次决定）。
- 配套 `agint-evolve` **v0.9.0**。

---

## 0.5.0 — 2026-10-23

### 新增「提案台 · 人工审批」：全插件第一个也是唯一一个写通道

**为什么**：2026-10-23 实测三件事指向同一个缺口 ——

1. **队列只进不出**：`agint_evolve.json / tables.proposal` 95 行里 53 行挂 `proposed`，
   最老 43 天。唯一出口是手动工具 `evolve_set_status`，而 `evolution-cycle` 从不下调
   （driver 全库无 `setStatus`）⇒ 提案攒着，没人有地方落笔。
2. **表在说假话**：抽查 20 条 `proposed`，**10 条与代码事实不符**（早已落地）。
   拿这张表排优先级 = 把做完的事再排一次队。
3. **状态机缺一档**：四档里 `applied` 的语义是**已落地**，「人工批准」无处表达。
   配套 `agint-evolve` **v0.8.0** 新增 `approved`（已批准待执行）。

**做了三块**：

| 块 | 内容 |
|---|---|
| 队列视图 | 状态统计（待批/已批准/已落地/拒绝/wontfix）+ 年龄三段条（7 天 / 8–30 天 / 30 天以上）+ 状态页签 + 分类 chip + 搜索 + 排序 + 「只看 30 天以上」 |
| 单个提案 | 正文五节取证（目的·问题 / 方案 / 价值·收益 / 风险边界 / 关联）+ 元信息 + **证据栏** + 决策区 |
| 审批 | 批准 / 拒绝 / wontfix / 标记已落地 / 撤销改判；三步走：按钮 → 确认条 → POST |

配套：**待办**一节新增「已批准待执行（工作单）」队列（`PENDING_SPECS.evolve-approved`）。
批准过的提案从「待批」挪进这一行，落地标 `applied` 才消失 —— 否则批准 = 从待办里消失。

**证据栏（这一节的核心判据）**：从正文抽**路径**与**符号**两类可核对的东西，
核对目标文件是否存在、符号是否在引用文件里命中。三档线索（`stale` / `maybe-done` /
`neutral`）措辞一律「可能」。⛔ 不判「已落地」；⛔ 不把「没法核对」写成「不存在」
（wiki 仓路径标 `exists:null`）；⛔ 不收通用符号（全仓同名 ≥2 处不计，命中率 100% 的线索等于没有）。

**写通道**：`POST /api/agint-family/proposal/decision`，四道门（回环 / 自定义头 + 同源 /
JSON + 4KB / 状态白名单），`rejected` 与 `wontfix` 服务端强制要求理由；`applied` 强制要求**落地证据**
（改了哪些文件）—— 全表 applied 行的 note 本来就是证据，允许空证据等于亲手毁掉那张表。
写入只经 `agint.evolve.setStatus()`，**不直接改存储文件**。

**三条数据纪律**：`note` 是账本（改判时追加原记录，不覆盖）；幂等（目标态=现状 →
`changed:false`，不刷 `updatedAt`）；写完重取（前端不做乐观更新）。

**顺带**：`smoke.mjs` 第 109 行的视图切换按钮断言写的是改文案前的
「切换到 v1 名册」，HEAD 版本就已对不上（存量债，非本轮引入），本次对齐到
`client.js:1220` 的实际文案。

**测试**：`test/v2-proposals.test.mjs`（17）、`test/proposal-board.test.mjs`（10，
`node:vm` + 迷你 DOM）、`test/decision-route.test.mjs`（13，四道门 + 三条纪律）。
`node plugins/agint-family-panel/test/smoke.mjs` 15 组 PASS。

**部署注意**：`agint-evolve` 的 `approved` 行由旧版代码读取会被 zod 拒绝 ⇒
**新代码必须先于新数据部署**，两个插件一起换、一起重启。

## 0.4.0 — 2026-10-22

### 新增「单插件档案页」：在 v1 名册点行 → 进这一个插件的档案

**为什么**：名册只回答「家族有哪些插件、它们通不通电」。老板要问的是
「这个插件到底是什么、凭什么存在、现在欠什么债」，得去翻 manifest、CHANGELOG、
源码、storages 四个地方。四处拼一遍才知道的事，应该点一下就看见。

**放哪儿（决定与理由）**：放在**停靠面板的 v1 名册**里，点任意插件行进入。
档案是名册的下钻层级，不是第三个并列视图 —— `← 名册` 返回，页尾给上/下邻居。
没有做进 v2 整页：整页答的是横向对比（Q1 谁依赖谁 / Q2 谁在干活 / Q3 哪里在腐化），
不承载单实体；名册本来就是「插件列表」，点行打开这一行是最短路径。

**档案分六段，顺序 = 从身份到判断**：

| 段 | 内容 |
|---|---|
| 它自己说它是什么 | 首句职责 + 完整自述（折叠，不截断信息） |
| 分量 | 代码行数/文件数、提供服务数、取用服务数、被依赖插件数 |
| 契约 | `provides` 逐条 + `serviceDocs` 原文；inject / optionalInject / consumes / events / tools / 存储域 / 权限 / 生命周期 / 测试入口 |
| 接线 | 取用（服务 · 提供方 · `文件:行号`）+ 依赖它的插件（前 8，余下折叠）+ 声明与代码的对差 |
| 产出 | 30 天工具调用与失败率、bus 发布、cron 任务、7 天曲线、最近活动 |
| 债 | 结构差异（版本分裂 / 契约与代码分家 / 无 manifest / 无服务自述…）+ 注释命中 + 无提供方 |
| 变更史 · 位置 | CHANGELOG 最近 6 版；同一 id 多个物理位置时列主/次 |

**数据从哪来（不新开路由）**：复用 `/v2/data`（单次 ~180KB，60s 进程内缓存）。
⛔ 新开 `/dossier?id=` 会带来两条坏路：重算一遍 = 两套口径，做切片 = 筛选条件又是
一套口径。整页视图已在用这份 payload，所以口径只有一个。首点一次往返，回环可忽略。

**三层结构事实（本轮实测，不是假设）**：

- 一个插件 id 可能有**两个物理位置**：`plugins/agint-quality-eval`（manifest 0.3.3，
  **没有 lib/**）与 `plugins/agint-quality/agint-quality-eval`（0.3.5，**有 lib/**）。
  只取一个位置就会说谎（0 行代码 / 契约丢失）。档案改为**汇拢**：主位置取有代码那份，
  manifest 从任一位置取并写 `contractSource`，两处版本不同进 `drift.dup-stale`。
  实测命中 2 例（quality-eval、quality-sandbox），另有 1 例 `split-location`
  （quality-report：契约在顶层壳、代码在嵌套目录）。
- 仓库里 `manifest.version ≠ package.json.version` 的有 **13 个插件**（cron / dream /
  event-bus / evolve / mutator / quality-eval 等）。档案把它作为 `drift.version-split`
  报出来，并明说「谁生效取决于读取方」，不判谁对。
- `permissions.shell: []` 是**空数组**（`Boolean([]) === true`）。旧写法判真会把每个
  插件都标成「能起子进程」。已按「有没有内容」判，并有 negative control 测试。

**顺带收拾的两处口径（不是新功能）**：

- 归因表（工具名前缀 / cron id / 宿主键）从 `assets/panel-v2.html` 硬编码里抽出，落到
  `lib/v2-owners.js`，随 `payload.owners` 下发。理由：档案页住在 `lib/client.js`，
  两个前端各抄一份必然漂移（同一 cron 任务在两处归到不同插件，没人知道哪份对）。
  本仓已有先例（`probeEventSources` 同样下发）。缺 `owners` 段 = host 半是旧版，
  整页视图会在黄条里报出来，**不静默变成「无归因」**。
- `profileContext` 补进宿主键名单。本仓用 `ctx.get('profileContext')` 取当前 profile 名，
  宿主注入、无 `provide` 行，此前被算成「无提供方」，让每个读它的插件多背一条假债。

**只读边界（与 0.3.0 一致）**：档案页不写任何东西，不改 manifest、不提交 evolve 提案、
不代为审批。它是「看书」，不是「改书」。

**测试**：

- `test/v2-dossier.test.mjs` 11 条：三级身份降级、壳/真身汇拢、版本分裂、CHANGELOG
  三种标题写法、代码体量不把 `test/` 算进去、`pluginsDir` 不可解析时的整层降级。
- `test/dossier-view.test.mjs` 13 条：六段齐全、空数组 shell 判否、无 manifest 说
  「不可得」、入边 13 个时前 8 + 折叠且数量写全、注释/伞键不冒充提供方、声明与代码对差、
  无档案 id 与取数失败的分支文案、7 天曲线全 0 返回 null。
- 后者用 `createElement` 替身加载浏览器半（`test/helpers/browser-half.mjs`），因为
  「少一节 / 字段读错 / 把取不到画成 0」这三类错误在真宿主里要重启才能发现。

**已知环境债（与本次改动无关，另行报告）**：`test/v2-data.test.mjs` 在工作区路径
（`D:\DSH\project源码\...`，含中文）下跑 `node --test` 会让进程静默退出（exit 127），
崩在文件开头的 `cpSync`。同一文件在纯 ASCII 路径的 git worktree 里通过 ⇒ 判定为
「Node `cpSync` + 中文源路径」的环境问题，不是代码缺陷。A/B 对比（同路径、同 fixture）
显示本次改动前后**失败的用例完全相同**（`v2-delivery-by-topic` / `v2-oracle` 两条存量债）。

## 0.3.0 — 2026-10-22

### 新增「神谕 · 美之判词」分区：把 agint-aesthetic-oracle 的输出搬进面板

**为什么**：神谕层每天 09:00 打分开口，但产出只落在广播事件与它自己的存储域里。
老板要看「系统现在美不美」，得在面板外面翻存储。面板原有六节答的是
「谁依赖谁 / 谁在干活 / 哪里在腐化 / 有什么等着人处理」，没有一处回答
「**它自己怎么判**」。

**放哪儿（决定与理由）**：新增 tab「神谕 · 美之判词」，排在**待办之后、Q1 之前**。
待办与神谕都是结论面 —— 一个说「你要动手什么」，一个说「系统现在如何」；
Q1/Q2/Q3 是证据面。结论先看，证据在后。默认分区仍是 Q1，不改既有使用习惯。

**放什么**（四块，全部只读转录，不重算、不改判定）：

| 块 | 内容 |
|---|---|
| 判词 | 最新一张卡片的全文（判词行/整段文本）+ 美总分 + 判定 + 最丑维 + 数据 asOf + 开口时间 + 输出模式 + 公式版本 + 判尺指纹 + 缓存回退天数 |
| 三档评分 | daily / weekly / monthly / alert 各一格（分数、判定、最丑维、模式、公式版本） |
| 状态面 | kill-switch、沉默模式、连续失败、基线（method / 建基日 / 重标日 / 各维样本数）、lastGood、配额、运行态开关 |
| 广播史 | 最近 20 条 · 失败、被拦、被静默的行不隐藏，带 Δ 基线 |

**数据从哪来（两路，服务面优先）**：

- 服务面 `agint.aestheticOracle`：`cards()` / `history(24)` / `getState()` / `status()`。
  ⛔ 只有 `status()` 带运行态开关（envOff / memoryStore / metricsAvailable /
  evolutionAvailable / busAvailable），这些事实不在落盘文件里，所以不能只读文件。
- 落盘 `storages/agint_aesthetic_oracle.json` 三表：`cards()` 为空时用它的卡片补齐。
  订阅没回写是常见形态（event-bus 未挂载 / 订阅被拒）；只读服务面会把
  「订阅掉了」显示成「神谕从没开过口」—— 两件事，必须分开读。
- 补齐原因逐条写进 `notes`，面板用黄条原样显示。**不静默补**。
- `source` 字段记录数据**实际来源**（service / service+storages / storages），
  不是「服务面在不在」：服务面存在但三个出口全缺（旧版 oracle）时数据 100% 来自落盘。

**Δ 口径（本次最要紧的一条）**：生产 `baseline` 建于 2026-10-04（first-week-mean），
评分公式 r3 于 2026-10-09 落地，而 `oracleStateSchema.baseline` **没有
`formulaVersion` 字段** ⇒ 跨口径。Δ 照算，但一律 `deltaComparable=false` + 原因，
面板对不可比的行加 ⚠ 与黄字。
⛔ 不把「缺标记」当「同版本」。两道防线：`!formulaVersion` 早返回 +
`formulaVersion !== baseFormula` 宽比较（缺标记走 `!==` 也判不等）。

**实测（2026-10-22 读 `AGINT-date/storages/agint_aesthetic_oracle.json`）**：
35 条广播 / 3 张卡片（daily 66.9 · weekly 62.4 · monthly 93.1，无 alert 卡片）；
baseline 75.4143（first-week-mean，无 formulaVersion）；Δ = −8.5，判**不可比**。

**红绿自证**：

- 新增 `test/v2-oracle.test.mjs`（6 组断言：生产形状 / Δ 口径 / 同 topic 取最新 /
  缺段不装绿 / 落盘三形态 / collectOracle 四种降级）。
- 变异 1：删掉 `collectOracle` 的「cards 空则回落落盘」→ 红（actual 0 / expected 3）。
- 变异 2：撤掉 Δ 的两道口径防线（缺标记当同版本）→ 红（actual 3 / expected 0）。
- 既有 11 个测试文件全绿。`v2-data.test.mjs` 在 managed node 22.22.2-6 下
  exit 127 零输出、系统 node 24.20.0 下 PASS —— **stash 验过基线同样现象**，
  属环境差异，不是本批引入。

**版本**：manifest 0.2.7 → 0.3.0、package 0.2.9 → 0.3.0。
（两处此前不一致，verify-manifests 一直报 VERSION_DRIFT；发版必须同时改，顺手消掉该 WARN。）

## 0.2.9 — 2026-10-18

### 修「技能候选（待审）」把已审判的候选也算成待办

**为什么**：老板说「已经审过了，就不要挂在那里了」。面板报 42 条待审，
生产存储里 42 条候选 = 37 条 REJECTED + 5 条 ROLLED_BACK，待审 0 条。

**根因**：`PENDING_SPECS` 里 skill-candidate 的 `select` 是 `() => true` ——
整张 candidates 表都算待办，连终态也算。同表的 evolve-proposal 有
`status === 'proposed'` 过滤，curriculum 有 `status === 'open'` 过滤，
只有这一行漏了。

**改法**：新增 `CANDIDATE_OPEN_STATUSES` 白名单（PENDING_EVAL / PHASE1_PASS /
PHASE2_PASS / PHASE3_PASS / QUEUED_FOR_RELEASE / BUDGET_WAIT）。
用白名单不用黑名单：将来新增终态时默认不进待办，宁可漏报也不谎报积压。
`item()` 标题改取 `skillDraft.name`（候选表没有顶层 title 字段，旧代码恒 null），
并带上 status，让「停在哪一步等人」看得见。`total` 仍报整表行数，
「审过的有多少」不隐藏。

**实测（2026-10-18 21:5x，生产存储）**：
- 改前 `skill-candidate pending=42 total=42`
- 改后 `skill-candidate pending=0 total=42`（直接调 aggPending 与
  `GET /api/agint-family/v2/data` 两处读数一致）

**红绿自证**：测试 fixture 加 4 条终态（REJECTED / REJECTED_STATIC / ROLLED_BACK /
STABLE / RELEASED），断言 pending 只数 QUEUED_FOR_RELEASE 那 1 条。
旧 `() => true` 会让 pending=6，该断言必红（实测 fail 1）。

**同一类病的第二处**：`curator-overlap` 队列的 `select` 也是 `() => true`。
overlap_candidates 的状态机是 proposed / acknowledged / resolved
（agint-curator/lib/schema.js:212），后两个是人已处理过的。
本机此刻 0 行（生产存储实测），所以现场没有症状——但判据写错，一有数据就会重演。
一并改成 `status === 'proposed'`，标题改取 `skillA ↔ skillB`（原来只显示 id）。
红绿自证：只把这一行改回 `() => true` → 断言「只有 status=proposed 待处理」立即红。
# agint-family-panel CHANGELOG

## 0.2.8 — 2026-10-18

### 修三处同源的形状误判（判据用形状代替语义）

**为什么**：老板看到面板报「运行态不在仓库 · agint-evolution-memory-probe · bus 发布 1 条」。
逐条取证后发现三处误报，根因同一个 —— 判据拿形状当语义。

**1. 探针 source 被当成插件**
生产 bus（41754 行）里该 source 仅 1 条，payload.origin=manual-test
（2026-09-04T15:35:00Z）；仓库 git 全历史 0 次新增该目录；三处部署根各 39 个身份、
hasProbe=false。旧判据只按 source.startsWith('agint-') 分流，带前缀的探针掉了进来。
→ 新增 PROBE_EVENT_SOURCES（含 erify-after-fix / erify-final），随
payload.probeEventSources 下发；前端不硬编码第二份，test 与 event-bus
schemas.js 的 KNOWN_EVENT_SOURCES 探针段**双向比对**，任一侧漂移即红。

**2. isRepoRoot 把部署位认成仓库**
.agint-bundle 与 @agint/host 同时有 plugins/ 与 cordis.patch.yml，旧两标记判据
判 true ⇒ 
epoDirsSource=self-path、
epoDirs 117 项（78 个 *.tmp）、
wiringExemptions=unavailable。→ 加 .git（用 existsSync，兼容 worktree 的 .git 文件）。

**3. *.tmp 换版残留被当成插件身份**
bundle 槽 117 个 gint-* 目录里 78 个是 .tmp 残留，105 个带 lib/，
gint-quality.tmp 已出现在 live amilyDirs 里。
→ 2-scan.isTmpLeftover 导出，2-data 四处过滤口径统一。

**4. 附带：Config schema 缺 
epoRoot**
lib/index.js:613 从 v0.3 起一直读 config.repoRoot，但 cordis 按 schema 剥未知键
⇒ 配了也到不了代码。这是第 2 条只改 patch 不生效的真正原因。

**红绿自证**：三条判据各自回退后测试立即变红（均 pass 0 / fail 1）。
**验收**：27 单测 + smoke 15 组全绿，连跑 12 轮无 flake；live 运行态不在仓库 1 → 0 行。
## 0.2.7 — 2026-10-15

### 修 v2 iframe 首挂载不自适应高度（只有切 v1 再切回才正常）

**为什么**：高度自适应 effect 的依赖数组是 `[view]`，而 iframe 只在 `data` 载入完成
后才渲染。首次进入面板时 `data === null`（显示「载入中…」），`frameRef.current` 是
`null`，effect 直接 return——load 监听器和 ResizeObserver 都没挂上。数据到达、iframe
渲染出来时 `view` 没变，effect 不再重跑，iframe 永远停在兜底高度
`calc(100vh - 190px)`。切到 v1 再切回 v2 时 `data` 已在，iframe 与 view 变化同一次
commit 渲染，effect 重跑时 ref 已就位，监听器才挂上——这就是老板看到的「切回来才正常」。

**改了什么**（`lib/client.js`，浏览器半）：

- iframe 元素经回调 ref 存入 state（`frameEl`），effect 依赖改为 `[frameEl]`——
  iframe 一出现就挂 load/RO/轮询，不再依赖 view 翻转这一时机巧合。
- effect 挂上时若 iframe 文档已 `complete`（切回 v2 复用缓存文档，load 不再触发），
  主动补一次 `onLoad()`。
- `onLoad` 内先清理旧 RO / 旧 interval 再重建，防浏览器缓存命中重复 load 事件时泄漏。

**测试**：浏览器半是宿主 artifact，smoke 只静态检查（`test/smoke.mjs` L7 注释）；
`node --check` 语法通过 + 面板全量 smoke 6 组通过。

**生效条件**：双副本同步（mirror + bundle）后重启 dsh；浏览器半还需页面刷新重新拉取
`lib/client.js`。

---

## 0.2.6 — 2026-10-05

### 仓库位新增候选 ⓪：cordis `config.repoRoot`

**为什么**：0.2.5 让面板读 `docs/wiring-exemptions.json`，但豁免表**只存仓库位**，
部署位没有 `docs/`。生产进程要拿到仓库位，`resolveV2Dirs` 当时只认两个环境变量
（`AGINT_HOME` / `AGINT_REPO_ROOT`），本机都没设 ⇒ `repoDirs=unavailable`，
零投递分层只能退化成「待人工判」。

配 `AGINT_HOME` 这条路查证后**否决**：它是双语义变量。`install.sh` 当它是源码根，
插件侧当它是**数据根**（`.agint-bundle/cordis.patch.yml:32/79` 用
`AGINT_HOME + '/dreams'`、`+ '/reviews'` 落盘）。设成仓根会把运行态数据写进仓库工作树，
并把现有 `~/projects/AGINT/{dreams,reviews}` 的历史孤立掉。

env 这条路还有一层坑：进程内 `restart_request` 的 respawn 继承的是**老进程启动那一刻**的环境，
`setx` 之后不重开终端链就不生效；且本机活进程实测不是 `start-dsh.cmd` 起的
（PID 22052 = powershell + `%AppData%\npm\...\bin.js web`），写进 launcher 也覆盖不到现状。

**改了什么**：`resolveV2Dirs(env, selfUrl, configRepoRoot)` 新增候选 ⓪，优先级高于
`AGINT_HOME` / `AGINT_REPO_ROOT`，来源标记 `config`；`buildV2Payload(ctx, config)` 把
cordis 注入的 `config.repoRoot` 传进去。这是本机已有的一套做法——`agint-cron`、
`agint-evolution-driver`、`agint-evolution-memory` 都在 HOME 的
`profiles/web/cordis.patch.yml` 里按插件 id 配了 `repoRoot: "D:/DSH/project源码/DSH-AGINT"`
（机器私有值不入库，各机各配）。面板原先没吃到，只是因为代码不看 config。

空值（`null` / `''` / 空白 / 非字符串）与「指到没有 `plugins/` 的目录」都不算命中：
前者忽略、后者回落到下一候选且**不得谎标 `config`**。

**测试**：`test/v2-data-v03.test.mjs` 新增 3b 段（⓪ 命中 / ⓪ 优先级 / 6 种非法值忽略 /
落空不谎标）。面板全量 6/6 通过。

**生效条件**：需要在 HOME `profiles/web/cordis.patch.yml` 追加
`- id: agint-family-panel / config: repoRoot: ...`，并重启 dsh（config 只在加载时求值）。

---

## 0.2.5 — 2026-10-05

### 零投递订阅分三档 + 名册认嵌套身份（面板改读 check-wiring 的权威口径）

**为什么**：0.2.4 修完误报后，Q3 还剩两条「面板自造口径」的错：

1. 「订阅 → 投递对差」把 13 条零投递一律标成「可能是隐藏耦合或死订阅者，需人工判」。
   用总线全历史（12.4 万条）反查后分成两类：10 个主题**有发布史只是低频**
   （`metrics.snapshot` 533 条、`evolution.evaluated` 372 条、`policy.rolledback` 111 条），
   16 个主题**从未发布**。而从未发布的那批里，`evoorch.task-started/completed` 早在
   **2026-09-24 就归档在 `docs/wiring-exemptions.json`**（reason：P2-3 未实施、订阅方已就位等发布方），
   `bin/check-wiring.mjs` 也判它们 EXEMPTED。面板不认这份档案，等于每次重启都重报一遍已归档的事
   —— playbook §3.28 那一族坑：自己造发现逻辑，不认上游注册处。
2. 「运行态不在仓库」按**顶层目录名**核名册，于是 `agint-quality-policy` 被报成「仓库无此目录」——
   它实际在 `plugins/agint-quality/agint-quality-policy/`（有 manifest + lib + 159 条发布史），
   而且扫描器早就把它认成身份了。名册用错了集合。

**改了什么**：

- `lib/v2-data.js`
  - `aggBus` 新增 **`topicLast`**（topic → 全历史最后一次发布的 occurredAt）。投递计数随进程清零，
    「有没有人发过」只有全历史能回答。
  - 新增导出 **`readWiringExemptions(repoPluginsDir)`**：读仓库位 `docs/wiring-exemptions.json`
    （`bin/check-wiring.mjs` 消费的同一份），逐条带 reason / since / evidence。
    ⛔ 只在仓库位读：部署位 `.agint-bundle/` 下没有 `docs/`（实测），读不到就 state:unavailable 照实降级。
  - 新增导出 **`classifySubscriptions(sub, bus, exempt)`**（纯函数）：零投递分三档
    —— `exempted`（主题全在豁免表在册）/ `lowFrequency`（全历史发布过，给次数与末次时间）/
    `neverPublished`（既无豁免又全历史 0 条，只有这一档需要人工判）。
    两条降级纪律：豁免表不可用 ⇒ 不许凭空判「已豁免」，在册那条落回待判并说明缺哪项证据；
    总线全历史不可读 ⇒ **不许判低频**，分不清就标 `undetermined` 留在待判。
  - `collectV2Data` payload 新增 `wiringExemptions`。
- `lib/index.js`：路由与 `agint.familyPanel.v2Data()` 合并成同一份 `buildV2Payload(ctx)`，
  在 host 半算出 `subscriptionAudit`（浏览器两样输入都拿不到：豁免表在仓库位、全历史在 storages）。
- `assets/panel-v2.html`
  - Q3 的订阅行按三档渲染：「订阅 → 投递对差」只在有 `neverPublished` 时出现；
    另出「低频未投递」（不标琥珀）与「已归档断链」（只转录 reason 与出处，面板不重判）。
  - 名册集合并入 **`UNITS`**（扫描器身份表，含嵌套一层）；非 `agint-*` 形态的 bus source
    单列为「非插件来源」（一次性手工验证时手填的标签，如 `verify-after-fix`），不再当部署缺口。
  - 龄期条：「eventBus 投递」从恒 warn 的「无查询接口」改成真读数
    （N 个订阅 / 零投递 N / 需判 N / 自举时间），并新增「接线豁免表」一行带在册条数。
- `test/q3-verdicts.test.mjs`：新增断言 ⑦ —— 喂合成订阅 × 真实全历史 × 真实豁免表，验三档归属、
  验两种降级路径不许越权判定；仓库位段补一条 `R.wiringExemptions.state==='ok'`。

**结果**：7 个测试文件全绿。合成订阅下三档 = 已归档 1（trajectory 的 evoorch 两条）/
低频 2（metrics.snapshot 有全历史 + 通配订阅）/ 待人工判 1（虚构主题）。
部署位口径下 `wiringExemptions` 正确报 unavailable（bundle 无 docs/），此时面板 note 里写明
「豁免表不可用，此档条数可能偏多」，不假装判过。

**仍未了结（等老板拍）**：`mount.requested/succeeded/failed/restart-*` 6 条与
`input.signal.self-observation.*` / `input.signal.adversarial.*` 7 条既无发布方、
**也不在豁免表里**（`check-wiring` 判它们 NOT_YET_FIRED / DATA_ONLY）。要么补进豁免表并注明出处，
要么按真缺口排期——不能靠面板一直挂着「需人工判」。

**未部署**：本次只改仓库位。

## 0.2.4 — 2026-10-05

### 修两条误报判定：family-panel「从未接线」+ mascot「文档腐化」（判据与扫描口径）

**为什么**：老板把 Q3 判定表贴出来要求逐条核实。结论：六行判定里四行是误报，根因全在
面板自己身上，共四条：

1. `lib/v2-scan.js` 的 umbrella 判据只查「有无子键」，不查裸键自身是否被 provide。
   `agint.eventBus` 由 event-bus 同时 provide 裸键与 7 个子键 ⇒ `lib/index.js:431`
   这条真边被降级为「不建边」⇒ family-panel 的 code 边数算成 0。
2. 扫描器只认 `ctx.get('字面量')`。本仓另一类写法把服务名放在**声明表 / 多参包装器**
   的实参位之外：mascot `probe(ctx, 'cron', 'agint.cron', 'list', …)` 与
   `late(ctx, 'pet')`，family-panel `service: 'agint.cron'` ⇒ mascot 声明的 5 个服务
   一个都看不见 ⇒ 被判「文档腐化」。
3. 判据层 `assets/panel-v2.html` 有一条「`decl.length===0` 也照样报从未接线」的分支，
   直接违反同文件判据②；它拿注释行当证据，把 family-panel 自己列进了表。
   被列出的 `lib/v2-scan.js:13/48/62` 全是该文件 docblock 里的**反例说明**。
4. `readManifestConsumes` 只读 `consumes`，把消费写在 `optionalInject` 的插件算成
   「未声明」⇒ 覆盖率报 14/38，且第 3 条的分支因此被触发。

**改了什么**：

- `lib/v2-scan.js`：三分类先查裸键自身是否被 provide（是 → code）；新增第二参
  `declaredKeys` 与 `LITERAL_RE`「声明补边」，三重闸门 = manifest 声明白名单 +
  该行非注释态 + 同行未被直呼/间接形态命中。不传第二参即旧行为，单测口径不变。
- `lib/v2-data.js`：声明消费 = `consumes` ∪ `optionalInject`（去重保序），并先于扫描
  算出、作为白名单传给 `scanPlugins`。**不并 `inject`**：那是宿主 DI 注入名
  （webServer / timer / storageDomain），不写在 ctx.get 调用位，并进来实测多 2 条
  假腐化（`agint-quality-policy→storageDomain`、`agint-dream→agint.metrics` 走注入参数）。
- `assets/panel-v2.html`：删 `decl.length===0` 分支；新增同族判据 `famIn`（声明 K、
  代码取 K.x 视为同一依赖，反向同理）。本仓 7 个插件按命名空间声明、按子键取用，
  严格等值比会凭空造 11 条假腐化。
- `manifest.json`：补 `consumes: [agint.eventBus, agint.metrics, agint.cron, agint.selfModel]`；
  version 0.2.2 → 0.2.4（package.json 早前已走 0.2.3，manifest 那份没跟上）。
- `test/q3-verdicts.test.mjs`：判据 1 同步删分支；判据 2 改用与面板同口径的 `agint.`
  前缀闸（补边会带出 tools / loader / pet 这类宿主键，本仓不可能 provide）；
  判据 3 从「必须为 0」改为**冻结 5 条真实悬空声明**，新增一条即变红。
- `test/fixtures/v2-scan-baseline.json`：重冻 189/41/0、provided 97、familyDirs 38，
  附 HEAD 对照归因（同一工作树跑两遍：重分类 15 条、新增 0、消失 0）。

**结果**（q3 真实数据回放，部署位 + 仓库位双口径）：从未接线 0 行（原 1 行误报）、
无提供方 0 行、manifest 漏写 0、僵尸真候选 0、文档腐化 = 冻结的 5 个插件 / 7 条悬空声明；
声明消费覆盖 14 → 25/38。七个测试文件全绿（含 smoke 15 组）。

**新暴露的真实问题（待老板拍，本次不动别人家 manifest）**：5 条声明在代码里从不取用 ——
`agint-event-bus→agint.memory`、`agint-input-gateway→agint.memory`、
`agint-mount→agint.population.ingest`、
`agint-population→agint.diagnosis / agint.qualitySandbox / agint.memory`、
`agint-skill-graph→agint.skillAutocreate`。逐条 grep 过对应插件 `lib/`：前四条属
契约写在前、接线没做（population 文档写「软依赖 6 个」，实取 3 个）；skill-graph 消费的是
`skill-autocreate.*` 事件而非其服务。

**未部署**：本次只改仓库位。生效需铺两槽（`.agint-bundle/plugins` + `profiles/web/plugins`）
并重启，重启只能在 dsh 会话内发 `restart_request`。

## 0.2.3 — 2026-10-04

### storages home 认标探测（修「v2 三源全 ENOENT」，根治不依赖 DSH_HOME）

**为什么**：v2 面板顶部挂「⚠ 数据源降级 — ENOENT … `/home/kylin/storages/xxx`」，
`agint_tool_stats.jsonl` / `agint_cron.json` / `agint_event_bus.json` 三源同时报错，路径**少一层
`.dsh`**。真机（Linux）复现：dsh 进程**未注入 `DSH_HOME`**（`/proc/<pid>/environ` 确认），
于是走 `resolveV2Dirs` 的回退分支 `resolve(pluginsDir,'..','..','..')`——**固定三级**隐含假设
「pluginsDir 在 `<home>/profiles/web/plugins` 下」。但 bundle 实体自 2026-10-01 修「AGINT 自毁」
起挪到 `<home>/.agint-bundle/plugins`，同样三级只到 home 的**同级** ⇒ `storagesDir` 落到 home 之外
⇒ 三源各自 try/catch 降级成 `state:error`。即：**代码里的层级假设与 10-01 的部署位改动脱节**。

**改了什么**：`lib/v2-data.js` 把回退分支从「猜级数」改成「**认标**」——

- 新增 `isDshHome(dir)`（导出）：只看 `storages/` 是不是目录。刻意**不看** `profiles/`，
  因为两种布局都可能有 profiles。
- 新增 `resolveStoragesHome(pluginsDir, {maxUp=12})`（内部）：从 pluginsDir **逐级上溯**，
  每级验一次 `isDshHome`，第一个命中的即 home。就近优先（先查祖先含自身），触到文件系统根
  或超上限即停（防病态自引用死循环）。
- `resolveV2Dirs` 返回值新增诊断字段 **`dshHomeSource`**：`DSH_HOME` / `self-probe` / `fallback`。
- `DSH_HOME` 显式注入仍是最高优先，不被探测绕过；探测全失败时保留旧行为（拼一个大概率不存在的
  路径），让三源各自降级——**绝不整页 500**。

**效果**：home 相对 pluginsDir 的深度是几都无所谓。`.agint-bundle/plugins`（2 级）与
`profiles/web/plugins`（3 级）两种布局同时成立，**不再依赖启动时有没有注入 `DSH_HOME`**，
手敲 `dsh web` 也不会复发。

**测试**：新增 `test/v2-storages-home.test.mjs`（5 组断言）——`isDshHome` 三态；
**depth=2 与 depth=3 两种布局都解析出同一 home**（核心回归断言）；`DSH_HOME` 优先；
就近优先（嵌套 home 取内层）；推不出时降级不崩。全量 `node --test "test/*.test.mjs"` **6/6 绿**。

**真机验收**：**故意不注入 `DSH_HOME` 启动**（复现原 bug 场景，`/proc/<pid>/environ` 确认未设置），
`GET /api/agint-family/v2/data` 返回 `ok:true`，三源均无 `state:error`：
tools.total=2357 / cron=25 / bus.total=6905。日志 `skipping profile bundle` /
`failed to import` / `ENOENT` 三查全 0。`install.sh` 装后 35 入口 import 冒烟全通。

**已知无关项**：仓库位跑 `node test/smoke.mjs` 报 `Cannot find package 'zod'` —— zod 只装在部署位
`~/.agint-bundle/node_modules/zod`（K78 已知形态），`git stash` 对比确认改动前同样失败，非本改动引入。

## 0.2.2 — 2026-10-04

### v2 内嵌高度自适应（老板反馈：固定视口高不如 v1 的整页下拉）

**为什么**：0.2.1 iframe 固定 `calc(100vh-190px)`，实测内页内容高 ≈6000px 而视口
≈900px——面板只显示 1/6，内容在内滚一层，体验割裂。v1 是整页在外层 `.agintfp-root`
里下拉，老板要同样的效果。

**改了什么**：`lib/client.js` 的 v2 视图加高度自适应——同源直读
`contentDocument` 的 `scrollHeight` 设进 iframe 高度（load 时 + ResizeObserver
监听内页 body + 3s 轮询兜异步取数后的高度变化；同源读不到时退回视口高兜底，不抛）。
内页满高展开、`scrolling=no`，滚动统一归外层面板，与 v1 一致。「刷新」在 v2 模式
先复位高度再换 cache-buster src。路由与数据层零改动。

**测试**：smoke 静态断言加 `contentDocument`/`ResizeObserver` 两条；全量测试 +
`node --check` PASS。两槽（`.agint-bundle` + `profiles/web`）同步后 GUI 强刷新
（不行再 restart_request）。

## 0.2.1 — 2026-10-04

### v2 内嵌进停靠面板（老板改令：页面不单独放外面）

**为什么**：0.2.0 把 v2 做成独立整页 + 停靠面板留链接；老板要求收进「AGINT 家族」
面板本身。

**改了什么**：

- `lib/client.js`：停靠面板新增视图状态，**默认 v2**——iframe 内嵌 `api/agint-family/v2`
  （文档相对路径，沿用 base-href 子路径纪律；不用 `data.apiPrefix` 根绝对）。
  顶栏四个按钮：v2/v1 视图切换、刷新（v2 模式给 iframe 换 cache-buster src，
  v1 模式重取 /status）、新标签页打开（保留逃生口）、返回会话。
- v1 名册视图（分组/行状态/通电信号）原样保留，一键可切。
- kill-switch / 读失败 / 载入中的降级路径对两种视图同时生效（先判 data，再进 v2 分支）。
- 路由与数据层零改动；`/v2` 与 `/v2/data` 独立可达性不变（iframe 源就是它们）。
- package/manifest 0.2.1（顺带：manifest 描述改述内嵌形态）。

**测试**：smoke 用例 3 的静态断言改为匹配新实现（V2_PATH 文档相对、iframe 内嵌、
window.open(V2_PATH)、切换按钮文案）；`node --check` client.js；全量测试 +
plugin-check 11 维度 + L0 门禁通过。部署：仓库 → `.agint-bundle/plugins` +
`profiles/web/plugins` 两槽同步 → restart_request（playbook §3.27 纪律）。

## 0.2.0 — 2026-10-04

### v2 家族面板上线：整页 + 实时数据端点

**为什么**：现面板只显示激活状态，产出与关系没体现（老板 2026-10-03 起因）。效果稿
（Q1/Q2/Q3）拍板转生产：入口=独立整页 + 停靠面板留链接；数据=实时端点按需计算 + 缓存；
范围=端点 + 整页全量，`FAMILY_GROUPS` 本版本**保留不删**（设计稿 §10 删表决策另行拍板）。

**改了什么**：

- host 半新增两条回环路由：`GET /api/agint-family/v2`（text/html 整页，资产
  `assets/panel-v2.html` 按 mtime 缓存）与 `GET /api/agint-family/v2/data`（实时聚合
  JSON）。与 `/status` 同一套 `enabled` kill-switch 与回环守卫。
- 新增 `lib/v2-scan.js`：源码扫描器（L0.5 真源，设计稿 §1.2/§1.4）。
  `ctx.get/provide('agint.*')` 三分类 code/comment/umbrella；伞键（有子键的命名空间
  裸键）不建边。与 2026-10-03 效果稿基线的两处规则差（注释中伞键命中一律标 comment；
  provide 伞键行不进 hits）在实施计划 Task 2 声明并逐条对账。
- 新增 `lib/v2-data.js`：storages 三源聚合（tool_stats 30 天窗口 + 7 天日聚合、
  cron_state、event_bus events/deadletter）+ manifest 三形态 consumes + repoDirs；
  TTL 30s + mtime 签名缓存；每源独立降级 `{state:'error',reason}`，不装绿；
  `latencyMs` 不聚合（U2）。
- `assets/panel-v2.html`：效果稿转生产——删 `g.alicdn.com` itrace 外部埋点；内嵌常量
  改 `fetch ./v2/data`；渲染包进 `render()`，刷新按钮真实重算；龄期条/覆盖率改动态，
  不留硬编码；Q3「运行态不在仓库」改数据驱动（部署位+仓库位目录对差，不可得时标
  unknown）；「最后改动」仍为示意（待接 evolution ledger）。
- v1 停靠面板 Head 加「打开 v2 全页」按钮（新标签页，noopener）。
- `agint.familyPanel` 服务新增 `v2Data()` 方法（与路由同源同缓存）。
- 版本漂移修复：manifest 0.1.2 与 package 0.1.4 统一到 0.2.0。
- manifest：`permissions.fs` 补三条读声明（storages / profiles/web/plugins / plugins）。

**测试**：新增 `test/v2-scan.test.mjs`（三分类 + 注释状态解析 + 基线回归容差 ±2，
基线冻结于 `test/fixtures/v2-scan-baseline.json`）、`test/v2-data.test.mjs`（聚合形状、
窗口、降级、缓存）与夹具树 `test/fixtures/v2-home/`；smoke 增第 15 组（三条路由注册、
data 形状、HTML content-type、非回环 403、kill-switch 不吐数据、v2Data 存在）。
全量 PASS；假 host + 真实存储联调经浏览器断言（表非空、无 NaN、刷新/过滤/展开/主题可用）。

## 0.1.4 — 2026-10-03

### 分组表补录 `agint-ops-preset`

**为什么**：生产运维子 preset（`~/.dsh/.agent-presets/agint-ops/preset.yml`，
名「智进·生产运维」）的 loader 行 `agint-ops-preset` 此前不在分组表（label map），
落进「未归类（分组表待补）」兜底组，`declared:false`。它是 AGENT 预设，不是杂项。

**取证**：实机 `GET /api/agint-family/status` 返回 `unmappedIds: ["agint-ops-preset"]`、
`unmapped` 组 1 成员；`.agent-presets/agint-ops/preset.yml:1` 写明「智进子 preset」。

**改了什么**：`FAMILY_GROUPS` 的 `preset` 组（`AGENT预设`）成员表追加
`agint-ops-preset`，排在其余三个 preset 之后（组内按成员表顺序渲染，追加不影响既有下标）。

**测试**：smoke fixture 增补 `agint-ops-preset` 一行，断言它落进 `preset` 组且
`declared:true`；兜底组断言同步为只收 `agint-mystery` 一行。smoke 14 组 PASS。

## 0.1.3 — 2026-10-01

### 终止开关（`dsh-kill-switch`）并入 agint 家族

**为什么**：终止开关是独立 DSH bundle（`bundles/dsh-kill-switch`，包名
`@local/dsh-kill-switch`），按 bundle 规范不落在 `plugins/agint-*` 命名空间。
`splitFamily` 的三条判据全是 `agint-` 前缀，于是它在面板上被划进 host 名册——
实机确认：家族 39 行里 `/kill-switch/` 零命中，而它确实在跑（host loader entry
`include:dsh-kill-switch`；客户端 dock slot occupant `dsh-kill-switch` active:true）。
**跑得好好的组件，在家族视图里不存在。**

**改了什么**：

- 新增 `EXTERNAL_FAMILY_MEMBERS`（当前仅 `dsh-kill-switch`）：家族成员 =
  `agint-` 命名空间 **+ 这张显式外部名单**。判据是 module 名**精确匹配**。
- `FAMILY_GROUPS` 新增 `{ id: 'host-lifecycle', label: '宿主生命周期' }`，
  收纳 `agint-restart` 与 `dsh-kill-switch`；`agint-restart` 同时从 `infra` 组移出
  （同列一组的行若在两处重复列出会在面板上重复计数）。
- `groupFamily` 匹配成员时**先查 entry id、再查 module 名**。

**过程中被 smoke 抓到的真 bug**（先写 id 匹配时）：分组表按 entry id 命中，
而外部 bundle 的 entry id 带 dsh 的 composition-only `include:` 标记，于是该行
虽然归了族、却落进「未归类」兜底组。取证：`include:` 是组合期标记，dsh 自己的
`dsh-client-ui-settings-plugin-inventory/lib/client.js:131` 注释原话即
"composition-only `include:` marker"，且它显示前也要剥掉。因此没有把这个标记
写进分组表，而是加 module 名兜底——分组表保持可读，展示 id 保持 loader 原样。

**测试**：smoke 增至 14 组。第 14 组含正负样本 ——
正样本照抄实机那一行的真实形状（`id: include:dsh-kill-switch` /
`name: @local/dsh-kill-switch`），断言它落进宿主生命周期组、`declared:true`、
家族计数增量恰好 1、host roster 分母不变；负样本用 `dsh-twin-preset` 与
`dsh-kill-switch-extra` 两条前缀相近的行，断言它们**不**被拖进家族（白名单是
精确匹配，放宽成前缀就会把别的 bundle 一并吞掉）。另有断言确保 `agint-restart`
不会同时出现在两组。

**未做**：全量运行时 roster 的逐行复算。`Config.listConfigs` 的分页参数在本机
bridge 过不去（`limit` 恒报 `must be a number`），拿不到 239 行明细；替代证据是
面板全量计数对比，见下方真机验收记录。

**真机验收**（2026-10-01，`requestId=0bdcad50` 重启后实测
`GET /api/agint-family/status`）：

| 项 | 改前 | 改后 |
|---|---|---|
| `counts.total` | 39 | **40**（增量恰好 1） |
| `hostRowCount` | 239 | **239**（不变） |
| `counts.active` | 39 | 40 |
| 「宿主生命周期」组成员 | 组不存在（restart 在 infra） | `agint-restart`, `dsh-kill-switch` |
| infra 组是否仍含 `agint-restart` | 是 | **否** |
| `dsh-kill-switch` 所在位置 | 不在家族（落 host 名册） | 宿主生命周期组，`declared:true` |
| `unmappedIds` | `["agint-ops-preset"]` | `["agint-ops-preset"]`（未变） |

**`total` 增量恰好 1 且 `hostRowCount` 239 未变**，即全量口径上只多认了终止开关
一行，其余 238 条 host 行没有一条被卷进家族 —— 这正是上面「未做逐行复算」所缺的
那格证据。

回归确认：重启后 `conversation.composer.dock` 的 occupant `dsh-kill-switch`
仍 `active:true`（本插件只改只读统计，未触碰终止开关本体）。
`agint-ops-preset` 落 unmapped 是既有问题，与本次改动无关，未处理。

## [Unreleased]

### 测试加固（无功能变更）

- **假 ctx 改用 Proxy 复刻 cordis 语义**：`makeCtx()` 此前返回带 `config` 的普通
  对象 —— 读未注入属性静默返回 `undefined`，于是 0.1.0 那个
  `apply(ctx){ ctx.config }` 的 bug **本地 11 组全绿、真宿主直接拒绝加载**。
  现在白名单外的属性读取一律抛
  `cannot get property X without inject`，`config` 明确不在白名单（它是 apply
  第二参数，绝不能从 ctx 上读）。
- **新增第 13 组断言（cordis 契约）**：先断言陷阱已武装（`ctx.config` 读取必抛），
  再断言 `apply` 在陷阱之上仍能跑完 —— 缺任一都说明测试在放水。
- **反向对照已做**：把 `void ctx.config` 塞回 `apply` 第一行，测试在第 4 组即抛
  `cannot get property config without inject`（与真宿主报错一致），确认新断言
  真能抓到该类回归；验毕还原源码，smoke 12 组 PASS。

## 0.1.2 — 2026-09-29

### 分组语义修正

- **「未归类（分组表待补）」组中的三个 AGENT 预设插件归位**：agint-preset、
  agint-blockchain-preset、agint-investor-preset 此前不在分组表（label map），
  落入 unmapped 兜底组（declared:false）。新增分组
  `{ id: 'preset', label: 'AGENT预设' }` 收纳三者，面板上显示为「AGENT预设」，
  declared 转 true；unmapped 兜底组保留，仅收纳真正未入表的 agint-* 行。
- smoke 测试同步：fixture 增补 agint-preset（断言落入 preset 组、declared:true）
  与 agint-mystery（断言 unmapped 兜底只收未入表行、unmappedIds 正确）。

### 验证

- smoke 11 组 PASS；浏览器实测 8 组（memory/governance/evolution/quality/
  closed-loop/execution/infra/preset），三个 preset 成员 declared:true。

## 0.1.1 — 2026-09-29

### 修复

- **apply 签名不符 cordis 契约导致宿主拒绝加载**：v0.1.0 写成 `apply(ctx)` 内读
  `ctx.config`，cordis 报 `cannot get property "config" without inject`、条目激活失败
  （宿主日志 `dsh: warning: 1 entry did not activate`，面板从未真正挂载）。
  改为 cordis 标准姿势 `apply(ctx, config = {})` —— config 是 apply **第二参数**，
  与 agint-aesthetic-oracle 等成熟插件一致。`allowNonLoopback` 改为闭包常量。
- `test/smoke.mjs` 同步：apply 第二参数传配置（此前 stub ctx 塞 `ctx.config`
  掩盖了真实宿主差异，测试过而宿主炸）。
- **成员状态全 unknown（38/38）**：v0.1.0 的 `readRows` 读 `entry.runtime.status`，
  但 cordis-plugin-loader 的 entry 没有 `runtime` 字段——真实生命周期状态在
  `entry.fiber.state`（FiberState 枚举：PENDING=0/LOADING=1/ACTIVE=2/FAILED=3/
  DISPOSED=4/UNLOADING=5）。新增 `fiberStateToStatus` 映射（2→active、3→failed、
  0/1→loading、4→disposed、5→unloading、无 state→unknown），`readRows` 改读
  `entry.fiber.state`。修复后实测 38 成员全部 `status:"active"`、`unknown:0`。
- **panelVersion 硬编码 `'0.1.0'`**：改为 `createRequire` 读 `package.json` 的
  version，面板自报版本与包版本永远一致（修复后实测 `panelVersion=0.1.1`）。
- `test/smoke.mjs` 的 row() stub 同步为真实 loader 结构
  （`options + disabled + fiber.state`），新增状态映射与 counts 断言。

### 验证

- smoke 11 组 PASS（含 fiberStateToStatus 8 组映射断言、混合 counts 断言）；
  重启后宿主无 `1 entry did not activate`，路由 `GET /api/agint-family/status`
  真正注册；浏览器实测 `panelVersion=0.1.1`、`counts {total:38, active:38,
  unknown:0}`、signals 三项全 ok。

## 0.1.0 — 2026-09-29

首次发布：AGINT 家族面板以**宿主原生停靠面板**形态上线（此前 AGINT 没有任何浏览器半代码，
33 个插件全是 host 半，家族在 GUI 里不可见）。

### 新增

- **双半插件**：host 半 `lib/index.js` + 浏览器半 `lib/client.js`，
  经 `package.json` 的 `dsh.client`（platform=web）+ `exports["./client"]` 声明，
  由 `dsh-client-modules` 按行解析到包清单并投放到浏览器模块表。
- **原生席位注册**：`sidebar.panellist` 入口行 + root `main` keyed slot 面板页，
  两者共用 id `agint-family`；全部经 `ctx.slots.inject`，席位不存在即静默不挂。
- **席位切换**走 `ctx.layout.selectPanel(id | null)`，不做 DOM 抢占；
  面板内「返回会话」按钮回落到会话界面。
- **尺寸自适应**：`grid auto-fill minmax(260px,1fr)` + `min-width:0`；
  入口型页面遵守 `--dsh-frame-top-clearance`。
- **只读回环路由** `GET /api/agint-family/status`：名册（loader 权威）+ 分组 +
  三个通电信号（cron / metrics / selfModel），默认只放行回环。
- **降级与 kill-switch**：信号缺席/抛错 → `unavailable`/`error` + reason；
  `enabled:false` 时路由仍应答 `{enabled:false}`，面板显示「已关闭」。
- **未归类兜底**：分组表只做标签映射，未命中的行进「未归类」组并列出 id。
- 冒烟测试 `test/smoke.mjs`（11 组断言，含降级、非回环拒绝、kill-switch）。

### 挂载

根 `cordis.patch.yml` 追加 `agint-family-panel` 行（bundle 位 + 兼容镜像位同步，md5 三方全等）。
