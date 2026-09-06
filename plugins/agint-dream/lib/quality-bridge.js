/**
 * agint-dream × agint-quality-eval bridge (task 2 / v0.2 REM phase).
 *
 * C1 scope（2026-09-06）：薄包装层 + target 解析 + candidate 字段映射。
 * 不接 sweep.js 主路径 —— REM 阶段调用留到 C2。
 *
 * 决策（写代码时使用）：
 * - Q1 (target 范围) = A1: 所有 9 个 BASELINE_TARGETS（每次 sweep 9 次 evaluate ≈ 1-2s，简单稳定）
 * - Q2 (target.path) = B3: 优先 host 副本（$DSH_HOME/profiles/web/plugins/...），
 *   回退 AGINT_HOME 仓路径（$AGINT_HOME/plugins/...），保证 evaluate 拿到真实 path
 *
 * 已知边界：
 * - qualityEvaluator 是 Sprint 12 A1 T1 影子期（评估结果写 shadow ring buffer，
 *   不进 model 工具）—— 当前 host 端可能在跑 shadow 模式，evaluate() 拿到的是
 *   shadow snapshot 还是真 EvalResult 以 host 实际为准。C2 接 REM 时必先实测。
 * - target.kind 取值 'plugin'/'skill'/'preset'/'composite'，本文件只解析 'plugin'
 *   （BASELINE_TARGETS 9 个全是 plugin）
 * - 自评约束：agint-quality-eval 自身排除（虽然不在 BASELINE_TARGETS，但本桥
 *   仍做防御性过滤，避免未来 BASELINE_TARGETS 变更引入自评）
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

// v0.2 (Sprint 13)：与 plugins/agint-quality/agint-quality-eval/lib/regression.js BASELINE_TARGETS 对齐
// 故意硬编码而不是 import 那个常量：dream 不应依赖 quality-eval 的源码路径
// （跨 plugin 边界 import 会绑死版本号）
// v0.2 C1 (2026-09-06)：导出给 index.js 的 status() 透出 target 清单
// （原来只是模块内 const，index.js import 它 → ESM 静态检查报
//   "does not provide an export named 'DREAM_BASELINE_TARGETS'"，host 起不来）
export const DREAM_BASELINE_TARGETS = Object.freeze([
  { id: 'agint-memory', kind: 'plugin' },
  { id: 'agint-rules', kind: 'plugin' },
  { id: 'agint-metrics', kind: 'plugin' },
  { id: 'agint-cron', kind: 'plugin' },
  { id: 'agint-dream', kind: 'plugin' }, // 评估 dream 自身用于自省（不在 quality-eval self-exclusion 里）
  { id: 'agint-evolve', kind: 'plugin' },
  { id: 'agint-wiki', kind: 'plugin' },
  { id: 'agint-tool-stats', kind: 'plugin' },
  { id: 'agint-quality-contract', kind: 'plugin' },
]);

const SELF_PLUGIN_ID = 'agint-quality-eval'; // 与 quality-eval 自评约束一致
const TARGET_KINDS = new Set(['plugin', 'skill', 'preset', 'composite']);

const DEFAULTS = Object.freeze({
  // 评估单个 target 的超时（毫秒）—— evaluate 内部还会触发 sandbox.runSmoke
  evaluateTimeoutMs: 30_000,
  // 批量评估最大并发数 —— 1 是 conservative（quality-eval 的 evaluateAll 串行），
  // 但 bridge 走 Promise.all 并发更省时间
  evaluateConcurrency: 4,
});

/**
 * 解析 target.path：优先 host 副本路径，回退 AGINT_HOME 仓路径。
 *
 * 决策依据（task 2 Q2 = B3）：
 * - qualityEvaluator.evaluate 触发 sandbox.runSmoke 需要真实 path
 * - host 加载的是 $DSH_HOME/profiles/web/plugins/... 副本（仓副本未必同步）
 * - 但 sandbox 跑 smoke 可能要读源码（qualityEval 评估 plugin 自身），源码在仓
 * - 两个路径都试，谁存在用谁
 *
 * @param {object} target - { id, kind, version?, path? }
 * @param {object} env - { DSH_HOME, AGINT_HOME }
 * @returns {string|null} - 找到的 path；都找不到返回 null
 */
export function resolveTargetPath(target, env = {}) {
  if (!target || typeof target.id !== 'string' || target.id.length === 0) return null;
  const dshHome = env.DSH_HOME || process.env.DSH_HOME || '';
  const agintHome = env.AGINT_HOME || process.env.AGINT_HOME || '';
  // host 副本路径
  if (dshHome) {
    const hostPath = join(dshHome, 'profiles/web/plugins', target.id);
    if (existsSync(join(hostPath, 'manifest.json'))) return hostPath;
    if (existsSync(hostPath)) return hostPath;
  }
  // 仓路径
  if (agintHome) {
    const repoPath = join(agintHome, 'plugins', target.id);
    if (existsSync(join(repoPath, 'manifest.json'))) return repoPath;
    if (existsSync(repoPath)) return repoPath;
  }
  return null;
}

