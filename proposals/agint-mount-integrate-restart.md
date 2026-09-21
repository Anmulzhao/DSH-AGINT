# Proposal: agint-mount 4 态路径接入 agint-restart，完成插件自动挂载

> **状态**：草案（draft） · 类别 `plugin` · **未提交** evolve plugin runtime storage
> **目标插件**：`agint-mount`（v0.6.5 当前）+ `agint-restart`（v0.8.1 当前）
> **作者**：MiniMax · **日期**：2026-09-16
> **风险等级**：P0（涉及 L0-frozen MountResult 邻近字段、storage schemaVersion 升级、新 ctx 注入依赖）

---

## 1. 背景与动机

### 1.1 现状（v0.6.5 的 4 态路径）

`agint-mount` 的 4 态路径 B（plugin 声明新 npm 依赖）在 Sprint 11 收口时是这样的：

```ts
// src/orchestrator.ts:280-294
if (needsInstall(deps)) {
  await runPnpmInstall(ctx, paths.webPackageJson, deps);
  ticket = await updateTicketPhase(ctx, ticketId, 'INSTALLED', contractCheck, null, null);

  // 发 sentinel restart（写一个 restart 信号文件 / 调 dsh Sentinel API；Sprint 11 留 hook）
  await requestRestart(ctx, paths.sentinelLease);
  ticket = await updateTicketPhase(ctx, ticketId, 'RESTART_REQUESTED', contractCheck, null, null);

  // 等 sentinel.lease（at+30s 后再继续；Sprint 11 骨架 stub）
  await waitSentinelLease(paths.sentinelLease);
  activatedPhase = 'ACTIVATED';
}
```

`requestRestart()` 的真实实现（src/orchestrator.ts:477-486）：

```ts
async function requestRestart(ctx, sentinelLeasePath) {
  if (ctx.requestRestart) {
    await ctx.requestRestart(sentinelLeasePath);   // 生产 dsh 没注入这个 ctx
    return;
  }
  // 兜底：写一个 at 时间戳到 lease 文件
  await writeFile(sentinelLeasePath, JSON.stringify({ at: ..., reason: 'agint-mount: 4-state restart' }), 'utf-8');
}
```

`waitSentinelLease()` 的真实实现（src/orchestrator.ts:488-492）：

```ts
async function waitSentinelLease(leasePath, timeoutMs = 30_000) {
  if ((globalThis as any).__AGINT_MOUNT_TEST_NO_LEASE_WAIT__) return;
  await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 1000)));   // 骨架阶段只 sleep 1s
}
```

### 1.2 致命漏洞：B 路径根本没真重启 dsh

| 阶段 | 现状 | 问题 |
|---|---|---|
| INSTALLED → RESTART_REQUESTED | 写 `sentinel.lease` 时间戳文件 | **不是真重启**，只是写了个标记 |
| waitSentinelLease | `setTimeout(1000)` | 1 秒后假装重启完了 |
| ACTIVATE 阶段 | atomic 写 patch.yml → HMR settle | 此时 dsh 进程还是**旧实例**，新 plugin 文件已就位但旧进程没加载新 plugin 代码 |
| HMR 成功判定 | `service-lookup / bus subscribe / ctx 直连` 30s timeout 四级 fallback | 旧 dsh 进程的 service registry 里有这个 service 吗？**没有**（新 plugin 还没加载），于是 HMR 失败 |
| HMR 失败 → DISABLED | rollback + DISABLE 标记 | **误报**：plugin 代码其实没问题，是 dsh 没重启导致 HMR 不上 |

**实际后果**：B 路径（plugin 声明新 npm 依赖）目前在生产 = **永远走不通**——`needsInstall(deps)` 命中就进 4 态路径，4 态路径的"重启"是假的，HMR settle 必然失败，最终挂 `DISABLED`。要使 B 路径可用，必须让 4 态路径**真把 dsh 重启起来**。

### 1.3 现有资源：agint-restart 已经有了

`agint-restart` v0.8.1 已经提供了完整的主动重启能力（v0.2.0 起）：

- 服务：`agint.restart.request / .status / .detect / .cancel`
- 工具：`restart_request / restart_status / restart_cancel`
- 守护：`lib/respawn.js`（独立孤儿进程，等旧进程退出 + 端口释放 + 拉起新 dsh + 等就绪）
- 护栏：`confirm` 必填 / `cooldownMs` 60s / `burstMax` 3/600s / `force` 绕过
- 输出契约：`lib/contract.js` 单一事实源 + `sideEffect` 字段
- win32 控制台隔离修复（v0.6.0）

**缺的就是 mount 没去用它**。

### 1.4 不做什么（边界）

- ❌ **不替 mount 做"事务级"重启语义**——mount 的 rollback 是文件级清理（删除 staging / 恢复 patch.yml），本提案专注"4 态路径里 INSTALLED → ACTIVATED 之间的真重启"
- ❌ **不改 MountResult FROZEN schema**（L0-frozen，改走 7 天影子 + 老板多签 + major 版本）
- ❌ **不替 restart 插件写新能力**——本提案只调它现有 service
- ❌ **不破 `agint-quality-static` / `agint-quality-sandbox` 的双门禁顺序**（PREPARE 之前已经过了）
- ❌ **不做 B 路径 + 三态路径并存之外的"全 dsh 热加载"**——超出 mount 角色

---

### 1.5 源码核实证据（2026-09-16 实测）

> 本节为 §1.1–§1.3 主张的**实测落点**，逐条对到真实代码行。前文「假重启」不是推测，是读 `agint-mount/src/orchestrator.ts` 与 `agint-restart/lib/index.js` 核出来的。

**核实方法**：直接读 `plugins/agint-mount/src/orchestrator.ts`（全 494 行）、`plugins/agint-restart/lib/index.js`、`plugins/agint-restart/lib/respawn.js`（存在性）、两个插件的 `manifest.json` 的 `mountOrder` 字段。

#### 1.5.1 当前 B 路径代码事实（orchestrator.ts）

