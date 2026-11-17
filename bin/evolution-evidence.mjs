#!/usr/bin/env node
/**
 * bin/evolution-evidence.mjs —— 进化证据体检（P0：先让判据可复现）
 *
 * ## 它是什么
 *
 * 一份**只读**的「证据在不在」清单：把六组判据（判尺标定性 / 预测↔实测 /
 * 能力图谱 / 自主课程 / 提案执行闭环 / 外部锚定）从生产存储里如实读出来，
 * 每组都带数据源、行数、三态指标与缺口原因。
 *
 * ⛔ 它**不回答**「AGINT 有没有在进化」「智能水平有多高」。
 *    理由：那两个问题的裁判必须是外部冻结基准 + 人（见
 *    `proposals/agint-external-anchor-eval.md`）。一个只读脚本替人下结论，
 *    等于把「自评」包装成「判定」，正是诊断报告里要拆掉的那个环。
 *    本脚本只回答：**判据有没有数据、能不能复现、还差什么**。
 *
 * ## ⭐ 本文件最重要的一条纪律（沿用 growth-report）
 *
 * **空数据输出「无数据 + 原因」，绝不输出 0。**
 *
 *   - `{ value: <数|对象>, reason: null, sampleSize }` 有数据
 *   - `{ value: null, reason: '...', sampleSize: 0 }` 无数据
 *   - ⛔ 绝不返回 `{ value: 0 }` 表示「没测过」
 *
 * 并且严格区分两种零（growth-report.mjs:189-219 的同型纪律）：
 *   - **表在、0 行** = 真 0（查过，确实没有）
 *   - **表不存在 / 字段不存在** = 无数据（不知道，不能替它下结论）
 * 典型：`prediction_outcomes` 里根本没有 `labelAuthority` 这一列 ⇒
 * 只能报「无数据：无法判断有无外部冻结标签」，**不能**报「0 条外部锚定」。
 * 后者会被读成「查过了，一条都没有」，而事实是「这一列压根没采」。
 *
 * ## 依赖边界
 *
 * - ⛔ **只读**：永不写任何存储文件。宿主存储是内存态整体重写
 *   （last-write-wins），外部写会被静默覆盖。`--out` 只写用户指定的报告文件。
 * - ⛔ **不重算**：预测↔实测一组直接调 `buildGrowthReport()` 并透传它的
 *   `predictionAccuracy / outcomes / linkage`。PQ 口径只有
 *   `prediction-scoring.js` 一份；本脚本自己再算一遍 = 报告里的分和
 *   driver 里的分不一致（K110 同源原则）。
 * - ⛔ **不写死绝对路径**：存储根只从 `--storages` 或 $DSH_HOME /
 *   $AGINT_DATA_HOME 推导（AGENTS.md「运行时数据落点」）。
 * - ⛔ **不 fallback 到 ~/.dsh**：本机最常见的假绿就是 DSH_HOME 为空时
 *   静默落到另一套副本，打印一片绿但检的不是线上对象。两者都没给就**报错**。
 *
 * 用法：
 *   node bin/evolution-evidence.mjs --storages <dir>              # 打印 markdown
 *   node bin/evolution-evidence.mjs --storages <dir> --json         # 机器可读
 *   node bin/evolution-evidence.mjs --storages <dir> --out <file>   # 落盘 md
 *   node bin/evolution-evidence.mjs --storages <dir> --json --compare <上次.json>
 *   DSH_HOME=/path/to/data node bin/evolution-evidence.mjs --json
 *
 * ## --compare：让判据有时间序列，但绝不替人判「进化」
 *
 * ⛔ 三条纪律：
 *   ① 「无数据 → 有值」只算**采集覆盖变好**，不算数值上涨；`null → 0` 尤其
 *      不得读成「能力变了」。反过来「有值 → 无数据」是覆盖退化，不是归零。
 *   ② 只有两侧都是有限数字才给 Δ；其余一律 `delta: null`，绝不虚构一个 0。
 *   ③ 本节只输出「读数变了什么、缺口增减了什么」，**不写「进化变好/变差」**。
 *      那是判定，需要外部冻结基准 + 人（external-anchor 提案）。
 *
 * 退出码：0 = 生成成功（**含「无数据」——那是合法结果，不是失败**）
 *        1 = 存储根未指定 / 对拍输入不可读或 schema 不符 / 脚本自身出错
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readDomainTables,
  tableRows,
  buildGrowthReport,
} from './growth-report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 判尺拟合门槛，来源：plugins/agint-aesthetic-oracle/test/calibration.mjs:306 / :390
// ① 阈值拟合：≥4 个已标注周才有初步区分力（建议 8-12 周）
// ② 权重拟合：≥5 个已标注 humanOverall 的周（且只认 better/worse，flat 不算方向样本）
export const FIT_GATES = Object.freeze({ thresholds: 4, weights: 5 });

// ── 三态 ──────────────────────────────────────────────────────────────────

/** 有数据。sampleSize 必填：没有样本量的数字无法复核。 */
export function ok(value, sampleSize) {
  return { value, reason: null, sampleSize };
}

/** 无数据。reason 必填：说不清为什么没数据的报告等于没有报告。 */
export function noData(reason) {
  return { value: null, reason, sampleSize: 0 };
}

/** 表是否存在（与 growth-report.mjs:143 同口径，dict 与 array 都算存在）。 */
export function tableExists(tables, name) {
  const t = tables?.[name];
  return Array.isArray(t) || (t !== null && typeof t === 'object');
}

