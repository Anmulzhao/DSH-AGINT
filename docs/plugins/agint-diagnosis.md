# agint-diagnosis — 归因引擎 plugin

> D-QAF P6 阶段的「看清失败」。把 AGINT 看见的失败归到 6 类根因之一，并提供反事实模拟 / 聚类 / 时间窗报告接口。
>
> **版本**：v0.6.0（Sprint 7 初版，仅骨架 + FROZEN schema）
> **存储域**：`agint_diagnosis`（独立于 `agint` / `agint_evolution` / `agint_rules` / `agint_metrics`）
> **Service 名**：`agint.diagnosis.annotate` / `counterfactual` / `cluster` / `report`

---

## 设计意图

任务记忆（`agint.memory`）记用户与 Agent 的对话；
进化记忆（`agint.evolution`）记 D-QAF 决策本身；
归因记忆（`agint_diagnosis`）记「失败为什么发生」——把抽象的 failure_pattern 落地到具体可复现的特征证据，反过来又喂给 Sprint 8 mutator 决定「该怎么改」。

| 维度 | 任务记忆 | 进化记忆 | 归因记忆 |
|---|---|---|---|
| 服务对象 | Agent 执行任务时的工作上下文 | DSH 系统自身的进化决策 | 系统看见的失败 + 归因证据 |
| 写入触发 | 用户 / Agent 主动 | D-QAF Phase 4 自动 | D-QAF pipeline / 周复盘 / 用户手动标注 |
| 读取触发 | Agent 任务推理时 | 进化评估 / dream deep | mutator（Sprint 8）/ 反事实验证 / 周报 |
| 关键抽象 | 教训 / 决策 / 偏好 / 规律 | evolution-log / failure-pattern / success-template | annotation / cluster / report |
| 上限 | 无硬上限 | failure 100 / template 50 | annotation 200 / cluster 50 / report 50 |

---

## Service 契约（FROZEN，设计稿 §2.1）

```js
agint.diagnosis.annotate({ failureId, trajectory })
  → { failureId, rootCause, confidence, evidence }
// rootCause ∈ FROZEN enum 7 类（PROMPT_DEFICIENCY/TOOL_GAP/KNOWLEDGE_GAP/REASONING_ERROR/PLANNING_FAILURE/ENVIRONMENT_SHIFT/UNCERTAIN）
// confidence ∈ [0,1] 启发式估计（≠ 真实成功率，docs 明示）

agint.diagnosis.counterfactual({ failureId, modifiedStrategy })
  → { successRate, divergentSteps }
// 启发式反事实模拟：3 组（不调该 tool / 用 v(n-1) prompt / 换任务拆分）中 ≥1 组「不会失败」的比例
// 性质：启发式估计 ≠ 真实成功率，docs 明示

agint.diagnosis.cluster({ failureIds })
  → Array<{ pattern, count, sampleFailureIds }>
// 按 failure_pattern.pattern substring 聚类，复用 evolution-memory 已有检索

agint.diagnosis.report({ windowDays })
  → { windowDays, generatedAt, annotationCount, clusterCount, rootCauseDistribution }
// rootCauseDistribution 是 7-key 完整分布（漏 key 即拒）
```

**v0.6.0 当前状态**：4 个 Service 接口已注册，但实现全部抛 `Error('not implemented: … (sub-task #N)')`。子任务 #3-#5 接力时**不改签名**，只填充算法本体。

详细 schema：`plugins/agint-diagnosis/lib/schema.js`。

---

## 存储结构

```
$DSH_HOME/storages/agint_diagnosis.json
├── annotations/    每条归因结果，{id, kind, createdAt, failureId, rootCause, confidence, evidence}
│                   上限 200（超限 warn，不自动 prune）
├── clusters/       聚类结果，{id, kind, createdAt, pattern, count, sampleFailureIds}
│                   上限 50
└── reports/        时间窗报告，{id, kind, windowDays, generatedAt, annotationCount, clusterCount, rootCauseDistribution}
                    上限 50
```

与兄弟插件的差异：

| 维度 | evolution-memory | diagnosis（本插件） |
|---|---|---|
| 域 | `agint_evolution` | `agint_diagnosis`（独立） |
| 表数 | 3 | 3 |
| 表名 | evolution_log / failure_pattern / success_template | annotations / clusters / reports |
| 衰减 | L1-L4 + confidence（纯复制 decay.js） | **本次不引入**（子任务 #6 评估后定） |
| FROZEN enum | 无 | `RootCauseKind` 7 类 |

