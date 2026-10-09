/**
 * agint-aesthetic-oracle 编排层验收测试（Day 1，v2.3 方案 §8）。
 *
 * 覆盖：AC-1（wall ≤3s）/ AC-2（≤5 行 ≤2KB 首行 asOf）/ AC-3（审计 1 条
 * oracle-daily-YYYY-MM-DD）/ AC-4（缺 key 权重归一）/ AC-4b（activity 不含
 * oracle——结构性断言：本层只用 metrics 排除后的 logCount key）/
 * §6.2 重试+沉默 / §6.3 kill-switch+配额回滚 / §3.6 基线 / §5 三档模板。
 *
 * 数据夹具 = 2026-09-27 生产标定值（附录 C）：预期美总分 53.4±0.5。
 * 跑法：`node --test`（仓库统一），不依赖 dsh 宿主——store 走内存兜底。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import {
  extractAtomic, rollQuota, fitLines, dateKey, isoWeekKey, monthKey, auditTargetId,
  QUOTA_LIMITS, MAX_BYTES,
} from '../lib/broadcast.js';

// ── 夹具 ───────────────────────────────────────────────────────────────────

const DUP = { kind: 'duplicate-pattern', ruleId: 'rule-a', with: 'rule-b' };

/** 标定时刻：本地 04:00（metrics-collect 的采集时刻）→ ISO。fmtAsOfLocal 再转回本地。 */
const FIXTURE_ASOF = new Date(2026, 8, 27, 4, 0, 0).toISOString();

/** 2026-09-27 标定快照（summary 形态）：四维齐 → 53.4。 */
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

/** 只有 confidence + bloat 两维可用（AC-4：权重归一到 50）。 */
const partialSummary = () => ({
  asOf: FIXTURE_ASOF,
  count: 2,
  metrics: [
    { key: 'memory.total', value: 336, meta: JSON.stringify({ avgConfXCompliance: 0.544 }) },
    { key: 'skills.totalBytes', value: 82652, meta: JSON.stringify({ fileCount: 11, roots: ['/x'] }) },
  ],
});

/**
 * 造一个挂好假服务的 ctx 并跑 apply。
 * summary 传 Error 实例 = summary 恒抛；传 null = metrics 服务缺席。
 */
function makeEnv({ config = {}, summary = fixtureSummary, extraServices = {} } = {}) {
  const audit = [];
  const bus = [];
  let summaryCalls = 0;
  // summary 可按次切换（env.setSummary）：基线重定测试需要「先两维、后四维」
  // 的数据演进——metrics 的 summary 在生产里本就是逐日变的数据源。
  let summaryFn = summary;
  const metrics = summary === null ? undefined : {
    summary: async () => {
      summaryCalls += 1;
      if (summaryFn instanceof Error) throw summaryFn;
      return typeof summaryFn === 'function' ? summaryFn() : summaryFn;
    },
  };
  const services = {
    'agint.metrics': metrics,
    'agint.evolution': { logPhase4: async (e) => { audit.push(e); return { ...e }; } },
    'agint.eventBus.publish': async (envelope) => { bus.push(envelope); return true; },
    ...extraServices,
  };
  const provided = {};
  const effects = [];
  const ctx = {
    get: (k) => services[k],
    provide: (k, v) => { provided[k] = v; },
    effect: (fn) => effects.push(fn),
  };
  apply(ctx, config);
  return {
    svc: provided['agint.aestheticOracle'],
    provided, audit, bus,
    calls: () => summaryCalls,
    /** 按次切换 metrics.summary 的数据源（基线重定测试用）。 */
    setSummary: (s) => { summaryFn = s; },
    dispose: () => { for (const f of effects) { try { f(); } catch { /* ignore */ } } },
  };
}

const day = (offset, h = 9) => new Date(2026, 8, 27 + offset, h, 0, 0); // 本地 2026-09-27 起算
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ── AC-1 / AC-2 / AC-3：daily 主链路 ────────────────────────────────────────

test('AC-1/2/3 daily 主链路：wall≤3s、≤5行≤2KB 首行 asOf、审计 1 条', async () => {
  const env = makeEnv();
  const t0 = Date.now();
  const out = await env.svc.runBroadcast('daily');
  const wall = Date.now() - t0;

  assert.equal(out.ok, true);
  assert.ok(wall <= 3000, `AC-1 wall clock ${wall}ms > 3000ms`);

  // AC-2：5 行、2KB、首行 asOf
  assert.ok(out.lines <= 5, `AC-2 行数 ${out.lines} > 5`);
  assert.ok(out.bytes <= MAX_BYTES, `AC-2 字节 ${out.bytes} > ${MAX_BYTES}`);
  const lines = out.text.split('\n');
  assert.match(lines[0], /^📊 今日美评 \d{4}-\d{2}-\d{2}（数据截至 \d{4}-\d{2}-\d{2} \d{2}:\d{2}）$/, '首行必须含 asOf');
  // asOf 来自 summary（04:00 采集），不是广播时刻（09:00）——§5 硬规则
  assert.ok(lines[0].includes('04:00'), `首行 asOf 应为采集时刻 04:00，实得：${lines[0]}`);

  // 标定分数（附录 C）+ Q2/Q3 + 呼吸注脚
  assert.equal(out.score, 53.4);
  assert.ok(out.text.includes('总分：53.4/100'), out.text);
  assert.ok(out.text.includes('基线未建') || out.text.includes('首周起算'), out.text);
  // r2：Q2 按 ratio 排序——redundancy（4/55，扣满 20/20=1.0）为最丑，
  // 旧口径按绝对扣分报 noise（r2 时 23.16/30≈0.77），已修复。
  assert.equal(out.worstKey, 'redundancy');
  assert.ok(out.text.includes('冗余'), out.text);
  // 广播 payload 透传公式版本（r3 = 双计数分子拆解）与判尺指纹（提案 98c8e911）：
  // 版本管结构变更（人工 bump），指纹管参数微调（自动），两者互补不可互相替代。
  const dailyEvent = env.bus.find((e) => e.payload?.kind === 'daily');
  assert.equal(dailyEvent?.payload?.formulaVersion, 'r3');
  assert.match(dailyEvent?.payload?.scaleHash ?? '', /^[0-9a-f]{8}$/,
    `payload 必须带判尺指纹，实得 ${dailyEvent?.payload?.scaleHash}`);
  // §3.5：activity 5/173=0.029 < 0.1 → 播「进化静默期」，不再用「死寂」
  assert.ok(out.text.includes('呼吸：进化静默期（0.029）'), out.text);
  assert.ok(!out.text.includes('死寂'), '病理性措辞「死寂」已废弃');

  // AC-3：evolution_log 恰 1 条，targetKind=oracle-daily、targetId 带日期
  const oracleAudit = env.audit.filter((e) => e.targetKind === 'oracle-daily');
  assert.equal(oracleAudit.length, 1);
  assert.match(oracleAudit[0].targetId, /^oracle-daily-\d{4}-\d{2}-\d{2}$/);
  assert.equal(oracleAudit[0].decision, 'ABSTAIN');
  assert.equal(oracleAudit[0].scores.aestheticScore, 53.4);
  assert.equal(oracleAudit[0].scores.noise, 0.2211);
  // §4 证据落地：id 清单进审计 findings（cap 50），不进广播正文
  const idsFinding = oracleAudit[0].findings.find((f) => f.ruleId === 'oracle-no-evidence-ids');
  assert.ok(idsFinding, '审计应携带无证据 id 清单');
  assert.equal(idsFinding.detail.split(',').length, 50);
  assert.equal(oracleAudit[0].tags.includes('aesthetic-oracle'), true);

  // 事件出口（Day 1 软接线；schema 注册归 Day 2-3）
  const topicEv = env.bus.find((e) => e.topic === 'oracle.daily');
  assert.ok(topicEv, '应发布 oracle.daily');
  assert.equal(topicEv.source, 'agint-aesthetic-oracle');
  assert.equal(topicEv.payload.asOf, FIXTURE_ASOF);

  env.dispose();
});

