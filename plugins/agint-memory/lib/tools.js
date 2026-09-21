/**
 * agint-memory: preset-scoped memory tools (memory_read/write/search/stats/
 * forget_scan). Consumes the host `agint.memory` service; registered from the
 * agint preset so only 智进 sessions see these tools.
 *
 * Preset row (agent.agint.yml):
 *   - id: agint-memory-tools
 *     name: agint-memory/lib/tools.js
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-memory-tools';
const inject = ['tools', 'agint.memory'];

const TYPES = ['lesson', 'decision', 'preference', 'pattern'];
const LEVELS = ['L1', 'L2', 'L3', 'L4'];

function apply(ctx) {
  const memory = ctx['agint.memory'];

  ctx.tools.register(defineTool({
    name: 'memory_write',
    description:
      'Write a memory entry into 智进 long-term memory (principles layer). Creates a new entry or updates by id. ' +
      'Types: lesson=教训/禁止项 (must carry evidence), decision=重要决策, preference=用户偏好, pattern=规律/模式. ' +
      'Use before answering when something here could change the answer; keep content one concise self-contained statement.',
    parameters: {
      content: { type: 'string', required: true, description: 'One concise, self-contained statement.' },
      type: { type: 'string', required: true, enum: TYPES, description: 'Entry type.' },
      id: { type: 'string', description: 'Existing entry id to update (omit to create).' },
      evidence: { type: 'string', description: 'Evidence string (tool+action+location) — required for lessons.' },
      level: { type: 'string', enum: LEVELS, description: 'Decay level (default L1).' },
      confidence: { type: 'number', description: '0..1 confidence (default 0.5).' },
    },
    output: {
      // memory.write returns the full memorySchema record (14 fields since P0
      // added lineageKey/supersedesKey). The previous schema only declared 7;
      // the rest caused DSH strict-mode to drop the response.
      //
      // DSH JSON-schema subset (see dsh-tools/lib/types/json-schema.js):
      //   - `required` is an array of property names, attached to the OBJECT
      //     schema (not to each property). It also may not coexist with
      //     `oneOf` (siblings are mutually exclusive).
      //   - For nullable fields we declare the union via `oneOf` and rely on
      //     `render()` to format null cleanly.
      schema: {
        type: 'object', additionalProperties: false,
        // required 已迁移至各属性（value schema DSL: 属性上的布尔 required: true）
        properties: {
          id: { required: true, type: 'string' },
          type: { required: true, type: 'string' },
          content: { required: true, type: 'string' },
          level: { required: true, type: 'string' },
          confidence: { required: true, type: 'number' },
          lastRecall: { required: true, type: 'string' },
          recalls: { required: true, type: 'integer' },
          evidence: { required: true, type: 'string' },
          resolved: { required: true, type: 'boolean' },
          replacedBy: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          lineageKey: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          supersedesKey: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          createdAt: { required: true, type: 'string' },
          updatedAt: { required: true, type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: `memory_write: saved ${v.id} (${v.type}/${v.level}, confidence ${v.confidence})${v.lineageKey ? ' · lineage=' + v.lineageKey : ''}` }],
    },
    execute(args) {
      return memory.write(args);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description:
      'Search 智进 long-term memory by keyword, ranked by effective confidence. ' +
      'Call this before answering anything that prior lessons, decisions, or preferences might cover.',
    parameters: {
      query: { type: 'string', required: true, description: 'Keyword(s) to match against content/evidence.' },
      type: { type: 'string', enum: TYPES, description: 'Optional type filter.' },
      limit: { type: 'integer', description: 'Max results (default 20).' },
    },
    output: {
      // Search returns the full entry shape (memorySchema 12 fields), not a
      // projection — strict-mode declared only 5 and dropped 7 fields per item.
      // Raw JSON Schema form required by DSH (`required` lives on the parent
      // object as an array, not on each property; not allowed beside `oneOf`).
      schema: {
        type: 'object', additionalProperties: false,
        // required 已迁移至各属性（value schema DSL: 属性上的布尔 required: true）
        properties: {
          results: { required: true,
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              // required 已迁移至各属性（value schema DSL: 属性上的布尔 required: true）
              properties: {
                id: { required: true, type: 'string' },
                type: { required: true, type: 'string' },
                content: { required: true, type: 'string' },
                level: { required: true, type: 'string' },
                confidence: { required: true, type: 'number' },
                lastRecall: { required: true, type: 'string' },
                recalls: { required: true, type: 'integer' },
                evidence: { required: true, type: 'string' },
                resolved: { required: true, type: 'boolean' },
                replacedBy: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                lineageKey: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                supersedesKey: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                createdAt: { required: true, type: 'string' },
                updatedAt: { required: true, type: 'string' },
              },
            },
          },
        },
      },
      render: (_a, v) => v.results.length === 0
        ? [{ type: 'text', text: 'memory_search: no matches' }]
        : [{ type: 'text', text: v.results.map((r) => `• [${r.type}/${r.level}] ${r.content}`).join('\n') }],
    },
    execute(args) {
      return memory.search(args.query, { type: args.type, limit: args.limit }).then((results) => ({ results }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description: 'Read one 智进 memory entry by id.',
    parameters: { id: { type: 'string', required: true, description: 'Entry id (from memory_search / memory_write).' } },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { entry: { type: 'object', additionalProperties: true } },
      },
      render: (_a, v) => [{ type: 'text', text: v.entry ? JSON.stringify(v.entry, null, 2) : 'memory_read: not found' }],
    },
    execute(args) {
      return memory.read(args.id).then((entry) => ({ entry }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_stats',
    description: 'Overview of 智进 long-term memory: counts by type and decay level, average confidence.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        // required 已迁移至各属性（value schema DSL: 属性上的布尔 required: true）
        properties: { stats: { required: true, type: 'object', additionalProperties: true } },
      },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v.stats, null, 2) }],
    },
    execute() {
      return memory.stats().then((stats) => ({ stats }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'memory_forget_scan',
    description:
      'Run the L1-L4 forgetting scan. Dry-run by default (reports planned actions only). ' +
      'With apply:true, downgrades stale entries and clears L4 entries that are resolved/replaced and 730+ days stale. ' +
      'Use periodically or when memory_stats shows bloat.',
    parameters: {
      apply: { type: 'boolean', description: 'Apply decay actions (default false = dry run).' },
    },
    output: {
      // decayScanRun returns { actions, report, applied }; the previous schema
      // dropped `report`. Keep report as additionalProperties:true so its inner
      // shape ({scanned, counts:{downgrade,clear}, generatedAt}) passes.
      // Raw JSON Schema form: `required` is array on parent object, not on
      // each property (array/string fields reject `required`).
      schema: {
        type: 'object', additionalProperties: false,
        // required 已迁移至各属性（value schema DSL: 属性上的布尔 required: true）
        properties: {
          actions: { required: true, type: 'array', items: { type: 'object', additionalProperties: true } },
          applied: { required: true, type: 'array', items: { type: 'object', additionalProperties: true } },
          report: { required: true, type: 'object', additionalProperties: true },
        },
      },
      render: (_a, v) => [
        { type: 'text', text: `memory_forget_scan: ${v.actions.length} planned, ${v.applied.length} applied\n${v.actions.map((a) => `  ${a.id}: ${a.action} ${a.from ? `${a.from}->` : ''}${a.to ?? 'clear'} (${a.reason})`).join('\n')}` },
      ],
    },
    execute(args) {
      return memory.decayScanRun({ apply: Boolean(args.apply) }).then(({ actions, report, applied }) => ({ actions, report, applied }));
    },
  }));
}

export { apply, inject, name };
