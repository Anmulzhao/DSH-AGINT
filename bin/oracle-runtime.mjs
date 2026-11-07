#!/usr/bin/env node
/**
 * bin/oracle-runtime.mjs —— 受控链路**端到端编排器**（接线主入口）
 *
 * 2026-11-07「开始接线，大胆一些」：把上一批三个纯函数模块真正接到
 * 真实 storages / 真实冻结集 / 真实插件 lib 上，串成一条可跑的链：
 *
 *   真实数据源 → B1 信封 → 五闸 → 真 sink（evolve.propose / curriculum.generate）
 *              → B2 离线回放 → C2 judge 通道 → 审计自省
 *
 * ⛔ 生产写入恒为 0：默认 sink 是 dry-run；真 sink 只能指向隔离演练域
 *    （assertRehearsalRoot 硬判据），本 CLI 永不置 approve=true。
 * ⛔ 不伪造真值：真实读数 0 条冻结标签 ⇒ labelAuthority=UNSET、G2 必拒；
 *    --rehearse 的合成真值只存在于内存信封，明确标 synthetic:true，
 *    绝不写进 eval/capability-baseline/sets/*.json。
 * ⛔ 不填人工标注、不改评分常量、不调 LLM、不挂 cordis、不连 3080。
 * ⛔ 判定权仍归外部冻结真值与授权人工；G5 撤销窗口与人类否决保留。
 *
 * 用法：
 *   node bin/oracle-runtime.mjs --storages <dir> --status
 *   node bin/oracle-runtime.mjs --storages <dir> --json
 *   node bin/oracle-runtime.mjs --storages <dir> --rehearse [--rehearsal-root <dir>]
 */

import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPrescriptionEnvelope, evaluateDeliveryAsync, DELIVERY_SCHEMA,
} from './oracle-prescription-delivery.mjs';
import { buildReplay } from './oracle-calibration-replay.mjs';
import { evaluateJudgeChannel } from './oracle-judge-channel.mjs';
import { evaluateAutonomousWrite, readSwitch } from './autonomous-write-gate.mjs';
import { readRuntimeSources, SOURCES_SCHEMA } from './oracle-runtime-sources.mjs';
import {
  makeDryRunSink, makeEvolveSink, makeCurriculumSink,
  assertRehearsalRoot, describeSinks, SINKS_SCHEMA,
} from './oracle-runtime-sinks.mjs';

export const RUNTIME_SCHEMA = '1.0';
export const DEFAULT_REHEARSAL_PARENT = '/home/kylin/projects/DSH/.oracle-rehearsal';
export const VETO_WINDOW_HOURS = 24;

/** ⛔ 合成真值只用于演练：绝不落盘到冻结集，绝不冒充已锚定。 */
export const SYNTHETIC_ANCHOR = Object.freeze({
  labelAuthority: 'GOLD',
  frozenLabelCount: 1,
  verifiedBy: 'capability-baseline',
  evidenceRef: 'SYNTHETIC_REHEARSAL_ONLY: 演练假设真值，未写入任何冻结集',
  synthetic: true,
});

export const SYNTHETIC_PRESCRIPTION = Object.freeze({
  id: 'rehearsal-synthetic-prescription-001',
  target: 'proposal_queue',
  predictedDelta: 0,
  predictedDeltaSource: 'SYNTHETIC_REHEARSAL: 演练用可证伪预测占位，不是真实处方',
  body: '［演练］若外部冻结真值到位、开关显式打开且 G5 未否决，本通道会把此候选投进提案队列；'
    + '本条不来自任何真实周报处方，不构成建议，也不代表系统判断。',
  asOf: null,
  synthetic: true,
});

/**
 * 由真实读数构造一份完整执行计划。**不写任何东西**。
 * @param {object} sources readRuntimeSources() 的结果
 * @param {{synthetic?:boolean, switchOn?:boolean|null, env?:object,
 *          humanVeto?:boolean, emergencyStop?:boolean, vetoWindowHours?:number}} opts
 */