test('AC-4：summary 缺任意 key → 广播仍输出，权重归一', async () => {
  const env = makeEnv({ summary: partialSummary });
  const out = await env.svc.runBroadcast('daily');
  assert.equal(out.ok, true);
  // 可用维 = confidence + bloat，ΣmaxWeight = 50 → 归一系数 2
  // score = 100 − 4.4571×2 − 0×2 = 91.1
  assert.equal(out.score, 91.1);
  assert.ok(out.text.includes('N/A：noise/redundancy'), out.text);
  assert.ok(out.lines <= 5 && out.bytes <= MAX_BYTES);
  env.dispose();
});

// ── 归一化可见化（提案 392cb761）：口径变化必须对读者出声 ────────────────────

test('归一化可见化：缺维时广播正文写明「按剩余维 X/100 归一」，且不新增行（AC-2）', async () => {
  const env = makeEnv({ summary: partialSummary });
  const out = await env.svc.runBroadcast('daily');
  // 读者侧：不写这句，91.1 会被当成与全维口径同尺的分数读
  assert.ok(out.text.includes('N/A：noise/redundancy（按剩余维 50/100 归一）'), out.text);
  // AC-2 不得因此放宽：仍是同一行、仍 ≤5 行
  assert.ok(out.lines <= 5, `行数 ${out.lines}`);
  assert.ok(out.bytes <= MAX_BYTES, `字节 ${out.bytes}`);
  env.dispose();
});

test('归一化可见化：审计 findings 落 oracle-score-renormalized，含缺维名单与有效分母', async () => {
  const env = makeEnv({ summary: partialSummary });
  await env.svc.runBroadcast('daily');
  const audit = env.audit.filter((e) => e.targetKind === 'oracle-daily');
  assert.equal(audit.length, 1);
  const f = audit[0].findings.find((x) => x.ruleId === 'oracle-score-renormalized');
  assert.ok(f, '缺维导致的口径变化必须进审计，不能只活在渲染里');
  assert.equal(f.severity, 'low');
  assert.ok(f.detail.includes('noise'), f.detail);
  assert.ok(f.detail.includes('redundancy'), f.detail);
  assert.ok(f.detail.includes('50/100'), `审计须写明有效分母：${f.detail}`);
  env.dispose();
});

test('全维可用时不产生归一化审计条目（不得制造噪声条目）', async () => {
  const env = makeEnv({ summary: fixtureSummary });
  await env.svc.runBroadcast('daily');
  const audit = env.audit.filter((e) => e.targetKind === 'oracle-daily');
  const f = audit[0].findings.find((x) => x.ruleId === 'oracle-score-renormalized');
  assert.equal(f, undefined, '四维齐时不得写出归一化条目');
  assert.ok(!env.audit[0].findings.some((x) => x.ruleId === 'oracle-score-renormalized'));
  env.dispose();
});

test('AC-4b：activity 只取 metrics 排除后的 logCount7d/30d，本层无二次计数路径', () => {
  const view = extractAtomic(fixtureSummary());
  assert.equal(view.activity, 0.029); // 5/173，metrics 侧已完成 oracle 排除
  // 结构性保证：extractAtomic 的输出里没有 entries 明细可供本层自行计数
  assert.equal('logRows' in view, false);
  const empty = extractAtomic({ asOf: '', metrics: [] });
  assert.equal(empty.activity, null, 'logCount 缺席 → activity null（不猜 0）');
});

// ── §4 真实关（2026-09-29 修复）：建议必须绑定真实 lint 证据 ──────────────────

/** 2026-09-29 生产实况（老板实测：rule_lint 0 issues、wiki 3 矛盾 16 孤儿）→ redundancy 最丑。 */
const todaySummary = () => ({
  asOf: new Date(2026, 8, 28, 20, 0, 0).toISOString(), // 本地 2026-09-29 04:00
  count: 7,
  metrics: [
    {
      key: 'wiki.orphans', value: 16,
      meta: JSON.stringify({
        files: [
          '.archive/diagnosis-report-2026-09-10.md', 'AGINT/diagnosis-report-2026-09-24.md',
          'AGINT/diagnosis-report-2026-09-25.md', 'AGINT/diagnosis-report-2026-09-26.md',
          'AGINT/diagnosis-report-2026-09-27.md', 'AGINT/diagnosis-report-2026-09-28.md',
          'AGINT/OpenViking-接入状态.md', 'AGINT/skill-autocreate-种子改写方案.md',
          'AGINT/渐进式披露-对照-Hermes.md', 'AGINT/观测侧假绿-识别与排查.md',
          'DSH-subagent集成坑.md', 'evol-reports/2026-09-06-dshagint-settings-error.md',
          'sandbox-escalation-discussion.md', 'subagent派活原则.md',
          '挂载-重启红线.md', '核实-3.1-3.2-2026-09-09.md',
        ],
        total: 21,
      }),
    },
    {
      key: 'wiki.contradictions', value: 3,
      meta: JSON.stringify({ files: ['DSH-subagent集成坑.md', '挂载-重启红线.md', '核实-3.1-3.2-2026-09-09.md'] }),
    },
    { key: 'rules.lintIssues', value: 0, meta: JSON.stringify({ issues: [], rulesTotal: 26 }) },
    {
      key: 'memory.total', value: 460,
      meta: JSON.stringify({
        noEvidence: { count: 71, ids: Array.from({ length: 71 }, (_, i) => `mem-${i}`), capped: true },
        avgConfXCompliance: 0.551,
      }),
    },
    { key: 'skills.totalBytes', value: 86039, meta: JSON.stringify({ fileCount: 8 }) },
    { key: 'evolution.logCount7d', value: 5, meta: JSON.stringify({ excludedOracle: 0 }) },
    { key: 'evolution.logCount30d', value: 173, meta: JSON.stringify({ excludedOracle: 0 }) },
  ],
});

