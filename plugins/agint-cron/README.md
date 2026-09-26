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

共 15 个（按调度粒度分组，组内按时刻排序）：

**高频巡检**

| job id | 调度 | 说明 |
|---|---|---|
| `diagnosis-watchdog` | `*/30 * * * *` | 诊断域看门狗：各表占用率 + report() 频率熔断状态（2026-09-26 事故后新增） |

**每日**

| job id | 调度 | 说明 |
|---|---|---|
| `night-dream` | `0 3 * * *` | 读会话日志 → 提取候选 → 评分 → 提升进记忆（daily） |
| `metrics-collect` | `0 4 * * *` | 采集 memory/wiki/cron/rules 健康指标（daily） |
| `tool-stats-backfill` | `30 4 * * *` | 用 session log 给工具统计反向补 latencyMs（daily） |
| `prompt-static-check` | `45 4 * * *` | 扫 prompt manifest+template 静态检查（daily） |
| `skill-autocreate-aggregate` | `45 4 * * *` | 聚合工具调用 → 检测重复任务模式 → 生成候选（daily） |
| `skill-autocreate-release` | `15 5 * * *` | 评估桥 + 发布队列：三道门自动发布（daily） |
| `skill-autocreate-observe` | `30 5 * * *` | 观察期判定：STABLE / 0 调用自动回滚 / 展期（daily） |

**每周**

| job id | 调度 | 说明 |
|---|---|---|
| `curator-weekly` | `0 2 * * 0` | 技能策展：陈旧检测 + 归档（Sun 02:00，早于周复盘；P0-2 Sprint 14） |
| `memory-decay` | `30 2 * * 1` | L1–L4 衰减扫描 + 应用降级/清除（Mon 02:30） |
| `wiki-lint` | `0 3 * * 0` | 断链/矛盾/孤岛三项检查（Sun 03:00） |
| `baseline-regression-suite` | `15 3 * * 0` | 写一行 mount 通道 baseline 状态（Sun 03:15） |
| `evolve-review` | `45 3 * * 0` | 采集数据快照 → 自动发现 → 写周复盘（Sun 03:45） |
| `curriculum-weekly` | `0 5 * * 0` | 边界探测 → 待练域生成挑战（Sun 05:00，出队不自动执行） |
| `skill-graph-weekly` | `0 7 * * 0` | 技能节点全量刷新 + 四类边重算（Sun 07:00，默认 count-only 标定期） |

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

- **inject**：`timer`（cordis-plugin-timer）、`storageDomain`（dsh-storage-domain）
- **生命周期**：60s `setInterval` 通过 `ctx.effect` 注册 disposer；无事件监听
- **权限**：读 `DSH_HOME`、读 `plugins/`；无网络；不 spawn 子进程
- **挂载顺序**：mountOrder 20

完整准入规范见 [`docs/plugins/PLUGIN-SPEC.md`](../docs/plugins/PLUGIN-SPEC.md)。
