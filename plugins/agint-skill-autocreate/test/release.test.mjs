// Sprint 16 发布层测试：mock ctx + 内存 storage + 临时目录/JSONL。
// 覆盖设计稿 §3：三道门各分支 / 原子落盘 / 重名防御 / 回滚归档 / 冷却期 /
// 观察期四分支（stable / zero-usage 回滚 / 展期 / 数据源失效顺延）。
// 不挂 Cordis、不碰真实 ~/.dsh（skills_root / jsonlPath 全部指向临时目录）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as plugin from '../lib/index.js';
import { weekKey, matchSkillCall, humanApprovalActive } from '../lib/release-manager.js';
import { packCandidate } from '../lib/storage.js';
import { DEFAULT_CONFIG } from '../lib/schema.js';

// ── 内存版 storage domain ─────────────────────────────────────────────────
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

// ── fixture ────────────────────────────────────────────────────────────────
function skillDraft(name = 'batch-frontmatter') {
  return {
    name,
    description: '批量更新 markdown 文件的 frontmatter 字段',
    category: 'productivity',
    template: 'file-batch',
    frontmatter: { name, description: '批量更新 frontmatter', triggers: ['frontmatter'], tools: ['file_read'] },
    body: '# 步骤\n\n1. 读取\n2. 写回',
    references: [],
    scripts: [],
  };
}
function makeCandidate(name) {
  return packCandidate({
    sourcePatternId: 'tp_test_001',
    source: 'auto',
    triggerEvent: 'test',
    skillDraft: skillDraft(name),
    estimatedBenefit: { successRateImprovement: 0.2, timeSavingsPct: 0.3, tokenSavingsPct: 0.2, harmIncrementEstimate: 0.05 },
    status: 'QUEUED_FOR_RELEASE',
    evalResults: { phase1: { status: 'pass' }, phase3: { rankingScore: 0.62, evidenceLevel: 'E0', provisional: true } },
    rejectionReason: null,
    releasedAt: null,
    releasedVersion: null,
    rollbackReason: null,
  });
}
const policyOk = { decide: async () => ({ kind: 'AUTO_DEPLOY', score: 0.8, policyId: 'p1', reason: 'ok' }) };
const policyReject = { decide: async () => ({ kind: 'REJECT', score: 0.2, policyId: 'p1', reason: '低分' }) };
const policyAbstain = { decide: async () => ({ kind: 'ABSTAIN', reason: '证据不足' }) };

function setup(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'autocreate-rel-'));
  const skillsRoot = join(root, 'skills');
  const archive = join(root, 'rolled-back');
  const jsonl = join(root, 'tool_stats.jsonl');
  writeFileSync(jsonl, opts.jsonl ?? '', 'utf8');
  const services = {
    'agint.qualityPolicy': opts.policy ?? policyOk,
    ...(opts.services ?? {}),
  };
  const ctx = mockCtx(services);
  const config = {
    skills_root: skillsRoot,
    rollback_archive_dir: archive,
    jsonlPath: jsonl,
    // 默认关掉人工确认窗（专测其它门）；确认窗行为在专项测试里单独开
    require_human_approval_until: opts.approvalUntil ?? '2020-01-01T00:00:00.000Z',
    ...(opts.config ?? {}),
  };
  plugin.apply(ctx, config);
  const svc = ctx._provided['agint.skillAutocreate'];
  return { svc, ctx, skillsRoot, archive, jsonl, root, config };
}

async function insertQueued(svc, name = 'batch-frontmatter') {
  const candidate = makeCandidate(name);
  // 借助内部 table 访问：通过 stats 不可行，直接用 domain 引用
  return candidate;
}

// 借助一次 detect 不可控，直接往内存表塞候选：通过 svc 暴露的 config 找不到
// table —— 用 ctx.storageDomain.open() 拿 domain。
async function putCandidate(svc, ctx, candidate) {
  const domain = await ctx.storageDomain.open();
  const t = domain.table('candidates');
  await t.put(candidate.id, candidate);
  return candidate;
}

