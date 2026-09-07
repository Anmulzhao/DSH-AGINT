# agint-curator

P0-2 技能策展人，**v0.2.0（Sprint 14 阶段 1 基础策展 + Sprint 15 阶段 2 智能策展）**。

技能一旦创建就静态躺在 preset 里，没人问「还在用吗」。本插件把「技能维护」从无人管变成「系统自动策展 + 人可干预」：每周扫描技能、聚合使用数据、把陈旧技能标 stale、把长期不用的归档到 `.archive/`（可恢复）；Sprint 15 起叠加**重叠检测**（三维度 ≥2 维达标 → 候选对 + 推荐动作）、**质量评估**（成功率周快照趋势 + 跨域 D-QAF 评估历史，缺失降级不编造）与**质量加速规则**（质量差的更快归档，高质量储备技能被保护）。

## 状态机（纯函数，无 LLM）

```
active ──30天未用──▶ stale ──90天未用──▶ archived
  ▲                   │                    │
  └──7天内有使用────────┘                    └──人工 unarchive──▶ active
  │
  └──人工 pin──▶ pinned（不参与任何自动转换）
  Sprint 15 质量路径：
  active ──质量下降──▶ quality_declining ──7天内有使用且质量恢复──▶ active
  active ──规则1 质量加速──▶ stale
  stale  ──规则2 质量加速(60天)──▶ archived
  stale  ──规则3 质量保护──▶ 不归档 + review 标记
  quality_declining ──陈旧达阈值──▶ archived
```

`lib/state-engine.js` 是**纯函数**（输入技能状态 + 使用统计 + 质量趋势 + 配置 + 当前时间 → 输出目标状态 + 理由）。质量加速规则（P0-2 §7.2 规则 1–4）叠加在纯函数分支上，可测性优先。

一个刻意的保守设计：`active` 即使已经 90+ 天未用，也**一次只走一步**（active→stale）。让陈旧技能先被「看见」一周（进 stale 列表 + 发事件），下周才归档。

## 四类保护（归档是破坏性操作，宁可漏不可错）

| 保护 | 行为 |
|---|---|
| `pinned` | 人工固定。不参与**任何**自动转换，连 stale 都不标 |
| `protected` | 白名单（`plan` / `memory-discipline` / `causal-reasoning`）+ 策展自保护：名字含 `curator`/`策展` 的技能自动进 protected（P0-2 §9.4，防「策展优化策展」递归自改） |
| `cron-referenced` | 被 cron job 引用：**可 stale，不可 archive** |
| 新技能保护期 | 创建 <14 天 **且**从未使用 → 不参与 stale 转换 |

注意 protected 与 cron-referenced 的差别：前者完全不动，后者允许标记陈旧但绝不归档。

## 存储域：`agint_curator`（独占，schemaVersion 1）

| 表 | 上限 | 说明 |
|---|---|---|
| `skill_states` | 200 | 每技能策展状态 + 使用统计 |
| `curation_actions` | 500 | 每次状态转换 / 人工操作 |
| `reports` | 52 | 每周一份，约一年 |
| `audit_log` | 1000 | 审计（唯一自动滚动清理） |

上限对齐 `agint-skill-autocreate` 惯例：**超限 warn 不 prune**，只有 audit_log 滚动。

> 与 P0-2 设计稿原文的差异（Sprint 14 设计稿后出，以其为准）：P0-2 §4.2/§4.3 写的是 1000/5000，Sprint14 §3.2 写 200/500；`state` 枚举含 `pinned`（P0-2 里 pinned 是布尔标志位），避免「pinned=true 但 state=archived」的双源真值矛盾。

## Service

| Service | 说明 |
|---|---|
| `agint.curator.run({ trigger, dryRun, force, nowMs })` | 完整策展流程 |
| `agint.curator.dryRun()` | 试运行：`run({dryRun:true})`，与真实执行**同一条计算路径**，输出一致但不落盘 |
| `listSkills(filter)` / `getSkill(name)` | 查询（可按 state / protectedOnly / query 过滤） |
| `pin` / `unpin` / `archive` / `unarchive` | 人工干预（幂等：重复操作返回 skipped 不报错） |
| `stats()` / `getReport(week)` | 统计 / 报告（week 省略返回最新） |
| `pause()` / `resume()` / `config(patch)` | 运行时开关（内存态，重启还原） |
| `listOverlaps` / `listDeclining` / `consolidate` / `prune` | **Sprint 15/16 接力，当前显式抛未实现**（绝不静默） |

## 工具（preset 平面，10 个）

读类（裸调）：`curator_list` / `curator_status` / `curator_stats` / `curator_get_skill` / `curator_dry_run`
写类：`curator_pin` / `curator_unpin` / `curator_archive` / `curator_unarchive` / `curator_run_now`

> **门禁现状（如实标注）**：P0-2 §6 要求写类工具走 ask 人工确认，但当前 dsh 未见统一的工具级 approval 配置位（`agint-rules` 的 ask 是业务语义不是门禁）。阶段 1 的做法是：写类工具 description 首行显式标注「⚠️ 写操作 · 需人工确认」，并把 actor 落进 audit_log。待 dsh approvals 可用后再接真实门禁。

## 技能使用数据从哪来

开放问题选 C：**先推断，后切换**。

- **推断路径（当前默认）**：技能 frontmatter 声明的 `tools` 与任务的工具序列求覆盖率，≥0.6 判定命中。这是启发式，如实标注——技能没声明 `tools` 时无法推断，`useCount` 保持 0。
- **准确路径**：记录带 `skill` 字段时直接归属（P0-1 上线后 tool-stats 增补该字段即自动生效）。

