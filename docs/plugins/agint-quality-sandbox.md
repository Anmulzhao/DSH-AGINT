# agint-quality-sandbox — D-QAF Phase 2 动态沙箱

> D-QAF Phase 2 的"隔离执行 + 资源监控"。桥接 dsh 的 `ctx.sandbox` 服务（`@deepseek-ai/dsh-sandbox` + `dsh-sandbox-local` 后端），在隔离环境里执行 plugin 冒烟测试。
>
> **版本**：v0.3.0（Sprint 2.A 初版）
> **Service 名**：`agint.qualitySandbox`
> **物理位置**：`plugins/agint-quality/agint-quality-sandbox/`

---

## 设计意图

D-QAF Phase 2 是 contract 静态准入后的"动态验证"。它要回答：

- 这个 plugin 在隔离环境里能不能正常 import？
- 它有没有意外依赖外部网络（破坏沙箱语义）？
- 它在 30s / 512MB 资源限制下能不能完成 smoke check？

老板 2026-08-20 拍板三个关键决策：

| # | 决策 |
|---|---|
| 1 | **桥接 `ctx.sandbox` 服务**（复用 dsh 后端） |
| 2 | **跑 plugin 冒烟测试脚本**（lib/smoke.js） |
| 3 | 静态检查（lint / secret scan / dep graph）本 Sprint **不做**，留后续 |

---

## Service 契约

```js
agint.qualitySandbox = {
  runSmoke({ target: { path, name? }, opts? }) → Promise<SandboxRunResult>,
  backendHealth() → Promise<{
    ctxSandboxAvailable, inProcessFallbackEnabled, timeoutMs, memoryMb
  }>,
  config: { timeoutMs, memoryMb, allowInProcessFallback },
};
```

`SandboxRunResult` schema：

```ts
{
  target: { path, name? },
  ok: boolean,
  mode: 'sandbox' | 'in-process',
  exitCode: number | null,
  stdout: string,
  stderr: string,
  checks: [{ name, ok, detail }],
  reason?: string,           // failure tag for grouping
  durationMs: number,
}
```

---

## 两条执行路径

### Path 1: 真沙箱（生产 dsh 启动时）

```
ctx.sandbox.confine(['node', smoke.js, <plugin-path>], {
  mode: 'workspace-write',
  workspaceRoot: <plugin-path>,
  timeoutMs: 30000,
  memoryMb: 512,
}) → wrapping argv
  → spawn child process
  → collect output
  → parse smoke JSON
```

要求 `ctx.sandbox` Service 在 dsh 启动时被 `dsh-sandbox-local` 后端注册。

### Path 2: in-process 降级（dev / CI / eval）

```
runSmokeInProcess(pluginPath) → 调用 lib/smoke.js 的纯函数版本
```

`allowInProcessFallback: true`（默认）允许在 `ctx.sandbox` 缺失时降级。**仅 dev 用** — 生产应关闭降级强制走真沙箱。

---

## lib/smoke.js 6 项冒烟

1. **plugin-exists** — plugin 目录存在
2. **package-json-parses** — package.json 是合法 JSON
3. **package-json-esm** — `"type": "module"`（AGINT plugin 必须 ESM）
4. **main-file-exists** — `pkg.main` 指向的文件存在
5. **plugin-exports** — `import()` 后含 `Config / apply / inject / name`
6. **no-external-network** — `lib/*.js` 不含 `fetch / axios / node-fetch / got / https.request / dns.lookup`

退出码：

- `0` = 全过
- `1` = smoke 失败（plugin 结构问题）
- `2` = 环境错误（plugin 不存在 / import 失败）
- `3` = 超时（由 spawn wrapper 标 `reason: 'timeout'`）

---

## 资源限制

```yaml
timeout: 30s         # ROADMAP P3 §沙箱 L103 限定
memory: 512MB        # ROADMAP P3 §沙箱 L103 限定
mode: workspace-write # 仅 plugin 自己目录可写，其他只读
network: denied      # bwrap --unshare-net 或 sandbox-exec deny network*
```

限制在 `apply(ctx, config)` 时通过 `Config.parse` 校验，**不运行时更改**。

