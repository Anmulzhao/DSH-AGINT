#!/usr/bin/env node
/**
 * dsh-release-locks.mjs — release orphaned dsh writer locks.
 *
 * WHY THIS EXISTS
 * ---------------
 * `withFileLock` in @deepseek-ai/dsh-atomic-write creates `<file>.lock` with an
 * exclusive `wx` write containing the holder's PID, and its own docs state:
 *
 *   "The contender never removes an existing lock because file age cannot prove
 *    that its owner stopped; orphan recovery is an operator action."
 *
 * It also waits only DEFAULT_LOCK_WAIT_MS = 2000ms before failing. So the moment
 * a dsh process dies WITHOUT running its `finally { rm(lockPath) }` — i.e. any
 * hard kill (Task Manager "End task", `taskkill /F`, power loss, OOM) — the next
 * boot fails outright with, e.g.:
 *
 *   dsh: plugin tree failed to load: failed to apply loader entry connection
 *   (@deepseek-ai/dsh-client-connection): atomic-write: timed out waiting for
 *   the writer lock at C:\Users\Administrator\.dsh\.credentials.yaml.lock
 *
 * That message looks like a credential problem and sends you hunting in the
 * wrong place. It is a stale 5-byte lock file whose recorded PID is dead.
 *
 * WHAT IT DOES
 * ------------
 * For every `*.lock` directly under the dsh home, read the PID inside and test
 * liveness. A lock whose PID is gone is an orphan and is deleted; a lock whose
 * PID is alive is left alone (a real writer holds it). Reports both. Always
 * dry-run first.
 *
 * USAGE
 *   node bin/dsh-release-locks.mjs [--home <dir>] [--apply]
 *     (no flag)  report what would be removed
 *     --apply    actually delete orphan locks
 *
 * WINDOWS PATH NOTE: do not pass an absolute path through `--home` from a POSIX
 * shell — Git Bash splits argv on ":" and `C:/x` arrives as `C`. Prefer setting
 * DSH_HOME, which is what dsh itself reads.
 */
import fs from 'node:fs';
import path from 'node:path';

const HOME = (() => {
  const i = process.argv.indexOf('--home');
  if (i >= 0) return process.argv[i + 1];
  return process.env.DSH_HOME || 'C:/Users/Administrator/.dsh';
})();
const APPLY = process.argv.includes('--apply');

/** A PID is considered held if the process exists; EPERM means it exists but is not ours. */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

if (!fs.existsSync(HOME)) {
  console.error(`dsh home not found: ${HOME}`);
  process.exit(2);
}

let entries;
try { entries = fs.readdirSync(HOME, { withFileTypes: true }); }
catch (err) { console.error(`cannot read ${HOME}: ${err.message}`); process.exit(2); }

const locks = entries.filter((e) => e.isFile() && e.name.endsWith('.lock'));
// `<name>.lock.stale-<pid>` files are quarantined leftovers from earlier manual
// recoveries. Nothing reads them; they are only clutter.
const litter = entries.filter((e) => e.name.includes('.lock.stale-'));

console.log(`dsh home     : ${HOME}`);
console.log(`mode         : ${APPLY ? 'APPLY' : 'dry-run'}`);
console.log(`locks present: ${locks.length}`);
if (litter.length > 0) {
  console.log(`stale litter : ${litter.length} (${litter.map((e) => e.name).join(', ')})`);
}

let orphans = 0;
let held = 0;
for (const entry of locks) {
  const p = path.join(HOME, entry.name);
  const raw = fs.readFileSync(p, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  const ageSec = ((Date.now() - fs.statSync(p).mtimeMs) / 1000).toFixed(0);
  if (isPidAlive(pid)) {
    console.log(`  HELD   ${entry.name}  pid=${pid} alive  age=${ageSec}s`);
    held += 1;
    continue;
  }
  console.log(`  ORPHAN ${entry.name}  pid=${raw || '?'} dead  age=${ageSec}s${APPLY ? '  -> deleted' : '  -> would delete'}`);
  if (APPLY) fs.unlinkSync(p);
  orphans += 1;
}

console.log('---');
console.log(`orphans ${APPLY ? 'deleted' : 'found'}: ${orphans}`);
console.log(`held by a live process: ${held}`);
if (!APPLY && orphans > 0) console.log('re-run with --apply to release them');
if (APPLY && orphans === 0) console.log('nothing to do');
