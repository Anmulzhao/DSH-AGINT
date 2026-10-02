/**
 * ledger-rebuild.test.mjs —— 历史重建（§4.3.5 / §4.6 #7）
 *
 * 这个文件要守住的不是"能跑"，是**重建不许撒谎**这四条：
 *   ① 证据取不到的字段一律 null / 进 blockers，⛔ 不出现"看起来合理"的补值
 *   ② 报告（bin）与入链（宿主）用的是同一份推导 —— 靠"只有一个实现"来保证，
 *      所以这里测的是 `buildRebuildPlan` 这个纯函数本身，不是它的复制品
 *   ③ 时序窗口关了就必须一条都不写（§4.3.5 硬约束）
 *   ④ 重建条目入链后 entryHash 仍可从存储重算复现（否则 reconstructed
 *      标记成了"可以少校验"的借口）
 *
 * Run: node --test plugins/agint-evolution-memory/test/ledger-rebuild.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLedgerService } from '../lib/ledger.js';
import { buildRebuildPlan, createLedgerRebuildService, REBUILD_CONTRACT_PREFIX } from '../lib/ledger-rebuild.js';
import { createFileSourceLoader, readUnitTable } from '../lib/ledger-rebuild-sources.js';
import { computeEntryHash } from '../lib/ledger-hash.js';
import { ledgerEntrySchema } from '../lib/schema.js';

// ── fixtures ──────────────────────────────────────────────────────────────

const variant = (over = {}) => ({
  variant_id: 'var-1',
  commit_id: 'prop-1',
  mutation_kind: 'PROMPT_MUTATION',
  generation: 0,
  policy_decision: 'PENDING_REVIEW',
  expected_effect: { metric: 'SUCCESS_RATE', direction: 'increase', window: '7d' },
  payload: { promptId: 'plugin-preflight' },
  ...over,
});

const outcome = (over = {}) => ({
  id: 'evt-outcome-1',
  topic: 'evolution.mutation.committed',
  occurredAt: '2026-09-27T10:30:07.089Z',
  payload: {
    proposalId: 'prop-1',
    candidateId: 'cand-1',
    path: 'presets/agint/skills/plugin-preflight/SKILL.md',
    preimagePath: '.agint-preimage/preset.bak',
    bytesBefore: 100,
    bytesAfter: 200,
    policyDecision: 'AUTO_DEPLOY',
  },
  ...over,
});

const proposed = (over = {}) => ({
  id: 'evt-proposed-1',
  topic: 'evolution.mutation.proposed',
  occurredAt: '2026-09-27T10:30:07.040Z',
  payload: { proposalId: 'prop-1', variantId: 'var-1' },
  ...over,
});

const okStat = () => ({ exists: true, size: 100 });

function planOf(over = {}) {
  return buildRebuildPlan({
    events: [proposed(), outcome()],
    variants: [variant()],
    preimageStat: okStat,
    ...over,
  });
}

/** 6 条互相独立的进化（跨过 §4.6 #7 的 ≥5 门槛）。 */
function sixEvidence() {
  const events = [];
  const variants = [];
  for (let i = 1; i <= 6; i++) {
    const pid = `prop-${i}`;
    const ts = `2026-09-2${(i % 7) + 1}T0${i}:00:00.${String(i).padStart(3, '0')}Z`;
    variants.push(variant({ variant_id: `var-${i}`, commit_id: pid }));
    events.push(proposed({ id: `evt-p-${i}`, occurredAt: ts, payload: { proposalId: pid, variantId: `var-${i}` } }));
    events.push(outcome({ id: `evt-o-${i}`, occurredAt: ts, payload: { ...outcome().payload, proposalId: pid, preimagePath: '.agint-preimage/x.bak' } }));
  }
  return { events, variants, preimageStat: okStat };
}

function makeTable() {
  const records = new Map();
  return {
    entries: () => [...records.entries()][Symbol.iterator](),
    keys: () => [...records.keys()][Symbol.iterator](),
    get: (k) => records.get(k),
    get size() { return records.size; },
    async put(k, v) { records.set(k, v); return true; },
  };
}

function makeLedger(nowIso = () => '2026-10-03T00:00:00.000Z') {
  const table = makeTable();
  const ledger = createLedgerService({ getTable: async () => table, now: nowIso, warn: () => {}, bump: () => {} });
  return { ledger, table };
}