test('Q3 证据绑定：extractAtomic 把 wiki 矛盾/孤儿清单透传进 adviceCtx', () => {
  const view = extractAtomic(todaySummary());
  assert.deepEqual(view.adviceCtx.wikiContradictionFiles,
    ['DSH-subagent集成坑.md', '挂载-重启红线.md', '核实-3.1-3.2-2026-09-09.md']);
  assert.equal(view.adviceCtx.wikiContradictionCount, 3);
  assert.equal(view.adviceCtx.wikiOrphanFiles.length, 16);
  assert.ok(view.adviceCtx.wikiOrphanFiles.includes('DSH-subagent集成坑.md'));
  assert.deepEqual(view.adviceCtx.ruleLintIssues, []);
  assert.equal(view.adviceCtx.curatorOverlaps, 0);
});

test('daily 回归（2026-09-29 bug）：redundancy 最丑但 rule_lint 0 命中 → 建议指 wiki 矛盾', async () => {
  const env = makeEnv({ summary: todaySummary });
  const out = await env.svc.runBroadcast('daily');
  assert.equal(out.ok, true);
  assert.equal(out.worstKey, 'redundancy', 'redundancy 扣 20（ratio 1.0）> noise 扣 17.16（ratio 0.57）→ 最丑');
  // r3 后本夹具总分 58.6（r2 时 58.0）：3 处 wiki 矛盾不再进 noise 分子，
  // 噪声比 90/507=0.1775 → 87/507=0.1716，扣分 17.75 → 17.16 ⇒ 总分 +0.6。
  // 分差恒等于被移出分子的矛盾条目数（3）÷ 分母（507）× 权重（30）≈ 0.18 的量级，
  // 实测 0.6 与之同向（分子缩小使比值更远离阈值，满扣段内非线性放大）。
  assert.equal(out.score, 58.6, 'r3 双计数拆解后的分数（r2 同夹具为 58.0）');
  assert.ok(out.text.includes('冗余度'), out.text);
  assert.ok(out.text.includes('3 条 wiki 矛盾'), out.text);
  assert.ok(out.text.includes('建议：解决 wiki 矛盾标记'), out.text);
  assert.ok(!out.text.includes('合并 rule_lint'), '不得再编造 duplicate 建议');
  assert.ok(out.text.includes('证据：wiki_lint contradictions 明细'), out.text);
  assert.ok(out.lines <= 5 && out.bytes <= MAX_BYTES);
  env.dispose();
});

// ── §6.2 / §6.3：失败重试 → 沉默；kill-switch；配额回滚 ─────────────────────

test('§6.2 连续 3 次调度失败 → 沉默模式；期间只写审计不开口', async () => {
  const env = makeEnv({ summary: new Error('boom') });
  const delays = [0, 1, 1, 1];
  for (let i = 1; i <= 3; i += 1) {
    await assert.rejects(() => env.svc.runScheduled('daily', { retryDelays: delays }), /boom/);
  }
  // 每轮 4 次（首次+3 重试）→ 12 次 summary 调用；重试期只在每轮末尾 alert 一次
  assert.equal(env.calls(), 12);
  const st = await env.svc.getState();
  assert.equal(st.silenceMode.active, true);
  assert.match(st.silenceMode.reason, /连续 3 次/);
  assert.equal(env.bus.filter((e) => e.topic === 'oracle.alert').length, 3);

  // 沉默中：第 4 次调度直接跳过（不碰 summary），但审计照写（§6.2 只写 audit log）
  const before = env.audit.length;
  const out = await env.svc.runScheduled('daily', { retryDelays: delays });
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'silence-mode');
  assert.equal(env.calls(), 12);
  assert.ok(env.audit.length > before, '沉默期间审计条目继续写入');

  // resume 一键恢复（清沉默 + 失败计数）
  await env.svc.resume();
  const after = await env.svc.getState();
  assert.equal(after.silenceMode.active, false);
  assert.equal(after.consecutiveFailures, 0);
  env.dispose();
});

test('§6.3 kill-switch：config enabled:false / env off → 不 provide（cron job soft-skip）', () => {
  const off = makeEnv({ config: { enabled: false } });
  assert.equal(off.svc, undefined, 'config 关闭 ⇒ 服务不存在 ⇒ cron soft-skip（§6.4）');

  const prev = process.env.AGINT_AESTHETIC_ORACLE;
  process.env.AGINT_AESTHETIC_ORACLE = 'off';
  try {
    const envOff = makeEnv({});
    assert.equal(envOff.svc, undefined, 'env 总闸 off ⇒ 同样不 provide');
  } finally {
    if (prev === undefined) delete process.env.AGINT_AESTHETIC_ORACLE;
    else process.env.AGINT_AESTHETIC_ORACLE = prev;
  }
});

test('§6.3 oracle_pause：运行时暂停拦截广播，resume 恢复', async () => {
  const env = makeEnv();
  await env.svc.pause('老板拍板');
  const skipped = await env.svc.runBroadcast('daily');
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'paused');
  assert.equal(env.calls(), 0, '暂停态不读 metrics');
  await env.svc.resume();
  const resumed = await env.svc.runBroadcast('daily');
  assert.equal(resumed.ok, true);
  env.dispose();
});

test('§6.3 配额回滚：daily 超 2 次 → 违规计数；违规 ≥3 → 自动沉默 + 告警', async () => {
  const env = makeEnv();
  assert.equal((await env.svc.runBroadcast('daily')).ok, true);
  assert.equal((await env.svc.runBroadcast('daily')).ok, true);
  for (let v = 1; v <= 2; v += 1) {
    const out = await env.svc.runBroadcast('daily');
    assert.equal(out.reason, 'quota');
    const st = await env.svc.getState();
    assert.equal(st.quota.violations, v);
  }
  // 第 3 次违规 → 沉默 + alert
  const third = await env.svc.runBroadcast('daily');
  assert.equal(third.reason, 'quota');
  const st = await env.svc.getState();
  assert.equal(st.quota.violations, 3);
  assert.equal(st.silenceMode.active, true);
  assert.ok(env.bus.some((e) => e.topic === 'oracle.alert' && /配额违规/.test(e.payload.reason)));
  // 沉默生效：后续全跳
  const silenced = await env.svc.runBroadcast('daily');
  assert.equal(silenced.reason, 'silence-mode');
  env.dispose();
});

test('§5.4 alert 独立日配额（3/天）防告警风暴', async () => {
  const env = makeEnv();
  assert.equal((await env.svc.alert('测试告警 1')).ok, true);
  assert.equal((await env.svc.alert('测试告警 2')).ok, true);
  assert.equal((await env.svc.alert('测试告警 3')).ok, true);
  const fourth = await env.svc.alert('测试告警 4');
  assert.equal(fourth.skipped, true);
  assert.equal(fourth.reason, 'quota');
  env.dispose();
});

