# CHANGELOG — agint-evolution-driver

## v0.8.0 — 2026-10-28 — 两处硬伤：截断换成锚点窗口、目标改成逐个尝试

v0.7.0 修掉了「批准后必失败」的三个外因（cwd / 120s / 提示词），这一版修的是剩下两处
**结构性问题**。两处都有实测数据，不是照着直觉改的。

### ① 提示里的目标文件：从头截断 → 锚点窗口 + 结构大纲

**旧实现**：`String(fileText).slice(0, 20000)`。三个已知后果：

- 锚点在 20000 字符之外 ⇒ 模型看不到要改的那段，只能答 `applicable=false`，或先花轮次去读；
- 提示声称「verbatim text of one target file」，模型却看到被截断的文本 —— 它自己会说
  「The file shown is truncated at the end」，然后去读原文件（截断本想省 token，换来更多轮次）；
- 行号无处可依：模型即使想精确读，也只能从头翻。

**新实现**（`lib/excerpt.js`，纯函数、可单测、不碰 ctx）：

- 全文 ≤ budget ⇒ 原文照给（`mode='full'`），一个字符都不动；
- 否则：从提案正文抽**锚点**（反引号里的标识符、`file:line`），在文件里定位到行，
  每个锚点取 ±30 行窗口，合并重叠区间；再附一份**带行号的结构大纲**（顶层
  `function` / `class` / `const` / Markdown 标题），让模型一次 `read offset=<行号>` 就能精准补读；
- ⛔ **正文窗口逐字原样，绝不给行首加行号** —— 模型要复制 `oldText`，加前缀必挂
  `anchorExists` 幻觉闸门。行号只出现在大纲与 `⟪omitted lines a-b⟫` 标记里。

**度量（6 个真实提案 × 它们各自解析出的目标文件，只看 >20000 字符的）**

| 提案 | 目标 | 大小 | 锚点 | 旧覆盖 | 新覆盖 | 字符 |
| --- | --- | --- | --- | --- | --- | --- |
| 2f91b72b | agint-dream/lib/sweep.js | 80957 | 6 | 4 | **6** | 20000→13263 |
| d2b77b47 | agint-dream/lib/sweep.js | 80957 | 9 | 6 | **8** | 20000→14529 |
| 567dabed | agint-evolve/lib/index.js | 47838 | 9 | 8 | **9** | 20000→10551 |
| 9d9697cf | agint-evolve/lib/index.js | 47838 | 9 | 7 | 7 | 20000→14744 |
| 58237933 | aesthetic-oracle/lib/scoring.js | 22529 | 10 | 6 | **7** | 20000→12942 |
| a6e6e1d9 | aesthetic-oracle/lib/scoring.js | 22529 | 9 | 6 | 6 | 20000→8405 |

合计 **37/52 → 43/52（71% → 83%）**，无一例变差；同时字符量 **120000 → 74434（−38%）**。
合成判据（T41b）还压住了一个**必然失败**的情形：锚点在第 6000 行时，旧实现 100% 丢、新实现覆盖。

> 仓库 1335 个受版本控制的文件里有 **104 个 >20000 字符**（7.8%），这类文件一旦成为目标就踩上面的坑。

### ② 目标资产：按「路径字符串长度」挑一个 → 有序多候选逐个尝试

**实机事故（提案 `846f4fbb`）**：正文里 5 条路径，`matchRepoFile` 用
`exact.sort((a, b) => b.length - a.length)[0]` 挑**字符串最长**的那条 ⇒ 选中
`plugins/agint-upstream-watch/test/_stub-storage-domain.mjs`（58 字符），
而它恰恰是提案里写「已修好、本次已在 upstream-watch 落地」的**样板文件**。

模型读完如实回答 `applicable=false` 并说明「待办在另外两个文件里」（判断完全正确），
执行器却据此把整条提案判成确定性失败、不再重试 —— **真正该改的
`agint-evolve/test/_stub-dsh-tools.mjs` 与 `agint-input-gateway/test/_stub-storage-domain.mjs`
一次都没被读过**。路径字符串的长度与「这个文件该不该改」毫无关系。

**新实现**：

- `resolveTargetAssets()` 返回**有序候选**：文档出现顺序 → 精确命中优先 → 后缀兜底只在
  **唯一**候选时收（歧义宁可丢，不猜）→ 去重保序。单目标调用方取 `[0]`（`resolveTargetAsset` 保持旧签名）。
- runner 逐个尝试（`maxTargetAttempts`，默认 3）：某个目标答 `applicable=false` 只意味着**换下一个**；
  全部候选都否才判 `not-actionable`，且错误里带上**每个**目标的拒因，人员不必重走一遍取证。
- 提示里补 `## Target N of M` 段，明确「本轮只负责这一个文件，不要因为提案横跨多文件就拒答，
  若本文件确实不用改，请 answer applicable=false 并指出该改哪个文件」。

### 配置

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `excerptChars` | 20000 | 提示里目标文件的字符上限（换算法不换预算） |
| `maxTargetAttempts` | 3 | 一次执行最多试几个目标（每个目标 = 一次真实 LLM 调用） |

### 验收

- `node test/smoke.mjs` ⇒ **67/67 PASS**（新增 T41a–e / T42a–b / T43a–b 共 9 条）。
- **阴性对照**：把 excerpt 退回 `slice(0, budget)`、把目标数改回 1 ⇒ T41b/T41d/T43/T43b **四条立刻变红**；
  还原后全绿 ⇒ 用例有分辨力。
- `plugin-check` 0 fail；`check-wiring` PASS。

## v0.7.0 — 2026-10-28 — 修掉「已批准·执行失败」的三个真因（cwd / 截断 / 120s 闸门）

**实机事故**：提案 `2f91b72b`「让 agint-dream 采集 assistant 正文里的主张」在面板批准后，
执行器连跑两次，两次都报 `driver 抛错：evolution-driver aborted: llm unavailable:
llm error: timeout after 120000ms`，`maxAttempts=2` 用尽 ⇒ 面板标「已批准·执行失败（待处理）」。
同批 `846f4fbb` 也失败（一次超时 + 一次「llm judged not applicable」）。

**取证（不是推测：解压孩子会话 `sessions/<cwd>/<childId>/session.v4.jsonl.zstd` 逐事件比对）**

| 运行 | 工具调用 | 其中 bash | turn 结束于 | 结果 |
| --- | --- | --- | --- | --- |
| 19:36 成功 | 7 | 3 | 57.8s | 调了 `structured_output` ⇒ 拿到变异 |
| 19:46 失败#1 | 15 | 13 | 119.2s | **没调 `structured_output`** ⇒ 父侧无结果 |
| 22:35 失败#2 | 10 | 6 | 116.9s | 同上 |

三条并列成因（缺一条都不至于失败）：

1. **孩子会话的 cwd 是进程 cwd，不是仓库。** `spawnLlm` 写死 `meta: { cwd: process.cwd() }`，
   而 dsh 这次是从 `~/桌面`（22:35 是 `~`）启动的 ⇒ 模型第一步就是
   `ls -d ~/DSH-AGINT … find /home/kylin -maxdepth 4 -name 'agint-dream'`，
   15 次调用里 13 次在找仓库。
2. **提示只给 20000 字符，目标文件 96.5KB。** `plugins/agint-dream/lib/sweep.js` 有 96546 字节，
   模型自己的 reasoning 写着「The file shown is truncated at the end (cut off mid `tokenOverlap`)」，
   于是去读原文件 —— 截断本想省 token，实际换来更多轮次。
3. **120s 闸门太紧，且失败时把已跑完的 turn 一起丢掉。** 成功案例已吃掉 48%（58s）/77%（92s）预算；
   失败那两次 turn 在 119.2s 结束（距闸门 1 秒），父侧仍只报「超时」，看不出「其实是没交结构化输出」。

**改动**

- `DEFAULT_TIMEOUT_MS` 120_000 → **600_000**；新增 `resolveLlmTimeout(env, config)`：
  env `AGINT_EVOLUTION_DRIVER_TIMEOUT_MS` > patch config `llmTimeoutMs` > 常量。
  非数字 / ≤0 一律回落默认（⛔ 不让一条脏 env 把闸门变成 0ms）。
- `construct()` 增 `cwd` 入参：缺省回落 patch config 的 `repoRoot`，再回落 `process.cwd()`；
  `runOnce` / `runForProposal` 的调用点显式传 `cwd: repoRoot`。
- `spawnLlm()` 增 `cwd` 入参，`meta.cwd` 用它（`preset` 不受影响）。
- 提示词三处补：user 侧新增 `## Working directory` 段与「excerpt 可能被截断，要读就读这个精确相对路径，
  不要全盘找」；system 侧新增「必须走 structured-output 工具调用，纯文本不算回答」与
  「工作目录就是仓库，别去找项目」。
- 文档：`construct` 的 JSDoc 补 `timeoutMs` / `cwd`。

**行为变化（要知情的两点）**

- 一次执行最长可占 600s。执行器是串行 `maxPerTick=1`，所以排队中的其他提案会等更久；
  真正的成本闸仍是 `maxAttempts=2` + `weeklyCommitCap=3`，不靠这个超时。
- 超时不再「覆盖」真实失败原因：模型跑完但没交结构化输出时，报错是
  `structured output missing (stopReason=…)` 而不是笼统的 `timeout`。

**验收清单**

- `node test/smoke.mjs` ⇒ 58/58 PASS（新增 T40a–T40d 四条）。
- 阴性对照（人为退回两处）：把常量改回 120_000 + `meta.cwd` 改回 `process.cwd()` ⇒
  T40a / T40b / T40d 立刻变红；还原后全绿 ⇒ 用例有分辨力，不是摆设。
- `bash bin/plugin-check.sh plugins/agint-evolution-driver` ⇒ 0 fail（1 条既有 WARN：
  `lastError` 无 tool render 消费，与本次无关）。

## v0.6.1 — 2026-10-27 — 部署位路径归一：别再让「真能改」的提案被判不可执行

**实机事故**：提案 `9d9697cf`「修复 agint-evolve 提案台 schema 缺 createdAt…」批准后
选「立即执行」，**1.5 秒失败**：
`not-actionable … no target asset resolved (mentioned:1 inRepo:0 bodyLen:1982)`。
可它给的文件、行号、修法一个不缺 —— 失败纯粹因为**路径写法**：

- 正文写的是面板里看到的部署位路径 `` `~/.dsh/.agint-bundle/plugins/agint-evolve/lib/index.js:793` ``；
- `repoFiles` 是仓库相对路径（`plugins/agint-evolve/lib/index.js`）⇒ `set.has(raw)` 恒 false；
- 更隐蔽的一层：抽取正则要求「路径后面紧跟反引号」，而 `index.js:793` 后面是冒号 ⇒
  **真正要改的 index.js 根本没被抽出来**。`mentioned:1` 里那个 1 是正文提到的
  `agint_evolve.json`（存储域文件名，仓库里没有）。

**变更**