test('weekKey：同周同键、跨周异键、格式合法', () => {
  const k1 = weekKey(new Date('2026-09-09T10:00:00Z'));
  const k2 = weekKey(new Date('2026-09-07T00:00:00Z'));   // 周一
  const k3 = weekKey(new Date('2026-09-13T23:00:00Z'));   // 周日
  assert.match(k1, /^\d{4}-W\d{2}$/);
  assert.equal(k1, k2);
  assert.equal(k1, k3);
  const k4 = weekKey(new Date('2026-09-14T00:00:00Z'));   // 下周一
  assert.notEqual(k1, k4);
});

test('matchSkillCall：tool=skill 且技能名命中（宽匹配）', () => {
  assert.equal(matchSkillCall({ tool: 'skill', args: { name: 'batch-frontmatter' } }, 'batch-frontmatter'), true);
  assert.equal(matchSkillCall({ tool: 'skill', args: { skill: 'batch-frontmatter' } }, 'batch-frontmatter'), true);
  assert.equal(matchSkillCall({ tool: 'skill', args: { other: 'batch-frontmatter' } }, 'batch-frontmatter'), true);  // JSON 兜底
  assert.equal(matchSkillCall({ tool: 'skill', args: { name: 'other-skill' } }, 'batch-frontmatter'), false);
  assert.equal(matchSkillCall({ tool: 'file_read', args: { name: 'batch-frontmatter' } }, 'batch-frontmatter'), false);
});

test('门 2 默认语义（2026-09-09 19:11 改口）：默认无确认窗 → 全自动发布', async () => {
  // 默认配置：require_human_approval_until = null → 门 2 不生效
  assert.equal(DEFAULT_CONFIG.require_human_approval_until, null);
  assert.equal(humanApprovalActive(DEFAULT_CONFIG), false, '默认全自动，不接入中间环节');
  // 显式开启仍有效（逃生通道保留）
  assert.equal(humanApprovalActive({ require_human_approval_until: '2099-01-01T00:00:00.000Z' }), true);
  assert.equal(humanApprovalActive({ require_human_approval: true }), true);
  assert.equal(humanApprovalActive({ require_human_approval_until: null }), false);
});

test('门 2 人工确认窗：auto 被拦 → BUDGET_WAIT；manual 放行并落盘', async () => {
  const h = setup({ approvalUntil: '2099-01-01T00:00:00.000Z' });
  const cand = makeCandidate('batch-frontmatter');
  await putCandidate(h.svc, h.ctx, cand);

  // auto：被确认窗拦下
  const r1 = await h.svc.release({ id: cand.id, manual: false });
  assert.equal(r1.released, false);
  assert.equal(r1.gate, 'human-approval');
  const after1 = await h.svc.getCandidate(cand.id);
  assert.equal(after1.status, 'BUDGET_WAIT');
  assert.match(after1.rejectionReason, /human-approval/);

  // manual：绕过确认窗，成功发布
  const r2 = await h.svc.release({ id: cand.id, manual: true, reason: '拍板 2：人工点头' });
  assert.equal(r2.released, true);
  const skillDir = join(h.skillsRoot, 'batch-frontmatter');
  assert.ok(existsSync(join(skillDir, 'SKILL.md')), 'SKILL.md 落盘');
  assert.ok(existsSync(join(skillDir, 'manifest.json')), 'manifest.json 落盘');
  const after2 = await h.svc.getCandidate(cand.id);
  assert.equal(after2.status, 'RELEASED');
  assert.ok(after2.releasedAt);
  assert.equal(after2.releasedVersion, '1');
});

