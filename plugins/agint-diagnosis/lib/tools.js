/**
 * agint-diagnosis: preset-scoped diagnosis tools (v0.6.0).
 * Consumes host services: annotate / counterfactual / cluster / report /
 * stats / analyzeFailedSmoke. Write/eval tools (annotate, counterfactual,
 * cluster, analyzeFailedSmoke) are ASK-gated per AGENTS.md boundary.
 *
 * Schema policy: K19 — `additionalProperties: true`; tighten after live call.
 *
 * K19-fix (2026-09-04): dsh-tools' lossless-JSON check rejects host return
 * values that aren't plain JSON. agint.diagnosis.stats() returns
 * {annotations, clusters, reports, limits} (plain object — see
 * plugins/agint-diagnosis/lib/index.js:108-118), but dsh-tools rejects
 * objects whose prototype chain contains a non-plain factory. JSON
 * round-trip guarantees plain JSON. If the host ever returns Date/Map/BigInt,
 * this loses precision and we need a typed serialiser; for stats() it is
 * exact. Same fix applies to diagnosis_report (uses report() returning
 * DiagnosisReportSchema-compliant plain object).
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-diagnosis-tools';
const inject = ['tools',
  'agint.diagnosis.annotate', 'agint.diagnosis.counterfactual',
  'agint.diagnosis.cluster', 'agint.diagnosis.report',
  'agint.diagnosis.stats', 'agint.diagnosis.analyzeFailedSmoke'];

function apply(ctx) {
  const annotate = ctx['agint.diagnosis.annotate'];
  const counterfactual = ctx['agint.diagnosis.counterfactual'];
  const cluster = ctx['agint.diagnosis.cluster'];
  const report = ctx['agint.diagnosis.report'];
  const stats = ctx['agint.diagnosis.stats'];
  const analyzeFailedSmoke = ctx['agint.diagnosis.analyzeFailedSmoke'];

  ctx.tools.register(defineTool({
    name: 'diagnosis_annotate',
    description:
      'Tag a failure event with one of 6 root-cause classes. **ASK-gated**. ' +
      'Writes to agint.diagnosis; downstream mutator/curriculum consume these annotations.',
    parameters: {
      event: { type: 'object', required: true, additionalProperties: true,
        description: 'Failure event: { id?, source, error, context? }. id 用于定位 failure_pattern 的失败样本（可等同 failureId）。' },
      // category 由必填改为可选（提案 49ac5e58 改动 3）：
      // rootCauseClassify(trajectory) 是 6 类特征投票，不接受人工类别 —— 旧 schema 把
      // category 设为必填却被服务层静默丢弃，是「必填参数被无视」的最坏状态。
      // 现在作为可选 hint：服务层会把值记入 evidence.hintCategory 供审计，但**不**
      // 覆盖算法判定；实际 rootCause 仍由特征投票决定。
      category: { type: 'string',
        description: 'Optional analyst hint. NOT authoritative: the 6-class feature vote decides rootCause; this value is recorded in evidence.hintCategory only.' },
      notes: { type: 'string', description: 'Optional analyst notes.' },
      // trajectory（提案 49ac5e58 后续修复，2026-11-18）：
      // 6 类特征投票吃的是「步骤序列」，但服务层原来只用 failure_pattern 里的
      // **单行**兜底 ⇒ 每次只命中 ≤1 特征 ⇒ 恒判 UNCERTAIN（实测 A/B 对照：
      // 同一份 3 步 trajectory，failureId 命中表内 → UNCERTAIN，不命中 → TOOL_GAP）。
      // 现在把调用方手里的真实失败步骤序列透传给服务层（显式 trajectory 优先于
      // 单行兜底），投票才有足够证据。
      trajectory: { type: 'array', items: { type: 'object', additionalProperties: true },
        description: 'Optional failure step sequence for the 6-class feature vote. Each step uses the classifier vocabulary: { pattern, evidence, note, message, tool } (trajectory-store steps only expose `content`, which the vote does NOT read — map it into `evidence` yourself). Without it the vote only sees a single failure_pattern row and will usually land on UNCERTAIN.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: `diagnosis_annotate: ${JSON.stringify(v)}` }],
    },
    execute(args) {
      return annotate({
        event: args.event,
        category: args.category,
        notes: args.notes ?? '',
        trajectory: Array.isArray(args.trajectory) ? args.trajectory : undefined,
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'diagnosis_counterfactual',
    description:
      'Run a counterfactual simulation: "if X were different, would Y still occur?" ' +
      '**ASK-gated** — produces a simulation result that mutator consumes.',
    parameters: {
      hypothesis: { type: 'object', required: true, additionalProperties: true,
        description: 'Hypothesis spec: { change, target, expectedDiff? }' },
      seed: { type: 'integer', description: 'Random seed for reproducible runs.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute(args) {
      return counterfactual(args.hypothesis, { seed: args.seed });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'diagnosis_cluster',
    description: 'Cluster a batch of annotations into patterns (time-window based). **ASK-gated**.',
    parameters: {
      windowDays: { type: 'integer', description: 'Lookback window in days.' },
      minOccurrences: { type: 'integer', description: 'Minimum occurrences to form a cluster (default 3).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute(args) {
      return cluster({ windowDays: args.windowDays ?? 7, minOccurrences: args.minOccurrences ?? 3 });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'diagnosis_report',
    description:
      'Aggregate report over a time window: root-cause distribution + cluster summary. ' +
      '**Read-only**. Per AGENTS.md step 6.',
    parameters: {
      windowDays: { type: 'integer', description: 'Lookback window in days (default 7).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute(args) {
      return report({ windowDays: args.windowDays ?? 7 });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'diagnosis_stats',
    description: 'Auxiliary stats: counts of annotations, clusters, counterfactual runs.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute() {
      return stats().then((s) => JSON.parse(JSON.stringify(s)));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'diagnosis_analyzeFailedSmoke',
    description:
      'Analyze a failed smoke test: which plugin/skill/topic + which root-cause class. ' +
      '**ASK-gated** — feeds the dream mutator with attribution evidence.',
    parameters: {
      // 参数名断层修复（与 49ac5e58 同型，2026-11-18）：
      // 旧 schema 只有一个 smokeRunId，服务层 analyzeFailedSmoke(payload) 要的却是
      // 事件 payload { target, mode, reason, failedChecks, durationMs }。
      // 而 agint-quality-sandbox **不存 smoke 运行记录**（只 publish sandbox.failed），
      // 所以 smokeRunId 在系统里根本没有可查的实体 —— 传进来必然退化成 reason='unknown'。
      // 现在工具直收 payload 各字段；smokeRunId 保留为「只记证据、不解析」的兼容位。
      target: { type: 'object', additionalProperties: true,
        description: 'Failed smoke target: { path, name }.' },
      mode: { type: 'string', description: 'Sandbox run mode.' },
      reason: { type: 'string',
        description: 'Failure reason, e.g. "smoke-failed" / "timeout" / "plugin-not-found" / "import".' },
      failedChecks: { type: 'array', items: { type: 'object', additionalProperties: true },
        description: 'Failed checks: [{ name, detail }].' },
      durationMs: { type: 'number', description: 'Run duration in ms.' },
      smokeRunId: { type: 'string',
        description: 'Legacy: smoke run id. No run store exists in AGINT, so it is recorded as evidence only and NOT resolved.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute(args) {
      return analyzeFailedSmoke({
        target: args.target,
        mode: args.mode,
        reason: args.reason,
        failedChecks: Array.isArray(args.failedChecks) ? args.failedChecks : [],
        durationMs: args.durationMs,
        smokeRunId: args.smokeRunId,
      });
    },
  }));
}

export { apply, inject, name };