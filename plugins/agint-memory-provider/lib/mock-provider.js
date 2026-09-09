/**
 * agint-memory-provider: MockProvider —— 测试用外部 provider（设计稿 §11.3）。
 *
 * 用途：在不接真实外部服务（Honcho/Hindsight/Mem0/Zep）的前提下，验证
 * ExternalProvider 接口契约、MemoryManager 的激活/降级/召回/同步编排。
 *
 * 相比设计稿 §11.3 的伪码，本实现补齐：
 *   - `calls` 记录每次调用的入参，供集成测试断言调用顺序与参数
 *   - 可注入延迟（prefetchDelayMs）以验证 Sprint 16 的超时保护
 *   - `unavailableReason()` 返回真实原因（§5.1：配合 isAvailable()===false）
 *   - 每个失败开关独立（prefetch / syncTurn / preCompress / initialize），
 *     避免一个开关同时影响多条路径导致测试无法定位
 */

import { ExternalProvider } from './provider.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class MockProvider extends ExternalProvider {
  /**
   * @param {object} [config]
   * @param {string} [config.name='mock']
   * @param {boolean} [config.available=true]
   * @param {boolean} [config.failInitialize=false]
   * @param {boolean} [config.failPrefetch=false]
   * @param {boolean} [config.failSyncTurn=false]
   * @param {boolean} [config.failPreCompress=false]
   * @param {boolean} [config.failToolCall=false]
   * @param {number} [config.prefetchDelayMs=0]
   * @param {number} [config.apiVersion=2] 2 = fail-closed（§3.2 [3]）
   * @param {string[]} [config.memories]
   */
  constructor(config = {}) {
    super();
    this._name = config.name ?? 'mock';
    this._available = config.available ?? true;
    this._failInitialize = config.failInitialize ?? false;
    this._failPrefetch = config.failPrefetch ?? false;
    this._failSyncTurn = config.failSyncTurn ?? false;
    this._failPreCompress = config.failPreCompress ?? false;
    this._failToolCall = config.failToolCall ?? false;
    this._prefetchDelayMs = config.prefetchDelayMs ?? 0;
    this._apiVersion = config.apiVersion ?? 2;
    this._memories = config.memories ?? [
      '[mock] semantic match: 用户偏好简洁回答',
      '[mock] long-term: 上次讨论主题为可插拔记忆架构',
    ];

    /** 调用记录：[[method, ...args], ...]，供断言 */
    this.calls = [];
    this.lastRecallCount = 0;
    this.initialized = false;
    this.sessionId = null;
    this.shutdownCount = 0;
  }

  get name() {
    return this._name;
  }

  get preCompressCheckpointApiVersion() {
    return this._apiVersion;
  }

  // ── 故障注入开关（测试用）──────────────────────────────────────────────
  setAvailability(v) { this._available = Boolean(v); return this; }
  setFailInitialize(v) { this._failInitialize = Boolean(v); return this; }
  setFailPrefetch(v) { this._failPrefetch = Boolean(v); return this; }
  setFailSyncTurn(v) { this._failSyncTurn = Boolean(v); return this; }
  setFailPreCompress(v) { this._failPreCompress = Boolean(v); return this; }
  setFailToolCall(v) { this._failToolCall = Boolean(v); return this; }
  setPrefetchDelay(ms) { this._prefetchDelayMs = Number(ms) || 0; return this; }

  /** 清空调用记录（用例之间隔离） */
  resetCalls() { this.calls = []; return this; }

  /** 按方法名筛选调用记录 */
  callsTo(method) { return this.calls.filter((c) => c[0] === method); }

  // ── 接口实现 ───────────────────────────────────────────────────────────

  isAvailable() {
    this.calls.push(['isAvailable']);
    return this._available;
  }

  unavailableReason() {
    return this._available ? '' : 'MOCK_API_KEY 未配置（模拟外部 provider 缺凭证）';
  }

  async initialize(sessionId, kwargs) {
    this.calls.push(['initialize', sessionId]);
    if (this._failInitialize) throw new Error('mock: initialize failed (simulated)');
    if (!this._available) throw new Error('mock: provider not available');
    this.sessionId = sessionId ?? null;
    this.initialized = true;
  }

  systemPromptBlock() {
    return '[mock provider] 语义记忆已启用（测试桩，不代表真实外部服务）';
  }

  async prefetch(query, options = {}) {
    this.calls.push(['prefetch', query]);
    if (this._failPrefetch) {
      throw new Error('mock: prefetch network timeout (simulated)');
    }
    if (this._prefetchDelayMs > 0) await sleep(this._prefetchDelayMs);

    // 简单相关性模拟：query 为空则无召回
    const q = String(query ?? '').trim();
    const hits = q ? this._memories : [];
    this.lastRecallCount = hits.length;
    return hits.map((m) => `• ${m}`).join('\n');
  }

  recallStatus() {
    return { providerLabel: this._name, count: this.lastRecallCount, glyph: '🧪' };
  }

  async syncTurn(userContent, assistantContent, options = {}) {
    this.calls.push(['syncTurn', userContent, assistantContent]);
    if (this._failSyncTurn) throw new Error('mock: syncTurn failed (simulated)');
  }

  /** 暴露一个工具，验证 §3.3 的工具注册/路由（Sprint 16 接线） */
  getToolSchemas() {
    return [
      {
        name: 'mock_add_user_memory',
        description: 'MOCK 工具：写入一条用户记忆（测试桩，不落真实数据）',
        parameters: {
          type: 'object',
          properties: { content: { type: 'string', description: '记忆内容' } },
          required: ['content'],
          // K19：object schema 必须显式声明，否则 dsh 严格校验会拒收（见 test/schema-guard.test.mjs）
          additionalProperties: false,
        },
      },
    ];
  }

  async handleToolCall(toolName, args, kwargs) {
    this.calls.push(['handleToolCall', toolName, args]);
    if (this._failToolCall) {
      throw new Error('mock: handleToolCall failed (simulated)');
    }
    if (toolName !== 'mock_add_user_memory') {
      // 未声明的工具必须显式失败（provider.js 同策略）
      throw new Error(`Provider ${this._name} does not handle tool ${toolName}`);
    }
    return JSON.stringify({ ok: true, source: this._name, tool: toolName, args: args ?? {} });
  }

  async shutdown() {
    this.calls.push(['shutdown']);
    this.shutdownCount += 1;
    this.initialized = false;
  }

  // ── hooks ──────────────────────────────────────────────────────────────

  async onTurnStart(turnNumber, message, kwargs) {
    this.calls.push(['onTurnStart', turnNumber]);
  }

  async onSessionEnd(messages) {
    this.calls.push(['onSessionEnd', Array.isArray(messages) ? messages.length : 0]);
  }

  async onSessionSwitch(newSessionId, options) {
    this.calls.push(['onSessionSwitch', newSessionId]);
    this.sessionId = newSessionId ?? null;
  }

  async onPreCompress(messages) {
    this.calls.push(['onPreCompress', Array.isArray(messages) ? messages.length : 0]);
    if (this._failPreCompress) {
      // apiVersion=2 时这代表「检查点持久化失败」→ MemoryManager 应 fail-closed
      throw new Error('mock: pre-compress checkpoint persistence failed (simulated)');
    }
    await sleep(10);
    return 'MOCK 洞察：本轮讨论集中在可插拔记忆架构与降级策略。';
  }

  getConfigSchema() {
    return [
      { key: 'apiKeyEnv', label: 'API Key 环境变量名', type: 'string', required: true, secret: true },
      { key: 'apiBaseUrl', label: 'API Base URL', type: 'string', required: false },
    ];
  }

  async saveConfig(values, dshHome) {
    this.calls.push(['saveConfig', Object.keys(values ?? {})]);
  }

  backupPaths() {
    return [];
  }
}

export { MockProvider };