export function buildRuntimePlan(sources, opts = {}) {
  const {
    synthetic = false,
    switchOn = null,
    env = {},
    humanVeto = false,
    emergencyStop = false,
    vetoWindowHours = VETO_WINDOW_HOURS,
  } = opts;

  const s = sources && typeof sources === 'object' ? sources : {};
  const sw = switchOn === null ? (s.switch?.on ?? readSwitch(env)) : switchOn === true;

  // ── 处方：真实数据里没有正文（只存计数）⇒ 如实记为缺口 ──────────────
  const prescription = synthetic
    ? { ...SYNTHETIC_PRESCRIPTION }
    : null;
  const prescriptionReason = synthetic
    ? 'SYNTHETIC_REHEARSAL: 演练用合成处方，非真实周报产出'
    : (s.oracle?.prescriptionCandidates?.reason ?? 'NO_PRESCRIPTION_BODY_STORED');

  // ── 锚：真实读数 or 演练合成（⛔ 合成绝不写冻结集）────────────────────
  const anchor = synthetic
    ? { ...SYNTHETIC_ANCHOR }
    : {
      labelAuthority: s.anchor?.labelAuthority ?? 'UNSET',
      frozenLabelCount: s.anchor?.frozenLabels?.value ?? null,
      verifiedBy: s.anchor?.verifiedBy ?? 'capability-baseline',
      evidenceRef: s.anchor?.evidenceRef ?? 'UNKNOWN',
      synthetic: false,
    };

  // ── B1：信封 + 五闸 ────────────────────────────────────────────────
  const envelopeResult = prescription
    ? buildPrescriptionEnvelope(prescription, anchor)
    : { ok: false, reason: prescriptionReason, writes: 0 };

  const gateProbe = evaluateAutonomousWrite({
    labelAuthority: anchor.labelAuthority,
    target: prescription?.target ?? 'proposal_queue',
    predictedDelta: prescription?.predictedDelta ?? 0,
    predictedDeltaSource: prescription?.predictedDeltaSource ?? '无处方',
    humanVeto,
    emergencyStop,
    vetoWindowHours,
  }, { switchOn: sw });

  // ── B2：真实周样本离线回放（不落参数）────────────────────────────────
  const replay = buildReplay({
    samples: s.annotations?.samples ?? [],
    candidateSpec: null,
  });

  // ── C2：notes-only 通道就绪度（契约已接线，独立 preset 仍未建）────────
  const judge = evaluateJudgeChannel({
    frozenLabels: s.anchor?.frozenLabels?.value ?? null,
    d1d5Approved: false,
    independentPresetReady: false,
    notesOnlyContractWired: true, // 本批已把 notes-only 信封接进编排器
  });

  const blockers = [];
  if (!sw) blockers.push(`G1_SWITCH_OFF: ${s.switch?.envVar ?? 'AGINT_ORACLE_AUTONOMOUS_WRITE'} 未显式打开（默认关闭）`);
  if (anchor.labelAuthority === 'UNSET' || (anchor.frozenLabelCount ?? 0) <= 0) {
    blockers.push('G2_NO_EXTERNAL_TRUTH: 0 条外部冻结标签 ⇒ labelAuthority=UNSET，G2 必拒');
  }
  if (!s.oracle?.domainOk) blockers.push(`ORACLE_DOMAIN_UNAVAILABLE: ${s.oracle?.domainReason ?? '无数据'}`);
  if (!synthetic && !prescription) blockers.push(`B1_NO_ELIGIBLE_PRESCRIPTION: ${prescriptionReason}`);
  if (replay.verdict !== 'REPLAY_READY_FOR_HUMAN_REVIEW') {
    blockers.push(`B2_${replay.verdict}: 人工标注周数不足 / 维度 unidentifiable ⇒ 不落任何参数`);
  }
  for (const b of judge.blockers) blockers.push(`C2_${b}`);

  return {
    schemaVersion: RUNTIME_SCHEMA,
    sourcesSchema: SOURCES_SCHEMA,
    deliverySchema: DELIVERY_SCHEMA,
    sinksSchema: SINKS_SCHEMA,
    synthetic,
    productionStorages: s.productionStorages ?? null,
    switchOn: sw,
    prescription: prescription ? { ...prescription } : null,
    prescriptionReason,
    anchor,
    envelope: envelopeResult.ok ? envelopeResult.envelope : null,
    envelopeResult,
    gateProbe,
    replay,
    judge,
    veto: { humanVeto, emergencyStop, vetoWindowHours },
    blockers,
    // ⛔ 恒定值：这一层不产生任何生产写入。
    writesToProduction: 0,
    frozenSetsWritten: 0,
    scoringConstantsWritten: 0,
    humanAnnotationsWritten: 0,
    llmCalls: 0,
    disclaimer: '接线只连通链路，不放宽判定权：真值冻结、人工标注、D1–D5 拍板、G1 开关与 G5 否决仍归人。'
      + ' 演练合成真值不写冻结集、不构成已锚定。',
  };
}

