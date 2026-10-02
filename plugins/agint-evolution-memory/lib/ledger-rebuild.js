/**
 * agint-evolution-memory: 历史 Ledger 重建（Phase 1 交付物 3，§4.3.5 / §4.6 #7）
 *
 * ## 它做什么、不做什么
 *
 * 做：从 `event_bus` 的 mutation 事件 + `agint_population.variants` + `.agint-preimage`
 * 的落盘证据，反推出「Phase 1 之前真实发生过、但当时没进链」的进化条目，
 * 标 `reconstructed: true` + `evidenceCompleteness`，经 `lib/ledger.js` 的
 * 唯一写入口追加进链。
 *
 * ⛔ 不做两件事，理由都写在这里而不是藏在实现里：
 *
 * 1. **不重建 Contract / contract_locks**。§7.1 的旧口径写了「≥5 份 Contract」，
 *    这里明确改为**不产出**，理由是 `hypothesisLock` 的全部语义就是
 *    「预测**先于**执行被锁定」——它靠的是时间先后。今天再算一份锁，
 *    证明的只能是"今天算的"，把它写成 9 月 27 日锁的，就是**用伪造的证据
 *    去保护证据**，正是 §4.2 要防的那类事。Ledger 侧只补「序列证据」，
 *    内容级字段（`contractHash` / `lockEventId`）一律 null。
 *
 * 2. **不推测任何参与哈希的字段**。schema 要求非空而证据缺失时，
 *    该条目进 `blockers` 而不是补一个看起来合理的值（§4.3.5 规则 3）。
 *    例：2026-09-27T10:18:15.793Z 那条 `evolution.mutation.rejected`
 *    在 variants 里没有对应行（它在 validate 阶段就被拒，从未生成变体），
 *    `mutationType` / `targetMetric` 无从取证 ⇒ 如实拒绝，输出原因。
 *
 * ## 三个"标记"的确切含义（对外口径必须照抄这段）
 *
 * - `contractId = "REBUILD:<proposalId>"`：**幂等键的命名空间**，
 *   不是"存在一份 Contract"的宣称。前缀 `REBUILD:` 让它在任何查询里
 *   都不会与真实 contractId 混淆。
 * - `generation = "GEN-UNKNOWN"`：variants 没给 generation 时的显式未知标记。
 *   它**长得像**一个代际号，是为了不破坏下游对格式的假设；
 *   `UNKNOWN` 这个词本身即声明"这里没有证据"。有证据时取
 *   `variants.generation`（数字）转 `GEN-<3 位>`.
 * - `evidenceCompleteness`：`FULL` = 本次重建**该有**的证据槽全部落实；
 *   `PARTIAL` = 有槽未落实，明细在 `missingEvidence`。
 *   ⚠️ 明细**不进条目**：条目形状是可哈希的 FROZEN 形状，多加字段要过
 *   §4.3「只增不减」纪律；而明细本身随时可核对 —— 顺着
 *   `references.eventBusIds` 回事件、回 variants 就能重算出来。
 *   ⚠️ `predictedDelta` / `actualDelta` / `predictionQuality` /
 *   `predictionSource` 恒为 null，且**不计入** completeness ——
 *   它们是 Phase 1 往后才产生的预测字段，历史里本来就没有，
 *   把它们算进"缺证据"会让每条重建都自动 PARTIAL，标记就失去分辨力。
 *
 * ## 时序硬约束（§4.3.5）
 *
 * 重建只允许发生在**首条实时条目入链之前**。链上一旦有 `reconstructed: false`
 * 的条目，向中间插入会让后续 parentHash 集体失配，而"重算使其自洽"正是
 * §4.4.4 禁止的重写历史。所以 `apply()` 先扫链、发现实时条目即
 * `REBUILD_TIMING_VIOLATION` 拒绝（⛔ 不提供 force 开关：合法的后补动作是
 * 追加尾部并如实标注，那是另一个决定，不该由重建脚本替人做）。
 *
 * ## 为什么 I/O 全部注入
 *
 * 本模块只吃 `events` / `variants` / `preimageStat`，不 import `node:fs`：
 * - `bin/rebuild-ledger-history.mjs`（只读报告，人工核对用）与宿主侧
 *   `evolution_ledgerRebuildHistory` 工具**共用同一份推导逻辑**。
 *   抄两份就会漂移，而漂移在这里的后果是"人核对过的计划"与"实际入链的条目"
 *   不是同一份东西 —— 那正好废掉人工核对这一道闸。
 * - 读别人的存储域（event_bus / population）不该是本插件的 fs 权限。
 */

