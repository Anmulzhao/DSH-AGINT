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
| **plugin** | **23 个** Cordis 插件（13 基础：`memory / wiki / cron / dream / rules / metrics / evolve / tool-stats / evolution-memory / diagnosis / mutator / population / mount` + quality 子家族 7：`quality / quality-eval / quality-sandbox / quality-static / quality-report / quality-policy / quality-sdk` + `agint-abtest` + `agint-event-bus` + `agint-self-model`（Sprint 13 自我模型只读观察者）；其中 `quality-policy` 嵌套于 `agint-quality/` 下不单列，故顶层 `plugins/agint-*` 目录计 22 个），提供 host Services | `plugins/agint-*/` |
| **patch** | 把插件挂入 dsh profile 的 user-patch 层 | `profile-patches/web/cordis.patch.yml` |
| **data** | 记忆 / 规则 / 指标 / 提案 / 梦境 / 复盘 / 评估历史 | runtime 数据，**不**进仓库 |

> 插件清单与概念区分（skill vs plugin / preset / patch）见 [Wiki 插件目录](https://github.com/Anmulzhao/DSH-AGINT/wiki) 与 [Wiki 概念区分](https://github.com/Anmulzhao/DSH-AGINT/wiki)。

## 自进化宪法（速览）

AGINT 的核心是 **D-QAF 四阶段流水线**（静态准入 → 动态沙箱 → 集成演练 → 灰度发布）与 **HARM 四维指标**（Homogeneity / Alignment / Reduction / Mutability），并引入**进化记忆层**区分于任务记忆。完整论述见 [Wiki 自进化宪法 D-QAF 与 HARM](https://github.com/Anmulzhao/DSH-AGINT/wiki) 与 [`docs/evolution-framework.md`](./docs/evolution-framework.md)。

## 安装

### 前置

- Node.js ≥ 20
- `@deepseek-ai/dsh` ≥ 0.1.1-rc.2（v0.6.5 起；v0.6.0 ~ v0.6.4 兼容 0.1.0-rc.6，见 [`VERSION`](./VERSION) 兼容矩阵）
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

- **v0.7.1 / Sprint 13**（2026-09-03）＝ **P7 第二段（总线 T1 收口 + 自我模型启动）**。① 事件边 07/08/09 场景补录（`s12-07` traceId 一致 + payload 深冻结 + `syncSubscriptions` 指标；`s12-08` at-least-once + handler 异常隔离 + 周复盘两行；`s12-09` sync 配额硬拒 + 死信可查 + `deadletterRate`），sprint12 e2e 7 pass 0 fail。② 每周 ≤3 次自动部署护栏 `checkDeployBudget`（agint-quality-eval，滚动 7 天 `policy.AUTO_DEPLOY` 计数 >3 → PENDING_REVIEW + 审计 + 周复盘告警），接入 weekly hook + self-model weekly 更新。③ 全新只读观察者插件 `agint-self-model` v0.7.1（独占域 `agint_self_model` 4 表 + 5 Service + 能力图谱 CAN/CANNOT/UNCERTAIN + 推理画像 + 资源基线 + 校准误差护栏 ≤10% + cold-start 守门 + 影子订阅 A6/A8 + 发布 A11 `self.model.updated`）。④ `agint-quality-static` 加 `self-model-isolation` 规则组（v0.7.1，禁写 qualityPolicy/mutator/population + 域边界，6/6）。self-model smoke 19/19 + static 套件 62/62 + deploy-budget 11/11 全绿。**仅仓库发版**（T2 切换期不早于约 2026-09-25；12 存量 eval fail 收口 ≥80% 仍待 runtime 收口）。23 个插件（加 `agint-self-model`）+ 3 个 preset + 1 个 patch + 4 个 skill + 3 个 prompt preset。
- **v0.7.0 / Sprint 12**（2026-08-30）＝ **P7 第一段（总线化）**。通信架构解耦：新增 `agint-event-bus` 插件（FROZEN event-bus schema + 3 Service + 死信/隔离/退避/traceId + sync 配额）+ 流水线事件化 8 条边 A1–A8（T1 影子期 publish-only 不切流量）。Sprint 11 遗留 8 项 TODO 收口；A6/A7/A8/A9/A10 全部补齐（含指标导出 + 周复盘模板）。全量 99/111（12 存量 fail 未扩）+ 256+ 测试 PASS + L0-frozen 0 命中 + FROZEN 契约零改动。**仅仓库发版**（T2 切换期不早于约 2026-09-25）。22 个插件（加 `agint-event-bus`）+ 3 个 preset + 1 个 patch + 4 个 skill + 3 个 prompt preset。
- **v0.6.5**（2026-08-28）：Sprint 11 L2→L3 跃迁验证 = P6 整体收口。`agint-mount` 动态挂载编排插件（4 态状态机 + 三段式事务 + 健康探针 + L0 隔离）+ `agint-quality-static` 加 `l0-isolation` 规则组（6/6 smoke PASS）+ 8 e2e 全 PASS + 92/104 全量基线 3 次连跑稳定。19 个插件 + 3 个 preset + 1 个 patch + 4 个 skill + 3 个 prompt preset。
- **v0.6.4 / v0.6.3**（Sprint 10）：架构解耦与安全性能收口——`agint-quality-sandbox` 独立化 + `agint-quality-static` / `agint-abtest` 独立插件 + `agint-mutator` 三段式事务 + `EvolutionLogBuffer`。
- **v0.6.2**（Sprint 9）：种群管理器 `agint-population` 落地，三变体锦标赛。
- **v0.6.1 / v0.6.0**：变异构造器 `agint-mutator`（19/19 eval）+ 归因引擎 `agint-diagnosis`（6 类根因 + 反事实 70%）。
- **v0.5.1 / v0.5.0**：SDK ↔ D-QAF 流水线接通 + Prompt SDK 落地（PromptManifest FROZEN 契约）。
- **v0.4.0**：P4 收口——策略引擎 + 反和谐检测器 + 元评估委员会 + HARM 报告 + 端到端闭环 e2e。
- **v0.3.1 / v0.2 / v0.1.x**：沙箱 + 进化记忆 + 退化探测 → D-QAF contract + eval → 迁移 + Seam 层。

> **下一步**：v0.8.0 / Sprint 14 —— 自主课程生成器 `agint-curriculum`（基于 self-model 能力边界探测）+ 总线 T2 切流量（约 2026-09-25 稳定窗后，需死信率 < 0.5% + sync 配额未触顶 + ≥4 条事件边切流量验证 + 12 存量 fail 收口 ≥80%）。Sprint 13 已收口（T1 收口 + self-model），详见 [路线图](https://github.com/Anmulzhao/DSH-AGINT/wiki/路线图) Sprint 13 章节。
>
> **已收口状态**：P0 ~ P6 全部 ✅ 收口。P6 = 进化闭环引擎（diagnosis v0.6.0 + mutator v0.6.1 + population v0.6.2 + 架构解耦 v0.6.3 + 性能/实验 v0.6.4 + L2→L3 跃迁 v0.6.5）；P7 第一段（事件总线 v0.7.0）✅ + P7 第二段（总线 T1 收口 + self-model v0.7.1）✅；P7 后续 Sprint 14（curriculum）/ Sprint 15（transfer）/ Sprint 16+（社区化）+ T2 切换 待启动。详见 [路线图](https://github.com/Anmulzhao/DSH-AGINT/wiki/路线图) 阶段总览表 + 「调整记录」段落。

完整路线见 [路线图](https://github.com/Anmulzhao/DSH-AGINT/wiki/路线图)；详细变更见 [变更日志](https://github.com/Anmulzhao/DSH-AGINT/wiki/变更日志)；Sprint 12 哲学对齐 5 条 + 张力仲裁表见 [`Sprint12-哲学对齐检查.md`](./AGINT.wiki/Sprint12-哲学对齐检查.md)。

> **挂载策略（v0.6.0 ~ v0.7.1 连续 8 个 minor）**：v0.6.0 / v0.6.1 / v0.6.2 / v0.6.3 / v0.6.4 / v0.6.5 / v0.7.0 / v0.7.1 仅仓库发版，未挂载顶层 `cordis.patch.yml`。生产环境仍跑 v0.5.1 的 SDK + D-QAF 链路。Sprint 13+ 决策点 = 12 存量 eval fail 收口 ≥80% + 总线 T1 收口（已验证，待 T2 切换）。

## 许可

MIT
