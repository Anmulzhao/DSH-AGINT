/**
 * agint-input-gateway — Gateway 核心逻辑。
 *
 * 职责：注册 Channel → 定时/手动 fetch → 过滤去重配额 → 归一化 → 路由发布到 eventBus。
 *
 * 不做什么：
 *   - 不自己采集数据（Channel 负责）
 *   - 不自己消费信号（memory/evolve/dream 通过 eventBus subscribe 消费）
 *   - 不新建定时器机制（用 setInterval + ctx.effect dispose）
 *   - 不修改任何现有插件状态
 */

import { randomUUID } from 'node:crypto';
import {
  PLUGIN_NAME,
  CHANNEL_TYPES,
  TOPIC_PREFIX,
  DEFAULT_QUOTAS,
  DEFAULTS,
} from './schema.js';
import {
  emptyCounters, packCounters, emptyChannelState, packDedup,
} from './storage.js';
import { checkSignal, getSecurityRules } from './security.js';

// security 门禁检查范围：外部来源信号（外部世界 / 对抗 / 跨 Agent）。
// 内部通道（self-observation）与 human 不检 —— 它们不是"外部信号"。
const SECURITY_CHECKED_TYPES = new Set([
  CHANNEL_TYPES.EXTERNAL,
  CHANNEL_TYPES.ADVERSARIAL,
  CHANNEL_TYPES.CROSS_AGENT,
]);

export class InputGateway {
  /**
   * @param {object} deps
   * @param {Function} deps.table — storage table getter: (name) => Table
   * @param {Function} deps.getPublish — () => publishFn|null
   * @param {object} deps.config — 全局配置（从 storage 加载）
   * @param {Function} deps.debug — debug logger
   * @param {Function} deps.now — () => number (epoch ms)，可注入测试
   */
  constructor({ table, getPublish, config, debug, now = () => Date.now() }) {
    this._table = table;
    this._getPublish = getPublish;
    this._config = config;
    this._debug = debug || (() => {});
    this._now = now;

    /** @type {Map<string, object>} channelId → channel instance */
    this._channels = new Map();
    /** @type {Map<string, object>} channelId → runtime state（内存态，持久化到 channel_state 表） */
    this._channelState = new Map();
    /** @type {Map<string, object>} channelId → counters（内存态，持久化到 counters 表） */
    this._counters = new Map();
    /** @type {Map<string, number>} dedupKey → expiry epoch ms */
    this._dedup = new Map();
    /** @type {Map<string, Map<string, number>>} channelId → Map<source:signalType, countInWindow> */
    this._noise = new Map();

    // security 门禁动作（flag=标记放行 / drop=丢弃 / off=不检测）
    this._securityAction = config?.securityAction ?? DEFAULTS.securityAction;
  }

  // ── Channel 注册 ────────────────────────────────────────────────────────

  registerChannel(channel) {
    if (!channel || typeof channel.id !== 'string' || typeof channel.fetch !== 'function') {
      throw new Error('registerChannel: channel must have id and fetch(ctx)');
    }
    if (this._channels.has(channel.id)) {
      this._debug(`channel ${channel.id} already registered, overwriting`);
    }
    this._channels.set(channel.id, channel);

    // 初始化内存态（如果 storage 里有则加载）
    if (!this._channelState.has(channel.id)) {
      this._channelState.set(channel.id, emptyChannelState(
        channel.id,
        channel.type || CHANNEL_TYPES.SELF_OBSERVATION,
      ));
    }
    if (!this._counters.has(channel.id)) {
      this._counters.set(channel.id, emptyCounters(channel.id));
    }
    this._debug(`channel registered: ${channel.id} (type=${channel.type})`);
  }

  // ── 调度：定时检查 ─────────────────────────────────────────────────────

  /**
   * 启动定时调度。返回 disposer。
   * @param {object} cronExprs — { channelId: 'm h dom mon dow' }
   */
  startScheduler(cronExprs) {
    this._nextFetch = new Map();
    for (const [channelId, expr] of Object.entries(cronExprs || {})) {
      this._nextFetch.set(channelId, this._computeNextCron(expr));
    }

    this._timer = setInterval(() => {
      void this._tick();
    }, DEFAULTS.cronCheckIntervalMs);
    // unref 不阻止进程退出
    if (typeof this._timer.unref === 'function') this._timer.unref();

    return () => {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
    };
  }

