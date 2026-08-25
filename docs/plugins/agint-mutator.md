# agint-mutator — 变异构造器 plugin

> D-QAF P6 阶段的「解决问题」。让 AGINT 在归因结果出来后，自动构造 3 类修改方案（PROMPT_MUTATION / TOOL_SYNTHESIS / STRATEGY_REWRITE），进 verify 沙箱验证，让 Sprint 9 的种群管理器有「候选个体」可用。
>
> **版本**：v0.6.1（Sprint 8 子任务 #2，仅骨架 + FROZEN schema）
> **存储域**：`agint_mutator`（独立于 `agint` / `agint_evolution` / `agint_diagnosis` / `agint_memory` / `agint_rules` / `agint_metrics`）
> **Service 名**：`agint.mutator.propose` / `validate` / `commit` / `rollback`

---

## 设计意图

任务记忆记用户与 Agent 的对话；
进化记忆记 D-QAF 决策本身；
归因记忆记「失败为什么发生」（agint-diagnosis）；
**变异记忆**（agint_mutator）记「该怎么改」——把归因结果落地到具体可复现的修改方案，反过来又喂给 Sprint 9 population manager 做多候选对比。

| 维度 | 任务记忆 | 进化记忆 | 归因记忆 | 变异记忆（本插件） |
|---|---|---|---|---|
| 服务对象 | Agent 执行任务时的工作上下文 | DSH 系统自身的进化决策 | 系统看见的失败 + 归因证据 | 候选修改方案 + verify 闭环 |
| 写入触发 | 用户 / Agent 主动 | D-QAF Phase 4 自动 | D-QAF pipeline / 周复盘 / 用户手动标注 | propose + commit 路径 |
| 读取触发 | Agent 任务推理时 | 进化评估 / dream deep | mutator（Sprint 8）/ 反事实验证 / 周报 | Sprint 9 population / 周复盘 |
| 关键抽象 | 教训 / 决策 / 偏好 / 规律 | evolution-log / failure-pattern / success-template | annotation / cluster / report | proposal / commit / finding |
| 上限 | 无硬上限 | failure 100 / template 50 | annotation 200 / cluster 50 / report 50 | proposal 100 / commit 50 / finding 100 |

---

## Service 契约（FROZEN，设计稿 §2.1）

```js
agint.mutator.propose({ source, failureId, rootCause, expectedEffect, rollbackCondition, atomicScope })
  → MutationProposal
// source ∈ FROZEN enum 3 类（attribution-driven / dream-random / evolution-reversed）
// atomicScope ∈ FROZEN enum 3 类（prompt / tool / strategy）
// MutationProposal = {
//   id, kind, payload (FROZEN 形态), expectedEffect, rollbackCondition,
//   preimageHash, createdAt, source
// }
// kind ∈ FROZEN enum 3 类（PROMPT_MUTATION / TOOL_SYNTHESIS / STRATEGY_REWRITE）

agint.mutator.validate({ proposal })
  → { ok: boolean, findings: Finding[] }
// 验证 4 条硬约束：原子性 / 可证伪 / 必填 / payload 形态

agint.mutator.commit({ proposalId })
  → { ok: boolean, commitId, postimageHash }
// 进 sandbox verify（D3 默认 verify 模式），跑 D-QAF Phase 1-3，过 → 返回 commitId；失败 → 抛错

agint.mutator.rollback({ commitId })
  → { ok: boolean, restoredHash }
// 按 rollbackCondition 退回到 preimageHash（哈希链校验）
```

**v0.6.1 当前状态**：4 个 Service 接口已注册，但实现全部抛 `Error('not implemented: … (sub-task #N)')`。子任务 #3-#5 接力时**不改签名**，只填充算法本体。

详细 schema：`plugins/agint-mutator/lib/schema.js`。

---

## 3 类变异（设计稿 §2.2，决策 D2 精简）

