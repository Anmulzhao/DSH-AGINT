/**
 * agint-quality-eval: 单维度评分算法实现（v0.2 初版）
 *
 * 每个 evaluator 接 target + ctx（拿到所有 host services），返回
 * { score: number | null, raw?: unknown, findings: Finding[] }。
 * score = null 表示无数据源 / 评估不充分。
 *
 * 维度列表（与 contract QualityEvaluatorIface.dimensions 对齐）：
 *   - trust, reliability, effectiveness, safety, convention, adaptability, integrability
 *
 * 维度权重（综合分）——v0.2 简版，safety 一票否决：
 *   trust:        0.20
 *   reliability:  0.20
 *   effectiveness: 0.10
 *   safety:       0.30
 *   integrability: 0.20
 *   convention, adaptability: v0.2 无数据源，不计入综合分
 */

import { z } from 'zod';

/** 单维度评估结果 */
const DimensionEvalSchema = z.object({
  score: z.number().min(0).max(1).nullable(),
  raw: z.unknown().optional(),
  findings: z.array(z.object({
    severity: z.enum(['info', 'warn', 'blocker']),
    message: z.string(),
    evidence: z.array(z.string()).default([]),
  })).default([]),
});

/**
 * Trust: 历史评估决策分布
 * 数据源：agint.memory.search(query=targetId)
 *   score = (AUTO_DEPLOY*1 + PENDING_REVIEW*0.5 + REJECT*0) / total
 */
export async function evalTrust(ctx, target) {
  const out = { score: null, findings: [] };
  const memory = ctx.get('agint.memory');
  if (!memory || typeof memory.search !== 'function') {
    out.findings.push({ severity: 'warn', message: 'agint.memory unavailable', evidence: [] });
    return out;
  }
  try {
    const results = await memory.search({ query: target.id, type: 'decision' });
    const items = results?.items || results || [];
    if (items.length === 0) {
      out.score = 0.5; // 无历史 = 中性
      out.findings.push({ severity: 'info', message: 'no historical decisions; neutral score', evidence: [] });
      return out;
    }
    let deploy = 0, pending = 0, reject = 0;
    for (const r of items) {
      const c = String(r.content || '');
      if (c.includes('AUTO_DEPLOY')) deploy++;
      else if (c.includes('PENDING_REVIEW')) pending++;
      else if (c.includes('REJECT')) reject++;
    }
    const total = deploy + pending + reject;
    out.score = total === 0 ? 0.5 : (deploy * 1 + pending * 0.5) / total;
    out.raw = { deploy, pending, reject, total };
  } catch (err) {
    out.findings.push({ severity: 'warn', message: `memory.search failed: ${err.message}`, evidence: [] });
  }
  return out;
}

/**
 * Reliability: 工具失败率
 * 数据源：agint.toolStats.failureRate({ tool: target.id })
 *   score = 1 - failureRate
 *   veto: high failure rate indicates broken component
 */
export async function evalReliability(ctx, target) {
  const out = { score: null, findings: [] };
  const toolStats = ctx.get('agint.toolStats');
  if (!toolStats || typeof toolStats.failureRate !== 'function') {
    out.findings.push({ severity: 'warn', message: 'agint.toolStats unavailable', evidence: [] });
    return out;
  }
  try {
    const fr = await toolStats.failureRate({ tool: target.id });
    if (fr === null || fr === undefined || (typeof fr === 'object' && !fr.tool)) {
      // tool not in stats → no data
      out.score = null;
      out.findings.push({ severity: 'info', message: `no toolStats records for ${target.id}`, evidence: [] });
      return out;
    }
    // 兼容返回格式：{ tool, failureRate, calls } 或裸数字
    const failureRate = typeof fr === 'number' ? fr : fr.failureRate;
    const calls = typeof fr === 'object' ? fr.calls : null;
    out.score = Math.max(0, Math.min(1, 1 - failureRate));
    out.raw = { failureRate, calls };
    if (calls !== null && calls < 5) {
      out.findings.push({ severity: 'info', message: `low sample size (${calls} calls); score may be noisy`, evidence: [] });
    }
  } catch (err) {
    out.findings.push({ severity: 'warn', message: `toolStats.failureRate failed: ${err.message}`, evidence: [] });
  }
  return out;
}

