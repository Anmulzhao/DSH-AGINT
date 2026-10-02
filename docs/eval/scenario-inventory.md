# 场景 Inventory 说明（Scenario Inventory）

> **交付物**：Phase 0 交付物 0（地基）| **版本**：v1.0 | **日期**：2026-10-02
> **产出物**：`eval/scenarios/inventory.json`（进仓库，是代码资产）
> **生成脚本**：`bin/build-scenario-inventory.mjs`（零第三方依赖）
> **上游设计**：[Phase-0 设计方案 §2](../DSH-AGINT.wiki/Phase-0%20验证体系形式化与补强%20设计方案.md)

---

## 1. 为什么先做这个

设计 v1.0 直接写「从 104 个场景中分配 60/32/12」，但**从未定义"一个场景"是什么**。
核对仓库后发现三种可能的计量单位，数值差异巨大：

| 候选单位 | 数量 | 问题 |
|---|---|---|
| `.scenario.json` 文件数 | 37 | 一个文件可含多个单元 |
| `driver.js` 全量回归的单元数 | **123** | ← 本文档采用的口径 |
| 单测断言数 | 216+ | 那是插件自身单测，不是评估场景 |

三者不是一回事。**在单位未定义前，任何"覆盖率 ≥80%"的说法都算不出分母。**

⇒ 本 Inventory 是交付物 1（三层隔离）分配的前提。没有它，配额和覆盖率都是无对象的数字。

---

## 2. 计量单位定义

```
场景单位（Scenario Unit）= driver.js 全量回归中可独立判定 PASS/FAIL 的最小执行单元

判定标准（三条同时满足）：
  1. 有唯一稳定 ID（跨次运行不变）        → 即 unit 的 `scenario` 字段
  2. 可独立执行且独立判定结果
     （不依赖其他单元的中间状态）
  3. 是 92/104 计数中的 1 个

排除：
  - 单测断言（插件自身的 unit test，不是评估场景）
  - e2e 脚本（eval/e2e/*.js，集成测试，单独归类）
```

### 2.1 一个文件 ≠ 一个单元（关键）

`driver.js` 的 `loadScenarios` 实测：

```javascript
const items = Array.isArray(parsed) ? parsed : [parsed];
for (const item of items) out.push({ file: f, scenario: substituteRoot(item) });
```

**一个 `.scenario.json` 可以是数组**，数组里每个元素是一个独立单元。
这是「37 个文件」与「123 个单元」差异的来源。

实测每文件单元数（>1 的文件）：

| 文件 | 单元数 |
|---|---|
| `agint-diagnosis.scenario.json` | 10 |
| `agint-quality-policy-decisions.scenario.json` | 10 |
| `agint-self-model.scenario.json` | 10 |
| `agint-sprint6-pipeline.scenario.json` | 8 |
| `agint-evolution-memory.scenario.json` | 7 |
| `agint-quality-policy-false-harmony.scenario.json` | 7 |
| `agint-quality-sdk.scenario.json` | 7 |
| `agint-quality-eval-regression.scenario.json` | 6 |
| `agint-quality-policy-committee.scenario.json` | 6 |
| `install-security.scenario.json` | 6 |
| `agint-quality-eval-deploy-budget.scenario.json` | 5 |
| `agint-quality-sandbox.scenario.json` | 5 |
| `agint-quality-eval-sandbox-gate.scenario.json` | 4 |
| `agint-quality-eval-weekly-hook.scenario.json` | 4 |
| `agint-rules-policy-deny.scenario.json` | 4 |
| `agint-quality-report.scenario.json` | 3 |
| `agint-cron.scenario.json` | 2 |
| `agint-metrics.scenario.json` | 2 |

（其余 17 个文件各 1 个单元）

---

## 3. 计量范围与 dedicated 边界

### 3.1 driver.js 只扫自身目录，不递归

```javascript
// eval/scenarios/driver.js（实测）
const dir = join(__dirname);
const files = (await readdir(dir)).filter((f) => f.endsWith('.scenario.json'));
```

⇒ `eval/scenarios/dedicated/` 下的 2 个场景**不被 driver 扫到**，
它们由独立 runner 执行（`eval/run-diagnosis-eval.mjs` / `eval/run-mutator-eval.mjs`）。

### 3.2 本 Inventory 的处理

