# Changelog — agint-population

> 所有破环性变更必须写入本文件。变更流程：FROZEN schema 修改走 L0 治理（人类多签 + 7 天影子 + major 版本），其它按 semver。

---

## v0.6.2 — 2026-08-26 — Sprint 9 收口

**首次发版**（起步阶段，N=3 — D3）。

### 新增（Added）

- **6 个 Service**（设计稿 §七.2 + §三）：
  - `agint.population.ingest` — 摄入变异体（前置校验 expectedEffect/rollbackCondition + Policy Gate + 1% 起步流量 + 谱系记录）
  - `agint.population.promote` — 阶梯式晋升（NEW 1% → OBSERVING 5% → PROMOTING 20% → EXPANDING 50% → FULL 100%）
  - `agint.population.cull` — 淘汰（强制 mutator.rollback + 写 failure_pattern tag=population-cull）
  - `agint.population.fixate` — 固化（mutator.commit.get hash 校验 + baseline 更新 + 同 scope 其余 → FROZEN_OBSERVE）
  - `agint.population.rollback` — 紧急回滚（强制 mutator.rollback + 写 failure_pattern tag=population-rollback）
  - `agint.population.stats` — 种群总览（host-side dashboard）

- **8 个 host-side 辅助 Service**：
  - `agint.population.evaluate` — 暴露 fitness 函数 供单测
  - `agint.population.recordEvaluation` — 评估 + 写 fitness_history + 更新 variant
  - `agint.population.limits` — LIMITS 100/500/500/50
  - `agint.population.config` — 当前配置（可被 updateConfig 原地改）
  - `agint.population.updateConfig` — 配置调参入口
  - `agint.population.checkLimit` — 上限检查 helper

- **4 张数据表**（设计稿 §二.2）：
  - `variants` (≤100) — variant_id / commit_id / **parent_variant_id（谱系树）** / mutation_kind / source / atomic_scope / payload / expected_effect / rollback_condition / policy_decision / stage（11 值）/ traffic_pct / fitness_score / **fitness_detail（含 HARM 4 维）** / generation / consecutive_pass / timestamps
  - `fitness_history` (≤500) — variant_id / generation / score / dimensions（含 HARM 4 维 H/A/R/M）/ sample_count / evaluated_at
  - `traffic_log` (≤500) — variant_id / from_pct / to_pct / reason（7 值）/ trigger / changed_at
  - `generation_log` (≤50) — generation / active_count / culled_count / fixed_count / avg_fitness / created_at

- **6 维适应度函数**（lib/fitness.js，设计稿 §四.2）：
  - success_rate (0.25) / error_rate (0.15) / latency_p99 (0.10) / token_cost (0.10) / **safety (0.30)** / user_satisfaction (0.10)
  - safety 硬门控（D9）：safety<0.5 或 violations>0 → 整体 fitness=0
  - user_satisfaction 缺失 → 权重从 success_rate + safety 重分配
  - FROZEN FitnessDimensionsSchema（raw / normalized / weights / gates / harm）

- **HARM 4 维映射**（lib/fitness.js computeHARM）：
  - H (Homogeneity) = `1 - σ(variant_norm) / σ(baseline_norm)`
  - A (Alignment) = safety_score
  - R (Reduction) = token_cost_score
  - M (Mutability) = `0.6 × success_rate_norm + 0.4 × user_satisfaction_norm`

- **11 阶段状态机**（lib/states.js，设计稿 §六）：
  - 入口：PENDING_REVIEW（Policy Gate 暂挂）
  - 阶梯：NEW → OBSERVING → PROMOTING → EXPANDING → FULL → FIXED
  - 旁路：REJECTED / CULLED / ROLLED_BACK / FROZEN_OBSERVE
  - checkPromote（阶梯晋升判定）/ nextLadderStage / ladderForStage / trafficForStage
  - shouldCull / shouldEmergencyRollback / shouldGlobalRollback / decideFrozenOutcome / findSameScopeCompeting

### 决策落地（11 项 D1-D11）

| ID | 决策 | 落地位置 |
|----|------|---------|
| D1 | 加权多维评分 | lib/fitness.js (evaluate) |
| D2 | 阶梯式流量递增 | lib/states.js (STAGE_LADDER) + lib/schema.js (STAGE_LADDER) |
| D3 | 起步 N=3 → 放宽 N=20 | lib/schema.js (DEFAULT_CONFIG.capacity=3, elite_k=1, cull_m=1) |
| D4 | 连续 3 周期达标 | lib/index.js (fixate.consecutive_pass ≥ fixation_periods=3) |
| D5 | Elitism + Truncation | lib/index.js (cull 选中最低分) |
| D6 | Policy Gate 置于 Ingest | lib/index.js (ingest 调 qualityPolicy.decide) |
| D7 | 保底基线 ≥ 20% | lib/schema.js (DEFAULT_CONFIG.baseline_min_traffic=20) |
| D8 | mutator 实装 | ✅ 2026-08-26 已实装（不在本 PR 范围） |
| D9 | safety 0.30 + 硬门控 | lib/fitness.js (DEFAULT_WEIGHTS.safety=0.30 + safetyHardGateBreached) |
| D10 | 同 scope 冻结观察 | lib/index.js (fixate 标记 FROZEN_OBSERVE) + lib/states.js (decideFrozenOutcome) |
| D11 | Cull 强制 rollback | lib/index.js (cull.doMutatorRollback) + lib/index.js (rollback) |

### 配置项（设计稿 §十，13 + 1 = 14 项）

