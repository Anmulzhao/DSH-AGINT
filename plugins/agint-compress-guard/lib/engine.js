/**
 * agint-compress-guard: GuardEngine —— 编排状态机 + FROZEN 6 Service（设计稿 §3.2 / §4.1）。
 *
 * 编排（§3.2 两段式 fail-closed，Q2）：
 *   [1] raw 检查点：host-compaction → shadowedSeqs 天然凭据；p1-checkpoint →
 *       委托 agint.memoryProvider.runPreCompressCheckpoint（P1-1 既有 fail-closed
 *       闸门）。写入失败 → BLOCKED_CHECKPOINT（硬门；shadow 档降级为记录告警）。
 *   [2] 洞察提取：规则版 ≤ maxInsightsPerCompress，3s 软超时；
 *       失败 → DEGRADED_INSIGHT（软降级，raw 兜底，不中止）。
 *   放行 → guard_log 落一行 + compress-guard.checkpointed 事件。
 *
 * 不变量（§4.3 全 8 条映射位置）：
 *   1 raw 先于洞察 → schema.validateInsight + extract 入参强校验
 *   2 写失败必中止 → 本文件 BLOCKED 分支（shadow 档为拍板前观察态，配置显式）
 *   3 fail-open 对调用方 → checkpoint() 永不 throw（内部异常记 DEGRADED）
 *   5 单一入口 → 提取只经 provider.onPreCompress（provider-bridge.js），
 *     本 engine 的 extract 仅供离线补录（设计稿 §4.1 extract 语义）
 *   6 零数据必须响 → stats() 双源合计 0 时返回 NO_SOURCE_REACHED
 *   7 事件名已核实 → schema.js TOPICS_* 全 grep 命中
 *   8 降级可恢复 → maybeProbeRecovery（跳闸 → 冷却 → 探针 → 复位）
 */

import {
  GUARD_TIERS,
  datedId,
  nowIso,
  validateInsight,
} from './schema.js';
import {
  emptyCounters,
  packInsight,
  packGuardLog,
  packCounters,
  packConfig,
} from './storage.js';
import { extractInsights } from './extractors.js';

/** 给 promise 施加软超时；超时不取消原操作，只放弃等待（对齐 P1-1 withTimeout） */
function withTimeout(promise, ms, onTimeout) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout?.();
      reject(new Error(`extract 软超时（>${ms}ms）→ DEGRADED_INSIGHT`));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise).then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } },
    );
  });
}

export class GuardEngine {
  /**
   * @param {object} deps
   * @param {(name: string) => Promise<object>} deps.table 表获取器（index.js 注入）
   * @param {() => object} deps.config 返回生效配置（含 runtime override）
   * @param {object|null} [deps.memoryProvider] agint.memoryProvider 服务（软依赖）
   * @param {(topic: string, payload: object) => Promise<boolean>} [deps.publish]
   * @param {(insights: Array, ctx: object) => Promise<Array>} [deps.persistInsights]
   *        洞察持久化钩子（默认走 insights 表；测试可注入故障）
   * @param {(msg: string) => void} [deps.debug]
   */
  constructor({ table, config, memoryProvider = null, publish, persistInsights, debug } = {}) {
    if (typeof table !== 'function') throw new Error('GuardEngine: table 获取器必填');
    if (typeof config !== 'function') throw new Error('GuardEngine: config 必须是函数');
    this.tableFn = table;
    this.configFn = config;
    this.memoryProvider = memoryProvider;
    this.publish = typeof publish === 'function' ? publish : async () => false;
    this.persistInsights = typeof persistInsights === 'function' ? persistInsights : null;
    this.debug = typeof debug === 'function' ? debug : () => {};

    /** 内存态：连续检查点写失败计数（成功清零）+ 降级起点（恢复探测用） */
    this.consecutiveWriteFailures = 0;
    this.degradedSince = 0;
    /** runtime 配置覆盖（熔断/开关当场生效；config 表持久化由 index.js 同步维护） */
    this.runtimeOverrides = {};
  }

  async table(name) {
    return this.tableFn(name);
  }

  cfg() {
    // runtime 覆盖（setEnabled / setLlmExtract 落表的同时即时生效，
    // 不等下次 loadPersistedConfig —— 熔断必须当场生效）
    return { ...this.configFn(), ...this.runtimeOverrides };
  }

  // ── counters（单例行，增量合并）────────────────────────────────────────