// ── ① 纯推导：字段来源 ────────────────────────────────────────────────────

test('buildRebuildPlan：一条 committed 进化的逐字段来源', () => {
  const p = planOf();
  assert.equal(p.counts.planned, 1);
  assert.equal(p.counts.blocked, 0);
  const [e] = p.entries;
  assert.ok(e.contractId.startsWith(REBUILD_CONTRACT_PREFIX), 'contractId 必须带 REBUILD: 命名空间');
  assert.equal(e.contractId, 'REBUILD:prop-1');
  assert.equal(e.generation, 'GEN-000', 'variants.generation=0 → GEN-000（有证据的格式化，不是 UNKNOWN）');
  assert.equal(e.summary.mutationType, 'PROMPT_MUTATION');
  assert.equal(e.summary.targetMetric, 'SUCCESS_RATE');
  assert.equal(e.summary.decision, 'AUTO_DEPLOY', '事件里的 policyDecision 优先于 variants 行');
  assert.deepEqual(e.summary.changedPlugins, [], 'presets/ 路径不属于任何插件，不猜归属');
  assert.equal(e.timestamp, '2026-09-27T10:30:07.089Z');
  assert.deepEqual(e.references.eventBusIds, ['evt-proposed-1', 'evt-outcome-1']);
  assert.equal(e.references.populationCandidateId, 'var-1');
  assert.equal(e.references.preimagePath, '.agint-preimage/preset.bak');
  // 内容级 / Phase 1 往后才有的字段：一律 null，且 contractHash 为 null
  // 是"没有 Contract 可指"的如实表达（头注第 1 条：不重建 Contract）。
  assert.equal(e.references.contractHash, null);
  assert.equal(e.references.lockEventId, null);
  assert.equal(e.references.gitCommit, null);
  assert.equal(e.references.abTestId, null);
  assert.equal(e.summary.predictedDelta, null);
  assert.equal(e.summary.actualDelta, null);
  assert.equal(e.summary.predictionQuality, null);
  assert.equal(e.summary.predictionSource, null);
  assert.equal(e.evidenceCompleteness, 'FULL');
  assert.deepEqual(e.evidence.missingEvidence, []);
  assert.equal(e.evidence.decisionSource, 'event.policyDecision');
});

test('buildRebuildPlan：digest 只拼有证据的片段，且长度有界', () => {
  const e = planOf().entries[0];
  assert.match(e.summary.hypothesisDigest, /PROMPT_MUTATION/);
  assert.match(e.summary.hypothesisDigest, /bytes 100->200/);
  assert.match(e.summary.hypothesisDigest, /expected SUCCESS_RATE increase within 7d/);
  assert.ok(!/undefined|null/.test(e.summary.hypothesisDigest), 'digest 里不得出现字面量 undefined/null');
  const long = planOf({
    events: [proposed(), outcome({ payload: { ...outcome().payload, reason: 'x'.repeat(500) } })],
  });
  assert.ok(long.entries[0].summary.hypothesisDigest.length <= 200);
});

test('buildRebuildPlan：planned 条目按 timestamp 升序（入链顺序 = 事件顺序）', () => {
  const p = buildRebuildPlan({
    events: [
      outcome({ id: 'o3', occurredAt: '2026-09-29T00:00:00.000Z', payload: { ...outcome().payload, proposalId: 'prop-1' } }),
      outcome({ id: 'o1', occurredAt: '2026-09-27T00:00:00.000Z', payload: { ...outcome().payload, proposalId: 'prop-2' } }),
      outcome({ id: 'o2', occurredAt: '2026-09-28T00:00:00.000Z', payload: { ...outcome().payload, proposalId: 'prop-3' } }),
    ],
    variants: [variant({ commit_id: 'prop-1' }), variant({ commit_id: 'prop-2' }), variant({ commit_id: 'prop-3' })],
    preimageStat: okStat,
  });
  assert.deepEqual(p.entries.map((e) => e.timestamp),
    ['2026-09-27T00:00:00.000Z', '2026-09-28T00:00:00.000Z', '2026-09-29T00:00:00.000Z']);
});

