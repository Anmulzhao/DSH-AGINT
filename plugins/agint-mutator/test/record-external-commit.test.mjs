#!/usr/bin/env node
// agint-mutator / recordExternalCommit unit test — `node test/record-external-commit.test.mjs`
//
// A5（2026-10-03）：这个入口存在的唯一理由是**让 driver 走自己落盘路径产出的 commit
// 也能被 mutator.rollback 回滚**。所以核心用例不是"表里多了一行"，而是
// 「记账 → rollback → 文件真的回到 preimage」这条闭环必须通。
//
// 另一半覆盖面是"不许假装"：缺 preimageContent 必须显式失败（不能拿空串兜底，
// 那会让 rollback 把文件写成空），超限必须拒绝，幂等必须不重复写。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from '../lib/index.js';
// unpackCommit 住在 storage.js，不在插件导出面 —— 第一版误用 plugin.unpackCommit
// 才发现。记账行的形状断言必须真的过一遍 unpack，否则等于在断言我自己写的对象。
import { unpackCommit } from '../lib/storage.js';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { LIMITS } = plugin;

// ── fixtures ────────────────────────────────────────────────────────

const PREIMAGE = 'OLD prompt content';
const POSTIMAGE = 'NEW prompt content';
const REL = 'plugins/agint-mutator/prompts/sys-prompt.md';
const PROPOSAL_ID = '11111111-2222-3333-4444-555555555555';
const COMMIT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** mock sandbox：rollback 的 step 3-5 smoke test 用。 */
const mockSandbox = {
  runSmoke: async ({ target }) => ({
    target: { path: target.path, name: target.name },
    ok: true, mode: 'in-process', exitCode: 0,
    stdout: '', stderr: '', checks: [], durationMs: 1,
  }),
};

function makeEnv() {
  const workdir = mkdtempSync(join(tmpdir(), 'agint-mutator-ext-'));
  mkdirSync(join(workdir, 'plugins', 'agint-mutator', 'prompts'), { recursive: true });
  const tables = { proposals: new Map(), commits: new Map(), findings: new Map(), metrics_log: new Map() };
  const services = {};
  plugin.apply({
    storageDomain: {
      open: async () => ({
        table: (name) => {
          const s = tables[name] || (tables[name] = new Map());
          return {
            // ⛔ size 必须给：recordExternalCommit 的 LIMITS 守门读 tC.size。
            // 缺 size ⇒ undefined >= cap 恒 false ⇒ 守门永不触发（与 eval 场景
            // service-annotations-table-full-throws 同根因的镜像版，见A4 归因报告）。
            size: s.size,
            entries: () => Array.from(s, ([id, v]) => ({ id, ...v })),
            put: async (id, v) => { s.set(id, v); },
            close: async () => {},
          };
        },
        close: async () => {},
      }),
    },
    get: (n) => {
      if (n === 'agint.qualitySandbox') return mockSandbox;
      if (n === 'agint.qualityPolicy') {
        return { decide: async () => ({ kind: 'AUTO_DEPLOY', score: 80, reason: 'mock' }), detectFalseHarmony: async () => ({}), setThresholds: async () => ({}), health: () => ({ serviceAvailable: true }), config: {} };
      }
      if (n === 'agint.diagnosis') return { annotate: async () => [], report: async () => ({}) };
      if (n === 'agint.evolution') return { queryFailures: async () => [] };
      return null;
    },
    provide: (n, f) => { services[n] = f; },
    effect: () => () => {},
  });
  return { services, tables, workdir, cleanup: () => rmSync(workdir, { recursive: true, force: true }) };
}

/** 合法的 recordExternalCommit 入参。 */
function baseInput(over = {}) {
  return {
    commitId: COMMIT_ID,
    proposalId: PROPOSAL_ID,
    targetPath: REL,
    preimageContent: PREIMAGE,
    postimageHash: 'f'.repeat(64),
    policyDecision: 'AUTO_DEPLOY',
    audit: {
      proposalId: PROPOSAL_ID,
      commitId: COMMIT_ID,
      kind: 'PROMPT_MUTATION',
      source: 'evolution-reversed',
      timestamp: '2026-10-03T00:00:00.000Z',
      sandboxResult: 'ok',
      rollbackTrigger: 'regression -> rollback',
    },
    ...over,
  };
}

// ── 核心闭环：记账 → rollback 真的还原文件 ──────────────────────────

