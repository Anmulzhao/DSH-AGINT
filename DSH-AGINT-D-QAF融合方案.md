# DSH-AGINT × D-QAF 融合方案

---

## 一、融合总览

### 1.1 核心理念对齐

| D-QAF 评估框架 | AGINT 项目 | 融合点 |
| :--- | :--- | :--- |
| 哲学基础："美本身"为价值锚点 | 设计哲学："美是起源与终极追求" | **天然契合**，直接复用 |
| HARM 和谐度指标 | `agint-metrics` 进化指标 | HARM 作为 metrics 的**质量子维度** |
| TRACE/TRACE-P 评估 | `agint-rules` 规则门禁 | 评估结果作为规则门禁的**输入信号** |
| D-QAF 评估引擎 | `agint-evolve` 周复盘 | 评估报告作为进化提案的**依据** |
| 沙箱动态验证 | `agint-dream` 梦境整合 | 梦境阶段执行**深度质量反思** |
| 插件化架构 | dsh "一切皆插件" | 评估框架作为**第 9 组插件**加入 |

### 1.2 融合后的插件全景

```
AGINT 插件体系（融合后）
│
├── 原有 8 插件（不变）
│   ├── agint-memory      ← 存储评估历史
│   ├── agint-wiki        ← 存储评估知识
│   ├── agint-cron        ← 定时触发评估
│   ├── agint-dream       ← 梦境中深度反思
│   ├── agint-rules       ← 安全门控执行
│   ├── agint-metrics     ← 采集评估数据
│   ├── agint-evolve      ← 基于评估生成提案
│   └── agint-tool-stats  ← 提供工具画像
│
└── 新增评估插件组（D-QAF-AGINT）
    ├── agint-quality-contract   ← 核心契约（Seam 定义）
    ├── agint-quality-eval       ← 评估引擎（TRACE/TRACE-P）
    ├── agint-quality-sandbox    ← 沙箱执行器
    ├── agint-quality-policy     ← 策略引擎（决策）
    └── agint-quality-report     ← 报告生成器
```

---

## 二、逐插件融合设计

### 2.1 `agint-quality-contract` — 核心契约

**职责**：定义评估框架的所有接口（Seam），不包含具体实现。

```yaml
# plugins/agint-quality-contract/package.json
name: agint-quality-contract
version: 0.1.0
keywords: [dsh-plugin]
```

**暴露的 Seam**：

```typescript
// 评估器接口
@seam.register("agint.quality/evaluator")
interface QualityEvaluator {
  evaluate(target: EvalTarget): Promise<EvalResult>
}

// 策略接口
@seam.register("agint.quality/policy")
interface QualityPolicy {
  decide(results: EvalResult[]): Promise<Decision>
}

// 报告接口
@seam.register("agint.quality/reporter")
interface QualityReporter {
  generate(results: EvalResult[], decision: Decision): Promise<Report>
}

// 生命周期钩子
@seam.register("agint.quality/lifecycle")
interface QualityLifecycle {
  onPluginLoaded(plugin: PluginMeta): void
  onPluginUnloaded(plugin: PluginMeta): void
  onSkillRegistered(skill: SkillMeta): void
  onDreamPhase(phase: DreamPhase): void
  onWeeklyReview(): void
}
```

**与 AGINT 的集成点**：
- 监听 `agint-dream` 的阶段事件（`onDreamPhase`）
- 监听 `agint-evolve` 的周复盘事件（`onWeeklyReview`）
- 监听 dsh 的插件加载/卸载事件

---

### 2.2 `agint-quality-eval` — 评估引擎

**职责**：实现 TRACE（Skill）和 TRACE-P（Plugin）的具体评估逻辑。

**与现有插件的数据流**：

```
agint-tool-stats ──→ 工具调用数据 ──→ ┐
agint-metrics    ──→ 运行时指标   ──→ ├──→ agint-quality-eval ──→ EvalResult
agint-memory     ──→ 历史评估记录 ──→ ┘
```

**评估维度映射**：

