# AGINT 能力边界契约

> 仓库级事实。两台机器一致（不含机器私有值）。
> 定位与哲学见 `README.md` 与本仓 `AGENTS.md`；本文件只回答一个问题：
> **一件事该由 dsh 做，还是由 AGINT 做？**

---

## 0. 结论

1. AGINT 是 **dsh 之上的规范 + 组件**，不是 dsh 的 fork，也不替代 dsh。
2. AGINT 的唯一职责是 **在美的理念下持续进化**。判断标准只有一条：
   **这件事是否让「进化闭环」更真**（多一条真实信号 / 少一个假读数 / 少一处会瞎的脆弱实现）。
3. 归属分三层：**宿主层**（dsh 职责）、**进化层**（AGINT 唯一职责）、**载体层**（AGINT 允许的呈现与运维外壳）。
4. 载体层可以存在，但**不得侵占进化闭环的数据通路**，也**不得重复实现宿主层能力**。
5. 违反本契约的判据是三条硬约束：
   - 宿主层已有等价服务/工具 ⇒ AGINT 不得再实现同名同义能力。
   - 进化层判据不满足 ⇒ 不新增。
   - 机器私有值（绝对路径、host 版本、cron tick）不得进入库文件。

---

## 1. 三层归属判据

| 层 | 判据 | 典型内容 | 违规形态 |
|---|---|---|---|
| **L-宿主** | dsh 已提供等价服务/工具，或能力本质是「运行时机制」 | 进程与生命周期、会话存储与格式、zstd/序列化、token 计量、调度执行器、沙箱与审批、权限、工具注册与 schema、存储域管理、UI slot 框架、LLM provider、子代理原语、上下文压缩执行器 | AGINT 自建同义实现；宿主一改就瞎 |
| **L-进化** | 直接服务「让系统持续变好且可证伪」 | 记忆 / 反思 / 约束 / 度量 / 评估 五件套；D-QAF 流水线；进化闭环（诊断→变异→种群→冻结基准→回滚）；进化记忆层；能力自我认知；技能生命周期策展 | 该做而没做（度量缺口） |
| **L-载体** | 呈现、交互、运维外壳 | 家族面板、桌宠、语音热键、重启控制面 | 侵占进化数据通路；与宿主层重复 |

**争议时的默认裁决**：先问「宿主改一次会不会让它瞎」——会 ⇒ 归 L-宿主，不自建。
再问「不做这件事，进化闭环会不会更假」——会 ⇒ 归 L-进化，必做。

---

## 2. 插件归属表（41 个顶层插件 + 5 个 quality 子模块）

图例：**E**=进化层 · **C**=载体层 · **H-越界**=自建了宿主层能力，应改为消费上游

