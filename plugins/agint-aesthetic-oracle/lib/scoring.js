/**
 * agint-aesthetic-oracle: 评分纯函数模块（v2.3 方案 §3 / §4）。
 *
 * 纯函数：输入原子值 → 输出四指标 + 美总分 + 美之三问。零 I/O、零服务访问、
 * 零 LLM——公式是确定性的，任何人拿到同样的原子值必须算出同样的分数。
 *
 * 分层纪律（方案 C / §9.4 的对偶面）：
 *   - 原子观测归 agint-metrics（summary()/series() 的 key + meta）
 *   - 复合派生（本文件）归神谕层；noise_ratio / aesthetic_score 永远不进 metrics
 *
 * v2.3 语义修复的落点（对照评审 P0/P1）：
 *   - §3.1 噪声比（P0-2）：分子 = 「在系统内」的无引用/无证据/重复条目；
 *     REJECTED 候选是门禁正常工作的证据，不进分子
 *   - §3.2 决策确信度：AVG(conf × evidence_compliance)，逐条相乘（不是均值×覆盖率）
 *   - §3.3 冗余度（P1-7）：三域合并公式，分子分母同口径
 *   - §3.4 臃肿度：预算 120KB = 11 技能 × 8-12KB（prompt 工程经验值）
 *   - §4 Q1（P1-4）：恶化≥2→丑；恶化<2 且改善≥3→美；其余→持平（全排序无洞）
 */

// ── 阈值常量（v2.3 §3 标定；改这里 = 改判尺，须走评审）────────────────────

export const THRESHOLDS = {
  /** 噪声比阈值（§3.1）。 */
  NOISE_RATIO: 0.30,
  /** 决策确信度下限（§3.2）。 */
  CONFIDENCE: 0.70,
  /** 冗余度阈值（§3.3）。 */
  REDUNDANCY: 0.05,
  /** 臃肿度预算字节：120KB（§3.4，11 技能 × 8-12KB）。 */
  BLOAT_BUDGET_BYTES: 120 * 1024,
};

/** 四维权重（§3.6 权重累减结构：避免一项满分掩盖四项差）。 */
export const DIM_WEIGHTS = {
  noise: 30,
  confidence: 20,
  redundancy: 20,
  bloat: 30,
};

export const DIM_KEYS = ['noise', 'confidence', 'redundancy', 'bloat'];

const round = (n, d = 4) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ── §3 派生：原子值 → 四个复合比率 ─────────────────────────────────────────

/**
 * 从原子值派生四指标。任一所需原子缺席 → 该指标 { na: true }（广播降 N/A，
 * 总分权重归一，AC-4）。
 *
 * @param {object} a 原子值
 * @param {number} [a.wikiOrphans] wiki 无入链条目数
 * @param {number} [a.wikiContradictions] wiki 矛盾标记数
 * @param {number} [a.ruleDuplicates] rule_lint 命中的 duplicate-pattern 数
 * @param {number} [a.memoryNoEvidence] memory evidence 顶层字段为空的条数
 * @param {number} [a.wikiTotal] wiki 全量页数
 * @param {number} [a.rulesTotal] 规则全量数
 * @param {number} [a.memoryTotal] memory 全量条数
 * @param {number} [a.avgConfXCompliance] Σ(conf×[evidence非空])/N（metrics meta 增补）
 * @param {number} [a.curatorOverlaps] curator 判定的技能重叠对数（可缺省 0；
 *   Day 0 未入 metrics 原子表，当前实测恒 0，接入路径 = metrics-ext 后续增 key）
 * @param {number} [a.skillsTotal] SKILL.md 个数（冗余度分母）
 * @param {number} [a.skillsBytes] Σ SKILL.md 字节（臃肿度分子）
 * @returns {{noise: object, confidence: object, redundancy: object, bloat: object}}
 */
