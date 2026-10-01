# dsh 集成说明

> AGINT 怎么用 dsh、依赖了哪些 dsh 内部约定、dsh 升级时哪里会断。
>
> 安全边界、D-QAF 评估硬约束：详见 `docs/security-boundary.md` 和 `docs/evolution-framework.md`。

## 我们用了 dsh 什么

### 1. bundle 层（2026-09-24 起的主载体）

AGINT 整体就是一个 dsh **bundle**：仓库根 `package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`，
那 400 行的 `insert` 列表（31 个 host service 行 + 3 条 preset 声明行）就是它的挂载层。

部署位 `$DSH_HOME/.agint-bundle/`（实体），`$DSH_HOME/profiles/web/node_modules/@agint/host` 是指过去的一条软链。
profile 的 `package.json` 里**两处**都要有它：`dsh.profile.bundles` 列 `@agint/host`（dsh 靠它加载），
`dependencies` 里写 `"@agint/host": "link:<实体目录>"`（让 pnpm 认领这条软链）。

> ⛔ **只写 `dsh.profile.bundles`、不写 `dependencies` = 定时自毁**（2026-10-01 修）。
> `dsh.profile.bundles` 只决定「dsh 要不要加载」，**不让 pnpm 知道这个包存在**；
> 而 `plugin_manager` 每次装/卸 bundle 都会在 profile 目录跑一次 `pnpm add|remove`，
> pnpm 会把清单里没有的包从 `node_modules` 剪掉。症状：某次热插拔之后，
> **37 个插件和 4 条 preset 一起从 host 上消失，host 一声不吭**（本机在给 AGINT
> 装 kill-switch / twin preset 之后首次实机验收时才发现 bundle 早就没了）。
> v0.8.2 的 VERSION 记录写的「不写 dependencies 也能挂，已实测」是**错的**——
> 当时确实挂上了，但没测过「挂上之后再装别的包」这一步。
> `install.sh` 3.5 步现在同时写 `bundles` 与 `dependencies`，3.6 步建软链。

**⛔ 两条路径基准不一样，这是最容易翻车的地方（K83）**：

| 写在哪儿 | 相对谁解析 | 结论 |
|---|---|---|
| `insert:` 行里的 `name:` | **本 patch 文件所在目录** = bundle 包根 | `./plugins/agint-x/lib/index.js` 一行不用改 ✓ |
| **任何 `config` 值**（含 `cordis:include` 的 `path`） | **profile 根**（`profiles/web/`） | 只能写 profile 根相对路径 |

依据：app-boot `anchorInsertedPluginNames()` 只把 insert 行的 `name:` 锚定到本 patch 所在目录，
而 `config` 值一律字面量（`new URL(config.path, ctx.baseUrl)`）。把 include 的 path 写成
`./presets/…` 会让 preset 解析失败，症状是**新建会话整体失败**：
`agent-preset/invalid: <id> (cordis:include): config file not found`。

### 1b. user-patch 层（已不写 AGINT 段）

`$DSH_HOME/profiles/web/cordis.patch.yml` 现在只保留**本机本地覆盖**（dsh-tui 接管块等）。

0.1.7 起 profile 级 patch 优先级**高于** bundle 层 —— 两边都写同一批 id = 重复挂载，
所以 AGINT 的挂载行全部搬进 bundle 层；`install.sh` 会在装前检测该文件是否残留 `agint-*` 段并 fail-closed。

**⛔ 仓库内的 `profile-patches/web/cordis.patch.yml` 是历史副本，别再改它当挂载源**：
`install.sh` 已**不再把它写入** profile 级 patch，但仍会**读**它作为 `uninstall.sh` 的挂载 id 清单源
（`PATCH_SRC=`，缺失直接 `die`）。**改挂载行只改仓库根那份 `cordis.patch.yml`**，动副本是白动。

### 2. agent-preset 层

`presets/agint/agent.cordis.yml` 是一个 dsh agent preset —— 一个 `name: '@deepseek-ai/dsh-*'` 工具行的有序列表。

我们引用了 dsh 官方工具名：`@deepseek-ai/dsh-tool-bash` / `fs` / `fs-search` / `jobs` / `goal` / `web` / `ask-user` / `todo` / `skill` / `cordis` / `subagent-*` / `ralph` 等。

