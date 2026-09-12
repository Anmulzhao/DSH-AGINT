#!/usr/bin/env node
/**
 * agint-dream smoke test (v0.3.0-C4 zstd contract validation).
 *
 * covers three layers required by plugin-preflight:
 *   1. import: sweep.js loads cleanly, key exports present
 *   2. contract: readSessionLog reads a real zstd-compressed session file
 *   3. fallback: when zstd CLI is missing, the new isZstdAvailable() guard
 *      surfaces a friendly error instead of letting execFile ENOENT for
 *      every single session (the 2026-09-12 silent-failure root cause).
 *
 * Exit 0 = pass. Exit non-zero = smoke FAILED.
 *
 * Run: node plugins/agint-dream/test/smoke.mjs
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';

import {
  readSessionLog,
  collectSessionSignals,
  extractCandidates,
  scoreCandidates,
  gateCandidates,
  renderDiary,
  runSweep,
  DEFAULTS,
  listSessionLogs,
} from '../lib/sweep.js';

console.log('[smoke] module=agint-dream');

// ── 1. import ────────────────────────────────────────────────────────────
assert.equal(typeof readSessionLog, 'function', 'readSessionLog must be a function');
assert.equal(typeof collectSessionSignals, 'function', 'collectSessionSignals must be a function');
assert.equal(typeof extractCandidates, 'function', 'extractCandidates must be a function');
assert.equal(typeof scoreCandidates, 'function', 'scoreCandidates must be a function');
assert.equal(typeof gateCandidates, 'function', 'gateCandidates must be a function');
assert.equal(typeof renderDiary, 'function', 'renderDiary must be a function');
assert.equal(typeof runSweep, 'function', 'runSweep must be a function');
assert.equal(typeof listSessionLogs, 'function', 'listSessionLogs must be a function');
assert.ok(DEFAULTS && typeof DEFAULTS === 'object', 'DEFAULTS must be exported');
assert.equal(DEFAULTS.minScore, 0.75, 'minScore should default to 0.75');
assert.equal(DEFAULTS.minRecall, 3, 'minRecall should default to 3');
console.log('[smoke] import ✓ (8 functions + DEFAULTS exported)');

// ── 2. contract: real zstd session read ──────────────────────────────────
// Find at least one real session.jsonl.zstd under /dsh/sessions (the AGINT
// canonical location). If none exist, fall back to a synthesized .zstd
// fixture so the smoke is deterministic and not host-state dependent.
import { execFileSync as _efs } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, statSync } from 'node:fs';

function findRealSession() {
  const root = '/dsh/sessions';
  try {
    const workspaces = readdirSync(root);
    for (const ws of workspaces) {
      const wsDir = join(root, ws);
      try {
        const sessions = readdirSync(wsDir);
        for (const sid of sessions) {
          const candidates = [
            join(wsDir, sid, 'session.jsonl.zstd'),
            join(wsDir, sid, 'session.v3.jsonl.zstd'),
          ];
          for (const c of candidates) {
            try {
              if (statSync(c).isFile()) return c;
            } catch {}
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agint-dream-smoke-'));
  const jsonlPath = join(dir, 'session.jsonl');
  const zstdPath = join(dir, 'session.jsonl.zstd');
  const records = [
    { type: 'session', id: 'smoke-fixture-001', createdAt: Date.now() },
    { type: 'user', seq: 0, text: '我喜欢简洁的代码风格' },
    { type: 'assistant', seq: 1, text: '收到，按 OpenClaw 风格走。' },
    { type: 'tool_use', seq: 2, name: 'memory_write' },
  ];
  writeFileSync(jsonlPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  _efs('zstd', ['-q', '-f', jsonlPath, '-o', zstdPath], { stdio: 'ignore' });
  return { dir, zstdPath, records };
}

let fixtureDir = null;
let sessionPath;
const realSession = findRealSession();
if (realSession) {
  sessionPath = realSession;
  console.log(`[smoke] using real session: ${sessionPath.slice(0, 60)}...`);
} else {
  const fx = makeFixture();
  fixtureDir = fx.dir;
  sessionPath = fx.zstdPath;
  console.log(`[smoke] using synthesized fixture: ${sessionPath}`);
}

try {
  const records = await readSessionLog(sessionPath);
  assert.ok(Array.isArray(records), 'readSessionLog must return an array');
  assert.ok(records.length > 0, 'must parse at least 1 record');
  // Every parsed record should be an object with a type field
  for (const r of records.slice(0, 5)) {
    assert.equal(typeof r, 'object', 'each record must be an object');
    assert.ok(typeof r.type === 'string', `each record must have a type string (got ${JSON.stringify(r).slice(0, 80)})`);
  }
  console.log(`[smoke] readSessionLog ✓ (${records.length} records parsed)`);
} finally {
  if (fixtureDir) {
    try { rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
  }
}

// ── 3. fallback: isZstdAvailable() guard ────────────────────────────────
// Tests both branches of the 2026-09-12 contract:
//   - happy path: zstd CLI present → isZstdAvailable() === true
//   - sad path:  zstd CLI missing   → isZstdAvailable() === false,
//                                   AND readSessionLog() throws the
//                                   friendly bootstrap-script error
//                                   (NOT the raw ENOENT we saw for 2 weeks).
//
// We can't actually delete /usr/bin/zstd (root-owned), so the sad path
// runs in a child Node process with a stripped PATH.
import { isZstdAvailable } from '../lib/sweep.js';

// 3a. happy path
assert.equal(isZstdAvailable(), true, 'isZstdAvailable() should be true when zstd is in PATH');
console.log('[smoke] isZstdAvailable() === true ✓');

// 3b. sad path: child process with PATH that has no zstd
//
// Trick: we can't actually delete /usr/bin/zstd (root-owned), and we can't
// strip PATH too aggressively or node loses access to its own internal
// modules. So we:
//   1. Write a fake `zstd` (always-exit-1) to a temp dir
//   2. Put that temp dir FIRST in PATH (so command -v zstd resolves to it)
//   3. Also remove the real /usr/bin and /usr/local/bin from PATH
//   4. Invoke a probe script via absolute node path (so PATH-stripping doesn't
//      kill node itself)
const fakeZstdDir = mkdtempSync(join(tmpdir(), 'agint-dream-nozstd-'));
const probePath = join(fakeZstdDir, '_probe.mjs');
try {
  writeFileSync(join(fakeZstdDir, 'zstd'), '#!/bin/sh\nexit 1\n');
  _efs('chmod', ['+x', join(fakeZstdDir, 'zstd')], { stdio: 'ignore' });
  // Compute the absolute path to sweep.js BEFORE writing probe, so the
  // probe's `import` resolves correctly regardless of where probePath lives.
  const sweepAbsPath = new URL('../lib/sweep.js', import.meta.url).pathname;
  writeFileSync(probePath, `
import { isZstdAvailable, readSessionLog } from ${JSON.stringify(sweepAbsPath)};
const has = isZstdAvailable();
console.log('IS_AVAILABLE:', has);
try {
  await readSessionLog('/tmp/nonexistent.jsonl.zstd');
  console.log('NO_ERROR_THROWN');
  process.exit(2);
} catch (e) {
  console.log('CAUGHT:', e.message);
  process.exit(0);
}
`);

  const filtered = process.env.PATH.split(':')
    .filter((p) => p !== '/usr/bin' && p !== '/usr/local/bin');
  const newPath = [fakeZstdDir, ...filtered].join(':');

  let probeStdout = '';
  let probeStderr = '';
  try {
    // execFileSync returns the stdout Buffer/string directly (not an object
    // with .stdout/.stderr fields). To get stderr separately we need
    // stdio: ['ignore', 'pipe', 'pipe'] AND we use the throw variant.
    const stdoutBuf = _efs(process.execPath, [probePath], {
      env: { ...process.env, PATH: newPath },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    probeStdout = stdoutBuf || '';
  } catch (e) {
    // If the probe exits non-zero, stdout/stderr live on the error object.
    probeStdout = (e.stdout?.toString('utf8') || '').toString();
    probeStderr = (e.stderr?.toString('utf8') || '').toString();
  }
  assert.equal(probeStdout.includes('IS_AVAILABLE: false'), true,
    `isZstdAvailable() should be false when PATH has no zstd, got stdout=${probeStdout.slice(0, 200)} stderr=${probeStderr.slice(0, 200)}`);
  assert.ok(/zstd CLI not found in PATH/.test(probeStdout),
    `must throw friendly zstd-missing error, got stdout=${probeStdout.slice(0, 200)}`);
  assert.ok(/agint-zstd-bootstrap/.test(probeStdout),
    `error message must reference bootstrap script, got stdout=${probeStdout.slice(0, 200)}`);
  console.log('[smoke] zstd-missing guard ✓ (child PATH stripped)');
} finally {
  try { rmSync(fakeZstdDir, { recursive: true, force: true }); } catch {}
}

// ── 4. manifest sanity (manifest.json shell field is the 2026-09-12 fix) ──
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
assert.ok(Array.isArray(manifest.spec.permissions.shell), 'permissions.shell must be an array (declaring zstd CLI dependency)');
assert.ok(manifest.spec.permissions.shell.includes('zstd'), 'permissions.shell must declare "zstd"');
console.log(`[smoke] manifest ✓ (permissions.shell = ${JSON.stringify(manifest.spec.permissions.shell)})`);

// ── summary ──────────────────────────────────────────────────────────────
console.log('[smoke] PASS ✓');
