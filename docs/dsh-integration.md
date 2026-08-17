# dsh 集成说明

> AGINT 怎么用 dsh、依赖了哪些 dsh 内部约定、dsh 升级时哪里会断。

## 我们用了 dsh 什么

### 1. user-patch 层

`profile-patches/web/cordis.patch.yml` 是一个标准的 dsh cordis patch —— 一组 `id-targeted` 配置覆盖 + `insert` 列表，被 dsh loader 在每个 bundle 之后应用。

这是 AGINT **唯一**与 dsh 深度耦合的接入点。

### 2. agent-preset 层

`presets/agint/agent.cordis.yml` 是一个 dsh agent preset —— 一个 `name: '@deepseek-ai/dsh-*'` 工具行的有序列表。

我们引用了 dsh 官方工具名：`@deepseek-ai/dsh-tool-bash` / `fs` / `fs-search` / `jobs` / `goal` / `web` / `ask-user` / `todo` / `skill` / `cordis` / `subagent-*` / `ralph` 等。

dsh 改名或弃用这些包名时，**AGINT 必须跟着改**。

### 3. Cordis 协议

8 个插件都是 Cordis Plugins，遵循：
- `apply(ctx)` 注入 Service
- `inject: ['service-name']` 声明硬依赖
- `ctx.effect()` / `ctx.on()` / `ctx.setTimeout()`（用 disposer 包副作用）

dsh loader 解析 plugin 文件（`./plugins/agint-memory/lib/index.js`），调用 `apply()`，并把 Service 注册到 host 容器。

### 4. Tool 注册

我们的 7 个 model-facing 工具（除 tool-stats 外）通过在 preset 里写 `id: agint-*-tools` + `name: ../../plugins/agint-*/lib/tools.js` 注册；该文件 `apply()` 把 `agint.*` Service 转写成 `Tool` 描述挂到 model 工具目录。

`agint-tool-stats` 的 `tool_stats_summary` 由插件自己直接注册（不走 preset），因为它没有对应的 agint preset 工具行需要它。

### 5. Storage 域

- `agint` → memory
- `agint_rules` → rules
- `agint_metrics` → metrics
- `agint_evolve` → evolve proposals

每个域独占一个 JSON 文件，由 dsh `storage` 服务管理读写锁。

### 6. cron tick

agint-cron 监听 dsh 内部的 tick 事件（通过 `@deepseek-ai/cordis-plugin-timer`），把内置 job 注册进去。

## 我们没碰 dsh 什么

- ✗ 没改 dsh 源码
- ✗ 没 fork dsh
- ✗ 没在 dsh 安装目录下加任何文件
- ✗ 没改官方 preset（`@deepseek-ai/dsh/config/agent-presets/{code,cordis,minimal,standard}`）
- ✗ 没绕过 dsh 的 sandbox / approval / 任何安全门

## 升级 dsh 时怎么测

```sh
# 1. 备份
cp -a ~/.dsh ~/.dsh.bak-$(date +%s)

# 2. 升级 dsh
npm install -g @deepseek-ai/dsh@latest

# 3. 跑 AGINT eval（v0.3 之后才有，目前手动）
dsh --profile headless "..."
# 看 8 个 plugin 是否都能 apply；preset 工具行是否都加载

# 4. 看 dsh CHANGELOG 里有没有 breaking change：
#    - loader patch 语法变了？
#    - tool name 改了？
#    - storage 域 API 改了？
#    - cron 事件名改了？
#    - waterfall 钩子名改了？
```

## 已知耦合点（dsh 0.1.0-rc.6）

- `tools/pre-execute` / `tools/post-execute` waterfall 名字
- `tools/result` 事件名
- `@deepseek-ai/dsh-tool-*` 包名
- preset 里 `name: '@deepseek-ai/dsh-tool-X'` 的解析规则
- `!!js` YAML 表达式的可用上下文

这些可能在 dsh rc7 / 1.0.0 时调整。