import { assertUtcMillisIso } from './canonical.js';
import { LEDGER_DECISIONS, LEDGER_MUTATION_TYPES } from './schema.js';

export const REBUILD_PLAN_VERSION = 1;
export const REBUILD_CONTRACT_PREFIX = 'REBUILD:';

/** 一条历史进化 = 一个 outcome 事件（committed / rolledback / rejected）。 */
const OUTCOME_TOPICS = new Set([
  'evolution.mutation.committed',
  'evolution.mutation.rolledback',
  'evolution.mutation.rejected',
]);
const PROPOSED_TOPIC = 'evolution.mutation.proposed';

const DIGEST_MAX = 200;

/** 从 `plugins/<name>/...` 取插件名；取不到就如实返回空数组（不猜归属）。 */
function pluginFromPath(path) {
  if (typeof path !== 'string') return [];
  const m = /^plugins\/([^/]+)\//.exec(path.replace(/\\/g, '/'));
  return m ? [m[1]] : [];
}

/** 数字→最多 4 位小数的十进制串由 canonical 层负责，这里只拼证据片段。 */
function buildDigest({ variant, event }) {
  const parts = [];
  const p = event.payload ?? {};
  const v = variant ?? {};
  parts.push(`${v.mutation_kind ?? 'mutation'}`);
  const target = p.skill ?? v.payload?.promptId ?? p.path ?? p.target?.id;
  if (target) parts.push(`target=${target}`);
  if (p.path) parts.push(`path=${p.path}`);
  if (Number.isInteger(p.bytesBefore) && Number.isInteger(p.bytesAfter)) {
    parts.push(`bytes ${p.bytesBefore}->${p.bytesAfter}`);
  }
  if (v.expected_effect?.metric) {
    parts.push(`expected ${v.expected_effect.metric} ${v.expected_effect.direction ?? '?'} within ${v.expected_effect.window ?? '?'}`);
  }
  if (p.verifyMode) parts.push(`verify=${p.verifyMode}`);
  if (p.reason) parts.push(`reason=${p.reason}`);
  if (Array.isArray(p.findings) && p.findings.length > 0) {
    parts.push(`findings=${p.findings.map((f) => (typeof f === 'string' ? f : f?.message ?? '')).filter(Boolean).join(' | ')}`);
  }
  const text = parts.join('; ');
  return text.length > DIGEST_MAX ? `${text.slice(0, DIGEST_MAX - 1)}…` : text;
}

/**
 * 纯函数：证据 → 计划。同一个输入必须给出同一个输出（不含时钟、不读文件）。
 *
 * @param {object} input
 * @param {Array<{id: string, topic: string, occurredAt: string, payload: object}>} input.events
 * @param {Array<object>} [input.variants] agint_population.variants 的行
 * @param {(path: string) => {exists: boolean, size?: number} | null} [input.preimageStat]
 *        preimage 文件的只读探测；给定 path 时才会被调用
 */