| 插件 | v | 层 | 依据（manifest description 摘要） |
|---|---|---|---|
| agint-memory | 0.2.0 | E | 长时记忆 + L1-L4 遗忘模型 |
| agint-memory-provider | 0.3.0 | E | 可插拔记忆 Provider 抽象与降级 |
| agint-evolution-memory | 0.6.15 | E | 进化记忆层（物理隔离存储域） |
| agint-dream | 0.5.0 | E | 夜间记忆整合（反思） |
| agint-wiki | 0.2.0 | E | 知识库 |
| agint-rules | 0.2.1 | E | 工具流水线规则门禁（约束） |
| agint-metrics | 1.1.2 | E | 客观指标采集（度量） |
| agint-evolve | 0.1.0 | E | 周复盘 + 提案跟踪 |
| agint-quality | 0.1.0 | E | D-QAF 评估框架聚合包（meta） |
| agint-quality-contract | — | E | D-QAF FROZEN 契约（Seam） |
| agint-quality-eval | 0.2.0 | E | D-QAF 评估引擎 |
| agint-quality-policy | — | E | 策略与门禁决策 |
| agint-quality-report | 0.4.0 | E | Phase 4 报告 |
| agint-quality-sandbox | 0.7.2 | E | Phase 2 动态沙箱 |
| agint-quality-sdk | 0.5.0 | E | Prompt Manifest / 模板引擎 |
| agint-quality-static | 0.8.1 | E | 插件代码级静态检查 |
| agint-diagnosis | 0.6.0 | E | 6 类根因归因 |
| agint-mutator | 0.6.7 | E | 3 类变异构造 |
| agint-population | 0.6.4 | E | 种群生命周期 + 适应度 |
| agint-evolution-driver | 0.3.1 | E | 闭环驱动（提案→变异→种群） |
| agint-mount | 0.7.2 | E | 变更编排三段式事务 |
| agint-abtest | 0.6.4 | E | Prompt A/B 统计判定 |
| agint-curriculum | 0.1.6 | E | 自主课程生成 |
| agint-self-model | 0.7.9 | E | 能力自我认知（CAN/CANNOT/UNCERTAIN） |
| agint-trajectory | 0.1.1 | E | 进化轨迹（训练数据层） |
| agint-skill-autocreate | 0.6.2 | E | 技能自动创建全链路 |
| agint-curator | 0.2.1 | E | 技能生命周期策展 |
| agint-skill-graph | 0.1.1 | E | 技能关系图谱 |
| agint-aesthetic-oracle | 0.5.0 | E | 「美」的度量与广播 |
| agint-event-bus | 0.7.1 | E | 进化事件基础设施 |
| agint-ov-strategy | 0.1.0 | E | 经验沉淀与策略召回 |
| agint-input-gateway | 0.1.5 | E | 多源信号进料 |
| agint-search-tools | 0.1.0 | E | 记忆/知识跨域检索 |
| agint-tool-stats | 0.1.0 | E | 工具统计（**为评估供料**） |
| agint-verify-tools | 0.1.0 | E | 验证入口全局化 |
| agint-compress-guard | 0.1.0 | E | 压缩前洞察提取 + 恢复通道（保护进化信号） |
| **agint-session-extract** | 0.1.0 | **H-越界** | 自建 zstd 解压 + jsonl 解析 + 会话文件发现 ⇒ 应消费 dsh `sessionQuery` |
| **agint-session-source** | — | **H-越界** | 会话文件发现唯一入口（候选名表 + 后缀兜底）⇒ 应消费 dsh `sessionQuery` |
| **agint-cron** | 0.2.16 | **E（调度原语偏 H）** | 自写 5 字段 cron 解析器 ⇒ 表达式解析属宿主层，应复用 dsh 调度原语 |
| agint-family-panel | 0.2.9 | C | 家族面板（呈现） |
| agint-mascot | 0.1.0 | C | 桌宠状态源（呈现） |
| agint-voice-hotkey | 0.2.5 | **C（与宿主重复）** | 自建热键/录音/SSE ⇒ dsh 已有 `dsh-experimental-client-ui-voice-input` 与 `dsh-voice-mode` |
| agint-restart | 0.9.2 | C | 重启闭环与控制面（宿主运维外壳） |

**未挂载的顶层插件**（代码在仓、patch 未引用）：`agint-mascot`、`agint-voice-hotkey`、`agint-search-tools`、`agint-session-extract`、`agint-session-source`、`agint-quality-report`。
其中 `agint-session-extract` / `agint-session-source` 是**被别的插件以相对路径 import 的库**（不是独立插件），不挂载是正确的。
`agint-quality-report` 在 patch 中被刻意注释掉（VERSION v0.12.0 记为「故意不挂载」）。
`agint-mascot` / `agint-voice-hotkey` / `agint-search-tools` 未挂载且无 import 引用 ⇒ **状态待裁决**（见 §5）。

---

## 3. dsh 能力面（0.2.1-rc.2 实测基线）

| 事实 | 证据 |
|---|---|
| 官方包 306 个 | `$DSH_HOME/.agint-deps/dsh-runtime/node_modules/@deepseek-ai/` 目录计数 |
| 运行期挂载 263 条 | `plugin_manager list_plugins` total=263 |
| 桌面壳内核不在那 306 包里 | 桌面版 CLI 入口指向 `<dsh-install>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`；该包既不在 CLI 包树，也不在 `app.asar.unpacked`（解包只含原生模块） |
| AGINT 侧挂载 40 条 | 263 条中 `file:///…@agint/host/plugins/…` 36 条 + 4 条 preset 声明行 |

⇒ **dsh 的能力面有两处**：CLI 包树（306 包）与 Electron `app.asar`（桌面壳 + 内核，~174 MB）。
`bin/check-dsh-compat.mjs` 只探 CLI 包树 ⇒ 桌面壳包会被误报 dangling。

### 0.2.1 提供、AGINT 尚未消费的能力（候选清单）

