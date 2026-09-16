# Proposal: agint-restart 加 rollback（重启失败可回滚）

> **状态**：草案（draft） · 类别 `plugin` · **未提交** evolve plugin runtime storage
> **目标插件**：`agint-restart`（v0.8.1 当前）
> **作者**：MiniMax · **日期**：2026-09-16
> **风险等级**：P1（修改 host service，新增 storage 表、新增 tool 行；不破 FROZEN 契约）

---

## 1. 背景与动机

### 1.1 现状（v0.8.1 行为面）

`agint-restart` 在 v0.2.0 起提供**主动重启**能力：

- `restart_request({confirm, reason, ...})` → 写 `restart-request.json` + detached 拉起 `lib/respawn.js` + 当前进程延迟退出
- `restart_cancel()` → 仅清空内存里的 `pending` 标记 + 在请求文件上追加 `cancelledAt` 时间戳
- `respawn.js` 是独立孤儿进程守护脚本，**完全不看 `cancelledAt`**（见 `lib/respawn.js:84-92` 的 `readRequest`，根本没校验这个字段）

### 1.2 痛点

**当前的「取消」是名义上的，不是事实上的**。一旦请求文件落盘 + respawn.js 拉起，进程退出几乎不可逆：

| 场景 | 现状 | 失败模式 |
|---|---|---|
| 用户误触 restart_request（拼错 reason / 旧任务还想跑） | `cancel()` 返回 `cancelled:true`，但 0.5~1.5s 后本进程仍然会退出；新 dsh 照常拉起 | "我明明取消了为什么还是重启了？" |
| respawn.js 拉起新 dsh **失败**（新实例崩溃 / EADDRINUSE / 端口被占 / 就绪超时） | `restart-result.json` 写 `ok:false`，但**没有回滚到原 dsh 实例的机制**——机器就处在"旧 dsh 已死、新 dsh 起不来"的状态 | 用户必须手动 `dsh web` 救场；如果是 headless server = 直接挂 |
| 新 dsh 起来了但**插件全挂**（cordis patch 写错 / 插件 manifest schema 不兼容 / mountOrder 冲突） | 进程在但每个工具调用都 500；用户看到的不是"重启失败"而是"重启后工具全坏" | 排障耗时长；中间状态无回滚锚点 |
| burst 熔断后老板人工想"再给我一次机会"（比如误把 3 次有效重启计满） | 重置只能手动删 `restart-history.json`；没有任何 service 路径 | 容易漏字段改坏 JSON |

### 1.3 缺口定位

- **没有「回到原 dsh」的能力**：respawn.js 只往前拉，不往后撤
- **没有「重启后健康探针失败则回滚」的策略**：拉起就完了，结果是新进程瘫着
- **没有 service 路径的 burst reset / cancel-rollback**：全靠人工改文件
- **`restart_cancel()` 名实不符**：内部状态清了，但进程退出链路还在跑

### 1.4 不做什么（边界）

- ❌ **不做「原子事务级」重启**（preimage 快照 + 失败回滚到原状）——这是 mount 插件的职责域（见 `agint-mount` 三段式事务 PREPARE→SMOKE→ACTIVATE + 健康探针连续失败 ≥2 → DISABLE）。`agint-restart` 不该和 `agint-mount` 抢角色
- ❌ **不做完整的 dsh 配置版本控制**——那是 `agint-evolution-memory` 的 `success-templates` / `failure-pattern` 范畴
- ❌ **不做跨平台快照**（WAL / VM snapshot）——超出插件能力边界

**本提案专注**：让"主动重启失败"或"主动重启被人工否决"时，**有一个明确、可观察、可调用的回滚路径**，而不是只能"希望新 dsh 起得来"。

---

## 2. 目标

### 2.1 必达（Must）

| ID | 描述 |
|---|---|
| **G1** | `restart_cancel()` 在 `restart_request()` 被接受后、当前进程退出前的窗口期内，**真正能阻止进程退出链路** |
| **G2** | `respawn.js` 检测到「请求文件被标记 cancelled」→ 不拉起新实例，**直接退出**（不是看也不看） |
| **G3** | respawn.js 拉起新 dsh 失败 / 新 dsh 健康探针失败 → 在 `restart-result.json` 写明 `failed=true` + `recoverable=true`，**保留旧进程的退出路径**（即：在某些时序下还能救——本提案给"是否能救"留出检测位，但具体救场动作人工） |
| **G4** | 新增 `restart_reset_history()` service —— 清空 `restart-history.json`（解除 burst 熔断 / 清空冷却），用于人工恢复 |
| **G5** | 输出契约统一收敛（继续走 `lib/contract.js` 的字段表 + schema + 分支构造函数单一事实源）——**不破 FROZEN** |