test('buildRebuildPlan：同一时刻的多条按 contractId 定序（决定论）', () => {
  const once = (id, pid) => outcome({ id, occurredAt: '2026-09-27T00:00:00.000Z', payload: { ...outcome().payload, proposalId: pid } });
  const mk = () => buildRebuildPlan({
    events: [once('b', 'prop-b'), once('a', 'prop-a')],
    variants: [variant({ commit_id: 'prop-a' }), variant({ commit_id: 'prop-b' })],
    preimageStat: okStat,
  }).entries.map((e) => e.contractId);
  assert.deepEqual(mk(), mk(), '同输入必同输出（报告与入链要能对上）');
});

// ── ② blockers：取不到证据就拒绝，不补值 ──────────────────────────────────

test('blockers：variants 无对应行 ⇒ 拒绝（生产实况：validate 阶段被拒的那条）', () => {
  const p = planOf({ variants: [] });
  assert.equal(p.entries.length, 0);
  assert.equal(p.blockers[0].code, 'NO_VARIANT_ROW');
});

test('blockers：缺 proposalId ⇒ 幂等键无从构造', () => {
  const p = planOf({ events: [proposed(), outcome({ payload: { candidateId: 'c' } })] });
  assert.equal(p.blockers[0].code, 'NO_PROPOSAL_ID');
});

test('blockers：mutation_kind 不在 FROZEN 枚举内 ⇒ 拒绝（⛔ 不就近挑一个合法值）', () => {
  const p = planOf({ variants: [variant({ mutation_kind: 'MEMORY' })] });
  assert.equal(p.blockers[0].code, 'MUTATION_TYPE_UNEVIDENCED');
});

test('blockers：expected_effect.metric 缺失 ⇒ 拒绝（⛔ 不默认 SUCCESS_RATE）', () => {
  const p = planOf({ variants: [variant({ expected_effect: { direction: 'increase' } })] });
  assert.equal(p.blockers[0].code, 'TARGET_METRIC_UNEVIDENCED');
});

test('blockers：两个来源都给不出枚举内 decision ⇒ 拒绝', () => {
  const p = planOf({
    events: [proposed(), outcome({ payload: { ...outcome().payload, policyDecision: 'SHIP_IT' } })],
    variants: [variant({ policy_decision: 'SHIP_IT' })],
  });
  assert.equal(p.blockers[0].code, 'DECISION_UNEVIDENCED');
});

test('blockers：occurredAt 不是 UTC 毫秒串 ⇒ 拒绝（§4.3.1 ①）', () => {
  const p = planOf({ events: [proposed(), outcome({ occurredAt: '2026-09-27T10:30:07Z' })] });
  assert.equal(p.blockers[0].code, 'TIMESTAMP_UNEVIDENCED');
});

test('REJECT 决策照常入链：Ledger 记的是发生过什么，不是成功过什么（§4.3.4 纪律 9）', () => {
  const p = planOf({
    events: [proposed(), outcome({ topic: 'evolution.mutation.rolledback', payload: { proposalId: 'prop-1', path: 'bin/x.sh', policyDecision: 'REJECT', sandboxOk: false, reverted: true } })],
  });
  assert.equal(p.entries.length, 1);
  assert.equal(p.entries[0].summary.decision, 'REJECT');
  assert.equal(p.entries[0].evidenceCompleteness, 'FULL', '回滚本来就没有 preimage，不缺证据');
});

// ── ③ completeness：什么算缺，什么不算 ───────────────────────────────────

test('preimage 字节数与事件声称的 bytesBefore 不符 ⇒ 引用置 null + PARTIAL', () => {
  const p = planOf({ preimageStat: () => ({ exists: true, size: 999 }) });
  assert.equal(p.entries[0].references.preimagePath, null);
  assert.equal(p.entries[0].evidenceCompleteness, 'PARTIAL');
  assert.deepEqual(p.entries[0].evidence.missingEvidence, ['preimage:size-mismatch']);
});

test('committed 事件没记 preimagePath ⇒ PARTIAL（证据断了一环，如实标注）', () => {
  const { preimagePath, ...rest } = outcome().payload;
  const p = planOf({ events: [proposed(), outcome({ payload: rest })] });
  assert.deepEqual(p.entries[0].evidence.missingEvidence, ['preimage:not-recorded']);
  assert.equal(p.entries[0].evidenceCompleteness, 'PARTIAL');
});

