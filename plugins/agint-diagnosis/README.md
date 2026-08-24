# agint-diagnosis

> v0.6.0 / Sprint 7 归因引擎（host service plugin）。
>
> 当前已交付：骨架 + FROZEN schema + storage 域装配 + **6 类根因判定（子任务 #3）** + **反事实模拟（子任务 #4）**。聚类 / report 聚合由后续子任务 #5-#6 实现。

设计稿：`wiki/AGINT/sprint-7-设计稿-2026-08.md`

---

## Purpose

把 AGINT 看见的失败归到 6 类根因之一（PROMPT_DEFICIENCY / TOOL_GAP / KNOWLEDGE_GAP / REASONING_ERROR / PLANNING_FAILURE / ENVIRONMENT_SHIFT，UNCERTAIN 兜底），并提供反事实模拟接口（启发式估算替换 modifiedStrategy 后的失败率）、按 substring 聚类、以及按时间窗聚合的 report 接口。

---

## 4 个 FROZEN Service 签名（设计稿 §2.1）

```js
agint.diagnosis.annotate({ failureId, trajectory })
  → { failureId, rootCause, confidence, evidence }
// 子任务 #3 已实现：6 类根因特征投票判定（17/17 unit test PASS）

agint.diagnosis.counterfactual({ failureId, modifiedStrategy })
  → { successRate, divergentSteps }
// 子任务 #4 已实现：确定性重放 + 启发式估算（不调真 LLM）
// （16/16 unit test PASS；详见「反事实模拟」一节）

agint.diagnosis.cluster({ failureIds })
  → Cluster[] // { pattern, count, sampleFailureIds }
// 占位实现，sub-task #5 接力：复用 evolution-memory substring 检索

agint.diagnosis.report({ windowDays })
  → DiagnosisReport
// { windowDays, generatedAt, annotationCount, clusterCount, rootCauseDistribution }
// 占位实现，sub-task #5 接力：report 聚合 + 写 wiki/memory 钩子
```

---

## 反事实模拟（子任务 #4，设计稿 §二.4）

### 接口

```js
agint.diagnosis.counterfactual({ failureId, modifiedStrategy })
  → { successRate, divergentSteps }
```

- `failureId`：与 `annotate` 同一个 failureId（指 `agint_evolution.failure_pattern` 表里一条 entry）
- `modifiedStrategy`：FROZEN 枚举 `['skip-tool', 'use-prev-prompt', 'reorder-subtasks']`
- 返回 `successRate ∈ [0, 1]`、`divergentSteps: string[]`（≥1 元素）

### 三种 modifiedStrategy

| 枚举值 | 扰动方式 | 命中条件 |
|---|---|---|
| `skip-tool` | 移除 trajectory 中所有被 TOOL_GAP 特征命中的步骤 | 扰动后 classifier 不再判为原 rootCause（一般对 TOOL_GAP） |
| `use-prev-prompt` | 删 PROMPT 段落 + 通过 `agint.memory.search` 找历史成功 prompt 注入「prev-prompt applied」步骤 | 扰动后 classifier 不再判为原 rootCause（一般对 PROMPT_DEFICIENCY）；memory 无相关条目时落到 0.3 兜底 |
| `reorder-subtasks` | 调换 PLAN_DISORDER 步骤首尾顺序 | 扰动后 classifier 不再判为原 rootCause（一般对 PLANNING_FAILURE 多步轨迹；Sprint 7 单步代理常见「未命中」） |

### successRate 启发式语义

- 单组 modifiedStrategy 调用 → 1 个成功率值
- 「扰动命中」（扰动后 rootCause ≠ 原 rootCause）→ `successRate = 1/3`（与设计稿 §二.4「跑三组，≥1 组模拟出不会失败 / 3」的比例化语义对齐）
- 「扰动未命中」→ `successRate = 0`
- `originalRootCause === 'UNCERTAIN'` 兜底 → `successRate = 0.3`（fixture-5 直觉期望）

### 性质（明示）

- **启发式估计 ≠ 真实成功率**（设计稿 §二.4 / §五）—— `divergentSteps` 明示「未命中」/「调换」/「no prev-prompt」等元信息，不假装命中
- **不调真 LLM**（设计稿 §八 红线）—— 算法纯函数 + regex + classifier 重判
- **不写任何表**（纯计算型接口）—— 0 个 side effect，不污染 `agint_diagnosis` 三表 / `failure_pattern`
- **软门槛**（设计稿 §三 验收）：10 条种子任务反事实成功率 ≥50%（路线图目标 70%）
- **冷启动守门**：`failure_pattern` 样本数 < 10 → 抛 `cold-start: failure_pattern 样本数 N < 10`
- **failureId 不存在** → 抛 `failureId not found in failure_pattern: …`

### 算法路径（确定性）

1. `evolution.queryFailures({ limit: 1000 })` 拉整 failure_pattern 表
2. 按 `failureId` 找基准 entry（先按 `id`，再按 `pattern` 文本兼容）
3. 用 baseline entry 包成 trajectory（与 #3 annotate 同模式，单条代理）
4. `#3 classifier.classify(trajectory)` 算原始 rootCause
5. UNCERTAIN → 直接兜底 0.3
6. 按 modifiedStrategy 应用扰动（perturbSkipTool / perturbUsePrevPrompt / perturbReorderSubtasks）
7. `classifier.classify(perturbedTrajectory)` 重判
8. 扰动后 ≠ 原 rootCause → 1/3；否则 → 0

---

## 存储域

- `agint_diagnosis`（与 `agint` / `agint_evolution` / `agint_rules` / `agint_metrics` 互斥）
- 三张表：annotations (≤200) / clusters (≤50) / reports (≤50)
- 超限 warn、不自动 prune（与 `agint-evolution-memory` 一致）

---

## FROZEN enum `RootCauseKind`

```
PROMPT_DEFICIENCY | TOOL_GAP | KNOWLEDGE_GAP
REASONING_ERROR | PLANNING_FAILURE | ENVIRONMENT_SHIFT | UNCERTAIN
```

UNCERTAIN 兜底写 `agint-memory`，**不**进 `failure_pattern`，避免污染进化系统下游。

---

## 装挂入口

`cordis.patch.yml` 模板已写——子任务 #2 完成时**不**改动顶层 `profile-patches/web/cordis.patch.yml`，由老板走 `bin/safe-update.sh mount-patch` 重启时统一追加。

完整 SOP：`docs/operations/safe-update-sop.md`

---

## 验挂

```sh
cd /home/anmul/projects/AGINT
./bin/plugin-check.sh plugins/agint-diagnosis
node plugins/agint-diagnosis/test/smoke.mjs                  # 7 用例
node plugins/agint-diagnosis/test/root-cause-classifier.test.mjs   # 17 用例（#3）
node plugins/agint-diagnosis/test/counterfactual-simulator.test.mjs # 16 用例（#4）
```
