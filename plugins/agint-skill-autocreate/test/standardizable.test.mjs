// [4] 可标准化判断单元测试 + 设计稿 §14.2「50 个已知模式」准确率验证。
//
// ⚠️ 关于这个 50 模式集的诚实说明（避免被误读成独立准确率验证）：
//   本集合是**按判定规则设计的回归集**，作用是锁死行为、防未来改动误伤，
//   不是独立 ground truth——用它跑出的 100% 不代表真实准确率。
//   真正的准确率需要「人工标注的真实模式集」，而目前没有任何已发布的
//   自动创建技能可作 ground truth（P0-1 阶段 3 尚未开工）。
//   本文件中唯一具备独立意义的是「生产真实模式」子集：那 7 个模式是
//   2026-09-09 从生产存储回放出来的、人工看过确认无价值的模式，
//   期望 7/7 被拒。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  judgeStandardizable,
  isMetaTool,
  metaToolsIn,
  paramTokenCount,
  scoreSignals,
  VERDICT_REASONS,
} from '../lib/standardizable.js';

/** 造一个 pattern：给定工具序列，每个工具给 n 个参数 token */
function pattern(toolSequence, opt = {}) {
  const paramSignature = {};
  for (const t of toolSequence) {
    paramSignature[t] = opt.emptyParams ? 'none' : 'path:str:.md|mode:str';
  }
  return {
    toolSequence,
    paramSignature,
    description: toolSequence.join(' → '),
    occurrenceCount: opt.occurrenceCount ?? 4,
    successRate: opt.successRate ?? 1,
    firstSeenAt: '2026-09-09T00:00:00Z',
    lastSeenAt: '2026-09-09T00:00:00Z',
  };
}

// ── 基础：元工具识别 ─────────────────────────────────────────────────────

test('isMetaTool：Agent 自我运维工具命中，任务工具不命中', () => {
  assert.equal(isMetaTool('memory_write'), true);
  assert.equal(isMetaTool('autocreate_stats'), true);
  assert.equal(isMetaTool('skill'), true);
  assert.equal(isMetaTool('evolve_propose'), true);
  assert.equal(isMetaTool('eventBus_publish'), true);
  assert.equal(isMetaTool('read'), false);
  assert.equal(isMetaTool('write'), false);
  assert.equal(isMetaTool('pwsh'), false);
  assert.equal(isMetaTool('ssh_exec'), false);
});

test('metaToolsIn：返回去重后的元工具', () => {
  assert.deepEqual(metaToolsIn(['read', 'memory_write', 'memory_write']), ['memory_write']);
  assert.deepEqual(metaToolsIn(['read', 'write']), []);
});

test('rule_check 不是元工具（业务输入环节），rule_add/lint/audit/list 才是', () => {
  // 教训：rule_ 做成前缀会误杀「先查规范再执行」这类真实流程（2026-09-09 回放发现）
  assert.equal(isMetaTool('rule_check'), false);
  assert.equal(isMetaTool('rule_add'), true);
  assert.equal(isMetaTool('rule_lint'), true);
  assert.equal(isMetaTool('rule_audit'), true);
  assert.equal(isMetaTool('rule_list'), true);
});

test('rule_check > pwsh 不被元工具规则硬拒；结论取决于参数丰富度', () => {
  // 参数结构丰富（≥4 token）→ 勉强放行（conf 0.6 = 阈值）
  const rich = judgeStandardizable(pattern(['rule_check', 'pwsh']));
  assert.notEqual(rich.reason, VERDICT_REASONS.META_TOOL, '不应被元工具规则硬拒');
  assert.equal(rich.standardizable, true);
  assert.equal(rich.confidence, 0.6);

  // 参数结构单薄（每工具 1 token）→ 证据不足，落「需人工」而非硬否
  const poor = judgeStandardizable({
    toolSequence: ['rule_check', 'pwsh'],
    paramSignature: { rule_check: 'path:str', pwsh: 'command:str' },
    description: 'rule_check → pwsh',
    occurrenceCount: 2,
    successRate: 1,
  });
  assert.notEqual(poor.reason, VERDICT_REASONS.META_TOOL);
  assert.equal(poor.standardizable, null);
  assert.equal(poor.reason, VERDICT_REASONS.LOW_CONFIDENCE);
});