// ── §3.6 基线：前 7 条 daily → 建立后 Δ 相对基线 ────────────────────────────

test('§3.6 基线：7 天 daily 后建立基线，之后 Δ 相对基线', async () => {
  const env = makeEnv();
  for (let i = 0; i < 7; i += 1) {
    const out = await env.svc.runBroadcast('daily', { now: day(i) });
    assert.equal(out.ok, true, `day ${i + 1}`);
  }
  const st = await env.svc.getState();
  assert.ok(st.baseline.establishedAt, '第 7 条后应建立基线');
  assert.equal(st.baseline.score, 53.4);

  // 第 8 天：Δ 相对基线（同数据 → 0.0）
  const out8 = await env.svc.runBroadcast('daily', { now: day(7) });
  assert.equal(out8.ok, true);
  assert.ok(out8.text.includes('基线 53.4'), out8.text);
  assert.ok(out8.text.includes('Δ：+0.0'), out8.text);
  env.dispose();
});

// ── 基线重定（提案 6be656fd；老板 2026-10-09 拍板方案 D：一次性，不滚动）──────

test('基线重定：缺值维触发一次，第二次 daily 不再重算（幂等）', async () => {
  // 生产形态复现：前 7 条用 partialSummary（noise/redundancy 缺值）建基
  const env = makeEnv({ summary: partialSummary });
  for (let i = 0; i < 7; i += 1) await env.svc.runBroadcast('daily', { now: day(i) });
  const st0 = await env.svc.getState();
  assert.ok(st0.baseline.establishedAt, '第 7 条后应建立基线');
  assert.equal(st0.baseline.method, 'first-week-mean', '首批仍是首周均值口径');

  // baselinePreview：只读预演，不改状态
  const preview = await env.svc.baselinePreview({ now: day(9) });
  assert.equal(preview.needsRebaseline, true, '基线缺 noise/redundancy 两维 ⇒ 需重定');
  assert.ok(preview.proposal, '应给出可写入的基线形态');
  assert.equal((await env.svc.getState()).baseline.score, st0.baseline.score, '预演不得改状态');

  // 数据源切到四维齐全，再跑一天 daily ⇒ 走 maybeRebaseline 链路
  env.setSummary(fixtureSummary);
  await env.svc.runBroadcast('daily', { now: day(8) });
  const after = await env.svc.getState();
  assert.equal(after.baseline.method, 'rolling-4w-median', '四维齐后应重定基');
  assert.ok(after.baseline.rebaselinedAt, '重定基须留时刻');
  assert.equal(after.baseline.windowDays, 28);
  assert.ok(isNum(after.baseline.sampleCounts?.redundancy), '每维样本数须落盘');
  for (const k of ['noise', 'confidence', 'redundancy', 'bloat']) {
    assert.ok(isNum(after.baseline.composites[k]), `重定后 ${k} 维必须有值`);
  }

  // 再跑一天 → 幂等：判据已失效，不再重算（否则退化成老板否掉的「滚动」）
  const before = JSON.stringify(after.baseline);
  await env.svc.runBroadcast('daily', { now: day(9) });
  const again = await env.svc.getState();
  assert.equal(JSON.stringify(again.baseline), before, '四维齐全后不得反复重定基');
  assert.equal(env.audit.filter((e) => e.targetKind === 'oracle-rebaseline').length, 1,
    '重定基审计恰好一条，不重复');
  env.dispose();
});

test('基线重定：样本窗口内仍缺值时不得重定（不把 null 写成 0 冒充可用）', async () => {
  const env = makeEnv({ summary: partialSummary });
  for (let i = 0; i < 9; i += 1) await env.svc.runBroadcast('daily', { now: day(i) });
  const st = await env.svc.getState();
  assert.equal(st.baseline.method, 'first-week-mean',
    '窗口内 redundancy/bloat 始终无值 ⇒ 重定基只会把 null 变 0，那是造假');
  assert.equal(env.audit.filter((e) => e.targetKind === 'oracle-rebaseline').length, 0);
  env.dispose();
});

test('基线重定：事件写审计（口径变更不可静默）', async () => {
  const env = makeEnv({ summary: partialSummary });
  for (let i = 0; i < 7; i += 1) await env.svc.runBroadcast('daily', { now: day(i) });
  env.setSummary(fixtureSummary);
  await env.svc.runBroadcast('daily', { now: day(8) });
  const reb = env.audit.filter((e) => e.targetKind === 'oracle-rebaseline');
  assert.equal(reb.length, 1, `重定基应恰好一条审计，实得 ${reb.length}`);
  assert.match(reb[0].targetId, /^oracle-rebaseline-\d{4}-\d{2}-\d{2}$/);
  const f = reb[0].findings.find((x) => x.ruleId === 'oracle-baseline-rebaselined');
  assert.ok(f, '须有可读的 findings');
  assert.ok(f.detail.includes('first-week-mean'), f.detail);
  assert.ok(f.detail.includes('rolling-4w-median'), f.detail);
  assert.ok(f.detail.includes('每维 n：'), `须落每维样本数：${f.detail}`);
  assert.ok(f.detail.includes('Δ 不可直接比较'), '口径切换须警告 Δ 不可跨期比较');
  env.dispose();
});

test('基线重定：无缺值维时不产生重定基审计（不得制造噪声条目）', async () => {
  const env = makeEnv();
  for (let i = 0; i < 9; i += 1) await env.svc.runBroadcast('daily', { now: day(i) });
  assert.equal(env.audit.filter((e) => e.targetKind === 'oracle-rebaseline').length, 0,
    '四维齐全的基线不应触发重定基审计');
  env.dispose();
});

// ── 权重标定样本出口（提案 a85ef850；老板 2026-10-09「先建标注采集，再标定」）──

test('calibrationSamples：产出机器侧归因样本，人工栏留 null（null ≠ 吻合）', async () => {
  const env = makeEnv();
  for (let i = 0; i < 3; i += 1) await env.svc.runBroadcast('daily', { now: day(i) });
  await env.svc.runBroadcast('weekly', { now: day(4) });
  const data = await env.svc.calibrationSamples({});
  assert.equal(data.formulaVersion, 'r3');
  assert.match(data.scaleHash, /^[0-9a-f]{8}$/);
  // daily 3 条 + weekly 1 条
  assert.equal(data.samples.length, 4);
  assert.ok(data.baseline, '须带基线口径，供标定脚本判读样本是否跨口径');
  for (const s of data.samples) {
    assert.equal(s.humanVerdict, null, '未标注必须是 null——写成 false/\'\' 会被下游读成「不吻合」');
    assert.ok(Array.isArray(data.annotationGuide) && data.annotationGuide.length > 0, '须给出标注口径说明');
  }
  // 机器侧归因：本夹具下 Q2 最丑恒为 redundancy
  assert.ok(data.samples.every((s) => s.machineWorst === 'redundancy'), `实得 ${JSON.stringify(data.samples.map((s) => s.machineWorst))}`);
  env.dispose();
});

