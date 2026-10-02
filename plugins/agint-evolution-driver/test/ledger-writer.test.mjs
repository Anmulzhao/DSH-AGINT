/**
 * ledger-writer 单测（Phase 1 交付物 3 §4.3.4 / Sprint 22 #10）。
 *
 * 分层（继承教训 §3.6）：这里只证**单元层**——纯函数的字段口径 + 写入器的
 * 失败形状。真实入链（宿主存储 + hash 链）由 test/smoke.mjs 的 T25/T25c
 * 与 agint-evolution-memory 侧的 ledger-service 测试分别覆盖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLedgerEntry, createLedgerWriter } from '../lib/ledger-writer.js';

const TS = '2026-10-03T01:02:03.456Z';

const proposal = { id: 'p-1', kind: 'PROMPT_MUTATION', payload: { promptId: 'agint-demo' } };
const variant = {
  variant_id: 'v-1',
  generation: 3,
  expected_effect: { metric: 'SUCCESS_RATE', direction: 'increase', window: '7d' },
};
const outcome = {
  decision: 'AUTO_DEPLOY',
  path: 'plugins/agint-demo/lib/index.js',
  preimagePath: '.agint-preimage/agint-demo.bak',
  bytesBefore: 100,
  bytesAfter: 120,
  verifyMode: 'syntax:.js',
  sandboxOk: true,
  reverted: false,
  reason: 'score-85',
  eventIds: ['env-2'],
  timestamp: TS,
};

function ok(input = {}) {
  const built = buildLedgerEntry({ proposal, variant, outcome, ...input });
  assert.equal(built.ok, true, JSON.stringify(built));
  return built.entry;
}

// ── 字段口径 ────────────────────────────────────────────────────────────

test('正常入链：七个必填字段全部来自真实证据', () => {
  const e = ok();
  assert.equal(e.contractId, 'p-1', 'contractId = proposal.id（幂等键）');
  assert.equal(e.generation, 'GEN-003', 'variant.generation 补零成 GEN-###');
  assert.equal(e.summary.mutationType, 'PROMPT_MUTATION');
  assert.deepEqual(e.summary.changedPlugins, ['agint-demo'], '从 plugins/<name>/ 取插件名');
  assert.equal(e.summary.targetMetric, 'SUCCESS_RATE');
  assert.equal(e.summary.decision, 'AUTO_DEPLOY');
  assert.equal(e.timestamp, TS);
  assert.ok(e.summary.hypothesisDigest.length > 0, 'hypothesisDigest 非空（schema min(1)）');
});

test('⛔ 无证据字段一律 null，不填"看起来对"的值', () => {
  const e = ok();
  for (const k of ['predictedDelta', 'actualDelta', 'predictionQuality', 'predictionSource']) {
    assert.equal(e.summary[k], null, `summary.${k} 必须 null`);
  }
  // contractHash/lockEventId 等 Contract 与锁未接入；gitCommit 要等人真提交
  for (const k of ['contractHash', 'lockEventId', 'mountTicketId', 'abTestId', 'gitCommit']) {
    assert.equal(e.references[k], null, `references.${k} 必须 null`);
  }
  // 有证据的两个必须带上
  assert.equal(e.references.populationCandidateId, 'v-1');
  assert.equal(e.references.preimagePath, '.agint-preimage/agint-demo.bak');
});

test('实时条目不带 reconstructed / evidenceCompleteness ⇒ 由 schema 默认 false/null', () => {
  const e = ok();
  assert.equal('reconstructed' in e, false);
  assert.equal('evidenceCompleteness' in e, false);
});

test('generation 非整数 ⇒ GEN-UNKNOWN（不猜代际）', () => {
  for (const g of [undefined, null, '2', 1.5, NaN]) {
    const e = ok({ variant: { ...variant, generation: g } });
    assert.equal(e.generation, 'GEN-UNKNOWN', `generation=${String(g)}`);
  }
  assert.equal(ok({ variant: { ...variant, generation: 0 } }).generation, 'GEN-000',
    '0 是合法代际，不能被 || 兜底吃掉');
});

test('路径不在 plugins/ 下 ⇒ changedPlugins 为空数组（不硬凑归属）', () => {
  assert.deepEqual(ok({ outcome: { ...outcome, path: 'lib/service.js' } }).summary.changedPlugins, []);
  assert.deepEqual(ok({ outcome: { ...outcome, path: 'presets/agint/skills/demo/SKILL.md' } })
    .summary.changedPlugins, [], '改的是 preset 内容 ⇒ 不是插件代码');
  assert.deepEqual(ok({ outcome: { ...outcome, path: 'plugins\\agint-demo\\lib\\x.js' } })
    .summary.changedPlugins, ['agint-demo'], '反斜杠要先归一（Windows 真实形态）');
});

test('生产实况：metric="unspecified" 照原样入链，不当缺证据拒写', () => {
  // population 的 ingest 缺省就是 { metric: 'unspecified' }（2026-10-03 生产副本实测 7/7 行）。
  // 条目要证的是"系统当时确实没定指标"；替它编一个指标才是造假。
  const e = ok({ variant: { ...variant, expected_effect: { metric: 'unspecified' } } });
  assert.equal(e.summary.targetMetric, 'unspecified');
});

test('eventBusIds：过滤非串、去重、排序（哈希入参必须确定）', () => {
  const e = ok({ outcome: { ...outcome, eventIds: ['env-9', 'env-2', 'env-9', null, undefined, ''] } });
  assert.deepEqual(e.references.eventBusIds, ['env-2', 'env-9']);
  assert.deepEqual(ok({ outcome: { ...outcome, eventIds: undefined } }).references.eventBusIds, []);
});

// ── 摘要：确定性 + 事实 ─────────────────────────────────────────────────

test('摘要确定性：同一决策两次构造必须逐字节相同', () => {
  assert.equal(ok().summary.hypothesisDigest, ok().summary.hypothesisDigest);
});

test('摘要含定位片段（target/path/bytes/expected/verify/reason）', () => {
  const d = ok().summary.hypothesisDigest;
  for (const frag of ['PROMPT_MUTATION', 'target=agint-demo', 'path=plugins/agint-demo/lib/index.js',
    'bytes 100->120', 'expected SUCCESS_RATE increase within 7d', 'verify=syntax:.js', 'reason=score-85']) {
    assert.ok(d.includes(frag), `摘要缺片段 ${frag}：${d}`);
  }
});

test('REJECT + 回滚失败必须固化在摘要里（否则链上只剩一个干净的 decision 在骗人）', () => {
  const rejected = ok({ outcome: { ...outcome, decision: 'REJECT', reverted: true } });
  assert.match(rejected.summary.hypothesisDigest, /exec=reverted/);
  const stuck = ok({ outcome: { ...outcome, decision: 'ABSTAIN', reverted: false } });
  assert.match(stuck.summary.hypothesisDigest, /exec=NOT-reverted/);
  assert.equal(stuck.summary.decision, 'ABSTAIN',
    'ABSTAIN 与 REJECT 走同一条入链分支（index.js 的 `REJECT || ABSTAIN`）—— 被拒/弃权同样进链');
  const deployed = ok();
  assert.equal(deployed.summary.hypothesisDigest.includes('exec='), false,
    'AUTO_DEPLOY 不该出现回滚片段');
});

test('摘要长度封顶 200（超长路径/reason 不得把条目撑爆）', () => {
  const e = ok({
    outcome: {
      ...outcome,
      path: `plugins/${'a'.repeat(150)}/` + 'b'.repeat(120) + '.js',
      reason: 'x'.repeat(300),
    },
  });
  assert.ok(e.summary.hypothesisDigest.length <= 200, `长度 ${e.summary.hypothesisDigest.length}`);
  assert.ok(e.summary.hypothesisDigest.endsWith('…'), '截断必须以省略号结尾，明示"这是截断不是全文"');
});

// ── 拒写：缺证据就不写，且说清缺哪个 ───────────────────────────────────

test('四类缺证据各自返回自己的 blocker', () => {
  const cases = [
    [{ proposal: { kind: 'PROMPT_MUTATION' } }, 'NO_PROPOSAL_ID'],
    [{ proposal: { id: 'p-1' } }, 'MUTATION_TYPE_UNEVIDENCED'],
    [{ variant: null }, 'NO_VARIANT_ROW'],
    [{ variant: { ...variant, expected_effect: undefined } }, 'TARGET_METRIC_UNEVIDENCED'],
    [{ variant: { ...variant, expected_effect: { metric: '' } } }, 'TARGET_METRIC_UNEVIDENCED'],
    [{ outcome: { ...outcome, decision: undefined } }, 'DECISION_UNEVIDENCED'],
    [{ outcome: { ...outcome, timestamp: '' } }, 'TIMESTAMP_UNEVIDENCED'],
  ];
  for (const [patch, blocker] of cases) {
    const built = buildLedgerEntry({ proposal, variant, outcome, ...patch });
    assert.equal(built.ok, false, `${blocker} 应当拒写`);
    assert.equal(built.blocker, blocker, `期望 ${blocker}，实际 ${JSON.stringify(built)}`);
    assert.ok(typeof built.reason === 'string' && built.reason.length > 0, '拒写必须给原因');
  }
});

// ── 写入器 ──────────────────────────────────────────────────────────────

/** append 的真实契约（lib/ledger.js:262）：{ entry, idempotent }。 */
function mockEvolution({ throws = null, before = [] } = {}) {
  const appended = [...before];
  return {
    appended,
    ledger: {
      append: async (entry) => {
        if (throws) throw new Error(throws);
        const hit = appended.find((e) => e.contractId === entry.contractId);
        if (hit) return { entry: hit, idempotent: true };
        const stored = { ...entry, seq: appended.length + 1 };
        appended.push(stored);
        return { entry: stored, idempotent: false };
      },
    },
  };
}

