<div align="center">
  <img src="docs/assets/brand/png/agint-logo-512.png" width="300" alt="AGINT">
</div>

# AGINT

> 基于 DeepSeek Harness (dsh) 的**自进化智能体框架**。

**Latest**：v0.8.1 · **32 个 Cordis 插件** · 24 个 preset 工具行 · 14 个 cron job · D-QAF v0.2 · HARM 四维

AGINT = **AGI INTelligence**。把 dsh 当 runtime，在它之上构建一套「持续自进化」的能力：长期记忆、定时反思、规则门禁、进化指标、周复盘、梦境整合、**D-QAF 质量评估**，以及 P7.5 的**自进化执行层**（技能自动创建 / 策展 / 学习图谱 / 轨迹记录 / 记忆压缩守卫）。

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

完整论述见 Wiki [PHILOSOPHY](https://github.com/Anmulzhao/DSH-AGINT/wiki/PHILOSOPHY)（原仓内 `PHILOSOPHY.md` 已于 2026-09-17 迁入 Wiki）；工程化检查项见 [`docs/evolution-philosophy-checkpoints.md`](./docs/evolution-philosophy-checkpoints.md)。

## 不是什么

- 不是 dsh 的 fork。dsh 是上游 runtime，AGINT 是 dsh 之上的规范 + 组件。
- 不是 AGI 实现。它是**通往 AGI 的工程化骨架**：记忆、反思、约束、度量、迭代、评估。
- 不追求大而全。遵循「简洁 > 冗余」：新增功能必须经 D-QAF 评估，并在现有插件化架构内实现。

## 是什么

| 层 | 内容 | 来源 |
|---|---|---|
| **preset** | 智进人格 + 工具集（含 AGINT 专属 skills）。3 套：`agint`（主线）、`agint-blockchain`、`agint-investor` | `presets/agint*/` |
| **plugin** | **32 个** Cordis 插件（另有 2 个嵌套在 `agint-quality/` 内不单列：`quality-contract` / `quality-policy`），提供 host Services | `plugins/agint-*/` |
| **patch** | 把插件挂入 dsh profile 的 user-patch 层 | `profile-patches/web/cordis.patch.yml` |
| **data** | 记忆 / 规则 / 指标 / 提案 / 梦境 / 复盘 / 评估历史 | runtime 数据，**不**进仓库 |

> 插件清单与概念区分（skill vs plugin / preset / patch）见 [Wiki 插件目录](https://github.com/Anmulzhao/DSH-AGINT/wiki) 与 [Wiki 概念区分](https://github.com/Anmulzhao/DSH-AGINT/wiki)。

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

AGINT 的核心是 **D-QAF 四阶段流水线**（静态准入 → 动态沙箱 → 集成演练 → 灰度发布）与 **HARM 四维指标**（Homogeneity / Alignment / Reduction / Mutability），并引入**进化记忆层**区分于任务记忆。完整论述见 [Wiki 自进化宪法 D-QAF 与 HARM](https://github.com/Anmulzhao/DSH-AGINT/wiki) 与 [`docs/evolution-framework.md`](./docs/evolution-framework.md)。

自 2026-09-18 起另立一条根本原则：**默认自动化，人工审批只作兜底**。门禁尽量下放为可自动验证的规则（计数 / 阈值 / 白名单），新机制一律带 kill-switch —— 但 **kill-switch ≠ 默认关**：新能力出厂即开，配齐「默认开 + 降级回落 + 审计出口 + 一键可关」四件套。

## 安装

### 前置

- Node.js ≥ 20
- `@deepseek-ai/dsh` ≥ 0.1.1-rc.2（兼容矩阵见 [`VERSION`](./VERSION)；本机实测 **0.1.7-rc.1**）
  - dsh 0.1.5-rc.1 起 preset persona 字段由 `text` 改为 `prefix`，`presets/agint/` 已适配
  - ⚠ **dsh ≥ 0.1.7**：preset 不再靠「扫目录」发现，必须声明式注册（AGINT 已适配，见下「preset 怎么被找到」）；
    低于 0.1.7 时三条 preset 不可见，**插件层不受影响**
- dsh 已初始化（`dsh web` 至少跑过一次）

### 装到本机

```sh
git clone https://github.com/Anmulzhao/DSH-AGINT.git ~/projects/AGINT
cd ~/projects/AGINT
./install/install.sh
```

`install.sh`（v0.2 安全左移版）按序执行：① 跑 `agint-security-checks.sh` 前置检查，任一 fail 即中止；② 复制 `presets/agint*/` 到 `$DSH_HOME/.agent-presets/`；③ **建 preset 依赖解析入口**（步骤 1.1，dsh ≥ 0.1.7 必需，见下）；④ 复制 `plugins/agint-*/` 到 `$DSH_HOME/profiles/web/plugins/`；⑤ 合并 `profile-patches/web/cordis.patch.yml` 到 user-patch 层；⑥ 装后静态校验（YAML 解析 / package.json / preset cordis.yml）。

幂等且可回滚：写前备份到 `$DSH_HOME/.agint-backups/`（保留最近 10 份），`trap EXIT` 跟踪部分安装状态，失败自动还原。`--dry-run` 只打印改动、不落盘。

安装后须重启 `dsh web`。

### 卸载

```sh
./install/uninstall.sh
```

`uninstall.sh` 支持从备份列表选一份回滚。

### preset 怎么被找到（dsh ≥ 0.1.7）

0.1.7 是个**破坏性变更**：dsh **不再扫** `$DSH_HOME/.agent-presets/` 目录来发现 preset（包名也从复数
`dsh-agent-presets` 变成单数 `dsh-agent-preset`）。只把目录铺好 = preset 永远不出现在列表里，**且不报错**。

AGINT 的做法：在 `profile-patches/web/cordis.patch.yml` 里显式声明三条 preset，用 `cordis:include` 指回
`.agent-presets/<id>/agent.cordis.yml` —— 定义保持单份，里面的相对路径（插件 / skills）继续正确。

```yaml
- id: agint-preset
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: agint
    name: 智进
    plugins:
      - id: agint-composition
        name: 'cordis:include'
        config:
          path: ../../.agent-presets/agint/agent.cordis.yml
```

⛔ 别给 include 那行加 `group: true`：它的语义是「子插件行放在 `config` 数组里」，不是「我是 carrier」。
carrier 身份来自插件类自己的 `static [EntryGroup.key]`。加错会让整条 preset 抛
`must hold a list of plugin rows`，而 UI 只显示「加载失败」。

### 依赖解析入口（步骤 1.1 在解决什么）

`include` 会把子条目的 `baseUrl` 挪到 `.agent-presets/<id>/`，于是 preset 里的裸包名
（`@deepseek-ai/dsh-persona` / `dsh-tool-fs` …）都从那个目录向上解析 —— 那儿没有 `node_modules` ⇒
官方插件行全部 `never started` ⇒ 注册表判 broken ⇒ **UI 只说「加载失败」**。

`install.sh` 步骤 1.1 在 presets **父目录**建 `$DSH_HOME/.agent-presets/node_modules`，指向 dsh 自带的
`node_modules`（276 个包）。⛔ 不能放进 `.agent-presets/<id>/` 里面：preset 同步是
`rsync -a --no-links --delete` 语义，下次重装会把它删掉，症状静默复活。

### 技能落点（升级时什么会丢、什么不会）

| 技能来源 | 落点 | 升级/重装后 |
|---|---|---|
| preset 自带（`presets/agint*/skills/`） | 随 preset 同步 | 以仓库为准（镜像覆盖） |
| **AGINT 自动生成的技能** | `$DSH_HOME/skills/`（用户级） | ✅ **保留**，不会被清空 |

三个消费者都读这个根：`agint-skill-autocreate.skills_root` · `agint-curator.skills_dir` ·
`agint-skill-graph.extraSkillDirs`。改投放目标时必须三处一起改，否则图谱/策展会看不到新技能。

### 排障：preset 显示「加载失败」

1. `dsh --profile web --dump-config` —— 官方工具，**不挂载、零风险**。正确结果：exit 0、无 stderr、三条声明都在。
2. 若上一步全绿但 UI 仍失败：真凶通常是 `never started`（依赖解析不到）⇒ 检查
   `$DSH_HOME/.agent-presets/node_modules` 是否存在。
3. ⚠ preset 激活错误**只打 stdout，不落日志**（`$DSH_HOME` 下没有日志文件）⇒ 必须把 dsh 启动输出
   重定向到文件才看得到：`dsh --profile web > boot.log 2>&1`。

## 环境变量

| 变量 | 用途 | 默认 |
|---|---|---|
| `DSH_HOME` | dsh 数据/配置根 | `$HOME/.dsh` |
| `AGINT_HOME` | AGINT workspace（dream/wiki/reviews/scenarios 落点） | `$HOME/projects/AGINT` |

## 运行现状（本机实测）

| 指标 | 值 |
|---|---|
| host 挂载插件 | 33（32 个 AGINT 插件 + 1 个本机临时挂载件） |
| preset tool rows | 24 |
| preset skills | 7 |
| cron job | 14（日任务：梦境整合 / 指标采集 / 工具统计回填 / 记忆衰减 / 技能自动创建三班；周任务：复盘 / 策展 / 课程 / 图谱 / wiki 巡检 / 基线回归） |
| 存储域 | 每个插件独占 `agint_*` 域，跨域写入由静态规则组 `self-model-isolation` / `l0-isolation` 拦截 |

> 数字随部署变化。权威实况见 [`AGENTS.md`](./AGENTS.md) 文末的自动生成块（由 `bin/agents-local-state.mjs` 探测回写）。

## 与 dsh 的关系

- **AGINT 依赖 dsh**，不 fork、不修改 dsh 源码。
- 能力通过 dsh 的 **user-patch 层** 与 **agent-preset 层** 注入。
- dsh 主线升级后重跑 `install/uninstall.sh` 即可重装。

详细边界见 [Wiki 与 dsh 的关系](https://github.com/Anmulzhao/DSH-AGINT/wiki/与dsh的关系) 与 [`docs/dsh-integration.md`](./docs/dsh-integration.md)。

## 哲学对齐检查

按路线图 §哲学锚点护栏 + AGENTS.md 第 11 节（P 阶段验收 / 重大 PR 必含）：

**v0.8.x — agint-restart 与「提示真相」**

- **真实 > 讨好**：v0.8.x 5 个连续 patch 本是 `agint-restart` 单插件的工作；本次升为框架发版**承认**这一现实，不假装"它是框架级重大变更"。读者一眼看 git log 不会困惑。
- **靠谱 > 聪明**：v0.8.1 立 `_sync_plugin.mjs` 守门脚本 = 把「改完 manifest 必跑 JSON.parse + 全量测试 + sha256 对齐」从**自觉**升级为**机制**。过去 3 次未转义直引号写坏 manifest + 校验与同步塞同一命令的失败模式被闭环堵住。
- **简洁 > 冗余**：codeFingerprint 是 12 位 sha256 前缀（`sha256(文件名\0哈希\0序列)`），恰好够 4096 个目录无碰撞且对人可读，不堆更多位。
- **安全 > 效率**：`codeStale`（HMR 静默失败 → 提示需重启）= 让"磁盘改过、进程仍是旧代码"这种静默失败被显式上报，符合 D-QAF 的 fail-closed > fail-open。
- **主动 > 被动**：codeFingerprint + codeStale 把"要不要重启"从**靠日志时间戳推断**变**事实**。

**v0.8.1 — dsh 0.1.7 适配与「技能资产归谁」**

- **真实 > 讨好**：UI 只说「加载失败」，没有因为 `--dump-config` 全绿就宣布修好 —— 用隔离环境把 23 条
  `never started` 挖出来、A/B 确证因果后才动手。
- **靠谱 > 聪明**：依赖解析入口写进 `install.sh`（幂等、失败只 warn），不是手工建一次了事；且刻意**不放**
  preset 子目录 —— 那里会被 `--delete` 镜像掉，症状会静默复活。
- **简洁 > 冗余**：preset 定义依然只有一份（`cordis:include` 复用），没有为绕开 baseUrl 而把百余行内联进 patch。
- **安全 > 效率**：自动生成技能移出 preset 目录 = 升级不再清空用户资产；改投放目标时先确认三处消费者，
  避免「改了一处、另两处看不到」的半边失效。

**Sprint 17–19 — 自进化执行层与「默认自动化」**

- **默认自动化 > 人工审批**：`skill-autocreate` 0.5.0 按 09-18 立的原则**出厂即开**（LLM 走 primary + on），LLM 失败自动回落规则轨道，kill-switch 常在 —— 不是"先默认关，等审批再开"。
- **可观测 > 可审批**：`dream` v0.3.2 加零命中健康度告警（连续 N 次扫不到会话 → degraded）；被拦截的对象仍入库计数，避免"分不清是没有，还是被拦了"。
- **靠谱 > 聪明**：`agint-cron` 加 tick 串行化 + 重入守卫 + 停滞看门狗，补跑批次不再乱序 —— 定时是底座，宁可慢不可乱。
- **真实 > 讨好**：`dream` consolidation 状态诚实化（0 过门就报 0，不加"抢救通道"让数字好看）；`trajectory` / `skill-graph` 一律先走 `count-only` 标定期，未标定就切 live 直接抛错。
- **简洁 > 冗余**：`session-extract` 抽成**中立纯函数模块**由 dream 与 autocreate 共享，而不是各自实现一份会话解析。

## 许可

MIT
