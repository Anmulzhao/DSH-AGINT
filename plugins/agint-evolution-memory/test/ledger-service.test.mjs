/**
 * agint-evolution-memory: ledger service 写入协议回归（§4.3.4 / §4.6 #6b）
 *
 * 覆盖的是**写入侧**纪律，而不是哈希数学（哈希在
 * test/ledger-canonical.test.mjs + test/ledger-vectors.test.mjs）：
 *   纪律 1 单写者        → 静态断言：lib/ledger.js 不引用 logBuffer / EvolutionLogBuffer
 *   纪律 2 逐条同步落盘  → 一条一次 put，且 put 完成才算成功
 *   纪律 3 不静默降级    → put 失败即抛 + 计数可见，表内不留半成品
 *   纪律 4 就绪前不吞    → getTable 抛错直接冒泡（不返回「成功但没写」）
 *   纪律 5 幂等          → 同 contractId 重放返回既有条目，不新增
 *   纪律 6 一 contractId 一条 → seq 单调 +1，绝不复用
 *   §4.3.2 CAS           → 前驱摘要变化 / seq 被占 ⇒ 拒写
 *   §4.4.4 空洞          → 拒绝向未知前驱追加，⛔ 不填洞
 *   勘误 #8              → 锚定回写不改 entryHash
 *
 * 表句柄形状对齐宿主真实 API（dsh-storage-domain/lib/index.js:229-260 的
 * KvTableImpl）：`entries()` 返回 **[key, value] 迭代器**、`get` 返回存活对象、
 * `size` 是 getter、**没有 has()**。mock 只要偏离这个形状，测试就会失真
 * （继承教训：`.entries().length` 恒为 undefined 把 9 个插件的容量守门全废掉）。
 *
 * Run: node --test plugins/agint-evolution-memory/test/ledger-service.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLedgerService } from '../lib/ledger.js';
import { GENESIS_PARENT_HASH } from '../lib/canonical.js';
import { computeEntryHash, verifyProof } from '../lib/ledger-hash.js';

const here = dirname(fileURLToPath(import.meta.url));

const FIXED_NOW = () => '2026-10-02T08:00:00.000Z';

/** 忠实仿宿主表句柄的内存表，并记录写次数（测「逐条同步」）。 */
function makeTable() {
  const records = new Map();
  const writes = [];
  return {
    records,
    writes,
    entries: () => [...records.entries()][Symbol.iterator](),
    keys: () => [...records.keys()][Symbol.iterator](),
    get: (k) => records.get(k),
    get size() { return records.size; },
    async put(k, v) {
      writes.push(k);
      records.set(k, v);
      return true;
    },
  };
}

/**
 * 造 service。`opts.table` 不给就用一张新空表；`opts.getTable` 可整体接管
 * （测 domain 未就绪 / put 失败等异常路径）。
 */
function makeLedger(opts = {}) {
  const table = opts.table ?? makeTable();
  const warns = [];
  const bumps = [];
  const svc = createLedgerService({
    getTable: opts.getTable ?? (async () => table),
    now: opts.now ?? FIXED_NOW,
    warn: (msg, extra) => warns.push([msg, extra]),
    bump: (key, n = 1) => bumps.push([key, n]),
  });
  return { svc, table, warns, bumps };
}

let counter = 0;
const nextContractId = () => `EVO-T${++counter}`;

function summary(over = {}) {
  return {
    mutationType: 'PROMPT_MUTATION',
    changedPlugins: ['agint-mutator'],
    targetMetric: 'aesthetic_pass_rate',
    hypothesisDigest: '提高保守阈值，减少误发布',
    predictedDelta: 0.03,
    actualDelta: 0.028,
    predictionQuality: 0.91,
    predictionSource: 'KNOWLEDGE_BASE',
    decision: 'AUTO_DEPLOY',
    ...over,
  };
}

function entryInput(over = {}) {
  return {
    contractId: nextContractId(),
    generation: 'GEN-003',
    summary: summary(),
    references: { abTestId: 'AB-1' },
    ...over,
  };
}

// ── 链的基本形状 ──────────────────────────────────────────────────────────

