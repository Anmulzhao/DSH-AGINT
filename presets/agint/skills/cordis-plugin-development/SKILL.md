---
name: cordis-plugin-development
description: Create, modify, debug, or extend dynamic Cordis Plugins, including Host Services and Events, Client Slot and theme UI, Package-private Client-to-Host calls, dynamic Tools, version updates, approval failures, and runtime diagnostics. Use this Skill to route a user request to the correct platform and Inspect Provider, then define, run, repair, or roll back the Plugin.
tools:
  - cordis_inspect_list
  - cordis_inspect_query
  - cordis_inspect_self
  - cordis_define
  - cordis_run
  - cordis_stop
  - cordis_undefine
triggers:
  - "创建/修改/调试/扩展 Cordis 插件"
  - "定义 Host Service / Event / Client Slot / 动态 Tool"
  - "插件审批失败、运行时诊断、版本更新或回滚"
related_skills:
  - editing-cordis-compositions
  - plugin-preflight

---

# 开发动态 Cordis 插件

判据：先定 Host/Client，再查真实接口，再写码。禁从 Service 名、Event payload、Slot props、主题 token、示例推断 API。

## 标准流程

1. `cordis_inspect_list`：取当前 Host/Client 的 Provider、方法、schema。
2. `cordis_inspect_query`（最少集）：读要用的 Service、Event、Builtin、Slot、token、Tool 签名。
3. 新插件设计首个 Package；改已有插件先 `cordis_inspect_self(pluginId, packageId)` 读基线源码与诊断。
4. `code.host`/`code.client` 写纯 JS，再 `cordis_define`。
5. 用 define 返回的 `pluginId`+`packageId` 调 `cordis_run`。
6. 从 Run 卡片、steering、`cordis_inspect_self` 处理审批、等待、加载、渲染失败。
7. `cordis_stop` 停用；不再需要才 `cordis_undefine`。

禁同轮等审批或异步浏览器结果。`cordis_run` 返 `awaiting-approval`/`starting` 后结束当前 Tool 流程，等状态更新与 steering 报终态。

## 工具用法

- `cordis_inspect_list`：禁当 manifest 是业务数据。
- `cordis_inspect_query`：禁代替插件内调真实 Service、禁假设 Client 查询无响应也完成。
- `cordis_inspect_self`：禁为建列表拉全部源码、禁拿来改或启动插件。
- `cordis_define`：先让用户预览代码；禁指望它执行 `apply`、请求审批、更新 current。
- `cordis_run`：禁当 pending、starting 是成功；换版本须显式 `update`。
- `cordis_stop`：暂停，留 Package、授权、版本指针；禁当永久删除。
- `cordis_undefine`：永久移除插件及全部 Package、清历史业务视图；禁在仍需回滚/检查/重启时调。

## 选平面

- Host：文件/命令/进程/网络、Agent 与持久 Session、Host 生命周期、下步模型可调的动态 Tool。
- Client：主题/布局/页面状态、Snapshot 与 session/workspace 列表、设置页/侧边栏/输入区/覆盖层/Tool 卡片。
- 两侧：Host 取数加 Client 展示。

各需求先查哪个 Provider 方法见同目录 reference.md。取最贴近数据拥有者的能力：Slot props 已给 Snapshot 不经 Host 取；只改样式不覆盖全局主题；小入口不替换整个 UI 区域。

## Provider 导航

Provider 名、方法名、入参必须来自当前 `cordis_inspect_list`；两遍查询法见同目录 reference.md。Catalog 不保证 Service 已挂载；运行时用真实 Service 与 Event。

## 执行环境

`code.host`/`code.client` 是返回 Cordis 插件的纯 JS 函数体，未经 TS/JSX/打包器编译。

禁：`import`、`require`、TS 类型、`as`、装饰器、JSX；`Builtin.listBuiltins` 未确认的全局量；猜测访问 `window`、`document`、`process`、`Buffer`、`fetch`、原生定时器。

Client React 必须用 `React.createElement(...)`；`apply()` 只注册生命周期贡献，禁返 React Element；UI 必注册到已查 Slot。

## 访问 Service

默认 `ctx.get(name)` 读可选能力并处理缺失；仅当 Service 是硬依赖、插件须等它出现后重新激活才继续时声明 `inject`。

禁为省 `undefined` 判断滥用 `inject`；禁未声明注入即访问 `ctx.requiredService`（Guard 拒绝）。

## 副作用

停止、更新、移除后每个贡献都要移除。`ctx.on()` 注册 Event 监听器；`ctx.effect()` 持有返 disposer 的外部订阅；留 Service、Tool、Slot、定时器、主题 API 的 disposer。

禁在模块作用域或 `apply()` 之外造进程级、页面级副作用。`subscribe()` 不返 disposer 时先查该 Service 有无清理机制；禁假设卸载会移除回调。

## 定时器