  async bumpCounters(delta) {
    const t = await this.table('counters');
    const existing = t.get('counters') ?? emptyCounters();
    const merged = { ...emptyCounters() };
    for (const k of Object.keys(merged)) merged[k] = (existing?.[k] ?? 0) + (delta?.[k] ?? 0);
    const entry = packCounters(merged, existing);
    await t.put(entry.id, entry);
    return entry;
  }

  async getCounters() {
    const t = await this.table('counters');
    const existing = t.get('counters');
    const merged = { ...emptyCounters() };
    for (const k of Object.keys(merged)) merged[k] = existing?.[k] ?? 0;
    return merged;
  }

  // ── 恢复探测（不变量 8；Hermes 跳闸 → 冷却 → 探针 → 复位）──────────────

  /**
   * 降级满 recoveryProbeMs 后，放行一次探针级检查点写。
   * @returns {Promise<boolean>} true = 本次是探针放行（调用方应尝试完整路径）
   */
  async maybeProbeRecovery(now) {
    if (this.consecutiveWriteFailures === 0) return false;
    const probeMs = this.cfg().recoveryProbeMs;
    if (!this.degradedSince || now - this.degradedSince < probeMs) return false;
    await this.bumpCounters({ recoveryProbes: 1 });
    this.debug('[engine] 恢复探针放行（降级已满冷却期）');
    return true;
  }

  /** 探针/成功后复位回 fail-closed */
  noteWriteSuccess() {
    this.consecutiveWriteFailures = 0;
    this.degradedSince = 0;
  }

  /** 写失败计数 + 记降级起点（首次失败时） */
  noteWriteFailure(now) {
    this.consecutiveWriteFailures += 1;
    if (!this.degradedSince) this.degradedSince = now;
  }

  // ── [1] raw 检查点（硬门）───────────────────────────────────────────────

  /**
   * C 档 raw 快照：委托 P1-1 runPreCompressCheckpoint（既有 fail-closed 闸门）。
   * @returns {Promise<{ok: boolean, checkpointId: string|null, reason: string|null}>}
   */
  async runRawCheckpoint(messages, sessionId, now) {
    const probe = await this.maybeProbeRecovery(now);
    const svc = this.memoryProvider;
    if (!svc || typeof svc.runPreCompressCheckpoint !== 'function') {
      this.noteWriteFailure(now);
      return { ok: false, checkpointId: null, reason: 'agint.memoryProvider 不可用（raw 检查点无处落）' };
    }
    try {
      const r = await svc.runPreCompressCheckpoint(messages, { sessionId });
      if (!r || r.abortCompress === true || !r.checkpointId) {
        this.noteWriteFailure(now);
        return { ok: false, checkpointId: r?.checkpointId ?? null, reason: r?.reason ?? 'P1-1 检查点写入失败' };
      }
      this.noteWriteSuccess();
      return { ok: true, checkpointId: r.checkpointId, reason: null, probe };
    } catch (e) {
      this.noteWriteFailure(now);
      return { ok: false, checkpointId: null, reason: `runPreCompressCheckpoint 抛错: ${e?.message ?? e}` };
    }
  }

  // ── 编排入口（FROZEN Service 1：checkpoint）─────────────────────────────

