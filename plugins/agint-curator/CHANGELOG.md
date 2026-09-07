# agint-curator 变更日志

## v0.1.0 — 2026-09-07（Sprint 14 阶段 1：基础策展）

上游：`设计-P0-2-技能策展人机制.md` §12.1 + `Sprint14-设计稿.md` §3 + A-14/A-15/A-16。

**新增**

- 插件骨架：Service `agint.curator`（13 个方法）+ 独占存储域 `agint_curator`（4 表，schemaVersion 1）。
- `state-engine.js`：纯函数状态机（active→stale→archived / reactivate / pinned），四类保护逐条实现。
- `aggregator.js`：skills 目录扫描（SKILL.md frontmatter）+ tool-stats 聚合 + 技能使用推断（覆盖率 ≥0.6）。
- `executor.js`：archive/unarchive/pin/unpin，含目录移动（`.archive/`）、预算（每周 10）、幂等、失败回滚。
- `reporter.js`：基础策展报告（统计 + 归档列表 + 建议），写入 `reports` 表。
- 10 个 preset 工具；5 类事件（软依赖 event-bus，不可用时降级）。
- D3（A-14）：`sessionId` 前缀 `curriculum-` 的记录整条丢弃，不刷新 `lastUsedAt`。
- D4（A-15）：`EXCLUDED_DATA_SOURCES` 黑名单常量双副本 + `const-consistency.test.mjs` 自动扫描断言。
- A-16：新技能保护期默认 14 天。

**决策与偏离（写明以便回溯）**

| 项 | 决定 | 理由 |
|---|---|---|
| Q2 tool-stats 是否支持自定义 `source` | **不支持** → 走 sessionId 前缀方案 | 已核对 tool-stats 记录字段固定为 `{ts,sessionId,turn,step,tool,callId,latencyMs,ok,errorKind,argFingerprint,args}` |
| 表上限 | 取 Sprint14 §3.2（200/500/52/1000），非 P0-2 原文 1000/5000 | Sprint14 稿后出且明确「对齐 skill-autocreate 惯例」 |
| `pinned` | 作为**状态**而非布尔标志位 | 避免「pinned=true 但 state=archived」双源真值 |
| protected 语义 | 不参与**任何**自动转换（连 stale 都不标） | P0-2 §9.1 原文；cron-referenced 才是「可 stale 不可 archive」 |
| active 超 90 天 | 一次只走一步（active→stale） | 安全 > 效率：先被看见一周再归档 |
| cron 时间 | 周日 **02:00**，非 Sprint14 §3.5 写的 05:00 | 05:00 晚于 evolve-review 03:45，与「在其之前」自相矛盾；按后者 + P0-2 §8.1 默认值取 02:00 |
| 工具 ask 门禁 | 未接真实门禁，仅 description 标注 + audit 记 actor | 当前 dsh 未见统一工具级 approval 配置位，如实标注为未决项 |

**配套改动**

- `agint-skill-autocreate` v0.1.0 → **v0.1.1**：加 D2 过滤（`aggregateTasks` 丢弃黑名单记录，返回新增 `excluded` 计数）+ `schema.js` 黑名单副本 + 5 个回归测试（34 → 39 PASS）。
- `agint-cron`：新增 `curator-weekly` job（周日 02:00，soft-skip 设计）。

**测试**：curator **55 项全 PASS**（smoke 9 / state-engine 15 / aggregator 10 / executor 9 / pipeline 9 / const-consistency 3）+ skill-autocreate 39 项全 PASS。

**挂载（2026-09-07 23:31，TS `20260907-233157`）**：已挂到 host——快照（patch/preset/plugins 三件套）→ 部署 curator + 同步 skill-autocreate v0.1.1 与 cron → 顶层 `cordis.patch.yml` 加 row + preset 加 `agint-curator-tools`（10 工具）→ js-yaml 双校验通过 → host 端 55 测试 + mock 端到端全 PASS。**首挂保守：`auto_curation_enabled: false`**，cron 只出报告不自动归档；观察两周后把 host patch 里该字段改 `true` 放行（或随时 `curator_pause` / `curator_resume`）。重启 dsh 后生效（老板手动）。

