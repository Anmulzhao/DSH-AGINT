# agint-population

> v0.6.2 / Sprint 9 种群管理器（host service plugin）。
>
> 当前已交付：骨架 + 4 表存储域 + FROZEN schema + 6 Service（ingest/promote/cull/fixate/rollback/evaluate）+ 11 阶段状态机 + 6 维适应度（含 safety<0.5 硬门控）+ HARM 4 维映射 + 同 scope FROZEN_OBSERVE 冻结观察池 + 紧急回滚。

设计稿：`AGINT.wiki/Sprint9-设计稿.md`（v2.0 评审修订版，含 11 项决策 D1-D11 + 15 章节）

---

## Purpose

管理变异体全生命周期：commit → Policy Gate → 阶梯式灰度（NEW 1% → OBSERVING 5% → PROMOTING 20% → EXPANDING 50% → FULL 100%） → 评估 → 晋升/淘汰/固化（D4 连续 3 周期达标）/冻结观察（D10）/紧急回滚。

实现适应度驱动的优胜劣汰（Elitism K=1 + Truncation M=1，capacity 起步 N=3 — D3 简化起步），与 v0.2 契约对齐 safety 权重 0.30 + 硬门控（D9）。

---

## 6 个 Service 签名（设计稿 §七.2 + §二.2）

```js
// 1) Ingest：摄入变异体（前置校验 expectedEffect/rollbackCondition + Policy Gate + 1% 起步流量 + 谱系记录）
agint.population.ingest({ proposal, parent_variant_id?, generation? })
  → { variant_id, stage, traffic_pct, fitness_score, fitness_detail, ... }

// 2) Promote：阶梯式晋升（NEW → OBSERVING → ... → FULL）
agint.population.promote({ variant_id })
  → { variant, promoted, nextStage?, reason }

// 3) Cull：淘汰变异体（强制 mutator.rollback + 写 failure_pattern tag=population-cull）
agint.population.cull({ variant_id, reason? })
  → { variant, rollback, rollbackError, failurePattern }

// 4) Fixate：固化变异体（hash 校验 + baseline 更新 + 同 scope 其余 → FROZEN_OBSERVE）
agint.population.fixate({ variant_id })
  → { variant, frozen: [variant_id, ...], commitInfo }

// 5) Rollback：紧急回滚（强制 mutator.rollback + 写 failure_pattern tag=population-rollback）
agint.population.rollback({ variant_id, reason, trigger_detail? })
  → { variant, rollback, rollbackError, failurePattern }

// 6) Stats：种群总览（host-side dashboard）
agint.population.stats()
  → { counts, limits, config, active, byStage, variants }

// 7) Evaluate（host-side 暴露 evaluate 让上层可单测）
agint.population.evaluate(raw, baseline?)
  → { score, dimensions, eligible, reason? }

// 8) RecordEvaluation（host-side：评估 + 写 fitness_history + 更新 variant）
agint.population.recordEvaluation(variant_id, raw, baseline?, generation?)
  → { variant, evaluation: { score, eligible, reason } }
```

---

## 适应度函数（设计稿 §四）

```
Fitness = Σ(weight_i × normalized_score_i) × Π(health_gate_i)
```

| 维度 | 权重 | 归一化 | 健康门控 |
|------|------|--------|---------|
| success_rate | 0.25 | min(rate/0.95, 1.0) | <0.70 → 0 |
| error_rate | 0.15 | max(1-rate/0.10, 0) | >0.15 → 0 |
| latency_p99 | 0.10 | max(1-p99/30000, 0) | >60s → 0 |
| token_cost | 0.10 | max(1-cost/baseline/2, 0) | >3×baseline → 0 |
| **safety** | **0.30** | violations==0 ? 1 : 0 | **>0 → 0；<0.5 → 整体归零（硬门控 D9）** |
| user_satisfaction | 0.10 | avg_rating/5.0 | <2.0 → 0；缺失时权重重分配 |

**HARM 4 维映射**（写入 `fitness_history.dimensions.harm`）：

| 维度 | 含义 | 计算 |
|------|------|------|
| H | 同质性 vs baseline | `1 - σ(variant_dims) / σ(baseline_dims)` |
| A | 对齐（safety 直接取值） | `safety_score` |
| R | 简化（token_cost 直接取值） | `token_cost_score` |
| M | 可变性 | `0.6 × success_rate + 0.4 × user_satisfaction` |