test('calibrationSamples：时间窗过滤生效，且缺席服务时快照侧为空（不静默跳过）', async () => {
  const env = makeEnv();
  await env.svc.runBroadcast('daily', { now: day(0) });
  await env.svc.runBroadcast('daily', { now: day(5) });
  const all = await env.svc.calibrationSamples({});
  assert.equal(all.samples.length, 2);
  const narrow = await env.svc.calibrationSamples({ since: new Date(day(3)).toISOString(), until: new Date(day(6)).toISOString() });
  assert.equal(narrow.samples.length, 1, 'since/until 应为闭区间过滤');
  // 窗口外全空 → 采到 0 条（事实），与「服务缺席」（未挂载）是两回事
  const empty = await env.svc.calibrationSamples({ since: '2030-01-01T00:00:00Z' });
  assert.deepEqual(empty.samples, []);
  env.dispose();
});

// ── 三档模板（weekly / monthly 全档 smoke；alert 模板）──────────────────────

test('§5 weekly / monthly / alert 模板', async () => {
  const env = makeEnv();
  const weekly = await env.svc.runBroadcast('weekly');
  assert.equal(weekly.ok, true);
  assert.match(weekly.text.split('\n')[0], /^📈 本周美谕 \d{2}-\d{2} ~ \d{2}-\d{2}（数据截至/);
  assert.ok(weekly.text.includes('Q1 持平'), weekly.text);

  const monthly = await env.svc.runBroadcast('monthly');
  assert.equal(monthly.ok, true);
  assert.match(monthly.text.split('\n')[0], /^🗓️ 本月美鉴 \d{4}-\d{2}（数据截至/);

  const alertOut = await env.svc.alert('演练：这是一条美谕警报');
  assert.equal(alertOut.ok, true);
  assert.ok(alertOut.text.includes('🔔 美谕警报'), alertOut.text);
  const alertAudit = env.audit.filter((e) => e.targetKind === 'oracle-alert');
  assert.equal(alertAudit.length, 1);
  assert.match(alertAudit[0].targetId, /^oracle-alert-\d{4}-\d{2}-\d{2}-\d+$/);
  env.dispose();
});

test('summary 服务整体缺席 → 落痕 + 抛错交重试（§6.1）', async () => {
  const env = makeEnv({ summary: null });
  await assert.rejects(() => env.svc.runBroadcast('daily'), /unavailable/);
  const st = await env.svc.getState();
  // 失败留痕：error 行在 oracle_broadcasts 里（经 history 可查）
  const rows = await env.svc.history(10);
  const errRow = rows.find((r) => r.outcome === 'error' && r.kind === 'daily');
  assert.ok(errRow, '失败必须留下痕迹');
  assert.match(errRow.detail, /summary-unavailable/);
  // 失败不算违规、不建立沉默（沉默只由连续调度失败触发）
  assert.equal(st.silenceMode.active, false);
  env.dispose();
});

// ── broadcast.js 纯函数单测 ─────────────────────────────────────────────────

test('周期 key：dateKey / isoWeekKey / monthKey（本地时区）', () => {
  assert.equal(dateKey(new Date(2026, 8, 27)), '2026-09-27');
  assert.equal(monthKey(new Date(2026, 8, 27)), '2026-09');
  assert.equal(isoWeekKey(new Date(2026, 8, 27)), '2026-W39', '2026-09-27（周日）属 ISO 第 39 周');
  assert.equal(isoWeekKey(new Date(2026, 8, 21)), '2026-W39', '同周周一');
  assert.equal(isoWeekKey(new Date(2026, 8, 28)), '2026-W40', '周一翻周');
  assert.equal(isoWeekKey(new Date(2026, 0, 1)), '2026-W01');
});

test('rollQuota：周期翻转清零（日/周/月各自独立）', () => {
  const q = rollQuota({
    date: '2026-09-26', daily: 2, violations: 2,
    weeklyKey: '2026-W38', weekly: 3,
    monthlyKey: '2026-08', monthly: 3,
    bytes: 4000, alerts: 3,
  }, new Date(2026, 8, 27, 9));
  assert.equal(q.date, '2026-09-27');
  assert.equal(q.daily, 0);
  assert.equal(q.violations, 0, '违规计数随日翻转清零（§6.3 单日语义）');
  assert.equal(q.weeklyKey, '2026-W39');
  assert.equal(q.weekly, 0);
  assert.equal(q.monthlyKey, '2026-09');
  assert.equal(q.monthly, 0);
  // 同日再滚：计数保留
  const q2 = rollQuota(q, new Date(2026, 8, 27, 15));
  assert.equal(q2.daily, 0);
  assert.equal(q2.violations, 0);
});

test('fitLines：超 2KB 尾部裁行，首行（asOf）必保', () => {
  const lines = ['📊 今日美评 2026-09-27（数据截至 04:00）', '总分：53.4/100'];
  for (let i = 0; i < 30; i += 1) lines.push(`填充行 ${i}：${'x'.repeat(120)}`);
  const r = fitLines(lines);
  assert.equal(r.truncated, true);
  assert.ok(r.bytes <= MAX_BYTES, `bytes ${r.bytes}`);
  assert.equal(r.lines[0], lines[0], '首行 asOf 必须幸存');
  assert.ok(r.text.endsWith('…（截断）'));
});

test('auditTargetId：四档格式（唯一性由 targetId 承担）', () => {
  const now = new Date(2026, 8, 27);
  assert.equal(auditTargetId('daily', now), 'oracle-daily-2026-09-27');
  assert.equal(auditTargetId('weekly', now), 'oracle-weekly-2026-W39');
  assert.equal(auditTargetId('monthly', now), 'oracle-monthly-2026-09');
  assert.equal(auditTargetId('alert', now, 2), 'oracle-alert-2026-09-27-2');
});

test('配额常量与方法案（§7 预算护栏在案）', () => {
  assert.equal(QUOTA_LIMITS.daily, 2);
  assert.equal(QUOTA_LIMITS.weekly, 3);
  assert.equal(QUOTA_LIMITS.monthly, 3);
  assert.equal(QUOTA_LIMITS.alert, 3);
  assert.equal(MAX_BYTES, 2048);
});

// ── Day 2-3：payload 合同 / dashboard 订阅 / 缓存回退 / alert 解耦 ──────────

import { validateTopicPayload, TOPIC_KIND } from '../lib/topics.js';
import { KIND_TOPIC } from '../lib/broadcast.js';

const flush = () => new Promise((r) => setTimeout(r, 20));

