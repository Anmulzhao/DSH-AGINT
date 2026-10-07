/**
 * agint-evolution-memory: ledger service（Phase 1 交付物 3 §4.3.4 写入协议）
 *
 * ## 这个文件是链的**唯一写入口**（§4.3.4 纪律 1）
 *
 * driver、cron 锚定任务、重建脚本一律经本 service 追加条目。
 * ⛔ 任何外部进程直接改写 `agint_evolution.json` 都不安全：宿主存储后端
 * 把整个 unit 读进内存 Map，每次 putRecord 用内存态**整体重写**文件
 * （`@deepseek-ai/dsh-storage-json/lib/index.js:215-226`，注释第 15 行
 * 自述 "last-write-wins"）⇒ 外部写入会在下一次 put 时被整份覆盖掉，
 * 而且覆盖是静默的。这既是「不得直写」的理由，也是「锚定必须在宿主内跑」的理由。
 *
 * ## 逐条同步，不复用 EvolutionLogBuffer（纪律 2）
 *
 * `log-buffer.js` 是 `DEFAULT_FLUSH_COUNT=10 / DEFAULT_FLUSH_MS=5000 / beforeExit`
 * 三触发批量 flush，且 flush 失败会降级写 `agint.memory` 的 `buffer-lost:<n>`。
 * 对 evolution_log 是可接受的降级；对 Ledger **不可接受**：
 *   - 批内崩溃 = seq 空洞 = 断链，而断链在 ledger 里是安全事件不是性能事件；
 *   - 「降级即成功」会把证据消失说成写入成功，本域已有前科
 *     （fix-20260921：evolution_log 168 条里 shadow-ingest 标记 0）。
 * 所以这里一条一 `await put`，失败即抛（纪律 3）。宿主每次 put 都 await 到
 * temp→fsync→rename→目录 fsync 完成（同文件 :30-35），落盘语义不用自己再造（纪律 7）。
 */

import { GENESIS_PARENT_HASH, assertUtcMillisIso } from './canonical.js';
import {
  LEDGER_BATCH_SIZE,
  appendToChain,
  batchOf,
  buildProof,
  computeEntryHash,
} from './ledger-hash.js';
import {
  LIMITS,
  ledgerEntryCoreSchema,
  ledgerEntrySchema,
} from './schema.js';

const errMessage = (err) => (err instanceof Error ? err.message : String(err));

/**
 * @param {object} deps
 * @param {() => Promise<object>} deps.getTable 取 evolution_ledger 表（必须 await
 *        domain ready —— 纪律 4：拿不到实例即失败，不吞调用）
 * @param {() => string} deps.now ISO 时间源（注入以便测试复现）
 * @param {(msg: string, extra?: object) => void} [deps.warn]
 * @param {(key: string, n?: number) => void} [deps.bump]
 */
