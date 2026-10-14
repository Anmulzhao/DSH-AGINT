/**
 * agint-quality-eval: preset-scoped model-facing tools (D-QAF evaluator).
 *
 * Consumes the host `agint.qualityEvaluator` service (registered from
 * profiles/web/cordis.patch.yml as a host row). Exposes two tools:
 *   - quality_eval_status  zero-side-effect snapshot (next fire / last run / weights)
 *   - quality_eval_run_now triggers the weekly scheduler immediately
 *
 * Per editing-cordis-compositions: consumer pattern, no isolate realm.
 * Schemas use additionalProperties:true (per K19) because the host service
 * returns dynamic shapes we cannot fully pre-declare.
 *
 * Preset row (agent.agint.yml):
 *   - id: agint-quality-eval-tools
 *     name: ../../profiles/web/plugins/agint-quality/agint-quality-eval/lib/tools.js
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-quality-eval-tools';
const inject = ['tools', 'agint.qualityEvaluator'];

/**
 * 把任意值压成纯 JSON 值（Date → ISO 字符串，Error → {message}）。
 *
 * 为什么需要它（2026-10-14 实测）：调度器把 `at` 存成 Date 对象
 * （lib/scheduler.js:58 `const at = new Date()`）。宿主对工具返回值做
 * lossless-JSON 校验，Date 不是 JSON 原生类型 ⇒ 整个返回值被拒，
 * 工具报 `invalid output: value is not lossless JSON`。
 * 该值在 lastRun 里，只在跑过评估之后才存在 ⇒ bug 首次评估后才现形。
 *
 * ⛔ 只做类型归一，不改语义、不吞字段。
 */
function sanitizeForJson(v, depth = 0) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Error) return { name: v.name, message: v.message };
  if (typeof v !== 'object') return v;
  if (depth > 8) return null; // 防循环/深嵌套
  if (Array.isArray(v)) return v.map((x) => sanitizeForJson(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = sanitizeForJson(val, depth + 1);
  }
  return out;
}

function apply(ctx) {
  const evaluator = ctx['agint.qualityEvaluator'];

  // ── quality_eval_status ────────────────────────────────────────────────────
  // Zero-side-effect: read nextFire / lastRun / weights / dimensionKeys.
  // Safe to call any time — does NOT trigger an evaluation.
  ctx.tools.register(defineTool({
    name: 'quality_eval_status',
    description:
      '查看 D-QAF 评估引擎当前状态：下次自动触发时间、最近一次评估结果、维度权重。' +
      '零副作用——不触发评估。典型用法：跑周评估前先看一眼 lastRun 是否还新鲜。',
    parameters: {},
    output: {
      // K21: raw JSON Schema form. `required` not allowed beside `oneOf` —
      // lift to parent.
      schema: {
        type: 'object', additionalProperties: false,
        // required 已迁移至各属性（value schema DSL: 属性上的布尔 required: true）
        properties: {
          nextFire: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          // K20-fix (2026-09-11)：从未跑过评估时 lastRun 为 null（下方 render 已有
          // '<never>' 分支，说明 null 是预期值），但 schema 只声明 object ⇒ 校验失败、
          // 工具必报 `"value.lastRun" must be an object`。此处与 nextFire 一致地放行 null。
          lastRun: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
          weights: { required: true, type: 'object', additionalProperties: true },
          dimensionKeys: { required: true, type: 'array', items: { type: 'string' } },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: [
          `quality_eval_status:`,
          `  nextFire:      ${v.nextFire ?? '<not scheduled>'}`,
          `  lastRun:       ${v.lastRun ? JSON.stringify(v.lastRun) : '<never>'}`,
          `  weights:       ${JSON.stringify(v.weights)}`,
          `  dimensionKeys: ${v.dimensionKeys.join(', ')}`,
        ].join('\n'),
      }],
    },
    execute() {
      const nextFire = typeof evaluator.nextFire === 'function' ? evaluator.nextFire() : null;
      const lastRun = typeof evaluator.lastRun === 'function' ? evaluator.lastRun() : null;
      return {
        nextFire: nextFire ? new Date(nextFire).toISOString() : null,
        // 2026-10-14 修复：lastRun 里的 `at` 是 Date 对象（scheduler.js:58 `const at = new Date()`），
        //   Date 不是 JSON 原生类型 ⇒ 宿主 lossless-JSON 校验拒绝整个返回值，
        //   表现为 `quality_eval_status: invalid output: value is not lossless JSON`。
        //   未跑过评估时 lastRun=null 不触发，所以这个 bug 只在首次评估之后才现形。
        //   修法：这里归一化成 ISO 字符串 —— 不动 scheduler 语义，只动序列化边界。
        lastRun: sanitizeForJson(lastRun) ?? null,
        weights: evaluator.weights ?? {},
        dimensionKeys: evaluator.dimensionKeys ?? [],
      };
    },
  }));

  // ── quality_eval_run_now ───────────────────────────────────────────────────
  // Side-effect: forces a weekly-scheduler tick. Writes to memory (decision
  // records per target). ASK-gated by agint-rules — see rule_check before call.
  ctx.tools.register(defineTool({
    name: 'quality_eval_run_now',
    description:
      '手动触发 D-QAF 周评估（强制跑一次，会写入 agint.memory 作为历史）。' +
      '副作用：会产生 decision 类型 memory 条目 + event bus evolution.evaluated 边。' +
      '被 rule 门禁为 ask 级别——调用前先 rule_check 确认。',
    parameters: {},
    output: {
      // K21: raw JSON Schema form.
      schema: {
        type: 'object', additionalProperties: false,
        // required 已迁移至各属性（value schema DSL: 属性上的布尔 required: true）
        properties: {
          triggered: { required: true, type: 'boolean' },
          detail: { required: true, type: 'object', additionalProperties: true },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: v.triggered
          ? `quality_eval_run_now: triggered\n${JSON.stringify(v.detail, null, 2)}`
          : `quality_eval_run_now: skipped — ${v.detail?.reason ?? 'unknown'}`,
      }],
    },
    async execute() {
      if (typeof evaluator.runNow !== 'function') {
        return { triggered: false, detail: { reason: 'runNow() not available on evaluator' } };
      }
      try {
        const result = await evaluator.runNow();
        return { triggered: true, detail: result ?? { note: 'runNow returned no detail' } };
      } catch (err) {
        return { triggered: false, detail: { reason: err?.message ?? String(err) } };
      }
    },
  }));
}

export { apply, inject, name };