# agint-family-panel

AGINT 家族面板 —— 以**宿主原生停靠面板**形态展示整个 AGINT 插件家族：分组、行状态、通电信号。

- 版本：v0.5.0（2026-10-23 新增「提案台 · 人工审批」，全插件第一个也是唯一一个写通道；v0.4.0 新增「单插件档案页」下钻；v0.3.0 新增「神谕 · 美之判词」分区；v0.2.0 于 2026-10-04 v2 整页上线；v0.1.0 于 2026-09-29 首次挂载）
- 形态：双半插件（host 半 + 浏览器半）
- 席位：侧栏 `sidebar.panellist` 入口行 + root 作用域 `main` keyed slot 面板页

## 是什么

| 半 | 文件 | 职责 |
|---|---|---|
| host | `lib/index.js` | 开三条**只读回环**路由：`GET /api/agint-family/status`（v1 快照）、`GET /api/agint-family/v2`（v2 整页 HTML）、`GET /api/agint-family/v2/data`（v2 实时聚合 JSON，TTL 30s + mtime 缓存）；不碰 DOM |
| host | `lib/v2-scan.js` / `lib/v2-data.js` | v2 数据层：源码扫描（L0.5 真源，code/comment/umbrella 三分类 + manifest 声明补边）+ storages 三源聚合 + 声明消费契约（`consumes` ∪ `optionalInject`，同时作补边白名单）；每源独立降级，不装绿 |
| host | `lib/v2-dossier.js` | **单插件档案数据层**（v0.4.0）：汇拢一个 id 的**全部物理位置**，读 manifest 契约 / package 身份 / CHANGELOG 变更史 / 代码体量，产出可核对的 `drift`（版本分裂、契约与代码分家、声明了没自述） |
| host | `lib/v2-owners.js` | **归因表单一事实源**（工具名前缀 / cron id / 宿主键），随 `payload.owners` 下发；整页视图与档案页都从这里取，不再各写一份常量 |
| browser | `lib/client.js` | 注册到宿主自带席位；停靠面板**默认内嵌 v2 视图**（iframe 走文档相对 `api/agint-family/v2`），一键可切名册视图（按钮文案「切换到家族名册」；分组/行状态/信号）；**名册每行可点 → 该插件的档案页**；不接管任何宿主 DOM |
| asset | `assets/panel-v2.html` | v2 整页前端（待办 / 神谕判词 / Q1 依赖拓扑 / Q2 实测产出 / Q3 腐化判定 / 事件链 / 伞键清单），fetch `/v2/data` 渲染 |
| host | `lib/index.js` 的 `collectOracle` | 神谕层取数：服务面（`cards`/`history`/`getState`/`status`）优先，空段用落盘补齐，补齐原因写 `notes` |
| host | `lib/v2-proposals.js` | **提案台数据层**（v0.5.0）：服务面 `agint.evolve.listProposals()` 优先、`agint_evolve.json` 兜底；正文分节解析 + 引用路径/符号提取 + 存在性核对；队列年龄与分类/来源聚合 |
| host | `lib/index.js` 的 `POST /api/agint-family/proposal/decision` | **全插件唯一写入口**：批准 / 拒绝 / wontfix / 改判，转发 `agint.evolve.setStatus()`，不碰存储文件 |

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
| `agint.aestheticOracle` / `storages/agint_aesthetic_oracle.json` | 神谕层判词、三档评分、广播史、状态面（服务面优先，卡片空时回落落盘） | `unavailable`/`error` + reason；运行态开关标 unknown |

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

## 神谕层分区（0.3.0）

侧栏面板的分区条多了「神谕 · 美之判词」，位置在**待办之后、Q1 之前**。

**为什么放这儿**：待办与神谕都是**结论面**（「你要动手什么」/「系统现在如何」），
Q1/Q2/Q3 是证据面。结论先看，证据在后。默认分区仍是 Q1，不改既有习惯。

**它转录什么**（只读，不重算分数、不改判定）：

| 块 | 来源 |
|---|---|
| 判词（最新卡片全文） | `oracle_cards` 的 `oracle.daily`；无 daily 退 weekly → monthly → alert |
| 三档评分 | `oracle_cards` 四个 topic 各一格 |
| 状态面 | `oracle_state.latest` + 服务面 `status()` |
| 广播史（最近 20 条） | `oracle_broadcasts`，失败与被静默的行不隐藏 |