  /**
   * 压缩前编排（§3.2 状态机）。**永不 throw**（不变量 3 fail-open 对调用方）。
   *
   * @param {object} input
   * @param {'p1-checkpoint'|'host-compaction'} input.kind
   * @param {string|null} [input.id] checkpointId（p1）/ compactionId（host）
   * @param {string} [input.text] 提取源文本（B 档传 summary；显式调用传原文）
   * @param {Array} [input.messages] 提取源消息列表（C 档显式调用）
   * @param {number[]} [input.shadowedSeqs] host-compaction 凭据
   * @param {number} [input.shadowedTokenCount]
   * @param {string} [input.sessionId]
   * @param {boolean} [input.runRawSnapshot] p1-kind 且带 messages 时是否跑 raw 快照（默认 true）
   * @returns {Promise<{status: string, abortCompress: boolean, insightsExtracted: number,
   *                     checkpointRef: object, rawBytes: number, tier: string, note: string|null,
   *                     disabled?: boolean, shadowed?: boolean}>}
   */
  async checkpoint(input = {}) {
    const cfg = this.cfg();
    const now = Date.now();
    const startedAt = nowIso();

    // 全局熔断：压缩直通（P1-1 原行为），counters 留痕（§4.1 setEnabled）
    if (!cfg.enabled) {
      await this.bumpCounters({ disabledPassThrough: 1 }).catch(() => {});
      return {
        status: 'DISABLED', abortCompress: false, insightsExtracted: 0,
        checkpointRef: { kind: input.kind ?? 'host-compaction', id: input.id ?? null },
        rawBytes: 0, tier: 'C', note: 'enabled=false 压缩直通', disabled: true,
      };
    }

    const kind = input.kind === 'host-compaction' ? 'host-compaction' : 'p1-checkpoint';
    const tier = kind === 'host-compaction' ? 'B' : 'C';
    let status = 'PASSED';
    let note = null;
    let insightsExtracted = 0;
    let rawBytes = 0;
    let abortCompress = false;
    let refId = input.id ?? null;

    try {
      // ── [1] raw 检查点（硬门）───────────────────────────────────────────
      if (kind === 'host-compaction') {
        // B 档：shadowedSeqs 天然已有（「什么被换掉」的凭据，§3.2 [1]）。
        // 无否决权（事件在提交后触发）→ 没有 abort 语义。
        rawBytes = input.shadowedTokenCount ?? 0;
        if (!Array.isArray(input.shadowedSeqs) || input.shadowedSeqs.length === 0) {
          note = 'compaction/summary 无 shadowedSeqs（降为仅审计）';
        }
      } else if (Array.isArray(input.messages) && input.messages.length > 0 && input.runRawSnapshot !== false) {
        // C 档：raw 快照委托 P1-1（分层不重建，Q3）
        const raw = await this.runRawCheckpoint(input.messages, input.sessionId, now);
        if (raw.checkpointId && !refId) refId = raw.checkpointId;
        rawBytes = JSON.stringify(input.messages).length;
        if (!raw.ok) {
          // 硬门：BLOCKED。shadow 档（§七挂载策略）：记录告警不真中止，
          // 观察一周误触发率后老板拍板转真中止。
          status = 'BLOCKED_CHECKPOINT';
          note = raw.reason;
          await this.bumpCounters({ checkpointWriteFailures: 1 });
          if (cfg.shadowMode) {
            await this.bumpCounters({ blockedShadowed: 1 });
            note = `${raw.reason}（shadow 档：记录告警不中止）`;
          } else {
            abortCompress = true;
          }
          await this.publishBlocked({ kind, id: refId }, note ?? 'checkpoint write failed');
        }
      }

      // ── [2] 洞察提取（软降级）───────────────────────────────────────────
      if (status !== 'BLOCKED_CHECKPOINT' && cfg.llmExtractEnabled === false) {
        const text = input.text ?? flattenMessages(input.messages);
        if (!text || !text.trim()) {
          note = note ?? '无可提取文本（0 条洞察，raw 兜底）';
        } else {
          try {
            // 3s 软超时覆盖提取 + 持久化（真正的异步风险在表 IO）。
            // JS 无法取消已发起的操作：超时后落库可能仍完成（孤儿洞察），
            // 但本轮按 DEGRADED 记账——宁可诚实降级也不吊住压缩流程。
            const ext = extractInsights(text, { max: cfg.maxInsightsPerCompress });
            const refCtx = {
              kind, id: refId, shadowedSeqs: input.shadowedSeqs,
              shadowedTokenCount: input.shadowedTokenCount, sessionId: input.sessionId ?? null,
            };
            const persisted = await withTimeout(
              this.persistExtracted(ext, refCtx),
              cfg.extractTimeoutMs,
            );
            insightsExtracted = persisted.length;
            if (ext.length > 0 && persisted.length === 0) {
              status = 'DEGRADED_INSIGHT';
              note = '洞察全部持久化失败（raw 兜底不受影响）';
            }
          } catch (e) {
            status = 'DEGRADED_INSIGHT';
            note = String(e?.message ?? e);
            await this.bumpCounters({ extractFailures: 1 });
          }
        }
      }
    } catch (e) {
      // fail-open 对调用方（不变量 3）：自身异常不炸记忆主链路。
      // 但硬门语义保留：非 shadow 下未知的自身异常也按 BLOCKED 处理。
      status = 'BLOCKED_CHECKPOINT';
      note = `engine 内部异常: ${e?.message ?? e}`;
      if (cfg.shadowMode) note += '（shadow 档：记录告警不中止）';
      else abortCompress = true;
      await this.publishBlocked({ kind, id: refId }, note).catch(() => {});
    }

    const endedAt = nowIso();
    const checkpointRef = { kind, id: refId };
    try {
      const t = await this.table('guard_log');
      const entry = packGuardLog({
        checkpointRef,
        tier,
        status,
        insightsExtracted,
        rawBytes,
        startedAt,
        endedAt,
        note,
      });
      await t.put(entry.id, entry);
    } catch (e) {
      this.debug(`[engine] guard_log 落库失败: ${e?.message ?? e}`);
    }

    if (status !== 'BLOCKED_CHECKPOINT') {
      await this.publish('compress-guard.checkpointed', {
        status, insightsExtracted, rawBytes, checkpointRef: { kind, id: refId },
      }).catch(() => {});
    }

    return {
      status, abortCompress, insightsExtracted, checkpointRef,
      // FROZEN 签名（§4.1）：checkpoint(input) -> { checkpointId, status, insightsExtracted }
      checkpointId: refId,
      rawBytes, tier, note,
      shadowed: status === 'BLOCKED_CHECKPOINT' && cfg.shadowMode,
    };
  }

