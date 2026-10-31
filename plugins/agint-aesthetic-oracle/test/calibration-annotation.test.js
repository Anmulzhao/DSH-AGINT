/**
 * agint-aesthetic-oracle 人工标注入口回归（提案 a6e6e1d9 第一步，2026-10-27）。
 *
 * 事故：`calibrationSamples()` 把 `humanVerdict` **硬编码成 null**，且
 * `oracleBroadcasts` 表根本没有这一列 —— 老板口头标了「这周是 confidence」，
 * 服务端无处可存，下次调用照样全 null。采集面只有出口、没有入口 ⇒
 * 「等 8-12 周样本」永远等不到，标定提案在数学上无法收敛。
 * 这与 createdAt 被 zod strip 掉是同一类事故（2026-10-27 已踩过一次）：
 * **schema 不声明的字段，存储层 open 时会静默丢掉**。
 *
 * 这一组用例钉的是行为承诺：
 *   ① 标注能落库，并在下一次 calibrationSamples() 里读出来（不再是硬编码 null）
 *   ② 标注进度按列分别计数（humanVerdict / humanOverall 是两列、两个目标）
 *   ③ ts 前缀多义时**报错并列出候选**，不猜要标哪一条
 *   ④ 非法枚举值直接拒绝（不静默存成自由文本）
 *   ⑤ null = 明确清空；undefined = 冻结不动（与 setStatus 的 blocker 同族语义）
 *   ⑥ 服务面暴露 formulaVersion（供 evolve 的提案台账写「成立条件」）
 *
 * 跑法：node --test test/calibration-annotation.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { FORMULA_VERSION } from '../lib/scoring.js';

const DUP = { kind: 'duplicate-pattern', ruleId: 'rule-a', with: 'rule-b' };
const FIXTURE_ASOF = new Date(2026, 8, 27, 4, 0, 0).toISOString();

const fixtureSummary = () => ({
  asOf: FIXTURE_ASOF,
  count: 7,
  metrics: [
    { key: 'wiki.orphans', value: 13, meta: JSON.stringify({ files: [], total: 18 }) },
    { key: 'wiki.contradictions', value: 1, meta: JSON.stringify({ files: [] }) },
    { key: 'rules.lintIssues', value: 3, meta: JSON.stringify({ issues: [DUP, DUP, DUP], rulesTotal: 26 }) },
    {
      key: 'memory.total', value: 336,
      meta: JSON.stringify({
        noEvidence: { count: 71, ids: Array.from({ length: 71 }, (_, i) => `mem-${i}`), capped: true },
        avgConfXCompliance: 0.544,
      }),
    },
    { key: 'skills.totalBytes', value: 82652, meta: JSON.stringify({ fileCount: 11, roots: ['/x'] }) },
    { key: 'evolution.logCount7d', value: 5, meta: JSON.stringify({ excludedOracle: 0 }) },
    { key: 'evolution.logCount30d', value: 173, meta: JSON.stringify({ excludedOracle: 0 }) },
  ],
});

/** 假 LLM：回显模板文本，保证广播走 mode=llm 且写 ok 行。 */
function fakeLlmStructured(schema, promptText) {
  const required = schema?.required ?? [];
  if (required.includes('advice')) {
    const advice = /机械建议：([\s\S]*?)\n证据：/.exec(promptText)?.[1]?.trim() ?? 'LLM 建议';
    const evidence = /证据：([\s\S]*?)\n\n/.exec(promptText)?.[1]?.trim() ?? 'LLM 证据';
    return { advice, evidence };
  }
  if (required.includes('narrative')) return { narrative: 'LLM 行级深挖', pattern: 'llm-pattern' };
  if (required.includes('body')) {
    const body = /模板 body：\n([\s\S]*?)\n(?:行级深挖：|问题模式：|请润色)/.exec(promptText)?.[1]?.trim()
      ?? 'LLM 提案正文';
    return { body };
  }
  return {};
}

function fakeLlmServices() {
  const calls = [];
  return {
    agents: { create: async () => ({ agent: { id: `parent-${calls.length + 1}` }, dispose: async () => {} }) },
    subagents: {
      getProvider: () => ({ name: 'spawn' }),
      startActivation: async (spec) => {
        calls.push(spec);
        const promptText = spec.request.prompt.map((b) => b?.text ?? '').join('\n');
        return {
          childId: `child-${calls.length}`,
          result: Promise.resolve({
            stopReason: 'completed',
            structured: fakeLlmStructured(spec.request.outputSchema, promptText),
          }),
          dispose: async () => {},
        };
      },
    },
  };
}

function makeEnv({ config = {} } = {}) {
  const llm = fakeLlmServices();
  const services = {
    'agint.metrics': { summary: async () => fixtureSummary() },
    'agint.evolution': { logPhase4: async (e) => ({ ...e }) },
    'agint.eventBus.publish': async () => true,
    agents: llm.agents,
    subagents: llm.subagents,
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test', reasoningEffort: 'high' }) },
  };
  const provided = {};
  const effects = [];
  const ctx = {
    get: (k) => services[k],
    provide: (k, v) => { provided[k] = v; },
    effect: (fn) => effects.push(fn),
  };
  apply(ctx, config);
  const svc = provided['agint.aestheticOracle'];
  return {
    svc,
    dispose: () => { for (const f of effects) { try { f(); } catch { /* ignore */ } } },
  };
}

const at = (dayOffset, hour = 9) => new Date(2026, 9, 20 + dayOffset, hour, 0, 0);

