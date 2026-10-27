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
// 2026-10-18 起本文件不再 import makeStorages：它曾用来重写共享的 v2-home，
// 那是并行测试的竞态源（见下方 collectV2Data 段的注释）。本文件现在只用
// 自己 mkdtemp 出来的 storages，不碰任何共享路径。
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

// ── ② 技能候选：1 条待评估 + 3 条终态（已拒/已回滚），终态不算待办 ──────
// 2026-10-18 老板令：审过的候选不要挂在待办里。原 select 是 () => true，
// 生产上 42 条全是 REJECTED/ROLLED_BACK 却报「42 待审」。
domain('agint_skill_autocreate.json', {
  task_patterns: { p1: {}, p2: {}, p3: {} },
  candidates: {
    c1: { id: 'c1', status: 'QUEUED_FOR_RELEASE', skillDraft: { name: '写一个巡检脚本' } },
    c2: { id: 'c2', status: 'REJECTED' },
    c3: { id: 'c3', status: 'REJECTED_STATIC' },
    c4: { id: 'c4', status: 'ROLLED_BACK' },
    c5: { id: 'c5', status: 'STABLE' },
    c6: { id: 'c6', status: 'RELEASED' },
  },
});

// ── ③ 进化提案：3 条待批 + 1 条已应用 + 1 条已批准可动手 + 1 条已批准但阻塞 ──
domain('agint_evolve.json', {
  proposal: {
    a: { id: 'a', title: '提案甲', status: 'proposed' },
    b: { id: 'b', title: '提案乙', status: 'proposed' },
    c: { id: 'c', title: '提案丙', status: 'proposed' },
    d: { id: 'd', title: '提案丁', status: 'applied' },
    e: { id: 'e', title: '提案戊', status: 'approved' },
    // 2026-10-27：批了方向、但前置没到位的那一档（生产实例 a85ef850）。
    // blocker 为空串 ≠ 有 blocker：前者必须留在工作单里。
    f: {
      id: 'f', title: '提案己', status: 'approved',
      blocker: '周报冻结权重常量，等 8-12 周人工标注样本',
      unblockCondition: '样本 ≥8 周且人工标注覆盖',
    },
    g: { id: 'g', title: '提案庚', status: 'approved', blocker: '' },
    // 2026-10-27：批准即执行之后的两档 —— 一条在队列里跑，一条跑失败了。
    // 它们都**不再**是工作单（前一条自己会跑完，后一条要人看）。
    h: {
      id: 'h', title: '提案辛', status: 'approved', blocker: '',
      execMode: 'immediate', execState: 'queued', execAttempts: 1,
    },
    i: {
      id: 'i', title: '提案壬', status: 'approved', blocker: '',
      execMode: 'immediate', execState: 'failed', execAttempts: 2,
      execError: 'no target asset resolved',
    },
  },
});

// ── ④ curator 重叠候选：1 条 proposed + 2 条已处理 ────────────────────
// 与 skill-candidate 同一类病（2026-10-18 一起修）：原 select 也是 () => true。
domain('agint_curator.json', {
  overlap_candidates: {
    o1: { id: 'o1', skillA: 'a', skillB: 'b', status: 'proposed' },
    o2: { id: 'o2', skillA: 'c', skillB: 'd', status: 'acknowledged' },
    o3: { id: 'o3', skillA: 'e', skillB: 'f', status: 'resolved' },
  },
});

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
assert.equal(skill.pending, 1, '只有仍在等人处理的状态算待办：REJECTED/ROLLED_BACK/STABLE/RELEASED 都不算');
assert.equal(skill.total, 6, 'total 仍报整表行数，好让「审过的有多少」看得见');
assert.equal(skill.items.length, 1, '待办条目只列未终结的候选');
assert.equal(skill.items[0].status, 'QUEUED_FOR_RELEASE');
assert.equal(skill.items[0].title, '写一个巡检脚本', '标题取 skillDraft.name（候选没有顶层 title 字段）');
assert.equal(skill.supply, 3, '同时报出上游 pattern 数：供给有而产出无要看得见');

const evo = byKey(P, 'evolve-proposal');
assert.equal(evo.state, 'ok');
assert.equal(evo.pending, 3, '只有 status=proposed 待批，applied / approved 不算');
assert.equal(evo.total, 9);
assert.equal(evo.items[0].title, '提案甲');

