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
    try { ctx.emitEvent?.('mount.requested', { ticketId, proposalId: proposal.id, decision: 'PENDING_REVIEW' }); }
    catch { /* 忽略 */ }
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
    try { ctx.emitEvent?.('mount.failed', { ticketId, reason: 'l0-isolation-failed' }); }
    catch { /* ignore */ }
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
      try { ctx.emitEvent?.('mount.failed', { ticketId, reason: 'sandbox-unavailable' }); }
      catch { /* ignore */ }
      return { ticketId, proposalId: proposal.id, phase: 'ROLLED_BACK', contractCheck, activatedAt: null };
    }
    const smokeResult = await sandbox.runVerify({ target: { path: targetDir, name: artifactName } });
    if (!smokeResult?.ok) {
      await updateTicketPhase(ctx, ticketId, 'ROLLED_BACK', contractCheck, null, `smoke-failed:${smokeResult?.reason ?? 'unknown'}`);
      try { ctx.emitEvent?.('mount.failed', { ticketId, reason: 'smoke-failed' }); }
      catch { /* ignore */ }
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

      // HMR settle：等 dsh 加载（ctx 暴露 awaitHmrSettle；Sprint 11 留 hook）
      const settleOk = await ctx.awaitHmrSettle?.(artifactName, 30_000);
      if (!settleOk) {
        // 失败：从 backup 恢复 + 标 DISABLE
        await restorePatch(paths.cordisPatch, backupPath);
        await updateTicketPhase(ctx, ticketId, 'DISABLED', contractCheck, null, 'hmr-settle-failed');
        try { ctx.emitEvent?.('mount.failed', { ticketId, reason: 'hmr-settle-failed' }); }
        catch { /* ignore */ }
        return { ticketId, proposalId: proposal.id, phase: 'DISABLED', contractCheck, activatedAt: null };
      }

      // 成功 → 清理 backup
      await cleanupBackup(backupPath);
    } catch (e: any) {
      // 任何异常：restore + rollback
      try { await restorePatch(paths.cordisPatch, backupPath); } catch { /* ignore */ }
      await executeRollback({ ...ctx, patchPath: paths.cordisPatch, backupPath, stagingDir }, ticketId, ticket.phase, `activate-error:${e.message}`);
      try { ctx.emitEvent?.('mount.failed', { ticketId, reason: 'activate-error' }); }
      catch { /* ignore */ }
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

    // 8) emit mount.succeeded
    try { ctx.emitEvent?.('mount.succeeded', { ticketId, artifactName, decision: 'AUTO_DEPLOY' }); }
    catch { /* ignore */ }

    return { ticketId, proposalId: proposal.id, phase: 'ACTIVATED', contractCheck, activatedAt };

  } catch (e: any) {
    // 顶层兜底：任一未捕获异常 → rollback
    try {
      await executeRollback(ctx, ticketId, ticket.phase, `mount-request-error:${e.message}`);
    } catch { /* rollback 自身失败也不阻断抛错 */ }
    try { ctx.emitEvent?.('mount.failed', { ticketId, reason: 'mount-request-error' }); }
    catch { /* ignore */ }
    throw e;
  }
}

/** mount.status：查询 ticket + 探针统计 */
export async function mountStatus(ctx: MountContext, ticketId: string): Promise<MountResult & { probeStats: any; createdAt: string }> {
  z.string().min(1).parse(ticketId);
  const tt = ctx.tables?.tickets;
  if (!tt) throw new Error('mount.status: tickets table unavailable');
  const entry = await tt.get(`t-${ticketId}`);
  if (!entry) throw new Error(`mount.status: ticket ${ticketId} not found`);
  const ticket = unpackTicket(entry);
  return { ...ticket, probeStats: (entry as any).probeStats, createdAt: (entry as any).createdAt };
}

/** mount.rollback：人类否决权入口 */
export async function mountRollback(ctx: MountContext, input: unknown): Promise<RollbackResult> {
  const parsed = z.object({ ticketId: z.string().min(1), reason: z.string().min(1).default('manual') }).safeParse(input);
  if (!parsed.success) throw new Error(`mount.rollback: invalid input: ${parsed.error.issues[0]?.message}`);
  const { ticketId, reason } = parsed.data;

  const tt = ctx.tables?.tickets;
  if (!tt) throw new Error('mount.rollback: tickets table unavailable');
  const entry = await tt.get(`t-${ticketId}`);
  if (!entry) throw new Error(`mount.rollback: ticket ${ticketId} not found`);
  const phase = (entry as any).phase as string;

  const result = await executeRollback(ctx, ticketId, phase, reason);
  // 写回 ticket.phase=ROLLED_BACK（除非已经是终态）
  if (phase !== 'DISABLED' && phase !== 'HEALTHY' && phase !== 'ROLLED_BACK') {
    await updateTicketPhase(ctx, ticketId, 'ROLLED_BACK', (entry as any).contractCheck, null, reason);
  }
  return result;
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