dsh 改名或弃用这些包名时，**AGINT 必须跟着改**。

### 3. Cordis 协议

9 个插件都是 Cordis Plugins，遵循：
- `apply(ctx)` 注入 Service
- `inject: ['service-name']` 声明硬依赖
- `ctx.effect()` / `ctx.on()` / `ctx.setTimeout()`（用 disposer 包副作用）

dsh loader 解析 plugin 文件（`./plugins/agint-memory/lib/index.js`），调用 `apply()`，并把 Service 注册到 host 容器。

### 4. Tool 注册

我们的 7 个 model-facing 工具（除 tool-stats 外）通过在 preset 里写 `id: agint-*-tools` + `name: ../../plugins/agint-*/lib/tools.js` 注册；该文件 `apply()` 把 `agint.*` Service 转写成 `Tool` 描述挂到 model 工具目录。

`agint-tool-stats` 的 `tool_stats_summary` 由插件自己直接注册（不走 preset），因为它没有对应的 agint preset 工具行需要它。

### 5. Storage 域

| 域 | 用途 | 互斥关系 |
|---|---|---|
| `agint` | memory | 与 `agint_rules` 互斥 |
| `agint_rules` | rules | 与 `agint` 互斥 |
| `agint_metrics` | metrics | 与 `agint` / `agint_rules` 互斥 |
| `agint_evolve` | evolve proposals | 与 `agint` / `agint_metrics` 互斥 |
| `agint_evolution`（v0.3 引入） | 进化记忆层 | 与全部其他域互斥 |

每个域独占一个 JSON 文件，由 dsh `storage` 服务管理读写锁。

### 6. cron tick

agint-cron 监听 dsh 内部的 tick 事件（通过 `@deepseek-ai/cordis-plugin-timer`），把内置 job 注册进去。

## 我们没碰 dsh 什么

- ✗ 没改 dsh 源码
- ✗ 没 fork dsh
- ✗ 没在 dsh 安装目录下加任何文件
- ✗ 没改官方 preset（`@deepseek-ai/dsh/config/agent-presets/{code,cordis,minimal,standard}`）
- ✗ 没绕过 dsh 的 sandbox / approval / 任何安全门

## D-QAF 安全边界（与 dsh 集成侧）

`docs/security-boundary.md` 给出完整硬约束清单。下表只列**与 dsh 集成相关的部分**——AGINT 自身的安全红线由 dsh 的 `sandbox_permissions` 机制兜底：

| 约束 | dsh 侧能力 | AGINT 落地 |
|---|---|---|
| 沙盒执行 bwrap / Landlock / Seatbelt | dsh 选其一 | `agint-quality-sandbox` 复用 |
| `tools/pre-execute` waterfall 拦截 | dsh 暴露 | `agint-rules` 监听 + `agint-quality-contract` 同名规则 |
| 持久化域互斥 | dsh storage 域机制 | 5 个 storage 域严格互斥 |
| Approval prompt（人类否决权） | dsh 询问机制 | `agint-quality-contract` L0 变更触发 |
| `dsh_restart` 用户主动重启 | dsh 工具 | `agint-quality-policy` 变更后触发 |

**关键不变量**：
- `agint-quality-eval` 不评估自己（递归陷阱由 dsh 进程边界兜底）
- `agint-quality-contract` L0 字段变更 → 人类否决权 + 不能单独部署（必须发 major 版本）
- 任何 plugin 修改 `agint_quality` 相关代码 → 触发 `agint-rules` 中 `bash-edit-quality-core` 规则（deny）

## 安装：`install.sh` 实际做什么

前置：Node.js ≥ 20 · `@deepseek-ai/dsh` ≥ 0.1.7-rc.1（矩阵见 `VERSION`）· dsh 已初始化（`dsh web` 跑过至少一次）。

```sh
git clone https://github.com/Anmulzhao/DSH-AGINT.git ~/projects/AGINT
cd ~/projects/AGINT
./install/install.sh
```

实际步骤（照脚本段号，README 早期版本列的 ①–⑧ 已与此漂移）：

