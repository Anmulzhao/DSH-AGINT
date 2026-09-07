/**
 * agint-memory-provider: ExternalProvider 抽象基类 + 实现完整性校验。
 *
 * 设计稿 §5.1（接口契约，参考 Hermes `agent/memory_provider.py` 的
 * MemoryProvider ABC）。JS 无真正 abstract class，用「基类抛错 / 默认 no-op」
 * 模拟，并由 validateProvider 在注册期做完整性校验（§3.1 [2]）。
 *
 * 方法分三类：
 *   - **必须实现**（基类抛 not implemented）：isAvailable / initialize /
 *     getToolSchemas。validateProvider 会拦下未 override 的实现。
 *   - **有默认实现**（可不 override）：prefetch（''）/ syncTurn（no-op）/
 *     shutdown（no-op）/ recallStatus（null）/ queuePrefetch（no-op）/
 *     unavailableReason（''）/ systemPromptBlock（''）/ 全部 on* hooks /
 *     getConfigSchema（[]）/ saveConfig（no-op）/ backupPaths（[]）。
 *   - **默认拒绝**：handleToolCall 抛「does not handle tool」——provider 没声明
 *     该工具时必须显式失败，不得静默吞掉（真实 > 讨好）。
 *
 * 命名：设计稿 §5.1 用 camelCase（isAvailable / syncTurn / onPreCompress），
 * 与 Hermes 的 snake_case 一一对应，本实现沿用 camelCase 对齐仓库既有风格。
 */

class ExternalProvider {
  // === 基本信息 ===

  /** Provider 短标识（如 'honcho', 'hindsight', 'mem0', 'builtin'） */
  get name() {
    throw new Error('ExternalProvider.name: not implemented');
  }

  /**
   * pre_compress 检查点 API 版本（设计稿 §3.2 [3]）：
   *   1 = best-effort（不验证持久化，兼容旧 provider）
   *   2 = fail-closed（持久化失败则中止压缩）
   */
  get preCompressCheckpointApiVersion() {
    return 1;
  }

  // === 核心生命周期（必须实现） ===

  /**
   * 是否可用：只检查配置/凭证，**不得发起网络请求**（§9.2 约束 6）。
   * @returns {boolean}
   */
  isAvailable() {
    throw new Error(`${this.constructor.name}.isAvailable: not implemented`);
  }

  /**
   * 初始化（连接、资源、会话线程）。
   * @param {string} sessionId
   * @param {object} [kwargs] - { dshHome, platform, agentContext, agentIdentity }
   */
  async initialize(sessionId, kwargs) {
    throw new Error(`${this.constructor.name}.initialize: not implemented`);
  }

  /**
   * 声明工具 schema（OpenAI function-calling 形态）。必须实现——**没有工具就
   * 返回 `[]`**，这是显式声明「我不暴露工具」，与「忘了实现」区分开。
   *
   * ⚠️ §14.1 决策 B：内置记忆工具（memory_write / memory_search / memory_read /
   * memory_stats / memory_forget_scan）继续由 agint-memory 的 preset 平面直接
   * 提供，**不经此接口**。故 BuiltinProvider 返回 []，否则会与既有工具重名冲突
   * （§9.2 约束 7：工具名必须唯一）。
   *
   * @returns {Array<{name: string, description: string, parameters: object}>}
   */
  getToolSchemas() {
    throw new Error(`${this.constructor.name}.getToolSchemas: not implemented`);
  }

  // === 有默认实现（可选 override） ===

  /** 不可用时的用户提示（配合 isAvailable() === false 使用） */
  unavailableReason() {
    return '';
  }

  /** 静态系统 Prompt 文本；召回内容走 prefetch，不走这里（§5.1） */
  systemPromptBlock() {
    return '';
  }

  /**
   * 召回上下文（本轮对话前调用，**必须快**；超时保护由 MemoryManager 施加）。
   * @param {string} query
   * @param {{sessionId?: string}} [options]
   * @returns {Promise<string>} 格式化召回文本；空串表示无
   */
  async prefetch(query, options) {
    return '';
  }

  /** 后台预取队列：本轮结束后入队，供下一轮 prefetch 消费（§5.1） */
  async queuePrefetch(query, options) {
    /* default: no-op */
  }

  /**
   * 最近一次 prefetch 的召回状态（确定性召回指示器，§3.1 [5]）。
   * @returns {{providerLabel: string, count: number, glyph: string}|null}
   */
  recallStatus() {
    return null;
  }

  /**
   * 同步一轮对话（非阻塞，后台写入记忆）。
   * @param {string} userContent
   * @param {string} assistantContent
   * @param {{sessionId?: string, messages?: Array}} [options]
   */
  async syncTurn(userContent, assistantContent, options) {
    /* default: no-op */
  }

  /** 关闭：刷新队列、关闭连接、释放资源（§9.2 约束 5：必须实现清理语义） */
  async shutdown() {
    /* default: no-op */
  }

  // === 可选 Hooks（override 以启用） ===

  /** 每轮开始时调用 */
  async onTurnStart(turnNumber, message, kwargs) {
    /* default: no-op */
  }

