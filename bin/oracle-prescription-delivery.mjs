#!/usr/bin/env node
/**
 * bin/oracle-prescription-delivery.mjs —— B1 受控投递通道（纲领附二 R1/R2）
 *
 * 2026-11-07 老板选「实现功能但守住闸门」：本模块是 B1 的**可执行形态**，
 * 但默认关闭、默认零写入。功能代码齐备，运行态不改变任何既有行为。
 *
 * ⛔ 纯函数：零 I/O、零服务访问、零 LLM；不挂 cordis、不建 storage 域、
 *    不注册 cron、不写队列。唯一可能的写入是调用方**显式注入**的 sink，
 *    默认 sink=null ⇒ writes 恒为 0。
 * ⛔ 五闸强制：任何路径都先经 evaluateAutonomousWrite()，defaultDeny 恒 true。
 * ⛔ 不读任何分数字段：处方里出现 aesthetic_score / score / 四维 / Q1·Q2
 *    / 阈值·权重 / 人工标注字段一律拒收（Goodhart / 纲领 §8 例二）。
 * ⛔ 状态恒为 proposed：不批准、不执行、不改系统（附二 R3「投递 ≠ 修改」）。
 *
 * 生产接线时才注入真 sink，且 sink 必须走面板/插件 lib、不得直写 storages。
 *
 * 用法：
 *   node bin/oracle-prescription-delivery.mjs            # 只读五闸探针
 *   node bin/oracle-prescription-delivery.mjs --switch-on --json
 */

import { fileURLToPath } from 'node:url';
import {
  evaluateAutonomousWrite, readSwitch, ALLOWED_TARGETS,
  EXTERNAL_AUTHORITIES, AUTONOMOUS_WRITE_SWITCH_ENV,
} from './autonomous-write-gate.mjs';

export const DELIVERY_SCHEMA = '1.0';

/** ⛔ 处方/锚里禁止出现的一切「分数 / 判尺 / 标注」字段。 */
export const FORBIDDEN_PRESCRIPTION_FIELDS = Object.freeze([
  'aesthetic_score', 'aestheticScore', 'score', 'scoreDelta', 'scoreImproved',
  'composites', 'noise', 'confidence', 'redundancy', 'bloat',
  'THRESHOLDS', 'DIM_WEIGHTS', 'SCALE_SPEC', 'scaleHash', 'FORMULA_VERSION',
  'q1', 'q2', 'q3', 'verdict', 'humanVerdict', 'humanOverall', 'annotatedAt',
]);

/** 信封字段白名单：状态只能是 proposed，其余一律不收。 */
export const ENVELOPE_FIELDS = Object.freeze([
  'schemaVersion', 'id', 'status', 'target', 'predictedDelta',
  'predictedDeltaSource', 'labelAuthority', 'evidenceRef', 'frozenLabelCount',
  'body', 'asOf',
]);

function fail(reason, extra = {}) {
  return { ok: false, reason, writes: 0, ...extra };
}

/** 检测对象（含嵌套一层）里是否混入了分数字段。 */
export function findForbiddenFields(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const found = [];
  for (const [k, v] of Object.entries(obj)) {
    if (FORBIDDEN_PRESCRIPTION_FIELDS.includes(k)) found.push(k);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const kk of Object.keys(v)) {
        if (FORBIDDEN_PRESCRIPTION_FIELDS.includes(kk)) found.push(`${k}.${kk}`);
      }
    }
  }
  return [...new Set(found)];
}

/**
 * 造一份候选处方信封。**不写任何东西**。
 * @param {object} prescription 处方正文（id/body/target/predictedDelta/predictedDeltaSource）
 * @param {object} anchor 外部冻结锚（labelAuthority/frozenLabelCount/verifiedBy/evidenceRef）
 */
