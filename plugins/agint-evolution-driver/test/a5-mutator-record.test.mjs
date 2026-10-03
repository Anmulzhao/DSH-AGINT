#!/usr/bin/env node
// agint-evolution-driver / A5 记账接线 unit test
//
// A5（2026-10-03）：driver 走自己的 commitToRepo 落盘路径，从不调 mutator.commit，
// 所以 commits 表天生为 0 ⇒ mutator_stats.commits 恒 0（对账恒告警），
// 且 driver 产出的 commit **无法被 mutator.rollback 回滚**。
// 本文件钉住「commit 成功后必须记账」这条接线，含三条边界：
//   ① 记账调用参数齐（尤其 preimageContent —— rollback 的唯一凭据）
//   ② 记账失败**不**污染 evolve.addFailure（那是进化失败模式通道）
//   ③ 记账失败仍外部可读（事件总线，纪律 3：warn→stdout 常驻进程读不到）
//
// 搭法照抄 smoke.mjs 的 T25（apply(ctx, {repoRoot}) → ctx.provided[...]，
// 依赖全部走 inject）—— 这是 driver 的真实调用契约，别自造。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../lib/index.js';

const EXPECTED_EFFECT_CODE = '代码类目标声明`场景集通过率`（点名 R1 仪器）';

async function makeRepo(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agint-driver-a5-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return root;
}

/**
 * 记录 publish 的 topic，供「记账失败必须外部可读」断言用。
 *
 * ⚠️ 签名必须复刻真实 `agint.eventBus.publish`（driver/lib/index.js:357）：
 * **单参数** `bus({ topic, payload, source })`，返回 `{ accepted, envelopeId }`。
 * 第一版写成 `publish(topic, payload)` 并直接返回字符串 ⇒ driver 侧
 * `res?.accepted === true` 恒 false ⇒ envelopeId 全 null ⇒ 5 条用例红。
 * 这正是 K115「mock 必须复刻真实入参/出参契约，否则字段名写错也照样绿」的同类。
 */
function makeBus() {
  const published = [];
  return {
    published,
    publish: async (input) => {
      const envelopeId = `env-${published.length + 1}`;
      published.push({ topic: input.topic, payload: input.payload, envelopeId });
      return { accepted: true, envelopeId };
    },
    subscribe: () => () => {},
  };
}

/**
 * 跑一次 commit 全链路。
 * @param {object} opts
 * @param {'ok'|'throw'|'missing'} opts.recordMode recordExternalCommit 的行为
 */