### 2.2 应达（Should）

| ID | 描述 |
|---|---|
| **G6** | `restart_request()` 返回值新增 `cancellableUntil: ISOString` —— 明确告诉调用方"过了这个时间点 cancel 不再有效"（= 进程已退出） |
| **G7** | 新增 `restart_history_clear` / `restart_pending_clear` 工具（**写工具默认 ask 门禁**，与 `mutator_/population_` 一致） |

### 2.3 可达（Could）

| ID | 描述 |
|---|---|
| **G8** | respawn.js 拉起新 dsh 后做**轻量健康探针**（lease 文件被刷新 + 端口可连 + 第一个 Service 可达），失败则把 `restart-result.json.failedReason` 写明；不替 mount 做"自动回滚到旧实例"（那要求预存旧进程 image，超出能力） |
| **G9** | 启动一个**手动回滚 runbook** 脚本（`bin/restart-rollback.ps1`）——把"respawn 失败 → 手动拉原 launch 命令"这条 SOP 脚本化；非插件职责，仅辅助 |

---

## 3. 设计

### 3.1 现有链路的修改点

```
[lib/index.js]                         [lib/respawn.js]                  [state dir]
─────────────────                       ────────────────                  ──────────
restart_request()
  ├─ 写 restart-request.json ────────►  readRequest()                    request.json
  │   {requestId, targetPid,                ↑ 当前完全不看 cancelledAt
  │    cancelledAt?: null}                  │
  ├─ spawn respawn.js ────────────────►  main()
  ├─ shutdownSelf(delayMs)                                    ──►         旧 dsh 退出
  └─ pending = {requestId, at}
                                        1. waitForExit(targetPid)
                                        2. waitPortFree()
                                        3. launchProcess()         ──►   新 dsh 拉起
                                        4. waitReady()             ──►   restart-result.json
                                                                            {ok: false?, ...}

restart_cancel()                          ←── 没任何跨进程信号 ──
  ├─ pending = null                                           
  ├─ restart-request.json 加 cancelledAt 时间戳                 
  └─ 返回 cancelled:true (但进程照样退出)
```

### 3.2 新增的服务与修改

#### 3.2.1 Service：`agint.restart.rollback`（新）

**签名**：
```js
agint.restart.rollback({ reason?: string }) → {
  rollback: 'rolled-back' | 'not-pending' | 'too-late' | 'no-file',
  code: string,
  message: string,
  requestId: string | null,
  sideEffect: boolean,
  // 仅 rolled-back 时有：
  cancelledAt?: string,
  expiresAt?: string,    // 进程退出的 deadline，过了就回滚不掉
}
```

**职责**：

1. 若 `pending === null` → 返回 `not-pending`（没在途请求，**无需回滚**）
2. 读 `restart-request.json`：
   - 文件不存在 → 返回 `no-file`（已过清理窗口或根本没写成功）
3. **关键**：用 `shutdownDelayMs + 当前时间` 与 `shutdownSelf` 的 setTimeout 比较——若超过 deadline → 返回 `too-late`（**回滚不掉**，进程已经在退出路上）
4. 在 `restart-request.json` 上写 `cancelledAt: <now>` + `cancellationReason: <reason>`
5. **取消 `shutdownSelf` 的 setTimeout**（这是 G1 的核心——目前 cancel() 没碰 timer）
6. 清空内存 `pending`
7. respawn.js 启动时会读 `cancelledAt`，若存在则**走早退路径**（见 3.2.3）

#### 3.2.2 Service：`agint.restart.resetHistory`（新）

**签名**：
```js
agint.restart.resetHistory({ confirm: boolean }) → {
  cleared: boolean,
  code: 'cleared' | 'needs-confirm' | 'no-history',
  message: string,
  clearedAt: string,
  removedCount: number,
  sideEffect: boolean,
}
```