| 事实 | 代码位置 | 实测内容 |
|---|---|---|
| 4 态判定块 | `orchestrator.ts:280-294` | `if (needsInstall(deps))` → `runPnpmInstall` → `updateTicketPhase(INSTALLED)` → `requestRestart(ctx, paths.sentinelLease)` → `updateTicketPhase(RESTART_REQUESTED)` → `waitSentinelLease()` → `activatedPhase='ACTIVATED'` |
| `requestRestart()` 实现 | `orchestrator.ts:477-486` | 先 `if (ctx.requestRestart)` 调 ctx 注入；**生产 dsh 没注入这个 ctx** → 走兜底 `writeFile(sentinelLeasePath, {at, reason})`——只写个时间戳占位文件 |
| `waitSentinelLease()` 实现 | `orchestrator.ts:488-492` | `__AGINT_MOUNT_TEST_NO_LEASE_WAIT__` 为真时直接 return；否则 `setTimeout(1000)`——骨架阶段只睡 1 秒假装重启完 |
| HMR settle 四级 fallback | `orchestrator.ts:112-165` | `awaitHmrSettleBus`：service-lookup → bus-subscribe → ctx 直连 → **兜底 30s timeout sleep 返回 `false`**（`orchestrator.ts:157-164`） |

#### 1.5.2 根因闭环（为什么 B 路径生产永远走不通）

```
4 态路径 ① runPnpmInstall → INSTALLED
       ② requestRestart → 写 sentinel.lease 时间戳（≠ 真重启）
       ③ waitSentinelLease → setTimeout(1000) 假装重启完成
       ④ ACTIVATE：backup → writePatchAtomic（新 plugin 行写进 patch.yml）
                    → awaitHmrSettleBus（兜底 30s sleep 返回 false）
       ⑤ settle=false → restorePatch + 标 DISABLED
```

**断点**：第 ② 步没有真重启 dsh，旧 dsh 进程从头到尾没加载新 plugin 的代码。于是第 ④ 步 HMR settle 的四级 fallback 全部落空（旧进程 service registry 里没有新 plugin 的 service），兜底 30s 超时必然返回 `false`，第 ⑤ 步必然标 `DISABLED`。

**测试为何「绿」**：`smoke.mjs` 跑 B 路径时开了 `globalThis.__AGINT_MOUNT_TEST_NO_LEASE_WAIT__`，把 `waitSentinelLease` 的 `setTimeout` 和 `awaitHmrSettleBus` 兜底路径**全短路**（`orchestrator.ts:160` / `:490`），等于在测试里用「跳过等待」掩盖了「没真重启」——**这是假绿，生产环境第 ④ 步的 30s 超时不会短路**。

#### 1.5.3 真重启能力已在位（agint-restart）—— 只是 mount 没调

| 能力 | 代码位置 | 实测 |
|---|---|---|
| `agint.restart` service 已 provide | `agint-restart/lib/index.js:779` | `ctx.provide('agint.restart', { detect, status, request, cancel })` ✅ |
| 孤儿进程守护 `respawn.js` | `agint-restart/lib/respawn.js` | 文件存在 ✅（等旧 pid 消失 + 端口释放 + 拉新 dsh + 等就绪 + 写 `restart-result.json`） |
| mount 是否调用它 | `orchestrator.ts` 全文检索 | **零引用**——`agint-mount` 当前完全没调 `agint.restart` |

#### 1.5.4 落点决策（已实测，对应 §3）

1. **重启调用放在哪**：替换 §1.5.1 红框 ②+③（`requestRestart` 写 lease + `waitSentinelLease` 睡 1s），位置在 `runPnpmInstall → INSTALLED` 之后、ACTIVATE 之前。调的是已就位的真能力 `agint.restart.request`。
2. **顺序必须重排（关键坑）**：`restart.request` 一旦被接受，当前 dsh 进程在 `shutdownDelayMs`（约 1.5s）后**自己退出**（`agint-restart/lib/index.js:541`「关掉自己，让 respawn.js 拉起的新实例能接管端口」）。所以：
   - **先写 `patch.yml`，再 firing 重启**——避免旧进程在 patch 写完前就退出的竞态；重启失败由 rollback 恢复 patch.yml。
   - **HMR settle 不能留在当前进程等**，必须搬到**新 dsh 启动钩子**续接（见 §3.2）。这是整套改动的命门，不是锦上添花。
3. **mountOrder 顺序差（已实读）**：`agint-mount` `manifest.json` mountOrder=**40**，`agint-restart` mountOrder=**50**（manifest.json 实读）。mount.apply 比 restart 早加载 → 重启调用必须用**懒注入** `ctx.inject(['agint.restart'], cb)`，在 4 态触发那一刻才取服务，且单向（restart 不反向 inject mount）避免循环依赖（§3.5 已述）。

> 本节事实与 §3.1 / §3.2 / §3.3 / §3.5 的改造方案**完全一致**，§3 的启动钩子代码即对应此处「新 dsh 启动续接」那段。前文所有「假重启」表述均有代码行号可复核，非假设。

---

## 2. 目标

### 2.1 必达（Must）

| ID | 描述 |
|---|---|
| **G1** | mount 4 态路径的 `requestRestart(ctx, sentinelLease)` 调用从"写 lease 占位"升级为"调 `agint.restart.request`"——**真重启 dsh** |
| **G2** | 重启完成后 `waitSentinelLease` 改为读 `restart-result.json.ok` 字段（restart 插件落盘的产物），不再 `setTimeout(1000)` 假装成功 |
| **G3** | mount → restart 走 `agint.restart` 服务依赖（`inject: ['agint.restart']`），**软降级**：restart 服务不可用时降级为 sentinel lease 兜底（保持向后兼容） |
| **G4** | 重启失败（respawn 拉新 dsh 失败 / 就绪超时）→ mount 走 `executeRollback(ticketId, 'RESTART_REQUESTED', 'restart-failed:...')`，标 `ROLLED_BACK`（不是 `DISABLED`——4 态路径下重启失败 = 整个事务失败，不是 plugin 本身的问题） |
| **G5** | mount ticket 表新增 `restartRequestId` / `restartResult` 字段（**storage schemaVersion 1 → 2**，向后兼容），记录本次挂载关联的重启请求 id 与结果 |
| **G6** | 显式 dryRun 路径：`mount.request({ ..., restartDryRun: true })` 不真重启，只返回 plan |
| **G7** | 不破 MountResult L0-frozen schema |

### 2.2 应达（Should）

| ID | 描述 |
|---|---|
| **G8** | mount 的 `status()` 返回值新增 `restartRequestId`（通过 tickets 表 join），老板看 status 时能直接看到"这次挂载触发的 restart 链" |
| **G9** | restart 插件的 `force: true` 在 mount 4 态路径下**不允许透传**（挂载是"系统级"动作，不能被 burst 熔断挡；但 burst 仍生效，仅绕过 cooldown）——这是 G1 的安全护栏 |
| **G10** | mount 的 event 发布 `mount.restart-requested` / `mount.restart-completed` / `mount.restart-failed`（接入 agint-event-bus T2 切换期；**现状：已发但订阅方为 0**） |