export function buildPrescriptionEnvelope(prescription = {}, anchor = {}) {
  const bad = [...findForbiddenFields(prescription), ...findForbiddenFields(anchor)];
  if (bad.length) {
    return fail(`SCORE_FIELD_PRESENT: 处方/锚里混入了分数字段 ${bad.join(', ')} ⇒ 五闸刻意不读分数`);
  }

  const p = prescription && typeof prescription === 'object' ? prescription : {};
  const a = anchor && typeof anchor === 'object' ? anchor : {};

  if (typeof p.id !== 'string' || !p.id.trim()) return fail('MISSING_ID');
  if (typeof p.body !== 'string' || !p.body.trim()) return fail('MISSING_BODY');
  if (!ALLOWED_TARGETS.includes(p.target)) {
    return fail(`TARGET_NOT_ALLOWED: ${JSON.stringify(p.target)} 不在白名单 ${ALLOWED_TARGETS.join('/')}`);
  }
  if (typeof p.predictedDelta !== 'number' || !Number.isFinite(p.predictedDelta)) {
    return fail('PREDICTED_DELTA_INVALID: 须为有限数，否则无法与 actualDelta 对拍');
  }
  if (typeof p.predictedDeltaSource !== 'string' || !p.predictedDeltaSource.trim()) {
    return fail('PREDICTED_DELTA_SOURCE_MISSING: 无预测的处方不是处方');
  }

  if (!EXTERNAL_AUTHORITIES.includes(a.labelAuthority)) {
    return fail(`ANCHOR_NOT_EXTERNAL: labelAuthority=${JSON.stringify(a.labelAuthority)} 不是 GOLD/HELDOUT（SILVER 自评不算）`);
  }
  if (!Number.isFinite(a.frozenLabelCount) || a.frozenLabelCount <= 0) {
    return fail('NO_FROZEN_LABELS: 0 条外部冻结标签 ⇒ 处方没有可对照的真值');
  }
  if (a.verifiedBy !== 'capability-baseline') {
    return fail('ANCHOR_UNVERIFIED: 锚必须由 capability-baseline 只读校验器产出');
  }
  if (typeof a.evidenceRef !== 'string' || !a.evidenceRef.trim()) return fail('EVIDENCE_REF_MISSING');

  return {
    ok: true,
    reason: 'ENVELOPE_BUILT: 仅构造候选信封，未写入任何队列',
    writes: 0,
    envelope: Object.freeze({
      schemaVersion: DELIVERY_SCHEMA,
      id: p.id,
      status: 'proposed',
      target: p.target,
      predictedDelta: p.predictedDelta,
      predictedDeltaSource: p.predictedDeltaSource,
      labelAuthority: a.labelAuthority,
      evidenceRef: a.evidenceRef,
      frozenLabelCount: a.frozenLabelCount,
      body: p.body,
      asOf: p.asOf ?? null,
    }),
  };
}

/**
 * 评估一次投递。**默认零写入**：只有五闸全过且显式注入 sink 才可能 writes=1。
 * @param {object} envelope buildPrescriptionEnvelope 产出的信封
 * @param {{env?:object, switchOn?:boolean|null, sink?:Function|null,
 *          humanVeto?:boolean, emergencyStop?:boolean, vetoWindowHours?:number}} options
 */
export function evaluateDelivery(envelope, options = {}) {
  const {
    env = process.env,
    switchOn = null,
    sink = null,
    humanVeto = false,
    emergencyStop = false,
    vetoWindowHours = 24,
  } = options;

  const base = {
    schemaVersion: DELIVERY_SCHEMA,
    defaultDeny: true,
    writes: 0,
    sinkInvoked: false,
    delivered: false,
  };

  if (!envelope || envelope.status !== 'proposed') {
    return { ...base, status: 'NO_ENVELOPE', reason: '信封无效或状态不是 proposed ⇒ 零写入' };
  }

  const sw = switchOn === null ? readSwitch(env) : switchOn === true;
  const gate = evaluateAutonomousWrite({
    labelAuthority: envelope.labelAuthority,
    target: envelope.target,
    predictedDelta: envelope.predictedDelta,
    predictedDeltaSource: envelope.predictedDeltaSource,
    humanVeto,
    emergencyStop,
    vetoWindowHours,
  }, { switchOn: sw });

  if (!gate.allowed) {
    return { ...base, status: 'DEFAULT_DENY', reason: gate.reason, gate };
  }

  if (typeof sink !== 'function') {
    return {
      ...base,
      status: 'WOULD_DELIVER_NO_SINK',
      reason: '五闸全过，但本模块不提供默认 sink ⇒ 仍是零写入；生产接线须显式注入经过审批的 sink',
      gate,
      envelope,
    };
  }

  // 唯一写入点：调用方显式注入。信封已冻结，sink 无法回改状态。
  sink(Object.freeze({ ...envelope }));
  return {
    ...base,
    writes: 1,
    sinkInvoked: true,
    delivered: true,
    status: 'DELIVERED_PROPOSED',
    reason: '已投递 status=proposed 候选处方；执行仍走既有驱动与人工审批（附二 R1）',
    gate,
  };
}

