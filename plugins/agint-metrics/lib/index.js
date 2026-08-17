/**
 * agint-metrics: host service plugin (provides `agint.metrics`).
 *
 * HOST plane, single instance: opens the `agint_metrics` storage domain once
 * (unique name — `agint` / `agint_rules` are taken, K12) and serves every
 * session. Metrics are a kv time series: each collect() writes one record per
 * computable metric key with a timestamp; summary() returns the latest record
 * per key plus the delta vs the previous record (trend).
 *
 * Sources are read lazily with ctx.get at call time (agint.cron / agint.rules
 * / agint.wiki / agint.memory); a missing or unhealthy source skips its
 * metrics instead of failing the run. The daily collect is wired as the
 * `metrics-collect` cron job (see packages/agint-cron/lib/jobs.js).
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-metrics
 *         name: ./plugins/agint-metrics/lib/index.js
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { computeMetrics, describeMetric } from './metrics.js';

const name = 'agint-metrics';
const inject = ['storageDomain'];

const Config = z.object({});

const metricSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  label: z.string().default(''),
  value: z.number(),
  unit: z.string().default(''),
  meta: z.string().default(''),
  ts: z.string().default(() => new Date().toISOString()),
});

const spec = defineDomain({
  name: 'agint_metrics',
  version: 1,
  tables: { metric: { valueSchema: metricSchema } },
});

function apply(ctx) {
  let domain = null;
  let domainError = null;
  let disposed = false;

  // ctx.effect semantics: callback runs IMMEDIATELY; its RETURN value is the
  // disposer that runs when this fiber is disposed. The disposer closes the
  // domain only if it is already open (K4/K8 double-sentinel pattern).
  ctx.effect(() => {
    return () => {
      disposed = true;
      if (domain) return domain.close();
    };
  });

  const ready = ctx.storageDomain.open(spec).then(
    (d) => {
      if (disposed) {
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
    if (disposed) throw new Error('agint-metrics: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-metrics: domain unavailable');
    return d.table('metric');
  };

  const randomId = () => {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  };

  // Sources resolved lazily so boot order does not matter.
  const sources = () => ({
    cron: ctx.get('agint.cron'),
    rules: ctx.get('agint.rules'),
    wiki: ctx.get('agint.wiki'),
    memory: ctx.get('agint.memory'),
  });

  ctx.provide('agint.metrics', {
    /** Collect one record per computable metric key right now. */
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

    /** Latest record per key, with delta vs the previous record (trend). */
    async summary() {
      const t = await table();
      const latest = new Map(); // key → record
      const prev = new Map(); // key → previous record (for delta)
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

    /** Time series for one key (oldest → newest). */
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

    /** Distinct metric keys with their latest timestamp. */
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

    /** Raw counts — for diagnostics and stats tools. */
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
  });
}

export { Config, apply, inject, name };