test('闭环: recordExternalCommit 记账后，rollback 能把文件还原回 preimage', async () => {
  const env = makeEnv();
  try {
    // 模拟 driver 已落盘：文件现在是 postimage
    const abs = join(env.workdir, REL);
    writeFileSync(abs, POSTIMAGE, 'utf8');
    // rollback 的 step 3 要读 proposal 决定「写回」还是「unlink」（kind=TOOL_SYNTHESIS
    // 才unlink）。driver 路径的 proposal 同样来自 evolve，不一定在 mutator.proposals 表里，
    // 但**可回滚性**要求它在 —— 没有它 rollback 直接抛「commit 残留？」。
    env.tables.proposals.set(PROPOSAL_ID, {
      id: PROPOSAL_ID, kind: 'PROMPT_MUTATION', status: 'PENDING', atomicScope: 'prompt',
      source: 'evolution-reversed',
    });

    const rec = await env.services['agint.mutator.recordExternalCommit'](baseInput());
    assert.equal(rec.ok, true);
    assert.equal(rec.recorded, true);
    assert.equal(rec.commitId, COMMIT_ID);
    assert.equal(env.tables.commits.size, 1, 'commits 表必须真的多一行 —— 否则 mutatorCommits 恒 0');

    const row = Array.from(env.tables.commits.values())[0];
    assert.equal(row.preimageContent, PREIMAGE, 'preimageContent 是 rollback 的唯一凭据，必须存原文');
    assert.notEqual(row.preimageHash, PREIMAGE, 'preimageHash 是内容哈希，不是内容本身');

    // 真能还原 —— 这是整个入口的存在理由
    const rb = await env.services['agint.mutator.rollback']({ commitId: COMMIT_ID, repoRoot: env.workdir });
    assert.equal(rb.ok, true);
    assert.equal(readFileSync(abs, 'utf8'), PREIMAGE, 'rollback 后文件必须回到 preimage');
  } finally { env.cleanup(); }
});

test('⛔ 记账后 proposal 缺失 ⇒ rollback 不可用（这是记账的前提，不是记账的失败）', async () => {
  const env = makeEnv();
  try {
    const abs = join(env.workdir, REL);
    writeFileSync(abs, POSTIMAGE, 'utf8');
    // 不建 proposal 行：记账本身成功，但记 reason
    const rec = await env.services['agint.mutator.recordExternalCommit'](baseInput());
    assert.equal(rec.recorded, true);
    assert.equal(rec.reason, 'proposal-absent');
    // rollback 会因查不到 proposal 而拒绝 —— 记下这个事实，别让测试假装它能回滚
    await assert.rejects(
      () => env.services['agint.mutator.rollback']({ commitId: COMMIT_ID, repoRoot: env.workdir }),
      /查不到/,
    );
    assert.equal(readFileSync(abs, 'utf8'), POSTIMAGE, '拒绝时不得改动文件');
  } finally { env.cleanup(); }
});

test('记账行过 packCommit schema（unpackCommit 各字段齐）', async () => {
  const env = makeEnv();
  try {
    await env.services['agint.mutator.recordExternalCommit'](baseInput());
    const row = Array.from(env.tables.commits.values())[0];
    const unpacked = unpackCommit(row);
    assert.equal(unpacked.ok, true);
    assert.equal(unpacked.commitId, COMMIT_ID);
    assert.equal(unpacked.targetPath, REL);
    assert.equal(unpacked.policyDecision, 'AUTO_DEPLOY');
    assert.equal(unpacked.audit.proposalId, PROPOSAL_ID);
    assert.ok(unpacked.preimageHash.length > 0);
  } finally { env.cleanup(); }
});

// ── 显式失败：缺料不许兜底 ──────────────────────────────────────────

test('缺 preimageContent → 抛错（不接受空串兜底：空串会让 rollback 把文件清空）', async () => {
  const env = makeEnv();
  try {
    const input = baseInput();
    delete input.preimageContent;
    await assert.rejects(
      () => env.services['agint.mutator.recordExternalCommit'](input),
      /缺 preimageContent/,
    );
    assert.equal(env.tables.commits.size, 0, '失败必须不写表');
  } finally { env.cleanup(); }
});

test('preimageContent 是空串 → 显式拒绝（它与"缺失"同样不可回滚）', async () => {
  const env = makeEnv();
  try {
    // 空串在 schema 层合法（preimageContent: min(0)），所以必须靠调用侧守卫拦。
    // 真实场景是 TOOL_SYNTHESIS 新建文件确实没有 preimage —— 那种情况 driver
    // 应走别的入口，不该记一条"可回滚到空"的账。
    await assert.rejects(
      () => env.services['agint.mutator.recordExternalCommit'](baseInput({ preimageContent: '' })),
      /不接受空串兜底|缺 preimageContent/,
    );
    assert.equal(env.tables.commits.size, 0);
  } finally { env.cleanup(); }
});

