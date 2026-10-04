// SPDX-License-Identifier: MIT
// Copyright (c) 2026 anmul
// AGINT 新增文件。许可见 DSH-AGINT/LICENSE（MIT）。

/**
 * agint-mascot · health: the pure aggregation layer.
 *
 * No cordis, no I/O, no clock. Four probe results go in, one verdict comes
 * out. Split out so the scoring rules are testable without a host and so the
 * degradation discipline is checkable by reading one file.
 *
 * The rule this file exists to enforce: **a source we could not read is never
 * counted as a source that read fine.** A missing probe lowers the score and
 * raises the tone. There is no path through this module that turns an
 * unreadable source into a green one, because the caller has no way to ask
 * for that and the arithmetic has no branch for it.
 */

/** @typedef {'ok' | 'warn' | 'low'} MascotTone */
/** @typedef {'ok' | 'warn' | 'error' | 'absent'} ProbeState */

/**
 * One probe outcome as the caller reports it. `state` is decided by the
 * caller because only it knows whether an absent service means "not installed"
 * or "not mounted yet"; this module only scores what it is told.
 *
 * @typedef {object} ProbeResult
 * @property {string} id - kebab-case source id.
 * @property {ProbeState} state - `ok` read fine, `warn` read but degraded,
 *   `error` the probe threw, `absent` the service is not on the context.
 * @property {string} [detail] - short human note; never shown raw, only counted.
 */

/** Score a probe reflects in the health percentage. */
const PENALTY = { ok: 0, warn: 8, absent: 15, error: 30 };

/** Tone thresholds, highest score first. A single `error` source floors the tone at `low`. */
const LOW_AT_OR_BELOW = 60;
const WARN_AT_OR_BELOW = 85;

/** Hard cap on `note`; the pet contract truncates at 80 anyway. */
const NOTE_MAX = 80;
/** Hard cap on `title`; the pet contract truncates at 80 anyway. */
const TITLE_MAX = 80;

/**
 * @typedef {object} MascotHealth
 * @property {MascotTone} tone
 * @property {number} percent - 0..100, rounded.
 * @property {string} headline - lead text for the bubble.
 * @property {string} note - short trailing note.
 * @property {ProbeResult[]} sources - the probes this verdict was built from.
 * @property {number} errorCount - probes that threw.
 * @property {number} unknownCount - probes absent or warn.
 */

/**
 * Aggregate probe results into one verdict.
 *
 * @param {ProbeResult[]} probes
 * @returns {MascotHealth}
 */
export function aggregateHealth(probes) {
  const list = Array.isArray(probes) ? probes.filter(isProbe) : [];
  if (list.length === 0) {
    // No probes at all is itself a fact. Reporting it as healthy would be the
    // exact lie this module refuses to tell, so an empty input is `low` with a
    // headline that says why.
    return {
      tone: 'low',
      percent: 0,
      headline: 'AGINT 状态源未就绪',
      note: '没有采集到任何状态源',
      sources: [],
      errorCount: 0,
      unknownCount: 0,
    };
  }

  let score = 100;
  let errorCount = 0;
  let unknownCount = 0;
  for (const probe of list) {
    score -= PENALTY[probe.state];
    if (probe.state === 'error') errorCount += 1;
    if (probe.state === 'error' || probe.state === 'absent' || probe.state === 'warn') unknownCount += 1;
  }
  const percent = Math.max(0, Math.min(100, Math.round(score)));

  // A throwing source is not an average-away problem: one dead probe is a real
  // fault, so the tone is floored regardless of how the other probes scored.
  const tone = errorCount > 0 || percent <= LOW_AT_OR_BELOW
    ? 'low'
    : unknownCount > 0 || percent <= WARN_AT_OR_BELOW
      ? 'warn'
      : 'ok';

  return {
    tone,
    percent,
    headline: headlineFor(tone, list),
    note: noteFor(list),
    sources: list,
    errorCount,
    unknownCount,
  };
}

/** Shape guard. A malformed probe is dropped, not guessed at. */
function isProbe(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.id === 'string' &&
    value.id !== '' &&
    (value.state === 'ok' ||
      value.state === 'warn' ||
      value.state === 'error' ||
      value.state === 'absent')
  );
}

/** Lead text. Names the worst thing rather than the average. */
function headlineFor(tone, probes) {
  if (tone === 'low') {
    const failed = probes.filter((p) => p.state === 'error').map((p) => p.id);
    if (failed.length > 0) return `AGINT 故障：${failed.join('、')}`;
    return 'AGINT 状态异常';
  }
  if (tone === 'warn') {
    const unread = probes.filter((p) => p.state !== 'ok').map((p) => p.id);
    if (unread.length > 0) return `AGINT 部分未读到：${unread.join('、')}`;
    return 'AGINT 状态波动';
  }
  return 'AGINT 全部健康';
}

/** Trailing note: how many sources answered, and how many did not. */
function noteFor(probes) {
  const ok = probes.filter((p) => p.state === 'ok').length;
  const total = probes.length;
  const raw = `${ok}/${total} 源已读`;
  return raw.length <= NOTE_MAX ? raw : raw.slice(0, NOTE_MAX);
}

/** Trim a headline to the contract's ceiling. Exported so the caller can assert the same bound. */
export function boundHeadline(text) {
  return text.length <= TITLE_MAX ? text : text.slice(0, TITLE_MAX);
}
