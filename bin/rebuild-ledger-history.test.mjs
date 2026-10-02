/**
 * rebuild-ledger-history.test.mjs —— CLI 契约（退出码 + 报告内容）
 *
 * 这里测的是**进程边界**：人（和 cron 前的自查）靠退出码判断"这批计划能不能入链"，
 * 所以 0 / 1 / 2 三档必须各就各位 —— 尤其"证据不足"（1，业务判据）与
 * "取数失败"（2，脚本自身出错）不能混：把读不到文件说成"没证据"，
 * 运维就会去看错的方向。
 *
 * 推导逻辑本身在 plugins/agint-evolution-memory/test/ledger-rebuild.test.mjs 测，
 * 两边共用同一个 buildRebuildPlan，所以这里不重测字段来源。
 *
 * Run: node --test bin/rebuild-ledger-history.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'rebuild-ledger-history.mjs');

function variant(i) {
  return {
    variant_id: `var-${i}`,
    commit_id: `prop-${i}`,
    mutation_kind: 'PROMPT_MUTATION',
    generation: 0,
    policy_decision: 'PENDING_REVIEW',
    expected_effect: { metric: 'SUCCESS_RATE', direction: 'increase', window: '7d' },
    payload: { promptId: `p-${i}` },
  };
}

/** 造一套 storages + repo：count 条可重建进化，外加一条「证据不全」的被拒候选。 */
function makeFixtures({ count = 6, ledgerRows = [] } = {}) {
  const storages = mkdtempSync(join(tmpdir(), 'dsh-rebuild-cli-st-'));
  const repo = mkdtempSync(join(tmpdir(), 'dsh-rebuild-cli-repo-'));
  mkdirSync(join(repo, '.agint-preimage'), { recursive: true });

  const events = [];
  const variants = [];
  for (let i = 1; i <= count; i++) {
    const ts = `2026-09-2${(i % 7) + 1}T0${i}:00:00.000Z`;
    writeFileSync(join(repo, '.agint-preimage', `p${i}.bak`), 'x'.repeat(100), 'utf8');
    variants.push(variant(i));
    events.push({ id: `evt-p-${i}`, topic: 'evolution.mutation.proposed', occurredAt: ts, payload: { proposalId: `prop-${i}`, variantId: `var-${i}` } });
    events.push({
      id: `evt-o-${i}`,
      topic: 'evolution.mutation.committed',
      occurredAt: ts,
      payload: { proposalId: `prop-${i}`, path: 'bin/x.sh', preimagePath: `.agint-preimage/p${i}.bak`, bytesBefore: 100, bytesAfter: 200, policyDecision: 'AUTO_DEPLOY' },
    });
  }
  // 一条永远重建不出来的候选：没有 variants 行（生产实况里就是 09-27 那条 validate 阶段被拒的）
  events.push({ id: 'evt-rejected', topic: 'evolution.mutation.rejected', occurredAt: '2026-09-27T10:18:15.793Z', payload: { proposalId: 'prop-ghost', findings: ['validate: 入参缺 proposal.id'] } });

  writeFileSync(join(storages, 'agint_event_bus.json'), JSON.stringify({
    unit: { name: 'agint_event_bus', version: 1 },
    tables: { events: Object.fromEntries(events.map((e) => [e.id, { envelope: e }])) },
  }, null, 2), 'utf8');
  writeFileSync(join(storages, 'agint_population.json'), JSON.stringify({
    unit: { name: 'agint_population', version: 1 },
    tables: { variants: Object.fromEntries(variants.map((v) => [v.variant_id, v])) },
  }, null, 2), 'utf8');
  writeFileSync(join(storages, 'agint_evolution.json'), JSON.stringify({
    unit: { name: 'agint_evolution', version: 1 },
    global: null,
    tables: { evolution_ledger: Object.fromEntries(ledgerRows.map((r) => [String(r.seq), r])) },
  }, null, 2), 'utf8');
  return { storages, repo };
}

