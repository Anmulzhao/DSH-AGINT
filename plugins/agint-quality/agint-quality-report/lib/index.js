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
  });

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
