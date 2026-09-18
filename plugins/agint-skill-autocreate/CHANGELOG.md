# Changelog — agint-skill-autocreate

## 0.5.0 (2026-09-18) — 自进化默认：LLM 出厂即开（判定 primary / 撰写 on）

> 老板拍板的**理念修正**：「AGINT 是自进化系统，能自动的就不要人工参与。
> 以后像这种情况就应该全部默认打开，这是理念问题，不是安全问题。」
> 0.4.0 的"默认全 off"是对 kill-switch 原则（K51）的误执行——
> **kill-switch 是出问题时的逃生门，不是默认熄火的理由。**

### 改动

1. `lib/schema.js`：`llm_judge_mode` 默认 `off` → **`primary`**；
   `llm_authoring_mode` 默认 `off` → **`on`**。其余键不动
   （provider/model 仍空=跟随宿主；预算仍 20/日；requires_judge 仍 true）。
2. `test/release.test.mjs`：默认值断言同步翻转。
3. 版本 0.4.0 → 0.5.0（默认行为变化，minor）。

### 为什么直上 primary 是安全的（不是拍脑袋）

- **失败即回落**：判定调用失败/超时/产出不合/预算耗尽 → 自动回落轨道 B 规则，
  不阻断、不报错（0.4.0 的降级设计在这版从"保险"变成"日常路径"，测试实证：
  mock 环境无 LLM 服务，321/321 依旧全绿）。
- **产出仍过三道本地门**：LLM 撰写的 name/description 过宿主名正则 +
  工具链名判据 + 自我指涉检查，不过关整条丢弃。
- **下游闸门全部保留**：候选还要过三道发布门 + 门 5 特异性复检才能上线。
- **预算封顶**：20 次/日（含 shadow），超了静默回轨道 B。
- **逃生门**：所有键在 `RUNTIME_CONFIG_KEYS`，一条配置即可回 off。

### 观察口径（开起来之后看什么）

- `llm_judge_degraded` 频率（服务可用性）
- `llm_authoring_rejected` 频率（撰写质量 / 本地门松紧）
- 候选通过率变化（LLM 判定 vs 规则判定的实际差异）

## 0.4.0 (2026-09-18) — LLM 接入：判定轨道 C + 提案撰写 + 每日硬预算（默认全 off）

> 来源：`issue-drafts/2026-09-18-LLM接入autocreate-方案.md`。关联：K45（分治）、
> K51（自进化默认：可回滚 > 可审批，新机制一律带 kill-switch）。

### 结论先行

**默认全 off ⟹ 零行为变化**。LLM 是增益不是依赖：调用失败/超时/产出不合/
预算耗尽一律静默回落轨道 B（启发式），不报错、不阻断，只写审计。

### 改动

1. **`lib/llm-verdict.js`（新增）**：把一次 LLM 调用包成永不抛的结构化结果。
   - `judgeViaLLM` 通过宿主 subagent 通道调用（`structured output` 过 schema）；
   - AbortController + `Promise.race` 超时双保险（同 dream K49 的教训）；
   - `finally` dispose，防句柄泄漏；prompt 注入防护（`<<<WINDOW` 分隔标记）；
   - **schema 只用宿主 enforced JSON Schema 子集**（`type/properties/required/
     additionalProperties/enum` 等）——`pattern`/`maxLength`/`minimum` 宿主不支持，
     会在子 agent 创建前直接抛错，相关约束全部下移本地校验（取证：
     `dsh-tools/lib/types/json-schema.js` 的 `assertObjectJsonSchema`）。
2. **`lib/llm-budget.js`（新增）**：每日硬预算（默认 20，**含 shadow**）。
   按本地日切，从当日 `llm_judge_called` 审计恢复——进程重启不丢预算；
   恢复失败按 0 算（宁可多花几次，不因读不到审计把 LLM 全关）。
3. **`lib/standardizable.js`**：合成顺序 = 硬否决 5 条 → 轨道 C（LLM）→
   轨道 A（diagnosis）→ 轨道 B（兜底）。`shadow` 模式不改结论只写
   `signals.llmShadow`；`primary` 模式 LLM 结论生效。LLM 与规则共用同一
   `min_standardizable_confidence`（LLM 无特权阈值）。硬否决提取为
   `preHardVeto` 供 index.js 预筛共用（同一份实现，防漂移）。
4. **`lib/proposer.js`**：`buildProposal` 支持 `opts.llmAuthoring`（name/
   description 按优先级合并）；LLM 产出过两道本地校验（宿主 SKILL_NAME 正则 +
   `isToolChainName` 工具链名判据）+ 自我指涉检查，任一不过整条丢弃并返回
   reason 供 `llm_authoring_rejected` 审计。导出 `validateLlmAuthoring`。
