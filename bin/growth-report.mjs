#!/usr/bin/env node
/**
 * bin/growth-report.mjs —— 结构化 Growth Report 生成器（路线图 1.2）
 *
 * ## 它是什么
 *
 * 一份**只读**的期间报告：把 `evolution_ledger`（决策序列）与
 * `prediction_outcomes`（实测读数）汇成一份人可读的 md。
 * 纯函数在 `buildGrowthReport()`，IO 只在 `main()`。
 *
 * ⛔ 形态：**bin 脚本，不是 cron job**（设计稿写「每 4 周自动生成」，
 *   但路线图 §1.2 的前置是 1.1 出数，而 1.1 生产读数 0 条。
 *   在 0 条数据上挂一个每月 job = 每月产出一份「无数据」报告 =
 *   训练人忽略这份报告。**先让报告在有数据时是对的，再谈自动化。**
 *   接线位置留给 `plugins/agint-cron/lib/jobs.js`（schedule 建议每月 1 日
 *   10:45，⛔ 不得落 10:00 / 10:30 —— oracle-monthly / spec-index-refresh 已占）。
 *
 * ## ⭐ 本文件唯一真正重要的一条纪律
 *
 * **空数据输出「无数据」，绝不输出 0。**
 *
 * 理由：`0` 与「没测过」在报告里长得一模一样，而它们的意思相反。
 * 一个 0% 成功率会让人以为「进化在破坏系统」，去查并不存在的回归；
 * 一个 0.00 的平均校准分会让人以为「预测能力为零」，去废掉预测模块。
 * 两个错误结论都比「不知道」贵得多。
 *
 * ⛔ 因此每个指标都返回三态，不是两态：
 *   - `{ value: <数>, ... }`   有数据
 *   - `{ value: null, reason }` 无数据，**带原因**
 *   - 绝不返回 `{ value: 0 }` 来代表「没数据」
 *
 * 这条纪律在 `EMPTY_REASONS` 里枚举了全部可接受的原因码，
 * 单测逐个断言「空数据时 value 必须是 null 且 reason 非空」。
 *
 * ## 依赖边界
 *
 * - ⛔ **只读**：本脚本永不写 ledger / outcomes / 任何存储文件。
 *   理由与 `ledger-anchor` 相同：宿主存储是内存态整体重写（last-write-wins），
 *   外部写会被静默覆盖。报告是读侧产物，不该有写路径。
 * - PQ（预测质量）算法**不自造**：复用 `prediction-scoring.js` 的
 *   `scorePrediction()` / `aggregateBucket()`。两份 PQ 实现必然漂移，
 *   而漂移的方向恰好是「报告里的分和 driver 里的分不一样」——
 *   那种不一致会让整份报告失去可信度（K110 同源原则）。
 * - 统计口径（successRate / directionalAccuracy / confidence 分级）
 *   全部沿用 `aggregateBucket()` 的定义，报告只做**呈现**，不做二次判定。
 *
 * 用法：
 *   node bin/growth-report.mjs                       # 打印到 stdout
 *   node bin/growth-report.mjs --json                # 机器可读
 *   node bin/growth-report.mjs --out docs/growth-report-YYYYMM.md
 *   node bin/growth-report.mjs --since 2026-09-01 --generation GEN-000
 *   node bin/growth-report.mjs --storages <dir>      # 换存储根（测试用）
 *
 * 退出码：0 = 生成成功（**含「无数据」——那是合法结果，不是失败**）
 *        1 = 报告生成器自身出错
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  scorePrediction,
  aggregateBucket,
  bucketConfidence,
} from '../plugins/agint-evolution-driver/lib/prediction-scoring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const DEFAULT_STORAGES = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'storages')
  : join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'storages');

// ── 原因码 ────────────────────────────────────────────────────────────────

/**
 * 「无数据」的全部合法原因。
 *
 * ⭐ 单测断言**每一个**码都能在空数据时产生一个 `value: null` 的指标。
 * 加新码必须同时加用例 —— 否则「多了一个码但没人判它」等于这个原因
 * 永远不会被输出，而报告会说不出自己为什么没数据。
 */
