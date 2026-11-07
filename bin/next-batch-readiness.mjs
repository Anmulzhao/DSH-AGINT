#!/usr/bin/env node
/**
 * bin/next-batch-readiness.mjs —— B1 / B2 / C2 的只读就绪度清单
 *
 * 2026-11-07 老板批准「1 开工 / 2 按建议 / 3 放宽」后，C1→A2→A3→A1 已落地，
 * 但 B1（处方回流）、B2（判尺自标定）、C2（LLM-as-Judge）各自被**硬前置**挡着：
 *   B1 五闸默认拒绝，且冻结标签 0 条 ⇒ 无 GOLD/HELDOUT 可过 G2
 *   B2 阈值拟合需 ≥4 已标注周、权重需 ≥5，现为 0
 *   C2 前置 C1 阶段 2/3（D1–D5 拍板 + 外部真值）未开工
 *
 * ⛔ 本脚本**不执行** B1/B2/C2：三项的只读实现见 bin/oracle-*.mjs
 *    （2026-11-07「实现功能但守住闸门」档，默认关闭、运行态零写入）。
 *    它只把「为什么现在还不能接线」做成可复跑、可验收的判据 —— 防止下一批
 *    在缺真值时先动手，重演「分数涨到 99.9 而能力证据为空」。
 *    ⛔ implementation.available=true 只说明「代码存在」，不改变 READY 判定。
 * ⛔ 三态纪律：数据缺失 ⇒ { value:null, reason }，绝不拿 0 冒充「查过了没有」。
 * ⛔ 存储根不显式给就报错，拒绝 fallback 到 ~/.dsh（本机最常见的假绿）。
 *
 * 用法：
 *   node bin/next-batch-readiness.mjs --storages <dir> [--sets <dir>] [--json] [--out <file>]
 *   DSH_HOME=<数据根> node bin/next-batch-readiness.mjs --json
 */

import { writeFileSync } from 'node:fs';
import { resolveStorages, readDomain, oracleEvidence, FIT_GATES, ok, noData } from './evolution-evidence.mjs';
import { verifyBaseline, DEFAULT_SETS_DIR, EXTERNAL_AUTHORITIES } from './capability-baseline.mjs';
import { evaluateAutonomousWrite, readSwitch, AUTONOMOUS_WRITE_SWITCH_ENV } from './autonomous-write-gate.mjs';

export const READINESS_SCHEMA = '1.1';

/** 一项就绪度：blockers 为空才 READY；三态读数全走 ok/noData。 */
function item(id, name, blockers, metrics, note) {
  return {
    id, name,
    status: blockers.length === 0 ? 'READY' : 'BLOCKED',
    blockers,
    metrics,
    note,
  };
}

/**
 * 计算三项就绪度。
 * @param {{oracle?:object, setsDir?:string, env?:object, switchOn?:boolean}} input
 */
