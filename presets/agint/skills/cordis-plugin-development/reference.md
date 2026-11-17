# cordis-plugin-development 参考

SKILL.md 只留判据、步骤、禁令与清单；本文承接被下沉的细则：代码示例、错误示例、查询方法详解、Client UI 细则、背景推导。

示例里的 Service 名、Slot 名、props 均为占位示例。真实名字必须来自 `cordis_inspect_list` / `cordis_inspect_query` 的当次查询结果。

## 一、执行环境：注册 React UI

正确：

```js
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('tool.view.cordis', () => slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      () => React.createElement('div', null, 'Hello'),
    ))
  },
}
```

错误（JSX）：

```jsx
return {
  apply(ctx) {
    return <div>Hello</div>
  },
}
```

JSX 不是这个例子里唯一的问题。`apply()` 注册生命周期贡献，不能把 React Element 当插件结果返回。UI 必须注册到查过的 Slot。

`code.host` 与 `code.client` 都是返回 Cordis 插件的纯 JavaScript 函数体，不由 TypeScript、JSX 或打包器编译。禁止使用 `import`、`require`、TypeScript 类型、`as`、装饰器、JSX；禁止使用 `Builtin.listBuiltins` 未确认的全局量；禁止猜测访问 `window`、`document`、`process`、`Buffer`、`fetch` 或原生定时器。Client React 代码必须用 `React.createElement(...)`。

## 二、访问 Service

默认写法，处理缺失：

```js
return {
  apply(ctx) {
    const service = ctx.get('serviceName')
    if (service === undefined) return
    service.someMethod()
  },
}
```

硬依赖才声明 `inject`：

```js
return {
  inject: ['requiredService'],
  apply(ctx) {
    ctx.requiredService.someMethod()
  },
}
```

不要为了省掉一次 `undefined` 判断就滥用 `inject`。没有声明注入就访问 `ctx.requiredService`，Guard 会拒绝未声明依赖。

## 三、管理副作用

```js
return {
  apply(ctx) {
    const service = ctx.get('serviceName')
    if (service === undefined) return
    ctx.effect(() => service.subscribe((value) => {
      console.log(value)
    }))
  },
}
```

`ctx.effect()` 持有返回 disposer 的外部订阅。`subscribe()` 不返回 disposer 时，先查该 Service 是否提供受支持的清理机制；不要假设卸载会自动移除任意第三方回调。

## 四、Host 与 Client 定时器

一次性延时：

```js
return {
  inject: ['timer'],
  apply(ctx) {
    const onClick = () => {
      ctx.timeout(() => console.log('done'), 300)
    }
    // Pass onClick to a queried Slot UI.
  },
}
```

React 组件里的周期任务：

```js
return {
  inject: ['timer'],
  apply(ctx) {
    function Clock() {
      React.useEffect(() => ctx.interval(() => console.log('tick'), 1000), [])
      return React.createElement('div', null, 'Running')
    }
    // Register Clock in a queried Slot.
  },
}
```

两个错误示例：

```js
return {
  apply(ctx) {
    ctx.timeout(() => console.log('invalid'), 300)
  },
}
```

```js
setTimeout(() => console.log('invalid'), 300)
```

第一个没有声明定时器硬依赖。第二个用了不存在的全局定时器。

两个平台上的定时器都是名为 `timer` 的 Service，接口相同，它不是 Builtin。用之前先用对应平台的 `Service.listService` 查 `{ "service": "timer" }`，并声明 `inject: ['timer']`。

## 五、监听 Event

普通 emit Event：

```js
return {
  apply(ctx) {
    ctx.on('some/event', (payload) => {
      console.log(payload)
    })
  },
}
```

Waterfall Event 的最后一个参数是 `next`。除非监听器有意停止下游处理，否则必须调用并返回它：

```js
return {
  apply(ctx) {
    ctx.on('some/waterfall', (payload, next) => {
      console.log(payload)
      return next()
    })
  },
}
```

先查 Event Provider 确认平台、参数顺序、返回值与 `mode`。

## 六、Slot 注册

```js
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('target.slot', () => slots.register(
      { name: 'target.slot', id: 'my-view' },
      (props) => React.createElement('div', null, String(props.someValue)),
    ))
  },
}
```

未声明注入时这样写是错的：

```js
return {
  apply(ctx) {
    ctx.slots.register({ name: 'target.slot' }, () => null)
  },
}
```

`ctx.get('slots')` 不需要注入。不要在查 Slot 协议之前猜 `id`、`key`、选择器或 props。不要默认使用根级 `root`、`sidebar`、`conversation`、`details` Slot——替换整个占用者会连带删除它声明的子 Slot。

先不带 `root` 查 `Slots.listSubTree`，从紧凑的用途与拓扑树里选目标；再用精确 `root` 查一次。查询结果决定：Slot 在布局中的用途；注册协议是 `single`、`list`、`keyed` 还是 `chain`；注册选项；scope 标准 props 与业务 owner props；当前占用者、替换风险与子 Slot。

## 七、Client 调 Host（Client→Host JSON RPC）

Host：

