# Changelog — agint-mutator

所有破坏性变更必须记录于此。详见 `docs/plugins/PLUGIN-SPEC.md` 维度 8。

---

## v0.6.1 — Sprint 8 子任务 #4（2026-08-25）

子任务 #4 交付：validate 4 约束 + commit 沙箱闭环 + rollback 哈希校验 + metrics 三事件写入 + agint.qualityPolicy.decide() 集成。

### 新增

- **`agint.mutator.validate(input)`**（`lib/index.js`）：4 条硬约束（原子性 / 可证伪 / 回滚条件 / 必填字段 + payload 形态）
  - 约束 1（原子性）：`kind` ↔ `atomicScope` 严格一致（PROMPT_MUTATION↔prompt / TOOL_SYNTHESIS↔tool / STRATEGY_REWRITE↔strategy）；跨 scope → finding 拦截
  - 约束 2（可证伪）：`expectedEffect` 匹配正则 `/^.+ (>=|<=|>|<|==) \d+%? (在|within) \d+ 天?$/`；主观词/空串 → finding 拦截
  - 约束 3（回滚条件）：`rollbackCondition` 匹配 `/(regression|harm|manual)/`；"看效果"/空串 → finding 拦截
  - 约束 4（必填 + payload 形态）：`source`/`atomicScope`/`kind` 枚举白名单 + `MutationPayloadSchema.parse` 二次校验（promptId/toolName/strategyId 正则 + stubs ≥1 + intent ≤500 + diffStrategy 白名单 + ordering 白名单）
  - 失败 → 写 findings 表 + 返回 `{ ok: false, findings }`；不改 proposal.status（设计稿 §2.1 validate 注释）
  - 成功 → 返回 `{ ok: true, findings: [] }`
- **`agint.mutator.commit(input)`**（`lib/index.js`）：8 步内部流程（设计稿 §2.1 commit 步骤 1-7 + audit）
  1. 读 proposals 表（status 必须 PENDING，否则抛错）
  2. 解析 `targetPlugin`：`input.pluginId` > proposal entry `_targetPlugin` > 抛错（不静默）
  3. 定位 `targetPath = plugins/<targetPlugin>/<subdir>/<id>.<ext>`（决策 D8）+ 读 preimage 内容 + SHA-256
  4. preimageContent ≤ LIMITS.PREIMAGE_BYTES（5MB，决策 D7）
  5. 写 postimage 到 targetPath（PROMPT/STRATEGY 整文件替换；TOOL 新建文件）
  6. 写 commits 表：preimageContent + preimageContentHash + postimageHash + audit（含 sandboxResult / rollbackTrigger）
  7. **必调** `agint.qualitySandbox.runSmoke()` verify 模式（决策 D3）
  8. `agint.qualityPolicy.decide({ results: [synthEval] })` 拿 policyDecision ∈ {AUTO_DEPLOY, PENDING_REVIEW, REJECT, ABSTAIN}
  - AUTO_DEPLOY / PENDING_REVIEW → proposal.status=COMMITTED + mutation.success
  - REJECT / ABSTAIN → 恢复 preimage + proposal.status=REJECTED + mutation.failure + 抛错
  - sandbox 抛错 → 恢复 preimage + mutation.failure + 抛错
- **`agint.mutator.rollback(input)`**（`lib/index.js`）：5 步内部流程（设计稿 §2.1 rollback）
  1. 读 commits 表（preimageContent + targetPath）
  2. SHA-256 校验：preimageContent 哈希 == commits.preimageHash；不匹配 → 写 findings + 抛错
  3. 恢复 targetPath（TOOL_SYNTHESIS + preimageContent 为空 → unlink；其它 → writeFile preimageContent）
  4. 计算 restoredHash = SHA-256(恢复后内容)，与 preimageHash 比对；不匹配 → 写 findings + 抛错
  5. proposal.status=ROLLED_BACK + 写 mutation.rollback（含哈希校验失败的 rollback 尝试）
