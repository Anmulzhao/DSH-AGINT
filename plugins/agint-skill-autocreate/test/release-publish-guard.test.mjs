// 提案 2f7c834c 收口三项（C1 / C2 / C4）的专项测试。
//
// C1：发布失败残留必须**移出 skills_root**（此前就地改名 → 被宿主当技能发现）。
// C2：证据级别门 —— E0（无可执行证据）不自动发布，人工点头才放行。
// C4：回滚归档必须登记知识归属 absorbedInto（可空）。
//
// 每条都配 negative control：把守卫关掉 / 把字段不传，断言行为确实反过来。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as plugin from '../lib/index.js';
import { publishToSkillsRoot, archiveSkillDir } from '../lib/release-manager.js';
import { packCandidate } from '../lib/storage.js';

function fakeTable() {
  const m = new Map();
  return {
    put: async (k, v) => { if (v === undefined) m.delete(k); else m.set(k, v); },
    entries: () => [...m.entries()],
    del: async (k) => { m.delete(k); },
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
function mockCtx(services = {}) {
  const provided = {};
  let domain = null;
  return {
    storageDomain: { open: async () => { if (!domain) domain = fakeDomain(); return domain; } },
    get: (key) => services[key] ?? null,
    provide: (key, val) => { provided[key] = val; },
    effect: () => {},
    _provided: provided,
  };
}

function skillDraft(name = 'guard-skill') {
  return {
    name,
    description: '用于守卫测试的临时技能',
    category: 'productivity',
    template: 'file-batch',
    frontmatter: { name, description: '守卫测试', triggers: ['guard'], tools: ['file_read'] },
    body: '# 步骤\n\n1. 读\n2. 写',
    references: [],
    scripts: [],
  };
}

function makeCandidate(name, evidenceLevel) {
  return packCandidate({
    sourcePatternId: 'tp_guard_001',
    source: 'auto',
    triggerEvent: 'test',
    skillDraft: skillDraft(name),
    estimatedBenefit: { successRateImprovement: 0.2, timeSavingsPct: 0.3, tokenSavingsPct: 0.2, harmIncrementEstimate: 0.05 },
    status: 'QUEUED_FOR_RELEASE',
    evalResults: { phase1: { status: 'pass' }, phase3: { rankingScore: 0.62, evidenceLevel, provisional: true } },
    rejectionReason: null,
    releasedAt: null,
    releasedVersion: null,
    rollbackReason: null,
  });
}

const policyOk = { decide: async () => ({ kind: 'AUTO_DEPLOY', score: 0.8, policyId: 'p1', reason: 'ok' }) };

function setup(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'autocreate-guard-'));
  const skillsRoot = join(root, 'skills');
  const archive = join(root, 'rolled-back');
  const jsonl = join(root, 'tool_stats.jsonl');
  writeFileSync(jsonl, '', 'utf8');
  const ctx = mockCtx({ 'agint.qualityPolicy': opts.policy ?? policyOk, ...(opts.services ?? {}) });
  plugin.apply(ctx, {
    skills_root: skillsRoot,
    rollback_archive_dir: archive,
    jsonlPath: jsonl,
    session_source: 'tool_stats',
    require_human_approval_until: '2020-01-01T00:00:00.000Z',
    ...(opts.config ?? {}),
  });
  const svc = ctx._provided['agint.skillAutocreate'];
  return { svc, ctx, skillsRoot, archive, root };
}

async function putCandidate(ctx, candidate) {
  const domain = await ctx.storageDomain.open();
  const t = domain.table('candidates');
  await t.put(candidate.id, candidate);
}

async function putRelease(ctx, release) {
  const domain = await ctx.storageDomain.open();
  const t = domain.table('releases');
  await t.put(release.id, release);
}

async function getRelease(ctx, id) {
  const domain = await ctx.storageDomain.open();
  return [...domain.table('releases').entries()].find(([k]) => k === id)?.[1] ?? null;
}

// ── C2：证据级别门 ────────────────────────────────────────────────────────

test('C2: E0 候选自动发布被证据门拦下', async () => {
  const { svc, ctx } = setup();
  const cand = makeCandidate('e0-skill', 'E0');
  await putCandidate(ctx, cand);
  const out = await svc.release({ id: cand.id });
  assert.equal(out.released, false);
  assert.equal(out.gate, 'evidence');
  assert.match(out.reason, /E0/);
});

test('C2: E0 候选人工点头放行（manual=true 绕过）', async () => {
  const { svc, ctx, skillsRoot } = setup();
  const cand = makeCandidate('e0-manual', 'E0');
  await putCandidate(ctx, cand);
  const out = await svc.release({ id: cand.id, manual: true, actor: 'human' });
  assert.equal(out.released, true, '人工点头时应放行');
  assert.ok(existsSync(join(skillsRoot, 'e0-manual')), '技能目录应已落盘');
});

test('C2: E1 候选自动发布不被证据门拦', async () => {
  const { svc, ctx } = setup();
  const cand = makeCandidate('e1-skill', 'E1');
  await putCandidate(ctx, cand);
  const out = await svc.release({ id: cand.id });
  assert.notEqual(out.gate, 'evidence');
  assert.equal(out.released, true);
});

test('C2 negative control: kill-switch 关掉后 E0 也能自动发', async () => {
  const { svc, ctx } = setup({ config: { evidence_gate_enabled: false } });
  const cand = makeCandidate('e0-killswitch', 'E0');
  await putCandidate(ctx, cand);
  const out = await svc.release({ id: cand.id });
  assert.equal(out.released, true, 'kill-switch 关掉时证据门必须真的不生效');
});

