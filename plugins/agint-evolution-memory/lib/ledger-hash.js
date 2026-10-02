/**
 * agint-evolution-memory: ledger hash chain（Phase 1 交付物 3 §4.3.1-§4.3.3）
 *
 * 本模块只做**纯计算**：不读存储、不读时钟、不发事件、不写文件。
 * 写入协议（CAS / 幂等 / 逐条同步）在 `ledger.js`，校验在 `bin/verify-ledger-chain.mjs`。
 *
 * ⚠️ 这里算出的每一个摘要都必须能被 `bin/verify-ledger-chain.mjs` 独立重算得到
 * （校验器不调用本模块，见 §4.4.3 独立性纪律 #1：校验器复用写入方代码路径 ⇒
 * 写入侧 bug 会同时污染写入与校验 ⇒ 恒真门禁）。两侧的一致性由
 * `fixtures/ledger-hash-vectors.json` 锁定，不由"看起来一样"保证。
 */

import {
  GENESIS_PARENT_HASH,
  canonicalHash,
  concatHash,
  prepareHashInput,
  assertUtcMillisIso,
} from './canonical.js';

export { GENESIS_PARENT_HASH };

/**
 * Merkle 批大小（§4.3.3：每 8 条一批，滚动构建）。
 *
 * 定 8 是为了让批内树 ≤3 层（8→4→2→1），proof 的兄弟节点恒为 3 个；
 * 改这个值会让历史 proof 的形状变化 —— 它是规格常量，不是性能旋钮。
 */
export const LEDGER_BATCH_SIZE = 8;

/**
 * 参与 `entryHash` 的字段清单（§4.3.1 关键约束 1-4）。
 *
 * ⛔ 清单之外一律不入哈希，尤其：
 *   - `chain.entryHash`（自身，循环依赖）
 *   - `chain.batchRoot` / `chain.merkleRoot`（由 entryHash 派生，含进来同样循环）
 *   - `anchorStatus` / `anchorSeq` / `integrity` / `reconstructed` /
 *     `evidenceCompleteness`（**事后回写字段**，v1.2 勘误 #8）
 *
 * 最后这组是 §4.4.2 步骤 6 要改写的字段。若它们参与哈希，锚定成功的那一刻
 * 条目就自证为被篡改 —— 机制自己拆自己的台。
 *
 * `chain` 只取 `parentHash`（约束 4：chain 对象**不得整体入哈希**，
 * 否则把上面两个派生字段带进来了）。
 */
export const ENTRY_HASH_FIELD_ORDER = Object.freeze([
  'seq',
  'contractId',
  'generation',
  'summary',
  'parentHash',
  'references',
  'timestamp',
]);

/**
 * 把存储条目投影成哈希入参（不可变字段子集）。
 *
 * 单列成一个函数是为了让"哪些字段进哈希"这件事**只有一处定义**、
 * 可被单测直接断言字段集合（§7.1「哈希入参边界」用例）。
 *
 * @param {object} entry
 * @returns {object} 未归一的投影（调用方再过 prepareHashInput）
 */
export function projectEntryHashInput(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError('projectEntryHashInput: entry 必须是对象');
  }
  return {
    seq: entry.seq,
    contractId: entry.contractId,
    generation: entry.generation,
    summary: entry.summary,
    parentHash: entry.chain?.parentHash ?? null,
    references: entry.references,
    timestamp: entry.timestamp,
  };
}

/**
 * 计算 `entryHash`（§4.3.1）。
 *
 * @param {object} entry 完整的 ledger 条目（chain.entryHash 可以尚未填）
 * @returns {string} `sha256:<hex>`
 * @throws {TypeError} 时间戳格式非法（§4.3.1 ①）、非有限数字、bigint 等
 */
export function computeEntryHash(entry) {
  const projected = projectEntryHashInput(entry);
  assertUtcMillisIso(entry.timestamp, 'entryHash.timestamp');
  return canonicalHash(prepareHashInput(projected));
}

// ── §4.3.3 批内 Merkle 树 ────────────────────────────────────────────────

/**
 * 校验一个摘要串的形状。
 *
 * 在算树之前先卡形状：叶子如果是 `undefined` / 空串 / 不带算法前缀的裸 hex，
 * `canonicalHash` 不会抛错（它会老老实实把 null 序列化进树里），
 * 于是**缺数据能算出一个"看起来正常"的根** —— 这是最糟的失效形态：
 * 校验恒绿，而根下面根本没有证据。fail-closed 抛错。
 *
 * @param {string} hash
 * @param {string} [field]
 * @returns {string}
 */
export function assertHashString(hash, field = 'hash') {
  if (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
    throw new TypeError(`${field}: 必须是 sha256:<64 hex> 形态，收到 ${JSON.stringify(hash)}`);
  }
  return hash;
}