test('① 标注能落库，并在 calibrationSamples() 里读出来（不再硬编码 null）', async () => {
  const env = makeEnv();
  try {
    const out = await env.svc.runBroadcast('daily', { now: at(0) });
    assert.equal(out.ok, true, '前置：广播必须写 ok 行');

    const before = await env.svc.calibrationSamples();
    assert.equal(before.samples.length, 1);
    assert.equal(before.samples[0].humanVerdict, null, '未标注 ⇒ null（不是猜测值）');
    assert.equal(before.counts.annotatedVerdict, 0);

    const written = await env.svc.annotateCalibration({
      id: before.samples[0].id,
      humanVerdict: 'confidence',
      humanOverall: 'worse',
      note: '这周在补证据，最丑是确信度',
    });
    assert.equal(written.humanVerdict, 'confidence');
    assert.equal(written.humanOverall, 'worse');
    assert.equal(written.counts.annotatedVerdict, 1);

    const after = await env.svc.calibrationSamples();
    assert.equal(after.samples[0].humanVerdict, 'confidence', '标注必须能被下一次采集读到');
    assert.equal(after.samples[0].humanOverall, 'worse');
    assert.equal(after.samples[0].humanNote, '这周在补证据，最丑是确信度');
    assert.notEqual(after.samples[0].annotatedAt, '');
    assert.equal(after.counts.annotatedVerdict, 1);
    assert.equal(after.counts.annotatedOverall, 1);
    assert.equal(after.counts.total, 1);
  } finally { env.dispose(); }
});

test('② 两列分别计数（阈值目标与权重目标不混为一谈）', async () => {
  const env = makeEnv();
  try {
    await env.svc.runBroadcast('daily', { now: at(0) });
    await env.svc.runBroadcast('daily', { now: at(1) });
    const { samples } = await env.svc.calibrationSamples();
    assert.equal(samples.length, 2);

    await env.svc.annotateCalibration({ id: samples[0].id, humanVerdict: 'noise' });
    await env.svc.annotateCalibration({ id: samples[1].id, humanOverall: 'better' });
    const got = await env.svc.calibrationSamples();
    assert.equal(got.counts.annotatedVerdict, 1, '只标了 humanVerdict 的算 1 条');
    assert.equal(got.counts.annotatedOverall, 1, '只标了 humanOverall 的算 1 条');
    assert.equal(got.samples[1].humanVerdict, null, '另一列没标仍是 null，不许连带填');
  } finally { env.dispose(); }
});

test('③ ts 前缀多义 ⇒ 报错并列出候选，不猜', async () => {
  const env = makeEnv();
  try {
    await env.svc.runBroadcast('daily', { now: at(0, 9) });
    await env.svc.runBroadcast('daily', { now: at(0, 15) });
    const { samples } = await env.svc.calibrationSamples();
    const datePrefix = samples[0].ts.slice(0, 10);
    assert.equal(samples.filter((s) => s.ts.startsWith(datePrefix)).length, 2);

    await assert.rejects(
      () => env.svc.annotateCalibration({ ts: datePrefix, humanVerdict: 'noise' }),
      /命中 2 条/,
      '同一天两条广播 ⇒ 前缀多义必须拒绝，不能默认标第一条',
    );
    // 给完整 ts 就能标
    const one = await env.svc.annotateCalibration({ ts: samples[0].ts, humanVerdict: 'noise' });
    assert.equal(one.humanVerdict, 'noise');
  } finally { env.dispose(); }
});

test('④ 非法枚举值直接拒绝', async () => {
  const env = makeEnv();
  try {
    await env.svc.runBroadcast('daily', { now: at(0) });
    const { samples } = await env.svc.calibrationSamples();
    await assert.rejects(
      () => env.svc.annotateCalibration({ id: samples[0].id, humanVerdict: 'ugly' }),
      /只能取/,
    );
    await assert.rejects(
      () => env.svc.annotateCalibration({ id: samples[0].id, humanOverall: 'much-better' }),
      /只能取/,
    );
    const after = await env.svc.calibrationSamples();
    assert.equal(after.samples[0].humanVerdict, null, '报错后不得留下半截写入');
  } finally { env.dispose(); }
});

test('⑤ null = 明确清空；undefined = 冻结不动', async () => {
  const env = makeEnv();
  try {
    await env.svc.runBroadcast('daily', { now: at(0) });
    const { samples } = await env.svc.calibrationSamples();
    await env.svc.annotateCalibration({ id: samples[0].id, humanVerdict: 'bloat', note: '先标着' });

    // 只改 note：humanVerdict 必须保持 bloat
    const kept = await env.svc.annotateCalibration({ id: samples[0].id, note: '补充说明' });
    assert.equal(kept.humanVerdict, 'bloat', '没传的列不许被洗成 null');
    assert.equal(kept.humanNote, '补充说明');

    // 显式 null：撤销标注
    const cleared = await env.svc.annotateCalibration({ id: samples[0].id, humanVerdict: null });
    assert.equal(cleared.humanVerdict, null);
    assert.equal(cleared.counts.annotatedVerdict, 0);
  } finally { env.dispose(); }
});

test('⑥ 服务面暴露 formulaVersion（供 evolve 写成立条件）', () => {
  const env = makeEnv();
  try {
    assert.equal(env.svc.formulaVersion, FORMULA_VERSION);
    assert.equal(typeof env.svc.annotateCalibration, 'function');
  } finally { env.dispose(); }
});