// 2026-10-23：approved 是「人工已批准、尚未执行」。它必须自己占一行待办 ——
// 否则批准 = 从待办里消失，决定做完了却没人去做。
const approvedQ = byKey(P, 'evolve-approved');
assert.equal(approvedQ.state, 'ok');
assert.equal(approvedQ.kind, 'action', '工作单是人能直接动手的，不是「供给不足」');
assert.equal(approvedQ.pending, 2, '只算 status=approved 且没标 blocker（e / g）');
assert.ok(approvedQ.items.some((it) => it.title === '提案戊'));
assert.equal(
  approvedQ.items.filter((it) => it.title === '提案己').length, 0,
  '⛔ 标了 blocker 的不是工作单：放这里就是拿催办去撞自家门禁',
);
assert.equal(
  approvedQ.items.filter((it) => it.title === '提案庚').length, 1,
  'blocker 是空串 ≠ 有 blocker —— 空串必须留在工作单里（否则「明确判过没卡住」被吞）',
);

// 2026-10-27：交给自动执行的提案**不是**工作单 —— 它已经在跑了。
for (const t of ['提案辛', '提案壬']) {
  assert.equal(
    approvedQ.items.filter((it) => it.title === t).length, 0,
    `${t} 已交给 agint-executor，放进工作单就是拿催办单去催一个自动流程`,
  );
}

const execActive = byKey(P, 'evolve-exec-active');
assert.equal(execActive.state, 'ok');
assert.equal(execActive.kind, 'supply', '排队/在跑时人能做的只有等 —— 不是待办');
assert.equal(execActive.pending, 1, '只收 queued/running/deferred');
assert.equal(execActive.items[0].title, '提案辛');
assert.equal(execActive.items[0].state, 'queued', '状态必须原样带出，不能只给个布尔');

const execFailed = byKey(P, 'evolve-exec-failed');
assert.equal(execFailed.state, 'ok');
assert.equal(execFailed.kind, 'action', '执行失败必须人看，是会自己好不了的那一类');
assert.equal(execFailed.pending, 1);
assert.equal(execFailed.items[0].title, '提案壬');
assert.match(execFailed.items[0].error, /no target asset/, '失败原因要带出，否则人不知道该改什么');

// 2026-10-27：批准了但前置没到位的那一档，单独一行，且必须把原因和条件带出来。
const blockedQ = byKey(P, 'evolve-approved-blocked');
assert.equal(blockedQ.state, 'ok');
assert.equal(blockedQ.kind, 'supply', '阻塞中的人此刻只能等，不是能直接动手的待办');
assert.equal(blockedQ.pending, 1, '只算 status=approved 且有 blocker');
const blockedItem = blockedQ.items[0];
assert.equal(blockedItem.title, '提案己');
assert.match(blockedItem.blocker, /8-12 周/, '阻塞原因必须原样带出，不能只给个布尔');
assert.match(blockedItem.unblockCondition, /样本/, '解锁条件也要带出，否则人不知道等到什么时候');

const cur = byKey(P, 'curator-overlap');
assert.equal(cur.state, 'ok');
assert.equal(cur.pending, 1, '只有 status=proposed 待处理；acknowledged / resolved 是人已处理过的');
assert.equal(cur.items[0].title, 'a ↔ b', '标题用 skillA ↔ skillB，比裸露 id 可读');

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
// ⛔ 不调 makeStorages(v2-home)（2026-10-18 修）：本用例的 storagesDir 用的是
// 自己的 mkdtemp 目录（见上 L18 的 dir），v2-home 只是 pluginsDir 的宿主。
// 原先这里调 makeStorages(HOME) 会**重写** v2-data.test.mjs / smoke.mjs 共用的
// fixtures/v2-home/storages/*.json —— 三个测试并行跑时 writeFileSync 互相覆盖，
// 偶发读到半截文件。12 轮压测复现 1 次（v2-data.test.mjs 红、单独跑绿）。
// 判据：只写自己独占的路径。要 storages 就在 mkdtemp 里造。
const HOME = join(here, 'fixtures', 'v2-home');
const R = collectV2Data(
  { pluginsDir: join(HOME, 'profiles', 'web', 'plugins'), storagesDir: dir, repoPluginsDir: null, repoPluginsSource: 'unresolved' },
  { cache: new Map() },
);
assert.ok(R.pending, 'collectV2Data 必须暴露 payload.pending —— 面板只读这一个快照');
assert.equal(R.pending.queues.length, 9, '九条声明表全在（2026-10-23 加「已批准待执行」，2026-10-27 加「阻塞中」+「执行中」+「执行失败」）');
assert.equal(byKey(R.pending, 'curriculum-challenge').pending, 1, '经 collectV2Data 聚合后与直调一致');

console.log('v2-pending: ok');
