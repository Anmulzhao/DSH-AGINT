/**
 * agint-executor —— 「提案批准之后，谁来动手」的那一端（2026-10-27）。
 *
 * ## 它补的是哪个洞
 *
 * `agint-evolve` 自 2026-10-23 起有 `approved` 这一档，`agint-evolution-driver`
 * 有完整的「提案 → LLM 原子编辑 → D-QAF → commit」流水线 —— 但两者**没接上**：
 * driver 的 `runOnce()` 只挑 `status:'proposed'`，approved 的行它不看。
 * 于是批准完的提案在家族面板里挂成一张「已批准待执行（工作单）」，
 * 等老板自己想起来去改代码。老板 2026-10-27 明确要求：批准即进执行流程，
 * 可以立即跑、也可以定时跑，**不要再生成催办单**。
 *
 * ## 职责边界（三件事，别越界）
 *
 *   1. 调度：ctx.setInterval 轮询 `agint.evolve.claimDueExecutions()`，捡到期任务
 *   2. 守护：状态/blocker 复核、周自动执行上限、重试上限、kill-switch
 *   3. 记账：把执行结果（成功/失败/顺延/撤销）写回 `agint.evolve`
 *
 * ⛔ **不造变异内容、不写仓库、不做验证决策** —— 那是 driver 的事。
 *    本插件只回答「现在该不该跑这条」，以及「跑完算不算数」。
 * ⛔ **不自己存状态**：队列在 `agint_evolve.execution` 表里（单一事实源）。
 *    自己再存一份 = 重启后两份对不上，而症状是"面板说排队中、实际没人跑"。
 *
 * ## 安全开关
 *
 *   AGINT_EXECUTOR=off        —— 整体停摆（出厂即开；红线定义见 AGENTS.md）
 *   config.weeklyCommitCap    —— 本周自动落地次数上限，默认 3，对齐 AGENTS.md
 *                                「不要跨周累计自动部署超过 3 次」这条红线
 *   config.maxAttempts        —— 同一提案最多试几次（默认 2，防无限重试烧 token）
 *   config.maxPerTick         —— 每个 tick 最多跑几条（默认 1，串行，不抢 CPU）
 *
 * 关掉它不会让已批准的提案消失，只会让它们停在「排队中」—— 面板上一眼可见。
 */

import { decideRun, canRetry, oneLine } from './plan.js';

const name = 'agint-executor';
const inject = [];

const KILL_ENV = 'AGINT_EXECUTOR';

/**
 * 配置读取 —— 刻意不用 zod。
 *
 * 本插件零第三方依赖：只用 6 个标量配置，为它拉一份 zod 进 node_modules
 * 不值（install.sh 要跟着 rsync、升级要跟着冲突）。校验口径写在这里，
 * 唯一的硬要求是「坏值不能变成 0 或 NaN」—— 那会让上限静默失效。
 */
function readConfig(raw = {}) {
  const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);
  return {
    /** 轮询间隔（毫秒）。入队时会 wake() 捅一下，所以这个值决定的是"兜底延迟"。 */
    tickMs: Math.max(1000, Math.trunc(num(raw.tickMs, 15_000))),
    /** 本周自动落地次数上限。0 = 不限（只建议在临时排查时用）。 */
    weeklyCommitCap: Math.max(0, Math.trunc(num(raw.weeklyCommitCap, 3))),
    /** 同一提案最多尝试几次（含首次）。 */
    maxAttempts: Math.max(1, Math.trunc(num(raw.maxAttempts, 2))),
    /** 失败后隔多久重试（毫秒）。 */
    retryDelayMs: Math.max(0, num(raw.retryDelayMs, 5 * 60_000)),
    /** 每个 tick 最多处理几条执行（串行）。 */
    maxPerTick: Math.max(1, Math.trunc(num(raw.maxPerTick, 1))),
    /** 挂载即开始调度。false 时只能手动 tick()（测试/排障用）。 */
    enabled: raw.enabled !== false,
  };
}

