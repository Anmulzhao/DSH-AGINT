# agint-skill-graph 变更日志

## v0.1.0 — 2026-09-13（Sprint 19 实施：P2-2 技能使用统计与学习图谱）

上游：`设计-P2-2-技能使用统计与学习图谱.md` v0.4（§3.2 四类边 / §4.3 七条不变量 / §5.3 count-only 标定期 / §六bis 实测条数）。

**新增**

- 插件骨架：Service `agint.skillGraph`（FROZEN 6：`updateFull` / `getStats` / `neighbors` / `clusters` / `recommend` / `getCoverage`；另有 `listForPrompt` / `exportGraph` / `proposeConsolidate` / `setLlmAnnotation` / `setMode` / `config` / `stats`）+ 独占存储域 `agint_skill_graph`（3 表，schemaVersion 1）。
- `lib/collect.js`：SKILL.md 扫描（同名技能跨 preset 去重、声明取并集、`declarations` 记录溯源）+ tool-stats 主口径取数（`tool === 'skill'` 取 `args.name`）+ 技能级聚合。
- `lib/edges.js`：四类边。`related` 声明式 / `overlap` 事件驱动 + 离线重算 / `co_use` 同会话窗口共现 / `similar` 元数据相似。每条边强制 evidence（`EVIDENCE_REQUIRED_KEYS` 按类型定必填键），`filterValidEdges` 丢边必留原因。
- `lib/query.js`：纯函数查询内核。覆盖率 / `health` 三态（EMPTY/SPARSE/OK）/ 并查集连通分量 / 推荐（list 不打分 + `INSUFFICIENT_DATA` 降级链）。
- `lib/index.js`：事件订阅（12 个上游 topic，`PENDING_TOPICS` 显式登记未落地者）+ `updateFull` 永不 throw + count-only 只写 meta。
- 10 个 preset 工具（7 读 3 写，写类 description 首行标注「⚠️ 写操作 · 需人工确认」）。
- `agint-cron` 新增 `skill-graph-weekly` job（周日 07:00，soft-skip 设计）+ 5 项编排测试。
- 阈值与纯函数**全部引用 curator，不写副本**（`SKILL_STATES` / `OVERLAP_THRESHOLDS` / `isExcludedRecord` / `tokenize` / `descSimilarity` / `detectOverlaps` / `parseFrontmatter`）。

**决策与偏离（写明以便回溯）**

| 项 | 决定 | 理由 |
|---|---|---|
| 首选边型 | `related`（声明式）取代 v0.2 的计算型三件套 | v0.2 押注的 overlap/similar 至今 0 条（元数据缺声明）；`related` 零计算零阈值，上游补一行就有一条边。**但 co_use 已被实测翻案（见下）**，两者互补而非替代 |
| `co_use` 实测 | **4 条边**（9/5/3/3 会话），推翻设计稿 §六bis「最多 2 对 × 各 1 次 → 0 条」 | 2026-09-13 对真实数据实跑：7815 条记录 / 86 条 skill 调用 / 76 条进入聚合。使用流量累积后 ≥3 会话门槛已跨过。schema.js 注释已同步更正 |
| `similar` 默认关 | `SIMILAR_DEFAULT_ENABLED = false`，阈值 0.70 独立于 overlap 的 0.85 | 实测描述维最高 0.201，阈值 0.70 为空集。复用 0.85 会制造「像不像」与「重不重叠」的语义混淆 |
| coverage 语义 | `allEdges = mode === 'live' ? edges : []`，投影只进 `lastCalibration` | 自查发现的语义错误：初版把标定期投影算进 coverage，等于「用预期值让空图看起来有内容」，违反不变量 6 |
| 切档护栏 | 未跑过标定期调 `setMode('live')` **抛错** | 对齐 P2-1 不变量；`promotable`（nodes>0 且 edges>0）是切档凭证 |
| cron 返回口径 | `persisted`（已落盘）与 `projected`（若转 live）**分开报** | count-only 下两者一个全零一个非零，混报就是自欺 |
| 主键 | `skillName`，全仓无 `skillId` | grep 证伪：`skillId` 在本仓库 0 命中（含 curator），不自造第二套 ID 空间 |
| 表上限 | usage_stats 500 / skill_edges 2000，超限 warn 不 prune | 对齐 curator / skill-autocreate 惯例 |
| cron 时间 | 周日 **07:00**（`0 7 * * 0`） | 设计稿 §5.2；排进周日流水线（curator 02:00 / wiki-lint 03:00 / baseline 03:15 / evolve 03:45 / curriculum 05:00）之后的空档 |
| zod 嵌套 default | 统一 `.default(() => X.parse({}))` | zod 4.4.3 实测：`.default({})` 不会再跑内层 schema，字段默认值全丢。**curator 的 `QualitySchema.default({})` 属同型隐患**（消费方恰好容错才没炸），已在其注释登记 |

