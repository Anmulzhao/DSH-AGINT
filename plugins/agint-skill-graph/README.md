# agint-skill-graph

P2-2 技能使用统计与学习图谱，**v0.1.0（Sprint 19 实施）**。

技能有入口（P0-1 技能注册）、有出口（P0-2 策展人管增删改），但中间**没有关系层**：没人回答「这个技能被谁一起用」、「哪几个技能其实在干同一件事」、「新任务该推哪个技能」。

本插件补的就是这一层。它把技能当**图**看——节点是技能，边是技能之间的关系——并为三种下游能力提供冷启动燃料：技能推荐、整合建议、自动创建查重。

## 四类边（§3.2）

| 类型 | 来源 | confidence | 现状 |
|---|---|---|---|
| `related` | `SKILL.md` frontmatter 的 `related_skills`，**声明式** | high | ⚠️ 实现完整，但当前 21 份 SKILL.md **无一份声明** `related_skills` → 0 条。**首选路径**：上游补一行就有一条边，零计算零阈值 |
| `overlap` | 订阅 `curator.overlap-detected`；离线重算复用 curator 纯函数 | medium | ✅ 可用（需 curator 挂载 + 事件有流量；元数据未补齐前无流量） |
| `co_use` | 同会话 30min 窗口内共现 ≥3 会话 | high | ✅ **当前唯一真实产边者**：2026-09-13 实测 4 条（9/5/3/3 会话） |
| `similar` | SKILL.md 元数据相似（描述维 Jaccard） | low | ❌ **默认关**：实测描述维最高 0.201，阈值 0.70 是空集 |

**为什么 v0.3 把首选从「计算型」换成「声明式」**：v0.2 设计稿押注三种计算边（overlap / co_use / similar）。今天回看，`co_use` 已经靠真实流量产出了 4 条边——但 `overlap` 与 `similar` 依然为 0，根因相同：**SKILL.md 元数据缺 `tools`/`triggers` 声明，curator 三维去重跑不出候选**。计算型边里只有不依赖元数据的 `co_use` 活了下来。

结论：**元数据补齐之前，`related`（零成本声明）是唯一能立刻让图谱有内容的路径**；`co_use` 是唯一不依赖元数据、随流量自动生长的路径。两者互补，这就是 v0.3 的排序逻辑。

## 实测条数（2026-09-13，真实数据，铁律 ③）

对**已部署**的真实环境（`$DSH_HOME/.agent-presets` + `agint_tool_stats.jsonl`）跑 count-only 标定期的结果：

| 项 | 值 | 说明 |
|---|---|---|
| tool-stats 总记录 | 7815 | 全历史 |
| `tool === 'skill'` 记录 | 86 | 主口径命中 |
| 无 `skill` 字段被丢弃 | 7729 | `skippedNoSkillField`，如实报出 |
| 技能名不在节点全集 | 10 | `unknownSkillName`（多半是已归档/改名的技能） |
| 进入聚合的调用 | 76 | |
| 节点数（已部署） | **10** | 19 份 SKILL.md 去重 |
| 节点数（仓内 presets） | **11** | 21 份 SKILL.md 去重；**已部署比仓内少 `plugin-preflight` × 3（部署漂移）** |
| 有使用记录的节点 | 5 | `nodesWithUsage=5`，usageRatio 0.5 |
| 投影边数（若转 live） | **4**（全部 co_use） | `lastCalibration.edges=4`，`promotable=true` |
| 已落盘边数（count-only） | 0 | 正式表空，`health=EMPTY` —— 投影与落盘两口径不混 |

co_use 实测明细（每条都带 sessionIds 证据，可审计）：

| 边 | 会话数 | weight |
|---|---|---|
| cordis-plugin-development ↔ editing-cordis-compositions | 9 | 1.0 |
| cordis-plugin-development ↔ memory-discipline | 5 | 0.833 |
| editing-cordis-compositions ↔ memory-discipline | 3 | 0.5 |
| causal-reasoning ↔ memory-discipline | 3 | 0.5 |