test('门 3 policy：REJECT / ABSTAIN / 异常 / 未挂载 一律 fail-closed', async () => {
  for (const [label, policy, expected] of [
    ['REJECT', policyReject, 'REJECT'],
    ['ABSTAIN', policyAbstain, 'ABSTAIN'],
    ['throw', { decide: async () => { throw new Error('boom'); } }, 'policy 调用失败'],
  ]) {
    const h = setup({ policy });
    const cand = makeCandidate('batch-frontmatter');
    await putCandidate(h.svc, h.ctx, cand);
    const r = await h.svc.release({ id: cand.id, manual: true });
    assert.equal(r.released, false, label);
    assert.equal(r.gate, 'policy', label);
    assert.match(r.reason, new RegExp(expected), label);
    const stored = await h.svc.getCandidate(cand.id);
    assert.equal(stored.status, 'BUDGET_WAIT', label);
    assert.equal(existsSync(join(h.skillsRoot, 'batch-frontmatter')), false, `${label}: 不得落盘`);
  }
  // 未挂载 policy 服务
  const h2 = setup({ services: { 'agint.qualityPolicy': undefined }, policy: undefined });
  const cand2 = makeCandidate('batch-frontmatter');
  await putCandidate(h2.svc, h2.ctx, cand2);
  const r2 = await h2.svc.release({ id: cand2.id, manual: true });
  assert.equal(r2.gate, 'policy');
  assert.match(r2.reason, /未挂载/);
});

test('门 4 周预算：auto 达预算被拦（manual 绕过不计数）', async () => {
  const h = setup({ config: { weekly_deploy_budget: 1 } });
  const c1 = makeCandidate('skill-one');
  const c2 = makeCandidate('skill-two');
  await putCandidate(h.svc, h.ctx, c1);
  await putCandidate(h.svc, h.ctx, c2);

  const r1 = await h.svc.release({ id: c1.id, manual: true });     // manual 绕预算
  assert.equal(r1.released, true);
  const r2 = await h.svc.release({ id: c2.id, manual: false });    // auto：本周已 1 条 ≥ 预算 1
  assert.equal(r2.released, false);
  assert.equal(r2.gate, 'budget');
  const after = await h.svc.getCandidate(c2.id);
  assert.equal(after.status, 'BUDGET_WAIT');
});

test('门 1 总开关：release_enabled=false 时 manual 也被拦', async () => {
  const h = setup({ config: { release_enabled: false } });
  const cand = makeCandidate('batch-frontmatter');
  await putCandidate(h.svc, h.ctx, cand);
  const r = await h.svc.release({ id: cand.id, manual: true });
  assert.equal(r.released, false);
  assert.equal(r.gate, 'release-switch');
});

test('重名硬防线：skills 目录已存在同名 → 拦下不覆盖', async () => {
  const h = setup();
  mkdirSync(join(h.skillsRoot, 'batch-frontmatter'), { recursive: true });
  writeFileSync(join(h.skillsRoot, 'batch-frontmatter', 'SKILL.md'), '人工技能', 'utf8');
  const cand = makeCandidate('batch-frontmatter');
  await putCandidate(h.svc, h.ctx, cand);
  const r = await h.svc.release({ id: cand.id, manual: true });
  assert.equal(r.released, false);
  assert.equal(r.gate, 'name-conflict');
  assert.equal(await h.svc.getCandidate(cand.id).then((c) => c.status), 'BUDGET_WAIT');
  assert.equal(await new Promise((res) => res(existsSync(join(h.skillsRoot, 'batch-frontmatter', 'SKILL.md')))), true);
});

test('回滚：目录归档 + release/candidate 状态 + 30 天冷却拦截重发', async () => {
  const h = setup();
  const cand = makeCandidate('batch-frontmatter');
  await putCandidate(h.svc, h.ctx, cand);
  const rel = await h.svc.release({ id: cand.id, manual: true });
  assert.equal(rel.released, true);
  assert.ok(existsSync(join(h.skillsRoot, 'batch-frontmatter', 'SKILL.md')));

  const rb = await h.svc.rollback({ skillName: 'batch-frontmatter', reason: '观察期 0 调用', actor: 'system' });
  assert.equal(rb.archived, true);
  assert.ok(rb.dest.startsWith(h.archive), '归档目录在 rollback_archive_dir 下');
  assert.ok(existsSync(join(rb.dest, 'SKILL.md')), '归档保留 SKILL.md');
  assert.equal(existsSync(join(h.skillsRoot, 'batch-frontmatter')), false, 'skills 目录已移除');

  const releases = await h.svc.listReleases({});
  assert.equal(releases.length, 1);
  assert.equal(releases[0].status, 'ROLLED_BACK');
  assert.equal(releases[0].rollbackReason, '观察期 0 调用');
  const after = await h.svc.getCandidate(cand.id);
  assert.equal(after.status, 'ROLLED_BACK');

  // 冷却：新候选同名 → 冷却拦截
  const cand2 = makeCandidate('batch-frontmatter');
  await putCandidate(h.svc, h.ctx, cand2);
  const r2 = await h.svc.release({ id: cand2.id, manual: true });
  assert.equal(r2.released, false);
  assert.equal(r2.gate, 'cooldown');
});

