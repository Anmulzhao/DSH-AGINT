# agint-mount

> AGINT 动态插件挂载编排器 v0.6.5。
>
> **Sprint 11 收口 / 设计稿 `AGINT.wiki/Sprint11-设计稿.md` §4.1**。
> 三段式事务（PREPARE → SMOKE → ACTIVATE）+ 4 态状态机（PREPARED → INSTALLED → RESTART_REQUESTED → ACTIVATED）+ 两段式 commit（HMR 成功前 atomic backup 永不清）。

---

## 一句话定义

把通过 `agint-quality-static` + `agint-quality-sandbox` 双门禁的 TOOL_SYNTHESIS 变异产物，编排为「暂存 → 沙箱验证 → dsh 热加载 → 健康探针 → 失败回滚」的可预期、可回滚挂载链路。

---

## 3 Service（FROZEN 候选）

| Service | 签名 | 职责 |
|---|---|---|
| `agint.mount.request` | `(proposal: MutationProposal, verdict: SandboxVerdict) → MountResult` | 受理挂载请求 → 三段式事务编排 → MountTicket；沙箱不可用时降级 PENDING_REVIEW |
| `agint.mount.status` | `(ticketId: string) → MountResult & probeStats & createdAt` | 查询 ticket 当前阶段（PREPARED/INSTALLED/RESTART_REQUESTED/ACTIVATED/HEALTHY/DISABLED/ROLLED_BACK）+ 探针历史 |
| `agint.mount.rollback` | `(ticketId: string, reason: string) → RollbackResult` | 显式回滚（人类否决权入口）；从 fromPhase 倒序执行 PREPARE/SMOKE/ACTIVATE 清理 |

完整签名与 zod schema 见 `src/schemas.ts`、`src/orchestrator.ts`。

---

## FROZEN MountResult（`schemas/mount-result.schema.yaml`，L0-frozen）

```yaml
type: object
frozenness: L0                # Sprint 11 内禁改；改走 L0 治理
required: [ticketId, proposalId, phase, contractCheck, activatedAt]
properties:
  ticketId:    { type: string }
  proposalId:  { type: string }
  phase:
    type: string
    enum:
      - PREPARED            # PREPARE 阶段产物已落 staging
      - INSTALLED           # （4 态路径）pnpm install 完成
      - RESTART_REQUESTED   # （4 态路径）已发 sentinel restart
      - ACTIVATED           # ACTIVATE 阶段完成；HMR settle；正式挂载
      - HEALTHY             # 探针连续成功 ≥ 3 次（健康）
      - DISABLED            # 探针连续失败 ≥ 2 次（自动 DISABLE，保留现场）
      - ROLLED_BACK         # 任一阶段失败或显式回滚完成
  contractCheck:
    type: object
    required: [signatureDiff, domainIsolation, dependencyWhitelist]
    properties:
      signatureDiff:       { type: boolean }
      domainIsolation:     { type: boolean }
      dependencyWhitelist: { type: boolean }
  activatedAt: { type: [string, "null"], format: date-time }
```

---

## 4 态状态机（spike 决策后）

```
                              ┌─────── ROLLED_BACK ───────┐
                              │  (任一阶段失败/显式回滚)   │
                              ▼                           │
   ┌──────────┐  SMOKE  ┌───────────┐  pnpm install  ┌──────────┐  sentinel restart  ┌──────────────────┐  HMR settle  ┌───────────┐
   │ PREPARED ├────────►│ SMOKE 验证 ├─────────────────►│INSTALLED ├──────────────────►│ RESTART_REQUESTED ├─────────────►│ ACTIVATED │
   └──────────┘  PASS   └───────────┘   (4 态路径)     └──────────┘                    └──────────────────┘              └─────┬─────┘
        │                              │ (3 态路径直通)                                              probe ≥3 success       │
        │                              └──────────────────────────────────────────────────────────► ACTIVATED ────────┐       │
        │                                                                                                                │       ▼
        │                                                                                                          ┌─────────┐ │
        │                                                                                                          │ HEALTHY │ │ probe ≥2 failure
        │                                                                                                          └─────────┘ │       │
        │                                                                                                                     ▼       ▼
        │ 探针连续失败 ≥2 (probe failure)                                                                ┌──────────┐
        └───────────────────────────────────────────────────────────────────────────────────────────────►│ DISABLED │
                                                                                                          └──────────┘
```

**3 态路径（A：plugin 只用 dsh 已闭包内依赖）**：
`PREPARED → ACTIVATED → HEALTHY / DISABLED`

**4 态路径（B：plugin 声明新 npm 依赖）**：
`PREPARED → INSTALLED → RESTART_REQUESTED → ACTIVATED → HEALTHY / DISABLED`

---

## 三段式事务（设计稿 ADR-11-3）

```
Phase 1 PREPARE   产物写入 ~/.dsh/profiles/web/plugins/<id>/
                  （B 路径同步写 package.json deps）
Phase 2 SMOKE     调 agint.qualitySandbox.runVerify / runExplore
                  沙箱不可用 → decision 降级 PENDING_REVIEW（红线：不 AUTO_DEPLOY）
Phase 3 ACTIVATE  两段式 commit（spike 决策）：
                  A 路径：plugin 文件已就位 → atomic 写 patch.yml → HMR settle → cleanup
                  B 路径：调 pnpm install → 发 sentinel restart → 等 lease → ACTIVATED
任一阶段失败       → executeRollback(ticketId, lastSuccessfulPhase, reason)
                  → 写 rollback_log + emit mount.failed + agint.evolution.addFailure
```