function recorder() {
  const warns = [];
  return { warns, warn: (msg, extra) => warns.push({ msg, extra }) };
}

test('写入器成功：返回 APPENDED + seq', async () => {
  const ev = mockEvolution();
  const { warn, warns } = recorder();
  const w = createLedgerWriter({ get: () => ev }, { warn, now: () => TS });
  const r = await w.writeDecision({ proposal, variant, outcome: { ...outcome, timestamp: undefined } });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'APPENDED');
  assert.equal(r.seq, 1);
  assert.equal(warns.length, 0, '成功不该留 warn');
  assert.equal(ev.appended[0].timestamp, TS, 'timestamp 缺省由注入的 now() 补');
});

test('写入器不缓存依赖：apply 顺序里 evolution 后到也要能写', async () => {
  const { warn } = recorder();
  let ev = null;
  const w = createLedgerWriter({ get: (name) => (name === 'agint.evolution' ? ev : null) }, { warn, now: () => TS });
  const early = await w.writeDecision({ proposal, variant, outcome });
  assert.equal(early.ok, false, '服务还没挂载 ⇒ 必须如实失败');
  assert.equal(early.status, 'LEDGER_UNAVAILABLE');
  ev = mockEvolution();
  const late = await w.writeDecision({ proposal, variant, outcome });
  assert.equal(late.status, 'APPENDED', '下一次调用就要能接上新挂载的服务（软依赖纪律）');
});

