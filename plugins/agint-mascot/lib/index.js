// SPDX-License-Identifier: MIT
// Copyright (c) 2026 anmul
// AGINT 新增文件。许可见 DSH-AGINT/LICENSE（MIT）。

/**
 * agint-mascot: HOST half (node plane, single instance).
 *
 * Reads AGINT's own health signals and pushes the verdict into the pet's
 * announcement bubble, so the desktop pet shows the system state instead of
 * only showing session activity.
 *
 * ## Why this is a separate plugin rather than a fork change
 *
 * The pet plugin is a third-party Apache-2.0 project we fork for asset
 * reasons. Its own `src/` stays untouched. This plugin lives in the AGINT repo
 * (MIT) and reaches the pet only through the documented sibling-plugin channel
 * `ctx.pet.announce(...)`. That keeps the fork rebase-clean and keeps the
 * AGINT repo free of Apache-2.0 code.
 *
 * ## Design constraints
 *
 * - **Never lie about energization.** A source that is absent, throws, or
 *   answers in an unexpected shape degrades the verdict. It is never counted
 *   as healthy. See lib/health.js.
 * - **Never break the host.** Every probe is individually guarded and every
 *   service lookup is late-bound (`ctx.get(name, false)` at poll time), so a
 *   service that has not mounted yet — or a pet plugin that never mounts — is
 *   a missing row, not a boot failure. Nothing here is required to start.
 * - **Write nothing.** No storage domain, no files, no persistence. The pet's
 *   announcement slot is in-memory with a TTL on the upstream side.
 *
 * Row (bundle cordis.patch.yml):
 *   - insert:
 *       - id: agint-mascot
 *         name: ./plugins/agint-mascot/lib/index.js
 */

import { aggregateHealth } from './health.js';
import { toAnnouncePayload, clampTtl, skinIdForHealth } from './announce.js';
import { registerMascotTools } from './tools.js';

const name = 'agint-mascot';

/**
 * Nothing is required. Every service this plugin reads is optional by design:
 * the whole point is to report which sources are missing, which is impossible
 * if the plugin refuses to start when one is.
 */
const inject = [];
const optionalInject = ['tools', 'loader', 'agint.cron', 'agint.metrics', 'agint.selfModel'];

const DEFAULT_POLL_MS = 30_000;
const MIN_POLL_MS = 5_000;
const MAX_POLL_MS = 600_000;

/** @typedef {import('./health.js').MascotHealth} MascotHealth */
/** @typedef {import('./health.js').ProbeState} ProbeState */
/** @typedef {import('./health.js').ProbeResult} ProbeResult */

/**
 * Late-bind a host service. Returns undefined instead of throwing when the
 * service is not on the context yet, which is the normal case for anything
 * that mounts after this row.
 * @param {object} ctx
 * @param {string} key
 * @returns {any}
 */
function late(ctx, key) {
  try {
    return ctx.get(key, false);
  } catch {
    return undefined;
  }
}

/**
 * Call one service method and classify the outcome. Never throws.
 *
 * An unexpected return SHAPE is treated as `warn`, not `ok`: a service that
 * answers with the wrong type is not a service that answered correctly, and
 * reporting it green is the one thing this plugin must not do.
 *
 * @returns {Promise<ProbeResult>}
 */
async function probe(ctx, id, serviceKey, method, inspect) {
  const service = late(ctx, serviceKey);
  if (service === undefined || typeof service[method] !== 'function') {
    return { id, state: 'absent', detail: `${serviceKey} 未挂载` };
  }
  try {
    const raw = await service[method]();
    return inspect(raw, id);
  } catch (err) {
    return { id, state: 'error', detail: shortError(err) };
  }
}

/** A thrown value becomes a short reason. Never echoed raw into the bubble. */
function shortError(err) {
  const text = (err && typeof err.message === 'string' ? err.message : String(err ?? 'error')).trim();
  return text.length <= 60 ? text : `${text.slice(0, 57)}...`;
}

/** `ok` when the shape matches; `warn` when it does not. */
function shape(state, id, detail) {
  return { id, state, detail };
}

/**
 * Normalize a service return into an array.
 *
 * This exists because `ctx.loader.entries()` is NOT an array — it is an
 * iterator, and the established caller spreads it
 * (`agint-family-panel/lib/index.js:188`). An `Array.isArray` check alone
 * reads a perfectly healthy loader as "wrong shape", which is the kind of
 * false negative this plugin must not produce.
 *
 * Returns null when the value is not a collection at all.
 * @param {unknown} value
 * @returns {unknown[] | null}
 */
function toArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' || value === null || value === undefined) return null;
  if (typeof (/** @type {any} */ (value)[Symbol.iterator]) !== 'function') return null;
  try {
    return [...(/** @type {Iterable<unknown>} */ (value))];
  } catch {
    return null;
  }
}

/** Collect all four probes. Each is independent; one failure never short-circuits the rest. */
export async function collectProbes(ctx) {
  return Promise.all([
    probe(ctx, 'cron', 'agint.cron', 'list', (raw) => {
      const direct = toArray(raw);
      const jobs = direct ?? toArray(raw?.jobs);
      if (jobs === null) return shape('warn', 'cron', '返回形状不是任务列表');
      const never = jobs.filter((j) => isNeverRun(j)).length;
      return never === 0
        ? shape('ok', 'cron', `${jobs.length} 个任务`)
        : shape('warn', 'cron', `${jobs.length} 个任务，${never} 个从未跑过`);
    }),

    probe(ctx, 'metrics', 'agint.metrics', 'summary', (raw) => {
      const metrics = toArray(raw) ?? toArray(raw?.metrics);
      if (metrics === null) return shape('warn', 'metrics', '返回形状不是指标列表');
      if (metrics.length === 0) return shape('warn', 'metrics', '尚无指标');
      return shape('ok', 'metrics', `${metrics.length} 项指标`);
    }),

    probe(ctx, 'selfModel', 'agint.selfModel', 'stats', (raw) => {
      if (typeof raw !== 'object' || raw === null) return shape('warn', 'selfModel', '返回形状不是对象');
      const count = firstNumber(raw);
      return count === null
        ? shape('warn', 'selfModel', '对象里没有数值字段')
        : shape('ok', 'selfModel', `${count} 项`);
    }),

    probe(ctx, 'plugins', 'loader', 'entries', (raw) => {
      // `ctx.loader.entries()` is an iterator, not an array. See toArray().
      const rows = toArray(raw);
      if (rows === null) return shape('warn', 'plugins', '返回形状不是条目列表');
      const failed = rows.filter((r) => fiberStateOf(r) === FIBER_FAILED);
      const idOf = (r) => String(r?.options?.id ?? r?.id ?? '?');
      return failed.length === 0
        ? shape('ok', 'plugins', `${rows.length} 个插件全部通电`)
        : shape('warn', 'plugins', `${failed.length} 个插件失败：${failed.map(idOf).slice(0, 3).join('、')}`);
    }),
  ]);
}

/* ---- loader entry shape ---- */

/**
 * `cordis-plugin-loader` entries do NOT carry `runtime.status`. The lifecycle
 * state is a NUMBER at `entry.fiber.state` (FiberState), and the row id is at
 * `entry.options.id`. Getting either wrong reads a healthy host as broken.
 *
 * Enum values transcribed from the established reader in this repo
 * (`agint-family-panel/lib/index.js:160-167`), which documents the same trap:
 * PENDING=0 / LOADING=1 / ACTIVE=2 / FAILED=3 / DISPOSED=4 / UNLOADING=5.
 */
const FIBER_FAILED = 3;

/** @returns {number} FiberState as a number; -1 when the entry is not shaped like one. */
function fiberStateOf(entry) {
  const state = entry?.fiber?.state;
  return typeof state === 'number' ? state : -1;
}

/** A cron job that has never produced a run. Shape-tolerant by design. */function isNeverRun(job) {
  if (typeof job !== 'object' || job === null) return false;
  if (job.lastRun === undefined && job.lastRunAt === undefined && job.lastRunMs === undefined) {
    // No run field at all: the job has never run.
    return true;
  }
  const value = job.lastRun ?? job.lastRunAt ?? job.lastRunMs;
  return value === null || value === 0;
}

