/**
 * test/deploy-bridge.test.mjs — 部署桥（A 段「通电不上膛」）
 *
 * 钉三件事：
 *   1. 部署腿**通电**：ticket 真的被建出来（此前 mount.request 全仓 0 调用方）
 *   2. ⛔ **绝不上膛**：递给 mount 的 verdict 恒为 PENDING_REVIEW
 *      —— 这是防自动 ACTIVATE / 自动重启的最后一道，改了就触碰重启红线
 *   3. 链条任一环缺失都不硬闯（NO_CTX / NO_SYNTH / NO_MOUNT / STAGE_FAILED）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const { requestSynthMount, PENDING_REVIEW_VERDICT } = await import(
  pathToFileURL(path.join(ROOT, 'plugins/agint-evolution-driver/lib/deploy-bridge.js')).href
);
const { MutationProposalSchema } = await import(
  pathToFileURL(path.join(ROOT, 'plugins/agint-mutator/lib/schema.js')).href
);
const { synthForProposal } = await import(
  pathToFileURL(path.join(ROOT, 'plugins/agint-mutator/lib/synth.js')).href
);

const toolProposal = () => MutationProposalSchema.parse({
  id: 'p-deploy-1',
  kind: 'TOOL_SYNTHESIS',
  source: 'evolution-reversed',
  atomicScope: 'tool',
  status: 'PENDING',
  failureId: 'f-1',
  rootCause: 'TOOL_GAP',
  payload: {
    toolName: 'note',
    signature: '{"type":"object"}',
    stubs: ['async record(input) {\n      return InputSchema.parse(input);\n    },'],
    intent: '存短文本',
  },
  expectedEffect: 'tool 调用成功率 >= 80% within 7 天',
  rollbackCondition: 'harm >10% → rollback',
  preimageHash: 'pre-1',
  createdAt: new Date('2026-10-25T00:00:00.000Z').toISOString(),
});

/** 内存 io：记录落盘，不碰真实磁盘。 */
function memIo() {
  const written = [];
  return {
    written,
    async mkdir() {},
    async writeFile(p, content) { written.push({ path: p, content }); },
  };
}

/** mock ctx：记录 mount 收到的入参。 */
function mockCtx({ withMount = true, withSynth = true } = {}) {
  const seen = [];
  const services = {
    'agint.mutator': withSynth ? { synthForProposal } : undefined,
    'agint.mount.request': withMount
      ? async (input) => {
        seen.push(input);
        return {
          ticketId: 't-1',
          phase: 'PREPARED',
          decision: input?.verdict?.decision ?? null,
        };
      }
      : undefined,
  };
  return { seen, ctx: { get: (k) => services[k] } };
}

test('A 通电：合成产物被递交 mount，ticket 真的建出来', async () => {
  const { ctx, seen } = mockCtx();
  const io = memIo();
  const r = await requestSynthMount({ ctx, proposal: toolProposal(), io, stagingRoot: '/tmp/stage' });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.ticketId, 't-1');
  assert.equal(r.files, 5);
  assert.equal(r.pluginId, 'agint-synth-note');
  assert.equal(seen.length, 1, 'mount.request 应被调用 1 次');
});

test('A 不上膛：递给 mount 的 verdict 恒为 PENDING_REVIEW', async () => {
  const { ctx, seen } = mockCtx();
  await requestSynthMount({ ctx, proposal: toolProposal(), io: memIo(), stagingRoot: '/tmp/stage' });
  assert.equal(seen.length, 1);
  const verdict = seen[0].verdict;
  assert.equal(verdict.decision, 'PENDING_REVIEW');
  // 负控自证：这一条是防自动 ACTIVATE 的关键，改了就触碰重启红线
  assert.deepEqual(verdict, PENDING_REVIEW_VERDICT);
  assert.equal(verdict.policyDecision, undefined, '不该夹带任何会绕过 PENDING_REVIEW 的字段');
});

test('A 不上膛：产物落盘到 staging，但 ticket 停在 PREPARED（不 INSTALLED / 不 ACTIVATED）', async () => {
  const io = memIo();
  const { ctx } = mockCtx();
  const r = await requestSynthMount({ ctx, proposal: toolProposal(), io, stagingRoot: '/tmp/stage' });
  assert.equal(r.phase, 'PREPARED');
  assert.equal(r.decision, 'PENDING_REVIEW');
  assert.ok(r.stagedAt.startsWith('/tmp/stage/agint-synth-note-'));
  assert.equal(io.written.length, 5);
  assert.ok(io.written.some((f) => f.path.endsWith('/lib/index.js')), '产物源码必须落在 lib/ 下');
});

test('A 链条缺失：合成器不可用 → NO_SYNTH，不硬闯', async () => {
  const { ctx } = mockCtx({ withSynth: false });
  const r = await requestSynthMount({ ctx, proposal: toolProposal(), io: memIo() });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_SYNTH');
});

test('A 链条缺失：mount 不可用 → NO_MOUNT，不硬闯', async () => {
  const { ctx } = mockCtx({ withMount: false });
  const r = await requestSynthMount({ ctx, proposal: toolProposal(), io: memIo() });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_MOUNT');
});

test('A 非 TOOL_SYNTHESIS proposal 一律拒（不喂给 mount）', async () => {
  const { ctx, seen } = mockCtx();
  const bad = toolProposal();
  bad.kind = 'PROMPT_MUTATION';
  const r = await requestSynthMount({ ctx, proposal: bad, io: memIo() });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_TOOL_SYNTHESIS');
  assert.equal(seen.length, 0, '不该把 PROMPT_MUTATION 递给 mount');
});

test('A ctx 缺失 → NO_CTX', async () => {
  assert.equal((await requestSynthMount({ ctx: null, proposal: toolProposal() })).code, 'NO_CTX');
  assert.equal((await requestSynthMount({ proposal: toolProposal() })).code, 'NO_CTX');
});

test('A 落盘失败 → STAGE_FAILED，且不递交 mount', async () => {
  const { ctx, seen } = mockCtx();
  const badIo = {
    async mkdir() {},
    async writeFile() { throw new Error('ENOSPC'); },
  };
  const r = await requestSynthMount({ ctx, proposal: toolProposal(), io: badIo, stagingRoot: '/tmp/stage' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'STAGE_FAILED');
  assert.equal(seen.length, 0, '落盘失败就不该递交 mount');
});

test('A 不落盘也能建 ticket（stagingRoot 缺省时跳过落盘，不误伤）', async () => {
  const { ctx } = mockCtx();
  const r = await requestSynthMount({ ctx, proposal: toolProposal(), io: memIo() });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.stagedAt, null);
});
