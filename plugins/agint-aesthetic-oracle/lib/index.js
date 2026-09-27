/**
 * agint-aesthetic-oracle — 美的神谕层 v0.1.0（Day 1：薄骨架 + daily 跑通）。
 *
 * 定位（v2.3 方案 §2，方案 C）：agint-metrics 之上的薄评论员——读仪表（只消费
 * summary()/series()），下判断（评分纯函数 + 美之三问），按节奏开口（三档 cron
 * 广播）。**零直连域 service**：除 metrics 外一切服务（evolution 审计 / eventBus
 * 发布）都是写白名单出口，且全部懒解析 + 软失败。
 *
 * 写白名单（§9.1，仅此三处，缺一即违宪）：
 *   1. evolution_log   经 agint.evolution.logPhase4，targetKind=oracle-*（审计）
 *   2. oracle_broadcasts / oracle_state / oracle_cards —— 本插件自己的存储域（状态面）
 *   3. agint_evolve.proposal（Day 4-5）—— weekly 美谕提案，**只经 evolve.propose()**
 *      写入；status 由 evolve 侧硬锁 'proposed'（本文件 307 行），oracle 永不调
 *      setStatus ⇒ 提案永不 auto-apply（§5：归档/合并由老板定夺后走执行层门禁，
 *      oracle 是观察者，不自己动手改自己读的数——观察者污染 P0-3 的对偶纪律）
 *
 * 回滚与自保（§6.2/§6.3/§6.4）：
 *   - 重试：调度入口 runScheduled 内 3 次重试（1s/4s/16s 指数退避）
 *   - 沉默模式：连续 3 次调度失败 / 单日配额违规 ≥3 → 只写审计不开口；
 *     持续 24h → oracle.alert 一次（防重）
 *   - kill-switch：config enabled:false（或 env AGINT_AESTHETIC_ORACLE=off）→
 *     **不 provide 服务** ⇒ agint-cron 的 3 个 oracle job soft-skip（§6.4：
 *     不碰任何其他插件的管线）；运行时 pause/resume 落 oracle_state（老板
 *     oracle_pause 语义），由本服务自身拦截
 *
 * 红线自查（§9.4）：不往 METRIC_DEFS 塞复合指标（noise_ratio / aesthetic_score
 * 只活在本插件）；对 metrics 无特权——summary()/series() 的普通消费者。
 *
 * Loader row（cordis.patch.yml）：
 *   - id: agint-aesthetic-oracle
 *     name: ./plugins/agint-aesthetic-oracle/lib/index.js
 *     config: {}
 */

import {
  openStore, loadState, randomId, nowIso,
  oracleBroadcastSchema,
} from './storage.js';
import { evaluateAesthetics, DIM_KEYS } from './scoring.js';
import {
  extractAtomic, renderReport, rollQuota, dimsFromRecord, compositesRecord,
  auditScores, auditTargetId, buildWeeklyProposals, isoWeekKey, KIND_TOPIC, QUOTA_LIMITS,
} from './broadcast.js';
import { validateTopicPayload, TOPIC_KIND } from './topics.js';

const name = 'agint-aesthetic-oracle';
// 硬注入仅 storageDomain（自己的状态面）；其余全懒解析——apply 顺序不保证，
// metrics / evolution / eventBus 缺席都必须可降级（§6.1：任一来源失败不阻断）。
const inject = ['storageDomain'];

const KINDS = ['daily', 'weekly', 'monthly', 'alert'];
const SILENCE_ALERT_AFTER_MS = 24 * 60 * 60 * 1000; // §6.2：沉默 24h → alert 一次
const RETRY_DELAYS_MS = [0, 1000, 4000, 16000];     // §6.2：首次 + 3 重试（指数退避）
const MAX_CONSECUTIVE_FAILURES = 3;                 // §6.3：连续 3 次 → 沉默
const MAX_DAILY_VIOLATIONS = 3;                     // §6.3：配额违规 ≥3 → 沉默 + 告警
const CACHE_MAX_AGE_MS = 7 * 86_400_000;            // §6.1：缓存回退最多信 7 天

