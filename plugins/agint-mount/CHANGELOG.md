# Changelog — agint-mount

> 所有破环性变更必须写入本文件。变更流程：FROZEN schema（`mount-result.schema.yaml` + `MountResultSchema` + `ContractCheckSchema`）修改走 L0 治理（人类多签 + 7 天影子 + major 版本），其它按 semver。

---

## v0.7.0 — 未发布 — Sprint 12

### 调研（Investigated）

- **mount 健康探针信号源**（B5）：调研 dsh 是否暴露可注入的真实心跳接口，用于替换
  `src/health-probe.ts` 的 mock 心跳（`probeStaging` stub）。

  **结论：dsh v0.1.1-rc.2 暂未暴露显式心跳 service。保留 mock fallback，`health-probe.ts` 行为不变。**

  **语义原话不变**：连续成功 ≥ 3 次 → `HEALTHY`；**失败 ≥ 2 → DISABLE**（不删除 plugin；保留现场供归因）。
  探针函数仍由 `probeFn` 注入，默认 `probeStaging` stub；本次不改 `manifest.json` 的 `optionalInject`
  （不硬猜不存在的服务名）。

  **调研证据**（4 路交叉验证，均为空）：

  1. `grep -rlniE "heartbeat|readiness|liveness|keepalive|\bpulse\b" --exclude-dir=node_modules .`
     于 `@deepseek-ai/dsh@0.1.1-rc.2` 包根 → **0 命中**（`lib/` 仅 5 个 bundle 文件，无心跳符号）。
  2. 展开到真实运行时 `node_modules/@deepseek-ai/dsh-*`（187 个包）同 grep → 53 个文件命中，
     **逐一核验后全部是 JSDoc 散文，无任何 API/service**。代表性证据：
     - `dsh-agent/lib/types/index.d.ts:204` — `presence is neither liveness proof nor authorization`
     - `dsh-client-connection/lib/types/client/connection.d.ts:55` — `Re-read both mutable liveness guards…`
     - `dsh-client-runtime/lib/types/client/sessions/service.d.ts:370` — `The one aliveness predicate…`
     - `dsh-session/lib/types/types.d.ts:354` — `NOT a liveness signal about other…`
     - `dsh-session-telemetry-otel/lib/types/index.d.ts:38` — `keepAlive` 仅为 OTel SDK 传输选项
  3. 活运行时 Inspect `Service.listService`（host）→ **55 个 service 全表**，
     无 `host.heartbeat` / `health.heartbeat` / `core.pulse`，无任何 health/liveness/readiness 类 service。
  4. 活运行时 Inspect `Event.listEvents`（host）→ **53 个 event 全表**，同样无心跳/健康类事件
     （最接近的仅 `agent/status` 的 idle⇄running，语义是 agent 忙闲，非进程存活探针）。

  **回归条件**：待 dsh 暴露稳定心跳 service 后回归本项——届时在 `manifest.json` 的
  `optionalInject` 加该服务名，`health-probe.ts` 改用该接口，且**必须保留 mock fallback**
  （service 不可用时只 log 一行 warning 降级为 mock，**不得立即 DISABLE**）。

---

## v0.6.5 — 2026-08-26 — Sprint 11 收口

**首次发版**（codex-A 子任务 #1 交付物）。

### 新增（Added）

- **3 个 Service**（设计稿 §4.1）：
  - `agint.mount.request` — 受理挂载请求（proposal + verdict）→ 三段式事务编排 → MountResult
  - `agint.mount.status` — 查询 ticket 当前阶段 + 探针历史
  - `agint.mount.rollback` — 显式回滚（人类否决权入口）

- **三段式事务**（`src/orchestrator.ts`，设计稿 ADR-11-3）：
  - `PREPARE`：产物写入 `~/.dsh/profiles/web/plugins/<id>/`
  - `SMOKE`：调 `agint.qualitySandbox.runVerify / runExplore`；沙箱不可用 → decision 降级 `PENDING_REVIEW`（红线：不 AUTO_DEPLOY）
  - `ACTIVATE`：两段式 commit（spike 决策）

- **4 态状态机**（spike 决策后扩，区别于 Sprint 11 设计稿字面）：
  - 3 态路径（A：plugin 只用 dsh 已闭包内依赖）：`PREPARED → ACTIVATED → HEALTHY / DISABLED`
  - 4 态路径（B：plugin 声明新 npm 依赖）：`PREPARED → INSTALLED → RESTART_REQUESTED → ACTIVATED → HEALTHY / DISABLED`

- **两段式 commit**（`src/patch.ts`，spike 决策红线）：
  - 写 patch.yml 前先 atomic backup `.bak-<timestamp>`
  - HMR apply 成功后再删 `.bak-*`
  - HMR apply 失败 → agint-mount 自己从 backup 恢复 YAML + dispose 新 entry
  - 原因：`EntryGroup.update()` 只回滚 memory tree，不回滚磁盘 YAML

- **健康探针**（`src/health-probe.ts`，设计稿 ADR-11-3）：
  - 连续成功 ≥ 3 → `HEALTHY`
  - 连续失败 ≥ 2 → `DISABLE`（不删除 plugin；保留现场供归因）
  - 探针函数由 `agint.probeFn` Service 注入；默认 `probeStaging` stub