/**
 * 批内 Merkle 根（叶子顺序即入链顺序，⛔ 不得排序）。
 *
 * 奇数节点：最后一个与**自身**配对 `h(x+x)`。
 * ⚠️ 这与"直接把该节点上抛一层"是两种不同做法，两者都自洽但不统一就会
 * 跨实现分叉（§4.3.3）—— 故本行行为由向量表 `merkle.oddSelfPaired` 锁定。
 * 单节点批：`batchRoot = h(x+x)`。空批：无 batchRoot ⇒ 抛错（不是返回 null）。
 *
 * @param {string[]} leaves 批内各条的 entryHash，按 seq 升序
 * @returns {string} `sha256:<hex>`
 */
export function computeBatchRoot(leaves) {
  if (!Array.isArray(leaves)) throw new TypeError('computeBatchRoot: leaves 必须是数组');
  if (leaves.length === 0) {
    throw new TypeError('computeBatchRoot: 空批没有 batchRoot（§4.3.3）');
  }
  let level = leaves.map((h, i) => assertHashString(h, `leaves[${i}]`));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      // 奇数个 ⇒ 最后一个与自身配对
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(concatHash(left, right));
    }
    level = next;
  }
  return level[0];
}

/**
 * 滚动根（§4.3.3 roll-up 链）：
 *   rollupRoot(0) = GENESIS_PARENT_HASH
 *   rollupRoot(k) = sha256(canonical([rollupRoot(k-1), batchRoot(k)]))
 *
 * ⚠️ 诚实标注：roll-up 是「链式根」而非全量平衡树，因此跨批 proof 随批数
 * **线性**增长（不是 O(log N)）。当前量级（Phase 1 目标 ≥20 条、风险表按
 * <1k 条设计）下这是最简方案；进入 10k 级需改动态平衡树并重标向量表。
 *
 * @param {string[]} batchRoots 从第 1 批到第 k 批的 batchRoot（按批次顺序）
 * @returns {string} rollupRoot(k)
 */
export function computeRollupRoot(batchRoots) {
  if (!Array.isArray(batchRoots)) throw new TypeError('computeRollupRoot: 必须是数组');
  let root = GENESIS_PARENT_HASH;
  batchRoots.forEach((br, i) => {
    root = concatHash(root, assertHashString(br, `batchRoots[${i}]`));
  });
  return root;
}

/**
 * 某条所在的批次号（1 起）与批内下标（0 起）。
 * @param {number} seq
 */
export function batchOf(seq) {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new TypeError(`batchOf: seq 必须是 >=1 的整数，收到 ${String(seq)}`);
  }
  return {
    batchIndex: Math.ceil(seq / LEDGER_BATCH_SIZE),
    leafIndex: (seq - 1) % LEDGER_BATCH_SIZE,
  };
}

// ── §4.3.3 / §4.5 Merkle proof（Phase 1 实装项：生成 + 自校验）──────────

/**
 * 造批内兄弟路径。
 *
 * @param {string[]} leaves 该批全部叶子（seq 升序）
 * @param {number} leafIndex 目标叶子下标
 * @returns {Array<{hash: string, side: 'left'|'right'|'self'}>} 自底向上的路径
 */
export function buildBatchPath(leaves, leafIndex) {
  if (!Array.isArray(leaves) || leaves.length === 0) {
    throw new TypeError('buildBatchPath: leaves 必须是非空数组');
  }
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leaves.length) {
    throw new TypeError(`buildBatchPath: leafIndex ${String(leafIndex)} 越界（批内 ${leaves.length} 叶）`);
  }
  let level = leaves.map((h, i) => assertHashString(h, `leaves[${i}]`));
  let idx = leafIndex;
  const path = [];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const isTargetLevel = i === idx - (idx % 2);
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      if (isTargetLevel) {
        // 记录目标节点的兄弟；奇数末位与自身配对 ⇒ side 标 'self' 供验方复原
        path.push(
          idx % 2 === 0
            ? { hash: right, side: right === level[i] ? 'self' : 'right' }
            : { hash: level[i], side: 'left' },
        );
        idx = Math.floor(idx / 2);
      }
      next.push(concatHash(level[i], right));
    }
    level = next;
  }
  return path;
}

/**
 * 由叶子 + 批内路径重算 batchRoot（**独立实现**，不复用 computeBatchRoot，
 * 因此能用来交叉验证批根算得对不对 —— §4.6 #3 的 10 case 靠它）。
 *
 * @param {string} leaf
 * @param {Array<{hash: string, side: 'left'|'right'|'self'}>} path
 * @returns {string}
 */
