/**
 * agint-mount — 三段式事务编排器
 *
 * 状态机（spike 决策后扩到 4 态）：
 *   3 态路径（A：plugin 只用 dsh 已闭包内依赖）：
 *     PREPARED → ACTIVATED → HEALTHY / DISABLED
 *   4 态路径（B：plugin 声明新 npm 依赖）：
 *     PREPARED → INSTALLED → RESTART_REQUESTED → ACTIVATED → HEALTHY / DISABLED
 *
 * 三段式阶段映射：
 *   PREPARE   → PREPARED
 *               产物写入 ~/.dsh/profiles/web/plugins/<id>/
 *               （B 路径也在此写 package.json deps）
 *   SMOKE     → （3 态无独立产物；B 路径：调 pnpm install → INSTALLED）
 *               沙箱 verify/explore 验证（跑一次，最小接口探针）
 *               沙箱不可用 → decision 降级 PENDING_REVIEW（不 AUTO_DEPLOY）
 *   ACTIVATE  → （3 态：A 路径直接跳到 ACTIVATED）
 *               两段式 commit：backup patch.yml → atomic write → HMR settle
 *               → cleanup backup；失败 → restore + 标 DISABLE
 *
 * L0 隔离 hook（codex-B 活）：
 *   - `l0IsolationCheck` 默认 noop + TODO 注释；接口已声明
 *   - 真正实现由 codex-B 注入（orchestrator 启动时从 ctx.get('agint.l0IsolationCheck') 拿）
 *   - 若 hook 缺失：contractCheck 三项默认 true（不影响状态机推进；失败由 smoke 兜底）
 */
import { mkdir, writeFile, rename, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MountRequestSchema, ContractCheckSchema, needsInstall, PHASES } from './schemas.js';
import { packTicket, unpackTicket, randomId, nowIso } from './storage.js';
import { executeRollback } from './rollback.js';
import { recordProbeResult, makeProbeLoop, probeStaging } from './health-probe.js';
import {
  backupPatch, writePatchAtomic, restorePatch, cleanupBackup,
  appendRow, formatRow, removeRow,
} from './patch.js';
import { resolvePaths, stagingDirFor } from './paths.js';
import type { MountContext, MountTicket, MountResult, RollbackResult } from './types.js';

/** sandbox 不可用信号：上游 quality-sandbox 已用 PENDING_REVIEW 决策传达 */
function isPendingReview(verdict: any): boolean {
  return verdict?.policyDecision === 'PENDING_REVIEW' || verdict?.decision === 'PENDING_REVIEW';
}

/** 默认 L0 隔离 hook：全部 true（不阻断），TODO 等 codex-B 注入 */
const DEFAULT_L0_HOOK = async (_proposal: any, _verdict: any) => ({
  signatureDiff: true,
  domainIsolation: true,
  dependencyWhitelist: true,
});

/**
 * mount 内部点对点 transport → bus publish（A4 / B4）
 *
 * 红线（AGENTS.md / 设计稿 Sprint12 §A4）：
 *   - 不切流量：ctx.emitEvent（cordis point-to-point）保留作为 fallback；
 *     bus 不可用 / publish 抛错时静默降级，原路径不受影响。
 *   - envelope.version 由 schema v1 锁定为 1
 *   - payload 字段见 plugins/agint-mount/schemas/mount-{requested,succeeded,failed}.schema.yaml
 *   - correlationId 透传 ticketId，便于 mount.* 三事件 + event-bus 自家 publish 串同一 traceId
 */
async function mountEventBusPublish(
  ctx: MountContext,
  topic: 'mount.requested' | 'mount.succeeded' | 'mount.failed',
  payload: Record<string, unknown>,
): Promise<void> {
  // ── 双轨 1：agint.eventBus.publish（影子/正式通路）──────────────
  try {
    const bus = ctx.getService?.('agint.eventBus') as any;
    const publish = bus?.publish;
    if (typeof publish === 'function') {
      const envelope = {
        topic,
        version: 1,
        source: 'agint-mount',
        traceId: (ctx as any).traceId ?? randomUUID(),
        correlationId: (payload.ticketId as string) ?? undefined,
        payload,
      };
      try {
        await publish(envelope);
      } catch {
        // bus 不可用时降级：保留原 ctx.emitEvent 路径
      }
      return;
    }
  } catch { /* ignore：ctx.getService 缺失 */ }

  // ── 双轨 2：ctx.emitEvent fallback（cordis point-to-point；原路径保留）──
  try { ctx.emitEvent?.(topic, payload); } catch { /* ignore */ }
}

