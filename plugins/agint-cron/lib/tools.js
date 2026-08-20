/**
 * agint-cron: preset-scoped tools (cron_list / cron_run_now / cron_health).
 * Consumes the host agint.cron service.
 *
 * Preset row (agent.agint.yml):
 *   - id: agint-cron-tools
 *     name: ../../plugins/agint-cron/lib/tools.js
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

// Format an ISO timestamp in the host's local timezone with offset,
// e.g. "2026-08-21T03:00:00+08:00". Falls back to the raw string when
// the input is not parseable (so 'never' / 'n/a' pass through cleanly).
const HOST_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
function toLocalIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // sv-SE locale yields ISO-ish yyyy-mm-dd HH:MM:ss; rejoin with 'T' and append offset.
  const local = d.toLocaleString('sv-SE', {
    timeZone: HOST_TZ,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const isoLike = local.replace(' ', 'T');
  const offsetMin = -d.getTimezoneOffset(); // local minus UTC, minutes
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const offset = sign + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0');
  return isoLike + offset;
}

const name = 'agint-cron-tools';
const inject = ['tools', 'agint.cron'];

function apply(ctx) {
  const cron = ctx['agint.cron'];

  ctx.tools.register(defineTool({
    name: 'cron_list',
    description: 'List all scheduled cron jobs with their schedule, last run, next scheduled run, and current health.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          jobs: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                schedule: { type: 'string', required: true },
                description: { type: 'string', required: true },
                lastRunAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                nextRunAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                lastOk: { oneOf: [{ type: 'boolean' }, { type: 'null' }], required: true },
                lastError: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                running: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_a, v) => v.jobs.length === 0
        ? [{ type: 'text', text: 'cron_list: no jobs' }]
        : [{
            type: 'text',
            text: v.jobs.map((j) => {
              const last = j.lastRunAt ? toLocalIso(j.lastRunAt).slice(0, 25) : 'never';
              const next = j.nextRunAt ? toLocalIso(j.nextRunAt).slice(0, 25) : 'n/a';
              return `${j.id.padEnd(18)} ${j.schedule.padEnd(12)} last=${last}  next=${next}  ${j.running ? '[running]' : (j.lastError ? '[ERROR: ' + j.lastError + ']' : '')}`;
            }).join('\n'),
          }],
    },
    execute() {
      // agint.cron.list() is synchronous (returns the array directly).
      return Promise.resolve(cron.list()).then((jobs) => ({ jobs }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cron_run_now',
    description: 'Manually trigger a cron job by id. Returns the job result or error. Use to test or backfill.',
    parameters: {
      id: { type: 'string', required: true, description: 'Job id (e.g. "memory-decay", "wiki-lint").' },
    },
    output: {
      // cron.runNow returns { ok, lastResult, lastError }. lastResult is the
      // job's own return value (object) when ok=true, or null when failed.
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          lastResult: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }], required: true },
          lastError: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: v.ok ? 'cron_run_now: OK' : ('cron_run_now: FAILED — ' + v.lastError),
      }],
    },
    execute(args) {
      return cron.runNow(args.id);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cron_health',
    description: 'Report cron health: overdue jobs, missed windows, last-run timestamps. Use if cron_list shows stale data.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          health: { type: 'object', required: true, additionalProperties: true },
        },
      },
      render: (_a, v) => {
        const h = v.health;
        const lines = [`cron_health: ${h.healthy ? 'healthy' : h.issues.length + ' issues'}`];
        h.issues.forEach((i) => lines.push(`  ! ${i.id}: ${i.reason}`));
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute() {
      // agint.cron.health() is synchronous.
      return Promise.resolve(cron.health()).then((health) => ({ health }));
    },
  }));
}

export { apply, inject, name };