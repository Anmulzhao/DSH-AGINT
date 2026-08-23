# 架构

> AGINT 的运行时结构、数据流、自进化宪法、与 dsh 的边界。
>
> 本文档是系统级架构图。**D-QAF / HARM / 进化记忆层 / 安全边界**等横向机制统一收口在 `docs/evolution-framework.md` 和 `docs/security-boundary.md`，本文仅描述运行时衔接。

## 整体关系

```
┌─────────────────────────────────────────────────────────────────┐
│  dsh (upstream runtime)                                          │
│  ├── default presets: code / cordis / minimal / standard        │
│  └── user-patch layer  ← cordis.patch.yml ← 这里注入 agint-*     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  AGINT user-patch 层 (profile-patches/web/cordis.patch.yml)      │
│  把 9 个 Cordis 插件作为 host Service 挂入 dsh web profile        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  AGINT host Services (plugins/)                                  │
│  memory │ wiki │ cron │ dream │ rules │ metrics │ evolve │ stats ││
│  + quality.contract  (Seam 层)                                   │
│  + quality.eval      (评估引擎 v0.2)                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  AGINT preset (presets/agint/agent.cordis.yml)                  │
│  把 host Services 暴露成 model 工具：memory_* / wiki_* / ...      │
│  + 4 个 skills + 智进人格                                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Runtime 数据 (gitignore)                                        │
│  $DSH_HOME/storages/agint*.json            KV 状态                │
│  $AGINT_HOME/dreams/                       梦境日记               │
│  $AGINT_HOME/wiki/                         知识库                 │
│  $AGINT_HOME/reviews/                      复盘报告               │
│  $AGINT_HOME/eval/scenarios/               评估场景集（v0.3+）    │
└─────────────────────────────────────────────────────────────────┘
```

## 9 个 host Services 一览

| Service | 启动 | 调度 | 落点 | 触发 |
|---|---|---|---|---|
| `agint.memory` | 启动时 | 即时 | `~/.dsh/storages/agint.json` | model 调 memory_* |
| `agint.wiki` | 启动时 | 即时 | `$AGINT_HOME/wiki/` | model 调 wiki_* |
| `agint.cron` | 启动时 | tick | KV + 触发器 | tick + 手动 |
| `agint.dream` | 启动时 | cron night-dream | `$AGINT_HOME/dreams/` | 每日 03:00 |
| `agint.rules` | 启动时 | waterfall | `~/.dsh/storages/agint_rules.json` | 每个工具调用 |
| `agint.metrics` | 启动时 | cron metrics-collect | `~/.dsh/storages/agint_metrics.json` | 每日 |
| `agint.evolve` | 启动时 | cron evolve-review | `$AGINT_HOME/reviews/` + KV | 每周日 |
| `agint.toolStats` | 启动时 | tools/result 监听 | `~/.dsh/storages/agint_tool_stats.jsonl` | 每个工具调用 |
| `agint.quality` | 启动时 | — | Seam 接口（无状态） | model 调 quality_* |
| `agint.qualityEvaluator` | 启动时 | cron weekly 04:30 | `agint.memory`（评估历史） | 每周日 + 手动 |

> **v0.2 变更**：`agint-quality-eval` 评估引擎已收编为第 10 个 host Service，但仍受 `agint.quality` 契约保护（Seam 不变，FROZEN）。

## 数据流：复盘 + 评估闭环

```
会话产生
   │
   ▼
agint.toolStats  ── append ──▶ agint_tool_stats.jsonl
   │
   ▼ (每日)
agint.metrics  ── 懒解析 ──▶ agint_metrics.json (kv 时序)
   │
   ▼ (周日 04:30)
agint.qualityEvaluator  ── 读 4 个源 ──▶ EvalResult
   │   (toolStats / memory / rules / metrics)
   │
   ▼ (周日 18:00)
agint.evolve.writeReview()
   │
   ├─▶ $AGINT_HOME/reviews/YYYY-MM-DD.md
   └─▶ model 看报告 → evolve_propose → 落地改进
                                          │
                                          ▼
                              memory_write / wiki_write / rule_add
                                          │
                                          ▼ (夜间)
                              agint.dream sweep
                                          │
                                          ▼
                              候选 → 评分 → 提升进 agint.memory
                                          │
                                          ▼
                              metrics 再观察改进是否生效
                                          │
                                          ▼ (周日 04:30)
                              agint.qualityEvaluator 下一次评估
```

