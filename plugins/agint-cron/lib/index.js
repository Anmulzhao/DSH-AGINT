/**
 * agint-cron: host service (provides agint.cron) — a tiny cron scheduler
 * built on cordis-plugin-timer. Maintains a 60-second tick, checks each
 * compiled job's schedule, fires when the next-fire minute passes since
 * the last run. Jobs due in the same tick run serially in declaration order
 * (see tick()); a per-job mutex plus a tick re-entrancy guard prevent
 * overlapping runs.
 *
 * Default jobs (memory-decay, wiki-lint, metrics-collect, evolve-review) are
 * registered at boot. The service exposes list / runNow / health for the
 * preset tools.
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-cron
 *         name: ./plugins/agint-cron/lib/index.js
 */

import { z } from 'zod';
import { nextFire, isDue } from './cron.js';
import { compileJobs } from './jobs.js';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { createHostBridge } from './host-schedule.js';

const name = 'agint-cron';
const inject = ['timer', 'storageDomain'];

const Config = z.object({}).optional();

// Persisted per-job run state. The scheduler keeps lastRunAt/lastResult/
// lastError in memory only, so a dsh process restart makes cron_list report
// `last=never` even for jobs that have run many times — the same class of bug
// agint-dream fixed by recovering lastSweep from diary mtime. We persist job
// state to an exclusive `agint_cron` storage domain so a rebooted host restores
// real last-run timestamps instead of looking never-run.
// Exported for the regression test that pins the `.nullish()` contract below.
// Not part of the plugin's runtime surface.
export const cronStateSchema = z.object({
  lastRunAt: z.string().nullable(),
  lastResult: z.string().nullable(),
  lastError: z.string().nullable(),
  // Job outcome summary (JSON string). MUST stay `.nullish()`, never `.nullable()`:
  // zod's `.nullable()` allows a null VALUE but still requires the KEY to be
  // present, so every record stored before this field existed would fail
  // `valueSchema.parse` at open (dsh-storage-domain README:94 / lib/index.js:371,
  // code `invalid-record`). That rejects the whole domain open, which silently
  // downgrades cron state to in-memory — the exact bug the persistence block
  // above was written to fix. Adding an optional key needs no version bump for
  // the same reason: README:153 rejects a spec whose version differs from the
  // stored one, so `version: 1` below must stay 1.
  lastResultSummary: z.string().nullish(),
  updatedAt: z.string(),
});

const spec = defineDomain({
  name: 'agint_cron',
  version: 1,
  tables: { cron_state: { valueSchema: cronStateSchema } },
});

