# CHANGELOG

## 未发布（2026-11-18 · 三笔待发版改动：D5 题池 / 防复读护栏 / LLM 语义判据）

> ⚠️ **未升版本号**：`manifest.json` 仍 0.2.1、`package.json` 仍 0.2.3（历史遗留不同步，本次不动）。
> 本段按老板指令「改变动和 wiki，部署」补齐变更记录，**不等于发版**——VERSION/wiki 版本表/tag/push 均未动。
> 三笔 commit：`9c71e43`（提案 2cac5f70，已 push）、`ba1ed9f` + `af5c0d7`（提案 10d2d87f，本地）。

### 一、integration D5 题池与域封顶出路（commit `9c71e43`，提案 2cac5f70）

- **改动**：integration / correctness 每档扩到 3 道题池，同档撞重先换 variant 再顺延档位；新增 `exec-code` 题型作 D5 封顶后的换题型出路；判池明确跳过写 `no_new_challenge` audit；域毕业降权（`graduate_deprioritize` 可一键回退）。
- **验收**：81/81 单测、smoke 10/10、四门禁 EXIT=0；18 道 challenger 落库含 3 道 exec-code。

### 二、防复读护栏（commit `ba1ed9f`，提案 10d2d87f 方案 1/2/4）

- **问题（生产实证）**：`clg_20261008/1015/1022` 三题 prompt 逐字相同却全 pass，integration 被灌到 D5 上限、`consecutivePass=6`；`clg_20261112` 两次 pass 的 steps 逐字完全相同。判定器只查步数 + 关键词，分不出解题与复读。
- **改动**：新增 `lib/replay.js` 纯函数——steps 指纹（方案 4）+ 同 domain/level/prompt 实例去重（方案 1 核心护栏）+ 关键词分布/承接线索信号（方案 2 只报不改判）。submit 判定 pass 后检测复读：attempt 打 replay 标记（result 仍 pass），但 difficulty 不计数、不发升档事件、不回写 self-model 成功信号。
- **存量兼容**：只对本次新提交判定，不回溯；生产数据离线回放验证零误伤（首 pass=novel、同题面=duplicate-prompt、原样复读=fingerprint）。
- **验收**：91/91、smoke 10/10、四门禁 EXIT=0。

### 三、LLM 语义判据（commit `af5c0d7`，提案 10d2d87f 方案 3）

- ⚠️ **架构违规声明（随记录保留）**：本笔**违反项目纲领 §9.5「评分链路永久零 LLM」**，由老板明确知情拍板（选项 2「完整实现并默认启用」），承担架构决策。
- **改动**：新增 `lib/replay-llm.js`，照抄经真实验证的宿主调用契约（agents.create + subagents.startActivation + agentPreset + agentOptions + structured + 双超时 + dispose），读 `agentDefaultModel.currentSelection()`。确定性护栏未命中时才调 LLM 补判「换说法复读」；判等价且置信度达阈值（默认 high）⇒ 升级 replay，不计能力成功。**失败一律降级、不抛、不阻塞 submit**（与 oracle「无降级」刻意不同，守判定可用性）。
- **开关**：`replay_llm`（默认 true）/ `replay_llm_timeout_ms`（30s）/ `replay_llm_min_confidence`（high），可一键关回零 LLM 口径。manifest `optionalInject` 声明 agents/subagents/agentDefaultModel；network 保持 `[]`（LLM 走 cordis 服务面，不占 HTTP 出站）。
- **配套**：`bin/check-llm-selection-parity.mjs` 白名单登记 curriculum（门禁新增 LLM 插件的硬要求）；兜底常量与宿主模型目录一致。
- **验收**：104/104、smoke 10/10；新测 13 例覆盖服务缺失/stopReason 降级/资源 dispose/集成升级/开关回退；四门禁 + LLM parity 全 PASS；tools.register() 4 工具全注册。

---

## 0.2.3（2026-11-17 · CANNOT 候选标记补对称清除路径 —— 假信号不再挂死）

