# Changelog — agint-quality-sandbox

## 2026-09-20 — 事件总线接线（方案 A / A3）+ 修复迁移遗留的 zod 硬编码路径

**背景**：`sandbox.passed` / `sandbox.failed` 既无发布方也无数据。根因是 v0.6.3 把本插件从
`plugins/agint-quality/agint-quality-sandbox/` 剥离为顶层插件时，**`publishSandboxEvent()`
没有跟着迁过来**（旧目录仍有，新目录丢失）。订阅方 `agint-diagnosis` 从上线起一条都没收到。

- 迁移回 `publishSandboxEvent()`，runVerify / runExplore 的**每个出口**（含抛错路径）都留事件
- `mode` 归一化到 schema enum `[sandbox, in-process]`（新版 mode 是 verify / verify-in-process 等）
- schemas 两个 yaml 一并迁到顶层 `schemas/`
- 新增 `test/shadow-publish.test.mjs`（4 项）

**顺带修复**：`lib/index.js:29` 硬编码 `import { z } from '../../agint-quality/node_modules/zod/index.js'`
指向已删除目录（同为迁移遗留）→ 该插件 20 个既有测试中 **9 个一直在失败**。改为 `from 'zod'` 后 20/20 通过。

## 0.7.1 (2026-09-17) — Sprint 18：sandbox.confine argv shape 防护

> 触发：老板发现 41 个 skill candidate 全部 BUDGET_WAIT（`autocreate_stats` 实证），
> rejectionReason `[policy] policy=REJECT（fail-closed）：policy-reject:veto-or-low-composite`。
> 根因：quality-eval 跑 Phase 2 时 sandbox.confine() 返回**非数组**结构（裸对象 `{ok, stdout, stderr}`），
> 原代码 `wrappedArgv = result.argv ?? result` 后 `argv.slice(1)` 抛 `TypeError: argv.slice is not a function`，
> finding 标 blocker，policy REJECT → release-manager veto fail-closed → 全候选卡 BUDGET_WAIT。

### Fixed

- **`runInMode()` sandbox.confine 返回 shape 校验**：
  - 之前：`wrappedArgv = result.argv ?? result` 直接 .slice
  - 现在：先 `Array.isArray(candidateArgv) && length>0 && typeof [0]==='string'` 校验，不是数组就 fail-safe 返回 `reason: 'sandbox-bad-shape'` + `fallback: 'in-process'`
  - 行为：**不抛**、**不 spawn**、policy 收到 `safety=0.0 / policyDecision=REJECT` 但带 sandbox-unavailable 信号，
    由 quality-eval 走 E0/provisional 路径，policy 给 PENDING_REVIEW，veto 模式放行
- **新增测试** `test/argv-shape-guard.test.mjs`（5 例）：覆盖 4 种异常返回（裸对象/字符串/null/正常 argv）+ 1 例抛错路径
- **不回退已有契约**：原有 `sandbox-confine-failed`（confine 抛错）路径行为不变

### 数据论证

- 修复前：policy 给 REJECT → 41 候选 BUDGET_WAIT → 0 release
- 修复后（理论预期）：policy 给 PENDING_REVIEW → veto 放行 → 走 budget 门 → 周 3 个发布落盘

### 已知限制

- baseline 已有 12+1 个 dual-mode.test.mjs / profile-resolver.test.mjs 失败（Windows + dsh-storage-domain ESM URL scheme 解析问题，与本改动无关——这次改动没新增退步）。
- argv shape 校验没"自动修"（不是把非数组转数组），而是 fail-safe —— 这是设计意图：sandbox 契约漂移应该被看见（写到 stderr / policy finding），不能默默伪装成 ok。

## 0.7.0 (2026-08-29) — Sprint 12 / A3 sandbox.passed / sandbox.failed 双 topic 事件化（T1 影子期）

### Added

- **sandbox.passed / sandbox.failed 双 topic 事件化（T1 影子期，不切流量）**：
  - 发布方：嵌套 `plugins/agint-quality/agint-quality-sandbox/lib/index.js` 的 `runSmoke()` / `runInRealSandbox()` / `runInProcess()` 三处出口
  - 订阅方：嵌套 `plugins/agint-quality/agint-quality-policy/lib/index.js` 加 async 订阅（audit-only：写 `memory[type=decision]`）
  - 软依赖 `ctx.eventBus.publish`（直连路径不切流量；publish 失败 `console.error` 不抛）
