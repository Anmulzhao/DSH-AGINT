# dsh-kill-switch

给 Harness Web GUI 加一个**两步确认的「终止 DSH」按钮**，按下去结束宿主进程**及其子进程**。

不是 agint 插件，是一个独立的 DSH bundle，所以放在 `bundles/` 而不是 `plugins/`——
`plugins/` 是 agint 插件命名空间，`bin/plugin-check.sh` 会按 `docs/plugins/PLUGIN-SPEC.md`
去校验 `manifest.json`，放进来会被误判为不合规。

## 行为

按钮落在输入框下方的 dock（`conversation.composer.dock`）：

- **第一次点** → 变红，显示 `再次点击以终止 · 4s` 倒计时
- **4 秒内再点** → 排程终止
- **4 秒内不动** → 自动还原，不会误杀

宿主是 PPID 1 拉起的，**没有任何东西看着它**，杀进程不会自动重启，需要手动
`dsh web --no-open` 重新拉起（命令见文末）。

## v2.0.0 改了什么：真把整棵树杀掉

v1.0.0 在宿主内部做 `process.kill(process.pid, sig)` —— **只打给自己一个 pid**。
实测（2026-10-01，dsh pid 1509258 挂子进程 `mcp-proxy.mjs` pid 1515057）：
主进程一死，子进程立刻变成 PPID=1 的孤儿继续跑，端口和内存都不回收。
「终止」要的是整棵树干净，不是换一个孤儿接着跑。

v2 把真正发信号的代码挪到一个**独立进程** `killer.js`，与 agint-restart 的 respawn 同一形状：

```
宿主 index.js     写 kill-request.json → detached 拉起 killer.js → 静候
killer.js（孤儿） 枚举进程树 → 叶子优先 SIGTERM → 升级 SIGKILL → 写 kill-result.json
```

| 环节 | 做法 | 为什么 |
|---|---|---|
| 枚举 | 读 `/proc/*/stat`（win32 走 PowerShell CIM） | 只用 node 内置模块——它是最后一道执行者，宿主正在退出，任何一次 import 失败都等于这次终止静默失效 |
| 顺序 | **叶子优先**，宿主排最后 | 先让子进程收尾（它知道自己该关什么）；宿主先死会让子进程变孤儿、丢收尾逻辑 |
| 组信号 | dsh 自称组长（`PGID=SID=pid`）时用 `kill(-pgid)` | 逐个杀收不掉「快照之后才冒出来的子进程」，组杀能 —— 前提已实测（`test/group-signal.test.mjs`，让组长在快照后才 fork，结果照样被收掉） |
| 升级 | SIGTERM 后超 `graceMs` 仍活 → SIGKILL | dsh 有优雅关闭逻辑，必要时得强杀 |
| 验证 | 回执记 `survivors`；`ok` 要求目标已消失**且**无孤儿 | 「发出信号」不等于「杀干净了」 |

**宿主不自杀**，这是刻意的：killer 的 pid 复用防护比对的是「ppid 仍在原主」的指纹，
宿主先死会让子进程 ppid 变成 1、指纹失配、被当成「不是那个进程」而漏杀。

## v2.0.1 改了什么：按钮本来压根点不动

v1.0.0 的 `client.js` 写的是：

```js
ctx.remote.commands.execute(sessionId, '/kill-dsh', [])
```

**这个 API 在 dsh 里不存在。** 取证（`cordis_inspect_list`，client 平台，2026-10-01）
显示客户端一共只有 8 个服务：`layout` / `locale` / `sessions` / `slots` / `theme` /
`timer` / `uiWorkspace` / `workspaces` —— 没有 `remote`，也没有 `commands`。
点按钮必然抛 `cannot get property "remote.commands" without inject`。
（`@deepseek-ai/dsh-api-remotes` 是 **host 侧**的包，不是客户端服务。）

