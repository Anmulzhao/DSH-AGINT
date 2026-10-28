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
 *
 * ⛔ 工具入口必须叫 `execute`，不能叫 `handler`（2026-10-28 现场教训）。
 *    dsh-tools 的 `defineTool` 只读 `options.execute`（dsh-tools/lib/index.js:839
 *    `const userExecute = options.execute;`，:869 `return userExecute(args, exec);`），
 *    写 `handler` 的话工具**照样注册成功、名字和 schema 都在工具表里**，
 *    但一调用就抛 `TypeError: userExecute is not a function`。
 *    ⚠️ 这类错注册**不会被本仓库任何测试抓到**：mock 的 `tools.register`
 *    若只把工具塞进数组，就永远不会走 dsh-tools 那层 `execute` 包装。
 *    全仓 27 个用 defineTool 的插件里 26 个用 `execute` —— 跟随多数写法。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

/**
 * 把 `impactSummary` 压成一行。
 *
 * 只在有非零项时列出 —— 一屏里出现 `blocking 0 / breaking 0 / additive 0 …`
 * 这种全零行，读的人会训练成自动跳过，真出事那天也照样跳过。
 */
function impactLine(sum) {
  if (!sum || typeof sum !== 'object') return '';
  const order = ['blocking', 'breaking', 'elsewhere', 'additive', 'compatible', 'unknown'];
  const parts = order.filter((k) => (sum[k] ?? 0) > 0).map((k) => `${k} ${sum[k]}`);
  return parts.join(' / ');
}

