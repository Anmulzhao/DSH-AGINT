# agint-quality-sandbox

> D-QAF Phase 2 动态沙箱独立 Cordis 插件。Sprint 10 v0.6.3 收口。
>
> **从 `agint-quality` 基座物理剥离**（ROADMAP §架构哲学修正声明，2026-08-26）；
> **新增 syscall 白名单矩阵**（设计稿 §〇 D3 + §二.2），通过 `sandboxProfile`
> 字段注入到 dsh `ctx.sandbox`，**不重造沙箱后端**。

---

## 是什么

承接原 `plugins/agint-quality/agint-quality-sandbox/` 的全部职责，并新增：

1. **双模式串行路由**：`verify`（严格） / `explore`（宽松 + 网络全隔离）
2. **syscall 白名单 profile 注入**：
   - Linux：seccomp BPF JSON（`SCMP_ACT_KILL_PROCESS` 兜底）
   - macOS：sandbox-exec SBPL（`(deny default)` + `(deny network*)` 兜底）
   - Windows：unsupported（仅 warn，Sprint 10 §九遗留 TODO #1）
3. **降级路径可证**：`seccompAvailable=false` / `sbplAvailable=false` →
   `in-process fallback` + 写 `sandbox-fallback` 失败模式，
   policy 决策强制 `PENDING_REVIEW`（设计稿 §二.2 红线）。

## Service 契约（v0.6.3）

```js
agint.qualitySandbox = {
  // v0.6.3 新增（设计稿 §二.2）
  runVerify({ target, opts }) → VerifyRunResult,      // 严格模式（30s/512MB）
  runExplore({ target, opts }) → ExploreRunResult,    // 宽松模式（60s/1GB + 放宽 execve）
  resolveProfile({ mode }) → ResolvedProfile,        // 平台路由（linux/darwin/win32）
  routeForMutation({ source, kind }) → { mode, stages },  // 变异路由决策

  // v0.3 保留（向后兼容）
  runSmoke({ target, opts }) → SandboxRunResult,      // 等价 runVerify（默认参数）
  backendHealth() → HealthReport,                    // 含 seccompAvailable / sbplAvailable
  config,
}
```

`runVerify` / `runExplore` 都透传 `sandboxProfile` 给 `ctx.sandbox.confine(argv, policy)`。

## 双模式资源矩阵（设计稿 §二.2）

| 维度 | `verify`（严格） | `explore`（宽松） |
|---|---|---|
| 网络 | `--unshare-net`（全隔离） | `--unshare-net`（不变） |
| syscall | 严格白名单（禁 execve/ptrace/socket） | 放宽（允许 execve 限白名单二进制） |
| 资源 | timeout 30s / mem 512MB | timeout 60s / mem 1GB |
| 失败落点 | safety=0 → REJECT | safety=0.3 → PENDING_REVIEW |

## 变异路由决策（设计稿 §二.2 末尾）

```text
mutator.propose → mutator.validate
  ├─ source='dream-random' OR kind='TOOL_SYNTHESIS'
  │   → explore 沙箱 → 通过 → verify 沙箱 → D-QAF Phase 3
  └─ 否则（attribution-driven PROMPT_MUTATION/STRATEGY_REWRITE）
      → verify 沙箱 → D-QAF Phase 3
```

## Profile 文件清单

| 文件 | 平台 | 模式 | 用途 |
|---|---|---|---|
| `profiles/sandbox-seccomp-verify.json` | linux | verify | strict 严格模式 |
| `profiles/sandbox-seccomp-explore.json` | linux | explore | 放宽 execve（限 node/git） |
| `profiles/sandbox-sbpl-verify.sb` | darwin | verify | strict 严格模式 |
| `profiles/sandbox-sbpl-explore.sb` | darwin | explore | 放宽 execve（限 /usr/bin/node） |

## 降级路径（设计稿 §二.2 红线）

| backend 探测 | 结果 | policy 决策 |
|---|---|---|
| Linux + seccomp 可用 | 真沙箱执行 | 正常 |
| Linux + seccomp 不可用 | in-process + `sandbox-fallback` | `PENDING_REVIEW` |
| macOS + sandbox-exec 可用 | 真沙箱执行 | 正常 |
| macOS + sandbox-exec 不可用 | in-process + `sandbox-fallback` | `PENDING_REVIEW` |
| Windows | unsupported warn | `PENDING_REVIEW` |

## 使用示例

```js
const sandbox = ctx.get('agint.qualitySandbox');

// 1. 双模式执行
const verifyResult = await sandbox.runVerify({
  target: { path: '/path/to/plugin', 'name': 'my-plugin' }
});
// → { ok: true, mode: 'verify', safety: 1.0, policyDecision: 'PASS', ... }

const exploreResult = await sandbox.runExplore({
  target: { path: '/path/to/new-tool' }
});
// → { ok: true, mode: 'explore', safety: 1.0, policyDecision: 'PASS', ... }

// 2. 变异路由决策（在 mutator 中调用）
const route = sandbox.routeForMutation({ source: 'dream-random', kind: 'TOOL_SYNTHESIS' });
// → { mode: 'explore-then-verify', stages: ['explore', 'verify'] }

// 3. 后端健康检查
const health = await sandbox.backendHealth();
// → { ctxSandboxAvailable, seccompAvailable, sbplAvailable, ... }
```

## 验证

```sh
# 跑契约层测试（10 用例）
node --test test/dual-mode.test.mjs

# 跑全 eval（待 Sprint 10 #6 收口）
node eval/scenarios/driver.js --file=agint-quality-sandbox
```

## L0-frozen 保护

- **不引用** `agint-quality-contract` FROZEN 接口
- **不修改** `runSmoke` 签名（向后兼容 v0.3 eval）
- **不引入**新的中心化服务（`resolveProfile` 仅平台路由）

## Sprint 10 不在本插件

- 不改 mutator rollback 事务（#5）
- 不写静态检查（#4）
- A/B 测试统计（v0.6.4）

## 行数预算（设计稿 §十.1）

- profile JSON ≤ 200 行（每个）
- 单测 ≤ 300 行
- 净增代码（v0.6.3）≤ 300 行

## 相关

- `AGINT.wiki/Sprint10-设计稿.md` §二.1 架构解耦 + §二.2 双模式 + §七 L0-frozen
- `AGINT.wiki/ROADMAP.md — AGINT 进化路线（优化版：架构解耦与真正插件化）.md` §架构哲学修正声明
- `docs/architecture.md` 沙箱在 D-QAF Phase 2 中的位置
- `plugins/agint-mutator/` 消费方（commit / rollback）