# cron 排期原则（agint-cron）

> 2026-09-28 建立。起因：提案 `e6cbe895` 实测发现 19 个 job 里 8 个周任务全堆在
> 周日凌晨，另有 2 组同分钟撞车，而时间点从来是手摆的、没有成文规则。
> 本文件把规则写下来；`plugins/agint-cron/test/schedule-layout.test.mjs` 把规则
> 编码成断言——**加/改 job 只要违反原则，测试直接红**。

## 一、先弄清两件事，否则会按错误的理由排期

### 1. 同一 tick 内的 job 是**串行**执行，不是并发

`lib/index.js` 的 `tick()` 对到期 job 逐个 `await runOne(job)`，按 `defaultJobs`
的**声明顺序**跑（`STALL_MS=15min` 是卡死兜底，超时后新 tick 接管）。

所以「两个 job 同一分钟」的害处**不是**并发争抢推理资源，而是：

1. **顺序由声明顺序决定，而非设计意图** —— 09-18 事故就是这个：聚合 job 反而
   晚于发布 job 36 秒落地，当天新生成的候选全错过那趟车，白等一天；
2. **拖尾** —— 前一个跑 10 分钟，后一个就晚 10 分钟起跑；
3. **归因困难** —— 两个 job 的 `lastRunAt` 落在同一分钟，出问题时分不清谁拖慢了谁。

### 2. 漏跑**不会**停摆一周：`isDue` 是补跑语义

`lib/cron.js` 的 `isDue()` 判据是「最近一次计划时刻 > lastRunAt 即到期」，
因此周任务错过窗口后，宿主下次启动的第一个 tick 会补跑一次（且同一窗口只会补一次）。
2026-09-28 22:36 重启就有活样本：`memory-decay`（Mon 02:30）在 22:39 补跑。

**推论**：把周任务从周日凌晨挪走，解决的不是「漏跑」，而是：

- **补跑风暴**：8 个周任务同时错过 → 全挤进启动后的同一个 tick 串行跑；
- **无人值守**：凌晨跑挂了没人看见，等 8 小时后老板起床才发现。

### ⚠️ 补跑场景下「排期时刻」保证不了顺序，只有「声明顺序」能

这是 2026-09-28 落地时才暴露的缺口。宿主停机后重启，`isDue()` 会把错过的 job
**一次性全判 due**，它们落在**同一个 tick** 里 —— 那一刻 07:00 与 07:30 的差别
完全失效，谁先跑只由 `defaultJobs` 的**声明顺序**决定。

所以 `curator-weekly` 的声明位置也被挪到了 `evolve-review` 之前（2026-09-28）。
否则补跑时周复盘会先跑、读到上周的策展报告，**不报错，只是静默读到旧数据**。

> 判定口诀：**凡是「A 必须早于 B」的语义依赖，都要同时在排期时刻和声明顺序上
> 成立**，否则补跑那天就会静默失效。

## 二、硬约束（违反 → 测试红）

| # | 原则 | 判据 |
|---|---|---|
| ① | **同分钟唯一** | 任意两个 job 的触发时刻不得重合，含 daily × weekly 交叉。`diagnosis-watchdog`（每 30 分钟）豁免：它必然覆盖所有 `:00`/`:30`，且是轻量巡检 |
| ② | **相邻间隔 ≥15 分钟** | 全局触发点两两比较 |
| ②b | **LLM 密集型之间 ≥30 分钟** | 集合见测试文件 `HEAVY`；判据 = 该 job 的 action 会调 LLM 或做全量重算 |
| ③ | **顺序契约：curator-weekly 必须早于 evolve-review** | 周复盘要吃本周的策展报告（P0-2 §2.2 / §8.1 `run_before_evolve_review`）。**这条不会报错，只会让周复盘静默读到上周数据** |
| ③b | **同一契约在「声明顺序」上也要成立** | `curator-weekly` 在 `defaultJobs` 数组里的下标必须小于 `evolve-review`。原因见下节 |
| ④ | **周任务不得堆在同一天** | dow 字段不同的取值 ≥3 个 |

### 两个必须避开的「固定位」

- `0 4 * * *` —— `metrics-collect`（daily 04:00）
- `0 9 * * *` —— `oracle-daily`（daily 09:00）

2026-09-28 重排时，提案原稿正是踩了这两个固定位：`evolution-cycle` 想放
`0 4 * * 3`（撞 metrics-collect），`wiki-lint` / `curriculum-weekly` /
`skill-graph-weekly` 都想放 09:00（撞 oracle-daily）——**解了 2 组旧撞车，
引入 4 组新撞车**。改后三档统一取 `30 9 * * N`（09:30）。

## 三、软约定（不强制，但排期时按这个想）

