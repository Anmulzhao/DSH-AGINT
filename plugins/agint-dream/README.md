# agint-dream

AGINT 梦境服务：夜间（cron `0 3 * * *`）离线整合会话历史，提炼偏好/决策/教训/规律候选，过门控后提升进 `agint.memory`。三阶段：Light（信号采集）→ REM（启发式候选）→ Deep（评分 + 提升）。

## 架构

- **`lib/index.js`** — Host 服务 `agint.dream`。单实例，独占 `agint_dream` storage domain。
- **`lib/sweep.js`** — 核心：扫 sessions → 信号采集 → 候选提取 → 评分 → 提升。
- **`lib/consolidation.js`** — P1 LLM consolidation（可选走启发式降级）。
- **`lib/recall-store.js`** — P2 短期 recall store，跨日累积 + 剪枝。
- **`lib/validation-gate.js`** — 候选过门控前的 schema 校验。
- **`lib/quality-bridge.js`** — v0.2 REM 阶段调 qualityEvaluator。
- **`lib/evolution-bridge.js`** — v0.3 Deep 阶段读 success-templates 评分参考。
- **`lib/tools.js`** — Preset 工具：`dream_status` / `dream_run_now` / `dream_diary` / `dream_verify_consolidation`。

## 系统依赖

| 依赖 | 必装？ | 提供方 | 缺失症状 |
|---|---|---|---|
| `zstd` CLI | **是**（sweep 读 session.jsonl.zstd 用） | 镜像层（Debian/Ubuntu `apt-get install zstd`）或 `install/agint-zstd-bootstrap.sh` 兜底 | nightly sweep 每条 session 都 ENOENT，`sessions=0` 但 `validation=OK`（**静默**，2026-09-12 教训） |

> 镜像层**主动不装** zstd CLI（保持精简 ~50MB），由 `install/agint-zstd-bootstrap.sh` 在 install 阶段按需补。详见 `install/agint-zstd-bootstrap.sh` 顶部注释。

## 安装

照常 AGINT install：`bash install/install.sh`。4.55 段会自动调 zstd bootstrap。
若 bootstrap 跳过或失败，手动跑：
```bash
bash install/agint-zstd-bootstrap.sh
```

## 验证

```bash
bash install/agint-zstd-bootstrap.sh --check   # exit 0 = OK
dream_run_now --dry-run                        # 看 sessions > 0
```

## 故障排查

| 现象 | 排查 |
|---|---|
| `dream_diary` 全是 `zstd -dc ... ENOENT` | 跑 `bash install/agint-zstd-bootstrap.sh` |
| `consolidation=heuristic-degraded` | P1 LLM consolidation 失败，回退启发式；不阻断 sweep，但质量降级 |
| `sessions=0` 且 `userMsgs=0` | 扫描窗口（默认 2d）内没新会话；非 bug |
| `candidates=0` 但 `userMsgs>0` | 候选没跨过 `minScore=0.75 / minRecall=3 / minUniqueSessions=2` 门控；属正常 |
| `toolErrorFilter 拦=` 数量骤增 | 正常：v0.4.0 起工具 stderr 原文不再直接进候选池。日记「工具错误诊断过滤」行看分档（`noise-shape` / `no-diagnostic-signal`） |
| 某类报错本该沉淀却没进记忆 | 原文缺「为什么/应该怎样」线索 → 被诊断过滤拦下。确认确有价值就手工 `memory_write` |

## 配置（cordis.patch.yml `agint-dream.config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `minScore` / `minRecall` / `minUniqueSessions` | 0.6 / 3 / 2 | 候选过门控阈值 |
| `dedupeTieredEnabled` / `dedupeHigh` / `dedupeMid` | true / 0.85 / 0.6 | 分级去重 |
| `toolErrorDiagnosticOnly` | **true** | v0.4.0：工具错误信号诊断化过滤。`false` 完全回退旧行为（全部放行） |
| `zeroHitAlert` / `zeroHitAlertThreshold` | true / 3 | 连续零命中告警 |

后三项也可运行时改（内存态，重启还原）：`agint.dream.config({ toolErrorDiagnosticOnly: false })`。
