#!/usr/bin/env node
/**
 * bin/baseline-provenance.test.mjs —— 独立人工签发通道的纯函数与 CLI 测试。
 *
 * 测试纪律（K151 / K219）：每条失败可见性都要有 negative control。
 * 本文件里「真负控」= 故意植入一个已知坏的签发/篡改，断言实算能拦住。
 * CLI 测试全程用临时 DSH_HOME，绝不碰生产存储。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  assessBaselineProvenance, makeAttestation, rowHash,
  ATTESTATION_TABLE, ROW_VOLATILE_KEYS,
} from './lib/baseline-provenance.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, 'attest-baseline.mjs');
const NODE = process.execPath;
const FIXED_AT = '2026-11-11T00:00:00.000Z';

const ROW = Object.freeze({
  id: 'st-1', kind: 'success-template', template: '先写测试再写实现',
  lastRecall: FIXED_AT, recalls: 0, updatedAt: FIXED_AT,
});

function attested(row = ROW, extra = {}) {
  return makeAttestation({
    targetKind: 'success_template', targetId: row.id, row,
    signedBy: '大鱼', mandate: '人工复核 2026-11-11',
    signedAt: FIXED_AT, ...extra,
  });
}

function state(rows, atts = []) {
  return {
    success_template: rows,
    benchmark_frozen_set: {},
    [ATTESTATION_TABLE]: Object.fromEntries(atts.map((a) => [a.id, a])),
  };
}

// ── 纯函数 ───────────────────────────────────────────────────────────────

test('① rowHash 确定性，且正常召回不改变摘要', () => {
  const a = rowHash(ROW);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  const afterRecall = { ...ROW, recalls: 17, lastRecall: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z' };
  assert.equal(rowHash(afterRecall), a, '召回计数变化不得判成 STALE（否则每周假阳性）');
  assert.notEqual(rowHash({ ...ROW, template: '改了模板' }), a, '真实内容变化必须改变摘要');
  assert.equal(ROW_VOLATILE_KEYS.length, 3);
});

test('② makeAttestation 恒 humanValidated=true，不接受冒名参数', () => {
  const a = attested(ROW, { humanValidated: false });
  assert.equal(a.humanValidated, true, '机器传 false 也不能覆盖人工签发语义');
  assert.equal(a.contentHash, rowHash(ROW));
  assert.equal(a.id, 'att-success_template-st-1');
  assert.throws(() => makeAttestation({ targetKind: 'nope', targetId: 'x', row: ROW, signedBy: 'x', mandate: 'x' }));
  assert.throws(() => makeAttestation({ targetKind: 'success_template', targetId: 'x', row: ROW, signedBy: '', mandate: 'x' }));
});

test('③ 空集不算 ANCHORED（防 vacuous truth）', () => {
  const r = assessBaselineProvenance(state({}, []));
  assert.equal(r.baselineAnchored, false);
  assert.equal(r.baselineProvenance, 'NOT_ANCHORED');
  assert.equal(r.counts.total, 0);
  assert.ok(r.reasons.some((x) => x.includes('空集')), '空集必须留 reason');
});

test('④ 无签发 → NOT_ANCHORED，每行带 reason', () => {
  const r = assessBaselineProvenance(state({ 'st-1': ROW }, []));
  assert.equal(r.baselineProvenance, 'NOT_ANCHORED');
  assert.equal(r.counts.unattested, 1);
  assert.equal(r.rows[0].status, 'UNATTESTED');
  assert.ok(r.rows[0].reason.length > 0);
});

test('⑤ 全部签发且内容一致 → ANCHORED（positive control）', () => {
  const r = assessBaselineProvenance(state({ 'st-1': ROW }, [attested()]));
  assert.equal(r.baselineAnchored, true);
  assert.equal(r.baselineProvenance, 'ANCHORED');
  assert.equal(r.rows[0].status, 'ATTESTED');
  assert.equal(r.rows[0].contentHash, rowHash(ROW));
});

test('⑥ 部分签发 → PARTIALLY_ANCHORED，不冒充全签', () => {
  const second = { ...ROW, id: 'st-2', template: '另一条策略' };
  const r = assessBaselineProvenance(state({ 'st-1': ROW, 'st-2': second }, [attested()]));
  assert.equal(r.baselineAnchored, false);
  assert.equal(r.baselineProvenance, 'PARTIALLY_ANCHORED');
  assert.equal(r.counts.attested, 1);
  assert.equal(r.counts.unattested, 1);
});

test('⑦ 真负控：签发后篡改内容 → STALE 且 NOT_ANCHORED', () => {
  const tampered = { ...ROW, template: '偷偷改成对自己有利的模板' };
  const r = assessBaselineProvenance(state({ 'st-1': tampered }, [attested()]));
  assert.equal(r.rows[0].status, 'STALE');
  assert.equal(r.baselineProvenance, 'NOT_ANCHORED');
  assert.ok(r.rows[0].reason.includes('重新签发'));
  assert.notEqual(r.rows[0].actualHash, r.rows[0].expectedHash);
});

test('⑧ 真负控：机器代签（humanValidated≠true）→ 拒绝冒充人工', () => {
  const fake = { ...attested(), humanValidated: false };
  const r = assessBaselineProvenance(state({ 'st-1': ROW }, [fake]));
  assert.equal(r.rows[0].status, 'INVALID_ATTESTATION');
  assert.equal(r.baselineAnchored, false);
  assert.equal(r.baselineProvenance, 'NOT_ANCHORED');
});

test('⑨ 真负控：孤儿签发 → ORPHAN 且阻断', () => {
  const orphan = attested({ ...ROW, id: 'st-gone' });
  const r = assessBaselineProvenance(state({ 'st-1': ROW }, [orphan]));
  assert.equal(r.counts.orphan, 1);
  assert.equal(r.baselineProvenance, 'NOT_ANCHORED');
  assert.ok(r.reasons.some((x) => x.includes('不存在的行')));
});

test('⑩ dict 与 array 两种存储形态都认', () => {
  const dict = assessBaselineProvenance(state({ 'st-1': ROW }, [attested()]));
  const arr = assessBaselineProvenance(state([ROW], [attested()]));
  assert.equal(dict.baselineProvenance, arr.baselineProvenance);
  assert.equal(dict.counts.total, arr.counts.total);
});

test('⑪ frozen set 用 setId，且独立签发互不串扰', () => {
  const frozen = { setId: 'frozen-2026-11-11', frozenCount: 3, frozenAggregateHash: 'sha256:abc' };
  const a = makeAttestation({
    targetKind: 'benchmark_frozen_set', targetId: frozen.setId, row: frozen,
    signedBy: '大鱼', mandate: '人工复核', signedAt: FIXED_AT,
  });
  const r = assessBaselineProvenance({
    success_template: {},
    benchmark_frozen_set: { [frozen.setId]: frozen },
    [ATTESTATION_TABLE]: { [a.id]: a },
  });
  assert.equal(r.baselineProvenance, 'ANCHORED');
  assert.equal(r.rows[0].targetId, frozen.setId);
});

// ── CLI ──────────────────────────────────────────────────────────────────

function sandbox(rows = { 'st-1': ROW }) {
  const dsh = mkdtempSync(join(tmpdir(), 'attest-cli-'));
  const st = join(dsh, 'storages');
  mkdirSync(st, { recursive: true });
  writeFileSync(join(st, 'agint_evolution.json'), JSON.stringify({ tables: { success_template: rows } }, null, 2), 'utf8');
  return { dsh, st };
}

function cli(dsh, args) {
  return spawnSync(NODE, [CLI, ...args], {
    encoding: 'utf8', env: { ...process.env, DSH_HOME: dsh }, maxBuffer: 8 * 1024 * 1024,
  });
}

test('⑫ --check 只报告不写盘', () => {
  const { dsh, st } = sandbox();
  try {
    const r = cli(dsh, ['--check']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /NOT_ANCHORED/);
    assert.match(r.stdout, /未签发 1/);
    assert.equal(existsSync(join(st, 'agint_baseline_attestation.json')), false, '--check 不得写盘');
  } finally {
    rmSync(dsh, { recursive: true, force: true });
  }
});

test('⑬ --sign 写独立文件、写后复核、再 --check 升级为 ANCHORED', () => {
  const { dsh, st } = sandbox();
  try {
    const r = cli(dsh, ['--sign', '--target=success_template:st-1', '--by=大鱼', '--mandate=人工复核 2026-11-11']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /已签发/);
    assert.match(r.stdout, /写后复核|复核 1\/1/);
    const file = join(st, 'agint_baseline_attestation.json');
    assert.equal(existsSync(file), true);
    const j = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(Object.keys(j.tables.baseline_attestation).length, 1);
    assert.equal(j.tables.baseline_attestation['att-success_template-st-1'].humanValidated, true);
    assert.equal(existsSync(join(st, 'agint_evolution.json')), true, '不得删除生产存储主文件');
    const c = cli(dsh, ['--check']);
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /ANCHORED/);
  } finally {
    rmSync(dsh, { recursive: true, force: true });
  }
});

test('⑭ 真负控：重复 --sign 拒绝覆盖（只增不改）', () => {
  const { dsh } = sandbox();
  try {
    const args = ['--sign', '--target=success_template:st-1', '--by=大鱼', '--mandate=人工复核'];
    assert.equal(cli(dsh, args).status, 0);
    const second = cli(dsh, args);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /拒绝覆盖/);
  } finally {
    rmSync(dsh, { recursive: true, force: true });
  }
});

test('⑮ 真负控：给不存在的基准签发一律拒绝', () => {
  const { dsh, st } = sandbox();
  try {
    const r = cli(dsh, ['--sign', '--target=success_template:st-ghost', '--by=大鱼', '--mandate=人工复核']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /不存在/);
    assert.equal(existsSync(join(st, 'agint_baseline_attestation.json')), false, '失败不得留半条签发');
  } finally {
    rmSync(dsh, { recursive: true, force: true });
  }
});
