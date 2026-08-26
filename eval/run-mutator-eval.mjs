#!/usr/bin/env node
/**
 * eval/run-mutator-eval.mjs — Sprint 8 子任务 #6 eval runner
 *
 * 读取 eval/scenarios/agint-mutator.scenario.json，按 scenario 顺序跑：
 *   - action=pureFn        → plugins/agint-mutator/lib/index.js 的模块级 pure helpers
 *   - action=serviceCall   → mock ctx 启动 lib/index.js，调真 Service
 *
 * 覆盖（设计稿 §三.2 验收门槛第 1 条）：3 类 mutation × 3 条来源 × validate 4 约束
 * （含反例 fixture 拦截）× commit 闭环 happy × rollback 闭环 happy × metrics 三事件。
 *
 * 退出码：0 = 全 PASS，1 = 有 FAIL（CI 友好）。
 *
 * 用法：
 *   node eval/run-mutator-eval.mjs
 *
 * 设计：单文件、零依赖、一行 node 跑；不修改 lib/，仅读 + 调用真 Service。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGINT_ROOT = resolve(__dirname, '..');
const SCENARIO_FILE = join(__dirname, 'scenarios', 'agint-mutator.scenario.json');

// ── 加载 scenario JSON ───────────────────────────────────────────────────

const raw = await readFile(SCENARIO_FILE, 'utf8');
const parsed = JSON.parse(raw);
// 兼容两种形态：纯数组（sprint 7 体例）或带 _purpose / _threshold / scenarios 字段的对象（Sprint 8 收口体例）
const scenarios = Array.isArray(parsed) ? parsed : (parsed.scenarios || []);
if (!Array.isArray(scenarios) || scenarios.length < 10) {
  console.error(`[FAIL] scenario.json 必须是 ≥10 个场景的数组，实得 ${scenarios?.length}`);
  process.exit(1);
}

// ── 加载真实 lib（动态 import — ESM） ────────────────────────────────────

const pluginMod = await import(`${AGINT_ROOT}/plugins/agint-mutator/lib/index.js`);
const { _deriveTargetPlugin, _pickKindFromSeed } = pluginMod;

// ── mock ctx 工厂 ──
// 4 表 in-memory Map + 软依赖注入（diagnosis / evolution / dream / sandbox / policy）。
// 红线：runner 只 import lib/index.js，不修改 lib/。commit 涉及 fs → tmpdir 隔离 + cleanup。
const DIAG_BASE = { queryAnnotations: async () => [], report: async () => ({}), annotate: async () => ({ rootCause: 'PROMPT_DEFICIENCY', evidence: 'agint-mutator' }) };
const EVO_BASE = { queryFailures: async () => [] };
const DREAM_BASE = { sweep: async () => ({}), status: async () => ({}) };
function makeFakeCtx({ services = {}, deps = null, writePreimage = false, sandboxOk = true, policyDecision = 'AUTO_DEPLOY' } = {}) {
  const tables = { proposals: new Map(), commits: new Map(), findings: new Map(), metrics_log: new Map() };
  const mockSandbox = {
    runSmoke: async ({ target }) => ({ target: { path: target.path, name: target.name }, ok: sandboxOk, mode: 'in-process', exitCode: sandboxOk ? 0 : 1, stdout: '', stderr: '', checks: [{ name: 'mock-smoke', ok: sandboxOk, detail: 'mock' }], durationMs: 1 }),
  };
  const mockPolicy = {
    decide: async () => ({ kind: policyDecision, score: 80, reason: `mock-policy-${policyDecision}`, triggeredBy: [], decidedAt: new Date().toISOString(), policyId: 'mock@v0' }),
    detectFalseHarmony: async () => ({}), setThresholds: async () => ({}), health: () => ({ serviceAvailable: true }), config: {},
  };
  let workdir = null;
  if (writePreimage) {
    workdir = mkdtempSync(join(tmpdir(), 'agint-mutator-eval-'));
    mkdirSync(join(workdir, 'plugins', 'agint-mutator', 'prompts'), { recursive: true });
    mkdirSync(join(workdir, 'plugins', 'agint-mutator', 'strategies'), { recursive: true });
    writeFileSync(join(workdir, 'plugins', 'agint-mutator', 'prompts', 'sys-prompt.md'), 'OLD prompt content');
    writeFileSync(join(workdir, 'plugins', 'agint-mutator', 'strategies', 'default-strategy.json'), JSON.stringify({ strategyId: 'default-strategy', ordering: 'before', steps: ['fetch_context', 'plan_subtasks', 'execute', 'verify'] }, null, 2));
  }
  const get = (n) => {
    if (deps === null) {
      if (n === 'agint.diagnosis') return DIAG_BASE;
      if (n === 'agint.evolution') return EVO_BASE;
      if (n === 'agint.dream') return DREAM_BASE;
      if (n === 'agint.qualitySandbox') return mockSandbox;
      if (n === 'agint.qualityPolicy') return mockPolicy;
      return null;
    }
    if (n === 'agint.diagnosis') return deps.diagnosis !== undefined ? deps.diagnosis : DIAG_BASE;
    if (n === 'agint.evolution') return deps.evolution !== undefined ? deps.evolution : EVO_BASE;
    if (n === 'agint.dream') return deps.dream !== undefined ? deps.dream : DREAM_BASE;
    if (n === 'agint.qualitySandbox') return deps.sandbox !== undefined ? deps.sandbox : mockSandbox;
    if (n === 'agint.qualityPolicy') return deps.policy !== undefined ? deps.policy : mockPolicy;
    return null;
  };
  pluginMod.apply({
    storageDomain: { open: async () => ({
      table: (name) => {
        const s = tables[name] || (tables[name] = new Map());
        return { entries: () => Array.from(s, ([id, v]) => ({ id, ...v })), put: async (id, v) => { s.set(id, v); }, close: async () => {} };
      },
      close: async () => {},
    }) },
    get, provide: (n, f) => { services[n] = f; }, effect: () => () => {},
  });
  return { services, tables, workdir, cleanup: () => { if (workdir) try { rmSync(workdir, { recursive: true, force: true }); } catch (_e) { /* ignore */ } } };
}

