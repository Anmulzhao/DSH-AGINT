# agint-evolve CHANGELOG

## v0.22.0（2026-11-07 · 确定性不可执行不再挂成「已批准·执行失败」）

### 问题（生产实证）

2026-11-04 批量批准 19 条、2026-11-07 批准 4 条，全部以 `已批准·执行失败` 挂在面板。
失败原因集中在 `not-actionable`：driver 的 `resolveTargetAssets()` 只认单个仓库文件/技能，
而特性级、机械动作类提案的正文里没有仓库路径（实测 `mentioned:0 inRepo:0`）。
这类失败是 **deterministic**（重试不会变），但旧协议只把 job 记成 failed，
提案 `execState=failed` 就永久停在 `person/failed`，**没有任何自动出口**，只能人工改状态。

### 改动

新增 `agint.evolve.markNotActionable(id, reason)`：

- `status` 保持 `approved` —— 批准是人的决定，机器不替人撤销。
- `execMode → manual`（退出自动执行队列）、`execState → idle`（脱离失败态）。
- `execError` / `note` 写明原因与下一步：已实现→applied / 不适用→wontfix / 需拆分→补可执行单元。
- 撤销同提案其它活跃 job，避免重复尝试。
- ⛔ 不自动标 applied / wontfix：两者都要证据与判断，机器代判就是撒谎。
- ⛔ 只动 `approved` 的行；人已改判成 applied/wontfix/proposed 时不抢写。

面板档位从 `person/failed` 变为 `person/plan`（待定执行计划），由人决定结案方式。

### 测试

`test/execution.test.mjs` 新增「确定性不可执行 ⇒ 退出自动队列」用例；71 项全过。

## v0.21.0（2026-11-03 · 紧急修复：v0.20.0 的 output schema 让整个 preset 加载失败）

### 现象

升级到 0.20.0 后，UI 里所有 AGINT preset（`agint` / `agint-blockchain` / `agint-investor` /
`agint-ops` / `agint-zgs`）一律显示红色「加载失败」，错误原文：

```
agint-evolve-tools (../../.agint-bundle/plugins/agint-evolve/lib/tools.js):
unsupported JSON schema:
schema.properties.mandate.type must be string/number/integer/boolean/null/array/object/json,
or use oneOf
```

### 根因

v0.20.0 给三处 output schema 的可空凭据写成 `type: ['object','null']`。
dsh-tools 的 JSON Schema **子集只收单个 type 字符串**
（`dsh-tools/lib/types/json-schema.js:244`，`SCHEMA_TYPES` 是闭集），
type 数组直接抛 `UNSUPPORTED_SCHEMA`。

而 `assertSupportedJsonSchema(output.schema)` 的位置是 `tools.register()`
（`dsh-tools/lib/index.js:2978`）—— **tools 插件挂载的入口**。
一行 schema 写错 ⇒ 整行 `agint-evolve-tools` 激活失败 ⇒ 该 preset 下所有 agent 起不来。
preset 的失败态是整条链的，所以五个 preset 一起红。

### 为什么门禁全绿、用例全绿

- 门禁四连（plugin-check / check-wiring / parity / compat）**都不调 `tools.register()`**，
  它们查的是接线、副本一致性、dsh 版本兼容；
- 共用契约替身 `plugins/_shared/test-stub-dsh-tools.mjs` 的 `assertRequiredTrue`
  **只查 `required === true`，完全不看 `type`** —— 这是最大的盲区：
  替身比真宿主宽松，所以「全绿」没有判据价值。

### 修法

1. `lib/tools.js` 三处改成上游惯用的 oneOf 写法（对照 `agint-cron/lib/tools.js:132`）：
   ```js
   mandate: {
     required: true,
     oneOf: [
       { type: 'object', additionalProperties: false, properties: { ... } },
       { type: 'null' },
     ],
   }
   ```
   ⛔ `properties` 只能留在 object 分支**内部** —— raw 子集禁止 `properties` 与 `oneOf` 同级
   （`json-schema.js:175`）。但 `required: true` 可以同级：它是 DSL 作者层的 requiredness 标记，
   编译期被提到父级 `required` 数组、不进入子节点产物（`index.js:603/604`），实测无误。

2. **补护栏**：`plugins/_shared/test-stub-dsh-tools.mjs` 新增 `assertSchemaSubset()`，
   `defineTool` 在 `assertRequiredTrue` 之后调用它。复刻 raw 子集的三条判定：
   type 必须单字符串且在闭集内 / type 与 oneOf 不并存 / oneOf 同级禁 properties·required(数组)·items。
   ⚠️ 布尔 `required: true` 与 oneOf 同级**要放行** —— 拒绝真宿主接受的写法是另一种失真。

3. `plugins/_shared/test-stub-contract.test.mjs` 加 5 条用例（阴性对照 ④⑤⑥⑦ + 两条阳性），
   其中 ④ 直接复刻本次事故形状。

### 阴性对照（实测变红）

把任一处改回 `type: ['object','null']` ⇒ evolve 用例 **9 条变红**，
含 `tools-contract.test.mjs` 的「工具注册」「真调一次」两条。

### 验证

- 真实 dsh-tools（0.2.1-rc.5）直接 `mod.apply(fakeCtx)` ⇒ 6 个工具全部注册成功
  （`evolve_review` / `evolve_read` / `evolve_propose` / `evolve_proposals` /
  `evolve_set_status` / `evolve_executions`）；
- evolve 测试 119/119；共用契约测试 12/12。

## v0.20.0（2026-11-03 · W8-3 Mandate：批准时固化改动范围，越界须重新审批）

### 起因：`approved` 只说「同意做」，没说「同意改哪些东西」

执行器把 `proposalId` 交给 driver，driver 从**提案正文抽路径**（`extractRepoPaths`）
再写仓库 —— 也就是说「改哪里」是在执行的那一刻才被决定的。两个口子：

1. 正文在批准后被编辑，多写一个路径 ⇒ 这次执行就改到了没人批过的文件，
   而台账上毫无异常：status 是 approved，凭据"一直在"。
2. 抽取规则本身变宽（比如认了新的路径形态），历史批准的语义随之扩大。
   这不是假设 —— `normalizeRepoPath` 就因为部署位路径认不出来而加过一轮壳剥离。

### 凭据结构

`mandate = { proposalId, paths[], grantedAt, policyVersion }`，在 `approved` 落库那一刻签发。

⛔ `nullable().default(null)`，**不能**给默认对象：老提案（90+ 条）没有这个字段，
给默认 `{paths: []}` 等于凭空造一份「批准范围为空」的凭据，`checkMandate`
会把「没有凭据」（unknown）误读成「批准了零个文件」。
**null 与「有凭据但是空数组」必须可区分。**

### 判定：三态，不是布尔

| state | 含义 | 执行器怎么办 |
|---|---|---|
| `ok` | 正文路径 ⊆ 凭据路径（收窄也算 ok） | 跑 |
| `mismatch` | 有路径不在凭据里，或凭据归属不对 | **拦**，须重新审批 |
| `unknown` | 没有凭据（老提案），或两边都空 | **放行**，但留痕 |

