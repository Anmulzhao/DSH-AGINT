// agint-evolution-driver：提案级全组事务（2026-11-07）
//
// 这一组钉的是**原子性**，不是「能不能改代码」：
//   ① 全部通过 ⇒ 全部写盘、全部记账
//   ② construct / verify / gate 任一失败 ⇒ write 一次都不许发生（negative control）
//   ③ 写盘中途失败 ⇒ 整组回滚，commits 必须为空
//   ④ 模型答 applicable=false ⇒ 跳过该单元，其余照常落地
//   ⑤ computePostimage 的幻觉闸：oldText 不唯一 / 空编辑 / 新建空内容
//   ⑥ 记账失败不回滚已过闸门的改动（账目问题 ≠ 安全问题）
//
// 运行：node --test test/proposal-transaction.test.mjs

import assert from 'node:assert/strict';
import { executeProposalTransaction, computePostimage } from '../lib/proposal-transaction.js';

const units = (n) => Array.from({ length: n }, (_, i) => ({
  id: `f${i}.js`, kind: 'edit', text: 'const v = 1;\n',
}));

function hooks(over = {}) {
  const calls = { construct: 0, verify: 0, decide: 0, validate: 0, propose: 0, write: 0, restore: 0, record: 0 };
  const base = {
    construct: async ({ unit }) => {
      calls.construct += 1;
      return { applicable: true, edit: { oldText: 'const v = 1;', newText: 'const v = 2;', rationale: '' }, rationale: '' };
    },
    verify: async () => { calls.verify += 1; return { ok: true, mode: 'syntax' }; },
    decide: async () => { calls.decide += 1; return 'AUTO_DEPLOY'; },
    propose: async () => { calls.propose += 1; return { id: 'm1' }; },
    validate: async () => { calls.validate += 1; return { ok: true, findings: [] }; },
    write: async ({ unit }) => {
      calls.write += 1;
      return { ok: true, path: unit.id, preimageContent: 'const v = 1;\n', postimageContent: 'const v = 2;\n' };
    },
    restoreMany: async (written) => { calls.restore += 1; return { ok: true, restored: written.length }; },
    record: async () => { calls.record += 1; },
  };
  return { ...base, ...over, calls, _calls: calls };
}

// ── ① 全部通过 ────────────────────────────────────────────────────────
{
  const h = hooks();
  const out = await executeProposalTransaction({ units: units(3), hooks: h });
  assert.equal(out.ok, true);
  assert.equal(out.phase, 'done');
  assert.equal(out.commits.length, 3);
  assert.equal(h._calls.construct, 3);
  assert.equal(h._calls.verify, 3, '每个单元都要在写盘前验证');
  assert.equal(h._calls.decide, 3);
  assert.equal(h._calls.write, 3);
  assert.equal(h._calls.record, 1);
}

// ── ② 前置阶段失败 ⇒ write 一次都不许发生 ──────────────────────────────
for (const [phase, over] of [
  ['construct', { construct: async () => ({ ok: false, reason: 'llm judged not applicable' }) }],
  ['verify', { verify: async () => ({ ok: false, reason: 'SyntaxError' }) }],
  ['gate', { decide: async () => 'REJECT' }],
  ['gate', { validate: async () => ({ ok: false, findings: ['unsafe'] }) }],
]) {
  const h = hooks(over);
  const out = await executeProposalTransaction({ units: units(3), hooks: h });
  assert.equal(out.ok, false, `${phase} 失败必须整体失败`);
  assert.equal(out.phase, phase, `失败阶段必须是 ${phase}`);
  assert.equal(h._calls.write, 0, '⛔ 前置阶段不许写盘 —— 这是事务的全部意义');
  assert.equal(out.commits.length, 0);
  assert.equal(h._calls.restore, 0, '没写盘就不需要回滚');
}

// ── ③ 写盘中途失败 ⇒ 整组回滚 ──────────────────────────────────────────
{
  let n = 0;
  const h = hooks({
    write: async ({ unit }) => {
      n += 1;
      if (n === 2) return { ok: false, reason: 'EPERM' };
      return { ok: true, path: unit.id, preimageContent: 'before', postimageContent: 'after' };
    },
  });
  const out = await executeProposalTransaction({ units: units(3), hooks: h });
  assert.equal(out.ok, false);
  assert.equal(out.phase, 'write');
  assert.equal(h._calls.restore, 1, '必须调用整组回滚');
  assert.equal(out.reverted, true);
  assert.equal(out.commits.length, 0, '⛔ 不许把前两个已落地的算成成功');
}

// ── ④ applicable=false ⇒ 跳过，其余照常 ────────────────────────────────
{
  const h = hooks({
    construct: async ({ unit }) => (unit.id === 'f1.js'
      ? { applicable: false, rationale: 'already correct' }
      : { applicable: true, edit: { oldText: 'const v = 1;', newText: 'const v = 2;' } }),
  });
  const out = await executeProposalTransaction({ units: units(3), hooks: h });
  assert.equal(out.ok, true);
  assert.equal(out.commits.length, 2);
  assert.deepEqual(out.skipped, ['f1.js']);
}

// ── ⑤ computePostimage 幻觉闸 ──────────────────────────────────────────
{
  assert.equal(computePostimage({ text: 'a\na' }, { oldText: 'a', newText: 'b' }).ok, false,
    'oldText 不唯一必须拒');
  assert.equal(computePostimage({ text: 'a' }, { oldText: 'a', newText: 'a' }).ok, false,
    '空编辑必须拒');
  assert.equal(computePostimage({ text: 'a' }, { oldText: '', newText: 'b' }).ok, false);
  assert.equal(computePostimage({ kind: 'create' }, { content: '' }).ok, false);
  assert.equal(computePostimage({ kind: 'create' }, { content: 'export const x = 1;\n' }).ok, true);
}

// ── ⑥ 记账失败不回滚（改动已过全部闸门）────────────────────────────────
{
  const h = hooks({ record: async () => { throw new Error('bus down'); } });
  const out = await executeProposalTransaction({ units: units(2), hooks: h });
  assert.equal(out.ok, true, '记账失败不是安全问题');
  assert.equal(out.recordFailed, true);
  assert.equal(out.commits.length, 2);
  assert.equal(h._calls.restore, 0);
}

console.log('proposal-transaction.test.mjs: all cases passed');