function run(args) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (err) {
    return { code: typeof err.status === 'number' ? err.status : 2, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('--json：证据齐备 ⇒ exit 0 + REBUILD_READY + 6 条计划', () => {
  const { storages, repo } = makeFixtures({ count: 6 });
  const r = run(['--json', '--storages', storages, '--repo', repo]);
  assert.equal(r.code, 0, r.out);
  const doc = JSON.parse(r.out);
  assert.equal(doc.code, 'REBUILD_READY');
  assert.equal(doc.entries.length, 6);
  assert.equal(doc.counts.blocked, 1);
  assert.deepEqual(doc.entries.map((e) => e.contractId)[0], 'REBUILD:prop-1');
  assert.deepEqual(doc.entries.map((e) => e.timestamp), [...doc.entries.map((e) => e.timestamp)].sort());
});

test('报告必须把「被拒绝的候选 + 理由」打出来（人工核对看的是负面清单）', () => {
  const { storages, repo } = makeFixtures({ count: 6 });
  const r = run(['--storages', storages, '--repo', repo]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /拒绝重建 1 条/);
  assert.match(r.out, /NO_VARIANT_ROW/);
  assert.match(r.out, /时序窗口【开】/);
});

test('链上已有实时条目 ⇒ exit 1 + REBUILD_TIMING_CLOSED（§4.3.5 硬约束）', () => {
  const live = {
    seq: 1, contractId: 'EVO-LIVE-1', generation: 'GEN-001',
    summary: { mutationType: 'PROMPT_MUTATION', changedPlugins: [], targetMetric: 'SUCCESS_RATE', hypothesisDigest: 'live', decision: 'AUTO_DEPLOY' },
    chain: { entryHash: `sha256:${'1'.repeat(64)}`, parentHash: `sha256:${'0'.repeat(64)}`, batchRoot: `sha256:${'2'.repeat(64)}`, merkleRoot: `sha256:${'3'.repeat(64)}` },
    references: { eventBusIds: [] }, timestamp: '2026-10-01T00:00:00.000Z', reconstructed: false, evidenceCompleteness: null,
  };
  const { storages, repo } = makeFixtures({ count: 6, ledgerRows: [live] });
  const r = run(['--json', '--storages', storages, '--repo', repo]);
  assert.equal(r.code, 1, r.out);
  const doc = JSON.parse(r.out);
  assert.equal(doc.code, 'REBUILD_TIMING_CLOSED');
  assert.equal(doc.chain.live, 1);
});

test('可重建不足 5 条 ⇒ exit 1 + REBUILD_INSUFFICIENT_EVIDENCE（门槛是判据，不是错误）', () => {
  const { storages, repo } = makeFixtures({ count: 3 });
  const r = run(['--json', '--storages', storages, '--repo', repo]);
  assert.equal(r.code, 1, r.out);
  assert.equal(JSON.parse(r.out).code, 'REBUILD_INSUFFICIENT_EVIDENCE');
});

test('取数失败 ⇒ exit 2（与「不可入链」的 1 分开）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rebuild-cli-missing-'));
  const r = run(['--storages', join(dir, 'nope'), '--repo', dir]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /REBUILD_SOURCE_MISSING/);
});

test('--out 落计划留档；⛔ 拒绝把留档写进存储目录', () => {
  const { storages, repo } = makeFixtures({ count: 6 });
  const out = join(repo, 'plan.json');
  const r = run(['--out', out, '--storages', storages, '--repo', repo]);
  assert.equal(r.code, 0, r.out);
  const doc = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(doc.code, 'REBUILD_READY');
  assert.ok(doc.generatedAt.endsWith('Z'));
  const bad = run(['--out', join(storages, 'agint_evolution.json'), '--storages', storages, '--repo', repo]);
  assert.equal(bad.code, 2, bad.out);
  assert.match(bad.out, /--out 不得指向存储目录/);
});

test('--help 与未知参数', () => {
  const h = run(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.out, /只读报告/);
  const bad = run(['--nope']);
  assert.equal(bad.code, 2);
});
