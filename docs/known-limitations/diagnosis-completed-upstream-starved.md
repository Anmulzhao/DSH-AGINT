# 已知限制：`diagnosis.completed` 上游断供 —— 两道守门叠加，事件恒 0

> 状态：**断链已定性，根因全部落在仓库代码内可读。修复方案未定** —— 需要老板先定
> 「要不要往 `failure_pattern` 喂样本」，那是产品决策，不是接线问题。
> 观测日期：2026-10-09。相关：[diagnosis-report-loop.md](./diagnosis-report-loop.md)、
> [event-bus-shadow-publish-gap.md](./event-bus-shadow-publish-gap.md)。

## 症状

- `agint-diagnosis.report()` 的发布接线**存在且正确**，但总线 `diagnosis.completed`
  自 2026-10-06 起无新增。
- `agint_diagnosis` 域 `annotations` 表恒 **0 行**。
- 下游 `agint-input-gateway` 的 `adversarial` 频道因此收不到该主题
  （`signalsEmitted=0`）。

## 先纠正一个常见误读：不是 0 条

**总线 `diagnosis.completed` 全历史有 14 条**（2026-09-29 → 2026-10-06），
不是 0 条。`docs/known-limitations/diagnosis-report-loop.md` 记的「全历史 6 条」
是 2026-09-26 的快照，之后又长了 8 条。

但这 14 条**全部是空壳**：

| 字段 | 全部 14 条的值 |
| --- | --- |
| `clusterCount` | `0` |
| `targetIds` | `[]` |
| `rootCauseDistribution` | 七键**全 0** |
| 对应 `reports` 表行的 `annotationCount` | `0` |

**有事件 != 有诊断产物。** 这批事件零信息量，和「没有事件」在下游是同一种结果：
`adversarial` 拿不到任何根因分布。

## 取证（2026-10-09 实读生产存储）

读 `$DSH_HOME/storages/` 下各域 JSON：

| 观测项 | 结果 |
| --- | --- |
| 总线总条数 / 死信 | 12043 / **0** |
| 总线不同主题数 | 28 |
| `diagnosis.completed` | **14**（末条 `2026-10-06T11:09:39Z`） |
| 总线最后一条事件 | `2026-10-08T16:35:38Z` |
| `agint_diagnosis.annotations` | **0** |
| `agint_diagnosis.reports` | **14**（与事件一一对应） |
| `agint_diagnosis.clusters` | **0** |
| `agint_evolution.failure_pattern` | **1** |

上面这些是**某一次的生产存储实读值**，换机器 / 换时间会变。
复核命令见文末；**结论依赖的是代码里的守门，不是这些数字本身**。

## 根因链（每一环都在仓库代码里可读）

1. **`agint_evolution.failure_pattern` 只有 1 行。**

2. **`annotate()` 冷启动守门把它挡在门外** ——
   `plugins/agint-diagnosis/lib/index.js:56` 定义 `const COLD_START_MIN = 10;`，
   `index.js:225` 处 `if (patternCount < COLD_START_MIN) throw`。

3. **于是 `agint_diagnosis.annotations` 恒 0 行。**

4. **`report()` 的空壳守门在此早退** ——
   `plugins/agint-diagnosis/lib/index.js:398`
   `if ((reportData.annotationCount || 0) === 0) { ... return skipped; }`
   该 `return` 发生在 publish 块（同文件 `index.js:466` 起）**之前**，
   所以既不落 `reports` 行，也不发 `diagnosis.completed`。

**两道守门是叠加的，不是二选一。** 即使有人去掉 `report()` 的空壳守门，
`annotations` 仍是 0，产出的只会是更多空壳事件 ——
那正是 09-29 到 10-06 已经发生过的事（14 条全空壳）。

引入空壳守门的提交：`afe8fb2`
`fix(diagnosis): report() 加空壳报告守门，冷启动期不落reports 行`

## 上游为什么喂不满：failure_pattern 只能靠工具写入

全库搜 `failure_pattern`，`agint-diagnosis` 侧**全是只读**
（其 README / CHANGELOG 明写「`failure_pattern` 表只读」）。
唯一的写入方是 **`evolution_addFailure` 工具**
（`plugins/agint-evolution-memory/lib/tools.js:111`，ASK-gated 破坏性写）。

**没有任何自动路径喂它**，必须由 agent 显式调用该工具。
生产只有 1 条，离 10 条差 9 条，所以 `annotations` 恒 0。

## report() 的生产调用方只有两处，且都不活跃

| 调用方 | 位置 | 状态 |
| --- | --- | --- |
| `diagnosis_report` 工具 | `plugins/agint-diagnosis/lib/tools.js:93` | agent 显式调用，无自动触发 |
| `self-model` 观测回调 | `plugins/agint-self-model/lib/observation.js:122` | 事件驱动分支已在 `fromDiagnosisEvent` 判定下熔断；仅非事件驱动的刷新才走 |
| **cron** | — | **一处都没有** |

`diagnosis-watchdog`（`plugins/agint-cron/lib/jobs.js:488`）只调
`agint.diagnosis.stats()`，**不调 `report()`**。

## 未证实项（不得含糊）

**「10-06 之后 0 条」有两个都能解释的成因，本次未能分开：**

1. 空壳守门挡住了（`annotations` 恒 0，任何 `report()` 调用都必然早退）
2. 根本没人调 `report()` 了