/** 语义面 + 宿主主包一行（同样只在有话时说） */
function semanticLine(sem, host) {
  const parts = [];
  if (sem && typeof sem === 'object') {
    const total = (sem.blocker ?? 0) + (sem.warn ?? 0) + (sem.info ?? 0);
    if (total > 0) parts.push(`${total} 条（阻断 ${sem.blocker ?? 0} / 警示 ${sem.warn ?? 0}）`);
  }
  if (host && host.semanticImpact && host.semanticImpact !== 'unknown') {
    parts.push(`宿主主包 ${host.from ?? '?'}→${host.to ?? '?'} 语义 ${host.semanticImpact}`);
  }
  return parts.join('；');
}

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
                // v0.2 语义面摘要。⛔ 用字符串而不是嵌套对象：工具输出 schema 是
                // additionalProperties:false 的严格形态，嵌套层次越深越容易在下一次
                // 加字段时把工具整个打挂（2026-10-27 的现场教训见文件头）。
                impact: { required: true, type: 'string' },
                semantics: { required: true, type: 'string' },
                updatedAt: { required: true, type: 'string' },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        const lines = [
          `upstream_status: ${v.plugin} digest=${v.digestCount} model=${v.model} autoPropose=${v.autoPropose}${v.disabled ? '  ⚠️ 已禁用' : ''}`,
          `  stats: signaled=${v.stats.signaled} digested=${v.stats.digested} judged=${v.stats.judged} judgeFailed=${v.stats.judgeFailed} proposals=${v.stats.proposals} skipped=${v.stats.skipped}`,
        ];
        if (v.stats.lastTag) {
          lines.push(`  last: tag=${v.stats.lastTag} at=${v.stats.lastAt}${v.stats.lastError ? `  ⚠️ ${v.stats.lastError}` : ''}`);
        }
        const recent = v.recent ?? [];
        if (!recent.length) lines.push('  （还没有判读记录）');
        for (const r of recent) {
          lines.push(`  · ${r.tag} [${r.level}] llm=${r.llmStatus} verdict=${r.verdict || '-'}`);
          if (r.headline) lines.push(`      ${r.headline}`);
          if (r.impact) lines.push(`      影响：${r.impact}`);
          if (r.semantics) lines.push(`      语义：${r.semantics}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute() {
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
          impact: impactLine(r.impactSummary),
          semantics: semanticLine(r.semanticSummary, r.hostFace),
          updatedAt: r.updatedAt ?? '',
        })),
      };
    },
  }));

  // ── 只读：判读准不准（v0.3）──
  ctx.tools.register(defineTool({
    name: 'upstream_calibration',
    description: '查看上游判读器自己的准确度：哪些版本已经装上并对拍过、误报几个包、漏报几个包、错在哪个包的哪个符号。只读。当需要判断「这套判读到底靠不靠得住」时用这个 —— ⛔ 它不产合成分数，只给可核对的逐条记录。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: { required: true, type: 'string' },
          installedVersion: { required: true, type: 'string' },
          judged: { required: true, type: 'number' },
          evaluated: { required: true, type: 'number' },
          pending: { required: true, type: 'number' },
          packagesChecked: { required: true, type: 'number' },
          falsePositive: { required: true, type: 'number' },
          falseNegative: { required: true, type: 'number' },
          confirmed: { required: true, type: 'number' },
          falsePositiveRate: { required: true, type: 'number' },
          falseNegativeRate: { required: true, type: 'number' },
          lastEvaluatedAt: { required: true, type: 'string' },
          notes: { required: true, type: 'array', items: { type: 'string' } },
          rows: {
            required: true,
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tag: { required: true, type: 'string' },
                status: { required: true, type: 'string' },
                falsePositive: { required: true, type: 'number' },
                falseNegative: { required: true, type: 'number' },
                confirmed: { required: true, type: 'number' },
                unverifiable: { required: true, type: 'number' },
                evaluatedAt: { required: true, type: 'string' },
                reason: { required: true, type: 'string' },
                worstPkg: { required: true, type: 'string' },
                worstVerdict: { required: true, type: 'string' },
                worstNote: { required: true, type: 'string' },
              },
            },
          },
        },
      },
      render: (_a, v) => {
        const lines = [
          `upstream_calibration: state=${v.state} installed=${v.installedVersion}`,
          `  判读 ${v.judged} ／ 已对拍 ${v.evaluated} ／ 待对拍 ${v.pending} ｜ 包数 ${v.packagesChecked}`,
          `  误报 ${v.falsePositive}（率 ${v.falsePositiveRate}） 漏报 ${v.falseNegative}（率 ${v.falseNegativeRate}） 已确认 ${v.confirmed}`,
        ];
        if (v.lastEvaluatedAt) lines.push(`  lastEvaluatedAt=${v.lastEvaluatedAt}`);
        for (const n of v.notes ?? []) lines.push(`  注：${n}`);
        for (const r of v.rows ?? []) {
          lines.push(`  · ${r.tag} [${r.status}] fp=${r.falsePositive} fn=${r.falseNegative} ok=${r.confirmed} unverifiable=${r.unverifiable}`);
          if (r.worstPkg) lines.push(`      最差包：${r.worstPkg} ／ ${r.worstVerdict}${r.worstNote ? ` — ${r.worstNote}` : ''}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute() {
      const c = await api.calibration();
      return {
        state: c.state ?? 'unknown',
        installedVersion: c.installedVersion ?? '',
        judged: c.judged ?? 0,
        evaluated: c.evaluated ?? 0,
        pending: c.pending ?? 0,
        packagesChecked: c.packagesChecked ?? 0,
        falsePositive: c.counts?.falsePositive ?? 0,
        falseNegative: c.counts?.falseNegative ?? 0,
        confirmed: c.counts?.confirmed ?? 0,
        // ⛔ null（无样本）压成 -1 而不是 0：0% 会让「还没对拍过」看起来像「一次都没错」。
        falsePositiveRate: typeof c.falsePositiveRate === 'number' ? c.falsePositiveRate : -1,
        falseNegativeRate: typeof c.falseNegativeRate === 'number' ? c.falseNegativeRate : -1,
        lastEvaluatedAt: c.lastEvaluatedAt ?? '',
        notes: Array.isArray(c.notes) ? c.notes : [],
        rows: (c.rows ?? []).map((r) => ({
          tag: r.tag ?? '',
          status: r.status ?? '',
          falsePositive: r.falsePositive ?? 0,
          falseNegative: r.falseNegative ?? 0,
          confirmed: r.confirmed ?? 0,
          unverifiable: r.unverifiable ?? 0,
          evaluatedAt: r.evaluatedAt ?? '',
          reason: r.reason ?? '',
          worstPkg: r.worst?.pkg ?? '',
          worstVerdict: r.worst?.verdict ?? '',
          worstNote: r.worst?.note ?? '',
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
          impact: { required: true, type: 'string' },
          semantics: { required: true, type: 'string' },
          topSemanticDeltas: {
            required: true,
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { required: true, type: 'string' },
                symbol: { required: true, type: 'string' },
                severity: { required: true, type: 'string' },
                note: { required: true, type: 'string' },
              },
            },
          },
          proposalCount: { required: true, type: 'number' },
          autoExecutable: { required: true, type: 'boolean' },
        },
      },
      render: (_a, v) => {
        if (!v.ok) {
          return [{ type: 'text', text: `upstream_digest: 失败 tag=${v.tag || '(未确定)'} — ${v.error || '(无原因)'}` }];
        }
        const lines = [
          `upstream_digest: ${v.tag} [${v.level}] preStage=${v.preStageChange} llm=${v.llmStatus}${v.cached ? '（缓存）' : ''}`,
          `  结论：${v.verdict || '(无)'}（置信度 ${v.confidence}）`,
        ];
        if (v.headline) lines.push(`  ${v.headline}`);
        if (v.factsSummary) lines.push(`  事实：${v.factsSummary}`);
        if (v.impact) lines.push(`  影响：${v.impact}`);
        if (v.semantics) lines.push(`  语义：${v.semantics}`);
        for (const d of v.topSemanticDeltas ?? []) {
          lines.push(`  · [${d.severity}] ${d.kind} ${d.symbol}${d.note ? ` — ${d.note}` : ''}`);
        }
        if (v.llmReason) lines.push(`  ⚠️ LLM：${v.llmReason}`);
        lines.push(`  提案 ${v.proposalCount} 条（不可自动执行）`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute({ tag, force }) {
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
          confidence: 0, headline: '', factsSummary: '', impact: '', semantics: '',
          topSemanticDeltas: [], proposalCount: 0, autoExecutable: false,
        };
      }

      const r = await api.digest(target, { force: force === true, via: 'tool' });
      const d = r.digest ?? {};
      // 语义差异首条值钱（引擎/模块形态），所以按严重度已排序的前 5 条足够；
      // 全量在 storages 的 digests 表里，需要细看时读那份。
      const semDeltas = [
        ...(d.facts?.hostFace?.semanticDeltas ?? []),
        ...(d.facts?.depFace ?? []).flatMap((x) => x.semanticDeltas ?? []),
      ]
        .sort((a, b) => ({ blocker: 0, warn: 1, info: 2 }[a.severity] ?? 9) - ({ blocker: 0, warn: 1, info: 2 }[b.severity] ?? 9))
        .slice(0, 5)
        .map((x) => ({
          kind: x.kind ?? '', symbol: x.symbol ?? '', severity: x.severity ?? '', note: x.note ?? '',
        }));

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
        impact: impactLine(d.impactSummary ?? d.facts?.impactSummary),
        semantics: semanticLine(d.semanticSummary ?? d.facts?.semanticSummary, d.hostFace ?? d.facts?.hostFace),
        topSemanticDeltas: semDeltas,
        proposalCount: Array.isArray(d.proposalIds) ? d.proposalIds.length : 0,
        autoExecutable: false,
      };
    },
  }));
}
