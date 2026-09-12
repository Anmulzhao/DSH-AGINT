# agint-trajectory — P2-1 进化轨迹记录（训练数据层）

> 设计稿：`DSH-AGINT.wiki/设计-P2-1-进化轨迹记录.md` v0.3
> 版本：v0.1.0（Sprint 18 实施范围 T1–T7 + Sprint 19 的 T8 导出 / T10 prune 主体）
> 存储域：`agint_trajectory`（独占，schemaVersion 1，3 表）

## 它干什么

AGINT 有决策层（evolution-memory）、蒸馏层（failure_pattern）、统计层（tool-stats），
**唯独没有原始轨迹层**。本插件补这一层：把每一次可归因的执行记成结构化轨迹，
成功/失败分离存储，可导出为 ShareGPT 供未来微调与离线分析。

**哲学底线**：轨迹**只做离线原料**——不回写任何上游域，不进任何在线打分/决策权重
（设计稿 §1.2 lesson 3）。

## Service 契约

### FROZEN 5（v0.1.0 冻结签名）

| Service | 签名 | 说明 |
|---|---|---|
| `record` | `record(input) -> { id }` | **永不 throw**（fail-open，内部捕获 → `counters.writeFailures++`） |
| `get` | `get(id) -> Trajectory \| null` | |
| `list` | `list(filter) -> Trajectory[]` | filter: `{source?, kind?, taskRef?, timeRange?, limit≤100}` |
| `export` | `export({filter, format, foldObservation?}) -> { successPath, failurePath, indexPath, counts, valid }` | 成功/失败**物理分离**两个文件 |
| `stats` | `stats() -> { bySource, byKind, totalBytes, oldest, newest, counters, discardRate, truncateRate, budget, calibration }` | 供 P2-2 与周报消费 |

### 非 FROZEN（观察期，v0.2 视稳定度转正）

`linkAttribution(id, {errorClass?, attributionId?, variantId?})`
`prune({maxAgeDays?, maxCount?, maxBytes?})`
`setEnabled(bool)` / `setSample(source, rate)` / `setRecordMode('count-only'\|'live')`
`calibration()` / `state()`

### FROZEN 不变量（5 条）

1. **fail-open** —— `record()` 任何内部异常不得向上抛出
2. **真实截断** —— payload 截断必置 `truncated: true` + `droppedSteps`，禁止静默截断
3. **分离导出** —— success 与 failure 永不混写同一文件（aborted 归失败侧）
4. **L0 红线** —— 不触碰任何 FROZEN 契约，只新增 `trajectory.*` 事件
5. **标定期门禁** —— `setRecordMode('live')` 无 ready 报告**抛错**（不是警告）

## 三态正交（§7.1）——别把它们混为一栏

| 维度 | 取值 | 默认 | 谁改 |
|---|---|---|---|
| 落盘档位 `recordMode` | `count-only` / `live` | `count-only` | `setRecordMode()`，受不变量 #5 门禁 |
| 采样率 `sample(source, rate)` | 0~1 | task 0.1，其余 1 | `setSample()` |
| 熔断 `enabled` | true/false | true | `setEnabled()`；连续 5 次写失败自动置 false |

`count-only` **不等于** `sample=0`：前者写入路径不执行但仍产出体积估算（标定期的目的），
后者写入路径执行了但全被过滤。

## 典型用法

```js
// 1. 首次挂载默认 count-only：先干跑攒标定期
const r = await agint.trajectory.record({
  source: 'task', kind: 'success', title: '重构 schema',
  taskRef: { sessionId: 's1', variantId: 'v-7', round: 7 },
  startedAt, endedAt,
  steps: [{ seq: 0, role: 'human', content: 'do it' },
          { seq: 1, role: 'gpt', content: 'ok', tool: 'bash', toolOk: true },
          { seq: 2, role: 'observation', content: 'done' }],
  final: { decision: 'DONE' },
});
// → { id: null, reason: 'count-only', bytes: 1024 }

// 2. 产出标定期报告（四项齐备才 ready）
const report = agint.trajectory.calibration();
// → { perDay, p50Bytes, p95Bytes, truncateRate, suggested: { maxCount, maxBytes }, ready }

// 3. 老板确认后切 live（无 ready 报告会抛错）
agint.trajectory.setRecordMode('live');

// 4. 导出（成功/失败分离 + 自检）
const res = await agint.trajectory.export({ format: 'sharegpt' });
```

