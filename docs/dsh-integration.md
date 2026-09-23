# dsh 集成说明

> AGINT 怎么用 dsh、依赖了哪些 dsh 内部约定、dsh 升级时哪里会断。
>
> 安全边界、D-QAF 评估硬约束：详见 `docs/security-boundary.md` 和 `docs/evolution-framework.md`。

## 我们用了 dsh 什么

### 1. bundle 层（2026-09-24 起的主载体）

AGINT 整体就是一个 dsh **bundle**：仓库根 `package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`，
那 400 行的 `insert` 列表（31 个 host service 行 + 3 条 preset 声明行）就是它的挂载层。

部署位 `$DSH_HOME/profiles/web/node_modules/@agint/host/`，profile 的 `dsh.profile.bundles` 里列 `@agint/host`。

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
