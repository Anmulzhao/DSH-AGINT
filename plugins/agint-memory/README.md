# agint-memory — 记忆读写与 L1-L4 衰减

> 长/短期记忆读写 + 四级衰减扫描。独占 `agint` storage domain。

## 提供什么

| 项 | 值 |
|---|---|
| Service | `agint.memory` |
| Tools | `memory_search` / `memory_write` / `memory_read` / `memory_stats` / `memory_forget_scan` / `memory_remove` |
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
| `recalls` | 召回次数 = 表内 legacy 值 + 旁路命中计数（读接口合并呈现，见「召回计数口径」） |
| `lastRecall` | 写入时刻。衰减按它计时；召回计数**不改**它 |
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

另有指数遗忘项 `LAMBDA_BASE = 0.0015`（每天）：`effectiveConfidence = confidence × exp(-λ·天数)`，
天数取自 `lastRecall`（回退 `updatedAt` → `createdAt`）。
⚠️ **`recalls` 不参与排序与衰减** —— 早期 README 曾写「与 recalls 共同决定实际得分」，
那是错的：`decay.js` 的 `effectiveConfidence` 从不读 `recalls`（2026-11-07 核对源码更正）。
`LEVEL_ORDER` / `THRESHOLDS` / `TRANSITIONS` / `CLEAR_DAYS` 均为导出常量，便于外部复用与断言。

## 召回计数口径（0.3.0）

`recalls` = 这条记忆被「用过」几次。2026-11-07 之前它**从未被接线**：
生产池 869 条 `recalls` 869/869 全为 0 —— 唯一写点 `memory.recall()` 的生产调用者
被默认关闭的 `builtin_recall_touch` 挡住，而其入口 `manager.beginTurn()` 全仓无调用者。

现在的口径：

| 事件 | 算召回吗 |
|---|---|
| `memory_search` 工具命中 | ✅ 算 |
| `agint_search` 工具命中（记忆域部分） | ✅ 算 |
| provider prefetch / 压缩兜底 / 诊断反事实 / 质量评估检索 | ❌ 不算（后台自检，不是用户使用） |
| `memory_read` / `memory_list` / `memory_forget_scan` | ❌ 不算（读不是用） |

计数落在**旁路文件** `<DSH_HOME>/storages/agint_memory_hits.jsonl`（append，一次检索一行），
不写 memory 表。原因实测：memory 表是 single-layout 单元（单文件 ~879KB），每写一行都要
整体重写该文件 —— 单行写实测平均 764ms（工具统计 `memory_write` n=517），一次检索命中
20 条要等 ~15 秒，写回型计数在生产上不可行。

读接口（`list()` / `search()`）把计数合并进返回条目的 `recalls`：
**表内 legacy 值 + 旁路命中数**。合并只在读侧呈现，不回写表 ⇒ **排序与衰减口径不变**。
新增 service 方法：`noteHits(ids)`（记一次命中）、`hitCounts()`（计数快照）；
`stats()` 多带 `hits: { entries, total }`。

计数文件按行增长（一次检索一行，约 100 字节）：一万次检索约 1MB。

## 0 动作自解释（0.2.1）

`memory_forget_scan` 默认 dry-run。池子太新时返回 `0 planned, 0 applied`。
report 另带三项，说明为什么没有动作：

| 字段 | 含义 | 空池或无候选 |
|---|---|---|
| `oldestEntryDays` | 池内最老条目距今天数 | `null` |
| `nextThresholdDays` | 离最近一次降级还差几天，`0` 表示已有条目达标 | `null` |
| `nextTransition` | 最近那个阈值的标签，如 `L1->L2` | `null` |

输出示例：`memory_forget_scan: 0 planned, 0 applied` 下一行
`oldest=42d, L1->L2 in 48d`。口径见 `decay.js` 的 `scanHorizon()`。
L4 的 clear 需要额外资格条件，不计入降级候选。

## 测试

入口：`test/decay.test.js`（`node test/decay.test.js`，6 个用例）。
它是 `bin/check-wiring.mjs` 查 I（漂移插件 smoke 门禁）的执行入口 —— 该入口必须真实存在且
exit 0，否则漂移插件的 smoke 保护会静默失效。

本插件全部测试：`node --test test/decay.test.js test/tools-contract.test.mjs test/forget-scan-horizon.test.mjs test/hit-counter.test.mjs`。
`forget-scan-horizon.test.mjs` 用 fake ctx 起真 service，覆盖 report 字段与 render 输出。
`hit-counter.test.mjs`（2026-11-07）覆盖召回计数：模型检索命中推进计数、后台检索与
`memory_read` 不推进（对照组）、持久化、尾部半行容错、合并口径、以及「计数没接线就会变红」
的负控制（实测摘掉工具层的 `countHits: true` → 11 例中 6 例变红）。

## 相关

- 消费方：`agint-dream`（P0 validation gate）、`agint-quality-eval`（依赖 `agint-evolution-memory`）
- 2026-09-29 起新增 C5：订阅 `input.signal.external.repo-diff` 自动沉淀记忆