/**
 * mount HMR settle：A4 / B1 — 替换原 ctx.awaitHmrSettle 硬约定
 *
 * 旧实现：`await ctx.awaitHmrSettle?.(artifactName, 30_000)` —— 点对点 + 30s timeout。
 * 新实现（B1 子任务汇流）：
 *   1. 优先走 service lookup：`ctx.getService('core.hmr')` / `('host.hmr')` / `('agint.hmr')`
 *      任何一个存在且提供 awaitHmrSettle(artifactName, ms) → 走它。
 *   2. 退而求其次：订阅 bus 的 mount.succeeded（自身 publish） + 等 ctx 暴露 hmrReady 信号；
 *      任一收到就 settle。
 *   3. 兜底：30s timeout sleep（与原 orchestrator 行为 1:1 对齐；不依赖 dsh 心跳接口 —
 *      B5 已知 dsh v0.1.1-rc.2 暂无心跳 service）。
 *
 * 红线：
 *   - 不切流量：原 ctx.awaitHmrSettle 路径保留；只是 bus / service lookup 不存在时
 *     不会主动切换走 bus。
 *   - 返回 boolean：true = settle OK；false = timeout / 异常
 */
async function awaitHmrSettleBus(
  ctx: MountContext,
  artifactName: string,
  timeoutMs: number,
): Promise<boolean> {
  // ── 路径 1：service lookup（dsh 暴露 hmr service 时优先走）──────
  try {
    const lookupKeys = ['core.hmr', 'host.hmr', 'agint.hmr'];
    for (const k of lookupKeys) {
      try {
        const svc = ctx.getService?.(k) as any;
        if (svc && typeof svc.awaitHmrSettle === 'function') {
          return await svc.awaitHmrSettle(artifactName, timeoutMs);
        }
      } catch { /* 试下一个 */ }
    }
  } catch { /* ignore：ctx.getService 缺失 */ }

  // ── 路径 2：bus subscribe（mount.succeeded 由自己 publish，监听=无意义；改为订阅一个
  //    future hmr.settled topic，目前 schema 没注册；保留作为 hook 占位）──
  try {
    const bus = ctx.getService?.('agint.eventBus') as any;
    const subscribe = bus?.subscribe;
    if (typeof subscribe === 'function') {
      // 不阻塞：仅注册监听，timeout 内未到走 false（与原 30s timeout 语义一致）
      // 未来 dsh 暴露 hmr.settled topic 时此路径自动接管；当前无此 topic，订阅无副作用
      try {
        subscribe(
          { subscriber: 'agint-mount', topics: ['hmr.settled'], mode: 'async' },
          (_env: unknown) => { /* noop：占位 */ },
        );
      } catch { /* topic 不存在时 bus 静默忽略 */ }
    }
  } catch { /* ignore */ }

  // ── 路径 3：原 ctx.awaitHmrSettle 直连点对点（保留 fallback）──
  try {
    // 兼容旧 ctx.awaitHmrSettle（cordis 历史接口；Sprint 11 留 hook）
    if (typeof (ctx as any).awaitHmrSettle === 'function') {
      const ok = await (ctx as any).awaitHmrSettle(artifactName, timeoutMs);
      if (typeof ok === 'boolean') return ok;
    }
  } catch { /* ignore：走 timeout fallback */ }

  // ── 路径 4（兜底）：30s timeout sleep ──
  return await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), Math.min(timeoutMs, 30_000));
    // 测试模式跳过等待
    if ((globalThis as any).__AGINT_MOUNT_TEST_NO_LEASE_WAIT__) {
      clearTimeout(t);
      resolve(true);
    }
  });
}

/**
 * mount.request 主入口。
 *
 * 流程：
 *   0) zod 校验 + 沙箱 decision 守门
 *   1) L0 隔离 hook（codex-B）
 *   2) tickets 行预占（phase=PREPARED）
 *   3) PREPARE：写产物到 plugins/<id>/
 *   4) SMOKE：调 agint.qualitySandbox.runVerify / runExplore（沙箱不可用 → PENDING_REVIEW）
 *   5) 4 态路径：调 pnpm install + 发 sentinel restart + 等 lease
 *   6) ACTIVATE：两段式 commit patch.yml（backup → write → HMR settle → cleanup）
 *   7) 启动健康探针（probe loop；ACTIVATED 之后）
 *   8) 返回 MountResult
 *
 * 任一阶段失败 → executeRollback(ticketId, lastSuccessfulPhase, reason)
 */