**一句话**：降档分支只置位 `cannotCandidate=true`，全流程没有对称的清除路径 ——
域一旦被打上标记就永远挂着，即使随后连过 N 关。`curriculum_stats` 于是长期报
一个已经不成立的「CANNOT 候选」。

**证据**（生产存储 `agint_curriculum` 域 `difficulty_state.df_integration`）：
2026-11-17 传输缺陷导致 10 次连续 fail，域被打上 `cannotCandidate=true`；
补交 5 关后 `consecutiveFail=0`、`consecutivePass=5`，但 `cannotCandidate` 仍是 true。

**影响面**（grep 取证）：`cannotCandidate` 仅被
`plugins/agint-curriculum/lib/index.js:684`（stats 输出）与 `lib/difficulty.js`
自身引用；`agint-self-model` 未读取该字段（grep `cannotCandidate` 于
`plugins/agint-self-model/lib/*.js` 命中 0 行）。所以它不影响判定与能力图谱，
但**周复盘与 stats 读到的是假信号**。

**改动**：`lib/difficulty.js` 的 force-promote 分支按与置位条件对称的判据
（连续 pass ≥ forcePromoteStreak）清除标记，并记 `candidateCleared=true` 以便审计。

**验收**：`node --test plugins/agint-curriculum/test/*.test.mjs` → 71/71。

## 0.2.2（2026-11-17 · 修复 evidence 数组传输缺陷 —— 提交判定恒 fail）

**一句话**：`curriculum_submit` 的 evidence 里，数组型证据（`steps`）在参数层
被包装成 `{ item: [...] }`，判定器取不到真数组，`step-list` 断言恒判
`steps 数量 0 < minLength N`。**不是题目难，也不是答案错 —— 是证据在传输层被压扁了。**

**证据**：
1. 生产存储 `agint_curriculum` 域 `attempts` 表：2026-11-17 的多次提交，`evidence`
   字段形态恒为 `{"steps":{"item":[...]}}`（`steps_type=WRAPPED:['item']`）。
2. 对照组：顶层数组参数（`agint_search` 的 `sources:["memory","wiki"]`）原样到达
   ⇒ 退化只发生在**自由对象型参数内部**，不是宿主全局数组能力缺失。
3. 判定失败是恒定的、且与内容无关：同一份答案在 `verdict.js` 里本地判定为
   `pass`，经工具链路提交后为 `fail`。

**改动**：
1. `lib/tools.js`：`evidence` 显式声明 `properties.steps: array<string>`（原来只挂
   `additionalProperties: true` 的 free-form object），并在 `execute` 前经
   `unwrapArray` / `normalizeEvidence` 归一化（支持 `{item:[...]}` 与数字下标两种形态）。
2. `lib/verdict.js`：`assertStepList` 还原包装后再按**原判据**判定 —— 还原后仍不是
   字符串数组的（元素非字符串、数量不足、缺关键词）照常 fail，**不放宽通过条件**。
3. `test/verdict.test.mjs`：新增回归用例，断言「包装形态可还原」且「还原后判据不放松」。

**验收**：`node --test plugins/agint-curriculum/test/*.test.mjs` → 70/70；
`bin/plugin-check.sh --all` → exit 0；部署并重启后，5 个 integration 课程挑战
首次提交即全部 PASS，`attempts` 表记录 `steps_type=str[]`。

**⚠️ 这次失败留下的真实痕迹**（不掩盖）：10 次传输失败把 integration 域的难度档
打到 `consecutiveFail=10 / cannotCandidate=true`；补交 pass 后 `consecutiveFail` 归零、
`consecutivePass=5`，但 `cannotCandidate` 标记仍为 true（§4.6 的降档分支只置位、
没有对称的清除路径）。历史 `attempts` 行按设计留档。


## 0.2.1（2026-11-05 · 修订阅入参形状 —— `goal/*` 链路从未注册）