/**
 * 执行计划。默认 dry-run sink ⇒ 零写入；真 sink 由调用方显式注入。
 * @returns {Promise<object>} 报告（含每一步状态与写入计数）
 */
export async function executeRuntimePlan(plan, options = {}) {
  const {
    sink = null,
    sinkKind = null,
    switchOn = null,
    env = {},
    humanVeto = null,
    emergencyStop = null,
    vetoWindowHours = null,
  } = options;

  const p = plan && typeof plan === 'object' ? plan : {};
  const dry = sink === null ? makeDryRunSink() : null;
  const effectiveSink = dry ? dry.sink : sink;
  const kind = dry ? 'dry-run' : (sinkKind ?? 'injected');

  const delivery = await evaluateDeliveryAsync(p.envelope ?? null, {
    env,
    switchOn: switchOn === null ? p.switchOn : switchOn,
    sink: effectiveSink,
    humanVeto: humanVeto ?? p.veto?.humanVeto ?? false,
    emergencyStop: emergencyStop ?? p.veto?.emergencyStop ?? false,
    vetoWindowHours: vetoWindowHours ?? p.veto?.vetoWindowHours ?? VETO_WINDOW_HOURS,
  });

  return {
    schemaVersion: RUNTIME_SCHEMA,
    synthetic: p.synthetic === true,
    sinkKind: kind,
    sinkGuard: dry ? { ok: true, reason: 'dry-run，不涉及磁盘' } : null,
    delivery,
    recordedEnvelopes: dry ? dry.recorded.length : 0,
    steps: [
      { id: 'sources', status: 'READ', note: '真实 storages / 冻结集 / 开关只读接入' },
      { id: 'B1_envelope', status: p.envelopeResult?.ok ? 'BUILT' : 'REJECTED', note: p.envelopeResult?.reason ?? '' },
      { id: 'five_gates', status: p.gateProbe?.allowed ? 'ALLOWED' : 'DEFAULT_DENY', note: p.gateProbe?.reason ?? '' },
      { id: 'sink', status: delivery.status, note: delivery.reason },
      { id: 'B2_replay', status: p.replay?.verdict ?? 'UNKNOWN', note: 'writes=0 / applied=false' },
      { id: 'C2_judge', status: p.judge?.status ?? 'UNKNOWN', note: 'llmCalls=0 / verdict 仅 notes-only' },
    ],
    blockers: p.blockers ?? [],
    // ⛔ 四个恒定零：无论演练怎么跑，都不碰生产对象与判定真值。
    writesToProduction: 0,
    frozenSetsWritten: 0,
    scoringConstantsWritten: 0,
    humanAnnotationsWritten: 0,
    llmCalls: 0,
    writes: delivery.writes,
    disclaimer: p.disclaimer ?? '',
  };
}

/** --status 自省：接线到哪一步、还差什么、打开后会往哪写。 */
export function buildStatus(sources, plan) {
  return {
    schemaVersion: RUNTIME_SCHEMA,
    wiring: 'CONNECTED',
    runtimeDefault: 'OFF',
    sources: {
      storagesRoot: sources.storagesRoot,
      productionStorages: sources.productionStorages,
      oracleDomainOk: sources.oracle.domainOk,
      broadcasts: sources.oracle.broadcasts,
      weeklyCount: sources.oracle.weeklyCount,
      weeklyProposalCount: sources.oracle.weeklyProposalCount,
      prescriptionCandidates: sources.oracle.prescriptionCandidates,
      historicalPrescriptions: {
        total: sources.oracle.historical.total,
        eligible: sources.oracle.historical.eligible,
        missingFields: sources.oracle.historical.missingFields,
        statusDistribution: sources.oracle.historical.statusDistribution,
      },
      crossCheck: sources.oracle.crossCheck,
      annotationWeeks: sources.annotations.independentWeeks,
      frozenLabels: sources.anchor.frozenLabels,
      labelAuthority: sources.anchor.labelAuthority,
      switch: sources.switch,
    },
    sinks: describeSinks(),
    plan: {
      envelope: plan.envelopeResult.ok ? 'BUILT' : plan.envelopeResult.reason,
      gate: plan.gateProbe.allowed ? 'ALLOWED' : `DEFAULT_DENY — ${plan.gateProbe.reason}`,
      replayVerdict: plan.replay.verdict,
      judge: plan.judge.status,
      blockers: plan.blockers,
    },
    veto: { ...plan.veto, entry: '--veto 可把 humanVeto 置 true（G5 立即拒绝投递）' },
    guards: {
      defaultSink: 'dry-run（零写入）',
      rehearsalRootGuard: 'assertRehearsalRoot：未 approve 禁止指向生产 storages',
      statusQuo: 'writesToProduction=0 / frozenSetsWritten=0 / scoringConstantsWritten=0 / humanAnnotationsWritten=0 / llmCalls=0',
    },
  };
}