| TRACE-P 维度 | 数据来源（AGINT 插件） | 说明 |
| :--- | :--- | :--- |
| **S**afety | 静态扫描 + `agint-rules` | 规则门禁作为安全基线 |
| **I**ntegrability | dsh 依赖图 + `agint-tool-stats` | 工具冲突检测 |
| **T**rust | 代码签名 + `agint-memory` | 历史信任记录 |
| **R**eliability | `agint-metrics` 运行时数据 | 错误率、资源泄漏 |
| **E**ffectiveness | `agint-metrics` + `agint-tool-stats` | 任务完成率、调用效率 |

**HARM 和谐度集成**：

```typescript
// 在 agint-quality-eval 中计算 HARM
function calculateHARM(evalResults: EvalResult[]): HARM {
  return {
    homogeneity: measurePatternReuse(evalResults),      // 跨任务模式复用率
    alignment: measureStrategyCoherence(evalResults),    // 策略-执行-结果连贯性
    reduction: measureMinimalComplexity(evalResults),    // 最小结构复杂度
    mutability: measureAdaptationFriction(evalResults),  // 新经验融入摩擦
  }
}

// HARM 分数 = 0.2·H + 0.3·A + 0.3·R + 0.2·M
```

---

### 2.3 `agint-quality-sandbox` — 沙箱执行器

**职责**：在隔离环境中执行待评估的 Skill/Plugin。

**与 AGINT 的集成**：
- 复用 dsh 已有的沙箱机制（bwrap/Landlock/Seatbelt）
- 评估专用的沙箱配置：**只读 + 网络隔离 + 资源限制**
- 沙箱执行结果写入 `agint-memory` 的评估历史区

```yaml
# 沙箱配置
sandbox:
  mode: read-only
  network: disabled
  timeout: 30s
  memory_limit: 512MB
  output: eval-result
```

---

### 2.4 `agint-quality-policy` — 策略引擎

**职责**：聚合评估结果，做出准入/拒绝/灰度决策。

**与 `agint-rules` 的协同**：

```
agint-rules（规则门禁）
    ↓ 提供安全基线规则
agint-quality-policy（策略引擎）
    ↓ 综合评估 + 规则 → 最终决策
    ↓
决策结果 → agint-evolve（进化提案依据）
```

**策略层级**：

```typescript
// 一票否决（Safety/Trust）
if (hasSecurityVulnerability || hasUnauthorizedAccess) {
  return Decision.REJECT("安全门控未通过")
}

// 综合评分
const score = weightedScore({
  safety: 0.30,
  integrability: 0.20,
  trust: 0.20,
  reliability: 0.20,
  effectiveness: 0.10,
})

// 分级决策
if (score >= 90) return Decision.AUTO_DEPLOY()
if (score >= 75) return Decision.PENDING_REVIEW()
return Decision.REJECT("质量不达标")
```

---

### 2.5 `agint-quality-report` — 报告生成器

**职责**：生成人类可读 + 机器可读的评估报告。

**输出格式**：
- **Markdown 报告**：写入 `agint-wiki`，供 Agent 自我查阅
- **JSON 结构化数据**：写入 `agint-memory`，供后续评估引用
- **进化提案格式**：直接对接 `agint-evolve` 的提案模板

---

## 三、与 AGINT 进化闭环的融合

### 3.1 融入 AGINT 的日常循环

