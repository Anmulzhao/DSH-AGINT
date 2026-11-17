/**
 * agint-executor/lib/plan.js —— 「这一次到底跑不跑」的纯判据（无 IO、无 ctx、无时钟）。
 *
 * ## 为什么单独成文件
 *
 * 一个自动执行的决定要过六道闸：状态、blocker、驱动可用性、周上限、重试次数、
 * 以及「这个 job 是不是已经被别人捡走了」。这些判据如果写在 tick 里，测一次就得
 * 起一个假宿主；写在纯函数里，六道闸可以逐条钉死。
 *
 * ## 判据顺序是有意义的（改顺序会改变事故形态）
 *
 *   ① 提案还在不在          —— 都没了，撤单
 *   ② 还是不是 approved     —— 人撤销了批准，撤单（不能让后台继续改代码）
 *   ③ blocker 还在不在     —— 前置没到位，撤单（不是失败，是"这次不该跑"）
 *   ④ 驱动在不在            —— 缺能力就是失败，且**不许**标成「跑过了」
 *   ⑤ 本周额度              —— 到顶就顺延到下周（不是失败）
 *   ⑥ 同一 job 的尝试次数   —— 到顶就失败收尾（防无限重试烧 token）
 *
 * ⛔ 2026-10-29 撤掉了原第 ③ 闸（`autoExecutable:false` ⇒ 撤单）。
 *    老板裁定「批准后就要自动执行，不许停下来等人、也不许标成不可自动执行」。
 *    代价实测可承受：目标资产解析在起 LLM 之前（driver 的 `resolveTargetAssets`），
 *    解析不到就直接 `continue` 记 not-actionable —— 毫秒级确定性失败、**不调 LLM**、
 *    不占周额度。留着那道闸的唯一效果是把「跑不动」伪装成「不该跑」，让人以为
 *    系统还在等人，而实际上没人会来。字段仍在存储里（历史数据），但不再参与任何判据。
 *
 * ⛔ ④ 必须在 ⑤ 之前：能力缺失是配置问题，不该消耗「本周额度」这个稀缺资源，
 *    也不该被顺延掩盖成"下周就能跑"。
 */

import { nextWeekStart } from './week.js';

/**
 * 这条提案是不是「机械动作提案」——动作对象是数据，不是仓库文件。
 *
 * 判定用两个信号，任一命中即为真：
 *   ① source === 'agint-aesthetic-oracle'（美谕层产的提案）
 *   ② body 自带「纯机械动作提案 … 永不 auto-apply」声明
 *
 * 为什么要有信号 ②：美谕层未来换 source 名、或老板手写同体例提案时，
 * 靠 source 单独判定会漏；而「永不 auto-apply」是提案**自己写的契约**，
 * 以它为准比以我方猜测为准更硬。
 *
 * ⛔ 判据只拦「自动执行队列」，不拦提案本身：提案仍可被老板在家族面板
 *    手动点名执行（定向执行路径走 driver.runForProposal，不经过本函数）。
 *
 * @param {object|null} proposal
 * @returns {boolean}
 */
export function isMechanicalActionProposal(proposal) {
  if (!proposal || typeof proposal !== 'object') return false;
  if (String(proposal.source ?? '').trim() === 'agint-aesthetic-oracle') return true;
  return /纯机械动作提案[\s\S]{0,40}永不 auto-apply/.test(String(proposal.body ?? ''));
}

/**
 * 决定一次 claim 到的执行该怎么处理。
 *
 * @param {object} input
 * @param {object} input.job         execution 行（claim 后 attempts 已 +1）
 * @param {object|null} input.proposal
 * @param {number} input.weekCommits 本周已自动落地次数
 * @param {number} input.cap         周上限（0 = 不限）
 * @param {boolean} input.driverReady `agint.evolutionDriver.runForProposal` 是否可用
 * @param {object|null} [input.mandate] `agint.evolve.checkMandate()` 的结果（W8-3）
 * @param {number} input.now
 * @returns {{action:'run'}|{action:'cancel',reason:string}|{action:'defer',dueAt:string,reason:string}|{action:'fail',error:string}}
 */