/** First numeric property of an object, used only to prove the shape is alive. */
function firstNumber(raw) {
  for (const value of Object.values(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * @param {object} ctx
 * @param {object} [config]
 */
function apply(ctx, config = {}) {
  const pollMs = Math.max(
    MIN_POLL_MS,
    Math.min(MAX_POLL_MS, Number.isFinite(config.pollMs) ? Number(config.pollMs) : DEFAULT_POLL_MS),
  );
  let enabled = config.enabled !== false;

  /** Last verdict, kept so the service and the tool answer without re-probing. */
  let last = null;
  /** Last announce result, for diagnostics. `skipped` is the normal state when no pet is mounted. */
  let lastPush = { at: 0, result: 'not-run' };
  let lastSkin = null;
  let lastSkinPush = { at: 0, result: 'not-run' };
  let timer = null;

  /**
   * One collection + push cycle. Everything is guarded: a throw here would
   * take the timer with it and silently stop the plugin.
   */
  async function cycle() {
    let health;
    try {
      health = aggregateHealth(await collectProbes(ctx));
    } catch (err) {
      lastPush = { at: Date.now(), result: `collect-failed: ${shortError(err)}` };
      return;
    }
    last = health;
    if (!enabled) {
      lastPush = { at: Date.now(), result: 'disabled' };
      return;
    }
    const pet = late(ctx, 'pet');
    if (pet === undefined || typeof pet.announce !== 'function') {
      // The pet plugin is not mounted (yet). This is a normal state, not a
      // fault, so it must not lower the health verdict we just computed.
      lastPush = { at: Date.now(), result: 'no-pet' };
      return;
    }
    try {
      const outcome = pet.announce(toAnnouncePayload(health, pollMs));
      lastPush = { at: Date.now(), result: outcome?.ok === true ? 'ok' : 'rejected' };
    } catch (err) {
      lastPush = { at: Date.now(), result: `throw: ${shortError(err)}` };
    }

    // The resting look. `announce` says it once; the skin holds it until the
    // verdict changes, so this is only pushed on a change.
    const wanted = skinIdForHealth(health);
    if (wanted === lastSkin) return;
    if (typeof pet.setSkin !== 'function') {
      // An older pet build without the skins channel. Not a fault of AGINT, and
      // it must not disturb the announcement we just pushed.
      lastSkinPush = { at: Date.now(), result: 'no-setSkin' };
      return;
    }
    try {
      const res = await pet.setSkin(wanted);
      if (res?.ok === true) {
        lastSkin = wanted;
        lastSkinPush = { at: Date.now(), result: `ok:${wanted}` };
      } else {
        // e.g. `unknown-skin` from a pet asset that does not declare it. Keep
        // the previous value so the next tick retries instead of giving up.
        lastSkinPush = { at: Date.now(), result: `rejected:${wanted}` };
      }
    } catch (err) {
      lastSkinPush = { at: Date.now(), result: `throw: ${shortError(err)}` };
    }
  }

  const tick = () => {
    void cycle();
  };

  timer = setInterval(tick, pollMs);
  // Node keeps the process alive for a pending timer; unref so a pet plugin
  // never becomes the reason a host fails to shut down.
  if (typeof timer.unref === 'function') timer.unref();
  tick();

  ctx.effect(() => () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  });

  registerMascotTools(ctx, {
    status: () => last,
    collect: () => collectProbes(ctx).then((probes) => aggregateHealth(probes)),
    lastPush: () => lastPush,
    lastSkinPush: () => lastSkinPush,
    currentSkin: () => lastSkin,
    pollMs: () => pollMs,
    setEnabled: (next) => {
      enabled = next === true;
      if (enabled) tick();
      return enabled;
    },
    isEnabled: () => enabled,
  });

  ctx.provide('agint.mascot', {
    /** Last computed verdict, or null before the first cycle finishes. */
    status: () => last,
    /** Force a fresh collection without waiting for the next tick. */
    refresh: async () => {
      await cycle();
      return last;
    },
    /** Announce TTL in ms, i.e. the poll cadence. */
    pollMs: () => pollMs,
    /** Outcome of the last push attempt, for diagnostics. */
    lastPush: () => lastPush,
    /** The resting look currently pushed, or null before the first success. */
    currentSkin: () => lastSkin,
    /** Outcome of the last `setSkin` attempt, for diagnostics. */
    lastSkinPush: () => lastSkinPush,
    setEnabled: (next) => {
      enabled = next === true;
      if (enabled) tick();
      return enabled;
    },
    isEnabled: () => enabled,
  });
}

export { apply, inject, name, optionalInject, DEFAULT_POLL_MS, MIN_POLL_MS, MAX_POLL_MS, clampTtl };