1. 新增导出 `normalizeRepoPath(raw)`：剥行号/列号、`\` → `/`、`$DSH_HOME`、`~/`，
   再按已知壳归一到仓库相对路径 ——
   `.agint-bundle/…`（部署 bundle）、`node_modules/@agint/host/…`（host 包位）、
   `profiles/<名>/plugins/…`（profile 实体位）、`/…/DSH-AGINT/…`（绝对路径带仓库根）。
   ⛔ 只剥**已知的壳**，剥完不认识就原样返回，让上层判「定位不到」——不做模糊猜测。
2. 新增导出 `matchRepoFile(mentioned, repoFiles)`：两级匹配。
   先归一后等值命中；未命中再**后缀兜底**（提案只写半截 `lib/index.js`、或多一层父目录）。
   ⛔ 后缀命中出现歧义（`lib/index.js` 多个插件都有）⇒ 返回 null，不猜：
   改错文件比不改更糟。
3. `extractRepoPaths`：字符集补 `~ $ { }`，并允许路径后跟 `:行号` / `:起-止` 再收尾。
4. `resolveTargetAsset` / `resolutionDiag` 改用上面两级匹配；诊断串在走后缀兜底时
   补 `suffix:<命中的仓库路径>`，避免「写法不对」被读成「仓库里没这个文件」。

**验证**：拿真实提案跑 `resolveTargetAsset`（repoFiles = `git ls-files`，1305 条）——
改前 `mentioned:1 inRepo:0` → 改后 `mentioned:2 inRepo:1`，
定位到 `plugins/agint-evolve/lib/index.js`。`smoke` 52 → **54 条**全过。

## v0.6.0 — 2026-10-27 — 定向失败区分「确定性不可执行」与「偶发」

**背景**：自动执行失败后一律重试，但有些失败**重试也不会变**。实机那条 oracle 复核类
提案两次各 1 秒失败，产出逐字相同 —— 重试只是再烧一遍 LLM。

**变更**
1. 新增导出 `classifyFailureKind(text)` → `'deterministic' | 'transient'`。
   确定性判据（定位不到目标 / LLM 判定不适用 / 幻觉闸门 / 实体闸门 / validate 拒绝 /
   路径不安全）；⛔ **默认 transient** —— 判错方向不对称：把偶发判成确定 = 提案永远
   不再自动跑；把确定当偶发 = 多烧一次 token。显式 transient 标记优先。
2. 定向模式（`runForProposal` / `runOnce({proposalId})`）无可执行目标时，返回
   `reason='not-actionable（…）'` + `deterministic: true`，并带上首个失败细节。
   ⛔ **sweep 模式（不指定 proposalId）保持原语义**（`deterministic: false`）——
   下一轮可能有新候选，那不是「不可能成功」。
3. 新增 `failures`（前 30 条）到返回里，调用方不必再从 summary 猜。

**验证**：`node test/smoke.mjs` 49 → **52 全绿**（T37 判据层 / T38 定向确定性 / T39 sweep 不变）。

## v0.5.0 — 2026-10-27 — `runForProposal(proposalId)`：定向执行一条已批准的提案

**背景**：`agint-executor` 要在批准后自动执行，但 `runOnce()` 的候选池写死
`listProposals({ status: 'proposed' })` —— `approved` 的行它一眼不看。
批准完的提案因此永远等不到执行，在面板里挂成一张催办工作单。

**变更**
1. `runOnce(opts)` 增 `opts.proposalId`：定向模式只取那一条，**允许 `status='approved'`**
   （`opts.allowAnyStatus` 可放宽，仅供排障），并且**不写 `state.seen`** ——
   `seen` 的语义是「一轮里别重复试同一条」，而定向模式本来只有一条，失败重试必须能再跑。
2. 新服务方法 `runForProposal(proposalId, opts)`：`runOnce` 的薄包装，返回补
   `{ proposalId, ok }`（`ok` = 流走到 commit 且 commit.ok），让执行器不必自己解释返回形状。
3. 定向模式下 `proposal-not-found` / `proposal-not-approved` 各自发一条 summary 并返回
   `{ skipped: true, reason }` —— 此前这两种情况会被混进「no actionable candidate」。

**不改**：构造 → 幻觉闸门 → mutator.propose → validate → population.ingest → 写入后验证
→ policy 决策 → commit/回滚 → 预测锁定 → ledger 入链，全沿用原路径。
`runForProposal` **不写提案状态**：那是 `agint.evolve` 的事，两边都写 = 两套口径。

**验证**：`node test/smoke.mjs` 49/49 绿（含 T36 等既有用例，确认定向分支未改变旧行为）。

## v0.4.1 — 2026-10-25 — A 段：合成产物 ⇒ mount 部署桥（**通电不上膛**）

**背景**：`agint.mount.request` 此前**全仓 0 个生产调用方**
（`check-wiring` 查 A：只有它自己 provide 行的 MENTION）。
⇒ 部署腿是建成但没接过线的：三条子检查、4 态状态机、回滚能力全在，没人调它。

**新增**：`lib/deploy-bridge.js` — `requestSynthMount({ ctx, proposal, io, stagingRoot })`
1. 调 `agint.mutator.synthForProposal` 合成产物（只吃 TOOL_SYNTHESIS）
2. 落盘到 staging（为「人批准后的 ACTIVATE」备好产物）
3. 递交 `agint.mount.request`，**verdict 硬编码 PENDING_REVIEW**

**⛔ 为什么恒 PENDING_REVIEW（改这行前先读）**
mount 的 4 态状态机里有 **RESTART_REQUESTED**：
PREPARED → INSTALLED → RESTART_REQUESTED → ACTIVATED。
自动走到 ACTIVATE = 系统自己往宿主装插件并可能触发重启请求，
直接撞项目铁律「常驻 dsh 只能老板双击启动」「永不触发 restart-request.json」。

`mountRequest` 入口第一行 `isPendingReview(verdict)` 命中即**只写一条
PENDING_REVIEW ticket 就 return**，绝不进三段式。
⇒ 腿通电（ticket 建、mount.requested 事件发、门禁看得见），
**没有人批准就永远不上膛**。

**暴露**：`agint.evolutionDriver.requestSynthMount`。
**测试**：`test/deploy-bridge.test.mjs` 9/9。
变异自证：把 PENDING_REVIEW 改成 AUTO_DEPLOY ⇒ 2 条立刻变红，还原 9/9。

**未做（A 的最后一公里）**
1. **cron 触发者未加**：本桥有 service 但无自动调用者。
2. **候选源缺失**：mutator 没有「列出 TOOL_SYNTHESIS 候选」的接口。
3. ⛔ **第四层断点（本轮查证）**：`attributionDriven` 靠 `rootCause=TOOL_GAP`
   才路由到 TOOL_SYNTHESIS，而 `agint_diagnosis` 生产存储 **0 行**
   ⇒ TOOL_GAP 从未被判定 ⇒ TOOL_SYNTHESIS 候选历史 0 条。
   **不解决这一层，A 通电也是空转**（扫不到候选）。


## v0.4.0 — 2026-10-25 — LLM 构造无降级 + 接 startActivation

**背景**：宿主只有 `subagents.startActivation`，旧代码检查 `subagents.start` ⇒
LLM 构造 25 天全程不可用，只以 `state.degraded` 计数悄悄跳过。

**变更**
1. `spawnLlm` 改调 `startActivation({ provider, label, request, signal, delivery:'caller' })`；
   旧宿主保留 `start` 兼容分支。`request` 带 `parent` / `prompt` / `agentPreset` /
   `agentOptions` / `outputSchema`；`agentOptions` 补 `reasoningEffort`。
2. **无降级**：`construct` 遇 LLM 通路失败返回 `{ llmFailure:true, reason }`；
   `runOnce` 立即发 `evolution.cycle.summary`（exitReason=`llm-unavailable`）并抛错，
   cron 的 `lastError` 可见。⛔ 不再计入 `degraded` 后继续下一条。
3. `not applicable` / 幻觉 `oldText` / 实体门命中仍是内容级拒绝，不触发整轮中止。
4. 超时双保险覆盖 create/start/result；晚到 handle/activation 也会 dispose；
   服务/方法/provider 三种病因分开报。
5. 默认模型更新为 `MiniMax-M3.1-Flash`。

**测试**：`test/smoke.mjs` 49 例全绿（新增 startActivation 契约与旧 start 兼容用例）。

## v0.4.0+doc1 — 2026-10-25 — 文档订正：commit 开关口径以代码为准

**背景**：`isCommitEnabled`（`lib/index.js`）判的是「值 ≠ `off`」⇒ **代码里默认开**。
README 开关表、`jobs.js:732` 注释、本文件 v0.2.10 行三处都写「默认关」，三方口径打架。

**订正**（老板 2026-10-25 拍板：**以代码为准**）
1. README 开关表改为「默认开，显式 `off` 才关」。
2. README「第一阶段不 commit」一节改写为「两道闸」：总闸默认开，
   **真正挡住写入的是第二道 `resolveRepoRoot` 解析到 `null`**。
3. `plugins/agint-cron/lib/jobs.js` 的 evolution-cycle 注释同步改口径。
4. ⛔ **不改写历史条目**：本文件 v0.2.10 行与 `proposals/agint-evolution-driver.md`
   保留原文（那是当时的决定），订正只以新增条目形式追加。

**未改代码**：行为零变化，本次纯文档。

## v0.3.1 — 2026-10-09（护栏 3 判据放宽：按被测文件的 import 图判依赖，而非仓库级一刀切）

依据：进化提案 `0738af45-0233-4391-924a-b2fd1b4002d8`（2026-10-04 提出，本日核销）。

### 旧判据为什么是永久误杀

护栏 3 原为 `if (!exists(join(repoRoot,'node_modules'))) return fail(NO_TEST_RUNTIME)`。
本仓是**零依赖插件集**：根 `package.json` 的 `dependencies`/`devDependencies` 均为空
（`node -p` 实测），根与三级父目录都没有 `node_modules`，**pnpm install 也装不出来** ⇒
护栏恒真，`prediction_outcomes` 恒 0 行。而插件的依赖在 `plugins/<name>/node_modules`
（软链到 dsh 自带包），Node 的向上查找本来就找得到 —— 一刀切判据把「仓库根没装」
错当成「跑不起来」。

实测（2026-10-04 20:11，麒麟机）：`scanned=1 / measurable=1 / attempted=1`，终态
`NO_TEST_RUNTIME`。被拒的 `plugins/agint-wiki/test/smoke.mjs` 只 import `node:` 内置
与相对路径 `../lib/index.js`，本来就能独立跑。

### 新判据

`collectTestDependencies({ repoRoot, files, read, exists })`（本文件导出，可单测）：

- `node:` 前缀 / 裸内置名（`fs`、`path`…）⇒ 永可达；
- 相对 / 绝对路径 ⇒ **跟进展开**（深度 ≤8、文件数 ≤200，防一张大图拖死探测）；
  读不出来的进 `unreadable` ⇒ 无法证明可运行 ⇒ 照旧拒测；
- 裸包名 ⇒ 按 Node 的**向上查找**规则从导入者所在目录逐级验 `node_modules/<pkg>`，
  插件自带 node_modules 也算数；探不到的进 `missing` ⇒ `NO_TEST_RUNTIME`。

扫描前剥注释（`stripComments`）—— 注释里写「`import x from 'a'`」这类举例是常态，
不剥掉会把举例里的假包名当成真依赖，假阳性又变回误杀（本文件自己的规格注释就踩到了）。

### 两处行为变化

1. 覆盖门先算、护栏 3 后判：筛不出测试时**不再**抢报 `NO_TEST_RUNTIME`，
   报 `NO_EVIDENCE`（没东西可跑是覆盖问题，不是运行时问题）；
   `TEST_SET_TOO_LARGE` 的判定顺序保持不变。
2. 失败载荷新增 `reason`（`TEST_DEPS_MISSING` / `TEST_DEPS_UNREADABLE`）、
   `missing` / `unreadable` 明细、`scanned`、`truncated`、`zeroDepRepo`
   —— 下游别再把「零依赖仓库」读成「安装缺失」。

依赖探测**不走**测量链路的 `read` 注入位（新增 `readDeps`，默认 `readFile`）：
那一位在单测里带副作用语义（模拟「第 N 次读才被改过」），探测多读几次会把时序搅乱。

### 防什么没丢

假基线（插件 `import 'zod'` 全报 `ERR_MODULE_NOT_FOUND` ⇒ 23/123）依旧被挡在门外：
相对导入会一路跟进到 `lib/index.js`，那里的裸包名照样验。新增 E3/E3c 两条用例钉死。

### 验收

- `plugins/agint-evolution-driver/test/outcome-measurer.test.mjs` 42/42 绿
  （E3 改写 + 新增 E3b 零依赖放行 / E3c 相对导入跟进 / E3d 插件自带 node_modules）；
- 真仓探测：`agint-wiki` / `agint-curriculum` / `agint-evolution-driver` / `agint-family-panel`
  四个 smoke 与测试入口 `ok:true` ⇒ 护栏放行；
- driver 全套 268 用例：267 绿，1 红为**既存**失败（`skill-gate.test.mjs` G11
  「9 个技能 ⇒ 9 个槽」，现为 10 —— 技能数增长导致的旧断言，与本改动无关）。

## v0.3.0 — 2026-10-04（路线图 A5：driver commit 补 mutator 记账，闭环从「改得进」到「回得退」）

minor 跨级（0.2.19 → 0.3.0）。功能依据：`docs/AGINT-路线图待做清单-20261003.md` A5，
commit `4f6cba0`。

### 为什么跨 minor

0.2.x 的 driver commit 是**单边写入**：`commitToRepo()` 自己落盘 + 备份 preimage，
**从不调 `mutator.commit()`** ⇒ mutator 的 `commits` 表天生为 0。三处后果：

1. `mutator.rollback(commitId)` 查不到行 ⇒ **driver 产出的 commit 无法回滚**；
2. `evolution-reconcile` 的 `mutatorCommits === 0` 告警**恒真** ——
   恒真的告警等于没有告警，它训练读者忽略这一行，真出事也不会被当真；
3. proposal 停在 `PENDING` 会撞 `uniq_atomicScope_pending` 唯一索引，
   同`atomicScope` 的后续提案可能被历史 PENDING 行挡住。

### 本版交付

- **mutator 新增 `recordExternalCommit()`**（本插件的改动）：
  只做记账，不写文件、不跑 sandbox、不跑 policy。`preimageContent` 非空是硬校验
  （空串会让「可回滚到空文件」的假记录进表）。commitId 幂等。
  守门沿用 `LIMITS.COMMITS` 与 `LIMITS.PREIMAGE_BYTES`。
- **driver commit 后调用它**（`plugins/agint-evolution-driver/lib/index.js`）：
  commitId 优先取 `evolution.mutation.committed` 的 `envelopeId`（**与事件同源**，
  账目与事件对得上）；事件总线不可用时退化为本地 `evt-…`（不用 null ——
  null 会让所有 commit 共用同一个空幂等键）。
- 记账失败**不发** `evolve.addFailure`：那是进化失败模式通道，
  账目故障走独立事件 `evolution.mutation.accounting-failed`（否则污染 A4 的失败归因）。
- `status()` 新增 `mutatorRecorded` / `mutatorRecordFailed` 两个计数器。
- `commitToRepo()` 返回值补`preimageContent` / `postimageContent` ——
  此前preimage 只落磁盘备份，**内容没进返回值**，记账入口拿不到。

### 三态对账判据

`evolution-reconcile` 的第 4 源从单一布尔拆成三态
（`absent` / `unwired` / `gap` / `consistent`）。原 `mutatorDegraded` 的定义
在 driver 不写表的时代**恒真**，恒真告警训练读者忽略告警。

### 验收

- driver smoke 48/48、mutator 119/119、reconcile 22/22
- A5 新增单测 38 条（mutator 13 / driver 10 / reconcile 15），
  3 组「放宽⇒变红」实验均产生精确变红、还原后全绿、零实验残留
- 部署位（bundle 槽）端到端复跑全绿

### 仍未达成：数据态

生产 `mutator_stats.commits` 仍为 0 ⇒ `mutatorState = unwired`。
取证：已committed 的 5 笔里，最新那笔由**独立进程**产生
（非宿主 driver 走的），天然绕过宿主记账入口。
⇒ 记账入口已就位但**宿主 driver 还没 commit 过**，读数是诚实的。
转 `consistent` 只能等宿主 driver 自己产生一笔 commit；
**补记存量不可行** —— 独立进程直写存储会被宿主 last-write-wins 静默覆盖。

## v0.2.19 — 2026-10-04（修 insideRepo 在 Windows 正斜杠 repoRoot 下的全量误拒）

### 症状
生产首跑 `outcome-measure`（手工 runNow，2026-10-04 00:04 本地）：`scanned 7 / measurable 1 /
attempted 1 / counts {PREIMAGE_UNPARSEABLE:1}`。唯一的可测条目 seq 7 被拒，`prediction_outcomes` 0 落行。

### 根因
`outcome-measurer.js` 的 `insideRepo()` 把 `repoRoot` 用 `path.sep` 拼串后与
`path.resolve()` 的产物比 `startsWith`。Windows 上 `resolve` 产出反斜杠，而配置值
`repoRoot: "D:/..."` 是正斜杠 ⇒ 两侧形状永不相等 ⇒ 所有测量被误判「改动不在仓库内」。
麒麟（Linux，原生正斜杠）不受影响，属 **Windows-only** 缺陷。

### 修法
两侧同走 `path.resolve` 归一再比对（护栏语义不变：仍拒 `.git/`、`.agint-preimage/` 与仓库外路径）。
回归测试 `test/outcome-measurer.test.mjs` 新增 J1（正斜杠 root 放行并双态真跑）/
J2（仓库外反解路径照旧拒）。

## v0.2.18 — 2026-10-03（修 R2 首版两处假阳性；核签核清单时发现）

### 症状
`_R2金标待签核清单_20261003.md` 第 1 节：1 号红线在 3 个技能报 FAIL，6 号在 1 个技能报了 4 条"不存在的路径"。
逐条核过：6 号那 4 条**全是假阳性** —— `plugins/**/lib/*.js`、`presets/<preset>/skills/<name>/SKILL.md` 这类通配符/占位符被当成真实路径去 stat。
1 号有两类假阳性（`https://…:443`、`http://127.0.0.1:7890` —— 正则 `[A-Za-z]:[\/]` 把 URL 里的 `s://` 当成了盘符）。

### 修法
- `lib/skill-gate.js`：`reference/path-exists` 跳过含 `*` / `<` / `>` 的引用。具体路径照旧必核。
- `bin/skill-gate-candidates.mjs`：盘符判据加左边界断言 `(?<![A-Za-z0-9])[A-Za-z]:[\\/]` ⇒ URL 与端口不再命中，真盘符照旧命中。
- 生成器补 `--refresh`：只覆盖**一条都没签过核**的槽；签过的永不覆盖（防止下次刷判据把老板的手改冲掉）。
- 9 个槽按新判据重刷（`--write --refresh`）。签核状态未变：全部 `addedBy: agent`。

### 重刷后的实测（`node D:/DSH/_r2-review-sheet.mjs`）
- 6 号：9/9 pass（假阳性清零）。
- 1 号：仍 3 个 FAIL，逐条核过都是**真**盘符 —— `check-soundness:64`、`github-push`（10 行，MSYS/OpenSSH 路径示例）、`plugin-preflight:95`（`D:` 反斜杠示例，边界情形）。

### 测试
- 新增 `G12`（盘符判据按**槽文件里的数据**核：URL 不命中、真盘符命中）、`G13`（通配符引用一个都不落到文件系统）。
- 套件 301 绿（+2）。

### 同批数据变更（不升版本）
- 老板签了 B 路线子集：四条 `must-not-*` × 9 个技能 = 36 条 ⇒ `addedBy:boss` + UTC 毫秒 `approvedAt`。
- 每条另带 `scribedBy:agent` + `approvedVia:boss-instruction` + `approvedNote` —— 判据读的是 `addedBy`，多这三栏只为审计上分得清"谁判的"与"谁敲的字"（老板代笔这条不能无痕）。
- 每技能分母从 0 变 4 ⇒ R2 从空槽变成在跑的仪器。基线读数：6 个技能 100%，`check-soundness` / `github-push` / `plugin-preflight` 各 75%（同红在盘符那条）。
- `test/skill-gate.test.mjs` 的 `G11` 跟着改成新不变量：断言已签集合恰是老板点的那四条、`total=4`、`passRate` 有限。

## v0.2.17 — 2026-10-03（R2：技能类有了第二台仪器，但只在人签了标签之后）


### 为什么要加

1b 收口报告 §6.5 留了一条诚实空档：技能 / preset 类变异没有仪器 ⇒ 不锁不测。
老板拍「建 R2」。我先做实验再动手（playbook §3.18 那条纪律）：把 11 条确定性规则断言
（skill-format + AGENTS.md 红线 + ASD 禁用词 + 路径存在性）跑在两次真实技能变异上 ——
9/11 → 9/11，**delta 0.0pp、零条翻转**，而那两次变异一次加了 16 行必需段、一次改对了 bundle 位路径。
规则集只查形式，看不见内容 ⇒ 它当体检合格，当尺子不合格。
能翻的只有**人工签核的内容断言**。实验数据与方案：`D:/DSH/_R2技能评估集方案_20261003.md`。

### 新增

- `lib/skill-gate.js`：R2 判据层。kind 封闭五类（`body/must-include` / `must-not-include` /
  `must-not-match` / `frontmatter/field` / `reference/path-exists`）。
  **只有 `addedBy:'boss'` 且 `approvedAt` 是 UTC 毫秒串的 case 进分母**（`GATE_APPROVER`）——
  裁判不能是选手，这条写进判据而不是写在文档里（外部锚定 §5）。
  0 条已签核 ⇒ `passRate: null`；case 形状坏 ⇒ `ok:false` + `SKILL_GATE_INVALID`，
  ⛔ 仪器故障不许被读成"技能不合格"（与 `cancelled` 不进 TAP 分母同一条纪律）。
- `lib/outcome-scope.js`：`skillCaseFileFor()` + 新分支 `SKILL_GATE`。
  `presets/<preset>/skills/<skill>/SKILL.md` 且**同路有 `eval/skills/<preset>/<skill>.cases.json`** 才算覆盖；
  没金标文件 ⇒ `SKILL_GATE_NO_CASE_FILE`（槽是空的 = 仍没仪器）。preset 名从路径取 ⇒ 拿 agint 的标签判 agint-ops 会被拦。
- `lib/outcome-measurer.js`：第二台仪器（`INSTRUMENT` / `OUTCOME_METHOD`）。
  指标门从"覆盖门之前"挪到"之后"：能不能测取决于用哪台仪器。
  技能条目链上写 `targetMetric:'unspecified'`（1a 刻意不给技能解析指标）⇒ 门禁那台照样量，
  记录按构造写 `SUCCESS_RATE`，**条目原话进 `evidence.entryTargetMetric`**；
  条目预测的是别的量纲（如 TOKEN_EFFICIENCY）⇒ `UNSUPPORTED_METRIC`，⛔ 不拿门禁通过率顶。
  新增终态 `SKILL_GATE_FAULT` / `SKILL_GATE_INVALID`。篡改门位置未动（仍在任何副作用之前）。
- `eval/skills/agint/*.cases.json`：9 个技能的槽，全部 `addedBy:'agent'` + `approvedAt:null`
  ⇒ 一条都不进分母。老板改两个字段即生效。
- `bin/skill-gate-candidates.mjs`：候选生成器（判据来源两路封闭：AGENTS.md 红线 / 已被接受的变异新增段）。
  默认 dry-run，`--write` 才落文件，已存在的文件不覆盖。

### 未做（有意）

- 老板拍 7-2=1「只测不锁」⇒ `expected-effect.js` 与 `metric-resolver.js` **一字未动**，
  技能类仍不锁预测（`predictedDelta:null` ⇒ `pqReason:'NOT_PREDICTED'`）。等攒够 gate delta 分布再谈。
- `trigger/match-*` 类 case 未做：运行时触发匹配器在 dsh 宿主里，AGINT 侧没有同源判据。

### 测试

- 新增 `test/skill-gate.test.mjs` 11 条（含与 `skill-format` checker 的 frontmatter 等价性锁、9 个槽全未签核）。
- `test/outcome-measurer.test.mjs` 加 I 系列 6 条（仪器选型 / 空槽拒测 / 形状坏 / 量纲不符 / 篡改门仍在最前 / 无金标文件）。
- `test/outcome-e2e.test.mjs` 加 E2E-R2：真双态换 SKILL.md ⇒ 基线 1/2 → 候选 2/2 = +50pp，
  过**真 zod schema** 落表（未签核那条没进分母，分母 = 2）。
- `test/outcome-scope.test.mjs` 那条"presets 一律 NO_INSTRUMENT"改成新判据（保留"无金标文件仍不覆盖"那一半）。
- 套件：driver 299 绿（原 260 + 39）。

## v0.2.16 — 2026-10-03（§2.4.2 归档校验终于有了调用点：先验锁，再量账）

### 问题

`predictor.verifyHypothesisLock` 是纯函数、有单测，**但全仓没有一个调用方**。
一把没人校验的锁只防"改 predictedDelta 数值"这一种动作，防不到：

1. 改完 `hypothesis` 的其它成分（`targetMetric` / `changedPlugins` / `lockedAt`）—— 摘要随之变了，没人重算。
2. **删掉 `contract_locks` 的行** —— 链上还写着 `predictedDelta`，见证却没了。
3. 复原路径本身没人验证过 —— `buildLockHypothesis` 只准放三个字段这条纪律，缺一个"从链上字段能否重建 hypothesis"的实测。

### 新增

- `lib/contract-audit.js`：
  - `hypothesisFromEntry(entry)` —— 从 Ledger 条目复原锁定时的 hypothesis；缺任一摘要成分就点名缺哪个（⛔ 不硬算，硬算必得另一个 hash ⇒ 假篡改）。
  - `auditOne({entry, lockRow})` —— 单向判定，五种终态：`VERIFIED` / `CONTRACT_TAMPERED` / `LOCK_ROW_MISSING` / `UNEVIDENCED_HYPOTHESIS` / `LEDGER_ENTRY_MISSING`。
  - `createContractAuditor(ctx).sweep()` —— **双向清点**：表里每行重算 + 链上每个预测都要有锁行。永不抛（`SERVICE_UNAVAILABLE` / `AUDIT_FAILED` 如实上报，⛔ 不可用 ≠ "没有篡改"）。
- `measureOutcomes()` 现在**先 sweep 再测量**，返回值带 `audit` 块（`checked` / `counts` / `tampered` / `orphanPredictions`，各截 10 条）。
- `status()` 加 `auditChecked` / `auditTampered` 两个计数器（"对不上"与"锁行缺失"都计入后者）。
- `outcome-measurer` 加篡改门（第 22 种终态 `CONTRACT_TAMPERED`）：条目自称有预测时，锁重算不回来就**在跑测试之前**拒测，不写 `prediction_outcomes`。
  没有预测的条目不受此门影响 —— 它的 `actualDelta` 仍是真观测，没有"预测 vs 实测"这对关系可供伪造。

### 只判定，绝不修复

与 `contract-manager.verifyLock` 同一条纪律：修复等于重写历史。处置是**标记 + 不计入统计 + 出声**，
出声通道是 cron `outcome-measure` 的 `throw`（见 `agint-cron` 0.2.9）。

### 测试

- `test/contract-audit.test.mjs`（15）：正向 VERIFIED 一条（证明判据不是恒红机器）+ 三种篡改各一条
  （改预测值 / 改指标 / 改 changedPlugins / 改 predictionSource / 改 lockedAt）+ 删锁行 + 缺条目 + 复原不出来 + sweep 双向 + 服务不可用 + 抛错外壳 + 空表。
- `test/outcome-measurer.test.mjs` 新增 H1~H4（篡改门在任何副作用之前：一次测试都没跑、文件没换、没写行）。
- `test/outcome-e2e.test.mjs` 新增第三条：**真服务真 hash** 下改掉存储里的条目 ⇒ 拒测；改回原值 ⇒ 同一条立刻可测（证明拒测的因是"对不上"，不是门禁恒红）。
- 红绿自证：把篡改门改成 `if (false && …)` ⇒ H1/H2/H3 立即变红（3 条），恢复后 31/31 绿。
- 夹具纪律：锁一律用 `computeHypothesisLock` 真算。写死 hash 的夹具会让每条都判红 —— 那是 mock 失真
  （同 §3.14 `bus.publish` 的 `envelopeId` 教训）。但"篡改"类夹具必须**只动存储、不重算锁**，否则记录自洽，测的是没被改过的情形。
- 本插件 280/280 绿。

## v0.2.15 — 2026-10-03（1b R1′ 落地：actualDelta 的尺子 = 改动面测试子集双态跑）

### 新增

| 文件 | 职责 |
|---|---|
| `lib/outcome-scope.js` | 判据层（纯函数）：`parsePreimagePath` 反解被改文件、`deriveTestFiles` 收测试全集、`planTestScope` 按路径规则定子集 + 覆盖门 |
| `lib/outcome-measurer.js` | 测量层：双态跑（候选态 → 临时换回 preimage 跑基线态 → 换回并核 sha）→ `scorePrediction` → 落 `prediction_outcomes`。**永不抛**，21 种终态各自可归因 |

- 服务入口 `measureOutcomes({ repoRoot, env, limit, inject })`；`status()` 加 `outcomeMeasured` /
  `outcomeRefused` / `outcomeAttention` 三个计数器。cron 侧新增 job `outcome-measure`（Tue 10:15，在 `agint-cron` v0.2.8）。
- 存储侧配套在 `agint-evolution-memory` v0.6.9（`prediction_outcomes` 表 + 三个服务方法）。

### 判据依据（2026-10-03 三路实测，见 `D:/DSH/_1b_actualDelta尺子方案_20261003.md` §8）

拿 2026-09-29 那次真实自改（给 `bin/plugin-check.sh` 加维度 11，与 HEAD 差 160 行）做对照：
场景集 123 条**逐条零差异**（看不见改动）；改动面子集 3/3 → 2/3（看得见）；
全仓 1928 条 passRate 只动 0.05pp（远小于死区 1.5pp，会被读成"无实质变化"）。
⇒ 度量集必须是按被改文件筛出的子集。**推荐 R1（场景集双跑）被这次实验推翻了一半**，改为 R1′。

### 四条护栏

1. ⛔ 只换一个文件且必须在 `repoRoot` 内（`pathResolve` 核前缀，不碰 `.git/`、`.agint-preimage/`）。
2. ⛔ 换完必核 sha：核不上仍落表但 `restoreVerified:false` + `needsAttention:true`，job 据此抛错出声。
   换不回去（写失败）⇒ `RESTORE_FAILED` 且不落表 —— 仓库仍处基线态这件事优先于一次测量。
3. ⛔ 裸工作树拒测 `NO_TEST_RUNTIME`：首轮实验在缺 `node_modules` 的 worktree 得到假基线 23/123。
4. ⛔ 覆盖门 `NO_EVIDENCE` 不写行（设计 §4.2.5「不得写 0/null 冒充无改进」）。
   另有 `SUPERSEDED`（同文件后续又被改 ⇒ 归因不唯一）与 `CONCURRENT_WRITE`（动手前现状 sha 变了 ⇒ 不换文件）。

### 修

- `nodeTestRunner` spawn 时清掉 `NODE_TEST_CONTEXT`。E2E 实测：宿主自己跑在 `node --test` 下时
  该变量传给子进程 ⇒ 子 node 判"测试递归"直接跳过跑文件 ⇒ 永远 `RUNNER_UNPARSABLE`。

### 测试

- `test/outcome-scope.test.mjs`（10，用仓库里 6 个真实 preimage 名做夹具）
- `test/outcome-measurer.test.mjs`（27，真临时仓库 + 内容驱动假 runner：**双态真的换了文件**是被证出来的）
- `test/outcome-e2e.test.mjs`（2，真 `node --test` 子进程 + 真 `agint-evolution-memory` 服务：
  写出的行必须过真 `predictionOutcomeEntrySchema`，覆盖门在真仓库上同样拦得住）
- `test/smoke.mjs` T36（`measureOutcomes` 入口与三个计数器）
- 本插件 260/260 绿。


## v0.2.14 — 2026-10-03（修掉 expectedEffect 的谎报：期望按目标类型声明，1b 前置）

### 问题

driver 给**每一个**变异硬写同一句 `expectedEffect: 'baseline 通过率 >= 95% 在 7 天'`（原 `index.js:605`）。
两个缺陷：
1. 不分目标。改一个 `SKILL.md` 也声称"通过率"会涨，而技能类改动今天没有任何测量手段
   （1b 取证实测：`agint_abtest` 0 行、`agint_population` fitness_history/traffic_log 0 行、
   trajectory 的 token/durationMs 无生产者、`agint_metrics` 的 15 个 key 一个都不属于四类指标）。
2. **借词**。v0.2.13 的 `metric-resolver.js` 会照词面把"通过率"解析成 `SUCCESS_RATE`
   ⇒ 每条变异（含多数量的技能类）都被锁成一条预测。时序合法、锁也真能验，
   但它承诺的是一个**没人测、也测不到**的数 —— 攒出来的校准分是"预测 vs 无证据"的混合物。

危害的落点在解析后果，不在措辞。所以修的是"声明什么"，不是"怎么写得好看"。

### 变更

- **新增 `lib/expected-effect.js`**：`expectedEffectForTarget({ targetType })`，两句封闭声明。
  - 代码类（repo 文件）⇒ `场景集通过率 >= 95% 在 7 天`。**点名仪器**（`eval/scenarios/driver.js`
    离线、确定性、零 LLM + `agint-quality-eval` 的 `computePassRate`/`baselineDelta`），
    也就是 1b 方案里的 R1。解析 ⇒ `SUCCESS_RATE` ⇒ 可以锁。
  - 技能/preset 类 ⇒ `技能输出质量评分 >= 90% 在 7 天`。这个词**刻意不进** `METRIC_KEYWORDS`
    ⇒ 解析 `METRIC_UNSTATED` ⇒ 外壳不落锁 ⇒ 链上 `predictedDelta` 留 null。
    等 R2（技能评估集）建好并登记指标，这条才升级成可测承诺。
  - 为什么技能类也给一句而不是留空：mutator 的 FROZEN 契约**必须**收到可证伪串
    （`agint-mutator/lib/index.js:369` 的 `VALIDATE_EXPECTED_RE`，缺了就 validate 失败）。
    所以给的是"这次改动真实想改善的量"，而不是一个恰好过正则、又恰好被解析成有仪器的指标。
- `index.js`：propose 的 `expectedEffect` 改为 `expectedEffectForTarget({ targetType: target.type })`。
- ⛔ `expected-effect.js` **不抄** mutator 的正则做二次校验（第二个真相源）。
  契约校验由真 `agint.mutator.validate` 在测试里跑（跨插件 import 只出现在测试，
  与 `test/contract-manager.test.mjs` 引 evolution-memory lib 同一先例）。

### 测试

- 新增 `test/expected-effect.test.mjs` 5 case：映射与"不复用" / 代码串点名仪器 /
  代码串解析成 SUCCESS_RATE / **技能串解析为 null + METRIC_UNSTATED** /
  两句都过真 mutator 的 FROZEN 可证伪校验。
- `test/smoke.mjs` **T25h**：skill 目标分支实际发出的 `propose` 入参必须是技能那句。
- `test/smoke.mjs` T25：新增断言 repo 目标发出的是 `EXPECTED_EFFECT_CODE`。
- 套件：driver 220（原 214）全绿，9 个门禁 exit 0。
- 红绿自证：把 `index.js` 改回那句硬编码 ⇒ T25 与 T25h 立即变红，改回后全绿。

### 影响面（要说给老板的口径）

- 生产链上从现在起：**代码类变异**才会有 predictedDelta；**技能类**（占比多数：
  09-17→10-03 实测 skill 124 / plugin 12）继续留 null 并记 `targetMetricReason: METRIC_UNSTATED`。
  这是有意的：宁缺不假。覆盖率要等 R2。
- 本轮未动 metric-resolver / prediction-locker / ledger-writer 的判据，只换了声明源。


## v0.2.13 — 2026-10-03（targetMetric 从提案期望里读出来，1a 补片 / 方案②）

### 问题

v0.2.12 把锁接进了主循环，但明写了「生产当前形态下不产生锁行」：
mutator 的 `expectedEffect` 是**字符串**（FROZEN，`agint-mutator/lib/index.js:128`），
population 只认**对象**（`agint-population/lib/index.js:173`）⇒ 实时路径
`variant.expected_effect.metric` 恒为 `'unspecified'` ⇒ `DEFAULT_RULE_TABLE` 查不到 ⇒
每周期 `NO_PREDICTION_AVAILABLE`。老板拍板走方案②（不动 FROZEN、不等 1b）。

### 变更

- **新增 `lib/metric-resolver.js`**：`resolveTargetMetric({ variantMetric, expectedEffect })`。
  - 优先级只有一条：variant 行记过指标就用它，本模块不插手（四类之外的指标名也原样放行 ——
    它是真实记录，不是"不在表里就作废"）。只有落兜底（`'unspecified'` / 空）才去读期望串。
  - 关键词表封闭（`METRIC_KEYWORDS` 四类，中英都收）。⛔ 不替提案编指标：
    一个都不匹配 ⇒ `METRIC_UNSTATED`；匹配两类以上 ⇒ `METRIC_AMBIGUOUS` + `matched` 列出全部。
  - **为什么歧义时不取第一个命中**：一旦按顺序取，就是**关键词表的顺序**在替系统做预测，
    而不是提案在说它要改什么。宁可这一期没预测。
  - 返回值带 `source`（`VARIANT` / `EXPECTED_EFFECT`），出处必须分栏可查。
- `index.js`：锁定前先解析指标，同一个值**同时**喂给 `predictionLocker.lock()` 与
  `ledgerWriter.writeDecision()`。理由不是美观，是密码学：`hypothesisLock` 把 targetMetric
  折进了摘要，条目里写另一个值 ⇒ 1b 归档复原重算必判**假篡改**，整把锁作废。
- `index.js`：`predictionAudit` 提到与 `commitAudit` 同一层，并直接挂进 `runOnce` 返回的
  `summary.prediction`（不再只挂在 commitAudit 里）。跳过 commit 时 commitAudit 是 null，
  那一刻已经落表的锁会成"表里有 hash、别处查不到预测内容"的孤行；提到外层就看得见。
  新增三个字段：`targetMetric` / `targetMetricSource` / `targetMetricReason`。
- `ledger-writer.js`：`buildLedgerEntry` 收可选 `targetMetric` 入参（非空串才认，脏值回落到
  variant 行，⛔ 不许用来补一个"看起来对"的指标）；`hypothesisDigest` 改用**同一个**指标名，
  否则摘要与 `summary.targetMetric` 分叉成两条真相。`variant: null` 仍判 `NO_VARIANT_ROW`
  —— 给个指标名补不齐 generation 与候选 id 的出处。

### 测试

- 新增 `test/metric-resolver.test.mjs` 8 case：variant 优先（含四类之外）/ 兜底值与脏值都不算指标 /
  七种生产措辞解析 / 不匹配 / 歧义 / 期望缺失 / 纯函数 / **两张表分叉守卫**
  （解析表每个指标必须在 `DEFAULT_RULE_TABLE` 每一类里有条目，反向也必须一一对应 ——
  否则就是"解析得到却预测不出来"的哑弹）。
- `test/smoke.mjs` **T25f**：生产形状（variant `unspecified` + 期望串"通过率 >= 95%"）⇒
  真落一行锁、条目 `targetMetric` 是 `SUCCESS_RATE`、摘要与预测字段齐全、出处标 `EXPECTED_EFFECT`，
  并**只用这条 Ledger 条目 + 表里的 lockedAt 重算 hash 必须逐字节相同**（归档真跑得起来）。
  **T25g**：期望串含两个指标 ⇒ 不锁、`METRIC_AMBIGUOUS` 落 summary、链上照原样留 `unspecified`、
  commit 不受影响。
- `test/ledger-writer.test.mjs` +3 case：入参覆盖 + 摘要同步 / 脏值回落且拒写不被绕过 /
  `NO_VARIANT_ROW` 不被指标入参绕过。
- 套件：driver 214（原 201）全绿。红绿自证：把条目的 `targetMetric` 改回 variant 值
  ⇒ T25f 的 hash 复原断言立即变红，改回后全绿。

### 已知未收口（不在本轮）

- 期望串的措辞覆盖面 = 目前实际会产生的那些（driver 硬编码 `'baseline 通过率 >= 95% 在 7 天'`
  + mutator `SOURCE_STUBS` 三类）。将来新增措辞要先加关键词表与用例，否则走 `METRIC_UNSTATED`
  ⇒ 不锁（安全侧，但会静默少数据；`summary.prediction.targetMetricReason` 可查）。
- 1b（actualDelta 的尺子与回填）、归档校验调用点、`prediction_outcomes` 表仍未做。
- 运行态：本轮仍全是单元/契约层。判据是部署后 `contract_locks` 出现行、链上条目带非 null
  `predictedDelta`，且 `summary.prediction.targetMetricSource` 两类都有分布。


## v0.2.12 — 2026-10-03（预测锁定进主循环，Phase 1.1 支点 1a / §2.4.2）

### 问题

v0.2.11 收口时留了一条明示缺口：`createContractManager` 在生产代码里**无调用点**
⇒ `contract_locks` 0 行、链上 `predictedDelta` 恒 null ⇒ 整个
「预测 vs 实际」的校准回路没有源头数据（`grep contract-manager plugins/**/lib/index.js` 零命中）。

试做时先在 `buildLedgerEntry` 里直接调 `generatePrediction` 填数，被仓内守卫测试
「⛔ 无证据字段一律 null」挡下。这次判定**守卫是对的，不动它**：
`generatePrediction` 虽是 prior-only，但在「写链那一刻」计算仍把预测与结果的先后
交给了进程时序而非密码学 —— §2.4.2 要防的正是这种"看着像先见之明"。
所以 1a 的形态是**把锁接进主循环的评估之前**，再把锁里的预测**当入参**传给条目。

### 变更

- **新增 `lib/prediction-locker.js`** —— `contract-manager.lockPrediction` 外面的**软失败外壳**：
  - **永不抛**。`lockPrediction` 的硬失败语义（域不可用即抛、caller 中止进化）保持不变，
    但主循环没有"中止进化"这条通道：抛上去会被 commit 的 `catch` 收成「commit threw」
    并触发一次真实回滚 —— 等于让观测缺陷毁掉一次仓库改动。外壳按 `ledger-writer` 的
    同一套纪律改成**可见的跳过**：warn + 计数器 + `cycle.summary` 带 status，predictedDelta 留 null。
  - **无预测 ⇒ 不落锁**。三级降级链查不到条目（如生产恒见的 `metric:'unspecified'`）就返回
    `NO_PREDICTION_AVAILABLE`，不往 `contract_locks` 写空锁占行 —— 表里的"覆盖"必须是真覆盖。
  - 状态清单 `PREDICTION_LOCK_STATUS`：LOCKED / NO_CONTRACT_ID / NO_PREDICTION_AVAILABLE /
    LOCK_UNAVAILABLE / ALREADY_LOCKED / LOCK_FAILED。只有 LOCKED 带 `locked:true` 凭证。
  - `buildLockHypothesis()` —— 参与 hash 的 hypothesis **限定三个字段**
    （mutationType / targetMetric / changedComponents）。理由不是简洁，是**可复原**：
    `contract_locks` 只存 hash 不存内容（单一真相源纪律），1b 归档校验要能只靠
    同一条 Ledger 条目 + 表里的 `lockedAt` 把 hash 重算回来。加一个复原不回的字段
    = 造一把永远验不了的锁。
- `index.js`：**锁定调用点在 `commitToRepo` 之前**（fail-closed 闸门之后、写入与验证之前）。
  `contractId = proposal.id`、`mutationType = proposal.kind`、`targetMetric = variant.expected_effect.metric`、
  `changedComponents = pluginFromPath(commitPath)`。锁到的预测作为 `prediction` 入参传给
  `ledgerWriter.writeDecision`；`commitAudit` 新增 `prediction` 段（status / predictedDelta /
  predictionSource / lockEventId）经 summary 通道落盘。计数器 `predictionLocked` / `predictionSkipped` 进 `status()`。
- `ledger-writer.js`：`buildLedgerEntry` 收 `prediction` 入参，并加**证据门** `lockedPredictionOf` ——
  只认 `locked:true` + 有限数 + 非空 `hypothesisLock` + enum 内来源，四个条件缺一就留 null。
  `actualDelta` / `predictionQuality` / `contractHash` 不受影响，继续 null。
  `pluginFromPath` 改为导出（主循环取 changedComponents 用，⛔ 不留第二份实现）。
- `contract-manager.js`：**修 `lockEventId` 恒 null 的字段名错配** ——
  `publishLocked` 读 `res.id`，而真实 bus 返回的是 `envelopeId`（`agint-event-bus/lib/bus.js:163-169`）。
  既有测试的 mock 返回 `{ok:true}`（连 `accepted` 都没有），所以照不出这个洞。
  生产后果：表里那条锁接不回总线里那条真实事件，而 `evolution.contract.locked` 正是
  「当时确实这么预测过」的外部见证。

### 测试

- 新增 `test/prediction-locker.test.mjs` 13 case：成功形状（含 hash 与事件 payload）/
  **只用 Ledger 字段重算 hash 必须逐字节相同** / 改一个字段即判 `CONTRACT_TAMPERED` /
  bus 缺失仍落表 / `unspecified` ⇒ 零写库 + 三级 attempts 留痕 / 四类跳过全部不抛 /
  重放 ALREADY_LOCKED 且不出凭证 / 裸 ctx 与空参不炸 / `buildLockHypothesis` 形状。
- 新增 `test/smoke.mjs` **T25d / T25e**（真实 tmpdir，真跑 verify+policy）：
  T25d 断 `order === ['lock','policy']`，并在 `recordContractLock` 里**读磁盘**证明
  「锁定那一刻仓库还是原文」（数组顺序证不了"结果尚未发生"，文件内容证得了）；
  再断预测流入条目 + `lockEventId` 接得上总线那条事件 + 改动照常落盘。
  T25e 复刻生产实况（`metric:'unspecified'`）⇒ 不锁、不发事件、链上 null、commit 照成功。
- `test/ledger-writer.test.mjs` +5 case：带锁预测入 summary/references；
  **十种无凭证形状一律留 null**（含 `locked:false`、NaN、字符串数字、脏 source）；
  `contractHash` 不许被 `hypothesisLock` 顶替；写入器透传。守卫测试原文未动。
- 套件：driver 201（原 181）全绿；`agint-evolution-memory` 164 全绿；
  门禁 `check-wiring` / `check-l0-frozen` / `check-spec-consistency` / `verify-event-topics` /
  `check-zero-deps` / `check-tool-schemas` / `check-storage-table-api` / `check-publish-safety` 全 exit 0。
- ⚠️ `check-preset-parity.test.mjs`(3) 与 `check-wiring.test.mjs`(1) 有失败，**与本次无关**：
  同两条在 HEAD 基线（干净 worktree）上分别红 3 与 4，报的是「部署副本 vs 仓库」的部署漂移
  （input-gateway / family-panel 等未上线文件）。本轮未新增失败项。

### 已知未收口（不在本轮）

- **1a 在生产上暂时"接了但锁不到数"**：mutator 的 `expectedEffect` 是**字符串**
  （FROZEN 契约，`agint-mutator/lib/index.js:128`），而 population 只认**对象**
  （`agint-population/lib/index.js:173`）⇒ 实时路径 `metric` 恒为 `'unspecified'`
  ⇒ `DEFAULT_RULE` 表查不到 ⇒ 每周期返回 `NO_PREDICTION_AVAILABLE`、不锁。
  要让链上真出现 predictedDelta，得先定「targetMetric 从哪来」—— 这是设计分叉，见根目录
  `_Phase1.1_PredictionOutcome_支点上_20261003.md` §4.6，等老板拍板，本轮不猜。
- 1b（actualDelta 度量源与回填）、归档校验（`verifyLock` 调用点）仍未做。
- 运行态：本轮全部为单元/契约层。真实锁行要等部署 + 跑一期 evolution-cycle，
  判据是 `agint_evolution.json` 的 `contract_locks` 出现行、且链上条目带非 null `predictedDelta`。


## v0.2.11 — 2026-10-03（决策入 Evolution Ledger，§4.3.4 / Sprint 22 #10）

### 问题

Ledger 侧（交付物 3）已经建好链、算好 hash、能锚定，但**生产里一条实时条目都不会产生**：
driver 的决策只发到事件总线和 `commitAudit`，从来没有人调 `ledger.append`。
取证：`grep -rn "ledger" plugins/agint-evolution-driver/` 在改动前**零命中**。

同时有一条设计内部矛盾必须裁定：§7.1 的集成测试行写的是
「outcome 回填 → PQ 计算 → ledger 写入」，即**等 T+7 度量出来再入链**。按字面实现会同时踩三个坑：
`summary` 参与 entryHash 且条目永不重写（纪律 9）⇒ 那七天里这次进化在链上不存在；
REJECT/ABSTAIN 根本没有 T+7 窗口（改动已回滚）⇒ 被拒绝的历史永远不进链，
正是 §4.3.4 末段禁止的「在证据层重新美化历史」；且 `prediction_outcomes` 是 Sprint 24 的交付物，现在还不存在。

### 变更

- **新增 `lib/ledger-writer.js`**：
  - `buildLedgerEntry()` 纯函数 —— 证据 → 条目。缺证据即返回 blocker 并**拒写**，⛔ 不代填：
    `NO_PROPOSAL_ID` / `MUTATION_TYPE_UNEVIDENCED` / `NO_VARIANT_ROW` /
    `TARGET_METRIC_UNEVIDENCED` / `DECISION_UNEVIDENCED` / `TIMESTAMP_UNEVIDENCED`。
  - `createLedgerWriter().writeDecision()` —— 只经 `agint.evolution.ledger.append`
    （§4.3.4 纪律 1 单写者），一次决策一次 `await`（纪律 2，⛔ 不复用 EvolutionLogBuffer），
    **永不抛**但失败四通道可见：返回值 + warn + `state.ledgerFailed`（进 cycle.summary）
    + `failure_pattern` 落行（纪律 3）。
- `index.js`：committed / rolledback 两个分支之后统一入链；`publish()` 改返回 `envelopeId`
  （原来只回布尔），条目 `references.eventBusIds` 由此接上真实事件。
- **裁定：写在「决策当时」，度量不回填**。`predictedDelta` / `actualDelta` /
  `predictionQuality` / `predictionSource` / `contractHash` / `lockEventId` / `gitCommit` /
  `mountTicketId` / `abTestId` 一律 null —— 前四个等 Contract 锁定与 Sprint 24 回填，
  `gitCommit` 等人工提交。条目的定位是「这一期进化做了什么决定」，后续度量走
  `prediction_outcomes`，用 `contractId` 交叉引用，⛔ 不回来改链。
- `commitAudit.reverted`：原来在 REJECT 分支**写死 `true`**，于是「policy 拒了但 preimage
  没恢复回去」（改动仍在仓库里）在落盘 summary 里与成功回滚长得一模一样。改为 `restored.ok`，
  并把回滚结果固化进 `hypothesisDigest`（`exec=reverted` / `exec=NOT-reverted`）——
  摘要参与 entryHash，事后无法改写。

### 测试

- 新增 `test/ledger-writer.test.mjs` 19 case：字段口径 / null 纪律 / GEN-### 与 GEN-UNKNOWN /
  `plugins/` 归属判据（含 Windows 反斜杠）/ `metric:"unspecified"` 照原样入链（生产 7/7 行实况）/
  eventBusIds 去重排序 / 摘要确定性与 200 截断 / 六个 blocker / 幂等重放 /
  CAS 抛错 → `APPEND_FAILED` / 依赖后挂载（软依赖不缓存）/ 裸 ctx 不抛 TypeError。
- `test/smoke.mjs`：T25 断言 AUTO_DEPLOY 真实入链（14 项字段核对）；
  **T25c 参数化为 REJECT 与 ABSTAIN 两条用例**，各跑真实 tmpdir 回滚 + 真实入链。
  mock 补真契约：`bus.publish` 返回 `envelopeId`（bus.js:164-169 实况）、
  `population.ingest` 返回带 `generation` / `expected_effect` 的 variant 行
  （生产 `agint_population.json` 实况）、`agint.evolution` 提供 `ledger.append` 命名空间。
- 红绿自证：把 `outcome.decision` 硬改成 `'AUTO_DEPLOY'` ⇒ T25c 立即变红（断言真的绑在决策值上），
  改回后 42/42 绿。
- 套件：ledger-writer 19 + smoke 42 + contract-manager 27 + predictor 46 + prediction-scoring 38 + goal-bridge 9。
- 接线后的跨插件回归（2026-10-03 实测全绿）：`agint-evolution-memory` 9 个 test 文件 151 case
  + `smoke.mjs` 13 case；门禁 `bin/verify-event-topics.mjs` `failed:false`、
  `bin/verify-ledger-chain.mjs` 报 `LEDGER_EMPTY`（生产链上 0 条，属预期，非失败）。

### 已知未收口（不在本轮）

- ⚠️ **时序副作用**：首条实时条目入链即永久关闭 §4.3.5 的重建窗口。
  正确顺序是先 `ledger.rebuild({apply:true})` 补那 6 条历史（窗口现为【开】），再部署本接线；
  若接线先上线，历史只能追加尾部并标 `reconstructed: true`（合法，但 seq 与事件时序不再一致）。
- 运行态仍未验证：本轮全是单元/契约层。**真实入链要等宿主部署 + 跑一期 evolution-cycle**，
  判据是 `agint_evolution.json` 的 `evolution_ledger` 出现非重建条目（§7.1 分层验证纪律）。
- `contract_locks` / `evolution.contract.locked` 尚未接进 commit 路径（`createContractManager`
  在生产代码里无调用点）⇒ `references.contractHash` / `lockEventId` 持续为 null。
- 版本对齐：manifest.json 0.2.6 与 package.json 0.2.10 长期漂移（`verify-manifests.mjs` 有
  VERSION_DRIFT 记录），本次一并对齐到 0.2.11。


## v0.2.10 — 2026-09-29（commit 阶段的 policyDecision 落盘可查）

### 问题

主链通电后仍有一处永久盲区：**policy 到底是 AUTO_DEPLOY 还是 PENDING_REVIEW，无从查证**。

三处叠加造成的：

1. `committed` 事件里其实**已经带了** `policyDecision`（`lib/index.js:776`）—— 但事件未落盘
   （T1 影子期 publish-only），事后查不到。
2. cron 的 `summarizeResult` 只写 `Object.keys(result)`，值全丢。
3. **driver 自己的返回值也有 bug**：
   ```js
   policyDecision: variant?.policy_decision ?? null,   // ← 提案阶段
   commit: commit?.ok === true
     ? { path, preimagePath }                          // ← 成功分支不带 policyDecision
     : { ok: false, policyDecision, ... }              // ← 只有失败分支才带
   ```
   **恰恰是 commit 成功时拿不到决策**。而且顶层那个 `policyDecision` 是提案阶段的
   `variant.policy_decision`，与 commit 阶段不是一回事 —— 抄它会得到误导性的答案。

### 变更

- `decision` 改为保留完整决策对象：新增 `decisionRaw = await policy.decide(...)`，
  `decision` 仍取 `.kind`。**`reason` 字段是排障抓手**（`policy-abstain:empty-results` /
  `safety-veto:below-0.5` 这类），原先 `(await decide())?.kind ?? 'ABSTAIN'` 把它丢掉了。
- 新增外层 `let commitAudit`，在 committed / rolledback 两个分支分别记录
  `policyDecision` / `policyReason` / `verifyMode` / `verifyOk` / `verifyReason` /
  `reverted` / `sandboxOk` / 字节数 / preimagePath。
- `commit` 对象的**成功分支**补上 `policyDecision` 与 `verifyMode`。
- 返回值新增 `summary`，交给 agint-cron v0.2.4 的约定式摘要通道落盘。

### 踩坑：作用域

`commitAudit` 第一次声明在 `} else {` 与 `try {` 之间（紧跟 `commitToRepo` 那个分支），
结果 `ReferenceError: commitAudit is not defined`（8 例挂）。原因是
`policy.decide` / `verifyTargetFile` 都在**该 `else` 块内部**，而 `runOnce` 的 `return`
在那一层之外。**必须与 `let commit = null` 同级**。

### 测试

- T25（成功路径）新增断言：`out.commit.policyDecision` / `out.summary.policyDecision` /
  `policyReason` / `verifyMode` / `reverted` / `proposalId`；mock policy 补上
  `reason: 'score-85'` 以证明 reason 真被带出。
- T25c（REJECT 路径）新增断言：`out.summary.policyDecision === 'REJECT'` /
  `policyReason === 'veto'` / `reverted === true` / `verifyOk === true`。
- **自证**：把 `commit` 成功分支的 `commitAudit?.policyDecision ?? null` 换成 `null`
  后 T25 变红（40/41）；恢复后 41/41。

## v0.2.9 — 2026-09-29（修 policy 契约错配：dimensions 必须带 key）

### 背景

v0.2.8 部署重启后第一次实跑，`evolution_queryFailures` 里出现：

```
pattern: evolution-commit-rejected:policy
evidence: proposalId=8d0c51eb path=bin/plugin-check.sh decision=REJECT
          verifyMode=syntax:.sh verifyOk=true reason=n/a reverted=true
```

v0.2.8 本身工作正常（`verifyOk=true` 说明 `bash -n` 通过，回滚也成功）。但
**语法检查满分却被 REJECT**，说明问题在 policy 这一侧。

### 根因：EvalResult.dimensions 字段名错配

`agint-quality-policy/lib/decide.js` 的 `computeComposite` 全程只认 `d.key`：

- line 88 `const w = weights[d.key] ?? 0;` — 只给 `name` 时 `weights[undefined] === 0` → `continue`
- line 93 `if (den === 0) return null;` — 所有维度被跳过 ⇒ `den===0` ⇒ 返回 `null`
- line 244 `if (composite === null) → anyVeto = true → REJECT`

即**只要 `dimensions` 用 `name` 而不是 `key`，policy 必然 REJECT，与分数无关**。
driver 的 synthEval 写的是 `{ name: 'safety', ... }`。

**这不是笔误，是照抄来的**：`agint-mutator/lib/index.js:609` 至今仍只传 `name`。
所以 `mutator.commit` 一旦被真正启用也会恒被 REJECT —— 它至今 `commits=0`，
这个 bug 从未暴露过。driver 走自己的 commit 路径，才第一次把它撞出来。

### 为什么单测没抓到

v0.2.8 的 T25 用 `policy.decide: async () => ({ kind: 'AUTO_DEPLOY' })` —— 固定返回值、
不校验入参形状，字段名写错也照样绿。**mock 要复读契约，而不是复读被测代码的期望。**

### 变更

- synthEval 的 `dimensions` 同时写 `key` 与 `name`：`key` 满足 policy 契约，
  `name` 兼容按 `name` 读旧结构的调用方。
- **不是改 FROZEN 契约**：`key` 才是 `EvalResult` 的契约字段，这里是**回到**契约，
  不触发 L0（人类多签 / 7 天影子 / major 版本）。
- T25 的 policy mock 改为复刻真实契约（无 `key` → REJECT），并断言
  `dimensions[].key === ['safety','trust']` 与 `.name` 同时存在。
- **自证**：把 `key` 去掉后重跑，T25 变红（40/41, exit 1）；恢复后 41/41。

### 遗留（本版未做）

`agint-mutator/lib/index.js:605-618` 的 synthEval 仍是 `name`-only，属同一处契约错配。
修它要改 `agint-mutator` 插件源码（另一个插件的 preflight），本版未动。

## v0.2.8 — 2026-09-29（换掉选错的验证器 + 失败原因落 failure_pattern）

### 背景

v0.2.7 部署 + 重启 + 实跑 cron 后暴露两个问题。**两个都不是设计问题，是实现问题，
且都要靠真实生产跑才发现 —— 单测全绿也照样漏掉。**

**① 第 4 道闸选错了工具，commit 100% 失败。**
v0.2.7 用 `sandbox.runSmoke` 做写入后验证。实测把 `bin/plugin-check.sh` 交给它，返回
`ok:false reason=package-json-missing`（它去 `bin/plugin-check.sh/package.json` 找插件清单）——
`runSmoke` 是**插件结构冒烟**（dynamic import `lib/index.js` + 校验 package.json +
exports 含 apply/inject），而本插件的目标是**任意仓库文件**。语义不匹配 ⇒ 恒失败 ⇒
policy 恒拒 ⇒ commit 恒被拒。这不是配置问题，调 `allowInProcessFallback` 修不好
（schema.js:41 默认即 `true`）。

**② 失败原因完全不可见（v0.2.7 自己引入的缺陷）。**
catch 分支只 `warn` 走 stdout（常驻进程读不到），cron 持久化又只写死 `"ok"`，
叠加 driver 事件未进 event-bus（T1 影子期，`evolution.cycle.summary` 也是 0），
结果是这一轮为什么失败**查不到任何线索**。

### 变更

- 新增 `verifyTargetFile({ repoRoot, relPath, sandbox })`：按文件类型选验证器。
  目录 → 仍走 `sandbox.runSmoke`（它唯一擅长的场景）；`.sh`/`.bash` → `bash -n`；
  `.js`/`.mjs`/`.cjs` → `node --check`；其余（`.md`/`.yaml`/`.json`…）→ 跳过，
  明确标注「交给 policy.decide 定夺」而不是假装通过。结果仍交 `policy.decide`，
  本函数不自行决定去留。
- 新增 `recordFailure()`：三条失败路径（commit-skipped / 拒则回滚 / 写入后异常）
  全部写 `agint.evolution.addFailure`，pattern 区分
  `evolution-commit-skipped:verify-unavailable` /
  `evolution-commit-rejected:{policy|verify}` / `evolution-commit-threw`，
  evidence 带 verifyMode + 原因 + 回滚结果。
- 事件补 `verifyMode` 字段；`rolledback` 另带 `reason`。
- fail-closed 判据放宽为「policy 必须有 + sandbox 仅在目标是目录时才必需」。

### ⭐ 拦下一个会让第 4 道闸彻底失灵的坑

写单测时发现 `node --check` 对 ESM **漏检**（本机 node v22+ 实测）：

| 内容 | 扩展名 | 退出码 |
| --- | --- | --- |
| `export const a = ;` | `.js` | **0 —— 漏检** |
| `const a = ;` | `.js` | 1 ✅ |
| `export const a = ;` | `.mjs` | 1 ✅ |

而 AGINT 仓库里几乎所有 `lib/*.js` 都是 ESM —— 不处理这条，第 4 道闸**恰好在最需要它的
场景上完全失灵**，比没有闸更危险（看起来绿了，其实什么都没验）。

修法：`.js` 先按内容判是否 ESM（含顶层 import/export 形式），是则复制成临时 `.mjs` 再检
（实测可检出）；否则直接检，避免把合法 CJS 判死造成假阳性。`.mjs`/`.cjs` 扩展名自带语义，
直接检。

### 影响

- 行为变更：文件目标不再调用 `runSmoke`。单测 T25 把 `sandbox.runSmoke` 设成**抛错**，
  代码一旦退回旧路径立刻变红。
- 失败原因现在可在 `evolution_queryFailures` 查到，不必再猜。
- 不改 FROZEN 契约：仍未触碰 `MutationPayloadSchema`；A 方案（统一到 `mutator.commit`）
  依然需要 L0 变更，未做。

### 验证

- `test/smoke.mjs` 41/41（新增 T26a/b/c/d）；`test/goal-bridge.test.mjs` 9/9。
- **T25/T25c 改用真实 tmpdir**（v0.2.7 的虚拟 fs 满足不了「真跑 node --check」），
  T25c 现在真断言「回滚后磁盘内容与改动前逐字节一致」，而不只是断言返回值。
- 真实仓库抽查无假阳性：driver lib/index.js、quality-sandbox lib/index.js、
  test/smoke.mjs、bin/plugin-check.sh、bin/check-wiring.mjs、install/install.sh 全 PASS；
  `.md`/`.json`/`.yml`/无扩展名正确 skip；路径不存在正确判死。
- `bin/plugin-check.sh --all`：driver 9 维度全过；全仓 4 既存 FAIL 与改动前一致。
- 字节保真：两文件 BOM/换行/尾字节与 HEAD 逐字节一致。

## v0.2.7 — 2026-09-29（commit 补写入后 D-QAF 验证 + fail-closed）

### 背景

排查「自进化主链最后一公里」时确认：本插件的 `commitToRepo` 走**自己的**落盘路径，
不经过 `mutator.commit`，因此整条 commit 链路**只过写入前闸门**（denylist / oldText 唯一性 /
preimage 备份），写完直接发 `evolution.mutation.committed` 事件结束 —— **不跑
`sandbox.runSmoke`、不过 `policy.decide`**。后果是三处同时为零：`mutator.commits` 表 0 条、
`sandbox.passed` / `sandbox.failed` 事件 0 条、提案永远停在 `PENDING`。

这等于 AGENTS.md 明令禁止的「绕过 D-QAF 任意阶段直接部署」：**仓库被改了，但没有任何
东西验证过这次改动**。

### 变更

- `runOnce` 的 commit 分支接入 `agint.qualitySandbox` 与 `agint.qualityPolicy`（软依赖，
  与 `agint.evolve` / `agint.mutator` / `agint.population` 同样的 `inj.x ?? dep()` 取法）。
- **写入后验证**：`commitToRepo` 成功后强制 `sandbox.runSmoke` → 合成 EvalResult →
  `policy.decide`，语义与 `mutator.commit` 步骤 5/6 对齐（safety/trust 双维，
  sandbox 失败则 score 0 + veto）。
- **决策为 `REJECT` / `ABSTAIN` 即回滚**：新增导出函数 `restoreFromPreimage()`，
  从 `commitToRepo` 已生成的 `.agint-preimage/*.bak` 拷回原位，不依赖 git。
  回滚后发 `evolution.mutation.rolledback`，**不发** `committed`。
- **⛔ fail-closed（破环性）**：`sandbox` 或 `policy` 不可用时**根本不写仓库**，只发
  `evolution.mutation.commit-skipped`。这是与 `mutator.commit` 的关键差异 —— 后者写完才发现
  sandbox 缺失，只能抛错并留下半成品；本版把检查前置。
- 写入后抛异常时同样尝试回滚，避免留下未验证改动。
- `runOnce` 返回值的 `commit` 字段在失败时不再恒为 `null`，改为携带
  `{ ok:false, path, policyDecision, sandboxOk, reverted, reason }`，
  让调用方能区分「被拒」与「路径不合法」。**注意：cron 持久化仍只写死 `"ok"`，
  真实原因要看事件总线。**
- `evolution.mutation.committed` 事件新增 `policyDecision` / `sandboxOk` 两个字段。

### 影响

- 这是**行为变更**：未挂载 `agint-quality-sandbox` 或 `agint-quality-policy` 的部署，
  `evolution-cycle` 将**不再修改仓库**（此前会改）。这是有意的 —— 没有验证能力就不改仓库。
- 不改 FROZEN 契约：`mutator.commit` 的 `input.pluginId` / `propose` 的 `targetPlugin`
  按既有 back-compat 通道走，本版未触碰 `MutationPayloadSchema`（仍是 4 字段 FROZEN）。
- **未统一到 `mutator.commit`**（原计划 A 方案）：核对后发现
  `mutator.generatePostimage` 对 `PROMPT_MUTATION` 直接 `return p.newText` 当整文件内容，
  而本插件是 `text.replace(oldText, newText)` 局部替换；`deriveTargetPath` 又硬编码
  `plugins/{pluginId}/prompts/{promptId}.md`，对本插件的 skill / repo 目标全部算错。
  直接接线会把 SKILL.md 整份覆盖成一个小节。统一需给 FROZEN payload 加 `targetPath`
  ⇒ 触发 L0 变更流程（人类多签 + 7 天影子模式 + major 版本），2026-09-29 老板改选 B 方案。

### 验证

- `test/smoke.mjs` 37/37（新增 T25b fail-closed、T25c policy REJECT 回滚）；
  `test/goal-bridge.test.mjs` 9/9。
- `bin/plugin-check.sh --all`：agint-evolution-driver 9 维度全过；
  全仓 4 个既存 FAIL（3×manifest 缺失 + 1×K19）与改动前一致，无新增。
- 字节保真：`lib/index.js` 与 `test/smoke.mjs` 的 BOM/换行/尾字节与 HEAD 逐字节一致。

## v0.2.5 — 2026-09-27（实体门抽成可复用模块 + 服务扩展点）
## v0.2.6 — 2026-09-28（行动 #2 goal 桥：提案 → dsh goal 驱动）

### 背景

报告行动 #2 后半段：`dsh-goal-round-driver` 已在宿主挂载（dsh-base bundle），会自动驱动
"同一 agent 会话的连续轮次"直到目标完成。本版把 AGINT 进化提案转成 dsh goal
（`goals.create(agent, { objective })`），让 goal-round-driver 接管后续改进轮次 ——
而不是 AGINT 在 host 平面自己 for 循环挑候选。

### 变更

- 新增 `lib/goal-bridge.js`：`proposalToGoal`（提案 → objective，body 截断 280 字符）+
  `createGoalBridge`（软依赖 `ctx.get('agint.goals')`；未挂载 / 无 create / 抛错 →
  `{ created:false, reason }`，不影响 runOnce 既有路径）。
- kill-switch：`AGINT_EVOLUTION_DRIVER_GOAL=on` 才启用（大小写不敏感 + 去空格），默认关。
  **2026-09-28 已在宿主 User 级环境置 on**（`[Environment]::SetEnvironmentVariable(..., 'User')`），
  宿主进程重启后生效。
- Service：`agint.evolutionDriver.goalBridge`（`{ enabled, create }`）。

### 边界

- 只创建、不接管：轮次驱动完全由宿主 goal-round-driver 承担，AGINT 不重复实现。
- 影子接入先验证链路再切换，避免无人值守 job 行为漂移。

### 验证

- `test/goal-bridge.test.mjs` 9/9；evolution-driver smoke 35/35。
- 未验证：宿主重启后 goal 创建链路的实际行为（需重启后观察）。


### 背景

v0.2.4 的实体门只服务本插件。但「LLM 产出的文本引用了不存在的实体」是**所有 LLM 写盘
路径**的共同风险（K117）——K115 幽灵接口已经证明：判据抄几份就会漂移，而漂移的闸门
等于假绿。老板 2026-09-27 拍板「做通用化」。

### 变更

- 新增 `lib/entity-gate.js`：`findFabricatedEntities` / `buildCodeIndex` + 容量常量
  **原样搬移**，`index.js` re-export 保持既有导入面（对既有消费方与测试零影响）。
- 服务新增只读扩展点 **`checkEntities(text, opts)`**（挂在既有 `agint.evolutionDriver` 上）：
  别的插件用软依赖 `ctx.get('agint.evolutionDriver').checkEntities(t)` 即可复用同一份判据
  与同一份代码索引，**不需要**跨插件 import、**不需要**各自配 repoRoot。
- 查询口径（防误用）：`{ checked, ok, fabricated, repoFiles, reason? }`。
  `checked:false` = **缺证据**（没 repoRoot / 门被关 / 门自己抛错），调用方应**放行**，
  不能当成"检出问题"。门自己出错时同样放行 + 告警留痕 —— 观测装置不允许变成新的单点故障。
- 索引缓存：`svcRepoFiles` / `svcCodeIndex` 一次构建、进程内复用（门的语义取"启动后快照"）。
- 测试 T33–T35（缺证据不许假通过 / 判据复用拦编造放真实 / 门自身出错放行），smoke 35/35。
  `fs` 可注入 ⇒ 测试 hermetic，不扫真仓库。

### 决策：不接发布门（2026-09-27 老板拍板）

`agint-skill-autocreate` 发布前调用 `checkEntities` 的**接线不做**。理由：那会改变发布门的
失败语义（终态 `REJECTED` 不可恢复 vs `hold` 可恢复），属产品决策；老板裁定维持现状。

⇒ `checkEntities` 是**已通电的只读扩展点**，当前**无生产调用方**（`grep -rn "checkEntities"
plugins/*/lib/` 只应命中本插件自身）。将来若要接，别改发布门终态语义，优先走 `hold`。

## v0.2.4 — 2026-09-27（实体存在性门：内容级编造在落盘前拦死）

### 背景

18:30 五轮验收四判据全中（闭环闭合），但引擎写入 SKILL.md 的新增段落引用了
不存在的插件 `agint-evolution-viz`。幻觉闸门只锚 verbatim oldText（编辑位置真实），
防不了 newText 的内容级编造。老板拍板：加「引用实体必须存在」硬校验。

### 变更

- 新增 `findFabricatedEntities(newText, { repoFiles, codeText })`：校验 newText 反引号
  token 中三类可机器验证的实体，其余放行（压误报）：
  1. **仓库路径**（含 `/` 且扩展名可识别）→ 必须在 repoFiles；
  2. **agint-\* 插件/技能名** → `plugins/<name>/`、`presets/agint/skills/<name>/`、
     `presets/<name>/` 目录必须真实存在（**结构化证据**）；
  3. **snake_case 表/存储名** → 必须出现在插件生产代码索引里。
- ⭐ 证据必须是结构化的：**文本「提及」不算数**——docs 规划文档 / eval mock / 代码
  注释都会提及从未存在的实体（K115 病毒式自举）。实测修正：`evolution_log` 与
  `metrics_summary` 其实真实存在（agint-evolution-memory / agint-metrics），
  全仓子串匹配会把它们连同真凶一起误伤/漏放；agint-\* 必须看目录，snake 类证据源 =
  `plugins/*/lib` 代码且**剥离注释行**（否则本插件自己的注释就构成「证据」）。
- `buildCodeIndex`：懒构建、单 runOnce 只建一次、容量护栏（单文件 256KB / 总 4MB）、
  失败返回 null → snake 类放行不误杀（留痕告警，K113）。
- construct 在幻觉闸门之后调用实体门；拦截形态 `{ ok:false, reason:'fabricated entities
  in newText: ... (entity gate)', fabricated:[...] }`，**不算 degraded**（LLM 通道正常）。
- kill-switch：`AGINT_EVOLUTION_DRIVER_ENTITY_GATE=off`（默认开，K51：出厂即开）。
- ⚠️ 解构默认值坑：`codeText: undefined` 会触发默认 `''`（=严格空索引），必须显式
  传 `null` 才是「索引不可用→跳过」语义。

### 测试

- smoke 新增 T30（结构化证据语义 + 提及≠证据反例 + null 语义）、T31（construct 集成拦截）、
  T32（真实实体放行 + null 跳过），32/32 绿。
- 真实数据离线验证：今天已落盘的那条编辑（排除目标文件模拟落盘前世界），门精确拦下
  `agint-evolution-viz`，其余实体零误报。

## v0.2.3 — 2026-09-27（mutator 首次真实落盘后两处调用约定修正）

## v0.2.3 — 2026-09-27（里程碑：mutator 首次真实落盘；两处调用约定修正）

### 18:18 三轮实测

- ⭐ **`agint_mutator.json` 首次落盘**：提案 `09f7342c`（plugin-preflight SKILL.md
  的真实原子编辑，oldText 为原文）。22 天闭环引擎第一次产出真实变异提案。
- `proposed: 1`；另 52542886 走完 construct+幻觉闸门后被 mutator zod 拒。
- 四判据进度：① mutator 落盘 ✓ ② proposed 事件（被 rejected 事件先行，修复后可达）
  ③ committed 事件+git 改动 ✗ ④ population 落盘 ✗。

### 变更（均为 driver 侧调用约定错误，K115 教训重演：调软依赖前必 grep 被依赖方签名）

- **promptId slug 化**（新 `slugifyPromptId`）：mutator 要求
  `^[a-z][a-z0-9-]{2,30}$`，repo 路径带斜杠/点必被拒 —— 取末段转 kebab，
  数字开头/空值加 `evo-` 前缀兜底。
- **validate 入参**：`{ proposalId }` → `{ proposal }`（mutator 读
  `input.proposal.id`）。
- smoke 新增 T28/T29 锁两个契约；T25 断言同步更新；29/29 绿。

## v0.2.2 — 2026-09-27（干净进程首轮 5/20 进到 LLM，全判 not applicable → 两处根因修正）

### 干净进程实测（18:10 触发，pid 7932）

- **管道端到端全通**：5/20 候选成功解析并真实调用 LLM
  （d85347bf 技能目标 + 52542886/531e2631/04d6199c/cdf41d63 **仓库路径目标**）
  —— v0.2.0 路径解析在真实链路有效；上轮 17:36 全败确证为热重载过渡态污染。
- 5/5 判 `not applicable`。归因两处：① 提案多为「拆分/重构」类多编辑诉求，
  旧规则 3 让 LLM 遇多编辑即拒 —— 设计错配（evolve 提案=特性级，construct=单原子编辑）；
  ② 片段截断 6000 字符 < metrics.js 实际 7334B，提示词却声称给全文。

### 变更

- **规则 3 改写**：提案需要多处编辑时，取「本文件的第一个连贯原子步骤」执行，
  剩余步骤写进 rationale；仅当提案空泛/需新建文件/属别的文件时才 applicable=false。
  单原子编辑 + verbatim 锚 + 幻觉闸门全部不变，边界不扩。
- **DEFAULT_SNIPPET 6000 → 20000**：消除「声称全文实为截断」导致的误判与
  幻觉闸门误伤风险。

## v0.2.1 — 2026-09-27（观测升级：failures 不再藏诊断尾巴）

### 背景

17:36 首轮验收：20 候选全失败，但 summary 的 failures 只留前 10 条
（pool 按 createdAt 倒序处理 ⇒ 被藏的恰是后处理的 10 条）。已知 3 条候选
（cdf41d63 / 04d6199c / 52542886）的提案正文含真实存在的仓库路径
（如 `plugins/agint-metrics/lib/metrics.js`），按同版代码离线复现**能命中**，
实跑却未见其 spawn 子代理 ⇒ 其真实失败原因被 cap 隐藏，无法取证。
另注：该轮跑在热重载过渡态的旧进程上（17:11 boot v0.1.x，17:31 才同步 v0.2.0），
结果本身可信度存疑；当前进程已干净重启加载 v0.2.x。

### 变更

- **failures 上限 10 → 30**（pool 上限 20，等价全量）：不再藏诊断尾巴。
- **no-target 失败串附诊断**（新 `resolutionDiag`）：`mentioned:N inRepo:H
  bodyLen:L` —— 提案文本里反引号路径数、真实命中仓库数、body 长度。
  下一轮无论结果如何都能一步定位「路径没提到 / 提到没命中 / body 缺失」。

## v0.2.0 — 2026-09-27（老板拍板「开放改仓库代码」）

### 变更

- **目标资产边界扩展**：技能（SKILL.md）→ 技能 + 仓库任意文件。定位三级：
  技能名命中（原 resolveTargetSkill）→ 提案里反引号路径命中仓库文件（新
  `resolveTargetAsset` + `extractRepoPaths`）→ 放弃。仓库清单靠运行时扫描
  （跳 .git/node_modules/dist 等，封顶 3000 文件）。此前 19/20 候选
  `no target skill resolved` 的主因即目标面太窄。
- **commit 默认开**（原默认关）：老板 2026-09-27 拍板最高档「开放改仓库代码」+
  K51「可回滚 > 可审批、kill-switch ≠ 默认关」。落点 = 仓库正本（部署位会被
  install.sh 镜像覆盖，写了白写）。
- **commit 落盘三保险**（新 `commitToRepo`）：denylist（cordis.patch.yml / .git /
  node_modules 绝不碰）+ oldText 必须在目标文件中**恰好出现一次** + preimage 备份
  到 `.agint-preimage/<路径扁平化>-<时间戳>.bak`。git 工作区天然可 diff/checkout
  回滚；每次 commit 发 `evolution.mutation.committed` 事件。
- **repoRoot 解析**：env `AGINT_EVOLUTION_DRIVER_REPO_ROOT` > patch config
  `repoRoot` > null（null ⇒ 只 propose 不落盘）。
- SYSTEM_PROMPT / schema 描述同步：删除"would require code changes → false"
  旧导向（正是挡住代码类提案的另一只手）。

### 测试

T20–T25 新增（路径提取 / 三级定位 / commit 默认开 / repoRoot 优先级 /
commitToRepo 三保险 / repo 目标全链路），T2/T8/T13 断言随默认值翻转更新。
共 27 用例全绿。

---

## 0.1.0 — 2026-09-27

闭环引擎第一次有驱动源。

### 新增

- 插件 `agint-evolution-driver`（Service `agint.evolutionDriver`），职责：把 `agint.evolve`
  的 `proposed` 提案编译成一次真实的变异候选，接进 mutator / population。
- 变异构造走 **subagent（真 LLM）**，结构化输出契约 `MUTATION_OUTPUT_SCHEMA`
  （subagents 方言：`required` 挂父对象数组，K70）。
- **幻觉闸门**：`oldText` 必须是目标文件原文的真实子串，否则丢弃本次、不进 propose。
- 链路：`propose → validate → ingest`，并发布 `evolution.mutation.proposed` /
  `evolution.mutation.rejected`。
- 开关：`AGINT_EVOLUTION_DRIVER=off`（出厂即开）；`AGINT_EVOLUTION_DRIVER_COMMIT=on`（**默认关**）。

### 设计取舍

- **不持存储域**：正本在 `agint_mutator` / `agint_population`，本插件只做驱动，避免第二份真相。
- **定位不到目标就换候选**，不硬凑：提案跟任何 preset skill 都无关时跳过，而不是拿一个不相干的文件凑数。
- **第一阶段不 commit**：改部署位会被 `install.sh` 镜像覆盖，仓库路径问题未解前不动手。

### 测试

- `test/smoke.mjs` T1–T14 全绿（含 kill-switch、幻觉闸门、validate 拒绝、seen 去重）。
