---
name: editing-cordis-compositions
description: Use when creating, changing, or validating a Cordis composition for this harness — writing or editing an agent preset, adding or removing a plugin row, deciding whether something belongs to the host composition or to one session, checking whether a preset you authored actually mounts, or diagnosing a row that mounted but contributed nothing.
tools:
  - cordis_mount
  - cordis_unmount
  - agentPresets.list
  - agentPresets.read
  - agentPresets.copy
  - agentPresets.standingKeyFor
triggers:
  - "创建/修改/校验一个 agent preset"
  - "增删 plugin row、判断能力属于 host 还是 agent 平面"
  - "验证某 preset 是否真的挂载"
related_skills:
  - cordis-plugin-development
  - plugin-preflight

---

# 编辑 Cordis 组合

本 harness 的每项能力都是 `cordis.yml` 里的一行插件行。没有独立的配置语言：改 agent 能做什么，就是改它被组合了哪些行。

## 禁改区

**绝不编辑、删除或覆盖部署自带的 preset**——部署自身配置旁边的 `agent-presets` 目录，它提供 `standard`、`code`、`minimal`、`cordis`。不要升级沙箱去够它：升级会覆盖该安装，损坏 `cordis` 会禁掉 preset 编制本身。读自带组合是正确起点，写它不是，改 host 组合绕开 preset 限制也不是。

要改自带 preset 的行为，就复制一份改副本。用户根下自建的 preset 归你创建、编辑、删除。

## 先判平面

两个平面。判据不是「看起来有多 agent」，而是**这东西是不是必须被共享**。

**Host 组合**：注册表本身（`tools`、`systemPrompt`、`agents`、`agent-loop`、`sessions`）、跨会话的东西（持久化、会话查询、存储、设置、凭证、遥测）、沙箱与审批栈、模型路由、subagent 注册表与 spawn/fork 后端。进程内一份。

**Agent preset**：一个会话往注册表贡献的——工具插件、人格与 prompt 段、压缩策略。每会话一份，随会话作用域挂载卸载。

**有 agent 平面之外消费者的 service 不能搬进 preset。** 推导见同目录 reference.md。

preset 是一个目录，含一个 `agent.cordis.yml`，旁边可选 `preset.yml` 承载展示元数据 `name` 与 `description`（自带 preset 还带名册 `order`）。元数据也要写：没有它，选择器里只显示裸目录名。

