/**
 * test/static-smoke.test.mjs — Sprint 10 v0.6.3 #4
 *
 * agint-quality-static Service 集成 smoke（≥5 用例）：用合成 pluginDir 跑真 Service。
 * mock ctx 模板参考 plugins/agint-quality-sandbox/test/dual-mode.test.mjs。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = resolve(__dirname, '../lib/index.js');

function makeMockCtx() {
  const effects = [];
  const providers = {};
  const services = {};
  return {
    _effects: effects,
    _providers: providers,
    effect: (fn) => { effects.push(fn); },
    get: (name) => services[name],
    provide: (name, val) => { providers[name] = val; },
    on: () => {},
    register: () => {},
    services,
  };
}

async function makeService() {
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  return { ctx, svc: ctx._providers['agint.qualityStatic'] };
}

function makePluginDir(files, parent) {
  const dir = parent || mkdtempSync(join(tmpdir(), 'agint-smoke-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

const CLEAN_FILES = {
  'package.json': JSON.stringify({ name: 'agint-clean', dependencies: { zod: '*' } }),
  'lib/index.js': 'export const home = process.env.DSH_HOME;\n',
};

const BLOCKER_FILES = {
  'package.json': JSON.stringify({ name: 'agint-dirty', dependencies: { lodash: '*' } }),
  'lib/index.js': "import fs from 'node:fs';\nfs.writeFileSync('agint_metrics/x.json', '{}');\n",
};

test('apply(): provides agint.qualityStatic with 4 methods', async () => {
  const { ctx, svc } = await makeService();
  assert.ok(svc, 'service should be provided');
  for (const m of ['checkPlugin', 'checkAll', 'listFamilies', 'addAllowlistEntry']) {
    assert.equal(typeof svc[m], 'function', `${m} should be a function`);
  }
  assert.ok(ctx._effects.length >= 1, 'should register at least one dispose effect');
});

test('listFamilies(): returns the 4 families', async () => {
  const { svc } = await makeService();
  const families = svc.listFamilies();
  assert.equal(families.length, 4);
  for (const f of ['dependency-audit', 'storage-boundary', 'env-access', 'contract-reference']) {
    assert.ok(families.includes(f), `missing family ${f}`);
  }
});

test('checkPlugin(): clean plugin → { ok: true, findings: [] }', async () => {
  const { svc } = await makeService();
  const dir = makePluginDir(CLEAN_FILES);
  try {
    const r = await svc.checkPlugin({ pluginDir: dir });
    assert.equal(r.ok, true, JSON.stringify(r.findings));
    assert.deepEqual(r.findings, []);
    assert.equal(typeof r.durationMs, 'number');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('checkPlugin(): blocker plugin → { ok: false } with blocker findings', async () => {
  const { svc } = await makeService();
  const dir = makePluginDir(BLOCKER_FILES);
  try {
    const r = await svc.checkPlugin({ pluginDir: dir });
    assert.equal(r.ok, false);
    const blockers = r.findings.filter(f => f.severity === 'blocker');
    assert.ok(blockers.length >= 2, `expected >=2 blockers, got ${JSON.stringify(r.findings)}`);
    const families = new Set(blockers.map(f => f.family));
    assert.ok(families.has('dependency-audit'));
    assert.ok(families.has('storage-boundary'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('checkPlugin(): rejects missing / nonexistent pluginDir', async () => {
  const { svc } = await makeService();
  await assert.rejects(() => svc.checkPlugin({}), /pluginDir is required/);
  await assert.rejects(
    () => svc.checkPlugin({ pluginDir: join(tmpdir(), 'agint-does-not-exist-xyz') }),
    /not a directory/,
  );
});

test('checkAll(): aggregates per-plugin results and totalFindings', async () => {
  const { svc } = await makeService();
  const root = mkdtempSync(join(tmpdir(), 'agint-all-'));
  try {
    makePluginDir(CLEAN_FILES, makePluginDir({}, join(root, 'agint-plugin-a')));
    makePluginDir(BLOCKER_FILES, makePluginDir({}, join(root, 'agint-plugin-b')));
    mkdirSync(join(root, 'not-agint-plugin'), { recursive: true });
    const r = await svc.checkAll({ pluginsDir: root });
    assert.deepEqual(Object.keys(r.results).sort(), ['agint-plugin-a', 'agint-plugin-b']);
    assert.equal(r.results['agint-plugin-a'].ok, true);
    assert.equal(r.results['agint-plugin-b'].ok, false);
    assert.ok(r.totalFindings >= 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('addAllowlistEntry(): bumps version and validates input', async () => {
  const { svc } = await makeService();
  const r1 = await svc.addAllowlistEntry({ family: 'dependency-audit', pattern: 'foo' });
  assert.equal(r1.ok, true);
  assert.equal(r1.version, 2);
  const r2 = await svc.addAllowlistEntry({ family: 'env-access', pattern: 'BAR' });
  assert.equal(r2.version, 3);
  await assert.rejects(() => svc.addAllowlistEntry({ family: 'nope', pattern: 'x' }), /unknown family/);
  await assert.rejects(() => svc.addAllowlistEntry({ family: 'env-access' }), /pattern must be/);
});

test('checkPlugin(): the real agint-quality-static plugin dir is self-clean', async () => {
  const { svc } = await makeService();
  const r = await svc.checkPlugin({ pluginDir: resolve(__dirname, '..') });
  const blockers = r.findings.filter(f => f.severity === 'blocker');
  assert.deepEqual(blockers, [], `self blockers: ${JSON.stringify(blockers)}`);
});
