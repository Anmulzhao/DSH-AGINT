# dsh-kill-switch

给 Harness Web GUI 加一个**两步确认的「终止 DSH」按钮**，按下去结束宿主进程。

不是 agint 插件，是一个独立的 DSH bundle，所以放在 `bundles/` 而不是 `plugins/`——
`plugins/` 是 agint 插件命名空间，`bin/plugin-check.sh` 会按 `docs/plugins/PLUGIN-SPEC.md`
去校验 `manifest.json`，放进来会被误判为不合规。

## 行为

按钮落在输入框下方的 dock（`conversation.composer.dock`）：

- **第一次点** → 变红，显示 `再次点击以终止 · 4s` 倒计时
- **4 秒内再点** → 发送终止信号
- **4 秒内不动** → 自动还原，不会误杀

宿主是 PPID 1 拉起的，**没有任何东西看着它**，杀进程不会自动重启，需要手动
`dsh web --no-open` 重新拉起。

## 结构

| 文件 | 角色 |
|---|---|
| `index.js` | 宿主半边。注册 `kill-dsh` 命令，是唯一真正杀进程���代码 |
| `client.js` | 浏览器半边。只负责画按钮和两步确认，不含任何进程逻辑 |
| `cordis.patch.yml` | Loader patch，插入宿主行 |
| `locale/{en,zh}.json` | 插件清单里的展示名与描述 |

**一个操作，两个入口。** 按钮点击最终变成一条 `kill-dsh` 命令行交给宿主执行，
所以 GUI 和 composer 里手敲 `/kill-dsh` 走的是同一段代码，不会各自漂移。

## 命令用法

```
/kill-dsh                    800ms 后 SIGTERM（默认）
/kill-dsh 3000               自定义延迟
/kill-dsh 0 exit             走 process.exit(0)
/kill-dsh kill               SIGKILL
/kill-dsh status             查当前有没有待杀、还剩几毫秒
/kill-dsh cancel             撤销待杀
```

延迟被夹在 100ms–30000ms：下限保证命令结果先回到浏览器，上限避免误填出一个永远不触发的杀。
`SIGTERM` 之后 2 秒不退再强杀。重复排程不叠加，只保留最后一个。

## 为什么不给 agent 工具

模型可以在自己正在运行的宿主里调一个把自己掐掉的工具。这个口子不该开，
所以只注册了人点的路径——这也是 `references/user-actions.md` 里
「授予或确认权限的动作只留给用户」那条的同一种判断。

## 安装

```bash
plugin_manager install_bundle  # target 指向本目录的绝对路径
```

装完 `application` 字段应为 `applied`；宿主侧行 `include:dsh-kill-switch`
应为 `fiberPhase: active`。

**浏览器半边需要刷新页面才可见。** bundle 是在页面 boot 之后才装的，
客户端 bundle 不会热喂给已开的页面。`/kill-dsh` 命令不用刷新，宿主侧已就绪。
