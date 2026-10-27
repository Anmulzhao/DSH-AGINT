/**
 * agint-evolve/lib/execution.js —— 提案「执行计划」的纯逻辑层（无 IO、无 ctx）。
 *
 * ## 它补的是哪个洞
 *
 * `approved` 这一档 2026-10-23 加进来时只解决了「点过头和已落地分开记」，
 * 没解决**谁来动手**：`agint-evolution-driver.runOnce()` 只挑 `status:'proposed'`
 * 的候选，`approved` 的行它一眼都不看。于是批准完的提案在家族面板里挂成一张
 * 「已批准待执行（工作单）」，催人去改代码 —— 而「自动执行」这件事在系统里
 * 压根没有入口。2026-10-27 老板要求补齐：批准之后自己进执行流程，
 * 可以立即跑，也可以定到某个时刻跑，**不是**再生成一张催办单。
 *
 * ## 为什么判据要单独成文件
 *
 * 「能不能入队」「什么时候该跑」「这次算不算成功」三件事会被四个地方问：
 *   setStatus（批准入口）／家族面板（显示口径）／agint-executor（调度）／工具。
 * 判据散成四份，就会出现「面板说排队中、执行器说没这条」的自相矛盾 ——
 * 这正是 blocker 那次改动踩过的坑（`proposalBlocked()` 只能有一处）。
 *
 * ⛔ 本文件不许碰存储、不许读 env、不许拿 Date.now()：时间一律由调用方传 now。
 *    这样「定时到点该跑」「过了周上限该顺延」才测得住。
 */

/** 执行方式三档。`manual` = 只批准、不自动执行（老行的隐含默认值）。 */
export const EXEC_MODES = ['manual', 'immediate', 'scheduled'];

/** 提案上的执行态（展示口径；与 execution 表的 job 状态不是同一个东西）。 */
export const EXEC_STATES = ['idle', 'queued', 'running', 'succeeded', 'failed', 'deferred', 'cancelled'];

/** 一次执行（execution 表一行）的状态机。 */
export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'deferred', 'cancelled'];

/** 到期仍可被 claim 的状态：queued 是正常待跑，deferred 是被周上限/前置顺延过的。 */
const CLAIMABLE = new Set(['queued', 'deferred']);

/** 定时的上限/下限：太远的将来（>365 天）几乎一定是填错了。 */
const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
/** 允许的过去容差：面板填 09:00、提交时已经 09:00:03 属于正常，不该拒。 */
const PAST_TOLERANCE_MS = 5 * 60 * 1000;

/** 历史行（加字段前写入）没有这些键 ⇒ 一律归一成契约里的默认值。 */
export function normalizeExec(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const mode = EXEC_MODES.includes(rec.execMode) ? rec.execMode : 'manual';
  const state = EXEC_STATES.includes(rec.execState) ? rec.execState : 'idle';
  return {
    ...rec,
    execMode: mode,
    execAt: typeof rec.execAt === 'string' ? rec.execAt : '',
    execState: state,
    // ⛔ Number(undefined) === NaN：不挡一下，NaN 会让「重试次数 < 上限」恒 false，
    //    表现是失败后永不重试，而且日志里只印 NaN。
    execAttempts: Number.isFinite(Number(rec.execAttempts)) ? Math.max(0, Math.trunc(Number(rec.execAttempts))) : 0,
    execError: typeof rec.execError === 'string' ? rec.execError : '',
    execStartedAt: typeof rec.execStartedAt === 'string' ? rec.execStartedAt : '',
    execFinishedAt: typeof rec.execFinishedAt === 'string' ? rec.execFinishedAt : '',
  };
}

/**
 * 校验一份执行计划。返回 `{ ok: true, mode, at }` 或 `{ ok: false, reason }`。
 *
 * ⛔ 这里是**唯一**的入参校验点：面板 route、evolve_set_status 工具、setStatus
 *    服务都调它。三处各写一份的结果必然是「工具能手填过去时间、面板不行」。
 */