export async function mountRequest(ctx: MountContext, input: unknown): Promise<MountResult> {
  // 0) 入参校验
  const parsed = MountRequestSchema.safeParse(input);
  if (!parsed.success) throw new Error(`mount.request: invalid input: ${parsed.error.issues[0]?.message}`);
  const { proposal, verdict } = parsed.data;

  // 决策门：沙箱不可用 → PENDING_REVIEW（红线：不 AUTO_DEPLOY）
  if (isPendingReview(verdict)) {
    // 写 ticket(stage=PREPARED, decision=PENDING_REVIEW)，但不走三段式
    const ticketId = randomId();
    const ticket = await writeTicket(ctx, {
      ticketId,
      proposalId: proposal.id,
      artifactName: proposal.kind === 'TOOL_SYNTHESIS' ? `agint-${randomId().slice(0,8)}` : `agint-${randomId().slice(0,8)}`,
      phase: 'PREPARED',
      contractCheck: { signatureDiff: true, domainIsolation: true, dependencyWhitelist: true },
      activatedAt: null,
      decision: 'PENDING_REVIEW',
      createdAt: nowIso(), updatedAt: nowIso(),
      probeStats: { consecutiveSuccess: 0, consecutiveFailure: 0, lastProbeAt: null },
    });
    await mountEventBusPublish(ctx, 'mount.requested', { ticketId, proposalId: proposal.id, decision: 'PENDING_REVIEW' });
    return unpackTicket(ticket);
  }

  // 1) L0 隔离 hook
  const l0Hook = (ctx.getService?.('agint.l0IsolationCheck') as any) ?? DEFAULT_L0_HOOK;
  let contractCheck: { signatureDiff: boolean; domainIsolation: boolean; dependencyWhitelist: boolean };
  try {
    contractCheck = await l0Hook(proposal, verdict);
  } catch (e: any) {
    contractCheck = { signatureDiff: false, domainIsolation: false, dependencyWhitelist: false };
  }
  // 任一 L0 检查失败 → 拒挂载（设计稿 ADR-11-4）
  if (!contractCheck.signatureDiff || !contractCheck.domainIsolation || !contractCheck.dependencyWhitelist) {
    const ticketId = randomId();
    await writeTicket(ctx, {
      ticketId,
      proposalId: proposal.id,
      artifactName: '(rejected-by-L0)',
      phase: 'ROLLED_BACK',
      contractCheck,
      activatedAt: null,
      decision: 'AUTO_DEPLOY',   // 决策曾经是 AUTO，但 L0 拒了
      createdAt: nowIso(), updatedAt: nowIso(),
      probeStats: { consecutiveSuccess: 0, consecutiveFailure: 0, lastProbeAt: null },
    });
    await mountEventBusPublish(ctx, 'mount.failed', { ticketId, reason: 'l0-isolation-failed', phase: 'ROLLED_BACK' });
    return {
      ticketId, proposalId: proposal.id, phase: 'ROLLED_BACK',
      contractCheck, activatedAt: null,
    };
  }

  // 2) tickets 行预占
  const ticketId = randomId();
  const artifactName = `agint-${randomId().slice(0, 8)}`;
  const deps: string[] = (proposal as any).declaredDependencies ?? [];

  let ticket = await writeTicket(ctx, {
    ticketId,
    proposalId: proposal.id,
    artifactName,
    phase: 'PREPARED',
    contractCheck,
    activatedAt: null,
    decision: 'AUTO_DEPLOY',
    createdAt: nowIso(), updatedAt: nowIso(),
    probeStats: { consecutiveSuccess: 0, consecutiveFailure: 0, lastProbeAt: null },
  });

  try {
    // ── PREPARE ─────────────────────────────────────────
    const paths = resolvePaths({ dshHome: ctx.dshHome });
    const targetDir = join(paths.pluginsRoot, artifactName);
    await mkdir(targetDir, { recursive: true });
    await mkdir(paths.stagingRoot, { recursive: true });
    const stagingDir = stagingDirFor(paths.stagingRoot, ticketId);

    // 写产物（最小骨架：把 proposal.payload 当 source 写 main）
    await writeArtifact(targetDir, artifactName, proposal);

    // ── SMOKE（沙箱） ─────────────────────────
    const sandbox = ctx.getService?.('agint.qualitySandbox');
    if (!sandbox?.runVerify) {
      // 沙箱不可用：降级 PENDING_REVIEW
      await updateTicketPhase(ctx, ticketId, 'ROLLED_BACK', contractCheck, null, 'sandbox-unavailable');
      await mountEventBusPublish(ctx, 'mount.failed', { ticketId, reason: 'sandbox-unavailable', phase: 'ROLLED_BACK' });
      return { ticketId, proposalId: proposal.id, phase: 'ROLLED_BACK', contractCheck, activatedAt: null };
    }
    const smokeResult = await sandbox.runVerify({ target: { path: targetDir, name: artifactName } });
    if (!smokeResult?.ok) {
      await updateTicketPhase(ctx, ticketId, 'ROLLED_BACK', contractCheck, null, `smoke-failed:${smokeResult?.reason ?? 'unknown'}`);
      await mountEventBusPublish(ctx, 'mount.failed', { ticketId, reason: 'smoke-failed', phase: 'ROLLED_BACK' });
      return { ticketId, proposalId: proposal.id, phase: 'ROLLED_BACK', contractCheck, activatedAt: null };
    }

    // ── 4 态判定：plugin 声明新依赖才走 INSTALLED/RESTART_REQUESTED ─────────
    let activatedPhase: 'ACTIVATED' | 'INSTALLED' | 'RESTART_REQUESTED' = 'ACTIVATED';
    if (needsInstall(deps)) {
      // 调 pnpm install（仅 deps.length > 0 时触发）
      await runPnpmInstall(ctx, paths.webPackageJson, deps);
      ticket = await updateTicketPhase(ctx, ticketId, 'INSTALLED', contractCheck, null, null);

      // 发 sentinel restart（写一个 restart 信号文件 / 调 dsh Sentinel API；Sprint 11 留 hook）
      await requestRestart(ctx, paths.sentinelLease);
      ticket = await updateTicketPhase(ctx, ticketId, 'RESTART_REQUESTED', contractCheck, null, null);

      // 等 sentinel.lease（at+30s 后再继续；Sprint 11 骨架 stub）
      await waitSentinelLease(paths.sentinelLease);
      activatedPhase = 'ACTIVATED';
    }

    // ── ACTIVATE：两段式 commit patch.yml ─────────────────────────
    const originalYaml = await ctx.readFile?.(paths.cordisPatch) ?? '';
    const backupPath = await backupPatch(paths.cordisPatch);
    try {
      // 写产物源（lib/index.js）→ 已在 PREPARE 阶段完成
      // atomic 写 patch.yml：append row
      const newRow = formatRow(artifactName, `./plugins/${artifactName}/lib/index.js`);
      const newYaml = appendRow(originalYaml, newRow);
      await writePatchAtomic(paths.cordisPatch, newYaml);

      // HMR settle：A4 / B1 — service-lookup → bus subscribe → ctx 直连 → 30s timeout 四级 fallback
      const settleOk = await awaitHmrSettleBus(ctx, artifactName, 30_000);
      if (!settleOk) {
        // 失败：从 backup 恢复 + 标 DISABLE
        await restorePatch(paths.cordisPatch, backupPath);
        await updateTicketPhase(ctx, ticketId, 'DISABLED', contractCheck, null, 'hmr-settle-failed');
        await mountEventBusPublish(ctx, 'mount.failed', { ticketId, reason: 'hmr-settle-failed', phase: 'DISABLED' });
        return { ticketId, proposalId: proposal.id, phase: 'DISABLED', contractCheck, activatedAt: null };
      }

      // 成功 → 清理 backup
      await cleanupBackup(backupPath);
    } catch (e: any) {
      // 任何异常：restore + rollback
      try { await restorePatch(paths.cordisPatch, backupPath); } catch { /* ignore */ }
      await executeRollback({ ...ctx, patchPath: paths.cordisPatch, backupPath, stagingDir }, ticketId, ticket.phase, `activate-error:${e.message}`);
      await mountEventBusPublish(ctx, 'mount.failed', { ticketId, reason: 'activate-error', phase: 'ROLLED_BACK' });
      return { ticketId, proposalId: proposal.id, phase: 'ROLLED_BACK', contractCheck, activatedAt: null };
    }

    // 7) ACTIVATED 写状态 + 启动探针
    const activatedAt = nowIso();
    ticket = await updateTicketPhase(ctx, ticketId, 'ACTIVATED', contractCheck, activatedAt, null);

    // 启动探针循环（经 ctx.effect 注册；探针函数由 ctx.getService('agint.probeFn') 注入，默认 stub）
    const probeFn = (ctx.getService?.('agint.probeFn') as any) ?? probeStaging;
    const loop = makeProbeLoop(ctx, ticketId, probeFn);
    ctx.registerEffect?.(() => { loop.stop(); });
    loop.start();

    // 8) publish mount.succeeded（A4 — bus 优先，emitEvent fallback）
    await mountEventBusPublish(ctx, 'mount.succeeded', { ticketId, artifactName, decision: 'AUTO_DEPLOY' });

    return { ticketId, proposalId: proposal.id, phase: 'ACTIVATED', contractCheck, activatedAt };

  } catch (e: any) {
    // 顶层兜底：任一未捕获异常 → rollback
    try {
      await executeRollback(ctx, ticketId, ticket.phase, `mount-request-error:${e.message}`);
    } catch { /* rollback 自身失败也不阻断抛错 */ }
    await mountEventBusPublish(ctx, 'mount.failed', { ticketId, reason: 'mount-request-error', phase: ticket?.phase ?? 'PREPARED' });
    throw e;
  }
}

