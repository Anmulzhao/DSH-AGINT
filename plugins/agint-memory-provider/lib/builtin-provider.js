/**
 * agint-memory-provider: BuiltinProvider —— 把现有 agint-memory 封装为
 * 始终可用的 provider（设计稿 §5.2）。
 *
 * ⚠️ 对设计稿 §5.2 伪码的三处纠正（依据仓库实况，非风格偏好）：
 *
 * 1. **不开存储域**。§5.2 写 `ctx.storageDomain.open(agintMemorySpec)`，但
 *    `agint` 域被 agint-memory **独占**（域名进程内独占，见
 *    plugins/agint-memory/lib/index.js 头注 "The domain name is exclusive per
 *    process"）。二次 open 必冲突。正确做法：注入 `agint.memory` 服务复用，
 *    与 agint-mount 注入 `agint.qualitySandbox`、agint-event-bus 注入
 *    `agint.evolution` 同模式。
 *
 * 2. **不关别人的域**。§5.2 的 `shutdown()` 调 `this.domain.close()`。域属
 *    agint-memory，由它自己的 ctx.effect disposer 关闭；这里关闭会破坏宿主
 *    生命周期（AGENTS.md 挂载红线）。BuiltinProvider.shutdown() 只做自身
 *    状态复位。
 *
 * 3. **prefetch 默认只读**。§5.2 的 prefetch 走 recall 逻辑；但
 *    `memory.recall(id)` 会写 recalls/lastRecall，而 lastRecall 是
 *    decay.js 降级判定的输入 → 直接改变衰减行为，违反 §12.1 验收标准
 *    「行为与现有 agint-memory 完全一致」。故默认只调 search（只读，与现有
 *    memory_search 工具一致），写回由 builtin_recall_touch 开关交人工决定。
 *
 * 另：§5.2/§6 提到的工具名 memory_add / memory_recall 是**过期名**，实际为
 * memory_write / memory_search / memory_read / memory_stats / memory_forget_scan
 * （见 plugins/agint-memory/lib/tools.js）。按 §14.1 决策 B，这些工具继续由
 * agint-memory 的 preset 平面提供，不经 provider 接口 → getToolSchemas() 返回 []。
 */

import { ExternalProvider } from './provider.js';
import { BUILTIN_PROVIDER } from './schema.js';

/** 召回条目的展示形态：`• [type/level] content`（与 memory_search render 一致） */
function formatMemories(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return '';
  return memories
    .map((m) => `• [${m.type}/${m.level}] ${m.content}`)
    .join('\n');
}

/**
 * @param {object} deps
 * @param {object} deps.memory - `agint.memory` 服务（read/list/search/write/recall/stats/...）
 * @param {() => object} deps.config - 返回生效配置（含 builtin_recall_limit / builtin_recall_touch）
 * @param {(msg: string) => void} [deps.debug] - debug_mode 日志出口
 */
class BuiltinProvider extends ExternalProvider {
  constructor({ memory, config, debug } = {}) {
    super();
    if (!memory || typeof memory !== 'object') {
      throw new Error('BuiltinProvider: 需要注入 agint.memory 服务');
    }
    if (typeof config !== 'function') {
      throw new Error('BuiltinProvider: config 必须是返回生效配置的函数');
    }
    this.memory = memory;
    this.configFn = config;
    this.debug = typeof debug === 'function' ? debug : () => {};

    this.initialized = false;
    this.sessionId = null;
    this.lastRecallCount = 0;
    this.lastQuery = null;
  }

  get name() {
    return BUILTIN_PROVIDER;
  }

  /** best-effort：P3-1 升级到 2（设计稿 §5.2） */
  get preCompressCheckpointApiVersion() {
    return 1;
  }

  /** §9.1 L0：内置 provider 始终可用，且永不降级 */
  isAvailable() {
    return true;
  }

  unavailableReason() {
    return '';
  }

