# AGINT

> 基于 DeepSeek Harness (dsh) 的自进化智能体框架。原 OpenClaw 版 AGINT 迁移到 dsh 后的规范化版本。

AGINT = **AGI INTelligence**，把 dsh 当 runtime，在它之上构建一套「持续自进化」的能力：长期记忆、定时反思、规则门禁、进化指标、周复盘、梦境整合、**D-QAF 质量评估**。

## 不是什么

- 不是 dsh 的 fork。dsh 是上游 runtime，AGINT 是 dsh 之上的规范 + 组件。
- 不是 AGI 实现。它是**通往 AGI 的工程化骨架**：记忆、反思、约束、度量、迭代、评估。
- 不追求大而全。AGINT 哲学「简洁 > 冗余」，新功能必须经过 D-QAF 评估、能在现有插件化架构内完成才会上。

## 是什么

| 层 | 内容 | 来源 |
|---|---|---|
| **preset** | 智进人格 + 工具集（含 4 个 AGINT 专属 skills） | `presets/agint/` |
| **plugin** | 13 个 Cordis 插件，提供 AGINT 专属 host Services（memory / wiki / cron / dream / rules / metrics / evolve / tool-stats / evolution-memory + quality 子家族 6 个：contract / eval / sandbox / policy / report / sdk） | `plugins/agint-*/` |
| **patch** | 把 9 个插件挂入 dsh profile 的 user-patch 层 | `profile-patches/web/cordis.patch.yml` |
| **data** | 长期记忆 / 规则 / 指标 / 提案 / 工具统计 / 梦境 / 复盘 / 评估历史 | runtime 数据，**不**进仓库 |

## 仓库结构

```
AGINT/
├── README.md                    你正在看
├── AGENTS.md                    给 AGINT agent 自己读的工作守则
├── PHILOSOPHY.md                设计哲学：美是起源与终极追求
├── ROADMAP.md                   进化路线 P0→P1→P2→P3→P4→P5
├── VERSION                      兼容 dsh 版本表
├── CHANGELOG.md                 每个版本的 release notes
├── LICENSE                      MIT
│
├── presets/                     ── dsh agent-presets/
│   ├── agint/                   智进主 preset（含 4 个 skills）
│   ├── agint-blockchain/        派生：区块链/Web3 工程师 + 领域专家（+ 5 个 web3 skill）
│   └── agint-investor/          派生：投研专用
│
├── plugins/                     ── dsh profile plugins/
│   ├── agint-memory/            P1 长期记忆四层遗忘
│   ├── agint-wiki/              知识库
│   ├── agint-cron/              定时任务
│   ├── agint-dream/             夜间梦境 light→REM→deep
│   ├── agint-rules/             规则门禁（frozenness 三层）
│   ├── agint-metrics/           进化指标
│   ├── agint-evolve/            周复盘 + 改进提案
│   ├── agint-tool-stats/        工具使用画像
│   ├── agint-evolution-memory/  进化专用记忆 (Sprint 2.B, P3)
│   ├── agint-quality-contract/  D-QAF Seam 层（v0.1.1）
│   ├── agint-quality-eval/      D-QAF 评估引擎（v0.2）
│   ├── agint-quality-sandbox/   D-QAF Phase 2 沙箱（v0.3）
│   ├── agint-quality-policy/    D-QAF Phase 4 策略引擎（v0.4）
│   ├── agint-quality-report/    D-QAF Phase 4 报告生成（v0.4）
│   └── agint-quality-sdk/       Prompt SDK + 静态检查（v0.5）
│
├── profile-patches/             ── dsh user-patch 层
│   └── web/cordis.patch.yml     把 13 个插件挂入 dsh web profile
│
├── docs/                        正式设计文档 / 架构图 / 插件契约
│   ├── architecture.md          运行时架构 / 数据流
│   ├── dsh-integration.md       dsh 集成边界
│   ├── evolution-framework.md   D-QAF / HARM 哲学与工程收口
│   ├── security-boundary.md     硬约束清单（dsh-security-boundary）
│   ├── evolution-philosophy-checkpoints.md  哲学锚点工程化检查
│   ├── plugins/                 每个插件一个 README
│   └── lessons/                 经验教训归档(踩坑实录 + 修复方案 + 教训)
│       └── *.md
│
├── eval/                        评估集（84 场景全量 PASS）
│   ├── scenarios/               单元场景（19 个 .json）
│   └── e2e/                     端到端测试（sprint4/5/6 闭环）
└── install/                     安装/卸载脚本
```