test('seq=1：parentHash 用创世常量，entryHash 可从存储重算', async () => {
  const { svc, table } = makeLedger();
  const { entry, idempotent } = await svc.appendEntry(entryInput());
  assert.equal(idempotent, false);
  assert.equal(entry.seq, 1);
  assert.equal(entry.chain.parentHash, GENESIS_PARENT_HASH);
  assert.equal(table.size, 1);
  assert.equal(table.get('1'), entry, 'put 后表内即该条目');
  // 落盘态重算必须等于存的值（写入侧「先归一再算 hash」的顺序自证）
  assert.equal(computeEntryHash(table.get('1')), entry.chain.entryHash);
});

test('seq 单调 +1 且 parentHash 逐条接续（一 contractId 一条，纪律 6）', async () => {
  const { svc } = makeLedger();
  const a = await svc.appendEntry(entryInput());
  const b = await svc.appendEntry(entryInput());
  const c = await svc.appendEntry(entryInput());
  assert.deepEqual([a.entry.seq, b.entry.seq, c.entry.seq], [1, 2, 3]);
  assert.equal(b.entry.chain.parentHash, a.entry.chain.entryHash);
  assert.equal(c.entry.chain.parentHash, b.entry.chain.entryHash);
  assert.equal(b.idempotent, false);
});

test('REJECT / ABSTAIN 同样入链（Ledger 记的是「发生过什么」）', async () => {
  const { svc } = makeLedger();
  const r = await svc.appendEntry(entryInput({ summary: summary({ decision: 'REJECT' }) }));
  const a = await svc.appendEntry(entryInput({ summary: summary({ decision: 'ABSTAIN' }) }));
  assert.equal(r.entry.summary.decision, 'REJECT');
  assert.equal(a.entry.summary.decision, 'ABSTAIN');
});

test('跨批写入：批满后新批重新起叶，merkleRoot 走 roll-up 且 proof 可自校验', async () => {
  const { svc } = makeLedger();
  const appended = [];
  for (let i = 0; i < 9; i++) appended.push((await svc.appendEntry(entryInput())).entry);
  // 第 8 条与第 9 条不同批：批根与滚动根都必须换代
  assert.notEqual(appended[7].chain.batchRoot, appended[8].chain.batchRoot);
  assert.notEqual(appended[7].chain.merkleRoot, appended[8].chain.merkleRoot);
  for (const e of appended) {
    const proof = await svc.proofFor(e.seq);
    // 比对对象是**批末条**存的滚动根（批的最终值），不是这条自己在入链那一刻
    // 存的部分根 —— 语义见 ledger-hash.js buildProof 的注释。
    const boundary = proof.batchLeafCount === 8
      ? appended[Math.min(8, appended.length) * proof.batchIndex - 1]
      : appended[appended.length - 1];
    assert.equal(proof.boundaryMerkleRoot, boundary.chain.merkleRoot, `seq=${e.seq} 批末条根`);
    const res = verifyProof(proof, { expectedMerkleRoot: boundary.chain.merkleRoot });
    assert.ok(res.ok, `seq=${e.seq} proof 自校验失败: ${res.reason}`);
  }
});

// ── 纪律 5：幂等 ──────────────────────────────────────────────────────────

test('同 contractId 重放 ⇒ 返回既有条目、不新增、head 不变（纪律 5）', async () => {
  const { svc, table } = makeLedger();
  const input = entryInput({ contractId: 'EVO-IDEM-1' });
  const first = await svc.appendEntry(input);
  const before = table.writes.length;
  const replay = await svc.appendEntry(input);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.entry.chain.entryHash, first.entry.chain.entryHash);
  assert.equal(table.size, 1, '重放不得新增条目（否则制造合法分叉链）');
  assert.equal(table.writes.length, before, '重放不得再写盘');
});

// ── §4.3.2 落盘前复核 ─────────────────────────────────────────────────────
//
// 诚实标注：进程内的并发追加由 service 自己的 appendLock 串行化关闭，
// 而快照与复核之间没有 await，所以**单实例路径上这两个分支不会自然触发**。
// 它们防的是「同表多实例 / 绕过 service 的直写」这类违例（纪律 1），
// 因此这里用**注入式 mock**（让复核读到漂移的值）来验证守卫逻辑本身。

