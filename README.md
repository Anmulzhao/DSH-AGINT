<div align="center">
  <img src="docs/assets/brand/png/agint-logo-512.png" width="300" alt="AGINT">
</div>

# AGINT

> 基于 DeepSeek Harness (dsh) 的**自进化智能体框架**。

**Latest**：v0.8.6 · **34 个 Cordis 插件** · 24 个 preset 工具行 · 16 个 cron job · D-QAF v0.2 · HARM 四维

AGINT = **AGI INTelligence**。把 dsh 当 runtime，在它之上构建一套「持续自进化」的能力：长期记忆、定时反思、规则门禁、进化指标、周复盘、梦境整合、**D-QAF 质量评估**，以及 P7.5 的**自进化执行层**（技能自动创建 / 策展 / 学习图谱 / 轨迹记录 / 记忆压缩守卫）。

## 设计哲学

> **美是 AGINT 的起源与终极追求**。美 = 简洁 + 真实 + 靠谱 + 主动 + 安全，冲突时取前者。

| 取 | 舍 | 取 | 舍 |
|---|---|---|---|
| 简洁 | 冗余 | 主动 | 被动 |
| 真实 | 讨好 | 安全 | 效率 |
| 靠谱 | 聪明 | | |

完整论述见 Wiki [PHILOSOPHY](https://github.com/Anmulzhao/DSH-AGINT/wiki/PHILOSOPHY)；工程化检查项见 [`docs/evolution-philosophy-checkpoints.md`](./docs/evolution-philosophy-checkpoints.md)。

## 不是什么

- 不是 dsh 的 fork。dsh 是上游 runtime，AGINT 是 dsh 之上的规范 + 组件。
- 不是 AGI 实现，是**通往 AGI 的工程化骨架**：记忆、反思、约束、度量、迭代、评估。
- 不追求大而全：新增功能必须经 D-QAF 评估，并在现有插件化架构内实现。

## 是什么

| 层 | 内容 | 来源 |
|---|---|---|
| **bundle** | AGINT 整体 = 一个 dsh bundle 包 `@agint/host`（下图所有插件 + 挂载 patch 都在包内） | 仓库根 `package.json` + `cordis.patch.yml` |
| **preset** | 智进人格 + 工具集（含 AGINT 专属 skills）。3 套：`agint`（主线）、`agint-blockchain`、`agint-investor` | `presets/agint*/` |
| **plugin** | **34 个** Cordis 插件（另有 2 个嵌套在 `agint-quality/` 内不单列：`quality-contract` / `quality-policy`），提供 host Services | `plugins/agint-*/` |
| **data** | 记忆 / 规则 / 指标 / 提案 / 梦境 / 复盘 / 评估历史 | runtime 数据，**不**进仓库 |

## 插件全景（34）

| 分组 | 插件 |
|---|---|
| **记忆与知识**（4） | `memory`（L1–L4 分层遗忘）· `wiki`（知识库，与任务记忆分离）· `memory-provider`（可插拔 Provider + 降级/检查点）· `search-tools`（跨域统一搜索：记忆 + wiki） |
| **调度与治理**（4） | `cron`（定时任务）· `rules`（advisory / ask / deny 三级门禁）· `metrics`（进化指标时序）· `tool-stats`（工具使用画像） |
| **反思与进化**（5） | `dream`（夜间梦境整合 light→REM→deep）· `evolve`（周复盘）· `evolution-memory`（进化记忆层，区别于任务记忆）· `diagnosis`（6 类根因归因）· `curriculum`（自主课程生成器） |
| **D-QAF 质量层**（6 + 2 嵌套） | `quality`（聚合入口）· `quality-sdk`（Prompt SDK）· `quality-static`（静态准入，6 族 checker）· `quality-sandbox`（动态沙箱）· `quality-eval`（7 维评分）· `quality-report`（HARM 报告）· 嵌套：`quality-contract`（L0 FROZEN 契约）· `quality-policy`（策略引擎） |
| **进化闭环引擎**（5） | `mutator`（变异构造）· `population`（种群管理）· `abtest`（A/B 检验）· `mount`（三段式挂载事务）· `evolution-driver`（闭环驱动源：evolve 提案 → 目标定位（技能名/仓库路径）→ subagent 生成原子编辑 → 幻觉闸门 + 实体存在性门 → mutator.propose → population.ingest → commit 写仓库（带 preimage 备份）；2026-09-27 端到端闭环首次跑通） |
| **自进化执行层**（5，P7.5） | `skill-autocreate`（技能自动创建：检测 → 评估 → 发布三道门）· `curator`（技能策展 / 陈旧归档）· `skill-graph`（技能关系图谱）· `trajectory`（进化轨迹 / 训练数据层）· `compress-guard`（记忆压缩检查点守卫） |
| **观测与基础设施**（5） | `self-model`（自我模型，只读观察者）· `event-bus`（事件总线）· `restart`（重启编排 + 代码指纹）· `session-extract`（中立会话提取器）· `ov-strategy`（OpenViking 策略层：dream/diagnosis 产物 write-through 投影 + 策略召回，单缝 R1 / 全软依赖 / kill-switch） |

## 5 分钟装起来

前置：Node.js ≥ 20 · `@deepseek-ai/dsh` ≥ 0.1.7-rc.1（矩阵见 [`VERSION`](./VERSION)）· dsh 已初始化（`dsh web` 跑过至少一次）。

```sh
git clone https://github.com/Anmulzhao/DSH-AGINT.git ~/projects/AGINT
cd ~/projects/AGINT
./install/install.sh          # 支持 --dry-run；幂等可回滚，备份保留 10 份
```

装完**必须重启 `dsh web`**（bundle 层与 profile 层都不热更新）。卸载：`./install/uninstall.sh`。

- ⛔ **装完像没装、且零报错** ⇒ 十有八九是没注册进 `dsh.profile.bundles`（安装步骤 3.5）。
- ⛔ 包内 `node_modules` junction 是 dsh 官方包的软链，卸载时**保留**（`rm -rf` 会跟进删掉 266 个包）。
- 排障三板斧、`install.sh` 实际步骤、dsh 0.1.7 的两个坑、技能落点：见 [`docs/dsh-integration.md`](./docs/dsh-integration.md)。
- ⛔ `npm install -g @deepseek-ai/dsh@latest` 会**静默降级**（`latest` 可能低于在跑版本）。**必须带精确版本号**。

## 自进化宪法

**D-QAF 四阶段流水线**（静态准入 → 动态沙箱 → 集成演练 → 灰度发布）+ **HARM 四维指标**（Homogeneity / Alignment / Reduction / Mutability）+ **进化记忆层**（区别于任务记忆），完整论述见 [`docs/evolution-framework.md`](./docs/evolution-framework.md)。

自 2026-09-18 起的根本原则：**默认自动化，人工审批只作兜底** —— 门禁尽量下放为可自动验证的规则，新机制一律带 kill-switch，但 **kill-switch ≠ 默认关**：出厂即开，配齐「默认开 + 降级回落 + 审计出口 + 一键可关」。

## 仓库自检

| 命令 | 查什么 |
|---|---|
| `node bin/check-dsh-compat.mjs` | dsh 兼容性四查：悬挂包名 / peer 兼容性预演 / 版本漂移 / 改名残留。`--json` 给 CI，`--strict` 让 info 也算失败 |
| `node bin/check-wiring.mjs` | 接线完整性九查（A~I）：空壳服务 / 主题接线 × 生产数据 / 存储域通电 / 命名空间错配 / TS 源产物漂移 / 双副本一致性 / 仓库↔部署位漂移 / 漂移插件 smoke 门禁 —— 「挂载了」≠「通电了」 |
| `node bin/check-tool-schemas.mjs` | tool schema 两套方言真编译一遍（写错会让整条 preset 起不来） |
| `node bin/check-memory.mjs` | 记忆层自检：索引 K 号真实性 / 重复 K 号一致性 / 目录分裂 / 体积超限 / 引用存在性。`--json` 供 CI |

## 文档地图

| 想看什么 | 去哪 |
|---|---|
| 运行现状（真实数字） | [`AGENTS.md`](./AGENTS.md) 文末 LOCAL-STATE 自动块（`bin/agents-local-state.mjs` 探测回写，权威） |
| 运行时架构 / 插件详细 | [`docs/architecture.md`](./docs/architecture.md) · [`docs/plugins/`](./docs/plugins/) |
| dsh 集成边界 / 安装排障 | [`docs/dsh-integration.md`](./docs/dsh-integration.md) |
| D-QAF / HARM / 进化记忆 | [`docs/evolution-framework.md`](./docs/evolution-framework.md) |
| 安全边界 | [`docs/security-boundary.md`](./docs/security-boundary.md) |
| 路线图 / 变更日志 / PHILOSOPHY | [GitHub Wiki](https://github.com/Anmulzhao/DSH-AGINT/wiki) |

## 环境变量

| 变量 | 用途 | 默认 |
|---|---|---|
| `DSH_HOME` | dsh 数据/配置根 | `$HOME/.dsh` |
| `AGINT_HOME` | AGINT workspace（dream/wiki/reviews/scenarios 落点） | `$HOME/projects/AGINT` |

## 许可

MIT