Host 与 Client 的定时器都是名为 `timer` 的 Service，非 Builtin。用前先用对应平台 `Service.listService` 查 `{ "service": "timer" }`，并声明 `inject: ['timer']`。

`ctx.timeout(fn, 300)` 一次性延时，`ctx.interval(fn, 1000)` 周期任务，React 组件内配 `React.useEffect`。禁不声明 `inject: ['timer']` 即用；禁全局 `setTimeout`。

## 监听 Event

查 Event Provider 确认平台、参数顺序、返回值、`mode`；Waterfall 末参 `next`，除非有意中断下游须调并返。

## 注册 Client UI

先不带 `root` 查 `Slots.listSubTree` 选目标，再带精确 `root` 查一次再写注册；结果决定 Slot 用途、注册协议、注册选项、props、占用者与子 Slot。

`ctx.get('slots')` 并处理缺失，再用 `slots.inject` 等 Slot 声明、回调内 `slots.register`；`ctx.get('slots')` 不需注入。

禁未声明 `inject: ['slots']` 即写成 `ctx.slots`；禁查协议前猜 `id`/`key`/选择器/props；禁默认用根级 `root`、`sidebar`、`conversation`、`details` Slot。设置页、会话数据、Run 面板、Tool 卡片、覆盖层的 Slot 名与细则见同目录 reference.md。

## Client 调 Host

Host 用 `harness.handle(method, handler)` 注册 Package 私有方法，Client 用 `host.call(method, args)` 调用。参数与返回值必须无损 JSON；禁传函数、React 元素、类实例、Context、Service、运行时对象；无数据返 `null`。禁注册公共 Remote Service，禁 `ctx.remote`。

## 注册动态模型 Tool

Host 用 `harness` 注册下一步模型可调的 Tool：先用 Host `Builtin.listBuiltins` 查 `harness` 签名，再用 `Tool.listTools` 查现有 Tool 名与 schema 以免冲突。参数与返回值必须 JSON 兼容；`execute` 负责业务结果，render 只管模型与原生 UI 所见；Tool 注册须属当前插件 Fiber，stop 或 update 后自动移除。

## 内部活数据

Service 实例、Event payload、Slot props、Session/Conversation Snapshot、Tool 状态等是内部活数据。禁对其或后代调 `JSON.stringify`、`structuredClone`；禁递归枚举、全量复制、整体展示；禁把 Host 对象放进 Package 状态或 RPC 返回值。只读所需叶子字段，先抽标量再构造自有 JSON。

## 版本、审批与修复

`pluginId`=插件，`packageId`=不可变版本，`pluginRunId`=每次激活运行 id；`currentPackageId`=最新成功版，`nextPackageId`=待审批或失败版。

mode：无或同 current→`run`；换版本→`update`；update 失败修 `nextPackageId` 再 `update`，或跑 `currentPackageId` 用 `run` 回滚。

未授权 Client Package 返 `awaiting-approval`；单勾只授权当前 Package，双勾授权未来版本；技术失败后授权仍保留；已授权返 `starting`。

技术性失败后：1. `cordis_inspect_self(pluginId, packageId)` 读失败版本源码与诊断。2. 报错涉未知能力则重列并查 Provider。3. 同插件下定义新 Package，禁覆盖失败者。4. 用新 `packageId` 与正确 mode 再跑。禁自动重试被拒的审批；update 失败不自动恢复旧 Run，需恢复时显式 run current。

## 修改 @pluginId

用户以 `@pluginId` 指目标时禁另建插件；注入上下文只含身份、版本指针与基线 Package，无源码。

1. `cordis_inspect_self(pluginId, packageId)` 读基线 Package。
2. 留不需改的那半，只改目标代码。
3. `cordis_define` 带 `plugin.kind: 'existing'` 与原 `pluginId`。
4. 用返回的 `packageId`；已有 current 时通常用 `update` 激活。

引用不可用时说明插件已移除、属别的会话或进程重启后丢失。禁建同名替代品。

## 常见故障排查

| 故障 | 先查 |
| --- | --- |
| `service "x" is not declared` | `ctx.x` 缺 `inject: ['x']`？改 `ctx.get('x')` |
| `cannot get property "timer" without inject` | 声明 `inject: ['timer']` |
| Client 解析失败 | 用了 JSX/TS/import 或不可用全局量？ |
| Slot 注册失败 | 查过活子树？Slot 存在？key/选择器合协议？ |
| UI 加载但页面报错 | 查 `client-render` 诊断与堆栈，定义新 Package 修 |
| `host.call` 失败 | handler 名、`pluginRunId`、JSON 参数、handler 内 Service 依赖 |
| update 失败 | 修 next 再 update，或 run current 回滚 |

代码示例、错误示例、查询方法详解见同目录 reference.md，用 read 工具打开（本会话 skill 加载返回的 Base directory 即技能基目录）。
