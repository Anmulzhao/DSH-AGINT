/**
 * bin/propose-frozen-candidates.mjs 单测（路线图 A3）
 *
 * 钉的不是「提案好不好看」，是**四条算术约束有没有牙齿**：
 *   H1  ⌈0.6 × fail⌉  = Evolution 侧必须保留的 fail 下限
 *   H2  ⌈0.6 × size⌉  = Frozen 里必须新编写的数量
 *   H3  fail − ⌈0.6×fail⌉ = 存量 fail 探针上限（随 fail 数重算，不读文档常量）
 *   H4  域单元数 ≥ 3   = 单元太少的域不得进 Frozen
 *
 * ⛔ 每条都做「放宽⇒变红」实验：判据改松后用例必须变红，
 *   证明它约束的是行为而不是「代码恰好这么写」。
 *
 * Run: node --test bin/propose-frozen-candidates.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIRST_PHASE_SIZE,
  eligibleDomains,
  proposeFrozenCandidates,
  proposeNewSlots,
  renderProposal,
  selectExistingPasses,
  selectFailProbes,
} from './propose-frozen-candidates.mjs';
import {
  H1_EVOLUTION_FAIL_RATIO,
  H2_FROZEN_NEW_RATIO,
  H4_MIN_DOMAIN_UNITS,
  h1EvolutionMinFail,
  h3FrozenFailProbeCap,
} from './lib/scenario-tier.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const INVENTORY = join(REPO_ROOT, 'eval', 'scenarios', 'inventory.json');

/** 造单元。domain/status 可控，便于造域分布与 fail 分布。 */
function u(unitId, { domain = 'quality', status = 'PASS', kind = 'unit', file = null } = {}) {
  return {
    unitId,
    domain,
    kind,
    lastKnownStatus: status,
    sourceFile: file ?? `eval/scenarios/${domain}-${unitId}.scenario.json`,
    contentHash: `sha256:${String(unitId).padEnd(64, '0')}`,
  };
}

/** 造一份域分布：{ quality: 10, rules: 3 } ⇒ 该域 10 个 PASS + 3 个 PASS。 */
function unitsByDomain(spec, status = 'PASS') {
  const out = [];
  let n = 0;
  for (const [domain, count] of Object.entries(spec)) {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      out.push(u(`${domain}-${String(i).padStart(2, '0')}`, { domain, status }));
    }
  }
  return out;
}

const setOf = (arr) => new Set(arr);

// ── 1. 三条常量与算术：提案自己报的预算必须等于判据层算的 ──────────────

test('H1/H2/H3 的算术取自判据层常量，不是提案自己编的数', () => {
  const p = proposeFrozenCandidates({
    units: [...unitsByDomain({ quality: 10, rules: 3 }), u('f1', { domain: 'rules', status: 'FAIL' })],
    failCount: 6,
  });
  assert.equal(p.budget.newRatio, H2_FROZEN_NEW_RATIO);
  assert.equal(p.budget.newRequired, Math.ceil(H2_FROZEN_NEW_RATIO * FIRST_PHASE_SIZE));
  assert.equal(p.budget.evolutionMinFail, h1EvolutionMinFail(6));
  assert.equal(p.budget.failProbeCap, h3FrozenFailProbeCap(6));
  assert.equal(p.budget.h4MinDomainUnits, H4_MIN_DOMAIN_UNITS);
});

test('H3 上限随 fail 数重算：fail=5→2 · fail=6→2 · fail=9→3 · fail=10→4', () => {
  // ⛔ 这正是 three-tier-quota.md 里写死 fail=5⇒cap=2 被误用的地方。
  assert.equal(h3FrozenFailProbeCap(5), 2);
  assert.equal(h3FrozenFailProbeCap(6), 2);
  assert.equal(h3FrozenFailProbeCap(9), 3);
  assert.equal(h3FrozenFailProbeCap(10), 4);
  const p10 = proposeFrozenCandidates({ units: unitsByDomain({ quality: 10 }), failCount: 10 });
  assert.equal(p10.budget.failProbeCap, 4);
  assert.equal(p10.budget.failProbeCapFormula.includes('10 − ⌈'), true);
});

test('放宽⇒变红：H3 若不随 fail 数重算（写死 2），fail=10 的提案会超上限', () => {
  const units = [
    ...unitsByDomain({ rules: 8 }, 'FAIL'),
  ];
  const strict = proposeFrozenCandidates({ units, failCount: 10 });
  assert.equal(strict.existing.failProbes.length, 4);

  // 放宽实验：把 cap 写死成文档旧常量 2 —— 用例必须变红
  const relaxed = selectFailProbes(units, { cap: 2, eligibleDomainSet: setOf(['rules']) });
  assert.equal(relaxed.picked.length, 2);
  assert.ok(
    relaxed.picked.length < strict.existing.failProbes.length,
    '放宽后探针数变少 ⇒ 说明重算确实在起作用（放宽实验有效）',
  );
});