// ── 来源 service 用：diagnosis / evolution mock 构造 ──
const mockDiagnosis = (rootCause, evidence = 'in agint-mutator') => ({ ...DIAG_BASE, annotate: async () => ({ rootCause, evidence }) });
const mockEvolution = (matches = []) => ({ ...EVO_BASE, queryFailures: async () => matches });

// ── assert helpers ───────────────────────────────────────────────────────

function assertPureFn(scenario, args, exp) {
  const svc = scenario.input[0].service;
  const fnName = svc.split('.').slice(2).join('.'); // 跳过 'agint.mutator' 前缀
  if (fnName === '_deriveTargetPlugin') {
    const out = _deriveTargetPlugin(args.ctx);
    if (exp.kind === 'targetPlugin') return out === exp.value ? { ok: true, detail: `targetPlugin=${out}` } : { ok: false, detail: `_deriveTargetPlugin=${out} expected=${exp.value}` };
    return { ok: false, detail: `unsupported expected.kind=${exp.kind} for _deriveTargetPlugin` };
  }
  if (fnName === '_pickKindFromSeed') {
    const out = _pickKindFromSeed(args.seed, args.pool, args.count);
    if (exp.kind !== 'pickKindResult') return { ok: false, detail: `unsupported expected.kind=${exp.kind} for _pickKindFromSeed` };
    if (out.length < (exp.minLength ?? 1) || out.length > (exp.maxLength ?? args.count ?? args.pool.length)) return { ok: false, detail: `_pickKindFromSeed 长度=${out.length} 不在 [${exp.minLength},${exp.maxLength}]` };
    for (const k of out) if (exp.subsetOf && exp.subsetOf.indexOf(k) < 0) return { ok: false, detail: `_pickKindFromSeed 越界: ${k} ⊄ ${JSON.stringify(exp.subsetOf)}` };
    return { ok: true, detail: `picked=${JSON.stringify(out)} (seed=${args.seed})` };
  }
  return { ok: false, detail: `pureFn 不支持 service='${svc}'` };
}