```
┌─────────────────────────────────────────────────────────┐
│                    AGINT 日常循环                         │
│                                                         │
│  用户任务 → Agent 执行 → 工具调用 → 结果反馈              │
│                              ↓                          │
│                    agint-tool-stats 记录                 │
│                    agint-metrics 采集                    │
│                              ↓                          │
│              ┌──── agint-quality-eval ────┐             │
│              │   TRACE/TRACE-P + HARM     │             │
│              │   持续评估运行中的组件       │             │
│              └────────────┬───────────────┘             │
│                           ↓                             │
│              agint-quality-policy 决策                   │
│              ├─ 正常 → 继续运行                          │
│              ├─ 异常 → 告警 + 降级                       │
│              └─ 严重 → 自动卸载 + 回滚                   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 3.2 融入 AGINT 的梦境机制

AGINT 的 `agint-dream` 有 light → REM → deep 三个阶段，评估框架在每个阶段承担不同角色：

| 梦境阶段 | 评估框架的角色 | 具体动作 |
| :--- | :--- | :--- |
| **Light** | 快速扫描 | 对当天新增/修改的 Skill 做 TRACE 静态评估 |
| **REM** | 深度反思 | 对 Plugin 做 TRACE-P 全量评估 + HARM 和谐度计算 |
| **Deep** | 整合归档 | 将评估结果写入 `agint-memory`，更新 `agint-wiki` 中的质量档案 |

```typescript
// agint-quality-contract 中的生命周期钩子
@seam.register("agint.quality/lifecycle")
class DreamQualityHook implements QualityLifecycle {
  async onDreamPhase(phase: DreamPhase) {
    switch (phase) {
      case "light":
        await this.quickScan()       // TRACE 静态评估
        break
      case "rem":
        await this.deepEvaluate()    // TRACE-P + HARM
        break
      case "deep":
        await this.archive()         // 写入 memory + wiki
        break
    }
  }
}
```

### 3.3 融入 AGINT 的周复盘

`agint-evolve` 负责每周复盘并生成改进提案，评估框架为其提供**数据支撑**：

```
agint-evolve 周复盘
    ↓ 请求
agint-quality-eval 提供本周评估汇总
    ├─ 各 Skill/Plugin 的 TRACE/TRACE-P 分数趋势
    ├─ HARM 和谐度变化曲线
    ├─ 安全事件统计
    └─ 性能退化告警
    ↓
agint-evolve 基于评估数据生成进化提案
    ├─ "Plugin X 的 Reliability 连续下降，建议重构"
    ├─ "Skill Y 的 Effectiveness 低于阈值，建议淘汰"
    └─ "HARM-Mutability 下降，系统适应性减弱，建议引入新技能"
```

### 3.4 融入 AGINT 的进化路线（P0→P4）

| 阶段 | AGINT 原有目标 | 评估框架的融合 |
| :--- | :--- | :--- |
| **P0** | 基础能力搭建 | 部署 `agint-quality-contract` + 基础静态评估 |
| **P1** | 长期记忆 + 反思 | 评估历史写入 `agint-memory`，梦境中做质量反思 |
| **P2** | 规则门禁 + 指标 | HARM 指标接入 `agint-metrics`，安全门控接入 `agint-rules` |
| **P3** | 自进化提案 | 评估数据驱动 `agint-evolve` 生成精准进化提案 |
| **P4** | 完全自主进化 | 评估框架自身可被 Agent 优化（策略权重自适应） |

---

## 四、安装与配置

### 4.1 目录结构（融合后）

```
AGINT/
├── plugins/
│   ├── agint-memory/
│   ├── agint-wiki/
│   ├── agint-cron/
│   ├── agint-dream/
│   ├── agint-rules/
│   ├── agint-metrics/
│   ├── agint-evolve/
│   ├── agint-tool-stats/
│   │
│   └── agint-quality/                    ← 新增
│       ├── agint-quality-contract/       ← 核心契约
│       ├── agint-quality-eval/           ← 评估引擎
│       ├── agint-quality-sandbox/        ← 沙箱执行器
│       ├── agint-quality-policy/         ← 策略引擎
│       └── agint-quality-report/         ← 报告生成器
│
├── profile-patches/
│   └── web/cordis.patch.yml              ← 更新：加入 5 个 quality 插件
│
└── install/
    └── install.sh                        ← 更新：安装 quality 插件
```

### 4.2 Patch 文件更新

```yaml
# profile-patches/web/cordis.patch.yml
plugins:
  # ... 原有 8 个插件 ...
  
  # 新增：D-QAF 评估插件组
  - name: agint-quality-contract
    path: plugins/agint-quality/agint-quality-contract
  - name: agint-quality-eval
    path: plugins/agint-quality/agint-quality-eval
  - name: agint-quality-sandbox
    path: plugins/agint-quality/agint-quality-sandbox
  - name: agint-quality-policy
    path: plugins/agint-quality/agint-quality-policy
  - name: agint-quality-report
    path: plugins/agint-quality/agint-quality-report
