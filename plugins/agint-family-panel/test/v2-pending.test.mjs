/**
 * aggPending 单测：把「积压待办队列」聚合成一节可展示的列表。
 *
 * 设计红线（插件自身的两条，照做）：
 *   - 绝不谎报通电：存储域缺失/读失败 → state=unavailable/error，**不是绿色的 0**
 *   - 绝不让面板崩：一个域坏只降级那一行
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { makeStorages } from './fixtures/make-storages.mjs';
import { aggPending, collectV2Data } from '../lib/v2-data.js';

const here = dirname(fileURLToPath(import.meta.url));

const dir = mkdtempSync(join(tmpdir(), 'panel-pending-'));

function domain(file, tables) {
  writeFileSync(join(dir, file), JSON.stringify({ unit: 'u', global: {}, tables }));
}

function domainIn(target, file, tables) {
  writeFileSync(join(target, file), JSON.stringify({ unit: 'u', global: {}, tables }));
}

const byKey = (p, k) => p.queues.find((q) => q.key === k);

// ── ① curriculum：一个 open 的挑战 + 一个已完成的挑战 ──────────────────
domain('agint_curriculum.json', {
  challenges: {
    c1: { id: 'c1', domain: 'integration', level: 'D1', status: 'open', attemptCount: 0 },
    c2: { id: 'c2', domain: 'planning', level: 'D1', status: 'done', attemptCount: 1 },
  },
  attempts: {},
});

// ── ② 技能候选：检测器有 54 个 pattern，但候选为 0（供给有、产出无）──
domain('agint_skill_autocreate.json', {
  task_patterns: { p1: {}, p2: {}, p3: {} },
  candidates: { c1: { id: 'c1', title: '写一个巡检脚本' } },
});

// ── ③ 进化提案：3 条待批 + 1 条已应用 ─────────────────────────────────
domain('agint_evolve.json', {
  proposal: {
    a: { id: 'a', title: '提案甲', status: 'proposed' },
    b: { id: 'b', title: '提案乙', status: 'proposed' },
    c: { id: 'c', title: '提案丙', status: 'proposed' },
    d: { id: 'd', title: '提案丁', status: 'applied' },
  },
});

// ── ④ curator 重叠候选 ────────────────────────────────────────────────
domain('agint_curator.json', { overlap_candidates: { o1: { id: 'o1' } } });

// ── ⑤ 失败样本供给（不是「待办」，是上游供给不足）────────────────────
domain('agint_evolution.json', { failure_pattern: { f1: { id: 'f1' }, f2: { id: 'f2' } } });

const P = aggPending(dir);

const curr = byKey(P, 'curriculum-challenge');
assert.equal(curr.state, 'ok', '域可读 → ok');
assert.equal(curr.pending, 1, '只有 open 的挑战算待办，done 不算');
assert.equal(curr.items.length, 1);
assert.deepEqual(
  { id: curr.items[0].id, domain: curr.items[0].domain, level: curr.items[0].level },
  { id: 'c1', domain: 'integration', level: 'D1' },
);

const skill = byKey(P, 'skill-candidate');
assert.equal(skill.state, 'ok');
assert.equal(skill.pending, 1, '候选数即待办数');
assert.equal(skill.supply, 3, '同时报出上游 pattern 数：供给有而产出无要看得见');

const evo = byKey(P, 'evolve-proposal');
assert.equal(evo.state, 'ok');
assert.equal(evo.pending, 3, '只有 status=proposed 待批，applied 不算');
assert.equal(evo.total, 4);
assert.equal(evo.items[0].title, '提案甲');

const cur = byKey(P, 'curator-overlap');
assert.equal(cur.state, 'ok');
assert.equal(cur.pending, 1);

const supply = byKey(P, 'failure-supply');
assert.equal(supply.state, 'ok');
assert.equal(supply.kind, 'supply', '供给不足不是「待办」，kind 必须区分，UI 才不会混排');
assert.equal(supply.pending, 2);
assert.equal(supply.threshold, 10, '门槛来自 COLD_START_MIN，低于它上游 annotate 放行不了');

// ── 绝不谎报通电：域不存在 ≠ 域是空的 ────────────────────────────────
const empty = mkdtempSync(join(tmpdir(), 'panel-pending-empty-'));
domainIn(empty, 'agint_curriculum.json', { challenges: {}, attempts: {} });
const E = aggPending(empty);
const okZero = byKey(E, 'curriculum-challenge');
assert.equal(okZero.state, 'ok');
assert.equal(okZero.pending, 0, '域在但确实为空 → 真的是 0');
const gone = byKey(E, 'evolve-proposal');
assert.equal(gone.state, 'unavailable', '域不存在 → unavailable');
assert.equal(gone.pending, null, '没有这个域时 pending 必须是 null，不能是 0 —— 0 会装绿');

// ── 一个域坏，其余照常 ────────────────────────────────────────────────
const broken = mkdtempSync(join(tmpdir(), 'panel-pending-broken-'));
writeFileSync(join(broken, 'agint_curriculum.json'), '{ not json');
domainIn(broken, 'agint_evolve.json', { proposal: { a: { id: 'a', status: 'proposed' } } });
const B = aggPending(broken);
assert.equal(byKey(B, 'curriculum-challenge').state, 'error', '坏域 → error 带原因');
assert.equal(byKey(B, 'evolve-proposal').state, 'ok', '一个域坏不能连累其余行');

// ── 接进 collectV2Data：不接就等于没做（面板读的是这一个快照）────────
const HOME = join(here, 'fixtures', 'v2-home');
makeStorages(HOME);
const R = collectV2Data(
  { pluginsDir: join(HOME, 'profiles', 'web', 'plugins'), storagesDir: dir, repoPluginsDir: null, repoPluginsSource: 'unresolved' },
  { cache: new Map() },
);
assert.ok(R.pending, 'collectV2Data 必须暴露 payload.pending —— 面板只读这一个快照');
assert.equal(R.pending.queues.length, 5, '五条声明表全在');
assert.equal(byKey(R.pending, 'curriculum-challenge').pending, 1, '经 collectV2Data 聚合后与直调一致');

console.log('v2-pending: ok');
