# Changelog — agint-metrics

## 1.1.0 — 2026-09-27 美的神谕层 Day 0（方案 C：原子归 metrics，派生归神谕层）

- 新增 `lib/metrics-ext.js`：METRIC_DEFS_EXT 4 个原子 key
  - `autocreate.candidatesRejected`（skillAutocreate.stats().candidates.byStatus.REJECTED；stats 缺席退化 listCandidates 自数）
  - `skills.totalBytes`（两处 skills 根 Σ SKILL.md 字节；`makeSkillsFsSource` 递归遍历）
  - `evolution.logCount7d` / `evolution.logCount30d`（agint.evolution.getLogRange 一次 30d 窗 + 本地分窗，limit 放开避免 200 截断）
- `metrics.js`：METRIC_DEFS = 基础 13 + 扩展 4 = 17；computeMetrics 尾部接入扩展块（整体 try/catch 不拖垮基础 key）
- 三个既有 key 的 **meta 增补**（value 一律不动）：
  - `rules.lintIssues.meta.rulesTotal`（rules.list()，冗余度分母）
  - `wiki.orphans.meta.total`（lint().checked，噪声比分母）
  - `memory.total.meta`：`noEvidence{count,ids(cap50),capped}` + `avgConfXCompliance`（Σ(conf×[evidence非空])/N，神谕层决策确信度口径）
- `service.js`：sources() +3（skillAutocreate / evolution / skillsFs），懒解析软降级
- 新增 `test/metrics-ext.test.js`（扩展 key / 防御 / meta 增补 / 17 defs 断言）

## 2026-09-20 — 事件总线接线（方案 A / A2）：mount.* 补订阅方

**背景**：mount 六个 topic 有真实发布方、但**订阅方为 0**，挂载成功/失败完全不可观测，
只能翻 tickets 表。

- 新增 `lib/mountCounters.js`：订阅 `mount.requested / succeeded / failed /
  restart-requested / restart-completed / restart-failed`，每条事件写一条计数记录
  （key：`mount.succeededCount` 等），meta 保留 ticketId 与 reason 便于对账
- `index.js` 在 domain open 后挂载该订阅
- 新增 `test/mount-counters.test.mjs`（6 项）

**顺带修复**：disposer 里 `if (domain) return domain.close();` 会在 domain 打开后
**跳过 bus 订阅注销**。已改为先注销所有订阅再关 domain。

## 1.0.0 — Sprint 12 A5
- 顶层 stub 补建：`manifest.json` / `CHANGELOG.md` / `README.md` / `test/smoke.mjs`
- 沿用真实 lib 版本号 1.0.0
- 接入 `agint.eventBus` 的 `policy.deployed` / `policy.rolledback` 影子计数（`policyCounters.js`，已实装）
- 不变量：lib/ 真实代码未改动