**两路取数**：服务面 `agint.aestheticOracle`（`cards` / `history` / `getState` /
`status`）优先，落盘 `storages/agint_aesthetic_oracle.json` 兜底。
`cards()` 为空时用落盘卡片补齐，原因写进面板黄条 —— 订阅没回写是常见形态
（event-bus 未挂载 / 订阅被拒），只读服务面会把「订阅掉了」显示成「神谕从没开过口」。

**Δ 基线的红线**：生产 `baseline` 建于 2026-10-04，评分公式 r3 于 2026-10-09 落地，
而 `oracleStateSchema.baseline` 没有 `formulaVersion` 字段 ⇒ 跨口径。
Δ 照算，但一律标「不可比」+ 原因。⛔ 不把「缺标记」当「同版本」。

**已知限制**：

- 判词正文只存在 `oracle_cards` 的最新一张里。`oracle_broadcasts` 只存
  score / verdict / worstKey，**不存判词文本** ⇒ 回看某一轮的原话做不到。
  要保留全文得改 oracle 侧存储，不在本插件职责内。
- 提案只显示计数（`proposals`）。内容与流转走 `agint.evolve.listProposals`，
  面板不复制那套状态机。（v0.5.0 起内容在「提案台」一节展开，见下；状态机仍归
  `agint-evolve`，面板只转发 `setStatus`。）

## 提案台 · 人工审批（v0.5.0）

**位置**：分区条第二格，紧跟「待办」。两格都是**队列面**（现在有什么等着人处理），
先看积压、再动手，证据面（Q1/Q2/Q3）在其后。

### 为什么做这一节

2026-10-23 实测三件事，都指向同一个缺口：

1. **队列只进不出**：`proposal` 表 95 行里 53 行挂 `proposed`，最老的 43 天。
   唯一的状态出口是手动工具 `evolve_set_status`，而 `evolution-cycle` 从不下调
   （driver 全库无 `setStatus`）⇒ 提案攒着，没人有地方落笔。
2. **表在说假话**：抽查 20 条 `proposed`，**10 条与代码事实不符**（早已落地）。
   拿这张表排优先级，等于把做完的事再排一次队。
3. **状态机缺一档**：原四档 `proposed / applied / rejected / wontfix` 里，
   `applied` 的语义是**已落地**。人工批准无处表达 —— 写成 `applied` 就是把
   「点头」记成「做完」。故 `agint-evolve` v0.8.0 补 `approved`（已批准待执行）。

### 批准之后去哪儿了

`approved` 不是终点。**待办**一节因此多了一行「已批准待执行（工作单）」
（`PENDING_SPECS` 的 `evolve-approved`，kind=`action`）：
批准过的提案从「待批」挪进这一行，落地后标 `applied` 才算消失。

⛔ 没有这一行时，批准 = 从待办里消失 —— 决定做完了却没人去做，比不批更糟。
⚠️ 这一行只统计，不自动执行：落地仍要人（或会话里的 AI）真的动手。

### 「批准了」不等于「现在能做」（v0.6.0，2026-10-27）

批准的是**方向**。前置没到位时（等样本攒够、等依赖落地），它不该以工作单的形态
催人动手。`agint-evolve` v0.9.0 给提案加了 `blocker`（卡在什么上）与
`unblockCondition`（等什么满足），面板据此把 approved 拆成两行：

| 行 | kind | 判据 | 人能做什么 |
|---|---|---|---|
| 已批准待执行（工作单） | `action` | `approved` 且无 `blocker` | 直接动手，落地标 `applied` |
| 已批准·阻塞中（等前置） | `supply` | `approved` 且有 `blocker` | 只有等；条件满足后清 blocker 回到工作单 |

⛔ 阻塞中的**不隐藏**：卡在哪、等什么必须印在条目上，否则又退回「批了没下文」。
实例：提案 `a85ef850`（权重真标定）批了，但周报冻结权重常量、等 8-12 周标注样本 ——
它在第一行挂了二十天后被归到第二行，原因与解锁条件都写在行里。