5. **`lib/index.js`**：接线。窗口上提共享；判定前按 `llm_judge_mode` 调
   LLM（**只在过了硬否决预筛的 pattern 上调**——那五条是结构性事实，让 LLM
   重判等于白付一次调用）；审计五动作：`llm_judge_called` /
   `llm_judge_degraded`（必带 reason）/ `llm_judge_shadow`（含 agree 分歧）/
   `llm_budget_exhausted` / `llm_authoring_rejected`；`stats()` 暴露 LLM 配置
   与当日用量；新增 `verifyLlmJudge()` service method（真模型验证，手动）。
6. **`lib/verify.js`（新增）**：照抄 dream verify 模式。两个刻意反向样本
   （一个带领域知识 / 一个纯脚手架）验证**分辨力**——全 true/全 false 都是
   prompt 失败的信号。不写存储、不动预算、不进 CI。工具 `autocreate_verify_llm`。
7. **`lib/schema.js`**：7 个 LLM 配置键全进 `RUNTIME_CONFIG_KEYS`
   （`llm_judge_mode`/`llm_authoring_mode`/`llm_provider`/`llm_model`/
   `llm_timeout_ms`/`llm_daily_budget`/`llm_authoring_requires_judge`）。
   provider/model 空 = 跟随宿主，**刻意不硬编码** dream 的
   `DEFAULT_PROVIDER='minimax-cn'`——那是从 settings.yaml 抄的快照，换模型
   那天会变成静默故障。
8. 版本 0.3.7 → 0.4.0（minor：新增可选能力，无破坏）。

### 测试

新增 4 个测试文件（llm-verdict / standardizable-llm / skill-authoring-llm /
llm-budget），全量 `node --test "test/*.test.mjs" test/smoke.mjs` **321/321 绿**。
关键护栏做过**变异测试**（5 处护栏逐个改坏、确认对应用例各自变红）：
dispose 漏调、硬否决让位 LLM、shadow 改结论、工具链名放行、预算超卖。

### 未做（明示）

- `llm_authoring_mode: on` 只开产出通路，默认仍 `off`；真模型上的 prompt
  分辨力需跑 `verifyLlmJudge` 人工确认后才建议开。
- Phase B（撰写质量门 A3 级别复核）未接——先让 Phase A 的判定数据说话。


## 0.3.7 (2026-09-18) — 发布前特异性复检（门 5）+ 黑名单依审计扩至 47 项

> 来源：0.3.6 上线后**首次真实运行**（2026-09-18 10:11，机器唤醒后 cron 补跑）
> 的核账结果。关联：K51「自进化默认」、K53「黑名单靠审计自检」。

### 问题一：A1 管不到存量队列

A1 作用在**候选产生那一刻**。它上线之前产生的候选，不受它约束。09-18 核账：

| 状态 | 条数 | 纯脚手架 |
|---|---|---|
| QUEUED_FOR_RELEASE | 37 | 27（另 9 条含未收录工具） |
| BUDGET_WAIT | 1 | 1 |
| RELEASED | 3 | 3 |

且当日 release job 已把 `pwsh-pwsh-pwsh-pwsh` 自动发布上线。**入口收紧了，出口还开着。**

### 问题二：黑名单没跟上（审计自检回路在工作）

0.3.6 留的审计出口 `pattern_specificity_unknown_tools` 首次运行就吐出了答案——
20 种未收录工具占满榜单，**全部是「操作 AGINT 自身」的控制面动作**：

```
restart_status(15) autocreate_stats(13) autocreate_list_candidates(7)
autocreate_list_patterns(5) cron_list(5) autocreate_list_releases(4)
evolve_propose(4) memory_read(3) ... dream_status/wiki_list/rule_check/...
```

判据（黑名单 = 任何任务都可能顺手用一步的通用外形）下，这些显然是脚手架，但
它们当时不在名单里，于是被当 unknown **放行**——今日候选
`read-read-askuserquestion-read`（tools 含 `restart_request`）正是这样逃过 A1 的。

> 这正是黑名单方案里「它是否仍然封闭，靠审计兜底」那句设计的兑现：
> **不是 bug 暴露，是检查表按预期报出了缺口。**

### 改动

1. **`lib/detector.js`**：`SCAFFOLD_TOOLS` 17 → 47 项，补入上述控制面工具；
   `DOMAIN_TOOLS` 同步移出这些（避免分类报告自相矛盾）。判据与判定逻辑未变
   （仍是「序列里全是脚手架才拦」），只把名单补全。
2. **`lib/release-manager.js`**：`checkGates` 新增**门 5**——用同一套黑名单重判
   候选工具序列，纯脚手架则拒发。关键取舍：
   - **终态 REJECTED，不是 BUDGET_WAIT**：特异性不合格是永久性的（除非改黑名单），
     留在 BUDGET_WAIT 会让 `releaseQueue` 每天把同一批重试一遍并刷日志。
     为此抽出 `rejectCandidate()`，与 `holdCandidate()` 分工。
   - **manual=true 也不绕**：与门 3 同理，质量门不该被人工点头打开；要发得改黑名单
     或关开关，那是显式动作。
