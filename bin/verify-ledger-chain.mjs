#!/usr/bin/env node
/**
 * bin/verify-ledger-chain.mjs —— Evolution Ledger 独立校验器（Phase 1 交付物 3 §4.4.3）
 *
 * ## 为什么这个文件必须**不 import 插件代码**
 *
 * §4.4.3 独立性纪律 #1：校验器若复用写入方（evolution-memory）的代码路径，
 * 写入侧的 bug 会同时污染「写入」与「校验」⇒ 恒真门禁。所以这里：
 *   - 直接读 `agint_evolution.json` 的**文件字节**，不碰 storage 后端、不起 domain；
 *   - 自带一份 canonical + 批树 + roll-up 实现（第三份），
 *     三份由 `fixtures/ledger-hash-vectors.json` 锁死（§4.6 #2），任一方漂移即变红；
 *   - entryHash / batchRoot / merkleRoot **全部从存储字段重算**，
 *     绝不采信文件里存着的摘要值。
 *
 * ## 读的是磁盘文件，所以看到的是「已落盘」的状态
 *
 * 宿主每次 put 都 await 到 temp→fsync→rename 完成（dsh-storage-json 第 30-35 行），
 * 因此本脚本与宿主进程并发运行不会读到半个条目 —— 这是「逐条同步落盘」
 * （§4.3.4 纪律 2）在白盒侧的受益点。
 *
 * 用法：
 *   node bin/verify-ledger-chain.mjs --full                 整链校验（O(N)）
 *   node bin/verify-ledger-chain.mjs --entry <seq|contractId>  单条 + Merkle proof
 *   node bin/verify-ledger-chain.mjs --anchor               锚点文件最新行 vs 链 head
 *   node bin/verify-ledger-chain.mjs --anchors              锚点文件**全部 git 历史**重放
 *   node bin/verify-ledger-chain.mjs --since 2026-10-01     只验某时刻之后的条目
 *   可选：--ledger <path> --anchor-file <path> --json
 *
 * 退出码（对齐仓内 bin/ 既有门禁惯例）：0 = 通过 / 1 = 校验失败 / 2 = 脚本自身出错
 *
 * 零第三方依赖：node:fs / node:path / node:url / node:os / node:crypto / node:child_process。
 * ⛔ 只读：本脚本永不写 ledger、锚点文件或任何 git 状态（§4.4.3 独立性纪律 #4）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { canonicalStringify as sharedCanonical } from './lib/canonical-json.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LEDGER = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'storages', 'agint_evolution.json')
  : join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'storages', 'agint_evolution.json');
const DEFAULT_ANCHOR_FILE = join(REPO_ROOT, 'docs', 'evolution-ledger-anchor.md');

const GENESIS_PARENT_HASH = `sha256:${'0'.repeat(64)}`;
const BATCH_SIZE = 8;
const HASH_DECIMALS = 4;
const ABS_UPPER_BOUND = 1e21;
const UNIT_NAME = 'agint_evolution';

// ── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    mode: 'full', entry: null, since: null,
    ledger: DEFAULT_LEDGER, anchorFile: DEFAULT_ANCHOR_FILE, json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full') opts.mode = 'full';
    else if (a === '--entry') { opts.mode = 'entry'; opts.entry = argv[++i] ?? null; }
    else if (a === '--anchor') opts.mode = 'anchor';
    else if (a === '--anchors') opts.mode = 'anchors';
    else if (a === '--since') { opts.since = argv[++i] ?? null; if (!opts.since) throw new Error('--since 需要一个值'); }
    else if (a === '--ledger') { opts.ledger = argv[++i] ?? null; if (!opts.ledger) throw new Error('--ledger 需要一个路径'); }
    else if (a === '--anchor-file') { opts.anchorFile = argv[++i] ?? null; if (!opts.anchorFile) throw new Error('--anchor-file 需要一个路径'); }
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') opts.mode = 'help';
    else throw new Error(`未知参数：${a}（-h 看用法）`);
  }
  if (opts.since && Number.isNaN(Date.parse(opts.since))) throw new Error(`--since 无法解析：${opts.since}`);
  return opts;
}

// ── 本地 canonical（第三份实现，§4.4.3 独立性纪律 #2）─────────────────────
//
// 序列化本体复用 bin/lib/canonical-json.mjs（仓内已有一份、且与插件侧
// 由向量表锁死一致）；这里**只**补 ledger 专属的两件确定化动作：
// 数字量化与字符串数组排序。为什么量化：跨语言/跨版本的浮点末位
// 差异会把同一条目算成两个摘要（§4.3.1 ②）。为什么不排序对象键：
// canonicalStringify 已经排了；这里排的是**值位置的字符串数组**
// （§4.3.1 ③：列表语义是集合时，顺序不该进证据）。

function canonicalHash(value) {
  const hex = createHash('sha256').update(sharedCanonical(value), 'utf8').digest('hex');
  return `sha256:${hex}`;
}

function assertHashString(h, field) {
  if (typeof h !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(h)) {
    throw new TypeError(`${field}: 必须是 sha256:<64 hex>，收到 ${JSON.stringify(h)}`);
  }
  return h;
}

function quantize(n, pathLabel) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new TypeError(`${pathLabel}: 非有限数字不得参与 hash（会与 null 撞摘要）: ${String(n)}`);
  }
  if (Math.abs(n) >= ABS_UPPER_BOUND) {
    throw new TypeError(`${pathLabel}: 数字过大（|n|>=1e21），toFixed 会退化 ${String(n)}`);
  }
  const v = Number(n.toFixed(HASH_DECIMALS));
  return v === 0 ? 0 : v; // -0 → 0
}

/** 与插件侧 lib/canonical.js 同语义的独立实现（漂移由向量表抓）。 */
function prepareHashInput(value, pathLabel = 'entry') {
  if (Array.isArray(value)) {
    const mapped = value.map((v, i) => prepareHashInput(v, `${pathLabel}[${i}]`));
    const allStrings = mapped.length > 0 && mapped.every((v) => typeof v === 'string');
    if (allStrings) mapped.sort();
    return mapped;
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number') return quantize(value, pathLabel);
    if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
      throw new TypeError(`${pathLabel}: ${typeof value} 无 JSON 表示，拒绝入 hash`);
    }
    return value ?? null;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    out[k] = prepareHashInput(v, `${pathLabel}.${k}`);
  }
  return out;
}