function apply(ctx) {
  // Persisted state domain. Opened lazily; if it fails to open (or is empty on
  // first boot) we degrade to in-memory-only (the previous behaviour) rather
  // than blocking the scheduler.
  let domain = null;
  let domainError = null;
  let disposed = false;
  ctx.effect(() => {
    return () => {
      disposed = true;
      if (domain) return domain.close();
    };
  });
  const ready = ctx.storageDomain.open(spec).then(
    (d) => {
      if (disposed) {
        void d.close().catch(() => {});
        return null;
      }
      domain = d;
      return d;
    },
    (error) => {
      domainError = error;
      return null;
    },
  );
  const stateTable = async () => {
    if (disposed) throw new Error('agint-cron: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-cron: domain unavailable');
    return d.table('cron_state');
  };
  const jobs = compileJobs().map((j) => ({
    ...j,
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    lastResultSummary: null,
    running: false,
  }));
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const bootTime = Date.now();

  // 行动 #2a（2026-09-28）：宿主原生调度桥。job 表静态快照；宿主 dsh-schedule
  // 在首次 validateSchedules / mirrorCatalog 时懒加载（失败降级 hostAvailable:false，
  // 不影响 tick 执行）。cron 语义与宿主 canonicalizeCronExpression 对齐。
  const hostSchedule = createHostBridge({
    getService: (n) => (typeof ctx.get === 'function' ? ctx.get(n) : null),
    jobs: jobs.map((j) => ({ id: j.id, schedule: j.schedule })),
  });
  console.info(
    '[agint-cron] host-schedule bridge ' + JSON.stringify(hostSchedule.status()) +
    '（宿主 dsh-schedule 懒加载；cron_list 可查 hostSchedule 面）',
  );

  // Hydrate persisted lastRunAt/lastResult/lastError per job so a rebooted
  // host does not report every job as never-run. The domain opens async, so we
  // update the job objects in place once ready; jobs start null (previous
  // behaviour) and are patched when the domain settles.
  ready.then((d) => {
    if (!d) return;
    const table = d.table('cron_state');
    for (const [jobId, rec] of table.entries()) {
      const job = jobById.get(jobId);
      if (!job) continue;
      if (rec.lastRunAt) job.lastRunAt = new Date(rec.lastRunAt).getTime();
      if (rec.lastResult === 'ok') job.lastResult = { ok: true, restored: true };
      if (rec.lastError) job.lastError = { message: rec.lastError };
      // `.nullish()` in cronStateSchema means a record written before this field
      // existed parses to `undefined` here — normalise to null for the tool face.
      if (rec.lastResultSummary !== undefined) job.lastResultSummary = rec.lastResultSummary;
    }
  }).catch(() => { /* domain unavailable or empty — jobs stay in-memory-only */ });

  // 60-second tick. Disposer registered so the interval is cleaned up on
  // fiber disposal (graceful shutdown or reload).
  const tickHandle = ctx.setInterval(() => void tick(), 60_000);
  ctx.effect(() => tickHandle.dispose);

  // Service resolution map: jobs receive a snapshot of common host services
  // they need. Resolved lazily at tick time so services are available by then.
  const services = () => ({
    'agint.memory': ctx.get('agint.memory'),
    'agint.wiki': ctx.get('agint.wiki'),
    'agint.metrics': ctx.get('agint.metrics'),
    'agint.evolve': ctx.get('agint.evolve'),
    'agint.toolStats': ctx.get('agint.toolStats'),
    'agint.dream': ctx.get('agint.dream'),
    'agint.promptSDK': ctx.get('agint.promptSDK'),
    'agint.skillAutocreate': ctx.get('agint.skillAutocreate'),
    'agint.curator': ctx.get('agint.curator'),
    'agint.curriculum': ctx.get('agint.curriculum'),
    // P2-2 技能图谱（mountOrder 28）。ctx.get 在 tick 时懒解析，晚挂载也能取到；
    // 未挂载时为 undefined → skill-graph-weekly job 走 soft-skip 不报错。
    'agint.skillGraph': ctx.get('agint.skillGraph'),
    // 诊断域看门狗（2026-09-26 事故后新增）：job 用它读各表占用率与 report()
    // 频率熔断状态（trips/recent）。同样懒解析；agint-diagnosis 未挂载时为
    // undefined → job 返回 {skipped:true} 而非报错。
    'agint.diagnosis.stats': ctx.get('agint.diagnosis.stats'),
    // 闭环引擎驱动（2026-09-27 新增 job evolution-cycle）。懒解析；
    // agint-evolution-driver 未挂载时为 undefined → job soft-skip 不报错。
    'agint.evolutionDriver': ctx.get('agint.evolutionDriver'),
    // 美的神谕层（2026-09-27 新增 job oracle-daily/weekly/monthly）。懒解析；
    // agint-aesthetic-oracle 未挂载（含 kill-switch enabled:false ⇒ 不 provide）
    // 时为 undefined → job soft-skip 不报错（§6.4：kill-switch 秒级可逆）。
    'agint.aestheticOracle': ctx.get('agint.aestheticOracle'),
    // P1-1 记忆 provider（阶段 3 定期健康检查，2026-10-01 新增 job
    // memory-provider-health）。懒解析；agint-memory-provider 未挂载时为
    // undefined → job soft-skip 不报错（该插件稳定性标记为 experimental）。
    'agint.memoryProvider': ctx.get('agint.memoryProvider'),
    sessionPersistence: ctx.get('sessionPersistence'),
  });

  // Jobs in one tick run to completion, in declaration order. Previously each
  // was fired with `void runOne(job)` (fire-and-forget), so completion order
  // was just whichever action happened to finish first. Measured on the
  // 2026-09-18 10:10 wake-up backfill: observe 10:10:54 → release 10:10:55 →
  // aggregate 10:11:30. The pass that *generates* candidates landed 36s AFTER
  // the pass that releases them, so everything it created missed that bus and
  // waited for the next one (next day 05:45, or the next wake-up) — collapsing
  // the deliberate 30-minute gap (aggregate 05:15 → release 05:45, see jobs.js；
  // 2026-09-28 重排前是 04:45 → 05:15）into roughly a day.
  //
  // A serialised tick can outlive the 60s interval, so re-entrant ticks are
  // suppressed. STALL_MS is the watchdog for a wedged job (e.g. a provider
  // that ignores the abort signal): without it `tickRunning` would never clear
  // and the scheduler would stop for good — worse than the old shape, where a
  // wedged job only ever blocked itself. On takeover the stale tick bails out
  // between jobs, and `job.running` still guards the wedged job from a
  // duplicate start.
  const STALL_MS = 15 * 60_000;
  let tickRunning = false;
  let tickStartedAt = 0;
  let tickGen = 0;

  async function tick() {
    const now = Date.now();
    if (tickRunning) {
      if (now - tickStartedAt < STALL_MS) return; // a tick is already in flight
      console.error(
        '[agint-cron] tick in flight for ' + Math.round((now - tickStartedAt) / 60_000) +
        ' min — taking over (a job is presumably wedged; job.running still guards it)',
      );
    }
    const gen = ++tickGen;
    tickRunning = true;
    tickStartedAt = now;
    try {
      for (const job of jobs) {
        if (gen !== tickGen) return; // superseded by a newer tick — abandon this pass
        if (!job.id) continue; // (already filtered, but keep types)
        try {
          // Backfill-aware due check (replaces the old nextFire-from-lastRun
          // logic that silently skipped weekly jobs whose narrow fire window
          // fell inside the host's offline hours). isDue() fires a job whose
          // most-recent scheduled occurrence is strictly after its last run —
          // which backfills a never-run job once on boot and catches up a
          // weekly that slipped past while the host was offline, without ever
          // double-firing the same occurrence.
          if (!isDue(job.parsed, job.lastRunAt, now)) continue;
          if (job.running) continue; // skip if previous run still in flight
          // Run to completion before the next job is considered.
          await runOne(job);
        } catch (error) {
          console.error('[agint-cron] tick error for ' + job.id + ': ' + (error && error.message ? error.message : String(error)));
        }
      }
    } finally {
      if (gen === tickGen) tickRunning = false;
    }
  }

  async function runOne(job) {
    job.running = true;
    const startedAt = new Date().toISOString();
    try {
      const result = await job.action(services());
      job.lastResult = { ok: true, startedAt, result };
      job.lastError = null;
    } catch (error) {
      job.lastError = { startedAt, message: error && error.message ? error.message : String(error) };
      console.error('[agint-cron] job ' + job.id + ' failed: ' + job.lastError.message);
    } finally {
      job.lastRunAt = Date.now();
      job.running = false;
      await persistJobState(job).catch(() => { /* state write must never break the run */ });
    }
  }

  // Job outcomes were reduced to the single string 'ok' on the way to disk, so
  // "what did it actually do?" was unanswerable after a restart. This extracts
  // a small, strictly structural summary: only fields that are provably present
  // are copied, nothing is inferred, and an unrecognised shape degrades to the
  // list of keys it returned. Must never throw — a failed summary degrades to
  // null, per the same "state write must never break the run" rule below.
  const SUMMARY_MAX_BYTES = 2000;
  const PREVIEW_MAX = 10;

  function summarizeResult(result) {
    try {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
      const actions = Array.isArray(result.actions) ? result.actions : null;
      const report = result.report && typeof result.report === 'object' ? result.report : null;
      const summary = {};
      if (report && typeof report.scanned === 'number') summary.scanned = report.scanned;
      if (report && report.counts && typeof report.counts === 'object') summary.counts = report.counts;
      if (actions) {
        summary.actionsTotal = actions.length;
        summary.actionsPreview = actions.slice(0, PREVIEW_MAX).map((a) => {
          const o = a && typeof a === 'object' ? a : {};
          return {
            id: o.id ?? null,
            action: o.action ?? null,
            from: o.from ?? null,
            to: o.to ?? null,
            reason: o.reason ?? null,
          };
        });
      }
      if (Object.keys(summary).length === 0) summary.keys = Object.keys(result).slice(0, 10);
      // 2026-09-29：约定式摘要通道。
      // 判据与本函数完全一致 —— 只搬「显式约定」的结构，**不猜**任何 job 特有字段
      //（nothing is inferred，见头注释）。job 想让运行结果在重启后仍可读，就自己放
      // `result.summary`，cron 只做限长搬运。
      //
      // 起因：evolution-cycle 的 commit 阶段 policyDecision 完全不可见 —— 它只出现在
      // driver 发的事件里，而事件未落盘；cron 这边又只写 Object.keys(result)。
      // 顶层那个 `policyDecision` 是**提案阶段**的 variant.policy_decision，与 commit
      // 阶段的决策不是一回事，抄它会得到误导性的答案。
      if (result.summary && typeof result.summary === 'object' && !Array.isArray(result.summary)) {
        // 先单独试一次可序列化性：job 的 summary 若含循环引用，不能连带把上面
        // 已经摘好的 scanned / counts / actions 一起拖成 null。
        let safe = true;
        try { JSON.stringify(result.summary); } catch { safe = false; }
        summary.result = safe ? result.summary : '[unserializable]';
      }
      const json = JSON.stringify(summary);
      // Never slice mid-JSON — an unparseable summary is worse than a marker.
      if (json.length > SUMMARY_MAX_BYTES) return JSON.stringify({ truncated: true, bytes: json.length });
      return json;
    } catch {
      return null;
    }
  }

  // Best-effort persist of a job's run state to the cron_state domain so a
  // later process restart can hydrate lastRunAt/lastResult/lastError. Failures
  // are swallowed: the in-memory state is authoritative for the current run.
  async function persistJobState(job) {
    const record = {
      lastRunAt: job.lastRunAt ? new Date(job.lastRunAt).toISOString() : null,
      lastResult: job.lastResult ? 'ok' : null,
      lastError: job.lastError ? job.lastError.message : null,
      lastResultSummary: job.lastResult ? summarizeResult(job.lastResult.result) : null,
      updatedAt: new Date().toISOString(),
    };
    const table = await stateTable();
    await table.put(job.id, record);
  }

  ctx.provide('agint.cron', {
    list() {
      const now = Date.now();
      return jobs.map((j) => ({
        id: j.id,
        name: j.name,
        schedule: j.schedule,
        description: j.description,
        lastRunAt: j.lastRunAt ? new Date(j.lastRunAt).toISOString() : null,
        nextRunAt: nextFire(j.parsed, new Date(j.lastRunAt ?? bootTime))?.toISOString() ?? null,
        lastOk: j.lastResult ? true : (j.lastError ? false : null),
        lastError: j.lastError ? j.lastError.message : null,
        lastResultSummary: j.lastResultSummary ?? null,
        running: j.running,
      }));
    },

    async runNow(id) {
      const job = jobById.get(id);
      if (!job) throw new Error(`agint-cron: no job '${id}'`);
      if (job.running) throw new Error(`agint-cron: job '${id}' already running`);
      await runOne(job);
      return { ok: job.lastError === null, lastResult: job.lastResult, lastError: job.lastError };
    },

    health() {
      const now = Date.now();
      const issues = [];
      const status = jobs.map((j) => {
        const last = j.lastRunAt ?? bootTime;
        const expected = nextFire(j.parsed, new Date(last));
        const overdueMs = expected ? Math.max(0, now - expected.getTime()) : 0;
        // A job is stale if its expected run is more than 1.5 windows overdue.
        const windowMs = expected && j.lastRunAt ? expected.getTime() - (j.lastRunAt ?? expected.getTime()) : 7 * 86_400_000;
        const stale = j.lastRunAt === null ? (now - bootTime > windowMs * 2) : (overdueMs > windowMs * 0.5);
        if (stale) issues.push({ id: j.id, reason: 'overdue by ' + Math.round(overdueMs / 60_000) + ' min' });
        return {
          id: j.id,
          stale,
          overdueMs,
          lastRunAt: j.lastRunAt ? new Date(j.lastRunAt).toISOString() : null,
          expectedNextRunAt: expected?.toISOString() ?? null,
        };
      });
      return { healthy: issues.length === 0, issues, jobs: status };
    },

    // Internal helper for diagnostics; not part of the public surface but
    // useful for the boot-level diagnostic.
    _tickNow() { return tick(); },
    _jobs() { return jobById; },

    // 行动 #2a（2026-09-28）：宿主原生调度桥面。validateSchedules 用宿主
    // canonicalizeCronExpression 校验全部 job；mirrorCatalog 只读镜像宿主
    // schedule.catalog() 的 agint-cron: 前缀条目。全软依赖，宿主未接入时
    // 返回 hostAvailable:false（不影响本调度器）。
    hostSchedule: {
      status: () => hostSchedule.status(),
      validateSchedules: () => hostSchedule.validateSchedules(),
      mirrorCatalog: () => hostSchedule.mirrorCatalog(),
    },
  });
}

export { Config, apply, inject, name };