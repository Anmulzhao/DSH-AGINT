# agint-compress-guard

> P3-1 记忆压缩检查点机制（设计稿 v0.3，Sprint 20 实施 v0.1.0）
> 一句话：**压缩可以发生，上下文不许消失**（M4，fail-closed）。

对应设计稿：`DSH-AGINT.wiki/设计-P3-1-记忆压缩检查点机制.md`（v0.3，2026-09-12）。

## 它解决什么问题

长记忆系统的压缩是**有损操作**：上下文满了就摘要、摘要再摘要，三个月前拍板的
决策理由可能只剩一句含混概括。本插件在压缩发生的前/中/后做三件事：

1. **压前留检查点**（raw 快照，唯一事实源归 P1-1 `pre_compress_checkpoints` 表，Q3 分层不重建）
2. **压时提洞察**（规则版三类：decision / fact / preference；LLM 默认关，Q1）
3. **压后可找回**（`compress_recall` 工具 + 记忆查询 miss 兜底一次，单次单向不回写，Q4 双通道）

## 接线梯子（设计稿 §5.3 v0.3）

| 档 | 接线点 | 状态 |
| - | ---- | ---- |
| ~~A~~ | ~~继承 `BasicCompactionEngine`~~ | **已移出设计**（Hermes 反例 + 替换默认引擎风险高于收益；重启条件已预注册） |
| **B** | `ctx.on('session/event')` 过滤 `compaction/start\|summary\|end\|prune` | **唯一主战场**。事件名已 grep 宿主源码核实：`@deepseek-ai/dsh-session/lib/types/known-event-types.js`；`compaction/summary` 载荷含 `compactionId` / `shadowedSeqs` / `shadowedTokenCount`（`dsh-compaction-basic/lib/index.js` 实测） |
| **C** | Service `checkpoint()` 显式调用 | 兜底（梦境/周复盘/离线补录）；p1-kind + messages 时 raw 快照委托 `agint.memoryProvider.runPreCompressCheckpoint` |

## 两段式 fail-closed（Q2 粒度）

```
[1] raw 检查点写入 ── 失败 → BLOCKED_CHECKPOINT（硬门：非 shadow 档 abortCompress=true）
[2] 洞察提取（3s 软超时，≤20 条）── 失败 → DEGRADED_INSIGHT（软降级：raw 兜底，不中止）
放行 → guard_log 落一行 + compress-guard.checkpointed 事件
```

- **shadow 观察档**（默认开，§七挂载策略）：BLOCKED 降级为「记录告警不真中止」，
  观察一周误触发率后老板拍板转硬门。配置 `shadowMode: false` 转正。
- **恢复探测**（不变量 8）：连续写失败降级满 `recoveryProbeMs`（默认 300s，Hermes 同构）
  后放行一次探针级检查点，成功即复位回 fail-closed。没有恢复机制的降级闸门 =
  一次瞬时故障让护栏永久失效。

## 提取的单一入口（Q6 / 不变量 5）

提取器实现为 **apiVersion=2 的 `provider.onPreCompress()`**（`lib/provider-bridge.js`），
注册进 P1-1 registry——**不自动激活**（激活会切换记忆召回路径，属行为变更）。
转正步骤：`active_provider → 'compress-guard'`（prefetch/syncTurn 已完整委托
`agint.memory`，激活后召回行为与 builtin 一致）。

附带的 P1-1 最小 PR（设计稿 §5.1 载荷缺口正解②，< 5 行授权范围内）：
`memory.pre-compress-checkpoint` 事件载荷补 `checkpointId` + `sessionId`。
PR 生效前，P1-1 路径的洞察以 `linkPending=true` 落库，事件到达后自动回填。

## Service（FROZEN 6，§4.1）

`agint.compressGuard`：

| Service | 签名 | 说明 |
| --- | --- | --- |
| `checkpoint` | `(input) -> { checkpointId, status, insightsExtracted, checkpointRef, ... }` | 编排入口；**永不 throw**（fail-open 对调用方） |
| `extract` | `(input) -> Insight[]` | 离线补录；必须带 `checkpointRef`（不变量 1） |
| `search` | `({ keyword?, type?, timeRange?, limit≤50 }) -> Insight[]` | 默认排除 superseded 与 linkPending |
| `recall` | `({ query }) -> { insights, rawRefs?, status }` | 洞察 miss → raw 下钻（host-compaction → 会话文件按 shadowedSeqs 回溯） |
| `stats` | `() -> { status, byType, byStatus, recallHitRate, counters, coverage, tiers, sourceHealth }` | **双源合计 0 条 → `NO_SOURCE_REACHED`**（不变量 6） |
| `setEnabled` | `(bool)` | 全局熔断；关闭时压缩直通，counters 留痕 |

非 FROZEN：`setLlmExtract`（v0.1 显式拒绝 true）/ `reindex`（Sprint 21）。

## Tools（preset 平面，只读）

- `compress_recall { query, type?, limit? }` —— 恢复双通道①；返回标注 `[来源：压缩洞察 ins_xxx]`
- `compress_guard_stats` —— 周报健康度；`NO_SOURCE_REACHED` 必须原样呈现，禁止省略

## 零流量诚实（2026-09-13 R10 探针实测）

本机 `$DSH_HOME/sessions` 155 个会话文件 / 140,109 个事件**全部可解**（多帧 zstd
逐帧解码），其中 **compaction/summary = 0 次**——本机从未发生过宿主压缩。
含义（设计稿 §六bis）：

- M4 验收口径是「**有压缩发生时**不丢上下文」，不是「洞察产出多少条」；
- 标定期 `stats()` 恒返回 `NO_SOURCE_REACHED`——这是正确行为，不是故障；
- B 档代码已就绪，真实压缩一发生即开始工作（`hostCompactionsSeen` 起算）。

## 存储域

`agint_compress_guard`（schemaVersion 1，独占）：`insights` / `guard_log` / `counters` / `config`。
raw 快照不复制进本域（guard_log 只存 checkpointRef 引用 + 字节数）；洞察只增不改
（`supersededBy` 链），preference 默认 `highRetention`。

## 测试

```
node --test "test/*.test.mjs" test/smoke.mjs
```

63 用例（状态机三分支 / 不变量 1 validate / 软超时降级 / 恢复探针复位 / 熔断直通 /
兜底单次不回写 / supersededBy 链 / 事件名静态核实 K19 / 多帧 zstd 回溯 / fail-open 注错）。

## 哲学对齐自查（P7.5 五条）

- **简洁 > 冗余**：raw 层零重建（引用 P1-1）；接线只用宿主官方事件。lib 实测 ~1150 行，
  超出设计稿 ≤700 行预算——超出理由：R10 结论落定后按「检索入口 + 观测」实施保留了
  session-reader（多帧 zstd 逐帧解码，宿主流式 API 实测不续帧）与 B 档完整接线两个
  设计稿明确要求的模块；规则提取器本体 ~120 行在预算内。
- **真实 > 讨好**：主动承认洞察层是增益层而非必要条件（§〇ter）；零数据显式报警；
  recallMisses 诚实计数；LLM/reindex 未实现就显式拒绝，不假装。
- **安全 > 效率**：shadow 观察档渐进转正；全局熔断；兜底单次不回写防自我污染。
- **靠谱 > 聪明**：rawOffset / shadowedSeqs 可回溯；洞察只增不改；接线档位显式登记。
- **主动 > 被动**：B 档主动挂宿主官方事件；BLOCKED 告警级事件主动进周报。