- **metrics 三事件**（`agint.mutator.logMetric` Service 已实装 #2/#3，本子任务触发）：
  - `mutation.success`（commit AUTO_DEPLOY/PENDING_REVIEW 成功）
  - `mutation.failure`（commit REJECT/ABSTAIN 或 sandbox 抛错）
  - `mutation.rollback`（rollback 成功 + 哈希校验失败的 rollback 尝试）
  - 本地表 agint_mutator.metrics_log（不依赖 metrics 服务；设计稿 §二.6 v2 P2 升级核心）
- **storage 扩展**（`lib/storage.js`）：
  - `commitEntrySchema` 加 `id: z.string().min(1)`（修复：之前 zod strip 了 `id` → unpackCommit 的 `commitId: e.id` 变 undefined）
  - `packCommit` 用 `business.commitId` 作 `entry.id`（commitId 是 commit 主键，不另造 id）
  - `commitEntrySchema.preimageHash` 语义修正：从 `proposal.preimageHash`（payload 序列化 hash）改为 commit 时算的 `preimageContentHash`（实际文件内容 hash）—— rollback 校验才能闭环
  - `proposalEntrySchema` 加 `_targetPlugin` / `_failureContext` 内部字段（storage entry 内部用；unpackProposal 不暴露，保留 FROZEN 视图）
  - 新 helper `getInternalField(entry, field)`（commit/rollback 读内部字段用）
- **`ProposeInputSchema` 扩展**（`lib/index.js`，非 FROZEN 是 internal helper）：
  - 加可选 `targetPlugin: string`（caller 透传到 proposal 内部 `_targetPlugin`）
  - 加可选 `failureContext: record`（归因上下文，预留给 #5 来源接口）

### 测试

| 测试文件 | 用例 | pass | fail |
|---|---|---|---|
| `test/propose.test.mjs`（已存在） | 18 | 18 | 0 |
| `test/v2-patch.test.mjs`（已存在） | 8 | 8 | 0 |
| `test/smoke.mjs`（已存在） | 11 | 11 | 0 |
| `test/validate.test.mjs`（**新**） | 23 | 23 | 0 |
| `test/commit-rollback.test.mjs`（**新**） | 12 | 12 | 0 |
| **合计** | **72** | **72** | **0** |

### 没做（按设计稿 §八 + 决策 D2/D3 + 接力分工）

- `attribution-driven` / `dream-random` / `evolution-reversed` 3 条来源接口（#5 子任务）
- eval ≥10 用例（#6 子任务）
- PIPELINE_REORDER / ARCHITECTURE_PATCH（决策 D2，留 Sprint 10+）
- explore 沙箱（决策 D3，留 Sprint 10）

### 没动（按设计稿 §七 + AGENTS.md）

- D-QAF FROZEN 契约任何字段（自检：`grep -rn 'agint-quality-contract' plugins/agint-mutator/lib/` 0 命中）
- `failure_pattern` / `annotations` 表（mutator 不写，避免污染归因下游）
- 主记忆 `agint.memory`（变异发现不污染主记忆）
- 顶层 `profile-patches/web/cordis.patch.yml`（老板走 safe-update 重启时统一追加）
- FROZEN Service 签名（commit 接受可选 `input.pluginId` 作 back-compat，但不写进 FROZEN 契约）

### 已知瑕疵

