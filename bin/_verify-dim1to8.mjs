#!/usr/bin/env node
/**
 * _verify-dim1to8.mjs — node 版 plugin-check 维度 1-4 深度校验（jq 不可用时 fallback）
 * 抄自 bin/plugin-check.sh line 142-179 的 jq 逻辑，覆盖维度 1-4 manifest 字段必填。
 * 维度 5（lifecycle setInterval/disposer）用 grep 静态扫，node 实现同款。
 * 维度 6/7/8 由 manifest.tests.entry / manifest.docs.readme / manifest.changelog 字段决定，
 *   本脚本同时校验这三项（与 plugin-check.sh 一致）。
 * 用法：node bin/_verify-dim1to8.mjs <plugin-dir>
 */
import { existsSync, readFileSync } from 'node:fs';
import { join as pjoin } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node bin/_verify-dim1to8.mjs <plugin-dir>');
  process.exit(2);
}

let warns = 0, fails = 0;
const log = (kind, msg) => { console.log(`[${kind}] ${msg}`); if (kind === 'WARN') warns++; if (kind === 'FAIL') fails++; };

const mfPath = pjoin(dir, 'manifest.json');
if (!existsSync(mfPath)) {
  log('FAIL', 'manifest.json 缺失');
  console.log(`fail=${fails} warn=${warns}`);
  process.exit(1);
}
const mf = JSON.parse(readFileSync(mfPath, 'utf8'));

// 双兼容 .spec.* 和顶层
const cordis = mf.spec?.cordis ?? mf.cordis;
const storage = mf.spec?.storage ?? mf.storage;
const deps = mf.spec?.dependencies ?? mf.dependencies;
const perms = mf.spec?.permissions ?? mf.permissions;

if (!cordis?.inject || !cordis?.provides) log('WARN', '维度 1 contract: manifest 缺 cordis.inject + cordis.provides');
else log('OK', `维度 1 contract: inject=${JSON.stringify(cordis.inject)} provides=${JSON.stringify(cordis.provides)}`);

if (!Array.isArray(storage?.domains)) log('WARN', '维度 2 storage: manifest 缺 storage.domains 数组');
else log('OK', `维度 2 storage: domains=${JSON.stringify(storage.domains)}`);

if (deps == null) log('WARN', '维度 3 deps: manifest 缺 dependencies');
else log('OK', `维度 3 deps: ${JSON.stringify(deps)}`);

if (perms == null) log('WARN', '维度 4 permissions: manifest 缺 permissions');
else log('OK', `维度 4 permissions: ${JSON.stringify(perms)}`);

// 维度 5 lifecycle: 静态扫
const libPath = pjoin(dir, 'lib', 'index.js');
if (existsSync(libPath)) {
  const src = readFileSync(libPath, 'utf8');
  const hasInterval = /setInterval|setTimeout/.test(src);
  const hasDisposer = /ctx\.effect|\.dispose/.test(src);
  if (hasInterval && !hasDisposer) log('WARN', '维度 5 lifecycle: 用了 setInterval/setTimeout 但没看到 ctx.effect dispose');
  else log('OK', '维度 5 lifecycle: disposer 已注册或未发现裸 timer');
} else {
  log('FAIL', 'lib/index.js 缺失');
  fails++;
}

// 维度 6/7/8
const testEntry = mf.spec?.tests?.entry ?? mf.tests?.entry ?? 'test/smoke.mjs';
if (!existsSync(pjoin(dir, testEntry))) log('WARN', `维度 6 tests: ${testEntry} 缺失`);
else log('OK', `维度 6 tests: ${testEntry} 存在`);

const readme = mf.spec?.docs?.readme ?? mf.docs?.readme ?? 'README.md';
if (!existsSync(pjoin(dir, readme))) log('WARN', `维度 7 docs: ${readme} 缺失`);
else log('OK', `维度 7 docs: ${readme} 存在`);

const cl = mf.spec?.changelog ?? mf.changelog ?? 'CHANGELOG.md';
if (!existsSync(pjoin(dir, cl))) log('WARN', `维度 8 changelog: ${cl} 缺失`);
else log('OK', `维度 8 changelog: ${cl} 存在`);

console.log(`--- fail=${fails} warn=${warns}`);
process.exit(fails > 0 ? 1 : 0);