test('幂等重放：同 contractId 第二次返回既有 seq 且状态可见', async () => {
  const ev = mockEvolution();
  const { warn, warns } = recorder();
  const w = createLedgerWriter({ get: () => ev }, { warn, now: () => TS });
  await w.writeDecision({ proposal, variant, outcome });
  const again = await w.writeDecision({ proposal, variant, outcome });
  assert.equal(again.ok, true);
  assert.equal(again.status, 'IDEMPOTENT');
  assert.equal(again.seq, 1);
  assert.equal(ev.appended.length, 1, '重放不得新增条目（纪律 5）');
  assert.match(warns.at(-1).msg, /幂等/, '幂等命中也要留痕');
});

test('append 抛错：返回 APPEND_FAILED + warn，且永不抛出（纪律 3 可见但不崩主流程）', async () => {
  const ev = mockEvolution({ throws: 'LEDGER_CAS_CONFLICT: 前驱摘要已变化' });
  const { warn, warns } = recorder();
  const w = createLedgerWriter({ get: () => ev }, { warn, now: () => TS });
  const r = await w.writeDecision({ proposal, variant, outcome });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'APPEND_FAILED');
  assert.match(r.error, /CAS_CONFLICT/);
  assert.equal(warns.length, 1, '失败必须 warn 一次');
  assert.match(warns[0].msg, /追加失败/);
});

test('缺证据时不碰写入通道（拒写发生在 append 之前）', async () => {
  let touched = 0;
  const ev = { ledger: { append: async () => { touched += 1; return { entry: {}, idempotent: false }; } } };
  const { warn, warns } = recorder();
  const w = createLedgerWriter({ get: () => ev }, { warn, now: () => TS });
  const r = await w.writeDecision({ proposal, variant: null, outcome });
  assert.equal(r.status, 'NO_VARIANT_ROW');
  assert.equal(touched, 0, '证据不全的条目绝不进链');
  assert.equal(warns.length, 1, '拒写也要留痕');
  assert.match(warns[0].msg, /拒写/);
});

test('ctx 没有 get（单测裸对象）⇒ LEDGER_UNAVAILABLE 而不是 TypeError', async () => {
  const { warn } = recorder();
  const w = createLedgerWriter({}, { warn, now: () => TS });
  const r = await w.writeDecision({ proposal, variant, outcome });
  assert.equal(r.status, 'LEDGER_UNAVAILABLE');
});

test('evolution 可显式注入（测试/多实例场景），优先于 ctx.get', async () => {
  const injected = mockEvolution();
  const globalEv = mockEvolution();
  const { warn } = recorder();
  const w = createLedgerWriter({ get: () => globalEv }, { warn, now: () => TS });
  await w.writeDecision({ proposal, variant, outcome, evolution: injected });
  assert.equal(injected.appended.length, 1);
  assert.equal(globalEv.appended.length, 0);
});
