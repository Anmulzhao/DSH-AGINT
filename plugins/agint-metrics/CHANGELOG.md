# Changelog — agint-metrics

## v1.3.0 — 2026-11-11 — 宿主子代理信号补订阅（接线修复）

> 本节与并行的「skills 字节分类」任务共用 v1.3.0 版号。那部分的代码与条目此刻**尚未入库**，
> 由该任务自行收口；本条只覆盖 `lib/eventCounters.js` 的订阅补齐（commit 8544c90）。
> `manifest.json` / `package.json` 的版本号 bump 随该任务一起落，本次不动。

**为什么**：`check-wiring` 报 2 个硬缺口 `NO_SUBSCRIBER(input.signal.host.subagent-start / -end)`。
根因是 11-03 `agint-event-bus/lib/host-bridge.js` 扩容时只接发布、没接消费。
这是存量债，11-04 起已记录在案；与 DSH_HOME 迁移（10-06）无关，首条事件晚于迁移 29 天。

**变更**

- `eventCounters.js` 的 `SUBSCRIPTION.topics` 补三条宿主主题：`subagent-start` / `subagent-end`
  / `workflow-phase`，对应 key `host.subagentStartCount` / `host.subagentEndCount` / `host.workflowPhaseCount`。
- `workflow-phase` 是同族潜在缺口（发布方 1 / 订阅方 0 / 生产 0），此刻只软报 `NOT_YET_FIRED`，
  第一次有工作流跑起来就翻成 `NO_SUBSCRIBER`。一并接，避免同一诉求分两次改、两次重启。
- 落点选 metrics 而非新建插件：metrics 是既定统一遥测出口，`domain-changed` / `workflow-end`
  已是同形态。「宿主派了多少子代理、成没成、用哪个 provider」此前在 AGINT 侧零指标。
- 改正取证口径：`deliveredTo` 是 `bus.js` 里 `publish()` 的返回值，**不落盘**，
  原注释把它写成「生产存储实读」属过强断言，已换成可测的计数对照。

**验证**

- `test/event-counters.test.mjs` 12/12；`bin/check-wiring.test.mjs` 35/35。
- `check-wiring` 0 硬缺口 PASS，两主题由 `NO_SUBSCRIBER 1/0` 转 `OK 1/1`；三副本 md5 一致。
- `bin/check-wiring.mjs` 本体未改动（不是改门禁凑绿）。

**运行态 / 数据态验收（2026-11-13 复核：已生效）**

- 冷启 `bootAt=2026-11-11T11:51:32.873Z` 晚于部署同步 `11:23:12Z` ⇒ 加载的是新文件。
  面板 `/v2/data` 里 agint-metrics 订阅 `createdAt=11:51:39.983Z`，10 条 topic 全在位。
- 冷启后宿主实派 3 个子代理（runId `f62c2228` / `282fc6eb` / `3f44fab1`）。
  总线 6 条边界事件 ↔ metrics 6 条计数，按 `runId + hostEvent` **6/6 配对**，
  孤儿计数 0、漏计 0，投递延迟 9–33 ms。
- 发布侧总量 40→43（start）/ 35→38（end），增量与计数一致。
- `stopReason` 收到 `error` 1 次、`completed` 2 次 ⇒ 失败路径同样计数，不是只数成功。

**仍未验证 / 已知无信息量（不声称已验证）**

- `workflow-phase` 与 `workflow-end` 生产仍各 0 条事件、0 条计数 ⇒ `NOT_YET_FIRED`。
  属预防性接线，还没有真实工作流跑过。
- 三条 `subagent-end` 的 `messageLength` **全为 0**，含 `completed` 的正常结束 ⇒
  宿主没供 `lastAssistantMessage`，该字段当前无信息量。上游既有问题，本次不动。


## 1.2.0 — 2026-11-08 cron 失效拆两维度（提案 cdf41d63）

### 问题

`cron.staleJobs` 只有一个口径（过期未跑），阈值是悬崖：series 里同一分钟出现过 7 和 3
两个值，delta 因此失去意义；运维也分不清「该跑没跑」与「早就不跑了」。

### 改动

- 新增两个指标 key：
  - `cron.staleOverdue` —— 过期未跑。取 `health().staleOverdue`；宿主旧版本没有这个
    字段时**回落** `health().issues`（同一个口径，不静默变 0）。
  - `cron.staleInactive` —— 久未活动。取 `health().staleInactive`；宿主旧版本没有 ⇒ 0。
- `cron.staleJobs` **保留**，降级为两者的**并集**（按 id 去重）。meta 里带
  `deprecated: true` 与 `definition: union(cron.staleOverdue, cron.staleInactive)`。
  旧看板 / 报告模板直接引用这个 key，删掉会当场空图。
- 基础指标块 13 → 15（总 17 → 19）。

### 口径变了（看趋势须知）

`cron.staleJobs` 的口径从「单一过期计数」变成「两维度并集」。跑过的 job 两个维度高度
重叠，但**从未运行**的 job 只进久未活动维度 ⇒ 汇总值可能比历史值大 1~2。
要判趋势请改用两个新维度；`cron.staleJobs` 只作旧看板兜底。

