/**
 * agint-cron: host service (provides agint.cron) — a tiny cron scheduler
 * built on cordis-plugin-timer. Maintains a 60-second tick, checks each
 * compiled job's schedule, fires when the next-fire minute passes since
 * the last run. Per-job mutex prevents overlapping runs.
 *
 * Default jobs (memory-decay, wiki-lint, metrics-collect, evolve-review) are
 * registered at boot. The service exposes list / runNow / health for the
 * preset tools.
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-cron
 *         name: ./plugins/agint-cron/lib/index.js
 */

import { z } from 'zod';
import { nextFire, lastFire } from './cron.js';
import { compileJobs } from './jobs.js';

const name = 'agint-cron';
const inject = ['timer'];

const Config = z.object({}).optional();

function apply(ctx) {
  const jobs = compileJobs().map((j) => ({
    ...j,
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    running: false,
  }));
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const bootTime = Date.now();

  // 60-second tick. Disposer registered so the interval is cleaned up on
  // fiber disposal (graceful shutdown or reload).
  const tickHandle = ctx.setInterval(() => void tick(), 60_000);
  ctx.effect(() => tickHandle.dispose);

  // Service resolution map: jobs receive a snapshot of common host services
  // they need. Resolved lazily at tick time so services are available by then.
  const services = () => ({
    'agint.memory': ctx.get('agint.memory'),
    'agint.wiki': ctx.get('agint.wiki'),
    'agint.metrics': ctx.get('agint.metrics'),
    'agint.evolve': ctx.get('agint.evolve'),
    'agint.toolStats': ctx.get('agint.toolStats'),
    sessionPersistence: ctx.get('sessionPersistence'),
  });

  async function tick() {
    const now = Date.now();
    for (const job of jobs) {
      if (!job.id) continue; // (already filtered, but keep types)
      try {
        const expected = nextFire(job.parsed, new Date(job.lastRunAt ?? bootTime));
        if (expected === null) continue;
        if (now < expected.getTime()) continue;
        if (job.running) continue; // skip if previous run still in flight
        // Fire the job (async, fire-and-forget at the tick level).
        void runOne(job);
      } catch (error) {
        console.error('[agint-cron] tick error for ' + job.id + ': ' + (error && error.message ? error.message : String(error)));
      }
    }
  }

  async function runOne(job) {
    job.running = true;
    const startedAt = new Date().toISOString();
    try {
      const result = await job.action(services());
      job.lastResult = { ok: true, startedAt, result };
      job.lastError = null;
    } catch (error) {
      job.lastError = { startedAt, message: error && error.message ? error.message : String(error) };
      console.error('[agint-cron] job ' + job.id + ' failed: ' + job.lastError.message);
    } finally {
      job.lastRunAt = Date.now();
      job.running = false;
    }
  }

  ctx.provide('agint.cron', {
    list() {
      const now = Date.now();
      return jobs.map((j) => ({
        id: j.id,
        name: j.name,
        schedule: j.schedule,
        description: j.description,
        lastRunAt: j.lastRunAt ? new Date(j.lastRunAt).toISOString() : null,
        nextRunAt: nextFire(j.parsed, new Date(j.lastRunAt ?? bootTime))?.toISOString() ?? null,
        lastOk: j.lastResult ? true : (j.lastError ? false : null),
        lastError: j.lastError ? j.lastError.message : null,
        running: j.running,
      }));
    },

    async runNow(id) {
      const job = jobById.get(id);
      if (!job) throw new Error(`agint-cron: no job '${id}'`);
      if (job.running) throw new Error(`agint-cron: job '${id}' already running`);
      await runOne(job);
      return { ok: job.lastError === null, lastResult: job.lastResult, lastError: job.lastError };
    },

    health() {
      const now = Date.now();
      const issues = [];
      const status = jobs.map((j) => {
        const last = j.lastRunAt ?? bootTime;
        const expected = nextFire(j.parsed, new Date(last));
        const overdueMs = expected ? Math.max(0, now - expected.getTime()) : 0;
        // A job is stale if its expected run is more than 1.5 windows overdue.
        const windowMs = expected && j.lastRunAt ? expected.getTime() - (j.lastRunAt ?? expected.getTime()) : 7 * 86_400_000;
        const stale = j.lastRunAt === null ? (now - bootTime > windowMs * 2) : (overdueMs > windowMs * 0.5);
        if (stale) issues.push({ id: j.id, reason: 'overdue by ' + Math.round(overdueMs / 60_000) + ' min' });
        return {
          id: j.id,
          stale,
          overdueMs,
          lastRunAt: j.lastRunAt ? new Date(j.lastRunAt).toISOString() : null,
          expectedNextRunAt: expected?.toISOString() ?? null,
        };
      });
      return { healthy: issues.length === 0, issues, jobs: status };
    },

    // Internal helper for diagnostics; not part of the public surface but
    // useful for the boot-level diagnostic.
    _tickNow() { return tick(); },
    _jobs() { return jobById; },
  });
}

export { Config, apply, inject, name };