**职责**：
1. 不带 `confirm:true` → 返回 `needs-confirm`
2. 读 `restart-history.json`，若为空 / 不存在 → 返回 `no-history`
3. 删除文件 / 清空 events 数组（**默认清空数组保留文件**，便于审计）
4. 写 `clearedCount` 到 `restart.log`

**理由**：当 burst 熔断误触发（3 次合法重启被记满）或 cooldown 倒计时阻碍下次合法操作时，老板有 service 级路径清空它，不需要手动 `cat | jq` 改文件。

#### 3.2.3 修改：`lib/respawn.js`

**新增早退分支**：

```js
async function main() {
  const req = readRequest(reqPath);
  // 新增：检测取消标记（早于所有副作用之前）
  if (req.cancelledAt) {
    const result = {
      requestId: req.requestId ?? null,
      cancelled: true,
      cancelledAt: req.cancelledAt,
      cancellationReason: req.cancellationReason ?? null,
      finishedAt: new Date().toISOString(),
      ok: false,
      reason: 'cancelled-by-rollback',
    };
    writeResult(result);
    log('rollback: cancelled before respawn, exiting without launching new dsh');
    process.exit(0);  // 正常退出，旧 dsh 没退的话也无所谓（cancel() 已清掉 shutdownSelf timer）
  }
  // ... 原有流程不变 ...
}
```

**新增健康探针（轻量，G8）**：

```js
async function healthProbe(readiness, logFile, log) {
  // 等待就绪后，再等 5s（覆盖 plugin apply 早期崩溃）
  const probeStart = Date.now();
  const PROBE_WINDOW_MS = 5000;
  while (Date.now() - probeStart < PROBE_WINDOW_MS) {
    const probeResult = await runPluginHealthProbe(readiness);  // 调 /__health 或读 sentinel
    if (probeResult.ok) return { healthy: true, waitedMs: Date.now() - probeStart };
    await sleep(500);
  }
  return { healthy: false, waitedMs: Date.now() - probeStart };
}
```

> 健康探针的具体形式取决于 dsh 暴露什么端点；本提案**只承诺 respawn.js 会**有这段钩子，**探针实现细节放到 P2 子任务**（避免本提案范围爆炸）。

#### 3.2.4 修改：`lib/index.js` 的 `cancel()` → 重命名为内部，`rollback()` 包装

```js
// 内部实现（被 rollback / cancel 共同调用）
const rollbackInner = (input = {}) => {
  if (!pending) return rollbackResult({ code: 'not-pending', ... });
  
  const file = readJson(requestPath, null);
  if (!file) return rollbackResult({ code: 'no-file', ... });
  
  // 关键：取消 shutdownSelf 的 timer（要保留 timer 句柄）
  if (shutdownTimerHandle) {
    clearTimeout(shutdownTimerHandle);
    shutdownTimerHandle = null;
  }
  
  // 写取消标记到请求文件
  writeJson(requestPath, {
    ...file,
    cancelledAt: new Date().toISOString(),
    cancellationReason: input.reason ?? null,
  });
  
  pending = null;
  
  return rollbackResult({
    code: 'rolled-back',
    requestId: file.requestId,
    cancelledAt: ...,
    expiresAt: ...,
  });
};

const rollback = (input = {}) => {
  try { return rollbackInner(input); }
  catch (err) { return rollbackInternalError(err); }
};

// 保留 cancel() 作为兼容别名（内部走 rollback）
const cancel = (input = {}) => rollback({ reason: input.reason ?? 'cancelled by legacy cancel()' });
```

**关键改动**：

- `shutdownSelf()` 现在把 setTimeout 句柄**保存到外层闭包变量** `shutdownTimerHandle`，rollback 能 clearTimeout 它
- `cancel()` 不再单独维护 pending 清理路径——全部走 rollback

#### 3.2.5 manifest.json 的 spec 扩展

```diff
   "spec": {
     "cordis": {
       "inject": ["agents"],
       "optionalInject": [],
       "provides": [
         "agint.restart",
-        "agint.restart.detect"
+        "agint.restart.detect",
+        "agint.restart.rollback",        // 新
+        "agint.restart.resetHistory"     // 新
       ],
       "events": [
         "agent/session-start",
         "agent/pre-step"
       ],
       "tools": [
         "restart_status",
         "restart_request",
-        "restart_cancel"
+        "restart_cancel",                // 兼容（内部走 rollback）
+        "restart_rollback",              // 新（推荐用）
+        "restart_reset_history"          // 新
       ]
     },
```