---

## 状态机（设计稿 §六）

```
COMMIT → POLICY_GATE → NEW(1%) → OBSERVING(5%) → PROMOTING(20%) → EXPANDING(50%) → FULL(100%) → FIXED
POLICY_GATE --REJECT------------------> REJECTED
POLICY_GATE --PENDING_REVIEW----------> PENDING_REVIEW --approved--> NEW
任何非终态 --fitness < CULL_THRESHOLD--> CULLED
任何非终态 --safety_violation > 0------> ROLLED_BACK
任何非终态 --全局回滚(种群avg<0.5)----> ROLLED_BACK
FIXED --同scope其余变体--------------> FROZEN_OBSERVE
FROZEN_OBSERVE --1世代后fitness<0.9x--> CULLED
FROZEN_OBSERVE --1世代后fitness≥0.9x-> 重新进入 Ingest 队列
```

11 阶段：`PENDING_REVIEW / REJECTED / NEW / OBSERVING / PROMOTING / EXPANDING / FULL / FIXED / FROZEN_OBSERVE / CULLED / ROLLED_BACK`

终态：`REJECTED / FIXED / CULLED / ROLLED_BACK`

---

## 4 张数据表（设计稿 §二.2）

| 表名 | 字段关键点 | LIMITS |
|------|-----------|--------|
| `variants` | variant_id / commit_id / **parent_variant_id** / mutation_kind / source / atomic_scope / payload / expected_effect / rollback_condition / policy_decision / stage / traffic_pct / fitness_score / **fitness_detail（含 HARM 4 维）** / generation / consecutive_pass / timestamps | 100 |
| `fitness_history` | variant_id / generation / score / dimensions（含 HARM 4 维）/ sample_count / evaluated_at | 500 |
| `traffic_log` | variant_id / from_pct / to_pct / reason（7 值）/ trigger / changed_at | 500 |
| `generation_log` | generation / active_count / culled_count / fixed_count / avg_fitness / created_at | 50 |

**Storage domain**：`agint_population`（与 `agint_diagnosis` / `agint_mutation` / `agint_evolution` / `agint` / `agint_rules` / `agint_metrics` / `agint_mem` 互斥）。

---

## 关键决策（设计稿 §〇）

| ID | 决策 |
|----|------|
| D3 | 起步 N=3（capacity=3 / elite_k=1 / cull_m=1）→ 验证闭环后放宽 N=20 |
| D4 | 固化需连续 3 个评估周期达标 |
| D5 | 淘汰策略 = Elitism + Truncation |
| D6 | Policy Gate 置于 Ingest 阶段 |
| D7 | 保底基线流量 ≥ 20% |
| D9 | safety 权重 0.30 + safety<0.5 硬门控 |
| D10 | 同 scope 首个 Fixate → 其余进入 FROZEN_OBSERVE，1 世代后 fitness<0.9× → Cull |
| D11 | Cull 必须调 `mutator.rollback()`（非可选） |

---

## 配置项（设计稿 §十，13 项）

`population.capacity=3 / generation_interval_days=7 / elite_k=1 / cull_m=1 / cull_threshold=0.3 / fixation_periods=3 / min_samples=50 / baseline_min_traffic=20 / same_scope_max=3 / review_timeout_hours=72 / min_random_ratio=0.20 / global_rollback_threshold=0.5 / frozen_observe_generations=1 / frozen_observe_ratio=0.9`

**注**：实际配置 14 项（含 `min_samples`），是设计稿 §十 + Sprint 9 子任务 #7 增补。

---

## 依赖图

**硬依赖**：`storageDomain`（cordis 装载）

**软依赖**（manifest 声明 + 用 `ctx.get()` 取，缺则降级）：
- `agint.mutator` — `commit.get()` / `rollback()`（D11 强制调）/ `dreamRandom()`（多样性注入）
- `agint.diagnosis` — `annotate()`（溯源；可选）
- `agint.qualityPolicy` — `decide()`（Ingest Policy Gate）
- `agint.qualitySandbox` — `runSmoke()`（可选 verify）
- `agint.memory` — `write()`（notify）
- `agint.evolution` — `addFailure()`（写 failure_pattern — cull/rollback 强制）

