/**
 * S22-0 golden hash 向量表对拍（设计 §4.3.1 / §6.1 S22-0 / §7.1 首行）
 *
 * ⛔ 本文件是 Ledger 防漂移机制的执行点：仓内有三份确定性序列化
 *   - `plugins/agint-evolution-driver/lib/predictor.js`（交付物 1 hypothesisLock）
 *   - `plugins/agint-evolution-memory/lib/canonical.js`（本插件，Ledger 侧）
 *   - `bin/lib/canonical-json.mjs`（Phase 0，校验脚本侧）
 * 三份各算各的 = 锚点与哈希互相打脸，而**报错形态与真篡改一模一样**
 * （§6.3 风险「三份 canonical 实现漂移」：概率高 / 影响高）。
 *
 * 为什么不能收敛成一份：`install/` 不把 `bin/` 同步进 bundle ⇒ 插件 import
 * `bin/lib/*` 生产直接 `ERR_MODULE_NOT_FOUND`；跨插件 import lib 又违反本仓
 * 零跨插件耦合纪律 ⇒ 多副本是结构性的，只能锁死行为。
 *
 * 测试期跨插件 import 是允许的（运行期插件互不 import；先例：
 * driver 的 contract-manager.test.mjs 直接 import 本插件的 schema.js）。
 *
 * Run: node --test plugins/agint-evolution-memory/test/ledger-vectors.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  canonicalStringify as memCanonical,
  canonicalHash as memHash,
  GENESIS_PARENT_HASH,
} from '../lib/canonical.js';
import {
  computeEntryHash,
  computeBatchRoot,
  computeRollupRoot,
  buildBatchPath,
  verifyBatchPath,
  LEDGER_BATCH_SIZE,
} from '../lib/ledger-hash.js';
import { canonicalStringify as driverCanonical } from '../../agint-evolution-driver/lib/predictor.js';
import { canonicalStringify as binCanonical } from '../../../bin/lib/canonical-json.mjs';

// test → agint-evolution-memory → plugins → 仓根
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const vectors = JSON.parse(readFileSync(join(repoRoot, 'fixtures', 'ledger-hash-vectors.json'), 'utf8'));
const IMPLS = [['memory', memCanonical], ['driver', driverCanonical], ['bin', binCanonical]];
const inputOf = (v) => (v.inputJson !== undefined ? JSON.parse(v.inputJson) : v.input);

test('向量表元数据与规格常量一致', () => {
  assert.equal(vectors.batchSize, LEDGER_BATCH_SIZE);
  assert.equal(vectors.algorithm, 'sha256');
  // ⛔ 创世常量必须是字面量，不接受推导或外部读取（§4.3.2）
  assert.equal(GENESIS_PARENT_HASH, `sha256:${'0'.repeat(64)}`);
  assert.equal(vectors.genesisParentHash, GENESIS_PARENT_HASH);
  assert.ok(vectors.canonical.length >= 8, 'canonical 向量至少 8 条（§6.1 S22-0）');
  assert.ok(vectors.entryHash.length >= 3);
});

for (const v of vectors.canonical) {
  test(`canonical 三份实现逐字节一致：${v.name}`, () => {
    const value = inputOf(v);
    for (const [name, fn] of IMPLS) {
      assert.equal(fn(value), v.expectedCanonical, `${name} 侧与向量表不符`);
    }
    assert.equal(memHash(value), v.expectedSha256);
    if (v.alsoInput) {
      for (const [name, fn] of IMPLS) {
        assert.equal(fn(v.alsoInput), v.expectedCanonical, `${name} 侧插入顺序漂移`);
      }
    }
  });
}
for (const v of vectors.entryHash) {
  test(`entryHash 与向量表一致：${v.name}`, () => {
    assert.equal(computeEntryHash(v.entry), v.expectedEntryHash);
    assert.match(v.expectedEntryHash, /^sha256:[0-9a-f]{64}$/);
  });
}

for (const v of vectors.invariance) {
  test(`哈希入参边界（同事实同摘要）：${v.name}`, () => {
    assert.equal(computeEntryHash(v.entryA), v.expectedEntryHash, v.note);
    assert.equal(computeEntryHash(v.entryB), v.expectedEntryHash, v.note);
  });
}

test('post_writeback_fields_excluded：回写 anchorStatus 后 entryHash 不变（验收 2c）', () => {
  const v = vectors.invariance.find((x) => x.name === 'post_writeback_fields_excluded');
  assert.ok(v, '向量表缺该用例');
  const before = computeEntryHash(v.entryA);
  const after = computeEntryHash(v.entryB);
  assert.equal(before, after);
  // 反向确认两条例子确实只在回写字段上不同（否则用例是空跑）
  const diffKeys = Object.keys(v.entryB).filter((k) => JSON.stringify(v.entryA[k]) !== JSON.stringify(v.entryB[k]));
  assert.deepEqual(diffKeys.sort(), ['anchorSeq', 'anchorStatus', 'evidenceCompleteness', 'integrity', 'reconstructed']);
});

for (const v of vectors.merkle.batchRoot) {
  test(`Merkle 批根与向量表一致：${v.name}`, () => {
    assert.equal(computeBatchRoot(v.leaves), v.expectedBatchRoot);
  });
}

for (const v of vectors.merkle.path) {
  test(`批内 path 自校验复原批根：${v.name}`, () => {
    const path = buildBatchPath(v.leaves, v.leafIndex);
    assert.deepEqual(path, v.expectedPath);
    assert.equal(verifyBatchPath(v.leaves[v.leafIndex], path), v.expectedBatchRoot);
  });
}

test('Merkle 批内 path 对每个叶子都能复原批根（交叉验证两套实现）', () => {
  for (const v of vectors.merkle.batchRoot) {
    v.leaves.forEach((leaf, i) => {
      assert.equal(verifyBatchPath(leaf, buildBatchPath(v.leaves, i)), v.expectedBatchRoot, `${v.name} leaf ${i}`);
    });
  }
});

test('叶子顺序反转必须改变批根（证明没有偷偷排序）', () => {
  const s = vectors.merkle.orderSensitivity;
  assert.equal(computeBatchRoot(s.leaves), s.expectedBatchRoot);
  assert.notEqual(s.expectedBatchRoot, s.differsFrom);
});

for (const v of vectors.rollup) {
  test(`roll-up 根链与向量表一致：${v.name}`, () => {
    assert.equal(computeRollupRoot(v.batchRoots), v.expectedRollupRoot);
  });
}

test('rollupRoot(0) 即创世常量（§4.3.3）', () => {
  assert.equal(computeRollupRoot([]), GENESIS_PARENT_HASH);
});

test('非有限数字 / bigint 在三份实现里都必须抛错（撞 hash 即漏检）', () => {
  const cases = [
    ['NaN', { v: Number.NaN }],
    ['Infinity', { v: Number.POSITIVE_INFINITY }],
    ['-Infinity', { v: Number.NEGATIVE_INFINITY }],
    ['bigint', { v: 10n }],
    ['function', { v: () => 0 }],
  ];
  for (const [name, value] of cases) {
    for (const [impl, fn] of IMPLS) {
      assert.throws(() => fn(value), TypeError, `${impl} 侧 ${name} 未抛错`);
    }
  }
});

test('空批没有 batchRoot（§4.3.3 fail-closed）', () => {
  assert.throws(() => computeBatchRoot([]), /空批/);
});