### 一屏回答三件事

| 屏 | 答什么 | 依据 |
|---|---|---|
| 统计条 + 队列年龄条 | 积压多深、老到什么程度 | `counts.aging`（待批口径，7 天 / 8–30 天 / 30 天以上三段） |
| 列表行 | 这条值不值得现在处理 | 状态、分类、年龄、**正文分节 3/5**、证据线索、来源 |
| 展开行 | 它的目的、方案、价值、风险、关联 | 正文五节原文 + 元信息 + 证据栏 + 决策区 |

**正文分节为什么进列表**：正文是 markdown，不是结构化字段。95 条里 49 条有「改动方案」、
61 条有「预期收益」，但仍有相当一部分一条小节都没有。**没分节的提案基本无法评审**，
列表里直接给「0/5」，让人一眼跳过而不是点开才发现。

### 证据栏：只报事实，不下判定

对每条提案，从正文里抽两类**可核对**的东西：

| 抽什么 | 怎么抽 | 怎么核对 |
|---|---|---|
| 路径 | `plugins/x/lib/index.js`、`README.md:85`、`D:\...\AGENTS.md` | 归一化到仓库相对路径（认 `DSH-AGINT/` 之后的锚），`statSync` 判存在 + 给 mtime |
| 符号 | 反引号里的标识符（要求带 `_` / 驼峰 / 长度 ≥ 10） | 在**引用到的那些文件**里 `indexOf` |

三档线索，措辞一律「可能」：

- `stale`：引用的路径**全部不存在** ⇒ 描述的文件布局已过期。
- `maybe-done`：符号在引用文件里**命中** ⇒ 可能已落地，需人确认。
- `neutral` / `unknown`：路径在但符号未命中 / 没有可核对的东西。

⛔ 刻意不做的三件：

1. **不判「已落地」**。符号命中可能是同名残留，也可能在别处定义。判定是人给的。
2. **不把「没法核对」写成「不存在」**。wiki 仓路径（`AGINT.wiki/*`）是另一个 git 仓，
   标 `exists:null` + 原因；写成 `false` 就是把「我没看」说成「它不在」。
3. **不收通用符号**。`status` / `note` / `VERSION` / 全仓同名 ≥2 处的标识符一律不计，
   命中率 100% 的线索等于没有线索。实测因此把 95 条里 18 条「疑似已落地」降到更可信的一批。

### 写通道（全插件唯一）

```http
POST /api/agint-family/proposal/decision
content-type: application/json
x-agint-panel: 1

{ "id": "<proposal id>", "status": "approved|rejected|wontfix|applied|proposed", "note": "理由" }
```

四道门，缺一不可：

| 门 | 判据 | 不过时 |
|---|---|---|
| 回环 | `socket.remoteAddress` ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1} | 403 `loopback-only` |
| 自定义头 + 同源 | `x-agint-panel: 1`；`Origin` 若存在必须与 `Host` 一致 | 403 |
| 类型与体积 | `content-type: application/json`；body ≤ 4KB | 415 / 413 |
| 状态白名单 | 五档枚举；`rejected` / `wontfix` **必须带理由**，`applied` **必须带落地证据**（≥2 字） | 400 |

过了门才碰服务：`ctx.get('agint.evolve').setStatus(id, status, note)`。
**面板从不直接写 `agint_evolve.json`** —— 原子写、版本号、后续迁移都归存储域管。

三条数据纪律：

1. **`note` 是账本，不是便签**。`applied` 行的 note 是落地证据，改判时**追加**不覆盖
   （`｜ 原记录：…`）；上一版已是面板记录时替换而非叠加，避免连续改判把 note 撑爆。
2. **幂等**。目标态与现状相同 → `changed:false`，不落库、不刷 `updatedAt`。
3. **写完重取**。前端不做本地乐观更新 —— 就地改状态会让面板显示「我以为的结果」。

### 服务缺席时

`agint.evolve` 是 `optionalInject`。未挂载 / 版本过旧时，读走 `agint_evolve.json` 兜底，
写路由返回 **503 + 原因**，面板据此提示「写不了」，而不是让人点了没反应。

### 测试