3. **`lib/schema.js`**：新增 `release_specificity_gate_enabled`（默认 true），
   已进 `RUNTIME_CONFIG_KEYS`。
4. **修两条既有红测试**（非本次引入，HEAD 即红）：
   - `test/smoke.mjs`：断言 `weekly_deploy_budget === 20`，实际 schema 早已调为 3
     （与发布收紧配套）——测试没跟上。
   - `test/aggregator-cross-session.test.mjs`：真实数据回放断言「primary 比 off
     多 >30%」，那是 09-17 的快照（401→687 = +71%）；09-18 复测已随数据积累
     收窄到 609→744（+22.2%）。**固定百分比会持续漂移假红**，改为只断言机制
     （严格多于），幅度留在报错信息里。
5. **新增 `test/release-specificity-gate.test.mjs`**（9 例）：门 5 各分支
   （拦截 / 不误杀领域工具 / unknown 放行 / 空序列拦 / manual 不绕 / kill-switch）
   + 两条生产回归（今日逃过的序列、审计 30 种工具全覆盖）。

### 验收

- repo 与宿主部署位各 **243/243** 全绿。
- 存量预演（宿主真代码 + 生产存储，只读）：待发 38 条中 **门 5 拦下 36 条**，
  放行 2 条（`web_fetch` / `agint_search` 序列，确有领域动作）。
- 已发布的 3 个技能（`glob-glob-glob-glob` / `askuserquestion-todowrite-edit-read`
  / `pwsh-pwsh-pwsh-pwsh`）均为 `scaffoldOnly=true`，属门上线前产物，**未自动清理**
  （回滚走 `rollback` 通道，不手工删目录）。

### 可回滚

`release_specificity_gate_enabled=false` 关闭门 5（退回只靠 A1 入口门）；
`scaffold_tools_extra` 追加校验名单。两者均免改代码、免重启后仍生效。

## 0.3.6 (2026-09-18) — A1 特异性门（检测层准入，黑名单判据）

> 来源：质量门方案 §2 A1（`issue-drafts/2026-09-17-技能自动生成质量门-方案.md`）——
> 三道门里**唯一还没落地**的一条。老板 09-18 拍板补齐，并定下判据方向为**黑名单**。
> 关联：K51「自进化默认」（门禁下放为可自动验证的规则，可回滚 > 可审批）。

**问题**：次数门槛（`occurrenceCount ≥ 3`）只证明「经常发生」，不证明「值得沉淀」。
通用脚手架序列（读/写/搜/执行/待办）频次最高，因为**任何任务**都要用它们。
2026-09-17 上线的 `glob-glob-glob-glob`、`askuserquestion-todowrite-edit-read`
两个技能就是这道门缺失的直接产物——正文只能是「调用 glob、调用 read」。

**判据（黑名单，不是白名单）**：序列里**全是**通用脚手架才拦下。
- 为什么不用白名单：领域工具是**开放集合**（每加一个插件就多一批），拿它当准入门槛
  等于要求「每长出一个新工具就来登记一次」——那是人工参与，不是自动化；
  且白名单误杀（好模式永远不成技能）**没有任何下游能救**，是最难观测的死法。
  黑名单误放则还有 A2 具体值门 / A3 信息量门 / 质量门 / 观察期兜底。
- `DOMAIN_TOOLS` 降级为**纯观测分类**，不参与判定。

**行为**：被拦模式**照常入库**（可观测），但不发 `pattern-detected`、不生成候选，
另开 `blockedByLowSpecificity` 桶 + `pattern_blocked_low_specificity` 审计。
判定顺序固定 成功率 → 特异性，两桶互斥，不重复计数。
`detect()` 返回值新增 `specificityBlocked` / `unknownTools` 两个计数。

**可回滚（K51）**：`pattern_specificity_gate_enabled`（默认 `true`，置 false 整门关闭）；
`scaffold_tools_extra`（追加脚手架黑名单，与内置取并集）。两者均进 `RUNTIME_CONFIG_KEYS`。

**可观测**：新增审计 `pattern_specificity_unknown_tools` —— 列出两个名单都没收录但已放行的
工具及频次。它同时是「黑名单是否还封闭」的检查表：里面若混进通用动作就该补进黑名单。

**实测（生产数据只读，`_a1_verify.mjs`）**：
- 存量 162 个 pattern → **62 个（38.3%）判为纯脚手架**，将被拦下
- 已上线的两个技能还原序列后**均判为拦下** → 门确实打在要害上
- 未收录工具 40 种 → 依审计补入 `structured_output`、`read_image` 两个明确通用动作 → 38 种

**测试**：新增 `test/specificity-gate.test.mjs` 15 例（含"未知工具不误拦"
"黑名单扩展是追加不是替换""三桶互斥""成功率门优先"）；全量 **234/234**。
`sampleArgs-plumbing.test.mjs` 两条用例显式 `specificityGate: false`——
被测对象是 sampleArgs 透传，与特异性正交（与 Phase 1 钉 `session_source` 同一手法）。

---

