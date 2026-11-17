// 提案 409d571f 第 3 点：历史 fail 一次性失效回填的判据与留痕测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchInvalidationSignature,
  selectBackfillCandidates,
  buildInvalidatedAttempt,
  buildBackfillAudit,
} from '../lib/invalidation-backfill.js';

const wrapped = (over = {}) => ({
  id: 'att_20261117_x', challengeId: 'clg_x', domain: 'integration',
  result: 'fail', reason: 'steps 数量 0 < minLength 3',
  evidence: { steps: { item: ['a', 'b', 'c'] } }, verifiedAt: '2026-11-17T04:39:34.116Z',
  ...over,
});

test('签名命中：steps 被参数层包装成 { item: [...] } 的历史 fail', () => {
  const r = matchInvalidationSignature(wrapped());
  assert.equal(r.matched, true);
  assert.equal(r.signature, 'step-list:steps-wrapped-object');
  // 数字下标形态同样命中
  assert.equal(matchInvalidationSignature(wrapped({ evidence: { steps: { 0: 'a', 1: 'b' } } })).matched, true);
});

test('逃逸口防线：真 fail 一律不命中（签名不匹配不回填）', () => {
  const cases = [
    [wrapped({ reason: 'steps 缺少必需关键词「test」' }), 'reason 非数量签名'],
    [wrapped({ evidence: { steps: ['a', 'b'] }, reason: 'steps 数量 2 < minLength 3' }), 'steps 是真数组'],
    [wrapped({ evidence: {} }), 'steps 字段缺失'],
    [wrapped({ result: 'pass' }), 'result 不是 fail'],
    [wrapped({ invalidated: true }), '已标记'],
    [wrapped({ evidence: { steps: { a: 1, b: 2 } } }), '非已知包装形态'],
  ];
  for (const [attempt, why] of cases) {
    assert.equal(matchInvalidationSignature(attempt).matched, false, `${why} 不应命中`);
  }
});

test('select：只筛出命中签名的，其余进 rejected 并带原因', () => {
  const good1 = wrapped({ id: 'g1' });
  const good2 = wrapped({ id: 'g2', evidence: { steps: { 0: 'a', 1: 'b' } } });
  const bad = wrapped({ id: 'b1', reason: 'conclusion 不匹配' });
  const { candidates, rejected } = selectBackfillCandidates([good1, bad, good2]);
  assert.deepEqual(candidates.map((a) => a.id), ['g1', 'g2']);
  assert.deepEqual(rejected.map((r) => r.id), ['b1']);
  assert.match(rejected[0].why, /签名/);
});

test('buildInvalidatedAttempt：只加标记，result 事实与 evidence 原样保留', () => {
  const src = wrapped();
  const out = buildInvalidatedAttempt(src, { actor: 'human:anmul', reason: '提案409d571f回填' });
  assert.equal(out.result, 'fail', 'result 事实不变（宁 fail 不 pass）');
  assert.equal(out.invalidated, true);
  assert.match(out.invalidationReason, /提案409d571f回填/);
  assert.match(out.invalidationReason, /human:anmul/);
  assert.deepEqual(out.evidence, src.evidence, 'evidence 原样留档');
  assert.equal(src.invalidated, undefined, '不修改入参');
});

test('buildInvalidatedAttempt：actor/reason 缺失即抛（强制留痕）', () => {
  assert.throws(() => buildInvalidatedAttempt(wrapped(), { actor: '', reason: 'x' }), /actor/);
  assert.throws(() => buildInvalidatedAttempt(wrapped(), { actor: 'human:x', reason: '  ' }), /reason/);
});

test('audit 载荷：id 白名单 + dryRun 标记 + 来源可追溯', () => {
  const a = buildBackfillAudit({ ids: ['g1', 'g2'], actor: 'human:anmul', reason: '回填', dryRun: false });
  assert.equal(a.action, 'attempt_invalidation_backfill');
  assert.equal(a.targetId, 'g1,g2');
  assert.equal(a.details.source, 'proposal-409d571f');
  const p = buildBackfillAudit({ ids: ['g1'], actor: 'human:anmul', reason: '预览', dryRun: true });
  assert.equal(p.action, 'attempt_invalidation_backfill_preview');
});