  async publishBlocked(checkpointRef, reason) {
    await this.publish('compress-guard.blocked', { checkpointRef, reason }).catch(() => {});
  }

  /** 洞察批量落库（可注入故障供测试）；返回成功条数列表 */
  async persistExtracted(insights, refCtx) {
    if (!Array.isArray(insights) || insights.length === 0) return [];
    const extractedAt = nowIso();
    const rows = insights.map((ins) => packInsight({
      type: ins.type,
      content: ins.content,
      retention: ins.type === 'preference' ? 'highRetention' : 'normal',
      source: {
        checkpointRef: {
          kind: refCtx.kind,
          id: refCtx.id ?? null,
          ...(Array.isArray(refCtx.shadowedSeqs) ? { shadowedSeqs: refCtx.shadowedSeqs } : {}),
          ...(Number.isFinite(refCtx.shadowedTokenCount) ? { shadowedTokenCount: refCtx.shadowedTokenCount } : {}),
          sessionId: refCtx.sessionId ?? null,
          rawOffset: ins.rawOffset,
          extractedAt,
          extractor: 'rule-v1',
        },
      },
      linkPending: !refCtx.id,
    }));
    if (this.persistInsights) return this.persistInsights(rows, refCtx);
    const t = await this.table('insights');
    const ok = [];
    for (const row of rows) {
      try {
        await t.put(row.id, row);
        ok.push(row);
      } catch (e) {
        this.debug(`[engine] insight 落库失败: ${e?.message ?? e}`);
      }
    }
    return ok;
  }

  // ── FROZEN Service 2：extract（离线补录用；必须带 checkpointRef）────────

  async extract(input = {}) {
    const cfg = this.cfg();
    if (!cfg.enabled) return [];
    const text = input.text ?? flattenMessages(input.messages);
    const ref = input.checkpointRef;
    if (!ref || !ref.kind) {
      throw new Error('extract: checkpointRef 必填（不变量 1「raw 先于洞察」：无 raw 引用的洞察非法）');
    }
    const insights = extractInsights(text ?? '', { max: cfg.maxInsightsPerCompress });
    const persisted = await this.persistExtracted(insights, {
      kind: ref.kind, id: ref.id ?? null, sessionId: input.sessionId ?? null,
    });
    return persisted;
  }

  // ── FROZEN Service 3：search ────────────────────────────────────────────

  async search(opts = {}) {
    const limit = Math.max(1, Math.min(Number(opts.limit) || 20, 50));
    const keyword = String(opts.keyword ?? opts.query ?? '').toLowerCase().trim();
    const timeRange = opts.timeRange ?? null;
    const cutoff = timeRange?.from ? Date.parse(timeRange.from) : null;
    const t = await this.table('insights');
    const out = [];
    for (const [, rec] of t.entries()) {
      if (rec.supersededBy && opts.includeSuperseded !== true) continue;
      if (rec.linkPending === true && opts.includePending !== true) continue;
      if (opts.type && rec.type !== opts.type) continue;
      if (keyword && !rec.content.toLowerCase().includes(keyword)) continue;
      if (cutoff !== null && Number.isFinite(cutoff)) {
        const at = Date.parse(rec.source?.checkpointRef?.extractedAt ?? '');
        if (!Number.isFinite(at) || at < cutoff) continue;
      }
      out.push({ ...rec });
    }
    out.sort((a, b) => String(b.source?.checkpointRef?.extractedAt ?? '').localeCompare(String(a.source?.checkpointRef?.extractedAt ?? '')));
    return out.slice(0, limit);
  }

