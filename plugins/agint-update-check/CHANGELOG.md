# Changelog — agint-update-check

## v0.1.1 (2026-10-31) — 修「插件条目 did not activate」：不再访问未注入的 timer

**症状**：宿主启动日志一行 `dsh: warning: 1 entry did not activate` +
`agint-update-check (...): Error: cannot get property "timer" without inject`，
界面上这个插件显示「失败」，三个工具全部不可用（但其余插件照常，很容易被忽略）。

**根因**：定时器分支写了 `ctx.setInterval(...)`。它是 `cordis-plugin-timer` 提供的糖，
内部转 `ctx.timer` —— 而 timer 只是 manifest 的 `optionalInject` 里写了，
**真正生效的是 lib/index.js 模块导出的 `inject` 数组**（本插件只有 `['tools']`）。
manifest 的 optionalInject 纯属文档，不会给 ctx 接服务 ⇒ 访问即抛。

**修法**：不用 `ctx.setInterval`，改 Node 原生 `setInterval` + `ctx.effect` 注册
`clearInterval` disposer（`unref()` 让周期检查不 hold 进程退出）。与 agint-restart 同款，
零宿主服务依赖。

**测试补强**：新增 `strictCtx`（Proxy 复刻 cordis gate：只有作用域内服务可访问，
其它属性名一读就按宿主原文抛错）。原来那份假 ctx 是普通对象，任何属性都读得到 ——
所以这类「未 inject 就访问」的 bug 在测试里永远绿，只在真宿主里炸。

**口径提醒**：manifest `spec.cordis.inject` / `optionalInject` 只描述意图；
cordis 真正注入什么，只看模块 export 的 `inject`。两者不一致时以代码为准。

## v0.1.0 (2026-10-28) — 初版：检测远端最新状态 + 询问用户是否更新部署

**解决的问题**：AGINT 仓库自己会往前走，但「仓库走到哪了」和「部署位跑到哪了」是两件事。
以前只能靠人记得去 fetch、看 diff、再手动跑安装脚本 —— 而且「拉不动」的那类情况
（本地有未推送提交 ⇒ 分叉；工作区有未提交改动 ⇒ 快进被拒）要等真去拉的时候才发现。

**这一版提供**：
- `agint_update_check`（只读）：本地 HEAD vs 远端 main，落后 / 领先多少、变了什么、
  要不要重新部署与重启宿主；返回里的 `question` 就是要问用户的那句话。
- `agint_update_apply`（写，ASK-gated）：快进 + `install/install.sh` 部署；必须 `confirm: true`；
  分叉 / 脏工作区一律拒绝，**不代劳** merge / rebase / stash。
- `agint_update_status`：读上次检测结果（不联网）。
- 6 小时自持周期检查：发现远端有更新就往用户会话投递一条「要不要更新」（同一版本只投一次）。

**刻意不做的事**：
- 不重启宿主 —— 重启归 `agint-restart` 的 `restart_request`（自带冷却与熔断）；
  本进程自杀式重启会让工具调用无返回、结果丢失。
- 不猜仓库根 / profile / bash —— 找不到就报错，不猜一个默认值去执行。
- 不自动部署 —— 部署仍要人点头，且受「每周自动部署 ≤ 3 次」的额度约束。

**踩过的坑（留档）**：
- `gitOut()` 会 trim 输出，而 `git status --porcelain` 首行的状态码靠**前导空格**定位
  ⇒ trim 之后第一行会被砍掉一个字符。脏文件列表必须用未 trim 的 stdout。
- `git ls-remote` 输出的空白切分要用 `/\\s+/`；写成 `/\\\\s+/` 会匹配「反斜杠 + s+」，
  结果永远解析不出 sha，表现为「远端没有分支」。