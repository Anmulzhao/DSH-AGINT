<div align="center">
  <img src="docs/assets/brand/png/agint-logo-512.png" width="300" alt="AGINT">
</div>

# AGINT

> 基于 DeepSeek Harness (dsh) 的**自进化智能体框架**。

**Latest**：v0.8.4 · **32 个 Cordis 插件** · 24 个 preset 工具行 · 14 个 cron job · D-QAF v0.2 · HARM 四维

AGINT = **AGI INTelligence**。把 dsh 当 runtime，在它之上构建一套「持续自进化」的能力：长期记忆、定时反思、规则门禁、进化指标、周复盘、梦境整合、**D-QAF 质量评估**，以及 P7.5 的**自进化执行层**（技能自动创建 / 策展 / 学习图谱 / 轨迹记录 / 记忆压缩守卫）。

📚 **文档**：本 README 是入口 · 深文档见 [**GitHub Wiki**](https://github.com/Anmulzhao/DSH-AGINT/wiki) · 契约/规范见 `docs/` · 路线见 [路线图](https://github.com/Anmulzhao/DSH-AGINT/wiki/路线图) · 变更见 [变更日志](https://github.com/Anmulzhao/DSH-AGINT/wiki/变更日志)

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
| **plugin** | **32 个** Cordis 插件（另有 2 个嵌套在 `agint-quality/` 内不单列：`quality-contract` / `quality-policy`），提供 host Services | `plugins/agint-*/` |
| **data** | 记忆 / 规则 / 指标 / 提案 / 梦境 / 复盘 / 评估历史 | runtime 数据，**不**进仓库 |

## 插件全景（32）

| 分组 | 插件 |
|---|---|
| **记忆与知识**（4） | `memory`（L1–L4 分层遗忘）· `wiki`（知识库，与任务记忆分离）· `memory-provider`（可插拔 Provider + 降级/检查点）· `search-tools`（跨域统一搜索：记忆 + wiki） |
| **调度与治理**（4） | `cron`（定时任务）· `rules`（advisory / ask / deny 三级门禁）· `metrics`（进化指标时序）· `tool-stats`（工具使用画像） |
| **反思与进化**（5） | `dream`（夜间梦境整合 light→REM→deep）· `evolve`（周复盘）· `evolution-memory`（进化记忆层，区别于任务记忆）· `diagnosis`（6 类根因归因）· `curriculum`（自主课程生成器） |
| **D-QAF 质量层**（6 + 2 嵌套） | `quality`（聚合入口）· `quality-sdk`（Prompt SDK）· `quality-static`（静态准入，6 族 checker）· `quality-sandbox`（动态沙箱）· `quality-eval`（7 维评分）· `quality-report`（HARM 报告）· 嵌套：`quality-contract`（L0 FROZEN 契约）· `quality-policy`（策略引擎） |
| **进化闭环引擎**（4） | `mutator`（变异构造）· `population`（种群管理）· `abtest`（A/B 检验）· `mount`（三段式挂载事务） |
| **自进化执行层**（5，P7.5） | `skill-autocreate`（技能自动创建：检测 → 评估 → 发布三道门）· `curator`（技能策展 / 陈旧归档）· `skill-graph`（技能关系图谱）· `trajectory`（进化轨迹 / 训练数据层）· `compress-guard`（记忆压缩检查点守卫） |
| **观测与基础设施**（4） | `self-model`（自我模型，只读观察者）· `event-bus`（事件总线）· `restart`（重启编排 + 代码指纹）· `session-extract`（中立会话提取器） |

## 自进化宪法（速览）

**D-QAF 四阶段流水线**（静态准入 → 动态沙箱 → 集成演练 → 灰度发布）+ **HARM 四维指标**（Homogeneity / Alignment / Reduction / Mutability）+ **进化记忆层**（区别于任务记忆），完整论述见 [`docs/evolution-framework.md`](./docs/evolution-framework.md)。

自 2026-09-18 起的根本原则：**默认自动化，人工审批只作兜底** —— 门禁尽量下放为可自动验证的规则，新机制一律带 kill-switch，但 **kill-switch ≠ 默认关**：出厂即开，配齐「默认开 + 降级回落 + 审计出口 + 一键可关」。

## 交付形态：一个 dsh bundle（v0.8.2 起）

v0.8.2 前是 `install.sh` 手抄 `plugins/` + 手改 profile 级 patch，**完全绕过 dsh 插件体系**，依赖解析全靠环境凑。现在 AGINT 整体就是一个 bundle：仓库根 `package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`（**仓库本身就是包**），部署到 `$DSH_HOME/profiles/web/node_modules/@agint/host/`，由 profile 的 `dsh.profile.bundles` 列出。**不写 `dependencies` 也能挂**（已实测）。

三条坑，都很安静：

- ⛔ **路径基准不对称**：insert 行的 `name:` 锚 patch 文件所在目录（所以包内 `./plugins/…` 一行不改），但 **`config` 值恒字面量、一律按 profile 根解析** ⇒ `cordis:include` 的 `path` 仍须写 `../../.agent-presets/<id>/agent.cordis.yml`。写成 `./presets/…` 的症状是**新建会话整体失败**（`agent-preset/invalid: … config file not found`）。
- ⛔ **两侧不能都写**：0.1.7 起 profile 级 patch 优先级高于 bundle 层，两边都写 = 同一批 id 重复挂载。AGINT 已从 profile 级撤出，`install.sh` 有 fail-closed 残留检测兜底。
- ⛔ **改 patch 只改仓库根那份**：`profile-patches/web/cordis.patch.yml` 是迁移前的历史副本，`install.sh` 已不再读它（待清理，避免两份分叉）。

## 安装

前置：Node.js ≥ 20 · `@deepseek-ai/dsh` ≥ 0.1.7-rc.1（矩阵见 [`VERSION`](./VERSION)，本机实测 **0.1.7-rc.1**）· dsh 已初始化（`dsh web` 跑过至少一次）。

```sh
git clone https://github.com/Anmulzhao/DSH-AGINT.git ~/projects/AGINT
cd ~/projects/AGINT
./install/install.sh
```

`install.sh` 按序：① 跑 `agint-security-checks.sh`，任一 fail 即中止；② 铺 preset → `$DSH_HOME/.agent-presets/`；③ 建两个依赖解析入口（见下）；④ zod bootstrap；⑤ 镜像插件 → bundle 部署位（同时留 `profiles/web/plugins` 兼容位，供少数按老路径定位的代码用）；⑥ **整份复制**挂载层（`cordis.patch.yml` + `package.json`）；⑦ **注册 bundle**：把 `@agint/host` 追加进 `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles`（幂等：已注册只打印跳过、不重写文件；清单不存在则 warn 并给出手工补救）；⑧ 装后静态校验。幂等可回滚：备份到 `$DSH_HOME/.agint-backups/`（保留 10 份），`trap EXIT` 跟踪部分安装、失败自动还原；`--dry-run` 只打印不落盘。

> ⛔ 第 ⑦ 步不能省：少了它，bundle 目录在、patch 在，但 dsh **根本不加载它** —— 现象是「装完像没装」，**且零报错**。`uninstall.sh` 会对称地把它摘掉，所以卸载后重装也不会漏。

装完须重启 `dsh web`（bundle 层与 profile 层都不热更新）；启动 stderr 不该出现 `skipping profile bundle "@agint/host"`。

卸载：`./install/uninstall.sh` —— 摘 bundle 本体 + 从 `dsh.profile.bundles` 摘名 + 清插件，支持从备份列表回滚。⛔ 包内 `node_modules` junction **必须保留**：`rm -rf` 会跟进链接目标，把 dsh 自身那 266 个官方包一起删掉。

### dsh 0.1.7 的两个坑

**preset 不再被扫目录发现**：0.1.7 起 dsh **不扫** `.agent-presets/`（包名也从复数 `dsh-agent-presets` 变单数 `dsh-agent-preset`）。只铺目录 = preset 永远不出现在列表里，**且不报错**。AGINT 改为在 patch 里显式声明三条 preset，用 `cordis:include` 指回 `.agent-presets/<id>/agent.cordis.yml` —— 定义保持单份，相对路径继续正确。⛔ 别给 include 那行加 `group: true`（它的语义是「子插件行放在 `config` 数组里」，不是 carrier 标记），加错会让整条 preset 抛 `must hold a list of plugin rows`，UI 只显示「加载失败」。

**依赖解析入口**：`cordis:include` 会把子条目的 `baseUrl` 挪到 `.agent-presets/<id>/`，preset 里的裸包名（`@deepseek-ai/dsh-persona` / `dsh-tool-fs` …）都从那儿向上解析 —— 那儿没有 `node_modules` ⇒ 官方插件行全部 `never started` ⇒ 注册表判 broken ⇒ **UI 只说「加载失败」，且不落日志**。`install.sh` 因此建两个 junction 指向 dsh 自带的 `node_modules`（266 个包）：`.agent-presets/node_modules`（preset 侧）与 `node_modules/@agint/host/node_modules/@deepseek-ai`（bundle 侧）。⛔ 两处都不能被同步删掉：preset 子目录会被 `rsync --delete` 镜像清空，bundle 同步必须 `--exclude=node_modules`。

**排障**：① `dsh --profile web --dump-config` —— 官方工具，不挂载、零风险，正确结果是 exit 0、无 stderr、三条声明都在。② 上一步全绿但 UI 仍失败 ⇒ 基本是 `never started`，检查两个解析入口是否存在。③ ⚠ preset 激活错误**只打 stdout 不落日志**，必须 `dsh --profile web > boot.log 2>&1` 才看得到。

### 技能落点（升级时什么会丢）

| 技能来源 | 落点 | 升级/重装后 |
|---|---|---|
| preset 自带（`presets/agint*/skills/`） | 随 preset 同步 | 以仓库为准（镜像覆盖） |
| **AGINT 自动生成的技能** | `$DSH_HOME/skills/`（用户级） | ✅ **保留**，不会被清空 |

三个消费者都读这个根：`agint-skill-autocreate.skills_root` · `agint-curator.skills_dir` · `agint-skill-graph.extraSkillDirs`。改投放目标必须三处一起改，否则图谱/策展会看不到新技能。

## 仓库自检

| 命令 | 查什么 |
|---|---|
| `node bin/check-dsh-compat.mjs` | dsh 兼容性四查：悬挂包名 / peer 兼容性预演 / 版本漂移 / 改名残留。`--json` 给 CI，`--strict` 让 info 也算失败 |
| `node bin/check-wiring.mjs` | 接线完整性：空壳服务（注册了没人用）/ 孤儿主题 / 与生产数据对账 —— 「挂载了」≠「通电了」 |
| `node bin/check-tool-schemas.mjs` | tool schema 两套方言真编译一遍（写错会让整条 preset 起不来） |

⛔ `npm install -g @deepseek-ai/dsh@latest` 会**静默降级** —— `latest` 可能低于在跑的版本（2026-09-24 实测 `latest`=0.1.5-rc.3，本机在跑 0.1.7-rc.1）。**必须带精确版本号**。

## 环境变量

| 变量 | 用途 | 默认 |
|---|---|---|
| `DSH_HOME` | dsh 数据/配置根 | `$HOME/.dsh` |
| `AGINT_HOME` | AGINT workspace（dream/wiki/reviews/scenarios 落点） | `$HOME/projects/AGINT` |

## 运行现状（本机实测）

**32 个 Cordis 插件 · 24 个 preset 工具行 · 14 个 cron job · 7 个 preset skills。** 数字随部署变化，权威实况见 [`AGENTS.md`](./AGENTS.md) 文末的 LOCAL-STATE 自动块（由 `bin/agents-local-state.mjs` 探测回写）。

## 与 dsh 的关系

AGINT 依赖 dsh，不 fork、不修改 dsh 源码；能力通过 **bundle 层**（`dsh.profile.bundles`）与 **agent-preset 层** 注入。dsh 升级后：`node bin/check-dsh-compat.mjs` → 重跑 `install/install.sh`。详细边界见 [`docs/dsh-integration.md`](./docs/dsh-integration.md) 与 Wiki 与 dsh 的关系。

## 哲学对齐检查（v0.8.4）

- **真实 > 讨好**：wiki 上「A7 一致率 100% PASS」躺了 12 天，实读生产才看清那是 **09-12 的孤本、对账早已停摆**（`batches:0 / compared:0`，事件侧照常在发）。**指标没在动 ≠ 指标在通过** —— 也顺带纠偏了「演练 14/14 过」不能当 A2 放行依据（它只验降级，没验决策回传）。
- **靠谱 > 聪明**：A1 放宽门禁**只放宽样本量，不放宽正确率**（`PASS_WEAK` 要求窗口内 100% 全覆盖），且给排除名单配了 `--no-exclude-known` 关闭开关 —— 能随时看未排除的原始数。**没有开关的排除名单就是后门。**
- **简洁 > 冗余**：A7 修法选「订阅侧空闲超时收批」而不是「让发布端在末条打 index/total 标记」—— 单边可收批，不用动两边，发布端以后怎么改都不影响。
- **安全 > 效率**：A2 **决议不切**（耦合豁免）。sync 超时降级是 `PENDING_REVIEW`，用在通知场景是保守，用在门禁决策上会 **fail-closed 反噬** —— 总线一抖，所有部署全部卡住。不为「形式上统一走事件」去换一个更糟的故障模式。

历史版本（v0.7.x–v0.8.3）的检查记录见 git 历史与 Wiki [变更日志](https://github.com/Anmulzhao/DSH-AGINT/wiki/变更日志)。

## 许可

MIT