test('复核发现前驱摘要漂移 ⇒ 拒写、不落新行（抓绕过 service 的改写）', async () => {
  const table = makeTable();
  const { svc, bumps } = makeLedger({ table });
  await svc.appendEntry(entryInput());
  const realGet = table.get;
  let headReads = 0;
  table.get = (k) => {
    const v = realGet(k);
    if (k === '1' && ++headReads > 1) {
      // 第二次读同一 key（= service 的落盘前复核）看到被改写的前驱摘要
      return { ...v, chain: { ...v.chain, entryHash: `sha256:${'f'.repeat(64)}` } };
    }
    return v;
  };
  await assert.rejects(() => svc.appendEntry(entryInput()), /LEDGER_CAS_CONFLICT/);
  assert.equal(table.size, 1, '复核不过就不许落盘');
  assert.ok(bumps.some(([k]) => k === 'ledger.append.casConflict'));
});

test('复核发现目标槽位已被占 ⇒ 拒写（抢跑的直写）', async () => {
  const table = makeTable();
  const { svc } = makeLedger({ table });
  await svc.appendEntry(entryInput());
  const realGet = table.get;
  table.get = (k) => (k === '2' ? { seq: 2, chain: { entryHash: `sha256:${'e'.repeat(64)}` } } : realGet(k));
  await assert.rejects(() => svc.appendEntry(entryInput()), /已被占用/);
  assert.equal(table.size, 1);
});

test('并发双写经 appendLock 串行化：两条都进链且接续正确', async () => {
  const { svc, table } = makeLedger();
  const [a, b] = await Promise.all([
    svc.appendEntry(entryInput({ contractId: 'EVO-CONC-1' })),
    svc.appendEntry(entryInput({ contractId: 'EVO-CONC-2' })),
  ]);
  assert.equal(table.size, 2, '无锁时两个调用会算出同一个 nextSeq，后者覆盖前者');
  assert.deepEqual([a.entry.seq, b.entry.seq], [1, 2]);
  assert.equal(b.entry.chain.parentHash, a.entry.chain.entryHash);
});

test('并发重放同一 contractId ⇒ 只落一条（幂等查在锁内）', async () => {
  const { svc, table } = makeLedger();
  const input = entryInput({ contractId: 'EVO-CONC-3' });
  const [a, b] = await Promise.all([svc.appendEntry(input), svc.appendEntry(input)]);
  assert.equal(table.size, 1);
  assert.equal(a.entry.chain.entryHash, b.entry.chain.entryHash);
  assert.notEqual(a.idempotent, b.idempotent, '一个是新写、一个是幂等命中');
});

test('空洞：表内缺前驱 ⇒ LEDGER_GAP 拒写，⛔ 不填洞不猜前驱', async () => {
  const table = makeTable();
  const { svc } = makeLedger({ table });
  await svc.appendEntry(entryInput());
  await svc.appendEntry(entryInput());
  await svc.appendEntry(entryInput());
  // 删掉中间那条（外部篡改/写丢失的形态）
  table.records.delete('2');
  await assert.rejects(() => svc.appendEntry(entryInput()), /LEDGER_GAP/);
  assert.equal(table.size, 2, '⛔ 禁止补占位条目填洞（§4.4.4）');
});

// ── 纪律 2/3/4：同步、不降级、就绪前不吞 ────────────────────────────────

test('逐条同步：N 条 = N 次 put，且每条写完才返回（纪律 2）', async () => {
  const { svc, table } = makeLedger();
  for (let i = 0; i < 5; i++) await svc.appendEntry(entryInput());
  assert.deepEqual(table.writes, ['1', '2', '3', '4', '5']);
});

test('domain 未就绪（getTable 抛错）⇒ 直接冒泡，不返回成功（纪律 4）', async () => {
  const { svc } = makeLedger({ getTable: async () => { throw new Error('domain unavailable'); } });
  await assert.rejects(() => svc.appendEntry(entryInput()), /domain unavailable/);
});

