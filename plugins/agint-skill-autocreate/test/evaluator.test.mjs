// Sprint 15 T3/T7 验收：evaluateCandidate 三阶段编排（mock services）。
// 覆盖：Phase1 blocker → REJECTED_STATIC；Phase2 实跑失败 → REJECTED_SANDBOX；
// 无可执行物 skipped → E0 放行；实跑通过 → E1；evaluator 抛错 → REJECTED_EVAL；
// rankingScore 公式；T7 evolution 写 phase3-provisional（枚举受限）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { evaluateCandidate, computeRankingScore } from '../lib/evaluator.js';

const CANDIDATE = {
  id: 'sc_20260908_t3abc',
  sourcePatternId: 'tp_20260908_pat1',
  skillDraft: {
    name: 'pdf-summarizer',
    description: '批量总结 PDF 文档并输出要点列表',
    category: 'productivity',
    template: 'file-processing',
    frontmatter: {
      name: 'pdf-summarizer',
      description: '批量总结 PDF 文档并输出要点列表',
      triggers: ['用户要求总结 PDF'],
      tools: ['read_file', 'write_file'],
    },
    body: '# PDF 总结\n\n1. 读取用户指定的 PDF 文件。\n2. 提取每页要点。\n',
    references: [],
    scripts: [],
  },
  estimatedBenefit: {
    successRateImprovement: 0.3,
    timeSavingsPct: 0.4,
    tokenSavingsPct: 0.2,
    harmIncrementEstimate: 0.1,
  },
};

const PATTERN = { occurrenceCount: 12 };
// 默认关掉 A3 信息量门：本文件的用例测的是「三阶段编排」，不是语义质量；
// A3 由 semantics.test.mjs + 下方专门的「A3 接通」用例覆盖。
const CFG = {
  dangerous_tools_blocklist: ['terminal:rm -rf', 'terminal:dd'],
  semantics_quality_gate_enabled: false,
};

function makeServices(overrides = {}) {
  return {
    qualityStatic: {
      // 与真实 quality-static checkPlugin 契约一致：{ ok, findings, durationMs, profile }
      checkPlugin: async () => ({ ok: true, findings: [], durationMs: 1, profile: 'skill-candidate' }),
    },
    qualitySandbox: {
      runSmoke: async ({ target }) => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    },
    qualityEvaluator: {
      evaluate: async (target) => ({
        id: target.id,
        kind: target.kind,
        scores: { composite: 71.4 },   // 模拟真实：新候选 composite 恒 71.4 < pendingReview 75
        findings: [],
      }),
    },
    evolution: {
      logPhase4: async (entry) => ({ ok: true, entry }),
    },
    ...overrides,
  };
}

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'eval-'));
}