这个结果说明**图谱不是空转**：切到 live 立刻能拿到 10 节点 / 4 边、覆盖 4 个技能的可用关系图。但按 §5.3 流程，仍应先让 count-only 跑几周、由老板确认 `lastCalibration` 无异常后再切档。

## 七条不变量（§4.3）

违反任一条即为设计缺陷，`test/contract.test.mjs` 逐条回归。

| # | 不变量 | 为什么 |
|---|---|---|
| 1 | **fail-open，永不 throw** | 图谱是旁路：它挂了不能让周报主链路跟着挂 |
| 2 | **每条边必须带 evidence** | 图谱要能自证。说不清来源的边一律丢弃（`filterValidEdges`） |
| 3 | **只读消费上游** | 不调用 curator 任何写方法，不碰 policy / HARM / evolution 存储 |
| 4 | **不进决策** | 图谱只**建议**（整合走 `agint.evolve.propose`），执行权归 curator + 人 |
| 5 | **主键恒为 `skillName`** | 全仓不存在 `skillId`，不自造第二套 ID 空间 |
| 6 | **零数据必须「响」** | `edges === 0` → `health = EMPTY` + `recommend` 返回 `INSUFFICIENT_DATA`。**禁止兜底、禁止合成数据** |
| 7 | **订阅的事件必须已核实存在** | 每条订阅在测试里 grep 发布方源码；未落地的显式登记（见 `PENDING_TOPICS`） |

不变量 6 是这套设计里最容易被自己破坏的一条。实现中曾把标定期的**投影值**算进 coverage，等于「用预期值让空图看起来有内容」——已修正为 `allEdges = mode === 'live' ? edges : []`，投影只出现在 `lastCalibration` 里。

## 数据从哪来（§3.3）

**主口径**：tool-stats JSONL 里 `tool === 'skill'` 的记录，取 `args.name`。实测 7815 条记录中 86 条命中。

**三个字段恒为 `null`，不编造**：

| 字段 | 为什么取不到 |
|---|---|
| `successRate` | P2-1 轨迹模型无技能维度（`taskRef` 只有 sessionId/cronJob/candidateId/…），做不出技能级成功率 |
| `viewCount` | 技能无「查看」语义，没有数据源 |
| `patchCount` | 技能补丁无计数来源 |

宁可交白卷也不填假数——这三个字段的下游（推荐打分）因此在 `recommendMode: 'list'` 下不参与计算。

## Service：`agint.skillGraph`（FROZEN 6 + 非 FROZEN）

| Service | 说明 |
|---|---|
| `updateFull({ nowMs, trigger })` | 周更全量刷新。**永不 throw**；`count-only` 档只写 meta |
| `getStats(skillName)` | 单技能画像 |
| `neighbors(skillName, opts)` | 邻居边（带 evidence），`opts.types` 可过滤 |
| `clusters(opts)` | 关系簇（内存并查集连通分量，结果带 evidence） |
| `recommend(args)` | 技能推荐。默认 `list` 不打分；覆盖率不足时 `status=INSUFFICIENT_DATA` + `degraded=true`（items 仍返回纯 intentMatch 降级列表，`degradedReason` 说明缺什么，`unavailableTerms` 列出失效的打分项） |
| `getCoverage()` | 覆盖率 + `health`（**EMPTY / SPARSE / OK**，空图必须显式） |
| `listForPrompt(opts)` | Prompt 注入用的紧凑列表 |
| `exportGraph({ format, dir })` | 落 DOT / JSONL，**仅限本地 runtime 目录** |
| `proposeConsolidate(clusterId)` | 把整合候选提交给 `agint.evolve.propose`，**只建议不执行** |
| `setMode(mode)` | 切档。**未跑过标定期切 `live` 直接抛错** |
| `setLlmAnnotation(bool)` | Sprint 20 离线标注开关，默认关 |
| `config(patch)` / `stats()` | 运行时配置（内存态）/ 总览快照 |