| dsh 能力 | 入口 | AGINT 现状 |
|---|---|---|
| token 计量 | `ctx.tokenMeter.measure(session)` / `estimateMessage(msg)`（`dsh-token-meter`） | **未接**。全仓无 token 计量（见 §4-F3） |
| 会话查询 | `ctx.sessionQuery.listSessions/readSession/observeSession/searchSessions/searchEvents`（`dsh-session-query` + `dsh-session-query-sqlite`） | **半接**（见 §4-F2） |
| 协作队伍 | `dsh-experimental-agent-team` + `tool-agent-team` + `client-ui-agent-team` | 未接（AGINT 另有 `docs/agent-collaboration.md` 规约） |
| 工作树隔离 | `dsh-experimental-worktree` + `tool-worktree` | 未接（10-19 已论证：AGINT 无裸 worktree 可替换） |
| 语音输入 | `dsh-experimental-speech-to-text` + `client-ui-voice-input`；第三方 `dsh-voice-mode` | 未接（`agint-voice-hotkey` 自建了一套） |
| 上下文压缩 | `dsh-compaction-basic` / `compaction-tool-result-pruner` / `compaction-image-offload` | `agint-compress-guard` 在其上做保护层（正确关系） |

---

## 4. 边界修正发现（逐条带取证）

### F1 · 兼容门禁只探一半 dsh 能力面 ⇒ 假警报

- 现象：`check-dsh-compat` 报 `dangling-package: @deepseek-ai/dsh-desktop-host`。
- 取证：该包**存在于**桌面版（`dsh.cmd` 入口路径），但不在 CLI 包树，也不在 `app.asar.unpacked`。
- 性质：**门禁探针口径问题**，不是上游改名。假警报会掩盖真漂移。
- 归属：仓库 `bin/`。修法：探测路径补桌面壳位，或把该引用降级为「测试期引用」豁免。

### F2 · 「接上游 sessionQuery」实际未生效 ⇒ AGINT 仍在自读盘

- 现象：`agint-session-source` 的上游分支产出的记录 `path` 恒为 `null`，
  而下游 `self-observation` 的出口 mapper 读 `r.path` 并用 `zstd -dc <path>` 读文件。
- 取证：`plugins/agint-session-source/lib/index.mjs:139-140`（"它未必给磁盘路径"）、
  `plugins/agint-input-gateway/lib/channels/self-observation.js:392`（`path: r.path ?? ''`）、
  同文件 `:411`（`execFileSync(bin, ['-dc', file.path])`）。
- 上游侧：dsh `sessionQuery.listSessions()` 返回的是逻辑会话元数据（`live`/`persisted` 标记），
  `readSession(id)` 返回重放校验过的事件流 —— **两者都不提供磁盘路径**。
- 结论：上游分支**给不出下游需要的东西** ⇒ 这条「接上游」路径实际空转，
  生产仍走本地扫盘 + 自解 zstd。2026-10-19 那次接入只完成了「把 4 处手搓收敛成 1 处」，
  **没完成「用上游替代自建」**（后者才是 J1 的收益）。
- 正确形态：**列举走 `listSessions()`，内容走 `readSession(id)`，本地 zstd 读盘降级为回落层**。
  保留在 AGINT 的只有「从事件里抽进化语义（工具调用序列 / 模型范围）」这一层。

### F3 · AGINT 全仓无 token 计量 ⇒ D-QAF 有效进化增量公式的 token 项恒缺

- 现象：全仓 grep `tokenmeter|tokencost|tokenusage|totalTokens|contextPressure` 命中 13 行，
  **全部**是「tool-stats 无 token 计量 ⇒ 恒 null」的占位注释；
  `agint-tool-stats` 目录内 grep `token|cost|usage` 命中 **0 行**。
- 影响面：
  - `agint-quality-eval` Phase 3 的「有效进化增量 = Δ(任务完成率) / Δ(Token消耗 + 步数 + 时间)」
    —— token 项恒缺，该比值的分母不成立。
  - `agint-curator` / `agint-skill-autocreate` 的 `avgTokenCost` 恒 null ⇒ 技能经济性不可度量。
- 上游已有：`ctx.tokenMeter`（replay-aware、确定性、不调模型；`dsh-token-meter` v0.2.1-rc.2）。
- 归属：度量缺口（进化层），上游已给测量原语（宿主层）⇒ **接上游，不自建**。

### F4 · 机器私有路径写进库文件