- **3 张数据表**（`src/storage.ts`，独占 `agint_mount` 域）：
  - `tickets` (≤200) — 事务票据 + 当前 phase + 探针统计
  - `probe_history` (≤2000) — 探针历史
  - `rollback_log` (≤200) — 回滚留痕（含 stage 倒序动作）

- **对外事件语义命名**（`mount.requested` / `mount.succeeded` / `mount.failed`，设计稿 ADR-11-1）：
  - Sprint 11 点对点发到 `agint.evolution.recordEvent`（软依赖失败不阻断）
  - Sprint 12 Event Bus 替换 transport（仅换传输层）

- **FROZEN `mount-result.schema.yaml`**（设计稿 §4.2）：
  - 7 值 phase enum（含 INSTALLED / RESTART_REQUESTED）
  - contractCheck 三布尔（signatureDiff / domainIsolation / dependencyWhitelist）
  - frozenness: L0 — Sprint 11 内禁改

- **L0 隔离 hook 留位**（`src/orchestrator.ts`）：
  - `l0IsolationCheck(proposal, verdict) → { signatureDiff, domainIsolation, dependencyWhitelist }`
  - 默认 noop + TODO 注释；真正实现由 codex-B 注入（ctx.getService('agint.l0IsolationCheck')）
  - 任一 L0 检查失败 → 拒挂载（设计稿 ADR-11-4）

- **`bin/agint-mount.sh` SOP 衔接**：本插件不挂顶层 `cordis.patch.yml`；首次发版仅仓库 commit，由老板走 `bin/agint-mount.sh new plugins/agint-mount` 挂载（AGENTS.md 红线）。

### 红线遵守

- ✅ 不触碰 `agint_meta` 存储域（manifest.storage.domains = `["agint_mount"]`）
- ✅ 不破坏既有 18 个插件（新建独立插件，不修改任何既有源码）
- ✅ Sprint 11 内不修改 `mount-result.schema.yaml` FROZEN 字段
- ✅ 不抢活：不写 L0 隔离规则实现、不写 fixture 测试变异、不写 e2e 场景

### 不在本 Sprint（本插件的代码骨架边界）

| 范围 | 责任方 | 备注 |
|---|---|---|
| L0 隔离规则组（`agint-quality-static` 加 l0-isolation） | codex-B | orchestrator 留 hook；本 Sprint 不实装 |
| fixture 测试变异（`fixture-echo-tool` / `fixture-bad-deps`） | codex-C | 放 `fixtures/mount/`，永不进真实锦标赛 |
| 8 个 e2e 场景（S11-01 ~ S11-08） | codex-D | `eval/scenarios/` |
| 真实 dsh HMR 探针（替代 `probeStaging` stub） | codex-D | Sprint 11 第 2 周接入 |
| `dsh.profilesDir` Service | 红线 | 不使用；从 `process.env.DSH_HOME` 拼路径 |
| 客户端 HMR | 独立机制 `dsh-client-hmr` | Sprint 11 范围外；留痕到 ROADMAP |

### 验证

- ✅ `bin/plugin-check.sh plugins/agint-mount` — 8 维度清单（lint 模式不阻断；contract/storage/deps/permissions/lifecycle/tests/docs/changelog 全齐）
- ✅ `node test/smoke.mjs` — 10 用例契约层验证（FROZEN phase 7 值 / MountResult required / contractCheck 三布尔 / storage spec / LIMITS / manifest 8 维度 / YAML schema / mock mountRequest 端到端 / rollback 倒序 / 红线自检）
- ✅ `grep -r agint_meta plugins/agint-mount/` — 0 命中（不触碰禁域）

### 偏离设计稿

| 偏离 | 偏离原因 | 老板拍板风险 |
|------|---------|-------------|
| **状态机 3 态 → 4 态**（增加 INSTALLED / RESTART_REQUESTED） | Sprint 11 第 1 周 dsh 热加载 spike 结论：plugin 声明新 npm 依赖时无法 pure-HMR，必须 `pnpm install` + sentinel restart | **已采纳 spike 决策**（boss 拍板） |
| **probe 函数抽象 + 默认 stub**（`probeStaging`） | 真实 dsh 探针路径需 dsh HMR 心跳暴露，Sprint 11 第 2 周由 codex-D 接入 | **0 风险**：hook 接口已声明，迁移只换 Service 注入 |
| **`mount.failed` 走点对点 evolution.recordEvent** 而非 Event Bus | Sprint 12 才有 Event Bus；当前最小实现 | **0 风险**：事件语义命名已对齐 Sprint 12 |
| **orchestrator 内 `sleep 1s` 替代 `waitSentinelLease` 真实等待** | Sprint 11 骨架阶段；真实等待需 dsh Sentinel API | **0 风险**：默认 `__AGINT_MOUNT_TEST_NO_LEASE_WAIT__=true` 跳过；生产 dsh 注入 |
| **L0 隔离 hook 默认全 true**（不阻断） | 真正实现由 codex-B 注入；Sprint 11 骨架阶段不阻塞 | **0 风险**：hook 接口已声明；TODO 注释明示 |

---

*下一步：老板 review 后由 `bin/agint-mount.sh new plugins/agint-mount` 走 lint → 拍快照 → patch → 重启 → smoke 挂载。*
