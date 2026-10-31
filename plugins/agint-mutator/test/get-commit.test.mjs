#!/usr/bin/env node
// agint-mutator / getCommit 单元测试 — `node test/get-commit.test.mjs`
//
// 2026-10-31：这个服务补的是一个**从来没存在过的接口**。消费方（agint-population 的
// fixate）按 `typeof mutator.commit?.get === 'function'` 探测，条件恒 false ⇒ 那段
// 「hash 校验」静默跳过三个月，测试还用 `commit: { get: fn }` 的假 mock 把它喂绿。
//
// 所以本文件的重心不是「函数能返回东西」，而是三件容易被糊过去的事：
//   ① **按 proposalId 反查**：driver 路径下 ingest 早于 commit，variants 里只有 proposalId，
//      只支持 commitId 等于让唯一的使用方永远查不到（这比「接口不存在」更难发现）；
//   ② **查不到返回 null 而不是抛错**：查不到是正常情形（ingest 早于 commit / 被 prune），
//      抛错会逼调用方 try/catch 再吞掉，等于又把「没凭据」伪装成「有凭据」；
//   ③ **与 recordExternalCommit 双向对拍**：读接口必须能读到记账入口写进去的那一行，
//      否则又是一次「各自测自己造的对象」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as plugin from '../lib/index.js';

const PROPOSAL_ID = 'pppppppp-0000-0000-0000-000000000001';
const COMMIT_ID = 'cccccccc-0000-0000-0000-000000000002';

function makeEnv() {
  const tables = { proposals: new Map(), commits: new Map(), findings: new Map(), metrics_log: new Map() };
  const services = {};
  plugin.apply({
    storageDomain: {
      open: async () => ({
        table: (name) => {
          const s = tables[name] || (tables[name] = new Map());
          return {
            // 真实契约：entries() 是 [key, value] 元组迭代器（dsh-storage-domain KvTableImpl）
            get size() { return s.size; },
            entries: () => [...s.entries()][Symbol.iterator](),
            put: async (id, v) => { s.set(id, v); },
            close: async () => {},
          };
        },
        close: async () => {},
      }),
    },
    get: (n) => {
      if (n === 'agint.qualitySandbox') return { runSmoke: async () => ({ ok: true }) };
      if (n === 'agint.qualityPolicy') return { decide: async () => ({ kind: 'AUTO_DEPLOY' }) };
      if (n === 'agint.diagnosis') return { annotate: async () => [] };
      if (n === 'agint.evolution') return { queryFailures: async () => [] };
      return null;
    },
    provide: (n, f) => { services[n] = f; },
    effect: () => () => {},
  });
  return { tables, services };
}

/** 直接往 commits 表塞一行（形状按 packCommit 的产物，即 unpackCommit 能吃的那种）。 */
function seedCommit(tables, over = {}) {
  const row = {
    id: COMMIT_ID,
    ok: true,
    commitId: COMMIT_ID,
    postimageHash: 'f'.repeat(64),
    committedAt: '2026-10-31T00:00:00.000Z',
    policyDecision: 'AUTO_DEPLOY',
    audit: { proposalId: PROPOSAL_ID, commitId: COMMIT_ID, kind: 'PROMPT_MUTATION', source: 'evolution-reversed' },
    proposalId: PROPOSAL_ID,
    preimageHash: 'a'.repeat(64),
    preimageContent: 'OLD prompt content',
    targetPath: 'presets/agint/skills/plugin-preflight/SKILL.md',
    ...over,
  };
  tables.commits.set(row.id, row);
  return row;
}

test('按 commitId 命中 → 返回 unpackCommit 形态（含 preimageContent）', async () => {
  const env = makeEnv();
  try {
    seedCommit(env.tables);
    const r = await env.services['agint.mutator.getCommit']({ commitId: COMMIT_ID });
    assert.equal(r.ok, true);
    assert.equal(r.commitId, COMMIT_ID);
    assert.equal(r.proposalId, PROPOSAL_ID);
    assert.equal(r.targetPath, 'presets/agint/skills/plugin-preflight/SKILL.md');
    assert.equal(r.preimageHash, 'a'.repeat(64));
    assert.equal(r.preimageContent, 'OLD prompt content', 'rollback 的唯一凭据，查询接口必须一并给出');
    assert.equal(r.policyDecision, 'AUTO_DEPLOY');
  } finally { env.cleanup?.(); }
});

