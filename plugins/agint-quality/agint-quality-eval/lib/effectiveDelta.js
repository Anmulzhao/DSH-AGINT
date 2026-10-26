/**
 * agint-quality-eval/lib/effectiveDelta.js — D-QAF Phase 3「有效进化增量」判定
 *
 * WHY
 * ---
 * `docs/evolution-framework.md` §5 把这条硬约束写进宪法：
 *
 *   有效进化增量 = Δ(任务完成率) / Δ(Token消耗 + 步数 + 时间)
 *   若 ≤ 0，即使 HARM 提升也标记为「无效进化」并拒绝部署
 *
 * 但此前这条公式**只在文档里**：分母的 token 项恒缺（capability-boundary.md §4 F3），
 * 于是公式算不出来、约束从未生效 —— 这正是本仓最讨厌的那种「纸面护栏」。
 * 2026-10-26 D2 收口：tool-stats 落 deltaTokens/tokenSource 并给出
 * `resourceWindow()` 窗口读数，token 项第一次可算。
 *
 * 设计原则（三条，缺一不可）
 * ---------------------------
 * 1. **纯函数**：输入两个窗口读数，输出判定。可被 node --test 直接对照，不依赖宿主。
 * 2. **fail-closed**：token 项不完整 ⇒ 返回 `verdict: 'unknown'` + 明确 reason，
 *    **绝不**把分母悄悄退化成「步数 + 时间」—— 那会变成「看起来测了，其实只测了一半」。
 * 3. **口径单一**：窗口读数由 agint-tool-stats 的 `resourceWindow()` 定义（任务=(sessionId,turn)、
 *    完成=组内全 ok、token 只累加测得值）。本文件不重新定义口径，只做比值与判定。
 *
 * 判定表（denominator = ΔtokensRel + ΔstepsRel + ΔdurationRel，numerator = Δ完成率）
 * -----------------------------------------------------------------------------
 * | 情形 | value | verdict | reason |
 * |---|---|---|---|
 * | 任一窗口无任务 | null | unknown | window-empty |
 * | token 覆盖率 < minTokenCoverage | null | unknown | token-unmeasured |
 * | 基线某项资源 = 0（无法归一化） | null | unknown | baseline-resource-zero |
 * | 分母 > 0 且比值 > 0 | 比值 | effective | ok |
 * | 分母 > 0 且比值 ≤ 0 | 比值 | ineffective | ok |
 * | 分母 = 0（资源没变）+ 完成率上升 | null | effective | zero-resource-growth |
 * | 分母 = 0 + 完成率未上升 | null | ineffective | zero-resource-growth |
 * | 分母 < 0（资源下降）+ 完成率上升 | null | effective | resource-shrink |
 * | 分母 < 0 + 完成率未上升 | null | ineffective | resource-shrink |
 *
 * ⛔ 「unknown」不是「通过」：调用方必须把它当**护栏未生效**处理（周复盘要看得见），
 *    而 `ineffective` 才是拒绝部署的那一条。
 *
 * ⚠️ 比值没有「够不够大」的门槛：宪法只写了「≤ 0 ⇒ 无效」，所以完成率微涨、
 *    资源涨 3 倍时比值仍是正数（判 effective）。「这点收益值不值这个代价」是
 *    上层阈值或人工审批的事 —— 本函数不偷偷把 `0 < value < ε` 改判成无效。
 */

/** token 覆盖率下限：两个窗口都达线才算 token 项可用。 */
export const MIN_TOKEN_COVERAGE = 0.5;

/** 公式原文（打印用，避免各处手抄出漂移）。 */
export const EFFECTIVE_DELTA_FORMULA = 'Δ任务完成率 / (Δtoken + Δ步数 + Δ耗时)';

/**
 * 相对变化：(cur - base) / base。
 * @returns {number|null} base = 0 且 cur = 0 ⇒ 0（没变）；base = 0 且 cur > 0 ⇒ null（无法归一化）
 */
export function relativeDelta(baseVal, curVal) {
  if (!Number.isFinite(baseVal) || !Number.isFinite(curVal)) return null;
  if (baseVal === 0) return curVal === 0 ? 0 : null;
  return (curVal - baseVal) / baseVal;
}

const round = (v, digits = 4) => (v === null || !Number.isFinite(v) ? null : +v.toFixed(digits));

/** 只留判定需要的窗口摘要（不把整窗记录带进返回值）。 */
function compact(window) {
  if (!window || typeof window !== 'object') return null;
  return {
    tasks: window.tasks ?? 0,
    completionRate: window.completionRate ?? null,
    steps: window.steps ?? 0,
    durationMs: window.durationMs ?? 0,
    tokens: window.tokens?.sum ?? 0,
    tokenCoverage: window.tokens?.coverage ?? 0,
    tokenSource: window.tokens?.source ?? null,
    records: window.records ?? 0,
  };
}

/**
 * 判定有效进化增量。
 *
 * @param {object} args
 * @param {object|null} args.baseline  基线窗口读数（tool-stats.resourceWindow 的 offsetDays=days 那一次）
 * @param {object|null} args.current   当期窗口读数（offsetDays=0）
 * @param {number} [args.minTokenCoverage] token 覆盖率下限（默认 0.5）
 * @param {string} [args.origin]       来源标注（'weekly' / 'manual'），只为可读性
 * @returns {{
 *   value: number|null,
 *   verdict: 'effective'|'ineffective'|'unknown',
 *   reason: string,
 *   shouldBlockDeploy: boolean,
 *   numerator: number|null,
 *   denominator: number|null,
 *   terms: { tokens: number|null, steps: number|null, duration: number|null },
 *   minTokenCoverage: number,
 *   baseline: object|null,
 *   current: object|null,
 *   origin: string,
 * }}
 */
