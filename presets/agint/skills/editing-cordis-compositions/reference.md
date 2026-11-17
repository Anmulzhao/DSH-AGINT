# editing-cordis-compositions 参考

SKILL.md 只留判据、步骤、禁令与清单；本文承接被下沉的细则：代码模板、YAML 模板、推导与背景。

## 一、禁改区：自带 preset 是什么

部署自带的 `agent-presets` 目录紧挨部署自身的配置，提供 `standard`、`code`、`minimal`、`cordis` 四个 preset：

- `standard`：完整编码 agent，是最常用的复制源。
- `code`、`minimal`：另外两种开箱配置。
- `cordis`： Cordis 本身的 preset。

改这里的三重风险：升级会覆盖整个安装，你写的行随之消失；损坏 `cordis` 会禁掉 preset 编制本身（`agent.cordis.yml` 是所有 preset 的格式）；即使当次没坏，跨机器复用时这个路径也只在别人的机器上存在。

正确姿势是「读自带组合」——它是了解本版本允许哪些行、哪些 key 的唯一可靠来源；错误姿势是「写自带组合」，以及「改 host 组合来绕开 preset 的限制」。后者会让本会话的特权与目标 preset 的特权混在一起，preset 的权限上限就不再等于它点名的插件。

## 二、`subagents` 为什么不能搬进 preset

`subagents` 是 worked example：它是一个被 agent 平面消费的 service，但它同时要跨会话回答 host api-proxy 的查询。

per-session 副本会同时坏两件事：

1. host 那一行永远等一个没人提供的 service——注册表在第二个会话里是空的，于是挂起；
2. provider 名只注册一次，第二个会话再挂就撞名。

所以 preset 贡献的是委派**工具**（`subagent`、`subagent_codex`、`subagent_claude_code` 等行），注册表与它的 spawn/fork 后端留在 host 侧。判断口径：**这个 service 有没有 agent 平面之外的消费者**。有，就不能 per-session。

## 三、preset 目录结构与展示元数据

```
<preset-root>/<preset-id>/
  agent.cordis.yml   # 组合本体
  preset.yml         # 可选：展示元数据
  skills/            # 可选：随 preset 携带的技能目录
```

`preset.yml` 承载：

- `name`：选择器里显示的名字；
- `description`：一句说明；
- `order`：名册顺序（自带 preset 才有）。

不写元数据的 preset 在每个选择器里只显示裸目录名，看起来像没装好。

自建 preset 的根是 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/`，每个 preset 一个子目录。部署可以配置别的根，所以实际路径要从 `list()` 或 `resolve()` 拿，不要猜。

## 四、名册服务：探针插件模板

`cordis_mount` 只返回挂载回执，服务回答送不回来。要把 `ctx.agentPresets` 装到自己手上，挂一个临时插件，注入 `agentPresets` 与 `tools`，并注册一个工具：

```js
return {
  name: 'preset-tools',
  inject: ['agentPresets', 'tools'],
  apply(ctx) {
    harness.registerTool(ctx, harness.defineTool({
      name: 'preset_check',
      description: 'Mount-validate one preset by id.',
      parameters: { id: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: v }] } },
      async execute(args) {
        try {
          await ctx.agentPresets.standingKeyFor(args.id)
          return 'mounted OK'
        } catch (error) {
          return error.message
        }
      },
    }))
  },
}
```

写码前先读 `cordis_inspect what:"api" name:"agentPresets"` 取当前签名。探针用完用 `cordis_unmount` 卸掉——它只用来问问题，不是交付能力。

## 五、编制一个 preset

### `copy()` 的语义

`copy(from, id, name)` 复制整个 preset 目录到用户根：组合、元数据、skill 目录、素材都复制。

- id 校验 `[a-z0-9][a-z0-9-]*`——id 会变成目录名，所以不能以连字符开头；
- 拒绝任何根已经提供的 id；
- 复制失败会回滚；
- 重写副本的 `preset.yml`：保留源的 description，丢掉源的 name 与 roster `order`。

它优于 shell 拷贝的三点：不需要升级沙箱；落在本部署设为可写的那个根里；副本与源一样可加载。`resolve(id)` 返回它实际创建的文件路径，后续编辑以那个路径为准。

### 沙箱升级流程

用户 preset 根在工作区之外。默认 `workspace-write` 策略下，第一次写那里会被拒；按绝对路径读任何组合不需要升级。

正确做法：把那条命令**原样**带 `sandbox_permissions` 升级重试一次，并附一句简短理由——用户会看到并批准。把多个文件合并成一次写（一个文件一次 heredoc），别为许多小命令反复升级。`copy()` 在 host 侧执行，不需要升级；升级只用于后续编辑。

## 六、realm 规则

### 自带 `standard` 的写法

`standard` 组合给 `workflows` 就是这么做的——它没有 agent 之外的读者，所以用一个 `delegation` group 加 `isolate` realm（委派工具行在此省略）：

```yaml
- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflows: true
  config:
    - id: workflow-worker-thread
      name: '@deepseek-ai/dsh-workflow-worker-thread'
      config:
        provider: spawn
    - id: tool-workflow
      name: '@deepseek-ai/dsh-tool-workflow'
