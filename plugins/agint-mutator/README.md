# agint-mutator

> v0.6.1 / Sprint 8 变异构造器（host service plugin）。
>
> 当前已交付：骨架 + FROZEN schema + storage 域装配 + 4 个 Service 占位（抛 `not implemented`）。3 类 mutation 构造器 / validate 4 约束 / commit 沙箱闭环 / 3 条来源接口由子任务 #3-#5 接力。

设计稿：`wiki/AGINT/sprint-8-设计稿-2026-08.md`

---

## Purpose

让 AGINT 在归因结果出来后，能自动构造「定向变异 / 随机变异 / 反向变异」三种策略的修改方案，进 verify 沙箱验证，让 Sprint 9 的种群管理器有「候选个体」可用。

> 核心洞察：没有变异能力，归因结果永远停留在「诊断」层面。变异是从「看见问题」到「解决问题」的桥梁。（设计稿 §一）

---

## 4 个 FROZEN Service 签名（设计稿 §2.1）

```js
agint.mutator.propose({ source, failureId, rootCause, expectedEffect, rollbackCondition, atomicScope })
  → MutationProposal
// source ∈ { 'attribution-driven' | 'dream-random' | 'evolution-reversed' }
// atomicScope ∈ { 'prompt' | 'tool' | 'strategy' }
// 占位实现，sub-task #3 接力：3 类 mutation 构造器（PROMPT_MUTATION / TOOL_SYNTHESIS / STRATEGY_REWRITE）

agint.mutator.validate({ proposal })
  → { ok, findings[] }
// 占位实现，sub-task #4 接力：4 条硬约束（原子性 / 可证伪 / 必填 / payload 形态）

agint.mutator.commit({ proposalId })
  → { ok, commitId, postimageHash }
// 占位实现，sub-task #4 接力：默认进 agint-quality-sandbox verify 模式（决策 D3），D-QAF Phase 1-3 通过才写 commits 表

agint.mutator.rollback({ commitId })
  → { ok, restoredHash }
// 占位实现，sub-task #4 接力：按 rollbackCondition 退回 preimageHash（哈希校验）
```

详细 schema：`plugins/agint-mutator/lib/schema.js`。

---

## FROZEN enum `MutationKind`（决策 D2 精简 3 类）

```
PROMPT_MUTATION | TOOL_SYNTHESIS | STRATEGY_REWRITE
```

**未做（决策 D2 写明原因）**：

- `PIPELINE_REORDER` — 调整 D-QAF 流水线顺序，牵涉 eval / policy / report 插件装载，按工作守则红线段是产线操作。Sprint 10（安全与性能收口）有 explore 沙箱后再说。
- `ARCHITECTURE_PATCH` — 插件间交互方式重构，超出 mutation 概念边界（mutation = 局部修改，架构 = 全局改写），更接近 meta-evolution。Sprint 10 以后或 P8 元进化讨论。

精简是「主动减负」（设计稿 §〇 决策 D2）—— 与路线图 line 335 列的 5 类对比，PIPELINE_REORDER / ARCHITECTURE_PATCH 的风险高于本 sprint 价值，不阻塞 Sprint 8 收口。

---

## 变异硬约束（D4 落地，子任务 #4 校验）

3 条不变量（`validate` 服务检查）：

1. **原子性**：payload 只影响 1 个 atomicScope（prompt / tool / strategy 三选一）。跨 scope 修改禁止。
2. **可证伪**：`expectedEffect` 必须是可被 D-QAF 验证的命题（含 target metric + 期望方向 + 验证窗口）。例：`"baseline-regression-suite 通过率 ≥95% 在 7 天内"`。禁止"更好/更快"这种主观命题。
3. **回滚条件**：`rollbackCondition` 必须含触发器（regression / harm 下降 / 手动）。禁止空字符串 / "看效果"。

---

## 变异来源（3 条路径，子任务 #5 接入）

