/**
 * §4.3.1 确定性四来源 + canonical 契约单元测试
 *
 * 与 ledger-vectors.test.mjs 的分工：向量表锁「三份实现一致」，本文件锁
 * 「行为本身的边界」—— JSON 表达不了的 undefined 键、量化边界、以及
 * 「哪些字段参与哈希」这类只有构造特例才能测的判据。
 *
 * Run: node --test plugins/agint-evolution-memory/test/ledger-canonical.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalStringify,
  canonicalHash,
  concatHash,
  quantizeNumber,
  prepareHashInput,
  assertUtcMillisIso,
  GENESIS_PARENT_HASH,
  HASH_DECIMALS,
} from '../lib/canonical.js';
import { computeEntryHash, projectEntryHashInput } from '../lib/ledger-hash.js';

const clone = (o) => JSON.parse(JSON.stringify(o));

test('undefined 值键整个省略，null 值保留（契约 ④，JSON 向量表无法表达）', () => {
  assert.equal(canonicalStringify({ a: undefined, b: null }), '{"b":null}');
  assert.notEqual(canonicalStringify({ a: undefined }), canonicalStringify({ a: null }));
});

test('数组里的 undefined 槽位序列化为 null（与 JSON.stringify 对齐）', () => {
  assert.equal(canonicalStringify([undefined, 1]), '[null,1]');
});

test('key 按 Unicode 码点排序（大写先于小写，代理对不错位）', () => {
  assert.equal(canonicalStringify({ b: 1, a: 2, B: 3 }), '{"B":3,"a":2,"b":1}');
  const emoji = String.fromCodePoint(0x1f600); // U+1F600，需代理对表示
  const bmpMax = String.fromCodePoint(0xffff);
  // 按码点：U+FFFF 先于 U+1F600；按 UTF-16 码元会把代理对排到前面
  const s = canonicalStringify({ [emoji]: 'astral', [bmpMax]: 'bmp' });
  assert.equal(s, `{${JSON.stringify(bmpMax)}:"bmp",${JSON.stringify(emoji)}:"astral"}`);
});

test('-0 归一为 0（跨语言/跨环境不得因符号位产出两种字节）', () => {
  assert.equal(canonicalStringify({ z: -0 }), '{"z":0}');
  assert.equal(canonicalStringify({ z: -0 }), canonicalStringify({ z: 0 }));
});

test('非有限数字与 bigint / function / symbol 抛错，不静默变 null（契约 5）', () => {
  for (const bad of [NaN, Infinity, -Infinity, 10n, () => 1, Symbol('s')]) {
    assert.throws(() => canonicalStringify({ v: bad }), TypeError);
  }
  assert.throws(() => canonicalHash({ v: NaN }), TypeError);
});

test('中文字符串不转义为 \\u 序列（UTF-8 原样，跨环境一致）', () => {
  assert.equal(canonicalStringify({ 键: '值' }), '{"' + '键' + '":"' + '值' + '"}');
});
test('quantizeNumber：量化到 4 位、-0 归一、整数不变、越界抛错（§4.3.1 ②）', () => {
  assert.equal(quantizeNumber(0.9400000000000001), 0.94);
  assert.equal(quantizeNumber(1 / 3), 0.3333);
  assert.equal(quantizeNumber(-1.4), -1.4);
  assert.ok(Object.is(quantizeNumber(-0.00001), 0), '量化后必须是 +0，不得残留 -0');
  for (const bad of [NaN, Infinity, 1e21, -1e21]) {
    assert.throws(() => quantizeNumber(bad), TypeError);
  }
  assert.equal(HASH_DECIMALS, 4);
});

test('prepareHashInput：纯字符串数组排序、混合数组保序、且不改动入参（§4.3.1 ③）', () => {
  const src = { s: ['b-plugin', 'a-plugin'], m: [2, 'a', 1] };
  const out = prepareHashInput(src);
  assert.deepEqual(out.s, ['a-plugin', 'b-plugin']);
  assert.deepEqual(out.m, [2, 'a', 1], '混合类型数组保序（顺序可能有意义）');
  assert.deepEqual(src.s, ['b-plugin', 'a-plugin'], '⛔ 归一不得改写存储值');
});

test('prepareHashInput：Set 转排序数组，Map 直接抛错', () => {
  assert.deepEqual(prepareHashInput({ t: new Set(['z', 'a', 'M']) }), { t: ['M', 'a', 'z'] });
  assert.throws(() => prepareHashInput({ t: new Map([['a', 1]]) }), TypeError);
});

test('assertUtcMillisIso：只接受 UTC + 3 位毫秒 + Z，且必须是真实时刻（§4.3.1 ①）', () => {
  assert.equal(assertUtcMillisIso('2026-10-29T04:15:00.000Z'), '2026-10-29T04:15:00.000Z');
  for (const bad of [
    '2026-10-29T04:15:00Z',            // 缺毫秒
    '2026-10-29T04:15:00.00Z',         // 两位毫秒
    '2026-10-29T12:15:00.000+08:00',   // 本地时区偏移
    '2026-10-29 04:15:00.000Z',        // 空格分隔
    '2026-10-29',                       // 仅日期
    '2026-02-31T00:00:00.000Z',         // 形状合规但 2 月没有 31 日（V8 会顺延，必须拒）
    123,
    null,
  ]) {
    assert.throws(() => assertUtcMillisIso(bad), TypeError, `应拒绝: ${String(bad)}`);
  }
});
const sample = () => ({
  seq: 1,
  contractId: 'EVO-T-1',
  generation: 'GEN-T-1',
  summary: {
    mutationType: 'PROMPT_MUTATION',
    changedPlugins: ['agint-evolution-driver'],
    targetMetric: 'SUCCESS_RATE',
    hypothesisDigest: 'digest',
    predictedDelta: 1,
    actualDelta: 0.5,
    predictionQuality: 0.8,
    predictionSource: 'DEFAULT_RULE',
    decision: 'AUTO_DEPLOY',
  },
  chain: {
    entryHash: 'sha256:' + 'a'.repeat(64),
    parentHash: GENESIS_PARENT_HASH,
    batchRoot: 'sha256:' + 'b'.repeat(64),
    merkleRoot: 'sha256:' + 'c'.repeat(64),
  },
  references: { contractHash: null, lockEventId: null, eventBusIds: [] },
  timestamp: '2026-10-29T04:15:00.000Z',
});

test('哈希入参字段集合就是清单（约束 1/2/4：不含自身与派生字段）', () => {
  const projected = projectEntryHashInput(sample());
  assert.deepEqual(
    Object.keys(projected).sort(),
    ['contractId', 'generation', 'parentHash', 'references', 'seq', 'summary', 'timestamp'],
  );
  // chain 只取 parentHash —— 整体入哈希会把 batchRoot/merkleRoot 带进来（循环依赖）
  assert.equal(projected.parentHash, GENESIS_PARENT_HASH);
  assert.equal('entryHash' in projected, false);
  assert.equal('batchRoot' in projected, false);
});

test('改 chain 的派生字段不得改变 entryHash（否则锚定/建树即自毁）', () => {
  const base = computeEntryHash(sample());
  const e = sample();
  e.chain.entryHash = 'sha256:' + 'd'.repeat(64);
  e.chain.batchRoot = 'sha256:' + 'e'.repeat(64);
  e.chain.merkleRoot = 'sha256:' + 'f'.repeat(64);
  assert.equal(computeEntryHash(e), base);
});

test('parentHash 参与摘要：换前驱必须得到不同 entryHash（链的衔接靠它）', () => {
  const a = sample();
  const b = sample();
  b.chain.parentHash = 'sha256:' + '9'.repeat(64);
  assert.notEqual(computeEntryHash(a), computeEntryHash(b));
});

test('非哈希入参字段（含回写与重建标记）变化不得改变 entryHash', () => {
  const a = sample();
  const b = { ...sample(), anchorStatus: 'ANCHORED', anchorSeq: 2, integrity: 'GAP_BEFORE', reconstructed: true, evidenceCompleteness: 'PARTIAL' };
  assert.equal(computeEntryHash(a), computeEntryHash(b));
});

test('时间戳格式非法 ⇒ 拒绝计算（fail-closed，不落库也不出摘要）', () => {
  const e = sample();
  e.timestamp = '2026-10-29T04:15:00Z';
  assert.throws(() => computeEntryHash(e), TypeError);
});

test('创世常量是硬编码字面量，不接受推导（§4.3.2）', () => {
  assert.equal(GENESIS_PARENT_HASH, 'sha256:' + '0'.repeat(64));
});

test('concatHash 对两个摘要的数组做规范化（与 roll-up 同一原语）', () => {
  const left = 'sha256:' + '1'.repeat(64);
  const right = 'sha256:' + '2'.repeat(64);
  assert.equal(concatHash(left, right), canonicalHash([left, right]));
  assert.notEqual(concatHash(left, right), concatHash(right, left), '内部节点保序，不得排序');
});
