# agint-cron

智进 (agint) 的 Cron 调度器插件。在 DSH 上提供一个 5 字段 cron 调度 host Service（`agint.cron`），基于 `cordis-plugin-timer` 的 60 秒 tick，到点触发已注册的 job 并做每 job 的互斥（per-job mutex，防重叠）。

## 能力

### 提供的 Service：`agint.cron`

| 方法 | 说明 |
|---|---|
| `list()` | 列出全部 job 的 schedule / lastRunAt / nextRunAt / 状态 |
| `runNow(id)` | 手动立即触发某个 job（返回结果或错误） |
| `health()` | 报告健康：逾期 job、错过的窗口、last-run 时间戳 |

### 注册的工具（preset 平面）

| 工具 | 说明 |
|---|---|
| `cron_list` | 列出所有 job 的调度、上次/下次运行、健康 |
| `cron_run_now` | 按 id 手动触发某 job（测试/补跑） |
| `cron_health` | 报告 cron 健康（逾期/错过窗口） |

### 默认注册的 job

共 22 个（按调度粒度分组，组内按时刻排序）。**2026-09-28 全体重排**：
原本 8 个周任务全部堆在周日凌晨，另有 2 组同分钟撞车。排期原则与改动理由见
[`docs/operations/cron-schedule-principles.md`](../../docs/operations/cron-schedule-principles.md)，
并由 `test/schedule-layout.test.mjs` 强制（改排期违反原则会直接测试红）。

**高频巡检**

| job id | 调度 | 说明 |
|---|---|---|
| `diagnosis-watchdog` | `*/30 * * * *` | 诊断域看门狗：各表占用率 + report() 频率熔断状态（2026-09-26 事故后新增；限流待验证，未动） |

**每日**

| job id | 调度 | 说明 |
|---|---|---|
| `night-dream` | `0 3 * * *` | 读会话日志 → 提取候选 → 评分 → 提升进记忆（daily） |
| `metrics-collect` | `0 4 * * *` | 采集 memory/wiki/cron/rules 健康指标（daily） |
| `tool-stats-backfill` | `30 4 * * *` | 用 session log 给工具统计反向补 latencyMs（daily） |
| `prompt-static-check` | `45 4 * * *` | 扫 prompt manifest+template 静态检查（daily） |
| `skill-autocreate-aggregate` | `15 5 * * *` | 聚合工具调用 → 检测重复任务模式 → 生成候选（daily，LLM 密集；原 04:45 与 prompt-static-check 撞车） |
| `skill-autocreate-release` | `45 5 * * *` | 评估桥 + 发布队列：三道门自动发布（daily，原 05:15） |
| `skill-autocreate-observe` | `15 6 * * *` | 观察期判定：STABLE / 0 调用自动回滚 / 展期（daily，原 05:30） |
| `memory-provider-health` | `30 8 * * *` | 记忆 provider 定期健康检查（daily 08:30；落 `health_checks`，**只告警不自动切换**；2026-10-01 新增，P1-1 阶段 3） |
| `oracle-daily` | `0 9 * * *` | 美谕晨报（daily 09:00 —— **周任务要避开这个固定位**） |

**每周**

| job id | 调度 | 说明 |
|---|---|---|
| `memory-decay` | `30 2 * * 1` | L1–L4 衰减扫描 + 应用降级/清除（Mon 02:30，纯计算无 LLM，未动） |
| `curator-weekly` | `0 7 * * 1` | 技能策展：陈旧检测 + 归档（Mon 07:00，**必须早于 evolve-review**；P0-2 Sprint 14） |
| `evolve-review` | `30 7 * * 1` | 采集数据快照 → 自动发现 → 写周复盘（Mon 07:30，老板在线时段） |
| `oracle-weekly` | `0 8 * * 1` | 美谕周报（Mon 08:00，紧接周复盘串读；原周日 21:00） |
| `wiki-lint` | `30 9 * * 1` | 断链/矛盾/孤岛三项检查（Mon 09:30；原周日 03:00 与 night-dream 撞车） |
| `evolution-cycle` | `0 7 * * 2` | 闭环引擎驱动（Tue 07:00，复盘后第一波；原周日 04:15） |
| `evolution-reconcile` | `0 8 * * 2` | 闭环取数三方对账（Tue 08:00，evolution-cycle 后 1h；Phase -1.1；**⛔ 只读出声不写盘**，见下方注） |
| `baseline-regression-suite` | `30 9 * * 2` | 写一行 mount 通道 baseline 状态（Tue 09:30；原周日 03:15） |
| `outcome-measure` | `15 10 * * 2` | 进化实测对账：双态跑改动面测试子集量 `actualDelta` 落 `prediction_outcomes`（Tue 10:15；Phase 1.1 支点 1b；零 LLM；**护栏未核过即抛错出声**，见下方注） |
| `curriculum-weekly` | `30 9 * * 4` | 边界探测 → 待练域生成挑战（Thu 09:30，出队不自动执行；原周日 05:00） |
| `skill-graph-weekly` | `30 9 * * 5` | 技能节点全量刷新 + 四类边重算（Fri 09:30，默认 count-only 标定期；原周日 07:00） |

**每月**

| job id | 调度 | 说明 |
|---|---|---|
| `oracle-monthly` | `0 10 1 * *` | 美谕月报（每月 1 日 10:00，未动） |
| `spec-index-refresh` | `30 10 1 * *` | 协议索引只读巡检：审计 `docs/specs/INDEX.json` 与磁盘是否漂移（每月 1 日 10:30；**⛔ 只读不写盘**；需配 `repoRoot`，否则 soft-skip；2026-10-03 新增，Phase-3 轨道 C） |