/**
 * Effectiveness: 调用频次 + 平均延迟（反向）
 * 数据源：agint.toolStats.summary()
 *   score = clamp(0..1, calls/100) * (1 - clamp(0..1, avgLatency/5000) * 0.3)
 */
export async function evalEffectiveness(ctx, target) {
  const out = { score: null, findings: [] };
  const toolStats = ctx.get('agint.toolStats');
  if (!toolStats || typeof toolStats.summary !== 'function') {
    out.findings.push({ severity: 'warn', message: 'agint.toolStats unavailable', evidence: [] });
    return out;
  }
  try {
    const summary = await toolStats.summary({});
    const items = summary?.items || summary || [];
    const entry = items.find((s) => s.tool === target.id || s.name === target.id);
    if (!entry) {
      out.findings.push({ severity: 'info', message: `no summary records for ${target.id}`, evidence: [] });
      return out;
    }
    const calls = entry.calls || 0;
    const avgLatency = entry.avgLatencyMs || entry.avgLatency || 0;
    const usage = Math.min(1, calls / 100);
    const speed = 1 - Math.min(1, avgLatency / 5000) * 0.3;
    out.score = usage * speed;
    out.raw = { calls, avgLatency, usage, speed };
  } catch (err) {
    out.findings.push({ severity: 'warn', message: `toolStats.summary failed: ${err.message}`, evidence: [] });
  }
  return out;
}

/**
 * Safety: 匹配的 deny 规则扣分
 * 数据源：agint.rules.list({ tool: target.id })
 *   score = 1 - sum(deductions)
 *   deductions: L1 deny -0.2 each; L2 deny -0.05 each; L3+ no deduction
 */
export async function evalSafety(ctx, target) {
  const out = { score: 1.0, findings: [] }; // 默认 1.0（无 deny）
  const rules = ctx.get('agint.rules');
  if (!rules || typeof rules.list !== 'function') {
    out.findings.push({ severity: 'warn', message: 'agint.rules unavailable', evidence: [] });
    return out;
  }
  try {
    const all = await rules.list({});
    const items = all?.items || all || [];
    const matching = items.filter((r) => r.tool === target.id || r.tool === '*');
    let deduction = 0;
    const breakdown = { L1: 0, L2: 0, L3plus: 0 };
    for (const r of matching) {
      if (r.action !== 'deny') continue;
      const level = r.level || 'L2';
      if (level === 'L1') { deduction += 0.2; breakdown.L1++; }
      else if (level === 'L2') { deduction += 0.05; breakdown.L2++; }
      else { breakdown.L3plus++; }
    }
    out.score = Math.max(0, 1 - deduction);
    out.raw = { matching: matching.length, breakdown };
    if (breakdown.L1 > 0) {
      out.findings.push({
        severity: 'warn',
        message: `${breakdown.L1} L1-deny rule(s) match ${target.id}`,
        evidence: matching.filter(r => r.action === 'deny' && r.level === 'L1').map(r => r.id),
      });
    }
  } catch (err) {
    out.findings.push({ severity: 'warn', message: `rules.list failed: ${err.message}`, evidence: [] });
  }
  return out;
}

/**
 * Convention: 静态代码规范（v0.2 无数据源）
 * v0.3 sandbox 起来后接 scan；当前返 null + info finding
 */
export async function evalConvention(ctx, target) {
  return {
    score: null,
    findings: [{
      severity: 'info',
      message: 'convention evaluation requires sandbox (v0.3); deferred',
      evidence: [],
    }],
  };
}

/**
 * Adaptability: 参数兼容性（v0.2 无数据源）
 * v0.3 sandbox 起来后接；当前返 null
 */
export async function evalAdaptability(ctx, target) {
  return {
    score: null,
    findings: [{
      severity: 'info',
      message: 'adaptability evaluation requires sandbox (v0.3); deferred',
      evidence: [],
    }],
  };
}