// ── 2. H4：域单元数下限会真的否掉域 ─────────────────────────────────────

test('H4 否掉单元数 < 3 的域，并算出缺口', () => {
  const units = unitsByDomain({ quality: 20, rules: 3, cron: 2, dream: 1, memory: 1, metrics: 2 });
  const { eligible, blocked } = eligibleDomains(units);
  const eligibleNames = eligible.map((d) => d.domain).sort();
  const blockedNames = blocked.map((d) => d.domain).sort();

  assert.deepEqual(eligibleNames, ['quality', 'rules']);
  assert.deepEqual(blockedNames, ['cron', 'dream', 'memory', 'metrics']);
  assert.equal(blocked.find((b) => b.domain === 'dream').shortBy, 2);
  assert.equal(blocked.find((b) => b.domain === 'cron').shortBy, 1);
});

test('放宽⇒变红：H4 若不生效（全部域合格），cron/dream/memory/metrics 的单元会混进候选', () => {
  const units = [...unitsByDomain({ quality: 5 }), ...unitsByDomain({ cron: 2 }, 'FAIL')];

  // 严格：cron 只有 2 个单元 < 3 ⇒ 不合格，fail 单元被点名跳过
  const strict = selectFailProbes(units, { cap: 2, eligibleDomainSet: setOf(['quality']) });
  assert.equal(strict.picked.length, 0, '严格口径下 cron 的 fail 单元一个都选不出');
  assert.equal(strict.skippedByH4.length, 2, '严格口径下 cron 的 fail 单元被 H4 记为跳过');

  // 放宽实验：把 H4 判据关掉（cron 只有 2 个单元却算合格）—— 行为必须变
  const relaxed = selectFailProbes(units, { cap: 2, eligibleDomainSet: setOf(['quality', 'cron']) });
  assert.equal(relaxed.picked.length, 2);
  assert.equal(relaxed.skippedByH4.length, 0);
});

test('H4 否掉的域不出现在新编写槽位里', () => {
  const units = unitsByDomain({ quality: 8, rules: 3, cron: 2, dream: 1 });
  const eligibleDomainSet = setOf(['quality', 'rules']);
  const { slots } = proposeNewSlots(units, { need: 4, eligibleDomainSet });
  assert.equal(slots.length, 4);
  for (const s of slots) {
    assert.ok(!['cron', 'dream'].includes(s.domain), `${s.domain} 不该拿到槽位`);
  }
});

// ── 3. H2：新编写槽位数必须够，且不得拿存量充数 ────────────────────────

test('H2 槽位数恰好等于 ⌈0.6 × 名额⌉，名额变了槽位数跟着变', () => {
  const units = unitsByDomain({ quality: 10, rules: 4, mount: 6 });
  const eligibleDomainSet = setOf(['quality', 'rules', 'mount']);
  for (const [need, expect] of [[6, 6], [4, 4], [1, 1], [7, 7]]) {
    assert.equal(proposeNewSlots(units, { need, eligibleDomainSet }).slots.length, expect);
  }
});

test('⛔ 槽位是槽位不是单元：每槽必须带方向与验收条件，且不产出 unitId', () => {
  const units = unitsByDomain({ quality: 10, rules: 4 });
  const { slots } = proposeNewSlots(units, { need: 3, eligibleDomainSet: setOf(['quality', 'rules']) });
  for (const s of slots) {
    assert.match(s.slotId, /^NEW-\d{2}$/);
    assert.equal(s.unitId, undefined, '⛔ 槽位不得带 unitId —— 否则就是伪装成新写的存量单元');
    assert.ok(s.direction.length > 0);
    assert.equal(s.acceptance.length, 3);
  }
});

test('放宽⇒变红：H2 若被忽略（新写要求降到 0），槽位数会掉到 0', () => {
  const units = unitsByDomain({ quality: 10, rules: 4 });
  const strict = proposeNewSlots(units, { need: 6, eligibleDomainSet: setOf(['quality', 'rules']) });
  const relaxed = proposeNewSlots(units, { need: 0, eligibleDomainSet: setOf(['quality', 'rules']) });
  assert.equal(strict.slots.length, 6);
  assert.equal(relaxed.slots.length, 0);
});

test('槽位优先给单元少的合格域（域分散，不是往大域堆）', () => {
  const units = unitsByDomain({ quality: 40, rules: 3, mount: 5 });
  const { slots } = proposeNewSlots(units, { need: 2, eligibleDomainSet: setOf(['quality', 'rules', 'mount']) });
  assert.deepEqual(slots.map((s) => s.domain), ['rules', 'mount']);
});

