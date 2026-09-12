/**
 * agint-trajectory — P2-1 进化轨迹记录（训练数据层）。
 *
 * Service：`agint.trajectory.*`（§4.1 FROZEN 5 + §4.2 非 FROZEN）。
 * 存储域：`agint_trajectory`（独占，3 表，schemaVersion 1）。
 *
 * 五条 FROZEN 不变量（§4.3）落点：
 *   1. fail-open     → record() 全局 try/catch，永不 throw
 *   2. 真实截断      → truncatePayload 置 truncated + droppedSteps
 *   3. 分离导出      → export() 写 success / failure 两个文件
 *   4. L0 红线       → 不触碰任何 FROZEN 契约，只新增 trajectory.* 事件
 *   5. 标定期门禁    → setRecordMode('live') 无 ready 报告则抛错
 *
 * 哲学底线（§1.2 lesson 3）：轨迹只做**离线原料**，不回写上游域、不进在线决策。
 *
 * 本文件只放**运行时状态机 + 装配**；纯逻辑分在
 * assemble.js（组装）/ payload.js（截断聚合）/ governance.js（stats/prune/归因）
 * / export.js / calibrate.js / subscribers.js —— 按职责边界拆，不为行数
 * （仓库「单文件 ≤200 行」红线已于 2026-09-13 由老板取消）。
 *
 * Loader row（cordis.patch.yml 模板）：
 *   - insert:
 *       - id: agint-trajectory
 *         name: ./plugins/agint-trajectory/lib/index.js
 *         config: {}
 */

import { ConfigSchema, DEFAULTS, CountersSchema, dayKey } from './schema.js';
import { spec, COUNTERS_KEY, CALIBRATION_KEY } from './storage.js';
import { compileRules } from './redact.js';
import { assembleTrajectory, estimateInputBytes } from './assemble.js';
import { createCalibrationState, noteSample, buildReport } from './calibrate.js';
import { buildExport, writeExport } from './export.js';
import {
  computeStats, pruneRows, linkAttributionRow, findAttributionTarget,
} from './governance.js';
import { attachSubscriptions, createEnvelopeHandler } from './subscribers.js';

const name = 'agint-trajectory';
const inject = ['storageDomain'];
const optionalInject = ['agint.eventBus', 'agint.metrics', 'agint.toolStats'];

const MAX_LIST = 100;