export const EMPTY_REASONS = Object.freeze({
  NO_LEDGER: 'LEDGER_EMPTY: evolution_ledger 0 条 ⇒ 期间内没有任何进化决策可汇总',
  NO_OUTCOMES: 'NO_OUTCOMES: prediction_outcomes 0 条 ⇒ 没有任何实测读数（1.1 未出数）',
  OUTCOMES_TABLE_ABSENT: 'OUTCOMES_TABLE_ABSENT: 生产存储里没有 prediction_outcomes 表 ⇒ 表可能尚未被宿主懒建（不确定，不当「无数据」而当「无表」）',
  NO_MEASURED_DELTA: 'NO_MEASURED_DELTA: 有条目但 actualDelta 全为 null ⇒ 决策已入链、效果未测',
  NO_PREDICTED_DELTA: 'NO_PREDICTED_DELTA: 有条目但 predictedDelta 全为 null ⇒ 没有预测就没有校准可言（⛔ 不用 0 冒充）',
  NO_OUTCOME_LINKED: 'NO_OUTCOME_LINKED: 有条目但没有一条能按 contractId 挂上 outcome ⇒ 两侧断链',
  FILTERED_OUT: 'FILTERED_OUT: 期间/代际过滤器把所有条目都排除了 ⇒ 换一个过滤条件再试',
  GENERATION_UNKNOWN: 'GENERATION_UNKNOWN: 条目没有可用的 generation 值 ⇒ 代际区间无法计算',
});

// ── 只读 IO ───────────────────────────────────────────────────────────────

/**
 * 读一个 dsh 存储域，**只取表**。
 *
 * @param {string} storagesDir 存储根目录
 * @param {string} domain      域名（如 agint_evolution）
 * @returns {{ok: boolean, reason: string|null, tables: object}}
 */
export function readDomainTables(storagesDir, domain) {
  const p = join(storagesDir, `${domain}.json`);
  if (!existsSync(p)) return { ok: false, reason: `STORAGE_MISSING: ${p} 不存在`, tables: {} };
  let doc;
  try {
    doc = JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `STORAGE_UNPARSEABLE: ${err.message}`, tables: {} };
  }
  // 表可能在顶层也可能在 tables 下（与 export-evolution-package.mjs 同源判据）
  const tables = (doc && typeof doc === 'object' && doc.tables && typeof doc.tables === 'object')
    ? doc.tables
    : (() => {
      const out = {};
      for (const [k, v] of Object.entries(doc ?? {})) {
        if (k === 'unit' || k === 'global') continue;
        if (v && typeof v === 'object') out[k] = v;
      }
      return out;
    })();
  return { ok: true, reason: null, tables };
}

/**
 * 取一张表的全部行，**认 dict 与 array 两种形状**。
 *
 * ⚠️ dsh 存储域的表在磁盘上是 dict（`{"1": {...}}`）。
 *   写成 `Array.isArray(t) ? t : []` 会让真数据被判成 0 行，
 *   而报告会把「0 条」渲染成一份看起来很正常、结论全错的报告。
 *   （同型 bug 已在 export-evolution-package.mjs 犯过一次。）
 */
export function tableRows(tables, name) {
  const t = tables?.[name];
  if (Array.isArray(t)) return t.filter((r) => r && typeof r === 'object');
  if (t && typeof t === 'object') return Object.values(t).filter((r) => r && typeof r === 'object');
  return [];
}

/** 表是否存在（区别于「存在但 0 行」—— 两者在报告里要分开说）。 */
function hasTable(tables, name) {
  const t = tables?.[name];
  return Array.isArray(t) || (t !== null && typeof t === 'object');
}

// ── 纯函数：报告计算 ──────────────────────────────────────────────────────

/** 空指标的统一形状。reason 必填 —— 没有原因的「无数据」等于假数据。 */
function empty(reason) {
  return { value: null, reason, sampleSize: 0 };
}

