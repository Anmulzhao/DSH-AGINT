# AGINT Safe-Update SOP — 挂载/重启前准备与回滚

> 来自 2026-08-21 重启崩溃复盘。由 Codex 出方案、我（智进）整合落地。配套脚本 `bin/safe-update.sh`。

## 一句话口诀

> **挂载/更新/重启 AGINT 任何东西之前**：① 拍 4 份快照（patch / preset / plugins tar.gz / storages）
③ `kill -SIGTERM` 而非 SIGKILL（让 cordis fiber dispose 跑完）
④ 重启后 `cat sentinel.lease` 看 `at` < 30s
⑤ 崩了就 `plugin → patch → preset` 倒序回滚，storage 默认不回滚。

---

## Phase 1 · 挂载新插件前 — 固化动态状态

| 项 | 为什么 | 不做会怎样 | 怎么做 |
|---|---|---|---|
| pending approval 全部跑完 | `cordis_run/update/stop` 的 await 会被 SIGTERM 截断 | 审批请求变成「孤儿」，下次重启被认作被动 | 在 DSH 会话里 `await` 完所有 in-flight 异步 |
| in-flight cron job | `agint-cron` 写到 `agint_metrics.json` / `agint_evolve.json` 中途断 | JSON 半写、metrics 序列断点 | `cron_list` 看 last_run，距 now > 5min 才安全 |
| tool-stats appender 缓冲区 | `agint-tool-stats` 是 appender（不 fsync）| 末尾几条调用记录丢失 | `lsof \| grep agint_tool_stats.jsonl` —— 持锁就等闲时 |
| sentinel lease | 重启会让别的 watcher 误以为我还活着 | sentinel 误 fire，吵醒老板 | `cat ~/.dsh/sentinel.lease` 记下 owner，重启后由新进程重新声明 |

## Phase 2 · 改源码/preset 前 — 必快照

| 文件 | 备份位置 | 命令 |
|---|---|---|
| `~/.dsh/profiles/web/cordis.patch.yml` | 同目录 + `.bak-<TS>` | `cp -a cordis.patch.yml cordis.patch.yml.bak-$(date +%Y%m%d-%H%M%S)` |
| `~/.dsh/.agent-presets/agint/agent.cordis.yml` | 同目录 + `.bak-<reason>-<TS>` | `cp -a agent.cordis.yml agent.cordis.yml.bak-<reason>-$(date +%Y%m%d-%H%M%S)` |
| `~/.dsh/profiles/web/plugins/agint-*/` | `~/.dsh/.agint-backups/agint-plugins-<TS>.tar.gz` | `tar czf ~/.dsh/.agint-backups/agint-plugins-$(date +%Y%m%d-%H%M%S).tar.gz -C ~/.dsh/profiles/web/plugins --exclude='*.bak-*' agint-*` |
| `~/.dsh/storages/agint*.json` + `agint_tool_stats.jsonl` | 同目录 + `.bak-<TS>` | 见 `safe-update.sh snapshot_storages` |

> 备份目录 `~/.dsh/.agint-backups/` 由 `safe-update.sh` 自动 `mkdir -p`。每个 `.bak` 至少保留 5 份历史再考虑清理（disk cheap）；时间戳精确到分钟。

## Phase 3 · 重启 `dsh web` 前 — 优雅退出 + 现场保留

```bash
# 1. 告诉老板「要重启了」，得到确认（高风险 = ask 门禁）
# 2. 触发 dsh 优雅退出（走 ctx.appExit 路径，回收插件树）
pkill -SIGTERM -f "dsh web"
# 3. 等10s 才兜底 SIGKILL
for i in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 <pid> 2>/dev/null || { echo "graceful OK (${i}s)"; break; }
  sleep 1
done
pkill -SIGKILL -f "dsh web"  # 兜底
# 4. 保留现场（不要删！）
#    ~/.dsh/storages/agint*.json + .jsonl       ← 全部留着
#    ~/.dsh/sessions/                            ← 全部留着
#    ~/.dsh/profiles/web/plugins/*.bak-*         ← 全部留着
#    ~/.dsh/.agint-backups/                      ← 全部留着
# 5. 清临时锁
rm -f ~/.dsh/sentinel.lease.tmp ~/.dsh/storages/*.tmp
# 6. 再起 dsh web
cd ~/projects && nohup dsh web > /tmp/dsh-web.log 2>&1 &
```

