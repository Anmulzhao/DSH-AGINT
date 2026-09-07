/**
 * agint-curriculum: verdict（§4.4）——外部化判定器。
 *
 * 哲学核心（真实 > 讨好）：curriculum 让 AGINT 自己出题、自己做、自己判，
 * 是典型的自我评估，系统完全可以通过「只出简单题 + 判自己全对」把能力图谱
 * 刷成一片 CAN。三条硬约束在此落地：
 *
 *   C1：挑战必须带可自动判定的通过条件（verifySpec），无法判定的域不生成挑战。
 *   C2：自评结果（evidence.selfAssessment）只存 notes，**不得**作为 pass/fail
 *       依据——capability status 由 self-model 侧决定，本插件只提供证据。
 *   C3：verdict 必须带 evidence；无 evidence → 记 fail，不记 pass。
 *
 * **纯函数**：输入（challenge + evidence + 配置 + 时间）→ 输出判定，无副作用。
 */

// ── verifySpec → 断言函数（C1 的机器侧）──────────────────────────────────

function assertExitCodeOutput(spec, ev) {
  if (ev.exitCode !== 0) {
    return { pass: false, reason: `exitCode=${ev.exitCode}，期望 0` };
  }
  const out = typeof ev.output === 'string' ? ev.output : '';
  if (out.trim().length < spec.minLength) {
    return { pass: false, reason: `output 为空或过短（minLength=${spec.minLength}）` };
  }
  return { pass: true, reason: `exit code 0 且输出非空（${out.trim().length} 字符）` };
}

function assertConclusionMatch(spec, ev) {
  const got = typeof ev.conclusion === 'string' ? ev.conclusion.trim() : '';
  if (!got) {
    return { pass: false, reason: '缺少 conclusion（C3：无证据不记 pass）' };
  }
  const expected = String(spec.expected ?? '').trim();
  if (got !== expected) {
    return { pass: false, reason: `conclusion="${got}" ≠ 预期"${expected}"` };
  }
  return { pass: true, reason: `conclusion 与预期一致（${expected}）` };
}

function assertStepList(spec, ev) {
  const steps = Array.isArray(ev.steps) ? ev.steps : [];
  if (steps.length < spec.minLength) {
    return { pass: false, reason: `steps 数量 ${steps.length} < minLength ${spec.minLength}` };
  }
  const joined = steps.join(' ').toLowerCase();
  for (const kw of spec.expected ?? []) {
    if (!joined.includes(String(kw).toLowerCase())) {
      return { pass: false, reason: `steps 缺少必需关键词「${kw}」` };
    }
  }
  return { pass: true, reason: `steps ${steps.length} 步且包含全部必需关键词` };
}

function assertToolMatch(spec, ev) {
  if (ev.toolUsed !== spec.expected) {
    return { pass: false, reason: `toolUsed="${ev.toolUsed ?? ''}" ≠ 预期"${spec.expected}"` };
  }
  if (ev.exitCode !== 0) {
    return { pass: false, reason: `exitCode=${ev.exitCode}，期望 0` };
  }
  return { pass: true, reason: `工具 ${spec.expected} 命中且运行成功` };
}

const ASSERTERS = {
  'exit-code-output': assertExitCodeOutput,
  'conclusion-match': assertConclusionMatch,
  'step-list': assertStepList,
  'tool-match': assertToolMatch,
};

// ── judge ────────────────────────────────────────────────────────────────

/**
 * 判定一次挑战提交。
 * @param {object} challenge 挑战记录（含 verifySpec）
 * @param {object} rawEvidence 执行者提交的 evidence（原始，可能含 selfAssessment）
 * @param {object} opts { requireEvidence = true }
 * @returns {{ result: 'pass'|'fail', reason: string, notes: string|null, evidence: object }}
 */
export function judge(challenge, rawEvidence, { requireEvidence = true } = {}) {
  const ev = rawEvidence && typeof rawEvidence === 'object' ? rawEvidence : {};

  // C2：自评剥离——只存 notes，绝不参与判定
  let notes = null;
  if (typeof ev.selfAssessment === 'string' && ev.selfAssessment.trim()) {
    notes = ev.selfAssessment.trim();
  }

  // C3：无 evidence → fail（自评不算 evidence）
  const evidencePayload = { ...ev };
  delete evidencePayload.selfAssessment;
  const hasEvidence = Object.keys(evidencePayload).length > 0;

  if (requireEvidence && !hasEvidence) {
    return {
      result: 'fail',
      reason: '无 evidence（C3：无证据不记 pass；selfAssessment 不是证据）',
      notes,
      evidence: {},
    };
  }

  const spec = challenge?.verifySpec;
  const asserter = spec ? ASSERTERS[spec.type] : null;
  if (!asserter) {
    // 理论上不会发生（C1 保证生成时必带 verifySpec）；防御性兜底，宁 fail 不 pass
    return {
      result: 'fail',
      reason: `verifySpec 类型 ${spec?.type ?? '缺失'} 无对应断言（防御性 fail）`,
      notes,
      evidence: evidencePayload,
    };
  }

  const { pass, reason } = asserter(spec, evidencePayload);
  return {
    result: pass ? 'pass' : 'fail',
    reason,
    notes,
    evidence: evidencePayload,
  };
}

export function listVerifierTypes() {
  return Object.keys(ASSERTERS);
}