/** 过滤后的条目集。返回条目与「是否被过滤全空」标记。 */
export function selectEntries(entries, { since = null, generation = null } = {}) {
  let list = Array.isArray(entries) ? entries : [];
  const before = list.length;
  if (since) {
    const t = Date.parse(since);
    if (Number.isNaN(t)) throw new Error(`--since 无法解析：${since}`);
    list = list.filter((e) => {
      const ts = Date.parse(e?.timestamp ?? '');
      return Number.isFinite(ts) && ts >= t;
    });
  }
  if (generation) list = list.filter((e) => e?.generation === generation);
  return { entries: list, allFilteredOut: before > 0 && list.length === 0, totalBeforeFilter: before };
}

/** 代际区间（generation 字段的 min..max）。无可用值 ⇒ 空指标。 */
export function generationRange(entries) {
  const gens = [...new Set((entries ?? []).map((e) => e?.generation).filter((g) => typeof g === 'string' && g !== ''))].sort();
  if (gens.length === 0) return empty(EMPTY_REASONS.GENERATION_UNKNOWN);
  return { value: { from: gens[0], to: gens[gens.length - 1], distinct: gens }, reason: null, sampleSize: gens.length };
}

/** 决策分布。空 ⇒ 空指标。 */
export function decisionBreakdown(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return empty(EMPTY_REASONS.NO_LEDGER);
  const counts = {};
  for (const e of list) {
    const d = e?.summary?.decision ?? '(缺失)';
    counts[d] = (counts[d] ?? 0) + 1;
  }
  return {
    value: {
      total: list.length,
      counts,
      accepted: counts.AUTO_DEPLOY ?? 0,
      pending: counts.PENDING_REVIEW ?? 0,
      rejected: counts.REJECT ?? 0,
      abstained: counts.ABSTAIN ?? 0,
      // 部署率的分母是**全部**决策，不是「已裁决的」。用后者会把 ABSTAIN
      // 从分母里悄悄抹掉，让部署率虚高。
      deployRate: list.length === 0 ? null : (counts.AUTO_DEPLOY ?? 0) / list.length,
    },
    reason: null,
    sampleSize: list.length,
  };
}

/** 回滚数。ledger 里**没有**回滚字段（见下方注释），所以只能从 mount 域取。 */
export function rollbackCount(tables) {
  const rows = tableRows(tables, 'rollback_log');
  if (!hasTable(tables, 'rollback_log')) {
    return empty('NO_ROLLBACK_TABLE: agint_mount.rollback_log 表不存在 ⇒ 回滚数无从判断（⛔ 不用 0 冒充「没回滚过」）');
  }
  if (rows.length === 0) {
    return {
      value: 0,
      reason: null,
      sampleSize: 0,
      // 区分「表在、0 行」与「表不在」：前者是「确实没回滚」，后者是「不知道」。
      caveat: 'rollback_log 表存在且 0 行 ⇒ 期间内无回滚记录（这是真 0，不是缺数据）',
    };
  }
  return { value: rows.length, reason: null, sampleSize: rows.length, caveat: null };
}

/**
 * 用 **reconstructed 标记** 区分「历史补录」与「实时决策」。
 *
 * ⭐ 这一段是本报告最容易骗人的地方：6 条生产条目**全部** `reconstructed: true`
 *   （`bin/rebuild-ledger-history.mjs` 实测），也就是它们是 Phase 1 之前
 *   真实发生过的进化，被反推进链。它们的 decision 是**当时的**裁决。
 *   报告必须把这一层显式说出来，否则读的人会以为「系统最近自动部署了 3 次」。
 */
export function provenanceSplit(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return empty(EMPTY_REASONS.NO_LEDGER);
  const reconstructed = list.filter((e) => e?.reconstructed === true).length;
  const live = list.length - reconstructed;
  return {
    value: { total: list.length, reconstructed, live },
    reason: null,
    sampleSize: list.length,
    caveat: live === 0
      ? '⛔ 全部条目都是 reconstructed（历史重建）⇒ 本报告不含任何「系统当时自动裁决」的实时决策'
      : (reconstructed > 0 ? `含 ${reconstructed} 条历史重建条目，其 decision 是当时的裁决` : null),
  };
}