### 2.3 可达（Could）

| ID | 描述 |
|---|---|
| **G11** | mount 的 `rollback(ticketId)` 自动调用 `agint.restart.resetHistory({confirm:true})` 清掉因 mount 触发的 burst 计数（避免 mount 链式挂载把 burst 打满） |
| **G12** | `bin/agint-mount.sh` CLI 加 `--restart-mode auto \| manual \| dry-run`，与 `agint.restart` 的 mode 字段对齐 |
| **G13** | mount 4 态路径支持"延迟重启"：plugin 文件就位后**不立即重启**，等 cron `mount-batch` 触发——把"多 plugin 挂载"合并成一次 dsh 重启（性能优化，**后期 sprint**） |

---

## 3. 设计

### 3.1 改造前后对比

**改造前**：

```
mount.request(proposal)
  ├─ PREPARE    : 写 staging
  ├─ SMOKE      : sandbox.runVerify
  ├─ ACTIVATE
  │   ├─ (4 态路径)
  │   │   ├─ runPnpmInstall
  │   │   ├─ requestRestart(ctx, sentinelLease)  ← 写 lease 占位，dsh 没真重启
  │   │   ├─ updateTicketPhase(RESTART_REQUESTED)
  │   │   └─ waitSentinelLease  ← sleep 1s 假装重启完成
  │   ├─ writePatchAtomic       ← atomic 写 patch.yml（旧 dsh 进程写自己的配置）
  │   ├─ awaitHmrSettleBus      ← 旧 dsh 进程加载新 plugin → 失败（plugin 没加载）
  │   └─ cleanup / rollback
  └─ ACTIVATED (但实际 plugin 没加载)
```

**改造后**：

```
mount.request(proposal)
  ├─ PREPARE    : 写 staging
  ├─ SMOKE      : sandbox.runVerify
  ├─ ACTIVATE
  │   ├─ (4 态路径)
  │   │   ├─ runPnpmInstall
  │   │   ├─ restartPlan = agint.restart.status()  ← 先看冷却/熔断，避免盲发
  │   │   ├─ updateTicketPhase(RESTART_REQUESTED)
  │   │   ├─ requestRestart(ctx, ...)  ← 调 agint.restart.request({confirm:true, reason:...})
  │   │   │     │
  │   │   │     ├─ restart.request 内部写 restart-request.json + spawn respawn.js
  │   │   │     ├─ 当前 dsh 进程延迟 shutdownSelf
  │   │   │     └─ respawn.js: 等旧 pid 退 + 端口释放 + 拉新 dsh + 等就绪
  │   │   │
  │   │   │   ⚠️ 注意：mount 调 request 后当前进程很快会退出
  │   │   │     mount 的"等重启完成"逻辑**不能**在当前进程做（要跨进程）
  │   │   │
  │   │   │   解法：**状态在 disk，状态机在 storage**
  │   │   │     - mount 写 ticket 表 phase=RESTART_REQUESTED + restartRequestId=<id>
  │   │   │     - 旧 dsh 退出
  │   │   │     - 新 dsh 拉起，agint-mount.apply() 在新进程里读 ticket 表
  │   │   │     - 见 §3.2 mount.apply 启动钩子
  │   │   │
  │   │   └─ (不再有 waitSentinelLease 同步等待；改成新 dsh 启动后异步检测)
  │   ├─ writePatchAtomic       ← atomic 写 patch.yml（旧 dsh 写完才退出）
  │   └─ (HMR settle 在新 dsh 启动时由 mount 钩子完成)
  └─ ACTIVATED (新 dsh 真的加载了新 plugin)
```

**核心范式变化**：mount 的"等重启完成"从**同步等待**改成**disk-state + 跨进程续接**。这是 B 路径能真工作的根本。

### 3.2 mount 启动钩子（新 dsh 加载后）

`agint-mount/lib/index.js` 的 `apply()` 改造：每次 dsh 启动时，检查是否有 phase=RESTART_REQUESTED 的 ticket —— 如果有，**这就是刚才被 restart 的那次挂载**，继续 HMR settle → ACTIVATED。

```js
// 在 mount apply() 里挂启动钩子
ctx.effect(() => {
  // 同步检查：是否有未完成的 RESTART_REQUESTED ticket？
  const pending = await tables.tickets.query({ phase: 'RESTART_REQUESTED' });
  if (pending.length === 0) return;

  for (const ticket of pending) {
    // 1. 读 restart-result.json，确认 restart 真的成功了
    const restartResult = await readRestartResult(restartStateDir);
    if (!restartResult?.ok) {
      // restart 失败 → 标 ROLLED_BACK（不是 DISABLED，是整个事务失败）
      await updateTicketPhase(ctx, ticket.ticketId, 'ROLLED_BACK', ticket.contractCheck,
        null, `restart-failed:${restartResult?.error ?? 'unknown'}`);
      await emitEvent('mount.restart-failed', { ticketId, ...restartResult });
      continue;
    }

    // 2. restart 成功，等 HMR settle（新 dsh 加载新 plugin）
    const settleOk = await awaitHmrSettleBus(ctx, ticket.artifactName, 30_000);
    if (!settleOk) {
      await restorePatch(ctx, ticket);
      await updateTicketPhase(ctx, ticket.ticketId, 'DISABLED', ticket.contractCheck,
        null, 'hmr-settle-failed-after-restart');
      continue;
    }

    // 3. 成功 → ACTIVATED + 启动探针
    const activatedAt = nowIso();
    await updateTicketPhase(ctx, ticket.ticketId, 'ACTIVATED', ticket.contractCheck,
      activatedAt, null);
    await startHealthProbe(ctx, ticket.ticketId);

    await emitEvent('mount.restart-completed', { ticketId: ticket.ticketId });
  }
});
```

**这是 mount 跨进程续接的关键**——旧 dsh 写到 ticket 表的 RESTART_REQUESTED 状态，在新 dsh 启动时被本钩子捡起续跑。

### 3.3 mount orchestrator 的 requestRestart 改造

