/**
 * agint-evolution-driver —— ledger-writer.js
 *
 * 设计 §4.3.4 的**写入侧接线**：把 policy 的一次决策变成链上的一条条目。
 *
 * ## 它站在哪
 *
 * ```
 * policy.decide() → decision
 *   → buildLedgerEntry()（纯函数：证据 → 条目，⛔ 不猜）
 *   → agint.evolution.ledger.append()（唯一的链写入者，§4.3.4 纪律 1）
 * ```
 *
 * Ledger 的 owner 是 `agint-evolution-memory`，本文件**只是调用方**：不碰存储域、
 * 不自己算 hash（entryHash/parentHash/batchRoot/merkleRoot 全在 service 里），
 * 与 `contract-manager.js` 同一条边界纪律 #2 —— 跨插件只走 Service。
 *
 * ## 为什么写在「决策当时」而不是「outcome 回填之后」
 *
 * §7.1 那行集成测试把顺序写成「outcome 回填 → PQ 计算 → ledger 写入」。落地时改判：
 *
 * 1. `summary` 参与 entryHash，而条目**永不重写**（纪律 9）⇒ 一旦写入，
 *    actualDelta / predictionQuality 就永久定型。若等 T+7 才有值，这七天里
 *    这次进化在链上**不存在**。
 * 2. REJECT / ABSTAIN 根本没有 T+7 窗口（改动已回滚，没有后续可测）。
 *    等 outcome 等于把「被拒绝的进化」重新赶出借记 —— 正是 §4.3.4 末段禁止的
 *    「在证据层美化历史」。
 * 3. `prediction_outcomes` 表是 Sprint 24 的交付物，现在**还不存在**。
 *
 * ⇒ 条目的定位是「**这一期进化做了什么决定**」；后续度量走 `prediction_outcomes`，
 *   用 `contractId` 交叉引用，⛔ 不回来改链。
 *
 * ## 三条不做的事
 *
 * - ⛔ **不填没有证据的字段**。`predictedDelta` / `actualDelta` / `predictionQuality` /
 *   `predictionSource` / `contractHash` / `lockEventId` / `gitCommit` / `mountTicketId` /
 *   `abTestId` 默认全部 null：`actualDelta` / `predictionQuality` 要等 1b 的度量回填，
 *   `gitCommit` 要等人真提交。**缺就是缺**，写个"看起来对"的值就是把伪造证据入链。
 *   `predictedDelta` / `predictionSource` / `lockEventId` 是**唯一有条件例外**的三个：
 *   调用方传入 `prediction` 且它带着**已入库的锁**（`locked:true` + `hypothesisLock`）
 *   时照原样入链。见下面的 `lockedPredictionOf` —— 判据是「锁先于结果」，
 *   不是「有人给了个数」。
 * - ⛔ **不复用 EvolutionLogBuffer**（纪律 2）：这里一次决策一次 `await append`，
 *   批内崩溃 = seq 空洞 = 断链。
 * - ⛔ **不静默降级**（纪律 3）：写入失败必须让外部看得见 —— 返回值 + warn +
 *   计数（进 `evolution.cycle.summary`）+ `failure_pattern` 落行。
 *   失败**不回滚仓库改动**：改动已经发生或已经回滚，记录失败是另一件事，
 *   把它伪装成"没做过这次进化"更糟。
 *
 * ## ⚠️ 时序副作用（部署前必读）
 *
 * 首条实时条目入链即**永久关闭** §4.3.5 的重建窗口（链成形后不许往中间插）。
 * 所以正确顺序是：先跑 `ledger.rebuild({apply:true})` 补历史（现在窗口仍为【开】，
 * 实测可重建 6 条），再部署本接线。若接线先上线，历史那 6 条只能追加在尾部
 * 并标 `reconstructed: true` —— 合法，但 seq 与事件时序不再一致，报告须说明。
 */

const DIGEST_MAX = 200;

/**
 * 从 `plugins/<name>/...` 取插件名；取不到就返回空数组（不猜归属）。
 *
 * ⚠️ 这与 `agint-evolution-memory/lib/ledger-rebuild.js` 里的同名私有函数是
 * **第二份实现** —— 跨插件 import 在本仓不存在（边界纪律 #2），故接受两份。
 * 判据只有一条 `^plugins/([^/]+)/`，两边各自有测试锁死；
 * `preset skills` 路径（`presets/agint/skills/...`）两边都返回 `[]`，
 * 因为改的是 preset 内容而不是插件代码，硬凑一个插件名就是假归属。
 */