/** 演练：合成真值 + 隔离域 + 真 sink，写入后回读验证。 */
export async function runRehearsal(sources, { rehearsalRoot = null, target = 'proposal_queue' } = {}) {
  const root = rehearsalRoot
    ? resolve(rehearsalRoot)
    : join(DEFAULT_REHEARSAL_PARENT, `run-${Date.now()}`, 'storages');

  // assertRehearsalRoot 不自动建目录 ⇒ 先建隔离域，再用**真实路径**复核硬判据。
  mkdirSync(root, { recursive: true });
  const checked = assertRehearsalRoot(root, sources.productionStorages, { approve: false });
  if (!checked.ok) {
    return { ok: false, reason: checked.reason, writesToProduction: 0, rehearsalRoot: root };
  }

  const plan = buildRuntimePlan(sources, { synthetic: true, switchOn: true });
  const real = target === 'curriculum_challenge_queue'
    ? makeCurriculumSink({ storages: root, productionStorages: sources.productionStorages, approve: false })
    : makeEvolveSink({ storages: root, productionStorages: sources.productionStorages, approve: false });

  const report = await executeRuntimePlan(plan, {
    sink: real.sink,
    sinkKind: real.kind,
    switchOn: true,
  });

  // 回读验证：真 sink 是否真的把记录写进了隔离域。
  const domainFile = join(root, target === 'curriculum_challenge_queue' ? 'agint_curriculum.json' : 'agint_evolve.json');
  let persisted = 0;
  if (existsSync(domainFile)) {
    try {
      const data = JSON.parse(readFileSync(domainFile, 'utf8'));
      const tables = data.tables ?? {};
      const rows = Object.values(tables.proposal ?? tables.challenges ?? {});
      persisted = rows.filter((r) => r && (r.source === 'oracle-gated-runtime' || r.status === 'proposed')).length;
    } catch { /* 读不出就是 0，如实 */ }
  }

  return {
    ...report,
    ok: report.delivery.delivered === true && persisted > 0,
    rehearsal: {
      root,
      domainFile,
      persistedRecords: persisted,
      syntheticTruth: true,
      frozenSetsWritten: 0,
      writesToProduction: 0,
      note: '⛔ 合成真值只存在于内存信封，未写入任何冻结集；演练写入全部落在此隔离域，生产 storages 未被触碰。',
    },
    sinkGuard: real.guard,
  };
}