test('put 失败 ⇒ 抛错 + 计数可见 + 表内无该条目，⛔ 不降级写别的表（纪律 3）', async () => {
  const table = makeTable();
  table.put = async () => { throw new Error('EACCES: rename denied'); };
  const { svc, bumps, warns } = makeLedger({ table });
  await assert.rejects(() => svc.appendEntry(entryInput()), /rename denied/);
  assert.ok(bumps.some(([k]) => k === 'ledger.append.failed'), '失败必须计数');
  assert.ok(warns.some(([m]) => /追加失败/.test(m)), '失败必须告警');
  assert.equal(table.size, 0, '没有 buffer-lost 式兜底，也没有半个条目进链');
});

test('静态纪律：lib/ledger.js 不引用 logBuffer / EvolutionLogBuffer（§4.6 #6b）', () => {
  const src = readFileSync(join(here, '..', 'lib', 'ledger.js'), 'utf8');
  // 头部注释里会提到 log-buffer 的名字（解释「为什么不用」），只看代码行
  const code = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /logBuffer|createLogBuffer|EvolutionLogBuffer|flushLogBuffer/);
  assert.doesNotMatch(code, /require\(|import\(/, '不动态绕过依赖边界');
});

test('时间戳非法（无毫秒 / 非 UTC / 假日期）⇒ 拒写（§4.3.1 ①）', async () => {
  const { svc, table } = makeLedger();
  for (const bad of [
    '2026-10-02T08:00:00Z',           // 缺毫秒
    '2026-10-02T08:00:00.000+08:00',  // 非 UTC
    '2026-10-02 08:00:00.000Z',       // 缺 T
    '2026-02-31T08:00:00.000Z',       // 不存在的日期
  ]) {
    await assert.rejects(() => svc.appendEntry(entryInput({ timestamp: bad })), undefined, bad);
  }
  assert.equal(table.size, 0);
});

test('summary 里出现非有限数字 ⇒ 抛错，不静默变 null（契约 5）', async () => {
  const { svc, table } = makeLedger();
  await assert.rejects(
    () => svc.appendEntry(entryInput({ summary: summary({ actualDelta: Number.NaN }) })),
    /非有限数字|expected/,
  );
  assert.equal(table.size, 0, '非法条目绝不进链');
});

test('未知字段被归一丢弃后仍自洽（先归一 → 再算 hash 的顺序自证）', async () => {
  const { svc, table } = makeLedger();
  const { entry } = await svc.appendEntry(entryInput({
    summary: { ...summary(), bogusField: 'should-be-dropped' },
  }));
  assert.equal(entry.summary.bogusField, undefined, 'zod 静默丢弃未知键');
  // 关键：hash 是在**丢弃之后**的形态上算的，所以重算必须相等。
  // 若顺序反了（拿含 bogusField 的输入算 hash），这一条断言会红。
  assert.equal(computeEntryHash(table.get(String(entry.seq))), entry.chain.entryHash);
});

// ── 勘误 #8：回写字段不参与哈希 ──────────────────────────────────────────

test('markAnchored 回写 anchorStatus 后 entryHash 不变（§4.4.2 步骤 6）', async () => {
  const { svc, table } = makeLedger();
  const a = await svc.appendEntry(entryInput());
  const b = await svc.appendEntry(entryInput());
  const before = { a: a.entry.chain.entryHash, b: b.entry.chain.entryHash };
  const res = await svc.markAnchored({ anchorSeq: 1, fromSeq: 1, toSeq: 2 });
  assert.deepEqual(res.anchored, [1, 2]);
  assert.equal(res.tampered.length, 0);
  assert.equal(table.get('1').anchorStatus, 'ANCHORED');
  assert.equal(table.get('2').anchorSeq, 1);
  assert.equal(table.get('1').chain.entryHash, before.a);
  assert.equal(table.get('2').chain.entryHash, before.b);
});

test('锚定发现条目已被改写 ⇒ 标 ANCHOR_MISMATCH + TAMPERED，不重写内容（纪律 9）', async () => {
  const { svc, table } = makeLedger();
  const a = await svc.appendEntry(entryInput());
  const original = { ...table.get('1') };
  table.get('1').summary.actualDelta = 0.99; // 事后篡改
  const res = await svc.markAnchored({ anchorSeq: 1, fromSeq: 1, toSeq: 1 });
  assert.deepEqual(res.tampered, [1]);
  const stored = table.get('1');
  assert.equal(stored.anchorStatus, 'ANCHOR_MISMATCH');
  assert.equal(stored.integrity, 'TAMPERED');
  assert.equal(stored.chain.entryHash, a.entry.chain.entryHash, '⛔ 不重算、不修复：保留原摘要作证据');
  assert.equal(stored.summary.actualDelta, 0.99, '读时不修：篡改内容原样留着供取证');
  assert.notEqual(computeEntryHash(stored), original.chain.entryHash);
});

test('markAnchored 遇到缺失 seq ⇒ 记入 missing，不造条目', async () => {
  const { svc } = makeLedger();
  await svc.appendEntry(entryInput());
  const res = await svc.markAnchored({ anchorSeq: 1, fromSeq: 1, toSeq: 3 });
  assert.deepEqual(res.anchored, [1]);
  assert.deepEqual(res.missing, [2, 3]);
});

// ── 插件接线（走真实 apply()，不是直接 new service）──────────────────────

/** 最小 ctx：storageDomain 提供 Map 支撑的表句柄（形状对齐宿主 KvTableImpl）。 */
function makeCtx() {
  const tables = new Map();
  const services = new Map();
  const handle = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    const records = tables.get(name);
    return {
      entries: () => [...records.entries()][Symbol.iterator](),
      keys: () => [...records.keys()][Symbol.iterator](),
      get: (k) => records.get(k),
      get size() { return records.size; },
      put: async (k, v) => { records.set(k, v); return true; },
    };
  };
  const ctx = {
    get: (k) => services.get(k),
    provide: (k, v) => services.set(k, v),
    effect: (fn) => { try { fn(); } catch { /* noop */ } return () => {}; },
    logger: { warn: () => {} },
    metrics: () => {},
    storageDomain: {
      open: async (specArg) => ({
        table: async (name) => {
          if (!Object.keys(specArg.tables).includes(name)) throw new Error(`未声明的表 ${name}`);
          return handle(name);
        },
        close: async () => {},
      }),
    },
  };
  return { ctx, tables };
}