⛔ **`unknown` ≠ `mismatch`**，这是本设计最容易做错的地方：
- 判成 mismatch ⇒ 升级瞬间 90+ 条历史提案全部停摆；
- 判成 ok 而不留痕 ⇒ 「没验过」冒充「验过了」，台账上两者长得一样。

判据收窄的方向也写死了：本模块的路径抽取只认反引号包裹、且含 `/` 的 token
（比 driver 那份窄）。漏认会让范围偏小，偏小是**安全**方向 —— 多出来的路径
会被判 mismatch 走重新审批，而不是被静默放行。

### 凭据生命周期

- 进入 `approved` 且**当前没有凭据** ⇒ 签发。
  已批准后改 blocker / 执行计划**不重签** —— 否则「改一句阻塞原因」就能把范围
  悄悄刷新成新正文，等于给越权开后门。
- 离开 `approved` ⇒ 凭据置 null。状态已不是批准，留着只是一份过期授权。
  从 applied/rejected 改判回 approved 会重新签发（那是一次新的批准）。

### 用例

- `test/mandate.test.mjs`（新，11 例）：M0 归一化（去重/排序/剥 `./`、行号、尾斜杠）、
  M1 批准时签发、M1b 抽不到路径时是 `[]` 而非 undefined、
  M2 正文改宽判 mismatch 且指出具体路径、M2b 收窄仍 ok、M2c 顺序无关、
  M3 老提案 unknown、M3b 两边都空也是 unknown、M3c 凭据归属错判 mismatch、
  M4 `checkMandate` 只读（不改入参）。
- evolve 全量 **119/119 通过**。

### 顺带修

三个工具的 output schema 补 `mandate` 声明（`type: ['object','null']`）。
`proposal-timestamps` ④ 立刻抓住 —— 这正是那条护栏的用途。

### 已知边界（未做）

`markProposal` 是通用的读-改-写，注释说「只动执行相关字段」但没有技术约束，
理论上 `patch` 里放 `body` 能改正文。**查过了：对外服务里没有改正文的入口**
（`body` 只在 `propose` 出现一次），所以这目前是理论缺口，没有加白名单 ——
加白名单会波及所有调用点，收益不值这个风险。若日后新增正文编辑入口，必须先回来看这里。

## v0.19.0（2026-11-03 · W8-2 Outbox + receipt：note 冻结语义 + set_status 返回体补齐）

### 一、`note` 改成冻结语义 —— 修一条「静默删掉人工记录」的活路径

原实现两行合起来是个陷阱：

```js
async setStatus(id, status, note = '', opts = {}) { ... }     // ① 默认值把 undefined 变成 ''
const updated = normalizeProposal({ ...rec, status, note: note ?? rec.note ?? '' });  // ② ?? 以为能拦住
```

① 先把 `undefined` 降级成空串，② 的 `??` 就再也拦不住 —— `'' ?? rec.note` 求值为 `''`。
**结果：任何「只改状态、不给 note」的调用都会把整行 note 清空。**
真凶是默认参数，不是 `??`（传 `null` 时 `??` 是能拦住的，用例 N4 钉着）。

两条真实入口都踩在这上面：

| 入口 | 形态 | 后果 |
|---|---|---|
| 工具 `evolve_set_status` | `tools.js:323` 直接透传 `args.note`；模型不带 note 时是 `undefined` | 落库成功、note 被抹、**无任何报错** |
| 服务直调 | `evolve.setStatus(id, 'applied')`（`shadow-publish.test.mjs:131` 就这么写） | 同上 |

为什么这比报错贵：本仓的提案 `note` 是**唯一的人工判断留痕**。面板写路由靠
`composeDecisionNote` 自己拼前缀绕开了它，所以从面板操作完全看不出来；
一旦从工具侧改判，证据静默消失、而 `updatedAt` 照常刷新 —— 事后读到的是
「刚被改过、但什么都没留下」的一行，比抛错难查得多。

改为与 `blocker` / `execMode` **同一冻结语义**：

- 不传（`undefined` / `null`）⇒ 保留现状
- 传 `''` ⇒ 显式清除（要清就得说清，不能靠省略）
- 传非空 ⇒ 覆盖
- 传非字符串 ⇒ 抛错（不猜）

工具入参描述同步改成「省略=保持原有记录不动；要清除请显式传空字符串」——
此前只写「变更说明」，模型会合理地认为不填没关系。

### 二、`evolve_set_status` 返回体补齐 stage 四件（既有 bug，非本次引入）

v0.24.0 引入 stage 九档时，`ticketStage()` 的四个派生值被写进
`evolve_set_status` 的 output schema 并标 `required`，但 `execute()` 的返回体没有它们。

- `evolve_proposals` 幸免：它直接返回 `listProposals()` 的行（自带 `decorateProposal`）
- `evolve_set_status` 是手工拼返回体 ⇒ **每次调用必被 DSH strict 校验打回**

而写路径是「先落库、后校验」⇒ 报错时状态**已经改完**。调用方看到失败重试一次，
撞上幂等短路得到「状态没变」—— 两边对不上账。

`proposal-timestamps.test.mjs` ④ 一直红着，`git stash` 验证过与本次改动无关。

补的时候踩到一个值得记的坑：`ticketStage()` 返回的键是**短名**
`side` / `label` / `why`，工具输出要的是 `stageSide` / `stageLabel` / `stageWhy`。
最初写成 `stage.stageSide` ⇒ 三个字段「存在、类型对、永远为空」，schema 照过、面板照显示空白。
`S4`（声明集 ⊇ 返回集）**抓不到**，因为键是齐的。必须靠 `S1`（不许空串）
+ `S2`（映射不错位）两层一起拦。

顺带补齐 `execStartedAt` / `execFinishedAt`（返回体原来漏带，schema 也没声明）。

### 三、smoke 补路径纪律 fixture（消掉长期 WARN）

`manifest.permissions.fs` 声明了 `read:plugins` / `write:reviews`，但 smoke 没有
路径用例 ⇒ `plugin-check` 长期报「permissions.fs 非空但 smoke 缺跨平台 fixture」。
补三条：正向正斜杠相对路径可读、`../` 逃逸必须抛 `escapes root`、
前导 `/` 被剥后仍按 root 内相对路径寻址。

### 用例

- `test/note-preservation.test.mjs`（新，10 例）：N1 阴性对照（复刻修复前求值、
  实测算出 `''`）+ N2–N10 覆盖四条入口 × 四种传参 + applied 追加原阻塞痕迹。
- `test/set-status-derived.test.mjs`（新，5 例）：S1 四件齐全且值随状态变（不许硬编码）、
  S2 与 `ticketStage()` 逐键对拍（钉键名映射）、S3 老版本服务无 `ticketStage()` 时字段仍存在、
  S3b 阴性对照（读错键得到 `undefined`）、S4 声明集 ⊇ 返回集。
- `agint-evolve` 全量：**108/108 通过**（此前 103 例 + 1 既有红 ⇒ 现在 0 红）。

### 阴性对照（全部实测变红）