export function buildRebuildPlan({ events = [], variants = [], preimageStat = null } = {}) {
  const byProposal = new Map();
  for (const v of variants) {
    // variants.commit_id 存的就是 proposalId（实测 2026-09-27~29 的 7 行全部如此）。
    if (v?.commit_id) byProposal.set(v.commit_id, v);
  }
  const proposedBy = new Map();
  for (const e of events) {
    if (e?.topic !== PROPOSED_TOPIC) continue;
    const pid = e.payload?.proposalId;
    if (pid && !proposedBy.has(pid)) proposedBy.set(pid, e);
  }

  const outcomes = events
    .filter((e) => OUTCOME_TOPICS.has(e?.topic))
    .sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt))
      || String(a.id).localeCompare(String(b.id)));

  const entries = [];
  const blockers = [];
  for (const e of outcomes) {
    const p = e.payload ?? {};
    const drop = (code, detail) => blockers.push({
      eventBusId: e.id, topic: e.topic, occurredAt: e.occurredAt, proposalId: p.proposalId ?? null, code, detail,
    });

    // 幂等键：没有 proposalId 就无法保证「同一进化只进链一次」，直接拒绝。
    if (!p.proposalId) { drop('NO_PROPOSAL_ID', '事件缺 proposalId，无法构造幂等键'); continue; }
    const variant = byProposal.get(p.proposalId) ?? null;
    if (!variant) {
      drop('NO_VARIANT_ROW', 'population.variants 里没有 commit_id=该 proposalId 的行，mutationType/targetMetric 无从取证');
      continue;
    }
    const mutationType = variant.mutation_kind;
    if (!LEDGER_MUTATION_TYPES.includes(mutationType)) {
      drop('MUTATION_TYPE_UNEVIDENCED', `variants.mutation_kind=${JSON.stringify(mutationType)} 不在生产 FROZEN 枚举内`);
      continue;
    }
    const targetMetric = variant.expected_effect?.metric;
    if (typeof targetMetric !== 'string' || targetMetric === '') {
      drop('TARGET_METRIC_UNEVIDENCED', 'variants.expected_effect.metric 缺失，不补默认指标名');
      continue;
    }
    // decision 优先取 outcome 事件（执行当时的策略结论），退回 variants 行。
    const decision = LEDGER_DECISIONS.includes(p.policyDecision) ? p.policyDecision
      : (LEDGER_DECISIONS.includes(variant.policy_decision) ? variant.policy_decision : null);
    if (!decision) {
      drop('DECISION_UNEVIDENCED', '事件与 variants 行都没有枚举内的策略结论');
      continue;
    }
    let timestamp;
    try {
      timestamp = assertUtcMillisIso(e.occurredAt, 'rebuild.timestamp');
    } catch (err) {
      drop('TIMESTAMP_UNEVIDENCED', `occurredAt=${JSON.stringify(e.occurredAt)} 不是 UTC 毫秒串：${err.message}`);
      continue;
    }

    const proposed = proposedBy.get(p.proposalId) ?? null;
    const eventBusIds = [proposed?.id, e.id].filter(Boolean);

    // preimage 引用只在「文件还在且字节数与事件声称的 bytesBefore 相等」时写：
    // 写一个指不到东西的路径，等于给校验留一个假线索。
    const missing = [];
    let preimagePath = null;
    if (p.preimagePath) {
      const st = preimageStat ? preimageStat(p.preimagePath) : null;
      if (st?.exists && (typeof p.bytesBefore !== 'number' || st.size === p.bytesBefore)) {
        preimagePath = p.preimagePath;
      } else {
        missing.push(st?.exists ? 'preimage:size-mismatch' : 'preimage:missing-file');
      }
    }
    if (!variant.variant_id) missing.push('populationCandidateId');
    if (!proposed) missing.push('proposedEvent');
    // committed 事件的正常形态应当带 preimagePath；没有就是证据断了一环。
    if (e.topic === 'evolution.mutation.committed' && !p.preimagePath) missing.push('preimage:not-recorded');

    entries.push({
      contractId: `${REBUILD_CONTRACT_PREFIX}${p.proposalId}`,
      generation: Number.isInteger(variant.generation)
        ? `GEN-${String(variant.generation).padStart(3, '0')}`
        : 'GEN-UNKNOWN',
      summary: {
        mutationType,
        changedPlugins: pluginFromPath(p.path ?? variant.payload?.path),
        targetMetric,
        hypothesisDigest: buildDigest({ variant, event: e }),
        predictedDelta: null,
        actualDelta: null,
        predictionQuality: null,
        predictionSource: null,
        decision,
      },
      references: {
        contractHash: null,
        lockEventId: null,
        eventBusIds,
        populationCandidateId: variant.variant_id ?? null,
        mountTicketId: null,
        abTestId: null,
        preimagePath,
        gitCommit: null,
      },
      timestamp,
      evidenceCompleteness: missing.length === 0 ? 'FULL' : 'PARTIAL',
      // 报告用，不入条目、不参与哈希。
      evidence: {
        outcomeEventBusId: e.id,
        proposedEventBusId: proposed?.id ?? null,
        variantId: variant.variant_id ?? null,
        decisionSource: LEDGER_DECISIONS.includes(p.policyDecision) ? 'event.policyDecision' : 'variant.policy_decision',
        generationSource: Number.isInteger(variant.generation) ? 'variant.generation' : 'UNKNOWN',
        missingEvidence: missing,
      },
    });
  }

  // §4.3.5 规则 1：按 timestamp 升序入链（seq 由 ledger service 分配）。
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.contractId.localeCompare(b.contractId));

  return {
    planVersion: REBUILD_PLAN_VERSION,
    // 计划里的计数是给人核对用的，不是链上的事实。
    counts: { outcomesSeen: outcomes.length, planned: entries.length, blocked: blockers.length },
    sources: {
      events: events.length,
      variants: variants.length,
      preimageProbed: preimageStat !== null,
    },
    entries,
    blockers,
  };
}

