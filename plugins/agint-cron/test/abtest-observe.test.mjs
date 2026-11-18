/**
 * test/abtest-observe.test.mjs — abtest-observe job 接线（方案 §十三）
 *
 * 测 job 层 gating 与委托：服务缺席 soft-skip、repoRoot 未配显式 skip、
 * 无候选对时委托 runObserve 返回 skipped。LLM 路径不在 job 单测里跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defaultJobs } from '../lib/jobs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ABTEST_PLUGIN = pathToFileURL(resolve(__dirname, '../../agint-abtest/lib/index.js')).href;
const REPO_ROOT = resolve(__dirname, '../../..');

const job = defaultJobs.find((j) => j.id === 'abtest-observe');

function makeMockCtx() {
  const providers = {};
  const tables = {};
  return {
    effect: () => {},
    get: () => null,
    provide: (name, val) => { providers[name] = val; },
    storageDomain: {
      open: async () => ({
        async table(name) {
          if (!tables[name]) tables[name] = new Map();
          return {
            put: async (id, v) => { tables[name].set(id, v); return true; },
            get: (id) => tables[name].get(id) ?? null,
            delete: async (id) => { tables[name].delete(id); return true; },
            entries: () => Array.from(tables[name].entries()), // 真实存储域语义：[key,value] 对（2026-11-18 首轮实跑揪出 mock 失真）
            get size() { return tables[name].size; },
          };
        },
      }),
    },
    on: () => {},
    _providers: providers,
  };
}

async function realAbtest() {
  const mod = await import(ABTEST_PLUGIN);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  return ctx._providers['agint.abtest'];
}

test('job 存在且带 schedule/description', () => {
  assert.ok(job, 'defaultJobs 应含 abtest-observe');
  assert.ok(job.schedule);
  assert.ok(job.description);
});

test('abtest 未挂载 → skipped', async () => {
  const r = await job.action({ 'agint.repoRoot': REPO_ROOT });
  assert.equal(r.skipped, true);
});

test('repoRoot 未配 → skipped（不猜目录）', async () => {
  const ab = await realAbtest();
  const r = await job.action({ 'agint.abtest': ab });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /repoRoot/);
});

test('population 未挂载 → skipped', async () => {
  const ab = await realAbtest();
  const r = await job.action({ 'agint.abtest': ab, 'agint.repoRoot': REPO_ROOT });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /population/);
});

test('无候选对 → 委托 runObserve 返回 skipped', async () => {
  const ab = await realAbtest();
  const r = await job.action({
    'agint.abtest': ab,
    'agint.repoRoot': REPO_ROOT,
    'agint.population.stats': async () => ({ variants: [] }),
  });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /candidate/);
});