| 拆掉什么 | 谁红 |
|---|---|
| 把 `applyStatus` 改回 `note ?? rec.note ?? ''` + 默认参数 | N2 / N3 / N7 / N10 |
| 把工具里的键名改回 `stage.stageSide` 等 | S1 / S2（S3、S4 仍绿 —— 证明两层护栏缺一不可） |
| 拆掉 `clean()` 的 `escapes root` 判断 | smoke 11b |

### 未做（诚实边界）

- **没做 outbox 表**。原本计划加一张 outbox 记录「面板点了什么、有没有被消费」，
  但读码后确认：面板路由的幂等短路 + `composeDecisionNote` 保留 `prev.note`
  已经把「重复写」和「中转丢 note」都处理了，真问题是 `setStatus` 的 note 语义。
  加一张表只会多一个需要清理和核对的状态源。**事件让系统知道，动手要显式** ——
  这里该修的是入口语义，不是再加一层记账。
- `note` 冻结语义不改变 `REASON_REQUIRED`（`applied` / `rejected` / `wontfix` 仍必须写理由）。
  那条是**跨调用**的完整性要求，与「同一次调用的缺省行为」是两件事。
- 面板 `composeDecisionNote` 未改：它的 `PANEL_NOTE_MARK` 前缀去重逻辑仍然需要，
  因为状态变化时确实要拼「谁在什么时候判了什么」的抬头。

## v0.18.0（2026-11-03 · W8-1 Effects：周额度按「提案」计数，不再按「执行行」）

### 起因：红线说的是「部署几次」，代码数的是「改了几个文件」

`weeklyUsage()` 的判据是 `jobs.filter(ok===true && state==='succeeded').length`
—— 数的是**执行行**。而 v0.22.0 起 `partial` 会自动续跑：一条横跨 N 个文件的提案
会产出 **N 条** `ok:true, state:'succeeded'` 的执行行（每条只落地一个原子单元）。

于是**一条提案吃掉 N 格周额度**。实测后果（本机 `weeklyCommitCap=5`）：
一条 3 单元提案 + 续跑上限 5 ⇒ 单条提案就能把 5 格全吃光，之后所有提案一律
`defer` 顺延到下周。那一周系统看起来「很忙」，实际只推进了一条提案。

这不是限流，是误伤 —— AGENTS.md 红线原文是「不要跨周累计自动**部署**超过 N 次」，
部署的单位是**提案**，不是文件。

### 改动

- `lib/execution.js:weeklyUsage()` 返回 `count` 改为按 `proposalId` 去重后的条数；
  新增 `proposals`（去重后的 id 列表）。`jobs` 仍是**未去重**明细 —— 周报要能说出
  「跑了 7 次、涉及 3 条提案」，两个数语义不同都保留。
- `executionStats()` 新增 `weekExecutions`（成功执行**行**数）与 `weekProposals`。
  `lastWeekCommits` 字段名不变（执行器 `decideRun({ weekCommits })` 与面板按它判上限），
  语义变更见上。
- `lib/tools.js` 的 `evolve_executions` 输出 schema 加 `weekExecutions`，
  渲染成「本周落地 3 条提案（共 7 次执行）」。
  ⛔ 必须与 `weekCommits` 并列：只报一个数会让人把续跑误读成又落地了一条新提案。

### 两条刻意的口径决定

1. **宁多算，不错并**。缺 `proposalId` 的行（历史脏数据 / 手写夹具）每条算独立一格，
   键退回 `__row_<id>`。天真写法 `String(j.proposalId ?? '')` 会把两条 `undefined`
   和一条 `''` 全部挤成同一个键 —— 实测 3 条真实执行被记成 1 格，上限被静默放宽 3 倍。
   **错并让红线悄悄失效，多算只会让它更早触发**，方向不对称。
2. **一致性由用例钉住，不靠人工记忆**。`agint-executor/test/week-unit.test.mjs`
   有一份独立实现（跨插件不许直接 import）；`weeklyUsage` 侧新增 E11 用真实现
   对拍五组数据，其中「缺 proposalId」那组正是两条实现最容易分歧的地方。

### 验收

- `agint-evolve` 全量 **92/92**（新增 `test/weekly-usage.test.mjs` 11 例）。
- `agint-executor` **6/6**（新增 `test/week-unit.test.mjs` 5 例）。
- ⛔ **阴性对照实测会红**：① 拆掉去重退回旧口径 → E1/E2/E3 红（证明这三条真在测口径）；
  ② 让 evolve 侧退回天真去重 → E6/E11 红（证明对拍真在起作用）。
- `plugin-check` 两插件 exit 0；`check-wiring` exit 0。

### 未做（诚实边界）

这次只修**计数单位**，没动「partial 也报 `ok:true`」这件事本身。
后者是执行台账的真实语义（job 确实成功了），改成 `ok:false` 会把「已落地那一份」
说成没做。要彻底分离「job 成功」与「提案闭环」，得引入独立的 effects 台账
（W8-1 的完整形态），那是独立改动。

---

## v0.17.0（2026-11-03 · 孤儿执行回收：宿主重启后卡在 running 的执行行能被结算掉）

### 起因（实机取证）

提案 `a6e6e1d9` 的执行行 `exec-1793280728689-kmy9h1` 从 2026-11-01T16:00:04.986Z 起
永远停在 `state='running'`（`finishedAt=''`），面板显示「已批准·执行中」，
而**没有任何东西在跑**。三条原因叠在一起：

1. 宿主在执行途中被重启/关停 ⇒ 结算调用撞上已 dispose 的存储域，抛错；
2. 执行器把结算失败**静默吞掉**（`catch { /* noop */ }`）⇒ 行永远停在 running；
3. `lib/execution.js:46` 的 `CLAIMABLE` 只含 `queued`/`deferred` ⇒ running 行永不再被捡；
   `lib/index.js:442-450` 的 `activeJobsFor` 又把 running 算活跃 job ⇒
   `autoEnqueueBlocker` 判 `already-queued` ⇒ 提案再也排不进去。

⇒ **队列不自愈**：没人会再来结算这一行，也没人能再排一条新的。

### 改动

- `lib/execution.js` 新增纯函数 `isOrphanExecution(job, {now, mountedAt, staleMs, excludeIds})`：
  - 判据①（硬证据）：行在**本进程挂载之前**就被 claim（`startedAt < mountedAt`）
    ⇒ 上一进程已死，本进程不可能是它的执行者 ⇒ 孤儿；
  - 判据②（兜底）：行 running 超过 `staleMs` 且不在 `excludeIds`（本进程活跃执行）里。
  - 无 IO、无时钟（`now` 由调用方传），与本文件其余判据同风格。
- `lib/index.js` 新增服务方法 `reapOrphanExecutions({now, mountedAt, staleMs, excludeIds})`：
  孤儿行落 `failed`（**不是** cancelled —— 中断 ≠ 人撤销），写 `finishedAt` 与日志；
  提案侧 `execState → failed`、`execError` 写明「因宿主重启/进程中断未结算」。