export function pluginFromPath(path) {
  if (typeof path !== 'string' || path === '') return [];
  const m = /^plugins\/([^/]+)\//.exec(path.replace(/\\/g, '/'));
  return m ? [m[1]] : [];
}

/** GEN-### —— 与重建侧同格式；generation 不是整数就写 GEN-UNKNOWN（不猜代际）。 */
function generationLabel(variant) {
  const g = variant?.generation;
  return Number.isInteger(g) ? `GEN-${String(g).padStart(3, '0')}` : 'GEN-UNKNOWN';
}

/**
 * 摘要：只拼**执行当时已成立**的事实片段，顺序固定 ⇒ 同一决策必得同一串。
 *
 * 不复用重建侧的 buildDigest：那边从事件流水反推（手里只有 payload），
 * 这边握着 proposal 原文。两者形状相似但不是同一函数，各自被自己的测试锁死。
 */
function buildDigest({ proposal, variant, outcome, targetMetric }) {
  const parts = [];
  parts.push(`${proposal?.kind ?? 'mutation'}`);
  const promptId = proposal?.payload?.promptId ?? variant?.payload?.promptId;
  if (promptId) parts.push(`target=${promptId}`);
  if (outcome.path) parts.push(`path=${outcome.path}`);
  if (Number.isInteger(outcome.bytesBefore) && Number.isInteger(outcome.bytesAfter)) {
    parts.push(`bytes ${outcome.bytesBefore}->${outcome.bytesAfter}`);
  }
  const ee = variant?.expected_effect;
  if (targetMetric) {
    // 指标名用**条目最终定的那一个**（可能与 variant 行里的 'unspecified' 不同，见
    // buildLedgerEntry 的 targetMetric 入参）：摘要与 summary 分叉 = 两条真相。
    parts.push(`expected ${targetMetric} ${ee?.direction ?? '?'} within ${ee?.window ?? '?'}`);
  }
  if (outcome.verifyMode) parts.push(`verify=${outcome.verifyMode}`);
  if (outcome.sandboxOk === false) parts.push('verify=fail');
  // 回滚状态必须进摘要：REJECT + 回滚失败 = 「拒了但改动还在仓库里」，
  // 这条事实若不固化在哈希里，事后就只剩一个干净的 decision 字段在骗人。
  if (outcome.decision === 'REJECT' || outcome.decision === 'ABSTAIN') {
    parts.push(outcome.reverted === true ? 'exec=reverted' : 'exec=NOT-reverted');
  }
  if (outcome.reason) parts.push(`reason=${outcome.reason}`);
  const text = parts.join('; ');
  return text.length > DIGEST_MAX ? `${text.slice(0, DIGEST_MAX - 1)}…` : text;
}

/**
 * 「这条预测算不算有证据」。三个条件缺一就当没证据（⇒ 留 null）：
 *
 * 1. `locked === true` ⇒ 外壳在 `contract_locks` 落行成功后才会置真。
 *    ⛔ 不认「调用方自称预测过」：没有锁的 predictedDelta 正是 §2.4.2
 *    要防的事后编造，放进不可重写的链上等于把造假固化。
 * 2. `predictedDelta` 是有限数。
 * 3. `hypothesisLock` 是非空串且 predictionSource 在 enum 内（schema 会拒脏值，
 *    这里先拒在门外，免得一条好好的决策因为一个坏引用被整条拒写）。
 *
 * @returns {{predictedDelta: number, predictionSource: string, lockEventId: string|null, hypothesisLock: string} | null}
 */
function lockedPredictionOf(prediction) {
  if (!prediction || prediction.locked !== true) return null;
  if (!Number.isFinite(prediction.predictedDelta)) return null;
  const lock = prediction.hypothesisLock;
  if (typeof lock !== 'string' || lock === '') return null;
  const source = prediction.predictionSource;
  if (source !== 'KNOWLEDGE_BASE' && source !== 'ANALOGY' && source !== 'DEFAULT_RULE') return null;
  return {
    predictedDelta: prediction.predictedDelta,
    predictionSource: source,
    hypothesisLock: lock,
    lockEventId: typeof prediction.lockEventId === 'string' && prediction.lockEventId !== ''
      ? prediction.lockEventId
      : null,
  };
}

