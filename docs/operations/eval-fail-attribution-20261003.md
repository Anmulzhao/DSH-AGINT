# eval 存量 FAIL 归因（2026-10-03）

> 生成器：`bin/attribute-eval-fails.mjs`（只读）· FAIL 6 条 · 已归因 6 条

> 覆盖率 **100.0%**（6/6）· 阈值 80% · ✅ 达标

> ⛔ 每条归因都附**可复算证据**（权威模块的实时读数 vs 场景断言值），不是「看起来像」。
> ⛔ 证据不足时诚实标 `NOT_ATTRIBUTED`，不猜 —— 错类会把修法引到反方向。

## 1. 根因类分布

| 根因类 | 条数 | 含义 | 该改什么 |
|---|---|---|---|
| `ASSERT_DRIFT` | 5 | 被测行为演进（或断言的前提被推翻），场景期望没跟上 | 改场景期望 |
| `HARNESS_GAP` | 1 | driver 的 mock / 派发与真实接口不一致 | 改 driver 基建 |
| `REAL_DEFECT` | 0 | 被测代码不满足场景声明的契约 | 改产品代码 |
| `NOT_ATTRIBUTED` | 0 | 证据不足，不猜 | 人工取证 |

> ✅ **0 条 REAL_DEFECT** —— 没有一个 FAIL 是产品缺陷。全部在评估侧（场景期望 或 driver 基建）。

## 2. 逐条归因

### `cron-default-jobs-registered`

- **根因类**：`ASSERT_DRIFT`　**探针**：`defaultJobs`
- **域 / 插件**：cron / agint-cron
- **场景文件**：`eval/scenarios/agint-cron.scenario.json`
- **结论**：场景漏列了 14 个新增默认 job（真实集合 ⊇ 场景集合）⇒ 断言比实现旧
- **证据**：
  - 场景 expectedIds（10 个）：baseline-regression-suite,curator-weekly,evolve-review,memory-decay,metrics-collect,night-dream,prompt-static-check,skill-autocreate-aggregate,tool-stats-backfill,wiki-lint
  - jobs.js 真值（24 个）：baseline-regression-suite,curator-weekly,curriculum-weekly,diagnosis-watchdog,evolution-cycle,evolution-reconcile,evolve-review,ledger-anchor,memory-decay,memory-provider-health,metrics-collect,night-dream,oracle-daily,oracle-monthly,oracle-weekly,outcome-measure,prompt-static-check,skill-autocreate-aggregate,skill-autocreate-observe,skill-autocreate-release,skill-graph-weekly,spec-index-refresh,tool-stats-backfill,wiki-lint
  - 真实有、场景无：curriculum-weekly,diagnosis-watchdog,evolution-cycle,evolution-reconcile,ledger-anchor,memory-provider-health,oracle-daily,oracle-monthly,oracle-weekly,outcome-measure,skill-autocreate-observe,skill-autocreate-release,skill-graph-weekly,spec-index-refresh
  - 场景有、真实无：（无）
  - driver 断言方式：JSON.stringify(ids) === JSON.stringify(expectedIds.sort()) ⇒ 严格逐项相等，多一个即 fail
- **修法**：改场景：把 expectedIds 补齐到与 jobs.js 一致。⛔ 不要改 driver 的相等判据 —— 放宽后新增 job 就再也不会被发现。

### `service-annotations-table-full-throws`

- **根因类**：`HARNESS_GAP`　**探针**：`tableFull`
- **域 / 插件**：diagnosis / agint-diagnosis
- **场景文件**：`eval/scenarios/agint-diagnosis.scenario.json`
- **结论**：driver 的 fake table 只提供 entries()，没有 size；而插件的守门读的是 t.size ⇒ undefined >= cap 恒 false ⇒ 守门永不触发 ⇒ 场景永远看不到抛错
- **证据**：
  - 场景想造满：annotationsCount=200（cap=200）、failurePatternCount=20
  - 守门顺序：表满(annotations>=cap) → 无后续守门（failurePatternCount=20 ≥ 10，cold-start 不拦）
  - 插件读法：plugins/agint-diagnosis/lib/index.js:233 `if (t.size >= LIMITS.ANNOTATIONS) throw ...`
  - 真实 Table 接口：@deepseek-ai/dsh-storage-domain/lib/index.js:253 `get size() { return this.records.size }`
  - driver fake table：有 entries=true、有 size=false
  - driver detail（实跑）：`未抛错，反而返回 rootCause=TOOL_GAP` ⇒ 守门确实没触发