### 本地设计过程文档（**不进 GitHub**）

仓库根目录下还有 3 份设计过程文档：

- `DSH-AGINT-D-QAF融合方案.md`（v0.3.1 设计稿）
- `DSH自进化系统评估框架完整汇总.md`（评估框架原始汇总）
- `DSH自进化系统整体优化改进方案.md`（§5 ROADMAP 调整建议的源头）

它们是 v0.5.1 之前的早期设计稿，**已被 `docs/evolution-framework.md` / `ROADMAP.md` / 各 plugin README 正式收口**。
按 [SKILL: github-push §仓库纪律](https://github.com/Anmulzhao/DSH-AGINT) 公开仓库只放框架本体，所以这 3 份**不 commit、不 push**，留在本地工作树供溯源。

正式设计文档在 `docs/` 下，与 GitHub 仓库一致。

## 安装

### 前置

- Node.js ≥ 20
- `@deepseek-ai/dsh` ≥ 0.1.0-rc.6（参见 `VERSION`）
- dsh 已初始化（`dsh web` 至少跑过一次，会自动建 `$DSH_HOME`）

### 装到本机

```sh
git clone https://github.com/Anmulzhao/DSH-AGINT.git ~/projects/AGINT
cd ~/projects/AGINT
./install/install.sh
```

`install.sh` 做三件事：
1. 把 `presets/agint/` 复制到 `$DSH_HOME/.agent-presets/agint/`（已存在则备份为 `agint.bak-<timestamp>`）
2. 把 `plugins/agint-*/` 复制到 `$DSH_HOME/profiles/web/plugins/`
3. 把 `profile-patches/web/cordis.patch.yml` 合并到 `$DSH_HOME/profiles/web/cordis.patch.yml`（已存在则备份 + 合并 agint-* insert 段）

**安装后必须重启 dsh web**（user-patch 层不热更新）。

### 卸载

```sh
./install/uninstall.sh
```

## 环境变量

| 变量 | 用途 | 默认 |
|---|---|---|
| `DSH_HOME` | dsh 数据/配置根 | `$HOME/.dsh` |
| `AGINT_HOME` | AGINT workspace（dream/wiki/reviews/scenarios 落点） | `$HOME/projects/AGINT` |

`AGINT_HOME/dreams/`、`AGINT_HOME/wiki/`、`AGINT_HOME/reviews/` 由 agint-dream / agint-wiki / agint-evolve 自动创建。

## 自进化宪法（速览）

> 完整版见 `docs/evolution-framework.md`。这里只放「老板一眼扫完」版。

### 哲学锚点 → 工程决策

| 哲学原则 | 工程实现 |
|---|---|
| 简洁 > 冗余 | 最小架构优先，新增功能必须能在现有插件化架构内完成。复杂插件化回归到单插件 |
| 真实 > 讨好 | 评估报告必须展示原始失败数据，HARM 分数不能独立决策 |
| 靠谱 > 聪明 | 语义版本锁定 + 一键回滚；任何变更必须经过 D-QAF 评估 |
| 主动 > 被动 | 退化/停滞自动告警；HARM 增量不足自动切换探索模式 |
| 安全 > 效率 | 沙盒前置 + 静态扫描 + 硬约束清单（`docs/security-boundary.md`） |

### D-QAF 四阶段流水线

```
Phase 1: 静态准入（代码规范、安全扫描、契约校验）
    ↓ 通过
Phase 2: 动态沙箱（单元测试、模糊测试、资源监控）  [v0.3 落地]
    ↓ 通过
Phase 3: 集成演练（冲突检测、全链路追踪）+ HARM 打分 + 预算对齐
    ↓ 通过
Phase 4: 灰度发布（A/B 测试、实时熔断）  [v0.4 落地]
    ↓ 达标
正式部署 / 不达标则回滚
```

### HARM 四维指标

`Harmony = 0.2·H + 0.3·A + 0.3·R + 0.2·M`

| 维度 | 含义 | 度量内容 |
|---|---|---|
| **H** - Homogeneity | 杂多中的统一 | 跨任务的模式复用率 |
| **A** - Alignment | 内部和谐 | 策略-执行-结果的逻辑连贯性 |
| **R** - Reduction | 纯一简约 | 达成目标的最小结构复杂度 |
| **M** - Mutability | 优雅适应 | 新经验融入现有结构的摩擦成本 |

### 进化记忆层（v0.3 引入）

区别于 `agint-memory`（任务级记忆），AGINT 引入**进化专用记忆**：
- 每次 D-QAF 评估完成后自动写入 `evolution-log`
- 周复盘时归纳 `failure-patterns` / 蒸馏 `success-templates`
- 提交新组件前自动检索历史失败模式，提前预警

物理隔离：进化记忆不与任务记忆共享存储。自动化写入：脱离 Agent 主动记录，由 D-QAF 流水线自动落点。

### 五条黄金准则

| 准则 | AGINT 现状 |
|---|---|
| 持久修改才算进化 | ✓ 已内化（cordis.patch 持久化 + git 仓库） |
| 可逆性是底线 | ✓ 语义版本锁定 + 一键回滚 |
| 最小架构优先 | ✓ 哲学锚点 + 3000 行精神 |
| 进化 ≠ 堆数据 | ⚠ v0.3 引入预算对齐（`docs/evolution-framework.md` §预算对齐） |
| 安全约束前置 | ✓ 沙盒 + 硬约束清单（`docs/security-boundary.md`） |

## 与 dsh 的关系

- **AGINT 依赖 dsh**，不 fork dsh、不修改 dsh 源码
- 所有 AGINT 能力走 dsh 的「user-patch 层」+「agent-preset 层」注入
- dsh 主线升级后跑 `install/uninstall.sh` 重装即可
- dsh API 变更会在 CI 中暴露（计划中）

详细边界见 `docs/dsh-integration.md`。

## 状态

- **v0.5.1**（2026-08）：SDK ↔ D-QAF 流水线接通（Sprint 6 / v0.5 Part 2/2 收口）。Prompt SDK 跟 D-QAF 流水线（eval / policy / report / cron）全联通。13 个插件 + 3 个 preset + 1 个 patch + 4 个 skill + 3 个 prompt preset，84/84 全量 eval 通过。
- **v0.5.0**：Prompt SDK 落地（Part 1/2）—— PromptManifest FROZEN 契约 + 模板引擎 + 静态检查 + CLI + 3 presets。
- **v0.4.0**：P4 收口——策略引擎（完整 4 决策 + 加权综合分）+ 反和谐检测器 + 元评估委员会 + HARM 报告生成 + 端到端闭环 e2e。
- **v0.3.1**：P3 收口——沙箱 + 进化记忆 + 退化探测 + D-QAF 端到端流水线接入。
- **v0.2**：D-QAF contract + eval 引擎初版；新增自进化宪法三件套（`docs/evolution-framework.md` / `docs/security-boundary.md` / `docs/evolution-philosophy-checkpoints.md`）。
- **v0.1.0 / v0.1.1 / v0.1.2**：迁移完成 + D-QAF Seam 层。

详细路线见 `ROADMAP.md`；详细变更见 `CHANGELOG.md`。

## 许可

MIT
