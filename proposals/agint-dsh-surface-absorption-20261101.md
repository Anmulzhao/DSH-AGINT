# Proposal: dsh 0.2.1 能力面承接（把宿主的 82 个传感器接进来）

> **状态**：**执行中** · 类别 `framework` · A1 已完成并部署（`28929dc`，2026-11-01）；A2 / B / C 待拍板
> **作者**：外部编码助手（WorkBuddy 会话） · **日期**：2026-11-01（A1 执行至 11-02 00:10）
> **目标对象**：`docs/capability-boundary.md` §3 候选清单 + `agint-input-gateway` / `agint-tool-stats` / `agint-mutator` / `agint-self-model` / `agint-family-panel` / `agint-restart`
> **风险等级**：A 批 P2（纯止损，不动挂载）· B 批 P1（要动挂载 / 重启）· C 批需单独立项
> **前置**：本机 dsh `0.2.1-rc.5`，AGINT `v0.24.0`

---

## 0. 一句话

**这次升级没有带来新功能，但它让我们看见了一个更旧的问题：AGINT 自称「事件总线驱动的自进化系统」，而宿主摆着 98 个服务、82 个事件，我们只用了 17 个服务、接了 6 个事件 —— 其中 1 个还接错了。**

所以本提案不追「新版本给了什么」，而是回答「宿主已经给了、我们一直没接的那部分，哪几条值得接」。

---

## 1. 事实层：dsh「新版本」到底新增了什么

三个口径必须分开说，混着说就是假话。

### 1.1 本次升级窗口（rc.3 → rc.5）：能力面零变更

| 面 | rc.3 | rc.5 | 增删 |
|---|---|---|---|
| 服务键 | 98 | 98 | **0 / 0** |
| 事件名 | 82 | 82 | **0 / 0** |
| 类型名 | 1054 | 1054 | **0 / 0** |
| 继承 ctx API | 9 | 9 | **0 / 0** |

**取证**：`npm pack @deepseek-ai/dsh-tool-cordis@{0.2.1-rc.3,0.2.1-rc.5}` 解包后 `import` 两份 `api-catalog.js`，
对 `SERVICE_API` / `EVENT_API` / `TYPE_API` / `INHERITED_CTX_API` 取键集合做双向差集 ——
不只名字没变，**逐条 `JSON.stringify` 比对连 summary 描述都没变一个字**。

同窗口依赖清单也无变化：`@deepseek-ai/dsh` 的 `dependencies` 86 条、`devDependencies` 53 条，
rc.2 / rc.3 / rc.4 / rc.5 四版**逐版 diff 增删均为空**（`npm pack` 后比 `package.json`）。

⇒ 上游 rc.4 / rc.5 的发布说明（ACP 诊断输出、思考内容展示）是 UI 层，
与本仓 `VERSION` 表 v0.23.0 行的记载一致。**「升级 rc.5 带来新能力」这个前提不成立。**

### 1.2 AGINT 现行契约基线（0.1.7-rc.2 → 0.2.1-rc.5）：这才是「新功能」

`VERSION` 表里 `dsh minimum = 0.1.7-rc.1` —— 那是 AGINT 承诺兼容的下限。
从那个基线量到 rc.5，才是「宿主这一代新增了什么」：

| 面 | 0.1.7-rc.2 | 0.2.1-rc.5 | 增删 |
|---|---|---|---|
| 服务键 | 89 | 98 | **+10 / −1** |
| 事件名 | 81 | 82 | **+1** |
| 类型名 | 926 | 1054 | **+138 / −10** |

**新增服务（10）**：
`claudeCodeMods` · `cotTranslation` · `otel` · `pluginMarket` · `productAnalytics` ·
`remoteAccess` · `translator` · `webApp` · `workingDirectory` · **`worktrees`**

**删除服务（1）**：`invariants` —— ✅ **已核实无风险**：全仓
`plugins/` `presets/` `cordis.patch.yml` grep `invariants` 命中 **0**。

**新增事件（1）**：`plugin-market/changed`

**新增类型（138）里真正构成能力簇的**（按对 AGINT 的相关度排）：

