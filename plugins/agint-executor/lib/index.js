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
 *   config.weeklyCommitCap    —— 本周自动落地次数上限。⛔ 代码默认 3、红线 5，
 *                                两者**不是同一个数**：红线 2026-10-29 由 3 改为 5
 *                                （commit a3b9b48），默认值故意没跟着动 ——
 *                                新部署没写 config 时不该拿着一个未经裁定的数字
 *                                开始自动改代码。改红线请改 config（本机/NAS 都写 5）。
 *   config.maxAttempts        —— 同一提案最多试几次（默认 2，防无限重试烧 token）
 *   config.maxPerTick         —— 每个 tick 最多跑几条（默认 1，串行，不抢 CPU）
 *   config.envBreakerThreshold —— 连续几次环境故障就整轮停手（默认 2）
 *   config.envBreakerCooldownMs —— 环境熔断的冷却窗口（默认 10 分钟）
 *   config.envMaxBackoffMs    —— 环境故障退避上限（默认 30 分钟）
 *
 * ## 环境故障 ≠ 提案失败（2026-11-07，提案 cdf41d63 实证）
 *
 * LLM 通道挂掉时 driver 抛错，旧逻辑把它当普通失败：排一次 5 分钟重试，第二次
 * 到点仍挂 ⇒ `finishExecution(ok:false)` ⇒ 提案 `execState=failed` ⇒ 面板
 * 「已批准·执行失败·等处理」。一天之内 5 条执行行全部这么被记成「提案失败」，
 * 而它们一行代码都没改、也一行都没错。
 *
 * 现在环境故障走另一条路：顺延（deferred）+ 指数退避 + **退还尝试额度**，
 * 连续两次就熔断一轮并冷却 10 分钟。提案保持 approved，面板显示「已顺延」。
 * 判据在 `lib/env.js`，与 driver 的 deterministic 判据互不覆盖。
 *
 * 关掉它不会让已批准的提案消失，只会让它们停在「排队中」—— 面板上一眼可见。
 */

import { decideRun, canRetry, oneLine } from './plan.js';
import { isEnvironmentFailure, envBackoffMs } from './env.js';

const name = 'agint-executor';
/**
 * `timer` 是**必填**注入，不是可选依赖。
 *
 * ⛔ 2026-10-27 实机教训（首次部署即翻车）：本插件用 `ctx.setInterval` 做 tick、
 *    `ctx.setTimeout` 做 wake 去重，但 inject 写的是 `[]`。宿主侧访问未注入的
 *    `ctx.timer` 会直接抛 `cannot get property "timer" without inject`，
 *    整个 apply 失败 ⇒ **插件根本没挂上**，而症状只是「服务 get 不到、tick 从不发生」。
 *    本地用例没抓到，是因为假 ctx 把 setTimeout 直接给了出去（替身比真宿主宽松）。
 *    判据与 agint-cron 同源：`const inject = ['timer', 'storageDomain']`。
 */
const inject = ['timer'];

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
    /**
     * 孤儿执行回收的超时兜底阈值（毫秒）。
     *
     * 2026-11-02（提案 a6e6e1d9 实证）：宿主重启前就在 running 的行，
     * 靠「startedAt < 本进程挂载时刻」这条硬证据就能抓住，不需要等超时；
     * 这条阈值只兜底「同进程内结算失败」的情形。默认 30 分钟。
     */
    orphanStaleMs: Math.max(0, num(raw.orphanStaleMs, 30 * 60_000)),
    /** 挂载即开始调度。false 时只能手动 tick()（测试/排障用）。 */
    enabled: raw.enabled !== false,
    /**
     * 环境故障熔断阈值（连续几次环境故障就整轮停手）。默认 2。
     *
     * 2026-11-07（提案 cdf41d63 实证）：LLM 通道挂掉时，每个 tick 仍会捡下一条
     * 提案、起一次注定失败的调用。当天 5 条执行行在 24 分钟内全部被烧掉，
     * 每条都记成「提案失败」。熔断的作用就是**一次故障只付一次代价**。
     */
    envBreakerThreshold: Math.max(1, Math.trunc(num(raw.envBreakerThreshold, 2))),
    /** 环境故障后的冷却窗口（毫秒）。冷却期内 tick 直接跳过，不 claim。默认 10 分钟。 */
    envBreakerCooldownMs: Math.max(0, num(raw.envBreakerCooldownMs, 10 * 60_000)),
    /** 环境故障退避上限（毫秒）。默认 30 分钟。 */
    envMaxBackoffMs: Math.max(0, num(raw.envMaxBackoffMs, 30 * 60_000)),
  };
}

