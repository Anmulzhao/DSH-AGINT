# Changelog — agint-quality-sandbox

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