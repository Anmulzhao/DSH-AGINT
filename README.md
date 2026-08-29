# AGINT

> 基于 DeepSeek Harness (dsh) 的**自进化智能体框架**。

AGINT = **AGI INTelligence**。把 dsh 当 runtime，在它之上构建一套「持续自进化」的能力：长期记忆、定时反思、规则门禁、进化指标、周复盘、梦境整合、**D-QAF 质量评估**。

📚 **文档**：本 README 是入口 · 深文档见 [**GitHub Wiki**](https://github.com/Anmulzhao/DSH-AGINT/wiki) · 契约/规范见 `docs/` · 路线见 [路线图](https://github.com/Anmulzhao/DSH-AGINT/wiki/路线图) · 变更见 [变更日志](https://github.com/Anmulzhao/DSH-AGINT/wiki/变更日志)

## 设计哲学

> **美是 AGINT 的起源与终极追求**。美 = 简洁 + 真实 + 靠谱 + 主动 + 安全，冲突时取前者。

| 取 | 舍 |
|---|---|
| 简洁 | 冗余 |
| 真实 | 讨好 |
| 靠谱 | 聪明 |
| 主动 | 被动 |
| 安全 | 效率 |

完整论述见 [`PHILOSOPHY.md`](./PHILOSOPHY.md)；工程化检查项见 [Wiki 进化哲学检查项](https://github.com/Anmulzhao/DSH-AGINT/wiki) 与 [`docs/evolution-philosophy-checkpoints.md`](./docs/evolution-philosophy-checkpoints.md)。

## 不是什么

- 不是 dsh 的 fork。dsh 是上游 runtime，AGINT 是 dsh 之上的规范 + 组件。
- 不是 AGI 实现。它是**通往 AGI 的工程化骨架**：记忆、反思、约束、度量、迭代、评估。
- 不追求大而全。遵循「简洁 > 冗余」：新增功能必须经 D-QAF 评估，并在现有插件化架构内实现。

## 是什么

| 层 | 内容 | 来源 |
|---|---|---|
| **preset** | 智进人格 + 工具集（含 AGINT 专属 skills） | `presets/agint*/` |
| **plugin** | **20 个** Cordis 插件（13 基础 + quality 子家族 5 + mount + abtest **+ Sprint 12 新增 agint-event-bus**），提供 host Services | `plugins/agint-*/` |
| **patch** | 把插件挂入 dsh profile 的 user-patch 层 | `profile-patches/web/cordis.patch.yml` |
| **data** | 记忆 / 规则 / 指标 / 提案 / 梦境 / 复盘 / 评估历史 | runtime 数据，**不**进仓库 |

> 插件清单与概念区分（skill vs plugin / preset / patch）见 [Wiki 插件目录](https://github.com/Anmulzhao/DSH-AGINT/wiki) 与 [Wiki 概念区分](https://github.com/Anmulzhao/DSH-AGINT/wiki)。

## 自进化宪法（速览）

AGINT 的核心是 **D-QAF 四阶段流水线**（静态准入 → 动态沙箱 → 集成演练 → 灰度发布）与 **HARM 四维指标**（Homogeneity / Alignment / Reduction / Mutability），并引入**进化记忆层**区分于任务记忆。完整论述见 [Wiki 自进化宪法 D-QAF 与 HARM](https://github.com/Anmulzhao/DSH-AGINT/wiki) 与 [`docs/evolution-framework.md`](./docs/evolution-framework.md)。

## 安装

### 前置

- Node.js ≥ 20
- `@deepseek-ai/dsh` ≥ 0.1.0-rc.6（见 [`VERSION`](./VERSION)）
- dsh 已初始化（`dsh web` 至少跑过一次）

### 装到本机

```sh
git clone https://github.com/Anmulzhao/DSH-AGINT.git ~/projects/AGINT
cd ~/projects/AGINT
./install/install.sh
```

`install.sh` 执行三项：① 复制 `presets/agint/` 到 `$DSH_HOME/.agent-presets/`；② 复制 `plugins/agint-*/` 到 `$DSH_HOME/profiles/web/plugins/`；③ 合并 `profile-patches/web/cordis.patch.yml` 到 user-patch 层。安装后须重启 `dsh web`。

### 卸载

```sh
./install/uninstall.sh
```

## 环境变量

| 变量 | 用途 | 默认 |
|---|---|---|
| `DSH_HOME` | dsh 数据/配置根 | `$HOME/.dsh` |
| `AGINT_HOME` | AGINT workspace（dream/wiki/reviews/scenarios 落点） | `$HOME/projects/AGINT` |

## 与 dsh 的关系

- **AGINT 依赖 dsh**，不 fork、不修改 dsh 源码。
- 能力通过 dsh 的 **user-patch 层** 与 **agent-preset 层** 注入。
- dsh 主线升级后重跑 `install/uninstall.sh` 即可重装。

详细边界见 [Wiki 与 dsh 的关系](https://github.com/Anmulzhao/DSH-AGINT/wiki) 与 [`docs/dsh-integration.md`](./docs/dsh-integration.md)。

## 状态

- **v0.6.5**（2026-08-28）：Sprint 11 L2→L3 跃迁验证 = P6 整体收口。`agint-mount` 动态挂载编排插件（4 态状态机 + 三段式事务 + 健康探针 + L0 隔离）+ `agint-quality-static` 加 `l0-isolation` 规则组（6/6 smoke PASS）+ 8 e2e 全 PASS + 92/104 全量基线 3 次连跑稳定。19 个插件 + 3 个 preset + 1 个 patch + 4 个 skill + 3 个 prompt preset。
- **v0.6.4 / v0.6.3**（Sprint 10）：架构解耦与安全性能收口——`agint-quality-sandbox` 独立化 + `agint-quality-static` / `agint-abtest` 独立插件 + `agint-mutator` 三段式事务 + `EvolutionLogBuffer`。
- **v0.6.2**（Sprint 9）：种群管理器 `agint-population` 落地，三变体锦标赛。
- **v0.6.1 / v0.6.0**：变异构造器 `agint-mutator`（19/19 eval）+ 归因引擎 `agint-diagnosis`（6 类根因 + 反事实 70%）。
- **v0.5.1 / v0.5.0**：SDK ↔ D-QAF 流水线接通 + Prompt SDK 落地（PromptManifest FROZEN 契约）。
- **v0.4.0**：P4 收口——策略引擎 + 反和谐检测器 + 元评估委员会 + HARM 报告 + 端到端闭环 e2e。
- **v0.3.1 / v0.2 / v0.1.x**：沙箱 + 进化记忆 + 退化探测 → D-QAF contract + eval → 迁移 + Seam 层。

> **下一步**：v0.7.0 / Sprint 12 —— Event Bus（`agint-event-bus`）基础设施。插件数已达 19，突破 18 阈值；Sprint 11 遗留 8 项 TODO 也将在 Sprint 12 收口。

完整路线见 [路线图](https://github.com/Anmulzhao/DSH-AGINT/wiki/路线图)；详细变更见 [变更日志](https://github.com/Anmulzhao/DSH-AGINT/wiki/变更日志)；Sprint 11 哲学对齐 5 条 + 张力 5 条见 [`Sprint11-哲学对齐检查.md`](./AGINT.wiki/Sprint11-哲学对齐检查.md)。

## 许可

MIT
