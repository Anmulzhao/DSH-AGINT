# CHANGELOG

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)；破环性变更在顶部标注 (BREAKING)。

## [0.2.5] — 新增 memory-provider-health job（P1-1 阶段 3，2026-10-01）

### 新增

- **第 20 个 job `memory-provider-health`**（daily 08:30）：巡检已注册记忆
  provider，结果落 `agint_memory_provider` 域的 `health_checks` 表。
  - 与阶段 2 的「运行时降级」互补：降级是**调用失败时**的实时护栏，
    本 job 是**没人调用时**也能发现 provider 悄悄不可用。
  - **只告警不处置**：连续未通过达阈值只发 `memory.provider-unhealthy` 事件 +
    一条 audit_log，切不切 provider 由人工决定（§9.3 自我评估禁止）。
  - 轻量（配置/凭证级校验；provider 实现了 `healthCheck()` 才做真实探活），
    不进 HEAVY 集合。
- `services()` 映射加 `agint.memoryProvider`（懒解析；未挂载 → job soft-skip）。

### 排期理由

08:30 是 08:00（oracle-weekly，周一）与 09:00（oracle-daily）之间唯一的空档 ——
两条排期原则（任意两 job 不同分钟、相邻 ≥15 分钟）由 `schedule-layout.test.mjs`
强制，8/8 PASS。

## [0.2.4] — 约定式 summary 通道：让 job 的运行结果以值落盘（2026-09-29）

### 问题

`summarizeResult` 只在没摘到任何东西时写 `Object.keys(result)`，其余情况只抄
`report.scanned` / `report.counts` / `actions`。于是 job 返回值里**其余字段的值全部丢失**。

真实后果（2026-09-29 实测）：`evolution-cycle` 的 commit 阶段 `policyDecision` 在进程退出后
无从查证 —— 它只出现在 driver 发的事件里而事件未落盘，cron 这边又只写 keys。
更糟的是顶层那个 `policyDecision` 是**提案阶段**的 `variant.policy_decision`，
如果有人图省事抄它，会得到一个**看起来对、其实是另一个阶段**的答案。

### 变更

`summarizeResult` 增加一条约定式摘要通道：job 自己放 `result.summary`（普通对象），
cron 把它搬进 `lastResultSummary.result`。

刻意保持本函数原有的 **`nothing is inferred` 判据**（见函数头注释）：

- **不猜**任何 job 特有字段。cron 只搬「显式约定」的结构 —— 要摘要就自己放。
- 数组 / 字符串 / null 一律不当摘要（`!Array.isArray` + `typeof === 'object'`）。
- summary 单独试一次可序列化性再放。job 若传了循环引用，**不能连带**把已经摘好的
  `scanned` / `counts` / `actions` 一起拖成 `null`（落 `[unserializable]`）。
- 超出 `SUMMARY_MAX_BYTES`（2000）时整体标记 `truncated`，不截半个 JSON。

### 兼容性

没放 `summary` 的 job 行为逐字节不变（仍退化成 `keys`）。现有 19 个 job 全部不受影响。

### 测试

新增 `test/summary-channel.test.mjs`（6 例）：值被搬走、无 summary 时行为不变、
与 report/actions 共存、循环引用不连累已摘好的字段、数组/字符串不被当摘要、超限标 truncated。
自证：把通道判据改成 `false && ...` 后 4/6 变红，恢复后 6/6。

## [0.2.3] — 排期重排 + 排期布局门禁（2026-09-28）

提案 `e6cbe895`：「错开 cron 排期：解 2 组同分钟撞车 + 周度 8 任务去周日单点」。
落地时对原提案做了修正（见下方 Fixed），理由全部写进 `lib/jobs.js` 的时机注释。

### Changed — 排期（19 个 job，改 11 个）

**每日尾段错开（解同分钟撞车）**

| job | 原 | 新 | 理由 |
|---|---|---|---|
| `skill-autocreate-aggregate` | `45 4 * * *` | `15 5 * * *` | 与 `prompt-static-check`(04:45) 撞车；本 job LLM 密集 |
| `skill-autocreate-release` | `15 5 * * *` | `45 5 * * *` | 让位；仍保持「聚合 → 发布 → 观察」30 分钟梯度 |
| `skill-autocreate-observe` | `30 5 * * *` | `15 6 * * *` | 同上 |

**周任务去周日单点（8 个 → 分散周一/周二/周四/周五）**

| job | 原 | 新 |
|---|---|---|
| `curator-weekly` | `0 2 * * 0` | `0 7 * * 1` |
| `evolve-review` | `45 3 * * 0` | `30 7 * * 1` |
| `oracle-weekly` | `0 21 * * 0` | `0 8 * * 1` |
| `wiki-lint` | `0 3 * * 0` | `30 9 * * 1` |
| `evolution-cycle` | `15 4 * * 0` | `0 7 * * 2` |
| `baseline-regression-suite` | `15 3 * * 0` | `30 9 * * 2` |
| `curriculum-weekly` | `0 5 * * 0` | `30 9 * * 4` |
| `skill-graph-weekly` | `0 7 * * 0` | `30 9 * * 5` |