test('apply() 后 evolution_ledger 已在 version 1 的域里注册，且 service 挂上 agint.evolution', async () => {
  const mod = await import('../lib/index.js');
  assert.equal(mod.spec.version, 1, '加表不得升 version（§4.6 #1b）');
  assert.ok(Object.keys(mod.spec.tables).includes('evolution_ledger'));

  const { ctx, tables } = makeCtx();
  await mod.apply(ctx);
  const svc = ctx.get('agint.evolution');
  assert.equal(typeof svc?.ledger?.append, 'function', 'ledger 命名空间必须经 service 暴露');

  const { entry } = await svc.ledger.append(entryInput());
  assert.equal(entry.seq, 1);
  assert.equal(tables.get('evolution_ledger').get('1').chain.entryHash, entry.chain.entryHash);
  const st = await svc.ledger.stats();
  assert.equal(st.entries, 1);
  // stats()（域级）也必须报出新表行数，否则「加表后既有表不变」无从在运行态观察
  const domainStats = await svc.stats();
  assert.equal(domainStats.evolution_ledger, 1);
  assert.equal(domainStats.evolution_log, 0);
});

// ── 统计与 head ───────────────────────────────────────────────────────────

test('stats：head 由 max(seq) 推导（无独立 head 指针，§4.3.2）', async () => {
  const { svc } = makeLedger();
  const empty = await svc.stats();
  assert.deepEqual([empty.entries, empty.headSeq, empty.headEntryHash], [0, null, null]);
  await svc.appendEntry(entryInput({ reconstructed: true, evidenceCompleteness: 'PARTIAL' }));
  const last = await svc.appendEntry(entryInput());
  const st = await svc.stats();
  assert.equal(st.entries, 2);
  assert.equal(st.headSeq, last.entry.seq);
  assert.equal(st.headEntryHash, last.entry.chain.entryHash);
  assert.equal(st.reconstructed, 1);
  assert.equal(st.batchIndex, 1);
});
