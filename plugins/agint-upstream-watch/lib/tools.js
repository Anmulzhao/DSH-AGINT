/**
 * agint-upstream-watch — 工具面。
 *
 * 两个工具，一个只读一个写：
 *   `upstream_status`  只读：判读器状态 + 最近几次判读（排障先看这个）
 *   `upstream_digest`  写：手动判读某个版本（会写事实、可能写提案）
 *
 * ⛔ 返回体里出现的每个字段都必须在 output.schema 里声明，
 *    且 schema 是 `additionalProperties: false`。2026-10-27 的现场教训：
 *    返回体里有、schema 里没声明的字段，会被 DSH 的 strict 校验直接判失败，
 *    表现为「工具每次都报错但错误信息看不出缺哪个字段」。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

export function registerTools(ctx, api) {
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') return;

  // ── 只读 ──
  ctx.tools.register(defineTool({
    name: 'upstream_status',
    description: '查看上游判读器（agint-upstream-watch）的状态：已判读多少个 dsh 版本、各版本的 LLM 判读是成功还是失败、最近几次结论。只读，零副作用。当需要回答「dsh 最近有新版吗、对我们有影响吗」时先看这个。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plugin: { required: true, type: 'string' },
          disabled: { required: true, type: 'boolean' },
          digestCount: { required: true, type: 'number' },
          model: { required: true, type: 'string' },
          autoPropose: { required: true, type: 'boolean' },
          stats: {
            required: true,
            type: 'object',
            additionalProperties: false,
            properties: {
              signaled: { required: true, type: 'number' },
              digested: { required: true, type: 'number' },
              judged: { required: true, type: 'number' },
              judgeFailed: { required: true, type: 'number' },
              proposals: { required: true, type: 'number' },
              skipped: { required: true, type: 'number' },
              lastAt: { required: true, type: 'string' },
              lastTag: { required: true, type: 'string' },
              lastError: { required: true, type: 'string' },
            },
          },
          recent: {
            required: true,
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tag: { required: true, type: 'string' },
                level: { required: true, type: 'string' },
                llmStatus: { required: true, type: 'string' },
                verdict: { required: true, type: 'string' },
                headline: { required: true, type: 'string' },
                factsSummary: { required: true, type: 'string' },
                updatedAt: { required: true, type: 'string' },
              },
            },
          },
        },
      },
    },
    async handler() {
      const s = await api.status();
      return {
        plugin: s.plugin,
        disabled: s.disabled,
        digestCount: s.digestCount,
        model: s.config?.model ?? '(default)',
        autoPropose: s.config?.autoPropose !== false,
        stats: {
          signaled: s.stats.signaled ?? 0,
          digested: s.stats.digested ?? 0,
          judged: s.stats.judged ?? 0,
          judgeFailed: s.stats.judgeFailed ?? 0,
          proposals: s.stats.proposals ?? 0,
          skipped: s.stats.skipped ?? 0,
          lastAt: s.stats.lastAt ?? '',
          lastTag: s.stats.lastTag ?? '',
          lastError: s.stats.lastError ?? '',
        },
        recent: (s.recent ?? []).map((r) => ({
          tag: r.tag ?? '',
          level: r.level ?? '',
          llmStatus: r.llmStatus ?? '',
          verdict: r.verdict ?? '',
          headline: r.headline ?? '',
          factsSummary: r.factsSummary ?? '',
          updatedAt: r.updatedAt ?? '',
        })),
      };
    },
  }));

  // ── 写：会落事实，可能产提案 ──
  ctx.tools.register(defineTool({
    name: 'upstream_digest',
    description: '手动判读一个 dsh 发行版本：拉 release 正文 → 实测 AGINT 用到的上游 API 有没有变 → 判读机会与缺口。会写入判读记录；若判读成功且确有值得做的事，会写一条**不可自动执行**的提案（需人工批准）。⛔ 它不会、也不能安装或升级 dsh。',
    parameters: {
      tag: { type: 'string', description: '发行版本 tag，如 dsh-v0.2.2-alpha.2。省略则用当前 npm latest' },
      force: { type: 'boolean', description: '已判读过的版本是否重判（默认 false，幂等）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { required: true, type: 'boolean' },
          tag: { required: true, type: 'string' },
          cached: { required: true, type: 'boolean' },
          error: { required: true, type: 'string' },
          level: { required: true, type: 'string' },
          preStageChange: { required: true, type: 'string' },
          llmStatus: { required: true, type: 'string' },
          llmReason: { required: true, type: 'string' },
          verdict: { required: true, type: 'string' },
          confidence: { required: true, type: 'number' },
          headline: { required: true, type: 'string' },
          factsSummary: { required: true, type: 'string' },
          proposalCount: { required: true, type: 'number' },
          autoExecutable: { required: true, type: 'boolean' },
        },
      },
    },
    async handler({ tag, force }) {
      let target = String(tag ?? '').trim();
      if (!target) {
        // 没给 tag 就用 npm 的 alpha 轨（最新），退 latest
        try {
          const res = await fetch('https://registry.npmjs.org/@deepseek-ai%2Fdsh', {
            headers: { 'user-agent': 'agint-upstream-watch' },
            signal: AbortSignal.timeout(10_000),
          });
          const json = await res.json();
          const t = json?.['dist-tags']?.alpha || json?.['dist-tags']?.latest;
          if (t) target = `dsh-v${t}`;
        } catch { /* 落到下面的错误 */ }
      }
      if (!target) {
        return {
          ok: false, tag: '', cached: false, error: '无法确定目标版本（未给 tag 且 npm 不可达）',
          level: '', preStageChange: '', llmStatus: '', llmReason: '', verdict: '',
          confidence: 0, headline: '', factsSummary: '', proposalCount: 0, autoExecutable: false,
        };
      }

      const r = await api.digest(target, { force: force === true, via: 'tool' });
      const d = r.digest ?? {};
      return {
        ok: r.ok === true,
        tag: target,
        cached: r.cached === true,
        error: r.error ?? '',
        level: d.level ?? '',
        preStageChange: d.preStageChange ?? '',
        llmStatus: d.llmStatus ?? '',
        llmReason: d.llmReason ?? '',
        verdict: d.verdict ?? '',
        confidence: typeof d.confidence === 'number' ? d.confidence : 0,
        headline: d.headline ?? '',
        factsSummary: d.factsSummary ?? '',
        proposalCount: Array.isArray(d.proposalIds) ? d.proposalIds.length : 0,
        autoExecutable: false,
      };
    },
  }));
}