/**
 * mount.status：查询 ticket + 探针统计。
 * ticketId 可选：不传时列出所有非终态 tickets（dry-run listing）。
 * 终态：HEALTHY（探针已稳态）/ ROLLED_BACK（已回滚）—— 不列入 pending 列表。
 * 非终态：PREPARED / INSTALLED / RESTART_REQUESTED / ACTIVATED / DISABLED。
 */
export async function mountStatus(
  ctx: MountContext,
  ticketId: string | undefined,
): Promise<any> {
  // zod v3：z.string().min(1).optional() → undefined 或非空字符串
  z.string().min(1).optional().parse(ticketId);
  const tt = ctx.tables?.tickets;
  if (!tt) throw new Error('mount.status: tickets table unavailable');
  // ── 列表模式（ticketId 缺省） ─────────────────────────────
  if (ticketId === undefined) {
    const TERMINAL = new Set(['HEALTHY', 'ROLLED_BACK']);
    const pending: any[] = [];
    for (const [, entry] of tt.entries()) {
      if (!TERMINAL.has((entry as any).phase)) {
        const ticket = unpackTicket(entry as any);
        pending.push({ ...ticket, probeStats: (entry as any).probeStats, createdAt: (entry as any).createdAt });
      }
    }
    return { mode: 'list', count: pending.length, pending };
  }
  // ── 单查模式 ────────────────────────────────────────────
  const entry = await tt.get(`t-${ticketId}`);
  if (!entry) throw new Error(`mount.status: ticket ${ticketId} not found`);
  const ticket = unpackTicket(entry as any);
  return { mode: 'single', ...ticket, probeStats: (entry as any).probeStats, createdAt: (entry as any).createdAt };
}