- 现象：`plugins/agint-input-gateway/lib/channels/self-observation.js:308-310`
  硬编码 `D:/Tools/zstd/zstd.exe` 等本机路径作为 zstd 解析器回落候选。
- 冲突：本仓 `AGENTS.md` 红线「机器私有事实不进入库文件」；本仓 `AGENTS.md` 已规定本机事实进 `AGENTS.local.md`。
- 修法：改为只读环境变量（已有 `ZSTD_BIN` 优先项），库内不写本机盘符。

### F5 · 使命/哲学没有本机可读的单一事实源

- 现象：本仓 `AGENTS.md` 指向 `wiki/设计与哲学.md`；实测本仓 `wiki/` 目录**递归无文件**。
  `README.md` 指向 GitHub Wiki。
- 影响：「不忘初心」缺少一个可离线读取的锚点；每次会话靠人肉记忆重建定位。
- 修法：本文件（`docs/capability-boundary.md`）即该锚点的机器可读部分；
  哲学全文另立一份入库文档，并修正 `AGENTS.md` 的指向。

### F6 · AGINT 取了宿主没有的服务键

- 现象：`plugins/agint-mount/lib/index.js:44` 用 `ctx.get('dshHome')` 取宿主 home。
- 取证：dsh 0.2.1-rc.2 的服务清单共 98 键（权威来源 `dsh-tool-cordis/lib/types/api-catalog.js`
  的 `SERVICE_API`，并用运行中宿主 `cordis_inspect_query{platform:host, provider:Service}` 实跑对账），
  **其中没有 `dshHome`**。
- 实际行为：因为有 `|| process.env.DSH_HOME` 兜底，**不报错**、功能正常 —— 但取法是错的：
  宿主若改了 home 解析方式，AGINT 仍按旧假设走。
- 修法：统一走 `process.env.DSH_HOME`（AGINT 其它插件已是此做法），去掉 `ctx.get('dshHome')` 这个
  不存在的键。

### F7 · 宿主 `ctx.schedule` 的投递语义 ≠ 智进 cron 的无人值守语义

- 现象：老板 2026-10-21 拍板「D5 复用 dsh ctx.schedule」。
- 取证（上游 `dsh-schedule` README + `lib/index.js`）：
  - `ScheduleService.create(sessionId, request, signal)` —— **必须绑定一个 sessionId**；
    投递语义是「往**原会话**注入 follow-up 消息」。
  - 投递要等 Session 承认 `session/flush` 才提交；`catalog/list/history` 全部按 sessionId 过滤。
  - 纯函数侧另有：`canonicalizeCronExpression`（表达式归一化 + 方言校验）、
    `createCronScheduleRecord`（内部算 `scheduledAt` = 严格晚于 now 的下一次）、
    `resolveCronOccurrence`（给 `occurrenceAt` = ≤ 决策时刻的最近一次，与 `nextScheduledAt`）。
- 冲突：智进 cron 的 27 个 job 是 **host 平面无人值守的 action 直调**，没有可绑定的 Session，
  也不该变成 agent 消息。强行 `create()` 是**行为变更**（无人值守 job 变会话消息），不是复用。
- 落地（D5 实际做法）：**规则与时刻计算交给上游，执行器留在智进**。
  - 上游负责：表达式方言校验 + 下一次/上一次时刻计算（Temporal 日历 + IANA 时区 + DST 正确；
    智进自研版是分钟粒度暴力扫描，上限 1 年 ⇒ 最坏 52 万次 Date 构造）。
  - 智进保留：`isDue()` 的补跑/幂等策略（进化层语义）、job 表、lastRunAt 记账、tick 执行器。
  - 上游缺席 ⇒ 回落智进自研实现（软依赖，行为与迁移前一致）。
- 判据：同一表达式、同一基准时刻，上游引擎与自研实现必须给出**同一时刻**（`test/host-cron-engine.test.mjs`，
  6 表达式 × 4 基准 = 24 组对照）。不靠"抄一遍逻辑"自证。

### F8 · `ctx.get()` 的**取用时机**决定接线成败（apply 时取快照 = 假接）

- 现象（2026-10-21 重启后运行态取证）：D1 与 D2 **代码态都做完了，运行态一个都没接上**。
  - D2 取证：`agint_tool_stats.jsonl` 全量 23035 行里含 `"deltaTokens"` 字段的 **20 条**，
    其中 `"deltaTokens": 数字` 命中 **0 条**（20/20 为 null）；`"tokenSource":"tokenMeter"` **1 条**、
    `"tokenSource":null` **19 条**。
  - D1 取证：session-source 的上游句柄恒 null ⇒ 4 处调用点走本地回落。
