/**
 * 神谕层（agint-aesthetic-oracle）在家族面板里的展示口径 —— 单测。
 *
 * 判据来源全部是**生产存储的真实形状**（2026-10-22 读
 * `$DSH_HOME/storages/agint_aesthetic_oracle.json`：35 条广播、3 张卡片、
 * baseline 建于 2026-10-04 且**没有 formulaVersion 字段**）。
 *
 * 三条红线（本文件每条断言都在守其中一条）：
 *  ① 取不到 ≠ 神谕没开口。缺段与空表要能分开读，不许都渲染成「无数据」。
 *  ② Δ 只在口径可比时才算趋势。基线无 formulaVersion 时，Δ 照算但必须标不可比。
 *     ⛔ 变异自证：把 normalizeOracle 的 `!formulaVersion` 分支删掉
 *     （退回「缺标记 = 一致」），下面 ② 组立刻红 —— 那正是「拿未知当已知」。
 *  ③ 服务面优先但不排他。cards() 空（订阅未回写）时用落盘卡片补，并写明原因；
 *     服务面整体不可用时回落落盘且保留 serviceReason。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeOracle, aggOracle, readOracleFile } from '../lib/v2-data.js';
import { collectOracle } from '../lib/index.js';

// ── 生产形状夹具 ──────────────────────────────────────────────────────
const CARD = (topic, occurredAt, score, extra = {}) => ({
  topic,
  envelopeId: `${topic}-env`,
  occurredAt,
  receivedAt: occurredAt,
  payload: {
    kind: topic.split('.')[1],
    asOf: '2026-10-21T00:00:00.000Z',
    score,
    verdict: 'beautiful',
    worstKey: 'bloat',
    lines: ['第一行判词', '第二行判词'],
    text: '整段文本',
    mode: 'heuristic-degraded',
    formulaVersion: 'r3',
    ...extra,
  },
});

const BROADCAST = (ts, score, extra = {}) => ({
  id: `b-${ts}`,
  kind: 'daily',
  ts,
  asOf: '2026-10-21T00:00:00.000Z',
  score,
  verdict: 'beautiful',
  worstKey: 'bloat',
  composite: {},
  lines: 5,
  bytes: 400,
  published: true,
  auditLogged: true,
  truncated: false,
  outcome: 'ok',
  detail: 'wall 6ms',
  proposals: 0,
  ...extra,
});

/** baseline 无 formulaVersion —— 生产现状（建基于 2026-10-04，r3 于 10-09 落地）。 */
const STATE_PROD = {
  id: 'latest',
  kind: 'oracle-state',
  paused: false,
  pausedReason: '',
  pausedAt: null,
  silenceMode: { active: false, since: null, reason: '', alerted: false },
  consecutiveFailures: 0,
  baseline: {
    establishedAt: '2026-10-04T01:00:18.798Z',
    score: 75.4143,
    composites: { noise: 0.1368, confidence: 0.5633, redundancy: 0.0327, bloat: 0.7016 },
    method: 'first-week-mean',
    rebaselinedAt: null,
    sampleCounts: {},
    windowDays: null,
  },
  lastGood: { asOf: '2026-10-21T00:00:00.000Z', savedAt: '2026-10-21T01:00:38.000Z', activity: 12 },
  quota: { date: '2026-10-21', daily: 1, weekly: 1, monthly: 2, bytes: 11642, violations: 0, alerts: 0 },
  updatedAt: '2026-10-21T01:00:38.000Z',
};

const CARDS_PROD = [
  CARD('oracle.daily', '2026-10-21T01:00:38.709Z', 66.9),
  CARD('oracle.weekly', '2026-10-19T00:00:28.896Z', 62.4),
  CARD('oracle.monthly', '2026-10-05T11:08:17.243Z', 93.1, { mode: 'llm', formulaVersion: undefined }),
];
const BROADCASTS_PROD = [
  BROADCAST('2026-10-17T11:17:59.789Z', 66.3),
  BROADCAST('2026-10-19T00:00:26.968Z', 62.4, { kind: 'weekly', proposals: 3 }),
  BROADCAST('2026-10-21T01:00:38.702Z', 66.9),
];

const base = () => normalizeOracle({
  cards: CARDS_PROD,
  broadcasts: BROADCASTS_PROD,
  state: STATE_PROD,
  runtime: { enabled: true, envOff: false, memoryStore: false, metricsAvailable: true, evolutionAvailable: true, busAvailable: true },
  source: 'service',
  observedAt: '2026-10-21T09:00:00.000Z',
});