export function verifyBatchPath(leaf, path) {
  let node = assertHashString(leaf, 'leaf');
  for (const [i, p] of path.entries()) {
    const sib = assertHashString(p?.hash, `path[${i}].hash`);
    if (p.side === 'self') node = concatHash(node, node);
    else if (p.side === 'right') node = concatHash(node, sib);
    else if (p.side === 'left') node = concatHash(sib, node);
    else throw new TypeError(`verifyBatchPath: path[${i}].side 非法: ${String(p.side)}`);
  }
  return node;
}

/**
 * 单条的完整 proof（§4.5 交接格式：批内 path + 该批之前的全部 batchRoot）。
 *
 * ⚠️ **为什么 proof 里的 `merkleRoot` 不是「这条自己存的那个值」**：
 * 条目落盘时算的 `batchRoot` / `merkleRoot` 是**追加那一刻的滚动值**
 * （§4.3.1 约束 2：条目写一次就不再改），所以批内非末条存的是「批还没长完」
 * 时的部分根。而验证一条属于**已完成的批**时，正确的比对对象是
 * **该批批末条（boundary）存的 merkleRoot** —— 它是这批的最终根，
 * 也是下一批 roll-up 的前驱（lib/ledger.js 的 deriveChainState 就是这么取的）。
 * 拿部分根去证最终态必然 MERKLE_ROOT_MISMATCH —— 这不是 bug，是两层语义：
 *   - 条目自带字段 = 「我入链那一刻链长什么样」（自证连续性）
 *   - proof 的根   = 「这批最终长什么样」（对外可验证）
 * 两者都由同一批叶子算出，对不上就说明有叶子被改写过 ⇒ 正是防篡改要抓的东西。
 *
 * @param {object} params
 * @param {Array<{seq: number, entryHash: string}>} params.entries 整条链（seq 升序）
 * @param {number} params.seq 目标条目
 * @returns {object} proof
 */
export function buildProof({ entries, seq }) {
  const list = normalizeEntries(entries);
  const target = list.find((e) => e.seq === seq);
  if (!target) throw new Error(`buildProof: seq=${seq} 不在链上`);
  const { batchIndex, leafIndex } = batchOf(seq);

  const batches = groupIntoBatches(list);
  const currentBatch = batches.find((b) => b.index === batchIndex);
  if (!currentBatch) throw new Error(`buildProof: 批次 ${batchIndex} 不存在`);

  const priorBatchRoots = batches
    .filter((b) => b.index < batchIndex)
    .map((b) => ({ batchIndex: b.index, batchRoot: b.batchRoot }));

  const boundarySeq = currentBatch.entries[currentBatch.entries.length - 1].seq;

  return {
    version: 1,
    seq: target.seq,
    contractId: target.contractId,
    entryHash: target.entryHash,
    batchIndex,
    batchLeafCount: currentBatch.leaves.length,
    leafIndex,
    path: buildBatchPath(currentBatch.leaves, leafIndex),
    priorBatchRoots,
    batchRoot: currentBatch.batchRoot,
    // 这批的最终滚动根 = roll-up(前置批根 + 本批根)；批已完成时等于批末条存的值。
    merkleRoot: computeRollupRoot([...priorBatchRoots.map((r) => r.batchRoot), currentBatch.batchRoot]),
    // 验证时应与之比对的条目（批末条；批未满时即 head）。
    boundarySeq,
    boundaryMerkleRoot: currentBatch.entries[currentBatch.entries.length - 1].merkleRoot ?? null,
    anchor: target.anchor ?? null,
  };
}

/**
 * 校验 proof 并把批根重放到 roll-up 根。
 *
 * @param {object} proof buildProof 的输出
 * @param {{expectedMerkleRoot?: string, expect?: object}} [opts]
 *        expect：期望的失败注入点（仅供测试，生产路径不传）
 * @returns {{ ok: boolean, batchRoot: string, rollupRoot: string, reason: string|null }}
 */
