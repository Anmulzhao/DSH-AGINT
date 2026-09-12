/**
 * agint-trajectory 导出单测（§6，Sprint 19 T8）。
 *
 * 断言三件事：映射规范（Q4 折叠）、分离导出（不变量 #3）、导出自检（§6.1
 * 「不允许带病交付」）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { toShareGpt, toIndexEntry, buildExport, validateExport, writeExport, systemPreamble } from '../lib/export.js';
import { createMemFs } from './_helpers.mjs';

const traj = (over = {}) => ({
  id: 'traj_20261103_a1b2c3d4',
  source: 'evolution',
  kind: 'success',
  title: 'evolution round 7',
  taskRef: { variantId: 'v-7', round: 7 },
  startedAt: '2026-11-03T00:00:00Z',
  endedAt: '2026-11-03T00:02:00Z',
  durationMs: 120000,
  usage: { tokensIn: 8211, tokensOut: 1940, toolCalls: 3 },
  outcome: {},
  payload: {
    steps: [
      { seq: 0, role: 'system', content: 'you are AGINT' },
      { seq: 1, role: 'human', content: 'run mutation' },
      { seq: 2, role: 'gpt', content: 'ok' },
      { seq: 3, role: 'observation', content: 'tool result' },
    ],
    final: { decision: 'PROMOTE' },
  },
  ...over,
});

test('ShareGPT 映射：system/human/gpt/observation 四角色直出（§6.1）', () => {
  const r = toShareGpt(traj());
  assert.deepEqual(r.conversations.map((c) => c.from), ['system', 'human', 'gpt', 'observation']);
  assert.equal(r.id, 'traj_20261103_a1b2c3d4');
});

test('foldObservation=true：observation 折叠为 human 前缀 Observation:', () => {
  const r = toShareGpt(traj(), { foldObservation: true });
  const last = r.conversations[r.conversations.length - 1];
  assert.equal(last.from, 'human');
  assert.ok(last.value.startsWith('Observation: '));
  assert.equal(r.conversations.filter((c) => c.from === 'observation').length, 0);
});

test('无 system 步时自动补元数据 system 轮（source/round 等）', () => {
  const noSystem = traj({ payload: { steps: [{ seq: 0, role: 'human', content: 'hi' }] } });
  const r = toShareGpt(noSystem);
  assert.equal(r.conversations[0].from, 'system');
  assert.match(r.conversations[0].value, /source=evolution/);
  assert.match(r.conversations[0].value, /round=7/);
  assert.match(systemPreamble(traj()), /variant=v-7/);
});

test('分离导出（不变量 #3）：success 与 failure 永不混写；aborted 归失败侧', () => {
  const rows = [
    traj({ id: 'a', kind: 'success' }),
    traj({ id: 'b', kind: 'failure', outcome: { errorClass: 'ENVIRONMENT_SHIFT' } }),
    traj({ id: 'c', kind: 'aborted' }),
  ];
  const out = buildExport(rows, { format: 'sharegpt' });
  assert.equal(out.success.length, 1);
  assert.equal(out.failure.length, 2);
  assert.deepEqual(out.counts, { success: 1, failure: 2, total: 3 });
  const idx = out.index.find((e) => e.trajId === 'b');
  assert.equal(idx.errorClass, 'ENVIRONMENT_SHIFT');
  assert.equal(idx.kind, 'failure');
});

test('jsonl 格式：原始轨迹逐行，sidecar 同时产出', () => {
  const out = buildExport([traj()], { format: 'jsonl' });
  const parsed = JSON.parse(out.success[0]);
  assert.equal(parsed.id, 'traj_20261103_a1b2c3d4');
  assert.equal(parsed.source, 'evolution');
});

test('导出自检：非法行被检出（valid=false + 错误定位）', () => {
  const bad = [
    JSON.stringify({ id: 'x', conversations: [{ from: 'human', value: 'v' }] }),
    '{not-json',
    JSON.stringify({ id: 'y', conversations: [{ from: 'alien', value: 'v' }] }),
    JSON.stringify({ id: 'z', conversations: [] }),
  ];
  const r = validateExport(bad, 'sharegpt');
  assert.equal(r.valid, false);
  assert.equal(r.invalid, 3);
  assert.ok(r.errors.some((e) => e.includes('JSON.parse failed')));
  assert.ok(r.errors.some((e) => e.includes("illegal from='alien'")));
  assert.ok(r.errors.some((e) => e.includes('conversations empty')));
  assert.equal(validateExport([bad[0]], 'sharegpt').valid, true);
});

test('writeExport：成功/失败/索引三文件分离落盘，路径用 path.join（跨平台）', async () => {
  const fs = createMemFs();
  const rows = [traj({ id: 'a', kind: 'success' }), traj({ id: 'b', kind: 'failure' })];
  const built = buildExport(rows, { format: 'sharegpt' });
  const res = await writeExport({ dir: '/tmp/exp', date: '2026-11-16', format: 'sharegpt', ...built, fs });
  assert.ok(res.successPath.endsWith('sharegpt-success-2026-11-16.jsonl'));
  assert.ok(res.failurePath.endsWith('sharegpt-failure-2026-11-16.jsonl'));
  assert.ok(res.indexPath.endsWith('index-2026-11-16.json'));
  assert.equal(res.valid, true);
  const idx = JSON.parse(await fs.readFile(res.indexPath));
  assert.equal(idx.entries.length, 2);
  assert.equal(idx.counts.failure, 1);
  // 分离：成功文件里不含失败 id
  const okText = await fs.readFile(res.successPath);
  assert.ok(!okText.includes('"b"'));
});

test('writeExport 缺 dir 抛错（不静默）', async () => {
  await assert.rejects(() => writeExport({ format: 'sharegpt', success: [], failure: [], index: [], fs: createMemFs() }), /dir required/);
});

test('toIndexEntry：元数据不进 ShareGPT 体，只在 sidecar', () => {
  const e = toIndexEntry(traj({ truncated: true, redacted: true }));
  assert.equal(e.trajId, 'traj_20261103_a1b2c3d4');
  assert.equal(e.usage.tokensIn, 8211);
  assert.equal(e.truncated, true);
  assert.equal(e.redacted, true);
  const body = JSON.stringify(toShareGpt(traj()));
  assert.ok(!body.includes('truncated'), 'kind/元数据不污染 ShareGPT 体');
});