按 §2 单位定义的字面含义（"driver.js 全量回归中…"），dedicated **不属于计量范围**，
因此不计入 `summary.totalUnits`。

但**不静默丢弃**：它们完整记录在 `dedicatedUnits` 段（含 contentHash / domain / kind），
`scope` 段显式声明这是待拍板事项。

> ✅ **已拍板（设计附录 C.2 第 9 项，Sprint 18）：维持独立 runner，不并入 driver。**
>
> 决定性理由不是成本，而是**口径纯净度**：dedicated 的 29 个单元在 driver 口径内的
> `lastKnownStatus` 是 `UNKNOWN`（inventory.json 实测）。把状态未知的单元混进权威分母，
> 通过率就成了不可计算的量 —— **118/123 是有效指标，118/152 不是**。
>
> 附带理由：两个 runner 的执行模型与 driver 不同（`run-mutator-eval.mjs` 自述
> 「单文件、零依赖、一行 node 跑；不修改 lib/，仅读 + 调用真 Service」），
> 而 driver 走场景 JSON dispatch。合并意味着改 driver 的执行模型，
> 风险落在当前唯一能跑通的全量门禁上。
>
> 口径写法（**唯一权威表述，所有文档统一照此写**）：
> - **driver 口径（采用）：123** —— 本清单 `summary.totalUnits`，一切分层/配额/通过率的分母
> - dedicated（**不在任何分母内**）：2 个文件 / **29 个可执行单元**
>   （mutator 19 个场景 + counterfactual 10 条 fixture；粒度取自各 runner 自己的取数）
>
> ⚠️ 关于历史数字 125：`docs/operations/eval-fail-attribution-20260909.md` 记
> 「主 driver（125 场景）… 2 SKIP」，那是这两个文件还在根目录时 **driver 把它们各计 1 个单元**
> 的口径。并入后按 runner 粒度应为 152、按该历史口径才是 125 —— **两者不可混用**。
>
> 反转条件：若两个专属 runner 被退役、这些场景改由 driver dispatch，则并入并**重跑全部配额计算**。
>
> 附注（消除歧义）：提交 `be115d1` 的信息写「主 driver 成为唯一门禁」，该表述针对的是
> diagnosis / self-model / deploy-budget 三个 dispatcher 的收口，**不等于要求 dedicated 并入**。
> 此处按实测维持独立 runner —— 写清是为了避免后人当成未完成事项反复提起。

---

## 4. 92/104 对账（reconciliation）

### 4.1 结论先行

| 项 | 文档声称 | 实测（2026-10-02） | delta |
|---|---|---|---|
| 单元总数 | 104 | **123** | **+19** |
| PASS | 92 | **118** | +26 |
| FAIL | 12 | **5** | −7 |

### 4.2 差异原因（git 历史实测，非推算）

「92/104」出自 **v0.6.5 / Sprint 11 时点（2026-08-28）**，记载于
`Sprint12-设计稿 .md:159`、`AGINT‐智进.md:9`、`路线图.md:188`。

| 时点 | 单元数 | 变化 | 证据 |
|---|---|---|---|
| 2026-08-28（声称时点） | **104** | — | 该时点实测确为 104 ⇒ **声称当时是准确的** |
| 2026-08-29 | 110 | +6 | Sprint 12 新增 `agint-event-bus-s12-02..06` + `s12-05-policy` 共 6 文件 |
| 2026-09-03 | 125 | +15 | 新增 `agint-self-model`（10）+ `agint-quality-eval-deploy-budget`（5） |
| 2026-09-09 | 125 | ±0 | 2 个文件从根目录移入 `dedicated/`（单元数不变，只是换目录） |
| **当前（driver 口径）** | **123** | −2 | 移入 `dedicated/` 的 2 个自此不在 driver 扫描范围 |

**⇒ 结论：104 是历史快照，不是错误。当前 driver 口径下的权威值是 123。**

### 4.3 为什么 FAIL 从 12 降到 5（差集对账，逐项溯源）

旧写法「部分 fail 已被修复；另有一部分口径变化来自单元总数增长」**不够**，因为
12 → 5 直接决定 Phase 1 交付物 4（H1 配额）的对象。以下为实测结论。

