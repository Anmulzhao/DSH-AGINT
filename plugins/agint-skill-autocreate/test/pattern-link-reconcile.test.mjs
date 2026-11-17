// 回链对账（2026-10-18）：候选走入终态后必须清/改 pattern 回链。
//
// 病：候选生成守门是 `if (stored.linkedCandidateId) continue;`，而只有人工
// rejectCandidate 会清回链。自动评估拒绝与回滚都不清 ⇒ 模式永久跳过。
// 实测生产：42 条 status='candidate' 的 pattern，42 条回链全部指向终态候选。
//
// 本文件锁三件事：
//   ① 终态拒绝/回滚 → dismissed + 清回链（模式可再被提案）
//   ② 在跑技能 → released，**保留**回链（可回溯技能从哪来）
//   ③ 未终结 → 不动（不能误伤还在排队/评估中的候选）
// 红绿自证：把 planPatternLinkFix 的 PATTERN_DEAD_CANDIDATE 判断改回 null，
// case ①②③ 立即变红。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as plugin from '../lib/index.js';
import { packTaskPattern, packCandidate } from '../lib/storage.js';

function fakeTable() {
  const m = new Map();
  return {
    put: async (k, v) => { if (v === undefined) m.delete(k); else m.set(k, v); },
    entries: () => [...m.entries()],
    del: async (k) => { m.delete(k); },
    get size() { return m.size; },
    _map: m,
  };
}

function fakeDomain() {
  const tables = new Map();
  return {
    close: async () => {},
    table: (name) => {
      if (!tables.has(name)) tables.set(name, fakeTable());
      return tables.get(name);
    },
  };
}

function mockCtx() {
  const provided = {};
  let domain = null;
  return {
    storageDomain: { open: async () => { if (!domain) domain = fakeDomain(); return domain; } },
    get: () => null,
    provide: (k, v) => { provided[k] = v; },
    effect: () => {},
    _provided: provided,
  };
}

async function boot(tmp) {
  const ctx = mockCtx();
  const jsonlPath = join(tmp, 'stats.jsonl');
  writeFileSync(jsonlPath, '', 'utf8');
  plugin.apply(ctx, {
    jsonlPath, session_source: 'tool_stats', aggregate_window_hours: 24,
    semantics_quality_gate_enabled: false,
  });
  return { ctx, svc: ctx._provided['agint.skillAutocreate'] };
}

/** 塞一条候选（只要状态与 id 对得上，其余字段用最小合法值） */
async function seedCandidate(ctx, { id, status }) {
  const domain = await ctx.storageDomain.open();
  const cd = domain.table('candidates');
  const cand = packCandidate({
    id,
    sourcePatternId: `tp_seed_${id}`,
    source: 'auto',
    triggerEvent: 'test',
    skillDraft: {
      name: `seed-skill-${id}`,
      description: 'seed candidate for link reconcile test',
      category: 'productivity',
      template: 'file-processing',
      frontmatter: {
        name: `seed-skill-${id}`,
        description: 'seed candidate for link reconcile test',
        triggers: ['test'],
        tools: ['read'],
      },
      body: '# seed\n\n1. step.\n',
    },
    estimatedBenefit: {
      successRateImprovement: 0.1, timeSavingsPct: 0.1, tokenSavingsPct: 0.1, harmIncrementEstimate: 0.1,
    },
    status,
  });
  await cd.put(cand.id, cand);
  return cand;
}

/** 塞一条回链到这个候选的 pattern */
async function seedLinkedPattern(ctx, { id, candidateId, status = 'candidate' }) {
  const domain = await ctx.storageDomain.open();
  const tp = domain.table('task_patterns');
  const packed = packTaskPattern({
    id,
    toolSequence: ['pwsh', 'memory_read'],
    paramSignature: { pwsh: 'command:str', memory_read: 'id:str' },
    description: 'pwsh > memory_read',
    occurrenceCount: 4,
    firstSeenAt: new Date(Date.now() - 86400_000).toISOString(),
    lastSeenAt: new Date().toISOString(),
    avgDurationMs: null,
    avgTokenCost: null,
    successRate: 1,
    standardizable: true,
    standardizableConfidence: 0.9,
    status,
    linkedCandidateId: candidateId,
  }, null);
  await tp.put(packed.id, packed);
  return packed;
}