`run()` 返回值里的 `inference` 字段会告诉你这次走的是哪条路径（`explicit` / `inferred` / `disabled`）。

## D3：curriculum 调用隔离（Sprint14 §2.1）

curriculum（P7 自主课程）的挑战是「同一类任务反复练」，如果不隔离会把两个数据源都污染：skill-autocreate 误判成可标准化重复模式，curator 把挑战调用当成「技能被使用」→ 陈旧技能被误判为活跃。

已确认 tool-stats 记录**不支持**自定义 `source` 字段，因此采用 **sessionId 前缀方案**：`sessionId` 以 `curriculum-` 开头的记录整条丢弃（同时保留 `source === 'curriculum'` 分支备用）。

`EXCLUDED_DATA_SOURCES` 常量在 curator 与 skill-autocreate 各持一份副本（D4：存储域互斥，不建共享模块），一致性由 `test/const-consistency.test.mjs` 自动扫描断言——新插件加副本会被自动纳入。

## 挂载

```yaml
# profile patch（顶层 cordis.patch.yml 的 loader list）
- insert:
    - id: agint-curator
      name: ./plugins/agint-curator/lib/index.js
      config: {}
```

```yaml
# preset（presets/agint/agent.cordis.yml）—— 工具平面
- id: agint-curator-tools
  name: ../../profiles/web/plugins/agint-curator/lib/tools.js
```

调度：`agint-cron` 的 `curator-weekly` job，周日 02:00（排在 `evolve-review` 03:45 之前，让周复盘吃到策展报告）。插件未挂载时 cron soft-skip，不报错。

> ⚠️ **首次挂载建议**：先 `curator_dry_run` 看一遍会归档什么，或直接挂载时设 `auto_curation_enabled: false`（只检测不执行）。归档是移动目录 + 从 Prompt 移除，虽然可恢复，但让你先看见再放行更安全。

## 配置（`cordis.patch.yml` 的 config）

```yaml
stale_after_days: 30              # 多少天未用 → stale
archive_after_days: 90            # 多少天未用 → archive
new_skill_protection_days: 14     # 新技能保护期
reactivate_within_days: 7         # stale 技能在这个天数内有使用 → 回 active
weekly_archive_budget: 10         # 每周自动归档上限（防批量误操作）
protected_skills: [plan, memory-discipline, causal-reasoning]
auto_curation_enabled: true       # 总开关（false = 只检测不执行）
dry_run_default: false
move_directory_on_archive: true   # false = 只落状态不移动目录
skills_dir: <DSH_HOME>/.agent-presets/agint/skills
archive_dir_name: .archive
weekly_cron: '0 2 * * 0'
# Sprint 15 质量评估 / 重叠检测
quality_snapshot_max_weeks: 8     # 周快照保留数
quality_success_decline_pct: 0.10 # 单周成功率降幅超此值记为下降
quality_success_decline_streak: 2 # 连续 2 周下降 → declining
quality_harm_declining_count: 2   # HARM 增量连续 2 次 <0 → declining
quality_harm_review_delta: 1.0    # 规则3：HARM>1.0 且成功率>0.8 → 保护
quality_archive_after_days: 60    # 规则2：质量下降加速归档阈值
overlap_detection_enabled: true   # 重叠检测总开关
overlap_desc_threshold: 0.85      # 描述维 Jaccard 阈值
overlap_tools_threshold: 0.7      # 工具维 Jaccard 阈值
overlap_triggers_threshold: 0.6   # 触发词维 Jaccard 阈值
overlap_min_dimensions: 2         # ≥2 维达标 → 重叠候选
overlap_max_pairs: 50             # 单周报告/事件上限
```

运行时可改（内存态，重启还原）：`auto_curation_enabled` / `weekly_archive_budget` / `stale_after_days` / `archive_after_days` / `dry_run_default` / `overlap_detection_enabled` / `quality_archive_after_days`。

## 测试

```sh
node --test "test/*.test.mjs" test/smoke.mjs
```

| 文件 | 覆盖 |
|---|---|
| `smoke.mjs` | 导出契约 / 枚举 / LIMITS / storage spec / pack / D4 常量 |
| `state-engine.test.mjs` | 转换规则 + **四类保护逐条** + **质量加速规则 1–3** + quality_declining 转换 + 纯函数性 |
| `aggregator.test.mjs` | frontmatter / 扫描 / **D3 过滤回归** / 使用聚合 |
| `executor.test.mjs` | 归档（真实目录移动）/ 幂等 / 保护 / 预算 / unarchive / pin / dry-run |
| `dedup.test.mjs` | tokenize / Jaccard / 三维度达标 / 推荐动作 / **500 技能性能 ≤30s** |
| `quality.test.mjs` | 成功率趋势 / HARM 趋势 / 质量规则 1–3 / 周快照 |
| `pipeline.test.mjs` | 端到端（stale→archive）/ D3 端到端 / 保护 / **dry-run 一致性** / 报告 / pause |
| `smart-curation.test.mjs` | 重叠检测端到端 / 质量下降标记 / 质量加速归档 / **T7 跨域 evolution 读取 + 降级** / 报告增强 |
| `const-consistency.test.mjs` | D4 三处副本一致性（自动发现） |

## 不做的事

- ❌ consolidate / prune（Sprint 16，prune 默认永久禁用）
- ❌ 改 preset 的 `agent.cordis.yml`（归档靠 `.archive/` 目录不在扫描范围内实现，不动配置）
- ❌ 策展自己（§9.4 自保护）