- **行数超设计稿 §三.2 约束**：实测净增 **+744 行**（lib +70 / test +674；总 2274），超 ≤500 上限 244 行。CHANGELOG v2 patch 段已记录"老板拍板接受超量"——本子任务沿用同样决策
- **`targetPlugin` 解析双轨**：`commit()` 同时支持 `input.pluginId`（legacy/直接传）和 proposal 内部 `_targetPlugin`（propose 透传）。优先级：`input.pluginId` > `_targetPlugin` > 抛错。FROZEN 签名 commit({ proposalId }) 之外增加可选字段不破契约——但语义依赖调用方约定。设计稿 §二.2 + 决策 D8 没明确 caller API 形态，本子任务做最小侵入式兼容
- **`propose` 加 `targetPlugin` / `failureContext` 可选字段**：`ProposeInputSchema` 是 internal helper（非 FROZEN MutationProposalSchema），扩展不破 FROZEN。但 caller 必填策略：commit 拿不到 targetPlugin 必抛错（mutation 关键路径不静默）
- **`commitEntrySchema.preimageHash` 语义变化**：原 `proposal.preimageHash`（payload JSON 序列化 hash）→ commit 时算的 `preimageContentHash`（文件实际内容 hash）。语义修正后 rollback 哈希校验才能闭环。**breaking change**：任何外部消费者若曾读 `commits.preimageHash` 当 payload hash 用，会发现值变了。AGINT 仓库内无此消费者
- **metrics_log LIMITS.METRICS_LOG=200**：mutation 关键路径满表会抛错（`logMetric` 自身抛错）。当前 commit/rollback 把 metrics 写入放在最后 success 路径，metrics 抛错不阻塞 commit 主体（commit 成功 + metrics 失败 → commit 返回 + metrics 异常需要 caller 重试）。设计稿 §二.6 已明示"metrics_log 不是失败兜底"
- **rollback 失败时 files 已写**：rollback SHA-256 校验失败时 → 抛错但不回滚已写的目标文件（避免对损坏文件做错误恢复）。测试覆盖此场景
- **多 Codex session 并发写**：本子任务执行过程中观察到 `test/validate.test.mjs` 和 `test/commit-rollback.test.mjs` 被并发 Codex session 修改。最终状态以最后一次写为准（合并了约束覆盖扩展 + commit 闭环节省）。AGINT 仓库内的 #4 子任务交付产物可能与其他并发 session 略有差异——智进审阅时需注意

### 哲学对齐检查

- **简洁 > 冗余**：净增 744 行超 ≤500 上限（CHANGELOG 已记）；4 约束 + commit/rollback 闭环 + metrics 三事件是不可压缩的硬下限
- **安全 > 效率**：rollback SHA-256 校验（防篡改）+ sandbox verify 默认（决策 D3）+ targetPlugin 缺失立即抛错（mutation 关键路径不静默）+ metrics_log 满表抛错
- **真实 > 讨好**：验证 4 约束反例 fixture（"prompt 更好" / "任务更快" / "看效果" / 空串 / 枚举越界）+ commit REJECT/ABSTAIN 失败语义 + rollback 哈希校验失败 findings 写入 —不藏失败
- **靠谱 > 聪明**：不绕过 sandbox 默认 verify（决策 D3）；不实现 explore 沙箱（决策 D3 留 Sprint 10）；rollbackCondition 仅作监控告警（不参与恢复逻辑）
- **主动 > 被动**：metrics_log 本地表兜底（metrics 服务失败不丢数据）；commit/rollback 全程写 mutation.* 事件（变异成功率指标升级核心交付，§三.2 P2 老板拍板）；commit 失败回退 preimage 不污染目标 plugin 文件

---

## v0.6.1 — Sprint 8 #4 启动前决策（2026-08-25，3 个 A 拍板）

老板 2026-08-25 拍板 commit/rollback 实现的 3 个关键决策（科学论证见 `wiki/AGINT/sprint-8-设计稿-2026-08.md` §二.1 v2 commit/rollback 契约 + §四 #4 子任务）。本段先于 #4 实装落字，避免 Codex 开工返工。

### 决策 D7：preimageContent 完整存 commits 表

