# agint-tool-stats — 工具使用画像

> 监听 `tools/result` 事件追加写 JSONL，形成工具调用画像。

## 提供什么

| 项 | 值 |
|---|---|
| Service | `agint.toolStats` |
| Service | `agint.toolStats.prune`（保留机制，2026-11-12 新增） |
| Tool | `tool_stats_summary` |
| 监听事件 | `session/created`、`tools/result` |
| 发布事件 | `toolStats.pruned`（prune 落地后） |
| 注入 | `tools` |
| 存储 | `$DSH_HOME/storages/agint_tool_stats.jsonl` + 同目录 `agint_tool_stats_rollup.jsonl`（atomic jsonl，非 storage domain） |

## 落盘格式

每执行一次工具，追加一行 JSONL。路径可通过 `config.jsonlPath` 覆盖，
默认取 `$DSH_HOME/storages/agint_tool_stats.jsonl`（**不写死绝对路径**：两台机器路径不同）。

### 参数指纹化（2026-11-12，`storeArgs`）

**默认 `storeArgs: false` = 不再把 args 原文写进 JSONL。**

依据（生产实测）：明细文件 7.9 MB / 7331 行，**args 正文占全文件 84%**
（bash 1.94 MB / 4210 次，edit 653 KB / 545 次，write 646 KB / 136 次）；
而每行**已经**带 `argFingerprint`(sha256) 与 `argsHash` ⇒ 统计口径（去重、
复用检测、模式聚类）用指纹就够，args 原文是纯体积负担，且是明文（命令、路径、
可能带 token 的参数全在里面）。

`storeArgs: false` 时每行写：

| 字段 | 含义 |
|---|---|
| `argFingerprint` | sha256(`${tool}::${stableStringify(args)}`)，本来就有 |
| `argsHash` | 纯 args 的 sha256 前 16 位，本来就有 |
| `argsBytes` | **新增** —— 原 args JSON 的字节数（体量指标，不含内容） |
| `argsPreview` | **新增** —— 原 args JSON 前 120 字符（超出截断） |

**不写 `args` 字段。** `storeArgs: true` 时行为与 0.2.0 完全一致（保留 args 原文），
供"要看参数正文"的排查场景回退。

⚠️ **存量行不回填改写**：已落盘的旧行仍带 `args`，prune / backfill 都不会去改它们
（改写等于毁证）。⇒ 同一份文件里"带 args 的旧行"与"不带 args 的新行"并存是常态。

### 读侧降级

读侧任何依赖 `record.args` 的地方，在 `storeArgs:false` 下**优雅降级，绝不抛错**：

- `repeatPatterns()` → `sampleArgs: undefined` + `argsUnavailable: true`；
  `suggestedSkillName` 降级为 `${tool}-pattern`（有 args 时才走命令词命名）。
- `summarize()` / `slowest()` / `failureRate()` / `timeseries()` / `resourceWindow()`
  **完全不碰 `args`**（只读 `ts` / `tool` / `ok` / `latencyMs`）⇒ 指纹化对它们零影响。
  这是"敢默认关掉 args 原文"的判据（逐字段核过，不是"应该没影响"）。

## 保留机制（2026-11-12）：30 天明细 + 周 rollup

```js
const prune = ctx.get('agint.toolStats.prune');   // 缺席是常态 → 取不到就跳过
if (typeof prune === 'function') {
  const r = await prune({ maxAgeDays: 30, dryRun: false });
  // → { removed, freedBytes, rolled, dryRun, applied, kept, maxAgeDays, cutoff }
}
```

- **超期判定**：`rec.ts`（epoch 毫秒）< `now - maxAgeDays * 86400000`。
  `ts` 缺失/坏行 ⇒ **不删**（只删能证明超期的行）。
- **先 rollup 再删明细**：被删明细按「工具 × 周」（UTC 周一 00:00 为一周之始，
  周键 = 该周周一的 `YYYY-MM-DD`）聚合成一行，写进**同目录**
  `agint_tool_stats_rollup.jsonl`。
- **一行一周一工具**：同一 (week, tool) 被多次 prune 命中时**合并**（calls / failures
  累加、firstTs 取小、lastTs 取大、p95 按合并后的延迟样本重算），不会一周写 7 行。
  合并需要历史延迟样本 ⇒ rollup 行里保留 `latencies`（纯数字，**不含 args**）。
- **p95 口径与 `aggregate.js` 一致**：升序取 `min(n-1, floor(n*0.95))` 下标。
- **dryRun**：`dryRun:true` **只算不删不写** —— 返回将删多少行（`removed`）、
  将释放多少字节（`freedBytes`），文件一个字节都不动（`applied: false` 标明没落盘）。
- **事件**：prune 落地后通过 `ctx.get('agint.eventBus.publish')` 发 `toolStats.pruned`，
  payload `{ removed, freedBytes }`；总线缺席或抛错 ⇒ **静默跳过**（不抛错）。
  dryRun 不发事件。

消费方约定：`agint-cron` 的 `storage-prune` job 用
`ctx.get('agint.toolStats.prune')` 调用，**取不到就跳过**（缺席是常态，不报错）。

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

## 配置

| 配置 | 默认 | 说明 |
|---|---|---|
| `jsonlPath` | `$DSH_HOME/storages/agint_tool_stats.jsonl` | 明细文件 |
| `sessionsRoot` | `$DSH_HOME/sessions` | backfill 的会话根 |
| `storeArgs` | `false` | 是否保留 args 原文（回退开关） |
| `rollupPath` | 明细同目录 `agint_tool_stats_rollup.jsonl` | 周 rollup 文件 |

## 测试

- `test/smoke.mjs` —— **smoke 入口**（13 个用例）：参数指纹化 ① ②、prune ③、
  dryRun ④、读侧降级 ⑤、apply 级配置通路 ⑥ ⑦。
- `test/aggregate.test.js` —— 聚合逻辑（9 个用例）
- `test/throttle.test.js` —— 节流逻辑（2 个用例）
- `test/backfill-v3.test.mjs` —— v3 会话回填
- `test/lazy-service.test.mjs` —— 懒取上游服务（5 个用例）
- `test/resource-window.test.mjs` —— 资源窗口聚合（9 个用例）

⚠️ `tests.entry` 只能指向单个文件，其余测试不会被 `bin/check-wiring.mjs` 自动跑到；
修改本插件时需手动跑全部。
