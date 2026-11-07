#!/usr/bin/env node
/**
 * bin/oracle-live-tick.mjs —— 受控链路「运行态点亮」心跳
 *
 * 2026-11-07「现在就让链路真正亮起来」：把此前只靠手动 CLI / 隔离域演练
 * 的链路接进**真实运行节奏**。每次心跳读真实 storages、真实冻结集、真实开关，
 * 走完整 B1 → 五闸 → sink → B2 → C2，逐闸留痕并追加可审计 ledger。
 *
 * ⛔ 四个恒定零：生产 storages 写入 / 冻结集写入 / 评分常量写入 / 人工标注写入
 *    恒为 0；默认 sink 仍是 dry-run；LLM 调用 0。
 * ⛔ 不伪造外部真值：0 条 GOLD/HELDOUT ⇒ labelAuthority=UNSET、G2 必拒；
 *    SILVER 自评永远不算锚定。
 * ⛔ 不替人填标注、不构造合格处方；**无合法信封时 G4 明文判 fail**，
 *    绝不拿 predictedDelta=0 的占位值冒充可证伪预测。
 * ⛔ --switch on 只在**本次进程**打开 G1，绝不改默认配置（默认恒 OFF）。
 * ⛔ ledger 只能写在生产 storages 之外（assertLedgerOutsideProduction 硬判据）。
 *
 * 用法：
 *   node bin/oracle-live-tick.mjs --storages <dir> --switch on --json
 *   node bin/oracle-live-tick.mjs --storages <dir> --status
 *   node bin/oracle-live-tick.mjs --storages <dir> --switch on --quiet   # 调度用
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRuntimeSources } from './oracle-runtime-sources.mjs';
import {
  buildRuntimePlan, executeRuntimePlan, RUNTIME_SCHEMA, VETO_WINDOW_HOURS,
} from './oracle-runtime.mjs';
import {
  evaluateAutonomousWrite, readSwitch, AUTONOMOUS_WRITE_SWITCH_ENV,
} from './autonomous-write-gate.mjs';

export const LIVE_SCHEMA = '1.0';
export const LEDGER_MAX_LINES = 240;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** ledger 默认落 DSH_HOME 旁的独立目录，⛔ 不进仓库（否则每小时把 git 弄脏）。 */
export function defaultLedgerPath(env = process.env) {
  const home = env.DSH_HOME || env.AGINT_DATA_HOME;
  return home
    ? resolve(home, '.oracle-live', 'live-ledger.jsonl')
    : resolve(REPO_ROOT, 'eval', 'gated-features', 'live-ledger.jsonl');
}

/** ⛔ 硬判据：审计台账绝不允许写进生产 storages 域。 */
export function assertLedgerOutsideProduction(ledgerPath, productionStorages) {
  const p = resolve(ledgerPath);
  const root = productionStorages ? resolve(productionStorages) : null;
  if (root && (p === root || p.startsWith(`${root}${sep}`))) {
    throw new Error(`LEDGER_IN_PRODUCTION_STORAGES: ${p} 位于生产 storages 内，拒绝写入`);
  }
  return { ok: true, path: p };
}

/**
 * 诚实逐闸输入：只有 B1 信封真的造出来，G4 才有预测可判。
 * ⛔ 无信封 ⇒ predictedDelta=null / source='' ⇒ G4 必 fail，不拿占位 0 冒充。
 */
export function buildLiveGateInput(plan) {
  const ok = plan?.envelopeResult?.ok === true;
  const env = plan?.envelope ?? null;
  return {
    labelAuthority: plan?.anchor?.labelAuthority ?? 'UNSET',
    target: (ok ? env?.target : plan?.prescription?.target) ?? 'proposal_queue',
    predictedDelta: ok ? env.predictedDelta : null,
    predictedDeltaSource: ok ? env.predictedDeltaSource : '',
    humanVeto: plan?.veto?.humanVeto ?? false,
    emergencyStop: plan?.veto?.emergencyStop ?? false,
    vetoWindowHours: plan?.veto?.vetoWindowHours ?? VETO_WINDOW_HOURS,
  };
}

