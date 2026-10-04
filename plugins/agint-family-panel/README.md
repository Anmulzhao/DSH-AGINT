# agint-family-panel

AGINT 家族面板 —— 以**宿主原生停靠面板**形态展示整个 AGINT 插件家族：分组、行状态、通电信号。

- 版本：v0.2.0（2026-10-04 v2 整页上线；v0.1.0 于 2026-09-29 首次挂载）
- 形态：双半插件（host 半 + 浏览器半）
- 席位：侧栏 `sidebar.panellist` 入口行 + root 作用域 `main` keyed slot 面板页

## 是什么

| 半 | 文件 | 职责 |
|---|---|---|
| host | `lib/index.js` | 开三条**只读回环**路由：`GET /api/agint-family/status`（v1 快照）、`GET /api/agint-family/v2`（v2 整页 HTML）、`GET /api/agint-family/v2/data`（v2 实时聚合 JSON，TTL 30s + mtime 缓存）；不碰 DOM |
| host | `lib/v2-scan.js` / `lib/v2-data.js` | v2 数据层：源码扫描（L0.5 真源，code/comment/umbrella 三分类）+ storages 三源聚合 + manifest consumes；每源独立降级，不装绿 |
| browser | `lib/client.js` | 注册到宿主自带席位；停靠面板**默认内嵌 v2 视图**（iframe 走文档相对 `api/agint-family/v2`），一键可切 v1 名册（分组/行状态/信号），另有「新标签页打开」逃生口；不接管任何宿主 DOM |
| asset | `assets/panel-v2.html` | v2 整页前端（Q1 依赖拓扑 / Q2 实测产出 / Q3 腐化判定 / 事件链 / 伞键清单），fetch `/v2/data` 渲染 |

它**不是**独立窗口、**不是** iframe、也不是第三方侧栏里的一个 tab：

- 页壳（`@deepseek-ai/dsh-client-ui-layout` 的三栏 AppFrame）拥有行盒子、标签、高亮、
  折叠轨、面板切换与窗口 chrome 交互 —— 和官方 Plugins / Schedule 页走同一套容器；
- 本插件只提供「行图标」和「页面组件」两个组件，其余全部由宿主渲染。

## 席位契约（改这里前必读）

```js
// 入口行：shell 的全局面板列表
slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: 'AGINT 家族' }, PanelIcon)
// 面板页：root 作用域的 main keyed slot
slots.register({ name: 'main', key: PANEL_ID, inject: () => ({ ctx }) }, FamilyPanel)
```

- ⛔ **同一个 id 寻址两个席位**：`sidebar.panellist` 的 `id` 就是 `main` 的 `key`。
  两者不一致 = 点行切不到页面（sidebar 契约明写：选不存在的 main 条目会抛错并保留当前面板）。
- ⛔ **一律走 `ctx.slots.inject`**：席位由壳插件声明，本包不在运行时依赖它们。
  宿主没声明席位 → 回调永不执行 → 面板静默不挂。**绝不拖垮 GUI 启动**。
- 席位切换是布局服务的活：`ctx.layout.selectPanel(PANEL_ID)` / `selectPanel(null)` 回会话。
  本插件不做任何 DOM 抢占。
- 尺寸自适应：`main` 页由框架给宽（中栏保底 400px），面板内部用
  `grid-template-columns: repeat(auto-fill, minmax(260px, 1fr))` + `min-width: 0`，
  窄到单列也不溢出；入口型页面遵守 `--dsh-frame-top-clearance` 顶部让位。

## 外观一致性纪律

- 只用 `--dsw-alias-*` 主题 token（`label-*` / `bg-*` / `border-*` / `state-*`），
  明暗主题自动跟随宿主；字面色只作为 token 缺失时的兜底。
- ⛔ 禁止 `require('@deepseek-ai/dsh-client-ui-*')` —— 那些不是 API 面，随时变，
  且抛错的组件会把整个 slot 条目打空（`slot entry crashed`）。控件自己写。
- 不替换 app root，不往 `document.body` 追加第二个应用。