test('T8 核心：零历史正常候选 → PHASE3_PASS（composite 71.4 不死锁）', async () => {
  const home = makeHome();
  try {
    const services = makeServices();
    const result = await evaluateCandidate({ candidate: CANDIDATE, pattern: PATTERN, services, cfg: CFG, dshHome: home });
    assert.equal(result.finalStatus, 'PHASE3_PASS', '硬门通过，绝不能因 composite 71.4 被 REJECTED_EVAL');
    assert.equal(result.evalResults.phase1.status, 'pass');
    assert.equal(result.evalResults.phase2.status, 'skipped');
    assert.equal(result.evalResults.phase3.composite, 71.4);
    assert.equal(result.evalResults.phase3.compositeTrusted, false, '综合分只记录不决策');
    assert.equal(result.evalResults.phase3.hardGatePassed, true);
    assert.equal(result.evalResults.phase3.provisional, true);
    assert.equal(result.evidenceLevel, 'E0', '无可执行物 → E0');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Phase1 blocker → REJECTED_STATIC（skill-format 语义）', async () => {
  const home = makeHome();
  try {
    const services = makeServices({
      qualityStatic: {
        checkPlugin: async () => ({
          ok: false,
          findings: [{ family: 'skill-format', severity: 'blocker', message: 'SKILL.md 缺必填字段: name' }],
          durationMs: 1,
          profile: 'skill-candidate',
        }),
      },
    });
    const result = await evaluateCandidate({ candidate: CANDIDATE, pattern: PATTERN, services, cfg: CFG, dshHome: home });
    assert.equal(result.finalStatus, 'REJECTED_STATIC');
    assert.equal(result.evalResults.phase1.status, 'reject');
    assert.ok(result.blockers.length === 1);
    assert.equal(result.evalResults.phase2, null, 'Phase1 拒则不进 Phase2');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Phase2 实跑失败 → REJECTED_SANDBOX', async () => {
  const home = makeHome();
  try {
    const services = makeServices({
      qualitySandbox: { runSmoke: async () => ({ exitCode: 1, stdout: '', stderr: 'smoke failed' }) },
    });
    const cand = { ...CANDIDATE, skillDraft: { ...CANDIDATE.skillDraft, scripts: [{ name: 'run.sh', content: '#!/bin/sh\nexit 1' }] } };
    const result = await evaluateCandidate({ candidate: cand, pattern: PATTERN, services, cfg: CFG, dshHome: home });
    assert.equal(result.finalStatus, 'REJECTED_SANDBOX');
    assert.equal(result.evalResults.phase1.status, 'pass');
    assert.equal(result.evalResults.phase2.status, 'reject');
    assert.equal(result.evalResults.phase2.exitCode, 1);
    assert.equal(result.evalResults.phase3, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Phase2 实跑通过 → E1 放行', async () => {
  const home = makeHome();
  try {
    const services = makeServices();
    const cand = { ...CANDIDATE, skillDraft: { ...CANDIDATE.skillDraft, scripts: [{ name: 'run.sh', content: '#!/bin/sh\nexit 0' }] } };
    const result = await evaluateCandidate({ candidate: cand, pattern: PATTERN, services, cfg: CFG, dshHome: home });
    assert.equal(result.finalStatus, 'PHASE3_PASS');
    assert.equal(result.evalResults.phase2.status, 'pass');
    assert.equal(result.evidenceLevel, 'E1', '沙箱实测通过 → E1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('evaluator 抛错 → REJECTED_EVAL（可重试路径）', async () => {
  const home = makeHome();
  try {
    const services = makeServices({
      qualityEvaluator: { evaluate: async () => { throw new Error('evaluator down'); } },
    });
    const result = await evaluateCandidate({ candidate: CANDIDATE, pattern: PATTERN, services, cfg: CFG, dshHome: home });
    assert.equal(result.finalStatus, 'REJECTED_EVAL');
    assert.match(result.error.message, /evaluator down/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('evolution 缺失 → 不阻断（降级标记）', async () => {
  const home = makeHome();
  try {
    const services = makeServices({ evolution: null });
    const result = await evaluateCandidate({ candidate: CANDIDATE, pattern: PATTERN, services, cfg: CFG, dshHome: home });
    assert.equal(result.finalStatus, 'PHASE3_PASS');
    assert.equal(result.evalResults.phase3.evolutionWrite.ok, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('T7：logPhase4 参数契约（targetKind skill / decision PENDING_REVIEW / tags 含 phase3-provisional）', async () => {
  const home = makeHome();
  try {
    let logged = null;
    const services = makeServices({
      evolution: { logPhase4: async (entry) => { logged = entry; return { ok: true }; } },
    });
    await evaluateCandidate({ candidate: CANDIDATE, pattern: PATTERN, services, cfg: CFG, dshHome: home });
    assert.ok(logged, 'phase3 通过必须写 evolution-log');
    assert.equal(logged.targetId, CANDIDATE.id);
    assert.equal(logged.targetKind, 'skill', 'targetKind 必须 ∈ plugin/skill/preset/composite');
    assert.equal(logged.decision, 'PENDING_REVIEW', 'decision 必须 ∈ 四枚举（provisional 语义）');
    assert.ok(logged.tags.includes('phase3-provisional'));
    assert.ok(logged.tags.includes(`candidate:${CANDIDATE.id}`));
    assert.equal(logged.scores.rankingScore, computeRankingScore(CANDIDATE, PATTERN));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('rankingScore：预估收益 + 模式频次 + 安全，纯函数', () => {
  const score = computeRankingScore(CANDIDATE, PATTERN);
  // benefitAvg=(0.3+0.4+0.2)/3=0.3；freq=min(1,12/10)=1；safety=0.9
  // score = 0.5*0.3 + 0.3*1 + 0.2*0.9 = 0.15+0.3+0.18 = 0.63
  assert.equal(score, 0.63);
  // 全零：benefitAvg=0, freq=0, harm 未知 → safety=1 贡献 0.2（无风险证据不扣分）
  assert.equal(computeRankingScore({ estimatedBenefit: {} }, {}), 0.2);
});

// ── Phase 2：A3 信息量门在评估层接通（2026-09-17）─────────────────────────
// 背景：2026-09-17 14:04 自动发布了 2 个空壳技能（正文 = 工具序列复述）。
// A2（生成层具体值门）先拦一道；本用例验证**评估层的兜底**真的接通——
// 即人工 modifyCandidate 绕过 A2 时，A3 仍能把空壳挡在发布之外。

/** glob-glob-glob-glob 的正文原文（今天被发布的空壳技能） */
const SHELL_BODY = [
  '## 适用场景',
  'glob → glob → glob → glob',
  '',
  '## 前置条件',
  '- 工具可用：glob、read、pwsh',
  '- 运行环境与历史任务实例一致（同工作目录/同权限）',
  '',
  '## 步骤',
  '1. 调用 glob，确认输出符合预期后再进入下一步。',
  '2. 调用 read，确认输出符合预期后再进入下一步。',
  '3. 调用 pwsh，确认输出符合预期后再进入下一步。',
  '',
  '## 注意事项',
  '- 本技能由系统从重复任务模式自动生成（经 D-QAF 评估 + 灰度发布）。',
  '- 首次使用如结果异常，停止并反馈，不要盲目重试。',
  '- 涉及写操作时先确认目标路径，避免覆盖非预期文件。',
].join('\n');

test('Phase1 A3：空壳正文候选 → REJECTED_STATIC（信息量门接通，防绕过 A2）', async () => {
  const home = makeHome();
  try {
    const services = makeServices();
    const cand = {
      ...CANDIDATE,
      skillDraft: {
        ...CANDIDATE.skillDraft,
        name: 'glob-glob-glob-glob',
        // tools 必须与正文一致——A3-1 剥工具名时按 frontmatter.tools 剥，
        // 对不上就会把工具名当「实质内容」留下来（这本身就是判据的边界）
        frontmatter: { ...CANDIDATE.skillDraft.frontmatter, name: 'glob-glob-glob-glob', tools: ['glob', 'read', 'pwsh'] },
        body: SHELL_BODY,
      },
    };
    const result = await evaluateCandidate({
      candidate: cand,
      pattern: PATTERN,
      services,
      cfg: { ...CFG, semantics_quality_gate_enabled: true },
      dshHome: home,
    });
    assert.equal(result.finalStatus, 'REJECTED_STATIC');
    assert.equal(result.evalResults.phase1.status, 'reject');
    const codes = result.evalResults.phase1.semanticCodes ?? [];
    assert.ok(codes.includes('non-informative-body'), `期望含 non-informative-body，实际: ${codes.join(',')}`);
    assert.equal(result.evalResults.phase2, null, 'Phase1 拒则不进 Phase2');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Phase1 A3：有实质知识的草稿 → 照常放行（不误杀）', async () => {
  const home = makeHome();
  try {
    const services = makeServices();
    const cand = {
      ...CANDIDATE,
      skillDraft: {
        ...CANDIDATE.skillDraft,
        name: 'skill-mount-diagnosis',
        body: [
          '## 适用场景',
          '排查 dsh 技能未挂载：确认 SKILL.md 是否落在 skills_root 一层深目录内。',
          '',
          '## 为什么',
          '- 宿主用 dsh-skill-filesystem 扫技能根，只认 <root>/<name>/SKILL.md，嵌套 **/SKILL.md 不会被发现。',
          '',
          '## 步骤',
          '1. 调用 glob：**/*/SKILL.md（在 .agent-presets/agint/skills 下扫）',
          '2. 调用 read：.agent-presets/agint/skills/<name>/SKILL.md，检查 frontmatter 是否含 name 与 description',
          '3. 调用 pwsh：node bin/plugin-check.sh --strict',
          '',
          '## 避坑',
          '- 曾遇到：Error: EPERM: operation not permitted, rename ...skills_root\\.tmp-xxx',
        ].join('\n'),
      },
    };
    const result = await evaluateCandidate({
      candidate: cand,
      pattern: PATTERN,
      services,
      cfg: { ...CFG, semantics_quality_gate_enabled: true },
      dshHome: home,
    });
    assert.equal(result.finalStatus, 'PHASE3_PASS', `不该被误杀，findings: ${JSON.stringify(result.evalResults?.phase1?.findings ?? [])}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
