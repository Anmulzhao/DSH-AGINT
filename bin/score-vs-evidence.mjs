#!/usr/bin/env node
/**
 * bin/score-vs-evidence.mjs —— 「日报分数能不能当判断标准」的可证伪对照
 *
 * ## 它要回答什么
 *
 * 用户问：「那个分数很窄，而且经常通过公式得出来」「有没有一个判断标准」。
 * 本脚本不替他下结论，而是把问题拆成**可证伪的两问**：
 *
 *   ① 左侧（aesthetic_score）有没有一条连续的时间序列？
 *   ② 右侧（能力证据）有没有一条**可与之对拍**的时间序列？
 *
 * 只有两问都是「有」，才谈得上「分数涨跌是否对应能力涨跌」。
 * 任何一侧缺序列，就输出 `NOT_COMPARABLE` / `INSUFFICIENT`，**绝不在空数据上
 * 编一个相关系数**。这与 growth-report 的「空数据输出无数据，绝不输出 0」同源。
 *
 * ## ⭐ 三条不能破的纪律
 *
 * 1. **0 ≠ 能力为零**：某一周「能力事件 0 条」是「这一周没采到证据事件」，
 *    不是「能力为零」。表在的 0 行是真 0，但它的语义是**没采**，不是**没有能力**。
 * 2. **事件流 ≠ 状态序列**：`capability_map` 只有当前行 + `lastVerifiedAt`，
 *    没有历史快照。若它只覆盖 1 个 ISO 周，右侧就没有「能力状态随时间变化」
 *    这条线，只有「某周发生了几个事件」—— 两者不能拿来对拍，直接判 NOT_COMPARABLE。
 * 3. **只当假设生成器**：即使算出了方向一致率，也**不构成判定**。
 *    `aesthetic_score` 是四维内部卫生指标的确定性公式（零 LLM、零服务访问），
 *    不是能力分数；判定权在外部冻结基准 + 人（proposals/agint-external-anchor-eval.md）。
 *
 * ## 依赖边界
 *
 * - ⛔ 只读，永不写存储文件；`--out` 只写用户指定的报告。
 * - ⛔ 不重算分数：直接读 `oracle_broadcasts.score`（权威落盘值）。
 * - ⛔ 复用 `evolution-evidence.mjs` 的 `isoWeek` / `weeklyDedup` / `readDomain` /
 *   `resolveStorages`（同源原则，不许两份 ISO 周实现漂移）。
 *
 * 用法：
 *   node bin/score-vs-evidence.mjs --storages <dir>
 *   node bin/score-vs-evidence.mjs --storages <dir> --json
 *   node bin/score-vs-evidence.mjs --storages <dir> --out <file>
 *
 * 退出码：0 = 生成成功（含 NOT_COMPARABLE / INSUFFICIENT 这些诚实结果）
 *        1 = 存储根未指定 / 脚本自身出错
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isoWeek,
  weeklyDedup,
  readDomain,
  resolveStorages,
  tableExists,
  ok,
  noData,
} from './evolution-evidence.mjs';
// ⛔ tableRows 的真源在 growth-report.mjs（evolution-evidence 只引用、未转发）；
//    直接取同一份实现，不许在这里抄一个 dict/array 判定。
import { tableRows } from './growth-report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DOMAIN_NAMES = Object.freeze([
  'agint_aesthetic_oracle',
  'agint_self_model',
  'agint_curriculum',
  'agint_evolution',
  'agint_evolve',
]);

/** 方向一致率至少要这么多「可比周对」才给读数（少于此拒绝出结论）。 */
export const MIN_COMPARABLE_WEEKS = 4;
/** 分数变化小于这个量级视为持平（日内噪声本身就有这个量级）。 */
const SCORE_EPS = 0.5;

/** 按 ISO 周聚合「事件数」。⛔ 计数本身不表示能力水平。 */
export function eventsByWeek(rows, timeField, predicate = () => true) {
  const out = new Map();
  for (const r of rows ?? []) {
    const wk = isoWeek(r?.[timeField] ?? '');
    if (!wk) continue;
    if (!predicate(r)) continue;
    out.set(wk, (out.get(wk) ?? 0) + 1);
  }
  return out;
}

