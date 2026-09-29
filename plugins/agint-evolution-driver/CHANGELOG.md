# CHANGELOG — agint-evolution-driver

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
