#!/usr/bin/env node
/**
 * 委托机械真值（2026-11-08 单独一轮）的阴性对照与可复现性对拍。
 *
 * 钉住：① 委托类别必须 provenance 完整 + humanValidated=false，缺一即拒密封；
 * ② 不许靠「署名不在禁词表」蒙混（人工署名与委托署名混用、缺 authorityBasis 一律拒）；
 * ③ --check 输出醒目降级告警；④ 人工金标路径完全不变；
 * ⑤ label 由实跑得出且含真 REJECT（不是一律盖章）；⑥ 生成→密封→verify 全链路可复现。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  MECHANICAL_SCHEMA, MANDATE, CHECKS, DELEGATED_SIGNATURE,
  runChecks, buildSamples, generateSets, verifyAgainst,
} from './capability-baseline-mechanical.mjs';
import {
  DELEGATED_BASIS, DELEGATION_NOTICE, REQUIRED_PROVENANCE_FIELDS,
  inspectDelegation, inspectSetGovernance, sealSet, isDelegatedSignature,
  isPlaceholderSignature,
} from './capability-baseline-freeze.mjs';
import { verifyBaseline, SET_NAMES, DEFAULT_SETS_DIR } from './capability-baseline.mjs';
import { canonicalHash } from './lib/canonical-json.mjs';

const TMP_BASE = process.env.TMPDIR || tmpdir();

function sandbox() {
  const dir = mkdtempSync(join(TMP_BASE, 'mech-sets-'));
  for (const n of SET_NAMES) {
    writeFileSync(join(dir, `${n}.json`), `${JSON.stringify({
      setName: n, setVersion: '1.0',
      authority: n === 'verify' ? 'VERIFY' : (n === 'heldout' ? 'HELDOUT' : 'GOLD'),
      layerScope: 'L0-L5', frozenAt: '', frozenBy: '', contentHash: '', samples: [], note: 'fixture',
    }, null, 2)}\n`, 'utf8');
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const readSet = (dir, n) => JSON.parse(readFileSync(join(dir, `${n}.json`), 'utf8'));

test('⛔ 委托语义：humanValidated 恒 false，明确写出降级与构造期自参照', () => {
  assert.equal(MANDATE.basis, DELEGATED_BASIS);
  assert.equal(MANDATE.humanValidated, false);
  assert.match(MANDATE.semanticDowngrade, /不表示|不得据此/);
  assert.match(MANDATE.knownLimitation, /构造期自参照/);
  assert.match(MANDATE.mandate, /运营者/);
  assert.match(MANDATE.reproduceCommand, /--verify/);
  assert.match(DELEGATION_NOTICE, /非人类验证/);
  for (const f of REQUIRED_PROVENANCE_FIELDS) assert.ok(MANDATE[f] !== undefined && MANDATE[f] !== '', f);
});

test('⛔ 委托署名必须显式标记，且不会被误认为人工署名或占位署名', () => {
  assert.equal(isDelegatedSignature(DELEGATED_SIGNATURE), true);
  assert.equal(isDelegatedSignature('kylin'), false);
  assert.equal(isDelegatedSignature('agent'), false);
  assert.equal(isPlaceholderSignature('agent'), true, '⛔ 普通系统占位署名仍被硬拒');
});

test('⛔ 委托类别缺 provenance / 缺 authorityBasis ⇒ 拒（不许悄悄代签）', () => {
  const rows = [{ id: 'x', set: 'gold', layer: 'L0', kind: 'k', description: 'd', mechanicalCheck: 'c', label: 'PASS', observed: 'o' }];
  const s = buildSamples(rows, { frozenAt: '2026-11-08T00:00:00.000Z' }).gold[0];
  assert.equal(inspectDelegation({ authority: 'GOLD', samples: [s] }, 'gold').errors.length > 0, true,
    '缺顶层 provenance 必须拒');
  const noBasis = inspectDelegation({
    authority: 'GOLD', provenance: MANDATE, samples: [s],
  }, 'gold');
  assert.ok(noBasis.errors.some((e) => e.includes('authorityBasis')), '缺 authorityBasis 必须拒');
  const ok = inspectDelegation({
    authority: 'GOLD', authorityBasis: DELEGATED_BASIS, provenance: MANDATE, samples: [s],
  }, 'gold');
  assert.deepEqual(ok.errors, [], `完整 provenance 应放行：${ok.errors.join(' | ')}`);
});

test('⛔ 把 humanValidated 改成 true ⇒ 拒（绝不允许把机械真值说成人类已验证）', () => {
  const rows = [{ id: 'x', set: 'gold', layer: 'L0', kind: 'k', description: 'd', mechanicalCheck: 'c', label: 'PASS', observed: 'o' }];
  const s = buildSamples(rows, { frozenAt: '2026-11-08T00:00:00.000Z' }).gold[0];
  const r = inspectDelegation({
    authority: 'GOLD', authorityBasis: DELEGATED_BASIS,
    provenance: { ...MANDATE, humanValidated: true }, samples: [s],
  }, 'gold');
  assert.ok(r.errors.some((e) => e.includes('humanValidated')));
});

test('⛔ 人工署名混进委托集合 ⇒ 拒（禁止混用）', () => {
  const rows = [{ id: 'x', set: 'gold', layer: 'L0', kind: 'k', description: 'd', mechanicalCheck: 'c', label: 'PASS', observed: 'o' }];
  const s = { ...buildSamples(rows, { frozenAt: '2026-11-08T00:00:00.000Z' }).gold[0], frozenBy: 'kylin' };
  const r = inspectDelegation({
    authority: 'GOLD', authorityBasis: DELEGATED_BASIS, provenance: MANDATE, samples: [s],
  }, 'gold');
  assert.ok(r.errors.some((e) => e.includes('不是委托署名')));
});

test('20+ 条断言实跑：label 全由 verify() 得出，且含真 REJECT 负控制', async () => {
  const rows = await runChecks();
  assert.ok(rows.length >= 20);
  assert.ok(rows.some((r) => r.label === 'PASS'));
  assert.ok(rows.some((r) => r.label === 'REJECT'), '⛔ 必须有真 REJECT，不能一律盖章');
  for (const r of rows) {
    assert.ok(['PASS', 'REJECT'].includes(r.label));
    assert.ok(r.observed !== undefined && r.observed !== '');
    assert.ok(r.mechanicalCheck.trim());
  }
  const ids = new Set(rows.map((r) => r.id));
  assert.equal(ids.size, rows.length, 'id 必须唯一');
  const gold = rows.filter((r) => r.set === 'gold').map((r) => r.id);
  const heldout = rows.filter((r) => r.set === 'heldout').map((r) => r.id);
  assert.equal(heldout.filter((id) => gold.includes(id)).length, 0, '⛔ gold ∩ heldout 必须为空');
});

test('生成→密封→verify 全链路：READY / 逐字段不变 / 可独立复现', async () => {
  const t = sandbox();
  try {
    const rows = await runChecks();
    const g = generateSets(t.dir, { rows });
    assert.equal(g.ok, true);
    for (const w of g.written) {
      const j = readSet(t.dir, w.name);
      assert.equal(j.contentHash, '', '⛔ 生成器绝不手填 contentHash');
      assert.equal(j.authorityBasis, DELEGATED_BASIS);
      assert.equal(j.provenance.humanValidated, false);
      assert.equal(j.samples.length, w.samples);
    }
    const gov = inspectSetGovernance(t.dir);
    assert.equal(gov.ok, true, gov.errors.join(' | '));
    assert.equal(gov.delegation.present, true);
    assert.equal(gov.delegation.humanValidated, false);
    assert.ok(gov.warnings.some((w) => w.includes(DELEGATION_NOTICE.slice(0, 8))));

    for (const n of SET_NAMES) {
      const before = readSet(t.dir, n);
      const r = sealSet(t.dir, n);
      assert.equal(r.ok, true, `${n}: ${r.reason} ${JSON.stringify(r.errors ?? [])}`);
      assert.deepEqual(r.changedFields, ['contentHash']);
      const after = readSet(t.dir, n);
      assert.deepEqual(after.samples, before.samples);
      assert.equal(after.contentHash, canonicalHash(before.samples));
      assert.equal(after.provenance.humanValidated, false);
    }

    const vb = verifyBaseline(t.dir);
    assert.equal(vb.verdict, 'READY');
    assert.ok(vb.usableFrozenLabels.value > 0);
    assert.equal(vb.capabilityConclusion.value, null, '⛔ 机械真值绝不产出能力结论');

    const v = await verifyAgainst(t.dir);
    assert.equal(v.reproducible, true, JSON.stringify(v.mismatches));
    assert.equal(v.schemaVersion, MECHANICAL_SCHEMA);
    assert.equal(v.rerunCount, rows.length);
    assert.equal(v.frozenCount, rows.length);
    assert.equal(v.mismatches.length, 0);
  } finally { t.cleanup(); }
});

test('⛔ 篡改任一条冻结 label ⇒ 可复现性对拍立刻报 MISMATCH', async () => {
  const t = sandbox();
  try {
    const rows = await runChecks();
    generateSets(t.dir, { rows });
    const gold = readSet(t.dir, 'gold');
    const flipped = gold.samples.find((s) => s.label === 'PASS');
    flipped.label = 'REJECT';
    writeFileSync(join(t.dir, 'gold.json'), `${JSON.stringify(gold, null, 2)}\n`, 'utf8');
    const v = await verifyAgainst(t.dir);
    assert.equal(v.reproducible, false);
    assert.ok(v.mismatches.some((m) => m.id === flipped.id));
  } finally { t.cleanup(); }
});

test('真实仓库冻结集：结构合法、判词合法，测试套件不擅自改动已有数据', () => {
  // ⚠ 不钉死仓库当前状态：生成前是 NO_FROZEN_LABELS、生成密封后是 READY，
  //    两者都合法。本用例只确认测试自身不改写真实集合。
  for (const n of SET_NAMES) assert.equal(existsSync(join(DEFAULT_SETS_DIR, `${n}.json`)), true);
  const g = inspectSetGovernance(DEFAULT_SETS_DIR);
  assert.ok(['NO_FROZEN_LABELS', 'READY'].includes(g.baselineVerdict));
  assert.equal(g.ok, true, g.errors.join(' | '));
});
