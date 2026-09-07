/**
 * agint-abtest: preset-scoped model-facing tools (v0.6.4 → v0.6.5 K19-fix).
 *
 * Consumes the host `agint.abtest` service (registered from
 * profiles/web/cordis.patch.yml as a host row). Exposes three tools:
 *   - abtest_list_tests  read-only  listTests()
 *   - abtest_report      read+write report({ testId }) — side-effect: marks test status
 *   - abtest_start       write      start({ variantA, variantB, taskSuite, ... })
 *
 * Per editing-cordis-compositions: consumer pattern, no isolate realm.
 *
 * K19 schema policy (2026-09-07 fix):
 *   - All output schemas use `additionalProperties: true` on nested objects
 *     because the host service `agint.abtest` returns shapes that may include
 *     fields not declared here.
 *   - Every execute() that returns host data does JSON.parse(JSON.stringify(v))
 *     round-trip to strip Date/Map/BigInt/undefined that the host layer may
 *     hand back, dsh-tools' lossless-JSON check rejects anything that does not
 *     round-trip cleanly through JSON.stringify.
 *   - render() output is also lossless (plain text segments only).
 *   - When the host service is missing (uncommon; startup race), tools
 *     return a structured { error } object instead of throwing, so the
 *     schema stays lossless.
 *
 * Safety gates:
 *   - taskSuite.length >= 10 (host-side throws if violated)
 *   - significanceThreshold ∈ [0, 1]
 *   - abtest_start is ASK-gated by `ask-abtest-start` rule
 *   - abtest_report is ASK-gated by `ask-abtest-report` rule (v0.6.5 add)
 *
 * Preset row (agent.agint.yml):
 *   - id: agint-abtest-tools
 *     name: ../../profiles/web/plugins/agint-abtest/lib/tools.js
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-abtest-tools';
const inject = ['tools', 'agint.abtest'];

const TASK_SUITE_MIN = 10;

/** Strip non-lossless fields from a host return value. */
function lossless(v) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return { error: 'host returned non-serializable value' };
  }
}

function apply(ctx) {
  const abtest = ctx['agint.abtest'];
  if (!abtest || typeof abtest.listTests !== 'function') {
    return;
  }

  // ── abtest_list_tests ────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'abtest_list_tests',
    description:
      '列出所有 A/B 测试条目（只读）。返回每条的 testId、status (running/completed/inconclusive/aborted)、' +
      'variantA / variantB 标识、createdAt。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        if (v?.error) return [{ type: 'text', text: `abtest_list_tests: ${v.error}` }];
        const tests = Array.isArray(v?.tests) ? v.tests : [];
        if (!tests.length) return [{ type: 'text', text: 'abtest_list_tests: no tests yet' }];
        const lines = tests.map((t) => {
          const va = t?.variantA ?? {};
          const vb = t?.variantB ?? {};
          return [
            `  ${t.testId ?? '?'}`,
            `[${String(t.status ?? '?').padEnd(12)}]`,
            `A=${va.promptId ?? '?'}@${va.version ?? '?'}`,
            `B=${vb.promptId ?? '?'}@${vb.version ?? '?'}`,
            `${t.createdAt ?? ''}`,
          ].join('  ');
        });
        return [{ type: 'text', text: `abtest_list_tests: ${tests.length} tests\n${lines.join('\n')}` }];
      },
    },
    async execute() {
      try {
        const result = await abtest.listTests();
        // Host returns { tests: [...] }; be permissive in case it ever returns a bare array.
        const raw = Array.isArray(result) ? { tests: result } : (result ?? {});
        const out = { tests: Array.isArray(raw.tests) ? raw.tests : [] };
        return lossless(out);
      } catch (err) {
        return { tests: [], error: err?.message ?? String(err) };
      }
    },
  }));

  // ── abtest_report ────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'abtest_report',
    description:
      '读取 A/B 测试结果（副作用：会把 test status 标为终态）。' +
      'winner ∈ {A, B, inconclusive}；样本不足或效应量 < 0.3 返回 inconclusive。' +
      '已被 ask-abtest-report 规则门禁，调用前 rule_check 会返回 ASK。',
    parameters: {
      testId: { type: 'string', required: true, description: 'Test id (from abtest_list_tests).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        if (v?.error) return [{ type: 'text', text: `abtest_report: ${v.error}` }];
        const samples = v.samples ?? {};
        return [{
          type: 'text',
          text: [
            `abtest_report: winner=${v.winner ?? '?'}`,
            `  pValue:      ${v.pValue ?? '?'}`,
            `  effectSize:  ${v.effectSize ?? '?'}`,
            `  samples:     A=${samples.A ?? 0}, B=${samples.B ?? 0}`,
          ].join('\n'),
        }];
      },
    },
    async execute(args) {
      try {
        const result = await abtest.report({ testId: args.testId });
        return lossless(result ?? {});
      } catch (err) {
        return { error: err?.message ?? String(err) };
      }
    },
  }));

  // ── abtest_start ─────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'abtest_start',
    description:
      '开一个新 A/B 测试（写副作用：往 abtests 表新增条目，cap 50）。' +
      `约束：taskSuite.length 必须 ≥ ${TASK_SUITE_MIN}；significanceThreshold ∈ [0, 1]（默认 0.05）。` +
      '已被 ask-abtest-start 规则门禁，调用前 rule_check 会返回 ASK。',
    parameters: {
      variantA: {
        type: 'object', required: true, additionalProperties: false,
        properties: {
          promptId: { type: 'string', required: true, description: 'Variant A 的 prompt id。' },
          version: { type: 'string', required: true, description: 'Variant A 的版本号。' },
        },
        description: 'Variant A 标识。',
      },
      variantB: {
        type: 'object', required: true, additionalProperties: false,
        properties: {
          promptId: { type: 'string', required: true, description: 'Variant B 的 prompt id。' },
          version: { type: 'string', required: true, description: 'Variant B 的版本号。' },
        },
        description: 'Variant B 标识。',
      },
      taskSuite: {
        type: 'array', required: true,
        items: { type: 'string' },
        description: `任务集 id 列表。长度必须 ≥ ${TASK_SUITE_MIN}（设计稿 §二.6 统计门槛）。`,
      },
      significanceThreshold: {
        type: 'number',
        description: '显著性阈值 α ∈ [0, 1]，默认 0.05。Bonferroni 校正前。',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => {
        if (v?.error) return [{ type: 'text', text: `abtest_start: ${v.error}` }];
        return [{ type: 'text', text: `abtest_start: testId=${v.testId ?? '?'} status=${v.status ?? '?'}` }];
      },
    },
    async execute(args) {
      try {
        const result = await abtest.start({
          variantA: args.variantA,
          variantB: args.variantB,
          taskSuite: args.taskSuite,
          ...(args.significanceThreshold != null
            ? { significanceThreshold: args.significanceThreshold }
            : {}),
        });
        return lossless(result ?? {});
      } catch (err) {
        return { error: err?.message ?? String(err) };
      }
    },
  }));
}

export { apply, inject, name };