| 段 | 做什么 | 备注 |
|---|---|---|
| 0.5 | 建中央备份目录 | `$DSH_HOME/.agint-backups/`，保留 10 份 |
| 1 | 铺 preset → `.agent-presets/` | |
| 1.1 | **preset 依赖解析入口** | dsh ≥ 0.1.7 必需，见下 |
| 1.2 | **bundle 内解析入口** | bundle 形态必需，见下 |
| 1.5 | zod bootstrap | ⛔ 必须在 plugin 同步**之前** |
| 2 | 安装 plugins（`profiles/web/plugins` 兼容位） | 少数按老路径定位的代码用 |
| 2.5 | 镜像插件 → bundle 部署位 | bundle 形态的**主挂载源** |
| 3 | 同步 bundle 挂载层（patch + 清单 + 解析入口） | 仓库根本 `cordis.patch.yml` |
| 3.5 | **注册 bundle 到 `dsh.profile.bundles`** | ⛔ 见下，漏了 = 装完像没装 |
| 4 | 装后静态校验 | |
| 4.5 / 4.55 | zod / zstd bootstrap 兜底 | 覆盖手动 rsync 场景 |
| 4.6 | 回写 `AGENTS.md` 本机实况块 | |
| 4.7 | 防御性补装 `dsh-workflow-worker-thread` | |

幂等可回滚：`trap EXIT` 跟踪部分安装，任一 step 失败即 reverse 回滚；`--dry-run` 只打印不落盘；
`agint-security-checks.sh` 任一 fail 即中止。

> ⛔ **第 3.5 步不能省**：少了它，bundle 目录在、patch 在，但 dsh **根本不加载它** ——
> 现象是「装完像没装」，**且零报错**。`uninstall.sh` 会对称地把它摘掉，所以卸载后重装也不会漏。

装完须**重启 `dsh web`**（bundle 层与 profile 层都不热更新）；启动 stderr 不该出现
`skipping profile bundle "@agint/host"`。

卸载：`./install/uninstall.sh` —— 摘 bundle 本体 + 从 `dsh.profile.bundles` 摘名 + 清插件，支持从备份列表回滚。
⛔ 包内 `node_modules` junction **必须保留**：`rm -rf` 会跟进链接目标，把 dsh 自身那 266 个官方包一起删掉。

### dsh 0.1.7 的两个坑

**坑一：preset 不再被扫目录发现。** 0.1.7 起 dsh **不扫** `.agent-presets/`（包名也从复数 `dsh-agent-presets`
变单数 `dsh-agent-preset`）。只铺目录 = preset 永远不出现在列表里，**且不报错**。AGINT 改为在 patch 里显式声明
三条 preset，用 `cordis:include` 指回 `.agent-presets/<id>/agent.cordis.yml` —— 定义保持单份，相对路径继续正确。
⛔ 别给 include 那行加 `group: true`（它的语义是「子插件行放在 `config` 数组里」，不是 carrier 标记），
加错会让整条 preset 抛 `must hold a list of plugin rows`，UI 只显示「加载失败」。

**坑二：依赖解析入口（1.1 / 1.2 两步）。** `cordis:include` 会把子条目的 `baseUrl` 挪到 `.agent-presets/<id>/`，
preset 里的裸包名（`@deepseek-ai/dsh-persona` / `dsh-tool-fs` …）都从那儿向上解析 —— 那儿没有 `node_modules`
⇒ 官方插件行全部 `never started` ⇒ 注册表判 broken ⇒ **UI 只说「加载失败」，且不落日志**。
`install.sh` 因此建两个 junction 指向 dsh 自带的 `node_modules`（266 个包）：
`.agent-presets/node_modules`（preset 侧）与 `.agint-bundle/node_modules/@deepseek-ai`（bundle 侧，
经 `node_modules/@agint/host` 软链同样可达）。
⛔ 两处都不能被同步删掉：preset 子目录会被 `rsync --delete` 镜像清空，bundle 同步必须 `--exclude=node_modules`。

### 排障三板斧

1. `dsh --profile web --dump-config` —— 官方工具，不挂载、零风险。正确结果：exit 0、无 stderr、三条 preset 声明都在。
2. 上一步全绿但 UI 仍失败 ⇒ 基本是 `never started`，检查两个解析入口（1.1 / 1.2）是否存在。
3. ⚠ preset 激活错误**只打 stdout 不落日志** —— 必须 `dsh --profile web > boot.log 2>&1` 才看得到。