/**
 * 把 BASELINE_TARGETS 解析成完整 EvalTarget shape（带 path + version + tags）。
 *
 * @param {object} [opts]
 * @param {string} [opts.DSH_HOME] - host home（默认 process.env.DSH_HOME）
 * @param {string} [opts.AGINT_HOME] - 数据根（默认 process.env.AGINT_HOME）
 * @param {string[]} [opts.excludeIds] - 排除的 plugin id（默认排除 agint-quality-eval）
 * @returns {Array<{id: string, kind: string, version: string, path: string|null, tags: string[]}>}
 */
export function resolveEvalTargets(opts = {}) {
  const dshHome = opts.DSH_HOME || process.env.DSH_HOME || '';
  const agintHome = opts.AGINT_HOME || process.env.AGINT_HOME || '';
  const env = { DSH_HOME: dshHome, AGINT_HOME: agintHome };
  const exclude = new Set([SELF_PLUGIN_ID, ...(opts.excludeIds ?? [])]);

  return DREAM_BASELINE_TARGETS
    .filter((t) => !exclude.has(t.id))
    .map((t) => {
      // path 不传（2026-09-06 修）：dream 只需要 quality-eval 的质量分（compositeScore），
      // 不需要真沙箱冒烟（sandbox gate 是 D-QAF 部署决策用的 Phase 2）。evaluate() line 212
      // `if (sandbox && ... && target.path)` —— 不传 path 字段（undefined）跳过 sandbox gate，直接走
      // evaluateAll(ctx, target) 完整评分。
      // **注意**：EvalTargetSchema 的 path 是 `z.string().optional()` —— optional 接受 undefined 但
      // 拒绝 null。之前传 `path: null` 触发 zod invalid_type 校验失败 → evaluate() 抛错 → status='error'
      // → compositeMean=n/a。必须用 undefined（不传字段），不能用 null。
      // evaluateAll 只用 target.id/kind/tags，不用 path。
      return {
        id: t.id,
        kind: t.kind,
        version: '0.0.0', // bridge 不解析 manifest.version，留 0.0.0 让 qualityEvaluator 自己取
        // path 不传（undefined）—— 让 optional 通过 + 跳过 sandbox gate
        tags: ['dream-baseline', `host:${dshHome ? 'yes' : 'no'}`, `repo:${agintHome ? 'yes' : 'no'}`],
      };
    });
}

/**
 * 评估单个 target —— 强降级路径，**永不抛错**。
 *
 * @param {object} ctx - cordis host ctx
 * @param {object} target - EvalTarget shape
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] - 默认 30s
 * @returns {Promise<{targetId: string, status: 'ok'|'degraded'|'error'|'unavailable', compositeScore: number|null, harmScore: number|null, reason: string|null, evaluatedAt: string|null, raw: object|null}>}
 */
