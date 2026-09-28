# Changelog — agint-metrics

## 1.1.1 — 2026-09-28 修复：summary() 透传 meta（神谕层总分虚标 100 根因）

**事故**：2026-09-28 晨报（oracle-daily）美总分播 100，同日标定应为 52.4。四维里
noise / confidence / redundancy 全 N/A——采集侧数据齐（存储 meta 完整）、消费侧
全 null。根因：`service.js` `summary()` 返回体漏带 `meta` 字段（`series()` 一直带），
而神谕层派生全靠 meta（noEvidence.count / rulesTotal / wiki.total /
avgConfXCompliance / fileCount）。两侧单测各自全绿、接缝处静默断裂——Day 0 的
AC-0a 用 computeMetrics 直测，绕过了 service 层，接缝无测试覆盖。

- 修复：`summary()` 的 metrics.push 补 `meta: rec.meta`（与 series() 口径一致）
- 新增 `test/service-summary.test.js`：真实 service（内存表 + 假源）走 collect →
  summary，断言四类 meta 落地且与 series() 同源——把接缝钉死
- 复算验证：用 2026-09-27 20:00 生产 meta 逐项代入 §3.6 公式 = 53.6 分（与
  09-27 标定 52.4 的差异为 wiki 18→19 页、memory 336→362 条的自然波动）
- 部署：bundle 位 + 兼容位两处 service.js 已同步（需重启 dsh web 生效）

**连带澄清**：09-28 weekly 广播 `proposals: 0` 是同一根因的下游症状（四维 N/A →
无扣分 → buildWeeklyProposals 无料可提），修复后自愈，非独立 bug。

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