---

## 与其他 plugin 的关系

| Plugin | 交互 |
|---|---|
| `agint-evolution-memory` | **只读** `failure_pattern` 表，给 annotate / cluster 提供数据（`optionalInject: ['agint.evolution']`，运行时降级处理） |
| `agint-quality-eval` | 评估归因覆盖率（覆盖率红线见路线图 line 530），不写本插件域 |
| `agint-mutator`（Sprint 8） | 读 clusters + annotations 决定 mutation 方向——本 sprint 不实现 |
| `agint-dream` | Deep 阶段可读 reports 作为评分参考（未来 sprint 接入） |
| `agint-wiki` / `agint-memory` | report 写 wiki + memory（子任务 #5 接入） |
| `agint-quality-contract` | **不调用**（设计稿 §七 L0-frozen） |

---

## FROZEN schema 与变更流程

字段名 / 顺序 / enum 取值任一变更：

1. **必须**走人类多签（老板 + 老板指定 1 人）
2. **必须**先经 7 天影子模式验证
3. **必须**发 major 版本
4. **必须**旧版本保留至少 3 个 minor 周期

CI 禁改：检测到 FROZEN 字段修改自动失败。

---

## Sprint 7 范围内（本次子任务 #2 已交付）

- [x] 插件骨架（package.json / manifest.json / lib/{index,schema,storage}.js）
- [x] 4 个 FROZEN Service 接口注册（占位抛 not implemented）
- [x] 物理隔离存储域（3 表 + LIMITS 200/50/50）
- [x] 5 个 smoke 用例全过
- [x] docs/plugins/agint-diagnosis.md

## Sprint 7 后续（子任务 #3-#6）

- [ ] 子任务 #3：6 类根因判定算法（特征投票 + UNCERTAIN 兜底）
- [ ] 子任务 #4：反事实模拟接口（确定性重放，不调真 LLM）
- [ ] 子任务 #5：cluster 聚类 + report 聚合 + 写 wiki/memory 钩子
- [ ] 子任务 #6：eval ≥10 用例 + 反事实成功率压测 + 哲学对齐检查

---

## 设计取舍

### 1. 占位 Service 显式抛 `not implemented: ... (sub-task #N)`（本次拍板）

绝不静默返回空对象——调用方一眼看出是这个 sprint 没实现（不是真的「归因为 UNCERTAIN」）。`UNCERTAIN` 是归因语义、不可与「还没做」混淆。

### 2. storage 域独立 `agint_diagnosis`（与兄弟插件同策略）

物理隔离理由：归因数据规模估算 200/50/50 表项，与 evolution-memory 表有交叉引用但不重叠——分域避免读放大，也避免 L0-frozen 风险传到本插件。

### 3. 4 个 Service 都用 `inject: ['storageDomain']` 一个硬依赖（与兄弟一致）

`agint.evolution` 是 optional（软依赖）；缺它时 annotate 的入参 `failureId` 仍可校验，只是判定算法会因缺种子数据集用空集跑——子任务 #3 加自检覆盖。

### 4. metadata（id / kind / createdAt）只在 storage entry 层有，不污染 FROZEN

Service 出参剥回 FROZEN 业务字段；storage entry 多带 metadata 让 L1-L4 衰减 + dedup 在未来 sprint 接入时不必大改 FROZEN。

---

## 验证

```sh
# 跑 plugin-check（8 维度）
cd /home/anmul/projects/AGINT
./bin/plugin-check.sh plugins/agint-diagnosis

# 跑 smoke（5 个用例）
node plugins/agint-diagnosis/test/smoke.mjs
```

两个都 PASS 才算 Sprint 7 子任务 #2 交付完成。

---

## 相关文档

- 设计稿本体：`wiki/AGINT/sprint-7-设计稿-2026-08.md`（真理之源）
- 路线图：P6 / Sprint 7 归因引擎（line 285-304）
- L0 契约：`docs/evolution-framework.md`
- 兄弟插件：`docs/plugins/agint-evolution-memory.md`
- 插件准入：`docs/plugins/PLUGIN-SPEC.md`
- 哲学检查点：`docs/evolution-philosophy-checkpoints.md`
- 安全边界：`docs/security-boundary.md`