test('paramTokenCount：none/empty 不计入', () => {
  assert.equal(paramTokenCount({ a: 'path:str:.md|mode:str', b: 'id:num' }), 3);
  assert.equal(paramTokenCount({ a: 'none', b: 'empty' }), 0);
  assert.equal(paramTokenCount({}), 0);
});

// ── 硬否决 ───────────────────────────────────────────────────────────────

test('空序列 → EMPTY_SEQUENCE', () => {
  const v = judgeStandardizable(pattern([]));
  assert.equal(v.standardizable, false);
  assert.equal(v.reason, VERDICT_REASONS.EMPTY_SEQUENCE);
});

test('单步序列 → TOO_FEW_STEPS', () => {
  const v = judgeStandardizable(pattern(['pwsh']));
  assert.equal(v.standardizable, false);
  assert.equal(v.reason, VERDICT_REASONS.TOO_FEW_STEPS);
});

test('单工具重复（无论重复几次）→ TRIVIAL_SINGLE_TOOL', () => {
  for (const seq of [['pwsh', 'pwsh'], ['pwsh', 'pwsh', 'pwsh'], ['read', 'read', 'read', 'read']]) {
    const v = judgeStandardizable(pattern(seq));
    assert.equal(v.standardizable, false, seq.join('>'));
    assert.equal(v.reason, VERDICT_REASONS.TRIVIAL_SINGLE_TOOL, seq.join('>'));
  }
});

test('命中元工具（哪怕只有一步）→ META_TOOL', () => {
  for (const seq of [['memory_write', 'memory_write'], ['skill', 'skill'], ['autocreate_stats'], ['read', 'memory_write'], ['skill', 'read']]) {
    const v = judgeStandardizable(pattern(seq));
    assert.equal(v.standardizable, false, seq.join('>'));
    assert.equal(v.reason, VERDICT_REASONS.META_TOOL, seq.join('>'));
  }
});

test('无参数结构 → NO_PARAM_STRUCTURE', () => {
  const v = judgeStandardizable(pattern(['read', 'write'], { emptyParams: true }));
  assert.equal(v.standardizable, false);
  assert.equal(v.reason, VERDICT_REASONS.NO_PARAM_STRUCTURE);
});

// ── 通过 / 需人工 ────────────────────────────────────────────────────────

test('典型文件处理流程 → 可标准化', () => {
  const v = judgeStandardizable(pattern(['read', 'edit']));
  assert.equal(v.standardizable, true);
  assert.equal(v.route, 'heuristic');
  assert.equal(v.reason, VERDICT_REASONS.OK_HEURISTIC);
  assert.ok(v.confidence >= 0.6);
});

test('多步组合流程 → 高置信度可标准化', () => {
  const v = judgeStandardizable(pattern(['glob', 'read', 'edit', 'write']));
  assert.equal(v.standardizable, true);
  assert.ok(v.confidence >= 0.8, `confidence=${v.confidence}`);
});

test('信号不足（无读写配对且工具少）→ null 需人工，不是硬否', () => {
  // 两个执行类工具、参数少、无读写配对 → 分数低于阈值
  const p = pattern(['pwsh', 'ssh_exec']);
  p.paramSignature = { pwsh: 'command:str', ssh_exec: 'host:str' };
  const v = judgeStandardizable(p);
  assert.equal(v.standardizable, null);
  assert.equal(v.reason, VERDICT_REASONS.LOW_CONFIDENCE);
  assert.ok(v.confidence < 0.6);
});

