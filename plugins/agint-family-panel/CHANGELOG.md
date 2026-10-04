# agint-family-panel CHANGELOG

## 0.2.2 — 2026-10-04

### v2 内嵌高度自适应（老板反馈：固定视口高不如 v1 的整页下拉）

**为什么**：0.2.1 iframe 固定 `calc(100vh-190px)`，实测内页内容高 ≈6000px 而视口
≈900px——面板只显示 1/6，内容在内滚一层，体验割裂。v1 是整页在外层 `.agintfp-root`
里下拉，老板要同样的效果。

**改了什么**：`lib/client.js` 的 v2 视图加高度自适应——同源直读
`contentDocument` 的 `scrollHeight` 设进 iframe 高度（load 时 + ResizeObserver
监听内页 body + 3s 轮询兜异步取数后的高度变化；同源读不到时退回视口高兜底，不抛）。
内页满高展开、`scrolling=no`，滚动统一归外层面板，与 v1 一致。「刷新」在 v2 模式
先复位高度再换 cache-buster src。路由与数据层零改动。

**测试**：smoke 静态断言加 `contentDocument`/`ResizeObserver` 两条；全量测试 +
`node --check` PASS。两槽（`.agint-bundle` + `profiles/web`）同步后 GUI 强刷新
（不行再 restart_request）。

## 0.2.1 — 2026-10-04

### v2 内嵌进停靠面板（老板改令：页面不单独放外面）

**为什么**：0.2.0 把 v2 做成独立整页 + 停靠面板留链接；老板要求收进「AGINT 家族」
面板本身。

**改了什么**：

- `lib/client.js`：停靠面板新增视图状态，**默认 v2**——iframe 内嵌 `api/agint-family/v2`
  （文档相对路径，沿用 base-href 子路径纪律；不用 `data.apiPrefix` 根绝对）。
  顶栏四个按钮：v2/v1 视图切换、刷新（v2 模式给 iframe 换 cache-buster src，
  v1 模式重取 /status）、新标签页打开（保留逃生口）、返回会话。
- v1 名册视图（分组/行状态/通电信号）原样保留，一键可切。
- kill-switch / 读失败 / 载入中的降级路径对两种视图同时生效（先判 data，再进 v2 分支）。
- 路由与数据层零改动；`/v2` 与 `/v2/data` 独立可达性不变（iframe 源就是它们）。
- package/manifest 0.2.1（顺带：manifest 描述改述内嵌形态）。

**测试**：smoke 用例 3 的静态断言改为匹配新实现（V2_PATH 文档相对、iframe 内嵌、
window.open(V2_PATH)、切换按钮文案）；`node --check` client.js；全量测试 +
plugin-check 11 维度 + L0 门禁通过。部署：仓库 → `.agint-bundle/plugins` +
`profiles/web/plugins` 两槽同步 → restart_request（playbook §3.27 纪律）。

## 0.2.0 — 2026-10-04

### v2 家族面板上线：整页 + 实时数据端点

**为什么**：现面板只显示激活状态，产出与关系没体现（老板 2026-10-03 起因）。效果稿
（Q1/Q2/Q3）拍板转生产：入口=独立整页 + 停靠面板留链接；数据=实时端点按需计算 + 缓存；
范围=端点 + 整页全量，`FAMILY_GROUPS` 本版本**保留不删**（设计稿 §10 删表决策另行拍板）。

**改了什么**：

- host 半新增两条回环路由：`GET /api/agint-family/v2`（text/html 整页，资产
  `assets/panel-v2.html` 按 mtime 缓存）与 `GET /api/agint-family/v2/data`（实时聚合
  JSON）。与 `/status` 同一套 `enabled` kill-switch 与回环守卫。
- 新增 `lib/v2-scan.js`：源码扫描器（L0.5 真源，设计稿 §1.2/§1.4）。
  `ctx.get/provide('agint.*')` 三分类 code/comment/umbrella；伞键（有子键的命名空间
  裸键）不建边。与 2026-10-03 效果稿基线的两处规则差（注释中伞键命中一律标 comment；
  provide 伞键行不进 hits）在实施计划 Task 2 声明并逐条对账。
- 新增 `lib/v2-data.js`：storages 三源聚合（tool_stats 30 天窗口 + 7 天日聚合、
  cron_state、event_bus events/deadletter）+ manifest 三形态 consumes + repoDirs；
  TTL 30s + mtime 签名缓存；每源独立降级 `{state:'error',reason}`，不装绿；
  `latencyMs` 不聚合（U2）。