```json
{
  "capacity": 3, "generation_interval_days": 7, "elite_k": 1, "cull_m": 1,
  "cull_threshold": 0.3, "fixation_periods": 3, "min_samples": 50,
  "baseline_min_traffic": 20, "same_scope_max": 3, "review_timeout_hours": 72,
  "min_random_ratio": 0.20, "global_rollback_threshold": 0.5,
  "frozen_observe_generations": 1, "frozen_observe_ratio": 0.9
}
```

### 测试（88 用例 + 5 E2E 场景）

| 文件 | 用例 | 状态 |
|------|------|------|
| `test/smoke.mjs` | 5 | ✅ 5/5 PASS |
| `test/fitness.test.mjs` | 13 | ✅ 13/13 PASS（6 维归一化 + gate + HARM + 硬门控） |
| `test/states.test.mjs` | 19 | ✅ 19/19 PASS（11 阶梯 + 晋升 + 冻结 + 紧急回滚） |
| `test/services.test.mjs` | 20 | ✅ 20/20 PASS（5 Service 端到端 + stats + recordEvaluation） |
| `test/ingest-rules.test.mjs` | 15 | ✅ 15/15 PASS（边界 + 3 类 source + 3 类 mutation_kind） |
| `test/storage-and-policy.test.mjs` | 10 | ✅ 10/10 PASS（pack/unpack + lifecycle + config） |
| `test/e2e.mjs` | 6（5 场景 + 1 汇总） | ✅ 6/6 PASS（设计稿 §十一 E2E 全覆盖） |

### 验证

- ✅ `./bin/plugin-check.sh plugins/agint-population` — 0 fail / 2 warn（warn 是缺 README/CHANGELOG，已补）
- ✅ L0-frozen grep 0 命中（`agint.qualityContract.*` / `agint-quality-contract` / `agint_quality_contract`）

### 偏离设计稿

| 偏离 | 偏离原因 | 老板拍板风险 |
|------|---------|-------------|
| **行数预算超 ≤400 行**（实测 lib ~1300 行，含 JSDoc ~1000 行 code） | 4 表 FROZEN schema + JSDoc 详细 + 5 Service 业务路径分支 + 6 维适应度 + HARM 4 维计算 + 11 阶梯判定 — 不可压缩 | **已遵循 Sprint 8 老板拍板（2026-08-25 "设计稿硬门槛不用考虑"）** |
| **DEFAULT_CONFIG 14 项**（设计稿列 13 项） | 子任务 #7 增补 `min_samples`（合理衍生项，与 sprint 7/8 同体例） | 0 风险（增项，无破环性） |
| **`mutator.rollback` 失败时 cull 仍完成**（设计稿 §三.6：失败应升级 P0 告警但未说是否阻断） | 设计意图解读："失败告警 + 后续阻塞"vs "立即抛错"。当前实现：cull 继续完成 + 记录 rollbackError + 写 failure_pattern + 失败信息便于 host-side dashboard 告警。 | **低风险**：符合"rollback 失败 → 告警"语义。如要 strict 抛错可后续补丁 |
| **`checkPromote` 使用 current stage 的 fitness_threshold + consec_required** | 设计稿 §五.1 表"晋升条件"含义模糊（描述"当前阶段"还是"下一阶段"？）。当前解读：每阶段有"晋升条件"，满足当前阶段条件 → 升下一阶梯（更直观）。 | **低风险**：与 Sprint 8 mutator 的"当前阶段能力"语义一致 |
| **HARM.H 公式 = `1 - σ(score)/σ(baseline)`**（设计稿字面） | 公式方向经实测验证**正确**：identical（σ=0）→ H=1（高同质）；divergent（σ=σBase）→ H=0（低同质）；与设计稿命名"H (Homogeneity)"完全对齐。Codex 阶段曾误判为"identical→H=0"，已在 Sprint 9 收口前修正。 | **0 风险**：实现与设计稿命名语义一致 |
| **FROZEN 字段 fitness_detail 合并原 fitness_history.dimensions**（设计稿 §二.2 修订说明） | 设计稿明确：消除双写一致性风险。 | 0 风险（设计稿 §修订说明） |

### 已知瑕疵

1. **行数预算超 ≤400 行**（见上表偏离）
2. **`checkPromote` 用 current stage 而非 next stage 的 consec_required**（见上表偏离）
3. **HARM.H 公式语义反转**（见上表偏离；Sprint 9 收口前已修正为 0 风险）
4. **`mutator.rollback 失败容忍 cull 完成`**（见上表偏离）
5. **`safety_violations_total` 累加逻辑在 `recordEvaluation` 而非 `rollback`** —— 紧急回滚路径不主动累加，仅 `recordEvaluation` 路径累加
6. **`fail.rollback()` 抛出时 cull 结果的 `rollback` 字段为 `null`** — 当前实现 catch 后 rollbackResult=null（cull 不抛错）；如要严格 D11 必须抛错则需调整
7. **`stats.active` 不含 PENDING_REVIEW**（与 `listActiveVariants` 同语义）

### 下次衍生 TODO

- mock ctx 工厂下沉到 `eval/scenarios/mocks/agint-population-ctx.mjs`（与 Sprint 7/8 同沿用 TODO）
- Sprint 10：跨代遗传/交叉 + 自适应权重 + 多种群隔离
- Sprint 11：变异体谱系图可视化 + 人工反馈闭环
- Sprint 12：多臂老虎机流量分配 + 适应度漂移检测
- 容量从 N=3 放宽至 N=20（Sprint 9 验证闭环后）
- 6 个额外 API 端点（GET /population/{id} / {id}/fitness / {id}/traffic / generations / PUT /population/config / POST /population/select）— Sprint 10

---

*下一步：老板 review 后由 `bin/safe-update.sh mount-patch` 拍快照 + `bin/safe-update.sh restart` 重启后挂载到顶层 cordis.patch.yml。*
