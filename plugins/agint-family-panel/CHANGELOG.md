# agint-family-panel CHANGELOG

## 0.1.1 — 2026-09-29

### 修复

- **apply 签名不符 cordis 契约导致宿主拒绝加载**：v0.1.0 写成 `apply(ctx)` 内读
  `ctx.config`，cordis 报 `cannot get property "config" without inject`、条目激活失败
  （宿主日志 `dsh: warning: 1 entry did not activate`，面板从未真正挂载）。
  改为 cordis 标准姿势 `apply(ctx, config = {})` —— config 是 apply **第二参数**，
  与 agint-aesthetic-oracle 等成熟插件一致。`allowNonLoopback` 改为闭包常量。
- `test/smoke.mjs` 同步：apply 第二参数传配置（此前 stub ctx 塞 `ctx.config`
  掩盖了真实宿主差异，测试过而宿主炸）。
- **成员状态全 unknown（38/38）**：v0.1.0 的 `readRows` 读 `entry.runtime.status`，
  但 cordis-plugin-loader 的 entry 没有 `runtime` 字段——真实生命周期状态在
  `entry.fiber.state`（FiberState 枚举：PENDING=0/LOADING=1/ACTIVE=2/FAILED=3/
  DISPOSED=4/UNLOADING=5）。新增 `fiberStateToStatus` 映射（2→active、3→failed、
  0/1→loading、4→disposed、5→unloading、无 state→unknown），`readRows` 改读
  `entry.fiber.state`。修复后实测 38 成员全部 `status:"active"`、`unknown:0`。
- **panelVersion 硬编码 `'0.1.0'`**：改为 `createRequire` 读 `package.json` 的
  version，面板自报版本与包版本永远一致（修复后实测 `panelVersion=0.1.1`）。
- `test/smoke.mjs` 的 row() stub 同步为真实 loader 结构
  （`options + disabled + fiber.state`），新增状态映射与 counts 断言。

### 验证

- smoke 11 组 PASS（含 fiberStateToStatus 8 组映射断言、混合 counts 断言）；
  重启后宿主无 `1 entry did not activate`，路由 `GET /api/agint-family/status`
  真正注册；浏览器实测 `panelVersion=0.1.1`、`counts {total:38, active:38,
  unknown:0}`、signals 三项全 ok。

## 0.1.0 — 2026-09-29

首次发布：AGINT 家族面板以**宿主原生停靠面板**形态上线（此前 AGINT 没有任何浏览器半代码，
33 个插件全是 host 半，家族在 GUI 里不可见）。

### 新增

- **双半插件**：host 半 `lib/index.js` + 浏览器半 `lib/client.js`，
  经 `package.json` 的 `dsh.client`（platform=web）+ `exports["./client"]` 声明，
  由 `dsh-client-modules` 按行解析到包清单并投放到浏览器模块表。
- **原生席位注册**：`sidebar.panellist` 入口行 + root `main` keyed slot 面板页，
  两者共用 id `agint-family`；全部经 `ctx.slots.inject`，席位不存在即静默不挂。
- **席位切换**走 `ctx.layout.selectPanel(id | null)`，不做 DOM 抢占；
  面板内「返回会话」按钮回落到会话界面。
- **尺寸自适应**：`grid auto-fill minmax(260px,1fr)` + `min-width:0`；
  入口型页面遵守 `--dsh-frame-top-clearance`。
- **只读回环路由** `GET /api/agint-family/status`：名册（loader 权威）+ 分组 +
  三个通电信号（cron / metrics / selfModel），默认只放行回环。
- **降级与 kill-switch**：信号缺席/抛错 → `unavailable`/`error` + reason；
  `enabled:false` 时路由仍应答 `{enabled:false}`，面板显示「已关闭」。
- **未归类兜底**：分组表只做标签映射，未命中的行进「未归类」组并列出 id。
- 冒烟测试 `test/smoke.mjs`（11 组断言，含降级、非回环拒绝、kill-switch）。

### 挂载

根 `cordis.patch.yml` 追加 `agint-family-panel` 行（bundle 位 + 兼容镜像位同步，md5 三方全等）。