- **payload schema v1**：嵌套路径新增 `schemas/sandbox-passed.schema.yaml` + `schemas/sandbox-failed.schema.yaml`
  - passed payload: `{target, mode, checks, durationMs}`
  - failed payload: `{target, mode, reason, failedChecks, durationMs}`
- `manifest.json`：
  - `cordis.optionalInject` 新增 `agint.eventBus`（软依赖）
  - `dependencies` 新增 `agint-event-bus: ">=0.7.0"`
  - `servicesOptional` 显式声明 `agint.eventBus.sandboxAudit`（audit-only consumer，由 `agint-quality-policy` 注册）

### Compatibility

- 直连路径（`runSmoke` / `runInRealSandbox` / `runInProcess` return 结果）完整保留
- 事件路径 publish 失败只 `console.error` 不抛；不阻断原 return
- policy A2 已 commit 的 sync 订阅（`evolution.evaluated`）未被触动；A3 的 async 订阅是新增独立边
- 嵌套路径 deprecated proxy（`plugins/agint-quality/agint-quality-sandbox/deprecation-proxy.js`）保留 — v0.7 清理计划不变（设计稿 §九遗留 TODO #5）
- L0-frozen 字段未触动（`grep -r 'agint-quality-contract' plugins/agint-quality-sandbox/` 实测 0 命中）

## 0.6.3 (2026-08-27) — Sprint 10 #2 + #3 收口

### Breaking

- **从 `agint-quality` 基座物理剥离**，重新注册为独立 Cordis 插件（设计稿 §〇 D1）。
  历史调用路径通过基座 deprecation 代理转发 1 周（设计稿 §二.1），
  v0.7 清理代理（设计稿 §九遗留 TODO #5）。
- 新增 Service 签名（FROZEN）：
  - `runVerify({ target, opts }) → VerifyRunResult`（严格模式，30s/512MB）
  - `runExplore({ target, opts }) → ExploreRunResult`（宽松模式，60s/1GB + 放宽 execve）
  - `resolveProfile({ mode }) → ResolvedProfile`（平台路由）
  - `routeForMutation({ source, kind }) → { mode, stages }`（变异路由决策）
- 保留旧 `runSmoke` 签名以兼容现有 v0.3 eval。

### Added

- **syscall 白名单 profile 注入**（设计稿 §〇 D3 + §二.2）：
  - `profiles/sandbox-seccomp-verify.json`：BPF JSON，deny-by-default + 显式 allow
  - `profiles/sandbox-seccomp-explore.json`：BPF JSON，继承 verify + 限白名单二进制 execve
  - `profiles/sandbox-sbpl-verify.sb`：sandbox-exec `(deny default)`
  - `profiles/sandbox-sbpl-explore.sb`：sandbox-exec 继承 verify + 限 /usr/bin/node
- `lib/index.js` 内部 `resolveProfile()`：平台路由（linux → bpf-json / darwin → sbpl / win32 → unsupported）
- `backendHealth()` 新增字段：`seccompAvailable` / `sbplAvailable`
- 降级路径：seccomp/sbpl 不可用 → `in-process fallback` + `sandbox-fallback` failure pattern，
  policy 强制 `PENDING_REVIEW`

### Security

- **explore 沙箱三道独立约束**（设计稿 §六 §6.2 + §十.6）：
  - 网络全隔离不变
  - 文件系统限 workspace
  - 白名单 binary（限 `node` / `git`，禁 `bash` / `sh` / `zsh` / `fish` / `dash`）
- **Windows 路径**：本 Sprint 仅 warn（设计稿 §九遗留 TODO #1）

### Compatibility

- 与 v0.3 基座内嵌版兼容至 v0.7（基座 deprecation 代理转发期）
- 旧 `agint-quality/agint-quality-sandbox/` 将在 v0.7 清理（设计稿 §九遗留 TODO #5）
- `agint-quality-contract` L0-frozen 字段未触动（设计稿 §七）：`grep -r 'agint-quality-contract' plugins/agint-quality-sandbox/` 实测 0 命中