| 簇 | 代表类型 | 能力 | AGINT 现状 |
|---|---|---|---|
| **mods / hooks** | `ModDefinition` `ModHook` `ModOn` `ModsApi` `HookMatcher` `HookRegistration` | Claude Code 兼容的**插件作者 API**：`on(event, matcher, hook)` 挂钩子 + `register` 生命周期 | **0 引用** |
| **原生 UI** | `UiRenderInput` `UiElements` `UiNode` `PaneOpenArgs` `ToastOptions` `SurfaceSnapshot` | `ModsApi.ui` 的 `open(pane)` / `toast` / `ask` / `resolve`，以及 `claudeCodeMods.watchBand/pressBand`（输入框上方的 band） | **0 引用**（面板仍是自建 `webServer` + 独立 HTML） |
| **调用级用量** | `TurnUsage` `TurnCompleteInput` | `{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, model}` | **未接**（只有压力差估计） |
| **工作树** | `CreateWorktreeRequest` `CreatedWorktree` | `ctx.worktrees.create(agent, {name, from})` → 新分支 + pinned commit + 保留的 checkout | **0 引用** |
| 插件市场 | ~25 个 `Market*` | 索引拉取 / 兼容性校验 / 安装目标 | 未接（路线图 S6 已定「不自建」） |
| 远程访问 | ~15 个 `RemoteAccess*` | 访问策略与框架 | 未接（与进化层无关） |
| 类型化 remote | `TypertResource*` `TypertRemoteValue` | 生成的严格契约 | 未接（用不上，除非做跨进程） |
| 会话日志导出 | `SessionLogReporter` `EventLogReporter` `SessionLogRecord` | 日志观察者（可外送 OTel） | 未接 |
| 子代理激活 | `SubagentActivation` `SubagentActivationSpec` | 可编程的 `childId` + `result` + `dispose` | 部分接（4 插件 `consumes: subagents`，未用 activation 形态） |

### 1.3 下一个要接的版本（0.2.2-alpha.2）：11 条破坏性变更

`docs/upstream-watch.md` §6 已实测：其中 `tools.resolve/executable` 迁移只是**新增一个可选第二参**，
`defineTool` 的 options 一字未变、140 处调用零改动。**关键词判据会误报，结论必须由实测段给。**

⇒ 本提案**不**围绕 0.2.2 展开（那是 `agint-upstream-watch` 的职责），只把它作为风险前置写进 §7。

---

## 2. 现状盘点：AGINT 用了宿主的多少

口径分两层，因为**声明层和实际用层不是一回事**（差 6 个，正是「软取」的那些）。

**实际用层**（扫 `plugins/**` 313 个非测试源文件，匹配 `ctx.<服务>` / `ctx.get('<服务>')` / `lazyService(ctx,'<服务>')`）：
**17 / 98** —— `agents` `tools` `storageDomain` `subagents` `profileContext` `tokenMeter` `sandbox`
`skills` `schedule` `sessionQuery` `sessionPersistence` `agentDefaultModel` `timer` `webServer`
`commands` `goals` `approval`

**声明层**（`spec.cordis.inject` + `spec.cordis.consumes`，39 份 manifest）：
硬 inject 的宿主服务 **6** 个（`agents` `commands` `storageDomain` `timer` `tools` `webServer`），
consumes 的 **5** 个（`agents` `sessionPersistence` `sessionQuery` `skills` `subagents`），去重 **11**。

⚠️ **两层差的那 6 个值得单独看一眼**：`tokenMeter` / `sandbox` / `schedule` / `profileContext` /
`agentDefaultModel` / `goals` —— 全是 `lazyService` 或 `ctx.get` 软取。
这是有意的（`agint-tool-stats/lib/index.js:104` 记着教训：apply 期直接 `ctx.get('tokenMeter')` 会取到空，
因为服务还没发布），但代价是**门禁看不见这些依赖**：宿主删了 `goals`，`check-wiring` 不会红。

**订阅的宿主事件**：7 条，其中 **1 条宿主从不发出**（见 §4-A1）。

宿主 82 个事件里，AGINT 真正接上的只有 6 个：
`tools/pre-execute` · `tools/post-execute` · `tools/result` · `session/event` · `session/created` · `agent/pre-step`。

**问题不在「用得少」，在「接的位置单一」。** 六个里四个是工具流水线，两个是会话。
而宿主把 AGINT 最需要的三类信号放在别处，一条没接：