- `assets/panel-v2.html`：效果稿转生产——删 `g.alicdn.com` itrace 外部埋点；内嵌常量
  改 `fetch ./v2/data`；渲染包进 `render()`，刷新按钮真实重算；龄期条/覆盖率改动态，
  不留硬编码；Q3「运行态不在仓库」改数据驱动（部署位+仓库位目录对差，不可得时标
  unknown）；「最后改动」仍为示意（待接 evolution ledger）。
- v1 停靠面板 Head 加「打开 v2 全页」按钮（新标签页，noopener）。
- `agint.familyPanel` 服务新增 `v2Data()` 方法（与路由同源同缓存）。
- 版本漂移修复：manifest 0.1.2 与 package 0.1.4 统一到 0.2.0。
- manifest：`permissions.fs` 补三条读声明（storages / profiles/web/plugins / plugins）。

**测试**：新增 `test/v2-scan.test.mjs`（三分类 + 注释状态解析 + 基线回归容差 ±2，
基线冻结于 `test/fixtures/v2-scan-baseline.json`）、`test/v2-data.test.mjs`（聚合形状、
窗口、降级、缓存）与夹具树 `test/fixtures/v2-home/`；smoke 增第 15 组（三条路由注册、
data 形状、HTML content-type、非回环 403、kill-switch 不吐数据、v2Data 存在）。
全量 PASS；假 host + 真实存储联调经浏览器断言（表非空、无 NaN、刷新/过滤/展开/主题可用）。

## 0.1.4 — 2026-10-03

### 分组表补录 `agint-ops-preset`

**为什么**：生产运维子 preset（`~/.dsh/.agent-presets/agint-ops/preset.yml`，
名「智进·生产运维」）的 loader 行 `agint-ops-preset` 此前不在分组表（label map），
落进「未归类（分组表待补）」兜底组，`declared:false`。它是 AGENT 预设，不是杂项。

**取证**：实机 `GET /api/agint-family/status` 返回 `unmappedIds: ["agint-ops-preset"]`、
`unmapped` 组 1 成员；`.agent-presets/agint-ops/preset.yml:1` 写明「智进子 preset」。

**改了什么**：`FAMILY_GROUPS` 的 `preset` 组（`AGENT预设`）成员表追加
`agint-ops-preset`，排在其余三个 preset 之后（组内按成员表顺序渲染，追加不影响既有下标）。

**测试**：smoke fixture 增补 `agint-ops-preset` 一行，断言它落进 `preset` 组且
`declared:true`；兜底组断言同步为只收 `agint-mystery` 一行。smoke 14 组 PASS。

## 0.1.3 — 2026-10-01

### 终止开关（`dsh-kill-switch`）并入 agint 家族

**为什么**：终止开关是独立 DSH bundle（`bundles/dsh-kill-switch`，包名
`@local/dsh-kill-switch`），按 bundle 规范不落在 `plugins/agint-*` 命名空间。
`splitFamily` 的三条判据全是 `agint-` 前缀，于是它在面板上被划进 host 名册——
实机确认：家族 39 行里 `/kill-switch/` 零命中，而它确实在跑（host loader entry
`include:dsh-kill-switch`；客户端 dock slot occupant `dsh-kill-switch` active:true）。
**跑得好好的组件，在家族视图里不存在。**

**改了什么**：

- 新增 `EXTERNAL_FAMILY_MEMBERS`（当前仅 `dsh-kill-switch`）：家族成员 =
  `agint-` 命名空间 **+ 这张显式外部名单**。判据是 module 名**精确匹配**。
- `FAMILY_GROUPS` 新增 `{ id: 'host-lifecycle', label: '宿主生命周期' }`，
  收纳 `agint-restart` 与 `dsh-kill-switch`；`agint-restart` 同时从 `infra` 组移出
  （同列一组的行若在两处重复列出会在面板上重复计数）。
- `groupFamily` 匹配成员时**先查 entry id、再查 module 名**。

**过程中被 smoke 抓到的真 bug**（先写 id 匹配时）：分组表按 entry id 命中，
而外部 bundle 的 entry id 带 dsh 的 composition-only `include:` 标记，于是该行
虽然归了族、却落进「未归类」兜底组。取证：`include:` 是组合期标记，dsh 自己的
`dsh-client-ui-settings-plugin-inventory/lib/client.js:131` 注释原话即
"composition-only `include:` marker"，且它显示前也要剥掉。因此没有把这个标记
写进分组表，而是加 module 名兜底——分组表保持可读，展示 id 保持 loader 原样。