- ⛔ **回收不得把提案标 applied**：中断的是「一次执行」，不是「这件事做完了」。
  提案保持 `approved`，剩余单元仍有入口（partial 的自动续跑机制继续有效）。
- ⛔ 回收**不自动重排**：重排由提案自己的入队机制（`autoEnqueueBlocker`）决定，
  执行器/本插件不越权 —— 否则一次重启能凭空多出 N 条自动执行。

### 面板口径

`agint-family-panel/lib/v2-proposals.js:469` 已有 `failed → person/failed` 分支，
回收后自动显示为「执行失败·等处理」，**面板无需改动**。

### 测试

`test/execution.test.mjs` 新增 4 组用例：跨进程孤儿被回收且提案不被标 applied /
`excludeIds` 里的 job 不被误判 / 超时兜底 / 非 running 行不被回收。

## v0.16.0（2026-11-01 · 工单状态机 `stage`：一条提案，一个「现在该谁动」的答案）

### 起因

`status` 说「台账上算哪一档」，`execState` 说「最近一次执行跑到哪一步」，两个字段各自都对，
但**没有一个字段回答「现在该谁动」**。面板只能拿 `execState` 硬猜，猜出过两次相反的事故：

- `a85ef850`：approved + immediate + `execState=idle` + blocker 非空 ⇒ 标签写「已批准·待入队」，
  读的人以为再等等就会自己跑 —— 而它被前置挡着，**永远不会入队**。
- `846f4fbb`：误结案成 applied 后人工改回 approved，`execState` 仍停在 `succeeded`
  ⇒ 标签说「已落地」，台账说「没做完」，两边都不像在撒谎。

两次根因同一个：**「等机器」与「等人」被混在一个字段里。**

### 改动

- 新增纯函数 `lib/execution.js:ticketStage(rec)`，九档：
  `closed` / `draft` / `person·blocked` / `person·failed` / `person·review` /
  `person·plan` / `working·queued` / `working` / `stalled`。
  判据自上而下第一个命中，**复用 `autoEnqueueBlocker()` 作为单一事实源**，没有第二套判据。
- 读接口统一走新的 `decorateProposal()`：`propose` / `listProposals` / `getProposal`
  三处都带 `stage` / `stageSide` / `stageLabel` / `stageWhy`。**派生值，不进 schema、不落盘**
  （同 `staleSince` —— 写进存储行会在下次变化时变成过期事实）。
- 服务面新增 `agint.evolve.ticketStage(rec)` 与 `agint.evolve.stages()`。
- 三个工具的 output schema 同步补四个字段（`additionalProperties:false`，不声明会被 strict 打回）。

### 两条刻意的设计决定

1. **不收 `now`。** 判据里只要有时间项，面板那份镜像实现就会算出不同的答案（它拿不到同一时刻）。
   现在 `ticketStage` 连时钟都不碰：同一个行喂两次，结果逐字相同（有用例）。
2. **没有 `idle` 这一档。** dsh-superagent 的同一张表里有 `idle`（「这轮干完了，等下一条
   Trigger」）—— 那是健康静息态。AGINT 没有它：一条 `approved` 提案的唯一正常归宿是**被执行**。
   照抄会把「应入队未入队」这个静默缺陷画成「等着呢，会来的」。所以那一档叫 `stalled`，
   `side` 是 `system` 而不是 `person` —— **没有人需要回答什么问题，需要的是修一个缺陷。**

### 验收

`test/stage.test.mjs` 6 组用例（22 个现场逐条命中 / side·label·stalled 与表一致 /
九档全可达 / 九档标签互不相同 / 判据不读时钟不改入参 / 命名约定）；evolve 全量 82 用例全绿
（`node --test "test/*.test.mjs" "test/*.test.js"`，含被严格 output schema 抓到后补的三处声明）。
面板侧镜像的等价性由 `agint-family-panel/test/stage-parity.test.mjs` 的 1080 组穷举钉住。

## v0.15.0（2026-10-30 · partial 之后自动续跑剩余单元）

### 老板的话

> 「下一版让它自动续跑剩余单元」

2026-10-29 实机（提案 `a6e6e1d9`，1/3 个原子单元）：job 成功、提案未完 ⇒ `execState=partial`
⇒ 面板归进「已批准·等手动执行（工作单）」，正是老板说的「让我去执行」。

### 根因不在面板，在这里

`syncExecutionQueue()` 只在 `setStatus()` 时被调；`partial` 只是一个 `markProposal`，
**之后没有任何人再问「剩下的谁来跑」** ⇒ 提案停在 partial，永远等人。
改面板分档只是把「没人跑」显示得好看一点。

### 改动

- `finishExecution()` 的 partial 分支末尾调 `continuePartial()`：还有剩余单元就
  `enqueueOne({ by: 'auto-continue', continuations: n+1 })` 并 `execWake()`（不等下一个 tick）。
- execution 行新增三个范围账字段（**带 default 的可选字段，不升 domain version**）：
  `unitsApplied` / `unitsTotal` / `remainingUnits`，外加 `continuations`（第几次续跑）。
- 新配置 `maxAutoContinuations`（默认 **5**，`0` = 关掉续跑、回到 10-28 的行为）。

### 止损三条（缺一条都可能变成烧 token 的死循环）

1. **必须有剩余单元** —— `remainingUnits` 为空（含 `requiresNewAsset` 的空快照）不续跑：
   没有可改的目标，再跑一次只会得到同样的结论。
2. **这一轮必须真的推进** —— `done = unitsTotal − remainingUnits.length` 要比**其它**
   执行行都大。⛔ 不能拿 `unitsApplied` 比：driver 报的是**本轮**落地数（恒为 1），
   跟上一轮比永远「没进展」，续跑刚开就被掐死。
3. **次数上限** `maxAutoContinuations`：兜底，不指望它止损。

停下来时把原因写进 `execError`（「没推进任何单元 / 已续跑 N 次仍未做完 / 续跑已关闭」）——
否则读的人分不清「做完了」「还在排」「做不动了」。

### 周额度不在这里判

续跑照排，到顶由执行器 `defer` 顺延到下周。⛔ 「现在不能跑」和「不必排」是两件事：
在这里提前拦，会把续跑变成静默丢弃（那正是「批准完就没人管」的另一种形态）。
代价要说清：一次 partial 也 `ok=true`，因此**每续跑一次就吃一格周额度**，
多单元提案会自然摊到几周里。

### 验收

`test/execution.test.mjs` 新增 4 组用例（续跑排上 / 没推进就停 / 无剩余单元不跑 /
配置关掉）；`withApp` 支持传 config 覆盖 `maxAutoContinuations`。

## v0.14.0（2026-10-29 · `autoExecutable` 降级为惰性历史标记）

- `autoEnqueueBlocker()` 删掉 `not-auto-executable` 分支 ⇒ 这个标记不再阻止入队。
- `enqueueOne()` 删掉「语义闸不可强穿」那段（force 与普通入队现在同一结果）。
- `isAutoExecutable()` 整个移除（唯一判据点没了，留着只会让下一个人以为它还有用）。
- `normalizeExec()` 仍派生 `autoExecutable` 字段，但注释写明**不参与判据**。
- 工具 `evolve_set_status` 仍收该参数（兼容老调用方），文案改为「历史标记，不再拦执行」。
  原 `render` 里那句「⛔ 已标『不可自动执行』：即使选了立即/定时也不会入队」是**假话**，
  必须改 —— 工具的输出文案比代码更容易被当成事实。

