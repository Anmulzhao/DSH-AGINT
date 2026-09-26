# Changelog — agint-diagnosis

所有破坏性变更必须记录于此。详见 `docs/plugins/PLUGIN-SPEC.md` 维度 8。

---

## 2026-09-26 — 表满守门全部失效（`.entries().length` 恒为 undefined）

### 缺陷

宿主 `dsh-storage-domain` 的 table API 中，`entries()` 返回的是**迭代器**
（`return [...this.records.entries()][Symbol.iterator]()`），迭代器没有 `.length`。
官方提供的计数入口是 `get size()`。

而本插件三处守门全部写成 `X.entries().length`：

| 位置 | 写法 | 后果 |
|---|---|---|
| `lib/index.js:184` | `t.entries().length >= LIMITS.ANNOTATIONS` | annotations 上限 200 **永不触发** |
| `lib/index.js:288` | `const existingCount = t.entries().length` | clusters 上限 50 **永不触发** |
| `lib/index.js:321` | `tr.entries().length >= LIMITS.REPORTS` | reports 上限 50 **永不触发** |

`undefined >= 50` 恒为 `false`。生产实测：reports 表堆到 **68,789 条**（上限 50），
annotations/clusters 三处守门一次都没拦过。

### 修复

- 三处 `X.entries().length` → `X.size`（`stats()` 里的三处计数同修，此前恒返 `undefined`）
- 新增 `test/cap-enforcement.test.mjs`（7 例）：用**忠实 mock**（迭代器 `entries()` + `size` getter）
  逐条断言三个 cap 会真抛错，并含一条"旧写法在此必然失效"的自证用例
- 同类误用为**全仓系统性**问题（9 插件 38 处），已一并修正；新增静态护栏
  `bin/check-storage-table-api.mjs` 防止回归

### 运维必读

**修复后 `report()` 会在 `reports.size >= 50` 时抛错**——这是设计意图（硬刹车），
但对已被污染的存储意味着**必须先把 reports 清到 50 条以下**，否则 diagnosis 永久不可用。

---

## v0.7.0 — Sprint 12 / A6 — diagnosis.completed 事件化（T1 影子期）

### 新增

- **`diagnosis.completed` 事件**：report() 末尾 publish，单 service 接口 `ctx.get('agint.eventBus.publish')`
  - payload：`{ reportId, targetIds, rootCauseDistribution, clusterCount, evaluatedAt }`
  - envelope：`{ topic: 'diagnosis.completed', version: 1, source: 'agint-diagnosis' }`
  - **软降级**：bus 不可用静默；不阻断 `unpackReport` 返回
  - **不切流量**：report 主路径完整保留（写表 → 写 wiki/memory → publish → return）
- **`schemas/diagnosis-completed.schema.yaml` v1**：payload schema + evolution 路径（v1 不冻结）
- **`manifest.json`**：
  - `version` 0.6.0 → 0.7.0
  - `dependencies` 加 `agint-event-bus >=0.7.0`
  - `optionalInject: ["agint.evolution","agint.eventBus"]`（A3 已含 eventBus，A6 落地 publish）

### 没动（红线）

- 4 个 FROZEN Service 签名（annotate / counterfactual / cluster / report）
- 6 类根因 FROZEN enum + AGENT 数据 schema
- `failure_pattern` 表只读
- `agint-quality-contract` L0-frozen 字段
- report 主决策路径（publish 在 return 之前，副通道）

### 测试

- `test/diagnosis-completed-publish.test.mjs`（新增，T1 影子期断言）
- e2e：新增 `eval/scenarios/agint-event-bus-s12-06-diagnosis.scenario.json` + branch
  - `eventBusDiagnosisCompletedEnvelopes=1`
  - `mutatorObservationRecorded=true`
  - `directReportReturnPathPreserved=true`
  - `publishDoesNotUseUmbrellaKey=true`

---


## v0.6.0 — Sprint 7 骨架初版（2026-08-24）

子任务 #2 交付物：

- **新增**：插件骨架 + Cordis `apply` 入口（`lib/index.js`）
- **新增**：4 个 FROZEN Service 占位 — `agint.diagnosis.annotate` / `counterfactual` / `cluster` / `report`，全部显式抛 `not implemented: … (sub-task #N)`，绝不静默
- **新增**：FROZEN 数据 schema（`lib/schema.js`）— `RootCauseKindSchema` (enum 7 类) + `AnnotationSchema` + `ClusterSchema` + `DiagnosisReportSchema` + `LIMITS` (200/50/50)
- **新增**：独立 storage 域（`agint_diagnosis`，`lib/storage.js`）— 三表 annotations/clusters/reports，含 pack/unpack helper + 超限 warn
- **新增**：5 个 smoke 用例（`test/smoke.mjs`）覆盖 FROZEN enum / schema 校验 / storage spec / 守门 / plugin entry
- **新增**：`manifest.json` (PLUGIN-SPEC 8 维度) + `cordis.patch.yml` loader 模板 + `package.json` 1 份
- **新增**：`docs/plugins/agint-diagnosis.md`（AGINT 仓库内兄弟级文档）

### 没做（按设计稿 §八）

- 6 类根因判定算法（子任务 #3）
- 反事实模拟实现（子任务 #4）
- cluster 实现 + report 写 wiki/memory（子任务 #5）
- eval 场景（子任务 #6）

### 没动（按设计稿 §七）

- `agint-quality-contract` 任何 FROZEN 字段
- `failure_pattern` 表（只读、UNCERTAIN 写 memory）
- 顶层 `profile-patches/web/cordis.patch.yml`（由老板走 safe-update 重启时统一追加）

---