- 根因：`ctx.get(key)` 在**插件 apply 时**求值就存成常量，而**插件 apply 与上游服务注册没有顺序保证**
  —— 取早了就恒为 null。这是"字段落了、值恒空"型假接：代码看起来接了，数据说没接。
- 反证（上游服务确实在）：`cordis_inspect_query{platform:host, provider:Service}`
  查 `tokenMeter` 与 `sessionQuery` 都返回完整契约 ⇒ 服务在，只是取早了。
- 修法：**每次使用时重新取**（懒取），不声明 `inject` 硬依赖（保持软依赖）。
  - `plugins/agint-tool-stats/lib/index.js` —— 新增导出 `lazyService(ctx, key)`，apply 内改用它。
  - `plugins/agint-session-source/lib/index.mjs` —— `createSessionSource` 内改用 `getUpstream()`，
    `mode` / `upstreamAvailable` 改成 getter（动态）。
- 判据（负向对照齐全）：
  - `test/lazy-service.test.mjs`（5 条）：上游晚注册 ⇒ 之后能取到；上游消失 ⇒ 取到 null；
    ctx 异常不炸；只取指定键。
  - `test/session-source.test.mjs` 新增 2 条：上游晚于建源注册 ⇒ 之后走上游；
    上游在建源后消失 ⇒ 回落（不许拿旧快照硬撑）。
- ✅ **同类模式已逐处核实（2026-10-21 老板令「处理同类模式」）—— 结论：8 处全是假警报，本轮不改代码。**
  核实方法：grep `ctx.get\(['"][a-zA-Z]+['"]\)` 在 `plugins/**/lib/*.js` 命中 44 处，
  再**逐处读上下文**判定取用时机（grep 命中 ≠ 问题）：
  | 位置 | 实际取用时机 | 判定 |
  |---|---|---|
  | `agint-evolve/lib/index.js:247` | 在 `dataSnapshot()` **函数体内** | 运行时取 ✓ |
  | `agint-dream/lib/consolidation.js:217-218` | 在 `consolidate()` **函数体内** | 运行时取 ✓ |
  | `agint-skill-autocreate/lib/llm-verdict.js:422-423` | **函数体内** | 运行时取 ✓ |
  | `agint-skill-autocreate/lib/tool-addition.js:120` | **函数体内** | 运行时取 ✓ |
  | `agint-quality-sandbox/lib/index.js:81,274,327` | 在 `runInMode()` **函数体内** | 运行时取 ✓ |
  | `agint-ov-strategy/lib/index.js:135` | 已是 `runtimeRaw = () => ctx.get(...)` **懒取**（注释明写"调用时取，绝不缓存"） | 正确范式 ✓ |
  | `agint-cron/lib/index.js:191-232` | `const services = () => ({...})` **工厂函数**，`job.action(services())` 在 **tick 时**调用 | 每 tick 重新求值 ✓ |
  | `agint-restart/lib/index.js:1072` | `const inject = ['agents', 'commands']`（第 61 行）—— 'commands' 是 **inject 硬依赖声明**，cordis 等它就绪才 apply | apply 时必然拿得到 ✓ |
  ⇒ **一处都不需要改**。若误改（尤其把 agint-restart 的 inject 硬依赖改成"懒取"）反而会引入真 bug：
  inject 声明是"apply 前保证就绪"，懒取是"运行时才取"，两者语义不同、不可互换。
- ⛔ **仍待处置**：`.agint-deps/dsh-runtime` 假绿来源（兼容门禁对着副本而非宿主）—— 与本项无关，另案。

### F9 · 上游事件流 ≠ 宿主侧原始日志（`readLocal` 契约踩坑）

- 现象（2026-10-21 第二次重启后运行态取证）：dream 扫到 **60 个会话**，但
  **用户消息信号 0 / memWrites 0 / 工具错误信号 0**；迁移前同窗口
  （`dreams/2026-10-21.md`，Light 2d）是 **31 会话 / 105 / 20 / 565**
  ⇒ 会话数涨了、内容全空 = 进化闭环的输入瞎了。