### 依据

2026-10-29 老板裁定：批准即自动执行。原闸的理由（复核类无目标 ⇒ 秒失败）在
driver 的目标解析前置化之后已不成立（零目标不调 LLM、确定性失败、不占额度）。

## v0.13.3（2026-10-28 · 提案 `846f4fbb` 单元 2+3：替身共用 + 真调断言）

- `test/_stub-dsh-tools.mjs` 改为转发 `plugins/_shared/test-stub-dsh-tools.mjs`
  （三处共用，避免漂移；契约逐字不变）。
- 新增 `test/tools-contract.test.mjs`：6 个工具逐个**真调一次** execute + output.render。
  
  为什么要它：本仓此前**没有一条测试真调过 evolve 的工具**（`node --test test/*.mjs`
  根本没 import `lib/tools.js`）。而 `defineTool` 只认 `options.execute` 与
  `options.output.render` ⇒ 入口写错 / render 漏写时工具照样注册成功，
  缺陷要到真调那一刻才炸 —— upstream-watch 就是这么连着上线三个版本的。
  
  该文件**自己注册** module hook（`register(_stub-loader.mjs)`），不依赖外部
  `--import`，否则"忘了加参数"会让用例退化成 ERR_MODULE_NOT_FOUND 而不是判据。

阴性对照（实测已红）：把 `evolve_review` 的 `execute` 改名 `handler` ⇒
`evolve_review 的入口不是 execute（真宿主会抛 userExecute is not a function）`。

验收：`node --test test/*.mjs` ⇒ 31/31 PASS（新增 2 条）；`bin/plugin-check.sh` 0 FAIL。

## v0.13.2（2026-10-28 · `succeeded` 只在 `applied` 时成立）

v0.13.1 的规则漏了一档：`846f4fbb` 改判回 **approved**（它只落地了 1/3 的单元，不该按成功记账）
之后 `execState` 仍是 `succeeded`，面板照 `m['succeeded']` 显示「已落地」—— 与 `status=approved`
正好相反。原因是上一条规则只处理「离开 approved/applied」，没处理「succeeded 与 applied 绑定」。

- `execState === 'succeeded'` ⇒ 只有 `status === 'applied'` 时成立，否则归位 idle；
- `partial` / `failed` / `running` ⇒ 只在 status 属于 approved/applied 时有意义，否则归位 idle；
- ⛔ 有活跃执行不动；⛔ 归位仍在入队之前（execMode=immediate 的再入队是合法行为，队列优先）。

验收：`test/executor-integration.test.mjs` 第 5 节补一条 —— 第 1 节那条**真的**做完的提案
改判回 approved（manual）⇒ execState 必须变 idle；以及 partial → proposed ⇒ idle。

## v0.13.1（2026-10-28 · 改判回退时执行态要跟着归位）

修 `846f4fbb` 那条记录时发现的第二处「各说各话」：它已被误结案成 `applied`
（其实只落地了 1/3 的单元），人工改判回 `approved` 之后 `execState` 仍停在 `succeeded`
⇒ 面板照 `m['succeeded']` 显示「已落地」，与台账的 `status` 正好相反。
状态与执行态不一致比单纯的字段错误更难查：两边各自都像在陈述事实。

- `setStatus()`：新的 status 不属于 `approved/applied` 时，若没有活跃执行 ⇒ `execState='idle'`；
- ⛔ 有活跃执行不动（队列是事实，归位不能抢在它前面）；
- ⛔ `approved` 不动 —— 那会把 partial 的欠账从执行态上抹掉；
- ⛔ 归位发生在 `syncExecutionQueue` **之前**：execMode 还是 immediate 时再入队是合法的，
  队列优先，不该被归位逻辑抢掉。

验收：`test/executor-integration.test.mjs` 第 5 节（partial → 改判 proposed ⇒ idle）
+ 阴性对照（第 1 节真做完的那条仍是 succeeded）；其余 4 个测试文件 16/16 全绿。

## v0.13.0（2026-10-28 · 执行态加 `partial`：job 成功了，提案未必做完）

### 补的哪个洞

执行态原先只有七档，`finishExecution(ok:true)` **必定** 走 `applyStatus('applied')`。
于是「一次自动落地」在系统里只有两种写法：成功 ⇒ 提案做完；失败 ⇒ 什么都没做。
但一次执行的原子单元是「一个文件的一次编辑」，提案横跨多文件是常态 —— 中间那一档
（job 成功、提案未完）**没有表达位**，只能被记账成其中一种假话。

实机后果（提案 `846f4fbb`，2026-10-28 23:31）：3~4 个原子单元只落地 1 个
（`agint-evolve` 的 dsh-tools 替身），台账却写成 `status=applied · execError=''`；
剩余单元（input-gateway 替身 / 共用模块 / 真调断言）在台账上彻底消失。

### 改了什么

- `EXEC_STATES` 加 `partial`；`partial = job 成功 ∧ 提案未完`。
- `finishExecution()` 在 `patch.partial === true` 时走新分支：
  **不**改 `status`（仍 `approved`），只把 `execState='partial'`，
  并把「已落地哪个文件 + 剩余单元 + policy/mutation」写进 `note` 与 `execError`。
- ⛔ 与成功分支不同的是**不**撤销同提案的其他活跃执行 —— 那些正是用来补剩余单元的；
  cancelled 的那套语义在这里是错的（会连 drying partially-covered 的子任务一起杀掉）。
- `lib/tools.js` 里那份 `EXEC_STATES` 副本删掉，改为从 `./execution.js` 引
  （`partial` 加进来时发现这里抄了一份 —— 判据两处，下次还会漂）。

### 验收

- `node --import ./test/_stub-register.mjs test/executor-integration.test.mjs` ⇒
  ok（第 4 节：真 evolve + 真 executor 跑一次部分落地 ⇒ `status=approved`、`execState=partial`、
  `execError` 点名剩余文件路径）。第 1 节即为阴性对照：不传 partial 时照样标 applied。
- `test/execution.test.mjs` / `executor-integration` / `proposal-provenance` /
  `proposal-timestamps` / `shadow-publish` 全绿（16/16）。

## v0.12.0（2026-10-27 · 提案台账加「成立条件」：判尺口径快照 + 声明式互斥检查）

### 为什么

提案 `a85ef850`「权重真标定：回测每周复盘报告，拟合 Q2 最丑归因与人工发现的重合度」：

| 时刻 (2026-10-09) | 事件 |
|---|---|
| 12:58 | 该提案立项。当时 `q2Worst` 按**绝对扣分**排序，权重直接决定归因 ⇒「用归因反推权重」成立 |
| 13:07 | 同日另一条 `f51d3280` 落地，Q2 改成 `ratio = deduction / maxWeight` 排序 |
| 之后 | `deduction = maxWeight × g(value, threshold)`（`agint-aesthetic-oracle/lib/scoring.js:327-336`）⇒ 权重在分子分母**被约掉** ⇒ 该提案的方法论彻底失效 |