## 10 个 preset 工具

读类（裸调）：`skillGraph_stats` / `skillGraph_coverage` / `skillGraph_get_skill` / `skillGraph_neighbors` / `skillGraph_clusters` / `skillGraph_recommend` / `skillGraph_list_for_prompt`

写类（description 首行标注「⚠️ 写操作 · 需人工确认」）：`skillGraph_export` / `skillGraph_set_mode` / `skillGraph_propose_consolidate`

> **门禁现状（如实标注）**：与 curator 同策略——当前 dsh 未见统一的工具级 approval 配置位，写类工具只在 description 标注 + 落审计，未接真实门禁。

## 存储域：`agint_skill_graph`（独占，schemaVersion 1）

| 表 | 上限 | 说明 |
|---|---|---|
| `usage_stats` | 500 | 每技能一行，周更全量刷新（主键 = `skillName`） |
| `skill_edges` | 2000 | 边表（主键 = `edgeId`，同 src/dst/type 覆盖写） |
| `graph_meta` | 1 | 全局元数据单行（`id = 'graph_meta'`） |

超限 **warn 不 prune**，对齐 curator / skill-autocreate 惯例。

## count-only 标定期（§5.3）

**默认档位，什么都不落正式表。** `updateFull` 在标定期只写 `graph_meta`，产出 `lastCalibration` 告诉你「若转 live 会得到多少节点/边」。以下是 2026-09-13 真实环境的实跑输出：

```json
{
  "week": "2026-W37", "nodes": 10, "edges": 4,
  "edgesByType": { "co_use": 4 },
  "promotable": true,            // nodes>0 且 edges>0 才允许切 live
  "provisionalNodes": 0,
  "skippedNoSkillField": 7729,   // 诚实报出「有多少记录没带 skill 字段」
  "unknownSkillName": 10
}
```

**切档护栏**：未跑过标定期调 `setMode('live')` **必须抛错**（对齐 P2-1 不变量）。先看几周 `lastCalibration`，`promotable === true` 再切。

`live` 档下 `coverage` / `health` 反映**已落盘**的图；标定期恒为 `ratio: 0` / `health: 'EMPTY'`——投影只进 `lastCalibration`，两个口径不混。

## 引用不复制

阈值与纯函数**全部从 curator 引入**，本插件不写副本：

| 引用 | 来源 |
|---|---|
| `SKILL_STATES` / `EXCLUDED_DATA_SOURCES` / `isExcludedRecord` | `agint-curator/lib/schema.js` |
| `OVERLAP_THRESHOLDS` / `tokenize` / `jaccard` / `descSimilarity` / `detectOverlaps` | `agint-curator/lib/dedup.js` |
| `parseFrontmatter` | `agint-curator/lib/aggregator.js` |

`similar` 的阈值 `0.70` 与 overlap 的描述维阈值 `0.85` **分开定义**——复用同一个数会制造语义混淆（7 个维度里「像不像」和「重不重叠」是两件事）。

## 挂载

```yaml
# profile patch（顶层 cordis.patch.yml 的 loader list）
- insert:
    - id: agint-skill-graph
      name: ./plugins/agint-skill-graph/lib/index.js
      config: {}
```

```yaml
# preset（presets/agint/agent.cordis.yml）—— 工具平面
- id: agint-skill-graph-tools
  name: ../../profiles/web/plugins/agint-skill-graph/lib/tools.js
```

`mountOrder: 28`（紧接 curator 26 / curriculum 27，早于 dream 30）——必须先于它的上游 curator 挂载。

调度：`agint-cron` 的 `skill-graph-weekly` job，周日 07:00，排进既有周日流水线（curator 02:00 / wiki-lint 03:00 / baseline 03:15 / evolve 03:45 / curriculum 05:00）之后的空档。插件未挂载时 cron soft-skip，不报错。

## 配置

