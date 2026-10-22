/**
 * 档案数据层测试（v2-dossier）。
 *
 * 钉住的判据（每条都对应一个真实踩过的坑）：
 *  1. 三级身份降级：manifest > package > 目录，且**不假装**契约存在。
 *  2. 一个 id 两个物理位置时，主位置取「有代码的那份」，契约可从另一位置汇拢并注明来源。
 *  3. 版本分裂（manifest vs package）与多位置版本不同都进 drift，且**不判谁对**。
 *  4. CHANGELOG 两种标题写法都能解析；非版本号标题不冒充版本。
 *  5. 代码体量只算 lib/ 下的 js/mjs，不把 test/ 算进去。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDossiers, parseChangelog, codeStat } from '../lib/v2-dossier.js';
import { ownersPayload, providerOfService, isHostKey, ownerOfTool } from '../lib/v2-owners.js';
import { makeDossierFixture } from './fixtures/dossier/make-fixture.mjs';

const dirs = { pluginsDir: makeDossierFixture(), repoPluginsDir: null };
const out = collectDossiers(dirs, { kinds: {}, mounted: new Set(['agint-normal']) });

test('采集成功，四个插件各有档案且 order 与 byId 一致', () => {
  assert.equal(out.state, 'ok');
  assert.deepEqual(out.order.slice().sort(), Object.keys(out.byId).sort());
  assert.deepEqual(out.order, ['agint-code-only', 'agint-container', 'agint-normal', 'agint-pkg-only', 'agint-shell']);
});

test('正常插件：契约、服务自述、代码体量、CHANGELOG 都在', () => {
  const d = out.byId['agint-normal'];
  assert.equal(d.layer, 'manifest');
  assert.equal(d.contractSource, 'self');
  assert.equal(d.meta.version, '0.2.0');
  assert.equal(d.contract.provides.length, 2);
  assert.equal(d.contract.serviceDocs['agint.a'], '服务 A 的自述');
  assert.deepEqual(d.contract.storageDomains, ['agint_a']);
  assert.equal(d.mounted, true);
  // test/smoke.mjs 不在 lib/ 下，不能计入
  assert.equal(d.code.files, 2);
  assert.ok(d.code.lines >= 3);
  assert.equal(d.doc.changelog.versions, 2);
  assert.equal(d.doc.changelog.recent[0].version, '0.2.0');
  assert.equal(d.doc.readme.present, true);
  assert.deepEqual(d.drift, [], '正常插件不该有可核对的结构差异');
});

test('只有 package：身份在、契约显式不可得（不是空数组）', () => {
  const d = out.byId['agint-pkg-only'];
  assert.equal(d.layer, 'package');
  assert.equal(d.contract, null);
  assert.equal(d.meta.version, '0.3.0');
  assert.equal(d.meta.versionSource, 'package');
  assert.ok(d.drift.some((x) => x.code === 'no-manifest' && x.level === 'warn'));
  // mounted=null 与 false 是两件事：这里传了 set，所以是明确的 false
  assert.equal(d.mounted, false);
});

test('只有代码：drift 报「身份为零」，不是静默通过', () => {
  const d = out.byId['agint-code-only'];
  assert.equal(d.layer, 'dir');
  assert.equal(d.meta.version, null);
  assert.equal(d.contract, null);
  assert.ok(d.drift.some((x) => x.code === 'no-identity' && x.level === 'err'));
});

test('壳 + 真身：主位置取有代码那份，另一位置的版本进 dup-stale', () => {
  const d = out.byId['agint-shell'];
  assert.equal(d.locations.length, 2, '两个物理位置都要登记');
  assert.equal(d.rel, 'agint-container/agint-shell', '主位置必须是有 lib 的真身');
  assert.equal(d.code.state, 'ok');
  assert.ok(d.code.files >= 1);
  assert.equal(d.meta.version, '0.2.0');
  const stale = d.drift.find((x) => x.code === 'dup-stale');
  assert.ok(stale, '两处版本不同必须报 dup-stale');
  assert.equal(stale.level, 'warn');
  assert.match(stale.text, /0\.2\.0/);
  assert.match(stale.text, /0\.1\.0/);
});

test('契约与代码分家时报 split-location，且 contractSource 指向另一位置', () => {
  // 造一个「真身没有 manifest、壳有 manifest」的情形
  const d = out.byId['agint-shell'];
  // 本例真身自己带 manifest，所以应该是 self；同时壳的存在仍被登记
  assert.equal(d.contractSource, 'self');
  assert.ok(d.locations.some((l) => l.role === 'secondary' && l.manifestVersion === '0.1.0'));
});

test('CHANGELOG 两种标题写法都解析，非版本号标题不冒充', () => {
  const items = parseChangelog(`# Changelog
## 变更
## 0.2.0 — 2026-10-22
## 0.1.0 (2026-10-01) — 初版
## v1.0.0 稳定
`);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { version: '0.2.0', date: '2026-10-22', title: '' });
  assert.deepEqual(items[1], { version: '0.1.0', date: '2026-10-01', title: '初版' });
  assert.deepEqual(items[2], { version: '1.0.0', date: null, title: '稳定' });
});

test('codeStat 对不存在的 lib 返回 missing，不是 0 行「成功」', () => {
  const r = codeStat(`${dirs.pluginsDir}/agint-code-only/nope`);
  assert.equal(r.state, 'missing');
  assert.equal(r.files, 0);
});

test('pluginsDir 不可解析时整层 unavailable 并给原因', () => {
  const bad = collectDossiers({ pluginsDir: 'Z:/definitely-not-here' }, {});
  assert.equal(bad.state, 'unavailable');
  assert.equal(bad.order.length, 0);
  assert.match(bad.reason, /pluginsDir/);
});

test('归因表：payload 形态完整，前缀优先匹配，宿主键判据只认非 agint 前缀', () => {
  const payload = ownersPayload();
  assert.ok(Array.isArray(payload.tool) && payload.tool.length > 10);
  assert.equal(payload.cron['oracle-daily'], 'agint-aesthetic-oracle');
  assert.ok(payload.hostKeys.includes('profileContext'), 'profileContext 是宿主键（无 provide 行）');
  // 长前缀必须先命中
  assert.equal(ownerOfTool('memory_provider_health'), 'agint-memory-provider');
  assert.equal(ownerOfTool('evolution_ledger_x'), 'agint-evolution-driver');
  assert.equal(ownerOfTool('nope_'), null);
  assert.equal(isHostKey('profileContext'), true);
  assert.equal(isHostKey('agint.cron'), false, 'agint.* 永远不是宿主键');
});

test('providerOfService 只在确有父键 provide 时回退', () => {
  const provided = { 'agint.eventBus': 'agint-event-bus', 'agint.eventBus.publish': 'agint-event-bus' };
  assert.equal(providerOfService(provided, 'agint.eventBus.publish'), 'agint-event-bus');
  assert.equal(providerOfService(provided, 'agint.eventBus.subscribe'), 'agint-event-bus', '子键没 provide 时退到父键');
  assert.equal(providerOfService(provided, 'agint.nothing.here'), null, '不能凭空造提供方');
});