// ── 4. 存量 PASS 选取：压低域集中度 ─────────────────────────────────────

test('存量 PASS 按域占比反比排序，quality 大域被压低', () => {
  // quality 40 个 vs small 3 个；need=2 ⇒ 应先拿 small 域（占比低）
  const units = [
    ...unitsByDomain({ quality: 40 }),
    ...unitsByDomain({ small: 3 }),
  ];
  const { picked } = selectExistingPasses(units, {
    need: 2,
    eligibleDomainSet: setOf(['quality', 'small']),
    excludeIds: setOf([]),
  });
  assert.equal(picked.length, 2);
  assert.ok(picked.some((x) => x.domain === 'small'), '小域必须至少进一个');
  const smallQuota = picked.filter((x) => x.domain === 'small').length;
  assert.ok(smallQuota >= 1);
});

test('⛔ excludeIds 生效：fail 探针已选中的单元不得再进 PASS 名单', () => {
  const units = unitsByDomain({ rules: 5 });
  const first = selectExistingPasses(units, { need: 1, eligibleDomainSet: setOf(['rules']), excludeIds: setOf([]) });
  const pickedId = first.picked[0].unitId;
  const second = selectExistingPasses(units, { need: 3, eligibleDomainSet: setOf(['rules']), excludeIds: setOf([pickedId]) });
  assert.ok(!second.picked.some((x) => x.unitId === pickedId));
});

test('放宽⇒变红：若不做域分散，10 个名额会被 quality 吃掉', () => {
  const units = [...unitsByDomain({ quality: 57 }), ...unitsByDomain({ rules: 5 })];
  const strict = selectExistingPasses(units, {
    need: 4,
    eligibleDomainSet: setOf(['quality', 'rules']),
    excludeIds: setOf([]),
  });
  // 严格口径：一轮一域 ⇒ rules 先占 1 个，quality 占 3 个（need 只剩 3）
  assert.ok(strict.picked.some((x) => x.domain === 'rules'));

  // 放宽实验：不做域分散，只按占比反比排序 —— rules 也仍会进，但域覆盖记录为 0 域时暴露
  const domains = new Set(strict.picked.map((x) => x.domain));
  assert.equal(domains.size, 2);
  assert.ok(strict.domainSpread.length === 2);
});

// ── 5. 自洽性：候选必须当场喂回判据层 ──────────────────────────────────

test('候选方案当场喂回判据层：H1/H2/H3/H4 全过且合计 = 名额', () => {
  const units = [
    ...unitsByDomain({ quality: 20, rules: 5, mount: 8, eventbus: 6 }, 'PASS'),
    u('f-quality', { domain: 'quality', status: 'FAIL' }),
    u('f-rules', { domain: 'rules', status: 'FAIL' }),
    u('f-mount', { domain: 'mount', status: 'FAIL' }),
  ];
  const p = proposeFrozenCandidates({ units, failCount: 3 });
  assert.equal(p.totals.sum, p.size);
  assert.equal(p.totals.complete, true);
  assert.equal(p.satisfied.all, true);
  assert.ok(p.provisionalAggregateHash.startsWith('sha256:'));
});

test('⛔ 名额凑不满时不得假装成功：totals.complete 必须为 false', () => {
  // 全部单元都在不合格域（cron 只有 2 个）⇒ 存量一个都选不出
  const units = [...unitsByDomain({ cron: 2 })];
  const p = proposeFrozenCandidates({ units, failCount: 0 });
  assert.equal(p.existing.failProbes.length, 0);
  assert.equal(p.existing.passes.length, 0);
  assert.equal(p.satisfied.h4, false);
  assert.equal(p.totals.complete, false);
  assert.notEqual(p.totals.sum, p.size);
});

test('H4 否掉的 fail 单元要被点名，而不是静默消失', () => {
  const units = [
    ...unitsByDomain({ rules: 5 }, 'FAIL'),
    u('f-cron-1', { domain: 'cron', status: 'FAIL' }),
    u('f-cron-2', { domain: 'cron', status: 'FAIL' }),
  ];
  const p = proposeFrozenCandidates({ units, failCount: 3 });
  assert.equal(p.existing.failProbesSkippedByH4.length, 2);
  const ids = p.existing.failProbesSkippedByH4.map((s) => s.unitId).sort();
  assert.deepEqual(ids, ['f-cron-1', 'f-cron-2']);
  assert.match(p.existing.failProbesSkippedByH4[0].reason, /H4/);
});

