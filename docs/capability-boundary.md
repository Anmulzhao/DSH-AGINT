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

---

## 5. 待裁决项（需要人拍板）

| # | 事项 | 选项 | 建议 |
|---|---|---|---|
| D1 | `agint-session-extract` / `agint-session-source` | A 改为消费 `ctx.sessionQuery`（F2 修法）· B 保留本地读盘并登记为「宿主格式变更风险点」 | **A**（消除「宿主改名即瞎」的复发面） |
| D2 | token 计量（F3） | A 接 `ctx.tokenMeter` 补 `avgTokenCost` 与有效进化增量的 token 项 · B 不做 | **A**（度量缺口，AGINT 核心职责） |
| D3 | `agint-voice-hotkey` | A 归档，改用 dsh 语音输入 · B 保留自建 · C 保留但登记为与宿主重复 | **A**（少一个真相源） |
| D4 | `agint-mascot` / `agint-search-tools` 未挂载 | A 挂载 · B 归档 · C 保持未挂载并登记 | 待查是否有真实消费方后再定 |
| D5 | `agint-cron` 自写 5 字段 cron 解析 | A 复用 dsh 调度原语 · B 保留（解析器已稳定） | B（先记为宿主层偏好，不急改） |

---

## 6. 不确定项

1. dsh `sessionQuery` 在**部署位**（bundle 层）能否拿到 —— 只验过 host 层有该服务。
2. dsh 0.2.1 是否还有破坏性变更未被 `check-dsh-compat` 覆盖 —— 该门禁只查包名解析与 peer 版本，不查 API 面变更。
3. `agint-mascot` / `agint-voice-hotkey` / `agint-search-tools` 未挂载的原因（刻意 vs 遗漏）—— 仓内无记录。
4. `app.asar` 内是否还有 AGINT 引用但 CLI 包树里没有的其它包 —— 本轮只核了 `dsh-desktop-host` 一个。