// ── ① 生产形状：三段齐 → ok，判词取 daily，历史降序 ───────────────────
{
  const o = base();
  assert.equal(o.state, 'ok');
  assert.equal(o.source, 'service');
  assert.equal(o.cards.length, 3);
  assert.equal(o.latest.topic, 'oracle.daily');
  assert.equal(o.latest.score, 66.9);
  assert.equal(o.latest.verdict, 'beautiful');
  assert.equal(o.latest.worstKey, 'bloat');
  assert.equal(o.latest.mode, 'heuristic-degraded');
  assert.equal(o.latest.lines.length, 2);
  assert.equal(o.history.length, 3);
  assert.deepEqual(o.history.map((h) => h.ts), [
    '2026-10-21T01:00:38.702Z',
    '2026-10-19T00:00:26.968Z',
    '2026-10-17T11:17:59.789Z',
  ], '广播史必须按 ts 降序（最新在上）');
  assert.equal(o.history[1].proposals, 3, 'weekly 提案数要透出');
  assert.equal(o.stateRow.baseline.score, 75.4143);
  assert.equal(o.stateRow.quota.daily, 1);
  assert.equal(o.runtime.busAvailable, true);
  assert.equal(o.observedAt, '2026-10-21T09:00:00.000Z');
}

// ── ② Δ 口径：基线无 formulaVersion → 数值照算，但一律标不可比 ────────
{
  const o = base();
  assert.equal(o.latest.delta, -8.5, '66.9 - 75.4143 四舍五入到 1 位小数');
  assert.equal(o.latest.deltaComparable, false);
  assert.match(o.latest.deltaReason, /formulaVersion/);
  assert.equal(o.historyComparable, 0, '历史行 schema 无 formulaVersion → 一行都不可比');

  // 负控：基线补上同版本口径 → 卡片可比；历史行仍不可比（它们没有该字段）
  const withFv = base();
  const state2 = { ...STATE_PROD, baseline: { ...STATE_PROD.baseline, formulaVersion: 'r3' } };
  const o2 = normalizeOracle({ cards: CARDS_PROD, broadcasts: BROADCASTS_PROD, state: state2, source: 'service' });
  assert.equal(o2.latest.deltaComparable, true, '基线口径 = r3 且本轮 r3 → 可比');
  assert.equal(o2.latest.deltaReason, null);
  /* 这一条专门守「缺席 ≠ 一致」：基线有口径了，但广播行 schema 里没有
     formulaVersion 字段 —— 缺标记必须判不可比。
     红绿已实测（2026-10-22）：normalizeOracle 里有两道防线（`!formulaVersion`
     早返回 + `formulaVersion !== baseFormula` 宽比较），**撤其中任一道仍绿**
     （另一道兜住）；两道全撤（即退回「缺标记 = 同版本」）本行立刻红，
     actual 3 / expected 0。 */
  assert.equal(o2.historyComparable, 0, '历史行无 formulaVersion → 即使基线有口径也不可比');
  assert.ok(o2.history.every((r) => r.deltaComparable === false));
  assert.equal(withFv.latest.deltaComparable, false, '基线没口径时不得升格为可比');

  // 历史行补上 formulaVersion（未来形状）→ 该行可比
  const o3 = normalizeOracle({
    cards: CARDS_PROD,
    broadcasts: [BROADCAST('2026-10-21T01:00:38.702Z', 66.9, { formulaVersion: 'r3' })],
    state: state2,
  });
  assert.equal(o3.historyComparable, 1);
  assert.equal(o3.history[0].deltaComparable, true);

  // 版本不同 → 不可比（跨版本不能当趋势）
  const o4 = normalizeOracle({
    cards: CARDS_PROD,
    broadcasts: [BROADCAST('2026-10-21T01:00:38.702Z', 66.9, { formulaVersion: 'r2' })],
    state: state2,
  });
  assert.equal(o4.history[0].deltaComparable, false);
  assert.match(o4.history[0].deltaReason, /r2/);
}

// ── ③ 同 topic 多卡取最新；卡缺 daily 时判词退到 weekly ───────────────
{
  const o = normalizeOracle({
    cards: [
      CARD('oracle.daily', '2026-10-20T01:00:00.000Z', 60.1),
      CARD('oracle.daily', '2026-10-21T01:00:00.000Z', 66.9),
      CARD('oracle.weekly', '2026-10-19T00:00:00.000Z', 62.4),
    ],
    state: STATE_PROD,
  });
  assert.equal(o.cards.length, 2, '同 topic 只留一张');
  assert.equal(o.latest.occurredAt, '2026-10-21T01:00:00.000Z');
  assert.equal(o.latest.score, 66.9);

  const onlyWeekly = normalizeOracle({ cards: [CARD('oracle.weekly', '2026-10-19T00:00:00.000Z', 62.4)], state: STATE_PROD });
  assert.equal(onlyWeekly.latest.topic, 'oracle.weekly', '无 daily 时判词退到 weekly，不显示「无判词」');
}

// ── ④ 缺段不装绿：三段全缺 → unavailable 且带原因 ────────────────────
{
  const o = normalizeOracle({});
  assert.equal(o.state, 'unavailable');
  assert.equal(o.latest, null);
  assert.deepEqual(o.history, []);
  assert.equal(o.stateRow, null);
  assert.ok(o.reason && o.reason.length > 0, '不可用必须带原因，不能只给一个空壳');

  // 只有状态行、无卡片 → 仍是 ok（状态面是真实产出），但 latest 为 null
  const onlyState = normalizeOracle({ state: STATE_PROD });
  assert.equal(onlyState.state, 'ok');
  assert.equal(onlyState.latest, null);
  assert.equal(onlyState.stateRow.baseline.score, 75.4143);
}

