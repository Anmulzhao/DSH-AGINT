# agint-tool-stats

> D2：工具使用画像。监听 `tools/result` 事件，按工具聚合成功率 / 延迟。
>
> v0.3 起扩展为预算对齐数据源（新增 `tokenCost` / `stepCount` / `durationMs` 字段）。

## 职责

- 监听 dsh `tools/result` 事件
- 追加写入 `~/.dsh/storages/agint_tool_stats.jsonl`
- 提供 `agint.toolStats` host Service
- 提供 `tool_stats_summary` model 工具

## 数据格式（jsonl）

每行：

```json
{
  "ts": 1755456000000,
  "tool": "bash",
  "ok": true,
  "durationMs": 1234,
  "sessionId": "...",
  "agentId": "agint"
}
```

> **v0.3 扩展**：新增预算对齐字段（用于 D-QAF 预算校验）
>
> ```json
> {
>   "tokenCost": 1234,        // 本次工具调用消耗的 token（近似）
>   "stepCount": 1,           // 步数（递归调用计数）
>   "durationMs": 1234,       // 已有字段
>   "ephemeral": false        // 临时评估任务（不计入预算）
> }
> ```

## 聚合维度

- 调用次数 / 失败率 / 平均延迟 / p95 延迟
- 限速：5/小时（防失控）
- 超限：抛错（不读 jsonl 兜底）

> **v0.3 扩展**：增加 `tokenCost` / `stepCount` 聚合，供 `agint-quality-eval` 预算对齐使用。

## 与其他插件的关系

- **`agint.metrics`**：`tools.usageTotal` 从这里采集
- **`agint.dream`**：高频失败工具是 sweep 候选信号
- **`agint.evolve`**：复盘时引用工具健康度
- **`agint.qualityEvaluator`**（v0.2 读 effectiveness / reliability，v0.3 读预算对齐数据）

## 文件

```
lib/index.js      Cordis apply()：监听 tools/result + 写 jsonl + 注册 Service
lib/aggregate.js  按工具聚合（调用次数 / 失败率 / 延迟）
test/throttle.test.js
test/aggregate.test.js
```

## 设计文档

详见 `docs/evolution-framework.md` 第五章"预算对齐"。