/** entryHash 的入参字段（§4.3.1 清单）。与插件侧同一份契约，各自独立书写。 */
function projectEntry(entry) {
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

function computeEntryHash(entry) {
  assertUtcMillisIso(entry.timestamp, `seq=${entry.seq} timestamp`);
  return canonicalHash(prepareHashInput(projectEntry(entry)));
}

function assertUtcMillisIso(ts, label) {
  if (typeof ts !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(ts)) {
    throw new TypeError(`${label}: 时间戳必须是 UTC + 毫秒 + Z，收到 ${JSON.stringify(ts)}`);
  }
  // 形状对不等于时刻真存在（2026-02-31 能过正则）⇒ 往返比对
  if (new Date(ts).toISOString() !== ts) throw new TypeError(`${label}: 不是真实时刻: ${ts}`);
  return ts;
}

function concatHash(left, right) {
  return canonicalHash([left, right]);
}

function computeBatchRoot(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) throw new TypeError('空批没有 batchRoot');
  let level = leaves.map((h, i) => assertHashString(h, `leaves[${i}]`));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(concatHash(level[i], right));
    }
    level = next;
  }
  return level[0];
}

function computeRollupRoot(batchRoots) {
  let root = GENESIS_PARENT_HASH;
  batchRoots.forEach((br, i) => { root = concatHash(root, assertHashString(br, `batchRoots[${i}]`)); });
  return root;
}

function batchOf(seq) {
  return { batchIndex: Math.ceil(seq / BATCH_SIZE), leafIndex: (seq - 1) % BATCH_SIZE };
}

// ── 读文件 ────────────────────────────────────────────────────────────────

/**
 * 直接解析整单元文件。刻意**不用** storage 后端：
 * 那会把「读文件」这件事交给被校验的一方（宿主写入方）的代码。
 */
function readLedger(path) {
  if (!existsSync(path)) throw new Error(`LEDGER_FILE_MISSING: 找不到 ledger 文件 ${path}（用 --ledger 指定）`);
  const raw = readFileSync(path, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) throw new Error('LEDGER_BOM: 文件带 UTF-8 BOM，JSON.parse 会拒收（继承教训 §4）');
  let doc;
  try { doc = JSON.parse(raw); } catch (err) { throw new Error(`LEDGER_UNPARSEABLE: ${err.message}`); }
  if (doc?.unit?.name !== UNIT_NAME) throw new Error(`LEDGER_FOREIGN_UNIT: unit.name=${JSON.stringify(doc?.unit?.name)}`);
  if (doc.unit.version !== 1) throw new Error(`LEDGER_VERSION: 期望整单元 version=1，实为 ${doc.unit.version}`);
  const rows = doc.tables?.evolution_ledger;
  if (rows === undefined) return { entries: [], tableAbsent: true };
  if (rows === null || typeof rows !== 'object' || Array.isArray(rows)) {
    throw new Error('LEDGER_MALFORMED_TABLE: evolution_ledger 不是对象');
  }
  const entries = Object.entries(rows).map(([key, e]) => ({ key, entry: e, parsed: Number(key) }))
    .filter((r) => Number.isInteger(r.parsed) && r.parsed >= 1)
    .sort((a, b) => a.parsed - b.parsed);
  // 主键必须等于 seq：不等就是「同一序号两条记录」，链序失去唯一定义
  for (const r of entries) {
    if (r.entry?.seq !== r.parsed) {
      throw new Error(`LEDGER_KEY_MISMATCH: 主键 ${r.key} 与 seq=${r.entry?.seq} 不符`);
    }
  }
  return { entries: entries.map((r) => r.entry), tableAbsent: false };
}
// ── 校验核心 ──────────────────────────────────────────────────────────────

/**
 * 整链校验：逐条重算 entryHash → 检 parentHash 接续 → 检 seq 连续 →
 * 按批重算 batchRoot → roll-up 重放比对批末条存的 merkleRoot。
 *
 * ⚠️ 文件里存着的摘要**只被用作比对目标，从不作为输入**。
 *
 * @param {object[]} entries seq 升序
 * @param {{sinceTs?: number|null}} [opts]
 */
