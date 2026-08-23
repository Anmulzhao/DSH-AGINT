# 自进化宪法 · Evolution Framework

> AGINT 系统自身的"宪法"——D-QAF 流水线、HARM 指标、进化记忆层、预算对齐、退化探测等横向机制的统一收口。
>
> **核心原则**：所有改进都必须在现有插件化架构内完成，不引入新的架构层。改进本身也必须遵循「简洁 > 冗余」哲学。
>
> **设计文档**：
> - `DSH-AGINT-D-QAF融合方案.md`（怎么做）
> - `DSH自进化系统评估框架完整汇总.md`（理论框架）
> - `DSH自进化系统整体优化改进方案.md`（结构性诊断与改进方向）
> - `docs/security-boundary.md`（硬约束清单）
> - `docs/evolution-philosophy-checkpoints.md`（哲学锚点工程化）
> - `docs/architecture.md`（运行时衔接）

---

## 第一章 · 哲学锚点 → 工程决策

AGINT 不声称"理解美"，只把"美"操作化为可度量、可执行的工程不变量。五大原则一一对应到工程决策：

| 原则 | 工程不变量 |
|---|---|
| 简洁 > 冗余 | 最小架构优先；新功能必须能在现有插件化架构内完成；复杂插件化回归单插件 |
| 真实 > 讨好 | 评估报告必须展示原始失败数据；HARM 分数不能独立决策 |
| 靠谱 > 聪明 | 语义版本锁定 + 一键回滚；任何变更必须经过 D-QAF 评估 |
| 主动 > 被动 | 退化/停滞自动告警；HARM 增量不足自动切换探索模式 |
| 安全 > 效率 | 沙盒前置 + 静态扫描 + 硬约束清单（`docs/security-boundary.md`） |

> **不可变层**：哲学锚点本身不可被优化修改。所有 Phase 5 的"评估评估者"也必须在哲学锚点之下。

---

## 第二章 · D-QAF 四阶段流水线

### 2.1 流水线总览

```
Phase 1: 静态准入（代码规范、安全扫描、契约校验）
        —— v0.1.1 落地（agint-quality-contract）
    ↓ 通过
Phase 2: 动态沙箱（单元测试、模糊测试、资源监控）
        —— v0.3 落地（agint-quality-sandbox）
    ↓ 通过
Phase 3: 集成演练（冲突检测、全链路追踪）+ HARM 打分 + 预算对齐
        —— v0.2 落地（agint-quality-eval）
    ↓ 通过
Phase 4: 灰度发布（A/B 测试、实时熔断）
        —— v0.4 落地（agint-quality-policy + agint-quality-report）
    ↓ 达标（≤ 3 次/周，超限强制人工审核）
正式部署 / 不达标则回滚
```

### 2.2 阶段责任

| 阶段 | 职责 | 落地插件 | 关键能力 |
|---|---|---|---|
| **Phase 1 静态准入** | 验证代码风格 / 接口签名 / 安全扫描 | `agint-quality-contract` | L0-frozen 字段校验；硬约束清单对齐 |
| **Phase 2 动态沙箱** | 隔离执行 + 资源监控 | `agint-quality-sandbox`（v0.3） | bwrap/Landlock/Seatbelt；超时 30s；内存 512MB |
| **Phase 3 集成演练** | 冲突检测 + HARM + 预算对齐 | `agint-quality-eval` | 7 维评分；HARM 简版；预算对齐（v0.3） |
| **Phase 4 灰度发布** | A/B 测试 + 实时熔断 | `agint-quality-policy`（v0.4） | AUTO_DEPLOY / PENDING_REVIEW / REJECT / ABSTAIN |

### 2.3 决策枚举（FROZEN）

| 值 | 含义 | 触发 |
|---|---|---|
| `AUTO_DEPLOY` | 综合分 ≥ `autoDeploy`（默认 90），安全门通过 | 灰度限速 ≤ 3 次/周 |
| `PENDING_REVIEW` | 综合分 ≥ `pendingReview`（默认 75），待人工 review | 老板看一眼过 / 不通过 |
| `REJECT` | 未达阈值或安全门失败 | 记录原因 + 写入 failure-patterns |
| `ABSTAIN` | 评估不充分，信号不足 | 等待下一轮评估 |

### 2.4 安全红线（永不通过）