失效了却没人知道：台账上它和任何一条正常提案长得一模一样，还挂着「待批」18 天，
直到 2026-10-27 人工点开才发现「拿 Q2 归因标定权重」等于优化一个不随参数变化的目标
（实测：36 条样本、随机 500 组权重 ⇒ 归因 0 变化；而 `CONFIDENCE` 0.70→0.55 能翻 24/36）。

同批还有第二个缺口：`f51d3280`（要求「归因与权重解耦」）与 `a85ef850`（要求「用归因
标定权重」）出自**同一份 2026-10-09 源码复审**、相隔 24 分钟立项、逻辑互斥，两条都进了池。

### 变更

1. **记成立条件**：`proposalSchema` 增三字段，`propose()` 落库时填
   - `formulaVersion` —— 当前判尺口径（由 `agint.aestheticOracle.formulaVersion` 读；oracle 未挂载 ⇒ 空串 = **口径未知**）
   - `assumedBy` —— 可选的人工假设锚点（如 `scoring.js@r2`）
   - `conflictsWith` —— 声明式互斥列表
2. **失效提示**：`listProposals()` / `getProposal()` 返回派生字段 `staleSince`
   （`'r2→r4'` = 立项口径已被后续公式变更甩在身后）。⛔ **只提示、不改 status**：
   判失效要人确认，机器不替人下判断。
3. **互斥检查**：`propose({ conflictsWith })` 里目标提案处于 `applied` / `approved`
   ⇒ **拒绝创建**并列出目标（截断 id + 状态 + 标题），要求正文「关联」节写清如何共存。
   `proposed` / `rejected` / `wontfix` 不拦（还没生效，或已被否）。
4. **三处工具 output schema 同步**：`evolve_propose` / `evolve_proposals` /
   `evolve_set_status` 全部声明新四字段——`additionalProperties: false` 下漏一个就
   被 strict 判失败（v0.11.0 已踩过一次，这次连测试一起加）。
5. 面板侧由 `agint-family-panel` 0.8.3 带出并在行上标「口径已变」。

### 边界

- `formulaVersion` 空串 ≠「与当前一致」：历史行没有这个字段，一律读成空串，
  **绝不因为「没记」就判它失效**（否则 90+ 条老提案集体标黄）。故存量提案暂不享受此提示。
- 互斥检查是**声明式**的：不做自然语言语义比对（要上 LLM 且误报率高）。
- 只覆盖「公式口径变更」这一类失效，覆盖不到「依赖的数据源消失」——那需要依赖图。

### 验证

- 新增 `test/proposal-provenance.test.mjs` 6 条（口径自动填、staleSince 三态、
  派生值不落盘、互斥拒绝/放行）。
- `test/proposal-timestamps.test.mjs` ④（output schema 覆盖断言）随新字段一起通过。
- evolve 全量 9 个测试文件 + `proposal-provenance` 全 PASS。

## v0.11.1（2026-10-27 · 修 v0.11.0 漏声明时间戳字段：提案台排序崩 + 改状态即写坏数据）

### 为什么

v0.11.0 给提案行加 blocker / execMode / autoExecutable 时，`proposalSchema` 被重写，
**把 `createdAt` / `updatedAt` 漏掉了**（同文件 `executionSchema` 里这两个字段还在
⇒ 是漏写，不是有意删除）。后果有两层：

1. **工具全挂**：存储域 open 时逐行过 schema
   （`dsh-storage-domain/lib/index.js:371` `valueSchema.parse(raw)`），zod object 默认
   strip 未知键 ⇒ 内存里的提案行没有 `createdAt` ⇒ `listProposals` 排序
   `b.createdAt.localeCompare(a.createdAt)` 抛 `TypeError` ⇒ `evolve_proposals` 任何
   过滤条件都崩；家族面板提案区走同一条出口，一并降级为「不可用」。
2. **写坏磁盘数据**：`KvTableImpl.put` 原样落盘、不重跑 schema；而 `setStatus` 用
   `normalizeProposal({ ...rec, status, updatedAt: nowIso() })` —— `rec` 是**已 strip 的
   内存行** ⇒ 任何一次改状态/改备注，都会把该行的 `createdAt` 永久写回成「不存在」。
   实测：`agint_evolve.json` 里 3 行（a85ef850 / c629019a / 4b34af47，均为 2026-10-27
   11:53–12:00Z 被改过状态）丢失 `createdAt`；对照 10-26 23:21 的备份，这 3 行原本都有。

同日还查出第三个面：**工具 output schema 与 proposalSchema 不同步**。output schema 是
`additionalProperties: false`，v0.11.0 新增的字段一个都没声明 ⇒
`evolve_propose` 每次调用都被 DSH strict 输出校验打回
（`value.blocker is not a declared property`），`evolve_set_status` 同理（返回体含
`autoExecutable` 而 schema 未声明）。⛔ `evolve_propose` 是「先落库、后校验」——
**报错时提案已经写进库了**，实跑一次失败调用就留下一行孤儿提案。

### 改动

1. `proposalSchema` 补回 `createdAt` / `updatedAt`（`z.string().default('')`）。
   ⛔ 不升 domain version（dsh 的 json backend 是硬版本校验，升版本会让现有 50+ 条
   提案整表读不出来）；老行没有这两个字段时照读不报错，读出空串。
2. `listProposals` 排序改空值安全：`String(b.createdAt ?? '').localeCompare(...)`
   —— 历史行可能真的没有该字段，一条脏数据不该把整段排序掀翻。
3. 三个工具的 output schema 补齐实际返回字段：
   `evolve_propose`（+10 个字段）、`evolve_proposals` 的 item（+8 个执行字段）、
   `evolve_set_status`（+`autoExecutable`）。

### 红绿自证

新增 `test/proposal-timestamps.test.mjs`（4 组）：propose 返回非空时间戳 /
listProposals 不抛且按 createdAt 倒序 / setStatus 后磁盘那行仍留 createdAt /
三个工具的 output schema 声明字段集 ⊇ 实际返回字段集。
替身复刻了真实存储域的两条语义（open 时过 schema、put 不重跑 schema）。

- 修复前：4 组全红，② 复现线上同一句 `TypeError: Cannot read properties of
  undefined (reading 'localeCompare')`。
- 修复后：4 组全绿；插件全量测试 68/68 通过。

## v0.11.0（2026-10-27 · 提案可声明「不可自动执行」：语义闸）

### 为什么

首跑当天就撞上：**面板默认 `execMode=immediate` ⇒ 批准即入队**，而 oracle 产出的
「美谕提案：决策确信度 扣 1.7 分」正文自述「纯机械动作提案，**永不 auto-apply**；
是否执行由老板裁定」「不改动、不删除、不自动生效」—— 它要的动作是**人去复核一条
记忆条目**，没有可改的代码目标。