### 3.3 storage 域扩展

**当前**：`agint_restart` 域 1 表（markers/result/history 都是 JSON 文件，不是 storage 表——`atomic: json` 仅约束写盘语义）。

**新增 storage 表**：

| 表 | 上限 | 字段 | 用途 |
|---|---|---|---|
| `rollback_log` | 50 | `{requestId, reason, cancelledAt, expiresAt, success: bool, message}` | 每次 rollback 留痕，便于事后复盘（"老板那次为什么重启失败？""哦他 rollback 了"） |

**storage schemaVersion**：1 → 2

**向后兼容**：旧 storage 域里没这张表，第一次 mount 时按 storage 默认行为（空表）创建，不破现有数据。

### 3.4 工具行新增（preset 挂载）

```yaml
# 在 presets/agint/agent.cordis.yml 中新增（或合入已有的 agint-restart-tools row）
- id: agint-restart-tools
  name: ../../profiles/web/plugins/agint-restart/lib/tools.js
```

工具集新增：
- `restart_rollback`（**写工具，默认 ask 门禁**）
- `restart_reset_history`（**写工具，默认 ask 门禁**）

`restart_cancel` 保留为兼容名（内部转发到 rollback）。

### 3.5 契约（FROZEN 字段保护）

**FROZEN 不动**（v0.1.0 起）：

- `agint.restart` / `agint.restart.detect` 服务签名
- `restart_status` / `restart_request` / `restart_cancel` 工具的 **入参 schema**
- `restart_status` 的字段表（v0.8.1 加 codeFingerprint 时定的，README 里有 FROZEN 标注）

**新增 / 修改（非 FROZEN）**：

- `agint.restart.rollback` / `agint.restart.resetHistory` 服务（新增）
- `restart_rollback` / `restart_reset_history` 工具（新增）
- `restart_request` 返回值**新增可选字段** `cancellableUntil`（G6，不破 FROZEN：v0.4.4 contract.js 的 REQUEST_FIELDS 表已经允许 optionalNullable 字段）
- `restart_cancel` 行为**变更**：从「仅清 pending」升级为「真回滚」（语义变化，**主版本号 → 0.9.0**；旧 cancel 调用方得到的还是 cancelled:true 但底层走 rollback 路径）

**主版本号语义**：本次提案**升 v0.9.0**（v0.8.1 → v0.9.0）。

- v0.8.x → v0.9.0 的边界：cancel 行为真变化了；其它都是 additive（不破）。
- 这是 minor+1，不是 major；按 agint 仓库的版本约定（VERSION 表 + AGENTS.md 红线），plugin-breaking minor 也要走 major。本次用 **0.9.0** 而不是 **0.8.2** 是因为 cancel 行为变更虽兼容旧返回值，但**底层语义变了**——老代码若依赖"cancel 后进程仍然退出"会出意外。

### 3.6 配置项新增

```yaml
# cordis.patch.yml 增项
config:
  # 启动一个 restart_request 后，多久内 rollback 仍然有效（默认 30s）
  # 超过这个时间 = shutdownSelf 的 timer 已经触发，rollback 只能"写标记"不能"拦进程"
  rollbackWindowMs: 30000
  # 健康探针（respawn.js 拉起新 dsh 后）的额外等待（默认 5000ms，G8）
  # 设 0 = 不做额外探针，依赖 dsh 自带就绪信号
  postLaunchProbeMs: 5000
  # 重试上限（respawn 拉起新 dsh 失败时）：达到后写 failed=true + 不再重试
  # 默认 0 = 不重试（一次性）
  respawnMaxRetries: 0
```

---

## 4. 实现路径（分阶段）

### P1（本次提案本体，必做）

