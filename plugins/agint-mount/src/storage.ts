/**
 * agint-mount — 存储域（agint_mount）声明 + 3 表 entry schema
 *
 * 红线：
 *   - 独占 `agint_mount` 域；不触碰 agint_meta / 其它兄弟插件域
 *   - schemaVersion=1；改字段走 L0 治理（人类多签 + major 版本）
 *
 * 3 张表：
 *   - tickets       (≤200)  事务票据 + 当前 phase
 *   - probe_history (≤2000) 健康探针历史
 *   - rollback_log  (≤200)  回滚留痕（含 stage 倒序动作）
 *
 * LIMITS（设计稿 §4.1 / AGINT 通用上限规范）：
 *   tickets=200 / probe_history=2000 / rollback_log=200
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { PhaseSchema, ContractCheckSchema } from './schemas.js';

// 复用 FROZEN phase + contractCheck 作为 tickets 表的 FROZEN 业务字段
const TicketSchema = z.object({
  ticketId: z.string().min(1),
  proposalId: z.string().min(1),
  artifactName: z.string().min(1),
  phase: PhaseSchema,
  contractCheck: ContractCheckSchema,
  activatedAt: z.string().nullable(),
  decision: z.enum(['AUTO_DEPLOY', 'PENDING_REVIEW']),
  createdAt: z.string(),
  updatedAt: z.string(),
  // 探针统计（host-side 快速读取，避免每次查 probe_history 聚合）
  probeStats: z.object({
    consecutiveSuccess: z.number().int().nonnegative(),
    consecutiveFailure: z.number().int().nonnegative(),
    lastProbeAt: z.string().nullable(),
    lastReason: z.string().optional(),
  }),
});
type Ticket = z.infer<typeof TicketSchema>;

const ticketEntrySchema = TicketSchema.extend({
  id: z.string().min(1),
  kind: z.literal('ticket'),
});

const ProbeHistorySchema = z.object({
  ticketId: z.string().min(1),
  at: z.string(),
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});
const probeEntrySchema = ProbeHistorySchema.extend({
  id: z.string().min(1),
  kind: z.literal('probe'),
});

const RollbackLogSchema = z.object({
  ticketId: z.string().min(1),
  fromPhase: PhaseSchema,
  actions: z.array(z.string()),   // 倒序执行的动作：['delete-staging', 'unpatch-row', ...]
  reason: z.string(),
  executedAt: z.string(),
});
const rollbackEntrySchema = RollbackLogSchema.extend({
  id: z.string().min(1),
  kind: z.literal('rollback'),
});

export const name = 'agint-mount';

// v0.0.1-rc.1：dsh-storage-domain 把 record schema 升级到 zod v4 的 ZodType 接口，
// 而本插件 peer 声明的是 zod v3（zod ^3.0.0），两套 ZodType 类型不互通。
// 用 `domainTable()` 包装 + 一次 as any cast 规避 TS2740，运行时仍按 v3 zod 解析（v3/v4 API 子集兼容）。
export const spec = defineDomain({
  name: 'agint_mount',
  version: 1,
  tables: {
    tickets: domainTable(ticketEntrySchema as any),
    probe_history: domainTable(probeEntrySchema as any),
    rollback_log: domainTable(rollbackEntrySchema as any),
  },
});

export const LIMITS = Object.freeze({
  TICKETS: 200,
  PROBE_HISTORY: 2000,
  ROLLBACK_LOG: 200,
});

// ── pack/unpack helpers（host-side 内部用） ─────────────────────────

function zString() { return z.string().min(1); }
function zLiteral(v: any) { return z.literal(v); }

export function packTicket(t: Omit<Ticket, never>): Ticket & { id: string; kind: 'ticket' } {
  const parsed = TicketSchema.parse(t);
  return { ...parsed, id: `t-${parsed.ticketId}`, kind: 'ticket' as const };
}

export function unpackTicket(e: { id: string; kind: string; [k: string]: any }): Ticket {
  const { id, kind, ...rest } = e;
  return TicketSchema.parse(rest);
}

export function packProbe(p: { ticketId: string; at: string; ok: boolean; latencyMs?: number; reason?: string }) {
  const parsed = ProbeHistorySchema.parse(p);
  return { ...parsed, id: `p-${p.ticketId}-${Date.now()}`, kind: 'probe' as const };
}

export function packRollback(r: { ticketId: string; fromPhase: any; actions: string[]; reason: string; executedAt: string }) {
  const parsed = RollbackLogSchema.parse(r);
  return { ...parsed, id: `r-${r.ticketId}-${Date.now()}`, kind: 'rollback' as const };
}

export function checkLimit(table: string, currentSize: number): null | { limit: number; _warn: string } {
  const cap = (LIMITS as any)[table.toUpperCase().replace(/_([A-Z])/g, (_, c) => c.toUpperCase()).replace(/^./, (c) => c.toUpperCase())] as number | undefined;
  if (cap === undefined) return null;
  if (currentSize < cap) return null;
  return { limit: cap, _warn: `${table} 上限 ${cap} 已满` };
}

export function randomId(): string {
  try { return globalThis.crypto.randomUUID(); }
  catch { return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
}

export function nowIso(): string { return new Date().toISOString(); }