- **修法**：给 driver 的 makeFakeCtx 的 table 加上 `size: entries.length`（⛔ 不改插件的守门逻辑 —— 用 undefined 比较来「通过」是假防线）。⚠️ 这是 K141 同款：部署位测试红了先判调用前提。

### `s12-05-policy-policy-deployed-rolledback-shadow`

- **根因类**：`ASSERT_DRIFT`　**探针**：`umbrellaKey`
- **域 / 插件**：event-bus / agint-event-bus
- **场景文件**：`eval/scenarios/agint-event-bus-s12-05-policy.scenario.json`
- **结论**：断言的**测量方式**基于一个已被推翻的前提：「伞键上不该有 publish」。event-bus 后来主动补了 `ctx.provide('agint.eventBus', {...publish...})`（纯加法，让消费方免写回退链）⇒ 伞键有 publish 是**当前设计的正确行为**，而场景仍把它当成缺陷。真正该守的是「policy 走的是单 service 接口」
- **证据**：
  - 场景 assertion 原文：`publishDoesNotUseUmbrellaKey = umbrellaKeyCalled === false`
  - 场景测量代码：先 `ctx.get('agint.eventBus')`，再判 `.publish` 是否函数 ⇒ 测的是「伞键存不存在」
  - event-bus 现状：plugins/agint-event-bus/lib/index.js:167 `ctx.provide('agint.eventBus', { publish, subscribe, inspect, ... })`
  - 实时核对：hasUmbrellaProvide=true umbrellaProvidesPublish=true
  - policy 侧实际写法（对）：policyEvents.js:108 `ctx.get('agint.eventBus.publish')` —— 单 service 接口，符合设计
  - driver detail（实跑）：12 项断言里 11 项 true，只有 `publishDoesNotUseUmbrellaKey:false` 红
  - ⇒ 其余 11 项都过，说明被测行为是对的，错的只是这一项的测量方式
- **修法**：改 branch 的测量方式：不再问「伞键有没有 publish」，改为**替换 publish 单 service 接口**（ctx.get 劫持成返回计数函数），再断言调用计数 === 0。⛔ 不要删掉这项断言 —— 「policy 不走伞键」这条设计约定仍要守，只是测法要换。

### `stats-reports-counts-and-limits`

- **根因类**：`ASSERT_DRIFT`　**探针**：`statsLimits`
- **域 / 插件**：evolution-memory / agint-evolution-memory
- **场景文件**：`eval/scenarios/agint-evolution-memory.scenario.json`
- **结论**：schema.js 的 LIMITS 新增了 key（4 个）/ 场景多了 key（0 个） ⇒ driver 用 JSON.stringify 全等比对，新加一个上限就 fail
- **证据**：
  - 场景 limitsShape（3 个）：{"FAILURE_PATTERNS":100,"SUCCESS_TEMPLATES":50,"EVOLUTION_LOG_LINES_PER_DAY":1000}
  - schema.js LIMITS（7 个）：{"FAILURE_PATTERNS":100,"SUCCESS_TEMPLATES":50,"EVOLUTION_LOG_LINES_PER_DAY":1000,"CONTRACT_LOCKS":1000,"LEDGER_ENTRIES":2000,"PREDICTION_OUTCOMES":2000,"BENCHMARK_FROZEN_SETS":500}
  - 真实有、场景无：CONTRACT_LOCKS,LEDGER_ENTRIES,PREDICTION_OUTCOMES,BENCHMARK_FROZEN_SETS
  - 场景有、真实无：（无）
  - ⛔ 这一条是「全等比对」的必然后果：以后每加一个上限常量都会红一次。
- **修法**：两种改法：(a) 改场景补齐 key；(b) 把 driver 的 limitsShape 断言从「全等」改成「场景声明的每个 key 都必须一致」（**新增 key 不再 fail**，删 key / 改值仍 fail）。(b) 更好，但改的是判据，要走门禁。

### `policy-decide-clean-results-pending-or-deploy`

