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

| job id | 调度 | 说明 |
|---|---|---|
| `memory-decay` | `30 2 * * 1` | L1–L4 衰减扫描 + 应用降级/清除（weekly） |
| `wiki-lint` | `0 3 * * 0` | 断链/矛盾/孤岛三项检查（weekly） |
| `metrics-collect` | `0 4 * * *` | 采集 memory/wiki/cron/rules 健康指标（daily） |
| `evolve-review` | `45 3 * * 0` | 采集数据快照 → 自动发现 → 写周复盘（weekly） |
| `night-dream` | `0 3 * * *` | 读会话日志 → 提取候选 → 评分 → 提升进记忆（daily） |
| `tool-stats-backfill` | `30 4 * * *` | 用 session log 给工具统计反向补 latencyMs（daily） |
| `prompt-static-check` | `45 4 * * *` | 扫 prompt manifest+template 静态检查（daily） |

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
