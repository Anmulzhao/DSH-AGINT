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
  // 证据里的 steps 必须是真正的 string[]：参数层可能把它包成 { item: [...] }
  // （2026-11-17 生产存储实测），这里先还原传输形态，再按原判据判定——
  // 还原后仍不是字符串数组的，照常判 fail，不放宽通过条件。
  const raw = ev.steps;
  let steps = [];
  if (Array.isArray(raw)) steps = raw;
  else if (raw && typeof raw === 'object') {
    const keys = Object.keys(raw);
    const arrayKeys = keys.filter((k) => Array.isArray(raw[k]));
    if (arrayKeys.length === 1) steps = raw[arrayKeys[0]];
    else if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      steps = keys.sort((a, b) => Number(a) - Number(b)).map((k) => raw[k]);
    }
  }
  if (!steps.every((s) => typeof s === 'string')) steps = [];
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

/**
 * exec-code（v0.2.4 / 提案 2cac5f70）：D5 封顶后「换题型」——真实写代码并运行。
 *
 * 判据比 exit-code-output 更严：不仅 exitCode=0 且输出非空，输出还必须同时包含
 * expected 里的全部确定性信号（如 `diff=[4]`）。这样「随便打印点东西」蒙混不过，
 * 必须真的把那段集成逻辑跑出正确结果——把「会拆解步骤」升级成「能跑通实现」。
 * 证据字段沿用 exitCode/output（tools.js 已声明），不引入新字段，不踩 schema 坑。
 */
function assertExecCode(spec, ev) {
  if (ev.exitCode !== 0) {
    return { pass: false, reason: `exitCode=${ev.exitCode}，期望 0（真实运行须成功）` };
  }
  const out = typeof ev.output === 'string' ? ev.output : '';
  if (out.trim().length < spec.minLength) {
    return { pass: false, reason: `output 过短（${out.trim().length} < ${spec.minLength}）` };
  }
  for (const signal of spec.expected ?? []) {
    if (!out.includes(String(signal))) {
      return { pass: false, reason: `output 缺少必需的运行信号「${signal}」（须真实执行得出，非口述步骤）` };
    }
  }
  return { pass: true, reason: `真实运行成功（exitCode=0）且输出含全部 ${(spec.expected ?? []).length} 个确定性信号` };
}

const ASSERTERS = {
  'exit-code-output': assertExitCodeOutput,
  'conclusion-match': assertConclusionMatch,
  'step-list': assertStepList,
  'tool-match': assertToolMatch,
  'exec-code': assertExecCode,
};

/**
 * 证据结构体检（提案 409d571f）：判定前先查必填数组字段是否被参数层压坏。
 *
 * 只认「字段确实提交了、但结构无法解析」这一种基础设施故障 —— 这正是
 * 2026-11-17 的生产事故：evidence.steps 被包成 {item:[...]}，判定器取不到
 * 数组，静默判成 `steps 数量 0 < minLength`，被 self-model 当成能力不足。
 *
 * ⛔ 逃逸口防线：字段**缺失**仍是真实的 fail（没交证据就是没做），不标失效。
 *    只有「交了但坏了」才是尺子的问题。失效只影响下游能力判定，不改变
 *    result 事实（宁 fail 不 pass）。
 *
 * @returns {string|null} 失效原因；null 表示结构正常或非数组型断言
 */
function detectEvidenceInvalidation(spec, ev) {
  if (!spec || spec.type !== 'step-list') return null;
  // 字段根本没提交 → 真实失败，不是失效
  if (!Object.prototype.hasOwnProperty.call(ev, 'steps')) return null;
  const raw = ev.steps;
  let steps = [];
  let restorable = false;
  if (Array.isArray(raw)) { steps = raw; restorable = true; }
  else if (raw && typeof raw === 'object') {
    const keys = Object.keys(raw);
    const arrayKeys = keys.filter((k) => Array.isArray(raw[k]));
    if (arrayKeys.length === 1) { steps = raw[arrayKeys[0]]; restorable = true; }
    else if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      steps = keys.sort((a, b) => Number(a) - Number(b)).map((k) => raw[k]);
      restorable = true;
    }
  }
  // 字段存在，但既还原不出数组、又含非字符串元素 ⇒ 传输/参数层压坏了必填数组
  if (!restorable || !steps.every((s) => typeof s === 'string')) {
    return `evidence.steps 结构无法解析（字段已提交但非字符串数组）：${JSON.stringify(raw).slice(0, 160)}`;
  }
  return null;
}

// ── judge ────────────────────────────────────────────────────────────────

/**
 * 判定一次挑战提交。
 * @param {object} challenge 挑战记录（含 verifySpec）
 * @param {object} rawEvidence 执行者提交的 evidence（原始，可能含 selfAssessment）
 * @param {object} opts { requireEvidence = true }
 * @returns {{ result: 'pass'|'fail', reason: string, notes: string|null, evidence: object, invalidation: string|null }}
 *   invalidation 非 null = 判定基础设施故障（证据结构被压坏），本条 fail 不是能力不足。
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
      invalidation: null,
    };
  }

  const spec = challenge?.verifySpec;
  // 证据结构体检（提案 409d571f）：在断言之前判定「尺子是否坏了」。
  // 无对应断言本身就是判定基础设施故障 —— 与「证据被压坏」同类。
  const invalidation = spec && ASSERTERS[spec.type]
    ? detectEvidenceInvalidation(spec, evidencePayload)
    : (spec ? `verifySpec 类型 ${spec.type} 无对应断言（判定器不可用）` : 'verifySpec 缺失（判定器不可用）');
  const asserter = spec ? ASSERTERS[spec.type] : null;
  if (!asserter) {
    // 理论上不会发生（C1 保证生成时必带 verifySpec）；防御性兜底，宁 fail 不 pass
    return {
      result: 'fail',
      reason: `verifySpec 类型 ${spec?.type ?? '缺失'} 无对应断言（防御性 fail）`,
      notes,
      evidence: evidencePayload,
      invalidation,
    };
  }

  const { pass, reason } = asserter(spec, evidencePayload);
  return {
    result: pass ? 'pass' : 'fail',
    reason,
    notes,
    evidence: evidencePayload,
    invalidation,
  };
}

export function listVerifierTypes() {
  return Object.keys(ASSERTERS);
}