/** 相邻可比周的 Δscore 符号 vs Δevidence 符号。无可区分对 ⇒ 无数据。 */
export function directionalAgreement(weeks) {
  const pairs = [];
  for (let i = 1; i < weeks.length; i++) {
    const p = weeks[i - 1];
    const c = weeks[i];
    if (p.score === null || c.score === null) continue;
    if (!p.comparable || !c.comparable) continue;
    const ds = c.score - p.score;
    const de = c.evidenceTotal - p.evidenceTotal;
    // ⛔ 分数持平或证据事件数没变 ⇒ 这一对没有区分力，不能算「一致」也不能算「不一致」
    if (Math.abs(ds) < SCORE_EPS || de === 0) continue;
    pairs.push({
      week: c.week, scoreDelta: ds, evidenceDelta: de,
      agree: Math.sign(ds) === Math.sign(de),
    });
  }
  if (pairs.length === 0) {
    return noData('NO_DIRECTION_PAIRS: 没有一对相邻周同时满足「分数有变化」且「证据事件数有变化」⇒ 方向一致率无从谈起');
  }
  const agree = pairs.filter((p) => p.agree).length;
  return ok({ agree, total: pairs.length, rate: agree / pairs.length, pairs }, pairs.length);
}

/**
 * 对照主体（纯函数）。
 * @param {object} input
 * @param {object} input.domains { 域名: readDomain() 的结果 }
 */
export function buildScoreVsEvidence({ domains = {}, storages = null, generatedAt = null } = {}) {
  const t = (name) => domains[name]?.tables ?? {};
  const available = (name) => domains[name]?.ok === true;

  const scoreRows = tableRows(t('agint_aesthetic_oracle'), 'oracle_broadcasts')
    .filter((r) => r?.outcome === 'ok' && (r.kind === 'daily' || r.kind === 'weekly'))
    .filter((r) => Number.isFinite(Date.parse(r.ts ?? '')));
  const weekly = weeklyDedup(scoreRows);

  const cap = tableRows(t('agint_self_model'), 'capability_map');
  const attempts = tableRows(t('agint_curriculum'), 'attempts');
  const outcomes = tableRows(t('agint_evolution'), 'prediction_outcomes');
  const executions = tableRows(t('agint_evolve'), 'execution');

  const capCAN = eventsByWeek(cap, 'lastVerifiedAt', (r) => r.status === 'CAN');
  const curPass = eventsByWeek(attempts, 'verifiedAt', (r) => r.result === 'pass');
  const measured = eventsByWeek(outcomes, 'measuredAt', (r) => Number.isFinite(r.actualDelta));
  const succeeded = eventsByWeek(executions, 'finishedAt', (r) => r.state === 'succeeded' && r.ok === true);

  // 能力图谱覆盖的周数：决定右侧有没有「状态序列」而不只是「事件流」
  const capWeeks = new Set(cap.map((r) => isoWeek(r.lastVerifiedAt ?? '')).filter(Boolean));

  const weeks = weekly.map((s) => {
    const evidence = {
      capabilityCAN: capCAN.get(s.week) ?? 0,
      curriculumPass: curPass.get(s.week) ?? 0,
      measuredOutcomes: measured.get(s.week) ?? 0,
      succeededExecutions: succeeded.get(s.week) ?? 0,
    };
    const evidenceTotal = Object.values(evidence).reduce((a, b) => a + b, 0);
    return {
      week: s.week,
      score: typeof s.score === 'number' ? s.score : null,
      worstKey: s.worstKey ?? null,
      evidence,
      evidenceTotal,
      comparable: evidenceTotal > 0,
    };
  });

  const comparableWeeks = weeks.filter((w) => w.comparable).length;
  let verdict;
  let verdictReason;
  let directional = noData('NOT_EVALUATED: 未达到可对照条件，按设计不计算方向一致率');

  if (!available('agint_aesthetic_oracle') || !tableExists(t('agint_aesthetic_oracle'), 'oracle_broadcasts') || weekly.length === 0) {
    verdict = 'NO_SCORE_SERIES';
    verdictReason = 'oracle_broadcasts 不可读 / 无 ok 的 daily·weekly 行 ⇒ 左侧没有分数序列';
  } else if (capWeeks.size < 2) {
    verdict = 'NOT_COMPARABLE';
    verdictReason = `能力图谱只覆盖 ${capWeeks.size} 个 ISO 周（${[...capWeeks].join(', ') || '无'}）⇒ 右侧没有跨周「能力状态序列」，只有事件流；⛔ 事件流与状态序列不能对拍`;
  } else if (comparableWeeks < MIN_COMPARABLE_WEEKS) {
    verdict = 'INSUFFICIENT';
    verdictReason = `可比周 ${comparableWeeks} 个 < ${MIN_COMPARABLE_WEEKS} ⇒ 拒绝出方向一致率（在 ${weeks.length} 个分数周上算相关系数等于编数据）`;
  } else {
    verdict = 'OBSERVATIONAL';
    verdictReason = `可比周 ${comparableWeeks} 个 ⇒ 给一组观测一致率；⛔ 它只是假设生成器，不构成「分数能当能力标准」的判定`;
    directional = directionalAgreement(weeks);
  }

  const scoreSeries = weekly.filter((s) => typeof s.score === 'number').map((s) => s.score);
  return {
    schemaVersion: '1.0',
    generatedAt,
    source: {
      storages,
      domains: Object.fromEntries(Object.entries(domains).map(([k, v]) => [k, {
        ok: v.ok, reason: v.reason, rows: v.rows ?? {},
      }])),
    },
    // ⛔ 分数序列本身只是读数，不是「智能水平」
    scoreSeries: {
      weeklyPoints: weeks.length,
      first: scoreSeries.length ? { week: weeks[0].week, score: scoreSeries[0] } : null,
      last: scoreSeries.length ? { week: weeks[weeks.length - 1].week, score: scoreSeries[scoreSeries.length - 1] } : null,
      delta: scoreSeries.length >= 2 ? scoreSeries[scoreSeries.length - 1] - scoreSeries[0] : null,
      saturated: scoreSeries.length >= 3 && scoreSeries.slice(-3).every((v) => v >= 99),
    },
    capabilitySnapshotWeeks: [...capWeeks].sort(),
    comparableWeeks,
    weeks,
    verdict,
    verdictReason,
    directional,
  };
}