| 步骤 | 文件 | 工作量 |
|---|---|---|
| 1 | `lib/contract.js` | 新增 `REQUEST_FIELDS.cancellableUntil` optionalNullable + 新增 `ROLLBACK_FIELDS` + `RESET_HISTORY_FIELDS` 表 + 构造函数 + schema |
| 2 | `lib/index.js` | ① shutdownSelf 返回 timer 句柄并保存；② 新增 `rollbackInner` / `rollback`；③ cancel 转发到 rollback；④ 注册新 services |
| 3 | `lib/respawn.js` | ① readRequest 后立刻检查 `cancelledAt`；② 写 `rollback` 分支的 result 文件 |
| 4 | `lib/tools.js` | 新增 `restart_rollback` / `restart_reset_history` 工具定义 |
| 5 | `manifest.json` | `provides` / `tools` / `storage.domains` / `schemaVersion` 增项；`description` / `serviceDocs` 增项 |
| 6 | `cordis.patch.yml` | 新增 `rollbackWindowMs` / `postLaunchProbeMs` / `respawnMaxRetries` 默认值 |
| 7 | `README.md` | 「重启闭环」章节补「回滚」小节；新增 Service 表加 rollback / resetHistory 两行 |
| 8 | `test/smoke.mjs` | 12 → 18 用例：rollback happy / rollback too-late / rollback no-pending / rollback too-late 边界 / resetHistory needs-confirm / resetHistory empty / respawn 早退（cancelledAt 命中）/ cancel→rollback 兼容路径 |
| 9 | `CHANGELOG.md` | v0.9.0 章节 |
| 10 | 仓库 10 维度 plugin-check | `bin/plugin-check.sh plugins/agint-restart` 通过 |

### P2（建议在 P1 落地后单开 proposal）

- 健康探针具体实现（依赖 dsh 暴露什么端点；要先看 dsh 主线）
- `bin/restart-rollback.ps1` 脚本（G9）
- 跨周累计自动部署的 D-QAF budget 检查接入（当前 `agint-quality-eval` 已有，但未触发）

### P3（远期，看后续事故模式）

- 「重启链路全程录制」→ 可回放（事故复盘导向）
- 与 `agint-mount` 的事务级回滚对接（mount 的 rollback 倒序清理 vs restart 的进程级回滚，目前各管各的）

---

## 5. 红线与风险

### 5.1 红线合规（AGENTS.md §挂载/重启红线 2026-08-21）

| 红线 | 本提案行为 |
|---|---|
| 拍 4 份快照（patch / preset / plugins tar.gz / storages）后再动 | ✅ 提案要求：实施前必须 `safe-update.sh snapshot` |
| `kill -SIGTERM` 而非 SIGKILL | ✅ 不变；本提案不碰退出策略 |
| `cat sentinel.lease` 看 `at` < 30s | ✅ 不变 |
| 崩了就 `plugin → patch → preset` 倒序回滚 | ✅ 不变 |
| 跨平台 fixture | ✅ 现有测试已含 forward-slash + `../escape` 负向；rollback 测试再加 case 覆盖 `cancellableUntil` 时区差异 |

### 5.2 插件准入红线（PLUGIN-SPEC 10 维度）

| 维度 | 影响 |
|---|---|
| 1. Contract | ✅ manifest 显式声明新 service / 工具 |
| 2. Storage domains | ✅ `agint_restart` 域 + 1 新表 `rollback_log`，独占 |
| 3. Dependencies | ✅ 不变（仍只依赖 cordis `agents`） |
| 4. Permissions | ✅ env 增加 `AGINT_HOME`（rollback 读 markerDir 用）；shell 仍 false |
| 5. Lifecycle | ✅ 新增 setInterval（健康探针）；必须 `ctx.effect` disposer 注册 |
| 5.5 跨平台 fixture | ✅ smoke 新增 forward-slash + `../escape` 负向 |
| 6. Tests | ✅ 18 用例 |
| 7. Docs | ✅ README 补「回滚」小节 + service 表 |
| 8. Changelog | ✅ CHANGELOG.md v0.9.0 |
| 9. runtime-contract | ✅ waterfall 监听器（agent/session-start、agent/pre-step）保持原有 `next()` 调用 |
| 10. 文档-代码公式一致性 | ✅ rollbackWindowMs / postLaunchProbeMs 在 lib/index.js 中实际读取并使用 |

### 5.3 风险评估