## v0.2.0 — 2026-09-08（Sprint 15 阶段 2：智能策展）

上游：`设计-P0-2-技能策展人机制.md` §12.2 + `Sprint15-设计稿.md` §4.3（跨域 B 路径）。

**新增**

- `dedup.js`（T1）：三维度重叠检测——描述+触发文本 Jaccard ≥0.85 / 工具列表 Jaccard ≥0.7 / 触发词 Jaccard ≥0.6，≥2 维达标 → 重叠候选对 + 推荐动作（保留使用率高/成功率高的，相近则建议 review）。纯函数，500 技能全对比较 ≤30s（实测毫秒级）。
- `quality.js`（T2）：质量趋势评估——成功率周快照（qualityHistory，保留 8 周）连续 2 周降幅>10% → declining；HARM 趋势读跨域 evolution-log 的 phase3-provisional 记录（T7），任一数据缺失 → 降级为 unknown，绝不编造。
- 质量加速规则（T3，并入 state-engine，保持纯函数）：规则1 加速 stale（active+HARM 连续2次<0+成功率<0.5）、规则2 加速 archive（stale+HARM 持续下降→60 天归档）、规则3 质量保护（stale+HARM>1.0+成功率>0.8→不归档+review 标记）、规则4 新技能保护期（阶段 1 已有）。新增状态 `quality_declining`。
- 存储扩展（T4）：schemaVersion 1→2，新增 `overlap_candidates` 表（上限 200）；`skill_states` 增 `quality` 字段；报告增 `overlaps`/`declining` 章节。
- 工具（T5）：`curator_list_overlaps` / `curator_list_declining` / `curator_get_report`（read-only 裸调）。
- 事件（T6）：`curator.overlap-detected` / `curator.quality-declining` / `curator.consolidate-proposed`。
- 跨域集成（T7）：软依赖 `agint.evolution`.readLogRangeMerged，按 `phase3-provisional` tag 侧过滤；evolution 未挂载/失败 → [] 降级不阻断。
- 报告增强（T8）：`summary.newlyDeclining` / `overlapsDetected` + 重叠/质量下降/建议章节，`renderReport` 同步。

**决策与偏离（写明以便回溯）**

| 项 | 决定 | 理由 |
|---|---|---|
| REVIEW 独立状态 | **不引入**，由 `quality_declining` + curationNotes `review-suggested` + 报告建议承载 | 避免「进了 review 出不来」的悬空态（无 curator_review 人工工具）；人工经既有 pin/archive/unarchive 处置 |
| 重叠检测输入 | 扫描元数据（tools/triggers）+ skill_states（state/usage）合并后比较 | skill_states 无 tools/triggers，扫描清单无 state/usage，两个来源缺一不可 |
| 技能级 HARM | 当前 evolution-log 只到候选级（targetId=candidateId，未发布），技能级 HARM 待 Sprint 16 release 链路补写 → HARM 缺失时规则 1/2/3 降级，成功率侧质量下降标记仍生效 | 不编造数据；验收由单测（喂模拟 HARM）+ 集成（成功率路径）双覆盖 |
| 与 evolve-review 集成 | 报告/事件已就绪，实际挂载待 evolve-review 存在后 | 当前 plugins 无 evolve-review（仅 agint-evolve） |
| dry-run 语义 | dry-run 不落盘 overlap_candidates 也不删旧记录 | 与阶段 1「dry-run 与真实执行同路径，除不落盘」一致 |

**测试**：新增 dedup 9 / quality 11 / state-engine 质量分支 9 / smart-curation 集成 7；全量 100/100 PASS；plugin-check 9 维全过。
