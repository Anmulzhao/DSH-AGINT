/**
 * agint-mount — 回滚执行器
 *
 * 设计：
 *   - 三段式（PREPARE / SMOKE / ACTIVATE）按 fromPhase 倒序执行清理动作
 *   - 4 态路径下 fromPhase 可能是 INSTALLED / RESTART_REQUESTED，也按等价语义清理
 *   - 写 rollback_log 表 + 调 agint.evolution.addFailure 留痕
 *   - emit `mount.failed` 事件（点对点先到 agint.evolution；Sprint 12 Event Bus 替换 transport）
 *
 * 不删除磁盘文件（除 staging）；ACTIVATED 之后只走 DISABLE 标记，不删 plugin。
 * 设计稿 ADR-11-3 红线：「自动 DISABLE（不删除），保留现场供归因」。
 */
import { rm } from 'node:fs/promises';
import { PhaseSchema, isTerminalPhase } from './schemas.js';
import { packRollback, nowIso } from './storage.js';
import { restorePatch } from './patch.js';
/**
 * 按 fromPhase 倒序执行回滚。
 *
 * 清理动作矩阵（仅作 host-side 编排，不直接改文件状态机）：
 *   PREPARED              → rm staging + 删 tickets 行
 *   SMOKE (TODO 4 态扩)   → rm staging + 删 profile 隔离 + 删 tickets 行
 *   INSTALLED (B 路径)    → 标 plugin disabled + rm staging + 删 tickets 行
 *   RESTART_REQUESTED     → 等 sentinel lease 到 at+30s 后再清理（防止 dsh 启动中）+ rm staging
 *   ACTIVATED             → 标 plugin disabled + restorePatch + DISABLE 标记（永不删 plugin）
 *   HEALTHY / DISABLED    → 仅 DISABLE（已生效，幂等回滚）
 *   ROLLED_BACK           → noop（终态已回滚）
 *
 * 不抛错：任何清理动作失败都记录到 rollback_log.actions，**绝不向上抛**（设计稿 §真实 > 讨好）。
 */
export async function executeRollback(ctx, ticketId, fromPhase, reason) {
    // 1) 守卫
    PhaseSchema.parse(fromPhase);
    if (isTerminalPhase(fromPhase) && fromPhase !== 'DISABLED') {
        // HEALTHY / ROLLED_BACK 不再回滚
        return { ticketId, fromPhase, actions: [], reason, executedAt: nowIso(), note: 'noop-already-terminal' };
    }
    const actions = [];
    // 2) 倒序清理（按 phase 序号，从后向前清）
    // 顺序表：
    //   ACTIVATED → INSTALLED → RESTART_REQUESTED → SMOKE → PREPARED → (终)
    // 任何 fromPhase 都清理它以及所有更早的阶段（已经做的全废掉）
    const order = ['PREPARED', 'INSTALLED', 'RESTART_REQUESTED', 'ACTIVATED'];
    const fromIdx = order.indexOf(fromPhase);
    const stagesToUndo = fromIdx >= 0 ? order.slice(0, fromIdx + 1) : [];
    for (const stage of stagesToUndo) {
        switch (stage) {
            case 'ACTIVATED': {
                // 已挂载：标 DISABLED + restore patch + 保留 plugin
                if (ctx.patchPath && ctx.backupPath) {
                    try {
                        await restorePatch(ctx.patchPath, ctx.backupPath);
                        actions.push(`restore-patch:${ctx.backupPath}`);
                    }
                    catch (e) {
                        actions.push(`restore-patch-FAILED:${e.message}`);
                    }
                }
                actions.push('mark-DISABLED');
                break;
            }
            case 'RESTART_REQUESTED': {
                // 已发 sentinel restart：等到 sentinel.lease at+30s 后再清（防止 dsh 启动中）
                actions.push(`await-sentinel-lease:${ctx.sentinelLease ?? '(none)'}`);
                actions.push('cleanup-staging');
                break;
            }
            case 'INSTALLED': {
                // pnpm install 已完成但未 ACTIVATE：标 plugin disabled + 删 staging
                actions.push('mark-plugin-disabled');
                actions.push('cleanup-staging');
                break;
            }
            case 'PREPARED': {
                // 仅写 staging：直接删
                if (ctx.stagingDir) {
                    try {
                        await rm(ctx.stagingDir, { recursive: true, force: true });
                        actions.push(`rm-staging:${ctx.stagingDir}`);
                    }
                    catch (e) {
                        actions.push(`rm-staging-FAILED:${e.message}`);
                    }
                }
                break;
            }
        }
    }
    // 3) 写 rollback_log
    const rbEntry = packRollback({
        ticketId,
        fromPhase,
        actions,
        reason,
        executedAt: nowIso(),
    });
    let logWritten = false;
    try {
        if (ctx.tables?.rollback_log) {
            await ctx.tables.rollback_log.put(rbEntry.id, rbEntry);
            logWritten = true;
        }
    }
    catch { /* tables 未就绪不阻断；留 evolution 兜底 */ }
    // 4) evolution-memory 留痕（软依赖失败不阻断）
    let evolutionWritten = false;
    try {
        const evo = ctx.getService?.('agint.evolution');
        if (evo?.addFailure) {
            await evo.addFailure({
                pattern: `mount-rollback:${ticketId}`,
                category: 'mount',
                severity: 'high',
                evidence: JSON.stringify({ fromPhase, actions, reason }).slice(0, 200),
                tags: ['mount-rollback'],
            });
            evolutionWritten = true;
        }
    }
    catch { /* 软依赖失败忽略 */ }
    // 5) emit 事件（点对点先到 evolution；Sprint 12 Event Bus 替换 transport）
    try {
        ctx.emitEvent?.('mount.failed', { ticketId, fromPhase, reason, actions });
    }
    catch { /* event 通道失败不阻断 */ }
    return {
        ticketId,
        fromPhase,
        actions,
        reason,
        executedAt: nowIso(),
        logWritten,
        evolutionWritten,
    };
}
