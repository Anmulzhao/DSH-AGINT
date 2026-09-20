/**
 * agint-search-tools: preset-scoped unified search across `agint.memory` and
 * `agint.wiki`. Consumes the host services; registers the `agint_search` tool
 * for this preset only.
 *
 * Same consumer pattern as agint-memory-tools / agint-wiki-tools: publishes
 * nothing, resolves the host instances, needs no isolate realm.
 *
 * Preset row (agent.cordis.yml):
 *
 *   - id: agint-search-tools
 *     name: ./plugins/agint-search-tools/lib/tools.js
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-search-tools';
const inject = ['agint.memory', 'agint.wiki', 'tools'];

function apply(ctx) {
  const memory = ctx['agint.memory'];
  const wiki = ctx['agint.wiki'];
  if (!memory || !wiki) return;

  ctx.tools.register(defineTool({
    name: 'agint_search',
    description:
      'Cross-domain unified search across agint memory (long-term principles) ' +
      'and agint wiki (knowledge files). Returns a merged list of hits tagged ' +
      'by source. Use this before manually cross-referencing memory_search + ' +
      'wiki_search.',
    parameters: {
      query: { type: 'string', required: true, description: 'Keyword(s) to match.' },
      sources: {
        type: 'array',
        items: { type: 'string', enum: ['memory', 'wiki'] },
        description: 'Limit search to these sources (default both).',
      },
      type: {
        type: 'string',
        enum: ['lesson', 'decision', 'preference', 'pattern'],
        description: 'Memory-only: filter by entry type.',
      },
      domain: {
        type: 'string',
        description: 'Wiki-only: domain prefix (e.g. "AGINT/").',
      },
      limit: { type: 'integer', description: 'Max total hits (default 20).' },
    },
    output: {
      // K21: raw JSON Schema form. `required` is array on parent object.
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['hits', 'counts'],
        properties: {
          hits: {
            type: 'array',
            items: {
              // additionalProperties: true because hit shape is a projection;
              // memory entries may carry extra fields (lineageKey, etc) we
              // don't enumerate here.
              type: 'object',
              additionalProperties: true,
              required: ['source'],
              properties: {
                source: { type: 'string' },
                id: { type: 'string' },
                path: { type: 'string' },
                title: { type: 'string' },
                snippet: { type: 'string' },
                type: { type: 'string' },
                confidence: { type: 'number' },
                line: { type: 'integer' },
              },
            },
          },
          counts: {
            type: 'object',
            additionalProperties: true,
            required: ['memory', 'wiki'],
            properties: {
              memory: { type: 'integer' },
              wiki: { type: 'integer' },
            },
          },
        },
      },
      render(_a, v) {
        if (!v.hits || v.hits.length === 0) {
          return [{ type: 'text', text: `agint_search: no hits (memory=${v.counts?.memory || 0}, wiki=${v.counts?.wiki || 0})` }];
        }
        const lines = v.hits.map((h) => {
          const tag = h.source;
          const id = h.id
            ? `[${h.id}]`
            : (h.path ? `${h.path}:${h.line || 0}` : '?');
          const snippet = h.snippet || h.content || '';
          return `[${tag}] ${id} ${snippet.slice(0, 160)}`;
        });
        return [{
          type: 'text',
          text: `agint_search: ${v.hits.length} hit(s) (memory=${v.counts.memory}, wiki=${v.counts.wiki})\n` + lines.join('\n'),
        }];
      },
    },
    async execute(args) {
      const sources = Array.isArray(args.sources) && args.sources.length > 0
        ? args.sources
        : ['memory', 'wiki'];
      const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 20;

      const hits = [];
      const counts = { memory: 0, wiki: 0 };

      if (sources.includes('memory')) {
        const opts = {};
        if (args.type) opts.type = args.type;
        const results = await memory.search(args.query, opts);
        for (const r of results) {
          hits.push({
            source: 'memory',
            id: r.id,
            title: `[${r.type}/${r.level}] ${(r.content || '').slice(0, 80)}`,
            snippet: r.content,
            type: r.type,
            confidence: r.confidence,
          });
        }
        counts.memory = results.length;
      }

      if (sources.includes('wiki')) {
        const opts = {};
        if (args.domain) opts.domain = args.domain;
        const results = await wiki.search(args.query, opts);
        for (const r of results) {
          hits.push({
            source: 'wiki',
            path: r.path,
            line: r.line,
            title: r.path,
            snippet: r.snippet,
          });
        }
        counts.wiki = results.length;
      }

      // Naive merge: keep insertion order (memory first, then wiki), truncate.
      // Memory entries are already ranked by effectiveConfidence; wiki entries
      // are sorted by path by the underlying service. A real ranking belongs
      // in a later iteration once we have hit-scoring from either side.
      return { hits: hits.slice(0, limit), counts };
    },
  }));
}

export { apply, inject, name };