**一句话**：0.2.0 的两条 goal 订阅从未注册成功。入参用了事件 envelope 的
`{ topic, source }`，而总线 `validateSubscription` 要求 `{ subscriber, topics, mode }`。
`subscribe()` 抛错后被 `catch` 吞成一条 warn，运行态静默退回自推模式。

**证据**：
1. 真 schema 对照：同一入参在 `agint-event-bus/lib/schemas.js` 被拒。
2. 生产存储：`input.signal.host.goal-changed` / `goal-activation-changed` 无订阅投递记录。
3. 同总线对照：`input.signal.host.domain-changed` 投递正常 ⇒ 问题只在订阅入参。

**为什么测试没拦住**：假总线不校验入参，且断言了错误的 `sub.topic` 形状。
现在测试调用真实 `validateSubscription`。

**改动**：
1. `lib/index.js`：两条 topic 合并为一次 `{ subscriber: name, topics: [两条], mode: 'async' }` 订阅。
2. 保存退订函数并注册 `ctx.effect`。
3. `test/goal-alignment.test.mjs` 的假总线接真实 schema，按 `sub.topics` 路由。

**验收**：`node --test plugins/agint-curriculum/test/*.test.mjs` → 69/69。

## 0.2.0（2026-11-03 · W3：订阅 `goal/*`，课程与真实目标对齐有了输入端）

**一句话**：课程此前由 `boundary-probe` 从 self-model 的**能力缺口**自推，
与老板真正在追什么目标没有任何关系。宿主的 `goal/changed` / `goal/activation-changed`
是「课程该对齐谁」的唯一输入端，本版接上。

**做了什么**：订阅两条 goal 主题，把最后观测到的目标状态记成对齐提示；
新增只读服务键 `agint.curriculum.goalAlignment()`。

**⛔ 只记账、不改课程队列**：课程队列是 `agint_curriculum` 域里的持久事实，
按事件自动重排等于让「一次目标编辑」变成「一串无法回滚的课程增删」。
真正的重排入口仍是 `curriculum.probe(...)`，由人/agent 显式调用。
这与 `agint-curator` 的 W2 是同一条纪律：**事件让系统知道，动手要显式**。

**两条 goal 事件的作用域不同**（别当同一件事的两种写法）：
- `goal/changed` —— **agent 级**（`dsh-goal:877`，`emit("goal/changed", { change })`）；
- `goal/activation-changed` —— **session 级**（`dsh-goal:798`，带 `sessionId`）。
本用途下按同一口径合并是安全的：`revision` 单调递增，比 revision 就能判新旧，
不依赖事件类型。**迟到的旧 revision 直接丢弃**（否则乱序事件会把对齐状态拉回去），
但 `eventsSeen` 照常计数 —— 丢弃的是状态覆盖，不是观测。

**观测面口径**（同样不许合并）：
| 状态 | 含义 |
|---|---|
| `received:false` | 这条链路根本没通电，课程退回自推 |
| `received:true` 且 `goalId:''` | 通电了，但宿主没带 goal（如 goal 被清空） |

**三条纪律**（写在 lib/index.js 的 W3 段）：①软取总线，总线不在就纯降级；
②回调里**不 await 任何存储**；③只留最后一条，不追加日志 —— 目标可能被连改十次。

**产物**：`lib/index.js` +75 行；`test/goal-alignment.test.mjs` 新增 6 条用例（6/6）；
`manifest.json` 的 `spec.cordis.events` 补两条宿主主题。

**阴性对照**：删掉 revision 丢弃逻辑 ⇒「迟到的旧 revision 被丢弃」用例变红（实测 6→5 通过 1 失败）。

**验收**：`node --test plugins/agint-curriculum/test/goal-alignment.test.mjs` → 6/6。

## 0.1.6（2026-10-21 · 新增只读出口 listAttempts，供 self-model pull 成绩）

### 变更