结果：driver 定位不到目标 ⇒ 两次各 1 秒失败（第二次产出与第一次逐字相同），
每次还要起一次 LLM。缺的正是「我不可自动执行」这个表达位。

### 新增

- `proposalSchema` 增 `autoExecutable`（布尔，**默认 true**）：⛔ 默认 true 是为了
  不影响加字段之前的所有提案（老提案不因这次升级突然被挡）。
- `normalizeExec` 归一（缺席 = true，绝不把「字段缺席」读成「不可执行」）。
- `isAutoExecutable(rec)` —— 判据只有一处。
- `autoEnqueueBlocker` 增闸 `not-auto-executable`。
- `propose(input)` 接受 `input.autoExecutable`；`setStatus` 接受 `opts.autoExecutable`（人工兜底闸）。
- 工具 `evolve_set_status` 增 `autoExecutable` 参数（布尔）：⛔ 只认布尔，传字符串/数字一律当没传（不猜）。
  **存量提案没有这个字段 ⇒ 默认 true ⇒ 仍可自动执行** —— 所以「这条其实不能自动跑」
  这件事以前改不了，现在人工可以补标。

### 语义闸 ≠ 外部闸（刻意的不对称）

`enqueueOne` 里 `force` 能跳过 blocker / 额度这类**外部**闸（「我知道有前置，我就是要跑」），
但**跳过不了** `not-auto-executable`：这不是「现在还不行」，是「它根本没有可改的目标」，
强穿等于明知会失败还要跑一次。

### 红绿自证

`test/execution.test.mjs` 增 4 组：声明 false ⇒ 不入队且 `execState` 保持 idle /
force 也不强穿 / 老提案（无该字段）照常入队 / 改成 false ⇒ 撤掉已排的队。

## v0.10.0（2026-10-27 · 提案执行计划 + `execution` 队列：批准即执行的数据层）

### 为什么

`approved` 这一档自 v0.8.0 起只说明「同意做」，v0.9.0 又补了 `blocker` 说明「现在还不能做」，
但**没有任何字段记录「该谁做、什么时候做、做到哪一步」**。结果批准之后信息就断在状态字段上：
家族面板只能把它渲染成一张工作单，而"自动执行"在系统里连个表达位都没有。

### 新增

- `proposalSchema` 增 7 个字段：`execMode`（manual/immediate/scheduled）、`execAt`、
  `execState`（idle/queued/running/succeeded/failed/deferred/cancelled）、`execAttempts`、
  `execError`、`execStartedAt`、`execFinishedAt`。
- 新表 `execution`（一行 = 一次批准触发的一次执行，重试复用同一行、attempts 自增、log 追加）。
- 新模块 `lib/execution.js`：纯判据层（`validateExecPlan` / `autoEnqueueBlocker` /
  `isJobDue` / `weeklyUsage` / `startOfWeek` / `interpretRunResult` / `describeExecution`）。
  ⛔ 不碰存储、不读 env、不取 Date.now() —— 时间一律由调用方传，否则「定时到点该跑」测不住。
- 8 个服务方法：`enqueueExecution` / `claimDueExecutions` / `finishExecution` /
  `requeueExecution` / `cancelExecution` / `listExecutions` / `executionStats` / `describeExecution`。

### 行为变更

- `setStatus(id, status, note, { execMode, execAt })`：显式传才改计划（同 blocker 的冻结语义）。
  状态成为 `approved`、无 blocker、且计划是 immediate/scheduled ⇒ **自动入队**；
  已批准时清空 blocker ⇒ 补入队；离开 approved ⇒ 撤销活跃执行。
- `finishExecution(ok:true)` 在**同一刻**把提案标 `applied`（note 追加落地证据）：
  「执行成功」与「已落地」在自动执行路径上必须是同一刻，否则面板会同时显示两种相反状态。
- 执行计划与队列的判定只有一处（`autoEnqueueBlocker`），面板与执行器各自读它 ——
  判据散成两份就会「面板说排队中、执行器说没这条」。

### 刻意不升 domain version

`agint_evolve` 仍是 `version: 2`。dsh 的 json backend 是**硬版本校验**
（`dsh-storage-json/lib/index.js:102`：`stored version != expected` 直接抛 `version-mismatch`，
没有 `compatibleVersions` 通道），升版本 = 现有 50+ 条提案整表读不出来、域开不了。
加表 + 加带 default 的可选字段在这个 backend 上是安全的：未声明的表按空表加载，
老记录缺的键由 zod default 补齐。1→2 那次升版本是为加 `baseline_history` 付了手工迁移的代价，
这次没有必须升的理由，就不制造「必须先迁移再启动」的窗口。

### 红绿自证

`test/execution.test.mjs`：批准即入队 / blocker 不入队 / 清空 blocker 补入队 / manual 永不入队 /
定时未到不跑 / 成功同刻 applied / 失败留原因 / 撤销批准撤队列 / 重复批准不叠单 / 统计口径。

## v0.9.0（2026-10-27 · `approved` 补 `blocker` / `unblockCondition`：批准 ≠ 现在能做）

### 新增

- `proposalSchema` 增两个可选字段：`blocker`（卡在什么上）、`unblockCondition`（等什么满足）。
- 导出 `normalizeProposal()` / `proposalBlocked()`：判据单一事实源，读出口统一归一。
  ⛔ 字段缺席（加字段前的历史行）与空串在展示口径上等价，但这个等价只在归一函数里做一次。
- `listProposals({ blocked })`：`true` 只挑「批准了但动不了手」的，`false` 反之。
- `setStatus(id, status, note, { blocker, unblockCondition })`：显式传字符串才改，
  不传=冻结原值（否则改状态会把上次写的阻塞原因静默洗掉）；传 `''`=解除。
- `evolve_proposals` 输出补两字段 + `blocked` 过滤；`evolve_set_status` 补两参数。

### 为什么

- 实测反例：提案 `a85ef850`（权重真标定）2026-10-26 被人工批准，可它自己的 note 写着
  「第 3 步客观不可行」，当周周报又明确 **31/31 样本未标注、8-12 周内冻结权重常量**。
  于是它在家族面板待办里挂成一张「已批准待执行（工作单）」，催人去动手 ——
  而真动手就撞自家门禁。缺的不是状态档，是「为什么还不能做」的表达位。

### 行为变更

- `applied` 时若仍挂着 `blocker`，**不静默清空**：原阻塞原因转写进 `note`（`解除阻塞（原：…）`）。

## v0.8.0（2026-10-23 · 提案状态机补 `approved`：人工批准与落地分开记）

### 新增

- `proposalSchema.status` 增加 `approved`（已批准待执行）。五档：
  `proposed / approved / applied / rejected / wontfix`。
- `PROPOSAL_STATUSES` 与 `evolve_proposals` / `evolve_set_status` 的枚举同步。

### 为什么

- 原状态机只有「落地」「拒绝」「暂不处理」三个出口，**没有「人工同意做」这一档**。
  结果是：人工审批无处落笔 —— 要么把「点头」记成 `applied`（表说假话），
  要么什么都不记（53 条 proposed 只进不出，实测 2026-10-23）。
