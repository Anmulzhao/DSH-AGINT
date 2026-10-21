# agint-curator 变更日志

## v0.2.2 (2026-10-21) — 修「多根只改了扫描侧」：归档/恢复按技能所属根定位

> 起因：v0.2.1 把 `skills_dir` 改成目录列表，**只改了扫描侧**。归档侧
> `executor.js` 仍是 `join(cfg.skills_dir, ...)` —— 数组进 `path.join` 抛
> `ERR_INVALID_ARG_TYPE`（实测），**归档能力静默失效**：目录不动、状态不落
> （`putSkill` 在移动之后才执行），只留一条 `archive_failed` 审计。
> fail-safe，不危险；但「策展能自动归档」这个能力从来没生效过。

**① 账本记物理位置**

`skill_states` 新增两个字段：`rootDir`（技能属于哪个扫描根）、`dirName`
（物理目录名，可能 ≠ frontmatter 的 `name`）。扫描时写入，归档时使用。
两字段可选且有默认值（null）⇒ 新旧记录双向兼容。

**② 归档/恢复按技能所属根算路径**

`executor.js` 新增 `resolveSkillRoot()`：
1. 账本里的 `rootDir`（扫描时写下的真实根，权威）；
2. 存量记录没有该字段 → **在所有根里找一遍**这个技能目录；
3. 都没找到 → 回退第一根（此时判「目录不存在」，只改账不移动）。

**不跨根搬**：归档与恢复都在同一个根内完成（`<root>/.archive/<name>/`）。
`skills_dir` 的归一化（字符串 / 数组）抽成 `normalizeSkillRoots()`，扫描侧与
归档侧共用同一份 —— 这次根因正是两边各写一遍、只改了一边。

**③ 恢复支持时间戳后缀**

归档时若目标已存在会加时间戳后缀（`name-<ts>`），旧恢复逻辑只找精确名
⇒「归档成功但恢复找不到目录」＝ 归档实际不可逆。现在按前缀找回。

**④ 顺带修一个一直没跑起来过的测试**

`test/const-consistency.test.mjs` 用 `new URL(...).pathname` 取仓库根，
而 `.pathname` 对中文路径返回**百分号编码**（`project%E6%BA%90%E7%A0%81`），
代码只剥了前导斜杠、没解码 ⇒ 在中文目录下 `readdirSync` 直接 ENOENT，
这个测试**没有真正执行过**。加 `decodeURIComponent` 后恢复。

**存储域版本保持 2**：`rootDir`/`dirName` 可选 + 有默认值，双向兼容；
bump 需声明 `compatibleVersions`，否则回滚插件时旧代码读 v3 medium 会
`version-mismatch` → 域打不开 → 插件挂不上。风险大于收益。

**测试**：新增 `test/multi-root-archive.test.mjs`（T0 根因回归 / T1 多根归档 /
T2 恢复 / T3 目录名≠name / T4 单根回归 / T5 存量记录兼容）。
本插件测试套件 97 项全通过。

## v0.2.1 (2026-10-01) — 多根扫描 + 孤儿清扫 + lastRunAt 落盘（策展「账实不符」三修）

> 起因：本机 `curator_status` 恒显 `lastRun=never`、preset 自带的 7 个手工技能**在账上
> 一条都没有**，账上 12 条里 5 条是**已被回滚的自动技能**却仍以 active 充当分母。
> 三处都是「静默失真」——不抛错，只是结果不对。

**① `skills_dir` 接受目录列表（多根合并、按 name 去重）**

原为单字符串，默认 `$DSH_HOME/skills`。2026-09-23 与 autocreate 同步改投用户级根后，
AGINT 手工维护的技能仍在 `$DSH_HOME/.agent-presets/agint/skills`，**整批落在账外**。
改为 `z.union([z.string(), z.array(z.string())])`——向后兼容单值，不破坏既有配置。
扫描结果携带 `dirs`（实际扫了哪几个根），**「扫了哪些根」必须可取证，不靠读配置猜**。

**② orphan 清扫（`orphan_sweep_enabled`，默认 true）**

账本里有、任何扫描根里都没有 → 判定为已移除/已回滚，只把账改成 `archived`
并写审计，**不移动目录、不删记录**（`curator_unarchive` 可回滚）。
护栏：扫描结果为空时整体跳过——配置写错或目录不可读时，不能把整本账扫成孤儿。

**③ `lastRunAt` 落盘回读**

`lastRunAt` 原是内存态 → 每次重启归零，`curator_status` 恒显 `lastRun=never`，
而 cron 记录里明明有成功运行。改为 `run()` 每次往 `audit_log` 写一条
`weekly_run` / `dry_run`，挂载时回读时间戳最新的一条；读不到就保持 null，**不假装有值**。

**不做的**：不自动判定「用着差」（无成败数据，硬造指标=自我评估）；不动存储 schema。

## v0.2.0+retarget (2026-09-23) — skills_dir 与 autocreate 投放目标对齐

`skills_dir` 默认值：`$DSH_HOME/.agent-presets/agint/skills` → `$DSH_HOME/skills`。

**为什么必须同改**：起因见 `agint-skill-autocreate/CHANGELOG.md` 的 `0.5.1+retarget`
（投放方改投用户级技能根）。本插件对 `skills_dir` 是**读+写**——
`scanSkills` 列技能、`moveToArchive` / `moveBackFromArchive` 对 `skills_dir/<技能名>`
做整目录 rename。不同步的后果是**静默失真**：`curator_list` 看不到新技能、
`curator_archive` 报 `skill directory not found`，不抛错、只是结果不对。

`archive_dir_name`（默认 `.archive`）是相对 `skills_dir` 的，跟着搬家，无需改。

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