test('C2: 无 evidenceLevel 字段的存量候选不因本门被拦', async () => {
  const { svc, ctx } = setup();
  const cand = makeCandidate('legacy-skill', undefined);
  await putCandidate(ctx, cand);
  const out = await svc.release({ id: cand.id });
  assert.notEqual(out.gate, 'evidence', '缺字段不算 E0，别把存量全拦死');
});

// ── C1：失败残留移出 skills_root ──────────────────────────────────────────

test('C1: 发布失败后 skills_root 下不留下 .failed-* / .tmp-*', async () => {
  const { ctx, skillsRoot, archive } = setup();
  const cand = makeCandidate('boom-skill', 'E1');
  // 注入：body 的 toString 抛错 ⇒ 失败发生在 tmp 目录**已建立**之后。
  cand.skillDraft = { ...cand.skillDraft, body: { toString() { throw new Error('boom'); } } };
  await assert.rejects(
    publishToSkillsRoot({ candidate: cand, skillsRoot, quarantineRoot: archive }),
    /boom/,
  );
  const left = readdirSync(skillsRoot);
  const dirty = left.filter((n) => n.includes('.tmp-') || n.includes('.failed-'));
  assert.deepEqual(dirty, [], `skills_root 必须干净，实际残留：${dirty.join(', ')}`);
  const quarantined = existsSync(join(archive, '.failed'))
    ? readdirSync(join(archive, '.failed')).some((n) => n.includes('boom-skill'))
    : false;
  assert.ok(quarantined, '残留应出现在 archive/.failed 而不是 skills_root');
});

test('C1 端到端: 走 release 路径时残留同样移出 skills_root', async () => {
  // 这条证明**上游真的把 quarantineRoot 传下去了**。
  // 上一条是直接调 publishToSkillsRoot 显式传参 —— 它证明不了调用链接对了。
  const { svc, ctx, skillsRoot, archive } = setup();
  const cand = makeCandidate('e2e-boom', 'E1');
  cand.skillDraft = { ...cand.skillDraft, body: { toString() { throw new Error('boom'); } } };
  await putCandidate(ctx, cand);
  await assert.rejects(svc.release({ id: cand.id }), /boom/);
  const left = readdirSync(skillsRoot);
  const dirty = left.filter((n) => n.includes('.tmp-') || n.includes('.failed-'));
  assert.deepEqual(dirty, [], `skills_root 必须干净，实际残留：${dirty.join(', ')}`);
  assert.ok(
    existsSync(join(archive, '.failed'))
    && readdirSync(join(archive, '.failed')).some((n) => n.includes('e2e-boom')),
    '残留必须落在 archive/.failed',
  );
});

test('C1 negative control: 没有 quarantineRoot 时回落就地改名（不丢目录）', async () => {
  const { ctx, skillsRoot } = setup();
  const cand = makeCandidate('fallback-skill', 'E1');
  cand.skillDraft = { ...cand.skillDraft, body: { toString() { throw new Error('boom'); } } };
  // 不传 quarantineRoot：模拟调用方没注入归档根（如老的直接调用路径）。
  await assert.rejects(
    publishToSkillsRoot({ candidate: cand, skillsRoot }),
    /boom/,
  );
  // 归档目录缺失 ⇒ 只能就地改名，交给 TTL 清理兜底。
  // 断言「目录还在（没丢）」，而不是「skills_root 干净」——这是降级路径的契约。
  const left = readdirSync(skillsRoot);
  assert.ok(left.some((n) => n.includes('fallback-skill') && n.includes('.failed-')),
    `降级时必须就地改名保留，实际：${left.join(', ')}`);
});

// ── C4：回滚登记知识归属 ──────────────────────────────────────────────────

test('C4: 回滚时登记的 absorbedInto 写进 release 记录', async () => {
  const { svc, ctx } = setup();
  const release = {
    id: 'sr_guard_1', candidateId: 'cand_guard_1', skillName: 'absorbed-skill',
    status: 'OBSERVING', createdAt: '2026-10-01T00:00:00.000Z', releasedBy: 'auto',
    observationMetrics: {},
  };
  await putRelease(ctx, release);
  const out = await svc.rollback({ id: 'cand_guard_1', reason: '零调用', absorbedInto: 'batch-frontmatter' });
  assert.ok(out);
  const saved = await getRelease(ctx, 'sr_guard_1');
  assert.equal(saved.absorbedInto, 'batch-frontmatter');
  assert.equal(saved.observationMetrics.absorbedInto, 'batch-frontmatter');
});

test('C4: 未登记时 absorbedInto 为 null（空 = 待办，不是没有）', async () => {
  const { svc, ctx } = setup();
  const release = {
    id: 'sr_guard_2', candidateId: 'cand_guard_2', skillName: 'unlogged-skill',
    status: 'OBSERVING', createdAt: '2026-10-01T00:00:00.000Z', releasedBy: 'auto',
    observationMetrics: {},
  };
  await putRelease(ctx, release);
  await svc.rollback({ id: 'cand_guard_2', reason: '零调用' });
  const saved = await getRelease(ctx, 'sr_guard_2');
  assert.equal(saved.absorbedInto, null);
});

test('C4: archiveSkillDir 原样透传 absorbedInto（含目录已消失时）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'autocreate-arch-'));
  const r = await archiveSkillDir({
    skillName: 'gone-skill',
    skillsRoot: join(root, 'skills'),
    archiveRoot: join(root, 'rolled-back'),
    absorbedInto: 'target-skill',
  });
  assert.equal(r.archived, false);
  assert.equal(r.absorbedInto, 'target-skill', '归档失败也要保住归属信息');
});