- 安全门（Safety < 0.5）→ 一票否决
- L0-frozen 字段被 patch 改 → `L0_FROZEN_VIOLATION` 抛错
- 修改 `agint-security-boundary.yaml` 内容 → 触发人类否决权 + CI 禁改
- 删除历史演化日志 → 触发 `agint-rules` 的 `file-delete-evolution-log` 规则（deny）
- 访问宿主机的 `/root`、`/etc`、SSH 密钥 → 触发 `agint-rules` 硬阻断

完整硬约束清单见 `docs/security-boundary.md`。

---

## 第三章 · HARM 四维和谐度指标

### 3.1 公式

`Harmony = 0.2·H + 0.3·A + 0.3·R + 0.2·M`

### 3.2 维度定义

| 维度 | 含义 | 度量内容 | 数据源 |
|---|---|---|---|
| **H** - Homogeneity | 杂多中的统一 | 跨任务的模式复用率 | `agint.toolStats` 工具调用聚类 |
| **A** - Alignment | 内部和谐 | 策略-执行-结果的逻辑连贯性 | `agint.memory` 历史决策分布 |
| **R** - Reduction | 纯一简约 | 达成目标的最小结构复杂度 | `agint.toolStats` 失败率反推 |
| **M** - Mutability | 优雅适应 | 新经验融入现有结构的摩擦成本 | `agint.dream` 候选-提升数 |

### 3.3 权重动态调节（v0.3 起）

默认权重静态，但允许**运行时根据阶段自适应**：

- **探索期**（近 4 周 HARM 增量 ≥ 2%）：M 权重 ↑ 0.05，R 权重 ↓ 0.05
- **稳定期**（近 4 周 HARM 增量 < 0.5%）：R 权重 ↑ 0.05，M 权重 ↓ 0.05
- **退化期**（基线回归 ≥ 2% 下降）：A 权重 ↑ 0.05，H 权重 ↓ 0.05
- **任何调整记录写入 `agint_evolution` 进化日志**

### 3.4 反和谐检测器（v0.3 起）

定义"伪和谐模式"清单，命中即对 HARM 施加惩罚项或触发人工审查：

| 模式 | 检测信号 | 惩罚 |
|---|---|---|
| 过度压缩 | R 维度分数 > 0.95 且 convention 维度（v0.3）< 0.5 | HARM × 0.9 |
| 可读性丧失 | R 增量 ≥ 0.3 但 trust 维度下降 | HARM × 0.85 |
| 强行合并异构逻辑 | H 维度聚类相似度 > 0.95 且 effectiveness 维度持续下降 | HARM × 0.8 + 人工审查 |

### 3.5 HARM 防欺骗：与 TRACE-P 联合使用

**HARM 不能独立决策**。必须与 TRACE-P 中的 Safety/Reliability 联合使用：

- HARM ≥ 95 但 Reliability < 80% → 不得自动部署
- HARM < 75 但 Safety = 1.0（无可信历史）→ 降级为 PENDING_REVIEW 而非 REJECT
- 这与 `agint-quality-contract` 的 `DecisionKind` 枚举一致

---

## 第四章 · 进化记忆层（v0.3 引入）

> **核心区别**：AGINT 进化记忆 ≠ 任务记忆。
>
> 任务记忆（`agint.memory`）让 Agent "记住用户说过什么"；进化记忆（`agint_evolution`）让系统"记住自己上次进化做了什么、效果如何、哪些坑别再踩"。

### 4.1 服务对象

| 维度 | 任务记忆（`agint.memory`） | 进化记忆（`agint_evolution`） |
|---|---|---|
| 服务对象 | Agent 执行任务时的工作上下文 | DSH 系统自身的进化过程 |
| 内容 | 用户对话、任务状态、检索到的知识 | 进化轨迹、HARM 分数变化、失败模式、成功策略模板 |
| 生命周期 | 会话级/任务级（短期）或知识库级（长期） | 跨进化周期的永久积累 |
| 写入触发 | Agent 在执行任务过程中主动/被动记录 | D-QAF Phase 4 完成后自动写入 |
| 读取场景 | Agent 推理时检索相关上下文 | 下一次进化评估时检索历史经验 |
| 是否可进化 | 记忆机制本身是静态的 | 压缩/抽象/遗忘策略本身也应可进化 |

### 4.2 存储结构