```ts
// src/orchestrator.ts (新版本)
async function requestRestart(ctx: MountContext, ticketId: string, artifactName: string): Promise<void> {
  const reason = `agint-mount: 4-state restart for ${artifactName}`;
  
  // G6: dryRun 模式
  if (ctx.config?.restartDryRun) {
    const status = await ctx.getService?.('agint.restart')?.status?.();
    return { ok: true, mode: 'dry-run', restartStatus: status, reason };
  }

  // G3: 软依赖 — restart 服务不可用时降级 sentinel lease 兜底
  const restartSvc = ctx.getService?.('agint.restart');
  if (!restartSvc?.request) {
    console.warn('[agint-mount] agint.restart 不可用，降级 sentinel lease 兜底（v0.6.5 兼容路径）');
    await writeFile(ctx.sentinelLease!, JSON.stringify({
      at: new Date().toISOString(),
      reason: 'agint-mount: fallback (no restart plugin)',
      ticketId,
    }));
    return;
  }

  // G1: 真重启
  const result = await restartSvc.request({
    confirm: true,                                    // G1: 显式 confirm
    reason,                                            // 落 restart.log
    // G9: 不透传 force；mount 重启走默认 burst / cooldown 规则
    force: false,
    // 让 restart 插件把 ticketId 写进自己的 restart-request.json
    metadata: { ticketId, artifactName },
  });

  // ⚠️ result.accepted=true → 当前进程马上要退出；result.accepted=false → 没重启
  if (!result.accepted) {
    throw new Error(`mount restart denied: ${result.code} ${result.message}`);
  }

  // 写 ticket 表（同步写，因为马上就要退出，disk 是真相）
  await ctx.tables?.tickets?.update?.(ticketId, {
    restartRequestId: result.requestId,
    restartResultFile: result.resultFile,
  });

  // 当前进程将在 shutdownDelayMs 后退出；重启链由 restart 插件接管
  return;
}
```

**关键时序**：

1. mount 调 `restart.request({confirm:true, reason, force:false, metadata})`
2. restart 内部走护栏：enabled → mode → confirm → pending → burst → cooldown（**mount 的 force=false 让 burst 仍生效**——G9）
3. restart 写 `restart-request.json`（含 metadata.ticketId）+ detached 拉起 `respawn.js`
4. restart 自己延迟 `shutdownSelf(1500ms)`
5. mount 的 `requestRestart()` 返回
6. mount 在 `shutdownDelayMs` 后退出
7. respawn.js 等旧 pid 退 + 端口释放 + 拉起新 dsh + 等就绪 + 写 restart-result.json
8. 新 dsh 启动 → mount 启动钩子（§3.2）捡起 RESTART_REQUESTED ticket → HMR settle → ACTIVATED

### 3.4 storage schemaVersion 升级

```diff
   "storage": {
     "domains": ["agint_mount"],
-    "schemaVersion": 1,
+    "schemaVersion": 2,
     "atomic": "json"
   }
```

`lib/storage.ts` 的 `tickets` 表加字段（**已有表，追加列**——兼容读）：

```diff
   tickets: z.object({
     ticketId: z.string(),
     proposalId: z.string(),
     artifactName: z.string(),
     phase: phaseSchema,
     contractCheck: contractCheckSchema,
     activatedAt: z.string().nullable(),
-    decision: ...,
-    createdAt: z.string(),
-    updatedAt: z.string(),
+    decision: ...,
+    createdAt: z.string(),
+    updatedAt: z.string(),
+    // v0.7.0 起（schemaVersion=2）：
+    restartRequestId: z.string().nullable().optional(),
+    restartResultFile: z.string().nullable().optional(),
+    restartMode: z.enum(['auto', 'manual', 'dry-run', 'fallback']).optional(),
   }),
```

### 3.5 manifest 改动

```diff
   "spec": {
     "cordis": {
       "inject": [
         "storageDomain",
-        "agint.qualitySandbox"
+        "agint.qualitySandbox",
+        "agint.restart"      // v0.7.0 起：硬依赖（G3 软降级仍允许，但挂载质量因此降级）
       ],
       "optionalInject": [
         "agint.evolution",
         "agint.population.ingest"
       ],
```

注意：把 `agint.restart` 放进 `inject` 而不是 `optionalInject`——理由：4 态路径若降级 fallback = B 路径挂载等于失败（plugin 没真加载）；直接挂 `inject` 让 restart 不可用时 mount 不启动 4 态路径。

但！这里有 **mountOrder 顺序问题**：

- `agint-mount` mountOrder = 40
- `agint-restart` mountOrder = 50

mount 40 比 restart 50 **先加载**——mount.apply() 时 restart 还没就绪。**两种解法**：

1. **mount 的 mountOrder 改到 60**（restart 之后）—— 但 mount 是 orchestrator，应该早加载
2. **mount 的 restart 调用改成 lazy**——只在 4 态路径触发时才 `ctx.inject(['agint.restart'], cb => cb(...))`——和现有 `agents` 注入模式一致

**选 (2)**：与 `agents` 软注入一致（参考 `agint-restart/lib/index.js:795` 的 `ctx.inject(['agents'], (scope) => { ctx.effect(() => { ... }) })`）。

```ts
// mount orchestrator 的 4 态分支：
if (needsInstall(deps)) {
  // ...
  // 用 lazy inject 拿 restart 服务
  const restartSvc = await ctx.inject?.(['agint.restart'], (scope) => scope.agint?.restart)
                       ?? ctx.getService('agint.restart');
  // ...
}
```

但 `MountContext` 接口里没 `inject`——需要扩接口，**扩 types.ts 是非 FROZEN 的**（只有 MountResult 是 FROZEN）。

### 3.6 cordis.patch.yml 配置项

```yaml
config:
  # v0.7.0 起：mount 与 restart 协作的开关
  mountRestartMode: auto    # auto | manual | dry-run | fallback
  # auto   : 4 态路径调 agint.restart.request 真重启
  # manual : 4 态路径写 sentinel lease + 等人工重启（不调 dsh）
  # dry-run: 4 态路径只返回 plan，不重启（老板审查用）
  # fallback: restart 服务不可用时降级 sentinel lease（v0.6.5 兼容）
  mountRestartReason: 'agint-mount: 4-state restart'  # 传给 restart.request 的 reason 模板
  mountRestartTimeoutMs: 90000  # 等 restart-result.json 的最长等待（新 dsh 启动钩子超时）
```

### 3.7 FROZEN 保护清单