test('⭐ 按 proposalId 反查 —— driver 路径下唯一可用的键', async () => {
  const env = makeEnv();
  try {
    seedCommit(env.tables);
    const r = await env.services['agint.mutator.getCommit']({ proposalId: PROPOSAL_ID });
    assert.equal(r.ok, true);
    assert.equal(r.commitId, COMMIT_ID, 'proposalId → commitId 的反查必须成立，否则 population.fixate 永远查不到');
  } finally { env.cleanup?.(); }
});

test('两个键都命中同一行时用 commitId；commitId 查不到时回落到 proposalId', async () => {
  const env = makeEnv();
  try {
    seedCommit(env.tables);
    const both = await env.services['agint.mutator.getCommit']({ commitId: COMMIT_ID, proposalId: PROPOSAL_ID });
    assert.equal(both.commitId, COMMIT_ID);

    const fallback = await env.services['agint.mutator.getCommit']({
      commitId: 'nonexistent-commit', proposalId: PROPOSAL_ID,
    });
    assert.equal(fallback.commitId, COMMIT_ID, 'commitId 查不到 ≠ 直接判无凭据，应回落到 proposalId');
  } finally { env.cleanup?.(); }
});

test('查不到 → 返回 null（不抛）：ingest 早于 commit 是正常情形', async () => {
  const env = makeEnv();
  try {
    assert.equal(await env.services['agint.mutator.getCommit']({ proposalId: 'not-yet-committed' }), null);
    assert.equal(await env.services['agint.mutator.getCommit']({ commitId: COMMIT_ID }), null);
  } finally { env.cleanup?.(); }
});

test('⛔ 两个键都不给 → 抛错（查询必须有键，不许全表返回）', async () => {
  const env = makeEnv();
  try {
    seedCommit(env.tables);
    await assert.rejects(
      () => env.services['agint.mutator.getCommit']({}),
      /commitId 或 proposalId/,
    );
    await assert.rejects(() => env.services['agint.mutator.getCommit'](), /commitId 或 proposalId/);
    // 空串等同于没给
    await assert.rejects(
      () => env.services['agint.mutator.getCommit']({ commitId: '', proposalId: '' }),
      /commitId 或 proposalId/,
    );
  } finally { env.cleanup?.(); }
});

test('双向对拍：recordExternalCommit 写进去的行，getCommit 必须读得回来', async () => {
  const env = makeEnv();
  const workdir = mkdtempSync(join(tmpdir(), 'agint-mutator-gc-'));
  try {
    const rec = await env.services['agint.mutator.recordExternalCommit']({
      commitId: COMMIT_ID,
      proposalId: PROPOSAL_ID,
      targetPath: 'plugins/agint-dream/lib/sweep.js',
      preimageContent: 'OLD prompt content',
      postimageHash: 'f'.repeat(64),
      policyDecision: 'AUTO_DEPLOY',
      audit: { proposalId: PROPOSAL_ID, commitId: COMMIT_ID, kind: 'PROMPT_MUTATION', source: 'evolution-reversed', timestamp: '2026-10-31T00:00:00.000Z', sandboxResult: 'ok', rollbackTrigger: 'manual' },
    });
    assert.equal(rec.recorded, true);

    for (const q of [{ commitId: COMMIT_ID }, { proposalId: PROPOSAL_ID }]) {
      const r = await env.services['agint.mutator.getCommit'](q);
      assert.ok(r, `用 ${Object.keys(q)[0]} 必须查得到记账入口刚写的那一行`);
      assert.equal(r.commitId, COMMIT_ID);
      assert.equal(r.targetPath, 'plugins/agint-dream/lib/sweep.js');
      assert.equal(r.preimageContent, 'OLD prompt content');
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('伞键上也有 getCommit（扁平 store 只 provide 全名子键时，ctx.get("agint.mutator") 会拿到它）', async () => {
  const env = makeEnv();
  try {
    const umb = env.services['agint.mutator'];
    assert.equal(typeof umb?.getCommit, 'function');
    assert.equal(umb.getCommit, env.services['agint.mutator.getCommit'], '伞键与平铺键必须是同一个函数引用');
  } finally { env.cleanup?.(); }
});
