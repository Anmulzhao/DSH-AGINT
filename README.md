# AGINT

> 基于 DeepSeek Harness (dsh) 的**自进化智能体框架**。

**Latest**：v0.8.1 · 27 个 Cordis 插件 · D-QAF v0.2 · HARM 四维

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

## 哲学对齐检查（v0.8.x）

按路线图 §哲学锚点护栏 + AGENTS.md 第 11 节（P 阶段验收 / 重大 PR 必含）：

- **真实 > 讨好**：v0.8.x 5 个连续 patch 本是 `agint-restart` 单插件的工作；本次升为框架发版**承认**这一现实（全部 5 commit 都是该插件的 fix/feat），不假装"它是框架级重大变更"。读者一眼看 git log 不会困惑。
- **靠谱 > 聪明**：v0.8.1 立 `_sync_plugin.mjs` 守门脚本 = 把「改完 manifest 必跑 JSON.parse + 全量测试 + sha256 对齐」从**自觉**升级为**机制**。过去 3 次未转义直引号写坏 manifest + 校验与同步塞同一命令的失败模式被闭环堵住，符合"靠谱"高于"灵活"。
- **简洁 > 冗余**：v0.8.0 加的 codeFingerprint 是 12 位 sha256 前缀（`sha256(文件名\0哈希\0序列)` 取前 12 位），恰好够 4096 个目录无碰撞且对人类可读，不堆更多位。
- **安全 > 效率**：codeStale 检测（HMR 静默失败 → 提示需重启）= 让"磁盘改过、进程仍是旧代码"这种静默失败被显式上报，符合 D-QAF 的"fail-closed > fail-open"。
- **主动 > 被动**：codeFingerprint + codeStale 把"要不要重启"从**靠日志时间戳推断**变**事实**——下次再问"我跑着的是哪版代码"，状态字段直接给答案，不用人翻日志。

## 许可

MIT