/**
 * 纯函数：一次决策 → 一条待入链条目。
 *
 * @param {object} input
 * @param {object} input.proposal   mutator 的 MutationProposal（`id` 即幂等键来源）
 * @param {object|null} input.variant  population.ingest 返回的 variant 行
 * @param {object} input.outcome    执行事实：{ decision, path, preimagePath,
 *   bytesBefore, bytesAfter, verifyMode, sandboxOk, reverted, reason, eventIds, timestamp }
 * @param {object|null} [input.prediction]
 *   **评估之前**锁定的预测（`createPredictionLocker().lock()` 的返回值原样传入）。
 *   缺省 / 未入库 ⇒ 三个预测字段留 null（守卫测试「⛔ 无证据字段一律 null」锁的就是这个形状）。
 * @param {string|null} [input.targetMetric]
 *   调用方定出的目标指标（`metric-resolver.js`）。只在 variant 行落兜底时用得上，
 *   且**必须与锁定时同一个值**（见下面的注释）。
 * @returns {{ok: true, entry: object} | {ok: false, blocker: string, reason: string}}
 */
export function buildLedgerEntry({ proposal, variant, outcome, prediction = null, targetMetric: targetMetricOverride = null } = {}) {
  // contractId：实时路径此刻没有 Contract 对象（Phase 0 的 contracts 表未接入本链路），
  // 用 FROZEN proposal.id 顶替 —— 它是这次进化真实且唯一的身份，重放时同一个值 ⇒ 幂等成立。
  // ⛔ 不要加前缀：重建侧的 `REBUILD:<proposalId>` 才是"后补记录"的标记，
  //    实时条目不需要自证身份，加了反而让"同一次进化的两条键"看着像两条不同事实。
  const contractId = proposal?.id;
  if (!contractId) return { ok: false, blocker: 'NO_PROPOSAL_ID', reason: 'proposal.id 缺失 ⇒ 没有幂等键，拒写' };

  const mutationType = proposal?.kind;
  if (!mutationType) {
    return { ok: false, blocker: 'MUTATION_TYPE_UNEVIDENCED', reason: 'proposal.kind 缺失 ⇒ mutationType 无从取证' };
  }

  if (!variant) {
    // 与重建侧同判据：没有 variant 行就没有 targetMetric / generation 的证据。
    return { ok: false, blocker: 'NO_VARIANT_ROW', reason: 'population.ingest 未返回 variant 行 ⇒ targetMetric 无从取证' };
  }

  // targetMetric 直接取 variant 行记录的值。生产实况是 `metric: "unspecified"`
  // （population 的 ingest 缺省）——**照原样入链**，不把它当"缺证据"：
  // 这条目要证的是"系统当时确实没定指标"，替它编一个指标才是造假。
  //
  // 唯一例外：调用方传入 `targetMetric`（1a 方案② = `metric-resolver.js` 从
  // **提案自己声明的** `expectedEffect` 串里读出来的指标）。⛔ 这条入参不是给
  // "填个好看的指标"开的后门，它服务的是密码学约束：`hypothesisLock` 把
  // targetMetric 折进了摘要，条目里若写另一个值，1b 归档复原重算必判**假篡改**，
  // 整把锁作废。所以"锁用什么指标，条目就必须用什么指标"。
  const variantMetric = variant.expected_effect?.metric;
  const targetMetric = (typeof targetMetricOverride === 'string' && targetMetricOverride.trim() !== '')
    ? targetMetricOverride
    : variantMetric;
  if (typeof targetMetric !== 'string' || targetMetric === '') {
    return { ok: false, blocker: 'TARGET_METRIC_UNEVIDENCED', reason: 'targetMetric 入参与 variant.expected_effect.metric 都不是非空串 ⇒ 拒写' };
  }

  const decision = outcome?.decision;
  if (!decision) {
    return { ok: false, blocker: 'DECISION_UNEVIDENCED', reason: 'outcome.decision 缺失 ⇒ 没有决策可记（⛔ 不代填 ABSTAIN）' };
  }

  const timestamp = outcome.timestamp;
  if (typeof timestamp !== 'string' || timestamp === '') {
    return { ok: false, blocker: 'TIMESTAMP_UNEVIDENCED', reason: 'outcome.timestamp 缺失（service 会拒非 UTC 毫秒串）' };
  }

  const eventBusIds = Array.isArray(outcome.eventIds)
    ? [...new Set(outcome.eventIds.filter((id) => typeof id === 'string' && id !== ''))].sort()
    : [];

  // 预测证据门：没过这道门就留 null（⛔ 不是「调用方给了个数就认」）
  const locked = lockedPredictionOf(prediction);

  return {
    ok: true,
    entry: {
      contractId,
      generation: generationLabel(variant),
      summary: {
        mutationType,
        changedPlugins: pluginFromPath(outcome.path),
        targetMetric,
        hypothesisDigest: buildDigest({ proposal, variant, outcome, targetMetric }),
        predictedDelta: locked ? locked.predictedDelta : null,
        actualDelta: null,
        predictionQuality: null,
        predictionSource: locked ? locked.predictionSource : null,
        decision,
      },
      references: {
        // contractHash 仍等 Phase 0 的 Contract 正文；gitCommit 仍等人真提交。
        // 预测侧两个字段现在**有证据了**：锁在 contract-manager 里落表成功，
        // 值由调用方作为入参传进来（⛔ 不是本函数算的 —— 见 lockedPredictionOf）。
        contractHash: null,
        lockEventId: locked ? locked.lockEventId : null,
        eventBusIds,
        populationCandidateId: variant.variant_id ?? null,
        mountTicketId: null,
        abTestId: null,
        preimagePath: outcome.preimagePath ?? null,
        gitCommit: null,
      },
      timestamp,
      // reconstructed / evidenceCompleteness 不给 ⇒ 走 schema 默认
      // （原始条目恒 reconstructed:false、evidenceCompleteness:null，§4.3 示例）
    },
  };
}

