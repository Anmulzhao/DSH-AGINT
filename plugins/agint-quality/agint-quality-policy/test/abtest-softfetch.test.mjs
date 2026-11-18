/**
 * test/abtest-softfetch.test.mjs — policy decide() 软取 abtest（方案 v2.1 §九.3 方案 B）
 *
 * 仿 effectiveDelta 先例：decide() 内软取 agint.abtest._internal.results()
 * 与 agint.quality.getConfig().abtest。调用方显式传值优先；服务缺席不拖垮决策。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = pathToFileURL(resolve(__dirname, '../lib/index.js')).href;

const ENABLED_CFG = { enabled: true, weight: 0.10, minSamples: 10, pValueThreshold: 0.05 };

function synthResult() {
  return {
    target: { id: 'unit-x', kind: 'plugin-postimage' },
    dimensions: [
      { key: 'safety', name: 'safety', score: { score: 1.0, veto: false } },
      { key: 'trust', name: 'trust', score: { score: 1.0, veto: false } },
    ],
    ok: true,
  };
}

function makeCtx({ abtestResults = null, contractAbtest = null, resultsThrows = false } = {}) {
  const providers = {};
  const services = {
    'agint.abtest': abtestResults === null ? null : {
      _internal: {
        results: async () => {
          if (resultsThrows) throw new Error('abtest storage down');
          return abtestResults;
        },
      },
    },
    'agint.quality': contractAbtest === null ? null : { getConfig: () => ({ abtest: contractAbtest }) },
  };
  return {
    effect: () => {},
    get: (k) => services[k] ?? null,
    provide: (name, val) => { providers[name] = val; },
    on: () => {},
    _providers: providers,
  };
}

async function decideWith(ctx, args = {}) {
  const mod = await import(POLICY_PATH);
  mod.apply(ctx, {});
  const policy = ctx._providers['agint.qualityPolicy'];
  return await policy.decide({ results: [synthResult()], ...args });
}

test('软取生效：contract enabled + 有终态结果 → abtest 维度进综合分', async () => {
  const inconclusive = [{ testId: 'abt-1', winner: 'inconclusive', pValue: 0.4, effectSize: 0.1, samples: 24 }];
  const withAbtest = await decideWith(makeCtx({ abtestResults: inconclusive, contractAbtest: ENABLED_CFG }));
  const baseline = await decideWith(makeCtx({}));
  assert.ok(withAbtest.perTarget[0].score < baseline.perTarget[0].score,
    `inconclusive(0.5) 应拉低综合分：${withAbtest.perTarget[0].score} vs ${baseline.perTarget[0].score}`);
});

test('contract enabled=false → 不进维度（与无服务同分）', async () => {
  const winner = [{ testId: 'abt-1', winner: 'A', pValue: 0.01, effectSize: 0.8, samples: 24 }];
  const disabled = await decideWith(makeCtx({ abtestResults: winner, contractAbtest: { ...ENABLED_CFG, enabled: false } }));
  const baseline = await decideWith(makeCtx({}));
  assert.equal(disabled.perTarget[0].score, baseline.perTarget[0].score);
});

test('调用方显式 options.abtestResults 优先于软取', async () => {
  const soft = [{ testId: 'soft', winner: 'inconclusive', pValue: 0.4, effectSize: 0.1, samples: 24 }];
  const explicit = [{ testId: 'explicit', winner: 'A', pValue: 0.001, effectSize: 0.9, samples: 24 }];
  const d = await decideWith(
    makeCtx({ abtestResults: soft, contractAbtest: ENABLED_CFG }),
    { options: { abtestResults: explicit } },
  );
  const baseline = await decideWith(makeCtx({}));
  assert.ok(d.perTarget[0].score >= baseline.perTarget[0].score, '显式 winner=1.0 不应低于基线');
});

test('overrideConfig.abtest 优先于 contract 配置', async () => {
  const winner = [{ testId: 'abt-1', winner: 'inconclusive', pValue: 0.4, effectSize: 0.1, samples: 24 }];
  const d = await decideWith(
    makeCtx({ abtestResults: winner, contractAbtest: { ...ENABLED_CFG, enabled: false } }),
    { config: { abtest: ENABLED_CFG } },
  );
  const baseline = await decideWith(makeCtx({}));
  assert.ok(d.perTarget[0].score < baseline.perTarget[0].score, 'override enabled=true 应生效');
});

test('软取抛错 → 决策照常（不拖垮）', async () => {
  const d = await decideWith(makeCtx({ abtestResults: [], contractAbtest: ENABLED_CFG, resultsThrows: true }));
  const baseline = await decideWith(makeCtx({}));
  assert.equal(d.perTarget[0].score, baseline.perTarget[0].score);
  assert.ok(['AUTO_DEPLOY', 'PENDING_REVIEW', 'REJECT'].includes(d.kind));
});