/** 变化率探针：对可提取数值的字段算期初/期末均值差。无 2 点则不给。 */
export function trendOf(entries, pick) {
  const list = (Array.isArray(entries) ? entries : [])
    .slice()
    .sort((a, b) => String(a?.timestamp ?? '').localeCompare(String(b?.timestamp ?? '')))
    .map(pick)
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (list.length < 2) return { from: null, to: null, delta: null, sampleSize: list.length };
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const half = Math.max(1, Math.floor(list.length / 2));
  const early = mean(list.slice(0, half));
  const late = mean(list.slice(list.length - half));
  return { from: early, to: late, delta: late - early, sampleSize: list.length };
}

/**
 * 预测准确度：PQ 分布 + 方向准确率。
 *
 * PQ **不重算** —— 直接取 `prediction_outcomes.predictionQuality`
 * （该字段由 driver 侧 `scorePrediction()` 写入）。若某条没有存 PQ 但存了
 * predicted/actual，则现场调 `scorePrediction()` 补算，**用同一份公式**。
 */
export function predictionAccuracy(outcomes) {
  const outs = Array.isArray(outcomes) ? outcomes : [];
  if (outs.length === 0) return empty(EMPTY_REASONS.NO_OUTCOMES);

  const scored = [];
  const unscoredReasons = {};
  for (const o of outs) {
    let pq = typeof o?.predictionQuality === 'number' ? o.predictionQuality : null;
    if (pq === null && Number.isFinite(o?.predictedDelta) && Number.isFinite(o?.actualDelta)) {
      const s = scorePrediction({
        predictedDelta: o.predictedDelta,
        actualDelta: o.actualDelta,
        targetMetric: o.targetMetric,
        baselineNoiseStd: o.baselineNoiseStd ?? null,
      });
      pq = typeof s.pq === 'number' ? s.pq : null;
      if (pq === null) unscoredReasons[s.reason] = (unscoredReasons[s.reason] ?? 0) + 1;
    } else if (pq === null) {
      unscoredReasons.NO_PREDICTED_DELTA = (unscoredReasons.NO_PREDICTED_DELTA ?? 0) + 1;
    }
    if (pq === null) continue;
    scored.push({
      pq,
      actualDelta: o.actualDelta,
      DA: Number.isFinite(o?.predictedDelta) && Number.isFinite(o?.actualDelta)
        ? (Math.sign(o.predictedDelta) === Math.sign(o.actualDelta) ? 1 : 0)
        : null,
      isDeadZone: o?.isDeadZone === true,
      mutationType: o?.mutationType ?? null,
      targetMetric: o?.targetMetric ?? null,
    });
  }
  if (scored.length === 0) {
    const why = Object.keys(unscoredReasons).length
      ? `NO_SCORABLE_OUTCOME: ${outs.length} 条 outcome 里没有一条能评分（${Object.entries(unscoredReasons).map(([k, v]) => `${k}×${v}`).join(', ')}）`
      : EMPTY_REASONS.NO_PREDICTED_DELTA;
    return { ...empty(why), totalOutcomes: outs.length, unscoredReasons };
  }

  const agg = aggregateBucket({ mutationType: 'ALL', targetMetric: 'ALL', records: scored });
  const pqs = scored.map((s) => s.pq).sort((a, b) => a - b);
  const mean = pqs.reduce((s, x) => s + x, 0) / pqs.length;
  return {
    value: {
      meanPQ: mean,
      medianPQ: agg.medianActualDelta === null ? null : pqs[Math.floor((pqs.length - 1) / 2)],
      minPQ: pqs[0],
      maxPQ: pqs[pqs.length - 1],
      directionalAccuracy: agg.directionalAccuracy,
      deadZoneRate: agg.deadZoneRate,
      confidence: bucketConfidence(scored.length),
      best: scored.reduce((a, b) => (b.pq > a.pq ? b : a)),
      worst: scored.reduce((a, b) => (b.pq < a.pq ? b : a)),
    },
    reason: null,
    sampleSize: scored.length,
    totalOutcomes: outs.length,
    unscoredReasons: Object.keys(unscoredReasons).length ? unscoredReasons : null,
    // ⛔ 冷启动纪律：n<5 的桶不得作为对外结论（prediction-scoring §2.3.4）
    coldStartWarning: scored.length < 5
      ? `样本 ${scored.length} 条 < 5 ⇒ confidence=${bucketConfidence(scored.length)}，按设计不得作为对外结论`
      : null,
  };
}

