# agint-verify-tools

host 平面插件。把 AGINT 的**验证入口**注册为全局工具，让任何 preset 的会话都能
手动触发 cron job 与刷新能力画像。

## 为什么存在

AGINT 的 cron / self-model 工具原本只挂在 `agint` preset 的 25 个工具行里
（`.agent-presets/agint/agent.cordis.yml`）。会话实际跑在哪个 preset 由宿主决定，
本机实测被切成过 `cordis` ⇒ 那些工具一个都不出现 ⇒ **验证一次修复必须等一个 cron 周期**。

### 曾经用错的方法（留作教训）

第一版做法是整段覆盖 `preset-cordis` 的 `config.plugins`（逐字复制官方 23 个 + 追加 2 个）。
它有两个硬伤：

1. **覆盖是整体替换，不深合并**。依据 `dsh-app-boot/lib/index.js:104-106`：
   ```js
   for (const [key, value] of Object.entries(overrides)) {
     if (key === "id") continue;
     target[key] = value;        // 整体赋值
   }
   ```
   ⇒ 官方升级 cordis preset 后，新增插件被冻结的快照挡住，**不再出现**；
   官方改动某个插件的 config 也会被旧快照覆盖回去。

2. **引用脆弱**。官方若改名/删除某个插件，快照里仍引用旧名 ⇒ 该 preset 可能整体起不来。

### 现在的方法

host 平面直接 `ctx.tools.register(...)`。

依据 `@deepseek-ai/dsh-scope/lib/index.js:189-195`：

```js
effect(ctx, action, options) {
  ...
  if (scope === void 0) layer = this.global;   // host ctx 无 scope ⇒ 全局层
```

⇒ 注册进 **global 层**，每个会话、每个 preset 都可见。
现成先例：同层的 `agint-tool-stats` 用同一手法注册 `tool_stats_summary`。

## 提供什么

| 工具 | 转调的 host 服务 |
|---|---|
| `cron_list` | `agint.cron.list()` |
| `cron_run_now` | `agint.cron.runNow(id)` |
| `cron_health` | `agint.cron.health()` |
| `selfModel_snapshot` | `agint.selfModel.snapshot()` |
| `selfModel_update` | `agint.selfModel.update()` |
| `selfModel_calibrate` | `agint.selfModel.calibrate()` |
| `selfModel_stats` | `agint.selfModel.stats()` |
| `selfModel_inspectSummary` | `agint.selfModel.inspectSummary()` |

## 设计边界

1. **只转发，不复制**。schema 与实现都留在 `agint-cron/lib/tools.js` 与
   `agint-self-model/lib/tools.js`。这里复制会造出第二份定义，两边一漂就出
   「工具描述与实现不符」——本仓已踩过这个坑。
2. **不 inject 具体服务**，只用 `ctx.get()` 懒取。host 平面各插件挂载顺序不保证，
   apply 时服务未必就绪；每次 execute 再取一次，代价可忽略，换掉「挂载顺序耦合」这一类故障。
3. **服务缺失时抛明确错误**，不静默少注册。工具仍会出现在列表里（注册不依赖服务），
   但调用时报 `host 服务 "xxx" 不可用（agint-cron / agint-self-model 未挂载？）`。
   静默缺失比报错更难查。

## 与 preset 内同名工具的关系

`agint` preset 里也有同名工具（`agint-cron-tools` / `agint-self-model-tools`）。
`dsh-tools` 的解析规则是 **scoped 注册遮蔽 global**，所以：

- `agint` preset 会话 → 用 preset 内那份
- 其他 preset 会话 → 用本插件这份

两份都转调同一 host 服务 ⇒ 行为一致。

## 测试

```bash
node --test plugins/agint-verify-tools/test/register.test.mjs
```

8 用例：8 个工具名字精确匹配、每个工具真转调并透传参数、服务缺失时抛明确错误、
`tools.register` 不可用时软降级、以及一条反向自证（少一个工具的清单必须不相等）。
