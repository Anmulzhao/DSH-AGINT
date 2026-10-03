/**
 * agint-evolution-driver —— skill-gate.js
 *
 * Phase 1.1 支点 **1b / R2** 的判据层：技能（`presets/<preset>/skills/<skill>/SKILL.md`）改完之后，
 * 拿一组**人工签核的内容断言**判它「还达不达标」，出一个通过率。
 *
 * ## 为什么不是那 11 条规则门禁（2026-10-03 实测）
 *
 * 我把 11 条确定性规则断言（skill-format + AGENTS.md 红线 + ASD 禁用词 + 路径存在性）
 * 跑在两次真实技能变异上（`.agint-preimage/` 改前态 vs 工作区改后态）：
 * 9/11 → 9/11，**delta = 0.0pp，零条翻转**。而那两次变异一次加了 16 行必需段、
 * 一次改对了 bundle 位路径。规则集只查形式，看不见内容 ⇒ 它当体检合格，当尺子不合格
 * （同一形状见 `outcome-scope.js` 头注里推翻 R1 的那个实验）。
 * 能翻的只有**内容级金标断言**：谁规定「这段必须在 / 那条路径不许再写」，谁才造得出灵敏的尺子。
 *
 * ## 三条构造性纪律
 *
 * 1. ⛔ **未签核的 case 不进分母**。只有 `addedBy === 'boss'` 且 `approvedAt` 是 UTC 毫秒串
 *    的条目才算数。我（Agent）生成的候选一律 `addedBy:'agent'` + `approvedAt:null` ⇒ 只供评审。
 *    理由：`wiki/AGINT/外部锚定评估架构.md` §5「LLM 只当假设生成器，不当标签源」+ §3.1 不变量 3。
 *    裁判不能是选手，这条不能靠自觉，得写进判据。
 * 2. **标签文件与被测文件不同池**：case 存 `eval/skills/<preset>/<skill>.cases.json`，
 *    测量器只换 `SKILL.md`（`outcome-measurer.js` 护栏 1），换不到标签 ⇒ 外部性由构造保证。
 * 3. ⛔ **0 条已签核 ⇒ total = 0 ⇒ 上层记 `NO_EVIDENCE`、不写行**。没签核就是没仪器，
 *    写 0 会被读成「改了但没效果」（设计 §4.2.5）。
 *
 * ## 纯函数纪律
 *
 * 与 `outcome-scope.js` 同一约定：本文件不 `import node:fs`，读写从外面注入。
 */

/** kind 封闭表：认不出的 kind = 仪器故障，不是技能不合格。 */
export const GATE_KINDS = Object.freeze({
  BODY_MUST_INCLUDE: 'body/must-include',
  BODY_MUST_NOT_INCLUDE: 'body/must-not-include',
  BODY_MUST_NOT_MATCH: 'body/must-not-match',
  FRONTMATTER_FIELD: 'frontmatter/field',
  REFERENCE_PATH_EXISTS: 'reference/path-exists',
});
const KIND_VALUES = new Set(Object.values(GATE_KINDS));

/** 唯一被承认的标签源。⛔ 不是 'agent' —— 见头注纪律 1。 */
export const GATE_APPROVER = 'boss';

/** approvedAt 必须是 UTC 毫秒串（与 prediction_outcomes.measuredAt 同一口径）。 */
const UTC_MILLIS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * SKILL.md 的最小 YAML 子集解析（标量 + `- item` 列表）。
 *
 * ⚠️ 与 `agint-quality-static/lib/checkers/skill-format.js` 的解析器等价。
 * 为什么不 import 它：跨插件直连别人的 lib 会把 driver 钉在 quality-static 的模块形状上
 * （cordis 依赖面 ≠ 文件系统可达）。等价性由 `test/skill-gate.test.mjs` 的真文件对照锁住。
 */
