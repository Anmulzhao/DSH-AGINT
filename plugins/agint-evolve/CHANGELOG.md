# agint-evolve CHANGELOG

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