/**
 * @param {object} deps
 * @param {object} deps.ledger createLedgerService() 的实例（只用 appendEntry / listEntries / getHead）
 * @param {() => Promise<{events: Array, variants: Array, preimageStat?: Function}>} deps.loadSources
 * @param {(msg: string, extra?: object) => void} [deps.warn]
 * @param {(key: string, n?: number) => void} [deps.bump]
 */
export function createLedgerRebuildService({ ledger, loadSources, warn = () => {}, bump = () => {} }) {
  if (!ledger?.appendEntry || typeof loadSources !== 'function') {
    throw new TypeError('createLedgerRebuildService: 需要 ledger.appendEntry 与 loadSources');
  }

  async function plan() {
    const src = await loadSources();
    return buildRebuildPlan(src);
  }

  /** 链上有实时条目 = 时序窗口已关（§4.3.5）。只判存在性，不判内容。 */
  async function timingWindowOpen() {
    const all = await ledger.listEntries();
    const live = all.filter((e) => e?.reconstructed !== true);
    return { open: live.length === 0, liveCount: live.length, headSeq: all.length ? all[all.length - 1].seq : 0 };
  }

  /**
   * 把计划推进链。`apply` 缺省 false（只报不动链），与 decayScanRun 的
   * `apply?` 约定一致；真实入链必须显式传 true，且先经人工核对报告。
   */
  async function apply({ apply: commit = false } = {}) {
    const p = await plan();
    const timing = await timingWindowOpen();
    if (!timing.open) {
      const detail = `链上已有 ${timing.liveCount} 条实时条目（head seq=${timing.headSeq}），`
        + '向中间插入会让后续 parentHash 全部失配（§4.3.5）。'
        + '合法的后补动作只有"追加尾部并如实标注"，那是单独的人工决定。';
      bump('ledger.rebuild.blockedTiming');
      warn('ledger: 重建时序窗口已关闭，未写入任何条目', { liveCount: timing.liveCount, headSeq: timing.headSeq });
      return { ...p, applied: 0, timing, code: 'REBUILD_TIMING_VIOLATION', detail };
    }
    if (!commit) return { ...p, applied: 0, written: [], timing, code: 'REBUILD_DRY_RUN' };
    if (p.entries.length < 5) {
      // §4.6 #7 的门槛是 ≥5 条；凑不满就停下，让人先看为什么缺。
      bump('ledger.rebuild.blockedCount');
      warn('ledger: 可重建条目不足 5 条，未写入', { planned: p.entries.length, blocked: p.blockers.length });
      return { ...p, applied: 0, written: [], timing, code: 'REBUILD_INSUFFICIENT_EVIDENCE' };
    }

    const written = [];
    // 逐条同步（纪律 2）：一条失败即停，⛔ 不跳过、不重试、不补洞。
    // 已写成功的前缀是合法的（seq 连续），修好取数口径后重跑，
    // 靠 contractId 幂等从断点继续。
    for (const entry of p.entries) {
      const res = await ledger.appendEntry({
        contractId: entry.contractId,
        generation: entry.generation,
        summary: entry.summary,
        references: entry.references,
        timestamp: entry.timestamp,
        reconstructed: true,
        evidenceCompleteness: entry.evidenceCompleteness,
      });
      written.push({
        contractId: entry.contractId,
        seq: res.entry.seq,
        entryHash: res.entry.chain.entryHash,
        idempotent: res.idempotent,
      });
      bump(res.idempotent ? 'ledger.rebuild.idempotentHit' : 'ledger.rebuild.appended');
    }
    const head = await ledger.getHead();
    bump('ledger.rebuild.done', written.length);
    return { ...p, applied: written.filter((w) => !w.idempotent).length, written, head, timing, code: 'REBUILD_APPLIED' };
  }

  return { plan, apply };
}