## 数据源与降级（真实 > 讨好）

| 源 | 用法 | 缺席时 |
|---|---|---|
| `ctx.loader.entries()` | **权威名册**（patch 只说明"要什么"，loader 才说明"挂上了什么"） | `rosterError` 显示原因，名册空 |
| `agint.cron.list()` | 任务数 + 从未跑过的数量 | `unavailable` + reason |
| `agint.metrics.summary()` | 指标条数 + meta 是否就位 | `unavailable` + reason |
| `agint.selfModel.stats()` | 首个数值字段 | `unavailable` + reason |

三条硬规矩：

1. **读不到就报"未读到"，绝不用 0 冒充绿。** 状态点里 `unknown` 是琥珀色，不是绿色。
2. **挂载 ≠ 通电。** 行状态直接取 loader 的 `runtime.status`，`failed` 就是红。
3. **分组表只是标签映射，不是白名单。** 名册里没被归类的一律进「未归类」组并在面板底部列出 id，
   新增插件会显示成"待补"，不会静默消失。

4. **谁算家族成员，判据只有命名空间 + 一张显式外部名单。** `splitFamily` 收
   `agint-` 前缀（entry id 或 module 名），外加 `EXTERNAL_FAMILY_MEMBERS`。
   **不是**"凡是没进已知 host 插件表的就算家族"——实机 host 名册 239 行对家族 39 行
   （2026-10-01），判据一放宽就会把绝大多数 host 行卷进面板。当前外部名单只有
   `dsh-kill-switch`（终止开关，见下）。

## 家族外部成员：终止开关

终止开关（`bundles/dsh-kill-switch`，包名 `@local/dsh-kill-switch`）是**独立 DSH
bundle**，按 bundle 规范不落在 `plugins/agint-*` 命名空间下，但它是家族的一等公民，
因此进了 `EXTERNAL_FAMILY_MEMBERS`，与 `agint-restart` 同列「宿主生命周期」组
（重启与终止是同一件事的两头）。

判据按 **module 名精确匹配**而非 id 前缀：loader 会给 patch 插入行加
composition-only 的 `include:` 标记（实机 entry id = `include:dsh-kill-switch`，
dsh 自己的 plugin-inventory UI 也要剥掉它才显示），按 id 前缀写会漏，按前缀放宽会误伤。
配套地，`groupFamily` 匹配成员时先查 entry id、再查 module 名，因此分组表里写的是
可读的 `dsh-kill-switch`，而面板展示的仍是 loader 原样的 `include:dsh-kill-switch`。

> 未做过的核对：全量运行时 roster 的逐行复算（Config inspect provider 的分页参数在
> 本机 bridge 过不去）。替代证据是全量计数对比——本机 `counts.total` 由 39 变 40、
> 增量恰好 1，见 CHANGELOG 0.1.3 的真机验收记录。

## kill-switch

```yaml
- id: agint-family-panel
  config:
    enabled: false          # 关闭：路由仍应答 { enabled: false }，面板显示「已关闭」而非「未挂载」
    allowNonLoopback: false # 默认只放行回环；面板载荷含路径与失败原因，不对局域网开放
```

## 验证

```sh
node plugins/agint-family-panel/test/smoke.mjs   # 14 组断言（含降级、kill-switch、外部家族成员正负样本）
dsh --profile web --dump-config | grep -A4 agint-family-panel
```

真机验收（需重启 `dsh web`，bundle 层不热更新）：

1. 侧栏出现「AGINT 家族」行 → 点击 → 中栏显示面板页；
2. 面板顶部时间与刷新按钮可用，"返回会话"回到对话；
3. 明暗两种主题下文字/卡片都可读；
4. 浏览器控制台无 `slot entry crashed`。

## 已知限制

- 面板几何是**瞬时状态**：刷新后右栏/面板选中态重置（宿主既有行为，非本插件限制）。
- 家族分组表是手维护的静态映射，新增插件需补表（未补也会显示，只是归到「未归类」）。
- 首次加载前若宿主半未挂载，页面显示「宿主半未挂载」——这是真实状态，不是 bug。
