/**
 * agint-mount v0.6.5 — Cordis 入口
 *
 * 对外 3 Service（设计稿 §4.1）：
 *   agint.mount.request    (proposal, verdict) → MountResult
 *   agint.mount.status     (ticketId) → MountResult + probeStats
 *   agint.mount.rollback   (ticketId, reason) → RollbackResult
 *
 * 监听：
 *   tools/post-execute      预留事件订阅（不消费；仅占位，便于 Sprint 12 迁移）
 *
 * 资源管理（AGENTS.md 红线）：
 *   - 探针循环 / setInterval 全部经 ctx.effect 注册 disposer
 *   - storageDomain handle 在 plugin dispose 时 close
 *   - 监听器 dispose 由 ctx.on 自动管理
 */
import { mountRequest, mountStatus, mountRollback } from './orchestrator.js';
import { spec, LIMITS } from './storage.js';
import { resolvePaths } from './paths.js';
import type { MountContext } from './types.js';

const name = 'agint-mount';
const inject = ['storageDomain', 'agint.qualitySandbox'];

/**
 * Cordis apply(ctx)。
 * ctx.storageDomain.open(spec) → 拿 3 张表的 handle（in-memory stub：ctx.tables 注入；真实 dsh 由 storageDomain 提供）。
 */
function apply(ctx: any, config: any = {}) {
  let disposed = false;
  const disposers: Array<() => void> = [];

  // ── lifecycle hook：plugin dispose 时清理全部资源 ──
  ctx.effect(() => () => {
    disposed = true;
    for (const d of disposers) {
      try { d(); } catch { /* 单个 dispose 失败不影响其它 */ }
    }
  });

  // ── 解析路径（dshHome 来自 ctx 或 process.env） ──
  let paths;
  try {
    paths = resolvePaths({
      dshHome: (ctx.get && ctx.get('dshHome')) || process.env.DSH_HOME,
      profilesDir: (ctx.get && ctx.get('profilesDir')),
      agintHome: process.env.AGINT_HOME,
    });
  } catch (e: any) {
    // DSH_HOME 未设 → 退化为测试模式（paths 留空，orchestrator 不依赖路径也能跑契约校验）
    paths = null;
  }

  // ── 构造 MountContext 适配层 ──
  const mountCtx: MountContext = {
    dshHome: paths?.dshHome,
    getService: (n: string) => (typeof ctx.get === 'function' ? ctx.get(n) : null),
    tables: undefined, // 由 storageDomain.open 后注入
    emitEvent: (channel, payload) => {
      // 点对点先到 agint.evolution.recordEvent（软依赖失败不阻断）
      try {
        const evo = (typeof ctx.get === 'function' ? ctx.get('agint.evolution') : null);
        if (evo?.recordEvent) return evo.recordEvent({ channel, payload });
      } catch { /* ignore */ }
      // 兜底：ctx.on 触发本地订阅（极简）
      try { return ctx.on?.(channel, () => payload); } catch { /* ignore */ }
      return undefined;
    },
    registerEffect: (d: () => void) => {
      disposers.push(d);
      ctx.effect(() => d);
    },
    readFile: async (p: string) => {
      const fs = await import('node:fs/promises');
      return fs.readFile(p, 'utf-8');
    },
    // runShell / requestRestart / awaitHmrSettle 由生产 dsh host 注入；
    // 骨架阶段留空，orchestrator 会因软依赖缺失走 fallback（如 sleep 1s）
  };

  // ── 打开 storage domain ──
  const ready = ctx.storageDomain.open(spec).then(
    (d: any) => {
      if (disposed) { try { void d.close(); } catch { /* ignore */ } return null; }
      mountCtx.tables = {
        tickets: d.table('tickets'),
        probe_history: d.table('probe_history'),
        rollback_log: d.table('rollback_log'),
      };
      return d;
    },
    (error: any) => {
      // 软降级：tables 未就绪 → mount.status / rollback 抛错；mount.request 不阻塞
      console.warn(`[agint-mount] storageDomain.open 失败：${error?.message ?? error}`);
      return null;
    },
  );
  disposers.push(() => { void ready.then((d: any) => d?.close?.()).catch(() => {}); });

  // ── 注册 3 Service ──
  ctx.provide('agint.mount.request', async (input: unknown) => mountRequest(mountCtx, input));
  ctx.provide('agint.mount.status', async (ticketId: string) => mountStatus(mountCtx, ticketId));
  ctx.provide('agint.mount.rollback', async (input: unknown) => mountRollback(mountCtx, input));

  // 注意：不要在此注册 tools/post-execute 空监听。该事件是 waterfall：
  // 监听器必须调用 next() 并返回其结果，否则瀑布结果为 undefined，
  // dsh-tools 读取 decision.kind 时抛 "Cannot read properties of undefined
  // (reading 'kind')"，导致所有 preset 的全部工具调用失败。
  // mount 不消费工具结果，因此不监听该事件。
}

const Config = {};

export { Config, apply, inject, name, LIMITS };