## 治理参数默认（§7.2 / §7.4）

| 项 | 默认 | 触发动作 |
|---|---|---|
| 单条 payload 内联上限 | 256KB | 截断（**保头 + 保尾丢中段**）+ `truncated=true` |
| 整条拒记 | 1MB | `droppedPayload++` |
| 日配额 `maxPerDay` | 200（只算实际落盘） | `droppedFull++` + 发布 `trajectory.budget-exhausted` |
| 容量 `maxCount` / `maxBytes` | 1800 / 64MB | prune 最旧非 pinned |

> ⚠️ 容量初值是**带标注的初值**。设计稿 §7.4 要求由标定期报告按方程推导
> （`maxCount = 保留期 × 日均 × 安全系数`，`maxBytes = maxCount × P95`）。
> 设计稿按实测外推的 maxBytes 约 117MB，对 dsh-storage-json（全量读入内存）偏大，
> 首版取 64MB 护栏。**标定期报告出来后按 `computeBudget()` 重拍**。

## 事件（§5.1）

**订阅（async，不占 sync 配额）**：`dream.completed` / `evolution.proposed` /
`evolution.evaluated` / `diagnosis.completed`（归因回填）/ `evo-orch.task-started` /
`evo-orch.task-completed`（P2-3 未实施，不阻塞）。

**发布**：`trajectory.recorded` / `trajectory.pruned` / `trajectory.budget-exhausted`。

**降级路径（v0.3）**：event-bus 不可用 / 订阅失败 / `enableEventSubscribe=false`
→ 退回显式 `record()`，不丢数据只少自动触发，用 `via: 'event' | 'explicit'` 区分来源。

## 数据所有权（§8bis）——不复存别人的权威数据

| 数据 | 权威源 | 本插件 |
|---|---|---|
| 工具参数正文 | `agint_tool_stats.jsonl` 的 `args` | **不存**，只留 `toolCallId` 关联键 |
| 工具成败/耗时 | tool-stats 的 `ok` / `latencyMs` | 抄录标量 |
| 子代理元数据 | P2-3 `subagent_tasks` | **不存**，只留 `subagentTaskId` / `batchId` 外键 |
| 轨迹本身 | **本插件** | 权威 |

## 诚实标注（真实 > 讨好）

1. **脱敏不保证零泄漏** —— 规则正则只覆盖已知形态（sk-/Bearer/AKIA/email/api_key/私钥头），
   兜底靠 `setEnabled(false)` 一键熔断。
2. **指标上报当前是事件 + counters，不是真 metrics** —— `agint-metrics` 没有外部 record
   接口（只有 collect/summary），跨域写 `agint_metrics` 又违反域独占不变量。因此丢弃走
   「发布事件 + counters + `stats()` 暴露 + warn 日志」；若未来 metrics 暴露 record 接口
   会自动接上。
3. **prune cron 未自注册** —— `agint-cron` 只有 `list()` 接口，本版只暴露 `prune()`，
   周日 06:00 调度由外部 cron 接（设计稿 T10）。
4. **不注册 model-visible 工具** —— 观察层不需要模型平面入口；数据经 Service 给 P2-2
   与周报消费，需要时再补 `trajectory_*` 工具。
5. **标定期的截断率是估算值**（用 count-only 的估算样本算，因为此时没有真实落盘记录）。

## 测试

```sh
node test/smoke.mjs                       # 冒烟（一行能跑）
node --test "test/*.test.mjs"             # 全量单测（含静态契约）
```

| 文件 | 覆盖 |
|---|---|
| `test/schema.test.mjs` | 枚举 / 治理参数 / 预算方程 / id |
| `test/redact.test.mjs` | 脱敏命中与边界、规则可配、非法正则不崩 |
| `test/payload.test.mjs` | 归一化 / 摘要 / 用量聚合 / 截断保头保尾 |
| `test/calibrate.test.mjs` | 分位数 / 样本滚动 / 报告 ready 与 missing |
| `test/export.test.mjs` | ShareGPT 映射 / 折叠 / 分离 / 自检 |
| `test/service.test.mjs` | 五条不变量 + 配额 / 熔断 / prune / 导出端到端 |
| `test/subscribers.test.mjs` | 事件映射 / 降级 / 归因回填 |
| `test/event-contract.test.mjs` | **静态契约**：订阅清单 → 全库 grep 校验 publish 存在 |