```

### 4.3 安装命令

```shell
# 在已有 AGINT 安装基础上，增量安装评估插件组
cd ~/projects/AGINT
./install/install.sh --with-quality

# 或手动复制
cp -r plugins/agint-quality $DSH_HOME/plugins/
# 更新 cordis.patch.yml 后重启
dsh web restart
```

---

## 五、安全约束（AGINT 特化）

| 约束 | 说明 | 执行方 |
| :--- | :--- | :--- |
| **不可自评估** | `agint-quality` 不能评估自身，需独立 CI 审查 | 外部流程 |
| **最小权限** | 仅读取其他插件代码/元数据，不修改不执行 | dsh 权限系统 |
| **梦境隔离** | 梦境中的深度评估在独立沙箱中执行，不影响主进程 | `agint-quality-sandbox` |
| **人类否决权** | 对 `agint-quality-contract` 的任何修改需人类确认 | `agint-rules` |
| **自动回滚** | 评估插件更新失败时，Cordis 可逆副作用机制自动回滚 | dsh Cordis |
| **评估日志** | 所有评估操作记录到 `agint-memory`，不可篡改 | `agint-memory` |

---

## 六、融合后的完整进化闭环

```
用户任务
    ↓
Agent 执行（调用 Skill/Plugin）
    ↓
agint-tool-stats + agint-metrics 采集运行数据
    ↓
agint-quality-eval 持续评估（TRACE/TRACE-P + HARM）
    ↓
agint-quality-policy 决策
    ├── 正常 → 继续运行
    ├── 异常 → 告警 + 降级
    └── 严重 → 自动卸载 + 回滚
    ↓
agint-dream 梦境反思
    ├── Light: 快速扫描
    ├── REM: 深度评估 + HARM 计算
    └── Deep: 归档到 agint-memory + agint-wiki
    ↓
agint-evolve 周复盘
    ↓ 基于评估数据生成进化提案
    ├── "新增 Skill Z 以填补能力缺口"
    ├── "重构 Plugin X 以提升可靠性"
    └── "淘汰 Skill Y，Effectiveness 持续低于阈值"
    ↓
进化提案执行 → 新 Skill/Plugin 进入评估流程
    ↓
agint-quality-eval 评估新组件（四阶段漏斗）
    ├── Phase 1: 静态准入
    ├── Phase 2: 动态沙箱
    ├── Phase 3: 集成演练
    └── Phase 4: 灰度发布
    ↓
通过 → 部署 / 不通过 → 拒绝 + 记录原因
    ↓
回到"Agent 执行"，闭环完成
```

---

## 七、总结

> **D-QAF 评估框架与 AGINT 的融合，本质上是将"质量保障"从一个外部约束，转化为 AGINT 自进化闭环的内在组成部分。**
>
> - **哲学层**：AGINT 的"美是起源与终极追求"与 D-QAF 的"美本身"价值锚点天然契合，无需额外适配。
> - **架构层**：评估框架以 5 个插件的形式加入 AGINT 的插件体系，完全遵循 dsh "一切皆插件"原则。
> - **数据层**：评估数据通过 `agint-memory`（长期存储）、`agint-metrics`（实时采集）、`agint-tool-stats`（工具画像）三个现有插件流转，无需新建数据通道。
> - **流程层**：评估嵌入 AGINT 的日常循环、梦境机制和周复盘，成为自进化的"质量守门人"。
> - **进化层**：评估框架自身在 P4 阶段可被 Agent 优化，实现"评估评估者"的递归自指。
>
> 最终，AGINT 不再只是一个"能进化的 Agent"，而是一个**知道自己进化得好不好、并据此调整进化方向的 Agent**。这正是从"自进化"走向"自知进化"的关键一步。