## 0.3.5 (2026-09-17) — 跨会话聚合（Sprint 17，老板拍板走 plugin-preflight 完整流程）

> 提案：`evolve_propose d5124051-817c-4aa3-bea6-fe259cf9914d` → **applied**
> 触发：老板原话「我的意图其实是跨会话的，这个模式的聚合也应该是跨会话的，这样才是科学合理的」
> **落地决策**：老板拍板**切 primary 一步到位**（不走 shadow 灰度期）。
>   - `cross_session_aggregation` 默认 = **primary**
>   - detect() 立即按 primary 跑；下一次 `45 4 * * *` cron 也会按 primary
>   - 13.5 天 / 9088 条数据回放预期：跨过 `min_occurrence_count≥3` 模式数 11 → 21（+91%）

- **行为扩展**（mode 三档）：
  - `aggregateTasks(records, options)` 新增 `mode: 'off' | 'shadow' | 'primary'`
    - `off` = v0.3.4 行为（保留可回退）。
    - `shadow` = 新旧并行算，返回 `shadowDiff { extra, lost, shared, *Count }` + `legacyTasks`，**不发候选**。
    - `primary`（**默认**）= 用跨会话结果作唯一任务边界。
  - 新函数 `aggregateTasksCrossSession(records, options)` 直接导出。
  - 跨会话任务边界 = 按 `ts` idle gap（默认 30s）切分，与 `sessionId` 解耦。
  - `detect()` 读 `effectiveConfig().cross_session_aggregation` 传给 aggregator；shadow 模式额外写 `cross_session_shadow_diff` 审计。
- **安全护栏**（写进代码 + 测试）：
  - **R1 防误合并**：`maxSessionsPerTask`（默认 20）—— 单任务跨过的 sessionId 数超阈值即整段丢弃。
  - **R2 性能**：模式指纹集合从 364 → 579，cron 每日聚合仍 <1s（实测）。
  - **R3 噪声**：参数签名仍生效（detector 层用），单纯工具序列相同但参数结构不同的不视为同一模式。
  - **运行时可改**：`cross_session_*` 三键已加进 `RUNTIME_CONFIG_KEYS`（2026-09-17 解封），但当前 model-visible 工具没暴露 `autocreate_config`，改档需改 `DEFAULT_CONFIG.default`（回 off 改一行即可）。
- **元数据扩展**（仅跨会话任务有，旧实现无）：
  - `sessionIds: string[]`：参与本任务的所有会话 id（按出现顺序去重）
  - `firstSeenAt / lastSeenAt: ISO string`：替代 `startedAt/endedAt` 的可读格式
  - `occurrenceSource: 'cross_session'`：标记
- **数据论证**（2026-09-17 离线回放）：
  - 数据源：`~/.dsh/storages/agint_tool_stats.jsonl`（9088 条 / 140 会话 / 13.54 天）
  - 旧实现跨过 `min_occurrence_count=3` 门槛：**11** 个模式
  - 跨会话：**21** 个模式（**+91%**）
  - ≥5 高频段：2 → 9（**+350%**）
  - 完整结果：`D:\DSH\.tmp\replay-aggregate.result.json`、脚本 `D:\DSH\.tmp\replay-aggregate.mjs`
- **新增单测**：`test/aggregator-cross-session.test.mjs`（**10 例**，含真实回放 fixture）。
  - 全量：**23/23 PASS**（旧 13 + 新 10）。
- **改动文件**：
  - `lib/aggregator.js`：新增 `aggregateTasksCrossSession` + `diffTasks`；改 `aggregateTasks` 加 `mode` 分发
  - `lib/schema.js`：新增 3 个配置项；扩展注释 + 锁定不在 runtime 暴露
  - `CHANGELOG.md`：本条目

### 0.3.5 已知限制

- **detector.js 还没接**：跨会话任务进了 `tasks[]` 数组，但 `detector.js` 在 `min_occurrence_count` 判定时仍按 `(toolSeq, paramSig)` 指纹分组——这一层**已经能正确把跨会话任务合并计数**，但**没读** `sessionIds` 字段做"是否真跨会话"的可信度加权。本期先把 aggregator 落地，detector 增强下个版本做。
- **影子期不自动跑**：`mode='shadow'` 的开关已就位但 cron 没自动切。老板拍板后人工改 `cross_session_aggregation: 'shadow'` 上线观察 1 周，再切 `primary`。

## 0.3.4 (2026-09-13) — 评估层语义准入 + 候选命名类级约束（P2-2 §六ter 建议 A + C）

- **补上「防垃圾」这半边**：quality-static 技能向四族（`skill-format` /
  `dangerous-command` / `secret-scan` / `prompt-hijack`）**只问「危不危险」，
  不问「这东西值不值得固化」**。Phase 1 现在有两段：quality-static（安全/格式）
  ＋ 新增 `lib/semantics.js`（语义），findings 同格式合并后统一判 blocker。