**方法**：git worktree 检出 `b6a14f7`（92/104 声称时点）→ 静态提取 104 个单元名
（102 具名 + 2 个当时还在根目录的 dedicated 文件，正对应历史记载的「125 场景 / 2 SKIP」）
→ 与当前 123 做差集 → 逐个比对单元内容。

> ⚠️ **方法论警示**：拿旧 commit **重跑** driver 无法复原历史 fail 名单 ——
> 实测在 `b6a14f7` 跑出 **13 passed / 91 failed (of 104)**，那是旧 plugin 代码配当前
> dsh 运行时的**环境污染值**，不是历史真值。别拿它当证据。

**能确定的部分**：

| 结论 | 值 | 意义 |
|---|---|---|
| 改名 / 删除的旧单元 | **0** | ✅ 排除「因重构/改名而消失 ⇒ 静默失忆」这一分支 |
| 新增具名单元 | 21 | 123 − 102（总数差 +19 = 21 新增 − 2 个 dedicated 移出扫描范围） |
| 当前 FAIL 中旧时点就存在的 | 4 | cron-default-jobs-registered / service-annotations-table-full-throws / policy-decide-clean-results-pending-or-deploy / sprint6-cron-job-prompt-static-check-registered |
| 当前 FAIL 中新增的 | 1 | `s12-05-policy-policy-deployed-rolledback-shadow`（08-29 随 Sprint 12 新增，不可能是旧 12 之一） |

**算术分解**：设 F = 旧 12 个 fail 中现已转 PASS 的数量，R = 旧时点 PASS 但如今回归的数量。
`4 = (12 − F) + R` ⇒ `F = 8 + R` ⇒ **至少 8 个旧 fail 已被修复**，另有 R ∈ [0,4] 个回归。
净变化 **−7 = −8（修复）+ 1（新增 s12-05）**，与 12 → 5 自洽。

**候选集**（旧时点即存在、且内容此后被改过的只有 5 个）：

- 改过且现已 PASS（3 个，`sandbox-*` 三兄弟）—— 最可能是「由 FAIL 转 PASS」的对象
- 改过且仍 FAIL（2 个，两个 cron 预期列表）—— 预期被更新过但仍落后实况，**不是改测试改绿**
- 从未改动却 PASS 的旧单元：95 个 ⇒ 若旧 fail 在其中，是被**plugin 代码**修复（真修复）

**不能确定的边界**：那 12 个 unitId **无法逐项复原** —— wiki 只有数字 12，仓库无存档的
driver 输出，旧 commit 重跑会被运行时污染。这不是本次对账的疏漏，而是**此前从未持久化
fail 名单**造成的既成事实。

**补救**：本 `inventory.json` 入仓后即成为首个持久化的 fail 名单
（`units[].lastKnownStatus = FAIL` 即完整列表，`attribution.pendingUnits` 单独列出），
此后每次生成都留痕，同类失忆不会再发生。

⚠️ **本 Inventory 只负责报数与留证，不做 fail 归因** —— 归因属 Sprint 17
（"12 存量 eval fail 归因 ≥80%"），见设计 §6.3 的协同约定。
因此 `failCategory` 恒为 `null`，**不用占位值冒充已归因**。

当前 5 个 fail 单元（供 Sprint 17 归因使用）：

| unitId | domain |
|---|---|
| `cron-default-jobs-registered` | cron |
| `service-annotations-table-full-throws` | diagnosis |
| `s12-05-policy-policy-deployed-rolledback-shadow` | event-bus |
| `policy-decide-clean-results-pending-or-deploy` | quality |
| `sprint6-cron-job-prompt-static-check-registered` | pipeline |

---

## 5. 领域（domain）分布（实测）

`domain` 按**文件前缀**归类（规则见脚本 `DOMAIN_RULES`），与单元自带的
`plugin` 字段分列记录，便于核对两者是否一致。

| domain | 单元数 | 备注 |
|---|---:|---|
| `quality` | 57 | 绝对主导 |
| `diagnosis` | 10 | |
| `self-model` | 10 | |
| `mount` | 8 | 全部为 e2e |
| `pipeline` | 8 | |
| `evolution-memory` | 7 | |
| `event-bus` | 6 | |
| `install-security` | 6 | |
| `rules` | 5 | |
| `cron` | 2 | |
| `metrics` | 2 | |
| `dream` | 1 | |
| `memory` | 1 | |