  async initialize(sessionId, kwargs) {
    // 不做 open：域归 agint-memory 独占（见文件头纠正 1）
    this.sessionId = sessionId ?? null;
    this.initialized = true;
    this.debug(`[builtin] initialized session=${this.sessionId ?? '(none)'}`);
  }

  systemPromptBlock() {
    return '';
  }

  /**
   * 关键词检索 + 级别排序，复用 agint-memory 的 search（不重写检索逻辑，
   * §1.3 非目标第 1 条）。search 内部已按 effectiveConfidence 降序排序。
   */
  async prefetch(query, options = {}) {
    const cfg = this.configFn();
    const limit = cfg.builtin_recall_limit ?? 8;
    const q = String(query ?? '').trim();
    this.lastQuery = q;

    // 空查询：search('') 会返回全表前 limit 条（无关键词过滤），这不是「针对
    // 本轮输入的召回」，按无召回处理，避免把无关旧记忆注入 prompt。
    if (!q) {
      this.lastRecallCount = 0;
      return '';
    }

    const memories = await this.memory.search(q, { limit });
    this.lastRecallCount = Array.isArray(memories) ? memories.length : 0;

    // 可选写回（默认关闭，见文件头纠正 3）
    if (cfg.builtin_recall_touch && this.lastRecallCount > 0) {
      for (const m of memories) {
        // recall 写 recalls/lastRecall；单条失败不影响召回结果返回
        await this.memory.recall(m.id).catch((e) => {
          this.debug(`[builtin] recall(${m.id}) failed: ${e?.message ?? e}`);
        });
      }
    }

    return formatMemories(memories);
  }

  /** 确定性召回指示器（§3.1 [5]） */
  recallStatus() {
    return {
      providerLabel: BUILTIN_PROVIDER,
      count: this.lastRecallCount,
      glyph: '🧠',
    };
  }

  /**
   * 每轮同步：内置记忆**不自动提取** lesson/decision/preference/pattern。
   *
   * §5.2 伪码注释说「后台提取」，但 agint-memory 现状没有任何自动提取实现
   * （lib/index.js 只有 CRUD + search + decayScanRun），提取需要 LLM 判定，
   * 属 §1.3 非目标范围。这里 no-op 而非新造一套提取逻辑：写记忆由
   * memory_write 工具（模型/人工显式调用）负责，保持现有行为不变。
   */
  async syncTurn(userContent, assistantContent, options) {
    /* no-op：见方法注释 */
  }

  /**
   * §14.1 决策 B：内置工具由 agint-memory preset 平面直接提供，不经 provider
   * 接口。返回 [] 是显式声明「不暴露工具」，避免与 memory_* 重名冲突
   * （§9.2 约束 7）。
   */
  getToolSchemas() {
    return [];
  }

  /** 内置 provider 不处理外部工具调用 → 显式失败（真实 > 讨好） */
  async handleToolCall(toolName, args, kwargs) {
    throw new Error(
      `Provider builtin does not handle tool ${toolName}` +
      '（内置记忆工具由 agint-memory 直接提供，见设计稿 §14.1 决策 B）',
    );
  }

  /**
   * best-effort：从即将压缩的消息里提取洞察。
   * 内置实现无 LLM 提取能力，这里返回空串表示「无洞察」，由 MemoryManager
   * 记为 best_effort 检查点；P3-1 再升级为真实提取 + fail-closed。
   */
  async onPreCompress(messages) {
    return '';
  }

  /** 只复位自身状态，不关 agint 域（见文件头纠正 2） */
  async shutdown() {
    this.initialized = false;
    this.sessionId = null;
    this.lastRecallCount = 0;
    this.lastQuery = null;
    this.debug('[builtin] shutdown (agint 域由 agint-memory 自行关闭)');
  }

  /** 暴露给 Service 层做健康检查/统计 */
  async stats() {
    return this.memory.stats();
  }
}

export { BuiltinProvider, formatMemories };