```
$DSH_HOME/storages/agint_evolution.json
├── evolution-log/
│   └── {YYYY-MM-DD}.jsonl   每次 D-QAF Phase 4 完成后追加
├── failure-patterns/
│   └── {hash}.json          周复盘时归纳（最多 100 条，超限走 L1 衰减）
├── success-templates/
│   └── {hash}.json          周复盘时蒸馏（最多 50 条）
└── retrieval-engine/
    └── index.json           关键词倒排索引（按 hamming 距离）
```

### 4.3 三条原则

1. **物理隔离**：进化记忆不与任务记忆共享存储（独立 storage 域 `agint_evolution`）
2. **自动化写入**：脱离 Agent 主动记录，由 D-QAF 流水线自动落点
3. **定向读取**：仅在进化评估阶段被 D-QAF 读取，不参与日常任务推理

### 4.4 写入规则

每次 D-QAF Phase 4 完成后，`agint-quality-policy` 自动写入：

```json
{
  "ts": "2026-08-20T18:30:00Z",
  "target": "agint-dream v0.3.0",
  "decision": "AUTO_DEPLOY",
  "score": {
    "trust": 0.92, "reliability": 0.88, "effectiveness": 0.85,
    "safety": 1.0, "integrability": 0.95
  },
  "harm": { "H": 0.5, "A": 0.92, "R": 0.88, "M": 0.5, "composite": 0.78 },
  "budget": {
    "tokenCost": 12345, "stepCount": 87, "durationMs": 23456,
    "efficiencyDelta": 0.12
  },
  "rollbackHistory": [],
  "tags": ["dream", "v0.3.0", "auto-deploy"]
}
```

### 4.5 读取规则

- **提交新组件前**：`agint-quality-eval` Phase 1 自动检索 `failure-patterns`，命中则提前预警
- **周复盘时**：`agint-evolve` 读 `evolution-log` 做趋势分析 + 归纳 failure-patterns + 蒸馏 success-templates
- **梦境 Deep 阶段**：`agint-dream` 读 `success-templates` 作为评分参考

### 4.6 衰减规则

- 90 天未用 → L2 弱化（标记 `weak: true`）
- 180 天未用 → L3 草稿（仅供 fallback）
- 730 天 + 已 resolved/replaced → L4 归档（仅供历史检索）

---

## 第五章 · 预算对齐（v0.3 引入）

### 5.1 问题

HARM 不绑定计算资源约束。Agent 完全可能通过"增加重试次数""扩大搜索范围""延长超时"来提升 pass@1，而 HARM 无法区分"真变强"和"花更多钱"。这是 2026 年 Harness 进化研究中被反复强调的头号陷阱。

### 5.2 定义

```
有效进化增量 = Δ(任务完成率) / Δ(Token消耗 + 步数 + 时间)
```

### 5.3 落地

- **D-QAF Phase 3 必须检查**：若有效进化增量 ≤ 0，即使 HARM 提升也标记为"无效进化"并拒绝部署
- **D-QAF Phase 4 强制约束**：新旧版本必须在相同 Token 预算、相同最大步数、相同超时阈值下运行对比测试
- **数据采集**：`agint-tool-stats` 新增 `tokenCost` / `stepCount` / `durationMs` 字段（v0.3 引入）

### 5.4 例外

- 关键安全修复：不走预算对齐（安全 > 效率）
- 新能力首批验证：允许在 1.5x 预算内运行（探索成本），但必须在第二次评估前回归到 1.0x

---

## 第六章 · 退化与停滞探测（v0.3 引入）

### 6.1 退化信号

| 探测器 | 触发条件 | 动作 |
|---|---|---|
| 进化停滞 | 连续 K=5 次进化 HARM 增量 < 0.5 | 切换探索模式 / 暂停 |
| 基线回归 | 黄金用例集通过率下降 > 2% | 立即冻结 + 告警 |
| 行为同质化 | 连续 K 次进化产出在行为空间余弦相似度 > 0.95 | 切换 Novelty Search / 暂停 |
| 退化告警 | 近 4 周 HARM 滑动平均 < 上月 95% | 触发 `baseline-regression-suite` 跑分 |

### 6.2 落地

`agint-quality-eval` 自持：

- `baseline-regression-suite/`：黄金用例集（v0.3 选 10 个，每次周日评估后必跑）
- `novelty-tracker/`：监控进化产出的多样性
- `drift-detector/`：检测 HARM 趋势的缓慢下降
- `alert-engine/`：触发冻结/告警/人工介入

### 6.3 退化协议