function apply(ctx, config) {
  const cfg = readConfig(config ?? {});
  // 2026-11-02：本进程挂载时刻。孤儿回收的第一判据是「startedAt < mountedAt」
  // ⇒ 这一行是**上一个进程** claim 的，而那个进程已经死了（实机：提案 a6e6e1d9 的
  // exec-1793280728689-kmy9h1 停在 running 一整天，面板显示「已批准·执行中」）。
  const mountedAt = Date.now();
  const state = {
    ticks: 0,
    lastTickAt: null,
    lastRunAt: null,
    lastError: null,
    claimed: 0,
    succeeded: 0,
    // 2026-10-28：succeeded 里有多少是「只落地了提案的一部分」（提案 `846f4fbb` 实证）。
    // 不单独计数的话，「本周自动落地 3 条」会把 1 条只做完 1/3 的也数进去。
    partial: 0,
    failed: 0,
    deferred: 0,
    cancelled: 0,
    // 2026-11-02：回收掉的孤儿执行数（跨宿主重启遗留的 running 行）。
    reaped: 0,
    // 2026-11-07：环境故障（LLM 通道/宿主能力不可用）次数。与 failed 分开计数 ——
    // 混在一起看，就读不出「是提案不行」还是「机器不行」。
    envDeferred: 0,
    // 连续环境故障计数与熔断到期时刻（毫秒）。
    envStreak: 0,
    breakerUntil: 0,
    breakerTrips: 0,
    lastResult: null,
  };

  const dep = (n) => (typeof ctx.get === 'function' ? ctx.get(n) : null);
  const isDisabled = (env = process.env) => String(env?.[KILL_ENV] ?? 'on') === 'off';
  const nowIso = () => new Date().toISOString();

  let inFlight = false;
  let wakeScheduled = false;
  let intervalHandle = null;
  let wakeHandle = null;
  // 本进程正在跑的 job id —— 回收孤儿时不能把它们当成上一进程的遗留。
  const activeJobIds = new Set();

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

    // 2026-11-03（W8-3）：核审批凭据。
    // 取不到（老版 evolve / 调用抛错）⇒ null ⇒ decideRun 不拦。
    // ⛔ 这里刻意不把「取不到」当 mismatch：那会把 evolve 的临时故障
    //    变成「所有提案疑似越权」的一次性停摆。
    let mandate = null;
    try {
      if (typeof evolve.checkMandate === 'function') {
        mandate = await evolve.checkMandate(job.proposalId);
      }
    } catch (error) {
      state.lastError = `checkMandate failed: ${error?.message ?? error}`;
    }

    const decision = decideRun({
      job,
      proposal,
      weekCommits,
      cap: cfg.weeklyCommitCap,
      driverReady: typeof driver?.runForProposal === 'function',
      mandate,
      now,
    });

    if (decision.action === 'cancel') {
      // ⛔ 越权撤单要把「为什么」写进执行台账的 reason 里 —— 否则人看到的
      //    只是「已撤销」，会以为是有人主动撤的。
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
      // 2026-10-28：部分落地要连同**剩余单元**一起交回 evolve，让它把提案留在
      // `approved` + `execState=partial`，而不是悄悄标 applied（那就等于替下一部分结账了）。
      await evolve.finishExecution(job.id, {
        ok: true,
        mutationId: verdict.mutationId,
        commitPath: verdict.commitPath,
        policyDecision: verdict.policyDecision,
        partial: verdict.partial === true,
        unitsApplied: verdict.partial === true ? verdict.unitsApplied : null,
        unitsTotal: verdict.partial === true ? verdict.unitsTotal : null,
        remainingUnits: verdict.partial === true ? verdict.remainingUnits : [],
        // 2026-11-07：driver 的事务返回 commits[]（本次落地/新建了哪些文件）。
        // 透传给 evolve，由它写到提案行 —— 面板只读 proposal 表。
        commits: verdict.commits ?? [],
        reason: verdict.partial === true ? verdict.reason : '',
      });
      state.succeeded += 1;
      if (verdict.partial === true) state.partial += 1;
      // 通道恢复的硬证据：一次真的跑完了 ⇒ 连续环境故障归零。
      state.envStreak = 0;
      return { proposalId: job.proposalId, action: 'run', ok: true, partial: verdict.partial === true, commitPath: verdict.commitPath };
    }

    const attempts = Number(job.attempts) || 1;
    // 2026-10-27：确定性失败**不重试**。
    //
    // 「这条提案没有可改的目标」这类失败重试不会变（实机：两次各 1 秒失败，
    // 产出逐字相同）。重试只是再烧一遍 LLM，且让人看到「它在努力」而误以为
    // 有希望。偶发失败（LLM 挂了、网络断了）仍照常重试。
    if (verdict.deterministic) {
      const err = oneLine(verdict.reason, 400);
      await evolve.finishExecution(job.id, { ok: false, error: err });
      state.failed += 1;
      await recordFailure('executor-run-not-actionable', `proposalId=${job.proposalId} attempts=${attempts} ${verdict.reason}`);
      warn('executor: 确定性不可执行，不重试', { proposalId: job.proposalId, attempts, reason: err });
      // 2026-11-07：确定性不可执行 ⇒ 提案退出自动队列，不再沉淀成「已批准·执行失败」。
      // 之前只在 job 上记 failed，提案 execState 跟着 failed，面板挂 person/failed；
      // 而这类失败重试不会变，挂着等于把无出口的欠账摆给人。收口口径见
      // agint-evolve.markNotActionable（保留 approved、降 manual、execState 归 idle）。
      // 老版 evolve 没有这个方法 ⇒ 退回原行为（job 仍是 failed，提案仍是 failed）。
      let parked = false;
      if (typeof evolve.markNotActionable === 'function') {
        try {
          const rec = await evolve.markNotActionable(job.proposalId, err);
          parked = rec !== null && rec !== undefined;
        } catch (error) {
          warn('executor: markNotActionable failed', {
            proposalId: job.proposalId,
            error: error?.message ?? String(error),
          });
        }
      }
      return { proposalId: job.proposalId, action: 'fail', error: err, deterministic: true, parked };
    }
    // 2026-11-07：环境故障与提案失败**分开记账**。
    //
    // 判据：失败原因落在「LLM 通道 / 宿主能力不可用」这一族（见 lib/env.js）。
    // 动作：顺延（deferred）+ 指数退避 + **退还这次 claim 消耗的尝试次数**。
    //
    // 为什么必须退还：maxAttempts 的语义是「这条提案最多试几次」，指的是提案
    // 本身值不值得再试。通道挂掉与提案无关，把额度烧在这里，等于通道恢复后
    // 这条提案已经没资格再跑（实机：cdf41d63 在 08:10 批准后 9 秒烧完 2 次，
    // 之后只能人工再批一次，再烧一次）。
    //
    // 为什么用 deferred 而不是 failed：deferred 的语义就是「不是失败，是等条件」
    // （见 agint-evolve/lib/execution.js 的 requeueExecution）。面板据此显示
    // 「已顺延，到期自动恢复」，而不是「执行失败·等处理」—— 后者会把人叫来处理
    // 一件他处理不了的事（模型通道）。
    if (isEnvironmentFailure(verdict.reason)) {
      const wait = envBackoffMs(attempts, cfg.retryDelayMs, cfg.envMaxBackoffMs);
      const dueAt = new Date(now + wait).toISOString();
      const err = oneLine(verdict.reason, 400);
      const reason = `环境不可用（${oneLine(verdict.reason, 160)}）；${Math.round(wait / 1000)}s 后再试，不计入提案失败次数`;
      try {
        await evolve.requeueExecution(job.id, { dueAt, error: err, reason, deferred: true, refundAttempt: true });
      } catch (error) {
        // 顺延失败（老版 evolve / 存储故障）⇒ 退回一次普通重试，别把 job 卡在 running。
        warn('executor: 环境故障顺延失败', { proposalId: job.proposalId, error: error?.message ?? String(error) });
        if (canRetry(attempts, cfg.maxAttempts)) {
          await evolve.requeueExecution(job.id, { dueAt, error: err, reason });
          return { proposalId: job.proposalId, action: 'retry', attempts, reason };
        }
        await evolve.finishExecution(job.id, { ok: false, error: err });
        state.failed += 1;
        return { proposalId: job.proposalId, action: 'fail', error: err };
      }
      state.envDeferred += 1;
      state.envStreak += 1;
      await recordFailure('executor-env-unavailable', `proposalId=${job.proposalId} attempts=${attempts} ${verdict.reason}`);
      warn('executor: 环境不可用，顺延且不消耗提案额度', {
        proposalId: job.proposalId, attempts, nextDueAt: dueAt, reason: err,
      });
      return {
        proposalId: job.proposalId, action: 'retry', attempts, reason, deferred: true, env: true, dueAt,
      };
    }
    // 走到这里 = 非环境故障。连续环境故障计数归零（熔断只认「连续」）。
    state.envStreak = 0;
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
      // 2026-10-27：两条优先级，取决于 driver 有没有给出「确定性」判定。
      //
      //   确定性（deterministic=true）⇒ 用 reason：它带「not-actionable」这个
      //     结论（而且已经把首个失败原因嵌在里面），人才知道**不该再试**。
      //   偶发 ⇒ 用 failures[0]：它比 reason 泛（'no actionable candidate'）
      //     具体得多（'xxx: no target asset resolved (...)'），排查要靠它。
      //
      // ⚠️ 顺序反了的后果不对称：泛化文案盖住细节 ⇒ 排查线索没了；
      //    细节盖住结论 ⇒ 人以为「还在努力」，而它其实永远不会成功。
      const first = Array.isArray(out.failures) && out.failures.length ? out.failures[0] : null;
      const reason = out.deterministic === true
        ? (out.reason ?? first ?? 'driver skipped')
        : (first ?? out.reason ?? out.lastError ?? 'driver skipped');
      return {
        ok: false,
        reason: oneLine(reason),
        // deterministic ⇒ 重试也不会变，不再排重试。
        deterministic: out.deterministic === true,
        commits: Array.isArray(out.commits) ? out.commits : [],
      };
    }
    const commit = out.commit ?? null;
    if (commit && commit.ok === true) {
      // ── 「job 成功」≠「提案做完」（2026-10-28 v0.2.1，提案 `846f4fbb` 实证）──
      //
      // 一次自动执行的原子单元 = 一个文件的一次编辑；提案横跨多文件是常态。
      // driver v0.9.0 起把 `scope`（unitsApplied/unitsTotal/remainingUnits）带出来：
      // complete=false 时这次 commit 只是提案的**一个单元**，把它按「已落地」报上去，
      // agint-evolve 就会把提案标成 applied —— 剩余单元从此失去入口。
      // 实机：846f4fbb 三个单元只落地 agint-evolve 那个替身，却被结案成
      // `status=applied · execError=''`（另一处替身至今仍是 `return { ...desc }`）。
      //
      // ⛔ 旧接口消失则退回原行为（ok:true） —— 老 driver 不受影响，
      //    这是「新口径靠新字段」，不是「读懂返回里的每一句话」。
      const scope = out.scope ?? null;
      const remaining = Array.isArray(scope?.remainingUnits)
        ? scope.remainingUnits.filter((x) => typeof x === 'string' && x.length > 0)
        : [];
      const partial = scope != null && scope.complete === false && (remaining.length > 0 || scope.requiresNewAsset === true);
      const total = Number.isFinite(Number(scope?.unitsTotal)) ? Number(scope.unitsTotal) : null;
      return {
        ok: true,
        mutationId: out.proposalId ?? '',
        commitPath: commit.path ?? '',
        policyDecision: commit.policyDecision ?? '',
        // 2026-11-07 v0.11.0：一次执行可能落地 N 个文件（含新建）。
        commits: Array.isArray(out.commits) ? out.commits : [],
        partial,
        unitsApplied: partial ? Number(scope.unitsApplied) || 0 : null,
        unitsTotal: partial ? total : null,
        remainingUnits: partial ? remaining : [],
        reason: partial
          ? `部分落地（${Number(scope.unitsApplied) || 0}/${total ?? '？'} 个原子单元）：`
            + `剩余 ${remaining.length ? remaining.join('、') : '提案要求新建的资产'}`
            + ' —— 提案不按已落地结案'
          : '',
      };
    }
    if (commit) {
      return { ok: false, reason: oneLine(commit.reason ?? 'commit 未通过（policy/verify 拒绝）') };
    }
    return { ok: false, reason: '变异已构造但没有写盘（commit 关闭或缺 repoRoot）—— 不算落地' };
  }

  /**
   * 回收孤儿执行（2026-11-02）。
   *
   * 什么时候做：挂载后立刻做一次（上一进程遗留的 running 行就靠这条被抓到），
   * 之后每轮 tick 前再做一次（兜底「同进程内结算失败」的情形）。
   *
   * ⛔ 回收的是**执行行**，不是提案：被回收的提案仍是 approved、仍有入口，
   *    绝不会被标成 applied（判据与动作见 agint-evolve 的 reapOrphanExecutions）。
   */
  async function reapOrphans(evolve, now = Date.now()) {
    if (!evolve || typeof evolve.reapOrphanExecutions !== 'function') return { reaped: [], count: 0 };
    let out;
    try {
      out = await evolve.reapOrphanExecutions({
        now,
        mountedAt,
        staleMs: cfg.orphanStaleMs,
        // 本进程正在跑的 job 不能被判成孤儿。
        excludeIds: [...activeJobIds],
      });
    } catch (error) {
      // 回收失败也不许吞：吞了就是下一次又卡在 running。
      state.lastError = `reapOrphans failed: ${error?.message ?? error}`;
      warn('executor: 回收孤儿执行失败', { error: state.lastError });
      await recordFailure('executor-reap-orphans-failed', state.lastError);
      return { reaped: [], count: 0 };
    }
    const count = Number(out?.count) || 0;
    if (count > 0) {
      state.reaped += count;
      warn('executor: 回收了孤儿执行（宿主重启遗留的 running 行）', { count, jobs: out.reaped });
      await recordFailure('executor-reaped-orphan-execution', `count=${count} ${JSON.stringify(out.reaped).slice(0, 300)}`);
    }
    return out ?? { reaped: [], count: 0 };
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
    // 2026-11-07：环境熔断。冷却期内不 claim —— 通道挂着的时候，每捡一条就是
    // 一次注定失败的调用，而每条都会在面板上留一道痕迹，看上去像「提案有问题」。
    // force=true（面板手动「立即执行」）是人对单条的点名，允许穿透。
    const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
    if (opts.force !== true && nowMs < state.breakerUntil) {
      const left = Math.ceil((state.breakerUntil - nowMs) / 1000);
      return { skipped: true, reason: `环境熔断中（连续 ${state.envStreak} 次环境故障），${left}s 后恢复` };
    }
    inFlight = true;
    state.ticks += 1;
    state.lastTickAt = nowIso();
    try {
      const evolve = dep('agint.evolve');
      if (!evolve || typeof evolve.claimDueExecutions !== 'function') {
        state.lastError = 'agint-evolve 缺 claimDueExecutions（版本过旧或未挂载）';
        return { skipped: true, reason: state.lastError };
      }
      const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
      // 回收在前、claim 在后：先把上一进程遗留的 running 行结算掉，
      // 否则它们会占着「活跃 job」的名额，让真正该跑的提案排不进去。
      await reapOrphans(evolve, now);
      const jobs = await evolve.claimDueExecutions({ now, limit: cfg.maxPerTick });
      if (!Array.isArray(jobs) || jobs.length === 0) {
        return { ran: 0, cleared: true };
      }
      state.claimed += jobs.length;
      const results = [];
      for (const job of jobs) {
        activeJobIds.add(job.id);
        try {
          results.push(await runJob(job, { now }));
        } catch (error) {
          // 单条炸掉不能让整个 tick 崩 —— 其余执行还要跑，队列还要继续转。
          state.lastError = `runJob threw: ${error?.message ?? error}`;
          warn('executor: runJob threw', { proposalId: job.proposalId, error: state.lastError });
          try {
            await evolve.finishExecution(job.id, { ok: false, error: oneLine(state.lastError, 400) });
          } catch (settleError) {
            // ⛔ 2026-11-02：结算失败**不许静默吞**。
            // 吞掉的代价：这一行永远停在 running，队列不自愈，提案再也排不进去
            // （实机：提案 a6e6e1d9 的 exec-1793280728689-kmy9h1 停在 running
            //  整整一天，面板显示「已批准·执行中」，而没有任何东西在跑）。
            const msg = `结算失败（执行行 ${job.id} 仍停在 running）：${settleError?.message ?? settleError}`;
            state.lastError = msg;
            warn('executor: 结算失败，执行行会停在 running', { jobId: job.id, error: msg });
            await recordFailure('executor-settle-failed', msg);
          }
          results.push({ proposalId: job.proposalId, action: 'fail', error: oneLine(state.lastError) });
        } finally {
          activeJobIds.delete(job.id);
        }
        // 2026-11-07：连续环境故障到阈值 ⇒ 本轮立刻停手，并进入冷却。
        // 不这么做的话，maxPerTick 只限制「一轮跑几条」，挡不住「每 15 秒一轮」：
        // 故障期里整条队列会被依次捡起来各撞一次墙（实机 11-07 一天 5 条）。
        const last = results[results.length - 1];
        if (last?.env === true && state.envStreak >= cfg.envBreakerThreshold) {
          state.breakerUntil = now + cfg.envBreakerCooldownMs;
          state.breakerTrips += 1;
          state.lastError = `环境熔断：连续 ${state.envStreak} 次环境故障，${Math.round(cfg.envBreakerCooldownMs / 1000)}s 内不再 claim`;
          warn('executor: 环境熔断', {
            streak: state.envStreak,
            cooldownMs: cfg.envBreakerCooldownMs,
            remaining: jobs.length - results.length,
            reason: last.reason,
          });
          await recordFailure('executor-env-breaker', `streak=${state.envStreak} ${last.reason}`);
          break;
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
    // 2026-11-02：挂载即回收孤儿执行。
    // 上一进程遗留的 running 行（宿主重启打断的）此刻就是孤儿 ——
    // 它们会占着「活跃 job」的名额，让真正该跑的提案永远排不进去。
    // ⛔ 不等第一次 tick：tick 前有 15 秒窗口，而孤儿行的危害是**挡路**。
    if (cfg.enabled) {
      void reapOrphans(dep('agint.evolve')).catch((error) => {
        warn('executor: 挂载后回收孤儿执行失败', { error: error?.message ?? error });
      });
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