### 验证

`test/metrics.test.js` 新增 3 组判据（两维度分开采集、staleJobs 并集去重而非相加、
旧宿主回落 issues）；`test/metrics-ext.test.js` 的基础块计数断言同步更新（13→15 / 17→19）。
agint-metrics 测试 45/45 通过。

## 1.1.4 — 2026-11-02 补 `inc()` 出口（复活总线的全部计数）+ 两条宿主事件主题

### ① 补 `inc()` —— 一条躺了很久的静默失败

`agint-event-bus` 的 `busCtx.metrics` 从 v0.7.0 起就是：

```js
metrics: (key, delta) => { const m = ctx.get('agint.metrics'); if (m?.inc) return m.inc(key, delta); }
```

而**本服务从来没有 `inc` 方法**（实际方法只有 collect / summary / series / keys / stats）。
⇒ 总线的全部计数（`publishInvalid` / `handlerError` / `deliveryFailed` / `deadletter`，
以及 2026-11-02 B1 新加的 `hostBridge*`）**一直是静默丢弃的**：
不报错、不落表、调用方零信号。

这不是"算错了"，是"这条路上什么都没发生，而没人知道"—— 本项目最典型的失败形状。
它恰好挡在「可观测性能不能成立」的入口上，所以补上。

- `inc(key, delta=1)`：写一条增量记录（与 eventCounters 同形），查询走 summary / series。
- 非法输入（空 key / NaN / 非数字）返回 `false` 且**不写** —— NaN 进了时间序列就洗不掉。
- 测试 `test/service-inc.test.mjs` 5 条，含阴性对照（把 inc 删掉，第 ① 条立即红）。

### ② 两条宿主事件主题的计数（B1 的消费侧）

**背景**：`agint-event-bus` 0.8.0 把宿主的 `domain/changed`（白名单域）与 `workflow/end`
桥成了总线主题。本版是它们的**唯一订阅方** —— 与 2026-10-26 那批同一形态、同一张表。

**为什么值得记**：这两件事在 AGINT 侧此前**零指标**。进化闭环能看见自己发了什么事件，
却看不见自己**被写了什么**：一个域昨晚写了 300 次还是 0 次，之前只能去翻存储文件时间戳。

**改动**：
- `COUNTER_METRIC_KEYS` / `COUNTER_METRIC_LABELS` 各加两行。
- `SUBSCRIPTION.topics` 加两条（仍是**单行字面量** —— 门禁靠正则扫源码，变量形式对它是不可见的）。

**验收**：`node --test test/event-counters.test.mjs` → **10/10 通过**
（覆盖清单用例改为字面量 7 条：刻意不写 `length >= 5`，那对「悄悄删掉一条」完全无感）。

**生产实测（2026-11-02 00:58，部署后约 1 分钟）**：`eventBus.hostDomainIgnored` 落 **332 行**
⇒ 桥接确实订阅到了宿主 `domain/changed`，`inc` 也确实写进了表。
⚠️ 这 332 行同时暴露了新问题：非白名单域写入频率约 **5.5 次/秒**，
若每条都写表，metrics 表每天涨 40 万行。已在 `host-bridge.js` 改为**采样**
（首次 + 每 100 次），见该文件 `ignoredSeen` 段注释。

---

## 1.1.2 — 2026-09-29 修复：metrics_summary output schema 缺 meta ⇒ 宿主整条拒收

**事故**：agint 自检调 `metrics_summary` 返回 `Error: tool "metrics_summary" ... schema
validation error`——不是指标算错，是**工具压根没跑起来**。宿主拿 `output.schema`
校验返回值，校验不过就把整条 tool result 换成错误，agint 侧只看到一句报错。

**根因**：1.1.1（09-28）给 `summary()` 补了 `meta: rec.meta` 透传，但 `tools.js` 里
`metrics_summary` 的 output schema 没同步声明 `meta`，而 `additionalProperties: false`
⇒ 多出来的 meta 直接判非法。**同一根因的第二次发作**：09-28 钉的是 service 侧
（summary 漏字段），这次断的是工具侧（schema 漏字段），两侧都各有一半。

**为什么既有门禁没拦住**（三条一起失效，值得记住）：
- `bin/check-tool-schemas.mjs` 只验证 schema **字面量能否编译**，不验证 service
  返回值能否装得进去——所以修复前它照样 PASS；
- `test/service-summary.test.js` 只钉 service 侧，不碰工具 schema；
- 唯一的真相在宿主运行时，而静态链路没有宿主。

- 修复：`metrics[].items.properties` 补 `meta: { type: 'string' }`，与 `metrics_series`
  口径一致。**不挂 `required`**——避免单条记录 meta 缺失时整个自检工具报废
  （宁可少一个字段，不可看不到全部指标）。
- 新增 `test/tools-schema-contract.test.js`：真调 `apply()` 取注册的工具定义，
  真调 `summary()`/`series()` 取真实返回，交叉断言字段集合——把这道接缝钉死。