async function assertPropose(env, args, exp) {
  const out = await env.services['agint.mutator.propose'](args.input);
  if (exp.kind !== 'proposal') return { ok: false, detail: `expected.kind=${exp.kind} 非 proposal` };
  const fails = [];
  if (out.kind !== exp.mutKind) fails.push(`kind=${out.kind} expected=${exp.mutKind}`);
  if (out.atomicScope !== exp.atomicScope) fails.push(`atomicScope=${out.atomicScope} expected=${exp.atomicScope}`);
  if (out.status !== exp.status) fails.push(`status=${out.status} expected=${exp.status}`);
  if (out.source !== exp.source) fails.push(`source=${out.source} expected=${exp.source}`);
  if (exp.preimageHashNonEmpty && (!out.preimageHash || out.preimageHash.length === 0)) fails.push('preimageHash 空');
  return { ok: fails.length === 0, detail: fails.length === 0 ? `kind=${out.kind} scope=${out.atomicScope} status=${out.status}` : fails.join('; ') };
}

async function assertValidate(env, args, exp) {
  const out = await env.services['agint.mutator.validate']({ proposal: args.proposal });
  if (exp.kind !== 'validateResult') return { ok: false, detail: `expected.kind=${exp.kind} 非 validateResult` };
  const fails = [];
  if (out.ok !== exp.ok) fails.push(`ok=${out.ok} expected=${exp.ok}`);
  if (exp.ok === false && !out.findings.some((f) => exp.findingMessageContains && (f.message || '').includes(exp.findingMessageContains))) {
    fails.push(`findings 不含 '${exp.findingMessageContains}'，实有=${JSON.stringify(out.findings.map((f) => f.message))}`);
  }
  return { ok: fails.length === 0, detail: `ok=${out.ok} findings=${out.findings.length}` };
}

async function assertSourceResult(args, exp, scenarioName) {
  // 三条来源 service 各自构造专属 mock ctx
  let out, tables;
  if (scenarioName.startsWith('source-attributionDriven')) {
    const env = makeFakeCtx({ deps: { diagnosis: args.diagnosisMock ? mockDiagnosis(args.diagnosisMock.rootCause, args.diagnosisMock.evidence) : null } });
    out = await env.services['agint.mutator.attributionDriven'](args.input);
    tables = env.tables; env.cleanup();
  } else if (scenarioName.startsWith('source-dreamRandom')) {
    const env = makeFakeCtx({ deps: { dream: args.dreamMock === null ? null : (args.dreamMock || DREAM_BASE) } });
    out = await env.services['agint.mutator.dreamRandom'](args.input);
    tables = env.tables; env.cleanup();
  } else if (scenarioName.startsWith('source-evolutionReversed')) {
    const env = makeFakeCtx({ deps: { evolution: args.evolutionMock ? mockEvolution(args.evolutionMock.matches || []) : null } });
    out = await env.services['agint.mutator.evolutionReversed'](args.input);
    tables = env.tables; env.cleanup();
  } else {
    return { ok: false, detail: `未知来源 service: ${scenarioName}` };
  }
  const fails = [];
  if (out.ok !== exp.ok) fails.push(`ok=${out.ok} expected=${exp.ok}`);
  if (exp.reason && out.reason !== exp.reason) fails.push(`reason=${out.reason} expected=${exp.reason}`);
  if (exp.mutKind && out.proposal && out.proposal.kind !== exp.mutKind) fails.push(`proposal.kind=${out.proposal && out.proposal.kind} expected=${exp.mutKind}`);
  if (exp.source && out.proposal && out.proposal.source !== exp.source) fails.push(`proposal.source=${out.proposal && out.proposal.source} expected=${exp.source}`);
  if (exp.proposalDroppedInTable === true && tables.proposals.size !== 1) fails.push(`proposal 未落库（proposals=${tables.proposals.size}）`);
  if (exp.proposalDroppedInTable === false && tables.proposals.size !== 0) fails.push(`proposal 意外落库（proposals=${tables.proposals.size}）`);
  if (exp.findingDroppedInTable === true && tables.findings.size !== 1) fails.push(`finding 未落库（findings=${tables.findings.size}）`);
  return { ok: fails.length === 0, detail: `ok=${out.ok} reason=${out.reason || '-'} kind=${out.proposal && out.proposal.kind || '-'}` };
}