| 字段 | 状态 | 改动 |
|---|---|---|
| MountResult L0-frozen schema | **FROZEN** | ❌ **不动** |
| MountResult 5 个 required 字段 | **FROZEN** | ❌ **不动** |
| phase enum 7 值 | **FROZEN** | ❌ **不动** |
| tickets 表已有字段 | **兼容读** | ✅ 追加 3 列（restartRequestId / restartResultFile / restartMode），老数据继续可读 |
| tickets 表新字段 | **新增** | ✅ schemaVersion 1→2 |
| MountContext 接口（types.ts） | **非 FROZEN** | ✅ 加 `inject?` 方法签名（optional） |
| agint.mount.request 输入 schema | **非 FROZEN** | ✅ 加 `restartDryRun?: boolean`（optional） |
| agint.mount.status 输出 | **非 FROZEN** | ✅ 加 `restartRequestId`（optional） |
| agint.mount.rollback 行为 | **不变** | ❌ 不动 |

### 3.8 主版本号

- agint-mount v0.6.5 → **v0.7.0**
  - 理由：mount 与 restart 插件强耦合（inject 列表加 restart）；storage schemaVersion 升级；MountContext 接口扩字段
- agint-restart 不变（仍是 v0.8.1）

### 3.9 事件接入（agint-event-bus T2 切换期，G10）

| 事件 | 触发时机 | payload |
|---|---|---|
| `mount.restart-requested` | mount 调 `restart.request` 之后 | `{ ticketId, restartRequestId, artifactName }` |
| `mount.restart-completed` | 新 dsh 启动钩子 HMR settle 成功 | `{ ticketId, restartResult, activatedAt }` |
| `mount.restart-failed` | restart 失败 / HMR 失败 | `{ ticketId, restartResult, reason }` |

**当前实际状态（2026-09-21 复核，勿沿用旧措辞）**：

`mountEventBusPublish`（`agint-mount/lib/orchestrator.js`）**已接上生产**，7 个 topic 全在发，
但 2026-09-20 的复核推翻了它的"健康"表象（见下方 §6.4 教训）：

- **曾长期空转**：它取 bus 用伞键 `ctx.getService('agint.eventBus')`，而总线注册的是三个
  **分服务名**，根本没有伞键 → 恒 `undefined` → 静默降级到 `ctx.emitEvent`。
  已改为 `resolveBusPublish()` 三形态探测。
- **订阅侧已补齐**：`agint-metrics` 已对 mount 六主题装计数订阅（`lib/mountCounters.js`）。
- **但生产数据仍全为 0 条**（2026-09-21 17:0x 实测），与 `storages/` 下**无 `agint_mount.json`**
  互相印证 —— 不是"发了没人收"，是**从未发生过真实挂载**。

关于另外 3 个影子发布服务（`population.publishProposed` / `population.publishMountRequest` /
`mutator.publishMountRequest`）：**2026-09-20 老板拍板方案 A 后，判定为「不接」并已说明理由**
（接上会制造错误数据：`mount.requested` 已有发布方，且 population/mutator 在生产中根本不发起挂载）。
服务保留作备用通道，**不再属于"待接线缺口"**。理由详见
`docs/known-limitations/event-bus-shadow-publish-gap.md` §6.2。

> ⚠️ **旧措辞已废弃**：本稿曾记作「T1 影子期：publish-only，不切流量」。
> 该措辞有**误导性** —— 它读出「已在发布、只是尚未切消费」，会让读者以为
> 发布侧已就绪。实测表明发布侧的接线状态是**分叉**的（mount 系已发无人收；
> population/mutator 三个服务从未被调用）。**判定状态以调用点数量与生产数据为准，
> 不以本文档措辞为准。** 详见 `docs/known-limitations/event-bus-shadow-publish-gap.md`。

**T2 切换期的目标**：由 event bus transport 替代 `mountEventBusPublish` 直连，
并**同时补齐订阅侧**（否则只是把「发了没人收」从直连搬到 bus）。

**T2 现状（2026-09-21 复核：未实现、未排期）**：

- 全库 `plugins/**/lib/*.js` grep `transport` **零命中** —— T2 所需的 transport 层
  **一行代码都没有**。所以 T2 不是"切了没切"，是"尚未开始"。
- 2026-09-20 方案 A 完成的是**接线**（补发布点 + 补订阅），**仍属 T1 影子期 publish-only**，
  主路径继续直连，不可与 T2 混为一谈。
- 前置条件未满足：该 4 处接线至今**无真实生产数据**
  （`evolution.proposed` 3 条全为 09-04 探针；`sandbox.passed|failed` / `hmr.settled` /
  `mount.*` 全为 0）→ **从未被证明可用，不应据此替代直连主路径**。
- 时间表：`VERSION` 表 v0.7.1 条目记「总线 T2 切流量，不早于约 2026-09-25 + 老板签字」。

---

## 4. 实现路径（分阶段）

### P1（本次提案本体，必做）

| 步骤 | 文件 | 工作量 |
|---|---|---|
| 1 | `plugins/agint-mount/src/types.ts` | MountContext 接口加 `inject?` 字段（optional） |
| 2 | `plugins/agint-mount/src/storage.ts` | tickets 表 schemaVersion 1→2，加 3 列；spec 同步 |
| 3 | `plugins/agint-mount/src/orchestrator.ts` | ① `requestRestart()` 改造（软注入 agint.restart）；② 4 态路径去掉 `waitSentinelLease` 同步等待；③ ticket 写 restartRequestId；④ 新增 `mountStartupHook()` |
| 4 | `plugins/agint-mount/src/index.ts` | apply() 里挂 `mountStartupHook` 为 ctx.effect（dispose 自动管理） |
| 5 | `plugins/agint-mount/src/rollback.ts` | RESTART_REQUESTED 阶段从「等 sentinel lease at+30s」改为「读 restart-result.json，超时标 ROLLED_BACK」 |
| 6 | `plugins/agint-mount/src/schemas.ts` | mount.request 入参加 `restartDryRun?`；mount.status 输出加 `restartRequestId?` |
| 7 | `plugins/agint-mount/manifest.json` | inject 加 `agint.restart`；description / serviceDocs 同步；mountOrder 不变 |
| 8 | `plugins/agint-mount/cordis.patch.yml` | 新增 `mountRestartMode` / `mountRestartReason` / `mountRestartTimeoutMs` |
| 9 | `plugins/agint-mount/README.md` | 「4 态路径」章节补"v0.7.0 与 agint-restart 协作"小节；状态机图更新 |
| 10 | `plugins/agint-mount/CHANGELOG.md` | v0.7.0 章节 |
| 11 | `plugins/agint-mount/test/smoke.mjs` | 10 → 16 用例：restart 真调 / restart 服务不可用降级 / restart 失败回滚 / 启动钩子跨进程续接 / restartDryRun 路径 / restartForce 不透传 / 事件发布 |
| 12 | `bin/plugin-check.sh plugins/agint-mount` | 10 维度自检 |
| 13 | `bin/agint-mount.sh` | CLI 加 `--restart-mode` |
| 14 | `fixtures/mount/` | fixture 改造：`echo-tool` / `bad-deps` 加新依赖场景，验证 B 路径真能挂上 |
| 15 | 仓库 D-QAF 评估 | `agint-quality-eval` 跑 B 路径 e2e 场景，HARM 报告 |