/** 一个域读不到时，整组指标统一标无数据（不许东一个 0 西一个 null）。 */
export function unavailable(domainStatus, key, metricNames) {
  const st = domainStatus?.[key];
  const why = st?.reason ?? '未知原因';
  const reason = `DOMAIN_UNAVAILABLE(${key}): ${why} ⇒ 本组 ${metricNames.length} 项全部无法判读`;
  return Object.fromEntries(metricNames.map((n) => [n, noData(reason)]));
}

/** ISO 周，⛔ 与 calibration.mjs:142-151 逐行同口径（标注入口按周去重）。 */
export function isoWeek(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** 独立样本 = 一个 ISO 周一行（取该周最后一条），同 calibration.mjs:154-163。 */
export function weeklyDedup(rows) {
  const map = new Map();
  for (const r of rows) {
    const wk = isoWeek(r.ts);
    if (!wk) continue;
    const prev = map.get(wk);
    if (!prev || r.ts > prev.ts) map.set(wk, r);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([week, r]) => ({ week, ...r }));
}

function countBy(rows, pick) {
  const out = {};
  for (const r of rows) {
    const k = String(pick(r) ?? '(缺失)');
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// ── 六组判据（全部纯函数，输入是已读好的 tables） ──────────────────────────

/**
 * ① 判尺标定性（神谕层）。
 *
 * ⭐ 这里最容易犯的错是把「0 条人工标注」渲染成「无数据」。
 *    事实相反：50 行广播、每周样本都在、标注列也在 —— 是**查过了，确实没人填**，
 *    这是真 0，必须报 0 并说明离门槛还差多少。只有「广播表不存在 / 一行都没有」
 *    才是无数据。两者混同的话，看报告的人会以为「判尺标定还没接线」，
 *    而真相是「接线齐了，只差人」。
 */
export function oracleEvidence(oracleTables, domainStatus = {}) {
  const names = [
    'broadcasts', 'independentWeeks', 'annotatedVerdictWeeks', 'annotatedOverallWeeks',
    'thresholdFitReady', 'weightFitReady', 'versionTraceable',
  ];
  if (!domainStatus.agint_aesthetic_oracle?.ok) return unavailable(domainStatus, 'agint_aesthetic_oracle', names);
  if (!tableExists(oracleTables, 'oracle_broadcasts')) {
    return unavailable({ agint_aesthetic_oracle: { reason: 'NO_BROADCAST_TABLE: oracle_broadcasts 表不存在' } }, 'agint_aesthetic_oracle', names);
  }
  const all = tableRows(oracleTables, 'oracle_broadcasts');
  if (all.length === 0) {
    return unavailable({ agint_aesthetic_oracle: { reason: 'NO_BROADCASTS: 表在但 0 行 ⇒ 判尺从未出过读数' } }, 'agint_aesthetic_oracle', names);
  }

  // ⛔ 与 calibration.mjs:53-56 的样本筛选逐条对齐，否则两个脚本的「周数」会打架
  const samples = all
    .filter((r) => r?.outcome === 'ok' && (r.kind === 'daily' || r.kind === 'weekly'))
    .filter((r) => Number.isFinite(Date.parse(r.ts ?? '')));
  const weekly = weeklyDedup(samples);
  const annotatedVerdict = weekly.filter((s) => s.humanVerdict != null);
  // ⛔ flat 不算方向样本（calibration.mjs:167）：权重拟合的目标是 sign(Δscore)
  const annotatedOverall = weekly.filter((s) => s.humanOverall === 'better' || s.humanOverall === 'worse');
  const withVersion = all.filter((r) => r.formulaVersion || r.scaleHash).length;

  return {
    broadcasts: ok(samples.length, samples.length),
    independentWeeks: ok(weekly.length, weekly.length),
    annotatedVerdictWeeks: ok(annotatedVerdict.length, weekly.length),
    annotatedOverallWeeks: ok(annotatedOverall.length, weekly.length),
    thresholdFitReady: ok(annotatedVerdict.length >= FIT_GATES.thresholds, annotatedVerdict.length),
    weightFitReady: ok(annotatedOverall.length >= FIT_GATES.weights, annotatedOverall.length),
    // README 声称广播行透传 formulaVersion / scaleHash；实现里 storage.js 没有这两列。
    // 如实报覆盖率，不替文档圆场、也不替实现改字段。
    versionTraceable: ok({ withVersion, total: all.length }, all.length),
    _caveats: weekly.length ? [{
      metric: 'annotatedVerdictWeeks',
      text: `0 条标注是**真 0**（已查 ${weekly.length} 个独立周样本），不是「没测过」；距阈值拟合门槛还差 ${Math.max(0, FIT_GATES.thresholds - annotatedVerdict.length)} 周、距权重拟合门槛还差 ${Math.max(0, FIT_GATES.weights - annotatedOverall.length)} 周。⛔ 门槛读数不构成「判尺已标定」的结论。`,
      sampleSize: weekly.length,
    }, {
      metric: 'broadcasts',
      text: `分母口径：broadcasts=${samples.length} 是 outcome=ok 的 daily/weekly（与 calibration.mjs 的样本筛选逐条一致）；versionTraceable.total=${all.length} 是 oracle_broadcasts 的全部行（含 monthly / 非 ok）。两者分母不同，不是数据打架。`,
      sampleSize: samples.length,
    }] : [],
  };
}

/**
 * ② 预测↔实测对拍（Growth Report）。
 * ⛔ 直接复用 buildGrowthReport()，不重算 PQ。
 *
 * ⚠ 但**不能**整份透传它的 hasData / gaps：buildGrowthReport 会连 rollbacks /
 *    decisions / provenance 一起算，而本组只关心三项。我们没给它 mountTables，
 *    于是 rollbackCount({}) 会产出一个「表不存在」的缺口 —— 那是**本脚本自己造的**，
 *    不是生产缺口。把它算进 hasData，等于报告在说「预测对拍没数据」，
 *    而真相只是「体检脚本没读 agint_mount」。所以按 RELEVANT 过滤，
 *    并把口径差异写进 caveat，免得有人拿它和 growth-report --json 的 hasData 对拍。
 */
export function growthEvidence(evolutionTables, domainStatus = {}, generatedAt = null) {
  const names = ['outcomes', 'predictionAccuracy', 'linkage', 'growthHasData', 'growthGapCount'];
  if (!domainStatus.agint_evolution?.ok) return unavailable(domainStatus, 'agint_evolution', names);
  const entries = tableRows(evolutionTables, 'evolution_ledger');
  const outcomes = tableRows(evolutionTables, 'prediction_outcomes');
  const gr = buildGrowthReport({ entries, outcomes, mountTables: {}, generatedAt });

  const RELEVANT = ['outcomes', 'predictionAccuracy', 'linkage'];
  const relevantGaps = gr.gaps.filter((g) => RELEVANT.includes(g.metric));
  const relevantNotes = gr.notes.filter((n) => RELEVANT.includes(n.metric));
  return {
    outcomes: gr.metrics.outcomes,
    predictionAccuracy: gr.metrics.predictionAccuracy,
    linkage: gr.metrics.linkage,
    growthHasData: ok(relevantGaps.length === 0, outcomes.length),
    growthGapCount: ok(relevantGaps.length, outcomes.length),
    _caveats: [
      // ⛔ metric 只写指标名：buildEvidence 会再拼 section 前缀，
      //    这里再带一次会渲染成 "growth.growth.predictionAccuracy"。
      ...relevantNotes.map((n) => ({ metric: n.metric, text: n.text, sampleSize: n.sampleSize })),
      {
        metric: 'growthHasData',
        text: '⛔ 口径限定：只判「实测读数 / 预测准确度 / 挂链」三项，不含 growth-report 的 rollbacks / decisions / provenance（本组不关心部署率与回滚）。因此本项的 true/false 与 `bin/growth-report.mjs --json` 的 hasData **不是同一个量**，不得互相代替。',
        sampleSize: outcomes.length,
      },
    ],
  };
}

/** ③ 能力图谱。⛔ 不把 UNCERTAIN 读成「能力为零」，只报三态分布。 */
export function capabilityEvidence(selfModelTables, domainStatus = {}) {
  const names = ['capabilities', 'statusBreakdown', 'verifiedRows', 'evidenceBackedRows'];
  if (!domainStatus.agint_self_model?.ok) return unavailable(domainStatus, 'agint_self_model', names);
  if (!tableExists(selfModelTables, 'capability_map')) {
    return unavailable({ agint_self_model: { reason: 'NO_CAPABILITY_TABLE: capability_map 表不存在' } }, 'agint_self_model', names);
  }
  const rows = tableRows(selfModelTables, 'capability_map');
  if (rows.length === 0) {
    return unavailable({ agint_self_model: { reason: 'NO_CAPABILITIES: 表在但 0 行 ⇒ 能力图谱从未写入' } }, 'agint_self_model', names);
  }
  return {
    capabilities: ok(rows.length, rows.length),
    statusBreakdown: ok(countBy(rows, (r) => r.status), rows.length),
    verifiedRows: ok(rows.filter((r) => Number.isFinite(Date.parse(r.lastVerifiedAt ?? ''))).length, rows.length),
    evidenceBackedRows: ok(rows.filter((r) => Array.isArray(r.evidenceRefs) && r.evidenceRefs.length > 0).length, rows.length),
  };
}

/** ④ 自主课程。只报数，不写「课程没跑起来」这类结论。 */
export function curriculumEvidence(curriculumTables, domainStatus = {}) {
  const names = ['challenges', 'attempts', 'challengesWithAttempt', 'openChallenges', 'uniquePrompts', 'levelBreakdown'];
  if (!domainStatus.agint_curriculum?.ok) return unavailable(domainStatus, 'agint_curriculum', names);
  const ch = tableRows(curriculumTables, 'challenges');
  const at = tableRows(curriculumTables, 'attempts');
  if (!tableExists(curriculumTables, 'challenges') && !tableExists(curriculumTables, 'attempts')) {
    return unavailable({ agint_curriculum: { reason: 'NO_CURRICULUM_TABLES: challenges / attempts 两表都不存在' } }, 'agint_curriculum', names);
  }
  if (ch.length === 0) {
    return unavailable({ agint_curriculum: { reason: 'NO_CHALLENGES: challenges 表在但 0 行 ⇒ 从未出题' } }, 'agint_curriculum', names);
  }
  const attemptedIds = new Set(at.map((a) => a.challengeId).filter(Boolean));
  return {
    challenges: ok(ch.length, ch.length),
    attempts: ok(at.length, at.length),
    challengesWithAttempt: ok(ch.filter((c) => attemptedIds.has(c.id)).length, ch.length),
    openChallenges: ok(ch.filter((c) => c.status === 'open').length, ch.length),
    uniquePrompts: ok(new Set(ch.map((c) => c.prompt).filter(Boolean)).size, ch.length),
    levelBreakdown: ok(countBy(ch, (c) => c.level), ch.length),
  };
}

/** ⑤ 提案执行闭环。⛔ 成功判据沿用周额度口径：state==='succeeded' && ok===true。 */
export function loopEvidence(evolveTables, domainStatus = {}) {
  const names = ['proposals', 'executions', 'succeededExecutions', 'oracleProposals', 'oracleSucceeded', 'proposalStatus'];
  if (!domainStatus.agint_evolve?.ok) return unavailable(domainStatus, 'agint_evolve', names);
  if (!tableExists(evolveTables, 'proposal')) {
    return unavailable({ agint_evolve: { reason: 'NO_PROPOSAL_TABLE: proposal 表不存在' } }, 'agint_evolve', names);
  }
  const pr = tableRows(evolveTables, 'proposal');
  const ex = tableRows(evolveTables, 'execution');
  if (pr.length === 0) {
    return unavailable({ agint_evolve: { reason: 'NO_PROPOSALS: 表在但 0 行 ⇒ 从未产提案' } }, 'agint_evolve', names);
  }
  const oracle = pr.filter((p) => p.source === 'agint-aesthetic-oracle');
  const oracleIds = new Set(oracle.map((p) => p.id));
  const succeeded = ex.filter((e) => e.state === 'succeeded' && e.ok === true);
  return {
    proposals: ok(pr.length, pr.length),
    executions: ok(ex.length, ex.length),
    succeededExecutions: ok(succeeded.length, ex.length),
    oracleProposals: ok(oracle.length, pr.length),
    oracleSucceeded: ok(succeeded.filter((e) => oracleIds.has(e.proposalId)).length, oracle.length),
    proposalStatus: ok(countBy(pr, (p) => p.status), pr.length),
  };
}

/**
 * ⑥ 外部锚定 / 判定权。
 *
 * ⭐ 全脚本最需要诚实的一格：`labelAuthority` 这一列在生产 outcome 里**不存在**。
 *    字段缺失 = 不知道（无数据），字段在但全 UNSET = 查过且确实没有（真 0）。
 *    混同两者会把「判定基准未接线」说成「判定基准检查过、零条锚定」。
 *    诊断报告 `docs/specs/evaluation-protocol-v1.md` 写的「全 UNSET」是**文档口径**，
 *    本脚本只报存储里能实证的那一层。
 */
export function anchorEvidence(evolutionTables, domainStatus = {}) {
  const names = ['frozenSets', 'latestFrozenCount', 'ledgerAnchorStatus', 'externalLabelAuthority'];
  if (!domainStatus.agint_evolution?.ok) return unavailable(domainStatus, 'agint_evolution', names);
  const frozen = tableRows(evolutionTables, 'benchmark_frozen_set');
  const ledger = tableRows(evolutionTables, 'evolution_ledger');
  const outs = tableRows(evolutionTables, 'prediction_outcomes');

  const latest = frozen.length
    ? frozen.slice().sort((a, b) => String(a.capturedAt ?? '').localeCompare(String(b.capturedAt ?? '')))[frozen.length - 1]
    : null;

  let labelMetric;
  if (outs.length === 0) {
    labelMetric = noData('NO_OUTCOMES: prediction_outcomes 0 行 ⇒ 没有任何可供锚定的实测读数');
  } else {
    const withField = outs.filter((o) => Object.prototype.hasOwnProperty.call(o, 'labelAuthority'));
    if (withField.length === 0) {
      labelMetric = noData(`NO_LABEL_AUTHORITY_FIELD: ${outs.length} 条 outcome 无一行带 labelAuthority 列 ⇒ 无法判断是否存在外部冻结真值标签（⛔ 不当「0 条锚定」——那是「这一列压根没采」）`);
    } else {
      // 枚举口径 2026-11-07 对齐仓库既有 `bin/lib/scenario-tier.mjs` 的
      // LABEL_AUTHORITY_VALUES = UNSET / SILVER / GOLD / HELDOUT，不另造第二套。
      // ⛔ 只有 GOLD / HELDOUT 算外部冻结真值；SILVER 是系统自评，
      //    按 external-anchor 提案 §3.2 不变量 4「无外部证据记 fail」必须排除，
      //    否则会把「选手当裁判」读成「已锚定」（旧实现把任意非 UNSET 都计入）。
      const EXTERNAL = new Set(['GOLD', 'HELDOUT']);
      const anchored = withField.filter((o) => EXTERNAL.has(o.labelAuthority)).length;
      const selfLabeled = withField.filter((o) => o.labelAuthority === 'SILVER').length;
      const unset = withField.filter((o) => !o.labelAuthority || o.labelAuthority === 'UNSET').length;
      labelMetric = ok({
        anchored,
        selfLabeled,
        unset,
        unknown: withField.length - anchored - selfLabeled - unset,
        total: withField.length,
        externalAuthorities: ['GOLD', 'HELDOUT'],
      }, withField.length);
    }
  }

  return {
    frozenSets: ok(frozen.length, frozen.length), // 表在、0 行是真 0
    latestFrozenCount: latest
      ? ok(latest.frozenCount ?? null, frozen.length)
      : noData('NO_FROZEN_SET: benchmark_frozen_set 0 行 ⇒ 无冻结基准集'),
    ledgerAnchorStatus: ok(countBy(ledger, (e) => e.anchorStatus), ledger.length),
    externalLabelAuthority: labelMetric,
    _caveats: [{
      metric: 'externalLabelAuthority',
      text: '⛔ 本组只报「存储里能实证的锚定证据」。外部冻结真值标签的有无属于判定权，须走 proposals/agint-external-anchor-eval.md，机器不得从 git 史实或自评推断标签。',
      sampleSize: outs.length,
    }],
  };
}

// ── 汇总 ──────────────────────────────────────────────────────────────────

export const SECTIONS = Object.freeze([
  { key: 'oracle', title: '① 判尺标定性（神谕层）', build: oracleEvidence },
  { key: 'growth', title: '② 预测↔实测对拍（Growth Report）', build: growthEvidence },
  { key: 'capability', title: '③ 能力图谱（self-model）', build: capabilityEvidence },
  { key: 'curriculum', title: '④ 自主课程（curriculum）', build: curriculumEvidence },
  { key: 'loop', title: '⑤ 提案执行闭环（evolve）', build: loopEvidence },
  { key: 'anchor', title: '⑥ 外部锚定（判定权）', build: anchorEvidence },
]);

/** 组内状态：全空 = NO_DATA，部分空 = PARTIAL，全有值 = COMPLETE。 */
export function sectionStatus(metrics) {
  const list = Object.entries(metrics ?? {}).filter(([k]) => !k.startsWith('_'));
  if (list.length === 0) return 'NO_DATA';
  const nulls = list.filter(([, m]) => m?.value === null || m?.value === undefined).length;
  if (nulls === list.length) return 'NO_DATA';
  if (nulls > 0) return 'PARTIAL';
  return 'COMPLETE';
}

/**
 * 体检主体（纯函数）。
 * @param {object} input
 * @param {object} input.domains      { 域名: { ok, reason, tables, rows } }
 * @param {string} [input.storages]   存储根（仅作元信息，不参与计算）
 * @param {string} [input.generatedAt]
 */
export function buildEvidence({ domains = {}, storages = null, generatedAt = null } = {}) {
  const t = (name) => (domains[name]?.tables ?? {});
  const status = Object.fromEntries(Object.entries(domains).map(([k, v]) => [k, { ok: v.ok, reason: v.reason }]));
  const sections = {};
  const gaps = [];
  const notes = [];

  for (const s of SECTIONS) {
    let metrics;
    // growth 需要注入 generatedAt 才能与其报告时间戳一致（其余组不需要时钟）
    metrics = s.key === 'growth'
      ? s.build(t('agint_evolution'), status, generatedAt)
      : s.build(t({
        oracle: 'agint_aesthetic_oracle',
        capability: 'agint_self_model',
        curriculum: 'agint_curriculum',
        loop: 'agint_evolve',
        anchor: 'agint_evolution',
      }[s.key]), status);

    const caveats = metrics._caveats ?? [];
    delete metrics._caveats;
    sections[s.key] = { title: s.title, status: sectionStatus(metrics), metrics };
    for (const [k, m] of Object.entries(metrics)) {
      if (m?.value === null || m?.value === undefined) {
        gaps.push({ section: s.key, metric: k, reason: m.reason ?? '未说明原因', sampleSize: m.sampleSize ?? 0 });
      }
    }
    for (const c of caveats) notes.push({ section: s.key, ...c });
  }

  return {
    schemaVersion: '1.0',
    generatedAt,
    source: {
      storages,
      domains: Object.fromEntries(Object.entries(domains).map(([k, v]) => [k, {
        ok: v.ok, reason: v.reason, rows: v.rows ?? {},
      }])),
    },
    sections,
    gaps,
    notes,
    // ⛔ 不是「进化是否发生的结论」，只是「六组判据各自读到了没有」
    readiness: {
      complete: Object.values(sections).filter((s) => s.status === 'COMPLETE').length,
      partial: Object.values(sections).filter((s) => s.status === 'PARTIAL').length,
      noData: Object.values(sections).filter((s) => s.status === 'NO_DATA').length,
      total: SECTIONS.length,
    },
  };
}

// ── 时间序列对拍 ──────────────────────────────────────────────────────────

export const EVIDENCE_SCHEMA = '1.0';

function hasValue(m) {
  return !!m && m.value !== null && m.value !== undefined;
}

function valueOf(m) {
  return hasValue(m) ? m.value : null;
}

/** 单次指标变化的分类。delta 只在「两侧都是有限数字」时给数，否则恒 null。 */
export function classifyChange(before, after) {
  const bHas = hasValue(before);
  const aHas = hasValue(after);
  const b = valueOf(before);
  const a = valueOf(after);

  if (!bHas && !aHas) return { kind: 'STILL_NO_DATA', delta: null, fields: null, note: '两侧都无数据，无法对拍' };
  if (!bHas && aHas) {
    return {
      kind: 'APPEARED', delta: null, fields: null,
      note: '⛔ 从「无数据」变成有值 = 采集覆盖变好，**不是数值上涨**；尤其 null→0 不得读成「能力变了」',
    };
  }
  if (bHas && !aHas) {
    return {
      kind: 'DISAPPEARED', delta: null, fields: null,
      note: '⛔ 从有值变成「无数据」= 采集覆盖退化，**不是数值归零**',
    };
  }
  if (typeof b === 'number' && typeof a === 'number' && Number.isFinite(b) && Number.isFinite(a)) {
    const d = a - b;
    return {
      kind: d > 0 ? 'NUMERIC_UP' : (d < 0 ? 'NUMERIC_DOWN' : 'NUMERIC_FLAT'),
      delta: d, fields: null, note: null,
    };
  }
  if (typeof b === 'boolean' && typeof a === 'boolean') {
    return {
      kind: b === a ? 'UNCHANGED' : 'BOOLEAN_CHANGED', delta: null, fields: null,
      note: b === a ? null : '布尔翻转（门槛就绪 / 有数据标记），只说明判据状态变了',
    };
  }
  if (b && a && typeof b === 'object' && typeof a === 'object') {
    const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
    const fields = [];
    for (const k of keys) {
      const bv = b[k] ?? null;
      const av = a[k] ?? null;
      if (JSON.stringify(bv) !== JSON.stringify(av)) fields.push({ key: k, before: bv, after: av });
    }
    return {
      kind: fields.length ? 'OBJECT_CHANGED' : 'UNCHANGED', delta: null,
      fields: fields.length ? fields : null,
      note: fields.length ? '对象型指标按子字段逐键比对，不给单一 Δ（会丢信息）' : null,
    };
  }
  if (typeof b !== typeof a) {
    return { kind: 'TYPE_CHANGED', delta: null, fields: null, note: '⛔ 两侧类型不同 ⇒ 口径可能变了，不得当作涨跌' };
  }
  return { kind: b === a ? 'UNCHANGED' : 'VALUE_CHANGED', delta: null, fields: null, note: null };
}

/**
 * 与上一份基线对拍（纯函数）。
 *
 * ⛔ 输出里没有任何「进化变好 / 变差」的判词 —— 只有读数变化、采集覆盖变化、
 *    缺口增减、就绪度变化。判定权在外部冻结基准与人。
 *
 * @param {object} baseline 上一份 `--json` 报告
 * @param {object} current  本次报告
 */
export function compareEvidence(baseline, current) {
  if (!baseline || typeof baseline !== 'object' || !baseline.sections || !Array.isArray(baseline.gaps)) {
    throw new Error('COMPARE_NOT_EVIDENCE: --compare 给的不是一份体检 --json 报告（缺 sections / gaps）');
  }
  if (baseline.schemaVersion !== EVIDENCE_SCHEMA || current.schemaVersion !== EVIDENCE_SCHEMA) {
    throw new Error(`COMPARE_SCHEMA_MISMATCH: 基线 schema=${baseline.schemaVersion} / 本次 schema=${current.schemaVersion}，期望 ${EVIDENCE_SCHEMA} ⇒ 指标集可能已变，拒绝跨版本对拍`);
  }

  const changes = [];
  for (const s of SECTIONS) {
    const bSec = baseline.sections?.[s.key];
    const cSec = current.sections?.[s.key];
    if (!bSec) {
      changes.push({ section: s.key, metric: '(整组)', kind: 'MISSING_IN_BASELINE', before: null, after: null, delta: null, fields: null, note: '基线里没有这一组 ⇒ 无法对拍' });
      continue;
    }
    const bm = bSec.metrics ?? {};
    const cm = cSec?.metrics ?? {};
    const names = [...new Set([...Object.keys(bm), ...Object.keys(cm)])].sort();
    for (const n of names) {
      if (!bm[n]) {
        changes.push({ section: s.key, metric: n, kind: 'NEW_METRIC', before: null, after: valueOf(cm[n]), delta: null, fields: null, note: '基线里没有这个指标（schema 相同但指标集变了，需复核）' });
        continue;
      }
      if (!cm[n]) {
        changes.push({ section: s.key, metric: n, kind: 'METRIC_REMOVED', before: valueOf(bm[n]), after: null, delta: null, fields: null, note: '本次没有这个指标（schema 相同但指标集变了，需复核）' });
        continue;
      }
      const c = classifyChange(bm[n], cm[n]);
      changes.push({ section: s.key, metric: n, kind: c.kind, before: valueOf(bm[n]), after: valueOf(cm[n]), delta: c.delta, fields: c.fields, note: c.note });
    }
  }

  const count = (k) => changes.filter((c) => c.kind === k).length;
  const gapKeys = (r) => (r.gaps ?? []).map((g) => `${g.section}.${g.metric}`);
  const before = gapKeys(baseline);
  const after = gapKeys(current);

  return {
    schemaVersion: EVIDENCE_SCHEMA,
    baselineGeneratedAt: baseline.generatedAt ?? null,
    currentGeneratedAt: current.generatedAt ?? null,
    summary: {
      totalMetrics: changes.length,
      changed: changes.filter((c) => !['UNCHANGED', 'STILL_NO_DATA', 'NUMERIC_FLAT'].includes(c.kind)).length,
      // ⭐ 数值持平也是「未变」，不能只数 UNCHANGED —— 否则两份完全相同的基线
      //    会显示「未变 0 项」，看起来像所有指标都动了。numericFlat 是它的子项。
      unchanged: count('UNCHANGED') + count('NUMERIC_FLAT'),
      stillNoData: count('STILL_NO_DATA'),
      numericUp: count('NUMERIC_UP'),
      numericDown: count('NUMERIC_DOWN'),
      numericFlat: count('NUMERIC_FLAT'),
      coverageImproved: count('APPEARED'),
      coverageRegressed: count('DISAPPEARED'),
      booleanChanged: count('BOOLEAN_CHANGED'),
      objectChanged: count('OBJECT_CHANGED'),
      typeChanged: count('TYPE_CHANGED'),
      schemaDrift: count('NEW_METRIC') + count('METRIC_REMOVED') + count('MISSING_IN_BASELINE'),
    },
    readiness: { before: baseline.readiness ?? null, after: current.readiness ?? null },
    gaps: {
      before, after,
      resolved: before.filter((g) => !after.includes(g)),
      introduced: after.filter((g) => !before.includes(g)),
    },
    changes,
  };
}

// ── 渲染 ──────────────────────────────────────────────────────────────────

function fmt(v) {
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (v && typeof v === 'object') {
    return Object.entries(v).map(([k, x]) => `${k}=${Array.isArray(x) || (x && typeof x === 'object') ? JSON.stringify(x) : x}`).join(' · ');
  }
  return String(v);
}

function renderMetric(name, m) {
  if (!m) return `- ${name}：_(无该指标)_`;
  if (m.value === null || m.value === undefined) return `- ${name}：**无数据** — ${m.reason ?? '未说明原因'}`;
  return `- ${name}：${fmt(m.value)} _(n=${m.sampleSize})_`;
}

/** 对拍章节。⛔ 只报变化，不判「进化变好/变差」。 */
export function renderComparison(cmp) {
  const L = [];
  L.push('## 与基线对拍（时间序列）');
  L.push('');
  L.push(`> 基线：${cmp.baselineGeneratedAt ?? '(未记录)'} → 本次：${cmp.currentGeneratedAt ?? '(未记录)'}`);
  L.push('> ⛔ 本节只报**读数变化与采集覆盖变化**，不判「进化变好 / 变差」。');
  L.push('> 「无数据 → 有值」是采集覆盖变好，不是数值上涨；`null → 0` 尤其不得读成能力变化。');
  L.push('');
  const s = cmp.summary;
  L.push(`- 指标总数 ${s.totalMetrics} · 有变化 ${s.changed} · 未变 ${s.unchanged} · 两侧仍无数据 ${s.stillNoData}`);
  L.push(`- 数值 涨 ${s.numericUp} / 跌 ${s.numericDown} / 平 ${s.numericFlat} · 布尔翻转 ${s.booleanChanged} · 对象子字段变化 ${s.objectChanged} · 类型变化 ${s.typeChanged}${s.schemaDrift ? ` · **指标集漂移 ${s.schemaDrift}**` : ''}`);
  L.push(`- 采集覆盖 变好 ${s.coverageImproved} / 退化 ${s.coverageRegressed}`);
  L.push(`- 缺口 ${cmp.gaps.before.length} → ${cmp.gaps.after.length}（消解 ${cmp.gaps.resolved.length} / 新增 ${cmp.gaps.introduced.length}）`);
  const rb = cmp.readiness.before ?? {};
  const ra = cmp.readiness.after ?? {};
  L.push(`- 就绪度 COMPLETE ${rb.complete}→${ra.complete} · PARTIAL ${rb.partial}→${ra.partial} · NO_DATA ${rb.noData}→${ra.noData}`);
  L.push('');
  const notable = cmp.changes.filter((c) => !['UNCHANGED', 'STILL_NO_DATA', 'NUMERIC_FLAT'].includes(c.kind));
  if (!notable.length) L.push('- （无显著变化：所有可比指标读数与覆盖都未变）');
  else {
    for (const c of notable) {
      const b = c.before === null ? '无数据' : fmt(c.before);
      const a = c.after === null ? '无数据' : fmt(c.after);
      const d = c.delta === null ? '' : ` · Δ=${c.delta > 0 ? '+' : ''}${fmt(c.delta)}`;
      L.push(`- **${c.section}.${c.metric}** \`${c.kind}\`：${b} → ${a}${d}`);
      if (c.fields?.length) {
        L.push(`  - 子字段：${c.fields.map((f) => `${f.key} ${f.before === null ? '—' : fmt(f.before)}→${f.after === null ? '—' : fmt(f.after)}`).join(' · ')}`);
      }
      if (c.note) L.push(`  - ${c.note}`);
    }
  }
  return L;
}

export function renderMarkdown(report) {
  const L = [];
  L.push('# AGINT 进化证据体检');
  L.push('');
  L.push(`> 生成时间：${report.generatedAt ?? '(未注入)'} · schema ${report.schemaVersion}`);
  L.push(`> 存储根：\`${report.source?.storages ?? '(未记录)'}\``);
  L.push('');
  L.push('> ⛔ **本体检不回答「AGINT 有没有在进化」**。它只回答：六组判据各自有没有数据、');
  L.push('> 能不能复现、还差什么。判定权在外部冻结基准与人，不在这个只读脚本。');
  L.push('> **「无数据」= 没有测过，不表示「效果为零」；本脚本从不把缺数据渲染成 0。**');
  L.push('');

  for (const s of SECTIONS) {
    const sec = report.sections?.[s.key];
    if (!sec) continue;
    L.push(`## ${s.title}　\`${sec.status}\``);
    L.push('');
    for (const [k, m] of Object.entries(sec.metrics)) L.push(renderMetric(k, m));
    L.push('');
  }

  if (report.comparison) {
    L.push(...renderComparison(report.comparison));
    L.push('');
  }

  L.push('## 缺口（本体检不能回答什么）');
  L.push('');
  if (!report.gaps?.length) L.push('- （无缺口：六组指标全有数据）');
  else for (const g of report.gaps) L.push(`- **${g.section}.${g.metric}** — ${g.reason}`);
  L.push('');

  L.push('## 读这份体检必须知道的事');
  L.push('');
  if (!report.notes?.length) L.push('- （无）');
  else for (const n of report.notes) L.push(`- **${n.section}.${n.metric}** — ${n.text}`);
  L.push('');

  L.push('## 数据源（跨机器对拍用）');
  L.push('');
  for (const [d, info] of Object.entries(report.source?.domains ?? {})) {
    const rows = Object.entries(info.rows ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || '(无表)';
    L.push(`- \`${d}\`：${info.ok ? '可读' : `**不可读** — ${info.reason}`} · ${rows}`);
  }
  L.push('');
  L.push(`判据就绪度：COMPLETE ${report.readiness.complete} / PARTIAL ${report.readiness.partial} / NO_DATA ${report.readiness.noData}（共 ${report.readiness.total} 组）`);
  L.push('');
  L.push('---');
  L.push('');
  L.push('*本体检由 `bin/evolution-evidence.mjs` 生成（只读）。预测准确度口径复用 `bin/growth-report.mjs` → `prediction-scoring.js`，未二次实现。*');
  return `${L.join('\n')}\n`;
}

// ── IO ────────────────────────────────────────────────────────────────────

const DOMAIN_NAMES = [
  'agint_aesthetic_oracle',
  'agint_evolution',
  'agint_evolve',
  'agint_self_model',
  'agint_curriculum',
];

/** 读一个域并附带行数元信息。 */
export function readDomain(storages, name) {
  const r = readDomainTables(storages, name);
  const rows = r.ok
    ? Object.fromEntries(Object.entries(r.tables)
      .filter(([k, v]) => k !== 'unit' && k !== 'global' && v && typeof v === 'object')
      .map(([k, v]) => [k, tableRows(r.tables, k).length]))
    : {};
  return { ok: r.ok, reason: r.reason, tables: r.tables, rows };
}

/**
 * ⛔ 存储根解析：不给就报错，绝不 fallback 到 ~/.dsh。
 * 本机最常见的假绿就是 DSH_HOME 为空时静默落到另一套副本 —— 打印一片绿，
 * 但检的不是线上对象（AGENTS.md / 项目守则 §0）。
 */
export function resolveStorages(explicit, env = process.env) {
  if (explicit) return explicit;
  const home = env.DSH_HOME || env.AGINT_DATA_HOME;
  if (home) return join(home, 'storages');
  throw new Error('NO_STORAGE_ROOT: 未指定 --storages，且 DSH_HOME / AGINT_DATA_HOME 均未设置 ⇒ 拒绝 fallback 到 ~/.dsh（会检到另一套副本，打印假绿）。请显式 export DSH_HOME=<数据根> 或传 --storages <dir>。');
}

function parseArgs(argv) {
  const o = { json: false, out: null, storages: null, compare: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--out') o.out = argv[++i] ?? null;
    else if (a === '--storages') o.storages = argv[++i] ?? null;
    else if (a === '--compare') o.compare = argv[++i] ?? null;
    else throw new Error(`未知参数：${a}`);
  }
  return o;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const storages = resolveStorages(opts.storages);
  const domains = Object.fromEntries(DOMAIN_NAMES.map((n) => [n, readDomain(storages, n)]));
  const report = buildEvidence({ domains, storages, generatedAt: new Date().toISOString() });

  if (opts.compare) {
    let baseline;
    try {
      baseline = JSON.parse(readFileSync(opts.compare, 'utf8'));
    } catch (err) {
      throw new Error(`COMPARE_UNREADABLE: ${opts.compare} — ${err instanceof Error ? err.message : String(err)}`);
    }
    // ⛔ 对拍输入错误属于「输入不可读」，不是「无数据」，必须 exit 1 而不是打印一片绿。
    report.comparison = compareEvidence(baseline, report);
  }

  const md = renderMarkdown(report);

  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, md, 'utf8');
    process.stdout.write(`[evolution-evidence] 已写入 ${opts.out}\n`);
    process.stdout.write(`  就绪度 COMPLETE ${report.readiness.complete} / PARTIAL ${report.readiness.partial} / NO_DATA ${report.readiness.noData} · 缺口 ${report.gaps.length} 项\n`);
    if (report.comparison) {
      const s = report.comparison.summary;
      process.stdout.write(`  对拍：变化 ${s.changed} 项 · 覆盖变好 ${s.coverageImproved} / 退化 ${s.coverageRegressed} · 缺口消解 ${report.comparison.gaps.resolved.length} / 新增 ${report.comparison.gaps.introduced.length}\n`);
    }
  } else process.stdout.write(md);
  // ⛔ 退出码恒 0：「无数据」是合法结果，不是脚本失败。
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith('evolution-evidence.mjs')) {
  try {
    main();
  } catch (err) {
    console.error(`[evolution-evidence] ❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