export function validateExecPlan(input = {}, now = Date.now()) {
  const rawMode = input.execMode;
  if (rawMode !== undefined && rawMode !== null && rawMode !== '') {
    if (!EXEC_MODES.includes(rawMode)) {
      return { ok: false, reason: `execMode 不在白名单：${String(rawMode)}（可选 ${EXEC_MODES.join(' / ')}）` };
    }
  }
  const mode = EXEC_MODES.includes(rawMode) ? rawMode : 'manual';
  const rawAt = typeof input.execAt === 'string' ? input.execAt.trim() : '';
  if (mode !== 'scheduled') {
    // immediate / manual 带 at 属于自相矛盾（面板切换选择时会残留旧值）：
    // 不报错，但**丢弃** —— 留着它，日后读的人会以为这条真有定时。
    return { ok: true, mode, at: '' };
  }
  if (rawAt === '') return { ok: false, reason: 'execMode=scheduled 必须给 execAt（ISO 时间）' };
  const ts = Date.parse(rawAt);
  if (!Number.isFinite(ts)) return { ok: false, reason: `execAt 不是合法时间：${rawAt}` };
  if (ts < now - PAST_TOLERANCE_MS) return { ok: false, reason: `execAt 在过去（${rawAt}）—— 要立刻跑请选 immediate` };
  if (ts > now + MAX_AHEAD_MS) return { ok: false, reason: `execAt 超过一年（${rawAt}）—— 大概率填错` };
  return { ok: true, mode, at: new Date(ts).toISOString() };
}

/**
 * 一条提案此刻该不该自动进执行队列。返回 `null` = 该入队；
 * 否则返回**不能入队的原因码**（面板与执行器都按这个码分区显示，不各自造词）。
 *
 * 原因码：
 *   not-approved        —— 没批准（含 applied/rejected/wontfix）
 *   blocked             —— 批准了但前置没到位（`proposalBlocked()` 判过的那种）
 *   manual              —— 明确选择「只批准，不自动执行」
 *   scheduled-at-missing/invalid —— 定时计划不完整
 *   already-queued      —— 已经有排队中/执行中的一次执行，别叠
 */
export function autoEnqueueBlocker(rec, activeJobs = []) {
  if (!rec || rec.status !== 'approved') return 'not-approved';
  const n = normalizeExec(rec);
  const blocker = typeof n.blocker === 'string' ? n.blocker.trim() : '';
  if (blocker !== '') return 'blocked';
  if (n.execMode === 'manual') return 'manual';
  if (n.execMode === 'scheduled') {
    if (n.execAt === '') return 'scheduled-at-missing';
    if (!Number.isFinite(Date.parse(n.execAt))) return 'scheduled-at-invalid';
  }
  const hasActive = (Array.isArray(activeJobs) ? activeJobs : []).some(
    (j) => j && j.proposalId === rec.id && (j.state === 'queued' || j.state === 'running' || j.state === 'deferred'),
  );
  if (hasActive) return 'already-queued';
  return null;
}

/** 到期时间：immediate=立刻；scheduled=execAt；解析不出来就当作立刻。 */
export function computeDueAt(mode, at, now = Date.now()) {
  if (mode === 'scheduled') {
    const ts = Date.parse(String(at ?? ''));
    if (Number.isFinite(ts)) return new Date(ts).toISOString();
  }
  return new Date(now).toISOString();
}

/** 这条 job 到点了吗（claim 的判据；deferred 也走这里，顺延期一过自动恢复）。 */
export function isJobDue(job, now = Date.now()) {
  if (!job || !CLAIMABLE.has(job.state)) return false;
  const ts = Date.parse(String(job.dueAt ?? ''));
  if (!Number.isFinite(ts)) return true; // 时间坏了不能卡死队列，当作立刻到期
  return ts <= now;
}

