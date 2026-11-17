#!/usr/bin/env node
/**
 * bin/autonomous-write-gate.mjs —— 受控写入权五闸（纲领 2026-11-07 附二 R2）
 *
 * 2026-11-07 老板批准放宽纲领 §5.1「永不自动执行」，落法为
 * 「默认关闭的受控自动投递」。本模块就是那道闸的**可执行形态**。
 *
 * ⛔ 默认拒绝（default deny）：任何输入缺省、任何一闸不过 ⇒ allowed=false。
 * ⛔ 纯函数：零 I/O、零服务访问、零 LLM、不读 storages、不写任何文件。
 * ⛔ **绝不读 aesthetic_score / scoreImproved 之类字段** —— 分数涨了不放行，
 *    否则「让数字变好看」会反过来成为写入许可（Goodhart / 纲领 §8 例二）。
 *
 * 五闸：
 *   G1 显式开关  AGINT_ORACLE_AUTONOMOUS_WRITE 必须为字面量 'on'
 *   G2 外部锚定  labelAuthority ∈ {GOLD, HELDOUT}；SILVER / UNSET 拒绝
 *   G3 目标白名单 target ∈ {proposal_queue, curriculum_challenge_queue}
 *   G4 可证伪预测 predictedDelta 为有限数 + predictedDeltaSource 非空
 *   G5 人类否决  humanVeto/emergencyStop 均非 true 且 vetoWindowHours > 0
 *
 * 用法（B1 落地时）：
 *   import { evaluateAutonomousWrite } from './autonomous-write-gate.mjs';
 *   const v = evaluateAutonomousWrite({ ... });
 *   if (!v.allowed) return;  // 默认路径
 */

export const AUTONOMOUS_WRITE_SWITCH_ENV = 'AGINT_ORACLE_AUTONOMOUS_WRITE';
export const EXTERNAL_AUTHORITIES = Object.freeze(['GOLD', 'HELDOUT']);
export const ALLOWED_TARGETS = Object.freeze(['proposal_queue', 'curriculum_challenge_queue']);

/** 只认字面量 'on'；'ON' / '1' / 'true' / 'yes' 一律视为关闭。 */
export function readSwitch(env = process.env) {
  return env?.[AUTONOMOUS_WRITE_SWITCH_ENV] === 'on';
}

/**
 * 评估一次自动投递是否被允许。
 *
 * @param {object} input 候选处方上下文
 * @param {{switchOn?: boolean, env?: object}} [options] switchOn 供测试/离线回放显式注入
 * @returns {{allowed: boolean, reason: string, defaultDeny: true,
 *            checks: Array<{id:string, passed:boolean, detail:string}>}}
 */
export function evaluateAutonomousWrite(input = {}, options = {}) {
  const s = input && typeof input === 'object' ? input : {};
  const switchOn = Object.prototype.hasOwnProperty.call(options, 'switchOn')
    ? options.switchOn === true
    : readSwitch(options.env ?? process.env);

  const checks = [];
  const add = (id, passed, detail) => checks.push({ id, passed: passed === true, detail });

  add('G1_switch', switchOn,
    switchOn
      ? `${AUTONOMOUS_WRITE_SWITCH_ENV}=on，开关已显式打开`
      : `${AUTONOMOUS_WRITE_SWITCH_ENV} 未开启（默认关闭）⇒ 回落到纲领 §5.1 默认状态`);

  const a = s.labelAuthority;
  add('G2_external_anchor', EXTERNAL_AUTHORITIES.includes(a),
    EXTERNAL_AUTHORITIES.includes(a)
      ? `外部冻结证据 ${a}`
      : `labelAuthority=${JSON.stringify(a)} 不是 GOLD/HELDOUT ⇒ 无外部证据记 fail（SILVER 自评不算）`);

  add('G3_target_whitelist', ALLOWED_TARGETS.includes(s.target),
    ALLOWED_TARGETS.includes(s.target)
      ? `目标 ${s.target} 在白名单内`
      : `target=${JSON.stringify(s.target)} 不在白名单 ⇒ 不得直写 storages / 评分常量 / prompt / rules`);

  const hasDelta = typeof s.predictedDelta === 'number' && Number.isFinite(s.predictedDelta);
  const hasSource = typeof s.predictedDeltaSource === 'string' && s.predictedDeltaSource.trim().length > 0;
  add('G4_falsifiable_prediction', hasDelta && hasSource,
    hasDelta && hasSource
      ? `predictedDelta=${s.predictedDelta}，来源 ${s.predictedDeltaSource} ⇒ 可与 actualDelta 对拍`
      : 'predictedDelta 须为有限数且 predictedDeltaSource 非空 ⇒ 无预测的处方不是处方');

  const veto = s.humanVeto === true;
  const stop = s.emergencyStop === true;
  const windowOk = typeof s.vetoWindowHours === 'number' && Number.isFinite(s.vetoWindowHours) && s.vetoWindowHours > 0;
  add('G5_human_veto', !veto && !stop && windowOk,
    veto ? 'humanVeto=true ⇒ 人工已否决'
      : stop ? 'emergencyStop=true ⇒ 急停中'
        : windowOk ? `撤销窗口 ${s.vetoWindowHours}h ⇒ 人类最终否决权保留`
          : 'vetoWindowHours 须 > 0 ⇒ 没有撤销窗口就不许自动投递');

  const failed = checks.filter((c) => !c.passed).map((c) => c.id);
  return {
    allowed: failed.length === 0,
    reason: failed.length === 0
      ? 'ALL_GATES_PASSED: 五闸全通过，允许投递 status=proposed 的候选处方（仍非自动执行）'
      : `DEFAULT_DENY: 未通过 ${failed.join(', ')}`,
    defaultDeny: true,
    checks,
  };
}