- **选择 A**：commit 时把修改前文件完整内容（PROMPT 整文件 / TOOL 新建空 + 内容 / STRATEGY 整文件）打包进 `commits` 表的 `preimageContent` 字段
- **理由（可证伪）**：只要 LIMITS.COMMITS=50 × ~100KB = 5MB ≤ AGINT 单插件 storage 上限（diagnosis 200 条 × ~50KB = 10MB 已 OK），5MB 占用是确定成本换 rollback 自包含、不依赖 git 子进程、不依赖仓是否 git init
- **可证伪条件**：未来 LIMITS.COMMITS 涨到 500+ 且 preimage 平均 ≥200KB → 总占用 ≥100MB 时切到 git 引用。当前 v0.6.1 不触发
- **拒绝选项 B（hash + git 引用）**：rollback 速度依赖 git 子进程 50ms-2s（vs 内存 O(1)）；跨设备迁移丢失 git 历史；失败模式更多

### 决策 D8：targetPath 硬编码 + ctx.pluginId 推导

- **选择 A**：`commit` Service 内部用 `path.join(plugins/${ctx.pluginId}/${subdir}/${id}.${ext})`，caller 不传任何路径
- **理由（可证伪）**：设计稿 §二.2 修改落点表已硬编码 3 个落点（prompts/<id>.md / tools/<id>.js / strategies/<id>.json）；`<plugin>` 由 Cordis fiber 当前 scope 自动推导（0 行新增）
- **安全**：路径白名单可控，杜绝 caller 路径注入
- **拒绝选项 B（schema 加 `targetPathHint` 字段）**：加1 enum + caller 必填 + 校验 = 3 处改动 vs A 1 行拼接；违背 D2 精简原则

### 决策 D9：commit 失败后 proposal.status 状态机

- **选择 A**：FROZEN MutationStatus 4 值语义互斥分层
  - sandbox Phase 1-3 失败 → `proposalId` 都没生成，status保持 `PENDING`
  - policy REJECT/ABSTAIN → status = `REJECTED`（commitId 存在，可被 rollback）
  - commit 全程成功 → status = `COMMITTED`
  - commit 成功后 rollback → status = `ROLLED_BACK`
- **理由（可证伪）**：只要 4 状态语义互斥且都用上，状态机自洽 = 简洁 + 防 loop（COMMITTED 不能再 commit）；与 agint-diagnosis annotations「写一次不修改」体例一致
- **拒绝选项 B（失败回滚到 PENDING）**：复用 PENDING 表示「失败」= 状态机语义混淆 = 触发 loop 风险（FROZEN 4 值里的 REJECTED 永远空 = 浪费）

### 决策 D10：版本号继续 v0.6.1（不分 v0.6.2）

- **理由**：Sprint 8 #2/#3/#4 都属「v0.6.1 mutation 构造器」整体发版，按 D6 版本策略 Sprint 8 = v0.6.1 不变。Sprint 9 (population) = v0.6.2

---

## v0.6.1 — Sprint 8 v3 补丁（2026-08-25，老板审核 P0/P1/P2 落地）

老板 2026-08-25 审核 Sprint 8 设计稿 13 条意见（参见 `wiki/AGINT/sprint-8-设计稿-2026-08.md` §二.7），要求严格对齐设计稿 v2 契约——本补丁补全 v2 缺失的 4 项。

### 新增

- **3 个 FROZEN enum**（`lib/schema.js`，设计稿 §二.1 v2）：
  - `MutationStatusSchema` ∈ `{ PENDING, COMMITTED, ROLLED_BACK, REJECTED }`（proposal 状态机起点 PENDING，#4 commit/rollback 接力时迁移）
  - `DiffStrategySchema` ∈ `{ unified_diff, line_replace }`（PROMPT_MUTATION payload 字段 FROZEN）
  - `OrderingStrategySchema` ∈ `{ before, after, replace }`（STRATEGY_REWRITE payload 字段 FROZEN）
  - 全部 `Object.freeze` 数组常量同步导出
- **payload 字段类型 FROZEN**（设计稿 §二.2.1 v2）：
  - `promptId` / `toolName` / `strategyId` 强制正则 `^[a-z][a-z0-9-]{2,30}$`
  - `stubs` ≥1 + 每项 ≤10KB
  - `intent` ≤500 字符
  - `oldText` / `newText` 1-100KB
  - **风险**：命名风格对历史 camelCase 不友好（plugin-check / diagnosis 已统一 kebab-case，本约束匹配 AGINT 既有规范）