- **红验证**：临时撤掉 meta 声明后该测试确实变红并精确报出
  `缺少 "cron.maxOverdueDays.meta"`（不是摆设），恢复后 18/18 绿。
- 顺带修版本脱节：`package.json` 停在 `0.1.0`，而 manifest 是 `1.1.0`、CHANGELOG
  是 `1.1.1`（09-28 漏 bump）。`agint-family-panel` 的 panelVersion 读 package.json
  ⇒ 面板长期显示错误版本。三处统一到 1.1.2。

**部署**：bundle 位 + 兼容镜像位两处 `lib/tools.js` 已同步（需重启 dsh web 生效）。

---

## 1.1.1 — 2026-09-28 修复：summary() 透传 meta（神谕层总分虚标 100 根因）

**事故**：2026-09-28 晨报（oracle-daily）美总分播 100，同日标定应为 52.4。四维里
noise / confidence / redundancy 全 N/A——采集侧数据齐（存储 meta 完整）、消费侧
全 null。根因：`service.js` `summary()` 返回体漏带 `meta` 字段（`series()` 一直带），
而神谕层派生全靠 meta（noEvidence.count / rulesTotal / wiki.total /
avgConfXCompliance / fileCount）。两侧单测各自全绿、接缝处静默断裂——Day 0 的
AC-0a 用 computeMetrics 直测，绕过了 service 层，接缝无测试覆盖。

- 修复：`summary()` 的 metrics.push 补 `meta: rec.meta`（与 series() 口径一致）
- 新增 `test/service-summary.test.js`：真实 service（内存表 + 假源）走 collect →
  summary，断言四类 meta 落地且与 series() 同源——把接缝钉死
- 复算验证：用 2026-09-27 20:00 生产 meta 逐项代入 §3.6 公式 = 53.6 分（与
  09-27 标定 52.4 的差异为 wiki 18→19 页、memory 336→362 条的自然波动）
- 部署：bundle 位 + 兼容位两处 service.js 已同步（需重启 dsh web 生效）

**连带澄清**：09-28 weekly 广播 `proposals: 0` 是同一根因的下游症状（四维 N/A →
无扣分 → buildWeeklyProposals 无料可提），修复后自愈，非独立 bug。

## 1.1.0 — 2026-09-27 美的神谕层 Day 0（方案 C：原子归 metrics，派生归神谕层）

- 新增 `lib/metrics-ext.js`：METRIC_DEFS_EXT 4 个原子 key
  - `autocreate.candidatesRejected`（skillAutocreate.stats().candidates.byStatus.REJECTED；stats 缺席退化 listCandidates 自数）
  - `skills.totalBytes`（两处 skills 根 Σ SKILL.md 字节；`makeSkillsFsSource` 递归遍历）
  - `evolution.logCount7d` / `evolution.logCount30d`（agint.evolution.getLogRange 一次 30d 窗 + 本地分窗，limit 放开避免 200 截断）
- `metrics.js`：METRIC_DEFS = 基础 13 + 扩展 4 = 17；computeMetrics 尾部接入扩展块（整体 try/catch 不拖垮基础 key）
- 三个既有 key 的 **meta 增补**（value 一律不动）：
  - `rules.lintIssues.meta.rulesTotal`（rules.list()，冗余度分母）
  - `wiki.orphans.meta.total`（lint().checked，噪声比分母）
  - `memory.total.meta`：`noEvidence{count,ids(cap50),capped}` + `avgConfXCompliance`（Σ(conf×[evidence非空])/N，神谕层决策确信度口径）
- `service.js`：sources() +3（skillAutocreate / evolution / skillsFs），懒解析软降级
- 新增 `test/metrics-ext.test.js`（扩展 key / 防御 / meta 增补 / 17 defs 断言）

## 2026-09-20 — 事件总线接线（方案 A / A2）：mount.* 补订阅方

**背景**：mount 六个 topic 有真实发布方、但**订阅方为 0**，挂载成功/失败完全不可观测，
只能翻 tickets 表。

- 新增 `lib/mountCounters.js`：订阅 `mount.requested / succeeded / failed /
  restart-requested / restart-completed / restart-failed`，每条事件写一条计数记录
  （key：`mount.succeededCount` 等），meta 保留 ticketId 与 reason 便于对账
- `index.js` 在 domain open 后挂载该订阅
- 新增 `test/mount-counters.test.mjs`（6 项）

**顺带修复**：disposer 里 `if (domain) return domain.close();` 会在 domain 打开后
**跳过 bus 订阅注销**。已改为先注销所有订阅再关 domain。

## 1.0.0 — Sprint 12 A5
- 顶层 stub 补建：`manifest.json` / `CHANGELOG.md` / `README.md` / `test/smoke.mjs`
- 沿用真实 lib 版本号 1.0.0
- 接入 `agint.eventBus` 的 `policy.deployed` / `policy.rolledback` 影子计数（`policyCounters.js`，已实装）
- 不变量：lib/ 真实代码未改动