不变：`memory-decay`（Mon 02:30）、`night-dream` / `metrics-collect` /
`tool-stats-backfill` / `prompt-static-check` / `oracle-daily` / `oracle-monthly`、
`diagnosis-watchdog`（限流待验证，不动）。

收益：同分钟撞车 2 组 → 0；周日 02:00–07:00 任务数 13 → 7。

### Added

- `test/schedule-layout.test.mjs`（8 条断言）：把排期原则编码成可自动验证的规则 ——
  同分钟唯一 / 相邻 ≥15 分钟 / LLM 密集 ≥30 分钟 / **curator-weekly 必须早于
  evolve-review（时刻 + 声明顺序各一条）** / 周任务 dow 取值 ≥3 / watchdog
  表达式不得顺手改。
- `docs/operations/cron-schedule-principles.md`：排期原则全文 + 改排期五步操作法
  + 已知边界（补跑风暴、漏跑、watchdog 限流待验证）。

### Fixed — 对原提案的修正

1. **提案阶段 1 自己引入了 4 组新撞车**：`wiki-lint` / `curriculum-weekly` /
   `skill-graph-weekly` 都取 09:00（撞 `oracle-daily` 的固定位），`evolution-cycle`
   取 `0 4 * * 3`（撞 `metrics-collect` 的固定位）。统一改到 `30 9 * * N` 与
   `0 7 * * 2`。
2. **提案反转了 curator-weekly 与 evolve-review 的顺序**（curator 07:30 晚于
   evolve-review 07:00）。这是硬契约而非习惯（P0-2 §8.1 `run_before_evolve_review`）：
   反了不会报错，只会让周复盘静默读到上周的策展报告。已改回 curator 07:00 →
   evolve-review 07:30，并加测试断言钉死。
3. 提案遗漏的边界：三处副本（仓库 / host bundle / profile 镜像）都要同步；
   **改完必须重启 dsh 才生效**（boot 期插件）；`cordis.patch.yml` 有 4 处提到
   cron 时刻的注释要同步改。
4. **补跑场景下排期时刻保证不了顺序**（提案与我第一版落地都没考虑到）：宿主停机后
   重启，`isDue()` 把错过的 job 一次性全判 due，落在同一 tick 内按**声明顺序**串行
   执行。原声明顺序里 `curator-weekly`(第 12 位) 晚于 `evolve-review`(第 4 位)，
   补跑时周复盘会先跑、静默读到上周策展报告。已把 `curator-weekly` 挪到
   `evolve-review` 之前，并加断言钉死声明顺序。

### Changed — 声明顺序

`defaultJobs` 中 `curator-weekly` 从第 12 位移到第 4 位（紧邻 `evolve-review`
之前）。`skill-autocreate-aggregate → release → observe` 的相对顺序未变。

### Notes

- 提案 P1 的「周日断电 = 整周停摆 7 天」不成立：`isDue()` 是补跑语义，错过的周
  任务会在宿主下次启动后补跑一次（2026-09-28 22:36 重启即观察到 `memory-decay`
  补跑）。真实收益是**补跑不再成坨 + 结果落在老板在线时段**，不是「不再漏跑」。
- 提案 P2 的「三个 last 全是手动触发、无按排程样本」不成立：UTC 时间戳换算 +8
  后，周日（2026-09-27）的 6 个周任务 lastRunAt 精确落在各自排程分钟上。
- 提案 P0 的「同刻起跑争抢推理资源」理由不准确：同一 tick 内 job 是**串行**
  `await` 执行（`tick()`）。真害处是顺序由声明顺序决定、拖尾、以及归因困难。



### Added

- 新增 `lib/host-schedule.js`：桥接宿主 `@deepseek-ai/dsh-schedule`（0.1.7-rc.2，宿主已带）。
  - 全部 job 用宿主 `canonicalizeCronExpression` 校验；catalog 只读镜像（不写宿主存储）；懒加载（首次访问才 import 宿主包）。
  - 宿主缺失时降级 `hostAvailable:false`，既有 cron 行为完全不变。
- **有意不调用宿主 `create()`**：宿主投递语义是"提醒注入 agent session"，与 cron 的 action 直调不同，投递策略留待拍板。
- Service 面新增只读 `agint.cron.hostSchedule`（`{ hostAvailable, jobs, hostPackage }`）。

### Notes

- 对应《三仓库对比分析报告_20260928.md》§7.1 行动 #2；测试 `test/host-schedule.test.mjs`。


## [0.2.1] — Sprint 16 发布层 cron（2026-09-09）

### Added
- 新增 cron job `skill-autocreate-release`（daily 05:15）：调 agint.skillAutocreate.releaseQueue()，三道门自动发布队列检查（人工确认窗内全部被拦，拍板 2 语义）。
- 新增 cron job `skill-autocreate-observe`（daily 05:30）：调 agint.skillAutocreate.observe()，观察期 STABLE / 0 调用自动回滚 / 展期判定。
- 两 job 均在 skill-autocreate-aggregate(04:45) 之后；插件未挂载时 soft-skip。

## [0.2.0] — Sprint 12 B3 baseline-regression 真 cron hook

