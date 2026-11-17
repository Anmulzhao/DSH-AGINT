/**
 * agint-dream: P1 LLM consolidation 独立验证模块。
 *
 * 设计见 AGINT/计划-agint-dream升级三方向.md P1 段 + cordis-plugin-development skill
 * "Register dynamic model Tool" 节。
 *
 * 目的：在 host plane 真实跑一次 minimal ctx.agents.create() + ctx.subagents.startActivation(
 * {outputSchema})，验证 DSH 自带 subagent runtime 通路真的可用。这是子任务 1.1
 * "写一个独立验证脚本"的内嵌实现 —— 不依赖挂 cordis dynamic plugin（AGINT preset
 * 未挂载 cordis_* 工具），改用 host plugin 永久 service method + model tool。
 *
 * 与 sweep.js 的边界：
 *   - 不调 sweep 主体
 *   - 不写 agint.memory（仅 schema-validated structured result 回传）
 *   - 不污染任何已有候选 / recall store
 *   - 真模型 LLM call 会被消耗 token —— 这是验证本身的代价
 *
 * 输入：ctx + 可选 { provider, model, timeoutMs }
 * 输出：JSON-safe { mode, operations, reason, diagnostic, schemaOk,
 *                  provider, model, day, gatedCount }
 */

import { consolidate, resolveLlmSelection } from './consolidation.js';
import { createHash } from 'node:crypto';

/** 构造一个最小但真实的测试场景：2 个候选 + 1 个 existing。
 *  候选内容刻意用 2 个不同主题（不让模型偷懒全 added），
 *  现有 memory 故意跟 c2 内容近但不完全相同，诱导模型走 merged。 */
function buildMinimalFixtures() {
  const gated = [
    {
      key: createHash('sha256').update('verify-c1').digest('hex'),
      text: '以后所有报告结尾加一行 build-hash 标记',
      type: 'decision',
      score: 0.85,
      sessionKey: 'verify-session-1',
      signalCount: 3,
      uniqueDays: 2,
      time: Date.now() - 86_400_000,
    },
    {
      key: createHash('sha256').update('verify-c2').digest('hex'),
      text: '每次大改完都跑一次 safe-update 流程',
      type: 'lesson',
      score: 0.82,
      sessionKey: 'verify-session-2',
      signalCount: 2,
      uniqueDays: 1,
      time: Date.now() - 60_000_000,
    },
  ];
  const existing = [
    {
      id: 'verify-existing-1',
      type: 'lesson',
      content: '大改完跑一次 safe-update',
      lineageKey: 'workflow/safe-update',
    },
  ];
  return { gated, existing };
}

/**
 * 跑一次 minimal consolidation。返回 JSON-safe 结果 —— 模型 tool 输出。
 * 永远不抛错；任何 host 端问题都进 mode='failed' + reason（无降级）。
 */
export async function runVerification({
  ctx,
  // 空串 = 宿主当前模型；不要写死模型名（换模型时以宿主 profile 为准）
  provider = '',
  model = '',
  timeoutMs = 60_000,
  day = `verify-${new Date().toISOString().slice(0, 10)}`,
} = {}) {
  const { gated, existing } = buildMinimalFixtures();
  // 报**生效值**而不是入参：入参空时实际用的是宿主当前选择 / 离线兜底值，
  // 写 '(default)' 等于藏起了「这轮到底用的哪个模型」。
  const selection = resolveLlmSelection(ctx, { provider, model });
  const result = await consolidate({
    ctx,
    gated,
    existing,
    day,
    provider: selection.provider,
    model: selection.model,
    timeoutMs,
  });
  // 截断 operations 到 5 条避免输出过大
  const ops = Array.isArray(result.operations) ? result.operations.slice(0, 5) : null;
  return {
    mode: result.mode ?? 'failed',
    operations: ops,
    operationsLength: Array.isArray(result.operations) ? result.operations.length : null,
    gatedLength: gated.length,
    reason: result.reason ?? null,
    diagnostic: result.diagnostic ?? null,
    // startActivation 拿不到 child localAgent 事件；诊断改由 result.diagnostic 承担
    childErrors: null,
    provider: selection.provider,
    model: selection.model,
    day,
    // schema 校验态：DSH provider 自动 schema-validation；这里只标记 "拿到 structured 就算 true"
    schemaOk: result.mode === 'llm' && Array.isArray(result.operations),
  };
}