export function deriveComposites(a = {}) {
  const na = (reason) => ({ value: null, na: true, reason });

  // noise = (orphans + contradictions + duplicates + noEvidence) / (wiki+rules+memory)
  let noise;
  {
    const numParts = [a.wikiOrphans, a.wikiContradictions, a.ruleDuplicates, a.memoryNoEvidence];
    const denParts = [a.wikiTotal, a.rulesTotal, a.memoryTotal];
    if (numParts.every(isNum) && denParts.every(isNum)) {
      const num = numParts.reduce((s, v) => s + v, 0);
      const den = denParts.reduce((s, v) => s + v, 0);
      noise = den > 0
        ? { value: round(num / den), na: false, numerator: num, denominator: den }
        : na('分母为 0（wiki/rules/memory 全空）');
    } else {
      noise = na('原子值缺席（wiki.orphans / wiki.contradictions / rules.lintIssues / memory.total）');
    }
  }

  // confidence = AVG(conf × compliance)——metrics 已按逐条口径聚合（avgConfXCompliance）
  const confidence = isNum(a.avgConfXCompliance)
    ? { value: round(a.avgConfXCompliance), na: false }
    : na('avgConfXCompliance 缺席（memory.list 不可用）');

  // redundancy = (duplicates + contradictions + curator_overlaps) / (rules+wiki+skills)
  let redundancy;
  {
    const overlaps = a.curatorOverlaps ?? 0;
    const numParts = [a.ruleDuplicates, a.wikiContradictions, overlaps];
    const denParts = [a.rulesTotal, a.wikiTotal, a.skillsTotal];
    if (numParts.every(isNum) && denParts.every(isNum)) {
      const num = numParts.reduce((s, v) => s + v, 0);
      const den = denParts.reduce((s, v) => s + v, 0);
      redundancy = den > 0
        ? { value: round(num / den), na: false, numerator: num, denominator: den }
        : na('分母为 0（rules/wiki/skills 全空）');
    } else {
      redundancy = na('原子值缺席（rulesTotal / wikiTotal / skillsTotal）');
    }
  }

  // bloat = Σbytes / 120KB（不 clamp：超预算线性扣分）
  const bloat = isNum(a.skillsBytes)
    ? { value: round(a.skillsBytes / THRESHOLDS.BLOAT_BUDGET_BYTES), na: false, bytes: a.skillsBytes, budget: THRESHOLDS.BLOAT_BUDGET_BYTES }
    : na('skillsBytes 缺席（skills 文件系统不可达）');

  return { noise, confidence, redundancy, bloat };
}

// ── §3.6 评分：四比率 → 美总分（N/A 权重归一）──────────────────────────────

/**
 * 扣分计算（单维）。返回 null 表示该维 N/A 不参与。
 *   noise      : 30 × min(nr / 0.30, 1)
 *   confidence : 20 × max((0.70 − c) / 0.70, 0)
 *   redundancy : 20 × min(r / 0.05, 1)
 *   bloat      : 30 × max(0, b − 1)
 */
export function dimDeduction(key, value) {
  const T = THRESHOLDS;
  switch (key) {
    case 'noise': return DIM_WEIGHTS.noise * Math.min(value / T.NOISE_RATIO, 1);
    case 'confidence': return DIM_WEIGHTS.confidence * Math.max((T.CONFIDENCE - value) / T.CONFIDENCE, 0);
    case 'redundancy': return DIM_WEIGHTS.redundancy * Math.min(value / T.REDUNDANCY, 1);
    case 'bloat': return DIM_WEIGHTS.bloat * Math.max(0, value - 1);
    default: return null;
  }
}

/**
 * 美总分（§3.6）。可用维度扣分按权重占比归一回 100 分制（AC-4：缺 key 时
 * 广播仍输出，公式重新归一到剩余维度）：
 *   score = 100 − Σded × (100 / ΣmaxWeight_available)
 * 全维可用时 ΣmaxWeight=100，退化为原公式。
 *
 * @returns {{score: number, dims: object, availableDims: string[], naDims: string[], renormalized: boolean}}
 */
export function computeAestheticScore(composites) {
  let sumDed = 0;
  let sumMaxW = 0;
  const dims = {};
  const availableDims = [];
  const naDims = [];
  for (const key of DIM_KEYS) {
    const c = composites?.[key];
    if (!c || c.na || !isNum(c.value)) {
      dims[key] = { available: false, deduction: null, maxWeight: DIM_WEIGHTS[key] };
      naDims.push(key);
      continue;
    }
    const ded = dimDeduction(key, c.value);
    dims[key] = { available: true, value: c.value, deduction: round(ded), maxWeight: DIM_WEIGHTS[key] };
    sumDed += ded;
    sumMaxW += DIM_WEIGHTS[key];
    availableDims.push(key);
  }
  if (availableDims.length === 0) {
    return { score: null, dims, availableDims, naDims, renormalized: false, note: '四维全部 N/A，无分可打' };
  }
  const renormalized = sumMaxW !== 100;
  const score = round(100 - sumDed * (100 / sumMaxW), 1);
  return { score, dims, availableDims, naDims, renormalized };
}

// ── §4 美之三问 ─────────────────────────────────────────────────────────────

/**
 * Q1：这件事让系统更美了吗？（§4 v2.3 判定，P1-4 修复）
 *
 *   恶化项数 ≥ 2            → 「在变丑」
 *   恶化项数 < 2 且改善 ≥ 3  → 「在变美」
 *   其余                     → 「持平」
 *
 * 恶化/改善按维定义：noise ↑ = 恶化；confidence ↓ = 恶化；redundancy ↑ = 恶化；
 * bloat ↑ = 恶化。N/A 维不参与计数。基线缺席 → 持平（附注）。
 *
 * @param {object} current composites（deriveComposites 输出）
 * @param {object|null} baseline composites（首周基线；null = 未建立）
 */
