/**
 * agint-wiki: preset-scoped wiki tools (wiki_read/write/search/list/lint).
 * Consumes the host `agint.wiki` service; registered from the agint preset so
 * only 智进 sessions see them.
 *
 * Preset row (agent.agint.yml):
 *   - id: agint-wiki-tools
 *     name: ../../plugins/agint-wiki/lib/tools.js
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-wiki-tools';
const inject = ['tools', 'agint.wiki'];

function apply(ctx) {
  const wiki = ctx['agint.wiki'];

  ctx.tools.register(defineTool({
    name: 'wiki_write',
    description:
      'Write or update a wiki knowledge entry. Path is relative to the wiki root (e.g. "行业/光伏.md" or "AGINT/复盘-2026-08.md"), must end in .md. ' +
      'Knowledge layer: use for accumulating research, references, and analysis. Principles (教训/决策/偏好) belong in memory_write, not here.',
    parameters: {
      path: { type: 'string', required: true, description: 'Relative wiki path ending in .md.' },
      content: { type: 'string', required: true, description: 'Full markdown content. Follow WIKI_SCHEMA.md (cite sources with file+line).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
        },
      },
      render: (_a, v) => [{ type: 'text', text: `wiki_write: saved ${v.path} (${v.bytes} bytes)` }],
    },
    execute(args) {
      return wiki.write(args.path, args.content);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'wiki_read',
    description: 'Read one wiki entry by relative path (must end in .md).',
    parameters: {
      path: { type: 'string', required: true, description: 'Relative wiki path ending in .md.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          entry: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.entry ? `# ${v.entry.path}\n\n${v.entry.content}` : `wiki_read: no entry at ${v.entry === null ? '(path)' : ''}` }],
    },
    execute(args) {
      return wiki.read(args.path).then((entry) => ({ entry }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'wiki_search',
    description: 'Search wiki entries by keyword. Use before answering anything that existing research/notes might cover (companies, industries, tech references).',
    parameters: {
      query: { type: 'string', required: true, description: 'Keyword(s) to match against entry content.' },
      domain: { type: 'string', description: 'Optional domain filter (e.g. "行业").' },
      limit: { type: 'integer', description: 'Max results (default 50).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          results: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                snippet: { type: 'string', required: true },
                line: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_a, v) => v.results.length === 0
        ? [{ type: 'text', text: 'wiki_search: no matches' }]
        : [{ type: 'text', text: v.results.map((r) => `${r.path}:${r.line}  ${r.snippet}`).join('\n') }],
    },
    execute(args) {
      return wiki.search(args.query, { domain: args.domain, limit: args.limit }).then((results) => ({ results }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'wiki_list',
    description: 'List wiki entries, optionally filtered by domain.',
    parameters: {
      domain: { type: 'string', description: 'Optional domain filter (e.g. "行业").' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          entries: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                size: { type: 'integer', required: true },
                mtime: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_a, v) => v.entries.length === 0
        ? [{ type: 'text', text: 'wiki_list: empty' }]
        : [{ type: 'text', text: v.entries.map((e) => `${e.path} (${e.size}B, ${e.mtime.slice(0, 10)})`).join('\n') }],
    },
    execute(args) {
      return wiki.list(args.domain).then((entries) => ({ entries }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'wiki_lint',
    description: 'Run wiki health checks: broken internal links, contradiction markers (⚠️), orphan entries. Use periodically or after bulk edits.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          report: { type: 'object', required: true, additionalProperties: true },
        },
      },
      render: (_a, v) => {
        const r = v.report;
        const parts = [`wiki_lint: ${r.checked} entries, ${r.brokenLinks.length} broken links, ${r.contradictions.length} contradictions, ${r.orphans.length} orphans`];
        r.brokenLinks.slice(0, 5).forEach((b) => parts.push(`  broken: ${b.from} -> ${b.target}`));
        r.contradictions.slice(0, 5).forEach((c) => parts.push(`  ⚠️ contradiction: ${c}`));
        r.orphans.slice(0, 5).forEach((o) => parts.push(`  orphan: ${o}`));
        return [{ type: 'text', text: parts.join('\n') }];
      },
    },
    execute() {
      return wiki.lint().then((report) => ({ report }));
    },
  }));
}

export { apply, inject, name };