// ── 渲染 ──────────────────────────────────────────────────────────────────

export function renderMarkdown(r) {
  const L = [];
  L.push('# 日报分数 ↔ 能力证据对照（可证伪体检）');
  L.push('');
  L.push(`> 生成时间：${r.generatedAt ?? '(未注入)'} · schema ${r.schemaVersion}`);
  L.push(`> 存储根：\`${r.source?.storages ?? '(未记录)'}\``);
  L.push('');
  L.push('> ⛔ **本报告不判定「AGINT 有没有在进化」**。它只检验：');
  L.push('> 分数序列与能力证据序列**能不能对拍**。判定权在外部冻结基准与人。');
  L.push('> **`0 条能力事件` = 那一周没采到证据，不等于「能力为零」；事件流 ≠ 状态序列。**');
  L.push('');
  L.push(`**结论（可对照性）：\`${r.verdict}\`** — ${r.verdictReason}`);
  L.push('');
  const s = r.scoreSeries;
  if (s.first && s.last) {
    L.push(`分数序列：${s.weeklyPoints} 周 · ${s.first.week} ${s.first.score} → ${s.last.week} ${s.last.score}`
      + `（Δ ${s.delta >= 0 ? '+' : ''}${Number(s.delta).toFixed(1)}）`
      + (s.saturated ? ' · ⚠ 末 3 周均 ≥99（分数饱和，已无区分力）' : ''));
  } else {
    L.push('分数序列：**无数据** — 左侧没有可读的周序列');
  }
  L.push(`能力图谱覆盖周：${r.capabilitySnapshotWeeks.length ? r.capabilitySnapshotWeeks.join(', ') : '（无）'} · 可比周 ${r.comparableWeeks}/${s.weeklyPoints}`);
  L.push('');

  L.push('## 逐周对照');
  L.push('');
  if (!r.weeks.length) {
    L.push('- （无周序列：左侧没有可读的广播）');
  } else {
    L.push('| ISO 周 | 分数 | 最丑维 | CAN 验证 | 课程通过 | 实测读数 | 成功执行 | 证据合计 | 可比 |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const w of r.weeks) {
      const e = w.evidence;
      L.push(`| ${w.week} | ${w.score === null ? '无数据' : w.score} | ${w.worstKey ?? '—'} | ${e.capabilityCAN} | ${e.curriculumPass} | ${e.measuredOutcomes} | ${e.succeededExecutions} | ${w.evidenceTotal} | ${w.comparable ? '是' : '否'} |`);
    }
  }
  L.push('');

  L.push('## 方向一致率');
  L.push('');
  if (r.directional.value === null) {
    L.push(`- **无数据** — ${r.directional.reason}`);
  } else {
    const d = r.directional.value;
    L.push(`- 相邻周方向一致 ${d.agree}/${d.total}（${(d.rate * 100).toFixed(0)}%） _(n=${r.directional.sampleSize})_`);
    L.push('- ⛔ 这是**观测一致率，不是判定**：`aesthetic_score` 是四维内部卫生指标的确定性公式，不是能力分数；右侧是事件计数不是能力状态。');
  }
  L.push('');

  L.push('## 读法（这四条决定本报告能怎么用）');
  L.push('');
  L.push('1. 分数上涨只说明「内部卫生指标的扣分变小」。`aesthetic_score` 是四维内部卫生指标的确定性公式（零 LLM、零服务访问），**不是能力分数**；纲领写明「只有趋势，没有及格线」「美是方向，不是门槛」。');
  L.push('2. 右侧四类都是**事件计数**（当周写入了几条），不是「当时能力有多高」。没有历史快照就没有状态序列。');
  L.push('3. `capability_map` 的 `CAN / CANNOT / UNCERTAIN` 是三态标签，不是分数；`UNCERTAIN` 不得读成「能力为零」。');
  L.push('4. 判定标准现成方案是 `proposals/agint-external-anchor-eval.md`（2026-10-01 存档）：判定权外部锚定，自评只能当假设生成器。');
  L.push('');
  L.push('## 数据源');
  L.push('');
  for (const [d, info] of Object.entries(r.source?.domains ?? {})) {
    L.push(`- \`${d}\`：${info.ok ? '可读' : `**不可读** — ${info.reason}`}`);
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push('*本报告由 `bin/score-vs-evidence.mjs` 生成（只读）。ISO 周口径复用 `bin/evolution-evidence.mjs`，分数取落盘权威值，未重算。*');
  return `${L.join('\n')}\n`;
}

// ── IO ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { json: false, out: null, storages: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--out') o.out = argv[++i] ?? null;
    else if (a === '--storages') o.storages = argv[++i] ?? null;
    else throw new Error(`未知参数：${a}`);
  }
  return o;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const storages = resolveStorages(opts.storages);
  const domains = Object.fromEntries(DOMAIN_NAMES.map((n) => [n, readDomain(storages, n)]));
  const r = buildScoreVsEvidence({ domains, storages, generatedAt: new Date().toISOString() });
  const md = renderMarkdown(r);

  if (opts.json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, md, 'utf8');
    process.stdout.write(`[score-vs-evidence] 已写入 ${opts.out}\n`);
    process.stdout.write(`  可对照性 ${r.verdict} · 可比周 ${r.comparableWeeks}/${r.scoreSeries.weeklyPoints}\n`);
  } else process.stdout.write(md);
  // ⛔ 退出码恒 0：NOT_COMPARABLE / INSUFFICIENT 是诚实结果，不是失败。
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith('score-vs-evidence.mjs')) {
  try {
    main();
  } catch (err) {
    console.error(`[score-vs-evidence] ❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
