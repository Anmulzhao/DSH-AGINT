/**
 * agint-evolution-memory: Merkle proof 生成与自校验（§4.3.3 / §4.5 / §4.6 #3）
 *
 * §4.6 #3 的判据是「单元测试 ≥10 case（含奇数节点、单节点批、跨批、满批）」。
 * 这里跑的是**真实服务写入的链**（不是手搓的哈希数组），所以同时覆盖了两件事：
 *   - 批结构本身（叶子分组、奇数自配对、path 形状、roll-up 前缀）
 *   - 服务写入的值确实能被 proof 复原（写读闭环）
 *
 * ⚠️ 语义提醒（lib/ledger-hash.js buildProof 注释）：proof 比对的是**批末条**
 * 存的滚动根（这批的最终值），不是目标条目入链那一刻存的部分根。
 *
 * Run: node --test plugins/agint-evolution-memory/test/ledger-proof.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLedgerService } from '../lib/ledger.js';
import { canonicalStringify } from '../lib/canonical.js';
import {
  LEDGER_BATCH_SIZE,
  batchOf,
  computeBatchRoot,
  computeRollupRoot,
  verifyBatchPath,
  verifyProof,
} from '../lib/ledger-hash.js';

const FIXED_NOW = () => '2026-10-02T08:00:00.000Z';

function makeTable() {
  const records = new Map();
  return {
    records,
    entries: () => [...records.entries()][Symbol.iterator](),
    keys: () => [...records.keys()][Symbol.iterator](),
    get: (k) => records.get(k),
    get size() { return records.size; },
    async put(k, v) { records.set(k, v); return true; },
  };
}

let n = 0;
/** 造一条 service 并追加 count 条，返回 { svc, table, entries }。 */
async function buildChain(count, { timestamp = FIXED_NOW } = {}) {
  const table = makeTable();
  const svc = createLedgerService({ getTable: async () => table, now: timestamp, warn: () => {}, bump: () => {} });
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push((await svc.appendEntry({
      contractId: `EVO-P${++n}`,
      generation: `GEN-${String(Math.floor(i / 4) + 1).padStart(3, '0')}`,
      summary: {
        mutationType: 'PROMPT_MUTATION',
        changedPlugins: ['agint-mutator'],
        targetMetric: 'aesthetic_pass_rate',
        hypothesisDigest: `h${i}`,
        predictedDelta: 0.01 * (i + 1),
        actualDelta: 0.009 * (i + 1),
        decision: i % 3 === 0 ? 'REJECT' : 'AUTO_DEPLOY',
      },
      references: { abTestId: `AB-${i}` },
    })).entry);
  }
  return { svc, table, entries };
}

/** 该批的批末条（proof 的权威比对对象）。 */
function boundaryOf(entries, seq) {
  const { batchIndex } = batchOf(seq);
  const inBatch = entries.filter((e) => batchOf(e.seq).batchIndex === batchIndex);
  return inBatch[inBatch.length - 1];
}

// ── #1-#4：四种批形状 ─────────────────────────────────────────────────────

test('case 1 满批：8 条恰好一批，每条 proof 都能对批末条复原', async () => {
  const { svc, entries } = await buildChain(LEDGER_BATCH_SIZE);
  const boundary = entries[7];
  for (const e of entries) {
    const proof = await svc.proofFor(e.seq);
    assert.equal(proof.batchLeafCount, LEDGER_BATCH_SIZE);
    assert.equal(proof.batchIndex, 1);
    assert.deepEqual(proof.priorBatchRoots, [], '首批没有前缀根');
    assert.equal(proof.boundaryMerkleRoot, boundary.chain.merkleRoot);
    assert.ok(verifyProof(proof, { expectedMerkleRoot: boundary.chain.merkleRoot }).ok, `seq=${e.seq}`);
  }
});