---

## 两段式 commit（spike 决策红线）

```js
// src/patch.ts
const bak = await backupPatch(patchPath);           // (1) 先 atomic backup
try {
  await writePatchAtomic(patchPath, newYaml);       // (2) atomic 写
  const ok = await awaitHmrSettle(newId, 30000);    // (3) 等 HMR
  if (!ok) { await restorePatch(patchPath, bak); throw new Error('hmr-settle-failed'); }
  await cleanupBackup(bak);                         // (4) HMR 成功才删 backup
} catch (e) {
  await restorePatch(patchPath, bak);               // (5) 任何失败 → 恢复
  throw e;
}
```

`EntryGroup.update()` 只回滚 memory tree 不回滚磁盘 YAML —— 必须自己 atomic backup + 自己恢复。

---

## 健康探针（设计稿 ADR-11-3）

```js
// src/health-probe.ts
const cfg = { intervalMs: 10_000, successThreshold: 3, failureThreshold: 2 };
// 连续成功 ≥ 3 → HEALTHY
// 连续失败 ≥ 2 → DISABLE（不删除 plugin；保留现场供归因）
```

探针函数由 `agint.probeFn` Service 注入；Sprint 11 骨架默认 `probeStaging` stub；真实 dsh 探针由 codex-D 在第 2 周接入。

---

## 存储域（独占 `agint_mount`）

3 张表（`src/storage.ts`）：

| 表 | 上限 | 字段要点 |
|---|---|---|
| `tickets` | 200 | ticketId / proposalId / artifactName / **phase**（FROZEN 7 值） / **contractCheck**（FROZEN 三布尔） / activatedAt / decision / createdAt / updatedAt / probeStats |
| `probe_history` | 2000 | ticketId / at / ok / latencyMs / reason |
| `rollback_log` | 200 | ticketId / fromPhase / actions[] / reason / executedAt |

**红线**：不触碰 `agint_meta` 域（设计稿 §2.2 + AGENTS.md 红线）。

---

## 对外事件语义命名（Sprint 12 Event Bus 迁移面）

| 事件 | 触发时机 | payload |
|---|---|---|
| `mount.requested` | mount.request 受理 | `{ ticketId, proposalId, decision }` |
| `mount.succeeded` | ACTIVATE 完成 | `{ ticketId, artifactName, decision }` |
| `mount.failed` | 任一阶段失败 / 探针 DISABLE | `{ ticketId, fromPhase, reason, actions? }` |

Sprint 11 通过 `ctx.emitEvent → agint.evolution.recordEvent` 点对点发布；Sprint 12 由 Event Bus 替换 transport。

---

## 与兄弟插件的接口

| 交互 | 方式 | 说明 |
|---|---|---|
| static / sandbox → mount | `mount.request` Service 调用 | 门禁顺序：先静后动（安全左移） |
| mount → population | `agint.population.ingest`（仅 SMOKE PASS 后调用） | 新个体标记 `origin=synthesized` |
| mount → evolution-memory | `agint.evolution.addFailure / recordEvent` | 挂载全程留痕 |
| 人类否决 | `mount.rollback` Service + CLI | 显式回滚入口 |

不调 `agint-quality-contract` FROZEN 接口（设计稿 §七 L0 治理）。

---

## 目录结构

```
plugins/agint-mount/
├── package.json
├── tsconfig.json
├── cordis.patch.yml          # loader 模板（不挂顶层；老板走 safe-update 合并）
├── manifest.json             # PLUGIN-SPEC 8 维度
├── schemas/
│   └── mount-result.schema.yaml   # FROZEN L0
├── src/
│   ├── index.ts              # Cordis 入口 + 3 Service 注册
│   ├── orchestrator.ts       # 三段式 + 4 态状态机
│   ├── health-probe.ts       # 探针 + DISABLE 规则
│   ├── rollback.ts           # 倒序清理 + 事件留痕
│   ├── storage.ts            # agint_mount 域 spec + 3 表
│   ├── schemas.ts            # FROZEN zod 校验
│   ├── patch.ts              # 两段式 commit（atomic backup + restore）
│   ├── paths.ts              # 路径解析（不用 dsh.profilesDir）
│   └── types.ts              # MountContext 抽象
├── test/
│   └── smoke.mjs             # 10 用例契约层验证
└── README.md
```

---

## 验证

```sh
# 契约层 smoke（不依赖 tsc / dsh runtime）
node test/smoke.mjs

# PLUGIN-SPEC 8 维度 lint
bin/plugin-check.sh plugins/agint-mount

# （未来）tsc build → lib/
npm run build
```

---

## Sprint 11 红线

- **不写** L0 隔离规则具体实现（codex-B 的活；orchestrator 留 `l0IsolationCheck` hook）
- **不写** fixture / e2e 场景（codex-C / codex-D 的活）
- **不触碰** `agint_meta` 存储域
- **不修改** `mount-result.schema.yaml` 的 FROZEN 字段
- **不破坏** 既有 18 个插件

---

## 相关

- 设计稿 `AGINT.wiki/Sprint11-设计稿.md` §3-4（架构 + 契约 + ADR）
- `docs/plugins/PLUGIN-SPEC.md`（8 维度规范）
- `bin/agint-mount.sh`（挂载 SOP）
- `bin/safe-update.sh`（snapshot / restart / rollback）
- `plugins/agint-quality-sandbox`（双模式沙箱）
- `plugins/agint-population`（种群管理器；挂载成功后注册新个体）
