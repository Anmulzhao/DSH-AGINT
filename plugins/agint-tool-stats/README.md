# agint-tool-stats — 工具使用画像

> 监听 `tools/result` 事件追加写 JSONL，形成工具调用画像。

## 提供什么

| 项 | 值 |
|---|---|
| Service | `agint.toolStats` |
| Tool | `tool_stats_summary` |
| 监听事件 | `session/created`、`tools/result` |
| 注入 | `tools` |
| 存储 | `~/.dsh/storages/agint_tool_stats.jsonl`（atomic jsonl，非 storage domain） |

## 落盘格式

每执行一次工具，追加一行 JSONL：`{ exec, result, sessionId, ... }`。
路径可通过 `config.jsonlPath` 覆盖，默认取 `$DSH_HOME/storages/agint_tool_stats.jsonl`。

## 读取方法

Service 暴露 5 个读取方法（均基于 `readAllRecords`，即全量读 JSONL 后聚合）：

- 调用次数
- 失败率
- p95 延迟
- 按会话维度的汇总
- `backfill(sessionsRoot, jsonlPath)` —— 从会话目录回填历史数据

### backfill 的一个历史 bug

早期 `backfill` 只认 `session.jsonl.zstd`，**漏读全部 v3 会话**，导致画像严重偏小。
2026-09-17 起会话解析统一走中立提取器（双格式 v3/jsonl + 去重）修复。
入口 `sessionsRoot` 可通过 `config.sessionsRoot` 覆盖。

## 节流

为防止画像写入本身压垮系统，`tool_stats_summary` 带每小时调用上限
（`THROTTLE_PER_HOUR`，窗口 3600_000 ms）。触顶时返回等待分钟数，
并提示可直接读 `agint_tool_stats.jsonl` 取原始数据 —— **节流只挡工具，不挡数据**。

## 测试

- `test/aggregate.test.js` —— 聚合逻辑（9 个用例）。**当前作为 manifest 的 `tests.entry`**，
  即 `bin/check-wiring.mjs` 查 I 的 smoke 入口。
- `test/throttle.test.js` —— 节流逻辑（5 个用例）
- `test/backfill-v3.test.mjs` —— v3 会话回填

⚠️ `tests.entry` 只能指向单个文件，故另外两个测试不会被查 I 跑到；
修改本插件时需手动跑全部三个。