- 根因一（`readLocal` 契约）：session-source 的 `readLocal` 契约是「返回**文本**」，
  而 dream 注入的是 `readSessionLog(path)` —— 它返回**已解析的事件数组**。
  ⇒ `readEventsFromDisk` 里 `String(text).split('\n')` 把数组 toString 成逗号串
  ⇒ `JSON.parse` 全部失败 ⇒ **0 个事件**。
  修法：拆出 `readSessionLogText(path)`（只解压返文本），`readLocal` 注入它。
  取证（本地实测，真实会话日志）：旧路径 3378 事件 / 17 userTexts / 5 memWrites；
  新路径（session-source 回落）**同数**。
- 根因二（字段名）：dream 的 `listSessionLogs` 返回的字段是 `dir`（不是 `sessionId`）
  ⇒ 上游 `readSession(record.dir)` 从未拿到 id。修法：`log.sessionId ?? log.dir`。
- 根因三（**边界判断错了**）：**self-observation 整条链接上上游反而瞎了**。
  - 它的检测对象是**原始日志**的缺陷（坏行 / seq 断裂 / 缺 content / 未配对 call）；
    上游 `readSession` 给的是**重放校验后**的事件流 ⇒ 缺陷已被抹平 ⇒ 检测能力归零。
  - 上游 `listSessions` 的记录**不含磁盘路径** ⇒ 下游 `path` 是空串
    ⇒ 解压必然失败 ⇒ 全部会话被判 `undecompressible`。
  ⇒ **回退**：self-observation 的列举与内容**都按设计走本地**
    （`listRecentSessionsFallback` + 本地 zstd 解压），并保留
    `findSessionLogFile` 的候选名 + 后缀兜底以抗宿主改名。
  - 代价：仍是 B-008 登记的「宿主层能力自建」，本轮**不**消除 ——
    完整性检查需要原始字节，上游目前不提供该形态。
- 判据：
  - `test/session-integrity.test.mjs` 两条 ⛔ 断言：`inspectSessionFile` 签名**不含**
    `sessionSource`；`listRecentSessions` 必须给出**非空本地路径**。
  - dream 151/151、input-gateway 6/6 绿。
- **结论（写给下一个人）**：迁到上游前先问一句「我要的是**逻辑会话**还是**原始字节**」。
  前者可走上游，后者只能走本地 —— 这不是实现偷懒，是两种数据形态的差别。

---

## 5. 待裁决项（需要人拍板）

| # | 事项 | 选项 | 建议 |
|---|---|---|---|
| D1 | `agint-session-extract` / `agint-session-source` | A 改为消费 `ctx.sessionQuery`（F2 修法）· B 保留本地读盘并登记为「宿主格式变更风险点」 | **✅ 已完成**（commit `78da995`，2026-10-21）：4 处调用点全部迁移，session-source 新增 `readEvents()` 上游优先 + 回落出声 |
| D2 | token 计量（F3） | A 接 `ctx.tokenMeter` 补 `avgTokenCost` 与有效进化增量的 token 项 · B 不做 | **A**（度量缺口，AGINT 核心职责） |
| D3 | `agint-voice-hotkey` | A 归档，改用 dsh 语音输入 · B 保留自建 · C 保留但登记为与宿主重复 | **A**（少一个真相源） |
| D4 | `agint-mascot` / `agint-search-tools` 未挂载 | A 挂载 · B 归档 · C 保持未挂载并登记 | **C**（老板 2026-10-21 拍板「保持」）⇒ 状态不变，仅登记 |
| D5 | `agint-cron` 自写 5 字段 cron 解析 | A 复用 dsh 调度原语 · B 保留（解析器已稳定） | **A**（老板 2026-10-21 拍板「复用 dsh ctx.schedule」）⇒ **✅ 已完成**：时刻计算改走上游 `dsh-schedule` 规则引擎（`canonicalizeCronExpression` + `createCronScheduleRecord` + `resolveCronOccurrence`），自研实现降为回落层 |
| D6 | `agint-mount` 取 `ctx.get('dshHome')`（F6） | A 改走 `process.env.DSH_HOME` · B 保留 | **A**（改动 1 行，无行为变化） |

---

## 6. dsh 0.2.1 破坏性变更对 AGINT 的影响（逐条核验）