- **新增 Service 方法 `listAttempts({domain?, result?, limit?})`**，挂在
  `agint.curriculum` 上（`lib/index.js`，在 `list` 之后）。
- **为什么需要它**：`capability_map` 的能力判定要知道「近期练过什么、结果如何」。
  此前 self-model 只能被动等本插件调 `selfModel.update({evidence})` 推过来，
  而 evidence **不落库** ⇒ 任何其他触发器（如 `dream.completed`）一跑，就把该域
  重算成 `UNCERTAIN`，能力读数随「哪个触发器最后跑」来回振荡。
  有了这个出口，self-model 每次聚合自己来读，稳定且与触发者无关。
- ⛔ **只读**：不写 attempts、不改 difficulty、不触发判定。判定权仍在本插件
  （`verdict.js` 的 §4.9「只提供证据，由 self-model 决定是否更新 capability」未变）。
- ⚠️ **为什么不是复用 `list()`**：`list()` 读的是 **challenges** 表
  （`lib/index.js:513-521`），那上面没有 `result` 字段；拿它当成绩会全部落成
  fail（`result === undefined`）。`listAttempts` 才是 attempts 明细。
  回归钉：`agint-self-model/test/curriculum-pull.test.mjs` 的
  「protect：不提供 list 时也要能工作」用例会在实现误用 `list()` 时变红。

### 测试

- curriculum 全量 74/74 过（本插件内无新增用例，新接口的回归钉在对侧
  `agint-self-model/test/curriculum-pull.test.mjs` 5 用例）。

## 0.1.5（2026-10-18 · 扩题库：integration / correctness 每档 3 道）

### 变更

- **题目池从「每域每档 1 道」扩到「integration / correctness 每档 3 道」**
  （`lib/challenge-gen.js`）。0.1.4 的去重撞重后只能顺延难度档，而池子每档
  1 道、每域共 5 道 ⇒ **5 周即耗尽**，之后 `generate` 只能如实 skipped。
  扩到每档 3 道后，撞重优先在同档换 variant，15 周才顺延一次档位。
- **`generate()` 的撞重处置顺序改为两级**（`lib/index.js`）：
  1. 先在本档内换 variant（同难度换题，**不动档位**）
  2. 本档题池用完，才沿 `DIFFICULTY_LEVELS` 向上顺延
  3. 全档位 × 全 variant 都出过 → 如实 skipped（`reason` 里报总池量）
- `generateChallenge(domain, level, { variant })` 新增 `variant` 入参（取模）。
  **不传 variant 时取 variant 0，输出与 0.1.4 逐字一致**（向后兼容，有测试锁定）。
- `challenge-gen.js` 新增导出 `bankSize(domain, level)` / `totalBankSize(domain)`，
  供耗尽文案与审计使用。
- `audit_log.details` 增补 `bankSizeAtLevel` / `totalBankSize` 两个字段，便于事后
  判断「这次顺延是因为池子多大」。

### 答案核对（不用心算）

所有 `correctness` 的 `expected` 都用脚本真算过一遍，同档内答案互不相同：

| 档 | 三道题答案 |
| --- | --- |
| D1 | 43（17+26）、56（8×7）、63（100−37） |
| D2 | 2、7、5（升序后取中间元素） |
| D3 | 3、4、1（`len(set(...))`） |
| D4 | 5、4、2（字符串字符计数） |
| D5 | 13、21、34（爬台阶，斐波那契） |

`integration` 每档 3 道题面互不相同，关键词各成一组（D1: 请求/错误 · 配置/默认 ·
参数/输出；D2: 订阅/发布/取消 · 鉴权/中间件/错误 · 连接/启动/关闭；以此类推），
`step-list` 断言器逐条校验。

### 测试

- `test/pipeline.test.mjs` 56 → 73 用例。新增：
  - 同档撞重先换 variant、档位不变
  - integration 15 道全部出过后才 skipped（并断言 15 条题面互不相同）
  - 每域每档 ≥3 道、池总量 ≥15 道
  - correctness 同档三答案互异
  - integration 同档三题面互异
  - `variant` 缺省时与 0.1.4 输出逐字一致
