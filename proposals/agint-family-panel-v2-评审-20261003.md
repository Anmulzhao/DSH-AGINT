# 提案评审报告：agint-family-panel v2（从手维护名册到派生视图）

> 评审日期：2026-10-03
> 评审对象：`D:\DSH\project源码\DSH-AGINT\proposals\agint-family-panel-v2.md`
> 取证范围：部署位 `~/.dsh/profiles/web/plugins/`（37 个插件目录、34 个 manifest、面板 lib/index.js 全文、CHANGELOG 全文、preset 组合文件 agent.cordis.yml、event-bus bus.js）

## 0. 结论先行

1. **方向认可**。删手维护分组表、从数据派生视图，是对的。CHANGELOG 0.1.2 / 0.1.3 / 0.1.4 三个版本全部在补表，证明静态表必然腐烂。
2. **三处关键事实需要修正**。实测推翻提案的三个隐含假设：manifest 结构不统一、服务边建不出、事件边建不出。
3. **三个设计缺口需要补齐**。判据与兜底矛盾、验收口径失效、缓存失效机制缺失。
4. **决策请求 3 有明确建议**。不自动喂 evolve，但可加只读导出出口。

## 1. 提案论断核实结果

| 提案论断 | 我的实测结果 |
|---|---|
| FAMILY_GROUPS 手维护静态表（index.js:91-102） | 属实。逐行数出 10 组 43 个成员名字 |
| CHANGELOG 0.1.2 / 0.1.3 / 0.1.4 全在补表 | 属实。读过 CHANGELOG 全文 |
| 面板一个 manifest 都没打开 | 属实。lib/index.js 425 行无 manifest IO |
| 3 个通电信号（cron / metrics / selfModel） | 属实（index.js:319-325） |
| 客户端 60 秒轮询 | 属实（client.js:43，REFRESH_MS=60000） |
| README:114 已知限制 | 属实 |
| manifest 的 agint 段 100% 存在 | 属实（34/34） |
| abtest manifest tools=[] 但 preset 挂 3 工具 | 属实（agent.cordis.yml:387-388） |
| U1「consumes 覆盖率未证实」 | 本次已证实：3/34（8.8%） |

## 2. 关键反证（实测数据）

### 2.1 manifest 结构不统一（提案只读了一个样本）

实测 34 个 manifest：

- **31 个**是 `spec.cordis` 包裹风格（evolution-driver 式）。
- **3 个**是顶层 `cordis` 风格（agint-abtest / agint-quality-sandbox / agint-quality-static）。
- **3 个插件没有 manifest**：agint-quality（聚合容器目录，子插件各有 manifest）、agint-search-tools、agint-session-extract。

影响：步 1 的解析器必须处理三种形态。只按 evolution-driver 一个样本写读取路径，会漏 6 个插件。

### 2.2 服务边建不出来（最重的反证）

提案的建边规则：「A 的 provides 与 B 的 inject / optionalInject 按服务名对上」。

实测 34 个 manifest 的 inject 值：

- `storageDomain` ×17、`tools` ×3、`webServer`、`timer`、`sandbox`、`agents`。全是宿主服务。
- **agint.* 家族服务引用只有 10 条**（5 个插件：compress-guard / dream / memory-provider / mount / self-model）。

家族服务依赖的真源是 `consumes` 字段（覆盖率 8.8%，3 个插件写了）+ 代码里的 `ctx.get('agint.*')` 运行时调用。

**按提案规则只能建出约 10 条服务边，不是「40 节点关系图」。**

含义：

- 依赖图要么稀疏（10 条边）。
- 要么先补齐 31 个插件的 consumes。这是新形式的手维护，不是「零手维护」。
- 要么用运行时探测记录 ctx.get。这属于 L1 手段，不是 L0。

提案的「零手维护」承诺不成立。需要重新定位 L0 的能力边界。

### 2.3 事件边建不出来

实测：

- `subscriptions`：只有 2 个插件声明非空（aesthetic-oracle 订阅自己的 oracle.*；ov-strategy 订阅 dream.completed / diagnosis.completed）。
- `events`：15 个插件声明 70+ 个 topic。
- event bus 实测 deliveries：66 条事件里只有 1 条带 deliveries（memory.provider-activated → agint-compress-guard）。
- deliveries 语义（bus.js:90-110）：只有发布时刻存在匹配订阅者才记录。订阅表是模块级 Map（bus.js:16），重启即重建。

含义：Q1「生产者 → 消费者链」在 L0 无声明、L1 只有 1 条链。照实显示会是一张几乎空的图。这满足「真实」，但不满足老板要的「关系与流程可视化」。**Q1 需要重定位**（见建议 3）。

## 3. 改进建议

按提案步骤编号。每条先写结论，再写动作。

### 建议 0（新增）：先做 manifest 普查，再写解析器

1. 产出 34 个 manifest 的字段普查表（本报告已给出主体数据）。
2. 解析器支持三种形态：spec.cordis、顶层 cordis、无 manifest。
3. 无 manifest 的 3 个插件列为已知清单，写进测试 fixture。