test('缺 proposed 事件 ⇒ PARTIAL，但 eventBusIds 只放真实存在的那条', () => {
  const p = planOf({ events: [outcome()] });
  assert.deepEqual(p.entries[0].references.eventBusIds, ['evt-outcome-1']);
  assert.ok(p.entries[0].evidence.missingEvidence.includes('proposedEvent'));
});

test('Phase 1 往后才有的预测字段不计入 completeness（否则每条都自动 PARTIAL）', () => {
  const p = planOf();
  assert.equal(p.entries[0].summary.predictionQuality, null);
  assert.equal(p.entries[0].evidenceCompleteness, 'FULL');
});

// ── 取数器 ────────────────────────────────────────────────────────────────

test('createFileSourceLoader：整单元 → { events, variants, preimageStat } 形状', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rebuild-src2-'));
  const repo = mkdtempSync(join(tmpdir(), 'dsh-rebuild-repo-'));
  mkdirSync(join(repo, '.agint-preimage'), { recursive: true });
  writeFileSync(join(repo, '.agint-preimage', 'a.bak'), 'abcdef', 'utf8');
  writeFileSync(join(dir, 'agint_event_bus.json'), JSON.stringify({
    unit: { name: 'agint_event_bus', version: 1 },
    tables: { events: { 'e1': { envelope: { id: 'e1', topic: 'evolution.mutation.committed', occurredAt: 'x', payload: { preimagePath: '.agint-preimage/a.bak' } } } } },
  }), 'utf8');
  writeFileSync(join(dir, 'agint_population.json'), JSON.stringify({
    unit: { name: 'agint_population', version: 1 },
    tables: { variants: { 'v1': variant() } },
  }), 'utf8');
  const src = await createFileSourceLoader({ storagesDir: dir, repoRoot: repo })();
  assert.equal(src.events.length, 1);
  assert.deepEqual(src.events[0], { id: 'e1', topic: 'evolution.mutation.committed', occurredAt: 'x', payload: { preimagePath: '.agint-preimage/a.bak' } });
  assert.equal(src.variants[0].variant_id, 'var-1');
  assert.deepEqual(src.preimageStat('.agint-preimage/a.bak'), { exists: true, size: 6 });
  assert.equal(src.preimageStat('/etc/passwd'), null, '绝对路径拒探');
  assert.equal(src.preimageStat('../outside.bak'), null, '`..` 逃逸拒探');
  assert.equal(src.preimageStat('.agint-preimage/gone.bak').exists, false);
});

test('createFileSourceLoader：unit 名/版本不符 ⇒ 抛错，不静默读', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rebuild-src3-'));
  writeFileSync(join(dir, 'agint_event_bus.json'), JSON.stringify({ unit: { name: 'someone_else', version: 1 }, tables: {} }), 'utf8');
  writeFileSync(join(dir, 'agint_population.json'), JSON.stringify({ unit: { name: 'agint_population', version: 2 }, tables: {} }), 'utf8');
  const load = createFileSourceLoader({ storagesDir: dir, repoRoot: dir });
  await assert.rejects(load(), /FOREIGN_UNIT/);
  assert.throws(() => readUnitTable(join(dir, 'agint_population.json'), 'agint_population', 'variants'), /REBUILD_SOURCE_VERSION/);
});

test('createFileSourceLoader：表还没落 ⇒ 空数组（无证据 ≠ 出错）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rebuild-src4-'));
  writeFileSync(join(dir, 'agint_event_bus.json'), JSON.stringify({ unit: { name: 'agint_event_bus', version: 1 }, tables: {} }), 'utf8');
  writeFileSync(join(dir, 'agint_population.json'), JSON.stringify({ unit: { name: 'agint_population', version: 1 }, tables: {} }), 'utf8');
  const src = await createFileSourceLoader({ storagesDir: dir, repoRoot: dir })();
  assert.deepEqual(src.events, []);
  assert.deepEqual(src.variants, []);
});

// ── ④ apply：入链前后的四条硬判据 ─────────────────────────────────────────

test('apply 缺省是 dry-run：一条都不写', async () => {
  const { ledger, table } = makeLedger();
  const svc = createLedgerRebuildService({ ledger, loadSources: async () => sixEvidence() });
  const res = await svc.apply();
  assert.equal(res.code, 'REBUILD_DRY_RUN');
  assert.equal(res.applied, 0);
  assert.equal(table.size, 0, '没传 apply:true 就绝不能写');
  assert.equal(res.entries.length, 6);
});