function verifyChain(entries, opts = {}) {
  const failures = [];
  const notes = [];
  const sinceTs = opts.sinceTs ?? null;

  if (entries.length === 0) {
    notes.push({ level: 'note', code: 'LEDGER_EMPTY', detail: '表内 0 条，没有可校验的链（尚未有进化入链）' });
  }

  // ① seq 连续性：1..max 每个都必须存在
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  const maxSeq = entries.length === 0 ? 0 : entries[entries.length - 1].seq;
  for (let seq = 1; seq <= maxSeq; seq++) {
    if (!bySeq.has(seq)) {
      // §4.4.4：空洞 = 篡改级事件。⛔ 不补占位条目填洞。
      failures.push({ seq, code: 'SEQ_GAP', detail: `seq=${seq} 不在表内（写丢失或删条目）` });
    }
  }

  // ② 逐条：重算 entryHash + parentHash 接续
  let prevHash = GENESIS_PARENT_HASH;
  for (const [i, entry] of entries.entries()) {
    const seq = entry?.seq;
    if (!entry || typeof entry !== 'object') {
      failures.push({ seq, code: 'ENTRY_MALFORMED', detail: '条目不是对象' });
      continue;
    }
    if (sinceTs !== null && Date.parse(entry.timestamp) < sinceTs) {
      prevHash = entry.chain?.entryHash ?? prevHash; // 跳过内容校验，但维持链序基准
      continue;
    }
    let recomputed;
    try {
      recomputed = computeEntryHash(entry);
    } catch (err) {
      failures.push({ seq, code: 'ENTRY_HASH_ERROR', detail: err.message });
      continue;
    }
    if (recomputed !== entry.chain?.entryHash) {
      failures.push({
        seq,
        code: 'ENTRY_HASH_MISMATCH',
        expected: entry.chain?.entryHash,
        actual: recomputed,
        detail: '条目内容与摘要不符 ⇒ 内容被改写，或写入侧的哈希字段集与本校验器不一致',
      });
    }
    if (entry.chain?.parentHash !== prevHash) {
      failures.push({
        seq,
        code: i === 0 && seq === 1 ? 'GENESIS_MISMATCH' : 'PARENT_HASH_BROKEN',
        expected: prevHash,
        actual: entry.chain?.parentHash,
        detail: '前驱摘要接续失败（链在此断裂或被整体重写）',
      });
    }
    prevHash = entry.chain?.entryHash ?? prevHash;
  }

  // ③ 批结构：每批用叶子重算批根，与该批批末条存的值比对；再 roll-up 重放
  const batches = groupBatches(entries);
  let rollup = GENESIS_PARENT_HASH;
  for (const b of batches) {
    let root;
    try {
      root = computeBatchRoot(b.leaves);
    } catch (err) {
      failures.push({ seq: b.boundarySeq, code: 'BATCH_ROOT_ERROR', detail: err.message });
      continue;
    }
    if (root !== b.boundary.chain?.batchRoot) {
      failures.push({
        seq: b.boundarySeq,
        code: 'BATCH_ROOT_MISMATCH',
        expected: b.boundary.chain?.batchRoot,
        actual: root,
        detail: `批 ${b.batchIndex} 的批根与批末条存的值不符（批内叶子被改写或顺序变动）`,
      });
    }
    rollup = concatHash(rollup, root);
    if (rollup !== b.boundary.chain?.merkleRoot) {
      failures.push({
        seq: b.boundarySeq,
        code: 'MERKLE_ROOT_MISMATCH',
        expected: b.boundary.chain?.merkleRoot,
        actual: rollup,
        detail: `批 ${b.batchIndex} 的 roll-up 根与批末条存的值不符`,
      });
    }
    if (!b.complete) {
      notes.push({ level: 'note', code: 'BATCH_OPEN', detail: `批 ${b.batchIndex} 未满（${b.leaves.length}/${BATCH_SIZE}），其根仍会随追加变化` });
    }
  }

  return {
    failures, notes, batches, rollup, entries,
    head: entries.length ? entries[entries.length - 1] : null,
    maxSeq,
    entryCount: entries.length,
  };
}

/**
 * 按 BATCH_SIZE 分组。
 *
 * ⚠️ 最后一批通常**未满**：未满批的批根是随追加变化的滚动值，所以这批的记录值
 * 就是批末条（= 链 head）当下存的值；校验器仍用同一批叶子**重算**再比，
 * 而不是采信 —— 与写入侧「一条一写、写完即定」的语义对齐（§4.3.4 纪律 2）。
 */
function groupBatches(entries) {
  const out = [];
  for (const e of entries) {
    const { batchIndex } = batchOf(e.seq);
    let b = out.find((x) => x.batchIndex === batchIndex);
    if (!b) {
      b = { batchIndex, entries: [], leaves: [], boundarySeq: null, boundary: null, complete: false };
      out.push(b);
    }
    b.entries.push(e);
    b.leaves.push(e.chain?.entryHash);
    b.boundary = e;
    b.boundarySeq = e.seq;
  }
  for (const b of out) b.complete = b.leaves.length === BATCH_SIZE;
  return out;
}

// ── 单条 Merkle proof（§4.5：批内 path + 该批之前的全部 batchRoot）────────