  /** 会话结束时调用（仅真实会话边界） */
  async onSessionEnd(messages) {
    /* default: no-op */
  }

  /** 会话切换时调用（/resume, /branch, /reset, /new, compression） */
  async onSessionSwitch(newSessionId, options) {
    /* default: no-op */
  }

  /**
   * 压缩前提取洞察（注入压缩摘要 prompt，§3.2）。
   * @param {Array} messages
   * @returns {Promise<string>} 洞察文本；空串表示无
   */
  async onPreCompress(messages) {
    return '';
  }

  /** 委派完成时调用（父端观察） */
  async onDelegation(task, result, options) {
    /* default: no-op */
  }

  /** 内置记忆工具写入时镜像调用（§5.1） */
  async onMemoryWrite(action, target, content, metadata) {
    /* default: no-op */
  }

  // === 配置与备份（Sprint 17 接入 setup 向导） ===

  /** 配置 schema（用于 setup 向导） */
  getConfigSchema() {
    return [];
  }

  /** 保存非敏感配置；敏感项只落 env var 名（§4.2 / §9.1 L2） */
  async saveConfig(values, dshHome) {
    /* default: no-op */
  }

  /** 声明 DSH_HOME 之外的备份路径 */
  backupPaths() {
    return [];
  }

  // === 默认拒绝：未声明的工具必须显式失败 ===

  /**
   * 处理 provider 工具调用。
   * @returns {Promise<string>} JSON 字符串
   */
  async handleToolCall(toolName, args, kwargs) {
    throw new Error(`Provider ${safeName(this)} does not handle tool ${toolName}`);
  }
}

/** 读 name 时基类会抛；校验/报错路径需要一个不会二次抛错的名字 */
function safeName(provider) {
  try {
    return provider?.name ?? provider?.constructor?.name ?? 'unknown';
  } catch {
    return provider?.constructor?.name ?? 'unknown';
  }
}

// ── 实现完整性校验（§3.1 [2]）───────────────────────────────────────────

/** 必须 override 的方法：解析到的函数若仍是基类 stub，视为未实现 */
const REQUIRED_METHODS = Object.freeze(['isAvailable', 'initialize', 'getToolSchemas']);

/** 建议 override（缺失不阻断注册，只在报告里提示） */
const RECOMMENDED_METHODS = Object.freeze(['prefetch', 'syncTurn', 'shutdown', 'recallStatus']);

/**
 * 校验一个 provider 实例的实现完整性。
 *
 * 判定方式：把实例上解析到的函数与 ExternalProvider.prototype 的 stub 做
 * **同一性比较**——相同即未 override。比「typeof === 'function'」严格，能拦下
 * 「继承了基类抛错 stub 却照样注册」的情况。
 *
 * @param {unknown} provider
 * @returns {{valid: boolean, name: string|null, missing: string[], recommended: string[], errors: string[]}}
 */
function validateProvider(provider) {
  const report = { valid: false, name: null, missing: [], recommended: [], errors: [] };

  if (!provider || typeof provider !== 'object') {
    report.errors.push('provider 必须是对象实例');
    return report;
  }

  // name：基类 getter 会抛
  try {
    const n = provider.name;
    if (typeof n !== 'string' || !n.trim()) {
      report.errors.push('name 必须是非空字符串');
      return report;
    }
    report.name = n;
  } catch (e) {
    report.errors.push(`name getter 抛错（未 override）：${e?.message ?? e}`);
    return report;
  }

  for (const m of REQUIRED_METHODS) {
    const fn = provider[m];
    if (typeof fn !== 'function') {
      report.missing.push(m);
      continue;
    }
    if (fn === ExternalProvider.prototype[m]) {
      report.missing.push(m);
    }
  }

  for (const m of RECOMMENDED_METHODS) {
    const fn = provider[m];
    if (typeof fn !== 'function' || fn === ExternalProvider.prototype[m]) {
      report.recommended.push(m);
    }
  }

  // preCompressCheckpointApiVersion 必须是 1 或 2（§3.2 [3]）
  const v = provider.preCompressCheckpointApiVersion;
  if (v !== 1 && v !== 2) {
    report.errors.push(`preCompressCheckpointApiVersion 必须是 1 或 2，实为 ${JSON.stringify(v)}`);
  }

  // getToolSchemas 必须返回数组（若已实现则实际调用一次验证）
  if (!report.missing.includes('getToolSchemas')) {
    try {
      const schemas = provider.getToolSchemas();
      if (!Array.isArray(schemas)) {
        report.errors.push('getToolSchemas() 必须返回数组');
      } else {
        for (const s of schemas) {
          if (!s || typeof s.name !== 'string' || !s.name.trim()) {
            report.errors.push('getToolSchemas() 每项必须有非空 name');
            break;
          }
        }
      }
    } catch (e) {
      report.errors.push(`getToolSchemas() 调用抛错：${e?.message ?? e}`);
    }
  }

  report.valid = report.missing.length === 0 && report.errors.length === 0;
  return report;
}

export { ExternalProvider, validateProvider, safeName, REQUIRED_METHODS, RECOMMENDED_METHODS };
