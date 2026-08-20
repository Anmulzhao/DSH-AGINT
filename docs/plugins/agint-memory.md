# agint-memory

> 长期记忆：四层遗忘模型 + 证据约束 + 类型分类。
>
> AGINT 存在两个独立的"记忆层"：
>
> - **任务记忆**（本插件，`agint.memory`）：Agent 任务级 / 知识库级长期记忆
> - **进化记忆**（v0.3 引入，`agint_evolution`）：系统自身的进化经验积累
>
> 两者物理隔离。详见 `docs/evolution-framework.md` 第四章。

## 职责

- 提供 `agint.memory` host Service
- 提供 `memory_*` model 工具（search/read/write/stats/forget-scan）
- 独占 `agint` storage domain

## 存储

`~/.dsh/storages/agint.json`，按 `type` 分桶：`lesson / decision / preference / pattern`。

## 遗忘模型（L1→L4）

| 层 | 含义 | 默认置信衰减 |
|---|---|---|
| L1 | 活跃 | 不衰减 |
| L2 | 弱化 | 触发条件：90 天未用 |
| L3 | 草稿 | 触发条件：180 天未用 |
| L4 | 仅供归档 | 触发条件：730 天 + 已 resolved/replaced |

`memory_forget_scan` 是 decay 引擎；dry-run 默认，apply=true 才会真的降级 / 清理。

## 写入约束（lesson 必须有证据）

```yaml
type: lesson  # 必须带 evidence
evidence: "工具+动作+位置（必填）"
content: "教训（一句话）"
confidence: 0..1
```

没有 evidence 的 lesson 会被 lib/index.js 在写入前 reject。

## 任务记忆 vs 进化记忆

| 维度 | 任务记忆（本插件） | 进化记忆（`agint_evolution`） |
|---|---|---|
| 存储域 | `agint` | `agint_evolution`（v0.3 引入） |
| 服务对象 | Agent 推理时检索上下文 | 下次进化评估时检索历史经验 |
| 写入触发 | Agent 主动/被动记录 | D-QAF Phase 4 完成后自动写入 |
| 读取场景 | 日常任务推理 | 进化评估阶段 |
| 衰减规则 | L1→L4（90/180/730 天） | 同 L1→L4 规则 |
| 物理隔离 | 与 `agint_rules` 互斥 | 与全部其他域互斥 |

**关键不变量**：两者绝不共享存储。`agint.memory` 不写入进化日志；`agint_evolution` 不写入任务上下文。

## 与其他插件的关系

- **`agint.dream`**：夜间 sweep 把会话日志里提炼的候选提升为任务记忆
- **`agint.metrics`**：`memory.health` / `memory.bloat` 指标从这里采集
- **`agint.evolve`**：复盘时写入新 lesson
- **`agint.quality.contract`**：`setConfig` 审计日志落点（如果可用）
- **`agint.qualityEvaluator`**：评估历史（`type: decision`）写入本服务；该记录**不可被覆盖**（`WRITE_PROTECT_TYPE_DECISION` 规则）

## 测试

`test/decay.test.js`：覆盖 L1→L2→L3 的降级路径与 dry-run/apply 切换。

## 文件

```
lib/index.js     Cordis apply()：注册 agint.memory Service
lib/decay.js     L1-L4 衰减引擎（pure functions + storage writer）
lib/tools.js     memory_* model 工具
test/decay.test.js
```
