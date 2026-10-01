/**
 * agint-memory-provider: **示例外部 provider —— FileProvider**（阶段 3 §12.3）。
 *
 * 这是「外部 provider 该怎么实现」的**参考实现 + 可直接跑的活样例**：
 *   - 不依赖任何外部服务（记忆落在本地 JSONL 文件），装了就能激活，
 *     因此可以用来验证「注册 → 激活 → 召回 → 同步 → 降级 → 恢复」整条链路；
 *   - 实现了 ExternalProvider 的**全部可选 hook**，包括阶段 3 新增的
 *     `healthCheck()`（唯一被允许做真实 I/O 探活的地方）；
 *   - 完整开发指南见 `docs/plugins/agint-memory-provider.md`。
 *
 * 用法（dsh 侧 / 或任何拿得到 `agint.memoryProvider` 服务的地方）：
 *
 *   import { FileProvider } from './examples/file-provider.js';
 *   const svc = ctx.get('agint.memoryProvider');
 *   svc.registerProvider(new FileProvider({ dir: 'D:/DSH/file-memory' }));
 *   await svc.activate('file', { actor: 'human', reason: '试用示例 provider' });
 *
 * ⛔ 安全约束（设计稿 §9.1 L2 / §13.2）：
 *   - 只允许读写自己配置的 `dir`，不做任何目录穿越（路径 join 后校验前缀）；
 *   - 不落任何凭证；配置里只放路径；
 *   - 工具名加 `file_` 前缀，不与内置记忆工具（memory_*）冲突。
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, accessSync, constants } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { ExternalProvider } from '../lib/provider.js';

const DEFAULT_DIR = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'file-provider-memory')
  : join(tmpdir(), 'agint-file-provider-memory');

class FileProvider extends ExternalProvider {
  /**
   * @param {object} [config]
   * @param {string} [config.dir] 记忆落盘目录；缺省 $DSH_HOME/file-provider-memory
   * @param {string} [config.name='file']
   */
  constructor(config = {}) {
    super();
    this._name = config.name ?? 'file';
    this._dir = resolve(config.dir ?? DEFAULT_DIR);
    /** @type {Array<{id: string, ts: string, text: string}>} */
    this.memories = [];
    this.initialized = false;
    this.sessionId = null;
    this.lastRecallCount = 0;
  }

  get name() {
    return this._name;
  }

  /** 示例保守：best-effort（1），不阻断压缩 */
  get preCompressCheckpointApiVersion() {
    return 1;
  }

  get file() {
    return join(this._dir, 'memories.jsonl');
  }

  /**
   * 路径穿越防护：任何读写前都把目标路径解析后校验仍在 dir 之内。
   * @returns {string|null} 安全则返回绝对路径，否则 null
   */
  safePath(target) {
    const abs = resolve(this._dir, target ?? '');
    if (abs !== this._dir && !abs.startsWith(this._dir + sep)) return null;
    return abs;
  }

  // ── 必须实现 ───────────────────────────────────────────────────────────

  /**
   * 只做本地检查（目录存在或可创建 + 可写），**不发网络请求**（§9.2 约束 6）。
   * @returns {boolean}
   */
  isAvailable() {
    try {
      if (!existsSync(this._dir)) return true; // initialize 会创建；不算不可用
      accessSync(this._dir, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  unavailableReason() {
    return `目录不可写: ${this._dir}`;
  }

  async initialize(sessionId) {
    if (!existsSync(this._dir)) mkdirSync(this._dir, { recursive: true });
    this._load();
    this.sessionId = sessionId ?? null;
    this.initialized = true;
  }

  /** 声明一个工具（示例：全文检索自己的记忆文件） */
  getToolSchemas() {
    return [
      {
        name: 'file_memory_search',
        description: '在 FileProvider（示例外部记忆）里按关键词检索记忆条目',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词' },
            limit: { type: 'integer', description: '返回条数，缺省 5' },
          },
          required: ['query'],
          // K19：object 必须显式声明 additionalProperties，否则 dsh 严格模式拒收
          additionalProperties: false,
        },
      },
    ];
  }

  // ── 可选实现（这里全部 override，作为示例）──────────────────────────────

  systemPromptBlock() {
    return `[${this._name}] 外部记忆已启用（本地文件存储：${this._dir}）`;
  }

  async prefetch(query) {
    const hits = this._match(query);
    this.lastRecallCount = hits.length;
    if (!hits.length) return '';
    return hits.map((m) => `• ${m.text}`).join('\n');
  }

  recallStatus() {
    return { providerLabel: this._name, count: this.lastRecallCount, glyph: '📄' };
  }

  async syncTurn(userContent, assistantContent) {
    // 只写有意义的轮次（空内容不落盘，避免噪声）
    const text = [userContent, assistantContent].filter(Boolean).join(' | ').trim();
    if (!text) return;
    const entry = { id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ts: new Date().toISOString(), text: text.slice(0, 2000) };
    this.memories.push(entry);
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  async shutdown() {
    this.initialized = false;
    this.sessionId = null;
  }

  async onSessionSwitch(newSessionId) {
    this.sessionId = newSessionId ?? null;
  }

  async onPreCompress() {
    if (!this.memories.length) return '';
    const tail = this.memories.slice(-10).map((m) => m.text.slice(0, 80));
    return `FileProvider 洞察（最近 ${tail.length} 条）：\n- ${tail.join('\n- ')}`;
  }

  /**
   * 阶段 3 可选 hook：**真实探活**——只有实现了这个方法，健康检查才会把
   * `networkProbed` 记为 true。这里做的是「目录可读可写 + 文件能读完」。
   * @returns {Promise<{ok: boolean, reason?: string, details?: object}>}
   */
  async healthCheck() {
    try {
      if (!existsSync(this._dir)) {
        return { ok: false, reason: `目录不存在: ${this._dir}` };
      }
      accessSync(this._dir, constants.R_OK | constants.W_OK);
      let lines = 0;
      if (existsSync(this.file)) {
        lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean).length;
      }
      return { ok: true, reason: '目录可读写', details: { dir: this._dir, lines } };
    } catch (e) {
      return { ok: false, reason: `探活失败: ${e?.message ?? e}` };
    }
  }

  getConfigSchema() {
    return [
      { key: 'dir', label: '记忆落盘目录', type: 'string', required: false },
    ];
  }

  async saveConfig(values, dshHome) {
    if (values?.dir) {
      this._dir = resolve(String(values.dir).replace(/^~/, dshHome ?? ''));
    }
  }

  backupPaths() {
    return [this._dir];
  }

  async handleToolCall(toolName, args) {
    if (toolName !== 'file_memory_search') {
      // 未声明的工具必须显式失败（provider.js 同策略，真实 > 讨好）
      throw new Error(`Provider ${this._name} does not handle tool ${toolName}`);
    }
    const limit = Math.min(Math.max(Number(args?.limit ?? 5) || 5, 1), 50);
    const hits = this._match(args?.query ?? '').slice(0, limit);
    return JSON.stringify({ ok: true, source: this._name, count: hits.length, items: hits });
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  _load() {
    this.memories = [];
    if (!existsSync(this.file)) return;
    const raw = readFileSync(this.file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj.text === 'string') this.memories.push(obj);
      } catch {
        /* 坏行跳过：示例实现不因一条脏数据整体失败 */
      }
    }
  }

  /**
   * 查询词切分。中文没有空格分词，直接整串 substring 匹配等于「搜不到」，
   * 故无空格的查询改用 **2-gram 滑窗**（示例级实现，只求召回可用，不求检索质量）。
   */
  _terms(q) {
    const s = String(q ?? '').trim().toLowerCase();
    if (!s) return [];
    if (/\s/.test(s)) return s.split(/\s+/).filter(Boolean);
    if (s.length <= 2) return [s];
    const grams = [];
    for (let i = 0; i + 2 <= s.length; i++) grams.push(s.slice(i, i + 2));
    return grams;
  }

  /** 极简关键词匹配（示例用，不追求检索质量） */
  _match(query) {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return [];
    const terms = this._terms(q);
    return this.memories
      .map((m) => {
        const t = m.text.toLowerCase();
        const score = terms.reduce((n, term) => n + (t.includes(term) ? 1 : 0), 0);
        return { m, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.m);
  }

  /** 测试/演示用：清空记忆文件（不在正式接口里，方便手工重置） */
  reset() {
    this.memories = [];
    if (existsSync(this._dir)) writeFileSync(this.file, '', 'utf8');
  }
}

export { FileProvider, DEFAULT_DIR };