test('releaseQueue：确认窗内全部被拦（拍板 2 的 cron 语义）', async () => {
  const h = setup({ approvalUntil: '2099-01-01T00:00:00.000Z' });
  const c1 = makeCandidate('skill-one');
  const c2 = makeCandidate('skill-two');
  await putCandidate(h.svc, h.ctx, c1);
  await putCandidate(h.svc, h.ctx, c2);
  const q = await h.svc.releaseQueue();
  assert.equal(q.attempted, 2);
  assert.equal(q.released, 0);
  assert.ok(q.results.every((r) => r.gate === 'human-approval'));
});

test('发布成功时：release 记录 + evolution.addSuccess + staging 清理', async () => {
  const added = [];
  const h = setup({
    services: {
      'agint.evolution': { addSuccess: async (x) => { added.push(x); return { id: 'st1' }; } },
    },
  });
  const cand = makeCandidate('batch-frontmatter');
  await putCandidate(h.svc, h.ctx, cand);
  const r = await h.svc.release({ id: cand.id, manual: true });
  assert.equal(r.released, true);
  assert.equal(added.length, 1);
  assert.match(added[0].template, /batch-frontmatter/);

  const releases = await h.svc.listReleases({});
  assert.equal(releases.length, 1);
  assert.equal(releases[0].releasedBy, 'human');
  assert.ok(releases[0].budgetWeek);
  assert.equal(releases[0].status, 'OBSERVING');
});

// ── 观察期 observe 四分支 ─────────────────────────────────────────────────

const DAY = 86400000;
function daysAgoIso(n) { return new Date(Date.now() - n * DAY).toISOString(); }

/** 造一条 release 记录直接入表（绕过发布流程，控制 createdAt/observationEndAt） */
async function insertRelease(svc, ctx, { skillName, createdAt, observationEndAt, status = 'OBSERVING' }) {
  const domain = await ctx.storageDomain.open();
  const t = domain.table('releases');
  const rec = {
    id: `sr_test_${skillName}`,
    kind: 'skill_release',
    createdAt,
    candidateId: 'sc_test_obs',
    skillName,
    version: '1',
    snapshot: {},
    observationEndAt,
    observationMetrics: { callsTotal: 0, callsByDay: {}, extensions: 0 },
    status,
    rollbackAt: null,
    rollbackReason: null,
    releasedBy: 'manual',
    budgetWeek: weekKey(new Date(Date.parse(createdAt))),
  };
  await t.put(rec.id, rec);
  return rec;
}

test('observe：窗满 + 调用达标 → STABLE', async () => {
  // 调用全部落在 (createdAt, observationEndAt) 内部（避免毫秒级边界抖动）
  const calls = [19, 18, 17, 16, 15].map((d, i) =>
    JSON.stringify({ ts: daysAgoIso(d), sessionId: 's1', turn: i, tool: 'skill', ok: true, args: { name: 'obs-skill' } }),
  ).join('\n');
  const h = setup({ jsonl: calls + '\n' });
  await insertRelease(h.svc, h.ctx, {
    skillName: 'obs-skill', createdAt: daysAgoIso(20), observationEndAt: daysAgoIso(6),
  });
  const out = await h.svc.observe();
  assert.deepEqual(out.stable, ['obs-skill']);
  const releases = await h.svc.listReleases({});
  assert.equal(releases[0].status, 'STABLE');
  assert.ok(releases[0].observationMetrics.callsTotal >= 5);
});