/** 桥接版 makeEnv：subscribe 注册的 handler 会在 publish 后异步收到 envelope。 */
function makeBridgedEnv(opts = {}) {
  const handlers = [];
  let seq = 0;
  const basePublish = async (envelope) => { /* 由 extraServices 覆盖 */ };
  const subscribeSvc = async (sub, handler) => { handlers.push(handler); return () => {}; };
  const env = makeEnv({
    ...opts,
    extraServices: {
      'agint.eventBus.subscribe': subscribeSvc,
      'agint.eventBus.publish': async (input) => {
        env.bus.push(input);
        const evt = {
          ...input,
          id: `evt-${(seq += 1)}`,
          occurredAt: new Date().toISOString(),
          traceId: 'test-trace',
        };
        for (const h of handlers) { Promise.resolve().then(() => h(evt)).catch(() => {}); }
        return true;
      },
      ...(opts.extraServices ?? {}),
    },
  });
  return { ...env, dashHandlers: handlers };
}

test('Day2-3 payload 合同：四 topic 合法样本过、违约样本拒、无合同 topic 拒', () => {
  const tierPayload = (kind) => ({
    kind, asOf: FIXTURE_ASOF, score: 53.4, verdict: 'flat',
    worstKey: 'noise', lines: ['a', 'b'], text: 'a\nb',
  });
  for (const [topic, kind] of [['oracle.daily', 'daily'], ['oracle.weekly', 'weekly'], ['oracle.monthly', 'monthly']]) {
    assert.deepEqual(validateTopicPayload(topic, tierPayload(kind)), { ok: true }, topic);
  }
  // oracle.alert 双形态：reason 形 / text 形 / 双空拒
  assert.deepEqual(validateTopicPayload('oracle.alert', { reason: '沉默 24h' }), { ok: true });
  assert.deepEqual(validateTopicPayload('oracle.alert', { kind: 'alert', text: '🔔' }), { ok: true });
  assert.equal(validateTopicPayload('oracle.alert', {}).ok, false, 'reason/text 双空必须拒');
  // 违约：kind 与 topic 不匹配 / score 非数值 / verdict 越枚举
  assert.equal(validateTopicPayload('oracle.daily', tierPayload('weekly')).ok, false);
  assert.equal(validateTopicPayload('oracle.daily', { ...tierPayload('daily'), score: '52' }).ok, false);
  assert.equal(validateTopicPayload('oracle.daily', { ...tierPayload('daily'), verdict: 'so-so' }).ok, false);
  // 无合同 topic：拒（新 topic 必须先立合同）
  assert.equal(validateTopicPayload('oracle.yearly', { any: true }).ok, false);
  // 判尺指纹（提案 98c8e911）：合法 8 位十六进制过；形状不对必拒
  assert.deepEqual(
    validateTopicPayload('oracle.daily', { ...tierPayload('daily'), scaleHash: '59e371d8' }),
    { ok: true },
  );
  for (const bad of ['59E371D8', '59e371d', '59e371d8ff', 'notahash', '']) {
    assert.equal(
      validateTopicPayload('oracle.daily', { ...tierPayload('daily'), scaleHash: bad }).ok,
      false,
      `非法 scaleHash 必须拒：${JSON.stringify(bad)}`,
    );
  }
  // 缺席（undefined）必须放行——旧事件历史里没这个字段
  assert.equal(validateTopicPayload('oracle.daily', { ...tierPayload('daily'), scaleHash: undefined }).ok, true);
  // 反查一致性：KIND_TOPIC ↔ TOPIC_KIND 互逆
  for (const [k, t] of Object.entries(KIND_TOPIC)) assert.equal(TOPIC_KIND[t], k);
});

test('Day2-3 出口 payload 与合同对齐：三档+alert 的真实 publish 必过自校验', async () => {
  const env = makeEnv();
  for (const kind of ['daily', 'weekly', 'monthly']) {
    const out = await env.svc.runBroadcast(kind);
    assert.equal(out.ok, true, kind);
  }
  await env.svc.alert('合同对齐演练');
  // 全部出口事件逐一过合同（合同与实现漂移在这里被抓）
  for (const evt of env.bus) {
    const check = validateTopicPayload(evt.topic, evt.payload);
    assert.deepEqual(check, { ok: true }, `${evt.topic} 出口 payload 违约：${check.ok ? '' : check.issues}`);
  }
  assert.equal(env.bus.length, 4);
  env.dispose();
});

test('Day2-3 dashboard 订阅端到端：daily 广播 → cards() 收到 oracle.daily 快照', async () => {
  const env = makeBridgedEnv();
  await flush(); // apply 末尾的首次订阅尝试落地
  assert.equal(env.dashHandlers.length >= 1, true, 'dashboard 订阅应已注册');

  const out = await env.svc.runBroadcast('daily');
  assert.equal(out.ok, true);
  await flush(); // async 投递 + 卡片落盘

  const cards = await env.svc.cards();
  const daily = cards.find((c) => c.topic === 'oracle.daily');
  assert.ok(daily, 'oracle.daily 卡片应存在');
  assert.match(daily.envelopeId, /^evt-/);
  assert.equal(daily.payload.score, 53.4);
  assert.ok(daily.occurredAt, '事件发生时刻应透出');
  assert.ok(daily.receivedAt, '订阅收到时刻应透出');
  env.dispose();
});

test('AC-7b 沉默 24h → oracle.alert 端到端（dashboard 收到告警卡片）', async () => {
  const env = makeBridgedEnv({
    summary: new Error('boom'),
    config: { silenceAlertAfterMs: 0 }, // 运维旋钮：演练模式把 24h 阈值调 0
  });
  await flush(); // 订阅落地
  const delays = [0, 1, 1, 1];
  for (let i = 1; i <= 3; i += 1) {
    await assert.rejects(() => env.svc.runScheduled('daily', { retryDelays: delays }), /boom/);
  }
  const st = await env.svc.getState();
  assert.equal(st.silenceMode.active, true);

  // 沉默态下再调度一次：sinceMs >= 0 → silence-24h alert（阈值调 0 的演练语义）
  await flush();
  const before = env.bus.filter((e) => e.topic === 'oracle.alert'
    && /沉默模式已持续/.test(e.payload?.reason ?? '')).length;
  const out = await env.svc.runBroadcast('daily');
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'silence-mode');
  await flush();
  const after = env.bus.filter((e) => e.topic === 'oracle.alert'
    && /沉默模式已持续/.test(e.payload?.reason ?? '')).length;
  assert.equal(after, before + 1, '沉默 24h（演练阈值）应恰发一条 oracle.alert');

  // 端到端终点：dashboard 卡片收到告警
  const cards = await env.svc.cards();
  const alertCard = cards.find((c) => c.topic === 'oracle.alert');
  assert.ok(alertCard, 'AC-7b：oracle.alert 卡片必须到达 dashboard 订阅者');
  assert.match(String(alertCard.payload?.reason ?? ''), /沉默模式已持续/);
  // 防重：再调度不再发
  const again = await env.svc.runBroadcast('daily');
  assert.equal(again.skipped, true);
  await flush();
  const final = env.bus.filter((e) => e.topic === 'oracle.alert'
    && /沉默模式已持续/.test(e.payload?.reason ?? '')).length;
  assert.equal(final, after, '24h 告警只发一次（alerted 防重）');
  env.dispose();
});