function buildBatchPath(leaves, leafIndex) {
  let level = leaves.map((h, i) => assertHashString(h, `leaves[${i}]`));
  let idx = leafIndex;
  const path = [];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      if (i === idx - (idx % 2)) {
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

function verifyBatchPath(leaf, path) {
  let node = assertHashString(leaf, 'leaf');
  for (const [i, p] of (path ?? []).entries()) {
    const sib = assertHashString(p?.hash, `path[${i}].hash`);
    if (p.side === 'self') node = concatHash(node, node);
    else if (p.side === 'right') node = concatHash(node, sib);
    else if (p.side === 'left') node = concatHash(sib, node);
    else throw new TypeError(`path[${i}].side 非法: ${String(p.side)}`);
  }
  return node;
}

/** 目标条目的 proof（比对对象是同批批末条存的滚动根）。 */
function buildProof(entries, seq) {
  const target = entries.find((e) => e.seq === seq);
  if (!target) throw new Error(`seq=${seq} 不在链上`);
  const { batchIndex, leafIndex } = batchOf(seq);
  const batches = groupBatches(entries);
  const current = batches.find((b) => b.batchIndex === batchIndex);
  if (!current) throw new Error(`批 ${batchIndex} 不存在`);
  const prior = batches.filter((b) => b.batchIndex < batchIndex);
  const priorBatchRoots = prior.map((b) => ({ batchIndex: b.batchIndex, batchRoot: computeBatchRoot(b.leaves) }));
  const batchRoot = computeBatchRoot(current.leaves);
  return {
    version: 1,
    seq: target.seq,
    contractId: target.contractId,
    entryHash: target.chain?.entryHash,
    // 独立重算，不抄文件
    recomputedEntryHash: computeEntryHash(target),
    batchIndex,
    batchLeafCount: current.leaves.length,
    leafIndex,
    path: buildBatchPath(current.leaves, leafIndex),
    priorBatchRoots,
    batchRoot,
    merkleRoot: computeRollupRoot([...priorBatchRoots.map((r) => r.batchRoot), batchRoot]),
    boundarySeq: current.boundarySeq,
    boundaryMerkleRoot: current.boundary.chain?.merkleRoot ?? null,
    anchor: target.anchorStatus === 'ANCHORED' ? { anchorSeq: target.anchorSeq ?? null } : null,
  };
}

/** proof 自校验（校验器侧独立实现：path 复原批根 + roll-up 重放）。 */
function verifyProofLocally(proof) {
  const fail = (reason) => ({ ok: false, reason });
  if (!proof || typeof proof !== 'object') return fail('PROOF_MALFORMED');
  if (proof.recomputedEntryHash !== proof.entryHash) return fail('ENTRY_HASH_MISMATCH');
  let rebuilt;
  try {
    rebuilt = verifyBatchPath(proof.entryHash, proof.path);
  } catch (err) {
    return fail(`PATH_ERROR: ${err.message}`);
  }
  if (rebuilt !== proof.batchRoot) return fail('BATCH_ROOT_MISMATCH');
  if (proof.priorBatchRoots.length !== proof.batchIndex - 1) return fail('PRIOR_ROOTS_COUNT');
  const rollup = computeRollupRoot([...proof.priorBatchRoots.map((r) => r.batchRoot), proof.batchRoot]);
  if (rollup !== proof.merkleRoot) return fail('ROLLUP_REPLAY_MISMATCH');
  if (typeof proof.boundaryMerkleRoot === 'string' && proof.boundaryMerkleRoot !== proof.merkleRoot) {
    return fail('BATCH_BOUNDARY_DRIFT');
  }
  return { ok: true, reason: null, batchRoot: rebuilt, rollupRoot: rollup };
}
// ── 锚点文件（§4.4.1）─────────────────────────────────────────────────────

/**
 * 解析锚点 markdown 表格。
 *
 * 列序（§4.4.1 表头纪律）：
 *   锚定时间(UTC) | Ledger Seq | Head Entry Hash | Rollup Root | Entry Count | Prev Anchor Commit
 *
 * ⚠️ 最后一列是**上一条锚点行的引入 commit**，不是本行的 —— 一个 commit 的
 * SHA 不可能出现在它自己的内容里（v1.2 勘误 #6）。本行的 commit 由 --anchors
 * 用 git 历史反查。首行该列固定为字面量 GENESIS。
 */
function parseAnchorRows(text) {
  const rows = [];
  let sawHeader = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length !== 6) {
      throw new Error(`ANCHOR_ROW_SHAPE: 期望 6 列，实为 ${cells.length} 列：${t}`);
    }
    if (/^锚定时间/.test(cells[0])) { sawHeader = true; continue; }
    if (/^[-\s:|]+$/.test(t.replace(/\|/g, ''))) continue; // 分隔行
    if (!sawHeader) throw new Error('ANCHOR_ROW_SHAPE: 表头之前出现数据行');
    const [anchoredAt, seqStr, headEntryHash, rollupRoot, countStr, prevCommit] = cells;
    const seq = Number(seqStr);
    const count = Number(countStr);
    if (!Number.isInteger(seq) || seq < 1) throw new Error(`ANCHOR_ROW_SHAPE: Ledger Seq 非法 "${seqStr}"`);
    if (!Number.isInteger(count) || count < 0) throw new Error(`ANCHOR_ROW_SHAPE: Entry Count 非法 "${countStr}"`);
    // 摘要串的格式也要归到 ANCHOR_ROW_SHAPE：形状非法是「文件读不了」，
    // 不是「校验不通过」—— 混成一类会让运维以为链被改了（exit 2 vs exit 1）。
    for (const [col, value] of [['Head Entry Hash', headEntryHash], ['Rollup Root', rollupRoot]]) {
      if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
        throw new Error(`ANCHOR_ROW_SHAPE: ${col} 应为 sha256:<64 hex>，收到 "${value}"`);
      }
    }
    if (!/^(GENESIS|[0-9a-f]{40})$/.test(prevCommit)) {
      throw new Error(`ANCHOR_ROW_SHAPE: Prev Anchor Commit 应为 GENESIS 或 40 位 SHA，收到 "${prevCommit}"`);
    }
    rows.push({ anchoredAt, seq, headEntryHash, rollupRoot, entryCount: count, prevCommit });
  }
  return rows;
}

