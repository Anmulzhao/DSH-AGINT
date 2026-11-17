/**
 * agint-evolution-driver/lib/proposal-run.js —— 「一次执行 = 整条提案」的编排层。
 *
 * ## 它补的是哪个洞（2026-11-07 老板裁定）
 *
 * driver 的旧口径是「一次 runOnce = 一个文件里的一次编辑」。一条提案若横跨 4 个
 * 文件，就要 **4 次执行行、4 次审批周期、4 次续跑**，中间任何一次失败都会把提案
 * 切成半成品（partial），而 partial 的自动续跑又有次数上限。
 *
 * 老板的判断（2026-11-07）：「执行器一次只做一个文件的单点编辑，不符合预期和目标，
 * 要以提案为执行的目标。」
 *
 * ## 这个文件的边界（刻意很窄）
 *
 *   它只做**编排**：按顺序反复调 `runOnce({proposalId, skipTargets})`，
 *   每次只允许它提交一个新的目标文件，直到提案覆盖完 / 没有可改目标 / 失败 / 达上限。
 *
 * ⛔ 它不读文件、不调 LLM、不判断「能不能改」—— 那些仍由 runOnce 内部既有闸门
 *    （目标解析 → 幻觉闸门 → 实体门 → mutator.validate → 写入后 verify → policy）
 *    逐文件负责。**写入单元仍是文件，执行单元变成提案。**
 *
 * ## 为什么不在这里做「全组事务（任一失败全回滚）」
 *
 * 全组回滚要求「先把 N 个文件都写进工作区，再统一验证」，而现有流水线是
 * 「写一个 → 验一个 → policy 判一个」。改成全组事务要动 runOnce 里 400 行
 * 提交段，风险远大于收益。因此 v1 的口径是：
 *
 *   · 每个文件落地前，仍要过它自己的全部闸门（安全面不降级）；
 *   · 任一文件失败 ⇒ **后续文件不再写**（失败即停，不继续扩大影响面）；
 *   · 已经落地的文件不回滚 —— 它们在写入时已单独通过 verify + policy，
 *     回滚它们才是真的破坏已验证的成果；
 *   · 剩下没做的目标如实交给 `scope.remainingUnits`，由既有 partial 机制接管。
 *
 * 这条边界写在这里，是为了下一个人不要以为「已经是事务了」。
 *
 * ## 可测试性
 *
 * `runOnce` 由调用方注入 ⇒ 本文件可以脱离宿主单测（见 test/proposal-run.test.mjs）。
 * ⛔ 本文件不许读 env、不许拿 Date.now()。
 */

/**
 * 反复跑 runOnce，直到提案被覆盖完 / 无目标可改 / 失败 / 到达单次执行上限。
 *
 * @param {object} opts
 * @param {string} opts.proposalId 提案 id（定向执行）
 * @param {(arg:{proposalId:string, skipTargets:string[], unitIndex:number}) => Promise<object>} opts.runOnce
 * @param {number} [opts.maxUnits=6] 单次执行最多落地几个文件（成本闸）
 * @param {string[]} [opts.skipTargets] 调用前就已经完成的目标（续跑场景）
 * @returns {Promise<object>} runForProposal 需要的聚合结果
 */
