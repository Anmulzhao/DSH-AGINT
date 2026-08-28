# Changelog — agint-evolution-memory

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