| 信号类 | 宿主给在哪 | AGINT 现状 |
|---|---|---|
| **存储写入** | `domain/changed`（emit，"一次写一条，严格在写之后"） | 21 个插件用 `storageDomain`，**零订阅** ⇒ 派生状态只能全量重扫或靠 cron 兜 |
| **工作流执行** | `workflow/start` `workflow/end` `workflow/phase` `workflow/log` `workflow/agent-start` `workflow/agent-end` | preset 已挂 `dsh-tool-workflow` + `dsh-workflow-ptc`，**零订阅** ⇒ 工作流跑过什么，进化闭环保留不下来 |
| **模型调用成本** | `TurnCompleteInput.usage: TurnUsage`（mod 钩子）/ `llm/stream` | 只有 `tokenMeter.measure()` 的**压力差**，非调用级 |

这三条合起来是一句话：**AGINT 的输入端只有 `agint-input-gateway` 的 5 类 channel，而这 5 类里没有一类叫「宿主自己」。**
P7 建了总线、建了死信、建了配额，但源头一直窄。

---

## 3. 判断依据：怎么筛的

用 `docs/capability-boundary.md` §0 的三条硬约束，不新增第四套标准：

1. **宿主层已有等价服务/工具 ⇒ AGINT 不得再实现同名同义能力**（违者 = H-越界）
2. **不做这件事，进化闭环会不会更假**（会 ⇒ 归进化层，必做）
3. **「宿主改一次会不会让它瞎」**（会 ⇒ 归宿主层，只消费）

⇒ 派生出一条本提案专用的取舍：**只接「能变成进化信号」或「能删掉一段自建」的**。
纯运行时便利（远程、翻译、遥测、GUI 自动化）一律不接 —— 接了就是给自己多一个会瞎的依赖。

---

## 4. 融合项

### A 批 · 纯止损（不动挂载、不新增能力，先修两个已经错了的）

#### A1 · `agent/session-start` 是一个宿主从不发出的事件 — ✅ **已完成 2026-11-01（`28929dc`，0.9.3，已部署生效）**

- **现象**：`plugins/agint-restart/lib/index.js:755` `ctx.on('agent/session-start', ...)`，
  这是 `tryFlushPending()`（重启后补投压着的恢复通知）的**唯一入口**。
- **取证**：宿主 0.2.1 的 `EVENT_API` 82 条里**没有** `agent/session-start`；
  对 dsh 安装树 `grep -rn "agent/session-start"` **命中 0 行** ⇒ 宿主不发，AGINT 自己也不发。
- **性质**：静默失效。cordis 里订阅不存在的事件不报错、永不触发 —— 与 2026-09-20 那次
  「`skipping profile bundle` 一声不响」同形状。
- **影响面（诚实版）**：通知**没有完全丢**。同文件注释记载还有第二条路径
  （`ctx.inject(['agents'])` 的 boot 轮询）会 `deliver()` 一次，所以日常重启仍能收到。
  但「补投」这条路死了 ⇒ `pendingOnlyLastSession` 与「重启时无活跃会话」的窗口**没有兜底**。
- **修法**：改成宿主真有的 `agent/created`（`[serial]`，"entered agent is ready for per-agent init"）。
  **不要**顺手改成 `session/created` —— 那个在 `[emit]` 语义下不保证 agent 已可投递。
- **验收**：`node plugins/agint-restart/test/pending-notice.test.mjs` 全绿 +
  新增一条阴性对照（宿主事件表里不存在的事件名必须让用例变红）；
  真实重启一次，`wake.log` 出现 `matched=pending`。
- **✅ 执行结果（2026-11-01 23:58 ~ 00:10 实跑）**：
  - 代码 `0.9.2 → 0.9.3`，commit `28929dc`；测试 9/9（新增 1 条护栏）；
    `plugin-check` EXIT 0 / FAIL 0；`verify-manifests` 全部一致；`check-dsh-compat` EXIT 0。
  - **阴性对照**：把事件名改回 `agent/session-start` → 4 条用例转红，报错精确到
    `订阅了宿主不存在的事件 "agent/session-start" —— 它将永不触发`；改回即绿。
  - **部署后真实证据**（这条是本提案唯一一次拿到「改动前不可能出现」的观测）：
    `install/redeploy.sh` 全流程 → dsh 重启（pid 1486298，00:04:45）→ 启动日志出现
    ```
    [agint-restart] code fingerprint c3e22539dc06（上一版 1e3c76fc563c）— 本次加载了新代码
    [agint-restart] no live agent yet — notice parked at .../pending-notice.json
    [agint-restart] notice delivered to evolution-driver-8087d7d1-… matched=pending mode=wake
    [agint-restart] parked notice flushed to evolution-driver-8087d7d1-…
    ```
    `matched=pending` 在改动前**不可能出现**（补投入口订阅的是不存在的事件）。这是 A1 生效的硬证据，
    不是「重启后看起来正常」。
  - 服务面复核：`/api/agint-family/v2/data` 200、`scan.errors` 空、`bus.total` 26907、`deadletter` 0、`oracle.state ok`；
    `redeploy.sh --verify-only` EXIT 0（preset 平价 CRITICAL 0 / INFO 64、5 个 preset 工具行镜像位全 0）。