> ⚠️ `spec-index-refresh` 需要配置项 `repoRoot` 指向 AGINT 仓库根。
> **默认 null 是有意的**：宿主上可能有多份 AGINT 检出，猜错会去审计另一份仓库
> 并报出一堆并不存在的漂移 —— **假警报比不报警更坏**。未配置时 job 走 soft-skip，
> 理由写进 `lastResultSummary`（`REPO_ROOT_UNKNOWN`）。
> ⚠️ 常驻宿主上通常 soft-skip：bundle 部署位只有 `cordis.patch.yml` / `package.json` /
> `plugins/`，**没有 `docs/` 也没有 `bin/`** —— 这是「能力不在这一层」，不是故障。

> ℹ️ `evolution-reconcile`（Phase -1.1）与 `spec-index-refresh` 不同：判据已**下沉进本插件
> `lib/evolution-reconcile-core.js`**（随 bundle 部署），所以 3 个存储源（event_bus /
> population / mutator，读 `$DSH_HOME/storages/`）在**常驻宿主上照常对账**，不依赖 `bin/`。
> 只有第 4 源 preimage（回滚备份核对，R2 安全红线）需要 `config.repoRoot` 指向含
> `.agint-preimage/` 的仓根；未配则降级为「跳过 preimage 源」并记 note，**不影响前 3 源**。
> ⇒ 想让 R2 也生效：在 HOME `cordis.patch.yml` 给 agint-cron 加 `config: {repoRoot: <仓根>}`
>   并重启（部署动作，每台机器各配，不入库）。

> ℹ️ `outcome-measure`（Phase 1.1 支点 1b）与上面两个又是第三种形状：**判据与副作用都在
> `agint-evolution-driver` 的 lib 里**（双态跑测试 + 临时换 preimage + 复原核 sha），
> 本插件的 action 只做映射与出声。它需要 **driver 那一侧** 能解析出 `repoRoot`
> （env `AGINT_EVOLUTION_DRIVER_REPO_ROOT` > driver `config.repoRoot`）；
> 两者都没有 ⇒ `NO_REPOROOT` ⇒ `lastResult.status = skipped`，不是失败也不是"没东西可测"。
> ⚠️ 它与 `evolution-reconcile` 一样会 `throw`，触发条件有两类：
> ① 某条测量的复原护栏没核上（`needsAttention`）—— 临时换文件没干净收尾，源码树可能仍处基线态；
> ② 归档校验发现异常（`audit.tampered` 锁重算对不上 / `audit.orphanPredictions` 链上有预测而锁行没了）——
>   这是安全事件，`contract_locks` 既不可覆盖也不可删除。
>   ⛔ 但 `audit.ok:false`（服务不可用 / 插件未重启）**不抛错**，只在 `report.auditChecked=0` 里如实带出：
>   "查不了"与"查过没问题"靠数字区分，不靠每周一次的常驻红色区分。


> **`diagnosis-watchdog` 的判据**（全为绝对值，故无需持久化历史）：表占用率 ≥80% cap 报 WARN、
> ≥cap 报 CRITICAL；`reportRateGuard.trips > 0`（频率熔断真被咬过）报 WARN；
> 近一个窗口内 `recent > max/2` 报 WARN。异常走 `throw` —— 这样告警会同时进
> `console.error`、`cron_state.lastError` 与 `cron_list` 的 `lastOk=false`，
> 而不是被静默吞掉。服务未挂载时 soft-skip。

### 存储域：`agint_cron`

每个 job 的 `lastRunAt` / `lastResult` / `lastError` 持久化到独立的 `agint_cron` storage domain（`cron_state` 表）。这样 host 进程重启后再跑 `cron_list`，能**恢复真实的 last-run 时间戳**，而不是显示 `never`。存储域打开失败时自动降级为内存-only（不阻塞调度，与旧行为一致）。

## 加载

host 插件通过 dsh 的 user-patch 层挂载：

```yaml
# profile-patches/web/cordis.patch.yml
- insert:
    - id: agint-cron
      name: ./plugins/agint-cron/lib/index.js
```

preset 侧工具（可选）：

```yaml
# preset agent.yml
- id: agint-cron-tools
  name: ../../plugins/agint-cron/lib/tools.js
```

## 使用示例

查看当前调度与健康：

```sh
cron_list
```

手动补跑某个 job：

```sh
cron_run_now --id wiki-lint
```

## 依赖与约束

## 宿主 schedule 桥（v0.2.2，行动 #2）

`lib/host-schedule.js`：桥接宿主 `@deepseek-ai/dsh-schedule`（0.1.7-rc.2，宿主已带）。
宿主 `canonicalizeCronExpression` 校验全部 job、catalog 只读镜像、懒加载；宿主缺失时降级
`hostAvailable:false`。**有意不调用宿主 `create()`**（宿主投递语义是"提醒注入 agent session"，
与 cron action 直调不同，留待拍板）。Service 面新增只读 `agint.cron.hostSchedule`。


- **inject**：`timer`（cordis-plugin-timer）、`storageDomain`（dsh-storage-domain）
- **生命周期**：60s `setInterval` 通过 `ctx.effect` 注册 disposer；无事件监听
- **权限**：读 `DSH_HOME`、读 `plugins/`；无网络；不 spawn 子进程
- **挂载顺序**：mountOrder 20

完整准入规范见 [`docs/plugins/PLUGIN-SPEC.md`](../docs/plugins/PLUGIN-SPEC.md)。