### P2（建议在 P1 落地后单开 proposal）

- `bin/agint-mount.sh` CLI 完整对接
- `agint-event-bus` T2 切换期 G10 真正接入（**现状：mount 侧已发、订阅方为 0；population/mutator 三个影子发布服务未接线**）
- `agint-mount-rollback` 自动调 `restart.resetHistory`（G11）—— **注意：这条会触发 restart 的写工具 ask 门禁**，需单独治理
- mount 批量挂载合并重启（G13）—— 性能优化

### P3（远期，看后续事故模式）

- 跨周累计自动部署的 D-QAF budget 检查接入（与 mount.batch 合并重启场景联动）
- mount 与 restart 的故障注入演练库（chaos-test）

---

## 5. 红线与风险

### 5.1 AGENTS.md 挂载/重启红线

| 红线 | 本提案行为 |
|---|---|
| 拍 4 份快照（patch / preset / plugins tar.gz / storages）后再动 | ✅ 实施前 `safe-update.sh snapshot` |
| `kill -SIGTERM` 而非 SIGKILL | ✅ 不变；restart 插件已处理 |
| `cat sentinel.lease` 看 `at` < 30s | ✅ 保留 sentinel.lease 落盘（restart 插件的 readiness 信号源） |
| 崩了就 `plugin → patch → preset` 倒序回滚 | ✅ rollback 路径完整 |
| 跨平台 fixture | ✅ 新 fixture 覆盖 win32 hidden launch |

### 5.2 PLUGIN-SPEC 10 维度（mount）

| 维度 | 影响 |
|---|---|
| 1. Contract | ✅ manifest inject 显式声明 `agint.restart` |
| 2. Storage domains | ✅ `agint_mount` 独占，tickets 表加 3 列（schemaVersion 1→2，向后兼容） |
| 3. Dependencies | ✅ `agint-quality-sandbox` 不变；新加 `agint-restart` peerDep `>=0.8.1` |
| 4. Permissions | ✅ env 增加 `AGINT_HOME`（mount 读 restart 状态用）；shell 不变 |
| 5. Lifecycle | ✅ 新增 mount 启动钩子；ctx.effect 注册 disposer |
| 5.5 跨平台 fixture | ✅ 新 fixture 覆盖 win32 + posix 双路径 |
| 6. Tests | ✅ smoke 16 用例 |
| 7. Docs | ✅ README 补"与 agint-restart 协作"小节 |
| 8. Changelog | ✅ CHANGELOG.md v0.7.0 |
| 9. runtime-contract | ✅ tools/post-execute 监听保持原状（空体 next()）—— 不变 |
| 10. 文档-代码公式一致性 | ✅ mountRestartTimeoutMs 在 lib/storage.ts / lib/orchestrator.ts 中实际读取并使用 |

### 5.3 FROZEN 保护

| FROZEN | 行为 |
|---|---|
| MountResult L0-frozen schema（5 required + 7 enum phase） | ❌ **不动**；新信息走 tickets 表 + status 返回值 optional 字段 |
| MountContext 接口 | ✅ 加 optional `inject?`，不破向后兼容 |
| restart 插件 FROZEN 接口（v0.1.0 起） | ❌ **不动**；只调它 |

### 5.4 风险评估

| 风险 | 等级 | 缓解 |
|---|---|---|
| mount 与 restart 互相 inject 形成循环依赖 | 中 | mount mountOrder=40、restart mountOrder=50；mount 用 lazy inject（`ctx.inject(['agint.restart'], cb)`），不在 apply 时硬依赖；restart 不 inject mount，**单向** |
| 4 态路径触发 restart 时，其他 plugin 的 in-flight 请求被打断 | 中 | restart 插件已处理（confirm/cooldown/burst + respawn.js 等旧进程退出）；mount 的 rollback 在新 dsh 启动钩子里检测 |
| restart-result.json 写盘失败 → mount 永远等不到 | 中 | mount 启动钩子加 timeout（mountRestartTimeoutMs 默认 90s）；超时标 ROLLED_BACK + 事件告警 |
| agint-event-bus 不可用时 mount 事件发布失败 | 低 | 软降级（影子发布，失败仅 warn；注意软降级会**静默吞掉"从未接入"**，需靠调用点核查发现） |
| mount 启动钩子在新 dsh 启动时被 dispose 时机抢跑 | 低 | mount 启动钩子用 `ctx.effect(() => ...)` 注册，dispose 时自动取消 |
| restart 插件不可用时 mount 4 态路径降级为 sentinel lease | 中 | **明确行为**：fallback 模式 mount 仍能继续（不挂起），但 plugin 实际**不会**被新 dsh 加载（因为没真重启）；mount.rollback 不需要专门处理（plugin 文件已就位但 HMR 没上，下次 dsh 真重启时被加载） |
| burst 熔断误触发（mount 链式挂载把 burst 打满） | 中 | G11：mount.rollback 自动调 `restart.resetHistory({confirm:true})`；G11 留 P2，本期不实装 |

### 5.5 D-QAF / HARM 评估

| 阶段 | 状态 |
|---|---|
| 静态准入 | plugin-check 10 维全过 |
| 动态沙箱 | smoke 16 用例 + 新 fixture（echo-tool-with-deps） |
| 集成演练 | 真实 dsh 跑 mount B 路径 e2e |
| 灰度发布 | v0.7.0 仓发版 → 老板重启 → host 挂载 → AGENTS.md 本机实况自动块更新 |

HARM 四维：