- **建议 A —— 语义四条**（规则直接来自 Hermes `_DO_NOT_CAPTURE_BLOCK`）：

  | # | 规则 | 级别 |
  | - | --- | --- |
  | 1 | 环境依赖失败、同段落无修复步骤 → **只许沉淀"怎么修"，不许沉淀"它坏了"** | warn |
  | 2 | 对工具能力的负面断言（X 不能用/不支持）**且无版本或条件限定** → 会硬化成模型引用数月的自我拒绝 | **blocker** |
  | 3 | 瞬时错误（错误码/堆栈）同段落无应对动作 → 自愈后就忘掉 | warn |
  | 4 | 声称"推荐/最佳实践"但关联模式成功率低于门槛 → **不许把没解决的失败包装成成功经验** | **blocker** |

- **建议 C —— 候选命名类级约束**（Hermes 判据：*"If the proposed name only makes sense for today's task, it's wrong."*）：命中 `fix-` / `debug-` / `hotfix-` / `tmp-` / `todo-` / `wip-` 前缀、含日期、含 issue 号 → **blocker**。沿用既有 `skill-format` 族名，不自造第三套族。
- 新配置 `semantics_check_enabled`（默认 **true**）。**这里与 Hermes"更聪明的机制默认关"相反**：那是放大错误的（LLM 判断驱动），这个是拦错误的——防垃圾的门不该默认关。
- **为什么落在 autocreate 内部，而不是给 quality-static 加新族**：① 规则 4 需要
  `pattern.successRate`（autocreate 私有数据，quality-static 的 checker 只吃目录、
  拿不到）；② quality-static 被多方消费，加族会外溢；③ 输入本就是内存里的
  `skillDraft`，不必先物化成 SKILL.md 再读回来。
- **防误杀优先**：每条规则都配了反向用例——版本/条件限定豁免（"v0.8 之前不能用"
  不是永久断言）、同段有解法豁免（"command not found，需安装 jq" 值得留）、
  成功率达标或缺数据豁免（缺数据不猜）。错误码走白名单而非"大写字母串"，
  工具名支持中英文。
- 测试：新增 `test/semantics.test.mjs` **19 例**；全量 **129 PASS**。
- 改动/新增：`lib/semantics.js`（新）、`lib/evaluator.js`（Phase 1 合并 findings，
  新增 `semanticFindings` / `semanticCodes` 便于周复盘区分来源）、`lib/schema.js`（开关）、
  `test/semantics.test.mjs`（新）。**未动数据表结构。**

## 0.3.3 (2026-09-13) — 检测层成功率准入门（Hermes 对照 §六ter 建议 B）

- **堵住「把反复失败的固化成技能」**：`occurrenceCount` 达标只证明「经常发生」，
  不证明「做对了」——一个稳定失败的序列重复 3 次同样会跨过 `min_occurrence_count`，
  而它恰是最不该被沉淀的东西（Hermes 侧对应 `_DO_NOT_CAPTURE_BLOCK`：
  不许把没解决的过程包装成成功经验）。
- 新增成功率门：次数达标 **且** `successRate >= min_pattern_success_rate`
  才进 `newRepeat`（→ 发 `pattern-detected` / 判定可标准化 / 生成候选）。
- 新配置 `min_pattern_success_rate`（默认 **0.6**；传 `0` 可关闭退回旧行为）。
  数据缺失（`successRate` 非有限数）时**不放行、也不折算**——缺数据不编造，
  与「真实 > 讨好」同向。
- 被拦下的模式**照常入库**（可观测），并写审计 `pattern_blocked_low_success`
  （含 `successRate` / `occurrenceCount` / 阈值 / `toolSequence`）；
  `detect()` 返回值新增 `successRateBlocked` 计数。
  **拦截不是丢弃**：稳定失败的模式最该被看见（说明有工具或流程坏了），
  只是不该被固化成技能 → 走审计而非静默丢弃（防 K31 式静默空转）。
- 测试：detector 单测 6 → 13（新增 7 例：拦下 / 放行 / 边界 `>=` / 默认 0.6 /
  缺失不放行 / 关门 / `passesSuccessGate`）；全量 **110 PASS**。
- 改动文件：`lib/detector.js`（判定 + `passesSuccessGate` 导出）、
  `lib/schema.js`（配置项）、`lib/index.js`（传参 + 审计 + 返回值）、
  `test/detector.test.mjs`。**不改数据表结构**（FROZEN schema 未动）。

## 0.3.2 (2026-09-09 晚) — v0.3.1 紧急修复：autocreate_modify JSON Schema

- 修 v0.3.1 引入的 preset mount 失败：dsh loader 严格 JSON Schema 校验
  要求每个 `type:"object"` 显式声明 `additionalProperties`，`autocreate_modify`
  的 `skillDraft` 参数漏写导致整条 agint preset 挂载失败，UI 冒泡成
  "agentPresets/list failed: Failed to fetch"（实际是 mount 异常）。