test('缺 commitId / proposalId / targetPath / postimageHash / audit → 各自抛错', async () => {
  const env = makeEnv();
  try {
    for (const k of ['commitId', 'proposalId', 'targetPath', 'postimageHash', 'audit']) {
      const input = baseInput();
      delete input[k];
      await assert.rejects(
        () => env.services['agint.mutator.recordExternalCommit'](input),
        new RegExp(`缺 ${k}`),
        `缺 ${k} 必须显式失败`,
      );
    }
    assert.equal(env.tables.commits.size, 0);
  } finally { env.cleanup(); }
});

// ── 守门与幂等 ──────────────────────────────────────────────────────

test('preimageContent 超 LIMITS.PREIMAGE_BYTES → 抛错，不截断不写表', async () => {
  const env = makeEnv();
  try {
    const tooBig = 'x'.repeat(LIMITS.PREIMAGE_BYTES + 1);
    await assert.rejects(
      () => env.services['agint.mutator.recordExternalCommit'](baseInput({ preimageContent: tooBig })),
      /PREIMAGE_BYTES/,
    );
    assert.equal(env.tables.commits.size, 0);
  } finally { env.cleanup(); }
});

test('commits 表满 → 抛错（守门读 size，size 缺失就会永不触发）', async () => {
  const env = makeEnv();
  try {
    for (let i = 0; i < LIMITS.COMMITS; i++) {
      env.tables.commits.set(`filler-${i}`, { id: `filler-${i}` });
    }
    await assert.rejects(
      () => env.services['agint.mutator.recordExternalCommit'](baseInput()),
      /commits table full/,
    );
    assert.equal(env.tables.commits.size, LIMITS.COMMITS, '被拒时不得半路写入');
  } finally { env.cleanup(); }
});

test('幂等: 同 commitId 记两次 → recorded:false 且表里仍只有一行', async () => {
  const env = makeEnv();
  try {
    const a = await env.services['agint.mutator.recordExternalCommit'](baseInput());
    const b = await env.services['agint.mutator.recordExternalCommit'](baseInput({ preimageContent: '别的内容' }));
    assert.equal(a.recorded, true);
    assert.equal(b.recorded, false);
    assert.equal(b.reason, 'duplicate');
    assert.equal(env.tables.commits.size, 1, '重复记账不得覆盖或新增');
    const row = Array.from(env.tables.commits.values())[0];
    assert.equal(row.preimageContent, PREIMAGE, '幂等命中时保留首次写入的内容');
  } finally { env.cleanup(); }
});

// ── proposal 状态推进（proposals 有 uniq_atomicScope_pending 唯一索引）──

test('proposal 在表里 → 状态推成 COMMITTED（否则同scope 的下一个提案被永久挡住）', async () => {
  const env = makeEnv();
  try {
    env.tables.proposals.set(PROPOSAL_ID, {
      id: PROPOSAL_ID, status: 'PENDING', atomicScope: 'prompt', kind: 'PROMPT_MUTATION',
    });
    const rec = await env.services['agint.mutator.recordExternalCommit'](baseInput());
    assert.equal(rec.recorded, true);
    assert.equal(env.tables.proposals.get(PROPOSAL_ID).status, 'COMMITTED');
  } finally { env.cleanup(); }
});

test('policyDecision 为 REJECT → proposal 推成 REJECTED（不是 COMMITTED）', async () => {
  const env = makeEnv();
  try {
    env.tables.proposals.set(PROPOSAL_ID, { id: PROPOSAL_ID, status: 'PENDING', atomicScope: 'prompt' });
    await env.services['agint.mutator.recordExternalCommit'](baseInput({ policyDecision: 'REJECT' }));
    assert.equal(env.tables.proposals.get(PROPOSAL_ID).status, 'REJECTED');
  } finally { env.cleanup(); }
});

test('proposal 不在表里 → 记账仍成功，但 reason 报 proposal-absent（不静默）', async () => {
  const env = makeEnv();
  try {
    const rec = await env.services['agint.mutator.recordExternalCommit'](baseInput());
    assert.equal(rec.ok, true);
    assert.equal(rec.recorded, true, '账必须记上 —— 记不上这条 commit 就永远不可回滚');
    assert.equal(rec.reason, 'proposal-absent');
  } finally { env.cleanup(); }
});

// ── 导出契约 ────────────────────────────────────────────────────────

test('导出契约: recordExternalCommit 挂在 agint.mutator 服务面上', () => {
  const env = makeEnv();
  try {
    assert.equal(typeof env.services['agint.mutator.recordExternalCommit'], 'function');
  } finally { env.cleanup(); }
});