test('case 2 单叶批：第 9 条独占新批，批根 = h(leaf+leaf)', async () => {
  const { svc, entries } = await buildChain(LEDGER_BATCH_SIZE + 1);
  const ninth = entries[8];
  const { batchIndex, leafIndex } = batchOf(9);
  assert.equal(batchIndex, 2);
  assert.equal(leafIndex, 0);
  const proof = await svc.proofFor(9);
  assert.equal(proof.batchLeafCount, 1);
  assert.equal(proof.path.length, 0, '单叶批没有兄弟节点');
  assert.equal(proof.batchRoot, computeBatchRoot([ninth.chain.entryHash]));
  assert.deepEqual(proof.priorBatchRoots.map((r) => r.batchIndex), [1]);
  assert.ok(verifyProof(proof, { expectedMerkleRoot: ninth.chain.merkleRoot }).ok);
});

test('case 3 奇数节点批：11 条 ⇒ 第三批 3 叶，末位与自身配对', async () => {
  const { svc, entries } = await buildChain(11);
  const thirdBatch = entries.slice(8);
  assert.equal(thirdBatch.length, 3);
  const boundary = thirdBatch[2];
  assert.equal(boundary.chain.batchRoot, computeBatchRoot(thirdBatch.map((e) => e.chain.entryHash)));
  for (const e of thirdBatch) {
    const proof = await svc.proofFor(e.seq);
    // 奇数批里最后一个叶子的 path 必须带 'self' 标记（自配对，不是上抛）
    if (e.seq === 11) assert.ok(proof.path.some((p) => p.side === 'self'), '末位奇节点应标 self');
    assert.ok(verifyProof(proof, { expectedMerkleRoot: boundary.chain.merkleRoot }).ok, `seq=${e.seq}`);
  }
});

test('case 4 跨批：第二批的 proof 携带第一批根，roll-up 重放得到批末条的根', async () => {
  const { svc, entries } = await buildChain(20);
  const proof = await svc.proofFor(15);
  assert.equal(proof.batchIndex, 2);
  assert.deepEqual(proof.priorBatchRoots.map((r) => r.batchIndex), [1]);
  const replay = computeRollupRoot([...proof.priorBatchRoots.map((r) => r.batchRoot), proof.batchRoot]);
  assert.equal(replay, proof.merkleRoot);
  assert.equal(proof.boundaryMerkleRoot, entries[15].chain.merkleRoot, '批 2 = seq 9-16，批末条 seq 16');
  assert.ok(verifyProof(proof, { expectedMerkleRoot: entries[15].chain.merkleRoot }).ok);
});

// ── #5-#8：结构不变量 ─────────────────────────────────────────────────────

test('case 5 path 深度 ≤3（8 叶 ⇒ 4→2→1），且每步都是复原批根的必要信息', async () => {
  const { svc } = await buildChain(20);
  for (let seq = 1; seq <= 20; seq++) {
    const proof = await svc.proofFor(seq);
    assert.ok(proof.path.length <= 3, `seq=${seq} path 深度 ${proof.path.length}`);
    assert.equal(verifyBatchPath(proof.entryHash, proof.path), proof.batchRoot);
  }
});

test('case 6 前缀根数量恒等于 batchIndex-1（roll-up 定位批次的唯一依据）', async () => {
  const { svc } = await buildChain(20);
  for (let seq = 1; seq <= 20; seq++) {
    const proof = await svc.proofFor(seq);
    assert.equal(proof.priorBatchRoots.length, proof.batchIndex - 1, `seq=${seq}`);
  }
});

test('case 7 proof 里不含条目自带的部分根 —— 批内每条的 path 互不相同', async () => {
  const { svc, entries } = await buildChain(9);
  const paths = await Promise.all(entries.slice(0, 8).map((e) => svc.proofFor(e.seq)));
  const serialized = new Set(paths.map((p) => canonicalStringify(p.path)));
  assert.equal(serialized.size, 8, '同一批里 8 个叶子的兄弟路径必须两两不同（否则定位不唯一）');
  // 部分根不入 proof：proof 只给最终批根 + 批末条根。
  // 批内非末条存的是入链那一刻的部分根（必然 ≠ 最终根）；末条存的正是最终根。
  for (const [i, p] of paths.entries()) {
    if (i === 7) assert.equal(p.merkleRoot, entries[i].chain.merkleRoot, '批末条的存量即这批的最终根');
    else assert.notEqual(p.merkleRoot, entries[i].chain.merkleRoot, `seq=${i + 1} 入链时刻的部分根 ≠ 批的最终根`);
  }
});