- **复盘/报告类 → 周一早上**：一周刚结束、老板第一眼就能看见（curator 07:00 →
  evolve-review 07:30 → oracle-weekly 08:00 → wiki-lint 09:30）。
- **纯维护/统计类 → 分散周中**：不依赖周末完整性，摊到周二/周四/周五。
- **LLM 密集型 → 尽量避开老板开工后的密集交互时段**（额度与 dsh 共用，见
  `KNOWLEDGE.md` K111）。周一 07:00–08:00 是「老板刚起、尚未开工」的窗口。
- ⚠️ **用「可见性」换「与交互争抢额度」是真实代价**，不是白赚：周日凌晨机器空闲
  但没人看，工作日白天有人看但可能和交互抢额度。选择已做，代价记在这里。

## 四、改排期时必做的五步

1. 改 `plugins/agint-cron/lib/jobs.js` 的 `schedule` **和它上面的时机注释**
   （注释里写明「为什么是这个点 / 避开了什么」，否则下次又有人踩）。
2. 跑 `node --test plugins/agint-cron/test/schedule-layout.test.mjs`，全绿才继续。
   若某条原则是故意违反的，改测试并在注释里写清理由——不要悄悄删断言。
3. 同步**三处**副本（漏一处 = 存量债，下次同步会被覆盖回去）：
   - `D:/DSH/project源码/DSH-AGINT/plugins/agint-cron/`（仓库，唯一事实源）
   - `C:/Users/Administrator/.dsh/profiles/web/node_modules/@agint/host/plugins/agint-cron/`（bundle 加载位）
   - `C:/Users/Administrator/.dsh/profiles/web/plugins/agint-cron/`（镜像位）
   同步后用 `md5sum` 对账，别信 mtime。
4. **必须重启 dsh 才生效** —— `agint-cron` 是 boot 期插件，`lib/*.js` 的热重载
   不覆盖它。⛔ 常驻进程只能老板双击重启，不要在会话里 spawn。
   重启后确认「进程 boot 时间 > 最后一次同步时间」再验收。
5. 同步 `cordis.patch.yml` 里提到 cron 时刻的注释（当前 4 处）与
   `plugins/agint-cron/README.md`、`docs/plugins/agint-cron.md` 的任务表。

## 五、已知边界（本原则不解决的事）

- **DSH 没拉起时排期照样不跑**。本文件只管「什么时候跑」，不管「跑不跑得到」——
  那是提案 `#391e7cf0`（日批 cron 调度器随 DSH 自动拉起）的范围，登记为依赖。
- **补跑风暴未治理**：错过的 job 会在启动后一次性涌进同一个 tick。补跑本身是
  正确行为（`isDue` 设计如此），但一坨串行长任务的表现尚未量化。要治理属于新
  功能（改 tick 语义），风险高于收益，暂不做。
- **`diagnosis-watchdog` 限流待验证**：`*/30 * * * *` → `*/30 7-23 * * *`
  （48→34 次/日）的前提是「深夜无人活动」。先观测 diagnosis annotations 的产出
  时间分布再决定；**未验证前不动**（测试里钉住了当前表达式）。
- **`cron_state.lastResult` 恒为字符串 `"ok"`**，不能用来判断「这次是不是真按
  排程跑的」。判据要用 `lastRunAt` 与计划时刻对齐到分钟。

## 六、现状排期一览（2026-09-28 重排后）

| 时刻 | job | 频率 |
|---|---|---|
| Mon 02:30 | memory-decay | weekly |
| daily 03:00 | night-dream | daily |
| daily 04:00 | metrics-collect | daily |
| daily 04:30 | tool-stats-backfill | daily |
| daily 04:45 | prompt-static-check | daily |
| daily 05:15 | skill-autocreate-aggregate | daily |
| daily 05:45 | skill-autocreate-release | daily |
| daily 06:15 | skill-autocreate-observe | daily |
| Mon 07:00 | curator-weekly | weekly |
| Mon 07:30 | evolve-review | weekly |
| Mon 08:00 | oracle-weekly | weekly |
| Mon 09:30 | wiki-lint | weekly |
| Tue 07:00 | evolution-cycle | weekly |
| Tue 09:30 | baseline-regression-suite | weekly |
| Thu 09:30 | curriculum-weekly | weekly |
| Fri 09:30 | skill-graph-weekly | weekly |
| daily 09:00 | oracle-daily | daily |
| 每月 1 日 10:00 | oracle-monthly | monthly |
| 每 30 分钟 | diagnosis-watchdog | high-freq |

周日 02:00–07:00 窗口内的任务数：13 → 7（剩下的全是分散的日任务）。
同分钟撞车：2 组 → 0。