function readAnchorFile(path) {
  if (!existsSync(path)) throw new Error(`ANCHOR_FILE_MISSING: ${path}`);
  const text = readFileSync(path, 'utf8');
  return { text, rows: parseAnchorRows(text) };
}

// ── git 取证（只读命令，绝不写任何东西）──────────────────────────────────

function git(repoDir, args) {
  const r = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').trim();
    return { ok: false, code: r.status ?? -1, error: msg || `git ${args.join(' ')} 退出码 ${r.status}` };
  }
  return { ok: true, out: r.stdout };
}

/** 逐 commit 提取锚点文件内容：{ commit, introducedCommit?, rows }。 */
function replayAnchorHistory(repoDir, relFile) {
  const log = git(repoDir, ['log', '--reverse', '--format=%H%x09%ct', '--follow', '--', relFile]);
  if (!log.ok) return { ok: false, error: log.error };
  const history = [];
  for (const line of log.out.split('\n').filter(Boolean)) {
    const [commit, commitTs] = line.split('\t');
    const show = git(repoDir, ['show', `${commit}:${relFile}`]);
    if (!show.ok) return { ok: false, error: show.error };
    let rows;
    try {
      rows = parseAnchorRows(show.out);
    } catch (err) {
      return { ok: false, error: `commit ${commit.slice(0, 8)} 里的锚点文件解析失败：${err.message}` };
    }
    history.push({ commit, commitTs: Number(commitTs), rows });
  }
  return { ok: true, history };
}

/** 该 commit 是否已被上游分支包含（有则说明远端也有一份）。 */
function commitOnRemote(repoDir, commit) {
  const up = git(repoDir, ['rev-parse', '--abbrev-ref', '--symbolic', '@{upstream}']);
  if (!up.ok) return { state: 'no-upstream' };
  const ref = up.out.trim();
  const has = git(repoDir, ['merge-base', '--is-ancestor', commit, ref]);
  if (!has.ok) return { state: 'unverified', ref };
  return { state: 'present', ref };
}

// ── --anchor / --anchors ──────────────────────────────────────────────────

/**
 * 校验「锚点文件工作区最新行」与链 head 的关系。
 *
 * ⚠️ v1.2 勘误 #7 的判据：**从 head 沿 parentHash 回溯能否命中上一条锚点的
 * entryHash**，而不是「head 的 parentHash == 上锚的 head hash」—— 后者只在
 * 本周恰好新增 1 条时成立，新增 0 条或多条都会误报（误报每周都发生 ⇒ 门禁
 * 第一天就被人忽略）。
 */