// 共享 helper：metrics_log + proposal.status 断言（commit / rollback 共用）
function checkMetricsAndStatus(env, exp, fails) {
  const pEntry = Array.from(env.tables.proposals.values())[0];
  if (pEntry && exp.proposalStatusAfter && pEntry.status !== exp.proposalStatusAfter) fails.push(`proposal.status=${pEntry.status} expected=${exp.proposalStatusAfter}`);
  const metricEntries = Array.from(env.tables.metrics_log.values());
  if (exp.metricEventWritten && !metricEntries.some((m) => m.eventType === exp.metricEventWritten)) {
    fails.push(`metrics_log 缺 ${exp.metricEventWritten}（实有=${JSON.stringify(metricEntries.map((m) => m.eventType))}）`);
  }
  return pEntry;
}

async function assertCommit(env, args, exp, scenarioName) {
  let proposal;
  try { proposal = await env.services['agint.mutator.propose'](args.input); }
  catch (e) { return { ok: false, detail: `propose 抛错: ${e.message || e}` }; }
  const commitArgs = { proposalId: proposal.id, pluginId: args.input.targetPlugin || 'agint-mutator', repoRoot: env.workdir };

  if (scenarioName === 'rollback-happy-metrics-rollback') {
    let commitRes;
    try { commitRes = await env.services['agint.mutator.commit'](commitArgs); }
    catch (e) { return { ok: false, detail: `rollback 前的 commit 抛错: ${e.message || e}` }; }
    const rb = await env.services['agint.mutator.rollback']({ commitId: commitRes.commitId, repoRoot: env.workdir });
    const fails = [];
    if (rb.ok !== exp.ok) fails.push(`ok=${rb.ok} expected=${exp.ok}`);
    if (exp.restoredHashMatchesPreimage && rb.restoredHash !== commitRes.preimageHash) fails.push(`restoredHash=${rb.restoredHash} ≠ preimageHash=${commitRes.preimageHash}`);
    const pEntry = checkMetricsAndStatus(env, exp, fails);
    return { ok: fails.length === 0, detail: fails.length === 0 ? `rollback ok, status=${pEntry && pEntry.status}` : fails.join('; ') };
  }

  if (args.expectThrows) {
    let thrown = null;
    try { await env.services['agint.mutator.commit'](commitArgs); } catch (e) { thrown = e; }
    if (!thrown) return { ok: false, detail: 'commit 未抛错（期望抛错）' };
    const msg = thrown.message || String(thrown);
    if (args.errorContains && !msg.includes(args.errorContains)) return { ok: false, detail: `thrown msg="${msg.slice(0, 80)}" 不含 '${args.errorContains}'` };
    const fails = [];
    const pEntry = checkMetricsAndStatus(env, exp, fails);
    return { ok: true, detail: `threw msg="${msg.slice(0, 60)}" status=${pEntry && pEntry.status}` };
  }

  // happy path
  try {
    const c = await env.services['agint.mutator.commit'](commitArgs);
    const fails = [];
    if (c.ok !== exp.ok) fails.push(`ok=${c.ok} expected=${exp.ok}`);
    if (exp.policyDecision && c.policyDecision !== exp.policyDecision) fails.push(`policyDecision=${c.policyDecision} expected=${exp.policyDecision}`);
    const pEntry = checkMetricsAndStatus(env, exp, fails);
    return { ok: fails.length === 0, detail: fails.length === 0 ? `commit ok policyDecision=${c.policyDecision} status=${pEntry && pEntry.status}` : fails.join('; ') };
  } catch (e) {
    return { ok: false, detail: `commit 抛错: ${e.message || e}` };
  }
}