| 维度 | 影响 |
|---|---|
| Homogeneity | mount 与 restart 协作模式与 v0.8.x 范式一致（contract.js 字段表 + 输出契约收敛） |
| Alignment | 与"安全 > 效率"哲学对齐（mount 不透传 force = burst 仍生效） |
| Reduction | 删掉了 `setTimeout(1000)` 假装重启的代码；mount 4 态路径从"假重启"变"真重启" |
| Mutability | FROZEN MountResult 不动；schemaVersion 升级走 storage 兼容路径 |

### 5.6 哲学对齐检查

- **真实 > 讨好**：本提案**承认** v0.6.5 的 4 态路径"假重启"——CHANGELOG 写明「v0.7.0 4 态路径真重启」；不假装"v0.6.5 的 B 路径已经能用"
- **靠谱 > 聪明**：跨进程续接靠 disk-state（ticket 表 + restart-result.json），不靠内存变量；fallback 路径明确"plugin 没真加载，下次重启会被加载"——不留隐性不一致
- **简洁 > 冗余**：用 restart 插件现有的 `metadata` 字段传 ticketId，不引入新接口
- **安全 > 效率**：mount 不透传 force = burst 熔断仍生效；rollback 倒序清理完整覆盖 RESTART_REQUESTED 阶段
- **主动 > 被动**：把"B 路径插件挂不上"的隐性故障变显性事件（mount.restart-failed）+ 启动钩子自愈

---

## 6. 验证计划

### 6.1 单元测试新增（`test/smoke.mjs`，10 → 16 用例）

> ⚠️ **测试假绿警示（见 §1.5.2）**：现有 B 路径用例依赖 `globalThis.__AGINT_MOUNT_TEST_NO_LEASE_WAIT__` 把 `waitSentinelLease` 与 `awaitHmrSettleBus` 兜底路径全短路，等于用「跳过等待」掩盖「没真重启」。新增用例**不得在真重启断言里继续开这个开关**——真重启路径必须关闭该开关，用 `agint.restart` mock 或真实 respawn 验证 `restart-result.json` 落盘与 HMR settle 推进，否则会重新喂出假绿。

| # | 用例 | 覆盖点 |
|---|---|---|
| 11 | 4 态路径真重启 happy | mount 4 态 → 调 restart.request({confirm:true}) → 返回 accepted → 写 ticket.restartRequestId |
| 12 | 4 态路径 restart 服务不可用降级 | agint.restart 不存在 → 写 sentinel lease（fallback 模式） → 不抛错 |
| 13 | 4 态路径 restart 失败回滚 | restart.request 返回 accepted=false（cooldown / tripped）→ mount 标 ROLLED_BACK |
| 14 | 启动钩子跨进程续接 | 新 dsh 启动 → 读 tickets 表 phase=RESTART_REQUESTED → 读 restart-result.json.ok=true → HMR settle → ACTIVATED |
| 15 | 启动钩子 restart 失败处理 | restart-result.json.ok=false → mount 启动钩子标 ROLLED_BACK + emit mount.restart-failed |
| 16 | restartDryRun 路径 | mount.request({restartDryRun:true}) → 4 态路径不调 restart，只返回 plan |
| 17 | force 不透传 | mount.request({force:true}) → mount 内部调 restart 时仍 force:false |
| 18 | 事件发布（mount.restart-requested/completed/failed） | 影子发布（已接生产），断言 publish 调用被调到 |

### 6.2 端到端演练（人工，**真实 dsh 必跑**）

1. **B 路径真挂载 happy**：echo-tool-with-deps fixture 走 4 态 → 真重启 → 新 dsh 加载 echo-tool-with-deps → HMR settle → ACTIVATED → HEALTHY
2. **B 路径启动钩子续接**：在 4 态 INSTALLED 后**人工 kill 旧 dsh**（不依赖 restart 插件） → 新 dsh 启动 → mount 启动钩子捡 ticket → HMR settle → ACTIVATED
3. **B 路径 restart 失败回滚**：把 `restart.logFile` 改成只读路径 → mount 4 态 → restart.request 返回 internal-error → mount 标 ROLLED_BACK → rollback 清理 staging + 恢复 patch.yml
4. **fallback 降级**：把 agint-restart 插件从 cordis.patch.yml 注释掉 → mount 启动 → 重启路径降级 sentinel lease + 走 v0.6.5 兼容行为（plugin 文件就位但不真重启）
5. **burst 熔断下 mount 行为**：连续 3 次 mount 4 态触发 restart burst → 第 4 次 mount 4 态 → restart 返回 tripped → mount 标 ROLLED_BACK

### 6.3 失败模式覆盖

| 失败模式 | 期望行为 |
|---|---|
| restart 进程退出但 respawn.js 没拉起新 dsh | restart-result.json.ok=false → mount 启动钩子标 ROLLED_BACK |
| 新 dsh 拉起但 plugin 文件被外部改坏 | HMR settle 失败 → mount 启动钩子标 DISABLED（不是 ROLLED_BACK——plugin 代码本身有问题） |
| restart 服务在 mount 4 态路径中途消失 | mount 4 态 fallback → 写 sentinel lease（v0.6.5 兼容）；下次 dsh 真重启时被加载 |
| mount 启动钩子执行时被 dispose | ctx.effect dispose 自动取消；不会写脏 tickets 表 |
| restart-result.json 文件不存在（被外部清理） | mount 启动钩子标 ROLLED_BACK + reason: `restart-result-missing` |

---

## 7. 不在本次提案范围（明确）

1. **mount 与 mount.batch 合并重启**（G13）—— 性能优化，P3
2. **agint-event-bus T2 真正切换 transport**（G10）—— 等 T2 切换期
3. **mount.rollback 自动调 restart.resetHistory**（G11）—— 涉及 restart 写工具 ask 门禁，P2
4. **mount CLI 完整对接**（G12）—— bin/agint-mount.sh 大改，P2
5. **MountResult FROZEN schema 加字段**——L0-frozen，改走 7 天影子 + 老板多签 + major 版本，本次只走 tickets 表 optional 字段

---

## 8. 实施时间线（建议）

| 阶段 | 周期 |
|---|---|
| 提案评审 + D-QAF 评估接入 | 1 周（影子期） |
| P1 实施（15 步） | 5-6 天 |
| Smoke + plugin-check + 新 fixture | 2 天 |
| 端到端演练（5 项必跑，含真实 dsh kill 演练） | 2 天 |
| 仓发版 → 老板重启 → host 挂载 | 1 天 |
| **合计** | **~2 周**（与 Sprint 17 / 18 节奏对齐） |

