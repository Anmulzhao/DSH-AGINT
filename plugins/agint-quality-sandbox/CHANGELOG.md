# Changelog — agint-quality-sandbox

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