| MutationKind | 原子 scope | 输入契约 | payload 形态（FROZEN） | 触发场景 |
|---|---|---|---|---|
| `PROMPT_MUTATION` | `prompt` | rootCause = `PROMPT_DEFICIENCY` | `{ promptId, oldText, newText, diffStrategy }` | 归因定向 |
| `TOOL_SYNTHESIS` | `tool` | rootCause = `TOOL_GAP` | `{ toolName, signature, stubs, intent }` | 归因定向 + 梦境随机 |
| `STRATEGY_REWRITE` | `strategy` | rootCause = `PLANNING_FAILURE` | `{ strategyId, oldSteps, newSteps, ordering }` | 归因定向 + 进化记忆反向 |

**未做（决策 D2 写明原因）**：

- `PIPELINE_REORDER` — 调整 D-QAF 流水线顺序，牵涉 eval / policy / report 插件装载，按工作守则红线段是产线操作。Sprint 10（安全与性能收口）有 explore 沙箱后再说。
- `ARCHITECTURE_PATCH` — 插件间交互方式重构，超出 mutation 概念边界（mutation = 局部修改，架构 = 全局改写），更接近 meta-evolution。Sprint 10 以后或 P8 元进化讨论。

---

## 存储结构

```
$DSH_HOME/storages/agint_mutator.json
├── proposals/    每条变异方案，{id, kind, source, atomicScope, failureId, rootCause,
│                              payload, expectedEffect, rollbackCondition,
│                              preimageHash, createdAt}
│                 上限 100（超限 warn，不自动 prune）
├── commits/      已提交变体，{id, ok, proposalId, postimageHash, committedAt, preimageHash}
│                 上限 50
└── findings/     validate / commit 反馈，{id, proposalId, severity, message, createdAt}
                  上限 100
```

与兄弟插件的差异：

| 维度 | evolution-memory | diagnosis | mutator（本插件） |
|---|---|---|---|
| 域 | `agint_evolution` | `agint_diagnosis` | `agint_mutator`（独立） |
| 表数 | 3 | 3 | 3 |
| 表名 | evolution_log / failure_pattern / success_template | annotations / clusters / reports | proposals / commits / findings |
| 衰减 | L1-L4 + confidence（纯复制 decay.js） | 本次不引入（子任务 #6 评估后定） | 本次不引入（子任务 #6 评估后定） |
| FROZEN enum | 无 | `RootCauseKind` 7 类 | `MutationKind` 3 类（D2 精简）/ `MutationSource` 3 类 / `AtomicScope` 3 类 |
| 哈希链 | 无 | 无 | preimageHash + postimageHash + restoredHash（commit/rollback 校验） |

---

## 与其他 plugin 的关系

| Plugin | 交互 |
|---|---|
| `agint-diagnosis` | **读** annotations / clusters 决定 mutation 方向（attribution-driven 来源，子任务 #5 接入） |
| `agint-evolution-memory` | **读** failure_pattern（evolution-reversed 来源，子任务 #5 接入） |
| `agint-dream` | REM 阶段触发 dream-random 来源（子任务 #5 接入） |
| `agint-quality-sandbox` | commit 默认进 verify 模式（决策 D3，子任务 #4 接入） |
| `agint-quality-eval` | commit 走 D-QAF Phase 1-3 验证（子任务 #4 接入） |
| D-QAF contract | **不调用**（设计稿 §七 L0-frozen；不引用任何 FROZEN 接口） |
| `agint-memory` | **不写**（避免变异发现污染主记忆；设计稿 §二.6） |
| Sprint 9 population manager | **未来消费方**（commit 输出给 Sprint 9；本 sprint 不写消费端） |

---

## FROZEN schema 与变更流程

字段名 / 顺序 / enum 取值任一变更：

1. **必须**走人类多签（老板 + 老板指定 1 人）
2. **必须**先经 7 天影子模式验证
3. **必须**发 major 版本
4. **必须**旧版本保留至少 3 个 minor 周期

CI 禁改：检测到 FROZEN 字段修改自动失败。

---

## Sprint 8 范围内（本次子任务 #2 已交付）