test('apply 经 ledger service 入链：seq 连续 + reconstructed 标记 + hash 可重算', async () => {
  const { ledger, table } = makeLedger();
  const svc = createLedgerRebuildService({ ledger, loadSources: async () => sixEvidence() });
  const res = await svc.apply({ apply: true });
  assert.equal(res.code, 'REBUILD_APPLIED');
  assert.equal(res.applied, 6);
  assert.deepEqual(res.written.map((w) => w.seq), [1, 2, 3, 4, 5, 6]);
  for (const w of res.written) {
    const rec = table.get(String(w.seq));
    assert.equal(rec.reconstructed, true);
    assert.equal(rec.evidenceCompleteness, 'FULL');
    assert.equal(rec.contractId, w.contractId);
    // 报告用的 evidence 明细不进条目（条目形状是可哈希的）
    assert.equal('evidence' in rec, false);
    // ④ 重建条目与原始条目走同一套哈希：标记不是免检理由
    assert.equal(computeEntryHash(rec), rec.chain.entryHash);
    ledgerEntrySchema.parse(rec);
  }
  const head = await ledger.getHead();
  assert.equal(head.seq, 6);
  assert.equal((await ledger.stats()).reconstructed, 6);
});

test('重放安全：同一份计划再 apply 一次不新增条目（contractId 幂等）', async () => {
  const { ledger, table } = makeLedger();
  const svc = createLedgerRebuildService({ ledger, loadSources: async () => sixEvidence() });
  await svc.apply({ apply: true });
  const again = await svc.apply({ apply: true });
  assert.equal(again.applied, 0);
  assert.equal(again.written.every((w) => w.idempotent), true);
  assert.equal(table.size, 6, '重跑不得往链上添东西');
});

test('时序窗口已关：链上有实时条目 ⇒ 一条都不写 + REBUILD_TIMING_VIOLATION', async () => {
  const { ledger, table } = makeLedger();
  await ledger.appendEntry({
    contractId: 'EVO-LIVE-1', generation: 'GEN-001',
    summary: { mutationType: 'PROMPT_MUTATION', changedPlugins: [], targetMetric: 'SUCCESS_RATE', hypothesisDigest: 'live', decision: 'AUTO_DEPLOY' },
    references: {}, timestamp: '2026-10-01T00:00:00.000Z',
  });
  const before = table.size;
  const svc = createLedgerRebuildService({ ledger, loadSources: async () => sixEvidence() });
  const res = await svc.apply({ apply: true });
  assert.equal(res.code, 'REBUILD_TIMING_VIOLATION');
  assert.equal(res.applied, 0);
  assert.equal(table.size, before, '窗口关了就是零写入，不是"写在尾部试试"');
  assert.match(res.detail, /parentHash/);
});

test('证据不足 5 条 ⇒ 拒绝入链并说明门槛（§4.6 #7）', async () => {
  const { ledger, table } = makeLedger();
  const three = { events: [proposed(), outcome()], variants: [variant()], preimageStat: okStat };
  const svc = createLedgerRebuildService({ ledger, loadSources: async () => three });
  const res = await svc.apply({ apply: true });
  assert.equal(res.code, 'REBUILD_INSUFFICIENT_EVIDENCE');
  assert.equal(table.size, 0);
});

