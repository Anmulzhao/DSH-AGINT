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