### 5.1 对交付物 1 的直接影响

分布**高度不均衡**：`quality` 占 57/123（46%），而 `memory`/`dream` 各仅 1 个单元。

⇒ 设计 §3.2.2 的 H4（单元数 < 3 的 domain 全部留在 Evolution Set）**会命中
memory / dream / cron / metrics** 四个 domain。
"每个 domain 在三层中都有代表"在数学上不可能满足 —— v2.0 已据此放弃该约束。

### 5.2 两处 file-prefix 与 plugin 字段不一致（如实记录）

| 文件 | 归类 domain | 单元自带 plugin |
|---|---|---|
| `install-security.scenario.json` | `install-security` | `agint-install` |
| `agint-sprint6-pipeline.scenario.json` | `pipeline` | `agint-sprint6-prompt-eval` |

归类沿用设计 §2.2.3 表的**文件前缀**口径。若 Sprint 19 决定改用 plugin 口径，
需同步更新脚本的 `DOMAIN_RULES` 并重新生成 Inventory。

---

## 6. kind 归类（及其局限）

设计 §2.2.2 允许 `smoke | integration | e2e | dedicated` 四值，但**未给出逐单元判定规则**。
本 Inventory 按可核查的既有记载做保守归类：

| kind | 判定 | 单元数 |
|---|---|---:|
| `dedicated` | 位于 `dedicated/`（不被 driver 扫到，独立 runner 执行） | 2 |
| `e2e` | `agint-mount-s11-*`（Sprint11 记载"8 e2e 全 PASS"） | 8 |
| `integration` | 其余（走 driver 的 mock ctx 调真实 plugin 方法） | 115 |

> ⚠️ **`kind` 归类当前是启发式的**（仅 `dedicated` 与 `e2e` 有外部证据支撑），
> `smoke` 一值当前无任何单元命中。这是已知局限，不是实测结论。
> Sprint 19 分层后如需按 kind 约束配额，须先补上判定规则。

---

## 7. contentHash 与防篡改

```javascript
contentHash = sha256( canonicalStringify( 单元原始定义 ) )
```

- 基于**文件中原始存储的 JSON**（不含 `$AGINT_ROOT` 替换结果）⇒ 换台机器算出来一样
- 序列化规则见 `bin/lib/canonical-json.mjs`：
  key 按 Unicode **码点**字典序递归排序、无缩进空格、UTF-8 无 BOM、数字不格式化
- 默认**不排除任何字段**（防篡改场景静默丢字段 = 开后门）

跨环境基线（golden 向量）由 `bin/lib/canonical-json.test.mjs` 钉死：
固定输入必须产出 `495eedb6...555af3e`。ubuntu 上跑出别的值 = 序列化规则变了。

---

## 8. 使用

```bash
# 完整模式（跑 driver.js 全量回归，需 dsh 运行时 ⇒ Tier B）
node bin/build-scenario-inventory.mjs

# 降级模式（不跑 driver，只做文件扫描 + hash + 归类 ⇒ Tier A）
node bin/build-scenario-inventory.mjs --static-only

# 指定输出（测试用）
node bin/build-scenario-inventory.mjs --out=/tmp/inv.json
```

### 退出码

| 码 | 含义 |
|---|---|
| 0 | 生成成功且对账一致（或降级模式显式声明未完成对账） |
| **2** | 生成成功但对账不一致（delta ≠ 0）⇒ 打印差异，**需人工确认后才可继续** |
| 1 | 生成失败 |

> 当前仓库状态下运行完整模式会返回 **2**（delta = +19）。这是**预期行为**，
> 不是故障：设计 §2.2.2 要求实测与声称不符时不得静默采用实测值。
> 人工确认后，本节 §4 的对账结论即作为 `deltaExplanation` 归档。

---

## 9. 与 Sprint 17 的协同

Sprint 17 有一项「12 存量 eval fail 归因 ≥80%」，与本交付物高度相关：

- **Sprint 17 需要**：知道"fail 到底是哪几个单元" ⇒ 本 Inventory 的
  `attribution.pendingUnits` 正好产出这个清单
- **反向回填**：Sprint 17 的归因结果应回填到 Inventory 的 `failCategory` 字段
- **边界**：Phase 0 只提供清单基础设施，**不做归因**（设计 §6.3）
