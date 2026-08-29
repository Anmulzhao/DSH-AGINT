/**
 * agint-quality-report: D-QAF Phase 4 报告生成插件（Sprint 4.4 初版）
 *
 * 实现 QualityReporterIface（FROZEN 签名）：
 *   generate(results: EvalResult[], decision: Decision): Promise<{ markdown: string, json: object }>
 *
 * Service: `agint.qualityReporter`
 *   - .generate({ results, decision, meta? }): { markdown, json }
 *   - .writeToWiki({ markdown, json, slug, tags? }): wiki writer
 *   - .writeToMemory({ json, slug }): memory writer
 *
 * Sprint 4.4 范围:
 *   - 报告渲染（render.js 纯函数）
 *   - 写入 agint-wiki (slug='d-qaf-<ts>', tags=['d-qaf','sprint-4'])
 *   - 写入 agint-memory (type=decision)
 *
 * Row:
 *   - insert:
 *       - id: agint-quality-report
 *         name: ./plugins/agint-quality/agint-quality-report/lib/index.js
 *         config: {}
 */

import { z } from 'zod';
import { renderReport } from './render.js';

const name = 'agint-quality-report';
const inject = [];

const Config = z.object({
  /** 是否写入 agint.wiki（默认 true） */
  writeWiki: z.boolean().default(true),
  /** 是否写入 agint.memory（默认 true） */
  writeMemory: z.boolean().default(true),
  /** wiki slug 前缀 */
  wikiSlugPrefix: z.string().default('d-qaf'),
  /** 标签 */
  wikiTags: z.array(z.string()).default(['d-qaf', 'quality-report', 'sprint-4']),
}).optional();

function apply(ctx, config) {
  const cfg = Config.parse(config || {});
  let disposed = false;

  ctx.effect(() => () => {
    disposed = true;
    // Sprint 12 / A5: dispose 时退订 policy.deployed / policy.rolledback
    try {
      if (typeof _policyBusUnsubscribe === 'function') _policyBusUnsubscribe();
    } catch { /* ignore */ }
  });

  // ── Sprint 12 / A5 — T1 影子期：policy.deployed / policy.rolledback 观测行
  // 走 console + audit memory（不进入 HARM 报告输出——决策观测与报告输出解耦）
  // 软降级：event-bus 不可用 → log 不抛，原 generate / writeToWiki / writeToMemory 路径不受影响
  let _policyBusUnsubscribe = null;
  const _subscribeBus = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.subscribe') : null;
  if (_subscribeBus && typeof _subscribeBus === 'function') {
    try {
      _policyBusUnsubscribe = _subscribeBus(
        {
          subscriber: 'agint-quality-report',
          topics: ['policy.deployed', 'policy.rolledback'],
          mode: 'async',
          timeoutMs: 5000,
        },
        async (envelope) => {
          try {
            const topic = envelope?.topic ?? '';
            const payload = envelope?.payload ?? {};
            // console 观测行（必出，便于 shadow 期观察）
            if (!disposed) console.log(`[agint.qualityReport.observe] ${topic} target=${payload?.targetId ?? '?'} decision=${payload?.decision ?? '?'} score=${payload?.score ?? '?'}${payload?.rollbackTarget ? ` rollbackTarget=${payload.rollbackTarget}` : ''}`);
            // audit 通道：写入 memory[type=decision]
            const mem = ctx.get('agint.memory');
            if (mem && typeof mem.write === 'function') {
              await mem.write({
                type: 'decision',
                content: `[agint.qualityReport.observe] ${topic} target=${payload?.targetId ?? ''} decision=${payload?.decision ?? ''} score=${payload?.score ?? ''} reason=${payload?.reason ?? ''}${payload?.rollbackTarget ? ` rollbackTarget=${payload.rollbackTarget}` : ''}`,
                evidence: `agint-quality-report:policy-observe:${envelope?.id ?? '?'}`,
              });
            }
          } catch (err) {
            if (!disposed) console.error('[agint-quality-report] policy observe failed:', err?.message ?? err);
          }
        },
      );
    } catch (err) {
      if (!disposed) console.error('[agint-quality-report] eventBus.subscribe failed:', err?.message ?? err);
      _policyBusUnsubscribe = null;
    }
  }

  /**
   * Generate report. Mirrors QualityReporterIface (FROZEN).
   */
  async function generate({ results, decision, meta } = {}) {
    if (disposed) throw new Error('agint-quality-report: disposed');
    if (!Array.isArray(results)) throw new Error('agint-quality-report: results must be an array');
    if (!decision || typeof decision.kind !== 'string') {
      throw new Error('agint-quality-report: decision with .kind is required');
    }
    return renderReport({ results, decision, meta });
  }

  /**
   * Write the report to agint-wiki (best-effort; log warn if unavailable).
   */
  async function writeToWiki({ markdown, json, slug, tags } = {}) {
    const wiki = ctx.get('agint.wiki');
    if (!wiki || typeof wiki.write !== 'function') {
      console.warn('[agint-quality-report] agint.wiki unavailable; report not persisted');
      return null;
    }
    const finalSlug = slug ?? `${cfg.writeWiki ? cfg.wikiSlugPrefix : 'report'}-${json.generatedAt ?? new Date().toISOString()}`;
    const finalTags = tags ?? cfg.wikiTags;
    return await wiki.write({
      path: `quality/${finalSlug}.md`,
      content: markdown,
      tags: finalTags,
      frontmatter: {
        generatedAt: json.generatedAt,
        decision: json.decision?.kind,
        score: json.decision?.score,
        policyId: json.decision?.policyId,
        targetCount: json.summary?.targetCount,
      },
    });
  }

  /**
   * Write the JSON sidecar to agint-memory (type=decision).
   */
  async function writeToMemory({ json, slug } = {}) {
    const memory = ctx.get('agint.memory');
    if (!memory || typeof memory.write !== 'function') {
      console.warn('[agint-quality-report] agint.memory unavailable; memory audit not persisted');
      return null;
    }
    return await memory.write({
      type: 'decision',
      content: `[agint.qualityReport] ${json.decision?.kind} score=${json.decision?.score} targets=${json.summary?.targetCount} slug=${slug ?? ''}`,
      evidence: `agint-quality-report:${json.generatedAt ?? new Date().toISOString()}`,
    });
  }

  /**
   * Convenience: generate + write wiki + memory.
   * Returns the full report plus the write receipts.
   */
  async function generateAndPersist({ results, decision, meta, slug, tags } = {}) {
    const report = await generate({ results, decision, meta });
    const wikiReceipt = cfg.writeWiki ? await writeToWiki({ ...report, slug, tags }) : null;
    const memoryReceipt = cfg.writeMemory ? await writeToMemory({ json: report.json, slug }) : null;
    return { ...report, wiki: wikiReceipt, memory: memoryReceipt };
  }

  function health() {
    return { config: cfg, serviceAvailable: true, sprint: 'v0.4' };
  }

  ctx.provide('agint.qualityReporter', {
    generate,
    writeToWiki,
    writeToMemory,
    generateAndPersist,
    health,
    config: cfg,
    render: renderReport,
  });
}

export { Config, apply, inject, name };
