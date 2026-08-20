# agint-evolution-memory — 进化记忆层 plugin

> D-QAF Phase 4 的"自我记忆"。物理隔离的 `agint_evolution` 存储域，记录 evolution-log / failure-patterns / success-templates。
>
> **版本**：v0.3.0（Sprint 2.B 初版）
> **存储域**：`agint_evolution`（独立于任务记忆 `agint`）
> **Service 名**：`agint.evolution`

---

## 设计意图

任务记忆（`agint.memory`）让 Agent "记住用户说过什么"；
进化记忆（`agint_evolution`）让系统"记住自己上次进化做了什么、效果如何、哪些坑别再踩"。

| 维度 | 任务记忆 | 进化记忆 |
|---|---|---|
| 服务对象 | Agent 执行任务时的工作上下文 | DSH 系统自身的进化过程 |
| 内容 | 用户对话、任务状态、检索到的知识 | 进化轨迹、HARM 分数变化、失败模式、成功策略模板 |
| 写入触发 | 用户 / Agent 主动 | D-QAF 流水线自动 |
| 读取触发 | Agent 任务推理时 | 进化评估 / 梦境 deep 阶段 |
| 衰减 | L1→L2→L3→L4 + confidence | 同（纯复制 `agint-memory/lib/decay.js`） |
| 上限 | 无硬上限 | failure 100 / template 50（warn，不自动 prune） |

---

## Service 契约

```js
agint.evolution = {
  // 写入
  logPhase4({ targetId, targetKind, decision, scores, findings, tags }),
  addFailure({ pattern, category, severity, evidence }),
  addSuccess({ template, sampleSize, appliesTo, evidence }),

  // 读取
  queryFailures({ query?, category?, severity?, limit? }),
  queryTemplates({ query?, appliesTo?, limit? }),
  getLogRange({ fromDate?, toDate?, limit? }),

  // 维护
  decayScanRun({ apply? }),   // L1-L4 + confidence 衰减扫描
  stats(),                   // 三表计数 + LIMITS

  limits: { FAILURE_PATTERNS: 100, SUCCESS_TEMPLATES: 50, EVOLUTION_LOG_LINES_PER_DAY: 1000 },
};
```

详细 schema 见 `plugins/agint-evolution-memory/lib/schema.js`。

---

## 存储结构

```
$DSH_HOME/storages/agint_evolution.json
├── evolution_log/      每次 D-QAF Phase 4 完成追加一行
├── failure_pattern/    REJECT 决策自动写入 + 周复盘归纳
└── success_template/   周复盘蒸馏
```

每个 entry 共享三个字段（让 decay.js 能统一处理）：
- `id`（hex hash / UUID）
- `level`（L1/L2/L3/L4）
- `confidence`（0..1）

加上各自专属字段（详见 schema.js）。

---

## 与其他 plugin 的关系

| Plugin | 交互 |
|---|---|
| `agint-quality-eval` | Phase 4 完成后调 `evo.logPhase4()` 写入 evolution-log（Sprint 3 接入） |
| `agint-quality-policy` | REJECT 决策触发 `evo.addFailure()`（Sprint 3 接入） |
| `agint-evolve` | 周复盘读 evolution-log 做趋势分析；归纳 failure-patterns / 蒸馏 success-templates |
| `agint-dream` | Deep 阶段读 success-templates 作为评分参考 |
| `agint-quality-sandbox` | Phase 2 sandbox 跑挂时由 policy 触发 addFailure（Sprint 3） |
| `agint-rules` | 拒绝删除 `agint_evolution/evolution_log/` 任何文件（`delete-evolution-log` 规则，Sprint 3 加） |

---

## Sprint 2.B 范围内（已完成）

- [x] Plugin 骨架（package.json / lib/{index,schema,decay}.js）
- [x] Service 契约完整（8 个方法）
- [x] 物理隔离（独立 storage domain）
- [x] 7 个 eval 场景全过（log/dedupe/search/template/decay/isolation/stats）

## Sprint 3 接入（D-QAF 端到端时一起做）

- [ ] 接 `agint-quality-eval` Phase 4 完成钩子
- [ ] 接 `agint-quality-policy` REJECT 决策
- [ ] 接 `agint-rules` 的 `delete-evolution-log` deny 规则
- [ ] 接 `agint-evolve` 周复盘的归纳 + 蒸馏自动化
- [ ] 接 `agint-dream` Deep 阶段读 success-templates
- [ ] `agint-quality-sandbox` 沙箱跑挂自动 addFailure

## Sprint 1.4 之前（评估引擎初版验证）

- [ ] `agint-quality-eval` Phase 4 评估时读 success-templates 作为加分项
- [ ] `agint-quality-eval` Phase 1 提交前读 failure-patterns 作为预警

---

## 设计取舍

### 1. 纯复制 `decay.js`（老板 2026-08-20 拍板）

跨 storage domain 不能直接复用 `agint-memory/lib/decay.js`（schema 不一样）。把 decay.js 复制到本 plugin，加 schema adapter。后续若 schema 稳定可抽公共包，但 Sprint 2.B 不动。

### 2. 检索：线性扫 + lowercase substring（老板拍板）

老板拍板"线性扫 + 子串匹配"（简单）。100 条以内 < 1ms。> 500 条再考虑倒排索引（evolution-framework §4.4 原设计）。

### 3. 上限保护：超限 warn 而非自动 prune（老板拍板）

failure 100 / template 50，超限 addFailure 返回 `{ ...entry, _warn: ... }` 不抛错。**老板手动决定何时 prune**。全自动 prune 会跟周复盘蒸馏流程冲突（蒸馏时 template 临时超过 50 是正常）。

### 4. 物理隔离：独立 storage domain（evolution-framework §4.2 要求）

物理隔离理由：任务记忆可能因为用户对话被频繁读写；进化记忆只在 D-QAF 流程里被读写，混在一起会让 eval 评估查询混入噪声。

---

## 验证

```sh
# 跑全部 7 个 evolution-memory 场景
node eval/scenarios/driver.js --file=agint-evolution-memory

# 跑全 20 个场景
node eval/scenarios/driver.js
# 当前结果：20/20 PASS
```

---

## 相关文档

- `docs/evolution-framework.md` 第四章（进化记忆层定义来源）
- `docs/security-boundary.md` 第 56 行（禁止删除 evolution-log 的硬约束）
- `docs/plugins/agint-memory.md`（task memory 参考）
- `ROADMAP.md` P3 §进化记忆层（路线图原文）
- `CHANGELOG.md#v0.3.0`（待发版）

## 相关 commit

- Sprint 2.B 一次性 commit：`feat(evolution-memory): Sprint 2.B 进化记忆层 plugin + 7 场景全跑通`