## Phase 4 · 验证重启安全 — smoke test

```bash
# 1. sentinel lease 在 30s 内被新进程认领
sleep 5; cat ~/.dsh/sentinel.lease   # 看 owner = 新 pid, at < now+30s

# 2. 6 个内置 cron job 都在
grep -lE 'memory-decay|wiki-lint|night-dream|metrics-collect|prompt-static-check|evolve-review' \
  ~/.dsh/profiles/web/plugins/agint-cron/lib/jobs.js

# 3. tool_stats 行数 + dom 文件完整
wc -l ~/.dsh/storages/agint_tool_stats.jsonl
for d in agint agint_rules agint_metrics agint_evolve; do
  test -f ~/.dsh/storages/${d}.json || echo "MISSING ${d}.json"
done

# 4. 9-service 深度验证（在 agint 会话里跑 cordis_inspect_self）
# → 这个我做，不进 shell 脚本
```

## Phase 5 · 崩了回滚路径 — 基于 `.bak-*` 倒序恢复

**原则**：依赖图反向 —— 先恢复底层（plugin 源码），再恢复配置（patch / preset），最后才是数据（storage）。

| 步骤 | 为什么 | 怎么做 |
|---|---|---|
| 5.1 停 dsh web | 任何"在跑"状态下回滚源码，下个 tick 又被覆盖 | 同 Phase 3 |
| 5.2 找回滚锚点 | `.bak-YYYYMMDD-HHMMSS` = 备份时刻；越近越安全 | `ls -lt ~/.dsh/profiles/web/cordis.patch.yml.bak-* \| head -5` |
| 5.3 回滚 plugin 源码 | plugin 是 patch 引用目标，patch 写错回滚时 plugin 也得跟上 | `tar xzf ~/.dsh/.agint-backups/agint-plugins-<TS>.tar.gz -C ~/.dsh/profiles/web/plugins/` |
| 5.4 回滚 cordis.patch.yml | patch 是 host 入口 | `cp -a cordis.patch.yml.bak-<TS> cordis.patch.yml` |
| 5.5 回滚 agent.cordis.yml | preset 是 realm 入口 | `cp -a agent.cordis.yml.bak-<TS> agent.cordis.yml` |
| 5.6 回滚 storage（**谨慎**） | storage 回滚 = 丢从快照到现在的所有写入（memory 32 条 → 15 条，proposal 演进全没） | **默认不回滚**；除非确认本次 schema migration 写坏。`jsonl appender 不回滚`（会破坏时间线） |
| 5.7 清 sentinel lease | 旧 owner 残留可能让新进程被认作 passive | `rm -f ~/.dsh/sentinel.lease ~/.dsh/sentinel.lease.tmp` |
| 5.8 重启 + smoke | 验证回滚后能跑 | `cd ~/projects && dsh web &`；跑 Phase 4 全部 6 项 |
| 5.9 万一回滚还崩 | 切到里程碑快照 `~/.dsh/backups/stable-1.0/`（已实测存在，2026-08-19 20:32 创建） | 全量覆盖 plugin + patch + preset；**storage 和 sessions 全量覆盖 = 回到那个时间点 —— 慎用** |

**回滚顺序口诀**：plugin → patch → preset → (storage 最后)；倒过来读：**数据 → 配置 → 源码**。

---

## 配套脚本

`bin/safe-update.sh` 把 5 个 Phase 压成一个脚本，参数化 4 个动作：

```sh
./safe-update.sh mount-patch      # 快照 + 编辑 cordis.patch.yml + 重启
./safe-update.sh edit-source      # 快照 + 编辑 plugins/.../lib/*.js + 重启
./safe-update.sh restart          # 优雅停 + 启动 + smoke
./safe-update.sh rollback <TS>    # 倒序回滚到指定时间戳
./safe-update.sh smoke            # 只跑 smoke test
./safe-update.sh help             # 用法
```

详见 `bin/safe-update.sh` 源码。

---

## 关联

- `AGENTS.md` 边界章节 —— 一句话口诀已同步
- `docs/operations/dsh-restart-incident-20260821.md` —— 这次崩的根因报告
- `bin/safe-update.sh` —— 脚本实现
- AGINT rule `agint-safe-update-advisory` —— 写入 plugins/ 或 preset 时 advisory 提示
- Memory `codex-not-resident` (L1) —— Codex 注入方式
- Memory `dsh-restart-incident-20260818` (L2) —— 历史事件