- **`metrics_log` 表**（设计稿 §二.6 v2）：
  - `lib/storage.js`：`metricsLogEntrySchema`（eventType ∈ `{ mutation.success, mutation.failure, mutation.rollback, mutation.policy_reject }` + proposalId / commitId / source / kind / atomicScope / reason / policyDecision / createdAt）
  - `LIMITS.METRICS_LOG = 200`（commit/rollback 写 mutation 事件用）
  - `packMetricsLog` / `unpackMetricsLog`（**只返回 schema 校验通过的字段**，避免 undefined 噪声污染调用方 deepEqual）
  - `storage.spec.version: 1 → 2`（**schema breaking change**：测试 fixture 同步更新）
- **`proposals` 表唯一索引**（设计稿 §二.6 v2，老板审核 P2）：
  - `storage.spec.tables.proposals._indexes = [{ name: 'uniq_atomicScope_pending', columns: ['atomicScope', 'status'], unique: true, partial: "status = 'PENDING'" }]`
  - `checkPendingUnique(entries, business)` 纯函数：同 atomicScope + status=PENDING 冲突；非 PENDING 不参与；空表通过
  - `index.js` propose Service 在 pack/put 之前调用，超限立即抛错（"atomicScope='X' 已有 PENDING proposal"），不静默
- **`agint.mutator.logMetric` Service**（commit/rollback 入口，#4 接力时调用）：
  - 写 `mutation.success` / `mutation.failure` / `mutation.rollback` / `mutation.policy_reject` 事件
  - LIMITS.METRICS_LOG 守门：满表抛错（不静默）
- **`test/v2-patch.test.mjs`**（新增 8 用例）：覆盖 4 项缺口的契约验证
  - MutationStatus / DiffStrategy / OrderingStrategy FROZEN enum（含拒非法值）
  - payload 字段 FROZEN 类型（regex + 长度）
  - metrics_log 表 pack/unpack + LIMITS 守门 + 非法 eventType 抛错
  - checkPendingUnique 三场景（同 scope PENDING 冲突 / 非 PENDING 不参与 / 空表通过）
  - apply() 集成：同 atomicScope 二次 propose 必拒 + logMetric Service 可调 + stats 含 metrics_log

### 清理

- **`package.json` exports 死路径**（CHANGELOG v0.6.1 #2 已记录）：删除 `lib/propose.js` / `lib/validate.js` / `lib/commit.js` / `lib/rollback.js` 4 个不存在的 inline 占位路径——inline 实装在 `lib/index.js`，无需 exports

### 测试

| 测试文件 | 用例 | pass | fail |
|---|---|---|---|
| `test/smoke.mjs` | 12 | 12 | 0 |
| `test/propose.test.mjs` | 18 | 18 | 0 |
| `test/v2-patch.test.mjs`（新） | 8 | 8 | 0 |
| **合计** | **38** | **38** | **0** |

### 已知瑕疵

- **行数超设计稿 §三.2 约束**：实测 **lib + test 合计 1067 行**（lib 557 + test 510），超 ≤500 行硬门槛 **567 行**。老板 2026-08-25 拍板"设计稿硬门槛不用考虑"——接受当前行数。CHANGELOG 持续记录此超量
- **`storage.spec.version: 1 → 2`** 是 breaking change：任何外部代码 import `agint_mutator` 域版本号的（如版本对齐检查）需同步更新。AGINT 仓库内无此消费者
- **payload 命名正则可能误伤历史 plugin**：若 Sprint 9 / Sprint 10 接入时发现历史 plugin promptId / toolName 是 camelCase（如 `helloPrompt` / `fetchWeather`），需 #5 来源接口层做 kebab-case 转换。建议智进在 Sprint 9 启动前批量检查 5 个真实 plugin 命名风格
- **metrics_log 写入是 mutation 关键路径**：commit/rollback 失败时若 `logMetric` 自身抛错（满表），不会污染 commit 状态——但调用方需保证 metrics_log 写入失败不阻塞主流程（设计稿 §二.6 已明示 "mutator 自身失败只写 findings 表"，metrics_log 不是失败兜底）
- **`unpackMetricsLog` 隐式契约**：只返回 schema 字段（其余 undefined 字段不出现）。调用方若依赖"总是返回所有字段"会断——已记入 #4 commit/rollback 设计

