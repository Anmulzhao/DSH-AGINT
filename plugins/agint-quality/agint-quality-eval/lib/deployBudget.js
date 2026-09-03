/**
 * agint-quality-eval/lib/deployBudget.js — Sprint 13 §3.3 weekly hook 部署护栏
 *
 * P7 遗留项「每周 ≤3 次自动部署」接入 weeklyTask 末尾：
 *   - 统计滚动 7 天窗口内 policy 决策为 AUTO_DEPLOY 的次数；
 *   - 超过预算（默认 3）→ 后续 proposal 强制 PENDING_REVIEW（写 audit + 周复盘告警一行）。
 *
 * 数据源（D6 简洁 > 冗余）：**不自建存储**，直接读 agint-quality-policy 落在
 * `agint.evolution` evolution_log 里的既有 audit 行。policy.decide() 每次都会
 * `evo.logPhase4({ targetId: 'policy-batch-<decidedAt>', decision, tags: ['policy-decision', 'decision:<KIND>'] })`
 * （见 agint-quality-policy/lib/index.js），因此 AUTO_DEPLOY 计数可从 audit 日志反推。
 *
 * 统计口径（遗留 TODO T2）：默认**滚动 7 天**（老板过审时确认）；
 * `windowDays` 可按调用方覆盖（自然周语义由上层传 windowDays=7 + 对齐周一实现）。
 *
 * 幂等（R1 / T2-b 硬前置）：本模块是**纯读 + 单次 audit 写**，重复调用只做重复计数读取，
 * 不产生额外决策、不累加计数器 —— 事件重复投递不会污染预算。
 */

/** 默认每周自动部署预算（健康度护栏） */
export const DEFAULT_DEPLOY_BUDGET = 3;
/** 默认统计窗口（滚动天数） */
export const DEFAULT_WINDOW_DAYS = 7;
/** 超预算后强制的决策类型 */
export const FORCED_DECISION = 'PENDING_REVIEW';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 判断一条 evolution_log 记录是否记了一次自动部署。
 *
 * 命中规则（policy 写日志的两种形态都认，向后兼容）：
 *   1) tags 含 `decision:AUTO_DEPLOY`
 *   2) entry.decision === 'AUTO_DEPLOY'
 *   3) scores.policyKind === 'AUTO_DEPLOY'（policy-batch 行把 kind 也塞进 scores）
 */
export function isAutoDeployEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.decision === 'AUTO_DEPLOY') return true;
  if (entry.scores && entry.scores.policyKind === 'AUTO_DEPLOY') return true;
  if (Array.isArray(entry.tags) && entry.tags.includes('decision:AUTO_DEPLOY')) return true;
  return false;
}

