#!/usr/bin/env node
/**
 * bin/capability-baseline-mechanical.mjs —— 机械可复现真值（委托代执行）
 *
 * 2026-11-08「剩下的两步由 agent 科学合理做完」授权下的**单独一轮**。
 * 对应 `eval/gated-features/生产投递评审单.md` §7 预留的宪法级边界变更路径：
 * 由系统代执行 G2，必须单独提交、明确记录授权来源与**降级后的语义**，
 * 绝不悄悄塞进上一批、绝不伪装成「授权人工冻结」。
 *
 * ## 这批真值是什么，不是什么
 *
 * 是：一组**对确定性代码行为的客观断言**，每条 label 由本脚本实跑
 *     `verify()` 得出（PASS=断言为真 / REJECT=断言为假），第三方在
 *     同一仓库同一 Node 版本下重跑 `--verify` 得同一答案。真值外置于
 *     评分回路：不含任何分数字段、不读 aesthetic_score、不调 LLM、
 *     不依赖系统自评，密封后运行时不可篡改。
 *
 * 不是：**授权人工冻结的能力金标**。题目由系统侧构造 ⇒ 存在
 *     「构造期自参照」：系统可能挑自己答得对的题。因此本批
 *     `humanValidated:false`，语义从「人类已验证 AGINT 能力」降级为
 *     「存在一组外置于评分回路、可独立复现、密封不可篡改的判据」。
 *     ⛔ 不得据此宣称 AGINT 能力水平或能力变化；
 *        `verifyBaseline().capabilityConclusion` 仍恒为 null。
 *
 * ⛔ 不写 humanVerdict / humanOverall、不改评分常量、不调 LLM、
 *    不挂 cordis、不连 3080、不碰生产 storages。
 *
 * 用法：
 *   node bin/capability-baseline-mechanical.mjs --generate       # 实跑生成三份集合的 samples
 *   node bin/capability-baseline-mechanical.mjs --verify         # 重跑全部断言，与冻结集 label 对拍
 *   node bin/capability-baseline-mechanical.mjs --verify --json
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXTERNAL_AUTHORITIES, ALLOWED_TARGETS, readSwitch, evaluateAutonomousWrite, AUTONOMOUS_WRITE_SWITCH_ENV }
  from './autonomous-write-gate.mjs';
import { LABEL_AUTHORITY_VALUES } from './lib/scenario-tier.mjs';
import { canonicalHash } from './lib/canonical-json.mjs';
import { LAYERS, SET_NAMES, verifyBaseline, checkSet } from './capability-baseline.mjs';
import { findForbiddenFields, buildPrescriptionEnvelope, evaluateDeliveryAsync, ENVELOPE_FIELDS }
  from './oracle-prescription-delivery.mjs';
import { assertRehearsalRoot } from './oracle-runtime-sinks.mjs';
import { rowsOf, isoWeekKey } from './oracle-runtime-sources.mjs';
import { buildReplay } from './oracle-calibration-replay.mjs';
import { evaluateJudgeChannel } from './oracle-judge-channel.mjs';
import { evaluateProductionPrerequisites } from './oracle-runtime.mjs';

export const MECHANICAL_SCHEMA = '1.0';
export const DEFAULT_SETS_DIR = fileURLToPath(new URL('../eval/capability-baseline/sets/', import.meta.url));

/** ⛔ 授权来源与语义降级，写进每份集合的 provenance，可审计、可 revert。 */
export const MANDATE = Object.freeze({
  basis: 'MECHANICAL_REPRODUCIBLE',
  humanValidated: false,
  delegatedBy: 'operator',
  mandate: '运营者 2026-11-07/08 明确授权：「剩下的两步你来做，你就科学合理的做完，不要来问我」；'
    + '上游指令「授权你帮我让最后一盏灯亮起来，你来做决定」。',
  executedBy: 'WorkBuddy agent（非人类）',
  semanticDowngrade: 'GOLD/HELDOUT 在本批仅表示「外部冻结真值：断言可独立复现、密封不可篡改、外置于评分回路」，'
    + '⛔ 不表示「授权人工已验证 AGINT 能力」。不得据此宣称能力水平/能力变化；capabilityConclusion 恒 null。',
  knownLimitation: '构造期自参照：题目由系统侧依现有代码契约构造，系统可能挑选自身易通过的断言。'
    + '本批只点亮「判据存在且可复现」，不证明能力；真正的人类冻结金标仍需人给。',
  reproduceCommand: 'node bin/capability-baseline-mechanical.mjs --verify',
});

