// Regression guard for the cron_state schema contract (added 2026-09-28).
//
// Why this test exists: `lastResultSummary` was added to cronStateSchema, and
// the obvious spelling of it — `.nullable()` — silently destroys the whole
// state domain. zod's `.nullable()` permits a null VALUE but still requires the
// KEY to exist, so every record written before the field existed fails
// validation at `storageDomain.open` (code `invalid-record`, dsh-storage-domain
// lib/index.js:371). The domain then fails to open, agint-cron falls back to
// in-memory-only, `persistJobState` writes are swallowed by `.catch(() => {})`,
// and after a restart cron_list reports `never` for every job. That is a
// strictly worse regression than the observability gap the field was added to
// close, and nothing in the logs says so.
//
// The test pins three things: the field stays optional, the domain version stays
// 1 (dsh-storage-domain README:153 rejects a spec version that differs from the
// stored one, so bumping it would also break open), and a record shaped exactly
// like the ones the old code wrote still parses.

import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cronStateSchema } from '../lib/index.js';

// The exact shape persistJobState wrote BEFORE lastResultSummary existed.
function legacyRecord(overrides = {}) {
  return {
    lastRunAt: '2026-09-28T02:30:30.000Z',
    lastResult: 'ok',
    lastError: null,
    updatedAt: '2026-09-28T02:30:30.000Z',
    ...overrides,
  };
}

test('legacy records without lastResultSummary still parse', () => {
  // This is the assertion that fails if `.nullish()` is ever "simplified" back
  // to `.nullable()`.
  const parsed = cronStateSchema.parse(legacyRecord());
  assert.equal(parsed.lastResult, 'ok');
  // A missing optional key parses to undefined, never throws.
  assert.ok(parsed.lastResultSummary === undefined || parsed.lastResultSummary === null);
});

test('a summary round-trips through the schema', () => {
  const summary = JSON.stringify({ scanned: 377, counts: { downgrade: 0, clear: 0 }, actionsTotal: 0 });
  const parsed = cronStateSchema.parse(legacyRecord({ lastResultSummary: summary }));
  assert.equal(parsed.lastResultSummary, summary);
  assert.deepEqual(JSON.parse(parsed.lastResultSummary).scanned, 377);
});

test('an explicit null summary is accepted', () => {
  const parsed = cronStateSchema.parse(legacyRecord({ lastResultSummary: null }));
  assert.equal(parsed.lastResultSummary, null);
});

test('the schema itself would have rejected legacy records if written as .nullable()', () => {
  // Pins the reason the field is `.nullish()`, so the rationale cannot be
  // "simplified" away by someone who does not know what it costs.
  const asNullable = z.object({
    lastRunAt: z.string().nullable(),
    lastResult: z.string().nullable(),
    lastError: z.string().nullable(),
    lastResultSummary: z.string().nullable(),
    updatedAt: z.string(),
  });
  assert.throws(() => asNullable.parse(legacyRecord()), /expected string, received undefined/);
  assert.doesNotThrow(() => cronStateSchema.parse(legacyRecord()));
});

test('domain version stays 1 — no data migration exists', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8');
  const m = src.match(/name:\s*'agint_cron',\s*\n\s*version:\s*(\d+)/);
  assert.ok(m, 'defineDomain({ name: "agint_cron", version: N }) not found');
  assert.equal(Number(m[1]), 1, 'agint_cron domain version must stay 1: bumping it makes stored data unopenable');
});