- 全量 `node --test "test/*.test.mjs" test/smoke.mjs` → **73/73 通过**。

### 生效条件（未闭环项，如实标注）

- ⚠️ 属 boot 期插件，需**部署位同步 + 宿主重启**后才生效。
- ⚠️ **部署位共 4 份**，其中 `profiles/desktop/node_modules/@agint/host/plugins/`
  是宿主实际加载的真实目录（`profiles/web` 同名路径只是指向 `.agint-bundle`
  的 junction）。0.1.4 首次上线时漏了 desktop-host 那一份，重启后仍跑旧代码
  且不报错；判定方法见下条。
- 验收方法（最硬的单一证据）：重启后读 `curriculum_stats` 的 `config` 块，
  **新增键出现即证明新代码已加载**；文件哈希只证明磁盘上有新代码，不证明已加载。

## 0.1.4（2026-10-18 · 生成期去重：不再重复产出同一道题）

### 修复

- **`generate()` 加生成期去重**（`lib/index.js`）。根因：`challenge-gen.js` 的
  `generateChallenge(domain, level)` 是确定性纯函数，入参只有 domain + level，
  题面是常量表；`generate()` 原实现只做 `datedId('clg')` + `put`，没有查过
  `challenges` 表里是否已有同题面，同域 24h 冷却只挡「一天内连生」。
  生产实测：2026-10-08 批 `clg_20261008_1706c6` 与 2026-10-15 批
  `clg_20261015_a15099` 的 prompt / passCriteria / verifySpec 逐字相同；
  `clg_20261008_6799ad` 与 `clg_20261015_7ce27e` 同（`expected: "43"`）。
- **撞重时顺延难度档，而不是静默重复或直接空转**：按 `DIFFICULTY_LEVELS`
  向上找该域尚未出过的题面。顺延只改「本次生成的题面」，**不写
  `difficulty_state.level`** —— 难度档只能由 `submit` 的判定证据推动
  （difficulty.js 的 40%–70% 护栏 + 连续序列）。让去重顺手改档等于用行为证据
  伪造能力结论。顺延事实写进 `audit_log.reason`，可审计。
- **D1–D5 题面全部出过 → 如实 skipped**（题目池耗尽），原因文案说明
  `force=true` 可绕过、或扩题库。不空造挑战、不改 `lastGeneratedAt`
  （没生成就不能假装生成过，否则白白烧掉 24h 冷却）。
- 新增配置 `dedup_window_days`（默认 30，`0` 关闭去重，进 `RUNTIME_CONFIG_KEYS`）。
  窗口内同 `domain + level + prompt` 视为重复；过期允许复出（复验）。
- `force=true` 同时绕过去重（此前只绕冷却），语义对齐。
- 删掉 `coolingDomains` 的死 import（`lib/index.js:40` 引入但无调用点；
  实际冷却是 inline 版本）。

### 顺带修正

- `generate()` 的 `createdAt` 与 `lastGeneratedAt` 改为跟随可注入的 `nowMs`，
  此前用 `nowIso()` 直读系统时钟 —— 导致 `nowMs` 注入只对冷却窗口生效、
  对去重窗口无效（同一函数内两个时钟）。生产路径 `nowMs = Date.now()`，行为不变。

### 测试

- `test/pipeline.test.mjs` 新增 5 个去重用例：顺延且不改档、题面耗尽 skipped、
  `dedup_window_days=0` 回退、窗口过期复验、`force` 绕过。
- 全量 `node --test "test/*.test.mjs" test/smoke.mjs` → **68/68 通过**
  （原 63 + 新增 5）。

### 生效条件（未闭环项，如实标注）