async function runCommitPath({ recordMode = 'ok' } = {}) {
  const repoRoot = await makeRepo({ 'lib/service.js': "export const greeting = 'hello world';\n" });
  const calls = [];
  const bus = makeBus();
  const recordedInputs = [];

  const mutator = {
    propose: async (input) => {
      calls.push(['propose', input.promptPayload?.promptId]);
      return { id: 'p1', kind: 'PROMPT_MUTATION', status: 'PENDING' };
    },
    validate: async () => ({ ok: true, findings: [] }),
  };
  if (recordMode !== 'missing') {
    mutator.recordExternalCommit = async (input) => {
      recordedInputs.push(input);
      if (recordMode === 'throw') throw new Error('commits table full (cap 50)');
      return { ok: true, commitId: input.commitId, recorded: true };
    };
  }

  const evolutionLog = {
    addFailure: async (f) => { calls.push(['addFailure', f.pattern]); return { id: 'f1' }; },
    queryFailures: async () => [],
    ledger: { append: async (entry) => ({ entry: { ...entry, seq: 1 }, idempotent: false }) },
  };

  const provided = {};
  const ctx = {
    get: (n) => ({
      'agint.evolve': {
        listProposals: async () => [
          { id: 'c1', title: '修 metrics bug', body: '目标 `lib/service.js` 的超时', status: 'proposed' },
        ],
      },
      'agint.mutator': mutator,
      'agint.population': {
        ingest: async () => ({
          variant_id: 'v1', generation: 2, mutation_kind: 'PROMPT_MUTATION',
          expected_effect: { metric: 'SUCCESS_RATE', direction: 'increase', window: '7d' },
          policy_decision: 'PENDING_REVIEW', stage: 'shadow',
        }),
      },
      'agint.evolution': evolutionLog,
      'agint.qualitySandbox': { runSmoke: async () => ({ ok: true, mode: 'in-process' }) },
      'agint.qualityPolicy': {
        // mock 必须复刻真实 policy 的 key 契约（decide.js:88/96 只按 d.key 取权重），
        // 否则恒REJECT —— smoke.mjs T25 的注释已记这条同源坑。
        decide: async ({ results }) => {
          const dims = results?.[0]?.dimensions ?? [];
          const keyed = dims.some((d) => d.key === 'safety') && dims.some((d) => d.key === 'trust');
          return keyed
            ? { kind: 'AUTO_DEPLOY', reason: 'score-85' }
            : { kind: 'REJECT', reason: 'unknown-veto' };
        },
      },
      'agint.eventBus.publish': bus.publish,
      agents: { create: async () => { throw new Error('no llm'); } },
      subagents: { start: async () => { throw new Error('no llm'); } },
    }[n] ?? null),
    provide: (n, v) => { provided[n] = v; },
    on: () => {},
    effect: () => () => {},
  };

  apply(ctx, { repoRoot });
  const cleanup = () => rm(repoRoot, { recursive: true, force: true });
  try {
    const out = await provided['agint.evolutionDriver'].runOnce({
      env: {},
      inject: {
        // ⚠️ 提案必须从这里来：`const evolve = inj.evolve ?? dep('agint.evolve')`。
        // 第一版误传空数组 ⇒ 无提案 ⇒ commit 整条路没走 ⇒ 记账当然调不到。
        evolve: {
          listProposals: async () => [
            { id: 'c1', title: '修 metrics bug', body: '目标 `lib/service.js` 的超时', status: 'proposed' },
          ],
        },
        mutator,
        population: {
          ingest: async () => ({
            variant_id: 'v1', generation: 2, mutation_kind: 'PROMPT_MUTATION',
            expected_effect: { metric: 'SUCCESS_RATE', direction: 'increase', window: '7d' },
            policy_decision: 'PENDING_REVIEW', stage: 'shadow',
          }),
        },
        // 文件目标不该再走 runSmoke（一被调用就抛错）—— 与 smoke T25 同守门。
        sandbox: { runSmoke: async () => { throw new Error('file target must NOT reach runSmoke'); } },
        policy: { decide: async () => ({ kind: 'AUTO_DEPLOY', reason: 'score-85' }) },
        evolution: evolutionLog,
        llm: async () => ({
          ok: true,
          value: {
            applicable: true,
            targetSkill: 'lib/service.js',
            oldText: 'hello world',
            newText: 'hello AGINT world',
            rationale: 'test',
          },
        }),
        skillNames: [],
        fs: { scanRepo: async () => ['lib/service.js', 'README.md'] },
      },
    });
    return { out, recordedInputs, calls, bus, status: provided['agint.evolutionDriver'].status, cleanup };
  } catch (err) {
    return {
      out: null, error: err, recordedInputs, calls, bus,
      status: provided['agint.evolutionDriver']?.status, cleanup,
    };
  }
}

// ── ① 记账被调用且参数齐 ────────────────────────────────────────────

test('commit 成功 → 调 mutator.recordExternalCommit，且 preimageContent 非空', async () => {
  const r = await runCommitPath({ recordMode: 'ok' });
  try {
    assert.equal(r.recordedInputs.length, 1, `记账必须被调一次 —— 否则 commits 表恒 0（${r.error?.message ?? ''}）`);
    const input = r.recordedInputs[0];
    assert.ok(input.commitId, 'commitId 是幂等键，不能空');
    assert.equal(input.proposalId, 'p1');
    assert.equal(input.targetPath, 'lib/service.js');
    assert.equal(typeof input.preimageContent, 'string');
    assert.ok(input.preimageContent.length > 0, 'preimageContent 是 rollback 的唯一凭据，不能空');
    assert.match(input.preimageContent, /hello world/, '必须是落盘前的内容（文件已被改成 newText）');
    assert.ok(input.postimageHash && input.postimageHash.length >= 32, 'postimageHash 必须是内容哈希');
    assert.equal(input.policyDecision, 'AUTO_DEPLOY');
    assert.equal(input.audit.proposalId, 'p1');
    assert.equal(input.audit.commitId, input.commitId);
  } finally { await r.cleanup(); }
});