test('case 8 未锚定的条目 proof.anchor 为 null；锚定回写后带 anchorSeq', async () => {
  const { svc, table } = await buildChain(3);
  const before = await svc.proofFor(2);
  assert.equal(before.anchor, null);
  await svc.markAnchored({ anchorSeq: 1, fromSeq: 1, toSeq: 3 });
  const after = await svc.proofFor(2);
  assert.deepEqual(after.anchor, { anchorSeq: 1 });
  assert.equal(table.get('2').anchorStatus, 'ANCHORED');
});

// ── #9-#12：篡改与异常必须被 proof 抓出 ──────────────────────────────────

test('case 9 改一个叶子的 entryHash ⇒ 同批全部 proof 变红', async () => {
  const { svc, table, entries } = await buildChain(10);
  table.get('3').chain.entryHash = `sha256:${'d'.repeat(64)}`;
  for (const e of entries.slice(0, 8)) {
    const proof = await svc.proofFor(e.seq);
    const res = verifyProof(proof, { expectedMerkleRoot: boundaryOf(entries, e.seq).chain.merkleRoot });
    assert.equal(res.ok, false, `seq=${e.seq} 应被识破`);
    assert.ok(
      ['BATCH_ROOT_MISMATCH', 'BATCH_BOUNDARY_DRIFT', 'MERKLE_ROOT_MISMATCH'].includes(res.reason),
      `失效原因应明确，实为 ${res.reason}`,
    );
  }
});

test('case 10 批末条的 merkleRoot 被伪造 ⇒ BATCH_BOUNDARY_DRIFT（不信任被改的那份）', async () => {
  const { svc, table, entries } = await buildChain(8);
  table.get('8').chain.merkleRoot = `sha256:${'b'.repeat(64)}`;
  const proof = await svc.proofFor(1);
  const res = verifyProof(proof);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'BATCH_BOUNDARY_DRIFT');
  assert.equal(entries[0].chain.entryHash, proof.entryHash, '被识破的是根，不是叶子本身');
});

test('case 11 前缀根数量被截 ⇒ PRIOR_ROOTS_COUNT（防"少给一批"的 proof）', async () => {
  const { svc } = await buildChain(12);
  const proof = await svc.proofFor(12);
  assert.equal(proof.batchIndex, 2);
  const truncated = { ...proof, priorBatchRoots: [] };
  const res = verifyProof(truncated);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'PRIOR_ROOTS_COUNT');
});

test('case 12 期望根不符 / seq 不在链上 / proof 形状非法 ⇒ 各自明确失败', async () => {
  const { svc } = await buildChain(9);
  const proof = await svc.proofFor(9);
  const wrong = verifyProof(proof, { expectedMerkleRoot: `sha256:${'1'.repeat(64)}` });
  assert.equal(wrong.reason, 'MERKLE_ROOT_MISMATCH');
  await assert.rejects(() => svc.proofFor(99), /不在链上/);
  assert.equal(verifyProof(null).reason, 'PROOF_MALFORMED');
  assert.equal(verifyProof({ ...proof, path: 'nope' }).reason, 'PATH_MALFORMED');
});

test('case 13 proof 可 JSON 序列化（无 undefined / 函数），能直接进 --entry 输出与进化包', async () => {
  const { svc } = await buildChain(9);
  for (const seq of [1, 5, 8, 9]) {
    const proof = await svc.proofFor(seq);
    const text = canonicalStringify(proof);
    assert.equal(JSON.parse(text).seq, seq);
    assert.doesNotMatch(text, /undefined/, '序列化后不得出现 undefined 槽位');
  }
});