const DEFAULT_CONFIG = Object.freeze({ enabled: true, silenceAlertAfterMs: SILENCE_ALERT_AFTER_MS });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  // kill-switch（K51 纪律：kill-switch ≠ 默认关，出厂即开；env 只做总闸）
  const envOff = String(process.env.AGINT_AESTHETIC_ORACLE || '').toLowerCase() === 'off';
  if (!cfg.enabled || envOff) return; // §6.4：不 provide ⇒ cron job soft-skip，秒级可逆

  const store = openStore(ctx);
  let disposed = false;
  ctx.effect(() => () => {
    disposed = true;
    try { dashUnsub?.(); } catch { /* ignore */ }
    try { store.close(); } catch { /* ignore */ }
  });

  // 内存兜底会异步换正表 ⇒ 每次现取，绝不缓存 table 引用。
  const tables = () => store.tables;
  const svcMetrics = () => (typeof ctx.get === 'function' ? ctx.get('agint.metrics') : null);
  const svcEvolution = () => (typeof ctx.get === 'function' ? ctx.get('agint.evolution') : null);
  const svcEvolve = () => (typeof ctx.get === 'function' ? ctx.get('agint.evolve') : null);
  const busPublish = () => (typeof ctx.get === 'function' ? ctx.get('agint.eventBus.publish') : null);

  const stats = { runs: 0, failures: 0, alertsSent: 0, silenceEntered: 0 };

  async function publishBus(topic, payload) {
    // §5 硬规则 2（Day 2-3）：payload 合同自校验——event-bus 的 FROZEN 面只管
    // envelope，payload schema「由发布方自带独立演进」（event-bus.schema.yaml
    // 第 12/64 行）。违约 payload 不发布（坏数据不进事件历史），落痕可见。
    const check = validateTopicPayload(topic, payload);
    if (!check.ok) {
      try {
        await recordBroadcast({
          kind: TOPIC_KIND[topic] ?? 'alert', outcome: 'schema-rejected',
          detail: `payload contract violation: ${check.issues}`,
        });
      } catch { /* 落痕失败不反噬 */ }
      return false;
    }
    const p = busPublish();
    if (typeof p !== 'function') return false;
    try {
      await p({ topic, version: 1, source: name, payload });
      return true;
    } catch { return false; } // §6.2：观测/发布失败不反噬主路径
  }

  /** 白名单写 #1：evolution_log 审计（decision=ABSTAIN——评论员不做部署决策）。 */
  async function auditLog({ targetId, targetKind, scores = {}, findings = [] }) {
    const evo = svcEvolution();
    if (!evo || typeof evo.logPhase4 !== 'function') return false;
    try {
      await evo.logPhase4({
        targetId, targetKind, decision: 'ABSTAIN', scores, findings,
        tags: ['aesthetic-oracle'],
      });
      return true;
    } catch { return false; }
  }

  async function recordBroadcast(row) {
    const rec = oracleBroadcastSchema.parse({ id: randomId(), ts: nowIso(), ...row });
    await tables().broadcasts.put(rec.id, rec);
    return rec;
  }

  // ── GUI dashboard 卡片订阅者（Day 2-3，方案 §5 硬规则 2 / §6.2 / P2-8）──────
  // dsh web 前端是封闭内部包，AGINT 侧不可注入 HTML 卡片 ⇒「dashboard 订阅」
  // 的 AGINT 落地 = 真实的事件订阅者（每 topic 留最新快照进 oracle_state.cards）
  // + cards() 查询面。它同时是 AC-7/7b 端到端的消费端证据：publish 出去的事件
  // 必须能被一个真实订阅者收到并持久化，否则 §5 通道就是自说自话。
  let dashUnsub = null;
  async function ensureDashboardSub() {
    if (dashUnsub) return true;
    const sub = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.subscribe') : null;
    if (typeof sub !== 'function') return false;
    try {
      dashUnsub = await sub(
        {
          subscriber: 'dashboard',
          topics: Object.values(KIND_TOPIC),
          mode: 'async',           // sync 名额留给门禁边（全局 ≤3，yaml constraints）
          reason: '',
        },
        (envelope) => { handleCardEvent(envelope); },
      );
      return true;
    } catch { dashUnsub = null; return false; } // event-bus 未挂载/订阅被拒 → 下次再试
  }

  async function handleCardEvent(envelope) {
    try {
      const t = envelope?.topic;
      if (!t || !TOPIC_KIND[t]) return;
      // 独立 cards 表（key=topic）：广播主链与订阅回写各写各的 key，
      // 不会再被主链的 quota saveState 用旧 state 快照覆盖（2026-09-27 实测竞态）。
      await tables().cards.put(t, {
        topic: t,
        envelopeId: String(envelope.id ?? ''),
        occurredAt: String(envelope.occurredAt ?? ''),
        receivedAt: nowIso(),
        payload: envelope.payload ?? null,
      });
    } catch { /* 卡片面失败不反噬主路径 */ }
  }

  async function cards() {
    return (await tables().cards.values())
      .sort((a, b) => (a.topic < b.topic ? -1 : 1));
  }

  async function saveState(next) {
    await tables().state.put('latest', { ...next, updatedAt: nowIso() });
    return next;
  }

  async function activateSilence(reason) {
    const state = await loadState(tables().state);
    if (state.silenceMode.active) return state;
    stats.silenceEntered += 1;
    return saveState({
      ...state,
      silenceMode: { active: true, since: nowIso(), reason, alerted: false },
      consecutiveFailures: 0,
    });
  }

  async function countDailyScored() {
    return (await tables().broadcasts.values())
      .filter((r) => r.kind === 'daily' && r.outcome === 'ok' && isNum(r.score)).length;
  }

  /** §3.6 基线：前 7 条有效 daily 的均值（score + 四维，na 维不计入均值）。 */
  async function maybeEstablishBaseline() {
    const state = await loadState(tables().state);
    if (state.baseline.establishedAt) return state;
    const rows = (await tables().broadcasts.values())
      .filter((r) => r.kind === 'daily' && r.outcome === 'ok' && isNum(r.score))
      .sort((a, b) => (a.ts < b.ts ? 1 : -1))
      .slice(0, 7);
    if (rows.length < 7) return state;
    const avg = (vals) => {
      const xs = vals.filter(isNum);
      return xs.length ? Math.round((xs.reduce((s, v) => s + v, 0) / xs.length) * 10000) / 10000 : null;
    };
    const composites = {};
    for (const k of DIM_KEYS) composites[k] = avg(rows.map((r) => r.composites?.[k]));
    return saveState({
      ...state,
      baseline: { establishedAt: nowIso(), score: avg(rows.map((r) => r.score)), composites },
    });
  }

  /**
   * 写白名单 #3（Day 4-5，§5 weekly）：weekly 美谕提案 → agint_evolve.proposal。
   * 提案 = 可用维按绝对扣分 top3（0 扣分不提），每条经 q3Advice 生成（纯机械
   * 动作 + 必附证据）。⭐ 只写文本不执行：永不调 curator_archive / setStatus；
   * evolve 侧 status 硬锁 proposed。失败降级不阻断广播（§6.1 原则）。
   */
  async function submitWeeklyProposals({ evaluation, adviceCtx, now, targetId }) {
    const evo = svcEvolve();
    if (!evo || typeof evo.propose !== 'function') return { ids: [], failed: 0, degraded: true };
    const drafts = buildWeeklyProposals(evaluation, adviceCtx ?? {}, { weekKey: isoWeekKey(now), targetId });
    const ids = [];
    let failed = 0;
    for (const d of drafts) {
      try {
        const rec = await evo.propose({
          title: d.title, body: d.body, category: d.category,
          source: name, note: `${targetId}（美的神谕层 weekly；evidence 见正文）`,
        });
        if (rec?.id) ids.push(rec.id); else failed += 1;
      } catch { failed += 1; }
    }
    return { ids, failed };
  }

  /**
   * 共享出口（Day 2-3 抽取）：事件 → 审计 → 自表落账 → 配额记账。
   * 主路径与缓存回退路径共用；任何一路失败都只降级不阻断。
   */
  async function finalizeBroadcast({ kind, state, quota, now, view, evaluation, report, dayIndex, extraFindings = [], extraDetail = '' }) {
    // Day 4-5：weekly 提案先行——提案 id 要进审计 findings（evidence 可追溯）
    let proposalIds = [];
    let proposalsFailed = 0;
    if (kind === 'weekly') {
      const submitted = await submitWeeklyProposals({
        evaluation, adviceCtx: view.adviceCtx, now, targetId: auditTargetId('weekly', now),
      });
      proposalIds = submitted.ids;
      proposalsFailed = submitted.failed;
    }
    const published = await publishBus(KIND_TOPIC[kind], {
      kind, asOf: view.asOf, score: evaluation.scored.score, verdict: evaluation.verdict.verdict,
      worstKey: evaluation.worst?.key ?? null, lines: report.lines, text: report.text,
      ...(isNum(report.staleDays) ? { staleDays: report.staleDays } : {}),
      ...(kind === 'weekly' ? { proposals: proposalIds.length } : {}),
    });
    // id 清单进审计 findings（§4：建议必附证据；广播正文只引用条目，防 2KB 爆）
    const findings = [...extraFindings];
    if (Array.isArray(view.auditIds) && view.auditIds.length) {
      findings.push({
        ruleId: 'oracle-no-evidence-ids', severity: 'low',
        detail: view.auditIds.slice(0, 50).join(','),
      });
    }
    if (proposalIds.length) {
      findings.push({
        ruleId: 'oracle-proposals', severity: 'low',
        detail: `agint_evolve proposal id：${proposalIds.join(',')}（status=proposed，永不 auto-apply）`,
      });
    }
    const auditLogged = await auditLog({
      targetId: auditTargetId(kind, now, kind === 'alert' ? (quota.alerts ?? 0) + 1 : null),
      targetKind: `oracle-${kind}`,
      scores: auditScores(evaluation),
      findings,
    });
    const rec = await recordBroadcast({
      kind, asOf: view.asOf, score: evaluation.scored.score, verdict: evaluation.verdict.verdict,
      worstKey: evaluation.worst?.key ?? '', composites: compositesRecord(evaluation.composites),
      lines: report.lines.length, bytes: report.bytes, published, auditLogged,
      truncated: report.truncated, outcome: 'ok',
      detail: `${extraDetail ? `${extraDetail}; ` : ''}wall ${report.wallMs}ms`,
      proposals: proposalIds.length,
    });
    // 配额计数 + 成功清失败计数（§6.3 状态面）
    const q = rollQuota(state.quota, now);
    const counterKey = kind === 'alert' ? 'alerts' : kind;
    q[counterKey] = (q[counterKey] ?? 0) + 1;
    q.bytes = (q.bytes ?? 0) + report.bytes;
    await saveState({ ...state, quota: q, consecutiveFailures: 0 });
    if (kind === 'daily') await maybeEstablishBaseline();
    return {
      ok: true, kind, id: rec.id, score: evaluation.scored.score,
      verdict: evaluation.verdict.verdict, worstKey: evaluation.worst?.key ?? null,
      lines: report.lines.length, bytes: report.bytes, truncated: report.truncated,
      asOf: view.asOf, published, auditLogged, text: report.text,
      ...(kind === 'weekly' ? { proposals: proposalIds.length, ...(proposalsFailed ? { proposalsFailed } : {}) } : {}),
      ...(isNum(report.staleDays) ? { staleDays: report.staleDays, stale: true } : {}),
    };
  }

  /**
   * 单次广播（手动 / 调度共用）。成功返回 { ok, ... }；可跳过类结果返回
   * { skipped, reason }（paused / silence / quota / disposed）；数据面失败
   * **抛错**（交 runScheduled 重试），但失败已先落 oracle_broadcasts 痕。
   *
   * 数据面三分支（Day 2-3）：
   *   a. alert —— 不碰 metrics（§6.1：警报通道不能被数据源挂掉绑架）
   *   b. 主路径 —— summary() 可用 → 评分 → finalize；成功后写 lastGood 缓存
   *   c. 缓存回退 —— summary() 挂但 lastGood ≤7 天 → 用缓存评分照发（stale 标注）
   */
  async function runBroadcast(kind, opts = {}) {
    if (disposed) return { skipped: true, reason: 'disposed' };
    if (!KINDS.includes(kind)) throw new Error(`runBroadcast: bad kind '${kind}'`);
    stats.runs += 1;
    const t0 = Date.now();
    const now = opts.now ?? new Date();
    let state = await loadState(tables().state);

    // dashboard 订阅懒补挂（event-bus 晚于 oracle 挂载时逐次重试；不 await 主链）
    ensureDashboardSub().catch(() => {});

    // 运行时 kill-switch（老板 oracle_pause；§6.3 第 4 行）
    if (state.paused) {
      await recordBroadcast({ kind, outcome: 'skipped', detail: `paused: ${state.pausedReason || 'oracle_pause'}` });
      return { skipped: true, reason: 'paused' };
    }

    // 沉默模式（§6.2）：只写审计不开口；持续 24h → oracle.alert 一次（防重）。
    // silenceAlertAfterMs 是运维旋钮（默认 24h；演练/测试可调短）——只调告警时机，
    // 不改「连续 3 次失败进沉默」的进沉默条件。
    const silenceAfterMs = isNum(cfg.silenceAlertAfterMs) ? cfg.silenceAlertAfterMs : SILENCE_ALERT_AFTER_MS;
    if (state.silenceMode.active) {
      const sinceMs = state.silenceMode.since ? Date.now() - new Date(state.silenceMode.since).getTime() : 0;
      if (sinceMs >= silenceAfterMs && !state.silenceMode.alerted) {
        const published = await publishBus(KIND_TOPIC.alert, {
          reason: `神谕层沉默模式已持续 24h（${state.silenceMode.reason}）——请检查 metrics/cron 健康`,
          since: state.silenceMode.since,
        });
        if (published) stats.alertsSent += 1;
        await recordBroadcast({ kind: 'alert', outcome: 'ok', detail: 'silence-24h-alert', published });
        state = await saveState({ ...state, silenceMode: { ...state.silenceMode, alerted: true } });
      }
      await auditLog({
        targetId: `${auditTargetId(kind, now)}-silenced`,
        targetKind: `oracle-${kind}`,
        findings: [{ ruleId: 'oracle-silence', severity: 'low', detail: state.silenceMode.reason }],
      });
      await recordBroadcast({ kind, outcome: 'silenced', detail: state.silenceMode.reason });
      return { skipped: true, reason: 'silence-mode' };
    }

    // 配额护栏（§5.4/§9.3）：周期滚动 + 违规计数；alert 走独立日配额
    let quota = rollQuota(state.quota, now);
    const counterKey = kind === 'alert' ? 'alerts' : kind;
    if ((quota[counterKey] ?? 0) >= QUOTA_LIMITS[kind]) {
      if (kind === 'alert') {
        await recordBroadcast({ kind, outcome: 'dropped-quota', detail: 'alert 日配额已满（3）' });
        return { skipped: true, reason: 'quota' };
      }
      quota = { ...quota, violations: (quota.violations ?? 0) + 1 };
      await saveState({ ...state, quota });
      await recordBroadcast({
        kind, outcome: 'dropped-quota',
        detail: `${kind} 配额 ${QUOTA_LIMITS[kind]} 已满（violation ${quota.violations}/${MAX_DAILY_VIOLATIONS}）`,
      });
      if (quota.violations >= MAX_DAILY_VIOLATIONS) {
        // §6.3：先告警后沉默（沉默会拦住后续一切出口，alert 必须抢在前面）
        const published = await publishBus(KIND_TOPIC.alert, {
          reason: `神谕层单日配额违规 ≥${MAX_DAILY_VIOLATIONS} 次 → 自动沉默`,
          violations: quota.violations,
        });
        if (published) stats.alertsSent += 1;
        await recordBroadcast({ kind: 'alert', outcome: 'ok', detail: 'quota-violation-alert', published });
        await activateSilence(`单日配额违规 ≥${MAX_DAILY_VIOLATIONS}`);
      }
      return { skipped: true, reason: 'quota' };
    }
    state = await saveState({ ...state, quota }); // 落滚动后的配额面

    // ── 分支 a：alert 直发（不依赖 metrics；渲染即发） ────────────────────────
    if (kind === 'alert') {
      const report = renderReport('alert', { now, reason: opts.reason, detail: opts.detail });
      report.wallMs = Date.now() - t0;
      const view = { asOf: '', auditIds: null };
      const evaluation = { scored: { score: null }, verdict: { verdict: 'flat' }, worst: null, composites: {} };
      return finalizeBroadcast({ kind, state, quota, now, view, evaluation, report, extraDetail: opts.detail ? `alert: ${opts.detail}` : 'alert' });
    }

    // ── 分支 b/c：daily / weekly / monthly（主路径 + 缓存回退）───────────────
    const metrics = svcMetrics();
    let summary = null;
    let summaryError = null;
    try {
      if (!metrics || typeof metrics.summary !== 'function') throw new Error('agint.metrics.summary unavailable');
      summary = await metrics.summary();
      if (!summary || !Array.isArray(summary.metrics) || summary.metrics.length === 0) {
        throw new Error('metrics summary empty');
      }
    } catch (err) {
      summaryError = err;
    }

    if (summaryError) {
      // 分支 c：§6.1 缓存回退——⛔ 不用 metrics.series()：它与 summary() 同表同
      // 命运，真正可回退的只有神谕层自己落盘的 lastGood 快照（最多信 7 天）。
      const cached = state.lastGood;
      const cachedAge = cached?.savedAt ? Date.now() - new Date(cached.savedAt).getTime() : Infinity;
      const cacheFresh = Number.isFinite(cachedAge) && cachedAge <= CACHE_MAX_AGE_MS;
      const cacheUsable = cacheFresh && cached.atomic && Object.keys(cached.atomic).length > 0;
      if (cacheUsable) {
        const staleDays = Math.floor(cachedAge / 86_400_000);
        const view = {
          asOf: cached.asOf, atomic: cached.atomic, adviceCtx: cached.adviceCtx ?? {},
          auditIds: null, activity: cached.activity ?? null,
        };
        const dayIndex = kind === 'daily' && !state.baseline.establishedAt
          ? (await countDailyScored()) + 1 : null;
        const baselineDims = state.baseline.establishedAt
          ? dimsFromRecord(state.baseline.composites) : null;
        const evaluation = evaluateAesthetics(view.atomic, { baseline: baselineDims, adviceCtx: view.adviceCtx });
        const report = renderReport(kind, {
          now, asOf: view.asOf, evaluation, atomic: view.atomic, activity: view.activity,
          baseline: { established: Boolean(state.baseline.establishedAt), score: state.baseline.score },
          dayIndex, staleDays, reason: opts.reason, detail: opts.detail,
        });
        report.wallMs = Date.now() - t0;
        report.staleDays = staleDays; // finalizeBroadcast 靠它把 staleDays 写进 payload 与返回值
        return finalizeBroadcast({
          kind, state, quota, now, view, evaluation, report, dayIndex,
          extraFindings: [{
            ruleId: 'oracle-stale-cache', severity: 'low',
            detail: `metrics summary 不可用（${String(summaryError?.message ?? summaryError)}），改用 ${Math.floor(cachedAge / 3_600_000)}h 前缓存广播`,
          }],
          extraDetail: `stale-cache-${staleDays}d`,
        });
      }
      // 无可用缓存 → 原路径：落痕 + oracle.alert（末次重试才发，防风暴）+ 抛错
      await recordBroadcast({ kind, outcome: 'error', detail: `summary-unavailable: ${summaryError?.message ?? summaryError}` });
      if (kind !== 'alert' && !opts.suppressAlert) {
        const published = await publishBus(KIND_TOPIC.alert, {
          reason: `metrics summary 不可用且无可用缓存（>7 天或首次），跳过本次 ${kind} 广播`,
          error: String(summaryError?.message ?? summaryError),
        });
        if (published) stats.alertsSent += 1;
      }
      throw summaryError;
    }

    // 分支 b：主路径——评分 + 三问（纯函数；缺 key → N/A + 权重归一，AC-4）
    const view = extractAtomic(summary);
    const dayIndex = kind === 'daily' && !state.baseline.establishedAt
      ? (await countDailyScored()) + 1 : null;
    const baselineDims = state.baseline.establishedAt
      ? dimsFromRecord(state.baseline.composites) : null;
    const evaluation = evaluateAesthetics(view.atomic, { baseline: baselineDims, adviceCtx: view.adviceCtx });

    const report = renderReport(kind, {
      now, asOf: view.asOf, evaluation, atomic: view.atomic, activity: view.activity,
      baseline: { established: Boolean(state.baseline.establishedAt), score: state.baseline.score },
      dayIndex, reason: opts.reason, detail: opts.detail,
    });
    report.wallMs = Date.now() - t0;
    const out = await finalizeBroadcast({ kind, state, quota, now, view, evaluation, report, dayIndex });

    // 成功后写 lastGood 缓存（§6.1 回退面；缓存的是本轮真实采集，供下次 metrics 挂掉时用）
    const latest = await loadState(tables().state);
    await saveState({
      ...latest,
      lastGood: {
        asOf: view.asOf, atomic: view.atomic, adviceCtx: view.adviceCtx ?? {},
        activity: view.activity ?? null, savedAt: nowIso(),
      },
    });
    return out;
  }

  /** 调度入口（agint-cron 的 3 个 oracle job 走这里）：重试 + 连续失败记账。
   *  opts.retryDelays 可注入（测试用）；中间次失败 suppressAlert，只在最后一试
   *  发 oracle.alert —— 重试期不发，防告警风暴（§5.4 同源纪律）。 */
  async function runScheduled(kind, opts = {}) {
    const delays = Array.isArray(opts.retryDelays) && opts.retryDelays.length
      ? opts.retryDelays : RETRY_DELAYS_MS;
    let lastErr = null;
    for (let i = 0; i < delays.length; i += 1) {
      if (i > 0) {
        if (disposed) return { skipped: true, reason: 'disposed' };
        await sleep(delays[i]);
        if (disposed) return { skipped: true, reason: 'disposed' };
      }
      try {
        const out = await runBroadcast(kind, {
          via: 'cron', attempt: i + 1, suppressAlert: i < delays.length - 1,
        });
        if (out?.skipped) return out; // paused/silence/quota：不重试不计数
        return out;
      } catch (err) { lastErr = err; }
    }
    // 全部重试失败 → §6.3 第 1 行：连续 3 次 → 沉默模式（跨重启持久）
    const state = await loadState(tables().state);
    const failures = state.consecutiveFailures + 1;
    stats.failures += 1;
    await saveState({ ...state, consecutiveFailures: failures });
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      await activateSilence(`连续 ${failures} 次调度执行失败（last: ${lastErr?.message ?? lastErr}）`);
    }
    throw lastErr; // cron 记 lastError（可见的失败 > 静默的成功）
  }

  /** 告警出口（程序化；oracle.alert 通道。绕过沉默但尊重 kill-switch 与日配额）。 */
  async function alert(reason, detail = '') {
    return runBroadcast('alert', { reason, detail });
  }

  async function pause(reason = 'oracle_pause') {
    const state = await loadState(tables().state);
    return saveState({ ...state, paused: true, pausedReason: reason, pausedAt: nowIso() });
  }

  async function resume() {
    const state = await loadState(tables().state);
    // resume = 一键恢复：清 pause + 沉默 + 失败计数（基线与配额不动）
    return saveState({
      ...state, paused: false, pausedReason: '', pausedAt: null,
      silenceMode: { active: false, since: null, reason: '', alerted: false },
      consecutiveFailures: 0,
    });
  }

  async function getState() { return loadState(tables().state); }

  function status() {
    return {
      name, enabled: cfg.enabled, envOff, disposed, memoryStore: store._memory,
      metricsAvailable: Boolean(svcMetrics()),
      evolutionAvailable: Boolean(svcEvolution()),
      busAvailable: typeof busPublish() === 'function',
      kinds: KINDS.slice(), quotas: QUOTA_LIMITS, stats: { ...stats },
    };
  }

  async function history(limit = 20) {
    return (await tables().broadcasts.values())
      .sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit);
  }

  ctx.provide('agint.aestheticOracle', {
    runBroadcast, runScheduled, alert, pause, resume, getState, status, history, cards,
  });

  // 首次订阅尝试（event-bus 已挂载时立即生效；未挂载由 runBroadcast 懒重试兜住）
  ensureDashboardSub().catch(() => { /* 懒重试兜住 */ });
}

export { name, inject, apply, DEFAULT_CONFIG };
