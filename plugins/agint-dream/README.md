# agint-dream

AGINT 梦境服务：夜间（cron `0 3 * * *`）离线整合会话历史，提炼偏好/决策/教训/规律候选，过门控后提升进 `agint.memory`。三阶段：Light（信号采集）→ REM（启发式候选）→ Deep（评分 + 提升）。

## 架构

- **`lib/index.js`** — Host 服务 `agint.dream`。单实例，独占 `agint_dream` storage domain。
- **`lib/sweep.js`** — 核心：扫 sessions → 信号采集 → 候选提取 → 评分 → 提升。
- **`lib/consolidation.js`** — P1 LLM consolidation（**无降级**：失败即跳过本轮提升，不退回启发式）。
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
| `consolidation=failed` | P1 LLM consolidation 失败：本轮不提升任何候选（无启发式回退），错误进 diary/errors |
| `sessions=0` 且 `userMsgs=0` | 扫描窗口（默认 2d）内没新会话；非 bug |
| `candidates=0` 但 `userMsgs>0` | 看日记「准入」行：`shape` 口径下候选只受形态判据约束（形态判据在抽取层），`0` 说明 assistant 正文里也没有形态合格的句子；`repetition` 口径下则是没跨过 `minScore / minRecall / minUniqueSessions` |
| `consolidation=failed` 且 reason 里是 `stopReason=error` | 多半是**推理档位不被宿主支持**：宿主 `resolveReasoningLevel()` 对模型没声明的档位抛 `UNSUPPORTED_REASONING_EFFORT`。查 profile patch 里该模型的 `reasoningEfforts` 是否声明（2026-11-07 曾因此恒失败，详见 CHANGELOG v0.9.0） |
| `toolErrorFilter 拦=` 数量骤增 | 正常：v0.4.0 起工具 stderr 原文不再直接进候选池，v0.5.0 起判据收紧为「因果句式」，v0.7.0 起错误信号改用结构化字段判定 + 正交判据（中文语境 / 非结构符号）。日记「工具错误因果过滤」行看分档（`noise-shape` / `no-causal-clause` / `structural-symbol` / `no-chinese-context`） |
| 某类报错本该沉淀却没进记忆 | v0.7.0 起判据是**正交**的：必须①是结构化判定的真实失败（或严格前缀开头）②是一句**中文**陈述③不含代码/日志骨架符号（`{ } ( ) [ ] < > = |`）④带因果句式。任何一条不满足即拦下。确认确有价值就手工 `memory_write`（README 口径：原始 stderr 不是主张） |

## 配置（cordis.patch.yml `agint-dream.config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `minScore` / `minRecall` / `minUniqueSessions` | 0.6 / 3 / 2 | 候选过门控阈值（**仅 `admissionMode='repetition'` 时生效**） |
| `admissionMode` | **shape** | v0.9.0：准入口径。`shape` = 形态准入（复现次数只当评分权重，「该不该记」交给 P1 LLM 裁决）；`repetition` = 旧口径（同句逐字复现 ≥3 次且跨 ≥2 会话）。运行时可改 |
| `maxGated` | 20 | 每轮进 LLM 的候选上限（按 score 取前 N 条，截断数写进日记） |
| `dedupeTieredEnabled` / `dedupeHigh` / `dedupeMid` | true / 0.85 / 0.6 | 分级去重 |
| `toolErrorDiagnosticOnly` | **true** | v0.5.0：工具错误信号「因果句式」过滤（抽取闸 + 提升边界闸）；v0.7.0：信号层改结构化字段判定，候选层改正交判据。`false` 完全回退旧行为（全部放行） |
| `zeroHitAlert` / `zeroHitAlertThreshold` | true / 3 | 连续零命中告警 |

后三项也可运行时改（内存态，重启还原）：`agint.dream.config({ toolErrorDiagnosticOnly: false })`。
`admissionMode` 同样可运行时改（回滚开关）：`agint.dream.config({ admissionMode: 'repetition' })`。

## 候选来源与准入口径（v0.9.0）

**候选有三条来源**：

| 源 | 判据 |
|---|---|
| 用户原话 | 命中「偏好/决策/教训/规律」4 类关键词桶之一 |
| **assistant 正文**（v0.9.0 新增） | 含经验/要求词 · 10–160 字 · 非引用块 · 非记忆条目形态 · 无代码骨架/路径 · 非工具回显 · 非疑问句 |
| 工具错误 | v0.7.0 的正交判据（结构化真实失败 + 中文陈述 + 无骨架符号 + 带因果句式） |

**准入有两种口径**（`admissionMode`，出厂 `shape`）：

- `shape`（新）：**不看复现次数**。复现次数退回评分权重（frequency / diversity / consolidation），
  「该不该记」由 P1 LLM consolidation 裁决（它能判 add / merge / supersede），
  校验门兜底（loss fraction ≤ 0.25、lineageKey、operations 与 gated 1:1）。
  准入上限 `maxGated` 控制每轮进 LLM 的量。
- `repetition`（旧）：`score ≥ minScore` ∧ 同句复现 ≥ `minRecall` ∧ 跨 ≥ `minUniqueSessions` 个会话。

**为什么改**（2026-11-07 实测）：真实语料里「同一句逐字复现 ≥3 次且跨 ≥2 会话」几乎不存在 ——
7 天窗口 60 个会话里，用户原话 75 个不同句子 + assistant 主张 54 个 = 129 个，
重复度分布几乎全是「1 次 / 1 会话」，够门槛的只有 1 个 ⇒ 老门槛把候选池永久关死，
梦境自 2026-10-21 起过门数持续为 0，最后一次非零提升是 2026-10-20。

**日记里能看见什么**（v0.9.0 新增两行）：

```
- 候选来源：用户原话 0 · assistant 正文 3 · 工具错误 0
- assistant 形态判据：句子 120 · 入池 3 · 挡 117（no-claim-word×100 · code×17）
- 准入：形态准入（复现次数只当权重，不作准入） · 上限 20 · 因上限截断 0
```