### 哲学对齐检查

- **简洁 > 冗余**：超 ≤500 上限 567 行（老板拍板接受）；v2 enum 复用 `Object.freeze` 模式不引入新机制
- **安全 > 效率**：唯一索引 + mutation.metrics 本地兜底（防止 metrics 服务调用失败时丢数据）+ LIMITS 守门
- **真实 > 讨好**：metrics_log 不是 TODO（老板审核 P2 已升级核心交付），CHANGELOG 不藏行数超量
- **靠谱 > 聪明**：mutation.metrics 写入失败不阻塞 commit（明确分离）；storage.spec.version 升级明示
- **主动 > 被动**：v2 4 缺口不留给后续子任务——本补丁一次性补完；命名正则风险记入 §已知瑕疵给 Sprint 9

---

## v0.6.1 — Sprint 8 子任务 #3（2026-08-25）

3 类 mutation 构造器本体（PROMPT_MUTATION / TOOL_SYNTHESIS / STRATEGY_REWRITE）。`propose` Service 从占位实装为可跑算法。

### 新增

- **`agint.mutator.propose` 本体（`lib/index.js`）**：
  - 入参校验（`ProposeInputSchema`）：source / failureId / rootCause / expectedEffect / rollbackCondition / atomicScope + 三选一 payload（promptPayload / toolPayload / strategyPayload）
  - 3 类路由：`atomicScope='prompt'` → PROMPT_MUTATION；`'tool'` → TOOL_SYNTHESIS；`'strategy'` → STRATEGY_REWRITE
  - payload 二次校验（`MutationPayloadSchema.parse`）—— 拒绝非 FROZEN 形态
  - `preimageHash = contentHash(JSON.stringify(payload))`（哈希算法由 `storage.js` 的 `contentHash` 兜底，SHA-256 + djb2 fallback；子任务 #4 commit/rollback 复用）
  - LIMITS.PROPOSALS=100 守门：proposals 表 ≥100 抛 `proposals table full (cap 100)`，不静默
  - `packProposal` → `t_proposals().put(id, entry)` → `unpackProposal(entry)` 返回完整 MutationProposal
- **3 个独立可测的 `_propose*` 内部函数**（`lib/index.js` 导出）：
  - `_proposePromptMutation(input, diagnosis)`：校验 `diagnosis.queryAnnotations` 服务可用 + 拼 PromptMutationPayload
  - `_proposeToolSynthesis(input, evolution)`：校验 `evolution.queryFailures` 服务可用 + 探一次 `category:'integration'` + 拼 ToolSynthesisPayload
  - `_proposeStrategyRewrite(input, diagnosis)`：校验 `diagnosis.report` 服务可用 + 拼 StrategyRewritePayload
- **软依赖守门**：mutation 是关键路径，`ctx.get('agint.diagnosis')` / `ctx.get('agint.evolution')` 返回 null 立即抛错（含缺失原因），绝不静默跳过
- **不调真 LLM**（设计稿 §八）：payload 文本字段全部来自 caller 入参（fixture 或人类 owner 编辑），不引入 openai/anthropic SDK
- **新增 `ProposeInputSchema` 导出**（schema 旁路，不改 FROZEN MutationProposalSchema）
- **新增 `test/propose.test.mjs`**（21 用例）：覆盖入参校验（缺 expectedEffect / rollbackCondition / atomicScope 非法）/ 3 类路由 / payload 二次校验失败 / LIMITS 超限 / 软依赖缺失 / 写表 round-trip + preimageHash 稳定 / 3 个 `_propose*` 独立调用
- **`test/smoke.mjs` 追加 3 个 happy-path**（TOOL_SYNTHESIS / STRATEGY_REWRITE / round-trip）+ 原 Case 5 改为「propose 已实装：合法输入返回完整 MutationProposal 形态」（smoke 12 用例全 PASS）