### 建议 1：家族成员判据三态化，与「无主插件」解耦

1. 正式成员：manifest 存在且含 agint 段。
2. 显式成员：EXTERNAL_FAMILY_MEMBERS 兜底名单命中（dsh-kill-switch）。
3. 无主插件：挂载 + 无 manifest + 不在兜底名单。
4. 原因：dsh-kill-switch 无 manifest 但走兜底。提案现在会把它同时报成「家族成员」和「无主插件」，双报矛盾。

### 建议 2：重定义步 1 验收口径

1. 新判据下 counts.total 必然不是 40（3 个无 manifest 插件掉出正式家族）。
2. 验收改为三项断言：正式成员数、无主清单 = {agint-quality, agint-search-tools, agint-session-extract}、兜底行 = {dsh-kill-switch}。
3. FAMILY_GROUPS 有 43 个名字而实机 40 行。分组表自己也在漂移。这是删表的补充证据。

### 建议 3：Q1 重定位——服务拓扑为主，事件链为辅助

1. 主视图：服务依赖拓扑（provides ↔ 运行时 ctx.get 探测 + consumes 合并）。
2. 事件链：只显示有 deliveries 的 topic（当前 1 条），并标注「已订阅但从未收到消息」的关系。
3. 事件订阅的实时查询需要 event-bus 补一个只读接口。订阅表当前是模块级 Map，无查询出口。
4. 这样 Q1 既诚实（照实显示空事件流）又有用（服务拓扑才是家族的真实耦合）。

### 建议 4：工具归属用三源合并

1. 源 A：manifest 非空 tools 字段（15 个插件）。
2. 源 B：preset 组合文件的 agint-X-tools 挂载行（已确认大量存在）。
3. 源 C：host tools 服务实测（建议 5 验证 API）。
4. 产出归属覆盖率基线表。无法归属的工具归 host 内建，单列。

### 建议 5：U4 验证路径明确化

1. 已证实：`ctx.tools` 是合法注入名（memory-provider / rules / tool-stats 三个插件已用），`tools.register()` 与 `tools.get(name)` 存在（memory-provider manager.js:1239）。
2. 待确认：tools 服务是否暴露「枚举全部注册工具」与「注册者归属」。
3. 若只有 get(name)：工具归属仍要靠命名前缀 + preset 挂载行。L2 的「隐藏耦合」判据要降级为「无法归属时标 unknown」。

### 建议 6：补 manifest 缓存失效机制

1. TTL 30 秒是对的，但不够。
2. 记录 manifest 的 mtime / version。变化即失效重读。
3. 插件更新后面板 30 秒内显示旧图。可接受，但要有 observedAt 标注。

### 建议 7：L2 增加对称判据

1. 现有「隐藏耦合」：有实测流量，无声明。
2. 补「声明无流量」：有声明，无实测。两条一起才能判断架构腐化方向。
3. 当前数据下「声明无流量」会大量命中（15 个插件声明 events，多数无 deliveries）。这本身就是重要信号。

### 建议 8：决策请求 3——不自动喂，加只读导出

1. 认同不自动喂 evolve。
2. 加一个只读出口：把 Q3 异常清单导出为 evolve 提案草稿（Markdown / JSON）。
3. 老板一键确认后再提交。不破坏只读不变量。

### 建议 9：补面板自身健康信号

1. manifest 解析失败数。
2. 缓存命中率。
3. 各数据源 observedAt 覆盖。
4. 原因：面板现在是家族的可观测面。它自己的不可观测，本身就是盲区。

## 4. 未证实项状态更新

| 项 | 提案状态 | 本次状态 |
|---|---|---|
| U1 consumes 覆盖率 | 未证实 | **已证实**：3/34（8.8%）。依赖边只能靠 inject/provides + 运行时探测 |
| U2 avg/p95 恒 0ms | 未证实 | 维持。延迟指标不进面板，处理正确 |
| U3 家族是否本应用事件总线 | 未证实 | 部分回答：events 声明 15 插件、subscriptions 仅 2 插件。事件总线是辅助信号。设计文档仍缺 |
| U4 ctx.get('tools') 归属 | 未证实 | **高置信可行**：ctx.tools 已证存在（register / get），inject 'tools' 已证合法。待确认 list / 归属 API |
| U5 roster 逐行复算 | 未证实 | 维持 |

## 5. 决策请求回答

1. **架构定性**：认。但步 1 范围必须含三态解析器与判据修正（建议 0-2）。
2. **范围**：先做步 0 + 步 1。步 2 前置 U4 验证（建议 5）。步 3 前置步 2 归属可靠（提案已写明，认同）。
3. **Q3 喂 evolve**：不自动喂，认同。加只读导出（建议 8）。

## 6. 一句话总结

提案的「该删手维护表」是对的，但「manifest 能零维护地给出依赖图」是错的。依赖契约（consumes / subscriptions）在家族里覆盖率不足 10%。按提案现在的 L0 设计做，会得到一个几乎空的图。把依赖图的真源从「manifest 声明」改成「运行时实测 + 声明对照」，再配三态解析器，这个提案才立得住。
