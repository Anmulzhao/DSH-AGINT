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
| **plugin** | **27 个** Cordis 插件（13 基础：`memory / wiki / cron / dream / rules / metrics / evolve / tool-stats / evolution-memory / diagnosis / mutator / population / mount` + quality 子家族 7：`quality / quality-eval / quality-sandbox / quality-static / quality-report / quality-policy / quality-sdk` + `agint-abtest` + `agint-event-bus` + `agint-self-model`（Sprint 13 自我模型只读观察者）+ Sprint 14-16 新增 4：`agint-skill-autocreate`（技能自动创建，检测层 + 评估层 + 发布层 v0.3.2）+ `agint-curator`（技能策展/陈旧归档 + 智能策展）+ `agint-memory-provider`（可插拔记忆 Provider 架构，阶段 2 v0.2.0）+ `agint-curriculum`（自主课程生成器 v0.1.1 已挂载 prod）+ v0.8 新增 `agint-restart`（宿主重启编排 + 代码指纹 v0.8.1）；其中 `quality-policy` 嵌套于 `agint-quality/` 下不单列，故顶层 `plugins/agint-*` 目录计 26 个），提供 host Services | `plugins/agint-*/` |
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

- **v0.8.0 / v0.8.1 / Sprint 16 进行中**（2026-09-11）＝ **agint-restart 5 连续 patch 升格为框架发版**。本批包含 5 个 commit：`fix(agint-restart): v0.7.0`（恢复通知落盘待投）+ `fix: v0.7.1`（断环——注入文案退化为纯状态）+ `fix: v0.7.2`（去重——同一次 boot 只投一次恢复通知）+ `feat: v0.8.0`（代码指纹：lib/fingerprint.js + marker.codeFingerprint + status.codeStale + AGINT_RESTART_CODE_DIR 测试钩子）+ `fix: v0.8.1`（把代码指纹带进 restart_status 输出面；立 D:\DSH\_sync_plugin.mjs 守门脚本）。**v0.8.x 系列实际承载在 `agint-restart` 单插件的连续补丁**——升格为框架发版的理由：① 解决了「改完插件无法一眼确认跑着的是哪版代码」+「HMR 到底有没有重载」两个反复踩到的真相缺口；② 新增了「JSON.parse + YAML + sha256」三段式守门脚本（`_sync_plugin.mjs`），把过去 3 次因未转义直引号写坏 manifest + 校验与同步塞同一命令导致的静默污染闭环堵住；③ 是 DSH 宿主启动/重启编排的关键可靠性提升，对自进化闭环的"重启后是否真的在跑新代码"构成底层事实基础。验证：smoke 41/41 + detect.test 12/12 + pending-notice 8/8 + repo↔host 17/17 sha256 MATCH + L0-frozen 0 命中。**注**：v0.8.x 未触动 VERSION 表首行（仍为 v0.7.1），是因为仓库自 v0.6.3 起漏打 git tag、远端 tag 止于 `v0.6.5`——本批升格为框架发版**不带 tag**，与 v0.7.0 / v0.7.1 同策略（详见 `wiki/变更日志.md` 顶部 v0.8 节）。
- **v0.7.4 / Sprint 16**（2026-09-09）＝ **T2 A7 切换完成**。`agint-self-model` 从影子对账器切到 apply 模式（metricsSource 三态：apply 为权威路径 + 直连作对账与兜底）；同夜修两 T2 apply 才暴露的生产 bug（v0.7.3 漏 `metrics_ingest` 表热切换 + 直连源方法名错），首次运行时影子对账闭环 `compared=1 / matched=1 / consistencyRate=100%`，`bin/t2-reconcile.mjs` 判定 A7 PASS。同期：`skill-autocreate` 发布层 v0.3.2（`autocreate_stats` sprint=16-release-layer）+ `memory-provider` 阶段 2 v0.2.0（运行时降级 + pre_compress fail-closed + 4 新工具 + 4 新事件，重启后 6 秒即由 builtin provider 发布 `memory.provider-activated`）+ `curriculum` v0.1.1 提前挂载 prod。**仅仓库发版**（无 tag 策略延续）。门禁 a7-ingest 34/34 + smoke 19/19 + 主 driver 123/0/0 + memory-provider 88/88 + skill-autocreate 102/102。26 个插件（v0.7.4 加 `skill-autocreate`/`curator`/`memory-provider`/`curriculum` 4 个 P7.5 实战插件；v0.8.0 续加 `agint-restart` → 27）+ 3 个 preset + 1 个 patch + 5 个 skill + 3 个 prompt preset。
- **v0.7.1 / Sprint 13**（2026-09-03）＝ **P7 第二段（总线 T1 收口 + 自我模型启动）**。① 事件边 07/08/09 场景补录（`s12-07` traceId 一致 + payload 深冻结 + `syncSubscriptions` 指标；`s12-08` at-least-once + handler 异常隔离 + 周复盘两行；`s12-09` sync 配额硬拒 + 死信可查 + `deadletterRate`），sprint12 e2e 7 pass 0 fail。② 每周 ≤3 次自动部署护栏 `checkDeployBudget`（agint-quality-eval，滚动 7 天 `policy.AUTO_DEPLOY` 计数 >3 → PENDING_REVIEW + 审计 + 周复盘告警），接入 weekly hook + self-model weekly 更新。③ 全新只读观察者插件 `agint-self-model` v0.7.1（独占域 `agint_self_model` 4 表 + 5 Service + 能力图谱 CAN/CANNOT/UNCERTAIN + 推理画像 + 资源基线 + 校准误差护栏 ≤10% + cold-start 守门 + 影子订阅 A6/A8 + 发布 A11 `self.model.updated`）。④ `agint-quality-static` 加 `self-model-isolation` 规则组（v0.7.1，禁写 qualityPolicy/mutator/population + 域边界，6/6）。self-model smoke 19/19 + static 套件 62/62 + deploy-budget 11/11 全绿。**仅仓库发版**。26 个插件（v0.7.1 加 `agint-self-model`；Sprint 14-15 续加 `skill-autocreate` / `curator` / `memory-provider` / `curriculum`）+ 3 个 preset + 1 个 patch + 4 个 skill + 3 个 prompt preset。
- **v0.7.0 / Sprint 12**（2026-08-30）＝ **P7 第一段（总线化）**。通信架构解耦：新增 `agint-event-bus` 插件（FROZEN event-bus schema + 3 Service + 死信/隔离/退避/traceId + sync 配额）+ 流水线事件化 8 条边 A1–A8（T1 影子期 publish-only 不切流量）。Sprint 11 遗留 8 项 TODO 收口；A6/A7/A8/A9/A10 全部补齐（含指标导出 + 周复盘模板）。全量 99/111（12 存量 fail 未扩）+ 256+ 测试 PASS + L0-frozen 0 命中 + FROZEN 契约零改动。**仅仓库发版**。22 个插件（v0.7.0 加 `agint-event-bus`；v0.7.1 续加 self-model → 23，Sprint 14-15 续加 `skill-autocreate` / `curator` / `memory-provider` / `curriculum` → 26）+ 3 个 preset + 1 个 patch + 4 个 skill + 3 个 prompt preset。
- **v0.6.5**（2026-08-28）：Sprint 11 L2→L3 跃迁验证 = P6 整体收口。`agint-mount` 动态挂载编排插件（4 态状态机 + 三段式事务 + 健康探针 + L0 隔离）+ `agint-quality-static` 加 `l0-isolation` 规则组（6/6 smoke PASS）+ 8 e2e 全 PASS + 92/104 全量基线 3 次连跑稳定。19 个插件 + 3 个 preset + 1 个 patch + 4 个 skill + 3 个 prompt preset。
- **v0.6.4 / v0.6.3**（Sprint 10）：架构解耦与安全性能收口——`agint-quality-sandbox` 独立化 + `agint-quality-static` / `agint-abtest` 独立插件 + `agint-mutator` 三段式事务 + `EvolutionLogBuffer`。
- **v0.6.2**（Sprint 9）：种群管理器 `agint-population` 落地，三变体锦标赛。
- **v0.6.1 / v0.6.0**：变异构造器 `agint-mutator`（19/19 eval）+ 归因引擎 `agint-diagnosis`（6 类根因 + 反事实 70%）。
- **v0.5.1 / v0.5.0**：SDK ↔ D-QAF 流水线接通 + Prompt SDK 落地（PromptManifest FROZEN 契约）。
- **v0.4.0**：P4 收口——策略引擎 + 反和谐检测器 + 元评估委员会 + HARM 报告 + 端到端闭环 e2e。
- **v0.3.1 / v0.2 / v0.1.x**：沙箱 + 进化记忆 + 退化探测 → D-QAF contract + eval → 迁移 + Seam 层。