/** 挂链检查：outcome 能否按 contractId 挂到 ledger 条目上。 */
export function linkageCheck(entries, outcomes) {
  const ids = new Set((entries ?? []).map((e) => e?.contractId).filter(Boolean));
  const outs = Array.isArray(outcomes) ? outcomes : [];
  if (ids.size === 0) return empty(EMPTY_REASONS.NO_LEDGER);
  if (outs.length === 0) return empty(EMPTY_REASONS.NO_OUTCOMES);
  const linked = outs.filter((o) => o?.contractId && ids.has(o.contractId)).length;
  if (linked === 0) return empty(EMPTY_REASONS.NO_OUTCOME_LINKED);
  return {
    value: { ledgerEntries: ids.size, outcomes: outs.length, linked, orphanOutcomes: outs.length - linked },
    reason: null,
    sampleSize: outs.length,
  };
}

/**
 * 报告主体（纯函数）。
 *
 * @param {object} input
 * @param {Array} input.entries  evolution_ledger 行
 * @param {Array} input.outcomes prediction_outcomes 行（可为空数组）
 * @param {object} [input.mountTables] agint_mount 的表（回滚数用）
 * @param {object} [input.filter] {since, generation}
 * @param {string} [input.generatedAt] 注入的时间戳（测试可复现）
 */
export function buildGrowthReport({ entries = [], outcomes = [], mountTables = {}, filter = {}, generatedAt = null } = {}) {
  const sel = selectEntries(entries, filter);
  const chosen = sel.entries;

  const noData = sel.allFilteredOut;
  const ledgerReason = (Array.isArray(entries) && entries.length === 0)
    ? EMPTY_REASONS.NO_LEDGER
    : (noData ? EMPTY_REASONS.FILTERED_OUT : null);

  const metrics = {
    generationRange: ledgerReason ? empty(ledgerReason) : generationRange(chosen),
    decisions: ledgerReason ? empty(ledgerReason) : decisionBreakdown(chosen),
    provenance: ledgerReason ? empty(ledgerReason) : provenanceSplit(chosen),
    rollbacks: ledgerReason ? empty(ledgerReason) : rollbackCount(mountTables),
    outcomes: (Array.isArray(outcomes) && outcomes.length > 0)
      ? { value: outcomes.length, reason: null, sampleSize: outcomes.length }
      // ⛔ 0 条实测读数同样是「没测过」，不是「测了 0 次」——
      //   两者在「进化有没有效果」这个问题上答案完全相反。
      : empty(EMPTY_REASONS.NO_OUTCOMES),
    predictionAccuracy: ledgerReason ? empty(ledgerReason) : predictionAccuracy(outcomes),
    linkage: ledgerReason ? empty(ledgerReason) : linkageCheck(chosen, outcomes),
    successRateTrend: ledgerReason ? empty(ledgerReason) : computeDeployRateTrend(chosen),
  };

  const { gaps, notes } = collectGaps(metrics);

  return {
    schemaVersion: '1.0',
    generatedAt,
    filter: { since: filter.since ?? null, generation: filter.generation ?? null },
    sourceCounts: {
      ledgerEntries: Array.isArray(entries) ? entries.length : 0,
      ledgerEntriesSelected: chosen.length,
      outcomeRows: Array.isArray(outcomes) ? outcomes.length : 0,
    },
    metrics,
    gaps,
    notes,
    hasData: gaps.length === 0,
  };
}