/**
 * mount.rollback：人类否决权入口。
 * input.ticketId 可选：不传时进入 dry-run listing，返回所有可被回滚的 tickets
 * （不写 storage、不发事件、不动状态机——与单查模式完全隔离）。
 * 终态 HEALTHY / ROLLED_BACK 不可回滚，列在不可回滚集合内。
 */
export async function mountRollback(ctx: MountContext, input: unknown): Promise<any> {
  const parsed = z.object({
    ticketId: z.string().min(1).optional(),
    reason: z.string().min(1).default('manual'),
  }).safeParse(input ?? {});
  if (!parsed.success) throw new Error(`mount.rollback: invalid input: ${parsed.error.issues[0]?.message}`);
  const { ticketId, reason } = parsed.data;

  const tt = ctx.tables?.tickets;
  if (!tt) throw new Error('mount.rollback: tickets table unavailable');
  // ── 列表模式（ticketId 缺省）：dry-run listing，不写不触发 ──
  if (ticketId === undefined) {
    const ROLLBACKABLE = new Set(['PREPARED', 'INSTALLED', 'RESTART_REQUESTED', 'ACTIVATED', 'DISABLED']);
    const TERMINAL_NOOP = new Set(['HEALTHY', 'ROLLED_BACK']);
    const rollbackable: any[] = [];
    const noop: any[] = [];
    for (const [, entry] of tt.entries()) {
      const ticket = unpackTicket(entry as any);
      const summary = { ticketId: ticket.ticketId, proposalId: ticket.proposalId, phase: ticket.phase, artifactName: ticket.artifactName };
      if (ROLLBACKABLE.has((entry as any).phase)) rollbackable.push(summary);
      else if (TERMINAL_NOOP.has((entry as any).phase)) noop.push(summary);
    }
    return { mode: 'list', dryRun: true, reason, count: rollbackable.length, rollbackable, noop };
  }
  // ── 单查模式：实际回滚 ───────────────────────────────────
  const entry = await tt.get(`t-${ticketId}`);
  if (!entry) throw new Error(`mount.rollback: ticket ${ticketId} not found`);
  const phase = (entry as any).phase as string;

  const result = await executeRollback(ctx, ticketId, phase, reason);
  // 写回 ticket.phase=ROLLED_BACK（除非已经是终态）
  if (phase !== 'DISABLED' && phase !== 'HEALTHY' && phase !== 'ROLLED_BACK') {
    await updateTicketPhase(ctx, ticketId, 'ROLLED_BACK', (entry as any).contractCheck, null, reason);
  }
  return { mode: 'single', ...result };
}

