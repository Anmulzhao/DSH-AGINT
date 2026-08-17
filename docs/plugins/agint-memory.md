# agint-memory

> 长期记忆：四层遗忘模型 + 证据约束 + 类型分类。

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

## 与其他插件的关系

- **`agint.dream`**：夜间 sweep 把会话日志里提炼的候选提升为 memory entry
- **`agint.metrics`**：`memory.health` / `memory.bloat` 指标从这里采集
- **`agint.evolve`**：复盘时写入新 lesson

## 测试

`test/decay.test.js`：覆盖 L1→L2→L3 的降级路径与 dry-run/apply 切换。

## 文件

```
lib/index.js     Cordis apply()：注册 agint.memory Service
lib/decay.js     L1-L4 衰减引擎（pure functions + storage writer）
lib/tools.js     memory_* model 工具
test/decay.test.js
```