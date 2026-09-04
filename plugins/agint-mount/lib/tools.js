/**
 * agint-mount: preset-scoped mount tools (v0.6.6).
 * Batch 1: status only (read-only). request/rollback deferred to Batch 2.
 *
 * Schema policy: K19 — `additionalProperties: true`; tighten after live call.
 *
 * v0.6.6 fix (2026-09-04): ticketId is optional — when omitted, the host
 * service returns a dry-run listing of all non-terminal tickets. Backward-
 * compatible: existing callers passing a ticketId see the same single-result
 * shape (with an added `mode: 'single'` envelope).
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-mount-tools';
const inject = ['tools', 'agint.mount.status'];

function apply(ctx) {
  const status = ctx['agint.mount.status'];

  ctx.tools.register(defineTool({
    name: 'mount_status',
    description:
      'Read-only mount status for a ticket id (or list pending if no id given). ' +
      'Returns ticket state machine snapshot (4 states per design §).',
    parameters: {
      ticketId: { type: 'string', description: 'Ticket id (omit to list pending tickets).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute(args) {
      return status(args.ticketId);
    },
  }));
}

export { apply, inject, name };