export function verifyProof(proof, opts = {}) {
  const fail = (reason) => ({ ok: false, batchRoot: null, rollupRoot: null, reason });

  if (!proof || typeof proof !== 'object') return fail('PROOF_MALFORMED');
  const { entryHash, path, priorBatchRoots, batchRoot } = proof;
  if (typeof entryHash !== 'string') return fail('ENTRY_HASH_MISSING');
  if (!Array.isArray(path)) return fail('PATH_MALFORMED');

  const recomputedBatchRoot = (() => {
    try {
      return verifyBatchPath(entryHash, path);
    } catch (err) {
      return `__error__:${err instanceof Error ? err.message : String(err)}`;
    }
  })();
  if (recomputedBatchRoot !== batchRoot) {
    return {
      ok: false,
      batchRoot: recomputedBatchRoot,
      rollupRoot: null,
      reason: 'BATCH_ROOT_MISMATCH',
    };
  }

  const roots = Array.isArray(priorBatchRoots) ? priorBatchRoots.map((r) => r?.batchRoot) : [];
  const ordered = Number.isInteger(proof.batchIndex) && proof.batchIndex === roots.length + 1;
  if (!ordered) {
    // 前缀根数量必须恰为「本批之前的批数」，否则 roll-up 无法复原批次位置。
    return { ok: false, batchRoot, rollupRoot: null, reason: 'PRIOR_ROOTS_COUNT' };
  }
  // 批末条存的滚动根必须与重放得到的根一致 —— 这条等式是「批已长完」的证明。
  // 不一致说明批内有叶子被改写（批末条是锚定时刻写入的权威值，不重算）。
  if (typeof proof.boundaryMerkleRoot === 'string'
    && proof.boundaryMerkleRoot !== proof.merkleRoot) {
    return {
      ok: false,
      batchRoot,
      rollupRoot: proof.boundaryMerkleRoot,
      reason: 'BATCH_BOUNDARY_DRIFT',
    };
  }
  let rollup;
  try {
    rollup = computeRollupRoot([...roots, batchRoot]);
  } catch (err) {
    return fail(`ROLLUP_ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (typeof opts.expectedMerkleRoot === 'string' && opts.expectedMerkleRoot !== rollup) {
    return { ok: false, batchRoot, rollupRoot: rollup, reason: 'MERKLE_ROOT_MISMATCH' };
  }
  return { ok: true, batchRoot, rollupRoot: rollup, reason: null };
}

/** 条目规范化：按 seq 升序，容忍调用方给乱序数组。 */
function normalizeEntries(entries) {
  if (!Array.isArray(entries)) throw new TypeError('entries 必须是数组');
  return [...entries].sort((a, b) => a.seq - b.seq);
}

/** 按 LEDGER_BATCH_SIZE 分组并算出每批的 batchRoot。 */
function groupIntoBatches(sortedEntries) {
  const batches = [];
  for (const e of sortedEntries) {
    const { batchIndex } = batchOf(e.seq);
    let b = batches.find((x) => x.index === batchIndex);
    if (!b) {
      b = { index: batchIndex, entries: [], leaves: [] };
      batches.push(b);
    }
    b.entries.push(e);
    b.leaves.push(e.entryHash);
  }
  return batches
    .sort((a, b) => a.index - b.index)
    .map((b) => ({ ...b, batchRoot: computeBatchRoot(b.leaves) }));
}

/**
 * 逐条追加时滚动更新批根与 roll-up 根（§4.3.3「追加成本 O(1) 摊销」）。
 *
 * 只在**本批叶子**上重算批根（≤8 个），批满则 roll-up 一层（1 次 concat）。
 * ⛔ 不重扫全表。
 *
 * @param {object} params
 * @param {string} params.entryHash 新条目的 entryHash
 * @param {number} params.seq 新条目的 seq
 * @param {string[]} [params.currentBatchLeaves=[]] 本批已有叶子（不含新条目，须恰为批内前缀）
 * @param {string} [params.prevRollupRoot] 上一条的 merkleRoot（首条时省略 = GENESIS）
 * @returns {{batchIndex: number, batchRoot: string, merkleRoot: string, batchCompleted: boolean, currentBatchLeaves: string[]}}
 */
export function appendToChain({
  entryHash,
  seq,
  currentBatchLeaves = [],
  prevRollupRoot = GENESIS_PARENT_HASH,
}) {
  const { batchIndex, leafIndex } = batchOf(seq);
  if (!Array.isArray(currentBatchLeaves)) {
    throw new TypeError('appendToChain: currentBatchLeaves 必须是数组');
  }
  // 叶子数必须等于「seq 在本批的下标」：多一条说明前面有条目没进链（洞或漏算），
  // 少一条说明传错了批。这里拒绝继续，⛔ 不猜缺的叶子。
  if (currentBatchLeaves.length !== leafIndex) {
    throw new Error(
      `appendToChain: seq=${seq} 期望批内已有 ${leafIndex} 叶，实得 ${currentBatchLeaves.length} —— 批状态与 seq 不符，拒绝写入`,
    );
  }
  assertHashString(prevRollupRoot, 'prevRollupRoot');

  const leaves = [...currentBatchLeaves, assertHashString(entryHash, 'entryHash')];
  const batchRoot = computeBatchRoot(leaves);
  const batchCompleted = leaves.length === LEDGER_BATCH_SIZE;

  return {
    batchIndex,
    batchRoot,
    merkleRoot: concatHash(prevRollupRoot, batchRoot),
    batchCompleted,
    // 已满的批不再作为「本批叶子」保留；调用方无需持久化该状态，
    // 下一条会从新批（leafIndex=0）重新读取。
    currentBatchLeaves: batchCompleted ? [] : leaves,
  };
}