function checkAnchorAgainstChain(anchor, verdict, opts) {
  const findings = [];
  const notes = [];
  if (anchor.rows.length === 0) {
    findings.push({ level: 'fail', code: 'ANCHOR_NO_ROWS', detail: '锚点文件一行都没有 ⇒ 从未锚定（§4.6 #4 未达成）' });
    return { findings, notes, trust: null };
  }
  const latest = anchor.rows[anchor.rows.length - 1];
  const head = verdict.head;

  if (!head) {
    notes.push({ level: 'note', code: 'ANCHOR_WITHOUT_CHAIN', detail: '链为空但锚点有行 ⇒ 锚点声称的条目不存在' });
    findings.push({ level: 'fail', code: 'ANCHOR_ORPHAN', detail: `最新锚点 seq=${latest.seq}，链里 0 条` });
    return { findings, notes, trust: null };
  }

  // 单调性：锚点 seq 不得大于链 max(seq)
  if (latest.seq > verdict.maxSeq) {
    findings.push({
      level: 'fail', code: 'ANCHOR_AHEAD_OF_CHAIN',
      detail: `锚点 seq=${latest.seq} > 链 max(seq)=${verdict.maxSeq} ⇒ 锚点行被伪造或链被回滚`,
    });
  }
  // 锚点声称的那一条必须仍在链上且哈希相符。
  // ⚠️ 按 **latest.seq 定位**，不是按 head 定位：条目永不删除，所以锚定时的
  // 那一条现在仍然查得到。v1.0 的判据是「锚点 head == 链 head」，于是周中
  // 新增几条就报一次断链（§4.6 #4b 要求不得误报）。回溯 parentHash 也不必要
  // —— 前缀完整性已经由 verifyChain 在全链上验过了。
  const bySeq = new Map(verdict.entries.map((e) => [e.seq, e]));
  const claimed = bySeq.get(latest.seq);
  if (!claimed) {
    // 上面的 ANCHOR_AHEAD_OF_CHAIN 已经说明了原因，不重复报
  } else if (claimed.chain?.entryHash !== latest.headEntryHash) {
    findings.push({
      level: 'fail', code: 'ANCHOR_MISMATCH',
      expected: latest.headEntryHash, actual: claimed.chain?.entryHash,
      detail: `锚点记录的 seq=${latest.seq} 那条 entryHash 与链上的不符 ⇒ ledger 在锚定后被改写`,
    });
  } else if (claimed.chain?.merkleRoot !== latest.rollupRoot) {
    findings.push({
      level: 'fail', code: 'ANCHOR_ROLLUP_MISMATCH',
      expected: latest.rollupRoot, actual: claimed.chain?.merkleRoot,
      detail: '锚点记录的 roll-up 根与链重放不符',
    });
  } else if (latest.seq < head.seq) {
    notes.push({
      level: 'note', code: 'ANCHOR_PREFIX_OK',
      detail: `锚点 seq=${latest.seq} 在链上相符，其后 ${head.seq - latest.seq} 条尚未锚定（PENDING）`,
    });
  } else {
    notes.push({ level: 'note', code: 'ANCHOR_UP_TO_DATE', detail: `锚点 seq=${latest.seq} 即链 head，无未锚定条目` });
  }

  // Entry Count vs Seq：二者相等说明没删过条目
  if (latest.seq > latest.entryCount) {
    notes.push({ level: 'note', code: 'ANCHOR_GAP_VISIBLE', detail: `锚点 Seq(${latest.seq}) > Count(${latest.entryCount}) ⇒ 链上有过空洞` });
  }

  // 信任层级（§4.4.5）：报告口径由这里决定，不由写报告的人决定
  const lastCommit = opts.lastAnchorCommit ?? null;
  if (!lastCommit) {
    notes.push({ level: 'note', code: 'ANCHOR_REMOTE_UNVERIFIED', detail: '未取到最新锚点行的引入 commit（--anchors 才会反查）⇒ 至多 L1' });
    return { findings, notes, trust: 'L1' };
  }
  const remote = commitOnRemote(REPO_ROOT, lastCommit);
  if (remote.state === 'present') {
    notes.push({ level: 'note', code: 'ANCHOR_REMOTE_VERIFIED', detail: `commit ${lastCommit.slice(0, 8)} 已包含于 ${remote.ref} ⇒ L2` });
    return { findings, notes, trust: 'L2' };
  }
  notes.push({
    level: 'note', code: 'ANCHOR_REMOTE_UNVERIFIED',
    detail: `commit ${lastCommit.slice(0, 8)} 不在上游分支（${remote.state === 'no-upstream' ? '本仓无 upstream' : `未包含于 ${remote.ref}`}）`
      + ' ⇒ 本地 git 可被同权限重写，对外不得宣称「已外部锚定」（§4.4.5）',
  });
  return { findings, notes, trust: 'L1' };
}

/**
 * 锚点文件的**全部 git 历史**重放（§4.4.3 独立性纪律 #3）。
 *
 * ⛔ 只读工作区文件是不够的：改完锚点文件再 commit 一次就完全隐身，
 * `git blame` 也只会告诉你「最后谁改的」。逐 commit 验三件事：
 *   ① 行序列单调（没被插入 / 删除 / 重排）
 *   ② 每行的 head entryHash 与 ledger 重放一致（条目永不删除，故今天仍能比对）
 *   ③ commit 链本身连续（每行的 Prev Anchor Commit == 上一行的引入 commit）
 */
