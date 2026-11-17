#!/usr/bin/env node
/**
 * bin/capability-baseline.test.mjs
 * ⛔ 显式路径跑：node --test bin/capability-baseline.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalHash } from './lib/canonical-json.mjs';
import {
  verifyBaseline, renderMarkdown, loadSet, checkSet,
  SET_NAMES, LAYERS, DEFAULT_SETS_DIR,
} from './capability-baseline.mjs';

function sample(id, over = {}) {
  return { id, layer: 'L3', kind: 'mutator', label: null, labelAuthority: 'UNSET', ...over };
}

/** 造一份 set 文件。samples 为空默认 UNSEALED；非空默认算正确 hash。 */
function mkSet(dir, name, samples = [], opts = {}) {
  const hash = Object.prototype.hasOwnProperty.call(opts, 'hash')
    ? opts.hash
    : (samples.length === 0 ? '' : canonicalHash(samples));
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({
    setName: name, setVersion: '1.0', contentHash: hash, samples,
  }, null, 2));
}

function emptySets() {
  const dir = mkdtempSync(join(tmpdir(), 'agint-capbase-'));
  for (const n of SET_NAMES) mkSet(dir, n, []);
  return dir;
}

function cleanup(dir) { rmSync(dir, { recursive: true, force: true }); }

// ── 空集语义测「行为」，⛔ 不钉死真实仓库的当前状态 ────────────────────────
// 2026-11-08：真实仓库已由委托机械真值填充并密封（READY / 17 标签）。
// 把「0 标签」断言绑在 DEFAULT_SETS_DIR 上会让测试随数据状态漂移，
// 故改为构造隔离空集测行为，真实仓库只断言不变量。
test('✅ 空集 ⇒ NO_FROZEN_LABELS，0 标签是真 0，能力结论无数据', () => {
  const dir = emptySets();
  try {
    const r = verifyBaseline(dir);
    assert.equal(r.verdict, 'NO_FROZEN_LABELS');
    assert.equal(r.usableFrozenLabels.value, 0, '表在、0 行是真 0，不是 null');
    assert.equal(r.goldHeldoutOverlap.value, 0, '查过且确实零交集');
    assert.equal(r.frozenIntegrity.value, 'OK');
    for (const n of SET_NAMES) assert.equal(r.sets[n].sealed, 'UNSEALED');
    assert.equal(r.capabilityConclusion.value, null);
    assert.match(r.capabilityConclusion.reason, /拒绝出任何能力结论/);
    assert.deepEqual(Object.keys(r.layerCoverage), [...LAYERS]);
    assert.ok(Object.values(r.layerCoverage).every((v) => v === 0));
  } finally { cleanup(dir); }
});

test('⛔ 0 标签时 markdown 不写「能力为零」，且明写拒绝判定', () => {
  const dir = emptySets();
  try {
    const md = renderMarkdown(verifyBaseline(dir));
    assert.doesNotMatch(md, /能力为零/);
    assert.match(md, /不产出/);
    assert.match(md, /NO_FROZEN_LABELS/);
  } finally { cleanup(dir); }
});

test('真实仓库冻结集：只钉不变量，不钉当前状态快照', () => {
  const r = verifyBaseline(DEFAULT_SETS_DIR);
  assert.ok(['NO_FROZEN_LABELS', 'READY'].includes(r.verdict), `verdict=${r.verdict}`);
  assert.equal(r.capabilityConclusion.value, null, '⛔ 无论有无标签都拒绝产出能力结论');
  assert.equal(r.goldHeldoutOverlap.value, 0, 'gold/heldout 交集必须为 0');
  assert.deepEqual(Object.keys(r.layerCoverage), [...LAYERS]);
  for (const n of SET_NAMES) {
    assert.ok(['UNSEALED', 'SEALED', 'CORRUPT'].includes(r.sets[n].sealed));
    assert.equal(r.sets[n].errors.length, 0, `${n} 不应有校验错误`);
  }
});

// ── 密封性 / 篡改 ──────────────────────────────────────────────────────────
test('⛔ 改动 samples 但没换 contentHash ⇒ CORRUPT', () => {
  const dir = emptySets();
  try {
    mkSet(dir, 'gold', [sample('g1', { label: 'PASS', labelAuthority: 'GOLD' })], { hash: 'deadbeef' });
    const r = verifyBaseline(dir);
    assert.equal(r.verdict, 'CORRUPT');
    assert.equal(r.sets.gold.sealed, 'CORRUPT');
    assert.ok(r.sets.gold.errors.some((e) => /篡改|不符/.test(e)));
    assert.equal(r.usableFrozenLabels.value, null, '损坏时读数无数据，不是 0');
  } finally { cleanup(dir); }
});