/** 部署率趋势：期初一半 vs 期末一半的 AUTO_DEPLOY 占比。 */
export function computeDeployRateTrend(entries, ledgerReason = null) {
  if (ledgerReason) return empty(ledgerReason);
  const list = (Array.isArray(entries) ? entries : [])
    .slice()
    .sort((a, b) => String(a?.timestamp ?? '').localeCompare(String(b?.timestamp ?? '')));
  if (list.length < 2) {
    return {
      ...empty('TREND_NEEDS_2: 条目不足 2 条 ⇒ 算不出趋势（单点的「趋势」是编的）'),
      sampleSize: list.length,
    };
  }
  const rate = (xs) => xs.filter((e) => e?.summary?.decision === 'AUTO_DEPLOY').length / xs.length;
  const half = Math.max(1, Math.floor(list.length / 2));
  const early = rate(list.slice(0, half));
  const late = rate(list.slice(list.length - half));
  const allReconstructed = list.every((e) => e?.reconstructed === true);
  return {
    value: { earlyRate: early, lateRate: late, delta: late - early, halfSize: half },
    reason: null,
    sampleSize: list.length,
    // ⛔ 全是历史重建条目时，这条「趋势」不是系统在变好，而是
    //   「重建脚本按时间戳排序时，那几天恰好部署得多」。不标出来就会
    //   被读成「AGINT 的部署率涨了 100 个百分点」。
    caveat: allReconstructed
      ? '⛔ 全部条目都是历史重建 ⇒ 该趋势反映「重建脚本读到的事件分布」，**不是**系统的学习曲线'
      : null,
  };
}

/**
 * 汇总「本报告不能回答什么」。
 *
 * ⭐ 刻意**不收** caveat / coldStartWarning —— 那是「有数据但要这样读」，
 *   与「没数据」性质不同。混在一处会让读的人以为「回滚数也是不知道」，
 *   而它其实是**真 0**（表在、0 行）。两类都重要，但不能同列。
 *
 * @returns {{gaps: Array, notes: Array}}
 */
export function collectGaps(metrics) {
  const gaps = [];
  const notes = [];
  for (const [k, m] of Object.entries(metrics ?? {})) {
    if (!m) continue;
    if (m.value === null && m.reason) {
      gaps.push({ metric: k, reason: m.reason, sampleSize: m.sampleSize ?? 0 });
    }
    if (m.coldStartWarning) notes.push({ metric: k, text: m.coldStartWarning, sampleSize: m.sampleSize ?? 0 });
    if (m.caveat) notes.push({ metric: k, text: m.caveat, sampleSize: m.sampleSize ?? 0 });
  }
  return { gaps, notes };
}

// ── 渲染（纯函数，输入 report 对象输出 md 文本）──────────────────────────

/** 三态渲染：null ⇒ 印「无数据 + 原因」，绝不印 0。 */
function renderMetric(label, m, fmt = (v) => String(v)) {
  if (!m) return `- ${label}：_(无该指标)_`;
  if (m.value === null || m.value === undefined) {
    return `- ${label}：**无数据** — ${m.reason ?? '未说明原因'}`;
  }
  const extra = [];
  if (m.sampleSize !== undefined && m.sampleSize !== null) extra.push(`n=${m.sampleSize}`);
  if (m.confidenceNote) extra.push(m.confidenceNote);
  return `- ${label}：${fmt(m.value)}${extra.length ? ` _(${extra.join(' · ')})_` : ''}`;
}