/**
 * Sprint 6.2: evalPromptStatic — prompt plugin 静态检查维度
 *
 * 触发条件 (FROZEN-compatible):
 *   target.kind === 'plugin' AND target.tags.includes('prompt-target')
 *
 * 不动 contract EvalTarget.kind enum (FROZEN); 用 tags 标记触发.
 * 输出 score 0..1 (1.0 = 无 violation; 0.0 = blocker / SDK 不可用)
 * 非 prompt target: 返 null + info finding (sentinel, 不计入综合分)
 */
export async function evalPromptStatic(ctx, target) {
  const out = { score: null, findings: [] };
  const isPrompt = target?.tags?.includes('prompt-target');
  if (!isPrompt) {
    out.findings.push({
      severity: 'info',
      message: `prompt-static-check skipped: not a prompt target (kind=${target?.kind ?? 'unknown'}; require tags include 'prompt-target')`,
      evidence: [],
    });
    return out;
  }
  const sdk = ctx.get('agint.promptSDK');
  if (!sdk || typeof sdk.staticCheck !== 'function') {
    out.score = 0.0;
    out.findings.push({
      severity: 'blocker',
      message: 'agint.promptSDK unavailable; cannot static-check prompt',
      evidence: [],
    });
    return out;
  }
  // prompt target 必须自带 manifest + templateText (字段约定)
  const manifest = target.manifest;
  const templateText = target.templateText;
  if (!manifest || !templateText) {
    out.score = 0.0;
    out.findings.push({
      severity: 'blocker',
      message: 'target.manifest or templateText missing; prompt-eval requires both',
      evidence: [],
    });
    return out;
  }
  try {
    const r = sdk.staticCheck({ templateText, manifest });
    // 分数: 1.0 无 violation, 每个 blocker -0.5, 每个 warn -0.1, 限幅到 [0, 1]
    let score = 1.0;
    for (const v of r.violations) {
      if (v.severity === 'blocker') score -= 0.5;
      else if (v.severity === 'warn') score -= 0.1;
    }
    out.score = Math.max(0, Math.min(1, score));
    out.raw = {
      blockers: r.blockers,
      warnings: r.warnings,
      violationCodes: [...new Set(r.violations.map((v) => v.code))],
    };
    if (r.blockers > 0) {
      out.findings.push({
        severity: 'warn',
        message: `prompt has ${r.blockers} blocker(s); static check failed`,
        evidence: r.violations.filter((v) => v.severity === 'blocker').map((v) => v.code),
      });
    }
  } catch (err) {
    out.score = 0.0;
    out.findings.push({
      severity: 'blocker',
      message: `staticCheck threw: ${err.message}`,
      evidence: [],
    });
  }
  return out;
}

/**
 * Integrability: 与 dsh host 的集成度（通过 metrics 探测）
 * 数据源：agint.metrics.summary()
 *   有指标条目 → 1.0；无 → 0.5
 */
export async function evalIntegrability(ctx, target) {
  const out = { score: 0.5, findings: [] };
  const metrics = ctx.get('agint.metrics');
  if (!metrics || typeof metrics.summary !== 'function') {
    out.findings.push({ severity: 'warn', message: 'agint.metrics unavailable', evidence: [] });
    return out;
  }
  try {
    const summary = await metrics.summary();
    const keys = summary?.keys || summary?.items || [];
    const related = keys.filter((k) => typeof k === 'string' && k.includes(target.id));
    out.score = related.length > 0 ? 1.0 : 0.5;
    out.raw = { relatedKeys: related.length };
  } catch (err) {
    out.findings.push({ severity: 'warn', message: `metrics.summary failed: ${err.message}`, evidence: [] });
  }
  return out;
}

/** 7 维权重（综合分计算用）—— 与综合分 §v0.2 简版 对齐
 *  Sprint 6.2 prompt-static 仅对 target.kind='prompt' 计入;其它 target 自动权重 0 */
export const DIMENSION_WEIGHTS = {
  trust:           0.20,
  reliability:     0.20,
  effectiveness:   0.10,
  safety:          0.30,
  convention:      0.00, // v0.2 null，不计入
  adaptability:    0.00, // v0.2 null，不计入
  integrability:   0.20,
  promptStatic:    0.20, // Sprint 6.2: 仅 prompt target
};

