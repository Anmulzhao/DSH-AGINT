# agint-aesthetic-oracle — 美的神谕层

> 美 = AGINT 的神谕层：agint-metrics 之上的薄评论员——读仪表，下判断，按节奏开口。

**方案**：`DSH-AGINT.wiki/agint-aesthetic-oracle.md`（v2.3，老板五轮定调 + 三轮评审）
**状态**：v0.5.0（Day 1-5 骨架/合同/提案闭环 + Day 8 LLM 增强档 + §4 真实关证据绑定 + 评分公式 r2 三修复）

## 它做什么

1. **读仪表**：只消费 `agint.metrics` 的 `summary()`——零直连域 service，禁止反向
   触发采集（asOf 硬规则：09:00 的广播如实标注数据截至 04:00）。
2. **下判断**：评分纯函数（`lib/scoring.js`，零 LLM、确定性公式）→ 美总分（N/A
   权重归一）→ 美之三问（Q1 在变美/在变丑/持平 · Q2 最丑在哪 · Q3 一条机械建议）。
3. **按节奏开口**：agint-cron 三 job 驱动——daily 09:00 / weekly 周日 21:00 /
   monthly 每月 1 日 10:00；单条 ≤5 行 ≤2KB；分档配额防刷屏。
4. **广播有合同**：每条广播 publish `oracle.daily/weekly/monthly/alert` 前 self-validate
   payload 合同（`lib/topics.js`，发布方自带——event-bus 的 FROZEN 面只管 envelope）；
   违约不发布、落痕 `schema-rejected`。合同人读版：`schemas/oracle-topics.schema.yaml`。
5. **失败有缓存**：每次成功广播后落 `lastGood` 原子值快照；summary() 整体不可用时
   ≤7 天缓存 → stale 广播照发（`⚠缓存N天` 标注 + 审计留痕），无缓存才 alert + 抛错。
   ⛔ 不用 metrics.series() 回退——它与 summary() 同表同命运，没有独立生存性。

## 它不做什么（红线，§9.4）

- 不往 `METRIC_DEFS` 塞复合指标（noise_ratio / aesthetic_score 永远不进 metrics）。
- 写白名单只有两处：`evolution_log` 审计（targetKind=oracle-*，decision=ABSTAIN）
  + 自有存储域 `agint_aesthetic_oracle`。其余一切写 API 禁。
- 对 metrics 无特权：self-model / evolve / dashboard 同级读同一接口。
- activity 排除 targetKind=oracle 是硬规则，任何迭代不得移除（在 metrics 采集侧实现）。

## 自保与回滚（§6）

| 触发 | 动作 |
|---|---|
| 调度执行异常 | 重试 3 次（1s/4s/16s），重试期只在末次发 alert |
| 连续 3 次失败（重试后） | 沉默模式：只写审计不开口；24h 后 `oracle.alert` 一次 |
| 单日配额违规 ≥3 | 自动沉默 + 告警 |
| `oracle_pause` | 运行时静默（pause/resume 落状态表） |
| config `enabled:false` / env `AGINT_AESTHETIC_ORACLE=off` | 不 provide 服务 ⇒ cron job soft-skip，秒级可逆 |

**系统总分不触发任何回滚**——指标深红是系统的现状，神谕层是被请来报忧的；杀了它等于杀信使。

## dashboard 卡片（§5 硬规则 2 / AC-7b）

oracle 自订阅 `oracle.*` 4 topic（subscriber=dashboard，async），每 topic 最新事件
快照落 `oracle_cards` 表（独立成表——与广播主链分写，杜绝单行多写者竞态）。
dsh web 前端是封闭内部包不可注入，AGINT 侧的「dashboard 订阅」= 卡片状态面 +
`cards()` 查询面；UI 壳（dsh 会话内查询 / 未来独立面板）都从这里读。

## weekly 美谕提案（§5 / Day 4-5）

weekly 广播时从评分派生**至多 3 条提案**：可用维按绝对扣分 top3（0 扣分 = 阈内
不提），每条 = 纯机械动作 + evidence 必填，经 `agint.evolve.propose()` 写入
agint_evolve.proposal（status 锁 proposed）。**永不 auto-apply**：oracle 不碰
setStatus / curator_archive——观察者不动手改自己读的数；执行动作由老板批准后
走执行层既有门禁（D-QAF）。

## 服务面

`agint.aestheticOracle`：

- `runBroadcast(kind, opts)` — 单次广播（daily/weekly/monthly/alert；alert 不依赖 metrics）
- `runScheduled(kind, opts)` — 调度入口（cron 用；重试 + 连续失败记账）
- `alert(reason, detail)` — 告警出口（独立日配额 3）
- `pause(reason)` / `resume()` — oracle_pause 语义（resume 一键清沉默）
- `getState()` / `status()` / `history(limit)` — 状态与广播史
- `cards()` — dashboard 卡片快照（4 topic 最新事件，含 envelopeId/occurredAt/payload）

提案表出口（经由 evolve，不在 oracle 服务面）：`agint.evolve.listProposals({ source: 'agint-aesthetic-oracle' })`
按周看提案与采纳情况（proposed/applied/rejected 由老板经 evolve_set_status 流转）。

## 运行

- 测试：`node --test`（56 例，含 2026-09-27 标定 52.4 复算 + 2026-09-29 证据绑定回归 + r2 公式钉）
- 评分公式版本：**r2**（2026-10-09，提案 f51d3280）——bloat 饱和上界 / Q1 效应量门槛 /
  Q2 按偏离度 ratio 排序；payload 透传 formulaVersion，r1→r2 前后总分不可直接比
- 基线：前 7 条有效 daily 的均值；建立后 Δ 全部相对基线（总分没有及格线，只有趋势）
- LLM 增强档已实现（L1 措辞/L2 深挖/L3 提案润色），env AGINT_AESTHETIC_ORACLE_LLM=off 可关
- §4 真实关：Q3 建议必须绑定真实 lint 证据（wiki 矛盾/孤儿清单、rule_lint 明细），
  查不到就输出「本日无可执行建议」，不许兜底编一句（v0.4.1）