按钮渲染得出来——slot occupants 里 `dsh-kill-switch` 一直是 `active: true`——
所以这个 bug 在外观上完全看不出来，只有点下去才炸。

现在走 composer 自己的 `InputActions`（slot 标准 prop，契约见
`dsh-client-ui-conversation/lib/types/client/contract/input.d.ts`）：

```js
inputActions.setDraft('/kill-dsh')   // 替换整个草稿
inputActions.submit()                // 走 composer 自己的命令仲裁
```

`submit()` 内部就是 Enter 提交管道（adjudication → claim transaction → sink），
以 `/` 开头的行会被判为命令并送到 host 的 `kill-dsh` handler。**不需要任何 RPC**，
也正是 v1.0.0 那句「一个操作，两个入口」本来就该有的实现。

> 为什么没走 `host.call(method, args)`：`host` 是 dynamic Cordis Plugin 的 builtin
> （"Package-private JSON RPC from Client to this Package's Host half"），
> 而本 bundle 走的是 `window.__ModuleLoader__` 的 bundle 通道。
> **我没有验证 bundle 形态下能否拿到 `host` builtin**，所以选了有硬契约证据的这条。

**代价（如实交代）**：`submit()` 无返回值，按钮拿不到宿主回执文案。页面断 = 成功；
页面没断 = 命令被拒。UI 上明写了这个判据，并指向手动 `/kill-dsh` 排查。
另外 `setDraft` 会**清空输入框里已有的草稿**——对终止开关来说这个取舍可接受
（一份草稿远不如一个停不下来的宿主值钱），但它不是静默的。

## 结构

| 文件 | 角色 |
|---|---|
| `index.js` | 宿主半边。注册 `kill-dsh` 命令，只负责**派发**与**留痕**，不含进程逻辑 |
| `killer.js` | 独立进程。**唯一真正发信号的地方**，也可单独 `node killer.js <request.json>` 跑 |
| `client.js` | 浏览器半边。只负责画按钮和两步确认，不含任何进程逻辑 |
| `cordis.patch.yml` | Loader patch，插入宿主行 |
| `locale/{en,zh}.json` | 插件清单里的展示名与描述 |
| `test/*.test.mjs` | killer 进程树 / 组信号前提 / index 命令面 / client 契约，共 27 条 |

**一个操作，两个入口。** 按钮点击最终变成一条 `kill-dsh` 命令行交给宿主执行，
所以 GUI 和 composer 里手敲 `/kill-dsh` 走的是同一段代码，不会各自漂移。

## 命令用法

```
/kill-dsh                    800ms 后终止整棵进程树（默认）
/kill-dsh 3000               自定义延迟
/kill-dsh kill               全程 SIGKILL
/kill-dsh self               只杀宿主自己，不动子进程（= v1.0.0 行为）
/kill-dsh exit               process.exit(0)，不走 killer
/kill-dsh status             查待杀倒计时 + 上一次终止的真实回执
/kill-dsh cancel             撤销待杀
```

延迟被夹在 100ms–30000ms：下限保证命令结果先回到浏览器，上限避免误填出一个永远不触发的杀。
重复排程不叠加，只保留最后一个。插件卸载（dispose）会丢弃待杀。

## 留痕：终止后怎么确认杀干净了

| 文件 | 内容 |
|---|---|
| `~/.dsh/.dsh-kill-switch/kill-request.json` | 本次请求（`requestId` / `targetPid` / `mode` / `scope`） |
| `~/.dsh/.dsh-kill-switch/kill-result.json` | **回执**：`ok` / `tree` / `signalled` / `escalated` / **`survivors`** |

⚠️ 宿主是被 killer 杀掉的，**当场没人能读回执**。要看结果得在**下次启动后**跑：

```
/kill-dsh status
# last kill (…): ok=true scope=tree mode=term tree=3 signalled=2 escalated=[] survivors=0
```

### 读回执的关键：`tree` 长度才是分母，`ok` 不是