---

## 9. 决策点（请老板拍）

| 决策 | 默认建议 |
|---|---|
| D1 | mount mountOrder 是否调整（40 → 60 让 restart 先加载）？—— **建议不动**，改 mount 的 restart 注入方式为 lazy `ctx.inject(['agint.restart'], cb)`（G3 已说明） |
| D2 | restart 服务不可用时 fallback 行为？—— **建议降级 sentinel lease**（v0.6.5 兼容），不阻塞挂载流程 |
| D3 | mount 是否透传 force 给 restart？—— **建议否**（G9：mount 是系统级动作，burst 应生效） |
| D4 | restart 失败时 mount 标 ROLLED_BACK 还是 DISABLED？—— **建议 ROLLED_BACK**（restart 失败 = 整个事务失败，不是 plugin 本身的问题；DISABLED 留给 plugin 代码本身有问题） |
| D5 | 是否升为 sprint 级（独立 Sprint 17）？—— **建议是**，跨 4 个模块（types.ts / orchestrator.ts / rollback.ts / index.ts）+ 1 个 fixture 改造 |
| D6 | 是否同时实装 G10（事件接入）？—— **建议实装影子发布**（已存在 mountEventBusPublish 函数，只需新增 3 个调用点）。⚠️ 但须同时明确**订阅侧归属**，否则得到的是「发了没人收」 |
| D7 | 是否把本提案与「agint-restart rollback 提案」合并？—— **建议否**，两份提案独立评审更稳（前者改 mount，后者改 restart，互相正交） |

---

## 10. 与「agint-restart rollback 提案」的关系

仓库内 `proposals/agint-restart-rollback.md`（同日提案）：

- **本提案**：`agint-mount` → 调 `agint.restart` 真重启
- **rollback 提案**：`agint.restart.rollback` service（让 cancel / rollback 真能拦下重启链路）

**两者正交**，但有交叉点：

- mount 调用 restart.request 后，**在当前 dsh 退出窗口期**（shutdownDelayMs），理论上老板可以调 `restart.rollback` 拦下（前提是 rollback 提案 P1 已落地）
- 这是 mount 4 态路径的"二次取消"机会——mount 不需要单独实现 cancel 链路，复用 restart 的 rollback 即可
- **本提案不强依赖 rollback 提案**——若 rollback 未落地，mount 4 态路径仍能工作（只是没有"二次取消"机会）

---

## 11. 参考

- `agint-mount/README.md` v0.6.5 当前状态
- `agint-mount/src/orchestrator.ts:280-294` 4 态路径现状
- `agint-mount/src/orchestrator.ts:477-492` requestRestart / waitSentinelLease 骨架
- `agint-mount/schemas/mount-result.schema.yaml` L0-frozen
- `agint-restart/lib/contract.js` 输出契约收敛模式（v0.4.4）
- `agint-restart/README.md` v0.8.1 重启闭环能力
- `proposals/agint-restart-rollback.md` 同日姊妹提案（restart 加 rollback）
- `AGINT.wiki/Sprint11-设计稿.md` §3-4
- `docs/evolution-framework.md` D-QAF / HARM

---

> **本提案状态**：草稿，**未提交** evolve plugin runtime storage
> 若老板决策「接受」→ 由 `evolve_propose` 工具转写为 runtime proposal
> 若「驳回」→ 留作历史，可被 wiki / docs 检索

---

> **实施进度（2026-09-16 实测）**：核心代码已落盘 `plugins/agint-mount/`（src + lib 同步）：
> - `src/orchestrator.ts` / `lib/orchestrator.js`：4 态路径改调 `agint.restart.request` 真重启；`requestRestart` 重写（软降级 fallback）；删除 `waitSentinelLease`；新增跨进程续接钩子 `mountResumeOnBoot`（带 `readRestartResult` 轮询超时，避免与 respawn.js 写结果的竞态）；`updateTicketPhase` 扩 3 个重启字段。
> - `src/storage.ts` / `lib/storage.js`：tickets 表 zod schema 加 `restartRequestId` / `restartResultFile` / `restartMode`（optional，schemaVersion 维持 1）。
> - `src/index.ts` / `lib/index.js`：`apply()` 在 storageDomain.open 后调用 `mountResumeOnBoot`。
> - `src/types.ts`：MountTicket 加 3 字段；清理已弃用 hook 注释（lib/types.js 为类型擦除，无需改）。
> - `package.json` 0.6.6 → 0.7.0；`CHANGELOG.md` 加 v0.7.0 节。
> - **已部署（2026-09-16 21:2x 实测）**：5 个运行时文件已逐文件复制到 host 部署位 `~/.dsh/profiles/web/plugins/agint-mount/`（备份在 `.pre-v0_7_0-deploy-backup-<ts>/`），host 端 md5 与 repo 完全一致：`lib/index.js`、`lib/orchestrator.js`、`lib/storage.js`、`package.json`、`CHANGELOG.md`。其余 `lib/*.js`/`cordis.patch.yml`/`manifest.json`/`tsconfig.json` 同 md5 未动。**但 dsh 运行进程仍是旧 v0.6.6 代码**——`%TEMP%/dsh-web.log` 有 `agint-restart` 指纹 `host code changed since apply … 进程里仍是旧代码，需重启（或等 HMR）才生效`；新模块尚未被 apply。需老板双击 `start-dsh.cmd` 重启 dsh 才能让 v0.7.0 加载（从本会话 spawn 的新实例活不过命令结束，不能代重启）。
> - **未做**：manifest `inject` 未加 `agint.restart`（采用提案 §3.5 选项 2 懒注入 `getService`，避开 mountOrder 40<50 的加载顺序差）；storage schemaVersion 未升 2（仅加 optional 字段，非破坏性）；`test/smoke.mjs` 未更新（§6.1 新用例 11–18 待补，且新真实重启路径断言需 mock `agint.restart`）；4 态路径的**端到端功能验证**未做（需真实 mount 一个带新依赖的插件 + dsh 真重启 + 新 dsh 续接，本会话环境无法完整跑）。
> - **本地无法 `tsc` 出 lib**：插件 `node_modules` 未装、`@deepseek-ai/dsh-storage-domain`/`zod` 类型解析不到、声明的 `typescript@^7` 在 npm 不存在。已手工逐字镜像 src→lib 并 `node --check` 通过；建议 CI 里用真实 tsc 重新编译校验 lib，再 md5 部署 + 重启 dsh。