**支持第 2 条的证据**：19:00Z 附近的报告节奏在 **2026-10-04 之后就没了**
（09-29 / 09-30 / 10-01 / 10-04 有，10-05 / 10-06 / 10-07 没有），
**这早于空壳守门的部署时间**。

**没能分开的原因：**

- `diagnosis-watchdog` 的 `reportRateGuard` 只持久化了**键名**、没存值
  ⇒ 无法从存储反推调用次数。
- `$DSH_HOME/logs/` 里只有**启动诊断**，且部分还是启动失败记录，**没有运行时日志**
  ⇒ 空壳守门那条特征 warn（`report()` 跳过落盘：annotations=0）grep 不到。

**这对修法的影响**：两种成因下，**光喂 `failure_pattern` 都不够** ——
还得有人真的调 `report()`。

## 复核命令（换机器时重跑）

```bash
# 1) 总线按主题普查（diagnosis.completed 实际条数 + 空壳率）
python3 -c "
import json, collections
d = json.load(open('\$DSH_HOME/storages/agint_event_bus.json'))
ev = d['tables']['events']
c = collections.Counter(v.get('topic') for v in ev.values())
print('总条数', len(ev), '死信', len(d['tables']['deadletter']))
rows = [v for v in ev.values() if v.get('topic') == 'diagnosis.completed']
rows.sort(key=lambda v: v.get('occurredAt') or '')
for v in rows:
    p = (v.get('envelope') or {}).get('payload') or {}
    print(v.get('occurredAt'), 'clusters=', p.get('clusterCount'), 'targetIds=', len(p.get('targetIds') or []))
"

# 2) 上游样本数（决定 annotate 放不放行）
python3 -c "import json;print(len(json.load(open('\$DSH_HOME/storages/agint_evolution.json'))['tables']['failure_pattern']))"

# 3) 各表行数（annotations 应 > 0 才说明上游通了）
python3 -c "import json;print({k:len(v) for k,v in json.load(open('\$DSH_HOME/storages/agint_diagnosis.json'))['tables'].items()})"

# 4) 若日志里有运行时输出，确认守门是否被咬
grep -rn "跳过落盘\|空壳报告守门\|cold-start" \$DSH_HOME/logs/
```

## 裁定：维持现状，不改（2026-10-09）

**空壳守门在正常工作，本条不是待修缺陷。**

要恢复 `diagnosis.completed` 的**有效**产出，需要同时满足：

1. `failure_pattern` 攒够 >= 10 条 —— 靠 `evolution_addFailure` 工具攒，
   即需要真实失败样本流入；
2. 有人调 `report()` —— 目前只有 agent 显式调用这一条路。

只做 1 不做 2，仍然 0 条；只做 2 不做 1，回到 14 条空壳的老路。

### ⛔ 明确否决的一个「修复」：不要下调 COLD_START_MIN

把 `COLD_START_MIN` 从 10 降到 1（或降到现有样本数）能让这条链「看起来通了」，
**但那是倒退，不是修复**：

1. **违反该表自己的契约。**
   `plugins/agint-evolution-memory/lib/schema.js:316` 的注释明写：
   「不存 `NO_EVIDENCE` 之类的『测不到』记录：测不到不是度量。
   那种状态走 `cycle.summary` + `failure_pattern`，
   **表里每一行都必须是一次真测量**。」
   样本不够时放宽门槛，等于把「测不到」写成「测到了」。

2. **会重演已发生的存储膨胀。**
   见 [diagnosis-report-loop.md](./diagnosis-report-loop.md)：
   同样的空壳 `report()` 曾把 `reports` 堆到 12,615 行、
   `agint_memory` 同步多出 12,605 条 `pattern`。
   那次事故的直接原因就是「无信息量的 report 照写照发」。

3. **喂不出真样本。**
   `failure_pattern` 的行是带 evidence 的结构化拒绝记录
   （现存唯一一条：`pattern=policy-abstain`、`category=integration`、
   `score=0`、`reason=policy-abstain:empty-results`、`triggeredBy=[abstain:empty-results]`）。
   **它不是错误日志**。工具调用报错（总线 `ov.tool.called` 带 `ok`/`error` 字段，
   实测 29 成功 / 5 失败）语义上不等价，**自动灌进去会污染这张表**。

> **让门槛去适应数据，不要让数据去适应门槛。**

### 那什么时候才该动它

只有当**真实失败测量自然流入**、`failure_pattern` 有机增长到 >= 10 条时，
`annotations` 才会开始有行，`report()` 才会产出非空壳事件。
在此之前，任何「让它通」的动作都是造数据，不是接线。

## 关联

- 同族：[diagnosis-report-loop.md](./diagnosis-report-loop.md)（`report()` 自激环，
  已掐断；本文是那次清理之后**残留的空壳产出**的另一面）
- 同族：[event-bus-shadow-publish-gap.md](./event-bus-shadow-publish-gap.md)
  （「publish-only / T1 影子期」这类措辞的状态判定陷阱）
- 下游：同一条 `adversarial` 断链的另一条腿见
  [curriculum-challenge-never-attempted.md](./curriculum-challenge-never-attempted.md)
- 教条同源：**「有调用点」不等于「有产出」；数生产存储的行数，不读设计稿的措辞**