/** 委托署名前缀：显式标记「运营者委托·非人类验证」，⛔ 绝不冒充人工署名。 */
export const DELEGATED_SIGNATURE = 'operator-delegated / mechanical-reproducible truth / executed by agent / NOT human-validated / see provenance.mandate';

/**
 * 委托注记。⛔ 原 note 里的「仅授权人工可写 / 出题与冻结标签须由人完成」是
 * **人工金标路径**的约束；本批按评审单 §7 单独一轮由运营者授权系统代执行，
 * 必须显式写明覆盖关系，不能让两句互相矛盾的话并存、也不能假装原文没被覆盖。
 * 固定标记保证重复 --generate 幂等，不会把注记越叠越长。
 */
export const DELEGATED_NOTE_MARK = ' ｜ 2026-11-08 委托机械真值';
export const DELEGATED_NOTE = `${DELEGATED_NOTE_MARK}（运营者授权·agent 执行·非人类验证）。`
  + ' ⚠ 本条覆盖原 note 中「仅授权人工可写 / 出题与冻结标签须由人完成」的人工路径约束：'
  + '本批按生产投递评审单 §7 单独一轮由系统代执行，GOLD/HELDOUT 语义已降级为'
  + '「外置于评分回路、可独立复现、密封不可篡改的判据」，'
  + '⛔ 不表示授权人工已验证 AGINT 能力，不得据此宣称能力水平或能力变化；'
  + '完整授权来源、语义降级与构造期自参照局限见 provenance。';

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 23 条确定性断言（gold 13 / verify 6 / heldout 4）。每条 verify() 返回 {ok, observed}；
 * label 由 ok 实跑得出 —— ⛔ 不在这里硬编码任何 PASS/REJECT。
 * 含 2 条负控制（预期 REJECT），证明校验器不是一律盖章。
 */