/**
 * 周自动执行上限。
 *
 * ⛔ 这不是新发明的护栏，是 AGENTS.md 既有红线「不要跨周累计自动部署超过 3 次」
 *    的可执行化。之前它是纸面约定，因为「自动部署」这件事根本没发生过；
 *    现在批准即自动执行，它必须变成代码，否则第一条越线的改动就没人拦。
 *
 * @param {Array} jobs 最近窗口内的执行行
 * @param {number} cap 上限（0 = 不限，给测试/临时放开用）
 */
export function weeklyUsage(jobs, now = Date.now(), windowMs = 7 * 24 * 60 * 60 * 1000) {
  const since = now - windowMs;
  const hits = (Array.isArray(jobs) ? jobs : []).filter((j) => {
    if (!j || j.ok !== true || j.state !== 'succeeded') return false;
    const ts = Date.parse(String(j.finishedAt ?? j.updatedAt ?? ''));
    return Number.isFinite(ts) && ts >= since;
  });
  return { count: hits.length, since: new Date(since).toISOString(), jobs: hits };
}

/**
 * 本周起点（周一 00:00 本地时间）。
 *
 * ⛔ 用**自然周**而不是滚动 7 天：AGENTS.md 的红线原文是「不要**跨周**累计自动
 *    部署超过 3 次」。滚动窗口下，周一发生的第 3 次会一直压到下周一才释放，
 *    等于实际限流成了 3 次/14 天；自然周才是那句话的意思。
 */
export function startOfWeek(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun
  const back = (dow + 6) % 7; // 周一=0 … 周日=6
  d.setDate(d.getDate() - back);
  return d.getTime();
}

/** 顺延到下一个自然周起点，用于周上限触发后的自动恢复。 */
export function nextWeekStart(now = Date.now()) {
  const d = new Date(startOfWeek(now));
  d.setDate(d.getDate() + 7);
  return d.toISOString();
}

/** 执行结果 → 是否算「真的落地」。只有 commit 成功才算，提案被构造出来不算。 */
export function interpretRunResult(out) {
  if (!out || typeof out !== 'object') return { ok: false, reason: 'driver-returned-nothing' };
  if (out.skipped === true) {
    const first = Array.isArray(out.failures) && out.failures.length ? out.failures[0] : null;
    return { ok: false, reason: first ?? out.reason ?? out.lastError ?? 'driver-skipped' };
  }
  const commit = out.commit ?? null;
  if (commit && commit.ok === true) {
    return {
      ok: true,
      mutationId: out.proposalId ?? '',
      commitPath: commit.path ?? '',
      policyDecision: commit.policyDecision ?? '',
      reason: '',
    };
  }
  if (commit) {
    return {
      ok: false,
      mutationId: out.proposalId ?? '',
      commitPath: commit.path ?? '',
      policyDecision: commit.policyDecision ?? '',
      reason: commit.reason ?? 'commit-not-ok',
    };
  }
  return { ok: false, mutationId: out.proposalId ?? '', reason: 'no-commit-attempted（变异已构造但没写盘：commit 关闭或缺 repoRoot）' };
}

/** 一行执行的人读摘要（面板、工具、日志共用一句话，避免各印各的）。 */
export function describeExecution(job) {
  if (!job) return '—';
  const pct = {
    queued: `排队中（${job.dueAt ? `到期 ${String(job.dueAt).slice(0, 16).replace('T', ' ')}` : '即时'}）`,
    running: '执行中',
    succeeded: `已落地${job.commitPath ? ` → ${job.commitPath}` : ''}`,
    failed: `失败：${job.error || job.reason || '未知原因'}`,
    deferred: `已顺延：${job.reason || job.error || '等条件成熟'}`,
    cancelled: `已撤销${job.reason ? `（${job.reason}）` : ''}`,
  };
  return pct[job.state] ?? job.state;
}