/** 取记录时间戳（ms）；无法解析返回 null（不静默计入窗口）。 */
function entryTimeMs(entry) {
  const raw = entry?.ts ?? entry?.createdAt ?? entry?.decidedAt;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 从 evolution audit 日志统计窗口内的 AUTO_DEPLOY 次数。
 *
 * 软降级（不抛）：evolution 不可用 / getLogRange 抛错 → 返回 0 并附 degraded 原因。
 * 理由：护栏读不到数据时不该阻断 weeklyTask 的其余产出；但要把 degraded 暴露在返回值里，
 * 让周复盘能看见「这一周的预算是盲算的」（真实 > 讨好）。
 *
 * @param {object} args
 * @param {object} [args.evolution]  agint.evolution service
 * @param {number} [args.windowDays] 滚动窗口天数（默认 7）
 * @param {number} [args.nowMs]      注入时钟（测试用）
 * @returns {Promise<{count: number, windowDays: number, from: string, to: string, degraded: string|null}>}
 */
export async function countAutoDeploys({ evolution, windowDays = DEFAULT_WINDOW_DAYS, nowMs = Date.now() } = {}) {
  const to = nowMs;
  const from = nowMs - windowDays * DAY_MS;
  const out = {
    count: 0,
    windowDays,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    degraded: null,
  };

  if (!evolution || typeof evolution.getLogRange !== 'function') {
    out.degraded = 'agint.evolution.getLogRange unavailable';
    return out;
  }

  let entries = [];
  try {
    entries = await evolution.getLogRange({
      fromDate: out.from,
      toDate: out.to,
      limit: 1000,
    });
  } catch (err) {
    out.degraded = `getLogRange failed: ${err?.message ?? String(err)}`;
    return out;
  }
  if (!Array.isArray(entries)) {
    out.degraded = 'getLogRange returned non-array';
    return out;
  }

  for (const e of entries) {
    if (!isAutoDeployEntry(e)) continue;
    const ms = entryTimeMs(e);
    // 时间不可解析 → 计为「未知」并降级提示，不静默丢弃
    if (ms === null) {
      out.degraded = out.degraded ?? 'some AUTO_DEPLOY entries lack a parseable timestamp (counted conservatively)';
      out.count += 1;
      continue;
    }
    if (ms >= from && ms <= to) out.count += 1;
  }
  return out;
}

/**
 * 部署预算护栏主入口（weeklyTask 末尾调用）。
 *
 * 返回值语义：
 *   - used / remaining / exceeded：窗口内用量与是否超预算
 *   - forcedDecision：超预算时 = 'PENDING_REVIEW'（供 proposal 路径强制降级）；否则 null
 *   - auditWritten：audit 行是否成功写入 memory（写失败不阻断，返回 false）
 *   - reviewLine：直接给周复盘用的一行文本（超预算时是告警行，否则是状态行）
 *
 * 副作用（仅在超预算时发生，且全部容错）：
 *   1) console.warn（周复盘采集侧可见）
 *   2) memory.write({ type: 'decision' }) 审计行
 *   3) evo.addFailure 一条 failure_pattern（tag 前缀 deploy-budget-exceeded）
 *
 * @param {object} args
 * @param {object} args.ctx        cordis ctx（读 agint.evolution / agint.memory）
 * @param {number} [args.budget]   每周自动部署预算（默认 3）
 * @param {number} [args.windowDays]
 * @param {number} [args.nowMs]
 * @param {boolean} [args.writeAudit=true] 关掉后可做纯计算调用（测试 / 只读巡检）
 */
export async function checkDeployBudget(args = {}) {
  const {
    ctx,
    budget = DEFAULT_DEPLOY_BUDGET,
    windowDays = DEFAULT_WINDOW_DAYS,
    nowMs = Date.now(),
    writeAudit = true,
  } = args;

  const evolution = ctx && typeof ctx.get === 'function' ? ctx.get('agint.evolution') : null;
  const memory = ctx && typeof ctx.get === 'function' ? ctx.get('agint.memory') : null;

  const usage = await countAutoDeploys({ evolution, windowDays, nowMs });
  const exceeded = usage.count > budget;
  const result = {
    windowDays,
    budget,
    used: usage.count,
    remaining: Math.max(0, budget - usage.count),
    exceeded,
    forcedDecision: exceeded ? FORCED_DECISION : null,
    from: usage.from,
    to: usage.to,
    degraded: usage.degraded,
    auditWritten: false,
    failureLogged: false,
    reviewLine: exceeded
      ? `- ⚠️ 部署预算超支：滚动 ${windowDays} 天内 AUTO_DEPLOY ${usage.count} 次 > 预算 ${budget} 次 → 后续 proposal 强制 PENDING_REVIEW`
      : `- 部署预算：滚动 ${windowDays} 天内 AUTO_DEPLOY ${usage.count}/${budget} 次`,
  };
  if (usage.degraded) result.reviewLine += `（数据降级：${usage.degraded}）`;
  if (!exceeded) return result;

  // ── 超预算副作用（全部容错；不阻断 weeklyTask）──
  console.warn(
    `[agint-quality-eval] deploy budget exceeded: ${usage.count} AUTO_DEPLOY in ${windowDays}d > ${budget}; forcing ${FORCED_DECISION}`,
  );

  if (writeAudit && memory && typeof memory.write === 'function') {
    try {
      await memory.write({
        type: 'decision',
        content: `[deploy-budget] exceeded ${usage.count}/${budget} in ${windowDays}d → force ${FORCED_DECISION}`,
        evidence: `agint-quality-eval:checkDeployBudget:${new Date(nowMs).toISOString()}`,
      });
      result.auditWritten = true;
    } catch (err) {
      console.error(`[agint-quality-eval] deploy budget audit memory.write failed: ${err?.message ?? err}`);
    }
  }

  if (writeAudit && evolution && typeof evolution.addFailure === 'function') {
    try {
      await evolution.addFailure({
        pattern: `deploy-budget-exceeded:${usage.count}/${budget}`,
        category: 'governance',
        severity: 'high',
        evidence: `window=${windowDays}d from=${usage.from} to=${usage.to}${usage.degraded ? ` degraded=${usage.degraded}` : ''}`,
      });
      result.failureLogged = true;
    } catch (err) {
      console.error(`[agint-quality-eval] deploy budget addFailure failed: ${err?.message ?? err}`);
    }
  }

  return result;
}

export { DAY_MS };
