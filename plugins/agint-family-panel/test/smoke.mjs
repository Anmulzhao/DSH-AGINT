/**
 * agint-family-panel smoke test.
 *
 * Exercises the host half against a stub context: the route must register,
 * answer a well-formed snapshot, degrade instead of throwing when the roster or
 * a signal source misbehaves, and refuse non-loopback callers. The browser half
 * is checked statically (it is a browser artifact, not a node module).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { apply, name, inject } from '../lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** Minimal stub loader row. */
function row(id, status = 'active', disabled = false) {
  return { options: { id, name: `./plugins/${id}/lib/index.js` }, disabled, runtime: { status } };
}

/** Build a stub host context. */
function makeCtx(overrides = {}) {
  const registered = [];
  const provided = {};
  const entries = overrides.entries ?? [row('agint-memory'), row('agint-cron'), row('other-plugin')];
  return {
    config: overrides.config ?? {},
    loader: { entries: () => entries },
    webServer: {
      register(route) {
        registered.push(route);
        return () => {};
      },
    },
    provide(key, value) { provided[key] = value; },
    get(service) { return (overrides.services ?? {})[service]; },
    effect() {},
    _registered: registered,
    _provided: provided,
  };
}

/** Call a registered route handler and capture the response. */
async function callRoute(ctx, { method = 'GET', remoteAddress = '127.0.0.1', path } = {}) {
  const route = ctx._registered.find((r) => r.path === (path ?? '/api/agint-family/status'));
  assert.ok(route, 'status route registered');
  let captured = null;
  const res = {
    writeHead(status, headers) { captured = { status, headers }; },
    end(body) { captured.body = body; },
  };
  await route.handler({ method, socket: { remoteAddress } }, res);
  return captured;
}

// 1. manifest shape ---------------------------------------------------------
assert.equal(name, 'agint-family-panel');
assert.ok(inject.includes('webServer'), 'host half declares webServer');

// 2. package.json dual-face declaration -------------------------------------
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'agint-family-panel');
assert.equal(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform is web');
assert.equal(pkg.exports?.['./client'], './lib/client.js', 'exports ./client');

// 3. browser half is a well-formed module-loader artifact --------------------
const clientSrc = readFileSync(join(root, 'lib/client.js'), 'utf8');
assert.ok(clientSrc.includes('window.__ModuleLoader__.load('), 'uses the module loader');
assert.ok(clientSrc.includes(`id: 'agint-family-panel'`), 'factory id equals the package name');
assert.ok(!/\brequire\(['"]@deepseek-ai\/dsh-client-ui-primitives['"]\)/.test(clientSrc), 'imports no Harness client package');
assert.ok(clientSrc.includes('var(--dsw-alias-'), 'styles through host theme tokens');
assert.ok(clientSrc.includes('var(--dsh-frame-top-clearance'), 'honours the window-chrome clearance');
// syntax check in a child process (the artifact references window)
execFileSync(process.execPath, ['--check', join(root, 'lib/client.js')], { stdio: 'pipe' });

// 4. route answers a snapshot ------------------------------------------------
const ctx = makeCtx();
apply(ctx);
const ok = await callRoute(ctx);
assert.equal(ok.status, 200, 'status 200');
const payload = JSON.parse(ok.body);
assert.equal(payload.ok, true);
assert.equal(payload.enabled, true);
assert.equal(payload.counts.total, 2, 'counts only agint-* rows');
assert.ok(payload.groups.some((g) => g.id === 'memory'), 'memory group present');
assert.ok(payload.groups.some((g) => g.id === 'unmapped') === false, 'no unmapped rows in the fixture');
assert.equal(payload.hostRowCount, 3, 'reports the whole host roster');
assert.equal(payload.signals.length, 3, 'three signal probes');

// 5. non-loopback is refused -------------------------------------------------
const denied = await callRoute(ctx, { remoteAddress: '10.0.0.7' });
assert.equal(denied.status, 403, 'non-loopback refused');

// 6. wrong method is refused -------------------------------------------------
const badMethod = await callRoute(ctx, { method: 'POST' });
assert.equal(badMethod.status, 405, 'POST refused');

// 7. a throwing loader degrades, never crashes -------------------------------
const brokenCtx = makeCtx({ entries: undefined });
brokenCtx.loader = { entries: () => { throw new Error('loader exploded'); } };
apply(brokenCtx);
const degraded = await callRoute(brokenCtx);
assert.equal(degraded.status, 200, 'degrades to 200');
const degradedBody = JSON.parse(degraded.body);
assert.ok(degradedBody.rosterError, 'roster failure is reported');
assert.equal(degradedBody.counts.total, 0, 'empty roster, not a fabricated one');

// 8. a missing signal source is reported as unavailable ----------------------
const noSignalsCtx = makeCtx({ services: {} });
apply(noSignalsCtx);
const noSignals = JSON.parse((await callRoute(noSignalsCtx)).body);
assert.ok(noSignals.signals.every((s) => s.state === 'unavailable'), 'absent services read unavailable');
assert.ok(noSignals.signals.every((s) => typeof s.reason === 'string' && s.reason.length > 0), 'with a reason');

// 9. a throwing signal source is reported as error ---------------------------
const throwingCtx = makeCtx({
  services: {
    'agint.cron': { list() { throw new Error('cron down'); } },
    'agint.metrics': { summary: () => ({ metrics: [1, 2], meta: { a: 1 } }) },
    'agint.selfModel': { stats: () => ({ count: 7 }) },
  },
});
apply(throwingCtx);
const mixed = JSON.parse((await callRoute(throwingCtx)).body);
const cronSignal = mixed.signals.find((s) => s.key === 'cron');
assert.equal(cronSignal.state, 'error', 'throwing probe reads error');
assert.ok(cronSignal.reason.includes('cron down'), 'reason preserved');
assert.equal(mixed.signals.find((s) => s.key === 'metrics').value, 2, 'metrics reduced');
assert.equal(mixed.signals.find((s) => s.key === 'selfModel').value, 7, 'self-model reduced');

// 10. kill-switch keeps the route alive but empty ----------------------------
const offCtx = makeCtx({ config: { enabled: false } });
apply(offCtx);
const off = JSON.parse((await callRoute(offCtx)).body);
assert.equal(off.enabled, false, 'reports switched off');
assert.equal(off.counts, undefined, 'no data served while off');

// 11. service face -----------------------------------------------------------
assert.equal(typeof ctx._provided['agint.familyPanel']?.status, 'function', 'provides agint.familyPanel');

console.log('agint-family-panel smoke: PASS (11 groups)');
