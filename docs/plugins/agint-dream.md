# agint-dream

> 夜间梦境：light → REM → deep 三阶段记忆整合（OpenClaw memory-core 思路移植）。
>
> **当前版本：v0.3.0**（host 实装；2026-09-06 Deep 阶段读 evolution success-templates + C3 compositeScore 真值接入）。v0.1.0 Sprint13 已收口 P0/P1/P2 三方向（validation gate / LLM consolidation / short-term recall store）。
>
> ✅ **v0.1.1 host 验证（2026-09-06）**：老板按 `bin/restart-runbook.ps1` 重启 dsh web 后，`dream_status` 不再报 schema 校验错，render 多一行 `consolidation=... · validation=...`。task 1 正式收口。
>
> ✅ **v0.2 C2 host 验证（2026-09-06）**：`dream_run_now` 输出 `qualityEval=degraded · compositeMean=n/a · ok=8/9`；dream_diary 第47 行渲染 v0.2 qualityEval 摘要。compositeMean=n/a 是诚实 null（compositeScore 数据源不可用）。
>
> ✅ **v0.3.0 host 验证（2026-09-06）**：`dream_run_now` 输出 `evolution=ok · templates=0 · topConfidence=n/a · boost=0`；dream_diary 第48 行渲染 v0.3 evolution 摘要。`templates=0` 是 evolution 库空（周复盘蒸馏未跑），非 bug。
>
> ✅ **C3 host 验证（2026-09-06）**：bridgeVersion `C3 (REM integrated; real compositeScore via evaluator.score(); 0-100 scale)` 加载。
>
> ✅ **compositeMean 真正修复（2026-09-06）**：dream bridge resolveEvalTargets 的 target.path 不传（undefined），跳过 quality-eval 的 sandbox gate（zod schema `.optional()` 拒绝 null——之前传 null 导致 invalid_type → evaluate 抛错 → compositeMean=n/a）。host 验证：`qualityEval=ok · compositeMean=71.4 · ok=9/9`；dream_diary `v0.2 qualityEval: status=ok · compositeMean=71.4 · harmMean=0.5 · 评估 9 个 plugin (9 ok)`。
>
> 🚧 **v0.3 后续（C3 提案 78dbb9e3-...）**：归档 evaluation summaries 尚未实现。

**运行时常态断层**：当前 sweep 跑成 `heuristic-degraded` 因 LLM 429 Token Plan 用量上限（`reference/openclaw-dreaming-implementation.md` §7）。P1 代码在，模型被额度卡住。

## 职责

- 提供 `agint.dream` host Service
- 提供 `dream_*` model 工具（5 个：`dream_status` / `dream_run_now` / `dream_diary` / `recall_store_inspect` / `dream_verify_consolidation`）
- sweep 读 DSH 会话日志 → 启发式提取候选 → 六维评分 →
  - **P2**：候选写入 short-term recall store（`recall-store.js`，跨 sweep 累积去重）
  - **P1**：Deep 阶段调 LLM consolidation（`consolidation.js`，`ctx.subagents.start('spawn',{outputSchema})`）决定 add/merge/supersede
  - **P0**：写 `agint.memory` 前过 validation gate（`validation-gate.js`，loss fraction ≤0.25 + lineageKey 强校验）
- 梦境日记写 `$AGINT_HOME/dreams/YYYY-MM-DD.md`
- 事件：`dream.completed`（T1 影子期）+ `dream.rejected`（P0 拒整批时）

## 三阶段

| 阶段 | 覆盖 | 强度 | 提升条件 |
|---|---|---|---|
| Light | 最近 2 天（lookbackDays 默认） | 低 | 评分 ≥ 软门槛；候选写入 recall store |
| REM | 8 天 | 中 | 评分 ≥ 中门槛，且与现有 memory 不重复；并入评分的 reinforcement 信号 |
| Deep | 30 天 | 高 | 评分 ≥ 高门槛 + 可溯源 ≥ 3 个会话；过 P1 LLM consolidation + P0 validation gate 后写入 |

### 与 D-QAF 联动（v0.2 起 — **C3 实现**）