**实现期踩坑（供后续插件参考）**

| 坑 | 现象 | 解法 |
|---|---|---|
| 跨插件 import 层级 | 从 `lib/` 出发到兄弟插件要**两级**：`../../agint-curator/lib/xxx.js` | CLI 报错会提示 `Did you mean to import "../../..."`，别凭直觉写一级 |
| 注释里的 `*/` | 块注释写 `` `<presetsDir>/*/skills/*/SKILL.md` `` → `*/` 提前闭合注释，后面代码裸奔 | 注释里避免 `*/` 序列，用「每个 preset 的 skills/{技能名}/SKILL.md」 |
| K19/K20 自检误报 | 正则命中注释里的「不写 `required: false`」 | 掩码必须完整处理 code/line/block/sq/dq/tpl 六种状态（与仓库级 `test/schema-guard.test.mjs` 对齐） |
| 测试断言自己写错 | overlap 权重浮点、declarations 长度、co_use 入参形态、similar 描述完全一致导致误命中 | 先分清「实现错」还是「断言错」，别急着改实现 |

**实测条数（2026-09-13，真实环境，铁律 ③）**

```
tool-stats 总记录        7815
tool === 'skill'           86
无 skill 字段丢弃        7729   (skippedNoSkillField)
技能名不在全集             10   (unknownSkillName)
进入聚合                   76
节点（已部署）             10   (19 份 SKILL.md 去重)
节点（仓内 presets）       11   (21 份；已部署缺 plugin-preflight × 3 —— 部署漂移)
有使用的节点                5   (usageRatio 0.5)
投影边（若转 live）         4   (全部 co_use；promotable=true)
已落盘边（count-only）      0   (health=EMPTY)
```

**配套改动**

- `agint-cron`：新增 `skill-graph-weekly` job（周日 07:00）+ `test/skill-graph-weekly.test.mjs`（5 用例，含 persisted/projected 口径分离断言）。
- `presets/agint/agent.cordis.yml`：加 `agint-skill-graph-tools` 行（10 工具）。
- `plugins/agint-skill-graph/cordis.patch.yml`：loader entry 模板（mountOrder 28，紧接 curator 26 / curriculum 27）。
- 顶层 `cordis.patch.yml` **未改**——由老板走 safe-update 合并（与 curator / autocreate 同策略）。

**测试**：**62 项全 PASS**（smoke 14 / collect 9 / edges 13 / query 11 / contract 15）+ cron skill-graph-weekly 5 项全 PASS + 仓库级 `test/schema-guard.test.mjs`（K19/K20）5 项全 PASS + `bin/plugin-check.sh` 0 fail。

**e2e 覆盖与 §七 T8 的对应**：设计稿 T8 要求 e2e ×3 —— ①扫描产节点 ②overlap 事件→边落盘→proposeConsolidate ③域损坏主链路无感。落点在**插件级 contract 测试**（e2e-1/2/3/4 + fail-open），**不是** `eval/scenarios/` driver 场景——理由：Sprint 14 之后的插件（curator / skill-autocreate / curriculum）均无 driver 场景，新场景需在 2235 行的 `driver.js`（已知债务热点）里加 dispatcher，成本高且偏离当前实践。真实环境的人工核验（真实 presets + 真实 tool-stats 实跑）已做并记录于上方实测条数。

**挂载**：**未挂载**。按 safe-update SOP 走：仓内 `cordis.patch.yml` 模板已备好，等老板合并到顶层 + 重启 dsh。默认档 `count-only` 本身就是最保守档位（不落正式表），无需额外保守选项。

**遗留与观察项**

- [ ] 21 份 SKILL.md 补 `tools` / `triggers` / `related_skills` 元数据（一次动作解锁四条路径，**当前性价比最高**）
- [ ] 已部署 presets 与仓内漂移：`plugin-preflight` × 3 缺失（走 safe-update 重新部署）
- [ ] count-only 跑几周后，凭 `lastCalibration.promotable=true` 决定是否切 `live`
- [ ] P2-1 轨迹补 `skill` 字段后，`successRate` 才能从 `null` 变成真数（§13 已登记）
- [ ] curator `QualitySchema.default({})` 同型隐患（zod 4 嵌套 default），待其升级时一并修
- [ ] 全仓 manifest 的 `zod: ^3.0.0` 与实装 4.4.3 不符（约 20 处，统一写法如此）——如实登记，不在本插件范围内擅改
