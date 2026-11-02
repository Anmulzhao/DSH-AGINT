/**
 * 工单状态机测试（2026-11-01，agint-evolve v0.16.0）。
 *
 * 这一组钉的是**行为承诺**，不是实现细节：
 *
 *   ① 每一条可能的现场都能唯一落到一档 stage，且档位名字在 TICKET_STAGES 里；
 *   ② blocker 优先于任何 execState（a85ef850：卡在前置却被写成「待入队」）；
 *   ③ `partial` 落到 person/review，不是 working、也不是 closed（846f4fbb）；
 *   ④ 「批准了、计划就绪、队列里却没有」必须报 stalled —— 这是 AGINT 独有的缺陷档，
 *      superagent 那边同样的现场叫 idle（健康静息态）。照抄会把缺陷伪装成正常；
 *   ⑤ 判据**不读时钟、不碰存储**：同一个行喂两次、冻结后再喂，结果必须逐字相同；
 *   ⑥ 九档全部可达（有档位没用例 = 有分支没人走过 = 下次改动随便就能改坏）；
 *   ⑦ 九档标签互不相同（两档同一句话，人还是分不出来，等于没分）。
 *
 * 运行：node --test test/stage.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketStage, TICKET_STAGES, STAGE_SIDES, STAGE_LABELS } from '../lib/execution.js';

/** 一条最小可用的提案行；各用例只覆盖自己关心的字段。 */
const rec = (patch = {}) => ({ id: 'p1', title: 't', body: 'b', status: 'approved', ...patch });

/** 覆盖全部现场的表：name → [输入, 期望 stage]。 */
const CASES = [
  // ── 不在执行链路上的两档 ──────────────────────────────────────────
  ['proposed ⇒ 待批准', { status: 'proposed' }, 'draft'],
  ['applied ⇒ 已结束', { status: 'applied', execState: 'succeeded' }, 'closed'],
  ['rejected ⇒ 已结束', { status: 'rejected' }, 'closed'],
  ['wontfix ⇒ 已结束', { status: 'wontfix' }, 'closed'],

  // ── 等人 ────────────────────────────────────────────────────────
  ['blocker ⇒ 阻塞（a85ef850 现场）', { execMode: 'immediate', execState: 'idle', blocker: '样本未标注' }, 'person/blocked'],
  ['blocker 优先于 failed', { execMode: 'immediate', execState: 'failed', blocker: '前置没到' }, 'person/blocked'],
  ['blocker 优先于 running', { execMode: 'immediate', execState: 'running', blocker: '前置没到' }, 'person/blocked'],
  ['空白 blocker 不算阻塞', { execMode: 'immediate', execState: 'idle', blocker: '   ' }, 'stalled'],
  ['failed ⇒ 执行失败', { execMode: 'immediate', execState: 'failed', execError: 'driver 抛错：timeout' }, 'person/failed'],
  ['partial ⇒ 部分落地（846f4fbb 现场）', { execMode: 'immediate', execState: 'partial', execError: '部分落地（1/3 个原子单元）' }, 'person/review'],
  ['manual ⇒ 待定执行计划', { execMode: 'manual', execState: 'idle' }, 'person/plan'],
  ['scheduled 缺时刻 ⇒ 待定执行计划', { execMode: 'scheduled', execAt: '', execState: 'idle' }, 'person/plan'],
  ['scheduled 时刻非法 ⇒ 待定执行计划', { execMode: 'scheduled', execAt: '明天下午', execState: 'idle' }, 'person/plan'],

  // ── 等机器 ──────────────────────────────────────────────────────
  ['queued ⇒ 排队中', { execMode: 'immediate', execState: 'queued' }, 'working/queued'],
  ['queued + 定时时刻 ⇒ 排队中', { execMode: 'scheduled', execAt: '2026-11-03T09:00:00.000Z', execState: 'queued' }, 'working/queued'],
  ['deferred ⇒ 排队中（顺延也是等机器）', { execMode: 'immediate', execState: 'deferred', execError: '本周已达上限（5/5）' }, 'working/queued'],
  ['running ⇒ 执行中', { execMode: 'immediate', execState: 'running' }, 'working'],

  // ── 缺陷档：批准了、计划就绪、队列里却没有 ────────────────────────
  ['idle 且计划就绪 ⇒ stalled', { execMode: 'immediate', execState: 'idle' }, 'stalled'],
  ['cancelled 且计划就绪 ⇒ stalled', { execMode: 'immediate', execState: 'cancelled' }, 'stalled'],
  ['succeeded 但仍是 approved（残局）⇒ stalled', { execMode: 'immediate', execState: 'succeeded' }, 'stalled'],

  // ── 历史行（加字段之前写入，字段全缺）────────────────────────────
  ['历史行 proposed（无任何执行字段）', { status: 'proposed' }, 'draft'],
  ['历史行 approved（execMode 缺省=manual）', { status: 'approved' }, 'person/plan'],
];

test('现场 → stage：逐条命中，且档位名合法', () => {
  for (const [name, input, want] of CASES) {
    const got = ticketStage(rec(input));
    assert.equal(got.stage, want, `${name}：期望 ${want}，实际 ${got.stage}`);
    assert.ok(TICKET_STAGES.includes(got.stage), `${name}：${got.stage} 不在 TICKET_STAGES 里`);
  }
});

test('side / label / stalled 三者与 stage 表一致', () => {
  for (const [name, input] of CASES) {
    const s = ticketStage(rec(input));
    assert.equal(s.side, STAGE_SIDES[s.stage], `${name}：side 与表不符`);
    assert.equal(s.label, STAGE_LABELS[s.stage], `${name}：label 与表不符`);
    assert.equal(s.stalled, s.stage === 'stalled', `${name}：stalled 只有 stalled 档才成立`);
    assert.ok(typeof s.why === 'string' && s.why.length > 0, `${name}：why 不能为空 —— 标签说不清的要有句话`);
  }
});

test('九档全部可达（没有分支没人走过）', () => {
  const seen = new Set(CASES.map(([, input]) => ticketStage(rec(input)).stage));
  const missing = TICKET_STAGES.filter((s) => !seen.has(s));
  assert.deepEqual(missing, [], `这些档位没有任何用例覆盖：${missing.join(', ')}`);
});

test('九档标签互不相同（两档同一句话等于没分）', () => {
  const labels = TICKET_STAGES.map((s) => STAGE_LABELS[s]);
  assert.equal(new Set(labels).size, labels.length, `标签有重复：${labels.join(' / ')}`);
});

test('判据不读时钟、不改入参（冻结后连喂两次，逐字相同）', () => {
  for (const [name, input] of CASES) {
    const frozen = Object.freeze(rec(input));
    const a = ticketStage(frozen);
    const b = ticketStage(frozen);
    assert.deepEqual(a, b, `${name}：两次调用结果不同 ⇒ 判据里有隐藏状态或时钟`);
  }
  // ⛔ 深冻结：真改了嵌套字段这里会抛 TypeError，比事后比对更早暴露。
  const deep = Object.freeze({ ...rec({ execMode: 'immediate', execState: 'partial' }) });
  assert.doesNotThrow(() => ticketStage(deep), 'ticketStage 不许写入参');
});

test('stage 名带斜杠的只有 person/* 与 working/*（面板按前缀分栏）', () => {
  for (const s of TICKET_STAGES) {
    const [head, tail] = s.split('/');
    if (tail === undefined) continue;
    assert.ok(['person', 'working'].includes(head), `${s}：斜杠前缀只能是 person 或 working`);
  }
});