export function createLedgerService({ getTable, now, warn = () => {}, bump = () => {} }) {
  if (typeof getTable !== 'function') throw new TypeError('createLedgerService: getTable 必须是函数');
  if (typeof now !== 'function') throw new TypeError('createLedgerService: now 必须是函数');

  const keyOf = (seq) => String(seq);

  /** 全表按 seq 升序读出（head 由 max(seq) 推导，不单独存指针，§4.3.2）。 */
  async function readAll(table) {
    const out = [];
    for (const [, rec] of table.entries()) {
      if (!rec || !Number.isInteger(rec.seq)) continue;
      out.push(rec);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  async function getHead() {
    const table = await getTable();
    const all = await readAll(table);
    return all.length === 0 ? null : all[all.length - 1];
  }

  async function listEntries() {
    const table = await getTable();
    return readAll(table);
  }

  async function findByContractId(contractId) {
    if (!contractId) return null;
    const table = await getTable();
    for (const [, rec] of table.entries()) {
      if (rec?.contractId === contractId) return rec;
    }
    return null;
  }

  /**
   * 读出追加一条所需的链状态：前驱摘要、本批已有叶子、上一批边界的 roll-up 根。
   *
   * 只读「本批叶子（≤8）+ 上一批末条」，⛔ 不重扫全表（§4.3.3 追加成本 O(1) 摊销）。
   * @param {object} table
   * @param {number} nextSeq 即将分配的 seq
   */
  function deriveChainState(table, nextSeq) {
    const head = nextSeq === 1 ? null : table.get(keyOf(nextSeq - 1));
    if (nextSeq > 1 && !head) {
      // seq 不连续 = 表里有洞（写丢失或删条目）。这里**不填洞**、不猜前驱，
      // 直接把状态异常抛出去（§4.3.2：空洞必须按篡改级处理，禁止占位条目）。
      throw new Error(`LEDGER_GAP: seq=${nextSeq - 1} 不在表内，无法安全追加（拒绝向未知前驱写链）`);
    }

    const { batchIndex } = batchOf(nextSeq);
    const batchStartSeq = (batchIndex - 1) * LEDGER_BATCH_SIZE + 1;

    const leaves = [];
    for (let s = batchStartSeq; s < nextSeq; s++) {
      const e = table.get(keyOf(s));
      if (!e) throw new Error(`LEDGER_GAP: 本批内 seq=${s} 缺失`);
      leaves.push(e.chain?.entryHash);
    }

    // roll-up 起点：本批之前那一批的 merkleRoot（即该批末条的 chain.merkleRoot）；
    // 首个批次用创世常量。
    let prevRollupRoot = GENESIS_PARENT_HASH;
    if (batchStartSeq > 1) {
      const boundary = table.get(keyOf(batchStartSeq - 1));
      if (!boundary) throw new Error(`LEDGER_GAP: 上批末条 seq=${batchStartSeq - 1} 缺失`);
      prevRollupRoot = boundary.chain?.merkleRoot;
    }

    return { head, leaves, prevRollupRoot, batchIndex };
  }

  // ── 进程内单写者锁（纪律 1 的实现）──────────────────────────────────────
  //
  // 宿主只为**单次 put** 排序（dsh-storage-domain 的 write chain），不会为
  // 「读快照 → 算 hash → 写」这段临界区排序。不自己上锁就会出现：
  //   两个并发 appendEntry 都算出 nextSeq=N ⇒ 都通过槽位检查 ⇒ 后者覆盖前者
  //   ⇒ 链上凭空少一条证据，且 head 的 entryHash 变了（比丢条目更难查）。
  // 追加频率是「每周若干条」量级，串行化的代价可忽略。
  let appendLock = Promise.resolve();
  function withAppendLock(job) {
    const run = appendLock.then(job, job); // 前一次成败都要放行下一次
    appendLock = run.then(() => {}, () => {});
    return run;
  }

  /**
   * 追加一条 ledger 条目（链的**唯一**写入路径）。
   *
   * 顺序：加锁 → 幂等查 → 取 head → 归一 → 算 entryHash → 更新批根
   *       → 复核 tail → 单条落盘 → 释放锁。
   * ⛔ 不做多条目事务批（会破坏「崩溃后表内停在旧 head」的语义，纪律 8）。
   *
   * @param {object} input
   * @param {string} input.contractId      幂等键
   * @param {string} input.generation
   * @param {object} input.summary         §4.3 的 summary 段
   * @param {object} [input.references]
   * @param {string} [input.timestamp]     缺省取注入的 now()
   * @param {boolean} [input.reconstructed] 历史重建条目传 true
   * @param {'FULL'|'PARTIAL'|null} [input.evidenceCompleteness]
   * @returns {Promise<{entry: object, idempotent: boolean}>}
   */
  function appendEntry(input) {
    return withAppendLock(() => appendEntryLocked(input));
  }

  async function appendEntryLocked(input) {
    const contractId = input?.contractId;
    if (!contractId) throw new Error('LEDGER_INPUT_INVALID: contractId 必填（它是幂等键，缺了就无从判重）');

    // 纪律 5：重复追加同 contractId ⇒ 返回既有条目，不新增。
    // 否则重放（cron 重跑 / 进程重启补写）会产生两条同 contractId 不同 timestamp
    // 的条目，制造「合法的分叉链」—— 比丢条目更难解释。
    // ⚠️ 幂等查必须在 appendLock **之内**（已在Locked 路径里）：否则两个并发的
    //    同 contractId 调用都查不到既存条目，各写一条 —— 幂等形同虚设。
    const existing = await findByContractId(contractId);
    if (existing) {
      bump('ledger.append.idempotentHit');
      return { entry: existing, idempotent: true };
    }

    const table = await getTable(); // 纪律 4：await domain ready，拿不到即抛（不吞调用）
    const all = await readAll(table);
    const nextSeq = all.length === 0 ? 1 : all[all.length - 1].seq + 1;

    // ① 先归一 + 校验「可哈希核」，再用归一值算 hash。
    //    顺序不能反：zod 的 z.object 默认**静默丢弃未知键**，若拿未归一的输入
    //    算 entryHash，落盘条目会少几个键 ⇒ 校验器从存储重算得到不同摘要
    //    ⇒ 一条正常写入的条目自证为 TAMPERED（假阳性会淹掉真实告警）。
    //    同时这也保证失败的 parse 发生在 put 之前 ⇒ 非法条目绝不进链。
    const timestamp = assertUtcMillisIso(input.timestamp ?? now(), 'ledger.timestamp');
    const { head, leaves, prevRollupRoot } = deriveChainState(table, nextSeq);
    const parentHash = head ? head.chain.entryHash : GENESIS_PARENT_HASH;

    let core;
    try {
      core = ledgerEntryCoreSchema.parse({
        seq: nextSeq,
        contractId,
        generation: input.generation,
        summary: input.summary,
        parentHash,
        references: input.references ?? {},
        timestamp,
      });
    } catch (err) {
      bump('ledger.append.rejected');
      warn('ledger: 条目字段非法，拒绝入链（未写入）', { contractId, seq: nextSeq, error: errMessage(err) });
      throw err;
    }

    // entryHash 只吃不可变字段清单（ledger-hash.js），回写字段与派生字段都不在里面。
    const entryHash = computeEntryHash({ ...core, chain: { parentHash } });
    const { batchRoot, merkleRoot } = appendToChain({
      entryHash,
      seq: nextSeq,
      currentBatchLeaves: leaves,
      prevRollupRoot,
    });

    // 复核（§4.3.2 CAS）：落盘前的最后一道闸。进程内并发已由 appendLock 关闭，
    // 这里真正防的是**绕过 service 的直写**（纪律 1 的违例）：
    //   - 前驱条目的 entryHash 与快照不符 ⇒ 有人改写了历史条目
    //   - nextSeq 槽位已被占            ⇒ 有人抢在链尾直写了一条
    // 两者都拒绝写入 + 告警，⛔ 不重试、不覆盖（覆盖 = 把违例证据洗掉）。
    if (head) {
      const fresh = table.get(keyOf(head.seq));
      if (!fresh) {
        bump('ledger.append.casConflict');
        throw new Error(`LEDGER_GAP: 前驱 seq=${head.seq} 在复核时已不在表内`);
      }
      if (fresh.chain?.entryHash !== parentHash) {
        bump('ledger.append.casConflict');
        warn('ledger: CAS 冲突，拒绝追加', { expectedSeq: head.seq, expectedHash: parentHash, actualHash: fresh.chain?.entryHash });
        throw new Error(`LEDGER_CAS_CONFLICT: seq=${head.seq} 的前驱摘要已变化，链状态存疑，拒绝写入`);
      }
    }
    // ⚠️ 宿主表句柄只有 get/keys/entries/size/put/delete/update，**没有 has()**
    //    （dsh-storage-domain/lib/index.js:229-260 的 KvTableImpl），所以用 get 判占位。
    const squatter = table.get(keyOf(nextSeq));
    if (squatter !== undefined && squatter !== null) {
      bump('ledger.append.casConflict');
      warn('ledger: 目标 seq 槽位已被占，拒绝追加', { seq: nextSeq, contractId });
      throw new Error(`LEDGER_CAS_CONFLICT: seq=${nextSeq} 已被占用（有人绕过 service 直写？）`);
    }

    let entry;
    try {
      entry = ledgerEntrySchema.parse({
        ...core,
        chain: { entryHash, parentHash, batchRoot, merkleRoot },
        reconstructed: input.reconstructed === true,
        evidenceCompleteness: input.evidenceCompleteness ?? null,
      });
      await table.put(keyOf(nextSeq), entry); // 纪律 2：一条一写，写完才算成功
    } catch (err) {
      // 纪律 3：失败必须抛 + 可见，禁止写一条 buffer-lost 就当成功。
      bump('ledger.append.failed');
      warn('ledger: 追加失败（未降级、未兜底）', {
        seq: nextSeq,
        contractId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    bump('ledger.append.ok');
    if (all.length + 1 > LIMITS.LEDGER_ENTRIES) {
      warn('ledger: 条目数超过告警阈值（只告警，⛔ 不轮转删除）', { count: all.length + 1, limit: LIMITS.LEDGER_ENTRIES });
    }
    return { entry, idempotent: false };
  }

  /**
   * 锚定成功后回写非哈希字段（§4.4.2 步骤 6）。
   *
   * ⚠️ 只改 anchorStatus / anchorSeq（以及发现异常时的 integrity），
   * 绝不改写条目内容 —— 这两个字段不参与 entryHash，所以回写不会自毁哈希
   * （v1.2 勘误 #8 的存在理由）。每条改完重算一次 entryHash 自证这点。
   *
   * 为什么不需要 withAppendLock（2026-10-07 审查复核，留注释免后人重推）：
   * 与并发 appendEntry 的 table.put 可能交错，但 ① host 平面把单次 put 串行化，
   * ② put 是 fresh get 之后的**全量重写**，写入值只由读到的 rec 决定——
   * 最坏交错也只是「anchorStatus 用旧条目状态覆盖一次」，下轮锚定自愈；
   * appendEntry 改的字段（content/chain）与这里改的字段（anchorStatus/anchorSeq）
   * 交集为空，且 appendEntry 的 CAS 复核会先撞 integrity 变化。锚定频率是周级，
   * 串行化零成本，若未来要绝对保守可直接包进 withAppendLock。
   */
  async function markAnchored({ anchorSeq, fromSeq, toSeq }) {
    if (!Number.isInteger(anchorSeq) || anchorSeq < 1) throw new Error('markAnchored: anchorSeq 必须是 >=1 的整数');
    const table = await getTable();
    const results = { anchored: [], tampered: [], missing: [] };
    for (let seq = fromSeq; seq <= toSeq; seq++) {
      const rec = table.get(keyOf(seq));
      if (!rec) {
        results.missing.push(seq);
        continue;
      }
      const recomputed = computeEntryHash(rec);
      const updated = { ...rec, anchorStatus: 'ANCHORED', anchorSeq };
      if (recomputed !== rec.chain.entryHash) {
        updated.anchorStatus = 'ANCHOR_MISMATCH';
        updated.integrity = 'TAMPERED';
        results.tampered.push(seq);
      } else {
        results.anchored.push(seq);
      }
      await table.put(keyOf(seq), ledgerEntrySchema.parse(updated));
    }
    bump('ledger.anchor.writeback', results.anchored.length + results.tampered.length);
    return { ...results, anchorSeq };
  }

  /** 取某条的 Merkle proof（批内 path + 前置批根，§4.5）。 */
  async function proofFor(seq) {
    const table = await getTable();
    const all = await readAll(table);
    return buildProof({
      entries: all.map((e) => ({
        seq: e.seq,
        contractId: e.contractId,
        entryHash: e.chain.entryHash,
        merkleRoot: e.chain.merkleRoot,
        anchor: e.anchorStatus === 'ANCHORED' ? { anchorSeq: e.anchorSeq } : null,
      })),
      seq,
    });
  }

  async function stats() {
    const all = await listEntries();
    const head = all.length === 0 ? null : all[all.length - 1];
    return {
      entries: all.length,
      headSeq: head?.seq ?? null,
      headEntryHash: head?.chain?.entryHash ?? null,
      headMerkleRoot: head?.chain?.merkleRoot ?? null,
      batchIndex: head ? batchOf(head.seq).batchIndex : 0,
      reconstructed: all.filter((e) => e.reconstructed).length,
      limits: { LEDGER_ENTRIES: LIMITS.LEDGER_ENTRIES },
    };
  }

  return { getHead, listEntries, findByContractId, deriveChainState, appendEntry, markAnchored, proofFor, stats };
}
