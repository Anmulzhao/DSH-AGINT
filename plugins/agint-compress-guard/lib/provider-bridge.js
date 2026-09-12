/**
 * agint-compress-guard: P1-1 Provider 桥（Q6「单一入口」）。
 *
 * 设计稿 Q6 / §1.4：P3-1 的规则提取器**实现为 apiVersion=2 的
 * provider.onPreCompress()**，复用 P1-1 既有插槽，禁止另造第二套提取入口
 * （不变量 5）。宿主侧（agint-memory-provider MemoryManager.runPreCompressCheckpoint）
 * 会在压缩前调用激活 provider 的 onPreCompress(messages)。
 *
 * 行为边界（Q2 两段式在 P1-1 路径上的映射）：
 *   - 洞察提取/持久化失败 → 软降级：返回 ''（P1-1 记 best-effort/success，
 *     raw 检查点由 P1-1 自己落表，不受影响）——「不许没提炼」是低量级失败。
 *   - engine 自身异常（非软降级）→ 重新抛出：P1-1 的 fail-closed（apiVersion=2）
 *     会 abortCompress=true → 这是「不许丢 raw」硬门的既有闸门。
 *
 * 激活策略（shadow 观察档，§七挂载策略）：本 provider 注册进 P1-1 registry
 * （listProviders 可见、可被显式 activate），但**不自动激活**——激活会切换
 * 记忆召回路径（prefetch/syncTurn 委托实现见下），属行为变更，观察一周后由
 * 老板拍板（active_provider → 'compress-guard'）。委托实现完整，激活即用。
 */

import { mapToMemoryType } from './extractors.js';

const PROVIDER_NAME = 'compress-guard';

/**
 * @param {object} deps
 * @param {import('./engine.js').GuardEngine} deps.engine
 * @param {object} deps.memory `agint.memory` 服务（prefetch/syncTurn 委托目标，
 *        与 BuiltinProvider 同一底层，保证激活后召回行为一致）
 * @param {() => object} deps.config 生效配置（builtin_recall_limit 同款语义）
 * @param {(msg: string) => void} [deps.debug]
 */
export function createInsightProvider({ engine, memory, config, debug } = {}) {
  if (!engine) throw new Error('createInsightProvider: engine 必填');
  if (!memory || typeof memory.search !== 'function') {
    throw new Error('createInsightProvider: 需注入 agint.memory 服务（委托目标）');
  }
  if (typeof config !== 'function') throw new Error('createInsightProvider: config 必须是函数');
  const log = typeof debug === 'function' ? debug : () => {};

  let sessionId = null;
  let lastRecallCount = 0;

  return {
    get name() {
      return PROVIDER_NAME;
    },

    /** apiVersion=2：P1-1 的 pre_compress_fail_closed 语义首次真正生效（Q6） */
    get preCompressCheckpointApiVersion() {
      return 2;
    },

    /** 本地规则提取，无外部凭证 → 恒可用（§9.2 约束 6 同款：不发网络请求） */
    isAvailable() {
      return true;
    },

    unavailableReason() {
      return '';
    },

    async initialize(sid) {
      sessionId = sid ?? null;
      log('[provider] initialized');
    },

    /**
     * 委托 agint.memory.search（与 BuiltinProvider.prefetch 同策略：关键词检索
     * + 只读，空查询返回 ''，不注入无关旧记忆）。
     */
    async prefetch(query, options = {}) {
      const limit = config().builtin_recall_limit ?? 8;
      const q = String(query ?? '').trim();
      if (!q) {
        lastRecallCount = 0;
        return '';
      }
      const memories = await memory.search(q, { limit });
      lastRecallCount = Array.isArray(memories) ? memories.length : 0;
      if (!Array.isArray(memories) || memories.length === 0) return '';
      return memories.map((m) => `• [${m.type}/${m.level}] ${m.content}`).join('\n');
    },

    recallStatus() {
      return { providerLabel: PROVIDER_NAME, count: lastRecallCount, glyph: '🛡️' };
    },

    /**
     * 委托保持 builtin 语义：内置记忆不自动提取（BuiltinProvider.syncTurn
     * no-op 同理由），写记忆仍走 memory_write 显式路径。
     */
    async syncTurn() {
      /* no-op：激活后行为与 builtin 一致（§12.1 验收「行为与现有完全一致」） */
    },

    /** §14.1 决策 B 同款：不暴露 provider 工具，避免与 memory_* 冲突 */
    getToolSchemas() {
      return [];
    },

    async handleToolCall(toolName) {
      throw new Error(`Provider ${PROVIDER_NAME} does not handle tool ${toolName}`);
    },

    async shutdown() {
      sessionId = null;
    },

    /**
     * **唯一提取入口**（不变量 5）：P1-1 压缩前回调。
     *
     * 注意 runRawSnapshot:false —— raw 快照由 P1-1 本流程自己落表，若在这里
     * 再委托 runPreCompressCheckpoint 会无限递归。
     *
     * @param {Array} messages 即将被压缩的消息
     * @returns {Promise<string>} 洞察散文（P1-1 记 insightLength；正文已由本
     *          插件结构化落 insights 表，补上 P1-1「只存长度不存正文」的漏点）
     */
    async onPreCompress(messages) {
      const list = Array.isArray(messages) ? messages : [];
      let result;
      try {
        result = await engine.checkpoint({
          kind: 'p1-checkpoint',
          id: null, // P1-1 载荷缺口（§5.1）：事件发布后由订阅回填 checkpointId
          messages: list,
          sessionId,
          runRawSnapshot: false,
        });
      } catch (e) {
        // engine 自身异常（非软降级路径）→ 抛给 P1-1 的 fail-closed 硬门
        throw new Error(`compress-guard onPreCompress 编排异常: ${e?.message ?? e}`);
      }

      if (result.status === 'DEGRADED_INSIGHT' || result.insightsExtracted === 0) {
        // 软降级：返回 ''，raw 检查点（P1-1 自己的表）不受影响（Q2）
        log(`[provider] onPreCompress status=${result.status} note=${result.note ?? '-'}`);
        return '';
      }
      // 返回提炼出的洞察散文（补 P1-1 insightLength 的正文语义）
      const insights = await engine.search({
        limit: result.insightsExtracted,
        includePending: true,
      });
      const prose = insights
        .map((i) => `[${mapToMemoryType(i.type)}] ${i.content}`)
        .join('\n');
      return prose.slice(0, 4000);
    },
  };
}

export { PROVIDER_NAME };
