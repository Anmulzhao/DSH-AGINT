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
 * 决定一次 claim 到的执行该怎么处理。
 *
 * @param {object} input
 * @param {object} input.job         execution 行（claim 后 attempts 已 +1）
 * @param {object|null} input.proposal
 * @param {number} input.weekCommits 本周已自动落地次数
 * @param {number} input.cap         周上限（0 = 不限）
 * @param {boolean} input.driverReady `agint.evolutionDriver.runForProposal` 是否可用
 * @param {number} input.now
 * @returns {{action:'run'}|{action:'cancel',reason:string}|{action:'defer',dueAt:string,reason:string}|{action:'fail',error:string}}
 */
export function decideRun({ job, proposal, weekCommits = 0, cap = 0, driverReady = false, now = Date.now() }) {
  if (!proposal) {
    return { action: 'cancel', reason: '提案已不存在（可能被删除）' };
  }
  if (proposal.status !== 'approved') {
    return { action: 'cancel', reason: `提案状态是 ${proposal.status}，不再是 approved` };
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