test('commitId 复用 committed 事件的 envelopeId（记账与事件一一对应）', async () => {
  const r = await runCommitPath({ recordMode: 'ok' });
  try {
    const committed = r.bus.published.find((e) => e.topic === 'evolution.mutation.committed');
    assert.ok(committed, '应发出 committed 事件');
    assert.equal(r.recordedInputs[0].commitId, committed.envelopeId,
      '用事件主键当记账键，重试/对账时两边能接上');
  } finally { await r.cleanup(); }
});

test('status() 带出记账计数器（成功路径唯一结构化出口）', async () => {
  const r = await runCommitPath({ recordMode: 'ok' });
  try {
    // ⚠️ 口径：`evolution.cycle.summary` **只在跳过/降级路径发**
    //   （driver/lib/index.js 里 emitSummary 只有 5 个调用点，全是 skipped 出口），
    //   成功路径不发 ⇒ 记账计数器必须从 status() 读。
    //   第一版误挂在 cycle.summary 上，断言 10 条里 2 条红 —— 那不是 mock 问题，
    //   是我把计数器挂在了成功路径永远读不到的通道上（已在 status() 补齐）。
    const st = r.status?.() ?? {};
    assert.equal(st.mutatorRecorded, 1, 'status() 必须带出 mutatorRecorded');
    assert.equal(st.mutatorRecordFailed, 0);
  } finally { await r.cleanup(); }
});

// ── ② 记账失败不污染 evolve.addFailure ──────────────────────────────

test('记账抛错 → 成功路径**不**记 addFailure（账目问题不是进化失败）', async () => {
  const r = await runCommitPath({ recordMode: 'throw' });
  try {
    assert.equal(r.recordedInputs.length, 1, '确实调了');
    assert.equal(r.calls.some((c) => c[0] === 'addFailure'), false,
      'addFailure 是进化失败模式通道，记账失败混进去会污染 A4 归因器的读数');
  } finally { await r.cleanup(); }
});

test('mutator 版本过旧（无 recordExternalCommit）→ 同上，不记 addFailure', async () => {
  const r = await runCommitPath({ recordMode: 'missing' });
  try {
    assert.equal(r.recordedInputs.length, 0);
    assert.equal(r.calls.some((c) => c[0] === 'addFailure'), false);
  } finally { await r.cleanup(); }
});

test('记账失败 → mutatorRecordFailed 计数 +1，mutatorRecorded 不动', async () => {
  const r = await runCommitPath({ recordMode: 'throw' });
  try {
    const st = r.status();
    assert.equal(st.mutatorRecordFailed, 1);
    assert.equal(st.mutatorRecorded, 0);
  } finally { await r.cleanup(); }
});

// ── ③ 记账失败仍外部可读（事件总线，唯一出口） ───────────────────────

test('记账失败 → 发 evolution.mutation.accounting-failed 事件（纪律 3）', async () => {
  const r = await runCommitPath({ recordMode: 'throw' });
  try {
    const ev = r.bus.published.find((e) => e.topic === 'evolution.mutation.accounting-failed');
    assert.ok(ev, 'warn 只到 stdout、常驻进程读不到 ⇒ 必须发事件');
    assert.equal(ev.payload.proposalId, 'p1');
    assert.equal(ev.payload.path, 'lib/service.js');
    assert.match(ev.payload.reason, /commits table full/);
  } finally { await r.cleanup(); }
});

test('记账失败不回滚已落盘的改动（改动已过 sandbox + policy 两道闸）', async () => {
  const r = await runCommitPath({ recordMode: 'throw' });
  try {
    const rolledBack = r.bus.published.some((e) => e.topic === 'evolution.mutation.rolledback');
    assert.equal(rolledBack, false, '记账是账目问题不是安全问题，不该触发回滚');
  } finally { await r.cleanup(); }
});

// ── 导出契约 ────────────────────────────────────────────────────────

test('导出契约: apply 可直接调用', () => {
  assert.equal(typeof apply, 'function');
});

test('常量纪律：EXPECTED_EFFECT_CODE 与 driver 内部声明一致（防文档漂移）', () => {
  assert.match(EXPECTED_EFFECT_CODE, /场景集通过率/);
});