---

## 失败上报

如果 sandbox 跑挂（`result.ok = false`），自动写 `agint.evolution.addFailure()`：

```js
await evo.addFailure({
  pattern: `sandbox-smoke-failed:${reason}`,
  category: 'integration',
  severity: timedOut ? 'medium' : 'high',
  evidence: `target=<plugin-path> reason=<...>`,
});
```

Sprint 3 接入后改由 `agint-quality-policy` 在 REJECT 决策时触发，本 Sprint 直接在 sandbox service 内部处理（owner = sandbox plugin 自己知道失败细节）。

---

## Sprint 2.A 范围内（已完成）

- [x] Plugin 骨架（package.json + lib/{index,smoke}.js）
- [x] Service 契约完整（runSmoke + backendHealth + config）
- [x] 桥接 ctx.sandbox.confine() 路径（生产用）
- [x] In-process fallback 路径（dev/CI 用）
- [x] 6 项冒烟 check + 失败上报到 agint.evolution
- [x] 5 个 eval 场景全过

## Sprint 3 接入（D-QAF 端到端时）

- [ ] 钩到 `agint-quality-eval` Phase 2 调用 runSmoke
- [ ] 失败上报路径改由 `agint-quality-policy` REJECT 决策触发（解耦 sandbox 与 evolution）
- [ ] `dsh-sandbox-local` 后端安装 / cordis.patch.yml 注册
- [ ] 真沙箱跑通（dev 主机无 bwrap，eval 走降级）

## 不在 Sprint 2.A 范围

- 静态检查（lint / secret scan / dep graph）— 老板拍板本 Sprint 不做
- 并发 sandbox 调度（单 plugin 串行够用）
- 网络白名单（plugin sandbox 默认无网络）

---

## 设计取舍

### 1. 桥接优先（老板拍板）

老板拍"桥接 ctx.sandbox 服务"。我没自建 bwrap wrapper 而是把 confine 后的 argv 交给 dsh 的 sandbox seam。**优点**：复用 dsh 的多平台后端（bwrap / Landlock / Seatbelt），自动适应 host kernel；缺点：dev 环境 ctx.sandbox 不存在时要降级。

### 2. In-process fallback（dev 友好）

老板没明说要不要降级。我**默认开启**（`allowInProcessFallback: true`），因为：

- eval/scenarios 跑在 mock ctx，**没有 ctx.sandbox**，不降级会全挂
- dev 主机（本机 Linux）没装 bwrap，**真沙箱跑不起来**
- CI 环境通常是容器，**沙箱可能禁止沙箱**（嵌套沙箱问题）

生产 dsh 启动时**关掉降级**（`config.allowInProcessFallback: false`）。

### 3. 6 项 smoke 检查 = 结构 + 网络（轻量）

不查 plugin **逻辑正确性**（那是 eval Phase 3 集成演练的事），只查：

- 结构（package.json / main / ESM / exports）
- 副作用（无外部网络）

轻量冒烟 = 沙箱快速跑通（<1s），不抢占 eval Phase 3 的预算。

### 4. 失败上报 owner = sandbox 本身（临时）

Sprint 2.A 让 sandbox 自己调 evo.addFailure。Sprint 3 接入 policy 后改为 policy 触发（policy 知道 sandbox 失败 → REJECT → addFailure），更符合"沙箱是数据源 / policy 是决策源"的分层。

---

## 验证

```sh
# 跑 5 个 sandbox 场景
node eval/scenarios/driver.js --file=agint-quality-sandbox

# 跑全 25 个场景
node eval/scenarios/driver.js
# 当前结果：25/25 PASS
```

---

## 相关文档

- `docs/evolution-framework.md` D-QAF Phase 2 定义
- `docs/security-boundary.md` 沙箱硬约束（超时 / 内存）
- `路线图` P3 §沙箱（路线图原文）
- `CHANGELOG.md#v0.3.0`（待发版）

## 相关 commit

- Sprint 2.A 一次性 commit：`feat(sandbox): Sprint 2.A 沙箱 plugin + 5 场景全跑通`