  // ── FROZEN Service 4：recall（高层恢复，全程只读）────────────────────────

  async recall(opts = {}) {
    const cfg = this.cfg();
    const hits = await this.search({ ...opts, limit: opts.limit ?? 20 });
    const countersDelta = {};
    if (hits.length > 0) {
      countersDelta.recallHits = 1;
      const t = await this.table('insights');
      for (const h of hits) {
        // recallCount 是价值审计指标（§6.3）：运行 4 周若 ≈0 周报如实说
        const cur = t.get(h.id);
        if (cur) await t.put(h.id, { ...cur, recallCount: (cur.recallCount ?? 0) + 1, lastRecalledAt: nowIso() });
      }
    }

    // 下钻 raw（Q4 双通道②）：洞察 miss → 检查点原文回溯
    let rawRefs = null;
    if (hits.length === 0 && cfg.fallbackEnabled !== false) {
      rawRefs = await this.rawRefsFor(opts);
      if (!rawRefs || rawRefs.length === 0) countersDelta.recallMisses = 1;
    } else if (hits.length === 0) {
      countersDelta.recallMisses = 1;
    }

    if (Object.keys(countersDelta).length > 0) await this.bumpCounters(countersDelta).catch(() => {});

    const status = hits.length > 0 ? 'HIT' : (rawRefs && rawRefs.length > 0 ? 'RAW_REF_ONLY' : 'MISS');
    return { insights: hits, rawRefs, status };
  }

  /** 洞察 miss 时的检查点原文下钻（host-compaction → 会话文件；p1 → 引用） */
  async rawRefsFor(opts) {
    const query = String(opts.query ?? opts.keyword ?? '').toLowerCase().trim();
    const t = await this.table('guard_log');
    const refs = [];
    // 最近 20 条 host-compaction 记录回溯会话原文
    const logs = [...t.entries()]
      .map(([, v]) => v)
      .filter((v) => v.checkpointRef?.kind === 'host-compaction' && v.checkpointRef?.id)
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .slice(0, 20);
    if (logs.length === 0) {
      // p1-checkpoint 引用：raw 表归 P1-1 管（跨域只读引用，不复制）
      const p1 = [...t.entries()]
        .map(([, v]) => v)
        .filter((v) => v.checkpointRef?.kind === 'p1-checkpoint' && v.checkpointRef?.id)
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
        .slice(0, 5);
      return p1.map((v) => ({
        kind: 'p1-checkpoint', id: v.checkpointRef.id,
        note: 'raw 原文在 P1-1 pre_compress_checkpoints 表（本插件只读引用，不复制）',
      }));
    }
    const { findShadowedMessages } = await import('./session-reader.js');
    const cfg = this.cfg();
    for (const log of logs) {
      const ref = { kind: 'host-compaction', id: log.checkpointRef.id };
      try {
        const found = await findShadowedMessages({
          shadowedSeqs: log.shadowedSeqs ?? [],
          sessionId: log.sessionId ?? undefined,
          sessionsRoot: cfg.sessionsRoot,
        });
        const matched = query
          ? found.filter((f) => JSON.stringify(f.record).toLowerCase().includes(query))
          : found;
        if (matched.length > 0) {
          refs.push({ ...ref, messages: matched.map((m) => m.record) });
        }
      } catch (e) {
        this.debug(`[engine] 会话回溯失败 (${log.checkpointRef.id}): ${e?.message ?? e}`);
      }
    }
    return refs;
  }

  // ── FROZEN Service 5：stats（周报消费）──────────────────────────────────