- 永久护栏：新增 `test/schema-guard.test.mjs`（K19），扫描 `lib/tools.js`
  所有 `type:"object"` schema，缺 `additionalProperties` 直接 fail；附
  brace-balancing 状态机处理字符串/注释/嵌套。
- 测试 103 → 104 全 PASS。

## 0.3.1 (2026-09-09 晚) — 拍板 2 改口：不接入中间环节，全自动发布

- `require_human_approval_until` 默认 `null`（原 2026-10-07）：门 2 人工确认窗默认关闭，
  候选过 policy 门 + 周预算即自动挂载，事后由外部日报汇报（不再等 autocreate_release 点头）。
- 逃生通道保留：运行时把 `require_human_approval_until` 设为未来时间（或
  `require_human_approval=true`）即可重新开窗，代码无需改。
- 新增默认语义测试（DEFAULT_CONFIG 无确认窗 + 显式开窗仍有效）；测试 102 → 103。

## 0.3.0 (2026-09-09) — Sprint 16 发布层（设计稿 §3，老板拍板 3 项）

**P0-1 全链路收口**：检测 → 评估 → 发布 → 观察 → 回滚全自动闭环（M3）。

### 新增：`lib/release-manager.js`

- **三道门**（全过才落盘，任何一道不过 → 候选停 `BUDGET_WAIT` + `release-held` 事件）：
  1. `release_enabled` 总开关（auto/manual 都拦）；
  2. 人工确认窗：`require_human_approval=true` 或 `now < require_human_approval_until`
     （拍板 2：默认开到 **2026-10-07**，`manual=true` 绕过）；
  3. policy 门：同步问询 `agint.qualityPolicy.decide`，仅 `AUTO_DEPLOY` 放行，
     ABSTAIN / PENDING_REVIEW / REJECT / 超时（5s）/ 异常一律 **fail-closed**（manual 也不绕）；
  4. 周预算：`weekly_deploy_budget`（默认 3），**回滚也算消耗**（`manual` 绕过）。
- **原子落盘**：staging 物料 → `skills_root` 先写 `.tmp-<ts>` 再整目录 rename
  （同盘原子；watcher 自动发现——Sprint16 设计稿 §1.2 源码级核实：无需重启 dsh、
  无需改 agent.cordis.yml）。重名硬防线 + 发布后自检。
- **观察期**（数据源 = tool-stats 的 `skill` 工具调用，零新采集）：
  窗满 14 天 + ≥5 次调用 → `STABLE`；最近 3 个 3 天子窗 0 调用 → 自动回滚；
  窗满不达标 → 展期一次（`extensions≥1` 后仍不达标 → 回滚）；
  **tool-stats 数据源失效 → 顺延判定不回滚**（09-09 停摆排查教训落地）。
- **回滚**：目录归档 `rollback_archive_dir`（只归档不删除）+ candidate/release
  标记 `ROLLED_BACK` + **30 天冷却**（同名禁重发，防振荡）。
- **记忆固化**：发布成功 → evolution-memory `addSuccess`（软依赖，失败不阻断）。
- 5 个新事件：`released` / `rolled-back` / `budget-exceeded` / `release-held` / `release-stable`。

### 变更

- `modifyCandidate`：`QUEUED_FOR_RELEASE`/`BUDGET_WAIT` 状态修改草稿 →
  回 `PENDING_EVAL` 重跑评估（防人工改动引入未评估内容直接挂载）。
- releases 表收紧：新增 `releasedBy`（auto/human）+ `budgetWeek`。
- 配置新增：`release_enabled` / `release_policy_timeout_ms` /
  `require_human_approval_until`（默认 2026-10-07）/ `observation_min_calls`（5）/
  `rollback_window_days`（3）/ `rollback_zero_call_windows`（3）/
  `rollback_cooldown_days`（30）/ `skills_root` / `rollback_archive_dir`；
  `observation_period_days` 默认 7 → **14**（拍板 3）。
- 新 preset 工具 4 个：`autocreate_release` / `autocreate_rollback` /
  `autocreate_list_releases` / `autocreate_modify`（write 类均走 agint-rules 门禁）。
- cron 新 job 2 个（agint-cron）：`skill-autocreate-release`（daily 05:15）+
  `skill-autocreate-observe`（daily 05:30）。
- 测试 102/102 PASS（新增 `test/release.test.mjs` 17 用例：三道门各分支 /
  重名防御 / 回滚归档 / 冷却 / 观察期四分支 / modify 重评）。

## 0.2.1 (2026-09-09) — 补齐 [4] 可标准化判断 + 修 [5] 模板工具名错配

2026-09-09 门槛离线回放时发现的**两处链路断裂**（详见
`docs/operations/p0-1-detector-replay-20260909.md` §7 及
`docs/operations/p0-1-standardizable-20260909.md`）。

### 新增：`lib/standardizable.js`（设计稿 §3.1 [4]，此前整段缺失）

- `judgeStandardizable(pattern, opts)` → `{ standardizable, confidence, route,
  rootCause, reason, signals }`
