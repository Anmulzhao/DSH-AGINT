// SPDX-License-Identifier: MIT
// Copyright (c) 2026 anmul
// AGINT 新增文件。许可见 DSH-AGINT/LICENSE（MIT）。

/**
 * agint-mascot · announce: map a health verdict onto the pet's announcement
 * contract.
 *
 * ## The constraint this module works around
 *
 * `pet.announce` validates into `PetAnnouncement`, whose `kind` is a CLOSED
 * enum: `'balance' | 'cost' | 'plan'`
 * (`agint-pet/src/announce.ts:17`, enforced at line 72). There is no
 * `status` / `health` / `error` kind. An unknown kind is rejected and
 * `announce()` returns `{ ok: false }` with no diagnostic.
 *
 * We map onto `'plan'` deliberately:
 *
 * - `plan` is the only kind whose `percent` field is required (line 81), and a
 *   health percentage is exactly what we have.
 * - `plan` is the only kind that carries a level rather than a currency.
 * - `balance` and `cost` both REQUIRE `amount` (line 80) and read as money.
 *
 * `tone` is `'ok' | 'warn' | 'low'` (line 29) and maps cleanly:
 * ok = healthy, warn = something unreadable, low = a source threw.
 *
 * If upstream ever adds a status kind, change `KIND` here and nothing else.
 */

/** Source tag written into every announcement. The pet contract caps it at 64 chars. */
export const SOURCE = 'agint-mascot';

/**
 * The kind we borrow. See the module note above. Changing this is the single
 * point of contact with any future upstream status kind.
 */
export const KIND = 'plan';

/** Pet contract floors ttlMs at 1000 and ceilings it at 7_200_000. */
export const TTL_MIN_MS = 1000;
export const TTL_MAX_MS = 7_200_000;

/**
 * @typedef {import('./health.js').MascotHealth} MascotHealth
 * @typedef {object} AnnouncePayload
 */

/**
 * Build the payload for `pet.announce`.
 *
 * `pollIntervalMs` is passed through as the TTL on purpose: the upstream
 * contract documents that a repeating announcer declares its poll cadence as
 * the TTL so an always-on bubble stays continuous across polls
 * (`agint-pet/src/announce.ts:39-45`).
 *
 * @param {MascotHealth} health
 * @param {number} pollIntervalMs
 * @returns {AnnouncePayload}
 */
export function toAnnouncePayload(health, pollIntervalMs) {
  return {
    source: SOURCE,
    kind: KIND,
    title: health.headline,
    percent: health.percent,
    note: health.note,
    tone: health.tone,
    ttlMs: clampTtl(pollIntervalMs),
  };
}

/** Clamp a poll interval into the contract's TTL window. */
export function clampTtl(ms) {
  if (!Number.isFinite(ms)) return TTL_MIN_MS;
  return Math.max(TTL_MIN_MS, Math.min(TTL_MAX_MS, Math.round(ms)));
}

/**
 * Pick the resting look (`frames2d.skins` id) for a verdict.
 *
 * Health is a STATE, not a sentence: `announce` is what the pet says once,
 * `setSkin` is how it rests until something changes. So the persistent part of
 * the verdict rides the skins channel.
 *
 * The four ids are declared by the installed pet asset (`pet.json` →
 * `frames2d.skins`) and are told apart by MOTION first: healthy drifts,
 * degraded limps, unknown swings without advancing, failed is still. Only
 * `failed` leaves the brand palette.
 *
 * @param {MascotHealth} health
 * @returns {'healthy' | 'degraded' | 'unknown' | 'failed'}
 */
export function skinIdForHealth(health) {
  if (health === null || health === undefined) return 'unknown';
  if (health.tone === 'ok') return 'healthy';
  if (health.tone === 'warn') return 'degraded';
  // `low` with nothing throwing means nothing could be READ, which is not the
  // same as something being broken. Reporting it as failed would be a claim
  // we cannot make.
  return health.errorCount > 0 ? 'failed' : 'unknown';
}