```yaml
presetsDir: <DSH_HOME>/.agent-presets              # 节点全集来源
toolStatsPath: <DSH_HOME>/storages/agint_tool_stats.jsonl
lookbackDays: 180
mode: count-only          # count-only（默认标定期）| live
enabled: true
edgeTypes:
  related: true
  overlap: true
  co_use: true
  similar: false          # §12.5 开放问题 4：实测空集，默认关
overlapOfflineRecompute: false   # 路径 B 回溯历史时才开
coUseWindowMs: 1800000           # 30min
coUseMinSessions: 3
similarDescThreshold: 0.7        # 与 overlap 的 desc 维 0.85 分开
recommendWeights: { intentMatch: 0.4, neighborBoost: 0.3, successRate: 0.2, recency: 0.1 }
recencyHalfLifeDays: 14
recommendMode: list              # list（不打分）| score
enableEventSubscribe: true
limits: { usage_stats: 500, skill_edges: 2000 }
exportDir: <DSH_HOME>/skill-graph/export
weeklyCron: '0 7 * * 0'
```

> ⚠️ **zod 4 陷阱（本插件踩过，curator 同型）**：嵌套对象用 `.default({})` **不会**跑内层 schema，字段默认值全丢。一律用 `.default(() => X.parse({}))`。

## 测试

```sh
node --test "test/*.test.mjs" test/smoke.mjs
```

| 文件 | 覆盖 |
|---|---|
| `smoke.mjs` | 导出契约 / 枚举 / 阈值 / storage spec / 上游常量同源 / **跨平台 fixture（forward-slash + `../escape` 负向）** |
| `collect.test.mjs` | SKILL.md 扫描与同名去重 / JSONL 读取 / 主口径取数 / 使用聚合 |
| `edges.test.mjs` | 四类边逐条 + 丢弃计数 + 证据齐备性 + 权重口径 |
| `query.test.mjs` | 覆盖率 / `health` 三态 / 邻居 / 连通分量 / 推荐（含 `INSUFFICIENT_DATA`） |
| `contract.test.mjs` | 七条不变量 / K19+K20 护栏 / 订阅 topic 在**发布方**源码可 grep / storage spec / **e2e 四段**（标定期 → 切 live → 事件链路 → 整合提案链路 §七 T8） |

## 不做的事

- ❌ **不执行技能整合**——只把候选提交给 `agint.evolve.propose`（不变量 4）
- ❌ **不编造数据**——取不到的字段一律 `null`，空图一律 `EMPTY`
- ❌ **不改 `presets/*/skills/*/SKILL.md`**——元数据补齐属上游条目（见下）
- ❌ **不参与 policy / HARM / evolution 决策路径**

## Sprint 20 观察项与解锁清单

图谱能产出多少，**取决于上游元数据补齐多少**。当前实测（2026-09-13）：

| 缺口 | 影响 | 解锁动作 |
|---|---|---|
| SKILL.md **无一份声明** `related_skills` | `related` 边为 0 → 图谱只剩 co_use 撑着 | 给 21 份 SKILL.md（去重 11 技能）补 frontmatter 元数据 |
| SKILL.md 缺 `tools` / `triggers` 声明 | curator 三维去重跑不出候选 → `overlap` 事件无流量；本插件走离线重算也缺输入 | 同上，一次性解锁 |
| P2-1 轨迹无技能维度 | `successRate` 恒 `null` → `recommendMode: 'score'` 无意义 | 待 P2-1 侧补 `skill` 字段（§13 已登记） |
| 已部署 presets 缺 `plugin-preflight` × 3 | 节点数 10 ≠ 仓内 11，图谱看不到这个技能 | 走 safe-update 重新部署 preset（不是本插件的事，但图谱会如实反映） |

补齐 SKILL.md 元数据是**一次动作解锁四条路径**：curator usage 推断、curator 三维去重、autocreate 查重、本插件 `related` 边。这是当前性价比最高的一步。
