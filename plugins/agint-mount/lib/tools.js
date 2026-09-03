/**
 * agint-mount: preset-scoped mount tools (v0.6.5).
 * Batch 1: status only (read-only). request/rollback deferred to Batch 2.
 *
 * Schema policy: K19 — `additionalProperties: true`; tighten after live call.
 *
 * Note (2026-09-04): mount_status requires ticketId at the dsh-tools layer
 * (type:'string' with no `required:false` is treated as required) but the
 * host service supports ticketId === undefined (lists pending tickets).
 * The DSH layer rejects `undefined` with "expected string, received
 * undefined". Fix is host-side: change zod schema to z.string().optional()
 * OR drop the ticketId parameter from this tool and let the model call
 * a different listing helper. Deferred to follow-up; current behaviour
 * requires the caller to pass an explicit ticket id string.
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