function apply(ctx, config) {
  const cfg = ConfigSchema.parse(config ?? {});
  const rules = compileRules(cfg);
  let disposed = false;
  let domain = null;
  let domainError = null;
  let unsubscribe = null;
  let bus = { subscribed: [], degraded: false, reason: null };

  // ── 运行时三态（§7.1 正交：落盘档位 / 采样率 / 熔断）─────────────────
  let enabled = cfg.enabled;
  let recordMode = cfg.recordMode;
  const sampleRates = { ...DEFAULTS.SAMPLE_RATES, ...(cfg.sampleRates ?? {}) };
  let counters = CountersSchema.parse({ day: dayKey() });
  let calibration = createCalibrationState();
  let failStreak = 0;
  let flushTimer = null;

  ctx.effect(() => () => {
    disposed = true;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch { /* ignore */ } }
    if (domain) return domain.close();
    return undefined;
  });

  const ready = ctx.storageDomain.open(spec).then(
    (d) => {
      if (disposed) { void d.close().catch(() => {}); return null; }
      domain = d;
      return d;
    },
    (error) => { domainError = error; console.error('[agint-trajectory] storageDomain.open failed:', error?.message || error); return null; },
  );

  const table = async (tableName) => {
    if (disposed) throw new Error(`${name}: disposed`);
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error(`${name}: domain unavailable`);
    return d.table(tableName);
  };

  // ── 状态装载 / 节流持久化 ──────────────────────────────────────────────
  const loadState = async () => {
    try {
      const tc = await table('counters');
      const stored = tc.get(COUNTERS_KEY);
      if (stored) counters = CountersSchema.parse({ ...counters, ...stored, day: counters.day || stored.day });
      const cc = await table('calibration');
      const cs = cc.get(CALIBRATION_KEY);
      if (cs) calibration = { ...calibration, ...cs };
    } catch {
      /* 首次启动无状态，用默认值 */
    }
  };

  const persistState = async () => {
    const tc = await table('counters');
    await tc.put(COUNTERS_KEY, CountersSchema.parse({ ...counters, updatedAt: new Date().toISOString() }));
    const cc = await table('calibration');
    await cc.put(CALIBRATION_KEY, calibration);
  };

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void persistState().catch(() => {});
    }, 2000);
    flushTimer.unref?.();
  }

  // ── 事件 / 指标（软降级，绝不阻塞记录）──────────────────────────────────
  async function publish(topic, payload) {
    const p = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.publish') : null;
    if (typeof p !== 'function') return false;
    try {
      await p({ topic, version: 1, source: name, payload });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 丢弃上报（§7.3）。诚实标注：agint-metrics **没有外部 record 接口**
   * （只有 collect/summary），且跨域写 agint_metrics 违反域独占不变量。
   * 因此本版走「事件 + counters + stats() 暴露」；若未来 metrics 暴露
   * record 接口则自动接上。
   */
  async function reportDiscard(kind, payload) {
    await publish('trajectory.budget-exhausted', { kind, ...payload });
    const rec = typeof ctx.get === 'function' ? ctx.get('agint.metrics.record') : null;
    if (typeof rec === 'function') {
      try { await rec({ key: `trajectory.${kind}`, value: 1, unit: 'count' }); } catch { /* ignore */ }
    }
    if (!disposed) console.warn(`[${name}] drop: ${kind} ${JSON.stringify(payload)}`);
  }

  // ── FROZEN 1/5：record（永不 throw）─────────────────────────────────────
  async function record(input = {}) {
    try {
      const now = new Date();
      const day = dayKey(now);
      if (counters.day !== day) { counters.day = day; counters.dayCount = 0; counters.dayPersisted = 0; }

      if (!enabled) {
        counters.droppedDisabled++;
        scheduleFlush();
        return { id: null, reason: 'disabled' };
      }

      counters.dayCount++;
      const source = input.source ?? 'task';

      const rejectBytes = estimateInputBytes(input, cfg);
      if (rejectBytes > cfg.rejectBytes) {
        counters.droppedPayload++;
        scheduleFlush();
        void reportDiscard('droppedPayload', { source, bytes: rejectBytes });
        return { id: null, reason: 'payload-too-large', bytes: rejectBytes };
      }

      const { traj, truncated, bytes } = assembleTrajectory(input, cfg, rules, now);
      noteSample(calibration, { day, bytes, truncated });

      // 落盘档位：count-only 只计数 + 估算，不写 trajectories 表（§7.1）
      if (recordMode === 'count-only') {
        scheduleFlush();
        return { id: null, reason: 'count-only', bytes, truncated };
      }

      const rate = sampleRates[source] ?? 1;
      if (Math.random() >= rate) {
        counters.sampledOut++;
        scheduleFlush();
        return { id: null, reason: 'sampled-out', bytes };
      }

      if (counters.dayPersisted >= cfg.maxPerDay) {
        counters.droppedFull++;
        scheduleFlush();
        void reportDiscard('droppedFull', { source, day, dayPersisted: counters.dayPersisted });
        return { id: null, reason: 'quota', bytes };
      }

      const t = await table('trajectories');
      await t.put(traj.id, traj);
      counters.total++;
      counters.dayPersisted++;
      if (truncated) counters.truncatedCount++;
      failStreak = 0;
      scheduleFlush();
      void publish('trajectory.recorded', { id: traj.id, source: traj.source, kind: traj.kind, durationMs: traj.durationMs });
      return { id: traj.id, truncated, redacted: traj.redacted, bytes: traj.bytes };
    } catch (err) {
      counters.writeFailures++;
      failStreak++;
      if (failStreak >= cfg.failStreakLimit) {
        enabled = false;
        if (!disposed) console.error(`[${name}] circuit open after ${failStreak} write failures`);
      }
      scheduleFlush();
      return { id: null, reason: 'error', error: String(err?.message ?? err) };
    }
  }

  // ── FROZEN 2/3：get / list ─────────────────────────────────────────────
  async function get(id) {
    if (!id) return null;
    const t = await table('trajectories');
    return t.get(String(id)) ?? null;
  }

  async function list(filter = {}) {
    const t = await table('trajectories');
    const rows = [...t.entries()].map(([, v]) => v);
    const limit = Math.min(Number(filter.limit) || 20, MAX_LIST);
    const from = filter.timeRange?.from ? Date.parse(filter.timeRange.from) : null;
    const to = filter.timeRange?.to ? Date.parse(filter.timeRange.to) : null;
    const ref = filter.taskRef ?? null;
    const matched = rows.filter((r) => {
      if (filter.source && r.source !== filter.source) return false;
      if (filter.kind && r.kind !== filter.kind) return false;
      if (from && Date.parse(r.startedAt) < from) return false;
      if (to && Date.parse(r.startedAt) > to) return false;
      if (ref) {
        for (const [k, v] of Object.entries(ref)) {
          if (v == null) continue;
          if (r.taskRef?.[k] !== v) return false;
        }
      }
      return true;
    });
    return matched
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .slice(0, limit);
  }

  // ── FROZEN 4：export（成功/失败物理分离）─────────────────────────────────
  async function exportTrajectories(opts = {}) {
    const rows = await list({ ...(opts.filter ?? {}), limit: opts.filter?.limit ?? MAX_LIST });
    const format = opts.format === 'jsonl' ? 'jsonl' : 'sharegpt';
    const built = buildExport(rows, {
      format,
      foldObservation: opts.foldObservation ?? cfg.foldObservation,
    });
    return writeExport({ dir: opts.dir ?? cfg.exportDir, date: opts.date, format, ...built });
  }

  // ── FROZEN 5：stats ────────────────────────────────────────────────────
  const stats = () => computeStats({
    table, cfg, counters, calibration, sampleRates, mode: recordMode, enabled, bus,
  });
  const prune = (opts = {}) => pruneRows({ table, cfg, opts, publish });
  const linkAttribution = (id, patch = {}) => linkAttributionRow({ table, id, patch });
  const findTarget = (ref = {}) => findAttributionTarget({ table, ref });

  // ── 非 FROZEN 开关（§4.2）──────────────────────────────────────────────
  function setEnabled(next) {
    enabled = Boolean(next);
    if (enabled) failStreak = 0;
    return { enabled };
  }

  function setSample(source, rate) {
    const r = Math.min(1, Math.max(0, Number(rate)));
    if (Number.isNaN(r)) throw new Error(`${name}: setSample rate must be 0..1`);
    sampleRates[source] = r;
    return { sampleRates: { ...sampleRates } };
  }

  /** 不变量 #5：切 live 必须已有 ready 的标定期报告，否则抛错（不是警告） */
  function setRecordMode(mode) {
    if (!['count-only', 'live'].includes(mode)) throw new Error(`${name}: unknown recordMode ${mode}`);
    if (mode === 'live' && calibration.lastReport?.ready !== true) {
      throw new Error(
        `${name}: setRecordMode('live') rejected — 缺少标定期报告（不变量 #5）。` +
        `先跑 count-only 标定，再调 calibration() 产出四项齐备的报告：` +
        `${(calibration.lastReport?.missing ?? ['perDay', 'p50Bytes', 'p95Bytes', 'truncateRate']).join(' / ')}`,
      );
    }
    recordMode = mode;
    return { recordMode };
  }

  function calibrationReport() {
    const report = buildReport({
      state: calibration,
      counters,
      retentionDays: cfg.retentionDays,
      safetyFactor: cfg.safetyFactor,
    });
    calibration.lastReport = report;
    scheduleFlush();
    return report;
  }

  // ── 事件订阅（§5.1，含降级路径）─────────────────────────────────────────
  const handleEnvelope = createEnvelopeHandler({
    record, findAttributionTarget: findTarget, linkAttribution,
  });

  ready.then(async () => {
    if (disposed) return;
    await loadState();
    if (!cfg.enableEventSubscribe) {
      bus = { subscribed: [], degraded: true, reason: 'disabled by config (降级：仅显式 record())' };
      return;
    }
    const subscribeFn = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.subscribe') : null;
    bus = attachSubscriptions({ subscribeFn, onEnvelope: handleEnvelope });
    unsubscribe = bus.unsubscribe;
    if (bus.degraded && !disposed) {
      console.warn(`[${name}] event-bus subscription degraded: ${bus.reason}（降级：仅显式 record()）`);
    }
  }).catch(() => { /* 状态装载失败不阻塞 Service（fail-open） */ });

  const service = {
    record,
    get,
    list,
    export: exportTrajectories,
    stats,
    linkAttribution,
    prune,
    setEnabled,
    setSample,
    setRecordMode,
    calibration: calibrationReport,
    /** 运行时快照（诊断用，非 FROZEN） */
    state: () => ({
      enabled, recordMode, sampleRates: { ...sampleRates }, counters: { ...counters },
      calibration: calibration.lastReport ?? null, bus,
    }),
  };

  ctx.provide('agint.trajectory', service);
  return service;
}

export { name, inject, optionalInject, apply, ConfigSchema, spec };