test('observe：最近 3 个子窗 0 调用 → 自动回滚（数据源仍活跃）', async () => {
  // 数据源活跃：近期有别的工具调用；但 obs-skill 零调用
  const noise = JSON.stringify({ ts: daysAgoIso(0.1), sessionId: 's1', turn: 1, tool: 'file_read', ok: true, args: { path: '/x' } });
  const h = setup({ jsonl: noise + '\n' });
  await insertRelease(h.svc, h.ctx, {
    skillName: 'obs-skill', createdAt: daysAgoIso(12), observationEndAt: daysAgoIso(-2),
  });
  const out = await h.svc.observe();
  assert.equal(out.rolledBack.length, 1);
  assert.match(out.rolledBack[0].reason, /zero-usage/);
  const releases = await h.svc.listReleases({});
  assert.equal(releases[0].status, 'ROLLED_BACK');
});

test('observe：数据源失效（整份 jsonl 近窗零记录）→ 顺延不回滚', async () => {
  const stale = JSON.stringify({ ts: daysAgoIso(30), sessionId: 's1', turn: 1, tool: 'file_read', ok: true, args: { path: '/x' } });
  const h = setup({ jsonl: stale + '\n' });
  await insertRelease(h.svc, h.ctx, {
    skillName: 'obs-skill', createdAt: daysAgoIso(20), observationEndAt: daysAgoIso(6),
  });
  const out = await h.svc.observe();
  assert.equal(out.stable.length, 0);
  assert.equal(out.rolledBack.length, 0);
  assert.equal(out.postponed, 1);
  const releases = await h.svc.listReleases({});
  assert.equal(releases[0].status, 'OBSERVING');
});

test('observe：窗满不达标但有零星使用 → 展期一次', async () => {
  const calls = [
    JSON.stringify({ ts: daysAgoIso(3), sessionId: 's1', turn: 1, tool: 'skill', ok: true, args: { name: 'obs-skill' } }),
    JSON.stringify({ ts: daysAgoIso(2), sessionId: 's1', turn: 2, tool: 'skill', ok: true, args: { name: 'obs-skill' } }),
    JSON.stringify({ ts: daysAgoIso(0.1), sessionId: 's1', turn: 3, tool: 'file_read', ok: true, args: { path: '/x' } }),  // 数据源活跃
  ].join('\n');
  const h = setup({ jsonl: calls + '\n' });
  await insertRelease(h.svc, h.ctx, {
    skillName: 'obs-skill', createdAt: daysAgoIso(20), observationEndAt: daysAgoIso(2),
  });
  const out = await h.svc.observe();
  assert.equal(out.rolledBack.length, 0);
  assert.equal(out.stable.length, 0);
  assert.equal(out.postponed, 1);
  const releases = await h.svc.listReleases({});
  assert.equal(releases[0].status, 'OBSERVING');
  assert.equal(releases[0].observationMetrics.extensions, 1);
  assert.ok(Date.parse(releases[0].observationEndAt) > Date.now(), 'observationEndAt 已展期到未来');
});

test('modifyCandidate：QUEUED_FOR_RELEASE 改草稿 → 回 PENDING_EVAL 重评', async () => {
  const h = setup();
  const cand = makeCandidate('batch-frontmatter');
  await putCandidate(h.svc, h.ctx, cand);
  const updated = await h.svc.modifyCandidate({
    id: cand.id,
    skillDraft: { ...skillDraft('batch-frontmatter'), body: '# 改过的步骤' },
  });
  assert.equal(updated.status, 'PENDING_EVAL');
  assert.match(updated.skillDraft.body, /改过/);
});

test('stats：含 releases 汇总 + sprint 16-release-layer', async () => {
  const h = setup();
  const s = await h.svc.stats();
  assert.equal(s.sprint, '16-release-layer');
  assert.ok(s.releases && typeof s.releases.total === 'number');
  assert.ok(s.config.release_enabled !== undefined);
});

test('收尾清理临时目录', () => {
  // 各 test 独立 mkdtemp，这里统一不清理也可（系统临时目录）；
  // 保留显式说明而非静默残留。
});