test('scoreSignals：单调性——工具更多/步骤更长/参数更丰富 → 分更高', () => {
  const base = { distinctTools: 2, steps: 2, paramTokens: 2, hasReadWritePair: true, successRate: 1, occurrenceCount: 3 };
  const moreTools = scoreSignals({ ...base, distinctTools: 3 });
  const moreSteps = scoreSignals({ ...base, steps: 4 });
  const moreParams = scoreSignals({ ...base, paramTokens: 5 });
  assert.ok(moreTools > scoreSignals(base));
  assert.ok(moreSteps > scoreSignals(base));
  assert.ok(moreParams > scoreSignals(base));
  assert.ok(scoreSignals({ ...base, hasReadWritePair: false }) < scoreSignals(base));
});

// ── 轨道 A（diagnosis）：接口存在性验证 ──────────────────────────────────

test('轨道 A：无失败证据时不激活（现状）', () => {
  const v = judgeStandardizable(pattern(['read', 'write']), {
    diagnosis: { classify: () => ({ rootCause: 'REASONING_ERROR', confidence: 0.9 }) },
  });
  assert.equal(v.route, 'heuristic', '无 failureEvidence 时不应走 diagnosis');
  assert.equal(v.standardizable, true);
});

test('轨道 A：有失败证据 + 可标准化根因 → OK_DIAGNOSIS', () => {
  const v = judgeStandardizable(pattern(['read', 'write']), {
    failureEvidence: [{ tool: 'read', evidence: 'tool not found' }],
    diagnosis: { classify: () => ({ rootCause: 'TOOL_GAP', confidence: 0.8 }) },
  });
  assert.equal(v.route, 'diagnosis');
  assert.equal(v.standardizable, true);
  assert.equal(v.reason, VERDICT_REASONS.OK_DIAGNOSIS);
  assert.equal(v.rootCause, 'TOOL_GAP');
});

test('轨道 A：不可标准化根因 → false；UNCERTAIN → null', () => {
  const opts = (rootCause) => ({
    failureEvidence: [{ tool: 'x', evidence: 'e' }],
    diagnosis: { classify: () => ({ rootCause, confidence: 0.9 }) },
  });
  const bad = judgeStandardizable(pattern(['read', 'write']), opts('PLANNING_FAILURE'));
  assert.equal(bad.standardizable, false);
  assert.equal(bad.reason, VERDICT_REASONS.DIAGNOSIS_NON_STANDARDIZABLE);

  const unc = judgeStandardizable(pattern(['read', 'write']), opts('UNCERTAIN'));
  assert.equal(unc.standardizable, null);
  assert.equal(unc.reason, VERDICT_REASONS.DIAGNOSIS_UNCERTAIN);
});

test('轨道 A：diagnosis 抛错 → 安全退回轨道 B', () => {
  const v = judgeStandardizable(pattern(['read', 'write']), {
    failureEvidence: [{ tool: 'x', evidence: 'e' }],
    diagnosis: { classify: () => { throw new Error('boom'); } },
  });
  assert.equal(v.route, 'heuristic');
  assert.equal(v.standardizable, true);
});

// ── 生产真实模式（2026-09-09 回放，人工确认无价值）───────────────────────
//
// 来源：agint_tool_stats.jsonl 全量回放（5368 条 / 332 任务实例）跨过
// min_occurrence_count=3 的 7 个模式。给「跑一次 pwsh」建技能是荒谬的，
// 全部应被 [4] 拦下。这是本文件里唯一有独立 ground truth 的子集。

test('生产回放 7 个真实模式 → 7/7 被拒', () => {
  const realPatterns = [
    ['pwsh'],
    ['pwsh', 'pwsh'],
    ['memory_write'],
    ['skill'],
    ['autocreate_stats'],
    ['pwsh', 'pwsh', 'pwsh'],
    ['pwsh', 'pwsh', 'pwsh', 'pwsh', 'pwsh'],
  ];
  for (const seq of realPatterns) {
    const v = judgeStandardizable(pattern(seq, { occurrenceCount: 4 }));
    assert.equal(v.standardizable, false, `应拒：${seq.join(' > ')}`);
  }
});