`ok: true` 只说明「目标已消失 **且** 快照里那些都死了」。它**不覆盖**快照之后才存在的东西。
所以 `tree` 有几个进程，决定了这次到底验到了什么：

| 回执 | 含义 |
|---|---|
| `ok=true, tree=1, survivors=0` | 只验到「dsh 自己被杀掉了」，**没验到子进程清理**（当时没有子进程） |
| `ok=true, tree=2+, survivors=0` | 这次真的验到了「子进程跟着死」 |

2026-10-01 17:02:50 的真机回执（`requestId=ba99fd7d`）就是前者：`tree` 长度 1，
因为那一刻 `mcp-proxy` 尚未启动。按钮链路与「终止生效」由它证明，**子进程清理由它证明不了**。

`survivors` 非 0 则更直接：还有进程没死干净，回执里直接列出 pid。

## 真机验证记录

| 时间 | requestId | tree | ok | 证明了什么 | 没证明什么 |
|---|---|---|---|---|---|
| 2026-10-01 17:02:50 | `ba99fd7d` | 1 | true | 按钮链路通（client→host 经 InputActions 生效）；dsh 确实被杀；耗时 2.3s | 子进程清理（当时无子进程） |

## 为什么不给 agent 工具

模型可以在自己正在运行的宿主里调一个把自己掐掉的工具。这个口子不该开，
所以只注册了人点的路径——这也是 `references/user-actions.md` 里
「授予或确认权限的动作只留给用户」那条的同一种判断。

## 已知边界（诚实交代）

- **组信号模式下 pid 复用防护不生效。** `kill(-pgid)` 是内核按组一次性投递的，无法逐个校验指纹；
  那一路的全部安全性押在三条判据上（dsh 自称组长 / 非 pid 1 / 不是执行者自己的组）。
  逐个杀分支才有指纹校验。
- **killer 起不来会退化成 v1.0.0 行为**（只杀自己，留孤儿）。派发失败时 `index.js` 会在宿主日志打
  一行 `[kill-switch] killer dispatch failed …`，并立即自兜底——宁可只杀自己，也不让宿主在用户
  以为已经停机的情况下继续跑。
- **测试不碰真 dsh。** `test/killer.test.mjs` 里所有目标 pid 都由测试自己 spawn，
  树是假的（`fake-dsh.cjs` fork 出模拟 mcp-proxy 的子进程）。
- **真机按钮链路已验一次**（2026-10-01 17:02，见上表）：证明按钮能用、dsh 能被杀干净。
  **子进程清理的真机证据仍待补**——那次回执的 `tree` 长度是 1。
- **组信号的前提已实测**（`test/group-signal.test.mjs`）：让组长在快照**之后**才 fork，
  该子进程照样被组信号收掉。这条原本只是设计推理——若不成立，组杀路线的理由就没了。

## 终止后重新拉起

本机（Kylin aarch64）实测的启动命令：

```bash
/home/kylin/.nvm/versions/node/v24.19.0/bin/node \
  /home/kylin/.nvm/versions/node/v24.19.0/bin/dsh web --no-open
```

入口 URL（带 token）只印在新实例 stdout 里。token 每次启动都变，旧页面刷不出来。

## 安装

```bash
plugin_manager install_bundle  # target 指向本目录的绝对路径
```

装完 `application` 字段应为 `applied`；宿主侧行 `include:dsh-kill-switch`
应为 `fiberPhase: active`。**确认部署位里有 `killer.js`**——缺了它按钮仍会「生效」，
但静默退化成只杀自己（`node -e "import('@local/dsh-kill-switch/killer')"` 可验）。

**浏览器半边需要刷新页面才可见。** bundle 是在页面 boot 之后才装的，
客户端 bundle 不会热喂给已开的页面。`/kill-dsh` 命令不用刷新，宿主侧已就绪。

## 自测

```bash
node --test "test/*.test.mjs"   # 27 条，约 3.5 秒
```