  /**
   * 计算下一次 fetch 时间。
   * 支持格式: "m h * * dow"，dow=-1/缺省 = 每天，dow=0 = 周日。
   */
  _computeNextCron(expr) {
    const parts = String(expr || '').trim().split(/\s+/);
    const minute = parseInt(parts[0] || '0', 10);
    const hour = parseInt(parts[1] || '2', 10);
    const dow = parts[4] ? parseInt(parts[4], 10) : -1; // -1 = 每天
    const now = new Date(this._now());
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);

    if (dow >= 0 && !Number.isNaN(dow)) {
      // 每周模式：找到下一个匹配 dow 的日期
      // JavaScript: 0=周日, 1=周一, ..., 6=周六（与 cron 一致）
      let daysAhead = (dow - next.getDay() + 7) % 7;
      if (daysAhead === 0 && next.getTime() <= now.getTime()) {
        daysAhead = 7; // 今天已过，等下周
      }
      if (daysAhead > 0) {
        next.setDate(next.getDate() + daysAhead);
      }
    } else {
      // 每日模式
      if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
      }
    }
    return next.getTime();
  }

  async _tick() {
    const now = this._now();
    for (const [channelId, nextAt] of this._nextFetch) {
      if (now >= nextAt) {
        const state = this._channelState.get(channelId);
        if (state && state.enabled) {
          this._debug(`scheduler: auto fetch ${channelId}`);
          await this.fetchChannel(channelId, { auto: true });
        }
        // 计算下一次
        const channel = this._channels.get(channelId);
        if (channel && channel.cron) {
          this._nextFetch.set(channelId, this._computeNextCron(channel.cron));
        }
      }
    }
    // 清理过期 dedup
    for (const [key, expiry] of this._dedup) {
      if (now > expiry) this._dedup.delete(key);
    }
  }

  // ── 手动/强制 fetch ──────────────────────────────────────────────────────

  async forceFetch(channelId) {
    if (!this._channels.has(channelId)) {
      throw new Error(`channel not found: ${channelId}`);
    }
    return this.fetchChannel(channelId, { force: true });
  }

  async fetchAll() {
    const results = {};
    for (const channelId of this._channels.keys()) {
      results[channelId] = await this.fetchChannel(channelId, { force: true });
    }
    return results;
  }

  async fetchChannel(channelId, opts = {}) {
    const channel = this._channels.get(channelId);
    if (!channel) return { ok: false, error: 'not found' };

    const state = this._channelState.get(channelId);
    if (!opts.force && !opts.auto && state && !state.enabled) {
      return { ok: false, error: 'channel disabled' };
    }
    if (opts.auto && state && !state.enabled) {
      return { ok: false, skipped: 'disabled' };
    }

    const startedAt = this._now();
    const counters = this._counters.get(channelId) || emptyCounters(channelId);
    counters.fetchCount += 1;

    let signals;
    try {
      // 超时保护
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`fetch timeout after ${DEFAULTS.fetchTimeoutMs}ms`)),
          DEFAULTS.fetchTimeoutMs));
      signals = await Promise.race([
        Promise.resolve(channel.fetch(this._channelCtx(channelId))),
        timeout,
      ]);
      if (!Array.isArray(signals)) signals = [];
    } catch (e) {
      counters.errorCount += 1;
      state.lastError = e.message || String(e);
      state.lastFetchAt = new Date(startedAt).toISOString();
      state.lastFetchDurationMs = this._now() - startedAt;
      counters.lastFetchAt = state.lastFetchAt;
      this._counters.set(channelId, counters);
      this._channelState.set(channelId, state);
      await this._persistCounters(channelId, counters);
      await this._persistChannelState(channelId, state);
      this._debug(`fetch ${channelId} error: ${state.lastError}`);
      return { ok: false, error: state.lastError, signals: 0 };
    }

    state.lastFetchAt = new Date(startedAt).toISOString();
    state.lastFetchDurationMs = this._now() - startedAt;
    state.lastError = null;
    counters.lastFetchAt = state.lastFetchAt;

    // 处理信号（过滤/去重/配额/路由/发布）
    const result = this.processSignals(signals, channel);

    counters.signalsEmitted += result.emitted;
    counters.signalsFiltered += result.filtered;
    counters.signalsDeduplicated += result.deduplicated;
    counters.securityScanned += result.securityScanned ?? 0;
    counters.securityFlagged += result.securityFlagged ?? 0;
    counters.securityDropped += result.securityDropped ?? 0;
    this._counters.set(channelId, counters);
    this._channelState.set(channelId, state);

    // 持久化 counters 和 channel_state（lastFetchAt 不能只在内存）
    await this._persistCounters(channelId, counters);
    await this._persistChannelState(channelId, state);

    this._debug(`fetch ${channelId}: in=${signals.length} emitted=${result.emitted} filtered=${result.filtered} dedup=${result.deduplicated}`);
    return { ok: true, in: signals.length, ...result };
  }

  _channelCtx(channelId) {
    // Channel 需要的 ctx 最小集。后续按需扩展。
    return {
      channelId,
      debug: this._debug,
    };
  }

  // ── 信号处理流水线 ──────────────────────────────────────────────────────

  /**
   * @param {Array} rawSignals — Channel 产出的 InputSignal[]
   * @param {object} channel — channel instance
   */
  processSignals(rawSignals, channel) {
    let emitted = 0, filtered = 0, deduplicated = 0;
    let securityScanned = 0, securityFlagged = 0, securityDropped = 0;
    const now = this._now();
    const state = this._channelState.get(channel.id);
    const quota = (state?.quotaOverride != null)
      ? state.quotaOverride
      : (DEFAULT_QUOTAS[channel.type] ?? 20);
    let quotaUsed = 0;

    for (const sig of rawSignals) {
      // 1. 基本校验
      if (!sig || !sig.signalId || !sig.signalType) { filtered++; continue; }

      // 2. payload 大小截断
      sig.payload = this._truncatePayload(sig.payload);

      // 2.5 security 门禁（v0.3.0）：外部信号 prompt injection 检查。
      //   action=flag（默认）：命中标记 security 元数据后放行；
      //   action=drop：命中即丢弃；action=off：跳过本步。
      if (this._securityAction !== 'off' && SECURITY_CHECKED_TYPES.has(channel.type)) {
        securityScanned += 1;
        const sec = checkSignal(sig);
        if (sec.verdict === 'flagged') {
          securityFlagged += 1;
          if (this._securityAction === 'drop') {
            securityDropped += 1;
            filtered += 1;
            continue;
          }
          const rules = sec.matches.map((m) => m.ruleId);
          const labels = sec.matches.map((m) => m.label);
          if (sig.payload && typeof sig.payload === 'object') {
            sig.payload.security = { verdict: 'flagged', rules, labels };
          } else {
            sig.security = { verdict: 'flagged', rules, labels };
          }
        }
      }

      // 3. 置信度过滤
      const conf = Number(sig.confidence ?? 0.5);
      if (conf < this._config.confidenceThreshold) { filtered++; continue; }

      // 4. 去重
      const dedupKey = `${channel.id}:${sig.signalId}`;
      if (this._dedup.has(dedupKey)) { deduplicated++; continue; }
      this._dedup.set(dedupKey, now + DEFAULTS.dedupWindowMs);

      // 5. 噪声抑制（同 source+signalType 在窗口内限流）
      const noiseKey = `${sig.source || 'unknown'}:${sig.signalType}`;
      let noiseMap = this._noise.get(channel.id);
      if (!noiseMap) { noiseMap = new Map(); this._noise.set(channel.id, noiseMap); }
      const noiseCount = noiseMap.get(noiseKey) || 0;
      if (noiseCount >= DEFAULTS.noiseMaxPerSource) { filtered++; continue; }
      noiseMap.set(noiseKey, noiseCount + 1);

      // 6. 配额
      if (quotaUsed >= quota) { filtered++; continue; }

      // 7. 构建 topic 并发布
      const topic = this._buildTopic(channel, sig);
      const published = this._publish(topic, channel, sig);
      if (published) { emitted++; quotaUsed++; } else { filtered++; }
    }

    return {
      emitted, filtered, deduplicated, quotaUsed, quota,
      securityScanned, securityFlagged, securityDropped,
    };
  }

  _buildTopic(channel, sig) {
    // input.signal.<channelType>.<signalType with dots→hyphens>
    const st = String(sig.signalType).replace(/\./g, '-').replace(/[^a-z0-9-]/gi, '');
    return `${TOPIC_PREFIX}.${channel.type}.${st}`;
  }

  _truncatePayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    try {
      const s = JSON.stringify(payload);
      if (s.length <= DEFAULTS.payloadMaxBytes) return payload;
      // 截断：保留 metadata + 摘要
      return {
        __truncated: true,
        originalSize: s.length,
        summary: s.slice(0, DEFAULTS.payloadMaxBytes - 100),
      };
    } catch {
      return { __nonSerializable: true };
    }
  }

  /**
   * 发布到 eventBus。检查 accepted 返回值（历史教训：不检查会静默丢弃）。
   */
  _publish(topic, channel, sig) {
    const publish = this._getPublish();
    if (typeof publish !== 'function') {
      this._debug(`eventBus unavailable, skipping publish ${topic}`);
      return false;
    }
    try {
      const result = publish({
        topic,
        version: 1,
        source: PLUGIN_NAME,
        payload: {
          signalId: sig.signalId,
          channelId: channel.id,
          channelType: channel.type,
          source: sig.source,
          signalType: sig.signalType,
          payload: sig.payload,
          confidence: sig.confidence ?? 0.5,
          relevance: sig.relevance ?? 0.5,
          occurredAt: sig.occurredAt || new Date(this._now()).toISOString(),
          rawRef: sig.rawRef,
        },
      });
      // publish 可能是 async
      Promise.resolve(result).then((r) => {
        if (r && r.accepted === false) {
          this._debug(`publish ${topic} rejected by eventBus (accepted=false): ${JSON.stringify(r)}`);
        }
      }).catch(() => {});
      return true;
    } catch (e) {
      this._debug(`publish ${topic} threw: ${e.message}`);
      return false;
    }
  }

  // ── 状态查询 ────────────────────────────────────────────────────────────

  async getStatus() {
    const channels = [];
    for (const [id, ch] of this._channels) {
      channels.push(await this.getChannelStatus(id));
    }
    return {
      gateway: PLUGIN_NAME,
      enabled: this._config.enabled,
      channelCount: channels.length,
      channels,
      config: { ...this._config },
      security: {
        action: this._securityAction,
        ruleCount: getSecurityRules().length,
        checkedTypes: [...SECURITY_CHECKED_TYPES],
      },
    };
  }

  async getChannelStatus(channelId) {
    const state = this._channelState.get(channelId) || {};
    const counters = this._counters.get(channelId) || emptyCounters(channelId);
    const result = {
      channelId,
      channelType: state.channelType,
      enabled: state.enabled !== false,
      quota: state.quotaOverride ?? (DEFAULT_QUOTAS[state.channelType] ?? 20),
      lastFetchAt: state.lastFetchAt,
      lastFetchDurationMs: state.lastFetchDurationMs,
      lastError: state.lastError,
      counters: { ...counters },
    };
    // 附加 Channel 自报健康（如 adversarial 的 initError）
    const ch = this._channels.get(channelId);
    if (ch && typeof ch.health === 'function') {
      try { result.health = await ch.health(); } catch {}
    }
    return result;
  }

  // ── 写操作（走 rule_check ask 门禁由 tools 层负责）─────────────────────

  setQuota(channelId, quota) {
    const state = this._channelState.get(channelId);
    if (!state) throw new Error(`channel not found: ${channelId}`);
    const q = Number(quota);
    if (!Number.isFinite(q) || q < 0 || q > 1000) {
      throw new Error(`quota must be 0-1000, got ${quota}`);
    }
    state.quotaOverride = q;
    this._channelState.set(channelId, state);
    this._persistChannelState(channelId, state);
    return { channelId, quota: q };
  }

  setChannelEnabled(channelId, enabled) {
    const state = this._channelState.get(channelId);
    if (!state) throw new Error(`channel not found: ${channelId}`);
    state.enabled = !!enabled;
    this._channelState.set(channelId, state);
    this._persistChannelState(channelId, state);
    return { channelId, enabled: state.enabled };
  }

  // ── 持久化（fire-and-forget，失败不影响主流程）──────────────────────────

  async _persistCounters(channelId, counters) {
    try {
      const t = this._table('counters');
      await t.put(channelId, packCounters(channelId, counters));
    } catch { /* 软降级 */ }
  }

  async _persistChannelState(channelId, state) {
    try {
      const t = this._table('channel_state');
      await t.put(channelId, { ...state, updatedAt: new Date().toISOString() });
    } catch { /* 软降级 */ }
  }
}