test('中途写失败即停：前缀保留、不跳过、不重试（断点可续）', async () => {
  const { ledger, table } = makeLedger();
  const original = ledger.appendEntry;
  let n = 0;
  const flaky = {
    ...ledger,
    async appendEntry(input) {
      n += 1;
      if (n === 3) throw new Error('MOCK_WRITE_FAILURE');
      return original(input);
    },
  };
  const svc = createLedgerRebuildService({ ledger: flaky, loadSources: async () => sixEvidence() });
  await assert.rejects(svc.apply({ apply: true }), /MOCK_WRITE_FAILURE/);
  assert.equal(table.size, 2, '失败前的前缀留下，失败后的不写');
  // 换回正常 ledger 重跑：靠幂等从断点续到 6 条，seq 不重复、不跳号
  const svc2 = createLedgerRebuildService({ ledger, loadSources: async () => sixEvidence() });
  const res = await svc2.apply({ apply: true });
  assert.equal(res.applied, 4);
  assert.deepEqual((await ledger.listEntries()).map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
});

test('createLedgerRebuildService：缺 ledger.appendEntry 或 loadSources 即抛（纪律 4）', () => {
  assert.throws(() => createLedgerRebuildService({ ledger: {}, loadSources: async () => ({}) }), /appendEntry/);
  assert.throws(() => createLedgerRebuildService({ ledger: { appendEntry() {} } }), /loadSources/);
});

test('plan() 与 apply() 的推导口径一致（报告与入链不是两套代码）', async () => {
  const { ledger } = makeLedger();
  const svc = createLedgerRebuildService({ ledger, loadSources: async () => sixEvidence() });
  const a = await svc.plan();
  const b = await svc.apply();
  assert.deepEqual(a.entries, b.entries);
});

// ── ⑤ 端到端：真文件 → 重建 → 独立校验器判绿 ──────────────────────────────
//
// 这一条是 §4.6 #7 的收口：重建条目必须**正常参与** entryHash / batchRoot /
// rollupRoot，否则它们只是"看起来在链上"。校验器是独立实现
// （bin/verify-ledger-chain.mjs，不 import 插件），所以这里绿不是自证。

test('端到端：真 fixture 文件重建 6 条 → 落盘 → bin 校验器判链完整', async () => {
  const storages = mkdtempSync(join(tmpdir(), 'dsh-rebuild-e2e-storages-'));
  const repo = mkdtempSync(join(tmpdir(), 'dsh-rebuild-e2e-repo-'));
  mkdirSync(join(repo, '.agint-preimage'), { recursive: true });

  const events = [];
  const variants = [];
  for (let i = 1; i <= 6; i++) {
    const pid = `prop-${i}`;
    const ts = `2026-09-2${(i % 7) + 1}T0${i}:00:00.${String(i).padStart(3, '0')}Z`;
    const pre = `.agint-preimage/p${i}.bak`;
    writeFileSync(join(repo, pre), 'x'.repeat(100 + i), 'utf8');
    variants.push(variant({ variant_id: `var-${i}`, commit_id: pid }));
    events.push(proposed({ id: `evt-p-${i}`, occurredAt: ts, payload: { proposalId: pid, variantId: `var-${i}` } }));
    events.push(outcome({
      id: `evt-o-${i}`,
      occurredAt: ts,
      payload: { ...outcome().payload, proposalId: pid, preimagePath: pre, bytesBefore: 100 + i, bytesAfter: 200 },
    }));
  }
  writeFileSync(join(storages, 'agint_event_bus.json'), JSON.stringify({
    unit: { name: 'agint_event_bus', version: 1 },
    tables: { events: Object.fromEntries(events.map((e) => [e.id, { envelope: e }])) },
  }, null, 2), 'utf8');
  writeFileSync(join(storages, 'agint_population.json'), JSON.stringify({
    unit: { name: 'agint_population', version: 1 },
    tables: { variants: Object.fromEntries(variants.map((v) => [v.variant_id, v])) },
  }, null, 2), 'utf8');

  const { ledger, table } = makeLedger();
  const svc = createLedgerRebuildService({
    ledger,
    loadSources: createFileSourceLoader({ storagesDir: storages, repoRoot: repo }),
  });
  const res = await svc.apply({ apply: true });
  assert.equal(res.code, 'REBUILD_APPLIED', JSON.stringify(res.blockers));
  assert.equal(res.applied, 6);
  // preimage 逐个对上了字节数 ⇒ 全 FULL（证明探测真的在跑，不是恒真）
  assert.deepEqual(res.entries.map((e) => e.evidenceCompleteness), Array(6).fill('FULL'));

  const ledgerFile = join(storages, 'agint_evolution.json');
  writeFileSync(ledgerFile, JSON.stringify({
    unit: { name: 'agint_evolution', version: 1 },
    global: null,
    tables: { evolution_ledger: Object.fromEntries(table.entries()) },
  }, null, 2), 'utf8');

  const HERE = dirname(fileURLToPath(import.meta.url));
  const script = join(HERE, '..', '..', '..', 'bin', 'verify-ledger-chain.mjs');
  const out = execFileSync(process.execPath, [script, '--full', '--ledger', ledgerFile],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /Chain integrity: 6 entries, seq 1-6, no gap/);
  assert.ok(!/TAMPERED|ANCHOR_MISMATCH|GAP/.test(out), `校验器报了链问题：\n${out}`);
});