test('⛔ 有样本却未密封（contentHash 空）⇒ CORRUPT', () => {
  const dir = emptySets();
  try {
    mkSet(dir, 'gold', [sample('g1')], { hash: '' });
    const r = verifyBaseline(dir);
    assert.equal(r.verdict, 'CORRUPT');
    assert.ok(r.sets.gold.errors.some((e) => /未密封/.test(e)));
  } finally { cleanup(dir); }
});

test('✅ 正确密封 + 合法外部冻结标签 ⇒ READY，但校验器仍不出能力结论', () => {
  const dir = emptySets();
  try {
    const gold = [
      sample('g1', { layer: 'L0', label: 'PASS', labelAuthority: 'GOLD' }),
      sample('g2', { layer: 'L4', label: 'REJECT', labelAuthority: 'GOLD' }),
    ];
    mkSet(dir, 'gold', gold);
    const r = verifyBaseline(dir);
    assert.equal(r.verdict, 'READY');
    assert.equal(r.usableFrozenLabels.value, 2);
    assert.equal(r.layerCoverage.L0, 1);
    assert.equal(r.layerCoverage.L4, 1);
    assert.equal(r.sets.gold.sealed, 'SEALED');
    assert.equal(r.capabilityConclusion.value, null, '判定权不在只读校验器');
    assert.match(r.capabilityConclusion.reason, /JUDGEMENT_EXTERNAL/);
  } finally { cleanup(dir); }
});

// ── 三层分离 ───────────────────────────────────────────────────────────────
test('⛔ gold ∩ heldout 有交集 ⇒ CORRUPT', () => {
  const dir = emptySets();
  try {
    const x = sample('SAME-ID', { label: 'PASS', labelAuthority: 'GOLD' });
    mkSet(dir, 'gold', [x]);
    mkSet(dir, 'heldout', [x]);
    const r = verifyBaseline(dir);
    assert.equal(r.goldHeldoutOverlap.value, 1);
    assert.equal(r.verdict, 'CORRUPT');
    assert.equal(r.frozenIntegrity.value, 'OVERLAP');
  } finally { cleanup(dir); }
});

test('⛔ SILVER 自评标签不计入 usableFrozenLabels', () => {
  const dir = emptySets();
  try {
    mkSet(dir, 'gold', [sample('g1', { label: 'PASS', labelAuthority: 'SILVER' })]);
    const r = verifyBaseline(dir);
    assert.equal(r.usableFrozenLabels.value, 0);
    assert.equal(r.verdict, 'NO_FROZEN_LABELS');
  } finally { cleanup(dir); }
});

// ── 形状与缺失 ─────────────────────────────────────────────────────────────
test('⛔ 非法枚举 / 非法层 / 非法 label ⇒ CORRUPT', () => {
  const dir = emptySets();
  try {
    mkSet(dir, 'gold', [
      sample('a', { labelAuthority: 'HUMAN_FROZEN' }),
      sample('b', { layer: 'L9' }),
      sample('c', { label: 'MAYBE' }),
    ]);
    const r = verifyBaseline(dir);
    assert.equal(r.verdict, 'CORRUPT');
    assert.ok(r.sets.gold.errors.some((e) => /labelAuthority/.test(e)));
    assert.ok(r.sets.gold.errors.some((e) => /layer/.test(e)));
    assert.ok(r.sets.gold.errors.some((e) => /label/.test(e)));
  } finally { cleanup(dir); }
});

test('⛔ 缺一份 set ⇒ MISSING_SETS，交集与标签数都是无数据', () => {
  const dir = emptySets();
  try {
    rmSync(join(dir, 'heldout.json'));
    const r = verifyBaseline(dir);
    assert.equal(r.verdict, 'MISSING_SETS');
    assert.equal(r.goldHeldoutOverlap.value, null);
    assert.match(r.goldHeldoutOverlap.reason, /SETS_NOT_READABLE/);
    assert.equal(r.usableFrozenLabels.value, null);
    assert.equal(r.sets.heldout.sealed, 'MISSING');
  } finally { cleanup(dir); }
});

test('⛔ 坏 JSON 不抛异常，如实报 CORRUPT', () => {
  const dir = emptySets();
  try {
    writeFileSync(join(dir, 'verify.json'), '{ not json');
    const loaded = loadSet(dir, 'verify');
    assert.ok(loaded.parseError);
    assert.equal(checkSet(loaded).sealed, 'CORRUPT');
    assert.equal(verifyBaseline(dir).verdict, 'CORRUPT');
  } finally { cleanup(dir); }
});