export function computeEffectiveDelta({
  baseline = null,
  current = null,
  minTokenCoverage = MIN_TOKEN_COVERAGE,
  origin = 'manual',
} = {}) {
  const base = compact(baseline);
  const cur = compact(current);
  const shell = {
    value: null,
    verdict: 'unknown',
    reason: 'window-empty',
    shouldBlockDeploy: false,
    numerator: null,
    denominator: null,
    terms: { tokens: null, steps: null, duration: null },
    minTokenCoverage,
    baseline: base,
    current: cur,
    origin,
  };

  // ① 两个窗口都要有任务，否则完成率无从比较
  if (!base || !cur || !base.tasks || !cur.tasks) return shell;

  // ② token 项必须完整 —— 这是 F3 的正题：缺了就说缺，不许退回「步数 + 时间」
  if (base.tokenCoverage < minTokenCoverage || cur.tokenCoverage < minTokenCoverage) {
    return {
      ...shell,
      reason: 'token-unmeasured',
      // 把覆盖率原样抛给调用方：周复盘要能看出「离达标还差多少」
      tokenCoverage: { baseline: base.tokenCoverage, current: cur.tokenCoverage },
    };
  }

  // ③ 三项资源相对变化
  const terms = {
    tokens: relativeDelta(base.tokens, cur.tokens),
    steps: relativeDelta(base.steps, cur.steps),
    duration: relativeDelta(base.durationMs, cur.durationMs),
  };
  if (terms.tokens === null || terms.steps === null || terms.duration === null) {
    return {
      ...shell,
      reason: 'baseline-resource-zero',
      terms: { tokens: round(terms.tokens), steps: round(terms.steps), duration: round(terms.duration) },
    };
  }

  const numerator = round(cur.completionRate - base.completionRate);
  const denominator = round(terms.tokens + terms.steps + terms.duration);
  const rounded = {
    tokens: round(terms.tokens),
    steps: round(terms.steps),
    duration: round(terms.duration),
  };

  // ④ 判定
  if (denominator > 0) {
    const value = round(numerator / denominator);
    const effective = value !== null && value > 0;
    return {
      ...shell,
      value,
      verdict: effective ? 'effective' : 'ineffective',
      reason: 'ok',
      shouldBlockDeploy: !effective,
      numerator,
      denominator,
      terms: rounded,
    };
  }

  // 分母 ≤ 0：资源没涨（甚至降了）。此时比值无意义，按「完成率有没有涨」直判。
  const improved = numerator !== null && numerator > 0;
  return {
    ...shell,
    value: null,
    verdict: improved ? 'effective' : 'ineffective',
    reason: denominator === 0 ? 'zero-resource-growth' : 'resource-shrink',
    shouldBlockDeploy: !improved,
    numerator,
    denominator,
    terms: rounded,
  };
}

/**
 * 给周复盘 / 日志用的一行文本。三种 verdict 三套措辞，不许含糊。
 * @param {object} result computeEffectiveDelta 的返回值
 */
export function formatEffectiveDeltaLine(result) {
  const r = result ?? {};
  const b = r.baseline ?? {};
  const c = r.current ?? {};
  const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
  const rate = `${b.completionRate ?? '—'} → ${c.completionRate ?? '—'}`;
  const terms = r.terms ?? {};

  if (r.reason === 'token-unmeasured') {
    return `- 有效进化增量：测不出来（token 覆盖率 基线 ${pct(r.tokenCoverage?.baseline ?? b.tokenCoverage)} / 当期 ${pct(r.tokenCoverage?.current ?? c.tokenCoverage)} < 门限 ${pct(r.minTokenCoverage)}）⇒ 护栏未生效，不能当作通过`;
  }
  if (r.reason === 'window-empty') {
    return '- 有效进化增量：窗口内没有可归属任务（(sessionId, turn) 分组为空）⇒ 无判据';
  }
  if (r.reason === 'baseline-resource-zero') {
    return `- 有效进化增量：基线某项资源为 0，无法归一化（token ${terms.tokens ?? '—'} / 步数 ${terms.steps ?? '—'} / 耗时 ${terms.duration ?? '—'}）`;
  }
  if (r.verdict === 'effective') {
    const how = r.value !== null
      ? `比值 ${r.value}`
      : `完成率上升而资源未涨（${r.reason}）`;
    return `- 有效进化增量：${how}（完成率 ${rate}；Δtoken ${pct(terms.tokens)} / Δ步数 ${pct(terms.steps)} / Δ耗时 ${pct(terms.duration)}）`;
  }
  if (r.verdict === 'ineffective') {
    const how = r.value !== null ? `比值 ${r.value} ≤ 0` : `完成率未上升（${r.reason}）`;
    return `- ⚠️ 无效进化：${how}（完成率 ${rate}；Δtoken ${pct(terms.tokens)} / Δ步数 ${pct(terms.steps)} / Δ耗时 ${pct(terms.duration)}）⇒ 即使 HARM 提升也应拒绝部署`;
  }
  return `- 有效进化增量：未判定（reason=${r.reason ?? 'unknown'}）`;
}
