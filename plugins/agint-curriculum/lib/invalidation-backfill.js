/**
 * agint-curriculum: 历史 fail 的一次性失效回填（提案 409d571f 第 3 点）。
 *
 * 背景：2026-11-17 的 evidence.steps 被参数层压成 { item: [...] }，
 * 判定器静默判成 `steps 数量 0 < minLength N`，10 条假 fail 被 self-model
 * 当成能力不足（integration 假 CANNOT）。传输缺陷已在 0.2.2 修复，
 * 新判定路径会给基础设施故障打 invalidated；但存量 10 条没有这个字段，
 * 需要一个显式、可审计、留痕的回填动作，避免等 7 天窗口自然滑出。
 *
 * ⛔ 逃逸口防线（提案红线）：
 *   1. 只认「已知故障签名」——reason 形如 `steps 数量 N < minLength M` 且
 *      evidence.steps 是被包装的对象（非字符串数组）。这是那批事故的确定指纹，
 *      不是模糊文本匹配。签名不匹配的一律不动。
 *   2. 显式 attempt id 白名单（dry-run 先列出候选，人工确认后再传 ids 执行），
 *      不做「全表扫描即改」。
 *   3. 每个变更必须带 actor（human:<name>）与 reason，写 audit_log 留痕。
 *   4. 只加失效标记，不改 result 事实（宁 fail 不 pass）、不改 difficulty、
 *      不触发 self-model 回写。self-model 是 pull 侧排除，天然闭环。
 *
 * 纯函数：不碰 storage、不碰 dsh，便于单测；离线脚本调它后走 storage 域 put。
 */

/** 历史事故签名：判定器把被压坏的 steps 判成「数量 0 < minLength」。 */
const STEP_COUNT_SIGNATURE = /steps\s+数量\s+0\s*<\s*minLength\s+\d+/;

/**
 * 判断一条 attempt 是否命中已知的「判定基础设施故障」签名。
 *
 * 只有两个条件同时成立才认：
 *   - result === 'fail' 且 reason 命中 `steps 数量 0 < minLength N`；
 *   - evidence.steps 已提交、但不是字符串数组（被参数层包装成对象）。
 *
 * 字段缺失的 fail（真没做）与可还原后仍不足的 fail（能力问题）都不认 ——
 * 与 verdict.js 的逃逸口防线同口径。
 *
 * @param {object} attempt
 * @returns {{ matched: boolean, why: string, signature: string|null }}
 */
export function matchInvalidationSignature(attempt) {
  if (!attempt || typeof attempt !== 'object') {
    return { matched: false, why: 'attempt 不是对象', signature: null };
  }
  if (attempt.result !== 'fail') {
    return { matched: false, why: 'result 不是 fail', signature: null };
  }
  if (attempt.invalidated === true) {
    return { matched: false, why: '已标记失效（幂等跳过）', signature: null };
  }
  const reason = typeof attempt.reason === 'string' ? attempt.reason : '';
  if (!STEP_COUNT_SIGNATURE.test(reason)) {
    return { matched: false, why: 'reason 未命中已知故障签名', signature: null };
  }
  const steps = attempt.evidence?.steps;
  if (steps === undefined || steps === null) {
    return { matched: false, why: 'steps 字段缺失（真实失败，不标失效）', signature: null };
  }
  if (Array.isArray(steps)) {
    // 真数组还被判 fail 说明是内容问题（步数不足/缺关键词），不是尺子坏了
    return { matched: false, why: 'steps 是字符串数组（内容失败，非签名）', signature: null };
  }
  if (typeof steps !== 'object') {
    return { matched: false, why: 'steps 类型异常但非已知包装形态', signature: null };
  }
  const keys = Object.keys(steps);
  const restorable = keys.length === 1 && Array.isArray(steps[keys[0]])
    || keys.length > 0 && keys.every((k) => /^\d+$/.test(k));
  if (!restorable) {
    return { matched: false, why: 'steps 对象形态非已知参数层包装', signature: null };
  }
  return {
    matched: true,
    why: '命中 2026-11-17 evidence.steps 参数层包装故障签名',
    signature: 'step-list:steps-wrapped-object',
  };
}

/**
 * 从 attempts 表里筛出可回填的候选（只筛不改）。
 * @param {Array<{id:string, [k:string]:any}>} attempts
 * @returns {{ candidates: Array<object>, rejected: Array<{id:string, why:string}> }}
 */
export function selectBackfillCandidates(attempts) {
  const candidates = [];
  const rejected = [];
  for (const a of Array.isArray(attempts) ? attempts : []) {
    const r = matchInvalidationSignature(a);
    if (r.matched) candidates.push(a);
    else rejected.push({ id: a?.id ?? '?', why: r.why });
  }
  return { candidates, rejected };
}

/**
 * 生成回填后的 attempt 记录：保留全部原字段，只覆盖失效标记三处。
 * result 事实不变（仍是 fail）——失效只影响下游能力判定，不改判定结论。
 *
 * @param {object} attempt 原 attempt（含 id/kind 等 storage metadata）
 * @param {{ actor: string, reason: string }} meta 人工确认信息
 * @returns {object} 新记录（不修改入参）
 */
export function buildInvalidatedAttempt(attempt, { actor, reason }) {
  if (!attempt || typeof attempt !== 'object') throw new Error('buildInvalidatedAttempt: attempt is required');
  if (typeof actor !== 'string' || !actor.trim()) throw new Error('buildInvalidatedAttempt: actor is required（human:<name>）');
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('buildInvalidatedAttempt: reason is required（留痕）');
  const stamp = new Date().toISOString();
  return {
    ...attempt,
    invalidated: true,
    invalidationReason: `${reason.trim()}（回填人：${actor.trim()}，时间：${stamp}）`,
  };
}

/**
 * 生成一条 audit_log 业务载荷（供 packAudit 使用；不在此处 parse）。
 * @param {{ ids: string[], actor: string, reason: string, dryRun: boolean }} p
 */
export function buildBackfillAudit({ ids, actor, reason, dryRun }) {
  return {
    actor: actor.trim(),
    action: dryRun ? 'attempt_invalidation_backfill_preview' : 'attempt_invalidation_backfill',
    targetType: 'attempt',
    targetId: ids.join(','),
    details: {
      count: ids.length,
      ids,
      dryRun,
      signature: 'step-list:steps-wrapped-object',
      source: 'proposal-409d571f',
    },
    reason: reason.trim(),
  };
}