function apply(ctx, config) {
  const cfg = readConfig(config ?? {});
  const state = {
    ticks: 0,
    lastTickAt: null,
    lastRunAt: null,
    lastError: null,
    claimed: 0,
    succeeded: 0,
    failed: 0,
    deferred: 0,
    cancelled: 0,
    lastResult: null,
  };

  const dep = (n) => (typeof ctx.get === 'function' ? ctx.get(n) : null);
  const isDisabled = (env = process.env) => String(env?.[KILL_ENV] ?? 'on') === 'off';
  const nowIso = () => new Date().toISOString();

  let inFlight = false;
  let wakeScheduled = false;
  let intervalHandle = null;
  let wakeHandle = null;

  const warn = (msg, data) => {
    try { ctx.logger?.warn?.(msg, data); } catch { /* noop */ }
  };

  /** 失败落到 evolution.failure_pattern（周报查得动的通道），不只是一条 stdout。 */
  const recordFailure = async (pattern, evidence) => {
    try {
      const evo = dep('agint.evolution');
      if (evo && typeof evo.addFailure === 'function') {
        await evo.addFailure({ pattern, category: 'integration', severity: 'high', evidence: oneLine(evidence, 400) });
      }
    } catch { /* 记账失败不改变执行结果 */ }
  };

  async function runJob(job, { now = Date.now() } = {}) {
    const evolve = dep('agint.evolve');
    const driver = dep('agint.evolutionDriver');
    let proposal = null;
    try {
      proposal = await evolve.getProposal(job.proposalId);
    } catch (error) {
      state.lastError = `getProposal failed: ${error?.message ?? error}`;
    }
    let weekCommits = 0;
    try {
      const stats = typeof evolve.executionStats === 'function' ? await evolve.executionStats({ now }) : null;
      weekCommits = Number(stats?.lastWeekCommits ?? 0) || 0;
    } catch { /* 数不出来按 0 算；周上限由 decideRun 的 cap>0 分支再判 */ }

    const decision = decideRun({
      job,
      proposal,
      weekCommits,
      cap: cfg.weeklyCommitCap,
      driverReady: typeof driver?.runForProposal === 'function',
      now,
    });

    if (decision.action === 'cancel') {
      await evolve.finishExecution(job.id, { state: 'cancelled', reason: decision.reason });
      state.cancelled += 1;
      return { proposalId: job.proposalId, action: 'cancel', reason: decision.reason };
    }
    if (decision.action === 'fail') {
      await evolve.finishExecution(job.id, { ok: false, error: decision.error });
      state.failed += 1;
      await recordFailure('executor-run-refused', `proposalId=${job.proposalId} ${decision.error}`);
      return { proposalId: job.proposalId, action: 'fail', error: decision.error };
    }
    if (decision.action === 'defer') {
      await evolve.requeueExecution(job.id, { dueAt: decision.dueAt, reason: decision.reason, deferred: true });
      state.deferred += 1;
      return { proposalId: job.proposalId, action: 'defer', reason: decision.reason, dueAt: decision.dueAt };
    }

    // ── 真的跑 ──────────────────────────────────────────────────────
    state.lastRunAt = nowIso();
    let out = null;
    let thrown = null;
    try {
      out = await driver.runForProposal(job.proposalId);
    } catch (error) {
      thrown = error;
    }
    const verdict = thrown
      ? { ok: false, reason: `driver 抛错：${thrown?.message ?? thrown}` }
      : interpret(out);

    if (verdict.ok) {
      await evolve.finishExecution(job.id, {
        ok: true,
        mutationId: verdict.mutationId,
        commitPath: verdict.commitPath,
        policyDecision: verdict.policyDecision,
        reason: '',
      });
      state.succeeded += 1;
      return { proposalId: job.proposalId, action: 'run', ok: true, commitPath: verdict.commitPath };
    }

    const attempts = Number(job.attempts) || 1;
    if (canRetry(attempts, cfg.maxAttempts)) {
      const dueAt = new Date(now + cfg.retryDelayMs).toISOString();
      await evolve.requeueExecution(job.id, { dueAt, error: oneLine(verdict.reason, 400), reason: `第 ${attempts} 次失败，${Math.round(cfg.retryDelayMs / 1000)}s 后重试` });
      warn('executor: 执行失败，已排重试', { proposalId: job.proposalId, attempts, reason: oneLine(verdict.reason) });
      return { proposalId: job.proposalId, action: 'retry', attempts, reason: oneLine(verdict.reason) };
    }
    await evolve.finishExecution(job.id, { ok: false, error: oneLine(verdict.reason, 400) });
    state.failed += 1;
    await recordFailure('executor-run-failed', `proposalId=${job.proposalId} attempts=${attempts} ${verdict.reason}`);
    warn('executor: 执行失败且不再重试', { proposalId: job.proposalId, attempts, reason: oneLine(verdict.reason) });
    return { proposalId: job.proposalId, action: 'fail', error: oneLine(verdict.reason) };
  }

  /** driver 返回 → 是否真的落地（只有 commit ok 算）。 */
  function interpret(out) {
    if (!out || typeof out !== 'object') return { ok: false, reason: 'driver 没有返回结果' };
    if (out.skipped === true) {
      const first = Array.isArray(out.failures) && out.failures.length ? out.failures[0] : null;
      return { ok: false, reason: oneLine(first ?? out.reason ?? out.lastError ?? 'driver skipped') };
    }
    const commit = out.commit ?? null;
    if (commit && commit.ok === true) {
      return {
        ok: true,
        mutationId: out.proposalId ?? '',
        commitPath: commit.path ?? '',
        policyDecision: commit.policyDecision ?? '',
      };
    }
    if (commit) {
      return { ok: false, reason: oneLine(commit.reason ?? 'commit 未通过（policy/verify 拒绝）') };
    }
    return { ok: false, reason: '变异已构造但没有写盘（commit 关闭或缺 repoRoot）—— 不算落地' };
  }

  /**
   * 跑一轮。可重入保护：inFlight 期间直接返回，不排队 ——
   * 排队的语义会让一次慢执行之后连着放好几条，把「每 tick 一条」变成「一次爆发」。
   */
  async function tick(opts = {}) {
    if (isDisabled(opts.env ?? process.env)) {
      return { skipped: true, reason: `paused（${KILL_ENV}=off）` };
    }
    if (!cfg.enabled && opts.force !== true) {
      return { skipped: true, reason: 'executor disabled（config.enabled=false）' };
    }
    if (inFlight) return { skipped: true, reason: 'already-running' };
    inFlight = true;
    state.ticks += 1;
    state.lastTickAt = nowIso();
    try {
      const evolve = dep('agint.evolve');
      if (!evolve || typeof evolve.claimDueExecutions !== 'function') {
        state.lastError = 'agint.evolve 缺 claimDueExecutions（版本过旧或未挂载）';
        return { skipped: true, reason: state.lastError };
      }
      const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
      const jobs = await evolve.claimDueExecutions({ now, limit: cfg.maxPerTick });
      if (!Array.isArray(jobs) || jobs.length === 0) {
        return { ran: 0, cleared: true };
      }
      state.claimed += jobs.length;
      const results = [];
      for (const job of jobs) {
        try {
          results.push(await runJob(job, { now }));
        } catch (error) {
          // 单条炸掉不能让整个 tick 崩 —— 其余执行还要跑，队列还要继续转。
          state.lastError = `runJob threw: ${error?.message ?? error}`;
          warn('executor: runJob threw', { proposalId: job.proposalId, error: state.lastError });
          try {
            await evolve.finishExecution(job.id, { ok: false, error: oneLine(state.lastError, 400) });
          } catch { /* noop */ }
          results.push({ proposalId: job.proposalId, action: 'fail', error: oneLine(state.lastError) });
        }
      }
      state.lastResult = results;
      return { ran: results.length, results };
    } catch (error) {
      state.lastError = `tick failed: ${error?.message ?? error}`;
      warn('executor: tick failed', { error: state.lastError });
      return { error: state.lastError };
    } finally {
      inFlight = false;
    }
  }

  /** 入队后立刻捅一下（「立即执行」不该等一个完整 tick）。同一轮内去重。 */
  function wake() {
    if (isDisabled() || !cfg.enabled) return;
    if (wakeScheduled) return;
    wakeScheduled = true;
    const fire = () => {
      wakeScheduled = false;
      void tick();
    };
    try {
      if (typeof ctx.setTimeout === 'function') {
        wakeHandle = ctx.setTimeout(fire, 0);
        return;
      }
    } catch { /* 落到下面的裸 setTimeout */ }
    wakeHandle = setTimeout(fire, 0);
  }

  ctx.effect(() => {
    if (cfg.enabled && typeof ctx.setInterval === 'function') {
      intervalHandle = ctx.setInterval(() => { void tick(); }, cfg.tickMs);
    }
    // 挂载后先跑一轮：重启可能错过一堆已到期的执行，等 15 秒才开始跑说不通。
    if (cfg.enabled) wake();
    return () => {
      try { intervalHandle?.dispose?.(); } catch { /* noop */ }
      try { wakeHandle?.dispose?.(); } catch { /* noop */ }
      if (wakeHandle && typeof wakeHandle === 'number') clearTimeout(wakeHandle);
      intervalHandle = null;
      wakeHandle = null;
      inFlight = false;
      wakeScheduled = false;
    };
  });

  ctx.provide('agint.executor', {
    tick,
    wake,
    status: () => ({
      ...state,
      config: { ...cfg },
      killSwitch: isDisabled() ? 'off' : 'on',
      inFlight,
      nextTickMs: cfg.tickMs,
    }),
    /** 手动放行一条：入队并立刻跑一轮（工具/面板「立即执行」用）。 */
    async runNow(proposalId, opts = {}) {
      const evolve = dep('agint.evolve');
      if (!evolve || typeof evolve.enqueueExecution !== 'function') {
        return { ok: false, error: 'agint.evolve 缺 enqueueExecution（版本过旧或未挂载）' };
      }
      const enq = await evolve.enqueueExecution(proposalId, {
        force: opts.force === true,
        by: opts.by ?? 'manual',
        execMode: opts.execMode,
        execAt: opts.execAt,
      });
      if (!enq?.enqueued) return { ok: false, reason: enq?.reason ?? 'not-enqueued' };
      const out = await tick({ force: true });
      const hit = (out.results ?? []).find((r) => r.proposalId === proposalId) ?? null;
      return { ok: hit?.ok === true || hit?.action === 'run', enqueued: enq.job?.id ?? null, result: hit, tick: out };
    },
    async runTick(opts = {}) { return tick(opts); },
  });
}

export { readConfig, apply, inject, name };