- ⚠️ 属 boot 期插件，需**部署位同步 + 宿主重启**后才生效。
- ⚠️ 去重按 `challenges` 表里窗口内的记录判断。当前生产的 4 条历史挑战
  （2 条重复题面各 2 份）仍在表里，所以重启后下一次 `curriculum-weekly`
  会直接顺延到 D2/D3 题面，而不是重出 D1。这是预期行为。

## 0.1.3（2026-10-06 · 零挑战修法①：并入 capability_map 真实域 integration/correctness）

### 修复

- **模板域从 4 扩到 6**（`lib/schema.js` TEMPLATE_DOMAINS + `lib/challenge-gen.js`）。
  根因（待做清单论证 §3.2）：self-model capability_map 的域全部来自 evolution
  failure_pattern category，本机实测只有 `integration` / `correctness`（还有 1 个 `unknown`）；
  而模板域写死 `codegen/reasoning/planning/tool-use` 四域 ⇒ **两集合零交集** ⇒
  probe 命中 CANNOT 后全落 `unverifiable`，`domains` 恒空 ⇒ `generate()` 从未被调用 ⇒
  全历史 `challenge-created` 0 条。0.1.2 的 CANNOT 修复只让两域从「不可见」变成
  「unverifiable」，供给没恢复。本批把两真实域并入模板域，直击断点。
- 复用既有断言器，不新建判定类型：`integration` → `step-list`（集成步骤拆解，
  必需环节关键词）；`correctness` → `conclusion-match`（答案唯一才可自动判定，守 C1）。
- `boundary-probe.js` unverifiable 文案里的「4 个模板域」改成动态计数，防再漂移。
- 版本位拉齐：此前 `package.json` 报 0.1.1、`manifest.json` 报 0.1.2（F2 同型病，
  判运行态会误判），本批统一为 0.1.3。

### 测试

- `test/challenge-gen.test.mjs`「6 个域模板全覆盖」；`test/smoke.mjs` 枚举断言更新为 6 域。
- 全量 `node --test "test/*.test.mjs" test/smoke.mjs` → 63/63 通过。

### 生效条件（未闭环项，如实标注）

- ⚠️ 属 boot 期插件，需**部署位同步 + 宿主重启**后生效。
- ⚠️ 重启后下一期 `curriculum-weekly`（周四 09:30）才会首次产挑战；真实供给恢复的运行态证据要等那一次。
- 前置：capability_map 那两行仍是 CANNOT（lastVerifiedAt 若不满足 30 天复验条件则不触发）——
  供给恢复幅度以实际 probe 读数为准，不打包票。

## 0.1.2（2026-09-29 · 激活上游：CANNOT 明确能力缺口纳入待练）

### 修复

- **boundary-probe 筛选规则补 CANNOT**（`lib/boundary-probe.js`）。此前筛选条件只认
  UNCERTAIN / miscalibrated / CAN 超期，`CANNOT` 完全不在条件里——self-model 能力画像
  integration/correctness 都是 CANNOT，probe 却永远返回空待练域（「curriculum 零挑战」根因）。
  现 CANNOT 以 `gapWeight=3` 纳入（高于 UNCERTAIN=2），reason 标注 `capability CANNOT（明确能力缺口）`。
  模板域外 CANNOT 仍走 C1/Q5 诚实留白进 `unverifiable`（设计不变）。

### 验证

- boundary-probe 测试 +3 项 CANNOT 用例（必练 / 优先级最高 / 模板域外留白）；全插件测试 53/53 PASS。

挂载冒烟（mock ctx + host 真代码）抓出两个 blocker，均在 defineTool / 服务注册
路径上，不修则挂载即失败或核心功能残废。

### 修复

- **tools.js：`curriculum_submit` 的 `evidence` 参数缺 `additionalProperties: true`**。
  dsh-tools 的 schema 编译器要求 object 参数显式声明，否则 `defineTool` 在
  **挂载期**抛 `JsonSchemaError`（UNSUPPORTED_SCHEMA）——preset 加载即崩，
  不是运行期错误。全仓其它插件只在 `output.schema` 用 object，本插件是第一个
  在 `parameters` 用 object 的，踩了这个坑。