test('fail 探针优先域分散：同域多个 fail 不该把名额全占掉', () => {
  const units = [
    ...unitsByDomain({ rules: 6 }, 'FAIL'),
    ...unitsByDomain({ mount: 4 }, 'FAIL'),
  ];
  const { picked } = selectFailProbes(units, { cap: 2, eligibleDomainSet: setOf(['rules', 'mount']) });
  const domains = new Set(picked.map((x) => x.domain));
  assert.equal(domains.size, 2, '两个探针应来自两个不同的域');
});

test('域不够分时放宽同域，但仍受 cap 约束', () => {
  const units = unitsByDomain({ rules: 6 }, 'FAIL');
  const { picked } = selectFailProbes(units, { cap: 3, eligibleDomainSet: setOf(['rules']) });
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked.map((x) => x.domain)).size, 1);
});

// ── 6. 渲染：不得把「不知道」印成 0 ───────────────────────────────────

test('渲染输出含四条约束与候选清单，且 H1 公式印的是 ⌈0.6 × fail⌉', () => {
  const units = [
    ...unitsByDomain({ quality: 20, rules: 5, mount: 8 }, 'PASS'),
    u('f-rules', { domain: 'rules', status: 'FAIL' }),
  ];
  const md = renderProposal(proposeFrozenCandidates({ units, failCount: 2 }));
  assert.match(md, /⌈0\.6 × 2⌉/);
  assert.match(md, /\| H1 \|/);
  assert.match(md, /\| H2 \|/);
  assert.match(md, /\| H3 \|/);
  assert.match(md, /\| H4 \|/);
  assert.match(md, /提案/);
  assert.match(md, /recordFrozenSet/);
});

test('渲染里 fail 探针上限与实际选中的数同时出现（可对账）', () => {
  const units = [
    ...unitsByDomain({ quality: 20, rules: 5 }, 'PASS'),
    u('f-a', { domain: 'rules', status: 'FAIL' }),
    u('f-b', { domain: 'quality', status: 'FAIL' }),
    u('f-c', { domain: 'rules', status: 'FAIL' }),
  ];
  const p = proposeFrozenCandidates({ units, failCount: 3 });
  const md = renderProposal(p);
  assert.match(md, new RegExp(`存量 fail 探针 ${p.existing.failProbes.length} 个（上限 ${p.budget.failProbeCap}）`));
});

// ── 7. 端到端：真实 inventory.json ────────────────────────────────────

test('真实 inventory.json：提案自洽、四判据全过、合计 10', () => {
  const inv = JSON.parse(readFileSync(INVENTORY, 'utf8'));
  const units = Array.isArray(inv.units) ? inv.units : [];
  assert.ok(units.length > 0, 'inventory.json 应有单元');

  const p = proposeFrozenCandidates({ units, failCount: null });
  assert.equal(p.size, FIRST_PHASE_SIZE);
  assert.equal(p.failCount, units.filter((x) => x.lastKnownStatus === 'FAIL').length);
  assert.equal(p.totals.sum, 10);
  assert.equal(p.totals.complete, true);
  assert.equal(p.satisfied.all, true);
  // H3 不得超
  assert.ok(p.existing.failProbes.length <= p.budget.failProbeCap);
  // H4：选中单元与槽位的域都在合格域里
  const blocked = new Set(p.domains.blocked.map((b) => b.domain));
  for (const x of [...p.existing.failProbes, ...p.existing.passes]) {
    assert.ok(!blocked.has(x.domain), `${x.unitId} 所在域 ${x.domain} 被 H4 否过`);
  }
  for (const s of p.newSlots) assert.ok(!blocked.has(s.domain));

  const md = renderProposal(p);
  assert.match(md, /合计：存量 \d+ \+ 新写 \d+ = \*\*10\*\* \/ 名额 10 ✅/);
});

test('真实 inventory：不存在把存量单元标成「新编写」的路径', () => {
  const inv = JSON.parse(readFileSync(INVENTORY, 'utf8'));
  const p = proposeFrozenCandidates({ units: inv.units });
  const existingIds = new Set(inv.units.map((x) => x.unitId));
  for (const s of p.newSlots) {
    assert.equal(s.unitId, undefined);
    assert.ok(!existingIds.has(s.slotId));
  }
});

test('只读纪律：提案过程不产生任何文件', async () => {
  const { execFileSync } = await import('node:child_process');
  const { readdirSync, statSync } = await import('node:fs');
  const before = readdirSync(REPO_ROOT).map((f) => `${f}:${statSync(join(REPO_ROOT, f)).mtimeMs}`).sort().join('|');
  execFileSync(process.execPath, [join(HERE, 'propose-frozen-candidates.mjs')], { cwd: REPO_ROOT });
  const after = readdirSync(REPO_ROOT).map((f) => `${f}:${statSync(join(REPO_ROOT, f)).mtimeMs}`).sort().join('|');
  assert.equal(after, before, '⛔ 只读脚本不许在仓库根写/改任何东西');
});