- **双轨判定**：
  - 轨道 A（diagnosis 归因）：需 `failureEvidence` + `diagnosis.classify`。
    **当前不激活**——aggregator 只落 `successRate`、不聚合 `errorKind`，
    且 `agint-diagnosis` v0.6.0 只暴露需要 `failureId` 的
    `annotate`/`counterfactual`。接口已预留。
  - 轨道 B（启发式，默认）：硬否决 + 正向信号打分。
- **硬否决**（`standardizable: false`，明确低价值，不需人工）：
  `EMPTY_SEQUENCE` / `TOO_FEW_STEPS` / `TRIVIAL_SINGLE_TOOL` /
  `META_TOOL` / `NO_PARAM_STRUCTURE`
- **软判定**（`standardizable: null`，证据不足 → 需人工，写周复盘）：
  `LOW_CONFIDENCE`
- 元工具黑名单：Agent 自我运维动作（自指红线 §9.4）。
  `rule_check` **不在**其中——它是业务输入环节，做成 `rule_` 前缀会误杀
  「先查规范再执行」这类真实流程（回放实测确认）。

### 修复：`lib/templates.js` 工具名归一化（[5] 此前 100% 落空）

- 模板 `requiredTools` 用设计稿抽象名（terminal / file_read / file_write），
  而生产 tool-stats 记录宿主真实工具名（pwsh / read / write / edit / glob /
  grep / ssh_exec…）。两者零交集 → `selectTemplate()` 在**全部真实模式上
  恒返回 null** → 即使过了 [4] 也产不出候选。
- 加 `TOOL_CANONICAL_MAP` / `canonicalTool()` / `canonicalToolSet()`：匹配前
  归一化，渲染（`renderBody`）仍用原始工具名，信息不丢。

### 变更：pipeline 接入

- `index.js` `detect()`：跨门槛 pattern **先过 [4] 再进 [5]**，判定结果
  （含被拒）**一律回写** `task_patterns.standardizable /
  standardizableConfidence`，供周复盘直接扫表。
- 被拒时写 `audit_log`（`standardizable_rejected` / `standardizable_uncertain`）。
- `detect()` 返回新增 `standardizable: { judged, pass, rejected, uncertain }`。

### 新增配置（均带默认值，`config: {}` 无需改动即可生效）

- `standardizable_min_steps`（默认 2）
- `standardizable_min_distinct_tools`（默认 2）
- `standardizable_route`（`auto` / `on` / `off`，默认 `auto`）

### 测试

- 新增 `test/standardizable.test.mjs`（18 项）、`test/template-alias.test.mjs`（6 项）
- 含设计稿 §14.2 的 **50 个已知模式准确率验证**（25 通过 + 25 拒绝，50/50）
- 含**生产回放 7 个真实模式 → 7/7 被拒**（唯一有独立 ground truth 的子集）
- 全量测试 **78/78 PASS**

### 已知局限（诚实标注）

- 50 模式集是**按规则设计的回归集**，不是独立 ground truth；用它的 100%
  不代表真实准确率（目前无任何已发布自动创建技能可当标注样本）。
- 补完 [4]+[5] 后，**生产当前数据下产出仍为 0**——瓶颈已从代码转移到
  数据量（tool-stats 自 09-08 14:50Z 后无新记录，日记录量持续衰减）。

## 0.2.0 (2026-09-08) — Sprint 15 P0-1 评估层（T1–T8）

用户 2026-09-08 拍板（设计稿 §12 五问全定，Q1=A 保 P0-1+P0-2），提前启动
Sprint 15 第一项 P0-1 评估层。A 路径分流评估：复用 D-QAF 执行层但**不复用
综合分决策**（新候选 composite 恒 71.4 < pendingReview 75 的语义错配，§3）。

### 新增

- **`lib/staging.js`（T1）**：候选物化 `$DSH_HOME/storages/agint_skill_autocreate/
  staging/<candidateId>/`（SKILL.md + manifest.json + scripts/），幂等重建；
  TTL 7 天兜底清理（`cleanupStale`）；candidateId 白名单防路径穿越
- **`lib/evaluator.js`（T3）**：`evaluateCandidate()` 三阶段编排
  - Phase 1 静态准入：`qualityStatic.checkPlugin`（真实 10 族，skill-candidate
    profile 组合）→ blocker ⇒ REJECTED_STATIC
  - Phase 2 沙箱门：有 scripts/ 走 `qualitySandbox.runSmoke`（实测通过 ⇒ E1，
    失败 ⇒ REJECTED_SANDBOX）；无可执行物 ⇒ skipped（不标 pass，E0）
  - Phase 3 硬门 + 排序：硬门 = Phase1 无 blocker ∧ Phase2 未失败 ⇒
    PHASE3_PASS（provisional / compositeTrusted:false）；综合分只记录不决策；
    `rankingScore = 0.5×收益均值 + 0.3×min(1,频次/10) + 0.2×(1−harm)`；
    evaluate 抛错 ⇒ REJECTED_EVAL（可重试）