- **index.js：`getSelfModel()` 取 `agint.selfModel` 父键恒为 undefined**。
  agint-self-model 实际只 provide 全名子键（`agint.selfModel.snapshot` /
  `.update` 等），cordis service store 是扁平的（reflect._getImpl 按确切键名查），
  原实现导致 `probe()` 永远走软降级、一个待练域都找不出来。现对齐全仓惯例：
  优先父键（未来兼容），否则按子键组装 `{ snapshot, update }`。

### 验证

- 仓库测试 50/50 PASS；挂载冒烟（`_smoke_curriculum.mjs`）全通过：
  probe 识别 UNCERTAIN 域 → generate → next（sessionId `curriculum-` 前缀）→
  submit 自动判定 pass → stats，3 个事件发布，4 工具注册。

## 0.1.0（2026-09-08 · Sprint 14 Part B · 仓库实现，不挂载 prod）

P7 自主课程生成器首个可用版本，按 Sprint14-设计稿 §4/§5 落地。

### 新增

- **边界探测**（`probe`）：消费 `agint-self-model` v0.7.1 `snapshot()` 能力画像；
  筛选 UNCERTAIN / calibration miscalibrated / CAN 超期未复验（默认 30 天）三类域，
  按「缺口权重 × 久未验证」排序；无模板域诚实留白（unverifiable，C1/Q5）。
- **挑战生成**（`generate` / `nextChallenge`）：4 域确定性模板（codegen /
  reasoning / planning / tool-use）× D1–D5 五档；挑战必带可自动判定 `verifySpec`
  （C1）；同域 24h 冷却 + 批量上限 5 防爆炸；出队只置 in_progress，**不自动执行**
  （§4.5）。
- **外部化判定**（`submit`）：按 verifySpec 断言（exit-code-output /
  conclusion-match / step-list / tool-match）判 pass/fail；C2 自评剥离进 notes；
  C3 无 evidence 记 fail；防御性 fail（宁 fail 不 pass）。
- **难度调节**（`difficulty`）：28 天滚动窗口 + 样本 <5 不调档（cold-start）；
  连续 pass/fail ≥3 强制升降档（防刷分/防挫败，行为信号优先于统计）；
  完成率 40%–70% 护栏；连续 fail ≥3 标 cannotCandidate 供 self-model 复验。
- **回写与事件**：判定结果经 `self-model.update()` 回写（trigger
  task-completed / task-failed，只提供证据，§4.9，不改 capability 表）；
  软依赖 event-bus 发布 4 类事件（boundary-probed / challenge-created /
  challenge-verdicted / difficulty-adjusted）。
- **D1 隔离**：挑战执行 `sessionId` 带 `curriculum-` 前缀；D4 黑名单副本三处
  （curator / skill-autocreate / curriculum）一致，`DATA_SOURCE_BLACKLIST_VERSION`
  = 2026-09-14.v1。
- **运维**：pause / resume / config 运行时开关；audit_log 唯一滚动清理；
  存储超限 warn 不 prune；不订阅任何 tools/pre-execute 类 waterfall 事件。

### 测试

- 60 个断言用例全绿：smoke（契约/枚举/LIMITS/storage spec/pack 元数据/
  generate 确定性/verdict C2C3/boundary-probe）、boundary-probe、challenge-gen、
  verdict、difficulty、pipeline（端到端：probe→generate→next→submit→
  难度演进→self-model 回写→事件→冷却→unverifiable→D1 隔离）。
- D4 三处一致性由 agint-curator 的 `const-consistency.test.mjs` 自动扫描覆盖。

### 不挂载 prod（Sprint14 拍板 Q1 / §0.3）

- prod 观察窗（变异成功率 ≥15% + 归因覆盖率 ≥80%，4 周）最早 10 月底满足；
  本版本只仓库实现 + 测试，挂载待 2026-09-25 影子挂载拍板会。