function readPattern(ctx, id) {
  return ctx.storageDomain.open().then((d) => d.table('task_patterns')._map.get(id));
}

test('① 回链指向 REJECTED → dismissed + 清回链', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'link-'));
  try {
    const { ctx, svc } = await boot(tmp);
    await seedCandidate(ctx, { id: 'sc_t1', status: 'REJECTED' });
    await seedLinkedPattern(ctx, { id: 'tp_t1', candidateId: 'sc_t1' });

    const r = await svc.reconcilePatternLinks();
    assert.equal(r.fixed, 1, `应修 1 条，实际 ${r.fixed}`);

    const p = await readPattern(ctx, 'tp_t1');
    assert.equal(p.status, 'dismissed', '拒绝过的模式不再提案');
    assert.equal(p.linkedCandidateId, null, '回链必须清空，否则守门永久跳过它');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('② 回链指向 ROLLED_BACK → dismissed + 清回链', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'link-'));
  try {
    const { ctx, svc } = await boot(tmp);
    await seedCandidate(ctx, { id: 'sc_t2', status: 'ROLLED_BACK' });
    await seedLinkedPattern(ctx, { id: 'tp_t2', candidateId: 'sc_t2' });

    await svc.reconcilePatternLinks();
    const p = await readPattern(ctx, 'tp_t2');
    assert.equal(p.status, 'dismissed');
    assert.equal(p.linkedCandidateId, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('③ 回链指向 STABLE → released，保留回链（可回溯技能从哪来）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'link-'));
  try {
    const { ctx, svc } = await boot(tmp);
    await seedCandidate(ctx, { id: 'sc_t3', status: 'STABLE' });
    await seedLinkedPattern(ctx, { id: 'tp_t3', candidateId: 'sc_t3' });

    await svc.reconcilePatternLinks();
    const p = await readPattern(ctx, 'tp_t3');
    assert.equal(p.status, 'released', '模式已变成在跑技能');
    assert.equal(p.linkedCandidateId, 'sc_t3', 'released 保留回链：这是技能来源的唯一线索');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('④ 未终结候选（PENDING_EVAL / QUEUED_FOR_RELEASE）不动', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'link-'));
  try {
    const { ctx, svc } = await boot(tmp);
    await seedCandidate(ctx, { id: 'sc_t4', status: 'PENDING_EVAL' });
    await seedCandidate(ctx, { id: 'sc_t5', status: 'QUEUED_FOR_RELEASE' });
    await seedLinkedPattern(ctx, { id: 'tp_t4', candidateId: 'sc_t4' });
    await seedLinkedPattern(ctx, { id: 'tp_t5', candidateId: 'sc_t5' });

    const r = await svc.reconcilePatternLinks();
    assert.equal(r.fixed, 0, '还在排队/评估中的候选不能被误伤');

    const p4 = await readPattern(ctx, 'tp_t4');
    assert.equal(p4.status, 'candidate');
    assert.equal(p4.linkedCandidateId, 'sc_t4');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('⑤ 幂等：第二次对账 fixed=0（不重复写、不重复审计）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'link-'));
  try {
    const { ctx, svc } = await boot(tmp);
    await seedCandidate(ctx, { id: 'sc_t6', status: 'REJECTED' });
    await seedLinkedPattern(ctx, { id: 'tp_t6', candidateId: 'sc_t6' });

    const first = await svc.reconcilePatternLinks();
    const second = await svc.reconcilePatternLinks();
    assert.equal(first.fixed, 1);
    assert.equal(second.fixed, 0, 'already-reconciled 不该每轮重写');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('⑥ detect() 开局自动对账，并把结果放进返回值', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'link-'));
  try {
    const { ctx, svc } = await boot(tmp);
    await seedCandidate(ctx, { id: 'sc_t7', status: 'REJECTED' });
    await seedLinkedPattern(ctx, { id: 'tp_t7', candidateId: 'sc_t7' });

    const result = await svc.detect({});
    assert.equal(result.patternLinkReconcile.fixed, 1, 'detect 开局应把历史遗留收口');
    const p = await readPattern(ctx, 'tp_t7');
    assert.equal(p.linkedCandidateId, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
