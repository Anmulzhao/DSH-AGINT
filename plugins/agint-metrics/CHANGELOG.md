# Changelog — agint-metrics

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