/**
 * 建一个 ledger 写入器。
 *
 * @param {object} ctx  cordis 上下文（用 ctx.get 取 `agint.evolution`，调用时取不缓存）
 * @param {object} [deps]
 * @param {(msg: string, extra?: object) => void} [deps.warn]
 * @param {() => string} [deps.now] ISO 时间源（注入以便测试复现）
 */
export function createLedgerWriter(ctx, { warn = () => {}, now = () => new Date().toISOString() } = {}) {
  const dep = (n) => (ctx && typeof ctx.get === 'function' ? ctx.get(n) : null);

  /**
   * 把一次决策写入链。**永不抛** —— 但失败一定可见（返回值 + warn + 计数由 caller 负责）。
   *
   * @param {object} input 见 buildLedgerEntry，另加 `evolution`（可注入，测试用）
   * @returns {Promise<{ok: boolean, status: string, seq: number|null, idempotent?: boolean, blocker?: string, reason?: string, error?: string}>}
   */
  async function writeDecision(input = {}) {
    const built = buildLedgerEntry({
      proposal: input.proposal,
      variant: input.variant,
      outcome: { ...input.outcome, timestamp: input.outcome?.timestamp ?? now() },
      prediction: input.prediction ?? null,
      targetMetric: input.targetMetric ?? null,
    });
    if (!built.ok) {
      // 拒写不是"跳过"：缺证据必须留下是哪个字段缺，否则事后与"没跑这条分支"无法区分。
      warn('ledger: 拒写条目（证据不全，未入链）', {
        proposalId: input.proposal?.id ?? null,
        blocker: built.blocker,
        reason: built.reason,
      });
      return { ok: false, status: built.blocker, seq: null, reason: built.reason };
    }

    const evolution = input.evolution ?? dep('agint.evolution');
    const append = evolution?.ledger?.append;
    if (typeof append !== 'function') {
      // 写入通道不可用 ⇒ 这次进化没有留下链上证据。这是事故，不是可忽略的空档。
      const reason = 'agint.evolution.ledger.append 不可用（插件未部署或未 provide）';
      warn('ledger: 写入通道不可用，本次决策未入链', { proposalId: input.proposal?.id ?? null, reason });
      return { ok: false, status: 'LEDGER_UNAVAILABLE', seq: null, reason };
    }

    try {
      // 纪律 2：一条一写，await 到落盘返回才算成功（不落 buffer）。
      const res = await append(built.entry);
      const seq = res?.entry?.seq ?? null;
      if (res?.idempotent === true) {
        // 重放（cron 重跑 / 进程重启补写）的正常形状：不是失败，但要可见。
        warn('ledger: 同 contractId 已有条目，按幂等返回既有 seq（纪律 5）', {
          contractId: built.entry.contractId, seq,
        });
        return { ok: true, status: 'IDEMPOTENT', seq, idempotent: true };
      }
      return { ok: true, status: 'APPENDED', seq, idempotent: false };
    } catch (error) {
      // 纪律 3：抛错 + 告警 + 计数可见。⛔ 不降级、不兜底、不改写仓库。
      const msg = error instanceof Error ? error.message : String(error);
      warn('ledger: 追加失败（未降级、未兜底）', { contractId: built.entry.contractId, error: msg });
      return { ok: false, status: 'APPEND_FAILED', seq: null, error: msg };
    }
  }

  return { writeDecision };
}

export default { createLedgerWriter, buildLedgerEntry };
