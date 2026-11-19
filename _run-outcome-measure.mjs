// 手动装配 agint-evolution-driver + agint-evolution-memory，跑 measureOutcomes。
// 目的：生产首跑（T11 Step 4），不用 dsh 进程，不造新持久化状态。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEPLOY_ROOT = 'D:\\DSH\\AGINT-date';
const REPO = __dirname;

process.env.DSH_HOME = DEPLOY_ROOT;
process.env.AGINT_HOME = DEPLOY_ROOT;
process.env.AGINT_REPO_ROOT = REPO;
process.env.AGINT_EVOLUTION_DRIVER_REPO_ROOT = REPO;

import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { pathToFileURL } from 'node:url';

function importM(p) { return import(pathToFileURL(p).href); }

const services = {};
const warns = [];

// 起真存储域
const storageRoot = path.join(DEPLOY_ROOT, 'storages');
const backend = new JsonStorageBackend(storageRoot);
const domainCtx = {
  logger: { error: () => {}, warn: () => {} },
  effect: (fn) => { fn(); },
  on: () => {},
  storage: { backend: { get: (n) => (n === 'json' ? backend : undefined) } },
};
const facility = new DomainFacility(domainCtx, { backend: 'json', routes: {} });

function makeCtx(getDeps) {
  return {
    storageDomain: facility,
    effect: (fn) => { fn(); },
    get: getDeps,
    on: () => {},
    logger: { warn: (m, e) => warns.push([m, e]) },
    provide: (name, val) => { services[name] = val; },
  };
}

// 1) memory 插件先上（它是 evolution service 持有者）
const memoryMod = await importM(path.join(DEPLOY_ROOT, '.agint-bundle', 'plugins', 'agint-evolution-memory', 'lib', 'index.js'));
memoryMod.apply(makeCtx(() => null), {});
const evo = services['agint.evolution'];
console.log('[step1] memory mounted:', !!evo, 'ledger.list:', typeof evo?.ledger?.list);

// 2) driver 插件（消费 agint.evolution）
const driverMod = await importM(path.join(DEPLOY_ROOT, '.agint-bundle', 'plugins', 'agint-evolution-driver', 'lib', 'index.js'));
driverMod.apply(makeCtx((n) => (n === 'agint.evolution' ? evo : null)), {});
const driver = services['agint.evolutionDriver'];
console.log('[step2] driver mounted:', !!driver, 'measureOutcomes:', typeof driver?.measureOutcomes);

// 3) 跑
const t0 = Date.now();
const result = await driver.measureOutcomes({});
const dt = Date.now() - t0;

// 4) 落盘后读一遍生产状态，给 T11 验收
await backend.close();

console.log('\n===== outcome-measure result =====');
console.log('ok:', result.ok, 'dt(ms):', dt);
console.log('scanned:', result.scanned, 'measurable:', result.measurable, 'attempted:', result.attempted, 'deferred:', result.deferred);
console.log('counts:', JSON.stringify(result.counts));
if (result.audit) {
  console.log('audit.checked:', result.audit.checked, 'audit.status:', result.audit.status);
}
if (result.buckets) {
  console.log('bucketsWritten:', result.buckets.bucketsWritten, 'sampleTotal:', result.buckets.sampleTotal, 'skipped:', JSON.stringify(result.buckets.skipped));
}
console.log('results:');
for (const r of (result.results ?? [])) {
  console.log(' ', r.contractId, r.status, 'noise=', r.baselineNoiseStd, 'pq=', r.predictionQuality?.toFixed?.(3), 'dZone=', r.isDeadZone, 'delta=', r.actualDelta);
}
console.log('warnings:', warns.length);
console.log('===================================');