- [x] 插件骨架（package.json / manifest.json / lib/{index,schema,storage}.js）
- [x] 4 个 FROZEN Service 接口注册（占位抛 not implemented）
- [x] 物理隔离存储域（3 表 + LIMITS 100/50/100）
- [x] 9 个 smoke 用例全过
- [x] docs/plugins/agint-mutator.md

## Sprint 8 后续（子任务 #3-#6）

- [ ] 子任务 #3：3 类 mutation 构造器（PROMPT_MUTATION / TOOL_SYNTHESIS / STRATEGY_REWRITE）
- [ ] 子任务 #4：validate 4 约束 + commit verify 沙箱闭环 + rollback 哈希校验
- [ ] 子任务 #5：3 条变异来源接口（attribution-driven / dream-random / evolution-reversed）
- [ ] 子任务 #6：eval ≥10 用例 + commit/rollback 闭环压测 + 哲学对齐检查

---

## 设计取舍

### 1. FROZEN enum 从 5 类精简到 3 类（决策 D2，本次拍板）

PIPELINE_REORDER 与 ARCHITECTURE_PATCH 风险高于本 sprint 价值——前者牵涉插件装载 / 重启（按工作守则红线段是产线操作），后者超出 mutation 概念边界（mutation = 局部修改，架构 = 全局改写）。精简是「主动减负」，与路线图 §进化闭环张力平衡检查点 - 简洁 > 冗余 对齐。

### 2. 占位 Service 显式抛 `not implemented: ... (sub-task #N)`（与 diagnosis 一致）

绝不静默返回空对象——调用方一眼看出是这个 sprint 没实现（不是真的「变异失败」）。「变异失败」是业务语义，不可与「还没做」混淆。

### 3. storage 域独立 `agint_mutator`（与 diagnosis / evolution-memory 同策略）

物理隔离理由：变异数据规模估算 100/50/100 表项，与归因数据有交叉引用但不重叠——分域避免读放大，也避免 L0-frozen 风险从归因传到本插件。

### 4. 4 个 Service 都用 `inject: ['storageDomain']` 一个硬依赖（与 diagnosis 一致）

4 条 optionalInject（`agint.evolution` / `agint.diagnosis` / `agint.dream` / `agint.qualitySandbox`）全部走 `ctx.get` 软依赖；缺它们时各自降级处理——子任务 #3-#5 实现时各自加 cold-start 守门。

### 5. 哈希链（commit / rollback 子任务 #4 用）

- `preimageHash` proposal 提交前快照（propose 时算）
- `postimageHash` commit 成功后快照（commit 写）
- `restoredHash` rollback 后内容哈希（rollback 写；应等于 preimageHash）

当前 `contentHash` 是 SHA-256（带 djb2 兜底）——子任务 #4 会换成更严格实现。

### 6. 行数约束 ≤300（设计稿 §三.3.2，含 lib + test，不含 eval）

本次交付实测净增 220 行（lib + test），距上限 80 行余量。

---

## 验证

```sh
# 跑 plugin-check（8 维度）
cd /home/anmul/projects/AGINT
./bin/plugin-check.sh plugins/agint-mutator

# 跑 smoke（9 个用例）
node plugins/agint-mutator/test/smoke.mjs

# L0 自检（设计稿 §七）
grep -r 'D-QAF contract FROZEN' plugins/agint-mutator/  # 命中：仅注释/文档；.js 文件必须 0 引用
```

三个都 PASS 才算 Sprint 8 子任务 #2 交付完成。

---

## 相关文档

- 设计稿本体：`wiki/AGINT/sprint-8-设计稿-2026-08.md`（真理之源）
- 路线图：P6 / Sprint 8 变异构造器（line 329-351）
- L0 契约：`docs/evolution-framework.md`
- 兄弟插件：`docs/plugins/agint-diagnosis.md`（变异输入源）/ `docs/plugins/agint-quality-sandbox.md`（变异 verify 出口）/ `docs/plugins/agint-quality-eval.md`（变异 D-QAF 验证）
- 插件准入：`docs/plugins/PLUGIN-SPEC.md`
- 哲学检查点：`docs/evolution-philosophy-checkpoints.md`
- 安全边界：`docs/security-boundary.md`
