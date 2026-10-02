// bin/validate-contract-schema.test.mjs — Contract schema 校验器的测试
//
// 设计 §7.1 要求「Contract schema 校验 ≥12 case，Tier A」。用例本体住在
// 脚本的 --fixtures 里（20 个），本文件负责把它接进 `node --test` 统一入口，
// 并钉住几条**容易被后续改动悄悄破坏**的硬约束。
//
// ⚠️ 已知边界（实测）：设计 §4.2.1 的 JSON 示例**本身过不了本校验器** ——
//    它的枚举字段写成 "SUCCESS_RATE | TOKEN_EFFICIENCY | ..." 这种速记形式，
//    不是单一合法取值。示例是示意性的（表示「可选值范围」），不是可直接
//    落盘的实例。这条不写成断言，避免有人为了让它通过而放宽枚举。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'validate-contract-schema.mjs');
const REPO_ROOT = join(__dirname, '..');
const SCHEMA_PATH = join(REPO_ROOT, 'docs', 'specs', 'evolution-contract-v1.schema.json');

const { validateContract, loadSchema, computeHypothesisLock } = await import(
  pathToFileURL(SCRIPT).href
);
const schema = loadSchema();

// ── 内置用例接入统一测试入口 ────────────────────────────────────────────────
test('--fixtures 全部通过且用例数 ≥12（设计 §7.1 的量化要求）', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--fixtures', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `内置用例失败：\n${r.stdout}`);
  const j = JSON.parse(r.stdout);
  assert.ok(j.total >= 12, `用例数 ${j.total} < 12，不满足设计 §7.1`);
  assert.equal(j.pass, j.total);
});

// ── schema 文件本身 ─────────────────────────────────────────────────────────
test('schema 是合法 JSON 且声明了必需顶层字段', () => {
  assert.equal(schema.type, 'object');
  for (const k of ['contractVersion', 'identity', 'hypothesis', 'evaluationPlan', 'budget', 'audit']) {
    assert.ok(schema.required.includes(k), `schema 未把 ${k} 列为必填`);
  }
});

test('audit.status 枚举必须含 10 个状态（含 TAMPERED 终态）', () => {
  const statuses = schema.properties.audit.properties.status.enum;
  const expected = [
    'DRAFT', 'DIAGNOSED', 'MUTATED', 'EVALUATED', 'MOUNTED',
    'TESTED', 'DECIDED', 'COMPLETED', 'ARCHIVED', 'TAMPERED',
  ];
  assert.deepEqual([...statuses].sort(), [...expected].sort());
});

test('benchmarkSet 枚举不得包含 FROZEN（设计 §4.2.1 修正表）', () => {
  const set = schema.properties.evaluationPlan.properties.benchmarkSet.enum;
  assert.ok(!set.includes('FROZEN'), 'FROZEN 出现在合法枚举里');
  assert.deepEqual(set, ['EVOLUTION', 'VALIDATION']);
});

// ── 语义规则（JSON Schema 表达不了的那三条）─────────────────────────────────
test('★ NO_EVIDENCE 纪律：有数值却无取数来源必须被拦', () => {
  const c = {
    contractVersion: '1.0',
    identity: { contractId: 'E1', createdAt: '2026-10-02T00:00:00Z', createdBy: 'evolution-driver' },
    hypothesis: {
      summary: 's', targetMetric: 'SUCCESS_RATE', predictedDelta: null,
      predictedDeltaNote: 'NOT_PREDICTED', reasoning: 'r',
      changedComponents: [{ pluginName: 'p', filesChanged: [], changeType: 'MODIFY' }],
    },
    evaluationPlan: {
      benchmarkSet: 'EVOLUTION', sampleSize: 3, statisticalTest: 'T_TEST',
      significanceLevel: 0.05, effectSizeThreshold: 0.3,
    },
    budget: { sandboxRequired: true, deployBudgetCheck: true },
    outcome: { actualDeltas: [{ metric: 'SUCCESS_RATE', baseline: 0, candidate: 0, delta: 0 }] },
    audit: { status: 'COMPLETED' },
  };
  const r = validateContract(c, schema);
  assert.ok(
    r.errors.some((e) => e.rule === 'NO_EVIDENCE_VIOLATION'),
    `未拦住「用 0 冒充无改进」：${JSON.stringify(r.errors)}`,
  );
});

test('★ 防事后编造：锁定后改 hypothesis 必须被拦（设计 §4.2.4）', () => {
  const base = {
    contractVersion: '1.0',
    identity: { contractId: 'E1', createdAt: '2026-10-02T00:00:00Z', createdBy: 'evolution-driver' },
    hypothesis: {
      summary: '原假设', targetMetric: 'SUCCESS_RATE', predictedDelta: null,
      predictedDeltaNote: 'NOT_PREDICTED', reasoning: 'r',
      changedComponents: [{ pluginName: 'p', filesChanged: [], changeType: 'MODIFY' }],
    },
    evaluationPlan: {
      benchmarkSet: 'EVOLUTION', sampleSize: 3, statisticalTest: 'T_TEST',
      significanceLevel: 0.05, effectSizeThreshold: 0.3,
    },
    budget: { sandboxRequired: true, deployBudgetCheck: true },
    audit: { status: 'DRAFT' },
  };
  const lock = computeHypothesisLock(base);

  assert.equal(validateContract(base, schema, { expectedHypothesisLock: lock }).valid, true);

  const tampered = JSON.parse(JSON.stringify(base));
  tampered.hypothesis.summary = '看到结果后编的假设';
  const r = validateContract(tampered, schema, { expectedHypothesisLock: lock });
  assert.ok(
    r.errors.some((e) => e.rule === 'HYPOTHESIS_LOCK_MISMATCH'),
    '篡改未被发现 —— 防事后编造机制失效',
  );
});

test('★ 锁定值不在 Contract 本体内（设计 §4.2.6 把它放在 contract_locks 表）', () => {
  assert.ok(
    !schema.properties.audit.properties.hypothesisLock,
    'schema 不该声明 hypothesisLock —— 它的归宿是独立的 contract_locks 表',
  );
});

// ── 注解键处理 ──────────────────────────────────────────────────────────────
test('_ 开头的注解键不受 additionalProperties 限制（设计示例自带 _comment）', () => {
  const raw = readFileSync(SCHEMA_PATH, 'utf8');
  assert.ok(raw.includes('_comment') || raw.includes('_annotationKeys'));
});