1. 触发退化告警 → 立即冻结自动部署
2. 写 `agint_evolution`：`tags: ["regression", "freeze"]`
3. 通知老板（不自动执行修复）
4. 修复后必须经过完整 D-QAF 流水线才能恢复

---

## 第七章 · 与 Harness 五方向契合度

| Harness 方向 | AGINT 覆盖 | 评级 | 改进优先级 |
|---|---|---|---|
| 1. Prompt 自进化 | 缺失 | 缺失 | P4（v0.4） |
| 2. 工具链/工作流自进化 | 完整 | 完全覆盖 | 维持 |
| 3. 记忆系统自进化 | 部分 → 完整（v0.3 引入进化记忆层） | 部分 → 完全 | P0 → P3 |
| 4. 控制逻辑自进化 | 部分（有调度，缺元搜索） | 部分覆盖 | P4 |
| 5. 评估与反馈闭环 | 完整且超前 | 完全覆盖 | 补预算对齐（v0.3） |

### 五条黄金准则对照

| 准则 | 现状 | 评级 |
|---|---|---|
| 持久修改才算进化 | 已内化 | 完全覆盖 |
| 可逆性是底线 | 版本锁定 + 一键回滚 | 完全覆盖 |
| 最小架构优先 | 哲学锚点 + 3000 行精神 | 完全覆盖 |
| 进化 ≠ 堆数据 | 缺预算对齐 → v0.3 引入 | 部分 → 完全 |
| 安全约束前置 | 沙盒 + 硬约束清单（v0.2） | 完全覆盖 |

---

## 第八章 · 不变量与红线

### 8.1 永远不变

1. 哲学锚点（L0-frozen）
2. D-QAF 四阶段流水线结构
3. `agint-quality-contract` 的 L0-frozen 字段集合
4. `agint-security-boundary.yaml` 的 `hard_constraints` 部分
5. HARM 公式骨架（仅**权重**可动态调整，**维度定义**不变）

### 8.2 L0 变更路径

任何 L0 字段变更必须满足：

1. 人类多签（至少老板 + 老板指定 1 人）—— 物理隔离，避免单点
2. CI 禁改（CI 任务检测到 L0 字段修改自动失败）
3. 必须发 major 版本，旧版本至少保留 3 个 minor 周期
4. 元评估委员会机制：连续 N 次进化未触发回滚 + 影子模式验证 7 天以上

### 8.3 红色操作清单

以下操作任何人都不能做（包括 Agent）：

- 修改 `agint-security-boundary.yaml` 的 `hard_constraints`
- 删除 `agint_evolution` 下的 evolution-log
- 跳过 D-QAF 流水线直接部署
- 评估 `agint-quality-eval` 自身（递归陷阱）
- 绕过 `agint-rules` 的 deny 规则

完整红色操作清单见 `docs/security-boundary.md`。

---

## 第九章 · 演进时间线

| 版本 | 阶段 | 关键里程碑 |
|---|---|---|
| v0.1.0 | P0 | 9 个插件 + 3 个 preset + 1 个 patch |
| v0.1.1 | P1 | D-QAF 契约层 + frozenness 三层 |
| **v0.2** | **P2** | **D-QAF 评估引擎初版 + 自进化宪法文档** |
| v0.3 | P3 | 沙箱 + 进化记忆层 + 预算对齐 + 退化探测 |
| v0.4 | P4 | 策略引擎 + 灰度发布 + Prompt 进化 + 社区化技术前提 |
| v0.5+ | P5 | 社区化 + 多 Agent 协同 |

---

## 第十章 · 与其他文档的关系

| 读者 | 推荐阅读顺序 |
|---|---|
| **第一次接触 AGINT** | README.md → PHILOSOPHY.md → 路线图 |
| **要写新插件** | `docs/architecture.md` → `docs/plugins/agint-*.md` 对应参考 → `docs/dsh-integration.md` |
| **要调 D-QAF** | 本文档第二章 / 第三章 → `docs/plugins/agint-quality.md` → `plugins/agint-quality/agint-quality-eval/README.md` |
| **要改 L0 字段** | 本文档第八章 + `docs/security-boundary.md` 后再找老板 |
| **要写复盘提案** | 本文档第六章 / `路线图` 节奏章节 → `docs/lessons/` |
| **老板审 ROADMAP** | `路线图` → 本文档第七章契合度表 → `docs/evolution-philosophy-checkpoints.md` |