function checkAnchorHistory(repoDir, relFile, verdict) {
  const findings = [];
  const notes = [];
  const replay = replayAnchorHistory(repoDir, relFile);
  if (!replay.ok) {
    findings.push({ level: 'fail', code: 'ANCHOR_GIT_UNAVAILABLE', detail: replay.error });
    return { findings, notes, commits: [] };
  }
  if (replay.history.length === 0) {
    findings.push({ level: 'fail', code: 'ANCHOR_NOT_COMMITTED', detail: `${relFile} 在 git 历史里没有一次提交` });
    return { findings, notes, commits: [] };
  }

  const bySeq = new Map(verdict.entries.map((e) => [e.seq, e]));
  let prevRowCount = 0;
  let prevCommit = null;
  for (const h of replay.history) {
    const rowCount = h.rows.length;
    // ① 单调：行数只能 +1（锚点是追加式）。0 → 0 允许（首次提交就是空表）。
    if (rowCount < prevRowCount) {
      findings.push({
        level: 'fail', code: 'ANCHOR_ROWS_SHRANK',
        detail: `commit ${h.commit.slice(0, 8)} 的行数(${rowCount}) 少于上一 commit(${prevRowCount}) ⇒ 锚点行被删除`,
      });
    } else if (rowCount > prevRowCount + 1) {
      findings.push({
        level: 'fail', code: 'ANCHOR_ROWS_JUMPED',
        detail: `commit ${h.commit.slice(0, 8)} 一次加了 ${rowCount - prevRowCount} 行 ⇒ 正常锚定每次只追加 1 行（多行=重写历史或补塞）`,
      });
    }
    const newest = h.rows[rowCount - 1];
    if (newest) {
      // ② 行内容与链一致（只比**新增的那一行**；旧行由 ① 的单调性保证未被改动）
      if (rowCount > prevRowCount) {
        const entry = bySeq.get(newest.seq);
        if (!entry) {
          findings.push({
            level: 'fail', code: 'ANCHOR_ROW_UNREPLAYABLE',
            detail: `commit ${h.commit.slice(0, 8)} 新增行声称 seq=${newest.seq}，链上没有 ⇒ 伪造锚点或条目被删`,
          });
        } else if (entry.chain?.entryHash !== newest.headEntryHash) {
          findings.push({
            level: 'fail', code: 'ANCHOR_MISMATCH',
            expected: newest.headEntryHash, actual: entry.chain?.entryHash,
            detail: `commit ${h.commit.slice(0, 8)} 的 seq=${newest.seq} 与链重算不符 ⇒ 该锚点行伪造，或 ledger 锚定后被改写`,
          });
        }
        // ③ commit 链连续
        if (prevCommit === null) {
          if (newest.prevCommit !== 'GENESIS') {
            findings.push({
              level: 'fail', code: 'ANCHOR_GENESIS_ROW',
              detail: `首行的 Prev Anchor Commit 应为 GENESIS，收到 ${newest.prevCommit}`,
            });
          }
        } else if (newest.prevCommit !== prevCommit) {
          findings.push({
            level: 'fail', code: 'ANCHOR_COMMIT_CHAIN_BROKEN',
            expected: prevCommit, actual: newest.prevCommit,
            detail: `commit ${h.commit.slice(0, 8)} 声称的上一锚点 commit 与 git 历史不符 ⇒ 中间有 commit 被插入或删除`,
          });
        }
      }
      // 已提交的旧行必须与它**首次出现时**那份逐字段一致（防「改了历史行再 commit」）。
      const sameRow = (a, b) => a && b && a.anchoredAt === b.anchoredAt && a.seq === b.seq
        && a.headEntryHash === b.headEntryHash && a.rollupRoot === b.rollupRoot
        && a.entryCount === b.entryCount && a.prevCommit === b.prevCommit;
      for (let i = 0; i < Math.min(prevRowCount, rowCount); i++) {
        const firstSeen = replay.history.find((x) => x.rows.length > i);
        if (!sameRow(firstSeen?.rows[i], h.rows[i])) {
          findings.push({
            level: 'fail', code: 'ANCHOR_ROW_REWRITTEN',
            detail: `第 ${i + 1} 行在 commit ${h.commit.slice(0, 8)} 与首次引入时不一致 ⇒ 锚点历史被重写`,
          });
        }
      }
    }
    prevRowCount = rowCount;
    if (rowCount > 0) prevCommit = h.commit;
  }
  const last = replay.history[replay.history.length - 1];
  notes.push({ level: 'note', code: 'ANCHOR_HISTORY', detail: `${replay.history.length} 次提交，最终 ${last.rows.length} 行，链尾 commit ${last.commit.slice(0, 8)}` });
  return { findings, notes, commits: replay.history.map((h) => h.commit), lastCommit: last.commit };
}
// ── 输出 ──────────────────────────────────────────────────────────────────

const ICON = { ok: '✓', note: '~', fail: '✗' };