  async stats() {
    const counters = await this.getCounters();
    const insightsT = await this.table('insights').catch(() => null);
    const logT = await this.table('guard_log').catch(() => null);

    const byType = { decision: 0, fact: 0, preference: 0 };
    let supersededCount = 0;
    let pendingInsights = 0;
    if (insightsT) {
      for (const [, r] of insightsT.entries()) {
        if (r.supersededBy) { supersededCount += 1; continue; }
        if (r.linkPending === true) { pendingInsights += 1; continue; }
        if (byType[r.type] !== undefined) byType[r.type] += 1;
      }
    }

    const byStatus = { PASSED: 0, DEGRADED_INSIGHT: 0, BLOCKED_CHECKPOINT: 0, NO_SOURCE_REACHED: 0 };
    const tierCounts = { A: 0, B: 0, C: 0 };
    if (logT) {
      for (const [, r] of logT.entries()) {
        if (byStatus[r.status] !== undefined) byStatus[r.status] += 1;
        if (tierCounts[r.tier] !== undefined) tierCounts[r.tier] += 1;
      }
    }

    const recallTotal = counters.recallHits + counters.recallMisses;
    const recallHitRate = recallTotal === 0 ? 0 : counters.recallHits / recallTotal;
    const totalSource = counters.p1CheckpointsSeen + counters.hostCompactionsSeen;
    const noSourceReached = totalSource === 0;

    return {
      // 不变量 6「零数据必须响」：双源合计 0 条 → 显式状态，禁止静默空图
      status: noSourceReached ? 'NO_SOURCE_REACHED' : 'OK',
      noSourceReached,
      byType,
      byStatus,
      recallHitRate,
      counters,
      coverage: {
        insights: insightsT ? insightsT.size - supersededCount - pendingInsights : 0,
        pendingInsights,
        supersededCount,
        guardLogs: logT ? logT.size : 0,
      },
      // 接线档位显式登记（验收项）
      tiers: { counts: tierCounts, active: 'B+C', note: 'A 档已移出设计（§5.3），本插件永不产出 tier=A' },
      sourceHealth: {
        p1CheckpointsSeen: counters.p1CheckpointsSeen,
        hostCompactionsSeen: counters.hostCompactionsSeen,
      },
      config: { ...this.cfg() },
      recovery: {
        consecutiveWriteFailures: this.consecutiveWriteFailures,
        degradedSince: this.degradedSince ? new Date(this.degradedSince).toISOString() : null,
        shadowMode: this.cfg().shadowMode,
      },
    };
  }

  // ── FROZEN Service 6：setEnabled（全局熔断）─────────────────────────────

  async setEnabled(enabled) {
    const v = enabled === true;
    const t = await this.table('config');
    const existing = t.get('config');
    const entry = packConfig({
      enabled: v,
      shadowMode: existing?.shadowMode ?? this.cfg().shadowMode,
      llmExtractEnabled: existing?.llmExtractEnabled ?? false,
      maxInsightsPerCompress: existing?.maxInsightsPerCompress ?? this.cfg().maxInsightsPerCompress,
      fallbackEnabled: existing?.fallbackEnabled ?? this.cfg().fallbackEnabled,
    }, existing);
    await t.put(entry.id, entry);
    this.runtimeOverrides.enabled = v;
    this.debug(`[engine] setEnabled(${v})`);
    return { ok: true, enabled: v };
  }

  /** 非 FROZEN（§4.2）：Q1 开关。LLM 提炼 v0.1 未实现，显式拒绝（真实 > 讨好）。 */
  async setLlmExtract(enabled) {
    if (enabled === true) {
      throw new Error('setLlmExtract(true): LLM 提炼未实现（设计稿 Q1 默认关，Sprint 21 拍板后启用）');
    }
    const t = await this.table('config');
    const existing = t.get('config');
    const entry = packConfig({
      enabled: existing?.enabled ?? this.cfg().enabled,
      shadowMode: existing?.shadowMode ?? this.cfg().shadowMode,
      llmExtractEnabled: false,
      maxInsightsPerCompress: existing?.maxInsightsPerCompress ?? this.cfg().maxInsightsPerCompress,
      fallbackEnabled: existing?.fallbackEnabled ?? this.cfg().fallbackEnabled,
    }, existing);
    await t.put(entry.id, entry);
    this.runtimeOverrides.llmExtractEnabled = false;
    return { ok: true, llmExtractEnabled: false };
  }

  /** 非 FROZEN（§4.2）：规则升级后离线补录。v0.1 显式未实现（Sprint 21）。 */
  async reindex() {
    throw new Error('reindex: 未实现（设计稿 §4.2 观察期转正项，Sprint 21 交付）');
  }
}

/** 消息列表 → 提取源文本 */
function flattenMessages(messages) {
  if (!Array.isArray(messages)) return '';
  return messages
    .map((m) => (typeof m === 'string' ? m : String(m?.content ?? '')))
    .join('\n');
}

export { withTimeout, datedId, GUARD_TIERS };