## v0.6.0 — Sprint 7 收口发版（2026-08-24）

子任务 #3 / #4 / #5 / #6 累计交付物（**仅仓库发版，未挂载到顶层 cordis.patch.yml**——老板 2026-08-24 拍「只发 tag + CHANGELOG，不挂载」）：

### 算法本体（4 个 lib）

- **新增** `lib/root-cause-classifier.js`（#3）：6 类根因特征投票算法 + 主入口 `classify(trajectory) → { rootCause, confidence, evidence }`。6 类根因各一个 `_classify*` 内部函数 + `UNCERTAIN` 兜底；并列情形取字典序前 + `evidence.tied` 标注。`scores` 7-key 完整。
- **新增** `lib/counterfactual-simulator.js`（#4 → #5 重写）：3 种 modifiedStrategy（`skip-tool` / `use-prev-prompt` / `reorder-subtasks`）+ 用户 modifiedStrategy 第 4 组 keyword match。`wouldSucceed` 启发式判定 + `successRate = true数/总数` + `divergentSteps = trajectory.length`。从 `agint.evolution.queryTemplates` 拉 success_template 参考源（设计稿 §二.6 偏差 #3 已承认）。
- **新增** `lib/cluster-aggregator.js`（#5）：substring 聚类算法 + 合并去重 + 截断到 `maxClusters=50`。复用 `agint.evolution.queryFailures({query, limit})` substring 检索（设计稿 §二.5 + 偏差 #5）。
- **新增** `lib/report-aggregator.js`（#5）：window-based 聚合 + 7-key rootCauseDistribution + generatedAt ISO。

### Service 接通（`lib/index.js`）

- `agint.diagnosis.annotate`（#3）：cold-start 守门（failure_pattern 样本 <10 抛错）+ 表满守门（annotations ≥200 抛错）+ 写 `agint_diagnosis.annotations` 表 + 返回 FROZEN 业务字段。
- `agint.diagnosis.counterfactual`（#4/#5）：cold-start 守门（success_template <10 抛错）+ **无副作用**（不写任何表）。
- `agint.diagnosis.cluster`（#5）：写 `agint_diagnosis.clusters` 表 + 表满 ≥50 抛错 + 不写 failure_pattern。
- `agint.diagnosis.report`（#5）：写 `agint_diagnosis.reports` 表 + 表满 ≥50 抛错 + **副作用写 wiki + memory**（agint.wiki 容错 + agint.memory 容错，不阻断 report 返回）。

### 测试 / eval

- **新增** `test/root-cause-classifier.test.mjs`（17 用例）+ `test/counterfactual-simulator.test.mjs`（16 用例）+ `test/cluster-aggregator.test.mjs`（13 用例）+ `test/report-aggregator.test.mjs`（12 用例）+ `test/smoke.mjs` 追加至 9 用例。
- **新增** `eval/scenarios/agint-diagnosis.scenario.json`（10 归因场景）+ `eval/scenarios/agint-diagnosis-counterfactual.scenario.json`（10 反事实 fixture）。
- **新增** `eval/run-diagnosis-eval.mjs`（runner，10/10 PASS）+ `eval/run-counterfactual-stress.mjs`（runner，**成功率 70%**，同时过软门槛 50% + 路线图目标 70%）。
- **新增** `wiki/AGINT/sprint-7-哲学对齐检查.md`（§六 5 条 + 收口结论，含实测数字 + 文件路径 + 行号引用）。

### 验收硬门槛对账（设计稿 §三）

| 门槛 | 实测 | 状态 |
|---|---|---|
| 归因覆盖 ≥4 类（实际 6 类） | 6/6 + UNCERTAIN 兜底 | ✅ |
| 反事实成功率（软门槛 50% / 目标 70%） | **70%** | ✅✅ |
| eval ≥10 归因用例 PASS | 10/10 | ✅ |
| `agint_diagnosis.annotations` ≤200 上限 | 守门已实装 + 单测覆盖 | ✅ |
| 种群变体数 = 0（未到 Sprint 9） | 0 | ✅ |
| L0-frozen 检查（不动 quality-contract） | 0 引用 | ✅ |
| 哲学对齐检查章节 | wiki 已落 | ✅ |

### 已知瑕疵（透明记录）

- **#4 子任务净增 329 行超 300 线 29 行**（老板 2026-08-24 拍「接受」）
- **#6 子任务净增 331 行超 300 线 31 行**（理由见 wiki 哲学章节「简洁 > 冗余」段：mock ctx 工厂内联避免拆文件 import 复杂度；建议下次衍生下沉到 `eval/scenarios/mocks/agint-diagnosis-ctx.mjs`）
- **3 条反事实 fixture 跑出 successRate=0**（fix-6/7/8：Sprint 7 现有 3 种 modifiedStrategy 对 KNOWLEDGE_GAP / REASONING_ERROR / ENVIRONMENT_SHIFT 无针对性扰动；属设计稿 §八「不调真 LLM」诚实代价，非 bug）

### Sprint 8 解锁前置（路线图 line 530）

- **归因覆盖率 ≥80%**（覆盖率 = `已标注 / failure_pattern 总数`）—— Sprint 8 启动子任务 #1 必做
- 反事实成功率 ≥70% ✅（已达成）
- L0-frozen 字段不动 ✅（已守住）

### 没动（按设计稿 §七 + AGENTS.md）

- `agint-quality-contract` 任何 FROZEN 字段（0 引用）
- `failure_pattern` 表（counterfactual 是只读 + 启发式）
- 顶层 `profile-patches/web/cordis.patch.yml`（老板 2026-08-24 拍「只发 tag + CHANGELOG，不挂载」）