export function renderMarkdown(report) {
  const L = [];
  const m = report.metrics ?? {};
  L.push('# AGINT Growth Report');
  L.push('');
  L.push(`> 生成时间：${report.generatedAt ?? '(未注入)'} · schema ${report.schemaVersion}`);
  L.push(`> 数据源：evolution_ledger ${report.sourceCounts.ledgerEntries} 行（选中 ${report.sourceCounts.ledgerEntriesSelected} 行）· prediction_outcomes ${report.sourceCounts.outcomeRows} 行`);
  const f = report.filter ?? {};
  if (f.since || f.generation) {
    L.push(`> 过滤：${f.since ? `since=${f.since}` : ''}${f.since && f.generation ? ' · ' : ''}${f.generation ? `generation=${f.generation}` : ''}`);
  }
  L.push('');
  L.push('> ⛔ 读法：本报告里「**无数据**」与数字同样重要。它表示**没有测过**，');
  L.push('> 不表示「效果为零」。本报告从不把缺数据渲染成 0。');
  L.push('');

  L.push('## 1. 期间与决策');
  L.push('');
  L.push(renderMetric('代际区间', m.generationRange, (v) => (
    v.distinct.length === 1 ? `${v.from}（仅 1 个取值，无代际跨度）` : `${v.from} … ${v.to}（${v.distinct.length} 个取值）`
  )));
  L.push(renderMetric('决策总数', m.decisions, (v) => `${v.total} 条`));
  if (m.decisions?.value) {
    const d = m.decisions.value;
    L.push(`  - AUTO_DEPLOY ${d.accepted} · PENDING_REVIEW ${d.pending} · REJECT ${d.rejected} · ABSTAIN ${d.abstained}`);
    L.push(`  - 部署率：${(d.deployRate * 100).toFixed(1)}%（分母 = 全部决策，ABSTAIN 不从分母剔除）`);
  }
  L.push(renderMetric('部署率趋势', m.successRateTrend, (v) => `期初 ${(v.earlyRate * 100).toFixed(1)}% → 期末 ${(v.lateRate * 100).toFixed(1)}%（${v.delta >= 0 ? '+' : ''}${(v.delta * 100).toFixed(1)}pp）`));
  L.push(renderMetric('回滚数', m.rollbacks, (v) => `${v} 次`));
  L.push('');

  L.push('## 2. 证据来源（这条决定报告能怎么读）');
  L.push('');
  L.push(renderMetric('条目构成', m.provenance, (v) => `共 ${v.total} 条 · 历史重建 ${v.reconstructed} · 实时 ${v.live}`));
  L.push('');

  L.push('## 3. 预测准确度');
  L.push('');
  L.push(renderMetric('实测读数', m.outcomes, (v) => `${v} 条`));
  L.push(renderMetric('挂链情况', m.linkage, (v) => `${v.linked}/${v.outcomes} 条 outcome 挂到 ledger · 孤儿 outcome ${v.orphanOutcomes} 条`));
  if (m.predictionAccuracy?.value) {
    const p = m.predictionAccuracy.value;
    L.push(`- 平均 PQ：**${p.meanPQ.toFixed(3)}** _（n=${m.predictionAccuracy.sampleSize} · confidence=${p.confidence}）_`);
    L.push(`- PQ 区间：${p.minPQ.toFixed(3)} … ${p.maxPQ.toFixed(3)} · 方向准确率 ${p.directionalAccuracy === null ? '—' : (p.directionalAccuracy * 100).toFixed(1) + '%'} · 死区率 ${p.deadZoneRate === null ? '—' : (p.deadZoneRate * 100).toFixed(1) + '%'}`);
    if (p.best) L.push(`- 最好：PQ ${p.best.pq.toFixed(3)}（${p.best.mutationType ?? '?'} / ${p.best.targetMetric ?? '?'}）`);
    if (p.worst) L.push(`- 最差：PQ ${p.worst.pq.toFixed(3)}（${p.worst.mutationType ?? '?'} / ${p.worst.targetMetric ?? '?'}）`);
  } else {
    L.push(renderMetric('预测准确度', m.predictionAccuracy));
  }
  L.push('');

  L.push('## 4. 本报告不能回答什么');
  L.push('');
  if (!report.gaps || report.gaps.length === 0) {
    L.push('- （无缺口：所有指标都有数据）');
  } else {
    for (const g of report.gaps) L.push(`- **${g.metric}** — ${g.reason}${g.sampleSize ? ` _（样本 ${g.sampleSize}）_` : ''}`);
  }
  L.push('');

  L.push('## 5. 读这份报告时必须知道的事');
  L.push('');
  L.push('> 以下不是缺口 —— 这些指标**有数据**，但数据有前提。');
  L.push('');
  if (!report.notes || report.notes.length === 0) {
    L.push('- （无）');
  } else {
    for (const n of report.notes) L.push(`- **${n.metric}** — ${n.text}${n.sampleSize ? ` _（样本 ${n.sampleSize}）_` : ''}`);
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push('*本报告由 `bin/growth-report.mjs` 生成（只读）。PQ 口径复用 `prediction-scoring.js`，未二次实现。*');
  return `${L.join('\n')}\n`;
}

// ── main ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { json: false, out: null, since: null, generation: null, storages: DEFAULT_STORAGES };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--out') o.out = argv[++i] ?? null;
    else if (a === '--since') o.since = argv[++i] ?? null;
    else if (a === '--generation') o.generation = argv[++i] ?? null;
    else if (a === '--storages') o.storages = argv[++i] ?? null;
    else throw new Error(`未知参数：${a}（不带参数运行即得默认报告）`);
  }
  return o;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const evo = readDomainTables(opts.storages, 'agint_evolution');
  const mount = readDomainTables(opts.storages, 'agint_mount');

  // ⛔ 读不到存储 ⇒ 报「无数据」而不是崩：报告不存在 ≠ 系统坏了。
  //   但「文件不存在」与「表不存在」要分开说（前者是环境问题，后者是数据状态）。
  const entries = evo.ok ? tableRows(evo.tables, 'evolution_ledger') : [];
  const hasOutcomesTable = evo.ok && hasTable(evo.tables, 'prediction_outcomes');
  const outcomes = evo.ok ? tableRows(evo.tables, 'prediction_outcomes') : [];

  const report = buildGrowthReport({
    entries,
    outcomes,
    mountTables: mount.ok ? mount.tables : {},
    filter: { since: opts.since, generation: opts.generation },
    generatedAt: new Date().toISOString(),
  });
  report.source = {
    storages: opts.storages,
    evolutionStorageOk: evo.ok,
    evolutionStorageReason: evo.reason,
    mountStorageOk: mount.ok,
    outcomesTablePresent: hasOutcomesTable,
  };
  // 复核：outcome 表整表缺失时，理由必须说「无表」而不是「0 条」——
  // 「宿主是否懒建这张表」当前**不确定**（路线图 C3），不能替它下结论。
  if (evo.ok && !hasOutcomesTable) {
    report.metrics.outcomes = empty(EMPTY_REASONS.OUTCOMES_TABLE_ABSENT);
    report.metrics.predictionAccuracy = empty(EMPTY_REASONS.OUTCOMES_TABLE_ABSENT);
    const r = collectGaps(report.metrics);
    report.gaps = r.gaps;
    report.notes = r.notes;
    report.hasData = report.gaps.length === 0;
  }
  if (!evo.ok) {
    report.metrics.ledgerAbsent = empty(evo.reason);
    const r = collectGaps(report.metrics);
    report.gaps = r.gaps;
    report.notes = r.notes;
  }

  const md = renderMarkdown(report);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, md, 'utf8');
    process.stdout.write(`[growth-report] 已写入 ${opts.out}\n`);
    process.stdout.write(`  缺口 ${report.gaps.length} 项 · ledger ${report.sourceCounts.ledgerEntries} 行 · outcomes ${report.sourceCounts.outcomeRows} 行\n`);
  } else {
    process.stdout.write(md);
  }
  // ⛔ 退出码恒 0：「无数据」是合法报告，不是脚本失败。
  //   只有「报告生成器自己坏了」才该非 0 —— 那种情况会 throw 到顶层。
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith('growth-report.mjs')) {
  try {
    main();
  } catch (err) {
    console.error(`[growth-report] ❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