### Added
- 新增 cron job `baseline-regression-suite`：周节奏 Sun 03:15（夹在 wiki-lint 03:00 与 evolve-review 03:45 之间），调 `agint.evolve.recordBaselineRun({channel:'mount', passRate:1.0, passed:0, total:0, source:'cron:baseline-regression-suite'})`。
- **不动** `metrics-collect` / `evolve-review` / `night-dream` / `quality-eval-weekly` 4 个被 AGENTS.md §边界 锁的 cron（保持时间表与 action 不变）。
- 默认 job 列表：8 个（memory-decay / wiki-lint / metrics-collect / evolve-review / night-dream / tool-stats-backfill / prompt-static-check / baseline-regression-suite）。

### Notes
- 当前以"占位行"语义写 `baseline_history`（passRate=1.0、passed=0、total=0）；真实 passRate 由 Sprint 13 B4 接入回归 runner 注入（design Sprint12 §B3）。
- 完整测试入口：`eval/run-baseline-regression.mjs`（不通过 cron action，直接 import 真 plugin apply + recordBaselineRun）。

## [Unreleased]

### Added
- 新增 cron job `diagnosis-watchdog`（**每 30 分钟**，2026-09-26 诊断报告自激环事故后新增）：
  巡检 `agint_diagnosis` 各表占用率与 `report()` 频率熔断状态。三条判据全为绝对值
  （故**无需持久化历史**）：① 表占用率 ≥80% cap → WARN、≥cap → CRITICAL；
  ② `reportRateGuard.trips > 0`（★ 频率熔断真被咬过的唯一直接证据）→ WARN；
  ③ 近一个窗口内 `recent > max/2` → WARN。异常走 `throw`，使告警同时进
  `console.error` + `cron_state.lastError` + `cron_list` 的 `lastOk=false`（不静默）。
- `index.js` services map 增补 `agint.diagnosis.stats`（与既有条目同款懒解析；未挂载时 job soft-skip）。
- 测试 `test/diagnosis-watchdog.test.mjs`（11 例）：soft-skip / 健康态无告警输出 /
  80% 阈值边界（78% 不报、80% 报）/ 表满 CRITICAL / annotations 同样受检 /
  熔断被咬 / 调用密集 / `recent = max/2` 不算 / stats 缺字段容错。
- README 的 job 表由 8 个补齐至 **15 个**（此前只列了 8 个，与实际注册数不符）。
- 新增 cron job `curriculum-weekly`（P7 自主课程生成器，Sprint 14 Part B）：**Sun 05:00**（老板拍板），排在周日全家桶（curator 02:00 / wiki-lint 03:00 / baseline-regression 03:15 / evolve-review 03:45）之后。流程：`agint.curriculum.probe()` 找待练域（UNCERTAIN / 校准失准 / CAN 超期未复验）→ 逐域 `generate({count:1})`（自带同域 24h 冷却 + 无模板域诚实留白）。挑战生成后**不自动执行**（P7 §4.5），由 agent 用 `curriculum_next` 领取。插件未挂载 / paused 时 soft-skip，不报错。
- `index.js` services map 增补 `agint.curriculum`（与既有 `agint.curator` 同款懒解析）。

### Added（前次）
- 新增 cron job `curator-weekly`（P0-2 技能策展，Sprint 14）：Sun 02:00，调 `agint.curator.run({trigger:'cron:curator-weekly'})`。刻意排在 `evolve-review`（03:45）**之前**，让周复盘能吃到本周策展报告。插件未挂载时 soft-skip，不报错。
  - 时间说明：Sprint14 设计稿 §3.5 写「周日 05:00」与其自述的「在 evolve-review 之前」互相矛盾（05:00 晚于 03:45），按后者 + P0-2 §8.1 默认 `0 2 * * 0` 取 02:00。
- `index.js` services map 增补 `agint.curator`（与既有 `agint.skillAutocreate` 同款懒解析）。
- 默认 job 列表：10 个（新增 `skill-autocreate-aggregate` / `curator-weekly`）。
- 持久化每个 cron job 的 `lastRunAt` / `lastResult` / `lastError` 到独立的 `agint_cron` storage domain（`cron_state` 表）。host 进程重启后 `cron_list` 能恢复真实的 last-run 时间戳，而不是显示 `never`（与 agint-dream 修复 lastSweep 同类问题）。存储域打开失败时降级为内存-only，不阻塞调度。
- `manifest.json`：按 PLUGIN-SPEC 8 维声明 injection（`timer` + `storageDomain`）、provides（`agint.cron`）、storage domain（`agint_cron`）与生命周期。
- `README.md`、`test/smoke.mjs`：补齐插件准入维度 7（docs）与维度 6（tests）。

## [0.1.0]

### Added
- 基于 `cordis-plugin-timer` 的 5 字段 cron 调度 host Service（`agint.cron`），60 秒 tick + per-job mutex 防重叠。
- 默认 job：memory-decay / wiki-lint / metrics-collect / evolve-review / night-dream / tool-stats-backfill / prompt-static-check。
- preset 侧工具：`cron_list` / `cron_run_now` / `cron_health`。