自建 preset 位于 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/` 下每 preset 一个目录，自带集合在部署自身配置旁边。部署可配其它根，读写路径来自 `list()` 或 `resolve()`。

## 名册服务

`ctx.agentPresets` 负责发现、编制与挂载。拿到它：挂一个临时插件注入它并给自己注册一个工具——`cordis_mount` 只返回挂载回执，注册的工具才能把回答送回给你，并在你下一步变为可调。

写码前先读 `cordis_inspect what:"api" name:"agentPresets"` 取当前签名。本技能依赖：

- `list()`——每个 preset 及其 `id`、`trust`（自带 `system`，自建 `user`）、组合文件绝对 `path`；目录是该 path 父目录。
- `read(id)`——读一个 preset 的组合文本，不用文件工具也不用 path。
- `copy(from, id, name?)`——唯一的编制写操作。
- `standingKeyFor(id)`——挂载校验一个 preset。

用完用 `cordis_unmount` 卸掉；它是探针不是要留下的能力。探针模板见同目录 reference.md。

## 编制一个 preset

1. **从副本开始。** `copy(from, id, name)` 复制整个 preset 目录到用户根：组合、元数据、skill 目录、素材都复制。它按 `[a-z0-9][a-z0-9-]*` 校验 id（id 变成目录名，不能以连字符开头），拒绝任何根已提供的 id，失败会回滚，并重写副本 `preset.yml`：保留源描述、丢掉源 name 与名册 `order`。优先用它而不是 shell 拷贝：不用升级沙箱，落在本部署可写的根里，副本与源一样可加载。`resolve(id)` 给出它创建的文件路径，后续编辑目标是那个路径，不是猜的。`standard` 是完整编码 agent，通常作源。
2. **预期副本之后的每次编辑都会撞上文件沙箱。** 用户 preset 根在工作区之外，默认 `workspace-write` 策略下第一次写那里会被拒。只写操作：按绝对路径读任何组合不需要升级。把那条命令原样带 `sandbox_permissions` 升级重试一次并附简短理由，用户会看到并批准。批量写（每个文件一次 heredoc），别为许多小命令反复升级。`copy()` 在 host 侧跑不需要这些，编辑需要。
3. **写副本的 `description`** 到 `preset.yml`，以及没给 `copy()` 传 name 时的 `name`。
4. **逐行编辑 `agent.cordis.yml`**，守住平面规则与 realm 规则。
5. **挂载校验结果**，再交给用户开真实会话——两者都在「验证一个改动」一节。

从零写的组合通常会漏掉一个 group realm 或一个消费者行；副本一上来就可加载。

## 最容易踩的规则

**发布 service 的行不能散落在 preset 里。** 没有 isolate realm 就进了进程全局 realm，第二个会话挂载该 preset 就与第一个冲突。挂载会拒绝，不让冲突日后浮现。

某行是否发布 service 从名字看不出来，装的部署里也没有包 README。从活运行时读：`cordis_inspect what:"services"` 列出每个 service 及其所属 fiber；归属 fiber 不是你正在加的那行，说明它消费而非提供。不在当前组合里的行，去做挂载校验并读拒绝信息，它会点名那个 service。

preset 真拥有某个 service 时，把**提供方和所有能到达它的消费者**一起包进一个带 `isolate` realm 的 group。`true` 是每挂载会话私有的 realm；字符串标签把子树并进共享 realm，该符号下第二次 `provide()` 仍抛错，所以标签不池化实例，也不是 preset 要的。

留在 group 外的消费者去解析 host 注册表，而 preset 没往里填东西，于是什么都不贡献，挂载校验把它报成一行从未激活。

realm 只给 preset 拥有的 service，不是给每个 group。只被 preset 消费的 host 能力必须留在 realm 外，否则该行解析不到：`tool-bash`、`tool-jobs`、`tool-goal` 什么都不发布，在 `standard` 里散着。把消费者行单独包进自己的 realm，与把它留在提供方 realm 外是同一个错误。YAML 见同目录 reference.md。

## 验证一个改动

**`standingKeyFor(id)` 就是检查。** 它真实组合该 preset 的插件子树（与会话启动同一挂载，只少 agent），拒绝组合失败的四种方式：

- 包解析不了的行（`Cannot find package …`）；
- config 非法的行（`invalid config: $.<field> missing required value`）；
- 从未激活的行（`N row(s) did not activate: <id>: waiting for <service>`）；
- 发布进 root realm 的 service：`row(s) published process-global service(s) [<name>]; a preset service must sit behind an isolate realm or move to the host composition`；host 已提供的名字在审计前就冲突：`service "<name>" has been registered at <Owner>`。两条都点名那个 service。

组合能挂载时它正常返回。把它当完工编辑的最后一道检查，别每写一行就跑一次：成功挂载会装一个常驻 generation 活到进程退出，失败则销毁子树不留痕迹。

**不要把名册的 `broken` 字段当验证。** `list()` 的 `broken` 来自形状检查（文件在加载器的 YAML 方言里能解析且有具名行），上面每种失败都能过。它抓损坏文件，不抓不可用的组合。

`cordis_inspect` 报的是**本会话**的组合，只确认该行在当前运行时里做什么，不说明新 preset 会做什么。

干净通过挂载校验后，请用户在新 preset 上开一个会话并确认工具列表；preset 决定工具 schema 与 prompt 段，只有真实会话能显示该组合产出什么。

`cordis_mount` 对活运行时求值 JavaScript，重启即消失。它是探针不是交付能力：能力属于组合文件。

## 原生产品 subagent

Codex 与 Claude Code provider 已住在 host 组合里。preset 靠贡献与 spawn、fork 用的同一个普通委派工具行来选产品；绝不把产品 provider 搬进 preset，绝不加产品专属的设置字段。

从自带完整 preset 复制这些禁用模板，只为用户要的产品去掉 `disabled`（YAML 见同目录 reference.md）。两行互相独立：全禁=保持副本原样，启用一个=只暴露该产品工具，都启用=两个都暴露。host 必须在 `PATH` 上提供 `codex` 或 `claude`；preset 不安装、不认证、不选模型、不探测产品。

## 不要搬进 preset 的东西

`agent-loop` 注册唯一的 agent 工厂，第二个会抛错。注册表拥有 per-session 分层，本身不能 per-session。会话持久化必须留在 host 侧，否则会话列表会碎。沙箱、审批与权限行是刻意划的边界：preset 的权限上限就是它点名的插件，让它放松自己的禁闭就等于废掉禁闭。

## Tool schema ↔ host service 形状（K19, 2026-08-17）

`defineTool({ output: { schema } })` 的 `schema.properties` 必须声明对应 service 方法实际返回的每个字段。同一 host 方法有两条执行路径时（如 `rule_check` 带和不带 `tool`）返回**不同**形状：用 `oneOf` 覆盖两条路径，**或者**把 host 方法归一成一个形状（更推荐）。

`additionalProperties: false` 且声明字段少于 host 返回字段时，`dsh-tools` 在 execute 时拒绝，即使 `standingKeyFor` 干净挂载（K18 的「挂载校验 ≠ service 可用」）。形状不能完全掌控的嵌套对象默认 `additionalProperties: true`。

字段集等价是判据：`schema declared fields == service return fields（按执行路径逐条比）`。写 `verify-*.mjs` 跑真实 `runProfile` 启动，走遍每条路径比对字段，不一致即回归。

代码示例、YAML 模板与推导见同目录 reference.md，用 read 工具打开（本会话 skill 加载返回的 Base directory 即技能基目录）。