export function decideRun({ job, proposal, weekCommits = 0, cap = 0, driverReady = false, mandate = null, now = Date.now() }) {
  if (!proposal) {
    return { action: 'cancel', reason: '提案已不存在（可能被删除）' };
  }
  if (proposal.status !== 'approved') {
    return { action: 'cancel', reason: `提案状态是 ${proposal.status}，不再是 approved` };
  }
  // 2026-11-05：机械动作提案不进自动执行队列。
  //
  // 为什么这道闸存在：美谕层（agint-aesthetic-oracle）产的提案正文自写
  // 「性质：纯机械动作提案（status 锁 proposed，永不 auto-apply；执行与否由老板定）」，
  // 动作对象是**记忆条目 / 技能归档 / wiki 孤儿**这类数据，不是仓库文件。
  // driver 的 `resolveTargetAssets()` 只认仓库文件与技能 ⇒ 解析不到目标 ⇒
  // 判 not-actionable，重试也不会变（实机：2026-11-05 同批 15 条同因失败）。
  //
  // 为什么放在「跑之前」而不是「跑完再判」：跑完再判等于先烧一次 LLM 调用、
  // 先把提案状态推到 failed，老板再回看面板才知道它压根不该被自动执行。
  //
  // ⛔ 这不是「不可自动执行」语义闸（那个 2026-10-29 已撤）：它拦的是**提案种类**，
  //    不是逐条标记。同源提案仍可由老板手动点名执行（family-panel 定向执行路径不受影响）。
  if (isMechanicalActionProposal(proposal)) {
    return {
      action: 'cancel',
      reason: '美谕机械动作提案：动作对象是记忆/技能/wiki 数据，不是仓库文件；不自动执行，由老板手动处置',
    };
  }
  // 2026-10-29：原「不可自动执行」语义闸已撤（老板裁定：批准即自动执行）。
  // 复核类提案照排，跑不动由 driver 的目标解析给出确定性失败原因。
  const blocker = typeof proposal.blocker === 'string' ? proposal.blocker.trim() : '';
  if (blocker !== '') {
    return { action: 'cancel', reason: `提案被标了 blocker：${blocker}` };
  }
  if (!driverReady) {
    return { action: 'fail', error: 'agint.evolutionDriver.runForProposal 未挂载 —— 没有执行能力，拒不改仓库' };
  }
  // 2026-11-03（W8-3）：审批凭据核验 —— 放在驱动之后、周额度之前。
  //
  // 为什么在额度之前：越权不是「这次不该跑」，是「这次没资格跑」。
  // 让它去顺延会把一份无效授权排到下周，下周照样无效。也不该算失败消耗重试。
  //
  // ⛔ 只有**明确的 mismatch** 才拦：
  //    unknown（老提案没凭据）必须放行 —— 升级瞬间 90+ 条历史提案都没有凭据，
  //    拦下来等于全站停摆。但放行不等于安心：`mandateState` 会带回调用方，
  //    让它落进执行日志，「没验过」和「验过了」在台账上不能长得一样。
  if (mandate && mandate.state === 'mismatch') {
    return {
      action: 'cancel',
      reason: `审批凭据不覆盖当前改动范围，需重新审批：${mandate.reason}`,
    };
  }
  if (cap > 0 && weekCommits >= cap) {
    return {
      action: 'defer',
      dueAt: nextWeekStart(now),
      reason: `本周自动执行已达上限（${weekCommits}/${cap}，AGENTS.md 红线）—— 顺延到下周起点`,
    };
  }
  const attempts = Number(job?.attempts) || 0;
  if (attempts > 1 && attempts > (Number(job?.maxAttempts) || 0) && Number(job?.maxAttempts) > 0) {
    // 兜底：正常情况下 runJob 会在失败时自己判断是否还有重试额度。
    return { action: 'fail', error: `已尝试 ${attempts} 次，超出上限` };
  }
  return { action: 'run' };
}

/**
 * 失败后还有没有重试额度。
 * @param {number} attempts 本次是第几次（claim 时已自增）
 * @param {number} maxAttempts 总上限（>=1）
 */
export function canRetry(attempts, maxAttempts) {
  const a = Number(attempts) || 0;
  const m = Number(maxAttempts) || 0;
  return m > 0 && a < m;
}

/** 区间文案：失败原因可能很长，日志/面板只留一行。 */
export function oneLine(text, max = 300) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