- `approved` 是**决定**，`applied` 是**事实**。两者混记会让「真做完」与
  「只是同意」无法区分，提案表从此不可信。

### 兼容

- **只增不改**：历史行的四个旧值全部仍合法，存储 domain 版本保持 `2`
  （无数据形状变化，不做迁移）。
- ⚠️ 部署注意：`approved` 行由旧版代码读取时会被 zod 拒绝，整个 `agint_evolve`
  域会 open 失败。**新代码必须先于新数据部署**。家族面板的写路由与 evolve 同进程，
  部署同步后重启即一致。

### 验证

- `node test/smoke.mjs`；`node --test test/path-escape-windows.test.mjs`。

## v0.7.3（2026-10-14 · Windows 路径逃逸误报修复）

### 修复

- `clean()` 的路径越界判据在 win32 恒为真 ⇒ **所有 `evolve_read` 读不到任何复盘报告**。
  判据原为 `abs.startsWith(root + '/')`，而 `resolve()` 在 Windows 返回反斜杠路径
  （`D:\...\reviews`），拼出的 `D:\...\reviews/` 与真实 `D:\...\reviews\xxx.md` 永不匹配。
  修法与 `agint-wiki` v0.4 同型：比较前把两侧都归一化成正斜杠。
- 实测症状（修复前）：`evolve_read path="2026-10-12-周复盘.md"`
  → `Error: agint-evolve: path escapes root` ⇒ 14 份复盘报告一份都读不到。

### 验证

- 新增 `test/path-escape-windows.test.mjs`（8 项）：真调生产 `readReview()` /
  `listReviews()`，含中文文件名、子目录、`../` 逃逸、多级 `../`、非 `.md`、文件不存在。
- 红绿自证：撤掉归一化 ⇒ 4 项变红；恢复 ⇒ 8/8 绿。安全不回退（`../` 仍被拒）单独覆盖。
- 全插件回归 54/54 PASS，`test/smoke.mjs` exit 0。

### 附带发现（未修，单列）

- `walk()` 在 win32 用 `relative()` 产出反斜杠分隔符，子目录报告返回
  `sub\nested.md` 而非 `sub/nested.md`。与 `clean()` 同型但独立，不影响读取
  （`clean()` 已归一化，回读能通），只影响输出形状。

### 测试基建

- 新增 `test/_stub-loader.mjs` + `test/_stub-register.mjs`：本机仓库工作树没有
  `@deepseek-ai/dsh-storage-domain`（该包只在 dsh 运行时提供），直接 `node --test`
  会 ERR_MODULE_NOT_FOUND。跑测试需
  `node --import ./test/_stub-register.mjs --test test/xxx.test.mjs`。

## v0.7.2（2026-09-29 · 周报纳入外部信号章节）

### 新增

- `dataSnapshot()` 取 `agint.inputGateway` 状态（`ctx.get` 软依赖，未挂载降级 `undefined`），snapshot 增 `inputGateway` 面
- `findingsFromSnapshot()` 增两类发现：
  - `gateway.silent.<channel>`（info）：fetch ≥2 且 emitted=0 → 上游链空转提示（本轮真实证据：self-observation 长期 0 信号）
  - `gateway.security`（warn）：security 命中 / 丢弃 → 外部信号注入风险提示
- `renderSnapshotTable()` 增「外部信号与多源输入」行；`buildReport()` 新增 `## 二·A、外部信号与多源输入` 章节（网关未挂载时如实标注）

### 验证

- report.test.js +4 项外部信号用例（silent/security/章节渲染/不可用降级）；全插件测试 19/19 PASS。

**背景**：`evolution.proposed` 只有订阅方（evolution-memory / quality-eval / trajectory）、
没有生产发布方 —— 生产仅 3 条 09-04 历史探针。本插件的 propose() 才是真实提案源（生产 55 条）。

- `propose()` 落库后向 bus 发一条 `evolution.proposed`，payload 含 proposalId / kind / origin
- `source` 写 `agint-evolve`（真实发布方），原始 `source` 保留在 payload 内
- 软降级：bus 缺失或 publish 抛错只 warn，返回值与落库不受影响（直连路径完整保留）
- 新增 `test/shadow-publish.test.mjs`（4 项）

## v0.7.1 — proposal category 增加 `plugin`

**日期**：2026-09-07
**范围**：纯枚举扩充 + 数据重归类，不改任何运行时行为。

### 变更

- `proposalSchema.category` 枚举：`rule/skill/doc/preset/service/other` → 新增 `plugin`（整 cordis 模块级改动；`service` 语义收窄为"模块内单 host 服务改动"）
- `PROPOSAL_CATEGORIES` 常量、`lib/tools.js` `CATEGORIES` 同步加 `plugin`
- `evolve_propose` 工具描述、`lib/report.js` 复盘提示语、`docs/plugins/agint-evolve.md` 同步更新

### 数据迁移

- 3 条 agint-dream 升级提案（P0/P1/P2）category 重归类为 `plugin`（P0 原为 `rule`，P1/P2 原为 `service`）

## v0.7.0 — Sprint 12 B3 baseline-regression 真 cron hook

**日期**：2026-XX-XX
**范围**：storage schema v1 → v2；新增 3 个 baselineGate 系列 service；与 `agint-cron` 的 `baseline-regression-suite` job 配对。

### 新增

- **Service `agint.evolve.baselineGate(channel, opts)`**
  - 输入：`channel`（默认 `'mount'`，预留扩展）、`opts.since`（ISO，可选）
  - 输出：`{ frozen: boolean, lastRunAt: string|null, since: string|null, source: string }`
  - 副作用：只读 `baseline_history` 表；不写、不动 mutation / policy
  - 缺数据 → `{frozen:false, lastRunAt:null, since, source:'empty'}`（稳定空值语义）
- **Service `agint.evolve.recordBaselineRun(input)`**
  - 由 `agint-cron` 的 `baseline-regression-suite` job 调用
  - 写 `baseline_history` 一行：`{id: ranAt, channel, passRate, passed, total, frozen: passRate<0.95, source, ranAt}`
  - 返回写入记录的副本
- **Service `agint.evolve.listBaselineHistory(filter)`**
  - 调试 / 报告 / 测试用，按 `ranAt` 倒序列出全部行

### Storage

- domain `agint_evolve` schemaVersion：`1` → `2`
- 新增表 `baseline_history`（valueSchema: `baselineHistorySchema`，zod 校验）

### 兼容

- 所有 v0.1.0 起的 proposal / review service 行为不变
- storage domain `agint_evolve` 旧数据（仅 `proposal` 表）继续可读；新增 `baseline_history` 表初始为空

### 配对

- `plugins/agint-cron` 新增 `baseline-regression-suite` job（每周日 03:15），调 `agint.evolve.recordBaselineRun`
- `eval/scenarios/driver.js` mount dispatcher 把 `mountMocks.baselineMock.isFrozen()` 替换为 `await ctx.get('agint.evolve').baselineGate('mount')`
- `eval/run-baseline-regression.mjs` 新建：跑真 cron action、写一行 `baseline_history`、输出表格