#### A2 · `sessionQuery` 仍半接：通往上游的那扇门修好了，但没人走

- **现象**：`docs/capability-boundary.md` §4-F2 已判——上游分支产出的 `path` 恒 `null`，
  下游仍 `execFileSync(zstd, ['-dc', path])` 自读盘。**「用上游替代自建」这半件事没做。**
- **2026-11-01 复核代码后的更正（比 F2 更细，动手前必读）**：情况不是「没接」，
  而是**门修好了、路没通**。`agint-session-source/lib/index.mjs` 里 `readEvents(record)`
  其实**已经有**上游分支：
  ```js
  if (upstream && record.upstream && record.dir) {
    const snap = await upstream.readSession(record.dir);   // 不需要磁盘路径
    return { events, via: 'upstream' };
  }
  ```
  回落分支也守住了纪律（拿不到就抛，不返回空数组冒充"没内容"）。
  ⇒ **真正断在消费端**：`agint-input-gateway/lib/channels/self-observation.js:520` 的注释写着
  「本函数签名**不再接受** sessionSource（2026-10-21 之前接受过，见 git 史）——
  zstd 解压 / 坏行计数 / 事件归一化自此全部自持」，同文件 `zstdCandidatePaths()` +
  `execFileSync` 仍在跑。**2026-10-21 那次改造把 `sessionSource` 从这条路上摘掉了，不是接上。**
- **最新证据**：HEAD `4e3798e` 修的正是同一个洞的下一层——
  「`sessionIntegrity` 子源从未执行过（zstd 探测恒 false）」。**修的是探测器，不是通路。**
- **修法（三步，缺一步都算没接）**：① `self-observation` 读内容改调
  `sessionSource.readEvents(record)`；② zstd 自解降为**回落层**并在返回值上标
  `source: 'upstream' | 'fallback'`；③ 坏行计数 / 事件归一化这两层**留在 AGINT**
  （那是进化语义，不是宿主职责），只是数据来源换了。
- **边界**：AGINT 保留的只有「从事件流抽进化语义（工具调用序列 / 模型范围）」这一层 —— 那是进化层，不是宿主层。
- **验收**：`sessionIntegrity` 子源在 `source='upstream'` 下产出非空记录；
  人为让 `readSession` 抛错，`source` 必须变 `fallback` 且**不是空数组**（失败要声张）；
  `node bin/check-boundary.mjs` 不再列 `agint-session-extract` 为 H-越界。
- **⚠️ 动手前的两个前置**：该文件 2026-11-01 刚被另一处改动碰过（`4e3798e`），
  改前先 `git status --short` 确认没有并发写者；函数体 500+ 行且被 `sessionIntegrity` /
  `self-observation` 两个子源共用，**先拆测试再改实现**，不要一次性重写。

---

### B 批 · 接宿主已有原语（每条都能删掉一段自建，或补一个真信号）

#### B1 · 事件源扩容：把 `domain/changed` 与 `workflow/*` 接进总线

- **为什么是这条**：一条提案的杠杆全在这里。AGINT 花了 v0.7 一整个版本建总线，
  却在输入端只接了 5 类 channel。宿主 82 个事件是现成的传感器阵列。
- **接哪几个（按增益排序，不贪多）**：

  | 事件 | 模式 | 接给谁 | 换来什么 |
  |---|---|---|---|
  | `domain/changed` | emit | `agint-self-model` / `agint-family-panel` | 派生状态**增量刷新**，不再全量重扫 21 个域 |
  | `workflow/end` + `workflow/phase` | emit | `agint-trajectory` / 进化记忆 | 工作流跑过什么进入训练数据层 |
  | `subagent/start` + `subagent/end` | emit | `agint-event-bus`（新 topic） | P8 多 Agent 进化的前置数据 |
  | `skills/change` | emit | `agint-curator` | 技能变更驱动策展，而不是靠 cron 扫 |
  | `goal/changed` + `goal/activation-changed` | emit | `agint-curriculum` | 课程与真实目标对齐 |

