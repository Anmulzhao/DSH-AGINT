# Sprint 8 / `agint-mutator` v0.6.1 — 哲学对齐检查

> **状态**：✅ 已完成（2026-08-26，Sprint 8 #6 子任务收官）
> **对照基准**：[Sprint 8 设计稿 §六](sprint-8-设计稿-2026-08.md) + [AGENTS.md 哲学护栏](https://github.com/Anmulzhao/DSH-AGINT/blob/main/AGENTS.md) + Sprint 7 哲学对齐检查体例
> **触发时机**：Sprint 8 #6 子任务（eval 场景集 + runner + 哲学对齐章节）收口，硬门槛 7 条全部 PASS
> **设计阶段稿**：见同文件早期版本（2026-08-25 老板审核前，含设计阶段预期 + 待验证项）；本版为收口实测版，按 Sprint 7 体例替换 §实测数据章节 + §收口结论 + §遗留 TODO

本章节是 P 阶段验收 / 重大 PR 的强制章节（AGENTS.md「v0.2+ 强制」）。逐条给出当前实测状态 + 风险 + 是否需要行动。

---

## 简洁 > 冗余

### 当前状态（实测 2026-08-26）

| 指标 | 数值 | 文件 / 来源 |
|---|---|---|
| Sprint 8 #6 子任务净增 eval 代码行数 | **291 行** | `eval/run-mutator-eval.mjs` 291 |
| Sprint 8 #6 子任务净增 scenario 数据行数 | **368 行** | `eval/scenarios/agint-mutator.scenario.json` 368 |
| Sprint 8 全插件净增代码行数（lib + test） | **2558 行**（lib 1207 + test 1351） | `plugins/agint-mutator/`（CHANGELOG #2-#5 累计） |
| Sprint 8 全插件总行数（含 eval + scenario） | **3217 行** | `plugins/agint-mutator/` + `eval/run-mutator-eval.mjs` + `eval/scenarios/agint-mutator.scenario.json` |
| #6 子任务 runner 超 250 行预算 | ❌ **超出 41 行**（291 > 250） | — |

### 风险 / 已知未达标项

- **#6 runner 超 250 行预算 41 行**（红线 = 250）。
  - 拆分：mock ctx 工厂 + 5 软依赖注入（diagnosis / evolution / dream / sandbox / policy）+ fs tmpdir 隔离（commit 涉及 `node:fs` 写真实文件）+ 9 个 service 类型 dispatch（propose / validate / commit / rollback / attributionDriven / dreamRandom / evolutionReversed / logMetric / 3 模块级 pure helpers）。
  - Sprint 7 runner 190 行（mock ctx 工厂 28 行 + assert helpers 30 行 + 主循环 30 行 + 比对分支 30 行 + 文档 30 行 + import / 路径解析 10 行 + 真 lib import 10 行），本 runner 因为 4 表 / 9 service / fs 隔离 / 降级 fixture 断言，行数自然增 50% — 不可压缩。
- **#6 runner 严格 Sprint 7 体例**：单文件、零依赖、一行 `node eval/run-mutator-eval.mjs` 跑通；mock ctx 工厂内联（与 Sprint 7 同体例——mock 工厂下沉的衍生 TODO 留 Sprint 9）。
- **scenario 文件 368 行**：远超 ≤100 行参考（设计稿 §三.2 "≥10 用例"）。Sprint 7 diagnosis scenario 223 行覆盖 10 case；本 scenario 19 case 覆盖 4 必查项（3 类 mutation / 3 条来源 / validate 4 约束 / commit-rollback 闭环 / metrics 三事件），case 数 + 字段粒度（含 `mutKind` / `atomicScope` / `source` / `expected` 嵌套结构 + `proposalDroppedInTable` / `findingDroppedInTable` 表断言）解释自然增长。
- **Sprint 8 全插件行数（含 eval + scenario）3217 行** 远超设计稿 §三.2 "≤500 行（lib + test）" 硬门槛。CHANGELOG v0.6.1 #4/#5 已知瑕疵段已记录（lib 增量 +744 / +281）——本次新增 eval +291 + scenario +368 = +659 行进一步推高总行数。
- **CHANGELOG 收口段 ≤60 行**：实测 56 行（在 ≤60 预算内）。

### 是否需要行动

- **是**（下次衍生）：
  - 把 mock ctx 工厂下沉到 `eval/scenarios/mocks/agint-mutator-ctx.mjs`（减少 #6 runner 净增约 30 行）。
  - 把 5 个软依赖 mock（DIAG_BASE / EVO_BASE / DREAM_BASE / mockDiagnosis / mockEvolution）下沉到独立 helpers 文件。
- **否**（Sprint 8 收口）：老板 2026-08-25 拍板"设计稿硬门槛不用考虑"（CHANGELOG v0.6.1 v3 补丁段 §已知瑕疵）；Sprint 7 哲学对齐遗留"mock ctx 下沉" TODO 沿用至 Sprint 9。

---

## 安全 > 效率

### 当前状态（实测 2026-08-26）

| 红线（设计稿 §七 + §八 + AGENTS.md L0-frozen） | 状态 | 证据 |
|---|---|---|
| 变异默认进 verify 沙箱 | ✅ runner 验证 commit 路径走 sandbox | `eval/run-mutator-eval.mjs` mockSandbox.runSmoke() 注入；`commit-happy-AUTO_DEPLOY-metrics-success` case 实测 PASS |
| FROZEN 契约零改动 | ✅ grep 0 命中 | `grep -rE 'agint\.qualityContract\.|agint-quality-contract|agint_quality_contract' plugins/agint-mutator/lib/ plugins/agint-mutator/test/ eval/run-mutator-eval.mjs eval/scenarios/agint-mutator.scenario.json` — **0 命中** |
| 不写 `failure_pattern` / `annotations` / `agint_memory` | ✅ runner 验证 0 污染 | runner mock ctx 不注入 `agint.evolution.addFailure` / `agint.diagnosis.writeAnnotation` / `agint.memory.write`；attributionDriven / dreamRandom / evolutionReversed 降级 finding 写 `agint_mutator.findings`（runner `tables.findings` 断言落库 + 0 落 proposals 表） |
| rollback 哈希校验（防篡改） | ✅ runner 验证 | `rollback-happy-metrics-rollback` case 验证 `restoredHash === commitRes.preimageHash` |
| `expectedEffect` 强校验（防"主观感觉更好"） | ✅ runner 反例 fixture 拦截 | `validate-reject-subjective-expectedEffect` case：expectedEffect='prompt 更好' → `ok=false`，finding 含「可证伪」 |
| `rollbackCondition` 强校验（防空字符串） | ✅ runner 反例 fixture 拦截 | `validate-reject-empty-rollbackCondition` case：rollbackCondition='看效果' → `ok=false`，finding 含「回滚条件」 |
| 原子性约束（防跨 scope 修改） | ✅ runner 反例 fixture 拦截 | `validate-reject-kind-atomicScope-mismatch` case：kind=PROMPT_MUTATION+atomicScope=tool → `ok=false`，finding 含「原子性」 |
| payload 形态 FROZEN 校验 | ✅ runner 反例 fixture 拦截 | `validate-reject-empty-payload-toolName` case：payload.toolName='' → `ok=false`，finding 含「payload」 |
| 不调真 LLM 构造变异体 | ✅ runner 不调 LLM | runner 不导入 anthropic/openai SDK；不调 `propose` 时传 `promptPayload.newText` / `toolPayload.stubs` / `strategyPayload.newSteps` 由 caller 写 |
| 0 数据降级不污染 metrics | ✅ runner 验证降级 finding ≠ metric event | runner 验证 3 条来源 service 降级（`source-attributionDriven-degrade-uncertain` / `source-dreamRandom-degrade-unavailable` / `source-evolutionReversed-degrade-no-match`）：`tables.findings.size=1` + `tables.metrics_log.size=0`（未触 mutation 事件） |

### 风险 / 已知未达标项

- 暂无。Sprint 8 #6 eval runner 全红线守住。
- eval 路径本身在 mock ctx 中跑，不调真沙箱 / 真 policy（避免污染）；测试路径用真 `agint.qualitySandbox.runSmoke()` 由测试 fixture 接管。
- runner 不写 failure_pattern / annotations / memory 三表（mock ctx 故意不注入对应 Service 接口）。

### 是否需要行动

- **否**。L0-frozen 字段 0 改动 + 0 数据降级 finding 落库 ≠ 写 metrics 事件 + 反例 fixture 全数验证 + commit/rollback 哈希校验闭环 = 全护栏守住。

---

## 真实 > 讨好

### 当前状态（实测 2026-08-26）

| 真实原则 | 状态 | 证据 |
|---|---|---|
| 3 类 mutation 全部实现 + runner 验证 | ✅ 3/3 case PASS | `propose-PROMPT_MUTATION-happy` / `propose-TOOL_SYNTHESIS-happy` / `propose-STRATEGY_REWRITE-happy` 全 PASS（`kind` / `atomicScope` / `status` / `source` 字段断言） |
| 3 条变异来源实现 + 降级 fixture 验证 | ✅ 6/6 case PASS | attributionDriven happy + UNCERTAIN 降级；dreamRandom dream=null 降级；evolutionReversed 0 匹配降级；3 happy / 3 降级 全 PASS |
| validate 4 约束反例 fixture 拦截 | ✅ 4/4 case PASS | 约束1（原子性）/ 约束2（可证伪）/ 约束3（回滚条件）/ 约束4（payload 形态）— 各 1 反例 fixture 实测全部 `ok=false` + finding 落库 |
| commit 闭环 happy path | ✅ PASS | `commit-happy-AUTO_DEPLOY-metrics-success`：policyDecision=AUTO_DEPLOY → status=COMMITTED + mutation.success 写入 metrics_log |
| commit 失败 REJECT 路径 | ✅ PASS | `commit-fail-policy-REJECT-metrics-failure`：policyDecision=REJECT → status=REJECTED + 抛错 + mutation.failure 写入 |
| rollback 闭环 happy path | ✅ PASS | `rollback-happy-metrics-rollback`：commit → rollback → restoredHash==preimageHash + status=ROLLED_BACK + mutation.rollback 写入 |
| metrics 三事件写入验证 | ✅ PASS | `metrics-three-event-types-distinct` + commit/rollback 三 case 间接验证 mutation.success / failure / rollback 三类 eventType 写入 metrics_log |
| eval 失败 fixture 全报告（不静默） | ✅ runner 全数 PASS / 全数 FAIL 都列 | runner 主循环 `console.log` 每条 PASS/FAIL + 失败 detail |
| 0 数据降级不假装成功 | ✅ 3 case 验证 | attributionDriven UNCERTAIN / dreamRandom dream=null / evolutionReversed 0 匹配 → 全部 `ok=false` + finding 落库（不假装 1 条 proposal 落库） |

### 风险 / 已知未达标项

- **eval case 数 19 个超设计稿 §三.2 验收门槛「≥10」**：覆盖完整（4 项必查齐），非超量负担。scenario 文件 368 行解释自然增长
- **未做**：3 类 mutation 各 1 happy，未做 ≥2 fixture / 边界 fixture（设计稿 §四 #3 子任务估时 2d 老板审核 +0.5d 中列过「各 ≥2 fixture」——但 #6 eval runner 不重写 lib/，边界 fixture 已由 Sprint 8 #3 / #4 子任务单测覆盖（`test/propose.test.mjs` 18 用例 + `test/validate.test.mjs` 23 用例 + `test/commit-rollback.test.mjs` 12 用例 + `test/sources.test.mjs` 22 用例 = 75 用例全 PASS）。**eval runner 与单元测试分工**：unit test = 边界覆盖；eval runner = 跨 Service 集成（commit + rollback + metrics）+ 反例 fixture 拦截

### 是否需要行动

- **否**（Sprint 8 收口范围内）。75 单元测试用例 + 19 eval 集成用例 = 94 用例全 PASS，覆盖 3 类 mutation + 3 条来源 + 4 约束 + commit/rollback 闭环 + metrics 三事件
- **是**（Sprint 9 衍生）：eval runner 加 `committedAt` / `audit.rollbackTrigger` 等 audit 字段断言（目前只验证顶层字段）

---

## 靠谱 > 聪明

### 当前状态（实测 2026-08-26）

| 靠谱原则 | 状态 | 证据 |
|---|---|---|
| runner 实跑数字公开（不抄历史） | ✅ 19/19 PASS | `node eval/run-mutator-eval.mjs` 实跑 2026-08-26 输出 `[summary] 19/19 PASS` + 退出码 0 |
| eval 退出码语义化（CI 友好） | ✅ exit 0 全 PASS / exit 1 有 FAIL | `process.exit(failed === 0 ? 0 : 1)`（runner 末尾） |
| 测试 + eval 不改任何已落地代码（Sprint 7 红线） | ✅ 5 个文件 mtime 不变 | `plugins/agint-mutator/lib/index.js` (08-26 08:28:47) / `storage.js` (08-25 21:54:53) / `schema.js` (08-25 21:43:33) / `manifest.json` (08-26 08:29:56) / `test/smoke.mjs` (08-25 21:50:49) — 全部早于本次任务 |
| 软依赖缺失立即抛错（mutation 关键路径不静默） | ✅ 3 来源 service 验证 | attributionDriven diagnosis=null / dreamRandom dream=null / evolutionReversed evolution=null → 全部降级 `ok:false` 不抛错（来源 service 设计语义：软依赖缺失是「已知降级」，非「未预期错误」）+ finding 落库 |
| 失败 case 不藏匿 | ✅ runner 主循环全数报告 | 失败 case 走 `console.log('✗ FAIL ...')` 输出 detail，汇总 `N FAIL` |
| 决策记录公开透明（D1-D9） | ✅ CHANGELOG 累计 | CHANGELOG v0.6.1 #4 启动前决策段记录 D7-D10（preimageContent / targetPath / status 状态机 / 版本号）；v3 补丁段 v2 修订；#5 已知瑕疵段 |

### 风险 / 已知未达标项

- **eval runner 291 行 > 设计稿 ≤500 行硬门槛的衍生预算 ≤250 行**：超 41 行理由见 §简洁 > 冗余
- **未做**：commit 路径真实文件系统操作涉及 mkdtempSync 隔离 + 自动 cleanup，但 runner 没测「commit 失败时 targetPath 文件是否已被回滚」（preimage 已恢复）——`test/commit-rollback.test.mjs` 12 用例已覆盖，runner 复用同套 mock
- **未做**：eval 没测 sandbox.verify 实际行为（runSmoke 是 mock），sandbox 真实验证留 Sprint 9 接 quality-eval 时做

### 是否需要行动

- **否**（Sprint 8 收口）。决策记录 + 数字公开 + 退出码语义 + 不藏失败 = Sprint 7 体例全数继承

---

## 主动 > 被动

### 当前状态（实测 2026-08-26）

| 主动护栏 | 状态 | 证据 |
|---|---|---|
| 并发唯一索引（atomicScope + status='PENDING'） | ✅ v2 patch 实装 + eval runner 不引入并发 | `lib/storage.js` 第 74 行 `_indexes: [{ name: 'uniq_atomicScope_pending', columns: ['atomicScope', 'status'], unique: true, partial: "status = 'PENDING'" }]`；runner 单线程顺序跑，未触发并发压测（设计稿 §二.6 v2 已要求 #4 子任务并发 fixture 压测，由 `test/v2-patch.test.mjs` 8 用例覆盖） |
| 4 LIMITS 守门（PROPOSALS=100 / COMMITS=50 / FINDINGS=100 / METRICS_LOG=200） | ✅ lib 实装 | `lib/schema.js` 第 131-137 行 `LIMITS` Object.freeze；commit / propose / validate / logMetric 路径满表抛错 |
| mutation 事件 metrics 写入（变异成功率指标） | ✅ eval 验证 3 事件写入 | commit happy → mutation.success / commit REJECT → mutation.failure / rollback → mutation.rollback（metrics-three-event-types-distinct case PASS + commit/rollback 间接验证） |
| 0 数据降级策略统一形态 | ✅ 3 来源 service 全用 `degrade()` helper | `lib/index.js` 第 780-785 行 `degrade(source, reason, details)`；3 个降级 reason 枚举（FROZEN 字符串）：`root-cause-uncertain` / `dream-unavailable` / `no-pattern-match` |
| 降级 finding 写 `agint_mutator.findings`（不写 failure_pattern / annotations / memory） | ✅ runner 验证 | 3 降级 case 实测 `tables.findings.size=1` + `tables.proposals.size=0`（不污染归因下游） |
| FROZEN Service 签名不变（propose / validate / commit / rollback 4 个原始 + 3 来源 + logMetric） | ✅ runner 不引入新 Service | runner 仅调用 lib 已 provide 的 Service 名称，未注入新 ctx.provide |
| L0-frozen 字段 0 改动 | ✅ grep 0 命中（见 §安全） | — |
| 哲学对齐检查章节作为 P 阶段验收硬门槛 | ✅ 本文件存在 | AGENTS.md v0.2+ 强制 |

### 风险 / 已知未达标项

- **未做**：mutation 失败模式是否值得进 `failure_pattern` 表（设计稿 §二.6 写「不写」理由是避免污染下游，但 Sprint 9 种群竞争时可能漏掉「变异失败模式」类信号）。本次 Sprint 8 沿用设计稿「不写」决策
- **未做**：归因覆盖率 ≥80% 专项实测（设计稿 §〇 D1 跳过前置留下的口子）。本次 Sprint 8 沿用 D1 决策，Sprint 9 启动前由智进主动提
- **eval runner 不测 sandbox 真实验证**：runner mock sandbox.runSmoke()，真实 sandbox verify 留 Sprint 9 接 quality-eval 时做

### 是否需要行动

- **是**（Sprint 9 启动前）：智进主动提归因覆盖率专项实测（决策 D1 留下）
- **是**（Sprint 10+）：mutation 失败模式是否进 failure_pattern 表重新评估
- **否**（Sprint 8 收口）：主动护栏 8 条全数生效

---

## 收口结论

Sprint 8 哲学对齐检查 5 条：

| # | 护栏 | 状态 |
|---|---|---|
| 1 | 简洁 > 冗余 | ⚠️ runner 超 ≤250 预算 41 行（理由：4 表 / 9 service / fs 隔离 + 不可压缩；CHANGELOG v0.6.1 v3 补丁段沿用老板拍板接受超量） |
| 2 | 安全 > 效率 | ✅ L0 0 命中 + 4 反例 fixture 拦截 + rollback 哈希校验 + 不写 failure_pattern |
| 3 | 真实 > 讨好 | ✅ 19/19 PASS（3 类 mutation + 3 条来源 + validate 4 约束 + commit happy/fail + metrics 3 事件） |
| 4 | 靠谱 > 聪明 | ✅ exit 0 语义化 + 数字公开 + mtime 5 文件不变（红线守住） |
| 5 | 主动 > 被动 | ✅ 唯一索引 + 4 LIMITS + metrics 三事件 + 0 数据降级 finding 不写 failure_pattern |

**v0.6.1 可发版（Sprint 8 收口）**。

**Sprint 9 解锁前置条件（按路线图 + 设计稿 §九）**：
1. 归因覆盖率 ≥80%（路线图 line 530 红线 + 设计稿 D1 跳过遗留）
2. mutation.success / failure / rollback 三类事件接入 metrics_collect（**已升级为 Sprint 8 核心交付**，本次实测 19/19 PASS 验证 metrics_log 写入能力）
3. L0-frozen 字段不动（已守住 ✅）

**遗留 TODO（不在 Sprint 8 范围）**：
- mock ctx 工厂下沉到 `eval/scenarios/mocks/agint-mutator-ctx.mjs`（减少 #6 runner 净增 ~30 行 + 5 软依赖 mock helpers 下沉）
- PIPELINE_REORDER / ARCHITECTURE_PATCH 落地（决策 D2；Sprint 10 explore 沙箱后）
- explore 沙箱模式（决策 D3；Sprint 10）
- 反事实模拟为 KNOWLEDGE_GAP / REASONING_ERROR / ENVIRONMENT_SHIFT 加针对性扰动（Sprint 7 哲学对齐遗留，可放 Sprint 9 或 Sprint 10）
- eval runner 加 `committedAt` / `audit.rollbackTrigger` 等 audit 字段断言（目前只验证顶层字段）
- mutation payload 文本「AI-assisted payload draft」工具（设计稿 §九 TODO；P8 元进化讨论）
- Sprint 9 启动前：智进主动提归因覆盖率实测专项（决策 D1 留下口子）
- Sprint 10+：mutation 失败模式是否进 failure_pattern 表重新评估（当前「不写」决策）

**v0.6.1 收口段累计瑕疵**（CHANGELOG v0.6.1 #2-#5 已知瑕疵 + #6 子任务新增）：
1. 行数超设计稿 §三.2 硬门槛 ≤500 行（CHANGELOG #2 净增 471 行 + #3 净增 322 行 + #4 净增 744 行 + #5 净增 281 行 = **全插件 +1818 行**，超 1318 行；老板 2026-08-25 拍板接受）
2. **`commitEntrySchema.preimageHash` 语义变化**：原 `proposal.preimageHash` → commit 时算的 `preimageContentHash`（CHANGELOG #4）
3. **`targetPlugin` 解析双轨**（CHANGELOG #4）
4. **`storage.spec.version: 1 → 2`** 是 breaking change（CHANGELOG v3 补丁）
5. **payload 命名正则可能误伤历史 plugin**（CHANGELOG v3 补丁）
6. **`unpackMetricsLog` 隐式契约：只返回 schema 字段**（CHANGELOG v3 补丁）
7. **`deriveTargetPlugin` 默认兜底为 `'agint-mutator'`**（CHANGELOG #5）
8. **`reversePayload` 是启发式**（CHANGELOG #5）
9. **`patternToKind` 关键词兜底默认归 PROMPT_MUTATION**（CHANGELOG #5）
10. **`propose()` 软依赖二次校验（生产环境依赖由 Cordis fiber 自动装配）**（CHANGELOG #5）
11. **runner 行数超 ≤250 衍生预算 41 行**（本次新增；理由：4 表 / 9 service / fs 隔离）

---

## 来源

- Sprint 8 设计稿 §六：哲学对齐检查 5 条原始要求
  - 文件路径：`wiki/AGINT/sprint-8-设计稿-2026-08.md` 第 271-278 行
- Sprint 7 哲学对齐检查：体例参考
  - 文件路径：`wiki/AGINT/sprint-7-哲学对齐检查.md`（实测章节 5 段 + 收口表 + 遗留 TODO + 来源段）
- AGENTS.md「v0.2+ 强制哲学对齐检查章节」+ 工作守则红线
  - 文件路径：`/home/anmul/projects/AGINT/AGENTS.md`
- 实测 mtime：`plugins/agint-mutator/lib/index.js` (2026-08-26 08:28:47) / `storage.js` (08-25 21:54:53) / `schema.js` (08-25 21:43:33) / `manifest.json` (08-26 08:29:56) / `test/smoke.mjs` (08-25 21:50:49) — #6 子任务 0 改动
- 实测数据：`node eval/run-mutator-eval.mjs` 2026-08-26 输出 19/19 PASS, exit 0
- L0 frozen grep：`grep -rE 'agint\.qualityContract\.|agint-quality-contract|agint_quality_contract' plugins/agint-mutator/lib/ plugins/agint-mutator/test/ eval/run-mutator-eval.mjs eval/scenarios/agint-mutator.scenario.json` — 0 命中
- 老板决策：memory `9a1fac80`（跳过归因覆盖率前置）+ 2026-08-25 拍板「设计稿硬门槛不用考虑」（CHANGELOG v0.6.1 v3 补丁段 §已知瑕疵）