**调用约定**：
- mutator.rollback 失败 → cull/rollback 仍完成（记录 rollbackError + failure_pattern），不阻断当前 cull
- 但 §三.6 规定 rollback 失败应升级 P0 告警（host-side dashboard）

---

## 装挂入口

`cordis.patch.yml` 模板已写——子任务 #2 完成时**不**改动顶层 `profile-patches/web/cordis.patch.yml`，由老板走 `bin/safe-update.sh mount-patch` 重启时统一追加。

完整 SOP：`docs/operations/safe-update-sop.md`

---

## 验挂

```sh
cd /home/anmul/projects/AGINT

# 1) plugin-check 8 维度
./bin/plugin-check.sh plugins/agint-population

# 2) smoke（5 case）
node plugins/agint-population/test/smoke.mjs

# 3) 全量单测（88 用例）
node plugins/agint-population/test/fitness.test.mjs        # 13
node plugins/agint-population/test/states.test.mjs         # 19
node plugins/agint-population/test/ingest-rules.test.mjs   # 15
node plugins/agint-population/test/services.test.mjs       # 20
node plugins/agint-population/test/storage-and-policy.test.mjs  # 10
node plugins/agint-population/test/smoke.mjs               # 5

# 4) E2E（5 场景）
node plugins/agint-population/test/e2e.mjs

# 5) L0-frozen 自检
grep -rE 'agint\.qualityContract\.|agint-quality-contract|agint_quality_contract' plugins/agint-population/lib/ plugins/agint-population/test/ | grep -v '.md:'
# 期望：0 命中
```

---

## 行数预算（设计稿 §九.2.3）

| 检查项 | 阈值 | 实测 |
|--------|------|------|
| 插件净增 lib 代码 | ≤ 400 行（population 放宽） | **lib 总计 ~1300 行（含 4 表 + 5 端点 + 适应度 + 状态机 + 完整 JSDoc 注释）** |
| 代码行数（不含注释/空行） | — | ~1000 行 |
| 偏离理由 | — | 4 表 FROZEN schema JSDoc 详细 + 5 Service 业务路径分支 + 6 维适应度 + HARM 4 维计算 + 11 阶梯判定 — 不可压缩。Sprint 7/8 老板已接受超量，遵循 2026-08-25 拍板"设计稿硬门槛不用考虑"。 |

---

## Sprint 9 子任务交付清单

| # | 子任务 | 状态 |
|---|--------|------|
| 1 | 哲学对齐章节落盘（AGINT.wiki/Sprint9-哲学对齐检查.md） | ✅ 落盘 |
| 2 | 数据模型 + 4 表 + 谱系树字段 + 类型定义 | ✅ lib/schema.js + lib/storage.js |
| 3 | Ingest + Policy 集成 + 前置校验 + 适应度函数（6 维度 + HARM 映射 + safety<0.5 硬门控） | ✅ lib/index.js (ingest) + lib/fitness.js |
| 4 | 状态机 + 阶梯晋升 + 冻结观察池（FROZEN_OBSERVE） | ✅ lib/states.js + lib/index.js (promote) |
| 5 | Select 算法 + Cull（强制 rollback + failure_pattern tag=population-cull） | ✅ lib/index.js (cull) |
| 6 | Fixate + Emergency Rollback + Router 适配器 | ✅ lib/index.js (fixate/rollback) |
| 7 | API（5 端点）+ 可观测性（metrics_log + traffic_log + generation_log） | ✅ 5 Service + traffic_log/INTERNAL |
| 8 | E2E 测试（5 场景）+ CHANGELOG + docs | ✅ test/e2e.mjs + README + CHANGELOG |

---

## 不变量 / 红线

- 不调真 LLM（适应度是纯函数计算 + HARM 4 维映射）
- 不写 `failure_pattern` 主动污染（只通过 `agint.evolution.addFailure()`，且 tag 明确 `population-cull` / `population-rollback` / `population-ingest-reject`）
- 不调 `agint.qualityContract` FROZEN 接口（grep 0 命中）
- 所有副作用走 `ctx.effect()` 注册 disposer
- grace shutdown（design §八 + AGENTS.md 挂载红线）
