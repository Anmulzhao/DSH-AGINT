/**
 * agint-memory: host service plugin (provides `agint.memory`).
 *
 * HOST plane, single instance: opens the `agint` storage domain once and
 * serves every session. The domain name is exclusive per process
 * (already-open), which is exactly why this must be host-plane and why the
 * tools consumer lives in the preset instead.
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-memory
 *         name: agint-memory
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { decayScan, effectiveConfidence, nextLevel, shouldClear } from './decay.js';

const name = 'agint-memory';
const inject = ['storageDomain'];

const Config = z.object({});

const memorySchema = z.object({
  id: z.string().min(1),
  type: z.enum(['lesson', 'decision', 'preference', 'pattern']),
  content: z.string().min(1),
  level: z.enum(['L1', 'L2', 'L3', 'L4']).default('L1'),
  confidence: z.number().min(0).max(1).default(0.5),
  lastRecall: z.string().default(() => new Date().toISOString()),
  recalls: z.number().int().min(0).default(0),
  evidence: z.string().default(''),
  resolved: z.boolean().default(false),
  replacedBy: z.string().nullable().default(null),
  // P0 (Sprint 13 / 2026-09-05)：validation gate + loss fraction budget 引入的 lineage 字段。
  // 向前兼容：旧 entry 没字段，zod 用 null default，新 entry 可选填。
  // lineageKey   - 合并关系链 ID；merged 操作时所有 priorEntries 必须同 lineageKey
  // supersedesKey - provenance 维度；supersede 操作时必带，匹配要被取代的 entry
  // 设计动机：openclaw `<!-- openclaw-memory-lineage:X -->` 注释的 P2 对齐版本。
  // 见 AGINT/计划-agint-dream升级三方向.md P0 段。
  lineageKey: z.string().nullable().default(null),
  supersedesKey: z.string().nullable().default(null),
  createdAt: z.string().default(() => new Date().toISOString()),
  updatedAt: z.string().default(() => new Date().toISOString()),
});

const spec = defineDomain({
  name: 'agint',
  version: 1,
  tables: { memory: { valueSchema: memorySchema } },
});

function apply(ctx) {
  let domain = null;
  let domainError = null;
  let disposed = false;

  // ctx.effect semantics: the callback runs IMMEDIATELY; its RETURN value is
  // the disposer that runs when this fiber is disposed (reload, unmount,
  // shutdown). The disposer closes the domain only if it is already open.
  ctx.effect(() => {
    return () => {
      disposed = true;
      if (domain) return domain.close();
    };
  });

  const ready = ctx.storageDomain.open(spec).then(
    (d) => {
      if (disposed) {
        // A reload disposed us before our own open settled. Close the domain
        // immediately so the replacement instance can open it (the domain
        // name is exclusive), and resolve null — never a fatal rejection.
        void d.close().catch(() => {});
        return null;
      }
      domain = d;
      return d;
    },
    (error) => {
      domainError = error;
      return null;
    },
  );

  const table = async () => {
    if (disposed) throw new Error('agint-memory: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-memory: domain unavailable');
    return d.table('memory');
  };

  const nowIso = () => new Date().toISOString();

  ctx.provide('agint.memory', {
    async read(id) {
      const t = await table();
      const rec = t.get(id);
      return rec ? { ...rec } : null;
    },

    async list(filter = {}) {
      const t = await table();
      const out = [];
      for (const [id, rec] of t.entries()) {
        if (filter.type && rec.type !== filter.type) continue;
        if (filter.level && rec.level !== filter.level) continue;
        out.push({ id, ...rec });
      }
      return out;
    },

    async search(query, opts = {}) {
      const q = String(query ?? '').toLowerCase().trim();
      const t = await table();
      const out = [];
      for (const [id, rec] of t.entries()) {
        if (q && !(rec.content.toLowerCase().includes(q) || rec.evidence.toLowerCase().includes(q))) continue;
        if (opts.type && rec.type !== opts.type) continue;
        out.push({ id, ...rec, _eff: effectiveConfidence(rec) });
      }
      out.sort((a, b) => b._eff - a._eff);
      const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 20;
      return out.slice(0, limit).map(({ _eff, ...rec }) => rec);
    },

    async write(input) {
      const t = await table();
      const now = nowIso();
      const existing = input.id ? t.get(input.id) : undefined;
      const entry = memorySchema.parse({
        id: input.id ?? randomId(),
        type: input.type,
        content: input.content,
        level: input.level ?? existing?.level ?? 'L1',
        confidence: input.confidence ?? existing?.confidence ?? 0.5,
        lastRecall: existing ? existing.lastRecall : now,
        recalls: existing ? existing.recalls : 0,
        evidence: input.evidence ?? existing?.evidence ?? '',
        resolved: input.resolved ?? existing?.resolved ?? false,
        replacedBy: input.replacedBy ?? existing?.replacedBy ?? null,
        // P0：lineage 字段；新写入可显式带，未带从 existing 继承。
        lineageKey: input.lineageKey ?? existing?.lineageKey ?? null,
        supersedesKey: input.supersedesKey ?? existing?.supersedesKey ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      await t.put(entry.id, entry);
      return { ...entry };
    },

    async recall(id) {
      const t = await table();
      const rec = t.get(id);
      if (!rec) return null;
      const updated = { ...rec, recalls: rec.recalls + 1, lastRecall: nowIso(), updatedAt: nowIso() };
      await t.put(id, updated);
      return { ...updated };
    },

    async remove(id) {
      const t = await table();
      const rec = t.get(id);
      if (rec) await t.delete(id);
      return Boolean(rec);
    },

    async decayScanRun(opts = {}) {
      const t = await table();
      const scan = decayScan([...t.entries()]);
      const applied = [];
      if (opts.apply) {
        const now = nowIso();
        for (const a of scan.actions) {
          if (a.action === 'downgrade') {
            const rec = t.get(a.id);
            if (rec) {
              await t.put(a.id, { ...rec, level: a.to, updatedAt: now });
              applied.push(a);
            }
          } else if (a.action === 'clear') {
            if (await t.delete(a.id)) applied.push(a);
          }
        }
      }
      return { actions: scan.actions, report: scan.report, applied };
    },

    async stats() {
      const t = await table();
      const byType = {};
      const byLevel = {};
      let total = 0;
      let confidenceSum = 0;
      for (const [, rec] of t.entries()) {
        total += 1;
        byType[rec.type] = (byType[rec.type] ?? 0) + 1;
        byLevel[rec.level] = (byLevel[rec.level] ?? 0) + 1;
        confidenceSum += rec.confidence ?? 0;
      }
      return { total, byType, byLevel, avgConfidence: total ? confidenceSum / total : 0 };
    },
  });
}

function randomId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export { Config, apply, inject, name };