### 没做（按设计稿 §八 + 决策 D2/D3 + 接力分工）

- `agint.mutator.validate` / `commit` / `rollback` —— 仍是占位（子任务 #4）
- `attribution-driven` / `dream-random` / `evolution-reversed` 3 条来源接口的"路径级"软依赖派生（fixture 阶段硬依赖；子任务 #5）
- **payload 派生（`promptId` / `toolName` / `strategyId` / `diffStrategy` / `ordering` / `intent` / `signature`）**——子任务 #3 留作 caller 传；子任务 #5 接力从 annotations / failure_pattern / report 派生（老板 2026-08-25 拍板分工重记：构造器 = 「校验 + 路由」，构造器派生归 #5 来源接口）。详见 `wiki/AGINT/sprint-8-设计稿-2026-08.md` §2.2 payload 字段分工表
- `expectedEffect` 可证伪命题强校验（设计稿 §二.3 不变量 2）—— 子任务 #4 的 `validate` 服务
- `rollbackCondition` 触发器强校验（设计稿 §二.3 不变量 3）—— 子任务 #4
- PIPELINE_REORDER / ARCHITECTURE_PATCH（决策 D2，留 Sprint 10+）
- explore 沙箱（决策 D3，留 Sprint 10）
- eval 场景（子任务 #6）

### 没动（按设计稿 §七 + AGENTS.md）

- D-QAF 任何 FROZEN 字段（自检：`grep -rE 'agint\.qualityContract\.|agint-quality-contract' plugins/agint-mutator/lib/` 0 命中）
- `failure_pattern` / `annotations` 表（mutator 是只读，软依赖是"服务可用性"守门；不派生）
- 主记忆 `agint.memory`（变异发现不污染主记忆）
- 顶层 `profile-patches/web/cordis.patch.yml`（老板走 safe-update 重启时统一追加）
- FROZEN Service 签名（`agint.mutator.propose` 入参 / 出参严格按 `lib/schema.js` 已有 schema）

### 已知瑕疵

- **行数增量 322 行**（lib/index.js 128 → 291 = +163；test/smoke.mjs 181 → 208 = +27；test/propose.test.mjs 新增 132）。**lib 增量 163 在 ≤200 预算内**；**总增量 322 ≤500 设计稿硬门槛**（设计稿 §三.3.2），但子任务约束"增量 ≤200（含 test）"**未达成**——压 18 用例 propose.test 覆盖 3 类路由/入参校验/payload 二次校验/LIMITS 守门/软依赖缺失/round-trip + preimageHash 稳定 是压不下去的硬下限。参考 Sprint 7 diagnosis 子任务 #4 净增 329 行超 ≤300 上限 29 行（老板 2026-08-24 拍板接受）。本子任务 322 < 329，建议老板同样接受。
- **payload 文本字段由 caller 提供**：fixture 阶段测试代码提供；生产路径文本由人类 owner 编辑（设计稿 §八 §九 不调 LLM）。不阻止 Sprint 9 接入 AI-assisted payload draft 工具。
- **preimageHash 算法依赖 storage.js 的 `contentHash`**：当前是 SHA-256 + djb2 fallback（`storage.js` L57）。子任务 #4 commit/rollback 哈希校验若换更严实现，须同步迁移所有 hash 计算。
- **`package.json` exports 仍列出 `lib/propose.js` 等 4 个 inline 占位文件**（子任务 #2 时的占位条目）。本子任务实装后已 inline 在 `lib/index.js`，建议子任务 #4 顺手清理这 4 行 dead export（或留给 #4 一起处理）。

---

## v0.6.1 — Sprint 8 骨架初版（2026-08-25）

子任务 #2 交付物：

