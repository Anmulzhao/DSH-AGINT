/**
 * agint-dream: host service plugin (provides `agint.dream`).
 *
 * HOST plane, single instance. The dreaming sweep is background memory
 * consolidation: it reads recent DSH session logs, extracts durable
 * candidates, scores them with the OpenClaw-adapted six-signal formula,
 * optionally promotes them into `agint.memory`, and writes a human-readable
 * dream diary under the configured root (default ${HOME}/projects/agint-dsh/dreams).
 *
 * Scheduling lives in agint-cron (job `night-dream`, daily 03:00 — OpenClaw default), which calls
 * `sweep({ apply: true })`. The preset tools (dream_status / dream_run_now /
 * dream_diary) call the same service for inspection and manual runs.
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-dream
 *         name: ./plugins/agint-dream/lib/index.js
 *         config:
 *           root: .../agint-dsh/dreams
 *           sessionsRoot: ${HOME}/.dsh/sessions
 */

import { resolve } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { runSweep, DEFAULTS } from './sweep.js';

const name = 'agint-dream';
// `agint.memory` is a soft dependency: read via ctx.get so a sweep still
// writes the diary (preview mode) when the memory service is unavailable.
const inject = [];

const Config = z.object({
  root: z.string().min(1, 'agint-dream: config.root is required'),
  sessionsRoot: z.string().default(() => (process.env.DSH_HOME || (process.env.HOME + '/.dsh')) + '/sessions'),
  // Three lookback windows mirror OpenClaw dreaming phases: Light 2d (candidate
  // extraction), REM 7d (cross-day reinforcement), Deep 30d (recovery backfill).
  lookbackDays: z.number().int().positive().default(DEFAULTS.lookbackDays),
  remLookbackDays: z.number().int().positive().default(DEFAULTS.remLookbackDays),
  deepRecoveryDays: z.number().int().positive().default(DEFAULTS.deepRecoveryDays),
  recover: z.boolean().default(true),
  minScore: z.number().min(0).max(1).default(DEFAULTS.minScore),
  minRecall: z.number().int().positive().default(DEFAULTS.minRecall),
  minUniqueSessions: z.number().int().positive().default(DEFAULTS.minUniqueSessions),
});

const DAY_MS = 24 * 60 * 60 * 1000;

function apply(ctx, config) {
  const root = resolve(config.root);
  const sessionsRoot = resolve(config.sessionsRoot);
  const state = { lastSweep: null, lastResult: null, lastError: null };

  ctx.provide('agint.dream', {
    /** Run a full sweep. opts.apply=false → preview + diary only. */
    async sweep(opts = {}) {
      const nowMs = Date.now();
      try {
        const result = await runSweep({
          sessionsRoot,
          diaryRoot: root,
          memory: ctx.get('agint.memory') ?? null,
          nowMs,
          apply: Boolean(opts.apply),
          lookbackDays: opts.lookbackDays ?? config.lookbackDays,
          remLookbackDays: opts.remLookbackDays ?? config.remLookbackDays,
          deepRecoveryDays: opts.deepRecoveryDays ?? config.deepRecoveryDays,
          recover: opts.recover ?? config.recover,
          minScore: opts.minScore ?? config.minScore,
          minRecall: opts.minRecall ?? config.minRecall,
          minUniqueSessions: opts.minUniqueSessions ?? config.minUniqueSessions,
        });
        state.lastSweep = nowMs;
        state.lastResult = result;
        state.lastError = null;
        return result;
      } catch (error) {
        state.lastError = error && error.message ? error.message : String(error);
        state.lastSweep = nowMs;
        throw error;
      }
    },

    /** Dreaming service status (no side effects). */
    async status() {
      const last = state.lastResult;
      return {
        enabled: true,
        frequency: '0 3 * * *', // nightly 03:00 (OpenClaw default), wired in agint-cron jobs
        sessionsRoot,
        diaryRoot: root,
        lookbackDays: config.lookbackDays,
        windows: {
          light: config.lookbackDays,
          rem: config.remLookbackDays,
          deep: config.deepRecoveryDays,
        },
        recover: config.recover,
        thresholds: {
          minScore: config.minScore,
          minRecall: config.minRecall,
          minUniqueSessions: config.minUniqueSessions,
        },
        lastSweepAt: state.lastSweep ? new Date(state.lastSweep).toISOString() : null,
        lastError: state.lastError,
        counts: last?.counts ?? { sessions: 0, userMessages: 0, memWrites: 0, toolErrors: 0, candidates: 0, gated: 0, recovered: 0, promoted: 0 },
      };
    },

    /** Read one dream diary file (default: most recent). */
    async diary(date) {
      const dir = root;
      const files = await readdir(dir).catch(() => []);
      const target = date ? `${date}.md` : null;
      let name = null;
      if (target && files.includes(target)) {
        name = target;
      } else {
        const mds = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
        const withTime = await Promise.all(mds.map(async (f) => ({ f, t: (await stat(join(dir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs ?? 0 })));
        withTime.sort((a, b) => b.t - a.t);
        name = withTime[0]?.f ?? null;
      }
      if (!name) return { path: null, content: null };
      return { path: join(dir, name), content: await readFile(join(dir, name), 'utf8') };
    },
  });
}

export { Config, apply, inject, name };
