/**
 * agint-metrics/lib/service.js — service implementation for the kv time series.
 *
 * Extracted from index.js in Sprint 12 / A5 to keep index.js ≤ 200 行 (红线).
 * Provides the agint.metrics service: collect / summary / series / keys / stats.
 *
 * The collect() method iterates over computable metric keys, each one writing
 * one record into the metric table. Sources are resolved lazily so boot order
 * does not matter.
 */

import { z } from 'zod';

export const metricSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  label: z.string().default(''),
  value: z.number(),
  unit: z.string().default(''),
  meta: z.string().default(''),
  ts: z.string().default(() => new Date().toISOString()),
});

export function defaultRandomId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build the agint.metrics service object.
 * @param {object} args
 * @param {object} args.ctx — Cordis ctx (sources resolved via ctx.get at call time)
 * @param {Function} args.table — async () => table handle
 * @param {Function} args.computeMetrics — pure fn from ./metrics.js
 * @param {Function} args.describeMetric — pure fn from ./metrics.js
 * @param {Function} args.randomId — () => string
 * @returns {object} agint.metrics service
 */
export function buildMetricsService({ ctx, table, computeMetrics, describeMetric, randomId = defaultRandomId }) {
  const sources = () => ({
    cron: ctx.get('agint.cron'),
    rules: ctx.get('agint.rules'),
    wiki: ctx.get('agint.wiki'),
    memory: ctx.get('agint.memory'),
  });

  return {
    async collect() {
      const t = await table();
      const records = await computeMetrics(sources());
      const now = new Date().toISOString();
      const written = [];
      for (const rec of records) {
        const record = metricSchema.parse({ id: randomId(), ...rec, ts: now });
        await t.put(record.id, record);
        written.push({ key: record.key, value: record.value, unit: record.unit, ts: record.ts });
      }
      const uncollected = [];
      for (const rec of written) if (rec.value === undefined) uncollected.push(rec.key);
      return { collectedAt: now, count: written.length, collected: written };
    },

    async summary() {
      const t = await table();
      const latest = new Map();
      const prev = new Map();
      for (const [, rec] of t.entries()) {
        const cur = latest.get(rec.key);
        if (!cur || rec.ts > cur.ts) {
          if (cur) prev.set(rec.key, cur);
          latest.set(rec.key, rec);
        } else if (!prev.has(rec.key) && rec.ts < cur.ts) {
          prev.set(rec.key, rec);
        }
      }
      const metrics = [];
      for (const [key, rec] of latest.entries()) {
        const p = prev.get(key);
        metrics.push({
          key,
          label: rec.label,
          value: rec.value,
          unit: rec.unit,
          ts: rec.ts,
          delta: p && typeof p.value === 'number' && typeof rec.value === 'number' ? rec.value - p.value : null,
        });
      }
      metrics.sort((a, b) => a.key.localeCompare(b.key));
      const asOf = metrics.reduce((m, x) => (x.ts > m ? x.ts : m), '');
      return { asOf, count: metrics.length, metrics };
    },

    async series(key, opts = {}) {
      const t = await table();
      const days = Number.isInteger(opts?.days) && opts.days > 0 ? opts.days : 0;
      const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0;
      const points = [];
      for (const [, rec] of t.entries()) {
        if (rec.key !== key) continue;
        const tMs = new Date(rec.ts).getTime();
        if (cutoff && tMs < cutoff) continue;
        points.push({ ts: rec.ts, value: rec.value, meta: rec.meta });
      }
      points.sort((a, b) => a.ts.localeCompare(b.ts));
      const def = describeMetric(key);
      return { key, label: def?.label ?? key, unit: def?.unit ?? '', points };
    },

    async keys() {
      const t = await table();
      const byKey = new Map();
      for (const [, rec] of t.entries()) {
        const cur = byKey.get(rec.key);
        if (!cur || rec.ts > cur.ts) byKey.set(rec.key, rec.ts);
      }
      const out = [];
      for (const [key, ts] of byKey.entries()) out.push({ key, lastCollectedAt: ts });
      return out.sort((a, b) => a.key.localeCompare(b.key));
    },

    async stats() {
      const t = await table();
      let total = 0;
      const byKey = {};
      for (const [, rec] of t.entries()) {
        total += 1;
        byKey[rec.key] = (byKey[rec.key] ?? 0) + 1;
      }
      return { total, byKey };
    },
  };
}