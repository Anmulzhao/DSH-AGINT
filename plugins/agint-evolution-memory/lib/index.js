/**
 * agint-evolution-memory: host service plugin (provides `agint.evolution`).
 *
 * 物理隔离的进化记忆存储域，独立于任务记忆 `agint`。
 *   - 存储域：agint_evolution（独立 @deepseek-ai/dsh-storage-domain）
 *   - 三个表：
 *       evolutionLog      每次 D-QAF Phase 4 完成后追加
 *       failurePattern    REJECT 决策自动写入 + 周复盘归纳
 *       successTemplate   周复盘蒸馏（手工 / 自动化蒸馏均支持）
 *
 * 设计原则：
 *   - 物理隔离：跟任务记忆不同 storage domain，避免跨域污染
 *   - 自动化写入：logPhase4 / addFailure 由 D-QAF 流水线触发
 *   - 定向读取：仅在进化评估阶段被 D-QAF / dream deep 读取
 *   - 上限保护：failure 100 / template 50，超限返回 warn（不自动 prune）
 *   - 检索：线性扫 + lowercase substring（老板 2026-08-20 拍板）
 *   - 衰减：L1-L4 + confidence，跟 agint-memory 一致（纯复制 decay.js）
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-evolution-memory
 *         name: ./plugins/agint-evolution-memory/lib/index.js
 *         config: {}
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import {
  evolutionLogEntrySchema,
  failurePatternSchema,
  successTemplateSchema,
  LIMITS,
  matchesQuery,
} from './schema.js';
import { decayScan } from './decay.js';
import { createLogBuffer, DEFAULT_FLUSH_COUNT, DEFAULT_FLUSH_MS } from './log-buffer.js';

const name = 'agint-evolution-memory';
const inject = ['storageDomain'];

const Config = z.object({}).optional();

// 三表 schema（用 zod）
const spec = defineDomain({
  name: 'agint_evolution',
  version: 1,
  tables: {
    evolution_log: { valueSchema: evolutionLogEntrySchema },
    failure_pattern: { valueSchema: failurePatternSchema },
    success_template: { valueSchema: successTemplateSchema },
  },
});

function randomId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `e-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso() { return new Date().toISOString(); }

function apply(ctx) {
  let domain = null;
  let domainError = null;
  let disposed = false;

  ctx.effect(() => () => {
    disposed = true;
    if (domain) return domain.close();
  });

  const ready = ctx.storageDomain.open(spec).then(
    (d) => {
      if (disposed) { void d.close().catch(() => {}); return null; }
      domain = d;
      return d;
    },
    (error) => { domainError = error; return null; },
  );

  // Sprint 10 v0.6.4 #7：EvolutionLogBuffer 实例（domain ready 后创建）
  // memFallback = ctx.get('agint.memory')；domain ready 后才可访问 table
  let logBuffer = null;
  ready.then((d) => {
    if (!d || disposed) return;
    const memFallback = ctx.get('agint.memory') ?? { write: async () => ({ ok: false, reason: 'no-memFallback' }) };
    logBuffer = createLogBuffer({
      storage: d,
      memFallback,
      flushCount: DEFAULT_FLUSH_COUNT,
      flushMs: DEFAULT_FLUSH_MS,
    });
  }).catch(() => { /* domain unavailable: logBuffer 保持 null, caller 用 logPhase4 同步路径 */ });

  const table = async (name) => {
    if (disposed) throw new Error('agint-evolution-memory: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-evolution-memory: domain unavailable');
    return d.table(name);
  };

  const t_log = () => table('evolution_log');
  const t_fail = () => table('failure_pattern');
  const t_template = () => table('success_template');

  // ── 写入 helpers ────────────────────────────────────────────────────────

  /** Append one evolution-log entry. Returns the persisted record. */
  async function logPhase4({ targetId, targetKind, decision, scores = {}, findings = [], tags = [] }) {
    if (!targetId) throw new Error('logPhase4: targetId is required');
    const entry = evolutionLogEntrySchema.parse({
      id: randomId(),
      kind: 'evolution-log',
      targetId,
      targetKind,
      decision,
      scores,
      findings,
      tags,
    });
    await (await t_log()).put(entry.id, entry);
    return { ...entry };
  }

  /**
   * logPhase4Buffered — Sprint 10 v0.6.4 #7 异步批量写入路径
   *
   * 与 logPhase4 同契约，但走 EvolutionLogBuffer 异步批量落盘。
   * 设计稿 §二.5：高频评估期（≥50 次 logPhase4 调用）从 50 次 → 5 次 I/O。
   *
   * 何时用：caller 自己决定（默认 caller 是 evaluateAll/decode/generate 流水线的
   * hot path；常规 caller 仍走 logPhase4 同步路径，保留向后兼容）。
   *
   * 不返回存储的 entry（异步）；返回 { queued: true, id } 即可。
   * 读时走 readLogRangeMerged（buffer + storage 合并视图），不破坏 storage。
   */
  async function logPhase4Buffered({ targetId, targetKind, decision, scores = {}, findings = [], tags = [] }) {
    if (!targetId) throw new Error('logPhase4Buffered: targetId is required');
    const entry = evolutionLogEntrySchema.parse({
      id: randomId(),
      kind: 'evolution-log',
      targetId,
      targetKind,
      decision,
      scores,
      findings,
      tags,
    });
    logBuffer.enqueue(entry);
    return { queued: true, id: entry.id };
  }

  /**
   * readLogRangeMerged — Sprint 10 v0.6.4 #8 读时合并视图
   *
   * 返回 buffer + storage 合并的 evolution_log 视图（buffer 在前）。
   * 不污染 storage（buffer 仅在内存 + flush 后才落盘）。
   */
  async function readLogRangeMerged(opts = {}) {
    return logBuffer.readMerged(opts.query);
  }

  /**
   * flushLogBufferNow — Sprint 10 v0.6.4 #7 立即强制 flush
   */
  async function flushLogBufferNow() {
    return logBuffer.flush('manual');
  }

  // 退出钩子：ctx.effect() disposer 在 plugin dispose 时强制 flush（设计稿 §二.5 退出触发）。
  // 不注册 process.on(beforeExit/SIGTERM) — 那些会让 Node 测试 process 永久卡住等待 listener 释放。
  // 生产 dsh 的 SIGTERM 处理在 dsh 主进程统一接管；plugin 自身的优雅停机由 ctx.effect() disposer 链驱动。
  ctx.effect(() => () => {
    if (logBuffer) void logBuffer.shutdown();
  });

  /**
   * Add a failure pattern. If a pattern with the same text already exists,
   * increment its occurrences instead of creating a duplicate. Returns the
   * stored record.
   */
  async function addFailure({ pattern, category = 'other', severity = 'medium', evidence = '' }) {
    if (!pattern) throw new Error('addFailure: pattern is required');
    const t = await t_fail();
    // 查找重复
    for (const [id, rec] of t.entries()) {
      if (rec.pattern === pattern) {
        const updated = { ...rec, occurrences: (rec.occurrences ?? 1) + 1, updatedAt: nowIso(), lastRecall: nowIso() };
        await t.put(id, updated);
        return { ...updated, _deduped: true };
      }
    }
    const entry = failurePatternSchema.parse({
      id: randomId(),
      kind: 'failure-pattern',
      pattern,
      category,
      severity,
      evidence,
    });
    await t.put(entry.id, entry);

    // 上限检查：超过 LIMITS.FAILURE_PATTERNS → 返回 warn
    const count = t.entries().length;
    if (count > LIMITS.FAILURE_PATTERNS) {
      return { ...entry, _warn: `failure-patterns count ${count} > limit ${LIMITS.FAILURE_PATTERNS}` };
    }
    return { ...entry };
  }

  /**
   * Add a success template. No dedup — distinct templates are kept distinct.
   * Returns the stored record.
   */
  async function addSuccess({ template, sampleSize = 1, appliesTo = [], evidence = '' }) {
    if (!template) throw new Error('addSuccess: template is required');
    const t = await t_template();
    const entry = successTemplateSchema.parse({
      id: randomId(),
      kind: 'success-template',
      template,
      sampleSize,
      appliesTo,
      evidence,
    });
    await t.put(entry.id, entry);

    const count = t.entries().length;
    if (count > LIMITS.SUCCESS_TEMPLATES) {
      return { ...entry, _warn: `success-templates count ${count} > limit ${LIMITS.SUCCESS_TEMPLATES}` };
    }
    return { ...entry };
  }

  // ── 读取 helpers ────────────────────────────────────────────────────────

  /** Query failure patterns. opts: { query?, category?, severity?, limit? } */
  async function queryFailures(opts = {}) {
    const t = await t_fail();
    const out = [];
    for (const [id, rec] of t.entries()) {
      if (opts.category && rec.category !== opts.category) continue;
      if (opts.severity && rec.severity !== opts.severity) continue;
      if (opts.query && !matchesQuery(`${rec.pattern} ${rec.evidence ?? ''}`, opts.query)) continue;
      out.push({ id, ...rec });
    }
    out.sort((a, b) => (b.occurrences ?? 1) - (a.occurrences ?? 1) || b.updatedAt.localeCompare(a.updatedAt));
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 20;
    return out.slice(0, limit);
  }

  async function queryTemplates(opts = {}) {
    const t = await t_template();
    const out = [];
    for (const [id, rec] of t.entries()) {
      if (opts.query && !matchesQuery(`${rec.template} ${rec.evidence ?? ''}`, opts.query)) continue;
      if (opts.appliesTo && opts.appliesTo.length > 0) {
        const overlap = (rec.appliesTo ?? []).some((a) => opts.appliesTo.includes(a));
        if (!overlap) continue;
      }
      out.push({ id, ...rec });
    }
    out.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 20;
    return out.slice(0, limit);
  }

  /**
   * Get evolution-log entries in [fromDate, toDate] (inclusive). ISO date
   * strings (YYYY-MM-DD or full ISO). Limit defaults to 200.
   */
  async function getLogRange({ fromDate, toDate, limit = 200 } = {}) {
    const t = await t_log();
    const from = fromDate ? new Date(fromDate).getTime() : 0;
    const to = toDate ? new Date(toDate).getTime() + 86_400_000 : Date.now() + 1;
    const out = [];
    for (const [id, rec] of t.entries()) {
      const ts = Date.parse(rec.ts ?? rec.createdAt);
      if (Number.isFinite(ts) && (ts < from || ts > to)) continue;
      out.push({ id, ...rec });
    }
    out.sort((a, b) => (b.ts ?? b.createdAt).localeCompare(a.ts ?? a.createdAt));
    return out.slice(0, limit);
  }

  /**
   * Run a decay scan over all three tables. Returns a unified report.
   * Caller is responsible for applying the actions (we do NOT auto-apply,
   * matching the agint-memory pattern where apply is opt-in).
   */
  async function decayScanRun(opts = {}) {
    const out = { evolutionLog: null, failurePattern: null, successTemplate: null, applied: [], generatedAt: nowIso() };
    const now = opts.now ?? Date.now();
    for (const [kind, tGetter, tableName] of [
      ['evolutionLog', t_log, 'evolution_log'],
      ['failurePattern', t_fail, 'failure_pattern'],
      ['successTemplate', t_template, 'success_template'],
    ]) {
      const t = await tGetter();
      const entries = [...t.entries()];
      const scan = decayScan(entries, now);
      out[kind] = { ...scan };
      if (opts.apply) {
        for (const a of scan.actions) {
          const rec = t.get(a.id);
          if (!rec) continue;
          if (a.action === 'downgrade') {
            await t.put(a.id, { ...rec, level: a.to, updatedAt: nowIso() });
          } else if (a.action === 'clear') {
            await t.delete(a.id);
          }
          out.applied.push({ table: tableName, ...a });
        }
      }
    }
    return out;
  }

  async function stats() {
    const t1 = await t_log();
    const t2 = await t_fail();
    const t3 = await t_template();
    return {
      evolution_log: t1.entries().length,
      failure_pattern: t2.entries().length,
      success_template: t3.entries().length,
      limits: LIMITS,
    };
  }

  ctx.provide('agint.evolution', {
    logPhase4,
    logPhase4Buffered,    // Sprint 10 v0.6.4 #7 异步批量写入
    readLogRangeMerged,   // Sprint 10 v0.6.4 #8 读时合并视图
    flushLogBufferNow,    // Sprint 10 v0.6.4 #7 强制 flush
    addFailure,
    addSuccess,
    queryFailures,
    queryTemplates,
    getLogRange,
    decayScanRun,
    stats,
    // 暴露 LIMIT 给上游读取
    limits: LIMITS,
  });
}

export { Config, apply, inject, name };