/** safety 一票否决阈值（< 此值 → REJECT） */
export const SAFETY_VETO_THRESHOLD = 0.5;

/** 调度器用：维度键顺序（保证 EvalResult.dimensions 顺序稳定）
 *  Sprint 6.2 加 'promptStatic' (仅 prompt target 计入) */
export const DIMENSION_KEYS = [
  'trust', 'reliability', 'effectiveness', 'safety',
  'convention', 'adaptability', 'integrability',
  'promptStatic',
];

/**
 * 一次 evaluate(target) 调用的入口：依次跑 7 个 evaluator，组装 EvalResult
 * 返回 { dimensions: [{key, label, score, veto, raw, findings, children}], harm, findings, evaluatorId }
 */
export async function evaluateAll(ctx, target) {
  const start = Date.now();
  const evaluatorId = `agint-quality-eval@${new Date().toISOString().slice(0, 10)}`;

  const fns = {
    trust: evalTrust,
    reliability: evalReliability,
    effectiveness: evalEffectiveness,
    safety: evalSafety,
    convention: evalConvention,
    adaptability: evalAdaptability,
    integrability: evalIntegrability,
    promptStatic: evalPromptStatic,
  };

  // 并发跑所有 evaluator
  const entries = await Promise.all(
    Object.entries(fns).map(async ([key, fn]) => [key, await fn(ctx, target)])
  );
  const evalResults = Object.fromEntries(entries);

  // 维度标签
  const LABELS = {
    trust: '信任',
    reliability: '可靠性',
    effectiveness: '有效性',
    safety: '安全',
    convention: '规范',
    adaptability: '适应性',
    integrability: '集成性',
  };

  const dimensions = DIMENSION_KEYS.map((key) => {
    const r = evalResults[key];
    const score = r?.score ?? null;
    return {
      key,
      label: LABELS[key],
      score: {
        score, // 0..1 or null
        raw: r?.raw,
        evidence: [], // v0.2 暂不填充
        children: [],
      },
      veto: score === null || (key === 'safety' && score !== null && score < SAFETY_VETO_THRESHOLD),
    };
  });

  // 整 EvalResult.findings = 各维度 findings 合并
  const findings = [];
  for (const [, r] of entries) {
    if (r?.findings) findings.push(...r.findings);
  }

  // HARM 简版：H/M 中性 0.5；A≈trust；R≈reliability
  const trustScore = evalResults.trust?.score ?? 0.5;
  const relScore = evalResults.reliability?.score ?? 0.5;
  const harm = {
    homogeneity: 0.5, // H
    alignment: trustScore, // A ≈ trust
    reduction: relScore, // R ≈ reliability
    mutability: 0.5, // M
  };

  return {
    targetId: target.id,
    kind: target.kind,
    evaluatedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    dimensions,
    harm,
    findings,
    evaluatorId,
  };
}

/**
 * 综合分计算（v0.2 简版）：
 *   score = 100 * sum(weight_i * score_i) / sum(weight_i for i where score_i !== null)
 *   任一维度的 score === null → 该维度不计入分母
 *   safety < SAFETY_VETO_THRESHOLD → null（让 caller 走 REJECT 路径）
 */
export function compositeScore(evalResult) {
  let num = 0;
  let den = 0;
  for (const d of evalResult.dimensions) {
    const s = d.score?.score;
    if (s === null || s === undefined) continue;
    const w = DIMENSION_WEIGHTS[d.key] ?? 0;
    if (w === 0) continue;
    num += w * s;
    den += w;
  }
  if (den === 0) return null;
  const score = (num / den) * 100;
  // safety 一票否决
  const safetyDim = evalResult.dimensions.find((d) => d.key === 'safety');
  if (safetyDim?.score?.score !== null && safetyDim.score.score < SAFETY_VETO_THRESHOLD) {
    return null; // caller should treat as REJECT
  }
  return Math.round(score * 10) / 10; // 保留 1 位小数
}