export function q1Verdict(current, baseline) {
  if (!baseline) {
    return { verdict: 'flat', worseCount: 0, betterCount: 0, note: '基线未建立（首周起算）' };
  }
  const worseDims = { noise: 'up', confidence: 'down', redundancy: 'up', bloat: 'up' };
  let worseCount = 0;
  let betterCount = 0;
  const worseList = [];
  const betterList = [];
  for (const key of DIM_KEYS) {
    const c = current?.[key];
    const b = baseline?.[key];
    if (!c || c.na || !isNum(c.value) || !b || b.na || !isNum(b.value)) continue;
    const diff = round(c.value - b.value);
    if (diff === 0) continue;
    const worsening = worseDims[key] === 'up' ? diff > 0 : diff < 0;
    if (worsening) { worseCount += 1; worseList.push(key); } else { betterCount += 1; betterList.push(key); }
  }
  let verdict;
  if (worseCount >= 2) verdict = 'ugly';
  else if (worseCount < 2 && betterCount >= 3) verdict = 'beautiful';
  else verdict = 'flat';
  return { verdict, worseCount, betterCount, worseList, betterList, note: null };
}

export const Q1_VERDICT_TEXT = {
  beautiful: '在变美',
  ugly: '在变丑',
  flat: '持平',
};

/**
 * Q2：这件事最丑的地方在哪？（§4：取偏离阈值/基线最差者，指到指标级 + 来源）
 * 排序键 = **绝对扣分**（与 §5 示例一致：noise 扣 23.2 > redundancy 扣满 20
 * 时，示例把噪声比报为最丑——绝对分差才是"离满分最远"的直觉口径）。
 * N/A 维不参与。
 */
export function q2Worst(composites, dims) {
  let worst = null;
  for (const key of DIM_KEYS) {
    const d = dims?.[key];
    const c = composites?.[key];
    if (!d?.available || !c || !isNum(c.value)) continue;
    if (!worst || d.deduction > worst.deduction) {
      worst = {
        key,
        value: c.value,
        deduction: d.deduction,
        maxWeight: DIM_WEIGHTS[key],
        ratio: round(d.deduction / DIM_WEIGHTS[key]),
      };
    }
  }
  return worst;
}

/**
 * Q3：建议怎么做才能更美？（§4 映射表，四条全量；纯机械动作 + 必附证据）
 *
 * @param {string} worstKey q2Worst().key
 * @param {object} ctx 证据上下文（各清单；缺了相应字段就降级为机制引用）
 */
export function q3Advice(worstKey, ctx = {}) {
  switch (worstKey) {
    case 'noise': {
      const ids = Array.isArray(ctx.memoryNoEvidenceIds) ? ctx.memoryNoEvidenceIds : null;
      const orphanList = Array.isArray(ctx.wikiOrphanFiles) ? ctx.wikiOrphanFiles : null;
      const head = ctx.memoryNoEvidenceCount
        ? `为 ${ctx.memoryNoEvidenceCount} 条无 evidence 记忆补证据`
        : '归档 wiki orphans';
      const detail = ids
        ? `（id 清单${ids.length >= 50 ? '前 50 条' : ''}：${ids.slice(0, 50).join(', ')}）`
        : (orphanList ? `（orphan 清单：${orphanList.slice(0, 10).join(', ')}${orphanList.length > 10 ? ' …' : ''}）` : '');
      return { advice: `${head}${detail}`, evidence: 'memory 表 evidence 字段扫描 + wiki_lint 报告' };
    }
    case 'redundancy': {
      const issues = Array.isArray(ctx.ruleLintIssues) ? ctx.ruleLintIssues : [];
      const dups = issues.filter((i) => i?.kind === 'duplicate-pattern');
      const pairs = dups.map((i) => `${i.ruleId}+${i.with}`).join(', ');
      return {
        advice: `合并 rule_lint 命中的 duplicate 规则${pairs ? `：${pairs}` : ''}`,
        evidence: 'rule_lint issues 明细',
      };
    }
    case 'confidence': {
      const rows = Array.isArray(ctx.lowConfidenceNoEvidence) ? ctx.lowConfidenceNoEvidence : [];
      const head = '定向复核低置信且无证据的 lesson 条目';
      const detail = rows.length ? `（${rows.slice(0, 10).join(', ')}${rows.length > 10 ? ' …' : ''}）` : '';
      return { advice: `${head}${detail}`, evidence: 'memory id + confidence 排序列表' };
    }
    case 'bloat': {
      return {
        advice: `归档 curator 判定陈旧/重叠的技能（当前 ${ctx.skillsBytes ?? '?'} 字节 / 预算 ${THRESHOLDS.BLOAT_BUDGET_BYTES}）`,
        evidence: 'curator overlaps / 陈旧检测输出',
      };
    }
    default:
      return { advice: null, evidence: null };
  }
}

/**
 * 一步到位：原子值 → 完整美评结构（派生 + 总分 + 三问）。
 * 供 broadcast.js 与标定脚本共用——保证「测的就是跑的」。
 */
export function evaluateAesthetics(atomic, { baseline = null, adviceCtx = {} } = {}) {
  const composites = deriveComposites(atomic);
  const scored = computeAestheticScore(composites);
  const verdict = q1Verdict(composites, baseline);
  const worst = scored.score !== null ? q2Worst(composites, scored.dims) : null;
  const advice = worst ? q3Advice(worst.key, adviceCtx) : { advice: null, evidence: null };
  return { composites, scored, verdict, worst, advice };
}
