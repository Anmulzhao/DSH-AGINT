# agint-dream

> 夜间梦境：light → REM → deep 三阶段记忆整合（OpenClaw memory-core 思路移植）。
>
> v0.2 起与 D-QAF 联动：在 REM 阶段调用 `agint.qualityEvaluator` 评估候选 Plugin/Skill；v0.3 起在 Deep 阶段读 `agint_evolution/success-templates` 作为评分参考。

## 职责

- 提供 `agint.dream` host Service
- 提供 `dream_*` model 工具（status / run_now / diary）
- sweep 读 DSH 会话日志 → 启发式提取候选 → 六维评分 → 门槛 → 提升进 `agint.memory`
- 梦境日记写 `$AGINT_HOME/dreams/YYYY-MM-DD.md`

## 三阶段

| 阶段 | 覆盖 | 强度 |
|---|---|---|
| Light | 最近 2 天（lookbackDays 默认） | 评分 ≥ 软门槛即提升 |
| REM | 8 天 | 评分 ≥ 中门槛，且与现有 memory 不重复 |
| Deep | 30 天 | 评分 ≥ 高门槛，且能溯源到 ≥ 3 个会话的反复出现 |

### 与 D-QAF 联动（v0.2 起）

| 阶段 | D-QAF 角色 | 具体动作 |
|---|---|---|
| **Light** | 快速扫描 | 对当天新增/修改的 Skill 做 TRACE 静态评估（只读 `agint.rules` / `agint.metrics`） |
| **REM** | 深度反思 | 对 Plugin 做 `agint.qualityEvaluator.evaluate` 全量评估 + HARM 简版计算 |
| **Deep** | 整合归档 | 将评估结果写入 `agint.memory`（type: decision），更新 `agint-wiki` 中的质量档案 |

> **v0.3 计划**：Deep 阶段读 `agint_evolution/success-templates` 作为评分参考，归档 evaluation summaries。

## 六维评分

每条候选打分：相关性 / 新颖度 / 可证伪 / 行动价值 / 时效 / 重复证据。
总分 = 加权和。门槛随阶段上升。

## dry-run vs apply

- **dry-run**（默认）：只评分 + 写梦境日记，**不写 memory**
- **apply=true**：把通过门槛的候选真实写入 `agint.memory`

手动 `dream_run_now --apply` 仅在补做 / 审查时用。

## 与其他插件的关系

- **`agint.cron`**：`night-dream` 每日 03:00 触发 sweep
- **`agint.memory`**：apply 时调 memory.write 落库
- **`agint.metrics`**：`dream.sweepCount` / `dream.promotedCount` 指标
- **`agint.qualityEvaluator`**（v0.2）：REM 阶段调用 evaluate() 评估候选
- **`agint_evolution`**（v0.3）：Deep 阶段读 success-templates

## 测试

`test/sweep.test.js`：六维评分纯函数 + 门槛判定。

## 文件

```
lib/index.js   Cordis apply()：注册 agint.dream Service + sweep 入口
lib/sweep.js   light→REM→deep 整合引擎
lib/tools.js   dream_* model 工具
test/sweep.test.js
```