test('Day2-3 §6.1 缓存回退：summary 挂 + lastGood 新鲜 → stale 广播照发', async () => {
  let mode = 'ok';
  const metricsSvc = {
    summary: async () => {
      if (mode !== 'ok') throw new Error('summary down');
      return fixtureSummary();
    },
  };
  const env = makeEnv({ summary: null, extraServices: { 'agint.metrics': metricsSvc } });
  // 第一遍：主路径成功 → 写 lastGood 缓存
  const first = await env.svc.runBroadcast('daily');
  assert.equal(first.ok, true);
  assert.equal(first.stale, undefined, '新鲜广播不带 stale 标注');
  const st1 = await env.svc.getState();
  assert.equal(st1.lastGood.atomic.memoryTotal, 336, '缓存应含原子值');
  assert.equal(st1.lastGood.asOf, FIXTURE_ASOF);

  // 第二遍：summary 挂 → 缓存回退，广播照发 + stale 标注
  mode = 'down';
  const second = await env.svc.runBroadcast('daily');
  assert.equal(second.ok, true, '缓存回退必须照发');
  assert.equal(second.stale, true);
  assert.equal(second.staleDays, 0);
  assert.ok(second.text.includes('⚠缓存0天'), second.text);
  assert.equal(second.score, first.score, '缓存数据 → 同分');
  // 事件 payload 带 staleDays 且过合同；审计带 oracle-stale-cache findings
  const evt = env.bus.filter((e) => e.topic === 'oracle.daily').pop();
  assert.equal(evt.payload.staleDays, 0);
  assert.deepEqual(validateTopicPayload(evt.topic, evt.payload), { ok: true });
  const staleAudit = env.audit.filter((e) => e.targetKind === 'oracle-daily').pop();
  assert.ok(staleAudit.findings.some((f) => f.ruleId === 'oracle-stale-cache'), '审计必须留缓存回退痕');
  // 缓存回退不算成功采集：lastGood.savedAt 不应被刷新成第二遍时刻
  const st2 = await env.svc.getState();
  assert.equal(st2.lastGood.savedAt, st1.lastGood.savedAt, '回退路径不刷新缓存（数据没变）');
  env.dispose();
});

test('Day2-3 alert 通道不依赖 metrics：summary 恒抛 → alert() 仍成功', async () => {
  const env = makeEnv({ summary: new Error('boom') });
  const out = await env.svc.alert('metrics 挂了也要能告警');
  assert.equal(out.ok, true, '§6.1：警报通道不能被数据源挂掉绑架');
  assert.ok(out.text.includes('🔔 美谕警报'), out.text);
  assert.equal(env.calls(), 0, 'alert 路径不读 summary');
  // payload 过合同（text 形）
  const evt = env.bus.filter((e) => e.topic === 'oracle.alert').pop();
  assert.deepEqual(validateTopicPayload(evt.topic, evt.payload), { ok: true });
  env.dispose();
});

// ── Day 4-5：weekly 美谕提案闭环（§5；status 锁 proposed，永不 auto-apply）──

import { evaluateAesthetics, q3Advice, NO_ADVICE } from '../lib/scoring.js';
import { buildWeeklyProposals } from '../lib/broadcast.js';

test('Day4-5 buildWeeklyProposals：绝对扣分 top3（无证据维跳过），0 扣分不提，evidence 必填', () => {
  const view = extractAtomic(fixtureSummary());
  const evaluation = evaluateAesthetics(view.atomic, { adviceCtx: view.adviceCtx });
  const proposals = buildWeeklyProposals(evaluation, view.adviceCtx, { weekKey: '2026-W39', targetId: 'oracle-weekly-2026-W39' });
  // 标定数据：noise 22.11 / redundancy 20 / confidence 4.46 / bloat 0。
  // 2026-10-08 接线修复：extractAtomic 的 adviceCtx 此前从未构造
  // lowConfidenceNoEvidence（q3Advice 的 case 'confidence' 唯一数据源）⇒
  // 该维永远回 NO_ADVICE，本测试把「跳过」固化成断言，故 confidence 建议**从未
  // 端到端跑过**。metrics.js:165 实际已产出 noEvidence.ids（fixture 71 条），
  // 原注释「metrics 不提供行级清单」的前提已不成立。
  // 现接通：confidence 以「无证据」近似口径提 1 条，措辞已降级、不宣称逐条
  // confidence（见 scoring.js case 'confidence' 的口径注释）。
  // bloat 零扣分仍不提。故由 2 条变 3 条。
  assert.equal(proposals.length, 3, 'noise + redundancy + confidence 各 1 条；bloat 零扣分不提');
  assert.deepEqual(proposals.map((p) => p.title.match(/噪声比|冗余度|决策确信度|臃肿度/g)?.[0]).sort(),
    ['噪声比', '冗余度', '决策确信度'].sort());
  for (const p of proposals) {
    assert.ok(p.title.startsWith('美谕提案：'), p.title);
    assert.match(p.body, /建议：/, 'body 必含建议');
    assert.match(p.body, /证据：/, 'evidence 必填（§5）');
    assert.match(p.body, /现状：/, 'body 必含现状数据');
    assert.match(p.body, /永不 auto-apply/, 'body 必须自述不自动执行');
    assert.ok(['rule', 'skill', 'doc', 'other'].includes(p.category), `category 合法：${p.category}`);
  }
  // 零扣分场景（全阈内）：无提案
  const healthy = evaluateAesthetics({
    wikiOrphans: 0, wikiContradictions: 0, ruleDuplicates: 0, memoryNoEvidence: 0,
    wikiTotal: 10, rulesTotal: 10, memoryTotal: 10,
    avgConfXCompliance: 0.9, skillsBytes: 1000, skillsTotal: 2,
  }, { adviceCtx: {} });
  assert.equal(buildWeeklyProposals(healthy, {}, {}).length, 0, '阈内系统不提案');
});