- **形态纪律（照抄 `agint-event-bus` 的既有做法）**：宿主事件 → 薄适配器 → `agint.eventBus.publish`，
  **不是**在每个插件里直接 `ctx.on` 散着接。理由：总线已有去重 / 死信 / 配额 / 观测，
  绕过它接就等于开第二个池子（`docs/upstream-watch.md` §2.1 那段的教训）。
- **验收**：`node bin/check-wiring.mjs` exit 0（新 topic 必须有订阅者，否则 NO_SUBSCRIBER）；
  人为写一个域，`agint.eventBus.inspect({topic:'…domain-changed'})` 能看到一条；
  面板刷新时不再触发全量 `v2-scan`。

#### B2 · 调用级 token：`TurnUsage` 补上「非 billing 级」这个已知限制

- **现状**：`docs/known-limitations/token-cost-not-billing-grade.md` 写明
  —— `deltaTokens` 是**压力差估计**，412/4746 行带数值，`avgTokenCost=1068`，但**不是调用级计费**。
- **宿主已给**：`TurnCompleteInput.usage?: TurnUsage`，字段是
  `input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens / model`。
  **这四个字段正好是 billing 级需要的全部。**
- **接法**：注册一个 mod（`ctx.claudeCodeMods.add(definition)`），在 turn-complete 钩子里拿 `usage`，
  写进 `agint-tool-stats` 的新字段（如 `turnUsage`），与既有 `deltaTokens` **并列不减**。
  两者对不上时**两个都留**并标 `tokenSource: 'turnUsage' | 'tokenMeter'` —— 不覆盖，做交叉验证。
- **⚠️ 前置已实测：本机拿不到这个服务。** `dsh-hooks-claude-code` / `dsh-hooks-codex` 在
  `@deepseek-ai/dsh` 的 `devDependencies` 里（`dependencies` 没有 ⇒ 全局装不带），
  对本机安装树 `ls node_modules/@deepseek-ai | grep -i "hook|mod|claude"` **命中 0 个相关包**
  （只匹配到 `dsh-plan-mode` / `*-model-*` 这类无关名），`AGINT-data/.agint-bundle/` 里
  grep `claudeCodeMods` 也**零命中**。
  ⇒ 能力面里声明了 `claudeCodeMods`，但**本机没有 provider**。
- **因此本条的真实工程量不是「接一个钩子」，而是「先加一个 host 挂载项」**：
  `dsh plugin --profile web add @deepseek-ai/dsh-hooks-claude-code@<与宿主同版本>`。
  装完再探测 `ctx.get('claudeCodeMods')` 非空才立项；为空则降级为「等官方默认挂载」，
  **不要**自己造一个 mod 宿主 —— 那就是新的 H-越界。
- **验收**：同一 turn 上 `turnUsage` 四字段之和 = `deltaTokens`（±5% 容差，超差记告警不记错）；
  `docs/known-limitations/token-cost-not-billing-grade.md` 改标题为「压力差 vs 调用级，两套口径并列」。

#### B3 · `worktrees`：给 mutator 一个真隔离实验环境

- **现状**：`capability-boundary.md` §3 记「未接（10-19 已论证：AGINT 无裸 worktree 可替换）」。
  **这个论证的结论要改**：不是「没有可替换对象」，是「当时宿主没给这个原语」——现在给了。
- **宿主已给**：`ctx.worktrees.create(agent, request)` →
  `{path, branch, baseCommit, repositoryRoot}`，语义是「建新分支、checkout 到 pinned revision、进入它；
  已存在的分支或路径直接失败」（fail-closed，正合 AGINT 纪律）。
- **接给谁**：`agint-mutator`。现在改源码靠 `bin/safe-update.sh` 拍快照 + 直接改工作区，
  一旦并发（本仓已知有并发写者）就是「谁的改动覆盖谁」。
  worktree 把实验挪出主工作区，**主工作区不再被试验污染**。
- **⚠️ 风险**：worktree 与 `install/redeploy.sh` 的部署位映射需要一起想清楚 ——
  在 worktree 里改完，仍要回主工作区才谈得上部署。**本条的产出是「实验隔离」，不是「自动部署」。**