依据：上游 release `dsh-v0.2.1-rc.2`（rc.1 自述覆盖「since v0.2.0-rc.2」，
compare API 显示 1925 提交 / 300 文件）。本机包树内**没有**变更说明文件
（`dsh-runtime` 全树搜 CHANGELOG/RELEASE/MIGRATION 命中 46 个候选，`@deepseek-ai/dsh-*` 名下
11 个全是类型声明与 devtools 资源，**无一是发布说明**）⇒ 变更说明只能取自上游。

| 上游破坏性变更 | AGINT 是否命中 | 取证 |
|---|---|---|
| 移除运行时 invariant 插件及各包 `./invariant` 导出 | **未命中** | grep `invariant` 全 `plugins/` 仅 2 处，均与 dsh 无关（`agint-tool-stats` 测试名 "key order invariant"；`agint-quality-sdk` 自己的 prompt `manifest.kind`） |
| 移除工具展示 `both` 混合模式（只留 native/ptc） | **未命中** | AGINT 侧 `both` 仅出现在 `agint-quality-sdk` 的 prompt manifest 语境；AGINT 插件 manifest 声明的是 `host`/`both`（client 半区），与 dsh 的工具展示模式不是同一物 |
| 移除 `agent-instructions` 逐行 `dshHome` 配置 | **未命中** | AGINT 的 `agent-instructions` 行只配 `maxBytes`（preset 侧），未用逐行 dshHome |
| 子代理工具立即返回 child ID（自定义 SDK 需支持 `session`/`wait`） | **需关注，未验证** | AGINT 走**服务面** `ctx.agents.create` + `ctx.subagents.start`（`agint-dream/lib/consolidation.js:252`、`agint-skill-autocreate/lib/llm-verdict.js:463`、`agint-evolution-driver/lib/index.js:1734`），不是 dsh 的 subagent **工具** ⇒ 工具面变更不直接命中；服务面是否同步变更**未验证** |
| Agent Team 改直投 Inbox，移除 outbox / 重试 / 去重（配置字段需迁移） | **未命中** | grep `outbox` 全 `plugins/` 命中 0 |
| Python PTC 需提供 `sandbox` + `sandboxPolicy` 服务 | **未命中** | AGINT 无 Python PTC 集成 |

**新增能力里与 AGINT 直接相关的**：

| 上游新增 | 与 AGINT 的关系 | 裁决 |
|---|---|---|
| `ctx.worktrees`（Git Worktrees 插件） | 可给 mutation 验证提供隔离工作区 | 机会项，非适配项（AGINT 今天无裸 worktree 可替换） |
| `DSH_AGENTS_HOME` 全局 AGENTS.md | 影响 AGINT 的工作区指令注入路径 | **待评估**：AGINT 靠工作区 `AGENTS.md` 注入，若上游支持全局 AGENTS.md，注入策略要重定 |
| pi-ai 路由支持会话内系统提示词更新 + 工具动态增删 | 与 preset 工具行有关 | 需评估是否与 AGINT 的 preset 自改机制冲突 |
| `ctx.ssh`（SSH helper 运行时） | 本机未装 | 机会项：AGINT 的 `gszx-login` 技能将来可走宿主通道 |
| `working_directory` 工具 + SDK 工作目录读写 | 与 AGINT 的 `repoRoot` 硬判据相关 | 需核对是否会引入第二套工作目录真相源 |

---

## 8. 专项盘点结果（2026-10-21，全量逐文件扫）

一次覆盖 `plugins/` + `presets/` + `install/` + `bin/` + `patches/` 的专项扫描，
四类共命中 **34 条**（含 1 条正例）。完整明细见工作区
`docs/AGINT-能力边界契约与dsh衔接-20261021.md` 附录；此处只留**裁决结论与已修项**。

### 8.1 已修（本轮动码）