| source | 触发条件 | 输入 | 输出 |
|---|---|---|---|
| `attribution-driven` | `agint.diagnosis.annotate` 返回 rootCause ∈ { PROMPT_DEFICIENCY, TOOL_GAP, PLANNING_FAILURE } | failureId + trajectory | 1 个定向 proposal |
| `dream-random` | `agint-dream` REM 阶段 / 手动触发 | random seed | 1-3 个随机 proposal（从 MutationKind 池子随机抽） |
| `evolution-reversed` | 进化记忆 `failure_pattern` 表新增条目且 category ∈ { `correctness`, `integration` } | pattern substring | 1 个反向 proposal（逆向构造"做相反修改"的 payload） |

Sprint 8 阶段梦境 / 进化记忆反向不一定都已被深度使用；`attribution-driven` 是核心路径。

---

## 变异流向（沙箱收口）

```
propose → validate → commit (进 sandbox verify)
                            │
                ┌───────────┴───────────┐
            D-QAF pass            D-QAF fail
                │                       │
          写 agint_mutator.commits   抛错 + 写 findings
                │                       │
                ▼                       ▼
         Sprint 9 population       （不污染 storage）
```

commit 默认走 `agint-quality-sandbox` verify 模式（决策 D3）。`explore` 模式留 Sprint 10。

---

## 存储域

- `agint_mutator`（与 `agint` / `agint_evolution` / `agint_diagnosis` / `agint_memory` / `agint_rules` / `agint_metrics` 互斥）
- 三张表：proposals (≤100) / commits (≤50) / findings (≤100)
- 超限 warn、不自动 prune（与 `agint-diagnosis` / `agint-evolution-memory` 一致）

数字来源（与 `agint-diagnosis` LIMITS 体例对齐但调小）：

- proposals 100 — 变异候选总数；密度不应超过归因 annotations 200
- commits 50 — 已提交变体（Sprint 9 population 消费侧）
- findings 100 — validate / commit 反馈记录

---

## 装挂入口

`cordis.patch.yml` 模板已写——子任务 #2 完成时**不**改动顶层 `profile-patches/web/cordis.patch.yml`，由老板走 `bin/safe-update.sh mount-patch` 重启时统一追加。

完整 SOP：`docs/operations/safe-update-sop.md`

---

## 验挂

```sh
cd /home/anmul/projects/AGINT
./bin/plugin-check.sh plugins/agint-mutator
node plugins/agint-mutator/test/smoke.mjs                  # 9 用例
```

---

## 与兄弟插件的关系

| Plugin | 交互 |
|---|---|
| `agint-diagnosis` | 读 annotations / clusters 决定 mutation 方向（attribution-driven 来源） |
| `agint-evolution-memory` | 读 failure_pattern（evolution-reversed 来源） |
| `agint-dream` | REM 阶段触发 dream-random 来源 |
| `agint-quality-sandbox` | commit 默认进 verify 模式（决策 D3） |
| D-QAF contract | **不调用**（设计稿 §七 L0-frozen；不引用任何 FROZEN 接口） |
| `agint-quality-eval` | commit 走 D-QAF Phase 1-3 验证 |

---

## 红线（设计稿 §八 / 决策 D8）

- 不调真 LLM（payload 是结构化字段，文本由对应工具的人类 owner 编辑）
- 不写 `failure_pattern` / `annotations` / `memory`（避免污染归因 + 主记忆）
- 不引用 D-QAF FROZEN 接口（设计稿 §七 L0 治理）
- 不挂载到顶层 `cordis.patch.yml`（AGENTS.md 红线；只产 loader 模板）
- 不实现 `PIPELINE_REORDER` / `ARCHITECTURE_PATCH`（决策 D2，留 Sprint 10+）
- 不实现 explore 沙箱（决策 D3，留 Sprint 10）
- 行数 ≤300 行（设计稿 §三.3.2，含 lib + test，不含 eval）

---

## propose 实现说明（子任务 #3 实装，Sprint 8 v0.6.1）

`agint.mutator.propose(input)` 把入参路由到 3 类 mutation 构造器之一，写入 `agint_mutator.proposals` 表。流程：