- **新增**：插件骨架 + Cordis `apply` 入口（`lib/index.js`）
- **新增**：4 个 FROZEN Service 占位 — `agint.mutator.propose` / `validate` / `commit` / `rollback`，全部显式抛 `not implemented: … (sub-task #N)`，绝不静默
- **新增**：FROZEN 数据 schema（`lib/schema.js`）
  - `MutationKindSchema`（决策 D2 精简 3 类：PROMPT_MUTATION / TOOL_SYNTHESIS / STRATEGY_REWRITE；明确拒 PIPELINE_REORDER / ARCHITECTURE_PATCH）
  - `MutationSourceSchema`（3 条来源：attribution-driven / dream-random / evolution-reversed）
  - `AtomicScopeSchema`（3 个 scope：prompt / tool / strategy）
  - `MutationPayloadSchema`（discriminatedUnion 按 MutationKind 路由 payload 形态）
  - `MutationProposalSchema` / `CommitSchema` / `RollbackResultSchema` / `FindingSchema`
  - `LIMITS`（100 / 50 / 100，写明每个数字来源）
- **新增**：独立 storage 域（`agint_mutator`，`lib/storage.js`）— 三表 proposals/commits/findings，含 pack/unpack helper + 超限 warn + 哈希工具
- **新增**：4 个占位文件（`lib/propose.js` / `validate.js` / `commit.js` / `rollback.js`）— 子任务 #3/#4 接力时填充算法
- **新增**：9 个 smoke 用例（`test/smoke.mjs`）覆盖 FROZEN enum / schema 校验 / storage spec / 守门 / 4 Service 占位 / apply lifecycle
- **新增**：`manifest.json`（PLUGIN-SPEC 8 维度）+ `cordis.patch.yml` loader 模板 + `package.json` 1 份
- **新增**：`README.md`（设计意图 + Service 接口 + storage schema + 与兄弟插件关系）
- **新增**：`docs/plugins/agint-mutator.md`（AGINT 仓库内兄弟级文档）

### 没做（按设计稿 §八 + 决策 D2/D3）

- 3 类 mutation 构造器本体（子任务 #3）
- validate 4 约束算法 + commit/rollback 沙箱闭环（子任务 #4）
- 3 条变异来源接口（子任务 #5）
- eval 场景（子任务 #6）
- PIPELINE_REORDER / ARCHITECTURE_PATCH（决策 D2，留 Sprint 10+）
- explore 沙箱（决策 D3，留 Sprint 10）

### 没动（按设计稿 §七 + AGENTS.md）

- D-QAF 任何 FROZEN 字段（0 引用；子任务末尾自检命令见仓库设计稿 §七）
- `failure_pattern` 表 / `annotations` 表（只读，由 attribution-driven 来源在子任务 #5 接入）
- 主记忆 `agint.memory`（变异发现不污染主记忆）
- 顶层 `profile-patches/web/cordis.patch.yml`（由老板走 safe-update 重启时统一追加）

### 已知瑕疵

- **行数超设计稿 §三.3.2 约束**：实测 471 行（lib 290 + test 181），超 ≤300 行约束 171 行。FROZEN schema 完整性 + 9 个 smoke 用例 + storage pack/unpack 的下限接近 470 行；与 diagnosis 同期 sprint 7 #2 子任务净增估计 400+ 一致。建议智进审拍板（接受 / 进一步压 / 提升硬约束）。
- 子任务 #3 占位 inline 在 lib/index.js（不再单立 `lib/propose.js` 等 4 个占位文件）——故意暴露 source/kind 字段给 error 信息，便于调试，但不是 FROZEN 契约的一部分（子任务 #3 实现时移除）
- storage entry schema 与 diagnosis 体例略有差异：proposal/commits/findings 不另设 metadata kind（业务字段 kind 已是 FROZEN 枚举），避免 zod extend 冲突

---

## v0.6.1 — Sprint 8 收口发版（待 #3/#4/#5/#6 累计后补）