```js
return {
  apply(ctx) {
    harness.handle('read-state', async (args) => {
      return { value: args.key }
    })
  },
}
```

Client：

```js
return {
  async apply(ctx) {
    const result = await host.call('read-state', { key: 'demo' })
    console.log(result.value)
  },
}
```

参数与返回值必须是无损 JSON。不要传函数、React 元素、类实例、Context、Service 或其他运行时对象；没有响应数据时返回 `null`。不要注册公共 Remote Service，也不要用 `ctx.remote` 做 Package 私有通信。

## 八、Provider 导航：两遍查询法

方法名、Provider 名与入参必须来自当前 `cordis_inspect_list` 结果。Service/Event Catalog 描述本版本允许哪些接口，不保证某个 Service 当前已挂载；运行时要用真实 Service 与 Event，不要缓存或展示 Catalog 查询结果。

- `Service.listService`：不带 `service` 时返回每个可调 Service 的用途与准确方法签名。带上 `service` 再查一次，取访问规则、结构化的方法说明/参数/返回值，以及它引用的类型。
- `Event.listEvents`：不带 `event` 时返回每个 Event 的用途、dispatch mode 与准确的监听器签名。带上 `event` 再查一次，取结构化监听契约与它引用的类型；Waterfall 监听器必须调用 `next()`。
- `Builtin.listBuiltins`：返回评估器提供的符号与签名，这些取不到 `ctx.get()`。
- `Slots.listSubTree`：不带 `root` 时返回紧凑的活树，含每个 Slot 的用途、kind、scope、注册键、替换风险与子节点。带精确 `root` 再查一次，会额外返回该 Slot 的完整契约、props 与当前占用者，子节点保持紧凑。
- `Theme.listTokens`：返回当前可查询、可覆盖的主题 token；它不修改主题。
- `Tool.listTools`：返回当前 Agent 实际可见的 Tool schema，包含动态注册的 Tool。

## 九、选平面：取舍原则

| 需求 | 优先平面 | 先查 |
| --- | --- | --- |
| 文件、命令、进程或网络 | Host | `fs`、`bash`、`subprocess`、`pty`、`web`（`Service.listService`） |
| Agent、持久 Session 数据或 Host 生命周期 | Host | 相关 Service 与 `Event.listEvents` |
| 注册下一步模型可调的动态 Tool | Host | `Builtin.listBuiltins` 的 `harness`，加 `Tool.listTools` |
| 页面主题、布局或当前页面状态 | Client | `Theme.listTokens` 与 Client `Service.listService` |
| Conversation Snapshot 或 session/workspace 列表 | Client | 目标 Slot 的标准 props 与 owner props |
| 设置页、侧边栏、输入区、覆盖层或 Tool 卡片 | Client | `Slots.listSubTree` |
| Host 取数并在 Client 展示 | 两侧 | Host Service 加 `harness.handle`；Client Slot 加 `host.call` |

选最贴近数据拥有者的能力。如果 Slot props 已经提供 Conversation Snapshot，就不要再通过 Host 取一次。如果只需要改 Package 自身的样式，就不要覆盖全局主题。如果只需要一个小入口，就不要替换整个产品 UI 区域。

## 十、Client UI 细则

### 设置页

完整的设置 UI 通常应通过 `settings.section` 注册自己的分区，以获得完整的内容区。`settings.general.item` 只适合一个紧凑的、通用型偏好项。两者都要先查真实的子树、选项与 props，再选仍然够用但最窄的入口。

动态插件是临时的、进程内的，所以它的设置 UI 不需要持久存储。不要为它加持久设置或另一套持久化机制。把 UI 注册到合适的设置 Slot，任何瞬时交互状态留在内存里，随插件生命周期结束。

### 会话与页面数据

会话级 Slot 可能通过标准 props 提供 `useSession`、`useSessions`、`useWorkspaces`、`useProjection`、输入状态或动作。按查询结果走，优先直接用 owner props 或标准 props；不要为已经存在的数据再加一层 Host RPC。

只选 UI 真正需要的字段。不要复制或渲染整个 Conversation Snapshot、Session、Tool 调用或 Slot props 对象。

### Cordis Run 专用面板

要把交互 UI 放进最近的 `cordis_run` 卡片，注册 `tool.view.cordis` 并带 `key: 'self'`：

```js
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('tool.view.cordis', () => slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      (props) => React.createElement('div', null, `Package ${props.packageId}`),
    ))
  },
}
```

运行时 `self` 绑定到 `pluginId + packageId`。不要把 `pluginRunId` 放进 key。同一 Package 多次运行时，最新的 Run 卡片承载 UI，旧卡片自动降级。

当功能需要用户交互并绑定到本 Package 的结果时，这个区域很合适，因为它把控件留在对话流里、紧挨着 Run 卡片。但它不是所有 Client UI 的默认目标：设置、侧边栏、消息动作、覆盖层在更贴合功能时，应该用各自查过的 Slot。

### 普通 Tool 卡片

要定制普通模型 Tool 的调用卡片，查 `tool.call.toolview`。它的 key 是 Tool 名；注册一个已存在的 key 可能替换产品的默认卡片。只定制新增的 Tool 时，先用 `Tool.listTools` 核验它的 schema，再查完整的 `ToolCallOwnerProps`。