/** 跑一次完整心跳。**只读真实源 + dry-run sink**，不写任何生产对象。 */
export async function buildLiveReport(sources, opts = {}) {
  const { switchOn = null, env = {}, humanVeto = false, now = new Date() } = opts;
  const sw = switchOn === null ? (sources?.switch?.on ?? readSwitch(env)) : switchOn === true;

  const plan = buildRuntimePlan(sources, { env, switchOn: sw, humanVeto });
  const gate = evaluateAutonomousWrite(buildLiveGateInput(plan), { switchOn: sw });
  const run = await executeRuntimePlan(plan, { env, switchOn: sw });

  // plan.gateProbe 用占位预测做「现状探针」；心跳对外只报诚实逐闸结果，避免两套口径。
  const chain = run.steps.map((s) => (s.id === 'five_gates'
    ? { ...s, status: gate.allowed ? 'ALLOWED' : 'DEFAULT_DENY', note: gate.reason }
    : s));

  return {
    schemaVersion: LIVE_SCHEMA,
    runtimeSchema: RUNTIME_SCHEMA,
    ts: now.toISOString(),
    wiring: 'CONNECTED',
    powered: sw,
    runtimeDefault: 'OFF',
    switch: {
      envVar: AUTONOMOUS_WRITE_SWITCH_ENV,
      on: sw,
      scope: 'PROCESS_ONLY',
      detail: sw ? '本次进程显式打开；默认配置仍为 OFF' : '默认关闭',
    },
    sources: {
      storagesRoot: sources?.storagesRoot ?? null,
      productionStorages: sources?.productionStorages ?? null,
      oracleDomainOk: sources?.oracle?.domainOk ?? false,
      broadcasts: sources?.oracle?.broadcasts ?? null,
      weeklyCount: sources?.oracle?.weeklyCount ?? null,
      weeklyProposalCount: sources?.oracle?.weeklyProposalCount ?? null,
      eligiblePrescriptions: sources?.oracle?.prescriptionCandidates?.value ?? null,
      frozenLabels: sources?.anchor?.frozenLabels ?? null,
      labelAuthority: sources?.anchor?.labelAuthority ?? 'UNSET',
      annotationWeeks: sources?.annotations?.independentWeeks ?? null,
    },
    gates: {
      status: gate.allowed ? 'ALL_GATES_PASSED' : 'DEFAULT_DENY',
      reason: gate.reason,
      passed: gate.checks.filter((c) => c.passed).length,
      total: gate.checks.length,
      failedIds: gate.checks.filter((c) => !c.passed).map((c) => c.id),
      checks: gate.checks.map((c) => ({ id: c.id, passed: c.passed, detail: c.detail })),
    },
    chain,
    delivery: {
      status: run.delivery.status,
      reason: run.delivery.reason,
      writes: run.delivery.writes,
    },
    replayVerdict: plan.replay?.verdict ?? null,
    judgeStatus: plan.judge?.status ?? null,
    blockers: plan.blockers ?? [],
    writesToProduction: 0,
    frozenSetsWritten: 0,
    scoringConstantsWritten: 0,
    humanAnnotationsWritten: 0,
    llmCalls: 0,
    disclaimer: '心跳只让链路通电并按真实节奏求值，不放宽判定权：G2 外部冻结金标、'
      + '人工标注、D1–D5 拍板与 G5 否决仍归人；生产写入恒 0。',
  };
}

/** 台账只存精简记录，避免把整份报告滚成膨胀文件。 */
export function ledgerRecord(report) {
  return {
    ts: report.ts,
    schema: report.schemaVersion,
    powered: report.powered,
    switchOn: report.switch.on,
    gate: report.gates.status,
    passed: report.gates.passed,
    total: report.gates.total,
    failed: report.gates.failedIds,
    envelope: report.chain.find((s) => s.id === 'B1_envelope')?.status ?? null,
    labelAuthority: report.sources.labelAuthority,
    eligiblePrescriptions: report.sources.eligiblePrescriptions,
    blockers: report.blockers.length,
    writes: report.delivery.writes,
    writesToProduction: report.writesToProduction,
  };
}

/** 追加一条心跳；超过上限滚动丢弃最老记录。⛔ 生产 storages 内直接抛错。 */
export function appendLedger(report, {
  ledgerPath = null, productionStorages = null,
  maxLines = LEDGER_MAX_LINES, env = process.env,
} = {}) {
  const guard = assertLedgerOutsideProduction(
    ledgerPath ?? defaultLedgerPath(env),
    productionStorages ?? report.sources.productionStorages,
  );
  let lines = [];
  if (existsSync(guard.path)) {
    try { lines = readFileSync(guard.path, 'utf8').split('\n').filter(Boolean); } catch { lines = []; }
  }
  lines.push(JSON.stringify(ledgerRecord(report)));
  const kept = lines.slice(-maxLines);
  mkdirSync(dirname(guard.path), { recursive: true });
  writeFileSync(guard.path, `${kept.join('\n')}\n`, 'utf8');
  return {
    appended: true,
    path: guard.path,
    totalLines: kept.length,
    dropped: Math.max(0, lines.length - kept.length),
  };
}

export function readLedgerTail(ledgerPath = null, n = 5, env = process.env) {
  const p = resolve(ledgerPath ?? defaultLedgerPath(env));
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-n)
      .map((l) => JSON.parse(l));
  } catch { return []; }
}

