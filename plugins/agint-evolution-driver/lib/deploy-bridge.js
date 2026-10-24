/**
 * lib/deploy-bridge.js — 合成产物 ⇒ agint-mount 的部署桥（A 段「通电不上膛」）
 *
 * ## 它解决什么
 * `agint.mount.request` 此前**全仓 0 个生产调用方**（check-wiring 查 A：只有 MENTION）。
 * 本文件是它的第一个生产调用者 ⇒ 部署腿「通电」。
 *
 * ## ⛔ 为什么叫「通电不上膛」
 * 部署腿的终点是 ACTIVATE，而 mount 的 4 态状态机里有 **RESTART_REQUESTED**：
 *   PREPARED → INSTALLED → RESTART_REQUESTED → ACTIVATED
 * 自动走到 ACTIVATE = 让系统自己往宿主装插件，并可能触发重启请求。
 * 项目铁律：「常驻 dsh 只能老板双击启动」「永不触发 restart-request.json」。
 *
 * 所以本桥**硬编码** verdict = PENDING_REVIEW：
 *   mount.request 入口第一行 isPendingReview(verdict) 命中 ⇒ 只写一条
 *   PENDING_REVIEW ticket 就 return，**绝不进三段式**（不 INSTALLED /
 *   不 RESTART_REQUESTED / 不 ACTIVATED / 不起健康探针）。
 * ⇒ 腿通电（ticket 会建、mount.requested 事件会发、门禁能看见它），
 *   但**没有人批准就永远不会上膛**。
 *
 * ⛔ 改这个文件前先读上面这段。把 PENDING_REVIEW 改成真 verdict 会直接
 *    触碰重启红线，那一步必须由老板单独拍板，并配套人工审批通道。
 *
 * 依赖全软：一律调用时 ctx.get，不在 apply 里缓存（driver 的既有约定）。
 */

import { randomUUID } from 'node:crypto';

export const PENDING_REVIEW_VERDICT = Object.freeze({ decision: 'PENDING_REVIEW' });

function fail(code, reason) {
  return { ok: false, code, reason };
}

/**
 * 把一条 TOOL_SYNTHESIS proposal 合成产物，落 staging，再递交给 mount。
 *
 * @param {object} args
 * @param {object} args.ctx    cordis ctx（提供 ctx.get）
 * @param {object} args.proposal FROZEN MutationProposal（kind 须为 TOOL_SYNTHESIS）
 * @param {object} [args.io]  落盘实现（默认 node:fs/promises；测试可注入内存 stub）
 * @param {string} [args.stagingRoot]  staging 根目录（默认交给 io.stagingDirFor）
 * @returns {Promise<{ok:true, ticketId, stagedAt, files:number, decision:string} | {ok:false,...}>}
 */
export async function requestSynthMount({ ctx, proposal, io, stagingRoot } = {}) {
  if (!ctx || typeof ctx.get !== 'function') return fail('NO_CTX', 'ctx.get 不可用');
  if (!proposal) return fail('NO_PROPOSAL', 'proposal 缺失');

  // 1) 合成：优先伞键下的 synthForProposal，退化到全名键
  const mutatorNs = ctx.get('agint.mutator');
  const synth = (mutatorNs && mutatorNs.synthForProposal)
    ?? ctx.get('agint.mutator.synthForProposal');
  if (typeof synth !== 'function') {
    return fail('NO_SYNTH', 'agint.mutator.synthForProposal 不可用');
  }

  const synthResult = synth(proposal);
  if (!synthResult || synthResult.ok !== true) {
    return fail(synthResult?.code ?? 'SYNTH_FAILED', synthResult?.reason ?? '合成失败');
  }

  // 2) 落盘到 staging（为「人批准后的 ACTIVATE」备好产物，本步不激活任何东西）
  const fsIo = io ?? (await import('node:fs/promises'));
  const stagedAt = stagingRoot
    ? `${stagingRoot.replace(/[\\/]+$/, '')}/${synthResult.meta.pluginId}-${randomUUID().slice(0, 8)}`
    : null;
  if (stagedAt && typeof fsIo?.mkdir === 'function') {
    try {
      await fsIo.mkdir(stagedAt, { recursive: true });
      for (const f of synthResult.files) {
        const out = `${stagedAt}/${f.path}`;
        if (typeof fsIo.mkdir === 'function') {
          const parent = out.slice(0, out.lastIndexOf('/'));
          if (parent !== stagedAt) await fsIo.mkdir(parent, { recursive: true });
        }
        await fsIo.writeFile(out, f.content, 'utf8');
      }
    } catch (e) {
      return fail('STAGE_FAILED', `staging 落盘失败: ${e?.message || e}`);
    }
  }

  // 3) 递交 mount：⛔ 恒 PENDING_REVIEW —— 通电不上膛
  const mount = ctx.get('agint.mount.request');
  if (typeof mount !== 'function') {
    return fail('NO_MOUNT', 'agint.mount.request 不可用');
  }
  let ticket;
  try {
    ticket = await mount({ proposal, verdict: { ...PENDING_REVIEW_VERDICT } });
  } catch (e) {
    return fail('MOUNT_THREW', `mount.request 抛错: ${e?.message || e}`);
  }

  return {
    ok: true,
    ticketId: ticket?.ticketId ?? null,
    phase: ticket?.phase ?? null,
    decision: ticket?.decision ?? null,
    stagedAt,
    files: synthResult.files.length,
    pluginId: synthResult.meta.pluginId,
  };
}
