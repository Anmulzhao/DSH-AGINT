# CHANGELOG

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
