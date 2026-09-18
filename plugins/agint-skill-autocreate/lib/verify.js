/**
 * agint-skill-autocreate: LLM 判定通路的**真模型**验证模块（2026-09-18）。
 *
 * 形态照抄 `agint-dream/lib/verify.js`：一个 host 侧 service method，手动触发，
 * **不进 CI**（真模型调用会花钱、且结果不保证逐字可复现）。
 *
 * 它要回答的是 CI 回答不了的问题：**这段 prompt 在这台机器上真能用吗** ——
 * 输出过不过 schema、模型的分辨力是否真的存在（而不是回回都说 true）。
 * 单测能证明「代码把 LLM 的产出正确地合成了」，证明不了「LLM 给得出像样的产出」。
 *
 * 边界（与 detect 主体严格分开，避免验证污染生产）：
 *   - 不写 task_patterns / candidates / audit
 *   - 不动每日预算（预算只在 detect 的判定路径上记账）
 *   - 不调用 release / staging
 *   - 唯一副作用：真模型 token 消耗
 *
 * 输入：ctx + 可选 { provider, model, timeoutMs }
 * 输出：JSON-safe { ok, provider, model, cases[], authoringGuard }
 */

import { judgeViaLLM } from './llm-verdict.js';
import { validateLlmAuthoring } from './proposer.js';

/**
 * 两个刻意反向的样本 —— 验证的重点不是「能跑通」，是**能分辨**：
 *   c1 携带领域知识（发布前必须做的检查顺序 + 踩过的坑）→ 应判值得固化
 *   c2 是通用脚手架的任意排列（读个文件、改一改、跑个命令）→ 应判不值得固化
 *
 * 如果两个都判 true（说好话的模型）或都判 false（一律否决的模型），
 * 说明 prompt 没给出可判别的判据 —— 那才是这次验证要抓的结论。
 */
function buildFixtures() {
  return [
    {
      id: 'verify-domain-check',
      toolSequence: ['terminal', 'file_read', 'file_write', 'terminal'],
      paramSignature: {
        terminal: 'command:str',
        file_read: 'path:str',
        file_write: 'path:str',
      },
      sampleArgs: {
        terminal: { command: 'node --test test/*.test.mjs' },
        file_read: { path: 'plugins/agint-cron/lib/index.js' },
        file_write: { path: 'plugins/agint-cron/lib/index.js' },
      },
      description: '改完 cron 插件后跑测试再核对 services 映射',
      occurrenceCount: 6,
      successRate: 0.83,
      windowText: [
        '先把 `services()` 的映射补上再重启，否则 job 拿到 undefined 会 soft-skip 且不报错',
        '上次漏了这条，跑了一整晚才发现 cron 一次都没触发',
      ].join('\n'),
    },
    {
      id: 'verify-generic-scaffold',
      toolSequence: ['file_read', 'file_write'],
      paramSignature: { file_read: 'path:str', file_write: 'path:str' },
      sampleArgs: { file_read: { path: 'a/b' }, file_write: { path: 'a/b' } },
      description: 'read → write',
      occurrenceCount: 12,
      successRate: 1,
      windowText: '',
    },
  ];
}

/**
 * 跑一次真模型验证。**永不抛错** —— 任何 host 端问题都进结果里的 reason。
 *
 * @param {object} args
 * @param {object} args.ctx
 * @param {string} [args.provider] 空 = 跟随宿主默认
 * @param {string} [args.model]    空 = 跟随宿主默认
 * @param {number} [args.timeoutMs]
 * @returns {Promise<object>} JSON-safe
 */
export async function runVerification({ ctx, provider = '', model = '', timeoutMs } = {}) {
  const cases = [];
  for (const fixture of buildFixtures()) {
    const t0 = Date.now();
    let out;
    try {
      out = await judgeViaLLM({
        ctx,
        pattern: fixture,
        windowText: fixture.windowText,
        provider,
        model,
        ...(timeoutMs ? { timeoutMs } : {}),
      });
    } catch (e) {
      // judgeViaLLM 契约上不抛，但验证脚本更不能因为一次异常整批中断
      out = { ok: true, mode: 'degraded', verdict: null, authoring: null, reason: `unexpected:${e?.message ?? e}`, attempted: false };
    }

    // 撰写产出再过一遍**生产用的同一道本地校验** —— 验证脚本不能只信
    // 「模型输出过 schema」，还要报告「它写的东西我们的门放不放行」。
    const guard = out.authoring ? validateLlmAuthoring(out.authoring) : null;

    cases.push({
      id: fixture.id,
      expect: fixture.id === 'verify-domain-check' ? 'standardizable=true' : 'standardizable=false',
      mode: out.mode,
      reason: out.reason ?? null,
      diagnostic: out.diagnostic ?? null,
      attempted: out.attempted ?? false,
      durationMs: Date.now() - t0,
      verdict: out.verdict,
      authoring: out.authoring,
      authoringRejected: guard?.rejection ?? null,
    });
  }

  const llmCases = cases.filter((c) => c.mode === 'llm');
  return {
    ok: llmCases.length > 0,
    provider: provider || '(host default)',
    model: model || '(host default)',
    cases,
    // 分辨力自检：两个反向样本给出不同结论才算「有用」。
    // 全 true / 全 false / 全 degraded 都要如实报出来。
    discriminated: llmCases.length === 2
      && llmCases[0].verdict?.standardizable === true
      && llmCases[1].verdict?.standardizable === false,
    degraded: cases.filter((c) => c.mode !== 'llm').map((c) => ({ id: c.id, reason: c.reason })),
  };
}