// 2026-10-08 回归钉。本缺陷能活这么久，是因为 scoring.test.js 手喂 ctx 测
// q3Advice 的**输入契约**，而没有任何测试断言 extractAtomic 的**输出**里带这个
// 字段——生产方与消费方之间的接线无人看守（两边各自全绿）。
test('2026-10-08 回归钉：adviceCtx.lowConfidenceNoEvidence 必须由 extractAtomic 产出，且空清单仍回 NO_ADVICE', () => {
  // 正样本：metrics 的 noEvidence.ids 非空（fixture 71 条）→ 字段须原样透传
  const view = extractAtomic(fixtureSummary());
  assert.ok(Array.isArray(view.adviceCtx.lowConfidenceNoEvidence),
    '字段必须存在且为数组——undefined 会让 q3Advice 静默短路，正是修复前的故障形态');
  assert.equal(view.adviceCtx.lowConfidenceNoEvidence.length, 71, '应透传 metrics 的全部 ids');
  assert.equal(q3Advice('confidence', view.adviceCtx).advice !== NO_ADVICE, true,
    '有清单时必须给出可执行建议');

  // 负样本：ids 缺席 → 空数组（不是 undefined），且**仍回 NO_ADVICE**。
  // 这是 09-29「真实关」的底线：接通数据源不等于可以编假建议。
  const bare = extractAtomic({ asOf: '', metrics: [] });
  assert.ok(Array.isArray(bare.adviceCtx.lowConfidenceNoEvidence), '字段恒存在');
  assert.equal(bare.adviceCtx.lowConfidenceNoEvidence.length, 0, '无 ids 时为空数组');
  assert.equal(q3Advice('confidence', bare.adviceCtx).advice, NO_ADVICE,
    '清单为空时必须回 NO_ADVICE，不得兜底编一句建议');
});

test('Day4-5 weekly 广播提 3 条提案：evolve.propose 收到、审计留痕、永不 setStatus', async () => {
  const proposed = [];
  const statusCalls = [];
  const env = makeEnv({
    extraServices: {
      'agint.evolve': {
        propose: async (input) => {
          // 复刻 evolve 侧契约：status 硬锁 proposed（input.status 即使传也被忽略）
          const rec = { id: `prop-${proposed.length + 1}`, status: 'proposed', ...input, status2: undefined };
          delete rec.status2;
          proposed.push(rec);
          return { ...rec };
        },
        setStatus: async (...args) => { statusCalls.push(args); return {}; },
      },
    },
  });
  const out = await env.svc.runBroadcast('weekly');
  assert.equal(out.ok, true);
  assert.equal(out.proposals, 3, 'weekly 应提交 3 条提案（2026-10-08 confidence 接线修复后）');
  assert.equal(proposed.length, 3, 'evolve.propose 实收 3 条（与 out.proposals 一致）');
  for (const p of proposed) {
    assert.equal(p.status, 'proposed', 'status 锁 proposed');
    assert.equal(p.source, 'agint-aesthetic-oracle');
    assert.match(p.note, /^oracle-weekly-\d{4}-W\d{2}/);
    assert.match(p.body, /证据：/, 'evidence 必填');
  }
  // 审计 findings 记提案 id（evidence 可追溯）
  const weeklyAudit = env.audit.filter((e) => e.targetKind === 'oracle-weekly').pop();
  const propFinding = weeklyAudit.findings.find((f) => f.ruleId === 'oracle-proposals');
  assert.ok(propFinding, '审计应携带提案 id 清单');
  assert.match(propFinding.detail, /prop-1,prop-2/);
  // oracle.weekly 事件 payload 带 proposals 计数
  const evt = env.bus.find((e) => e.topic === 'oracle.weekly');
  assert.equal(evt.payload.proposals, 3); // 2026-10-08 confidence 接线修复后由 2 变 3
  // ⭐ 永不 auto-apply：oracle 从不触碰 setStatus
  assert.equal(statusCalls.length, 0, 'oracle 不得调 setStatus（§5：只提不 commit）');
  // daily 不提提案
  proposed.length = 0;
  const daily = await env.svc.runBroadcast('daily');
  assert.equal(daily.ok, true);
  assert.equal(daily.proposals, undefined, 'daily 不带提案字段');
  assert.equal(proposed.length, 0, 'daily 不提提案');
  env.dispose();
});

test('Day4-5 evolve 缺席/抛错 → weekly 广播照发（提案降级不阻断，§6.1）', async () => {
  // 缺席
  const env1 = makeEnv();
  const out1 = await env1.svc.runBroadcast('weekly');
  assert.equal(out1.ok, true);
  assert.equal(out1.proposals, 0);
  env1.dispose();
  // propose 恒抛
  let throws = 0;
  const env2 = makeEnv({
    extraServices: {
      'agint.evolve': {
        propose: async () => { throws += 1; throw new Error('evolve down'); },
      },
    },
  });
  const out2 = await env2.svc.runBroadcast('weekly');
  assert.equal(out2.ok, true, '提案失败不得阻断广播');
  assert.equal(out2.proposals, 0);
  // 2026-10-08 confidence 接线修复：confidence 不再跳过，提交数与失败记账
  // 同步由 2 变 3（提案失败仍不阻断广播——本用例的真正判据是 ok=true）。
  assert.equal(out2.proposalsFailed, 3, '3 条提案各自失败记账（confidence 修复后不再跳过）');
  assert.equal(throws, 3);
  const rows = await env2.svc.history(5);
  const weeklyRow = rows.find((r) => r.kind === 'weekly' && r.outcome === 'ok');
  assert.equal(weeklyRow.proposals, 0, '落账行反映真实提交数');
  env2.dispose();
});

// ── §8.1.6 可观测性（v0.4.3）：mode 与 LLM 降级 reason 进审计 findings ──────
// 2026-10-05 排障缺口回归钉：此前 mode 只进事件 payload、降级 reason 只活在
// 内存里，evolution_log 查不到，只能靠广播墙钟反推走没走 LLM。

test('审计带 oracle-llm-mode：LLM 通路不可用时记 mode + 降级 reason', async () => {
  const env = makeEnv();   // ctx 无 agents/subagents 服务 → L1 立即降级（不真调 LLM）
  const out = await env.svc.runBroadcast('daily');
  assert.equal(out.ok, true);

  const audit = env.audit.filter((e) => e.targetKind === 'oracle-daily');
  assert.equal(audit.length, 1);
  const finding = audit[0].findings.find((f) => f.ruleId === 'oracle-llm-mode');
  assert.ok(finding, '审计必须带 oracle-llm-mode finding');
  assert.ok(finding.detail.includes('mode=heuristic-degraded'), finding.detail);
  assert.ok(finding.detail.includes('L1:agents unavailable'), finding.detail);
  env.dispose();
});

test('审计带 oracle-llm-mode：kill-switch off 时记 mode=template 且不带降级段', async () => {
  const prev = process.env.AGINT_AESTHETIC_ORACLE_LLM;
  process.env.AGINT_AESTHETIC_ORACLE_LLM = 'off';
  try {
    const env = makeEnv();
    await env.svc.runBroadcast('daily');
    const audit = env.audit.filter((e) => e.targetKind === 'oracle-daily');
    const finding = audit[0].findings.find((f) => f.ruleId === 'oracle-llm-mode');
    assert.ok(finding, '审计必须带 oracle-llm-mode finding');
    assert.equal(finding.detail, 'mode=template');
    env.dispose();
  } finally {
    if (prev === undefined) delete process.env.AGINT_AESTHETIC_ORACLE_LLM;
    else process.env.AGINT_AESTHETIC_ORACLE_LLM = prev;
  }
});