export function buildReadiness({
  oracle = null,
  setsDir = DEFAULT_SETS_DIR,
  env = process.env,
  switchOn = null,
} = {}) {
  const sw = switchOn === null ? readSwitch(env) : switchOn === true;

  // ── 冻结基准（B1 的 G2、C2 的真值都依赖它） ──────────────────────────────
  const baseline = verifyBaseline(setsDir);
  const frozen = baseline.usableFrozenLabels; // { value, reason, sampleSize }

  // ── 判尺标注（B2） ───────────────────────────────────────────────────────
  const oracleOk = oracle && oracle.ok === true;
  // ⛔ oracleEvidence 的第二参数是 domainStatus（形如 { agint_aesthetic_oracle: { ok, reason } }）。
  //    漏传会让整组指标走 unavailable ⇒ 把「查过 N 周、0 标注」谎报成「没测过」，
  //    正好违反三态纪律；readDomain() 返回的是 { ok, reason, tables, rows }，需显式包装。
  const oracleMetrics = oracleOk
    ? oracleEvidence(oracle.tables, { agint_aesthetic_oracle: { ok: true, reason: oracle.reason ?? '' } })
    : null;
  const verdictWeeks = oracleMetrics ? oracleMetrics.annotatedVerdictWeeks : noData('ORACLE_DOMAIN_UNAVAILABLE: 读不到 agint_aesthetic_oracle 存储域');
  const overallWeeks = oracleMetrics ? oracleMetrics.annotatedOverallWeeks : noData('ORACLE_DOMAIN_UNAVAILABLE: 读不到 agint_aesthetic_oracle 存储域');
  const independentWeeks = oracleMetrics ? oracleMetrics.independentWeeks : noData('ORACLE_DOMAIN_UNAVAILABLE');

  // ── B1：五闸实跑一次「候选处方」 ─────────────────────────────────────────
  // 用最有利的合法参数（目标白名单内、有可证伪预测、有撤销窗口、无人否决），
  // 只把外部锚定留成真实现状 ⇒ 若这样都拒，就不是参数没配好，而是真值确实缺。
  const candidateLabel = frozen.value === 0 ? 'UNSET' : (frozen.value === null ? null : EXTERNAL_AUTHORITIES[0]);
  const gate = evaluateAutonomousWrite({
    labelAuthority: candidateLabel,
    target: 'proposal_queue',
    predictedDelta: 0, // 有限数即可；真正的 predictedDelta 由处方生成器给
    predictedDeltaSource: 'next-batch-readiness 探针（非真实处方）',
    humanVeto: false,
    emergencyStop: false,
    vetoWindowHours: 24,
  }, { switchOn: sw });

  const b1Blockers = gate.checks.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`);
  if (frozen.value === 0) {
    b1Blockers.push('NO_FROZEN_LABELS: 0 条外部冻结标签 ⇒ 处方没有可对照的外部真值，actualDelta 无法判定');
  } else if (frozen.value === null) {
    b1Blockers.push(`FROZEN_SETS_UNREADABLE: ${frozen.reason}`);
  }

  const b1 = item('B1', '日报产「处方」回流 curriculum / evolve', b1Blockers, {
    switchOn: ok(sw, 1),
    frozenLabels: frozen,
    gateAllowed: ok(gate.allowed, gate.checks.length),
    gateChecks: ok(gate.checks.map((c) => ({ id: c.id, passed: c.passed })), gate.checks.length),
    gateReason: ok(gate.reason, 1),
  }, '放宽的是「受控自动投递」，不是判定权；五闸默认拒绝且刻意不读任何分数字段。'
    + `开关环境变量 ${AUTONOMOUS_WRITE_SWITCH_ENV} 须为字面量 on 才可能放行。`);

  // ── B2：判尺自标定的两个门槛 ─────────────────────────────────────────────
  const b2Blockers = [];
  if (verdictWeeks.value === null) b2Blockers.push(`ANNOTATION_UNKNOWN: ${verdictWeeks.reason}`);
  else if (verdictWeeks.value < FIT_GATES.thresholds) {
    b2Blockers.push(`阈值拟合需 ≥${FIT_GATES.thresholds} 个已标注 humanVerdict 周，现 ${verdictWeeks.value}（差 ${FIT_GATES.thresholds - verdictWeeks.value}）`);
  }
  if (overallWeeks.value === null) b2Blockers.push(`ANNOTATION_UNKNOWN: ${overallWeeks.reason}`);
  else if (overallWeeks.value < FIT_GATES.weights) {
    b2Blockers.push(`权重拟合需 ≥${FIT_GATES.weights} 个已标注 humanOverall 周，现 ${overallWeeks.value}（差 ${FIT_GATES.weights - overallWeeks.value}）`);
  }
  b2Blockers.push('redundancy / bloat 在现有样本上机器从未判为最丑 ⇒ unidentifiable，光堆周数也标不出这两维');
  b2Blockers.push('改 THRESHOLDS / DIM_WEIGHTS 会改 scaleHash ⇒ 历史分数必须分段，且须离线回放护栏 + 人工复核后才能落');

  const b2 = item('B2', '判尺自动标定（让尺子「一直在进化」）', b2Blockers, {
    independentWeeks,
    annotatedVerdictWeeks: verdictWeeks,
    annotatedOverallWeeks: overallWeeks,
    thresholdsGate: verdictWeeks.value === null ? noData(verdictWeeks.reason) : ok(verdictWeeks.value >= FIT_GATES.thresholds, verdictWeeks.value),
    weightsGate: overallWeeks.value === null ? noData(overallWeeks.reason) : ok(overallWeeks.value >= FIT_GATES.weights, overallWeeks.value),
  }, '0 标注是查过的真 0，不是「没测过」。并列最优多组时不得挑一个当答案。');

  // ── C2：judge 通道的前置 ────────────────────────────────────────────────
  const c2Blockers = [
    'C1 仅重启到阶段 1（纯函数，不挂载不建域）；阶段 2/3 的 D1–D5 尚未拍板',
    '无外部冻结真值 ⇒ judge 没有可对照的金标，自评只能当假设生成器、不能当裁判',
    '独立 preset / 独立会话尚未建立；verdict 只进 notes 的写入契约尚未接线',
  ];
  const c2 = item('C2', '独立 preset 的 LLM-as-Judge 通道', c2Blockers, {
    frozenLabels: frozen,
    externalTruthAvailable: frozen.value === null ? noData(frozen.reason) : ok(frozen.value > 0, frozen.value),
    judgeVerdictScope: ok('notes-only', 1),
  }, '⛔ 即使通道建好，verdict 也只当假设：不得进 METRIC_DEFS / 指标存储 / 四维计算 / aesthetic_score / Q1·Q2·阈值（§9.5）。');

  const items = [b1, b2, c2];
  const ready = items.filter((x) => x.status === 'READY').length;
  return {
    generatedAt: new Date().toISOString(),
    schemaVersion: READINESS_SCHEMA,
    overall: ready === items.length ? 'ALL_READY' : ready === 0 ? 'ALL_BLOCKED' : 'PARTIAL',
    readyCount: ready,
    blockedCount: items.length - ready,
    items,
    // 2026-11-07「实现功能但守住闸门」：三项只读实现已就位，但运行态默认关闭。
    // ⛔ 这个字段是**状态说明**，不参与 overall 判定 —— 代码存在不等于前置齐备。
    implementation: {
      available: true,
      modules: {
        B1: 'bin/oracle-prescription-delivery.mjs',
        B2: 'bin/oracle-calibration-replay.mjs',
        C2: 'bin/oracle-judge-channel.mjs',
      },
      runtimeDefault: 'OFF',
      writesByDefault: 0,
      note: '三项功能代码已就位，但默认关闭、五闸不绕过、无默认 sink ⇒ 运行态零写入。'
        + 'READY 仍只由外部冻结真值 / 人工标注 / D1–D5 拍板决定，不因代码就位而变化。',
    },
    disclaimer: '本清单只判「前置是否齐备」，不执行 B1/B2/C2（只读实现见 bin/oracle-*.mjs，默认零写入），'
      + '不评估 AGINT 能力，不产出任何判定。BLOCKED 是设计结果，不是故障。',
  };
}

/** 渲染 markdown。 */
export function renderMarkdown(r) {
  const L = [];
  L.push('# B1 / B2 / C2 就绪度清单（只读）');
  L.push('');
  L.push(`生成：${r.generatedAt} ｜ 判据版本 ${r.schemaVersion} ｜ **${r.overall}**（READY ${r.readyCount} / BLOCKED ${r.blockedCount}）`);
  L.push('');
  L.push(`> ${r.disclaimer}`);
  L.push('');
  for (const it of r.items) {
    L.push(`## ${it.id} · ${it.name} — **${it.status}**`);
    L.push('');
    L.push(it.note);
    L.push('');
    L.push('读数（三态：无数据显示「无数据 + 原因」，不拿 0 冒充）：');
    L.push('');
    L.push('| 指标 | 值 | 样本量 |');
    L.push('|---|---|---|');
    for (const [k, m] of Object.entries(it.metrics)) {
      const v = m?.value === null || m?.value === undefined
        ? `无数据（${m?.reason ?? '原因缺失'}）`
        : (typeof m.value === 'object' ? JSON.stringify(m.value) : String(m.value));
      L.push(`| ${k} | ${v} | ${m?.sampleSize ?? '—'} |`);
    }
    L.push('');
    L.push(`阻塞项（${it.blockers.length}）：`);
    L.push('');
    for (const b of it.blockers) L.push(`- ${b}`);
    if (it.blockers.length === 0) L.push('- （无）');
    L.push('');
  }
  L.push('## 下一批开工判据');
  L.push('');
  L.push('1. 人工填完 6 周标注作业单，且 gold / verify / heldout 三份冻结集由人冻结标签；');
  L.push('2. 重跑本清单，`overall` 才可能从 `ALL_BLOCKED` 变化 —— 在此之前不写任何自动投递或自动标定逻辑；');
  L.push('3. 每次改动前后各跑一份 `bin/evolution-evidence.mjs --compare`，确认没有把「覆盖变好」误读成「能力变好」。');
  L.push('');
  return L.join('\n');
}

function parseArgs(argv) {
  const o = { json: false, out: null, storages: null, sets: DEFAULT_SETS_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--out') o.out = argv[++i] ?? null;
    else if (a === '--storages') o.storages = argv[++i] ?? null;
    else if (a === '--sets') o.sets = argv[++i] ?? null;
    else throw new Error(`未知参数：${a}`);
  }
  return o;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const storages = resolveStorages(opts.storages);
  const oracle = readDomain(storages, 'agint_aesthetic_oracle');
  const report = buildReadiness({ oracle, setsDir: opts.sets });
  const text = opts.json ? JSON.stringify({ ...report, source: { storages, sets: opts.sets } }, null, 2) : renderMarkdown(report);
  if (opts.out) {
    writeFileSync(opts.out, opts.json ? text : `${text}\n`, 'utf8');
    process.stdout.write(`已写入 ${opts.out} ｜ ${report.overall}（READY ${report.readyCount} / BLOCKED ${report.blockedCount}）\n`);
  } else process.stdout.write(opts.json ? `${text}\n` : text);
}

// 仅在作为 CLI 直接运行时执行（被 import 做单测时不触发）
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