// ── 设计稿 §14.2：50 个已知模式准确率 ────────────────────────────────────

/** 期望可标准化的 25 个（真实工具名 + 有输入有输出 + 参数结构稳定） */
const SHOULD_PASS = [
  ['read', 'edit'],
  ['read', 'write'],
  ['glob', 'read', 'write'],
  ['read', 'grep', 'edit'],
  ['read', 'pwsh', 'write'],
  ['pwsh', 'read', 'write'],
  ['glob', 'read', 'edit', 'write'],
  ['read', 'read', 'write'],
  ['grep', 'read', 'edit'],
  ['read', 'edit', 'pwsh', 'write'],
  ['web_fetch', 'write'],
  ['read', 'pwsh', 'pwsh', 'write'],
  ['glob', 'glob', 'read', 'write'],
  ['read', 'edit', 'edit', 'write'],
  ['wiki_read', 'wiki_write'],
  ['read', 'web_search', 'write'],
  ['pwsh', 'read', 'edit', 'write'],
  ['read', 'grep', 'grep', 'write'],
  ['glob', 'read', 'pwsh', 'write'],
  ['read', 'edit', 'write', 'pwsh'],
  ['read', 'write', 'write'],
  ['grep', 'read', 'write', 'edit'],
  ['read', 'pwsh', 'edit'],
  ['glob', 'read', 'read', 'edit'],
  ['read', 'edit', 'grep', 'write'],
];

/** 期望不可标准化 / 需人工的 25 个（单工具、元工具、无参数、过短） */
const SHOULD_REJECT = [
  ['pwsh'],
  ['pwsh', 'pwsh'],
  ['memory_write'],
  ['skill'],
  ['autocreate_stats'],
  ['pwsh', 'pwsh', 'pwsh'],
  ['pwsh', 'pwsh', 'pwsh', 'pwsh', 'pwsh'],
  ['read'],
  ['write'],
  ['grep', 'grep'],
  ['read', 'read', 'read'],
  ['memory_search', 'memory_write'],
  ['autocreate_list_patterns', 'autocreate_list_candidates'],
  ['evolve_propose', 'evolve_set_status'],
  ['dream_run_now', 'dream_status'],
  ['cron_list', 'cron_health'],
  ['eventBus_publish', 'eventBus_inspectSummary'],
  ['metrics_collect', 'metrics_summary'],
  ['diagnosis_annotate', 'diagnosis_report'],
  ['selfModel_snapshot', 'selfModel_stats'],
  ['curator_dry_run', 'curator_stats'],
  [],
  ['read', 'memory_write'],
  ['skill', 'read'],
  ['rule_add', 'rule_lint'],
];

test('§14.2 50 模式集：准确率 100%（25 通过 + 25 拒绝）', () => {
  let ok = 0;
  const failures = [];
  for (const seq of SHOULD_PASS) {
    const v = judgeStandardizable(pattern(seq, { occurrenceCount: 5 }));
    if (v.standardizable === true) ok++;
    else failures.push(`应通过但被拒: [${seq.join(' > ')}] → ${v.reason} (conf=${v.confidence})`);
  }
  for (const seq of SHOULD_REJECT) {
    if (seq.length === 0) {
      const v = judgeStandardizable(pattern([]));
      if (v.standardizable !== true) ok++;
      else failures.push('应拒绝但通过: []');
      continue;
    }
    const v = judgeStandardizable(pattern(seq, { occurrenceCount: 5 }));
    if (v.standardizable !== true) ok++;
    else failures.push(`应拒绝但通过: [${seq.join(' > ')}] → ${v.reason} (conf=${v.confidence})`);
  }
  assert.equal(ok, 50, `准确率 ${ok}/50；失败项：\n${failures.join('\n')}`);
});