| 阶段 | D-QAF 角色 | 具体动作 | 状态 |
|---|---|---|---|
| **Light** | 快速扫描 | 对当天新增/修改的 Skill 做 TRACE 静态评估（只读 `agint.rules` / `agint.metrics`） | ❌ 计划 |
| **REM** | 深度反思 | 对 Plugin 做 `agint.qualityEvaluator.evaluate` 全量评估 + HARM 简版计算 | ✅ **C3 实现**（REM 已接入，真 compositeScore via evaluator.score()） |
| **Deep** | 整合归档 | 将评估结果写入 `agint.memory`（type: decision），更新 `agint-wiki` 中的质量档案 | 🚧 **v0.3 部分实现**（evolution success-templates 已接，归档 evaluation summaries 待） |

> **v0.3 实现**（提案 ba3e1800-... task 3）：Deep 阶段读 `agint_evolution/success-templates` 作为评分参考，已实装（`lib/evolution-bridge.js`）。归档 evaluation summaries 尚未实现——待 C3 提案 78dbb9e3-...。

## 六维评分

每条候选打分：相关性 / 新颖度 / 可证伪 / 行动价值 / 时效 / 重复证据。
总分 = 加权和（与 openclaw `rankShortTermPromotionCandidates` 一致，半衰期 14d）。门槛随阶段上升。

## dry-run vs apply

- **dry-run**（默认）：只评分 + 写梦境日记 + 更新 recall store，**不写 memory**
- **apply=true**：把通过门槛 + validation gate 的候选真实写入 `agint.memory`

手动 `dream_run_now --apply` 仅在补做 / 审查时用。

## 与其他插件的关系

- **`agint.cron`**：`night-dream` 每日 03:00 触发 sweep（`0 3 * * *`）
- **`agint.memory`**：apply 时调 memory.write 落库
- **`agint.metrics`**：`dream.sweepCount` / `dream.promotedCount` 指标
- **`agint.qualityEvaluator`**（v0.2）：REM 阶段调用 evaluate() 评估候选（C3 用 evaluator.score() 拿真 composite）
- **`agint_evolution`**（v0.3）：Deep 阶段读 success-templates（`lib/evolution-bridge.js`）
- **DSH subagent runtime**（P1）：`ctx.subagents.start('spawn',{outputSchema})` 做 LLM consolidation
- **`agint.eventBus`**（v0.7.0）：publish `dream.completed` / `dream.rejected`（T1 影子期）

## 测试

`test/`：`sweep.test.js`（六维评分 + 门槛 + P1 集成 4 case）、`validation-gate.test.js`（9 case）、`recall-store.test.js`（11 case）、`sweep-integration.test.js`、`dream-completed-publish.test.mjs`。

## 文件（v0.3.0 host 实装）

```
lib/index.js              239 行   Cordis apply()：注册 agint.dream Service + sweep 入口 + status() 兜底对象
lib/sweep.js              980 行   light→REM→deep 整合引擎 + 六维评分 + diary + P0/P1/P2 编排 + v0.2/v0.3 联动
lib/consolidation.js      255 行   P1 LLM consolidation（ctx.subagents.start + outputSchema）
lib/validation-gate.js    227 行   P0 validation gate（loss fraction ≤0.25 + lineageKey）
lib/recall-store.js       279 行   P2 recall store（JSONL/容错/剪枝/markPromoted）
lib/tools.js              421 行   5 个 preset model tool（v0.1.1 schema 同步 + v0.2/v0.3 schema）
lib/verify.js             101 行   P1 独立验证（dream_verify_consolidation）
lib/quality-bridge.js     227 行   v0.2 qualityEvaluator 桥接层（C3 用 evaluator.score() 真值）
lib/evolution-bridge.js   126 行   v0.3 evolution success-templates 桥接层
test/                     6 个测试文件
CHANGELOG.md              版本日志（v0.3.0 / v0.3.0-C3 / v0.2.0-C2 / v0.2.0-C1 / v0.1.1 / v0.1.0）
```

## 历史

- **2026-09-06** — v0.3.0：Deep 阶段读 evolution success-templates（task 3）+ C3 compositeScore 真值
- **2026-09-06** — v0.2.0-C2：REM qualityEvaluator 接入（task 2 C2）
- **2026-09-06** — v0.2.0-C1：qualityEvaluator 桥接元数据（task 2 C1）
- **2026-09-06** — v0.1.1：dream_status schema 同步（提案 ba3e1800-... task 1）
- **2026-09-05** — v0.1.0：Sprint13 收口（P0 validation gate / P1 LLM consolidation / P2 recall store）
- **2026-08-20** — host 重启后 `lastSweep` 从 disk fallback 修复（详见 wiki `dream-host-state-recovery.md`）
- **更早** — v0.0.x 初装，含 dream_status/dream_run_now/dream_diary 三件