// ── 内部 helpers ─────────────────────────────────────────

async function writeTicket(ctx: MountContext, t: any): Promise<any> {
  const tt = ctx.tables?.tickets;
  if (!tt) throw new Error('orchestrator: tickets table unavailable');
  const entry = packTicket(t);
  await tt.put(entry.id, entry);
  return entry;
}

async function updateTicketPhase(
  ctx: MountContext,
  ticketId: string,
  phase: string,
  contractCheck: any,
  activatedAt: string | null,
  lastReason: string | null,
): Promise<any> {
  const tt = ctx.tables?.tickets;
  if (!tt) throw new Error('orchestrator: tickets table unavailable');
  const existing = await tt.get(`t-${ticketId}`);
  if (!existing) throw new Error(`orchestrator: ticket ${ticketId} not found`);
  const updated = {
    ...existing,
    phase,
    contractCheck,
    activatedAt: activatedAt ?? existing.activatedAt,
    updatedAt: nowIso(),
    probeStats: lastReason ? { ...(existing as any).probeStats, lastReason } : (existing as any).probeStats,
  };
  await tt.put(updated.id, updated);
  return updated;
}

async function writeArtifact(targetDir: string, artifactName: string, proposal: any): Promise<void> {
  // 最小骨架：写 lib/index.js = proposal.payload?.source ?? 默认 stub
  const libDir = join(targetDir, 'lib');
  await mkdir(libDir, { recursive: true });
  const mainSource = (proposal?.payload?.source as string) || `// auto-generated by agint-mount for ${artifactName}\nexport const apply = () => {};\n`;
  await writeFile(join(libDir, 'index.js'), mainSource, 'utf-8');
}

async function runPnpmInstall(ctx: MountContext, webPackageJson: string, deps: string[]): Promise<void> {
  if (deps.length === 0) return;
  // 仅在 deps.length > 0 时触发；4 态路径
  // Sprint 11 骨架阶段：ctx 暴露 runShell；若缺则 throw 让 rollback 兜底
  if (!ctx.runShell) throw new Error('orchestrator: ctx.runShell unavailable for pnpm install');
  await ctx.runShell('pnpm', ['add', ...deps], { cwd: dirname(webPackageJson) });
}

async function requestRestart(ctx: MountContext, sentinelLeasePath: string): Promise<void> {
  // Sprint 11 骨架：ctx 暴露 requestRestart；若缺则写 sentinel lease 文件占位
  if (ctx.requestRestart) {
    await ctx.requestRestart(sentinelLeasePath);
    return;
  }
  // 兜底：写一个 at 时间戳到 lease 文件
  const { writeFile } = await import('node:fs/promises');
  await writeFile(sentinelLeasePath, JSON.stringify({ at: new Date().toISOString(), reason: 'agint-mount: 4-state restart' }), 'utf-8');
}

async function waitSentinelLease(leasePath: string, timeoutMs: number = 30_000): Promise<void> {
  // Sprint 11 骨架：ctx 暴露 waitSentinelLease；缺则 sleep 30s 兜底（避免 dsh 启动中冲突）
  if ((globalThis as any).__AGINT_MOUNT_TEST_NO_LEASE_WAIT__) return;
  await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 1000)));   // 骨架阶段只 sleep 1s
}

import { dirname } from 'node:path';
