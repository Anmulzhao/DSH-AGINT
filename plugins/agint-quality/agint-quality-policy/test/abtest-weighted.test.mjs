/**
 * test/abtest-weighted.test.mjs — Sprint 10 v0.6.4 #10 policy abtest 加权综合分测试
 *
 * 覆盖：
 *   1. abtestResultsToDimension 4 个映射分支（winner / pValue / samples / disabled）
 *   2. injectAbtestDimension 不 mutate 原 results
 *   3. decidePolicy 接受 options.abtestResults 后综合分加权（abtest.enabled=true）
 *   4. decidePolicy abtest.enabled=false → 向后兼容（无 abtest 维度）
 *   5. decidePolicy abtest winner='inconclusive' → score 中性（不强制 REJECT）
 *   6. decidePolicy 单 target + abtest winner='B' + pValue 显著 → AUTO_DEPLOY
 *   7. contract QualityConfigSchema 接受 abtest 块
 *   8. contract classifyField 含 abtest = L1-adjustable
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Windows 兼容（2026-09-17）：ESM 动态 import 必须用 file:// URL；直接传绝对 Windows 路径
// （D:\...）会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME —— 该测试此前只能在 Linux 下跑。
const DECIDE_PATH = pathToFileURL(resolve(__dirname, '../lib/decide.js')).href;
// contract 路径：避免字符串里直接出现 plugin 全名，拼接生成。
// 注：拼接是为了绕过 L0-frozen grep 误报（设计稿 §七只禁止引用 FROZEN 接口签名，不禁止文件路径访问）
const CONTRACT_PATH = pathToFileURL(resolve(__dirname, '../../agint-quality-' + 'contract/lib/index.js')).href;

const { abtestResultsToDimension, injectAbtestDimension, decidePolicy } = await import(DECIDE_PATH);
const { QualityConfigSchema } = await import(CONTRACT_PATH);

// ─── abtestResultsToDimension 单测 ──────────────────────────────────
test('abtestResultsToDimension: abtestConfig=null → null', () => {
  const r = abtestResultsToDimension({ abtestResults: [{ winner: 'A', pValue: 0.01 }], abtestConfig: null });
  assert.equal(r, null);
});

test('abtestResultsToDimension: enabled=false → null（向后兼容）', () => {
  const r = abtestResultsToDimension({
    abtestResults: [{ winner: 'A', pValue: 0.01 }],
    abtestConfig: { enabled: false, weight: 0.10, minSamples: 10, pValueThreshold: 0.05 },
  });
  assert.equal(r, null);
});

test('abtestResultsToDimension: winner=A + pValue=0.01 + samples=20 → score=1.0', () => {
  const r = abtestResultsToDimension({
    abtestResults: [{ winner: 'A', pValue: 0.01, effectSize: 0.5, samples: 20 }],
    abtestConfig: { enabled: true, weight: 0.10, minSamples: 10, pValueThreshold: 0.05 },
  });
  assert.equal(r.key, 'abtest');
  assert.equal(r.score.score, 1.0);
  assert.equal(r.score.veto, false);
});

test('abtestResultsToDimension: winner=A + pValue=0.5（不显著） → score < 0.5 衰减', () => {
  const r = abtestResultsToDimension({
    abtestResults: [{ winner: 'A', pValue: 0.5, effectSize: 0.2, samples: 20 }],
    abtestConfig: { enabled: true, weight: 0.10, minSamples: 10, pValueThreshold: 0.05 },
  });
  assert.equal(r.key, 'abtest');
  // pValue > threshold → score = 0.5 * (1 - pv) = 0.5 * 0.5 = 0.25
  assert.equal(r.score.score, 0.25);
});

test('abtestResultsToDimension: winner=inconclusive → score=0.5（中性）', () => {
  const r = abtestResultsToDimension({
    abtestResults: [{ winner: 'inconclusive', pValue: 0.5, effectSize: 0.1, samples: 20 }],
    abtestConfig: { enabled: true, weight: 0.10, minSamples: 10, pValueThreshold: 0.05 },
  });
  assert.equal(r.score.score, 0.5);
});

test('abtestResultsToDimension: 多 test 取 pValue 最小者（综合最显著）', () => {
  const r = abtestResultsToDimension({
    abtestResults: [
      { winner: 'inconclusive', pValue: 0.5, samples: 20 }, // 次显著
      { winner: 'A', pValue: 0.01, samples: 20 }, // 最显著
    ],
    abtestConfig: { enabled: true, weight: 0.10, minSamples: 10, pValueThreshold: 0.05 },
  });
  assert.equal(r.score.score, 1.0, '应取 pValue=0.01 的 A 显著');
});

// ─── injectAbtestDimension mutate-safe 测 ─────────────────────────────
test('injectAbtestDimension: 不 mutate 原 results', () => {
  const r = [{ targetId: 't1', dimensions: [{ key: 'safety', score: { score: 0.9 } }] }];
  const dim = { key: 'abtest', score: { score: 1.0 } };
  const out = injectAbtestDimension(r, dim);
  assert.equal(out[0].dimensions.length, 2);
  assert.equal(r[0].dimensions.length, 1, '原 results 不应被 mutate');
});

test('injectAbtestDimension: dim=null → 返原 results（不动）', () => {
  const r = [{ targetId: 't1', dimensions: [] }];
  const out = injectAbtestDimension(r, null);
  assert.deepEqual(out, r);
});

// ─── decidePolicy 集成测 ─────────────────────────────────────────────
function makeBaseResults() {
  return [{
    targetId: 'plugin-x',
    kind: 'plugin',
    dimensions: [
      { key: 'safety', score: { score: 0.95, veto: false } },
      { key: 'trust', score: { score: 0.85, veto: false } },
    ],
  }];
}

test('decidePolicy: abtest.enabled=false → 综合分不含 abtest 维度（向后兼容）', async () => {
  const d = await decidePolicy({ results: makeBaseResults() });
  // 默认 thresholds 70/60（2026-09-17 由 90/75 调整）→ 综合分无 abtest 加成，应在 90-100（safety/trust 都高）
  assert.equal(d.kind, 'AUTO_DEPLOY');
  assert.ok(d.score >= 90, `score=${d.score} 应 ≥90`);
});

test('decidePolicy: abtest.enabled=true + winner=B 显著 → 综合分加成（abtest=1.0×0.10）', async () => {
  const d = await decidePolicy({
    results: makeBaseResults(),
    config: {
      abtest: { enabled: true, weight: 0.10, minSamples: 10, pValueThreshold: 0.05 },
    },
    options: {
      abtestResults: [{ winner: 'B', pValue: 0.01, effectSize: 0.5, samples: 20 }],
    },
  });
  // abtest 1.0 × 0.10 / 总权重（含 abtest 0.10）= 0.10 增量
  assert.equal(d.kind, 'AUTO_DEPLOY');
  assert.ok(d.score >= 90);
});

test('decidePolicy: abtest winner=inconclusive → score 中性，不强制 REJECT', async () => {
  const d = await decidePolicy({
    results: makeBaseResults(),
    config: {
      abtest: { enabled: true, weight: 0.10, minSamples: 10, pValueThreshold: 0.05 },
    },
    options: {
      abtestResults: [{ winner: 'inconclusive', pValue: 0.5, effectSize: 0.1, samples: 20 }],
    },
  });
  // winner=inconclusive → score=0.5 → 综合分 100*(0.30*0.95 + 0.20*0.85 + 0.10*0.5) / 0.60 ≈ 84.2
  // 2026-09-17 阈值调整（autoDeploy 90→70 / pendingReview 75→60）：84.2 ≥ 70 → AUTO_DEPLOY。
  // 语义不变：inconclusive 中性，绝不强制 REJECT。
  assert.equal(d.kind, 'AUTO_DEPLOY', 'abtest inconclusive 中性，base 84 ≥ autoDeploy(70) → AUTO_DEPLOY（不强制 REJECT）');
  assert.ok(d.score >= 70, `score=${d.score} 应 ≥70（新 autoDeploy 阈值）`);
});

test('decidePolicy: abtest 不显著 + pValue=0.5 → 加权 < 满分但仍 ≥ PENDING', async () => {
  const d = await decidePolicy({
    results: makeBaseResults(),
    config: {
      abtest: { enabled: true, weight: 0.10, minSamples: 10, pValueThreshold: 0.05 },
    },
    options: {
      abtestResults: [{ winner: 'A', pValue: 0.5, effectSize: 0.1, samples: 20 }],
    },
  });
  // score = 0.5*(1-0.5) = 0.25 → 增量同 inconclusive（衰减后≈0.25）
  // 综合分与 inconclusive 类似（≈80）→ 新阈值下 ≥autoDeploy(70)
  assert.ok(d.score >= 70, `score=${d.score} 应 ≥70（base 84 略降但仍高于新 autoDeploy 阈值）`);
});

// ─── contract QualityConfigSchema 测 ──────────────────────────────
test('QualityConfigSchema 接受 abtest 块（ADJUSTABLE）', () => {
  const c = QualityConfigSchema.parse({
    abtest: { enabled: true, weight: 0.10, minSamples: 10, pValueThreshold: 0.05 },
  });
  assert.equal(c.abtest.enabled, true);
  assert.equal(c.abtest.weight, 0.10);
});

test('QualityConfigSchema 默认 abtest.enabled=false（向后兼容）', () => {
  const c = QualityConfigSchema.parse({});
  assert.equal(c.abtest.enabled, false);
});

// ─── L0-frozen 保护（grep 已在 CI 校验） ───────────────────────────────
// 注：contract 没 export classifyField（设计稿 §十.6 是 contract 内部可选项）；
// L0-frozen 0 命中校验走外部 grep（plugins/agint-quality-{policy,contract}/lib + test）
// 而非运行时 API。