| 风险 | 等级 | 缓解 |
|---|---|---|
| 改 cancel 行为 → 老调用方依赖"cancel 后仍退出"出意外 | 中 | 旧 cancel 返回值字段不变；新 cancel 内部走 rollback；旧 cancel 的"shutdown timer 仍然会触发"行为**取消**——若老板脚本依赖这个，必须升级。这是 minor bump 的根因 |
| respawn.js 新增 cancelledAt 检查 → 启动时多一次文件读 | 低 | JSON.parse 已经做了一次，再多读一个字段是 O(1) |
| 健康探针触发新的"探针失败就回滚"逻辑 → 误判导致正常 dsh 被标失败 | 中 | 探针**只写** `failedReason`，**不替 mount 做回滚**——失败也仅记录，由人决策 |
| `restart_request` 返回值新增字段 → 旧 schema 校验可能拒 | 低 | `cancellableUntil` 标 `optionalNullable`，schema 不破；现有 `normalizeRequestOutput` 兜底 |
| 写工具默认 ask 门禁 → `restart_rollback` 第一次调会被问 | 接受 | 与 mutator/population 一致，AGENTS.md 已规定 |

### 5.4 D-QAF / HARM 评估点

按 `docs/evolution-framework.md` 的 D-QAF 四阶段：

| 阶段 | 状态 |
|---|---|
| 静态准入 | plugin-check 10 维全过（实施后） |
| 动态沙箱 | smoke 18 用例全过（实施后） |
| 集成演练 | 跨插件不破：仅依赖 cordis `agents`，不引入新依赖 |
| 灰度发布 | 0.9.0 → 仓发版 → 等老板重启 → host 端挂载 → AGENTS.md 本机实况自动块更新 |

HARM 四维：

| 维度 | 影响 |
|---|---|
| Homogeneity | 提案与现有 v0.8.x 范式一致（contract.js 字段表 + 输出契约收敛） |
| Alignment | 与"安全 > 效率"哲学对齐（rollback = 给误触留出口，符合「真实 > 讨好」——明确说 cancel 不再是名义上的） |
| Reduction | additive 为主；唯一行为变化是 cancel → 真 rollback |
| Mutability | 不破 FROZEN 契约；plugin spec schemaVersion 升级走 storage 兼容路径 |

### 5.5 哲学对齐检查（v0.8.x 红线要求，P 阶段验收必含）

- **真实 > 讨好**：本提案**承认**「v0.2.0 起的 cancel 是名义上的、不真」这个事实，**不**假装「cancel 一直是这样」——changelog v0.9.0 写明「cancel 行为变更」
- **靠谱 > 聪明**：rollback 走单一 service 入口（不散到 index.js 各个角落），cancel 转发到 rollback（不维护两套路径）
- **简洁 > 冗余**：rollback 字段表沿用 contract.js 模式（REQUEST_FIELDS 风格），不引入新框架
- **安全 > 效率**：rollback 必须显式传 `reason`（虽然 optional，但 contract 推荐写），result 写 `sideEffect` 说明已发生什么
- **主动 > 被动**：把"怎么回滚"从「人工 cat | jq 改文件」变 service 调用

---

## 6. 验证计划

### 6.1 单元测试新增（`test/smoke.mjs`）

| 用例 | 覆盖点 |
|---|---|
| 33. rollback happy path | 在 shutdownSelf 触发前调 rollback → shutdownTimer 被 clear → 进程不退出 → respawn.js 启动后读到 cancelledAt → 早退 |
| 34. rollback too-late | rollback 在 deadline 之后调 → 返回 `too-late`，shutdownTimer 仍触发 |
| 35. rollback no-pending | 没有 pending → 返回 `not-pending`，零副作用 |
| 36. rollback no-file | pending 有但 request.json 已清 → 返回 `no-file` |
| 37. respawn 早退 | respawn.js 读到 cancelledAt → 写 rollback 标记到 result.json → 不拉新 dsh → exit 0 |
| 38. resetHistory needs-confirm | 不带 confirm → 返回 `needs-confirm` |
| 39. resetHistory empty | restart-history.json 不存在 / events 空 → 返回 `no-history` |
| 40. cancel 兼容路径 | 调 cancel → 内部走 rollback → 返回值字段兼容（含 requestId / sideEffect） |
| 41. cancellableUntil 字段 | restart_request 返回值含 cancellableUntil ISOString，在 `now + shutdownDelayMs + rollbackWindowMs` 范围内 |
| 42. storage rollback_log 写入 | 每次 rollback 都向 `agint_restart.rollback_log` 表写一条 |

### 6.2 端到端演练（人工）

