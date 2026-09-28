/**
 * tool-addition bridge 测试（行动 #3，2026-09-28）。
 * 覆盖：增量计算、tool-addition 块生成、KV Cache append-only 判据（前缀不变量）、
 * 通知桥的软依赖降级与可达路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeToolDeltas,
  buildToolAdditionBlock,
  assertToolAdditionAppendOnly,
  notifyToolAddition,
} from '../lib/tool-addition.js';

const BASELINE = [
  { name: 'tool_a' },
  { name: 'tool_b' },
  { name: 'tool_c' },
];

test('computeToolDeltas: 新增工具进 additions、移除进 removals', () => {
  const current = [{ name: 'tool_a' }, { name: 'tool_c' }, { name: 'tool_new' }];
  const r = computeToolDeltas(BASELINE, current);
  assert.deepEqual(r.additions, ['tool_new']);
  assert.deepEqual(r.removals, ['tool_b']);
});

test('computeToolDeltas: 无变化 → 空增量', () => {
  const r = computeToolDeltas(BASELINE, BASELINE);
  assert.deepEqual(r, { additions: [], removals: [] });
});

test('buildToolAdditionBlock: 与宿主 agent-loop 语义一致的块', () => {
  assert.deepEqual(buildToolAdditionBlock('tool_x'), { type: 'tool-addition', toolName: 'tool_x' });
});

test('assertToolAdditionAppendOnly: 仅新增 → appendOnly:true + additions-only', () => {
  const current = [...BASELINE, { name: 'tool_new' }];
  const r = assertToolAdditionAppendOnly({ baselineTools: BASELINE, currentTools: current });
  assert.equal(r.appendOnly, true);
  assert.equal(r.reason, 'additions-only');
  assert.deepEqual(r.additions, ['tool_new']);
  assert.deepEqual(r.blocks, [{ type: 'tool-addition', toolName: 'tool_new' }]);
});

test('assertToolAdditionAppendOnly: 新增 + 移除 → appendOnly:true + additions-and-removals', () => {
  const current = [{ name: 'tool_a' }, { name: 'tool_c' }, { name: 'tool_new' }];
  const r = assertToolAdditionAppendOnly({ baselineTools: BASELINE, currentTools: current });
  assert.equal(r.appendOnly, true);
  assert.equal(r.reason, 'additions-and-removals');
  assert.deepEqual(r.additions, ['tool_new']);
  assert.deepEqual(r.removals, ['tool_b']);
});

test('assertToolAdditionAppendOnly: 无变化 → no-change', () => {
  const r = assertToolAdditionAppendOnly({ baselineTools: BASELINE, currentTools: BASELINE });
  assert.equal(r.appendOnly, true);
  assert.equal(r.reason, 'no-change');
});

test('assertToolAdditionAppendOnly: 既有工具顺序被重排 → appendOnly:false（KV Cache 前缀失效）', () => {
  // tool_b 从中间被挪到最前 = 请求头前缀重排，append-only 无法表达 → 判 false。
  const current = [{ name: 'tool_b' }, { name: 'tool_a' }, { name: 'tool_c' }];
  const r = assertToolAdditionAppendOnly({ baselineTools: BASELINE, currentTools: current });
  assert.equal(r.appendOnly, false);
  assert.equal(r.reason, 'existing tool order changed');
});

test('assertToolAdditionAppendOnly: 只在尾部追加新工具 → 前缀相对顺序保持', () => {
  // 关键用例：AGINT 发布技能后，宿主 agent-loop 把新技能追加在现有工具列表尾部
  // （additions 在 current 尾部）—— 前缀 tool_a/tool_b/tool_c 相对顺序不变。
  const current = [...BASELINE, { name: 'agint_skill_x' }];
  const r = assertToolAdditionAppendOnly({ baselineTools: BASELINE, currentTools: current });
  assert.equal(r.appendOnly, true);
  assert.deepEqual(r.additions, ['agint_skill_x']);
});

test('notifyToolAddition: ctx 不可用 → deferred（发布不受影响）', async () => {
  const r = await notifyToolAddition({ ctx: null, skillName: 's1' });
  assert.deepEqual(r, { notified: false, deferred: true, reason: 'ctx unavailable' });
});

test('notifyToolAddition: agents 服务不可用 → deferred', async () => {
  const r = await notifyToolAddition({ ctx: { get: () => undefined }, skillName: 's1' });
  assert.deepEqual(r, { notified: false, deferred: true, reason: 'agents service unavailable' });
});

test('notifyToolAddition: agents 可用 → 走 host-agent-loop 路径（kvCacheSafe 固化）', async () => {
  let got = null;
  const r = await notifyToolAddition({
    ctx: { get: (n) => { got = n; return { create: async () => ({}) }; } },
    skillName: 'my-skill',
  });
  assert.equal(got, 'agents');
  assert.equal(r.notified, true);
  assert.equal(r.path, 'host-agent-loop');
  assert.equal(r.toolName, 'my-skill');
  assert.equal(r.kvCacheSafe, true);
});
