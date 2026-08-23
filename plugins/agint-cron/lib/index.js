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
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';

const name = 'agint-cron';
const inject = ['timer', 'storageDomain'];

const Config = z.object({}).optional();

// Persisted per-job run state. The scheduler keeps lastRunAt/lastResult/
// lastError in memory only, so a dsh process restart makes cron_list report
// `last=never` even for jobs that have run many times — the same class of bug
// agint-dream fixed by recovering lastSweep from diary mtime. We persist job
// state to an exclusive `agint_cron` storage domain so a rebooted host restores
// real last-run timestamps instead of looking never-run.
const cronStateSchema = z.object({
  lastRunAt: z.string().nullable(),
  lastResult: z.string().nullable(),
  lastError: z.string().nullable(),
  updatedAt: z.string(),
});

const spec = defineDomain({
  name: 'agint_cron',
  version: 1,
  tables: { cron_state: { valueSchema: cronStateSchema } },
});

function apply(ctx) {
  // Persisted state domain. Opened lazily; if it fails to open (or is empty on
  // first boot) we degrade to in-memory-only (the previous behaviour) rather
  // than blocking the scheduler.
  let domain = null;
  let domainError = null;
  let disposed = false;
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
  const stateTable = async () => {
    if (disposed) throw new Error('agint-cron: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-cron: domain unavailable');
    return d.table('cron_state');
  };
  const jobs = compileJobs().map((j) => ({
    ...j,
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    running: false,
  }));
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const bootTime = Date.now();

  // Hydrate persisted lastRunAt/lastResult/lastError per job so a rebooted
  // host does not report every job as never-run. The domain opens async, so we
  // update the job objects in place once ready; jobs start null (previous
  // behaviour) and are patched when the domain settles.
  ready.then((d) => {
    if (!d) return;
    const table = d.table('cron_state');
    for (const [jobId, rec] of table.entries()) {
      const job = jobById.get(jobId);
      if (!job) continue;
      if (rec.lastRunAt) job.lastRunAt = new Date(rec.lastRunAt).getTime();
      if (rec.lastResult === 'ok') job.lastResult = { ok: true, restored: true };
      if (rec.lastError) job.lastError = { message: rec.lastError };
    }
  }).catch(() => { /* domain unavailable or empty — jobs stay in-memory-only */ });

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
      await persistJobState(job).catch(() => { /* state write must never break the run */ });
    }
  }

  // Best-effort persist of a job's run state to the cron_state domain so a
  // later process restart can hydrate lastRunAt/lastResult/lastError. Failures
  // are swallowed: the in-memory state is authoritative for the current run.
  async function persistJobState(job) {
    const record = {
      lastRunAt: job.lastRunAt ? new Date(job.lastRunAt).toISOString() : null,
      lastResult: job.lastResult ? 'ok' : null,
      lastError: job.lastError ? job.lastError.message : null,
      updatedAt: new Date().toISOString(),
    };
    const table = await stateTable();
    await table.put(job.id, record);
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