async function assertMetricEvent(env, args, exp) {
  if (!exp.eventTypeAllowed.includes(args.eventType)) return { ok: false, detail: `eventType=${args.eventType} ∉ ${JSON.stringify(exp.eventTypeAllowed)}` };
  try {
    await env.services['agint.mutator.logMetric']({ eventType: args.eventType, proposalId: 'p-test', commitId: 'c-test', source: 'attribution-driven', kind: 'PROMPT_MUTATION', atomicScope: 'prompt' });
    const metricEntries = Array.from(env.tables.metrics_log.values());
    if (metricEntries.length !== 1) return { ok: false, detail: `metrics_log=${metricEntries.length}（期望 1）` };
    if (metricEntries[0].eventType !== args.eventType) return { ok: false, detail: `eventType=${metricEntries[0].eventType} expected=${args.eventType}` };
    return { ok: true, detail: `metric dropped: ${args.eventType}` };
  } catch (e) {
    return { ok: false, detail: `logMetric 抛错: ${e.message || e}` };
  }
}

// ── 单 scenario 执行 ─────────────────────────────────────────────────────

async function runOne(scenario) {
  const input = scenario.input[0];
  const args = input.args ?? {};
  const exp = scenario.expected[0];

  if (input.action === 'pureFn') return assertPureFn(scenario, args, exp);

  if (input.action === 'serviceCall') {
    const svc = input.service;
    if (svc === 'agint.mutator.attributionDriven' || svc === 'agint.mutator.dreamRandom' || svc === 'agint.mutator.evolutionReversed') {
      return await assertSourceResult(args, exp, scenario.scenario);
    }
    if (svc === 'agint.mutator.commit' || svc === 'agint.mutator.rollback') {
      const env = makeFakeCtx({ sandboxOk: args.sandboxOk, policyDecision: args.policyDecision, writePreimage: args.writePreimage });
      try { return await assertCommit(env, args, exp, scenario.scenario); } finally { env.cleanup(); }
    }
    if (svc === 'agint.mutator.propose') {
      const env = makeFakeCtx({});
      try { return await assertPropose(env, args, exp); } finally { env.cleanup(); }
    }
    if (svc === 'agint.mutator.validate') {
      const env = makeFakeCtx({});
      try { return await assertValidate(env, args, exp); } finally { env.cleanup(); }
    }
    if (svc === 'agint.mutator.logMetric') {
      const env = makeFakeCtx({});
      try { return await assertMetricEvent(env, args, exp); } finally { env.cleanup(); }
    }
    return { ok: false, detail: `unsupported service='${svc}'` };
  }

  return { ok: false, detail: `unsupported action=${input.action}` };
}

// ── 主循环 ────────────────────────────────────────────────────────────────

const results = [];
console.log(`\n[agint-mutator eval] ${scenarios.length} scenarios\n`);
for (const sc of scenarios) {
  const { ok, detail } = await runOne(sc);
  const status = ok ? '✓ PASS' : '✗ FAIL';
  console.log(`${status}  ${sc.scenario.padEnd(48)} — ${detail}`);
  results.push({ name: sc.scenario, ok });
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n[summary] ${passed}/${results.length} PASS${failed > 0 ? `, ${failed} FAIL` : ''}`);

// 退出码语义化：failed === 0 → 0；否则 1（CI 友好）
process.exit(failed === 0 ? 0 : 1);