### 覆盖层与局部入口

- 吐司、状态提示与整屏覆盖层：先查 `shell.overlay`，观察它的 pointer-events 与层序规则。
- 选定的目标是全局覆盖层 Slot 时，先决定 UI 是否可拖、用户如何显示与隐藏它，以及它必须盖住或保持在哪些已有层之下。
- 小型侧边栏动作：优先用加法式的内层 Slot，例如 `sidebar.footer.action`；不要替换整个侧边栏。
- 对话轮次之后的补充内容：查 `conversation.chat.turnTail`，按它返回的 chain 选择器与 fallback 规则注册。

## 十一、主题与样式

先定改动范围：

1. 全局主题：先查 `Theme.listTokens`，再通过 Client `Service.listService` 查 `{ "service": "theme" }`。按查询要求为每项覆盖提供浅色与深色值，并保留返回的 disposer。
2. Package 自身的组件：用 `styles.insert(css)`，颜色优先用主题 CSS 变量。
3. 新的可见内容：先选 Slot，再决定用局部 CSS 还是全局 token。

不要操作 `document.body`、`window` 或硬编码的产品 DOM 选择器。主题 Service 改 token 但不造 UI；Slot 造 UI 但不替换主题系统。

## 十二、版本、审批与修复

- 插件是稳定实例，由 `pluginId` 标识。
- Package 是不可变的代码版本，由 `packageId` 标识。
- 每次激活尝试都有自己的 `pluginRunId`。
- `currentPackageId` 是最新成功版本；它不意味着插件当前正在运行。
- `nextPackageId` 是等待审批、正在激活、等待 Client 激活或最近失败的目标。

`cordis_run` 的 mode 选择：

| 当前状态 | 目标 | mode |
| --- | --- | --- |
| 没有 current | 该插件下任意 Package | `run` |
| 有 current | 同一个 Package | `run` |
| 有 current | 另一个 Package | `update` |
| update 失败 | `nextPackageId` | 用 `update` 重试 |
| update 失败 | `currentPackageId` | 用 `run` 回滚 |

未授权的 Client Package 返回 `awaiting-approval`。单个勾只授权当前 Package；双勾授权同一插件的未来版本。技术性运行时失败之后授权仍然保留。已授权的 Package 返回 `starting`，并在浏览器里异步完成。

技术性失败之后：

1. 用 `cordis_inspect_self(pluginId, packageId)` 读失败版本的源码与准确诊断。
2. 如果报错涉及未知能力，重新列出并查询对应的 Provider。
3. 在同一插件下定义新 Package；不要覆盖失败的那个。
4. 用新的 `packageId` 与正确的 mode 再跑一次。

用户拒绝审批后不要自动重试。失败的 update 不会自动恢复旧的物理 Run；需要恢复时显式 run current。

## 十三、内部活数据

Service 实例、Event payload、Slot props、Session 与 Conversation Snapshot、Tool 状态以及其他 DSH/Cordis 对象都是内部活数据。

不要：

- 对这些对象及其后代调用 `JSON.stringify` 或 `structuredClone`；
- 递归枚举、完整复制或整体展示它们；
- 把 Host 对象放进 Package 的长期状态或 RPC 返回值里。

只读当前功能需要的叶子字段。先抽取最少的字符串、数字、布尔值等标量，再构造自有 JSON。

## 十四、修改 @pluginId

当用户用 `@pluginId` 指认目标时，不要再创建另一个插件。注入的上下文只包含身份、版本指针与默认基线 Package，不包含源码。

1. 用 `cordis_inspect_self(pluginId, packageId)` 读基线 Package。
2. 保留不需要改动的那一半（Host 或 Client），只修改目标代码。
3. 调 `cordis_define`，带 `plugin.kind: 'existing'` 与原来的 `pluginId`。
4. 使用返回的 `packageId`；已有 current 时，通常用 `update` 激活新版本。

如果引用不可用，说明该插件已被移除、属于另一个会话，或在进程重启时丢失。不要创建同名的替代品。

## 十五、常见故障排查展开

| 故障 | 先查 |
| --- | --- |
| `service "x" is not declared` | 代码是否用了 `ctx.x` 却没在插件对象上声明 `inject: ['x']`；改用带缺失判断的 `ctx.get('x')`，或声明真正的硬依赖 |
| `cannot get property "timer" without inject` | 查询 timer Service，并声明 `inject: ['timer']` |
| Client 解析失败 | 代码是否用了 JSX、TypeScript、import 或不可用的全局量 |
| Slot 注册失败 | 是否查询过活子树、Slot 是否存在、options、key 或选择器是否满足返回的协议 |
| UI 加载但页面报错 | 检查 `client-render` 诊断与堆栈；错误归属某一次具体 Run，所以要定义新 Package 来修 |
| `host.call` 失败 | Host handler 名、当前 `pluginRunId`、JSON 参数、handler 内部的真实 Service 依赖 |
| Update 失败 | 保持 current/next 语义；修好 next 再 update，或 run current 回滚 |