```
input → ProposeInputSchema.parse (zod)
     → atomicScope → kind (prompt→PROMPT_MUTATION / tool→TOOL_SYNTHESIS / strategy→STRATEGY_REWRITE)
     → MutationPayloadSchema.parse (二次校验)
     → preimageHash = contentHash(JSON.stringify(payload))
     → softDepOrThrow: PROMPT/STRATEGY 需 agint.diagnosis；TOOL 需 agint.evolution
     → _propose* 构造器拼 payload
     → checkLimit('proposals', count) → 超限抛 'proposals table full'
     → packProposal → t_proposals().put(id, entry)
     → unpackProposal → 完整 MutationProposal 形态
```

### 入参形态（`ProposeInputSchema`，本子任务导出）

```js
{
  source: 'attribution-driven' | 'dream-random' | 'evolution-reversed',
  failureId: string,
  rootCause: string,                  // PROMPT_DEFICIENCY | TOOL_GAP | PLANNING_FAILURE（与 atomicScope 一致）
  expectedEffect: string,             // 可被 D-QAF 证伪的命题（子任务 #4 validate 强校验）
  rollbackCondition: string,          // 含触发器（子任务 #4 validate 强校验）
  atomicScope: 'prompt' | 'tool' | 'strategy',
  promptPayload?: { promptId, oldText, newText, diffStrategy },     // atomicScope='prompt' 时必填
  toolPayload?: { toolName, signature, stubs, intent },             // atomicScope='tool' 时必填
  strategyPayload?: { strategyId, oldSteps, newSteps, ordering },  // atomicScope='strategy' 时必填
  windowDays?: number,                // STRATEGY_REWRITE 给 diagnosis.report 用
}
```

### 3 类构造器（独立可测，已 export）

- `_proposePromptMutation(input, diagnosis)` — 拼 `PromptMutationPayload`；软依赖验 `diagnosis.queryAnnotations`
- `_proposeToolSynthesis(input, evolution)` — 拼 `ToolSynthesisPayload`；软依赖验 `evolution.queryFailures`，探一次 `category:'integration'`
- `_proposeStrategyRewrite(input, diagnosis)` — 拼 `StrategyRewritePayload`；软依赖验 `diagnosis.report`

### 软依赖守门（设计稿 §六「安全 > 效率」）

mutation 是关键路径，软依赖缺失立即抛错（含缺失原因），绝不静默跳过：

- `ctx.get('agint.diagnosis') === null` → PROMPT_MUTATION / STRATEGY_REWRITE 抛 `propose: agint.diagnosis service 不可用`
- `ctx.get('agint.evolution') === null` → TOOL_SYNTHESIS 抛 `propose: agint.evolution service 不可用`

### 哈希链（设计稿 §三.1 + 哲学对齐检查 §靠谱）

- `preimageHash = contentHash(JSON.stringify(payload))` —— 同 payload 必同 hash；不同 payload 必不同 hash
- 哈希算法由 `lib/storage.js` 的 `contentHash` 提供：优先 SHA-256（`crypto.subtle.digest`），退化 djb2
- 子任务 #4 commit/rollback 直接复用；postimageHash / restoredHash 同算法链

### LIMITS 守门（设计稿 §二.6 + §三.2）

- `LIMITS.PROPOSALS = 100`：写入前 `t.entries().length ≥ 100` 抛 `proposals table full (cap 100)`
- LIMITS.COMMITS / FINDINGS 守门留子任务 #4 实现（commit / rollback 路径）
- 不自动 prune（与 diagnosis / evolution 一致；超出给老板手动留口子）

### 测试覆盖

- `node test/propose.test.mjs` —— 21 用例（子任务 #3 主力覆盖）
- `node test/smoke.mjs` —— 12 用例（含 3 个 happy-path 追加）
- L0-frozen 自检：`grep -rE 'agint\.qualityContract\.|agint-quality-contract' plugins/agint-mutator/lib/` 0 命中
