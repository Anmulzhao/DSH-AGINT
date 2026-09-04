# Changelog — agint-evolution-memory

## 0.6.5 (2026-09-04) — Batch 2.1 preset tools

### Added

- **`lib/tools.js`**（preset-scoped model tools，168 行）：
  - 11 个 model-visible 工具：`evolution_logPhase4` / `evolution_logPhase4Buffered` / `evolution_readLogRangeMerged` / `evolution_flushLogBufferNow` / `evolution_addFailure` / `evolution_addSuccess` / `evolution_queryFailures` / `evolution_queryTemplates` / `evolution_getLogRange` / `evolution_decayScanRun` / `evolution_stats`
  - K19 兜底：所有 `execute` 走 `JSON.parse(JSON.stringify(s))` 防止 dsh-tools lossless-JSON 校验拒
  - 全部 output schema `additionalProperties: true`（per K19 教训）
- **5 个 write 工具 ask gate**（按老板 2026-09-04 决策）：
  - `evolution_logPhase4` / `evolution_logPhase4Buffered` / `evolution_addFailure` / `evolution_addSuccess` / `evolution_flushLogBufferNow` 走 rule_check ask gate
  - `evolution_decayScanRun` 走 L1-L4 衰减（不入 ask gate，独立兜底）
- **`test/smoke.mjs`** 改写：内联原 `log-buffer.test.mjs` 的 9 个单测契约 + tools.js 注册 11 工具 + dim5.5 跨平台 fixture（forward-slash ✓ + `../escape` ✓ 双覆盖）
- **`manifest.json`**：`tests.entry` 从 `test/log-buffer.test.mjs` → `test/smoke.mjs`；`version` 0.6.4 → 0.6.5
- **`package.json`**：`version` 0.3.0 → 0.6.5（与 manifest 同步）

### Compatible

- 仓 `lib/index.js` 不动（FROZEN Service 签名 11 个方法保留向后兼容）
- 原 `test/log-buffer.test.mjs` 保留作为独立单测入口（`node --test`）

## 0.6.4 (2026-08-27) — Sprint 10 #7 收口

### Added

- **EvolutionLogBuffer**（`lib/log-buffer.js`，117 行）：
  - `createLogBuffer({storage, memFallback, flushCount=10, flushMs=5000})`
  - `enqueue / flush / readMerged / shutdown` 4 个方法
  - 计数 ≥10 / 时间 ≥5s 触发同步落盘
  - 退出钩子：ctx.effect() disposer 强制 flush
  - 失败兜底：写 agint.memory 一条 `buffer-lost:<count>`
- **3 个新 Service**（extend 不破 FROZEN）：
  - `logPhase4Buffered({...}) → { queued: true, id }`（异步路径）
  - `readLogRangeMerged(opts) → Entry[]`（buffer + storage 合并视图）
  - `flushLogBufferNow() → { flushed, lost }`
- **9 个新单测**（`test/log-buffer.test.mjs`）：覆盖计数触发 / 时间触发 / 失败兜底 / readMerged 去重 / 子串过滤 / shutdown 强制 / 真实 plugin 路径 / 参数校验

### Compatibility

- logPhase4 旧同步路径 FROZEN 不动（向后兼容）
- 不引用 quality-contract FROZEN 接口
- 不挂顶层 cordis.patch.yml（本 Sprint 仅仓库发版）

## 0.3 — Sprint 2/3 落地（独立 plugin）

- 物理隔离的进化记忆存储域 + 三表 + L1-L4 衰减 + 100/50 上限
- 与 agint-memory 不同 storage domain