export async function runProposalLoop({ proposalId, runOnce, maxUnits = 6, skipTargets = [], onPartial } = {}) {
  if (typeof runOnce !== 'function') throw new Error('runProposalLoop: runOnce 必填');

  const limit = Number.isFinite(Number(maxUnits)) && Number(maxUnits) > 0
    ? Math.max(1, Math.trunc(Number(maxUnits)))
    : 1;

  const done = Array.isArray(skipTargets) ? [...skipTargets] : [];
  const commits = [];
  const failures = [];
  let lastScope = null;
  let lastOut = null;

  for (let i = 0; i < limit; i += 1) {
    const out = await runOnce({ proposalId, skipTargets: [...done], unitIndex: i });
    lastOut = out;

    // ── 没有任何东西可提交 ────────────────────────────────────────────
    if (!out || out.skipped === true || out.commit?.ok !== true) {
      if (Array.isArray(out?.failures)) failures.push(...out.failures);
      if (commits.length === 0) {
        // 一个文件都没落地 ⇒ 原样把第一次的结果交回去，调用方（执行器）按老口径判失败。
        // 但「没落地 ≠ 没欠账」：这一轮如果本来就只覆盖了一部分，计数要照记
        // （否则 partialScope 会漏掉「commit 被 fail-closed 跳过」这一类）。
        if (out?.scope && out.scope.complete === false && typeof onPartial === 'function') {
          try { await onPartial({ unitsApplied: 0, unitsTotal: out.scope.unitsTotal ?? 0, remainingUnits: out.scope.remainingUnits ?? [] }); } catch { /* 计数失败不影响结果 */ }
        }
        return { ...(out ?? { skipped: true }), proposalId, commits: [], unitsApplied: 0 };
      }
      // 已经落地了一部分：失败即停，把剩余单元如实交回。
      break;
    }

    // ── 落地了一个文件 ────────────────────────────────────────────────
    commits.push({
      path: out.commit.path,
      policyDecision: out.commit.policyDecision ?? '',
      preimagePath: out.commit.preimagePath ?? '',
      bytesBefore: out.commit.bytesBefore ?? null,
      bytesAfter: out.commit.bytesAfter ?? null,
    });
    if (out.commit.path) done.push(out.commit.path);
    if (out.scope) lastScope = out.scope;
    if (Array.isArray(out.failures)) failures.push(...out.failures);

    // 提案已覆盖完（最后一处目标就是刚写的那个）⇒ 立刻停，不再多起一次 LLM。
    if (out.scope?.complete === true) break;
    // 记账说没有剩余单元了（例如前面的目标都被模型判过「不用改」）。
    if (Array.isArray(out.scope?.remainingUnits) && out.scope.remainingUnits.length === 0) break;
  }

  const unitsApplied = commits.length;
  // ⚠️ 每一轮 runOnce 看到的 targets 都被 skipTargets 过滤过，所以它报的 unitsTotal
  //    是「**本轮可见**的目标数」，会比整条提案少。这里取「本轮可见总数」与
  //    「实际落地数」的较大者 —— 宁可报少不多：complete 仍要求 remaining 为空。
  const reportedTotal = Number.isFinite(Number(lastScope?.unitsTotal)) ? Number(lastScope.unitsTotal) : 0;
  const unitsTotal = Math.max(reportedTotal, unitsApplied);
  const remainingUnits = Array.isArray(lastScope?.remainingUnits) ? lastScope.remainingUnits : [];
  const complete = unitsApplied > 0 && remainingUnits.length === 0 && lastScope?.requiresNewAsset !== true;

  // 部分覆盖计数**按执行**算一次，不按 runOnce 算。
  // ⛔ 旧口径里这个计数写在 runOnce 内，提案级执行下一条提案会被数 N 次，
  //    status().partialScope 直接失去意义（它本该回答「有多少条提案没做完」）。
  if (typeof onPartial === 'function' && complete !== true) {
    try { await onPartial({ unitsApplied, unitsTotal, remainingUnits }); } catch { /* 计数失败不影响结果 */ }
  }

  return {
    // runForProposal 的既有契约：skipped=false + commit.ok=true 才算成功。
    ...(lastOut ?? {}),
    proposalId,
    skipped: false,
    ok: true,
    // 兼容既有消费者（执行器 interpret 只读 commit.ok / commit.path / policyDecision）。
    commit: {
      ok: true,
      path: commits[commits.length - 1]?.path ?? '',
      policyDecision: commits[commits.length - 1]?.policyDecision ?? '',
      preimagePath: commits[commits.length - 1]?.preimagePath ?? '',
    },
    // 新增：这条提案这一次到底写了哪几个文件（面板/报告要用）。
    commits,
    failures,
    scope: {
      unitsApplied,
      unitsTotal,
      remainingUnits,
      requiresNewAsset: lastScope?.requiresNewAsset === true,
      complete,
      reason: complete
        ? ''
        : `本次落地 ${unitsApplied}/${unitsTotal} 个单元`
          + `${remainingUnits.length ? `，剩余 ${remainingUnits.join('、')}` : ''}`
          + `${lastScope?.requiresNewAsset === true ? '（提案要求新建资产，本执行器不做）' : ''}`,
    },
  };
}