function renderText(out) {
  const L = [];
  if (out.rehearsal) {
    L.push('受控链路 · 端到端演练（隔离域真写入）');
    L.push(`  结果：${out.ok ? '✓ 链路跑通' : 'x 未跑通'} ｜ sink=${out.sinkKind} ｜ 判词=${out.delivery.status}`);
    L.push(`  隔离域写入 ${out.writes} 条，回读验证 ${out.rehearsal.persistedRecords} 条 ｜ 域文件 ${out.rehearsal.domainFile}`);
    L.push(`  ⛔ 生产写入 ${out.writesToProduction} ／ 冻结集写入 ${out.frozenSetsWritten} ／ 评分常量 ${out.scoringConstantsWritten} ／ 人工标注 ${out.humanAnnotationsWritten} ／ LLM ${out.llmCalls}`);
    L.push(`  合成真值：${out.synthetic}（仅内存信封，${out.rehearsal.note}）`);
    if (!out.ok) L.push(`  失败原因：${out.delivery.reason}`);
  } else if (out.wiring) {
    L.push('受控链路 · 接线状态（--status）');
    L.push(`  接线：${out.wiring} ｜ 运行态默认：${out.runtimeDefault} ｜ 默认 sink：${out.guards.defaultSink}`);
    L.push(`  真实读数：广播 ${out.sources.broadcasts} 条 / weekly ${out.sources.weeklyCount} 周 / 回流计数 ${out.sources.weeklyProposalCount}`);
    L.push(`  历史处方：evolve.proposal 里 oracle 源 ${out.sources.historicalPrescriptions.total} 条，满足受控投递契约 ${out.sources.historicalPrescriptions.eligible} 条`
      + ` ｜ 缺字段 [${out.sources.historicalPrescriptions.missingFields.join(', ') || '无'}]`);
    L.push(`  交叉对拍：广播 ${out.sources.crossCheck.broadcastWeeklyProposalCount} vs evolve ${out.sources.crossCheck.evolveOracleProposals}`
      + ` ⇒ ${out.sources.crossCheck.consistent ? '一致' : '不一致'}`);
    L.push(`  冻结标签 ${JSON.stringify(out.sources.frozenLabels.value)} ｜ labelAuthority=${out.sources.labelAuthority} ｜ G1 ${out.sources.switch.on ? 'ON' : 'OFF'}`);
    L.push(`  B1 信封：${out.plan.envelope}`);
    L.push(`  五闸：${out.plan.gate}`);
    L.push(`  B2：${out.plan.replayVerdict} ｜ C2：${out.plan.judge} ｜ 撤销窗口 ${out.veto.vetoWindowHours}h`);
    L.push('  仍缺（需人给真值/拍板）：');
    for (const b of out.plan.blockers) L.push(`    x ${b}`);
    L.push(`  ⛔ ${out.guards.statusQuo}`);
  } else {
    L.push('受控链路 · 默认执行（dry-run）');
    L.push(`  判词：${out.delivery.status} ｜ sink=${out.sinkKind} ｜ 写入 ${out.writes} 条 ｜ 记录信封 ${out.recordedEnvelopes} 个`);
    L.push(`  原因：${out.delivery.reason}`);
    L.push('  链路步骤：');
    for (const s of out.steps) L.push(`    ${s.id}: ${s.status}${s.note ? ` — ${s.note}` : ''}`);
    L.push(`  ⛔ 生产写入 ${out.writesToProduction} ／ 冻结集 ${out.frozenSetsWritten} ／ 评分常量 ${out.scoringConstantsWritten} ／ 标注 ${out.humanAnnotationsWritten} ／ LLM ${out.llmCalls}`);
  }
  return `${L.join('\n')}\n`;
}

function parseArgs(argv) {
  const o = { status: false, json: false, rehearse: false, storages: null, sets: null, rehearsalRoot: null, veto: false, target: 'proposal_queue' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--status') o.status = true;
    else if (a === '--json') o.json = true;
    else if (a === '--rehearse') o.rehearse = true;
    else if (a === '--veto') o.veto = true;
    else if (a === '--storages') o.storages = argv[++i] ?? null;
    else if (a === '--sets') o.sets = argv[++i] ?? null;
    else if (a === '--rehearsal-root') o.rehearsalRoot = argv[++i] ?? null;
    else if (a === '--target') o.target = argv[++i] ?? 'proposal_queue';
    else throw new Error(`未知参数：${a}`);
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

  if (o.rehearse) {
    const out = await runRehearsal(sources, { rehearsalRoot: o.rehearsalRoot, target: o.target });
    process.stdout.write(o.json ? `${JSON.stringify(out, null, 2)}\n` : renderText(out));
    return out;
  }

  const plan = buildRuntimePlan(sources, { env, humanVeto: o.veto });
  if (o.status) {
    const out = buildStatus(sources, plan);
    process.stdout.write(o.json ? `${JSON.stringify(out, null, 2)}\n` : renderText(out));
    return out;
  }

  const out = await executeRuntimePlan(plan, { env });
  process.stdout.write(o.json ? `${JSON.stringify(out, null, 2)}\n` : renderText(out));
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
}