/**
 * 异步投递（2026-11-07 接线新增）。五闸判据与 evaluateDelivery() 逐条一致，
 * 唯一差别是 **await sink**：真 sink 走插件 lib 的 propose()/generate()，
 * 都是异步写穿；同步版不等待会出现「返回 writes=1 但磁盘还没落」的假象。
 *
 * ⛔ 仍默认零写入：没注入 sink ⇒ WOULD_DELIVER_NO_SINK。
 * ⛔ sink 抛错 / 返回 ok!=true ⇒ SINK_ERROR / SINK_REJECTED，writes 恒 0，绝不假装成功。
 */
export async function evaluateDeliveryAsync(envelope, options = {}) {
  const {
    env = process.env,
    switchOn = null,
    sink = null,
    humanVeto = false,
    emergencyStop = false,
    vetoWindowHours = 24,
  } = options;

  const base = {
    schemaVersion: DELIVERY_SCHEMA,
    defaultDeny: true,
    writes: 0,
    sinkInvoked: false,
    delivered: false,
  };

  if (!envelope || envelope.status !== 'proposed') {
    return { ...base, status: 'NO_ENVELOPE', reason: '信封无效或状态不是 proposed ⇒ 零写入' };
  }

  const sw = switchOn === null ? readSwitch(env) : switchOn === true;
  const gate = evaluateAutonomousWrite({
    labelAuthority: envelope.labelAuthority,
    target: envelope.target,
    predictedDelta: envelope.predictedDelta,
    predictedDeltaSource: envelope.predictedDeltaSource,
    humanVeto,
    emergencyStop,
    vetoWindowHours,
  }, { switchOn: sw });

  if (!gate.allowed) {
    return { ...base, status: 'DEFAULT_DENY', reason: gate.reason, gate };
  }

  if (typeof sink !== 'function') {
    return {
      ...base,
      status: 'WOULD_DELIVER_NO_SINK',
      reason: '五闸全过，但没注入 sink ⇒ 仍是零写入；生产接线须显式注入经过审批的 sink',
      gate,
      envelope,
    };
  }

  let sinkResult;
  try {
    sinkResult = await sink(Object.freeze({ ...envelope }));
  } catch (e) {
    return { ...base, status: 'SINK_ERROR', reason: `SINK_ERROR: ${e.message}`, gate };
  }
  if (!sinkResult || sinkResult.ok !== true) {
    return {
      ...base,
      status: 'SINK_REJECTED',
      reason: sinkResult?.reason ?? 'sink 未确认写入',
      gate,
      sinkResult,
    };
  }

  return {
    ...base,
    writes: sinkResult.writes ?? 1,
    sinkInvoked: true,
    delivered: true,
    status: 'DELIVERED_PROPOSED',
    reason: '已投递 status=proposed 候选处方；执行仍走既有驱动与人工审批（附二 R1）',
    gate,
    sinkResult,
  };
}

/**
 * 只读五闸探针：用真实现状跑一次，证明默认路径是零写入。
 * ⛔ 不构造信封（0 条冻结标签本就造不出合法锚），只展示五闸判定。
 */
export function probeGates({ switchOn = null, env = process.env, labelAuthority = 'UNSET' } = {}) {
  const sw = switchOn === null ? readSwitch(env) : switchOn === true;
  const gate = evaluateAutonomousWrite({
    labelAuthority,
    target: 'proposal_queue',
    predictedDelta: 0,
    predictedDeltaSource: 'oracle-prescription-delivery 五闸探针（非真实处方）',
    humanVeto: false,
    emergencyStop: false,
    vetoWindowHours: 24,
  }, { switchOn: sw });
  return {
    schemaVersion: DELIVERY_SCHEMA,
    defaultDeny: true,
    writes: 0,
    delivered: false,
    status: gate.allowed ? 'WOULD_DELIVER_NO_SINK' : 'DEFAULT_DENY',
    reason: gate.reason,
    gate,
  };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const r = probeGates({ switchOn: args.includes('--switch-on') ? true : null, env: {} });
  const out = {
    ...r,
    switchEnv: AUTONOMOUS_WRITE_SWITCH_ENV,
    note: '⛔ 本 CLI 不写任何文件、不投递任何队列；--switch-on 仅供离线验证五闸行为，不改变生产开关。',
  };
  if (json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else {
    process.stdout.write(`B1 受控投递 · 只读五闸探针\n`);
    process.stdout.write(`  判词：${r.status} ｜ 写入 ${r.writes} 条 ｜ defaultDeny=${r.defaultDeny}\n`);
    process.stdout.write(`  原因：${r.reason}\n`);
    for (const c of r.gate.checks) process.stdout.write(`  ${c.passed ? '✓' : 'x'} ${c.id}: ${c.detail}\n`);
    process.stdout.write(`  ${out.note}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
