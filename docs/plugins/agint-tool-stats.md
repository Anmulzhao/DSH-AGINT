# agint-tool-stats

> D2：工具使用画像。监听 `tools/result` 事件，按工具聚合成功率 / 延迟。

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

## 聚合维度

- 调用次数 / 失败率 / 平均延迟 / p95 延迟
- 限速：5/小时（防失控）
- 超限：抛错（不读 jsonl 兜底）

## 与其他插件的关系

- **`agint.metrics`**：`tools.usageTotal` 从这里采集
- **`agint.dream`**：高频失败工具是 sweep 候选信号
- **`agint.evolve`**：复盘时引用工具健康度

## 文件

```
lib/index.js      Cordis apply()：监听 tools/result + 写 jsonl + 注册 Service
lib/aggregate.js  按工具聚合（调用次数 / 失败率 / 延迟）
test/throttle.test.js
test/aggregate.test.js
```

## 设计文档

详见 `docs/d2-dream-evolve-linkage.md`（v0.3 写）。