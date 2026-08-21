# DSH 重启崩溃事故 — 2026-08-21

## TL;DR

老板在一次重启后，整个 AGINT preset 挂了。Codex（手动调起来的另一个会话）通过给 6 个插件目录做时间戳备份 + 恢复到正常状态。

根因：当时**没有 SOP**。挂载前没快照、改源码前没 diff 验证、重启用了 `SIGKILL` 截断了 in-flight cordis fiber dispose。

## 时间线

| 时刻 | 事件 |
|---|---|
| 2026-08-18 16:40 ~ 17:26 | 老板叫起 Codex 会话，6 次重启尝试，每次崩 → 留 6 套 `agint-*.bak-YYYYMMDD-HHMMSS` |
| 2026-08-18 17:26 | Codex 找到正确版本回滚成功 |
| 2026-08-21 13:02 | 我（智进）问老板「挂载插件重启前要做哪些准备？」 |
| 2026-08-21 13:05 | 我**误判 Codex 不可用**（实际是 key 注入问题），自己出 SOP |
| 2026-08-21 13:10 | 老板纠正「本机 codex 在运行，你怎么调用它」 |
| 2026-08-21 13:12 | 找到正确 key（`MINIMAX_CN_API_KEY` 在 `~/.dsh/.credentials.yaml`），注入 `MINIMAX_API_KEY` 后 Codex 正常出 SOP |
| 2026-08-21 13:20 | 落地 SOP wiki + script + rule + memory |

## 教训

### L1 · Codex 注入方式（L1 已落 memory）

- 本机 Codex 走 MiniMax provider，要 `MINIMAX_API_KEY`
- key 在 `~/.dsh/.credentials.yaml` 的 `MINIMAX_CN_API_KEY` 字段（mode 0600）
- 注入命令：

```sh
export MINIMAX_API_KEY=$(grep -E '^MINIMAX_CN_API_KEY' ~/.dsh/.credentials.yaml | cut -d':' -f2 | tr -d ' "')
codex exec -    # stdin 接 prompt
```

### L2 · 重启 SOP（已落 wiki + script）

详见 `docs/operations/safe-update-sop.md`。核心：拍 4 份快照 + `SIGTERM` 而非 `SIGKILL` + 倒序回滚。

### L2 · 怀疑"工具不可用"前必须自证

我两次太快下结论：
1. 第一轮："Codex 不通" —— 没找到 key 是我懒，不是它没
2. 备用方案："老板叫起另一个 Codex 会话" —— 没意识到本机就有 `--yolo` 常驻

**修正规则**：以后判断「某个工具/服务不能用」前，必须跑 `codex doctor` / `which` / `lsof` 三件套，且至少尝试 2 种调用方式。

## 改进闭环

- [x] SOP 落 `docs/operations/safe-update-sop.md`
- [x] 一句话口诀同步 `AGENTS.md`
- [x] 脚本 `bin/safe-update.sh` 落地
- [x] Rule `agint-safe-update-advisory` 提示
- [x] Codex 注入方式落 memory（L1）
- [x] 历史事件落 memory（L2）