- **验收**：`mutator.synthForProposal` 产出的补丁在 worktree 里落盘、主工作区 `git status` 干净；
  `CreatedWorktree.baseCommit` 与主工作区 HEAD 相等（否则实验对象不是线上对象）；
  失败路径：同名分支已存在 ⇒ 抛错而不是复用。

#### B4 · `sessionProjections`：把派生状态交给宿主托管

- **现状**：AGINT 的派生值（`stage` / `staleSince` / `hasBlocker`）靠「不落盘、每次现算」或
  「落盘 + 手动失效」两选一。v0.24.0 刚为这事专门写了「派生值不落盘」的设计决定。
- **宿主已给**：`ctx.sessionProjections.register(definition)` + `onChanged(listener)` + `stateOf(session, key)`。
  语义是「注册一个域的单位，状态由宿主在 session cursor 处物化」。
- **价值**：这正是「派生值不落盘、但也不每次重算」的第三条路。
- **⚠️ 注意**：它绑 **session**，而 AGINT 的提案台账是**跨 session** 的（`agint_evolve` 域）。
  ⇒ 本条**只适用于会话内派生值**（tool-stats 的 resourceWindow、self-model 的会话级快照），
  **不适用于提案 stage**。别为了用而用。
- **验收**：注册一个 host-only 单元，会话中途 `stateOf` 与现算结果逐字相同；
  会话结束 `onChanged` 不再触发（不泄漏）。

#### B5 · `claudeCodeMods` 的 pane / band：载体层的第二条路（**先评估，不实施**）

- **现状**：`agint-family-panel` 自建 `webServer` 路由 + 独立 HTML 页面。
  `capability-boundary.md` 把它归 C（载体层）—— 合规，但离宿主 GUI 是两张皮。
- **宿主已给**：`ModsApi.ui.open(pane)` / `close` / `toast` / `ask` / `resolve(UiRenderInput)`，
  以及 `watchBand(agent)` / `pressBand(agent, generation, actionId)` —— 输入框上方的一条可交互 band。
- **为什么只评估**：把 43 个插件 + 一个成熟面板改成 mod 形态是**架构级动作**，
  与「面板是 C 层、不得侵占进化数据通路」的纪律有张力（mod 跑在宿主进程里，权限面变了）。
- **前置同 B2**：`ModsApi.ui` / `watchBand` 都挂在 `claudeCodeMods` 上，**本机当前无 provider**
  （见 B2 实测），这条连评估都要先装包。
- **本提案只要求一件事**：写一份 3 页评估，回答「band 能否只承载『现在该谁动』这一行状态」。
  能 ⇒ 后续单独立项；不能 ⇒ 记为「已评估，不做」，别每季度重问一次。

---

### C 批 · 需要单独立项（本提案只登记，不动手）

| # | 事项 | 现状 | 为什么不当场做 |
|---|---|---|---|
| C1 | 官方 plugin market（路线图 S6） | `pluginMarket` 服务 + `plugin-market/changed` 事件已在；AGINT 的 manifest 未按市场声明规范化 | 路线图已定「不自建，GA 后作为分发渠道」。上架前需先补 `MarketCompatibility` / `MarketEngines` 声明，属发版级动作 |
| C2 | mod 形态 vs cordis 插件形态 | AGINT 全仓 0 引用 `claudeCodeMods` | 形态变了，权限面 / 生命周期 / 门禁全要重写。**不建议在 P7 收敛期动** |
| C3 | agentTeams（P8 多 Agent） | 未接；`docs/agent-collaboration.md` 已有规约 | P8 已 Deferred，前置未达 |

---

## 5. 明确不做

| 项 | 理由 |
|---|---|
| `remoteAccess` / 移动端 | 与进化闭环无关；路线图已定「不做，只适配」 |
| `translator` / `cotTranslation` | 呈现层便利，不进信号面 |
| `productAnalytics` / `otel` / `productTelemetry` | 数据外发，与「机器私有事实不进库」的边界冲突 |
| 全量 diff 上游 `lib/*.js` | 上游日更，全量 diff 会让噪声淹没信号（`upstream-watch` §6-2 已论证） |
| 把 138 个新类型逐个接 | 绝大多数是 UI/remote 契约，与进化层无关。**接类型不是目标，接信号才是** |

---

## 6. 验收（每条都要给退出码和原始输出，不许说「应该没问题」）