### ⛔ 别拿 `profiles/<p>/cordis.yml` 当生效组合读（2026-10-01 实测）

同一版本 dsh 0.2.0-rc.2，那个文件出现过**两种形态**：

| 启动方式 | `profiles/web/cordis.yml` |
|---|---|
| `dsh web --profile web` | 物化后的树，**238 行** |
| `dsh web`（`agint-restart` 拉起，不带 `--profile`） | **4 行空根**：`# dsh profile root — an empty entry list. The tree is composed as patches` + `[]` |

⇒ 它的形态**取决于启动方式**，不是稳定的生效组合来源。任何拿它当基线的脚本都会
在某种启动方式下**读到空、然后静默跳过那条基线还照样报绿**。

**权威来源只有 `dsh --profile <p> --dump-config`**（本机实测：1579 行，
`preset-cordis` 在第 1108 行，递归展开 33 条能力行）。`bin/check-preset-parity.mjs`
已按「先试 cordis.yml 拿不到就回退 dump-config，两者都拿不到判红」实现。
通用化的教训见技能 `check-soundness`。

**活体验收**（比静态检查硬）：`Config.listConfigs` 报 `total`（本机 238）、
`Service.listService` 目录（91 个 key）都能直接问活着的宿主。新装的 cron job
在重启后自己跑了一次（19 → 20 个 job）就是最硬的证据。

### 技能落点（升级时什么会丢）

| 技能来源 | 落点 | 升级/重装后 |
|---|---|---|
| preset 自带（`presets/agint*/skills/`） | 随 preset 同步 | 以仓库为准（镜像覆盖） |
| **AGINT 自动生成的技能** | `$DSH_HOME/skills/`（用户级） | ✅ **保留**，不会被清空 |

三个消费者都读这个根：`agint-skill-autocreate.skills_root` · `agint-curator.skills_dir` ·
`agint-skill-graph.extraSkillDirs`。改投放目标必须三处一起改，否则图谱/策展会看不到新技能。

## 升级 dsh 时怎么测

**首选静态门禁**（秒级，不需要启动 dsh）：

```sh
node bin/check-dsh-compat.mjs          # 退出码 0=通过 1=有问题 2=环境不满足
node bin/check-dsh-compat.mjs --json   # 升级前后各存一份，diff 出新增问题
```

它把下面流程里「机械可判定」的部分自动化了：悬挂包名 / peer 兼容性预演 / 版本漂移 / 改名残留。
**语义判断**（某个 breaking 对 AGINT 意味着什么）脚本做不了，仍需人读上游 diff。

完整流程：

```sh
# 1. 备份
cp -a ~/.dsh ~/.dsh.bak-$(date +%s)

# 2. 升级 dsh —— ⛔ 必须带精确版本号；@latest 可能低于在跑的版本导致静默降级
npm install -g @deepseek-ai/dsh@<精确版本>

# 3. 静态门禁
node bin/check-dsh-compat.mjs

# 4. 真机冒烟
dsh --profile headless "..."
dsh --dump-config        # 期望零警告
# 口径：全部 plugin 都能 apply；preset 工具行都 started；
#       entry 真加载数 / patch 挂载 import 成功数 / preset 对账 DIFF=0 / 生产 storages 零污染

# 5. 跑 D-QAF 最小场景集
node eval/scenarios/run-minimal.mjs
# 期望：通过率 ≥ 90%

# 6. 看 dsh CHANGELOG / 上游提交里有没有 breaking change：
#    - loader patch 语法变了？
#    - tool name 改了？
#    - storage 域 API 改了？
#    - cron 事件名改了？
#    - waterfall 钩子名改了？
#    - sandbox 沙箱机制改了？
```

## 已知耦合点（dsh 0.1.0-rc.6）

- `tools/pre-execute` / `tools/post-execute` waterfall 名字
- `tools/result` 事件名
- `@deepseek-ai/dsh-tool-*` 包名
- preset 里 `name: '@deepseek-ai/dsh-tool-X'` 的解析规则
- `!!js` YAML 表达式的可用上下文
- 沙箱机制（bwrap / Landlock / Seatbelt）的可用性

这些可能在 dsh rc7 / 1.0.0 时调整。
