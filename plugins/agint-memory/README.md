# agint-memory — 记忆读写与 L1-L4 衰减

> 长/短期记忆读写 + 四级衰减扫描。独占 `agint` storage domain。

## 提供什么

| 项 | 值 |
|---|---|
| Service | `agint.memory` |
| Tools | `memory_search` / `memory_write` / `memory_read` / `memory_stats` / `memory_forget_scan` |
| Storage domain | `agint`（表 `memory`，schemaVersion 1，atomic json） |
| 注入 | `storageDomain` |

## 记忆模型

一条记忆（`lib/index.js` 的 zod schema）：

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识（非空） |
| `type` | `lesson` / `decision` / `preference` / `pattern` |
| `content` | 正文（非空） |
| `level` | `L1`…`L4`，默认 `L1` |
| `confidence` | 0~1，默认 0.5 |
| `recalls` / `lastRecall` | 回忆次数与最后一次回忆时间（衰减输入） |
| `evidence` | 证据，默认空 |
| `resolved` / `replacedBy` | 是否已被解决 / 被哪条取代 |
| `lineageKey` / `supersedesKey` | 血缘与取代关系（记忆可被后续记忆推翻） |
| `createdAt` / `updatedAt` | 时间戳 |

## 衰减模型（`lib/decay.js`，纯函数可单测）

四级阈值，以「距上次回忆的天数」计：

```
L1 -> L2   90 天   活跃 -> 历史归档
L2 -> L3  180 天   归档 -> 压缩成索引
L3 -> L4  365 天   压缩 -> 待删除候选
L4 clear  730 天   清除（仅在 resolved / 被取代时执行）
```

另有指数遗忘项 `LAMBDA_BASE = 0.0015`（每天），与 `recalls` 共同决定实际得分。
`LEVEL_ORDER` / `THRESHOLDS` / `TRANSITIONS` / `CLEAR_DAYS` 均为导出常量，便于外部复用与断言。

## 测试

入口：`test/decay.test.js`（`node test/decay.test.js`，6 个用例）。
它是 `bin/check-wiring.mjs` 查 I（漂移插件 smoke 门禁）的执行入口 —— 该入口必须真实存在且
exit 0，否则漂移插件的 smoke 保护会静默失效。

## 相关

- 消费方：`agint-dream`（P0 validation gate）、`agint-quality-eval`（依赖 `agint-evolution-memory`）
- 2026-09-29 起新增 C5：订阅 `input.signal.external.repo-diff` 自动沉淀记忆