## 横向机制：自进化宪法

> 完整版在 `docs/evolution-framework.md`。仅列运行时衔接。

### 安全边界（详见 `docs/security-boundary.md`）

```
┌──────────────────────────────────────────────────────────────┐
│  AGINT 安全边界（hard_constraints + sandbox_permissions）    │
│                                                              │
│  1. dsh-security-boundary.yaml 是唯一安全定义源              │
│  2. agint-rules 加载 boundary 规则到规则门禁（deny 最高优先级）│
│  3. 每个 plugin 启动时 agint.quality.contract 校验自身边界     │
│  4. 任何对 boundary 的修改 = L0-frozen 变更 = 人类多签 + CI 禁改│
└──────────────────────────────────────────────────────────────┘
```

### 预算对齐（v0.3 引入）

`agint-quality-eval` Phase 3 加入 `有效进化增量 = Δ(任务完成率) / Δ(Token消耗 + 步数 + 时间)`。
评估循环里**新增的 `agint-tool-stats` 字段**（tokenCost / stepCount / durationMs）将被拉到评估上下文。

### 进化记忆层（v0.3 引入）

```
独立存储域 `agint_evolution`（与 `agint/ agint_rules/ agint_metrics/ agint_evolve` 互斥）
   │
   ├── evolution-log/      每次 D-QAF Phase 4 完成后自动写入
   ├── failure-patterns/   周复盘时归纳
   ├── success-templates/  周复盘时蒸馏
   └── retrieval-engine/   提交新组件前自动检索
```

**物理隔离**：进化记忆 ≠ 任务记忆（不与 `agint.memory` 共享存储）。
**自动化写入**：脱离 Agent 主动记录，由 D-QAF 流水线自动落点。
**定向读取**：仅在进化评估阶段被 D-QAF 读取，不参与日常任务推理。

### 退化/停滞探测（v0.3 引入）

挂载在 `agint-quality-eval`：

- `baseline-regression-suite`：黄金用例集，每次周日评估后必跑
- 连续 K=5 次进化 HARM 增量 < 0.5 → 切换探索模式 / 暂停
- 基线回归套件通过率下降 > 2% → 立即冻结进化并告警
- 连续 K 次进化产出在行为空间余弦相似度 > 0.95 → 进化停滞预警

## 与 dsh 的边界

| 我们做 | dsh 做 |
|---|---|
| 注入 9 个 host Services | preset 协议 / loader / patch 模型 |
| 暴露 model 工具 | tool registry / 工具 schema |
| 写我们自己的 KV | 持久化 / 域管理 / 进程单例 |
| 写我们自己的 cron jobs | tick 调度 / job 注册 |
| 写我们自己的 rules | tools/pre + tools/post waterfall |
| 编排 5 个内置 job | cron 时间源 |
| 自持 WeeklyScheduler | 调度接口 |

**dsh 升级时**：load 顺序、waterfall hook 名、preset schema 可能变——CI 会暴露断点。

## 关键不变量

1. **`agint` storage domain 唯一**：memory 一个进程只有一个实例（service 域独占）
2. **host ↔ preset 工具配对**：plugin 负责 Service，preset 负责 Tool；任何工具都没有 Service 是悬空的
3. **patch 不破坏**：install.sh 用 `backup + merge`；用户 patch 里非 agint 段原样保留
4. **路径可移植**：`$AGINT_HOME` / `$DSH_HOME` 都在 .patch.yml 里走环境变量，默认值不带硬编码家目录
5. **L0-frozen 不可改**：任何对 `agint-quality-contract` 的 L0 字段变更需要人类多签 + CI 禁改
6. **插件不递归自评**：`agint-quality-eval` 评估 `agint-quality-eval` 本身抛错
7. **D-QAF Phase 4 走灰度**：自动部署 ≤ 3 次/周，超限必须人工审核（详见 `路线图` 节奏章节）
