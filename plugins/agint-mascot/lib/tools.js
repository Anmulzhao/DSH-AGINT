// SPDX-License-Identifier: MIT
// Copyright (c) 2026 anmul
// AGINT 新增文件。许可见 DSH-AGINT/LICENSE（MIT）。

/**
 * agint-mascot · tools: the read-only inspection surface.
 *
 * One tool. It exists so the verdict can be checked from a session without
 * opening the GUI and without trusting the pet's rendering. Read-only by
 * construction: it re-runs the same probes the bubble is built from and
 * returns the same object, so what it says and what the pet shows cannot
 * drift apart.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

/** One probe row in the tool output. */
const probeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { required: true, type: 'string' },
    state: { required: true, type: 'string' },
    detail: { type: 'string' },
  },
};

/**
 * Register the tool if the host exposes a tool registry.
 *
 * `tools` is an optional inject, so a host without it must not turn this
 * plugin into a boot failure. The service `agint.mascot` is the primary
 * surface; the tool is a convenience.
 *
 * @param {object} ctx
 * @param {object} api - the accessors wired in index.js.
 */
export function registerMascotTools(ctx, api) {
  let tools;
  try {
    tools = ctx.get('tools', false);
  } catch {
    return false;
  }
  if (tools === undefined || typeof tools.register !== 'function') return false;

  tools.register(defineTool({
    name: 'mascot_status',
    description:
      '查看 AGINT 桌宠当前呈现的健康判定：四个状态源（cron / metrics / selfModel / 插件通电）逐源的 ok/warn/error/absent，' +
      '聚合后的 tone 与百分比，以及最近一次推进宠物气泡的结果。用于核对「脸的颜色对不对」。' +
      '读不到的状态源报 absent 或 warn，不报 0。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tone: { required: true, type: 'string' },
          percent: { required: true, type: 'integer' },
          headline: { required: true, type: 'string' },
          note: { required: true, type: 'string' },
          errorCount: { required: true, type: 'integer' },
          unknownCount: { required: true, type: 'integer' },
          pollMs: { required: true, type: 'integer' },
          enabled: { required: true, type: 'boolean' },
          lastPush: { required: true, type: 'string' },
          sources: { required: true, type: 'array', items: probeSchema },
        },
      },
      render: (_a, v) => {
        const lines = [`mascot_status: tone=${v.tone} percent=${v.percent} enabled=${v.enabled}`];
        lines.push(`  ${v.headline}（${v.note}）`);
        for (const s of v.sources) lines.push(`  [${s.state}] ${s.id}${s.detail ? ` — ${s.detail}` : ''}`);
        lines.push(`  lastPush=${v.lastPush} pollMs=${v.pollMs}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute() {
      const health = await api.collect();
      return {
        tone: health.tone,
        percent: health.percent,
        headline: health.headline,
        note: health.note,
        errorCount: health.errorCount,
        unknownCount: health.unknownCount,
        pollMs: api.pollMs(),
        enabled: api.isEnabled(),
        lastPush: api.lastPush().result,
        sources: health.sources.map((s) => ({ id: s.id, state: s.state, ...(s.detail ? { detail: s.detail } : {}) })),
      };
    },
  }));

  return true;
}
