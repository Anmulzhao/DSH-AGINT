/**
 * v2-data 单测：目录解析、三源聚合形状、30 天窗口、7 天 daily、
 * manifest 三形态 consumes、每源独立降级、TTL/mtime 缓存。
 */
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStorages } from './fixtures/make-storages.mjs';
import { resolveV2Dirs, collectV2Data, clearV2Cache } from '../lib/v2-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const HOME = join(here, 'fixtures', 'v2-home');
makeStorages(HOME);
const DIRS = {
  pluginsDir: join(HOME, 'profiles', 'web', 'plugins'),
  storagesDir: join(HOME, 'storages'),
  repoPluginsDir: join(here, 'fixtures', 'v2-repo', 'plugins'),
};
const now = Date.now();

// resolveV2Dirs：DSH_HOME 优先；无 AGINT_HOME → repoPluginsDir null（不猜）
{
  const selfUrl = 'file:///' + join(DIRS.pluginsDir, 'agint-alpha', 'lib', 'index.js').split('\\').join('/');
  const a = resolveV2Dirs({ DSH_HOME: HOME }, selfUrl);
  assert.equal(a.pluginsDir.replace(/\\/g, '/'), DIRS.pluginsDir.replace(/\\/g, '/'));
  assert.equal(a.storagesDir.replace(/\\/g, '/'), join(HOME, 'storages').replace(/\\/g, '/'));
  assert.equal(a.repoPluginsDir, null, '无 AGINT_HOME → null');
  const b = resolveV2Dirs({ DSH_HOME: HOME, AGINT_HOME: join(here, 'fixtures', 'v2-repo') }, 'file:///x');
  assert.equal(String(b.repoPluginsDir).replace(/\\/g, '/'), DIRS.repoPluginsDir.replace(/\\/g, '/'));
}

const P = collectV2Data(DIRS, { now, cache: new Map() });

// tools：窗口、聚合、daily、host 工具保留在 rows（归属分离是前端职责）
assert.equal(P.tools.windowDays, 30);
assert.ok(!P.tools.rows.some((r) => r.t === 'old_tool'), '30 天窗口外排除');
const alpha = P.tools.rows.find((r) => r.t === 'alpha_do');
assert.deepEqual({ n: alpha.n, f: alpha.f }, { n: 2, f: 1 });
assert.equal(P.tools.daily.alpha_do.length, 7);
assert.equal(P.tools.daily.alpha_do.reduce((s, v) => s + v, 0), 2);
assert.ok(P.tools.rows.some((r) => r.t === 'pwsh'), 'pwsh 留在 rows');
assert.equal(P.tools.total, 7);

// cron
assert.equal(P.cron.count, 2);
assert.equal(P.cron.jobs.find((j) => j.j === 'mystery-job').res, '?');

// bus
assert.equal(P.bus.total, 3);
assert.equal(P.bus.deadletter, 0);
assert.deepEqual(P.bus.topics[0], ['alpha.did', 2]);
assert.equal(P.bus.daily['agint-alpha'].reduce((s, v) => s + v, 0), 2);
assert.equal(P.bus.range.length, 2);

// manifestConsumes：三形态解析，只收非空
assert.deepEqual(P.manifestConsumes, { 'agint-alpha': ['agint.beta.svc'] });

// scan 与 repoDirs
assert.ok(P.scan.hits.length > 0);
assert.deepEqual(P.repoDirs, ['agint-alpha']);

// 降级：storages 目录不存在 → 三源各自 error，scan 照常，不抛
{
  const bad = collectV2Data({ ...DIRS, storagesDir: join(HOME, 'nope') }, { now, cache: new Map() });
  assert.equal(bad.ok, true);
  assert.equal(bad.tools.state, 'error');
  assert.equal(bad.cron.state, 'error');
  assert.equal(bad.bus.state, 'error');
  assert.ok(bad.scan.hits.length > 0, 'scan 独立于 storages');
}

// 缓存：TTL 内命中；force 重算；mtime 变化重算
{
  const c = new Map();
  const p1 = collectV2Data(DIRS, { now, cache: c });
  const p2 = collectV2Data(DIRS, { now: now + 1000, cache: c });
  assert.equal(p1.generatedAt, p2.generatedAt, 'TTL 内命中缓存');
  const p3 = collectV2Data(DIRS, { now: now + 1000, cache: c, force: true });
  assert.notEqual(p1.generatedAt, p3.generatedAt, 'force 重算');
}

clearV2Cache();
console.log('v2-data.test.mjs PASS');