export async function evaluatePlugin(ctx, target, opts = {}) {
  const evaluatedAt = new Date().toISOString();
  const targetId = target?.id ?? 'unknown';
  const baseResult = {
    targetId,
    status: 'unavailable',
    compositeScore: null,
    harmScore: null,
    reason: null,
    evaluatedAt,
    raw: null,
  };

  // ── 防御性：target 形状校验 ────────────────────────────────────────────
  if (!target || !TARGET_KINDS.has(target.kind)) {
    return { ...baseResult, status: 'error', reason: `invalid target kind: ${target?.kind}` };
  }
  if (!target.id || target.id === SELF_PLUGIN_ID) {
    return { ...baseResult, status: 'error', reason: target.id === SELF_PLUGIN_ID ? 'self-evaluation refused' : 'missing target.id' };
  }

  // ── ctx 不可用 ──────────────────────────────────────────────────────────
  if (!ctx || typeof ctx.get !== 'function') {
    return { ...baseResult, reason: 'ctx unavailable' };
  }

  // ── qualityEvaluator service 不可用 ──────────────────────────────────
  const evaluator = ctx.get('agint.qualityEvaluator');
  if (!evaluator || typeof evaluator.evaluate !== 'function') {
    return { ...baseResult, reason: 'agint.qualityEvaluator service unavailable' };
  }

  // ── 真实评估（带 timeout）────────────────────────────────────────────
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.evaluateTimeoutMs;
  let timer = null;
  try {
    const evalPromise = evaluator.evaluate(target);
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`evaluate timeout after ${timeoutMs}ms`)), timeoutMs);
    });
    const result = await Promise.race([evalPromise, timeoutPromise]);
    if (timer) clearTimeout(timer);

    // 解析 compositeScore：调 quality-eval 暴露的 `score(evalResult)` service
    // （plugins/agint-quality/agint-quality-eval/lib/index.js line 272），
    // 拿 0-100 真值；null 表示 safety 一票否决（C3 真值接入，0 行上游改动）
    // 见 C3 提案 78dbb9e3-... + memory d54a67f4-...
    // B 兜底（老板 2026-09-06 拍板）：compositeScore null 时区分两种情况——
    //   - 真 safety veto（result.dimensions 里 safety.score < 0.5 或 null = sandbox REJECT）
    //     → 保留 null（诚实反映被拒，不掩盖信号）
    //   - 非 veto（safety 健康但其它维度数据源不可用 → compositeScore null）
    //     → 给中性 50（数据源缺 + 评分退化时的中性兜底，让 boost 不总是 0）
    let compositeScore = null;
    if (typeof evaluator.score === 'function' && result && typeof result === 'object') {
      try {
        compositeScore = await evaluator.score(result);
        // 安全归一化：compositeScore 应是 number|null
        if (typeof compositeScore !== 'number' && compositeScore !== null) compositeScore = null;
      } catch (err) {
        // score 失败不阻断 evaluate 已成功的 result；fallback 到 null（由下方兜底处理）
        compositeScore = null;
      }
      // B 兜底：null 时区分 veto vs 数据源缺
      if (compositeScore === null && Array.isArray(result.dimensions)) {
        const safety = result.dimensions.find((d) => d.key === 'safety');
        const safetyScore = safety?.score?.score;
        const isVeto = safetyScore === null || safetyScore === undefined || safetyScore < 0.5;
        if (!isVeto) {
          compositeScore = 50; // 数据源不可用但无 veto → 中性 50（0-100 标量）
        }
      }
    }
    const harm = result?.harm ?? null;
    const harmScore = harm ? (homogeneityAlignmentReductionMutabilityAvg(harm)) : null;

    // status 判定（修正，2026-09-06）：
    // - 原逻辑用 dimensions.length > 0 标 ok —— sandbox REJECT 的 EvalResult 只有 1 个
    //   safety=0 维度也被标 ok，误导 ok=8/9。
    // - 修正：dimensions.length >= 2（至少有 trust + 其它）才算评估完整；< 2 标 degraded
    //   （sandbox REJECT 或数据源全缺通常只有 safety 维度）
    // - compositeScore null + 非 veto（B 兜底给 50）→ 算 ok（数据源缺但评估跑了）
    const isReject = (result?.findings ?? []).some((f) => f.severity === 'blocker');
    const dimensionCount = Array.isArray(result?.dimensions) ? result.dimensions.length : 0;
    const evalStatus = dimensionCount >= 2 || (compositeScore !== null && !isReject) ? 'ok' : 'degraded';

    return {
      targetId,
      status: evalStatus,
      compositeScore,
      harmScore,
      reason: result?.findings?.[0]?.message ?? null,
      evaluatedAt: result?.evaluatedAt ?? evaluatedAt,
      raw: result ?? null,
    };
  } catch (err) {
    if (timer) clearTimeout(timer);
    return {
      ...baseResult,
      status: 'error',
      reason: err?.message ? String(err.message) : 'evaluate threw',
      raw: null,
    };
  }
}

/**
 * 批量评估 —— Promise.all 并发（C1 默认 4 并发），结果数组与输入 target 顺序对齐。
 *
 * @param {object} ctx
 * @param {Array} targets - resolveEvalTargets() 输出
 * @param {object} [opts]
 * @returns {Promise<Array>}
 */
export async function evaluatePlugins(ctx, targets, opts = {}) {
  if (!Array.isArray(targets) || targets.length === 0) return [];
  const concurrency = opts.concurrency ?? DEFAULTS.evaluateConcurrency;

  // 简单并发实现（不引入 p-limit 等外部依赖）
  const results = new Array(targets.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= targets.length) return;
      results[idx] = await evaluatePlugin(ctx, targets[idx], opts);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 把评估结果集映射成 dream candidate 字段（REM 阶段加权用，C2 接入主路径时用）。
 *
 * 输入：evaluatePlugins() 输出数组
 * 输出：Map<targetId, {compositeScore, harmScore, status}>
 *
 * 设计：C1 先暴露 helper，不直接接 REM —— 让 C2 决定怎么加权。
 */
export function toCandidateQualityField(results) {
  const map = new Map();
  for (const r of results || []) {
    if (!r || !r.targetId) continue;
    map.set(r.targetId, {
      compositeScore: r.compositeScore,
      harmScore: r.harmScore,
      status: r.status,
    });
  }
  return map;
}

// ── helpers ─────────────────────────────────────────────────────────────

function homogeneityAlignmentReductionMutabilityAvg(harm) {
  if (!harm || typeof harm !== 'object') return null;
  const vals = [harm.homogeneity, harm.alignment, harm.reduction, harm.mutability]
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** 暴露 DEFAULTS 给 status() 用 —— 让 dream_status 能显示当前评估配置 */
export function getBridgeDefaults() {
  return DEFAULTS;
}

export const __test = {
  DREAM_BASELINE_TARGETS,
  SELF_PLUGIN_ID,
  TARGET_KINDS,
};