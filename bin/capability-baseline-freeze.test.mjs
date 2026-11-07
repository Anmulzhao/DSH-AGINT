#!/usr/bin/env node
/**
 * bin/capability-baseline-freeze.test.mjs —— 金标就绪包的阴性对照
 *
 * 钉住：① 脚本绝不代填真值/署名（占位署名一律拒）；② verify 样本绝不混进
 * GOLD 分母；③ gold∩heldout 交集为 0；④ 密封只写 contentHash，
 * samples/label/labelAuthority/frozenBy/frozenAt/authority 逐字段不变；
 * ⑤ 空集与治理未就绪时拒绝密封；⑥ 路径逃逸拒绝。
 * ⛔ 顶层 import 放在 test() 之前（项目硬规则，撞 TDZ）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FREEZE_SCHEMA, SAMPLE_TEMPLATE, FORBIDDEN_FROZEN_BY,
  inspectSetGovernance, sealSet, assertSealTarget, isPlaceholderSignature,
} from './capability-baseline-freeze.mjs';
import { verifyBaseline, SET_NAMES, DEFAULT_SETS_DIR } from './capability-baseline.mjs';
import { canonicalHash } from './lib/canonical-json.mjs';

const TMP_BASE = process.env.TMPDIR || tmpdir();

function baseSet(name, overrides = {}) {
  return {
    setName: name, setVersion: '1.0',
    authority: name === 'verify' ? 'SILVER' : (name === 'heldout' ? 'HELDOUT' : 'GOLD'),
    layerScope: 'L0-L5', frozenAt: '', frozenBy: '', contentHash: '', samples: [],
    note: 'test fixture', ...overrides,
  };
}

function sample(overrides = {}) {
  return {
    id: 'cap-L3-001', layer: 'L3', kind: 'mutator',
    description: '给定输入，产出可编译 diff 且单测全绿',
    mechanicalCheck: '运行 manifest.tests.command，无 [FAIL] 即 PASS',
    label: 'PASS', labelAuthority: 'GOLD',
    frozenBy: 'kylin', frozenAt: '2026-11-07T00:00:00.000Z',
    ...overrides,
  };
}

function writeSet(dir, name, data) {
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function sandbox(sets = {}) {
  const dir = mkdtempSync(join(TMP_BASE, 'freeze-sets-'));
  for (const n of SET_NAMES) writeSet(dir, n, sets[n] ?? baseSet(n));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function readSet(dir, name) {
  return JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
}

test('模板只是形状说明：__EXAMPLE_ONLY__ 且不产生任何样本、零写入', () => {
  assert.equal(SAMPLE_TEMPLATE.__EXAMPLE_ONLY__, true);
  assert.equal(FORBIDDEN_FROZEN_BY.includes('agent'), true);
  assert.equal(isPlaceholderSignature('AI'), true);
  assert.equal(isPlaceholderSignature('kylin'), false);
});

test('空集 check：治理无违规但明确 NO_FROZEN_LABELS，未伪装成就绪', () => {
  const t = sandbox();
  try {
    const g = inspectSetGovernance(t.dir);
    assert.equal(g.schemaVersion, FREEZE_SCHEMA);
    assert.equal(g.baselineVerdict, 'NO_FROZEN_LABELS');
    assert.equal(g.usableFrozenLabels.value, 0);
    assert.equal(g.ok, true, '未填样本不是「违规」，但也不是就绪');
    assert.equal(g.perSet.gold.frozenSigned, false);
    assert.ok(g.warnings.some((w) => w.includes('空集')));
    assert.equal(verifyBaseline(t.dir).verdict, 'NO_FROZEN_LABELS');
  } finally { t.cleanup(); }
});

test('⛔ 缺失 / 系统占位署名一律拒（脚本绝不代签）', () => {
  const t = sandbox({ gold: baseSet('gold', { samples: [sample({ frozenBy: '' })] }) });
  try {
    const g = inspectSetGovernance(t.dir);
    assert.equal(g.ok, false);
    assert.ok(g.errors.some((e) => e.includes('frozenBy')));
    assert.equal(sealSet(t.dir, 'gold').ok, false);
  } finally { t.cleanup(); }
  const t2 = sandbox({ gold: baseSet('gold', { samples: [sample({ frozenBy: 'agent' })] }) });
  try {
    assert.equal(inspectSetGovernance(t2.dir).ok, false);
  } finally { t2.cleanup(); }
});

test('⛔ frozenAt 非 ISO8601 / 缺题目 / 缺机械判据 ⇒ 拒', () => {
  const t = sandbox({
    gold: baseSet('gold', { samples: [sample({ frozenAt: '昨天' })] }),
    verify: baseSet('verify', { samples: [sample({ id: 'v1', description: '' })] }),
    heldout: baseSet('heldout', { samples: [sample({ id: 'h1', mechanicalCheck: '' })] }),
  });
  try {
    const g = inspectSetGovernance(t.dir);
    assert.equal(g.ok, false);
    assert.ok(g.errors.some((e) => e.includes('frozenAt')));
    assert.ok(g.errors.some((e) => e.includes('description')));
    assert.ok(g.errors.some((e) => e.includes('mechanicalCheck')));
  } finally { t.cleanup(); }
});

test('⛔ verify 样本标 GOLD ⇒ 拒（不能混进可用冻结标签分母）', () => {
  const t = sandbox({
    gold: baseSet('gold', { samples: [sample()] }),
    verify: baseSet('verify', { samples: [sample({ id: 'v1', labelAuthority: 'GOLD' })] }),
  });
  try {
    const g = inspectSetGovernance(t.dir);
    assert.equal(g.ok, false);
    assert.ok(g.errors.some((e) => /verify 样本混进/.test(e)));
  } finally { t.cleanup(); }
});

test('⛔ gold ∩ heldout 有交集 ⇒ 拒（否则 verifyBaseline 判 CORRUPT）', () => {
  const t = sandbox({
    gold: baseSet('gold', { samples: [sample()] }),
    heldout: baseSet('heldout', { samples: [sample({ id: 'cap-L3-001', labelAuthority: 'HELDOUT' })] }),
  });
  try {
    const g = inspectSetGovernance(t.dir);
    assert.equal(g.ok, false);
    assert.deepEqual(g.goldHeldoutOverlap, ['cap-L3-001']);
    assert.ok(g.errors.some((e) => e.includes('GOLD_HELD_OUT_OVERLAP')));
  } finally { t.cleanup(); }
});

test('✅ 人填完后密封：只写 contentHash，其余字段逐一对拍不变', () => {
  const samples = [sample(), sample({ id: 'cap-L4-002', layer: 'L4', label: 'REJECT' })];
  const t = sandbox({ gold: baseSet('gold', { samples }) });
  try {
    const before = readSet(t.dir, 'gold');
    const r = sealSet(t.dir, 'gold');
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.writes, 1);
    assert.deepEqual(r.changedFields, ['contentHash']);
    assert.equal(r.baselineVerdict, 'READY');
    assert.equal(r.usableFrozenLabels, 2);
    const after = readSet(t.dir, 'gold');
    assert.deepEqual(after.samples, before.samples, '⛔ samples 被改了');
    for (const k of ['setName', 'setVersion', 'authority', 'layerScope', 'frozenAt', 'frozenBy', 'note']) {
      assert.equal(after[k], before[k], `⛔ 非哈希字段 ${k} 被改了`);
    }
    assert.equal(after.contentHash, canonicalHash(samples));
    assert.equal(verifyBaseline(t.dir).sets.gold.sealed, 'SEALED');
  } finally { t.cleanup(); }
});

test('⛔ 治理未就绪时拒绝密封，且不改动文件；非法集名 / 路径逃逸一律拒', () => {
  const t = sandbox({ gold: baseSet('gold', { samples: [sample({ frozenBy: '' })] }) });
  try {
    const r = sealSet(t.dir, 'gold');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'GOVERNANCE_NOT_READY');
    assert.equal(r.writes, 0);
    assert.equal(readSet(t.dir, 'gold').contentHash, '');
    assert.throws(() => assertSealTarget(t.dir, 'nope'), /SEAL_TARGET_NOT_ALLOWED/);
    assert.throws(() => assertSealTarget(t.dir, '../evil'), /SEAL_TARGET_NOT_ALLOWED/);
  } finally { t.cleanup(); }
});

test('⛔ 空集密封返回 EMPTY_SET（UNSEALED 是合法未就绪态）', () => {
  const t = sandbox();
  try {
    const r = sealSet(t.dir, 'gold');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'EMPTY_SET: 空集不密封（UNSEALED 是合法未就绪态）');
    assert.equal(r.writes, 0);
    assert.equal(readSet(t.dir, 'gold').contentHash, '');
  } finally { t.cleanup(); }
});

test('assertSealTarget：只认三份 set，越出目录直接抛', () => {
  const t = sandbox();
  try {
    assert.throws(() => assertSealTarget(t.dir, 'nope'), /SEAL_TARGET_NOT_ALLOWED/);
    assert.throws(() => assertSealTarget(t.dir, '../evil'), /SEAL_TARGET_NOT_ALLOWED/);
    assert.equal(assertSealTarget(t.dir, 'gold').ok, true);
  } finally { t.cleanup(); }
});

test('⛔ verify.authority="VERIFY" 是合法用途标记，不阻挡 gold 密封（工具不倒逼改数据）', () => {
  const t = sandbox({
    gold: baseSet('gold', { samples: [sample()] }),
    verify: baseSet('verify', { authority: 'VERIFY' }),
  });
  try {
    const g = inspectSetGovernance(t.dir);
    assert.equal(g.ok, true, g.errors.join(' | '));
    assert.equal(g.perSet.verify.authority, 'VERIFY');
    const r = sealSet(t.dir, 'gold');
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.baselineVerdict, 'READY');
  } finally { t.cleanup(); }
});

test('真实仓库冻结集：治理无违规、能力结论恒 null，脚本不擅自改动', () => {
  const g = inspectSetGovernance(DEFAULT_SETS_DIR);
  assert.equal(g.ok, true, g.errors.join(' | '));
  // ⛔ 2026-11-08：集合可能已由委托机械真值填充（READY）或仍是空集
  //    （NO_FROZEN_LABELS）；测试只钉不变量，不钉状态快照。
  assert.ok(['NO_FROZEN_LABELS', 'READY'].includes(g.baselineVerdict), `verdict=${g.baselineVerdict}`);
  assert.equal(verifyBaseline(DEFAULT_SETS_DIR).capabilityConclusion.value, null);
  assert.equal(g.goldHeldoutOverlap.length, 0);
  for (const n of SET_NAMES) {
    const s = g.perSet[n];
    if (s?.delegated) {
      assert.equal(s.humanValidated, false, `${n} 委托类别必须 humanValidated=false`);
      assert.equal(s.authorityBasis, 'MECHANICAL_REPRODUCIBLE');
    }
  }
});
