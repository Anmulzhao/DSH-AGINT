// 完整装配 cron + driver + memory，调用 runNow('outcome-measure') 并核验 cron_state。
// 目的：让 cron plugin 负责持久化 lastRunAt/lastResultSummary。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY_ROOT = 'D:\\DSH\\AGINT-date';
const REPO = __dirname;

process.env.DSH_HOME = DEPLOY_ROOT;
process.env.AGINT_HOME = DEPLOY_ROOT;
process.env.AGINT_REPO_ROOT = REPO;

function importM(p) { return import(pathToFileURL(p).href); }

import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';

const services = {};
const warns = [];
const storageRoot = path.join(DEPLOY_ROOT, 'storages');
const backend = new JsonStorageBackend(storageRoot);
const domainCtx = {
  logger: { error: () => {}, warn: () => {} },
  effect: (fn) => { fn(); },
  on: () => {},
  storage: { backend: { get: (n) => (n === 'json' ? backend : undefined) } },
};
const facility = new DomainFacility(domainCtx, { backend: 'json', routes: {} });

function makeCtx(getDeps = (n) => null) {
  const onCbs = {};
  return {
    storageDomain: facility,
    effect: (fn) => { fn(); },
    get: (n) => (services[n] ?? getDeps(n)),
    on: (name, cb) => { (onCbs[name] ??= []).push(cb); },
    emit: () => {},
    logger: { warn: (m, e) => warns.push([m, e]), error: () => {}, info: () => {} },
    provide: (name, val) => { services[name] = val; },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
  };
}

// 1) memory
const memoryMod = await importM(path.join(DEPLOY_ROOT, '.agint-bundle', 'plugins', 'agint-evolution-memory', 'lib', 'index.js'));
memoryMod.apply(makeCtx(), {});
console.log('[step1] memory:', !!services['agint.evolution']);

// 2) driver
const driverMod = await importM(path.join(DEPLOY_ROOT, '.agint-bundle', 'plugins', 'agint-evolution-driver', 'lib', 'index.js'));
driverMod.apply(makeCtx(), {});
console.log('[step2] driver:', !!services['agint.evolutionDriver']);

// 3) cron —— 它会调用 services['agint.evolutionDriver'].measureOutcomes()
const cronMod = await importM(path.join(DEPLOY_ROOT, '.agint-bundle', 'plugins', 'agint-cron', 'lib', 'index.js'));
const cronCfg = { jobs: ['evolution-cycle', 'evolution-reconcile', 'outcome-measure'] };
cronMod.apply(makeCtx(), cronCfg);
const cron = services['agint.cron'];
console.log('[step3] cron:', !!cron, 'runNow:', typeof cron?.runNow);

// 4) 调 runNow
const t0 = Date.now();
let out;
try {
  out = await cron.runNow('outcome-measure');
  console.log('[step4] runNow result:', JSON.stringify(out));
} catch (e) {
  console.log('[step4] runNow ERROR:', e.message);
}
console.log('  dt(ms):', Date.now() - t0);

await backend.close();
console.log('done. warns:', warns.length);