> **下一步**：Sprint 16 收口期（2026-09-06 ~ 09-19）— ① **09-13 两个首次自动任务核验**（02:00 策展 + 05:00 课程，等不干预）；② **A7 一致率观察**（v0.7.4 首轮 100%，随自动任务攒样本）；③ 后续边按条件触发：A1 等样本（INSUFFICIENT）→ A2 演练通过后最后切。详见 [路线图](https://github.com/Anmulzhao/DSH-AGINT/wiki/路线图) Sprint 16 + T2 切边清单。
>
> **已收口状态**：P0 ~ P6 全部 ✅ 收口。P6 = 进化闭环引擎（diagnosis v0.6.0 + mutator v0.6.1 + population v0.6.2 + 架构解耦 v0.6.3 + 性能/实验 v0.6.4 + L2→L3 跃迁 v0.6.5）；P7 第一段（事件总线 v0.7.0）✅ + P7 第二段（总线 T1 收口 + self-model v0.7.1）✅ + P7.5 Sprint 16 主线（skill-autocreate 检测层 + 评估层 + 发布层 + memory-provider 阶段 2 + curriculum 提前挂载）✅ 进行中。详见 [路线图](https://github.com/Anmulzhao/DSH-AGINT/wiki/路线图) 阶段总览表 + 「调整记录」段落。

完整路线见 [路线图](https://github.com/Anmulzhao/DSH-AGINT/wiki/路线图)；详细变更见 [变更日志](https://github.com/Anmulzhao/DSH-AGINT/wiki/变更日志)；Sprint 12 哲学对齐 5 条 + 张力仲裁表见 [`Sprint12-哲学对齐检查.md`](./AGINT.wiki/Sprint12-哲学对齐检查.md)。

> **挂载策略（v0.6.0 ~ v0.8.1 连续 10 个 minor，仓发布语义）**：v0.6.0 / v0.6.1 / v0.6.2 / v0.6.3 / v0.6.4 / v0.6.5 / v0.7.0 / v0.7.1 / v0.7.4 / v0.8.0 / v0.8.1 仓库发布时未自动同步顶层 `cordis.patch.yml`；本机 `install.sh` 已跑完故已挂载（host 端实测 27 个 `- id: agint-*` 全启用，见 AGENTS.md「本机实况」自动块 + `C:/Users/Administrator/.dsh/profiles/web/cordis.patch.yml`）。生产环境决策点 = 12 存量 eval fail 收口 ≥80%（实测主 driver 123/0/0 已收口）+ 总线 T2 切换（v0.7.4 已完成 A7 切换 + A8 确认，A1/A2 待触发）。

## 哲学对齐检查（v0.8.x）

按路线图 §哲学锚点护栏 + AGENTS.md 第 11 节（P 阶段验收 / 重大 PR 必含）：

- **真实 > 讨好**：v0.8.x 5 个连续 patch 本是 `agint-restart` 单插件的工作；本次升为框架发版**承认**这一现实（全部 5 commit 都是该插件的 fix/feat），不假装"它是框架级重大变更"。读者一眼看 git log 不会困惑。
- **靠谱 > 聪明**：v0.8.1 立 `_sync_plugin.mjs` 守门脚本 = 把「改完 manifest 必跑 JSON.parse + 全量测试 + sha256 对齐」从**自觉**升级为**机制**。过去 3 次未转义直引号写坏 manifest + 校验与同步塞同一命令的失败模式被闭环堵住，符合"靠谱"高于"灵活"。
- **简洁 > 冗余**：v0.8.0 加的 codeFingerprint 是 12 位 sha256 前缀（`sha256(文件名\0哈希\0序列)` 取前 12 位），恰好够 4096 个目录无碰撞且对人类可读，不堆更多位。
- **安全 > 效率**：codeStale 检测（HMR 静默失败 → 提示需重启）= 让"磁盘改过、进程仍是旧代码"这种静默失败被显式上报，符合 D-QAF 的"fail-closed > fail-open"。
- **主动 > 被动**：codeFingerprint + codeStale 把"要不要重启"从**靠日志时间戳推断**变**事实**——下次再问"我跑着的是哪版代码"，状态字段直接给答案，不用人翻日志。

## 许可

MIT