- **根因类**：`ASSERT_DRIFT`　**探针**：`policyDecision`
- **域 / 插件**：quality / agint-quality-policy
- **场景文件**：`eval/scenarios/agint-quality-policy-decisions.scenario.json`
- **结论**：按当前权重实算 composite=80 → AUTO_DEPLOY，场景期望 PENDING_REVIEW
- **证据**：
  - 权重（evaluators.js DIMENSION_WEIGHTS）：{"trust":0.2,"reliability":0.2,"effectiveness":0.1,"safety":0.3,"convention":0,"adaptability":0,"integrability":0.2,"promptStatic":0.2}
  - 阈值（decide.js 默认）：autoDeploy=70 pendingReview=60
  - 参与计分：safety=1×0.3 + trust=0.5×0.2 + reliability=0.6×0.2 + integrability=1×0.2
  - 实算：(0.7200 / 0.9000) × 100 = 80
  - 分类：composite ≥ 70 ? AUTO_DEPLOY : ≥ 60 ? PENDING_REVIEW : REJECT ⇒ AUTO_DEPLOY
  - 场景 _note 自带的算式 = 68.9 ⇒ 场景里那句手算注释本身也算错了（分子写成 0.62，实际 0.72）
  - ⛔ 场景期望值不是从权重表推出来的，是手写的 ⇒ 权重一改就漂。
- **修法**：改场景的 decision/scoreAtLeast；⛔ 不要改阈值来迁就场景 —— 阈值是老板 2026-09-17 拍板的。

### `sprint6-cron-job-prompt-static-check-registered`

- **根因类**：`ASSERT_DRIFT`　**探针**：`defaultJobs`
- **域 / 插件**：pipeline / agint-cron
- **场景文件**：`eval/scenarios/agint-sprint6-pipeline.scenario.json`
- **结论**：场景漏列了 14 个新增默认 job（真实集合 ⊇ 场景集合）⇒ 断言比实现旧
- **证据**：
  - 场景 expectedIds（10 个）：baseline-regression-suite,curator-weekly,evolve-review,memory-decay,metrics-collect,night-dream,prompt-static-check,skill-autocreate-aggregate,tool-stats-backfill,wiki-lint
  - jobs.js 真值（24 个）：baseline-regression-suite,curator-weekly,curriculum-weekly,diagnosis-watchdog,evolution-cycle,evolution-reconcile,evolve-review,ledger-anchor,memory-decay,memory-provider-health,metrics-collect,night-dream,oracle-daily,oracle-monthly,oracle-weekly,outcome-measure,prompt-static-check,skill-autocreate-aggregate,skill-autocreate-observe,skill-autocreate-release,skill-graph-weekly,spec-index-refresh,tool-stats-backfill,wiki-lint
  - 真实有、场景无：curriculum-weekly,diagnosis-watchdog,evolution-cycle,evolution-reconcile,ledger-anchor,memory-provider-health,oracle-daily,oracle-monthly,oracle-weekly,outcome-measure,skill-autocreate-observe,skill-autocreate-release,skill-graph-weekly,spec-index-refresh
  - 场景有、真实无：（无）
  - driver 断言方式：JSON.stringify(ids) === JSON.stringify(expectedIds.sort()) ⇒ 严格逐项相等，多一个即 fail
- **修法**：改场景：把 expectedIds 补齐到与 jobs.js 一致。⛔ 不要改 driver 的相等判据 —— 放宽后新增 job 就再也不会被发现。

## 3. 修法优先级（按「改错代价」排）

1. **`REAL_DEFECT`**（本次 0 条）—— 改产品代码，要门禁 + 实测。
2. **`HARNESS_GAP`** —— 改 driver mock。风险：mock 与真实接口越走越远，缺口会扩散。
3. **`ASSERT_DRIFT`** —— 改场景期望。风险最低，但必须逐条人工确认「是代码对、场景旧」，不能批量照抄真值。

> ⛔ **不要为了让 driver 全绿而放宽判据**。6 个 fail 里没有一个是产品缺陷，
>   但放宽判据会让下一次真回归也变成 PASS —— 那才是真正的损失。

---

*只读脚本：不改场景、不改 driver、不改产品代码。第 2 节的「修法」是建议，执行需单独决定。*