| 项 | 命令 | 通过判据 |
|---|---|---|
| A1 | `node plugins/agint-restart/test/pending-notice.test.mjs` | 全绿 + 新增「宿主不存在的事件名必须变红」阴性对照 |
| A1 | 真实重启一次 | `wake.log` 出现 `matched=pending`（当前不可能出现） |
| A2 | `node bin/check-boundary.mjs` | `agint-session-extract` 不再列 H-越界 |
| A2 | 人为让 `readSession` 抛错 | 返回 `source='fallback'` 且**非空**，不静默 |
| B1 | `node bin/check-wiring.mjs` | exit 0，新 topic 无 NO_SUBSCRIBER |
| B1 | 写一个域 | `agint.eventBus.inspect({topic})` 有 1 条，面板不触发全量扫描 |
| B2 | 探测 `ctx.get('claudeCodeMods')` | 非空才立项；空则本条挂起并在提案里记「未验证」 |
| B3 | `mutator` 造一次补丁 | worktree 内落盘、主工作区 `git status --short` 为空 |
| B4 | 会话内 `stateOf` vs 现算 | 逐字相同；会话结束 `onChanged` 静默 |
| 全部 | `bin/plugin-check.sh plugins/<name>` | 无 FAIL |
| 全部 | `DSH_ROOT=<dsh根> node bin/check-preset-parity.mjs` | 全绿，repo 与 deployed 行数相等 |
| 全部 | `./install/redeploy.sh` | exit 0；启动日志无 `skipping profile bundle`、无 `startup failed` |

---

## 7. 风险与前置

1. **0.2.2-alpha.2 是下一个雷**：11 条破坏性变更，其中 `engines.node >= 24.9.0`（本机 nvm `v24.21.0` 满足）。
   本提案的任何改动**不应**顺手升到 0.2.2-line —— 先把 rc.5 上的承接做完。
2. **不改 dsh 安装目录**（AGENTS.md 红线）。B2/B5 若需要 host 层挂载 `dsh-hooks-*`，
   那是 profile 动作（`dsh plugin --profile web add`），不是改安装树。
3. **B3 与部署链的关系要想清楚**：worktree 只解决「实验隔离」，不解决「怎么上线」。
   把两者混在一起会把 `redeploy.sh` 的 fail-closed 语义搞乱。
4. **并发写者**：本仓有另一个 agent 会话在直接改 `plugins/**`。提交前 `git status --short`，
   `git add` 用显式路径，**禁止 `-A`**。
5. **每条都要能单独回滚**：B 批逐条一个 commit、一个插件一批，不混提交。
6. **部署时看见一个新的宿主告警（2026-11-02 00:04 实拍，未处置）**：
   dsh 启动日志 `dsh: warning: 1 entry did not activate`，失败项是
   `experimental-inspector (@deepseek-ai/dsh-experimental-inspector): Error: inspector: source state
   exceeds the source-frame byte limit`（`InspectorSourceBuffer.setState`）。
   - 与 `wiki/` 里记的 rc.5 inspector 必崩 bug（`Host source is closed`）**不是同一条**：
     那条已用 `tools/patch-dsh-inspector.mjs` 补掉（`--check` 现在报 ✓ 补丁在位），
     本次是**字节上限**，补丁没覆盖。
   - 进程没有崩（运行 5 分钟、fatal 计数 0、3080 正常服务、家族面板 200），
     所以是「调试面板少一棵树」而不是功能故障。
   - 但**它很可能是 AGINT 规模撑出来的**：45 个插件 + 27 cron job 的 cordis 树序列化后
     超过 inspector 的 frame 上限。这是「宿主层容量限制 vs AGINT 规模」的新问题，
     `docs/` 里**没有记录**（grep `source-frame byte limit` 命中 0）。
   - ⇒ 建议单独开一条：要么记进 `docs/known-limitations/`（承认 inspector 在 AGINT 规模下不可用），
     要么向 `agint-upstream-watch` 报一条上游候选。**不要**为了让它变绿去手改 dsh 安装目录。

---

## 8. 建议的推进顺序

```
A1（半天）→ A2（1~2 天，动 session 通路，风险最高但收益最硬）
   ↓
B1（2~3 天，只接 domain/changed + workflow/end 两条，先证明形态）
   ↓
B2 探测（1 小时）→ 非空则做，空则挂起
   ↓
B3 / B4 任选其一（各 2 天，都能独立验收）
   ↓
B5 只写评估，不写代码
```

A 批不依赖任何新增挂载，可以立刻做；B 批每条都要过 `redeploy.sh` 与重启核验。