```

### `isolate` 取值

- `true`：realm 对每个挂载会话私有。
- 字符串标签：把子树并进一个**共享** realm。但该符号下第二次 `provide()` 仍会抛错，所以标签不池化实例，也不是 preset 要的东西。

### 谁进 group

- 提供方（发布 service 的行）必须进 group。
- **所有能到达它的消费者**也必须进同一个 group。留在 group 外的消费者会去解析 host 的注册表，而 preset 没往里填东西，于是它什么都不贡献；挂载校验会把它报成一行从未激活。
- 只被 preset 消费的 host 能力必须留在 realm 外。`tool-bash`、`tool-jobs`、`tool-goal` 什么都不发布，在 `standard` 里散着，其注释说明每个解析到哪个 host 实例、为什么加 realm 会坏掉。把消费者行单独包进自己的 realm，与把它留在提供方 realm 外，是同一个错误。

## 七、验证：`standingKeyFor` 的四类失败

`standingKeyFor(id)` 真实组合该 preset 的插件子树——与会话启动做的同一挂载，只少 agent。

1. **包解析不了**：`Cannot find package …`
2. **config 非法**：`invalid config: $.<field> missing required value`
3. **从未激活**：`N row(s) did not activate: <id>: waiting for <service>`
4. **service 进了 root realm**，两种消息：
   - host 不提供的名字落进 root realm，挂载审计拒绝：`row(s) published process-global service(s) [<name>]; a preset service must sit behind an isolate realm or move to the host composition`
   - host 已提供的名字在审计之前就撞名：`service "<name>" has been registered at <Owner>`

两条都点名那个 service。

### 为什么 `broken` 不是验证

`list()` 报�� `broken` 来自形状检查——文件在加载器的 YAML 方言里能解析，且有具名行。上面四类失败**全部能过**这道检查。它抓的是损坏文件，不是不可用的组合。

### 为什么要放在最后跑

成功挂载会装一个 standing generation，活到进程退出；失败的挂载会销毁子树，不留任何东西。所以它是完工前的最后一道检查，不是每写一行就跑一次的探针。

## 八、原生产品 subagent 模板

从自带完整 preset 复制这两行，只为用户要的产品去掉 `disabled`：

```yaml
- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config:
    provider: codex
    toolName: subagent_codex
    enableRunInBackground: false
    maxDepth: provider-managed

- id: tool-subagent-claude-code
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config:
    provider: claude-code
    toolName: subagent_claude_code
    enableRunInBackground: false
    maxDepth: provider-managed
```

两行互相独立：全禁保持副本原样，启用一个只暴露该产品工具，都启用则两个都暴露。host 必须在 `PATH` 上提供 `codex` 或 `claude`；preset 不安装、不认证、不为它选模型、也不探测产品。

## 九、Tool schema ↔ host service 形状

写 `defineTool({ output: { schema } })` 行时，对应 service 方法实际返回的每个字段都必须在 `schema.properties` 里声明。

同一 host 方法有两条执行路径时（如 `rule_check` 带和不带 `tool`），它们返回**不同**形状——schema 要用 `oneOf` 覆盖两条路径，**或者**把 host 方法归一成一个形状（更推荐）。

`additionalProperties: false` 加上少于 host 返回的字段数时，`dsh-tools` 会在 execute 时拒绝，即使 `standingKeyFor` 干净挂载。这就是 K18 的「挂载校验 ≠ service 可用」。形状不能完全掌控的嵌套对象（例：另一个插件 service 调用的结果）默认用 `additionalProperties: true`。

字段集等价是判据：

```
schema declared fields  ==  service return fields (per execution path)
```

写一个 `verify-*.mjs` 脚本，跑真实 `runProfile` 启动，走遍每条路径，比对字段——任何不一致都当回归。