export function parseSkillFrontmatter(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s.startsWith('---\n')) return null;
  const end = s.indexOf('\n---', 4);
  if (end === -1) return null;
  const fields = {};
  let key = null;
  for (const raw of s.slice(4, end).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const listMatch = line.match(/^(\s*)-[ \t]+(.+)$/);
    if (listMatch) {
      if (key) fields[key].push(listMatch[2].replace(/^['"]|['"]$/g, ''));
      continue;
    }
    const kv = line.match(/^([a-zA-Z0-9_-]+):[ \t]*(.*)$/);
    if (!kv) continue;
    key = kv[1];
    const val = kv[2].trim().replace(/^['"]|['"]$/g, '');
    fields[key] = val === '' ? [] : val;
  }
  return { fields, body: s.slice(end + 4).replace(/^[\r\n]+/, '') };
}

/**
 * 单条 case 的形状校验。不合法 ⇒ 仪器故障（上层落 `SKILL_GATE_INVALID`），⛔ 不算技能失败。
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateCase(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { ok: false, reason: 'CASE_NOT_OBJECT' };
  if (typeof c.id !== 'string' || c.id.trim() === '') return { ok: false, reason: 'CASE_ID_MISSING' };
  if (typeof c.kind !== 'string' || !KIND_VALUES.has(c.kind)) {
    return { ok: false, reason: `CASE_KIND_UNKNOWN:${String(c.kind ?? '')}` };
  }
  if (c.kind === GATE_KINDS.FRONTMATTER_FIELD) {
    if (typeof c.field !== 'string' || c.field.trim() === '') return { ok: false, reason: 'CASE_FIELD_MISSING' };
    if (!['equals', 'contains', 'regex'].includes(c.op)) return { ok: false, reason: 'CASE_FIELD_OP_UNKNOWN' };
    // 空 expect 会白拿一分（缺字段时实际值也是空串）⇒ 形状层面就拒掉。
    if (typeof c.expect !== 'string' || c.expect === '') return { ok: false, reason: 'CASE_EXPECT_EMPTY_NOT_ALLOWED' };
    return { ok: true };
  }
  if (c.kind === GATE_KINDS.REFERENCE_PATH_EXISTS) return { ok: true };
  if (typeof c.expect !== 'string' || c.expect === '') return { ok: false, reason: 'CASE_EXPECT_MISSING' };
  if (c.kind === GATE_KINDS.BODY_MUST_NOT_MATCH) {
    // 正则坏 = 仪器故障（跑的时候也会抛，这里提前判掉，好在错误串里点名是哪条 case）
    try { new RegExp(c.expect); } catch { return { ok: false, reason: 'CASE_EXPECT_NOT_A_REGEX' }; }
  }
  return { ok: true };
}

/**
 * 把 case 文件里的条目分成三堆：已签核（算数）/ 待签核（不算数，只报数）/ 不合法（仪器故障）。
 *
 * @param {object} doc 解析后的 `.cases.json`
 * @returns {{approved: object[], proposed: object[], invalid: Array<{id: string|null, reason: string}>}}
 */
export function splitCases(doc) {
  const cases = Array.isArray(doc?.cases) ? doc.cases : [];
  const approved = [], proposed = [], invalid = [];
  for (const c of cases) {
    const v = validateCase(c);
    if (!v.ok) { invalid.push({ id: typeof c?.id === 'string' ? c.id : null, reason: v.reason }); continue; }
    const signed = c.addedBy === GATE_APPROVER && typeof c.approvedAt === 'string' && UTC_MILLIS_RE.test(c.approvedAt);
    if (signed) approved.push(c);
    else proposed.push(c);
  }
  return { approved, proposed, invalid };
}

function fieldValue(fields, key) {
  const v = fields[key];
  if (Array.isArray(v)) return v.join('\n');
  return typeof v === 'string' ? v : '';
}

/** 判一条已签核 case。返回 true = 这条过。 */
export function evalCase({ c, skillText, parsed, repoRoot, exists }) {
  switch (c.kind) {
    case GATE_KINDS.BODY_MUST_INCLUDE:
      return skillText.includes(c.expect);
    case GATE_KINDS.BODY_MUST_NOT_INCLUDE:
      return !skillText.includes(c.expect);
    case GATE_KINDS.BODY_MUST_NOT_MATCH:
      return !new RegExp(c.expect, 'm').test(skillText);
    case GATE_KINDS.FRONTMATTER_FIELD: {
      const actual = parsed ? fieldValue(parsed.fields, c.field) : '';
      if (c.op === 'equals') return actual === c.expect;
      if (c.op === 'contains') return actual.includes(c.expect);
      return new RegExp(c.expect, 'm').test(actual);   // 正则由已签核的 case 提供，不是用户输入通道
    }
    case GATE_KINDS.REFERENCE_PATH_EXISTS: {
      // 只核"看起来就是具体路径"的反引号引用。带 `*` / `<name>` 的是通配符与占位符，
      // 拿它们去 stat 会得到假阳性（2026-10-03 首版就在 `plugins/**/lib/*.js` 上报了 4 条假的）。
      const refs = [...skillText.matchAll(/`((?:docs|wiki|eval|bin|presets|plugins)\/[^`\s]*?\.(?:md|js|mjs|sh|json|ya?ml))`/g)]
        .map((m) => m[1])
        .filter((r) => !/[*<>]/.test(r));
      return refs.every((r) => exists(`${repoRoot}/${r}`.replace(/\/+/g, '/')));
    }
    default:
      return false;
  }
}

/**
 * 跑一个技能的门禁集。
 *
 * @param {object} input { skillText, caseDoc, repoRoot, exists }
 * @returns {{ok: boolean, error?: string, passed, failed, total, passRate,
 *            approvedCount, proposedCount, invalid, details}}
 *
 * 口径与 TAP 汇总一致：分母 = 已签核 case 数，⛔ 不含待签核（它们没资格当判据）。
 * 0 条已签核 ⇒ `passRate: null` ⇒ 上层 `NO_EVIDENCE` 且不写行（头注纪律 3）。
 */
export function runSkillGate({ skillText, caseDoc, repoRoot, exists }) {
  const { approved, proposed, invalid } = splitCases(caseDoc);
  if (invalid.length > 0) {
    return { ok: false, error: `SKILL_GATE_INVALID: ${invalid.map((i) => `${i.id ?? '?'}=${i.reason}`).join(', ')}`,
      passed: 0, failed: 0, total: 0, passRate: null, approvedCount: approved.length, proposedCount: proposed.length, invalid, details: [] };
  }
  const text = typeof skillText === 'string' ? skillText : '';
  const parsed = parseSkillFrontmatter(text);
  const details = [];
  let passed = 0;
  for (const c of approved) {
    let ok = false;
    try {
      ok = evalCase({ c, skillText: text, parsed, repoRoot, exists }) === true;
    } catch (error) {
      // 判据自己跑挂了（比如非法正则）= 仪器故障，不能记成"技能不合格"。
      return { ok: false, error: `SKILL_GATE_CASE_ERROR: ${c.id}: ${error?.message ?? error}`,
        passed: 0, failed: 0, total: 0, passRate: null, approvedCount: approved.length, proposedCount: proposed.length, invalid, details };
    }
    details.push({ id: c.id, kind: c.kind, ok });
    if (ok) passed += 1;
  }
  const total = approved.length;
  return {
    ok: true, error: null, passed, failed: total - passed, total,
    passRate: total === 0 ? null : passed / total,
    approvedCount: total, proposedCount: proposed.length, invalid: [], details,
  };
}

/**
 * 门禁 runner（与 `nodeTestRunner` 同一签名，可直接塞进 `createOutcomeMeasurer`）。
 *
 * `files` = `outcome-scope` 的产物：`[SKILL.md, <skill>.cases.json]`。
 * 认不出配对（缺一个或各多于一个）⇒ `{ok:false}` ⇒ 上层判仪器故障，不写行。
 *
 * @param {object} deps { read, exists }
 */
export function createSkillGateRunner({ read, exists }) {
  return async function skillGateRunner({ repoRoot, files }) {
    const list = (Array.isArray(files) ? files : []).map((f) => String(f).replace(/\\/g, '/'));
    const caseFile = list.filter((f) => f.endsWith('.cases.json'));
    const skillFile = list.filter((f) => f.endsWith('/SKILL.md') || f === 'SKILL.md');
    if (caseFile.length !== 1 || skillFile.length !== 1) {
      return { ok: false, timedOut: false, stdout: '', stderr: '', error: `SKILL_GATE_FILE_PAIR_BAD:${list.join(',')}` };
    }
    let skillBuf, caseBuf;
    try {
      skillBuf = await read(`${repoRoot}/${skillFile[0]}`.replace(/\/+/g, '/'));
      caseBuf = await read(`${repoRoot}/${caseFile[0]}`.replace(/\/+/g, '/'));
    } catch (error) {
      return { ok: false, timedOut: false, stdout: '', stderr: '', error: `SKILL_GATE_READ_FAILED: ${error?.message ?? error}` };
    }
    let caseDoc = null;
    let parseError = null;
    try {
      caseDoc = JSON.parse(String(caseBuf));
    } catch (error) {
      parseError = error?.message ?? String(error);
    }
    if (parseError || !caseDoc || typeof caseDoc !== 'object' || Array.isArray(caseDoc)) {
      return { ok: false, timedOut: false, stdout: '', stderr: '', error: `SKILL_GATE_CASE_UNPARSEABLE: ${parseError ?? 'not an object'}` };
    }
    const out = runSkillGate({ skillText: String(skillBuf), caseDoc, repoRoot, exists });
    if (!out.ok) return { ok: false, timedOut: false, stdout: '', stderr: '', error: out.error, gate: out };
    return { ok: true, timedOut: false, stdout: '', stderr: '', error: null, gate: out };
  };
}

export default { GATE_KINDS, GATE_APPROVER, parseSkillFrontmatter, validateCase, splitCases, evalCase, runSkillGate, createSkillGateRunner };