function report(lines, opts) {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(lines, null, 2)}\n`);
    return;
  }
  for (const l of lines) process.stdout.write(`${l}\n`);
}

function shapeFailures(failures) {
  return failures.map((f) => {
    const parts = [`${ICON.fail} ${f.code}${f.seq ? ` at seq=${f.seq}` : ''}`];
    if (f.expected) parts.push(`    Expected (ledger 存值): ${f.expected}`);
    if (f.actual) parts.push(`    Actual   (独立重算): ${f.actual}`);
    parts.push(`    → ${f.detail}`);
    return parts.join('\n');
  });
}

// ── main ──────────────────────────────────────────────────────────────────

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.mode === 'help') {
    process.stdout.write(
      '用法：node bin/verify-ledger-chain.mjs [--full | --entry <seq|contractId> | --anchor | --anchors | --since <日期>] [--ledger <路径>] [--anchor-file <路径>] [--json]\n'
      + '退出码：0 = 通过 / 1 = 校验失败 / 2 = 脚本自身出错\n',
    );
    return 0;
  }

  const { entries, tableAbsent } = readLedger(opts.ledger);
  const sinceTs = opts.since ? Date.parse(opts.since) : null;
  const verdict = verifyChain(entries, { sinceTs });
  const lines = [];
  const push = (icon, text) => lines.push(`${icon} ${text}`);

  if (tableAbsent) {
    push(ICON.note, `evolution_ledger 表在文件里还不存在（宿主 descriptor 未加表 / 老文件）：${opts.ledger}`);
  }
  const gapCount = verdict.failures.filter((f) => f.code === 'SEQ_GAP').length;
  push(gapCount ? ICON.fail : ICON.ok,
    `Chain integrity: ${verdict.entryCount} entries, seq 1-${verdict.maxSeq}`
    + (gapCount ? `, ${gapCount} 处空洞` : ', no gap'));
  push(verdict.failures.some((f) => f.code.startsWith('MERKLE') || f.code.startsWith('BATCH')) ? ICON.fail : ICON.ok,
    `Merkle: ${verdict.batches.length} batch(es), roll-up root ${verdict.rollup.slice(0, 19)}…`);
  const anchored = entries.filter((e) => e.anchorStatus === 'ANCHORED').length;
  const pending = entries.filter((e) => e.anchorStatus !== 'ANCHORED').length;
  push(ICON.ok, `Anchor status: ${anchored} ANCHORED, ${pending} PENDING`);

  let exitCode = verdict.failures.length > 0 ? 1 : 0;
  let proofJson = null;

  if (opts.mode === 'entry') {
    const asNum = Number(opts.entry);
    const target = Number.isInteger(asNum) && asNum >= 1
      ? entries.find((e) => e.seq === asNum)
      : entries.find((e) => e.contractId === opts.entry);
    if (!target) {
      push(ICON.fail, `--entry ${opts.entry}: 链上没有这一条（seq 或 contractId）`);
      exitCode = 1;
    } else {
      const proof = buildProof(entries, target.seq);
      const res = verifyProofLocally(proof);
      push(res.ok ? ICON.ok : ICON.fail,
        `Proof seq=${target.seq}: ${res.ok ? 'verified' : `FAILED (${res.reason})`}`
        + ` — path ${proof.path.length} 层，前缀批根 ${proof.priorBatchRoots.length} 个`);
      // proof 本体留到最后单独一行：前面的提示行里不带 `{`，
      // 于是 `--entry` 的输出可以直接 tail 出一段可 JSON.parse 的文本给人贴到工单里。
      proofJson = JSON.stringify(proof, null, 2);
      if (!res.ok) exitCode = 1;
    }
  }

  if (opts.mode === 'anchor' || opts.mode === 'anchors') {
    const anchor = readAnchorFile(opts.anchorFile);
    push(anchor.rows.length >= 3 ? ICON.ok : ICON.note,
      `Anchor file: ${anchor.rows.length} row(s) in ${opts.anchorFile}`);
    let lastAnchorCommit = null;
    if (opts.mode === 'anchors') {
      const rel = opts.anchorFile.startsWith(REPO_ROOT)
        ? opts.anchorFile.slice(REPO_ROOT.length + 1).split(/[\\/]+/).join('/')
        : opts.anchorFile;
      const hist = checkAnchorHistory(REPO_ROOT, rel, verdict);
      for (const f of hist.findings) push(ICON.fail, `${f.code}: ${f.detail}${f.expected ? `\n    Expected: ${f.expected}\n    Actual  : ${f.actual}` : ''}`);
      for (const n of hist.notes) push(ICON.note, `${n.code}: ${n.detail}`);
      if (hist.findings.length > 0) exitCode = 1;
      lastAnchorCommit = hist.lastCommit ?? null;
    } else {
      push(ICON.note, 'ANCHOR_HISTORY_SKIPPED: 只比对了工作区最新行；逐 commit 重放请用 --anchors（§4.4.3 #3）');
    }
    const chk = checkAnchorAgainstChain(anchor, verdict, { lastAnchorCommit });
    for (const f of chk.findings) push(ICON.fail, `${f.code}: ${f.detail}`);
    for (const n of chk.notes) push(ICON.note, `${n.code}: ${n.detail}`);
    if (chk.findings.length > 0) exitCode = 1;
    if (chk.trust) push(ICON.note, `Trust level: ${chk.trust}${chk.trust === 'L1' ? '（本地 git，远端未比对 ⇒ 对外不得宣称「已外部锚定」，§4.4.5）' : ''}`);
  }

  for (const f of verdict.failures) lines.push(shapeFailures([f])[0]);
  for (const n of verdict.notes) push(ICON.note, `${n.code}: ${n.detail}`);

  // 链内校验的固有极限（是设计，不是漏洞）：**删尾部**不留痕迹 —— 剩下条目的
  // 存量仍是各自追加时的前缀值，自洽；后面没有更新的条目来印证旧批根。
  // 抓截断只能靠外部计数，即 git 锚点行的 Entry Count + Head Entry Hash。
  // mode=anchor/anchors 已经在比对了，这里只标出纯链模式的盲区。
  if (verdict.head && opts.mode !== 'anchor' && opts.mode !== 'anchors') {
    push(ICON.note, `TAIL_TRUNCATION_UNCHECKABLE: 尾部截断链内不可察觉（当前 head=seq ${verdict.head.seq}）`
      + ' ⇒ 用 --anchor / --anchors 比对 git 锚点的 Entry Count 与 Head Entry Hash（§4.4.5）');
  }

  if (exitCode === 1) {
    lines.push('→ 处置：标记、告警、冻结、人工取证。⛔ 本脚本不修复、不重写任何条目（§4.4.4 核心纪律）。');
  }
  if (proofJson) lines.push(proofJson);

  report(lines, opts);
  return exitCode;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ error: msg, mode: 'error' }, null, 2)}\n`);
  } else {
    process.stderr.write(`✗ 校验器自身出错（退出码 2，与「校验不通过」区分）：${msg}\n`);
  }
  process.exitCode = 2;
}