**测试**：smoke 增至 14 组。第 14 组含正负样本 ——
正样本照抄实机那一行的真实形状（`id: include:dsh-kill-switch` /
`name: @local/dsh-kill-switch`），断言它落进宿主生命周期组、`declared:true`、
家族计数增量恰好 1、host roster 分母不变；负样本用 `dsh-twin-preset` 与
`dsh-kill-switch-extra` 两条前缀相近的行，断言它们**不**被拖进家族（白名单是
精确匹配，放宽成前缀就会把别的 bundle 一并吞掉）。另有断言确保 `agint-restart`
不会同时出现在两组。

**未做**：全量运行时 roster 的逐行复算。`Config.listConfigs` 的分页参数在本机
bridge 过不去（`limit` 恒报 `must be a number`），拿不到 239 行明细；替代证据是
面板全量计数对比，见下方真机验收记录。

**真机验收**（2026-10-01，`requestId=0bdcad50` 重启后实测
`GET /api/agint-family/status`）：

| 项 | 改前 | 改后 |
|---|---|---|
| `counts.total` | 39 | **40**（增量恰好 1） |
| `hostRowCount` | 239 | **239**（不变） |
| `counts.active` | 39 | 40 |
| 「宿主生命周期」组成员 | 组不存在（restart 在 infra） | `agint-restart`, `dsh-kill-switch` |
| infra 组是否仍含 `agint-restart` | 是 | **否** |
| `dsh-kill-switch` 所在位置 | 不在家族（落 host 名册） | 宿主生命周期组，`declared:true` |
| `unmappedIds` | `["agint-ops-preset"]` | `["agint-ops-preset"]`（未变） |

**`total` 增量恰好 1 且 `hostRowCount` 239 未变**，即全量口径上只多认了终止开关
一行，其余 238 条 host 行没有一条被卷进家族 —— 这正是上面「未做逐行复算」所缺的
那格证据。

回归确认：重启后 `conversation.composer.dock` 的 occupant `dsh-kill-switch`
仍 `active:true`（本插件只改只读统计，未触碰终止开关本体）。
`agint-ops-preset` 落 unmapped 是既有问题，与本次改动无关，未处理。

## [Unreleased]

### 测试加固（无功能变更）

- **假 ctx 改用 Proxy 复刻 cordis 语义**：`makeCtx()` 此前返回带 `config` 的普通
  对象 —— 读未注入属性静默返回 `undefined`，于是 0.1.0 那个
  `apply(ctx){ ctx.config }` 的 bug **本地 11 组全绿、真宿主直接拒绝加载**。
  现在白名单外的属性读取一律抛
  `cannot get property X without inject`，`config` 明确不在白名单（它是 apply
  第二参数，绝不能从 ctx 上读）。
- **新增第 13 组断言（cordis 契约）**：先断言陷阱已武装（`ctx.config` 读取必抛），
  再断言 `apply` 在陷阱之上仍能跑完 —— 缺任一都说明测试在放水。
- **反向对照已做**：把 `void ctx.config` 塞回 `apply` 第一行，测试在第 4 组即抛
  `cannot get property config without inject`（与真宿主报错一致），确认新断言
  真能抓到该类回归；验毕还原源码，smoke 12 组 PASS。

## 0.1.2 — 2026-09-29

### 分组语义修正

- **「未归类（分组表待补）」组中的三个 AGENT 预设插件归位**：agint-preset、
  agint-blockchain-preset、agint-investor-preset 此前不在分组表（label map），
  落入 unmapped 兜底组（declared:false）。新增分组
  `{ id: 'preset', label: 'AGENT预设' }` 收纳三者，面板上显示为「AGENT预设」，
  declared 转 true；unmapped 兜底组保留，仅收纳真正未入表的 agint-* 行。
- smoke 测试同步：fixture 增补 agint-preset（断言落入 preset 组、declared:true）
  与 agint-mystery（断言 unmapped 兜底只收未入表行、unmappedIds 正确）。

### 验证

- smoke 11 组 PASS；浏览器实测 8 组（memory/governance/evolution/quality/
  closed-loop/execution/infra/preset），三个 preset 成员 declared:true。

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