// ── ⑤ 落盘口径：文件在 / 不在 / 坏 JSON 三种形态 ─────────────────────
const storages = mkdtempSync(join(tmpdir(), 'panel-oracle-'));
const writeDomain = (target, tables) => {
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'agint_aesthetic_oracle.json'), JSON.stringify({ unit: 'u', global: {}, tables }));
};

writeDomain(storages, {
  oracle_state: { latest: STATE_PROD },
  oracle_broadcasts: Object.fromEntries(BROADCASTS_PROD.map((r) => [r.id, r])),
  oracle_cards: Object.fromEntries(CARDS_PROD.map((c) => [c.topic, c])),
});
{
  const raw = readOracleFile(storages);
  assert.equal(raw.ok, true);
  assert.equal(raw.cards.length, 3);
  assert.equal(raw.broadcasts.length, 3);

  const o = aggOracle(storages);
  assert.equal(o.state, 'ok');
  assert.equal(o.source, 'storages');
  assert.equal(o.latest.score, 66.9);
  assert.equal(o.runtime, null, '落盘口径没有运行态开关，不许伪造');
}

{
  const empty = mkdtempSync(join(tmpdir(), 'panel-oracle-empty-'));
  const o = aggOracle(empty);
  assert.equal(o.state, 'unavailable');
  assert.match(o.reason, /不存在/);
  assert.equal(o.latest, undefined, '文件不在时不给 latest，前端据此显示「未取到」');
}

{
  const broken = mkdtempSync(join(tmpdir(), 'panel-oracle-broken-'));
  writeFileSync(join(broken, 'agint_aesthetic_oracle.json'), '{ not json');
  const o = aggOracle(broken);
  assert.equal(o.state, 'error');
  assert.match(o.reason, /解析失败/);
}

// ── ⑥ collectOracle：服务面优先 / 卡片回落落盘 / 服务面挂掉 ──────────
const svcFull = {
  cards: async () => CARDS_PROD,
  history: async () => BROADCASTS_PROD,
  getState: async () => STATE_PROD,
  status: () => ({ enabled: true, envOff: false, memoryStore: false, metricsAvailable: true, evolutionAvailable: true, busAvailable: true }),
};
{
  const o = await collectOracle({ get: () => svcFull }, storages);
  assert.equal(o.state, 'ok');
  assert.equal(o.source, 'service');
  assert.equal(o.serviceAvailable, true);
  assert.deepEqual(o.notes, [], '三段全来自服务面时不该有补齐说明');
  assert.equal(o.history.length, 3);
}

{
  // 订阅没回写：cards() 空，但落盘有卡 → 用落盘的卡，并写明为什么
  const svcNoCards = { ...svcFull, cards: async () => [] };
  const o = await collectOracle({ get: () => svcNoCards }, storages);
  assert.equal(o.state, 'ok');
  assert.equal(o.cards.length, 3, '服务面空卡片时用落盘补齐');
  assert.equal(o.latest.score, 66.9);
  assert.equal(o.source, 'service+storages');
  assert.ok(o.notes.some((n) => /卡片取自落盘/.test(n)), '补齐原因必须落进 notes，不许静默补');
}

{
  // 服务面整体不可用 → 全部回落落盘，serviceReason 保留
  const o = await collectOracle({ get: () => { throw new Error('cannot get property aestheticOracle without inject'); } }, storages);
  assert.equal(o.state, 'ok', '服务面挂掉不等于神谕没开口：落盘有数就照常显示');
  assert.equal(o.source, 'storages');
  assert.equal(o.serviceAvailable, false);
  assert.match(o.serviceReason, /服务未注入/);
  assert.equal(o.runtime, null);
  assert.ok(o.notes.some((n) => /落盘/.test(n)));
}

{
  // 服务未挂载（ctx.get 返回 null）→ 明确写「未挂载」
  const o = await collectOracle({ get: () => null }, storages);
  assert.equal(o.serviceAvailable, false);
  assert.match(o.serviceReason, /未挂载/);
  assert.equal(o.latest.score, 66.9);
}

{
  // 服务面无出口（旧版 oracle）→ 每段各记一条，回落落盘
  const o = await collectOracle({ get: () => ({ status: () => ({ enabled: true }) }) }, storages);
  assert.equal(o.serviceAvailable, true);
  assert.equal(o.source, 'storages', '没有出口时卡片/历史/状态全来自落盘');
  assert.ok(o.notes.some((n) => /cards\(\)/.test(n)));
  assert.equal(o.runtime.metricsAvailable, false);
}

{
  // 服务面与落盘都空 → unavailable，且两条原因都在
  const empty = mkdtempSync(join(tmpdir(), 'panel-oracle-none-'));
  const o = await collectOracle({ get: () => null }, empty);
  assert.equal(o.state, 'unavailable');
  assert.equal(o.serviceAvailable, false);
  assert.ok(o.notes.length >= 2, '服务面与落盘各自的原因都要留下');
}

console.log('v2-oracle: all assertions passed');