- **`lib/similarity.js`（T5）**：归一化编辑距离去重（与 `skills.list()` 比对，
  相似度 ≥ `dedup_similarity_threshold`(0.9) ⇒ REJECTED_STATIC dedup）
- **`triggerEval()`（T4）**：状态机 PENDING_EVAL → PHASE1_PASS →
  PHASE2_PASS（skipped 不落）→ PHASE3_PASS / REJECTED_STATIC /
  REJECTED_SANDBOX / REJECTED_EVAL（attempts+1 + cooldown，超
  `max_eval_attempts` 转人工）
- **proposals 表写入（§7.2）**：`rankingScore / evidenceLevel / provisional /
  status='QUEUED_FOR_RELEASE' / estimatedBenefit`（P0-2 策展人排序消费）
- **T7 evolution 写入**：Phase 3 通过时 `logPhase4({targetKind:'skill',
  decision:'PENDING_REVIEW', tags:['phase3-provisional',...]})`（枚举受限，
  见 lib/evaluator.js 注释）
- **工具（T6）**：`autocreate_trigger_eval`（write，门禁由 agint-rules 接管）、
  `autocreate_get_candidate`（read，详情含三阶段结果）、`autocreate_list_candidates`
  增强（evidenceLevel / provisional 过滤）
- **配置键（§7.3）**：`phase3_evidence_gate`(E0) / `eval_cooldown_days`(7) /
  `max_eval_attempts`(3) / `staging_ttl_days`(7) / `sandbox_timeout_ms`(30000)
- **测试**：`test/staging.test.mjs`(7)、`test/evaluator.test.mjs`(8)、
  pipeline 集成扩展 4 case（含 **T8 核心验收：零历史正常候选走完 Phase 1-3 →
  PHASE3_PASS，71.4 不死锁**，真实 quality-static checker + 真实 staging）

### 修改

- `lib/storage.js`：`proposalEntrySchema` 扩展 §7.2 字段
- `lib/index.js`：顶部注释 Sprint 14→15；`release/rollback` 仍显式抛
  not implemented（Sprint 16 发布层接力）；stats.sprint → `15-eval-layer`

## 0.1.1 (2026-09-07)

Sprint 14 §2.1 D2：数据源隔离（与 `agint-curator` 配套，防 curriculum 挑战调用污染检测）。

### 修改

- `schema.js` 新增 `EXCLUDED_DATA_SOURCES` / `DATA_SOURCE_BLACKLIST_VERSION` /
  `isExcludedRecord()`（D4 三处副本之一；curator 侧 `const-consistency.test.mjs`
  自动扫描比对）。
- `aggregator.js`：`aggregateTasks()` 丢弃黑名单记录（sessionId 前缀
  `curriculum-`，或未来 `source === 'curriculum'`），返回值新增 `excluded` 计数；
  `detect()` 结果透出该计数。
- 向后兼容：无 `sessionId`/`source` 字段的旧记录照常处理，行为零变化。

### 测试

- 新增 `test/datasource-filter.test.mjs`（5 项）：前缀过滤 / 只靠挑战重复 3 次
  不成模式 / source 标签 / 旧记录兼容 / 常量形状。套件 34 → **39 PASS**。

---

## 0.1.0 (2026-09-07)

Sprint 14 检测层初版（设计稿：wiki/设计-P0-1-技能自动创建机制.md v0.1-draft）。

### 新增

- Service `agint.skillAutocreate`：detect / listPatterns / listCandidates /
  getCandidate / rejectCandidate / modifyCandidate / stats / pause / resume / config。
- 检测管线：aggregator（任务实例聚合 + 参数签名 v1）→ detector（序列全等 +
  参数 Jaccard 相似度 ≥0.8 + 累计 ≥3）→ proposer（纯模板 SKILL.md 草稿 +
  启发式收益预估）。
- 技能模板库：shell-automation / file-processing / api-calling /
  report-generation / code-lint / git-workflow（设计稿 §7.1 全 6 个）。
- 存储域 `agint_skill_autocreate`（5 表：task_patterns / candidates /
  proposals / releases / audit_log；后两者 Sprint 15/16 写入）。
- 事件：skill-autocreate.pattern-detected / candidate-created（软依赖
  event-bus）。
- preset 只读工具：autocreate_list_patterns / autocreate_list_candidates /
  autocreate_stats。
- 自我评估禁止（§9.4）：自我指涉草稿不生成、不可经 modify 注入。

### 关联修改（现有插件，均为加法）

- agint-cron：jobs.js 新增 `skill-autocreate-aggregate` job（daily 04:45，
  插件未挂载时 soft-skip）；index.js services map 增补 `agint.skillAutocreate`。

### 明确未实现（绝不静默）

- triggerEval / release / rollback → 抛「Sprint 15/16 交付」。
- diagnosis 可标准化判断 → standardizable 恒 null。
- D-QAF Phase 1-3 评估、灰度发布、观察期回滚 → Sprint 15/16。