1. **挂载 v0.9.0**：`safe-update.sh snapshot` → 替换 plugin → `safe-update.sh smoke`
2. **happy path 演练**：模拟 agent 调 `restart_request` → 立刻 `restart_rollback` → 看 `restart-result.json.cancelled=true` + 旧 dsh 未退
3. **respawn 失败演练**：人工把 `restart.logFile` 路径改成只读 → 调 `restart_request` → 等 30s → 看 `restart-result.json.failed=true` + `failedReason=ENOENT`
4. **burst reset 演练**：3 次合法 restart_request 触发熔断 → 调 `restart_reset_history({confirm:true})` → 下次 restart_request 通过
5. **跨会话连续性演练**：在 UI 里开两个会话 → 第一个调 `restart_rollback` → 第二个会话**不中断**（验证进程未退出）

### 6.3 失败模式覆盖

| 失败模式 | 期望行为 |
|---|---|
| rollback 时 respawn.js 已经拉起但还没 waitForExit | respawn 读 cancelledAt → 早退，旧 dsh 因为 timer 被 clear 而继续运行 |
| rollback 时新 dsh 已经拉起 | 太晚——返回 too-late；新 dsh 已经接管，无法回滚 |
| resetHistory 时 history 文件被另一个进程持有 | 返回 `internal-error` + sideEffect=false |
| respawn.js 早退时 result.json 写失败 | log 记录，不抛（不影响退出） |

---

## 7. 不在本次提案范围（明确）

1. **预存旧进程 image → 自动回滚到原 dsh**（超出能力边界；属于 mount 插件的"事务级回滚"语义）
2. **跨平台 dsh 健康探针的具体实现**（依赖 dsh 暴露什么端点；P2 单开）
3. **`bin/restart-rollback.ps1` 人工 runbook**（G9，实施时另开）
4. **restart_request 与 agint-mount 的对接**（mount 的 rollback 倒序清理是文件级；本提案是进程级——两者不冲突，但桥接是 P3 远期）

---

## 8. 实施时间线（建议）

| 阶段 | 周期 |
|---|---|
| 提案评审 + D-QAF 评估接入 | 1 周（影子期） |
| P1 实施（10 步） | 3-4 天 |
| Smoke + plugin-check | 1 天 |
| 端到端演练 | 1 天 |
| 仓发版 → 老板重启 → host 挂载 | 1 天 |
| **合计** | **~2 周**（与 Sprint 17 节奏对齐） |

---

## 9. 决策点（请老板拍）

| 决策 | 默认建议 |
|---|---|
| D1 | cancel 是否升级为"真回滚"（= 旧 cancel 调用方受影响）？—— **建议是**，理由：本提案的核心价值就是修这个 |
| D2 | rollbackWindowMs 默认值？—— **建议 30000ms**（覆盖 shutdownDelayMs 1500 + 进程退出 ~3s + respawn 启动 ~5s 余量） |
| D3 | 是否在 respawn.js 加 postLaunchProbeMs？—— **建议加**，但默认 5000ms；用户可设为 0 关掉 |
| D4 | resetHistory 是否要 confirm 必填？—— **建议必填**，与 restart_request 一致 |
| D5 | 主版本号 0.9.0 还是 0.8.2？—— **建议 0.9.0**（cancel 行为变化是契约变更） |
| D6 | 是否升为 sprint 级（独立 Sprint 17）？—— **建议是**，因为本提案跨 4 个模块（contract.js / index.js / respawn.js / tools.js） |

---

## 10. 参考

- `agint-restart/README.md` v0.8.1 当前状态
- `agint-restart/lib/contract.js` v0.4.4 契约收敛模式
- `agint-restart/lib/respawn.js` 早退分支待加
- `agint-mount/README.md` 三段式事务（PREPARE→SMOKE→ACTIVATE + 健康探针）—— 本提案**不**复刻它的复杂度，但借鉴它的"健康探针失败标记"思路
- `docs/evolution-framework.md` D-QAF / HARM
- `AGENTS.md` §挂载/重启红线 + §插件准入红线 10 维度 + §哲学锚点护栏

---

> **本提案状态**：草稿，**未提交** evolve plugin runtime storage
> 若老板决策「接受」→ 由 `evolve_propose` 工具（或 AGINT preset 里挂的 `agint-evolve` service）转写为 runtime proposal
> 若「驳回」→ 留作历史，可被 wiki / docs 检索