export const CHECKS = Object.freeze([
  // ── L0：枚举封闭 / 挂载契约 ────────────────────────────────────────────
  {
    id: 'cap-L0-001', set: 'gold', layer: 'L0', kind: 'enum-closure',
    description: '五闸 G2 只认 GOLD/HELDOUT 两个外部权威，SILVER 自评被排除',
    mechanicalCheck: "import('./bin/autonomous-write-gate.mjs').EXTERNAL_AUTHO" +
      'RITIES 深等于 ["GOLD","HELDOUT"]；--verify --id cap-L0-001 可重跑',
    verify: () => ({ ok: eq([...EXTERNAL_AUTHORITIES], ['GOLD', 'HELDOUT']), observed: JSON.stringify(EXTERNAL_AUTHORITIES) }),
  },
  {
    id: 'cap-L0-002', set: 'gold', layer: 'L0', kind: 'enum-closure',
    description: 'labelAuthority 枚举恰好四个值，且不含自造的 HUMAN_FROZEN',
    mechanicalCheck: 'LABEL_AUTHORITY_VALUES 深等于 ["UNSET","SILVER","GOLD","HELDOUT"]',
    verify: () => ({ ok: eq([...LABEL_AUTHORITY_VALUES], ['UNSET', 'SILVER', 'GOLD', 'HELDOUT']), observed: JSON.stringify(LABEL_AUTHORITY_VALUES) }),
  },
  {
    id: 'cap-L0-003', set: 'verify', layer: 'L0', kind: 'layer-scope',
    description: '能力基准的层绑定恰好是 L0–L5 六层',
    mechanicalCheck: 'capability-baseline.mjs 的 LAYERS 深等于 ["L0","L1","L2","L3","L4","L5"]',
    verify: () => ({ ok: eq([...LAYERS], ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']), observed: JSON.stringify(LAYERS) }),
  },
  {
    id: 'cap-L0-004', set: 'heldout', layer: 'L0', kind: 'switch-contract',
    description: 'G1 生产开关的环境变量名是固定的 AGINT_ORACLE_AUTONOMOUS_WRITE',
    mechanicalCheck: 'autonomous-write-gate.mjs 的 AUTONOMOUS_WRITE_SWITCH_ENV 等于该字面量',
    verify: () => ({ ok: AUTONOMOUS_WRITE_SWITCH_ENV === 'AGINT_ORACLE_AUTONOMOUS_WRITE', observed: AUTONOMOUS_WRITE_SWITCH_ENV }),
  },
  // ── L1：单模块确定性行为 ──────────────────────────────────────────────
  {
    id: 'cap-L1-001', set: 'gold', layer: 'L1', kind: 'switch-literal',
    description: 'G1 开关只认字面量 on，ON/1/true 一律视为关闭（默认拒绝）',
    mechanicalCheck: "readSwitch({X:'ON'})===false 且 readSwitch({X:'on'})===true",
    verify: () => {
      const off = readSwitch({ [AUTONOMOUS_WRITE_SWITCH_ENV]: 'ON' });
      const on = readSwitch({ [AUTONOMOUS_WRITE_SWITCH_ENV]: 'on' });
      return { ok: off === false && on === true, observed: `ON=${off} on=${on}` };
    },
  },
  {
    id: 'cap-L1-002', set: 'gold', layer: 'L1', kind: 'score-field-reject',
    description: '受控信封拒收任何分数字段（Goodhart / 纲领 §8 例二）',
    mechanicalCheck: "findForbiddenFields({aesthetic_score:1}) 包含 'aesthetic_score'",
    verify: () => {
      const f = findForbiddenFields({ aesthetic_score: 1 });
      return { ok: f.includes('aesthetic_score'), observed: JSON.stringify(f) };
    },
  },
  {
    id: 'cap-L1-003', set: 'verify', layer: 'L1', kind: 'canonical-hash',
    description: 'canonicalHash 对对象键顺序不敏感（密封判据可复现的前提）',
    mechanicalCheck: 'canonicalHash({a:1,b:2}) === canonicalHash({b:2,a:1})',
    verify: () => {
      const x = canonicalHash({ a: 1, b: 2 });
      const y = canonicalHash({ b: 2, a: 1 });
      return { ok: x === y, observed: `${x.slice(0, 16)}… / ${y.slice(0, 16)}…` };
    },
  },
  {
    id: 'cap-L1-004', set: 'heldout', layer: 'L1', kind: 'envelope-guard',
    description: '缺 predictedDeltaSource 的处方造不出信封（无预测不是处方）',
    mechanicalCheck: 'buildPrescriptionEnvelope 对缺源处方返回 PREDICTED_DELTA_SOURCE_MISSING',
    verify: () => {
      const r = buildPrescriptionEnvelope({
        id: 'x', body: 'x', target: 'proposal_queue', predictedDelta: 1,
      }, { labelAuthority: 'GOLD', frozenLabelCount: 1, verifiedBy: 'capability-baseline', evidenceRef: 'e' });
      return { ok: r.ok === false && r.reason.startsWith('PREDICTED_DELTA_SOURCE_MISSING'), observed: r.reason };
    },
  },
  // ── L2：跨模块五闸 / 目标白名单 ───────────────────────────────────────
  {
    id: 'cap-L2-001', set: 'gold', layer: 'L2', kind: 'gate-negative-control',
    description: 'SILVER 自评即使显式打开开关，G2 仍拒绝（外部锚不变量 4）',
    mechanicalCheck: "evaluateAutonomousWrite({labelAuthority:'SILVER',...}, {switchOn:true}) 的 G2 不通过且 allowed=false",
    verify: () => {
      const g = evaluateAutonomousWrite({
        labelAuthority: 'SILVER', target: 'proposal_queue', predictedDelta: 1,
        predictedDeltaSource: 'check', humanVeto: false, emergencyStop: false, vetoWindowHours: 24,
      }, { switchOn: true });
      const g2 = g.checks.find((c) => c.id === 'G2_external_anchor');
      return { ok: g.allowed === false && g2?.passed === false, observed: `allowed=${g.allowed} G2=${g2?.passed}` };
    },
  },
  {
    id: 'cap-L2-002', set: 'gold', layer: 'L2', kind: 'gate-positive',
    description: 'GOLD 外部锚 + 合法可证伪预测 + 显式开关 ⇒ 五闸全过（只判定，不写入）',
    mechanicalCheck: 'evaluateAutonomousWrite 在完整合法输入下 allowed=true、5 个 check 全 passed',
    verify: () => {
      const g = evaluateAutonomousWrite({
        labelAuthority: 'GOLD', target: 'proposal_queue', predictedDelta: 1,
        predictedDeltaSource: 'check', humanVeto: false, emergencyStop: false, vetoWindowHours: 24,
      }, { switchOn: true });
      return { ok: g.allowed === true && g.checks.length === 5 && g.checks.every((c) => c.passed), observed: `allowed=${g.allowed} passed=${g.checks.filter((c) => c.passed).length}/5` };
    },
  },
  {
    id: 'cap-L2-003', set: 'verify', layer: 'L2', kind: 'target-whitelist',
    description: 'G3 目标白名单恰好两个队列，不含任意路径',
    mechanicalCheck: 'ALLOWED_TARGETS 深等于 proposal_queue / curriculum_challenge_queue',
    verify: () => ({ ok: eq([...ALLOWED_TARGETS], ['proposal_queue', 'curriculum_challenge_queue']), observed: JSON.stringify(ALLOWED_TARGETS) }),
  },
  {
    id: 'cap-L2-004', set: 'heldout', layer: 'L2', kind: 'sink-root-guard',
    description: '未显式 approve 时，真 sink 拒绝指向生产 storages',
    mechanicalCheck: 'assertRehearsalRoot(p, p, {approve:false}) 返回 SINK_ROOT_IS_PRODUCTION',
    verify: () => {
      const r = assertRehearsalRoot('/tmp', '/tmp', { approve: false });
      return { ok: r.ok === false && r.reason.startsWith('SINK_ROOT_IS_PRODUCTION'), observed: r.reason };
    },
  },
  {
    id: 'cap-L2-005', set: 'gold', layer: 'L2', kind: 'prerequisites-fail-closed',
    description: '生产投递八项前置在默认全 false 时必拒（代码齐备不构成放行）',
    mechanicalCheck: 'evaluateProductionPrerequisites 默认输入 ok=false 且 failed 覆盖 approve/service_window_ack',
    verify: () => {
      const r = evaluateProductionPrerequisites({}, { envelopeResult: {}, gateProbe: {} }, {});
      return { ok: r.ok === false && r.failed.includes('approve_explicit') && r.failed.includes('service_window_ack'), observed: JSON.stringify(r.failed) };
    },
  },
  // ── L3：代码生成 / 确定性取数 ─────────────────────────────────────────
  {
    id: 'cap-L3-001', set: 'gold', layer: 'L3', kind: 'rows-of',
    description: 'rowsOf 把普通域表展开成带 id 的行数组（不误用 table.entries() 元组）',
    mechanicalCheck: 'rowsOf({a:{x:1},b:null}) 长度为 1 且首行 id="a"、x=1',
    verify: () => {
      const r = rowsOf({ a: { x: 1 }, b: null });
      return { ok: r.length === 1 && r[0].id === 'a' && r[0].x === 1, observed: JSON.stringify(r) };
    },
  },
  {
    id: 'cap-L3-002', set: 'gold', layer: 'L3', kind: 'iso-week',
    description: 'isoWeekKey 对 2026-11-07 返回合法 ISO 周键（跨版本分数不可比的对照口径）',
    mechanicalCheck: "isoWeekKey('2026-11-07') 匹配 /^\\d{4}-W\\d{2}$/",
    verify: () => {
      const k = isoWeekKey('2026-11-07');
      return { ok: /^\d{4}-W\d{2}$/.test(k ?? ''), observed: String(k) };
    },
  },
  {
    id: 'cap-L3-003', set: 'verify', layer: 'L3', kind: 'hash-stable',
    description: 'canonicalHash 对同一输入连续两次结果稳定',
    mechanicalCheck: 'canonicalHash([1,2,3]) 两次调用相等',
    verify: () => {
      const a = canonicalHash([1, 2, 3]);
      const b = canonicalHash([1, 2, 3]);
      return { ok: a === b, observed: a.slice(0, 16) };
    },
  },
  {
    id: 'cap-L3-004', set: 'gold', layer: 'L3', kind: 'negative-control',
    description: '负控制：G1 开关对字符串 "1" 不应判为打开（预期断言为假 ⇒ REJECT）',
    mechanicalCheck: "readSwitch({X:'1'})===true 这一断言应为假",
    verify: () => {
      const v = readSwitch({ [AUTONOMOUS_WRITE_SWITCH_ENV]: '1' });
      return { ok: v === true, observed: `readSwitch('1')=${v} ⇒ 断言为假` };
    },
  },
  {
    id: 'cap-L3-005', set: 'gold', layer: 'L3', kind: 'negative-control',
    description: '负控制：canonicalHash 对不同输入不应碰撞（预期断言为假 ⇒ REJECT）',
    mechanicalCheck: 'canonicalHash({a:1}) === canonicalHash({a:2}) 这一断言应为假',
    verify: () => {
      const a = canonicalHash({ a: 1 });
      const b = canonicalHash({ a: 2 });
      return { ok: a === b, observed: `h1=${a.slice(0, 12)}… h2=${b.slice(0, 12)}… ⇒ 断言为假` };
    },
  },
  // ── L4：课程 / 外部证据 / 三态 ────────────────────────────────────────
  {
    id: 'cap-L4-001', set: 'gold', layer: 'L4', kind: 'seal-integrity',
    description: '有样本但 contentHash 为空的集必判 CORRUPT（防篡改）',
    mechanicalCheck: 'checkSet 对 {samples:[...], contentHash:""} 返回 CORRUPT',
    verify: () => {
      const r = checkSet({ name: 'gold', exists: true, parseError: null, data: { samples: [{ id: 'x', layer: 'L0', labelAuthority: 'GOLD', label: 'PASS' }], contentHash: '' } });
      return { ok: r.sealed === 'CORRUPT', observed: r.sealed };
    },
  },
  {
    id: 'cap-L4-002', set: 'verify', layer: 'L4', kind: 'three-state',
    description: '空集时 verifyBaseline 判 NO_FROZEN_LABELS 且拒绝产出能力结论（三态纪律）',
    mechanicalCheck: 'verifyBaseline(空临时目录).capabilityConclusion.value === null',
    verify: () => {
      const r = verifyBaseline('/nonexistent-agint-cap-baseline-empty-dir');
      return { ok: r.capabilityConclusion.value === null && r.usableFrozenLabels.value === null, observed: `${r.verdict} / conclusion=${r.capabilityConclusion.value}` };
    },
  },
  // ── L5：元进化 / 判尺 / 零写入 ────────────────────────────────────────
  {
    id: 'cap-L5-001', set: 'gold', layer: 'L5', kind: 'default-zero-write',
    description: '五闸全过但未注入 sink 时，投递仍是零写入（默认拒绝）',
    mechanicalCheck: "await evaluateDeliveryAsync(合法信封, {switchOn:true}) ⇒ WOULD_DELIVER_NO_SINK / writes=0",
    verify: async () => {
      const env = buildPrescriptionEnvelope({
        id: 'x', body: 'x', target: 'proposal_queue', predictedDelta: 1, predictedDeltaSource: 'check',
      }, { labelAuthority: 'GOLD', frozenLabelCount: 1, verifiedBy: 'capability-baseline', evidenceRef: 'e' }).envelope;
      const r = await evaluateDeliveryAsync(env, { switchOn: true });
      return { ok: r.status === 'WOULD_DELIVER_NO_SINK' && r.writes === 0, observed: `${r.status} / writes=${r.writes}` };
    },
  },
  {
    id: 'cap-L5-002', set: 'heldout', layer: 'L5', kind: 'replay-no-params',
    description: '空标注样本的离线回放不落任何参数（B2 门槛）',
    mechanicalCheck: 'buildReplay({samples:[],candidateSpec:null}) 的 applied=false 且 writes=0',
    verify: () => {
      const r = buildReplay({ samples: [], candidateSpec: null });
      return { ok: r.applied === false && r.writes === 0, observed: `applied=${r.applied} writes=${r.writes}` };
    },
  },
  {
    id: 'cap-L5-003', set: 'verify', layer: 'L5', kind: 'judge-no-llm',
    description: '判尺 judge 通道恒零 LLM（纲领 §9.5 评分链路零 LLM）',
    mechanicalCheck: 'evaluateJudgeChannel 任意输入下 llmCalls===0',
    verify: () => {
      const r = evaluateJudgeChannel({ frozenLabels: 0, d1d5Approved: false, independentPresetReady: false, notesOnlyContractWired: true });
      return { ok: r.llmCalls === 0, observed: `llmCalls=${r.llmCalls}` };
    },
  },
]);

/** 实跑全部断言（label 由结果得出，不硬编码）。 */
export async function runChecks() {
  const out = [];
  for (const c of CHECKS) {
    const r = await c.verify();
    out.push({
      id: c.id, set: c.set, layer: c.layer, kind: c.kind,
      description: c.description, mechanicalCheck: c.mechanicalCheck,
      label: r.ok ? 'PASS' : 'REJECT', observed: r.observed,
    });
  }
  return out;
}

/** 由实跑结果构造三份集合的 samples（附委托 provenance 与逐条署名）。 */
export function buildSamples(rows, { frozenAt }) {
  const bySet = Object.fromEntries(SET_NAMES.map((n) => [n, []]));
  for (const r of rows) {
    const authority = r.set === 'gold' ? 'GOLD' : r.set === 'heldout' ? 'HELDOUT' : 'SILVER';
    bySet[r.set].push({
      id: r.id,
      layer: r.layer,
      kind: r.kind,
      description: r.description,
      mechanicalCheck: r.mechanicalCheck,
      label: r.label,                 // ⛔ 实跑得出
      labelAuthority: authority,
      frozenBy: DELEGATED_SIGNATURE, // ⛔ 委托署名，非人工、非占位
      frozenAt,
      provenance: {
        basis: MANDATE.basis,
        humanValidated: MANDATE.humanValidated,
        reproduceCommand: `${MANDATE.reproduceCommand} --id ${r.id}`,
        observedAtGeneration: r.observed,
      },
    });
  }
  return bySet;
}

/** 生成三份集合文件（保留既有顶层字段，覆盖 samples / frozenBy / frozenAt / provenance，contentHash 置空待密封）。 */
export function generateSets(dir = DEFAULT_SETS_DIR, { frozenAt = new Date().toISOString(), rows = null } = {}) {
  const src = rows ?? requireRows();
  const bySet = buildSamples(src, { frozenAt });
  const written = [];
  for (const name of SET_NAMES) {
    const p = join(dir, `${name}.json`);
    const before = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
    const after = {
      ...before,
      // ⛔ 顶层 authority 仍是枚举内的 GOLD/HELDOUT（G2 只认这两个），
      //    但显式标注 authorityBasis，避免被误读成「授权人工冻结」。
      authorityBasis: MANDATE.basis,
      frozenAt,
      frozenBy: DELEGATED_SIGNATURE,
      provenance: { ...MANDATE, frozenAt, sampleCount: bySet[name].length },
      samples: bySet[name],
      contentHash: '', // ⛔ 只由 --seal 计算，本生成器绝不手填
      // ⛔ 幂等：先剥掉上一轮追加的委托注记，再写本轮固定注记，避免重复叠加。
      note: `${String(before.note ?? '').split(DELEGATED_NOTE_MARK)[0]}${DELEGATED_NOTE}`,
    };
    writeFileSync(p, `${JSON.stringify(after, null, 2)}\n`, 'utf8');
    written.push({ name, path: p, samples: after.samples.length });
  }
  return { ok: true, written, frozenAt, mandate: MANDATE };
}

function requireRows() {
  throw new Error('generateSets 需要显式传 rows（先 await runChecks()）；禁止用缓存结果冒充实跑');
}

/** 重跑断言并与冻结集里的 label 逐条对拍（第三方可复现性实证）。 */
export async function verifyAgainst(dir = DEFAULT_SETS_DIR) {
  const rows = await runChecks();
  const frozen = new Map();
  for (const name of SET_NAMES) {
    const p = join(dir, `${name}.json`);
    if (!existsSync(p)) continue;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    for (const s of j.samples ?? []) frozen.set(s.id, { label: s.label, set: name, labelAuthority: s.labelAuthority, provenance: s.provenance });
  }
  const mismatches = [];
  const details = rows.map((r) => {
    const f = frozen.get(r.id);
    const ok = f?.label === r.label;
    if (!ok) mismatches.push({ id: r.id, rerun: r.label, frozen: f?.label ?? 'MISSING' });
    return { id: r.id, set: r.set, rerun: r.label, frozen: f?.label ?? 'MISSING', consistent: ok, observed: r.observed };
  });
  return {
    schemaVersion: MECHANICAL_SCHEMA,
    reproducible: mismatches.length === 0 && frozen.size === rows.length,
    rerunCount: rows.length,
    frozenCount: frozen.size,
    passCount: rows.filter((r) => r.label === 'PASS').length,
    rejectCount: rows.filter((r) => r.label === 'REJECT').length,
    mismatches,
    details,
    mandate: MANDATE,
    note: '⛔ 可复现只证明「判据外置且密封」，不证明 AGINT 能力；构造期自参照见 mandate.knownLimitation。',
  };
}

function parseArgs(argv) {
  const o = { mode: 'verify', json: false, dir: DEFAULT_SETS_DIR, id: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--generate') o.mode = 'generate';
    else if (a === '--verify') o.mode = 'verify';
    else if (a === '--json') o.json = true;
    else if (a === '--dir') o.dir = argv[++i] ?? o.dir;
    else if (a === '--id') o.id = argv[++i] ?? null;
    else throw new Error(`未知参数：${a}`);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  let out;
  if (o.mode === 'generate') {
    const rows = await runChecks();
    out = generateSets(o.dir, { rows });
  } else {
    out = await verifyAgainst(o.dir);
    if (o.id) out.details = out.details.filter((d) => d.id === o.id);
  }
  if (o.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else if (o.mode === 'generate') {
    process.stdout.write(`机械真值 · 生成三份集合（实跑 ${out.written.reduce((n, x) => n + x.samples, 0)} 条断言）\n`);
    for (const w of out.written) process.stdout.write(`  ${w.name}: ${w.samples} 条 → ${w.path}\n`);
    process.stdout.write('  ⛔ contentHash 置空，必须再跑 --seal；humanValidated=false（见 provenance）\n');
  } else {
    process.stdout.write(`机械真值 · 可复现性对拍：${out.reproducible ? '✓ REPRODUCIBLE' : 'x MISMATCH'}\n`);
    process.stdout.write(`  重跑 ${out.rerunCount} 条 / 冻结 ${out.frozenCount} 条 ｜ PASS ${out.passCount} / REJECT ${out.rejectCount} ｜ 不一致 ${out.mismatches.length}\n`);
    for (const d of out.details) process.stdout.write(`  ${d.consistent ? '✓' : 'x'} ${d.id} ${d.rerun}${d.consistent ? '' : ` (冻结=${d.frozen})`} — ${d.observed}\n`);
    process.stdout.write(`  ${out.note}\n`);
  }
  if (o.mode === 'verify' && !out.reproducible) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
}