| 项 | 原状 | 修法 | 验证 |
|---|---|---|---|
| `agint-dream/lib/sweep.js` 名字表缺 v4 | 只有 `v3` / 无版本；宿主 09-22 起用 v4 ⇒ 候选名恒落空、走后缀兜底；v3/v4 并存时取哪个取决于 readdir 顺序 | 改为 import `agint-session-source` 唯一真相源（v4>v3>无版本） | dream **151/151** 测试绿 |
| 仓内 4 个 preset 共 46 处 `../../profiles/web/` | 指向 2026-10-18 已删除的 web profile（部署位早已是 desktop，仓内没跟上）⇒ 若某次 install 跳过重写，25 个工具行指向空目录 = K21 症状（挂得上、一个工具都没有、不报错） | 全改 `profiles/desktop`；另 3 处注释/persona 文本里的 `~/.dsh/profiles/web` 一并订正 | `check-patch-yaml` **11/11** 可解析 |
| `patches/dsh-builtin-toggles/apply.sh` | **改写上游 `node_modules` 里的插件源码**（`lib/index.js` 单行替换）。目标路径写死 `profiles/web` ⇒ web 删除后脚本必 exit 1；`profiles/desktop` 侧也无此插件（实测两处都不存在） | 加退役声明（三条理由），`apply.sh` 暂留待老板决定是否删除 | 未运行（脚本已失效） |
| `bin/plugin-check.sh` | 无边界门禁 | 接入 `check-boundary.mjs` 阻断位 | plugin-check 实跑 exit 0 |

### 8.2 未修但已裁决（需老板拍板，见 §5）

| 类 | 条数 | 最重的项 |
|---|---|---|
| 硬编码上游私有格式 | 11 | 会话文件名表另有 2 份副本（dream 已修，`session-extract` 仍持正则）；provider/model 硬编码 4 份（上游已有 `agentDefaultModel.currentSelection()`）；至少 10 处手搓 `DSH_HOME \|\| homedir()/.dsh`（上游有 `dsh-home-paths`） |
| 重复造轮子 | 7 | 会话发现 4 处自建 vs `sessionQuery`；技能枚举 3 处 vs `skills.list()`；插件挂载/清单 vs `pluginManager`/`pluginInventory`；手搓 UserMessage vs `dsh-llm.createUserMessage` |
| 越界侵入框架层 | 7 | 改写上游源码（已退役）；自带并锁死一份 dsh 运行时（门禁对着副本不是宿主）；直接写 dsh 的 `cordis.patch.yml`；沙箱缺席时默认在宿主进程内跑被测代码（`allowInProcessFallback` 默认 `true`） |
| 软依赖静默降级 | 9（含 1 正例） | `agint-quality-policy` 明确注释「memory 不可用 → 静默跳过」；`agint-search-tools` 依赖缺失 ⇒ 工具根本不注册、无日志；`agint-evolve` 同文件两套缺席标准（memory 缺席则键消失，oracle 缺席则 null） |

### 8.3 两条需要单独记住的判断

1. **`agint-mount/src/paths.ts` 头注释说「不使用 dsh 新增的 dsh.profilesDir Service」是正确的**
   —— 实测 306 个包里 `super(ctx,"profilesDir")` 命中 **0**，上游确实没有暴露该服务。
   文件头的理由应保留，避免后人再找一遍。
2. **「自带一份 dsh 运行时」是本仓最大的假绿来源**：`$DSH_HOME/.agint-deps/dsh-runtime`
   被排在 `npm root -g` 之前当解析根，而它内部版本三方不一致
   （容器清单 `0.2.0-rc.2` / 其 `node_modules` 内 `0.2.1-rc.2` / 真实宿主 `0.2.1-rc.2`）。
   兼容门禁对着的是这份副本，不是宿主本体 ⇒ 宿主升级而副本不动时，门禁对真实宿主失明。

---

## 9. 不确定项

1. dsh `sessionQuery` 在**部署位**（bundle 层）能否拿到 —— 只验过 host 层有该服务。
2. dsh 0.2.1 是否还有破坏性变更未被覆盖 —— 本轮核的是上游 release 明列的 14 条，
   `check-dsh-compat` 门禁本身**不查 API 面变更**（只查包名解析与 peer 版本）。
3. `agint-mascot` / `agint-voice-hotkey` / `agint-search-tools` 未挂载的原因（刻意 vs 遗漏）—— 仓内无记录。
4. `app.asar` 内是否还有 AGINT 引用但 CLI 包树里没有的其它包 —— 本轮只核了 `dsh-desktop-host` 一个。
5. 「子代理立即返回 child ID」这条是否也改了 `ctx.agents.create` 的**服务面**契约 —— 未验证。
6. dsh 的 `ctx.ssh` 服务在本机不可用（实现包不在这 306 个包里），本机是否需要它 —— 未评估。
7. 上游服务清单两份来源数目不一致（`api-catalog.js` 的 `SERVICE_API` 98 条 / 扫 `super(ctx,"...")` 得 92 个）——
   差集未逐条核对，可能含基类继承与非 Cordis Service。