/** 心跳活性：以 ledger 最后一条时间为准，2h 内算 LIVE。⛔ 没跑过绝不假报活性。 */
export function deriveHeartbeat(tail, now = new Date()) {
  if (!Array.isArray(tail) || tail.length === 0) {
    return { status: 'NEVER_RUN', lastTs: null, ageHours: null, ticks: 0 };
  }
  const last = tail[tail.length - 1];
  const t = Date.parse(last?.ts ?? '');
  if (Number.isNaN(t)) return { status: 'UNKNOWN', lastTs: last?.ts ?? null, ageHours: null, ticks: tail.length };
  const ageHours = Math.max(0, (now.getTime() - t) / 3600000);
  return {
    status: ageHours <= 2 ? 'LIVE' : 'STALE',
    lastTs: last.ts,
    ageHours: Math.round(ageHours * 100) / 100,
    ticks: tail.length,
  };
}

function renderText(out) {
  const L = [];
  L.push('受控链路 · 运行态心跳');
  L.push(`  接线 ${out.wiring} ｜ 通电 ${out.powered ? 'ON' : 'OFF'}（${out.switch.detail}）｜ 默认配置恒 ${out.runtimeDefault}`);
  L.push(`  真实读数：广播 ${out.sources.broadcasts} 条 / weekly ${out.sources.weeklyCount} 周 / 回流 ${out.sources.weeklyProposalCount}`);
  L.push(`  冻结标签 ${JSON.stringify(out.sources.frozenLabels?.value ?? null)} ｜ labelAuthority=${out.sources.labelAuthority} ｜ 合格处方 ${out.sources.eligiblePrescriptions}`);
  L.push('  五闸逐闸：');
  for (const c of out.gates.checks) L.push(`    ${c.passed ? '✓' : 'x'} ${c.id}: ${c.detail}`);
  L.push(`  判词 ${out.gates.status}（${out.gates.passed}/${out.gates.total} 通过，未过 ${out.gates.failedIds.join(', ') || '无'}）`);
  L.push('  链路：');
  for (const s of out.chain) L.push(`    ${s.id}: ${s.status}${s.note ? ` — ${s.note}` : ''}`);
  L.push(`  ⛔ 生产写入 ${out.writesToProduction} ／ 冻结集 ${out.frozenSetsWritten} ／ 评分常量 ${out.scoringConstantsWritten} ／ 标注 ${out.humanAnnotationsWritten} ／ LLM ${out.llmCalls}`);
  if (out.heartbeat) {
    L.push(`  心跳活性：${out.heartbeat.status} ｜ 最近 ${out.heartbeat.lastTs ?? '无'} ｜ 台账 ${out.heartbeat.ticks} 条`);
  }
  if (out.ledger?.appended) L.push(`  审计台账：${out.ledger.path}（${out.ledger.totalLines} 条）`);
  L.push('  仍缺（判定权归人，不代填）：');
  for (const b of out.blockers) L.push(`    x ${b}`);
  return `${L.join('\n')}\n`;
}

function parseArgs(argv) {
  const o = {
    json: false, quiet: false, noLedger: false, status: false, veto: false,
    storages: null, sets: null, ledger: null, switchOn: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--no-ledger') o.noLedger = true;
    else if (a === '--status') o.status = true;
    else if (a === '--veto') o.veto = true;
    else if (a === '--storages') o.storages = argv[++i] ?? null;
    else if (a === '--sets') o.sets = argv[++i] ?? null;
    else if (a === '--ledger') o.ledger = argv[++i] ?? null;
    else if (a === '--switch') {
      const v = argv[++i];
      if (v !== 'on' && v !== 'off') throw new Error(`--switch 只接受 on/off，收到 ${JSON.stringify(v)}`);
      o.switchOn = v === 'on';
    } else throw new Error(`未知参数：${a}`);
  }
  return o;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const o = parseArgs(argv);
  const sources = readRuntimeSources({
    storages: o.storages,
    ...(o.sets ? { setsDir: o.sets } : {}),
    env,
  });
  const report = await buildLiveReport(sources, {
    switchOn: o.switchOn, env, humanVeto: o.veto,
  });

  if (o.status) {
    const tail = readLedgerTail(o.ledger, 5, env);
    const out = { ...report, ledger: { appended: false, tail }, heartbeat: deriveHeartbeat(tail) };
    if (!o.quiet) process.stdout.write(o.json ? `${JSON.stringify(out, null, 2)}\n` : renderText(out));
    return out;
  }

  if (o.noLedger) {
    report.ledger = { appended: false, reason: '--no-ledger' };
  } else {
    report.ledger = appendLedger(report, {
      ledgerPath: o.ledger,
      productionStorages: sources.productionStorages,
      env,
    });
  }
  if (!o.quiet) process.stdout.write(o.json ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
}