```sh
node --test plugins/agint-family-panel/test/v2-proposals.test.mjs   # 数据层 17 条
node --test plugins/agint-family-panel/test/proposal-board.test.mjs # 渲染与审批流 10 条（vm + 迷你 DOM）
node --test plugins/agint-family-panel/test/decision-route.test.mjs # 写路由 13 条（四道门 + 三条纪律）
```

`proposal-board.test.mjs` 用 `node:vm` 跑页面脚本、用桩元素接 `addEventListener`，
断言的是**事件处理逻辑**（谁能写、写成什么、失败说什么），不是浏览器排版。
`decision-route.test.mjs` 的 ctx 替身沿用 `smoke.mjs` 的严格代理：未声明属性一律抛错。

## 插件档案页（v0.4.0）

**入口**：停靠面板切到 v1 名册 → 点任意插件行。档案是名册的**下钻层级**，不是第三个
并列视图：`← 名册` 返回，页尾有上/下邻居。

**为什么做在名册而不是整页视图**：名册就是「家族有哪些插件」的列表，点行打开这一行的
档案是最短路径；整页视图答的是横向对比（Q1/Q2/Q3），不承载单实体。

**六段，顺序 = 从身份到判断**：

| 段 | 答什么 | 数据来源 |
|---|---|---|
| 它自己说它是什么 | 首句职责 + 完整自述（折叠） | manifest / package 的 `description` |
| 分量 | 代码行数 / 提供服务数 / 取用服务数 / 被依赖插件数 | `v2-dossier` 代码体量 + `scan` 边 |
| 契约 | `provides` 逐条 + `serviceDocs` 原文；inject / optionalInject / consumes / events / tools / 存储域 / 权限 / 生命周期 / 测试入口 | `manifest.json` |
| 接线 | 取用（服务 / 提供方 / `文件:行号`）+ 依赖它的插件（前 8，余下折叠）+ 声明与代码的对差 | `scan.hits` |
| 产出 | 30 天工具调用与失败率、bus 发布、cron 任务、7 天曲线、最近活动 | storages 三源 |
| 债 | 结构差异（版本分裂 / 契约与代码分家 / 无 manifest…）+ 注释命中 + 无提供方 | `v2-dossier` 的 `drift` + `scan` 分类 |
| 变更史 · 位置 | CHANGELOG 最近 6 版；同一 id 多物理位置时列主/次 | `CHANGELOG.md` / 目录扫描 |

**三条判据纪律**：

1. **取不到就说取不到。** 无 manifest → 契约段写「不可得」并说明只剩身份与代码；
   无版本 → 显示「版本未读到」，不填 `0.0.0`；无产出 → 说「30 天无可归因产出」并
   给出三种可能（只提供服务 / 事件触发 / 归属表未覆盖），不写 0 了事。
2. **一个 id 可能有多个物理位置。** 实测 `plugins/agint-quality-eval`（0.3.3，**无 lib**）
   与 `plugins/agint-quality/agint-quality-eval`（0.3.5，**有 lib**）并存。档案取
   **有代码那份**作主位置，manifest 可从另一位置汇拢并注明 `contractSource`，
   两处版本不同报 `dup-stale`。⛔ 不替人决定哪份是「对的」——那是挂载行的权限。
3. **只收可核对的差异。** 版本号不等、文件缺失、契约与代码分家、声明了没自述 ——
   这些能跑命令复核。判断「写得好不好」是神谕层的活，档案不做。

**性能取舍**：档案复用 `/v2/data`（单次 ~180KB，60s 进程内缓存），**不另开路由**。
另开要么重算一遍（两套口径必然漂），要么做切片（筛选条件又是一套口径）。
代价是首点一次的网络往返，本地回环可忽略。

**测试**：`test/v2-dossier.test.mjs`（数据层 11 条）+ `test/dossier-view.test.mjs`
（渲染 13 条）。后者用 `createElement` 替身加载浏览器半，断言「少哪一节、字段读错、
把取不到画成 0」—— 这三类错误在真宿主里要重启才能发现，在这里一条断言就能钉住。

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
node --test plugins/agint-family-panel/test/v2-dossier.test.mjs    # 档案数据层（11 条）
node --test plugins/agint-family-panel/test/dossier-view.test.mjs  # 档案页渲染（13 条）
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
