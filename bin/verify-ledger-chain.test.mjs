/**
 * bin/verify-ledger-chain.test.mjs —— 校验器必须「写得进、读得回、改得被抓」
 *
 * 这个测试验的是**门禁本身有没有价值**。要点：
 *   - 校验器不 import 插件代码（§4.4.3 独立性纪律 #1）。这里刻意用插件 service
 *     造条目、再交给校验器判 —— 两套实现必须对同一份字节达成一致，
 *     否则就是恒真门禁（写入侧 bug 同时污染写入与校验）。
 *   - 每种篡改都要被抓出**对应的错误码**，不接受"总之是失败"：
 *     误报和漏报都会让人忽略门禁（§0.1 教训）。
 *   - 校验器只读：跑完之后文件字节必须一模一样（§4.6 #6）。
 *   - 信任层级不夸大：无远端可比时必须输出 ANCHOR_REMOTE_UNVERIFIED（§4.6 #9）。
 *
 * Run: node --test bin/verify-ledger-chain.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLedgerService } from '../plugins/agint-evolution-memory/lib/ledger.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'verify-ledger-chain.mjs');

const UNIT_NAME = 'agint_evolution';

function makeTable() {
  const records = new Map();
  return {
    entries: () => [...records.entries()][Symbol.iterator](),
    keys: () => [...records.keys()][Symbol.iterator](),
    get: (k) => records.get(k),
    get size() { return records.size; },
    async put(k, v) { records.set(k, v); return true; },
  };
}

/** 用**真实写入侧**造 count 条，返回整单元文件文本。 */
async function buildLedgerFile(count) {
  const table = makeTable();
  const svc = createLedgerService({
    getTable: async () => table,
    now: () => '2026-10-02T08:00:00.000Z',
    warn: () => {},
    bump: () => {},
  });
  for (let i = 0; i < count; i++) {
    await svc.appendEntry({
      contractId: `EVO-V${i + 1}`,
      generation: 'GEN-003',
      summary: {
        mutationType: 'PROMPT_MUTATION',
        changedPlugins: ['agint-mutator'],
        targetMetric: 'aesthetic_pass_rate',
        hypothesisDigest: `digest-${i}`,
        predictedDelta: 0.04,
        actualDelta: 0.0400000000000001, // 浮点末位噪声：量化后不得影响校验
        decision: i % 2 === 0 ? 'AUTO_DEPLOY' : 'REJECT',
      },
      references: { abTestId: `AB-${i}` },
    });
  }
  const doc = {
    unit: { name: UNIT_NAME, version: 1 },
    global: null,
    tables: { evolution_ledger: Object.fromEntries(table.entries()) },
  };
  return { text: `${JSON.stringify(doc, null, 2)}\n`, entries: doc.tables.evolution_ledger };
}

/** 写临时文件并跑校验器；返回 { code, out }。 */
function run(file, args, extraFiles = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-ledger-'));
  const ledgerPath = join(dir, 'agint_evolution.json');
  writeFileSync(ledgerPath, file, 'utf8');
  for (const [name, content] of Object.entries(extraFiles)) writeFileSync(join(dir, name), content, 'utf8');
  let code = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [
      SCRIPT, ...args,
      '--ledger', ledgerPath,
      '--anchor-file', join(dir, 'evolution-ledger-anchor.md'),
    ], { encoding: 'utf8', cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    code = typeof err.status === 'number' ? err.status : 2;
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  return { code, out, ledgerPath, dir };
}

function tamper(file, mutate) {
  const doc = JSON.parse(file);
  mutate(doc.tables.evolution_ledger);
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// 锚点行的真实表头（§4.4.1）：六列、最后一列是**上一条**锚点行的引入 commit
function anchorRow({ anchoredAt, seq, headEntryHash, rollupRoot, entryCount, prevCommit }) {
  return `| ${anchoredAt} | ${seq} | ${headEntryHash} | ${rollupRoot} | ${entryCount} | ${prevCommit} |`;
}

const ANCHOR_HEAD = '# Evolution Ledger 外部锚点\n\n'
  + '| 锚定时间(UTC) | Ledger Seq | Head Entry Hash | Rollup Root | Entry Count | Prev Anchor Commit |\n'
  + '|---|---|---|---|---|---|\n';

// ── 干净链 ────────────────────────────────────────────────────────────────

test('写入侧造的 10 条链：--full 通过（exit 0），两套实现互相同意', async () => {
  const { text } = await buildLedgerFile(10);
  const { code, out } = run(text, ['--full']);
  assert.equal(code, 0, out);
  assert.match(out, /Chain integrity: 10 entries, seq 1-10, no gap/);
  assert.match(out, /Merkle: 2 batch\(es\)/);
});

test('校验器只读：跑完之后文件字节不变（§4.6 #6）', async () => {
  const { text } = await buildLedgerFile(3);
  const { ledgerPath } = run(text, ['--full']);
  assert.equal(readFileSync(ledgerPath, 'utf8'), text, '校验器不得改写 ledger');
});

test('单条 proof：--entry 输出可解析的 proof 且自校验通过', async () => {
  const { text } = await buildLedgerFile(9);
  for (const arg of ['1', '5', '8', '9', 'EVO-V9']) {
    const { code, out } = run(text, ['--entry', arg]);
    assert.equal(code, 0, `${arg} ⇒ ${out}`);
    const start = out.indexOf('{');
    const proof = JSON.parse(out.slice(start));
    assert.equal(typeof proof.entryHash, 'string');
    assert.ok(Array.isArray(proof.path));
    assert.match(out, /Proof seq=\d+: verified/);
  }
});

test('--since 只看某时刻之后的条目，之前的链仍维持基准', async () => {
  const { text } = await buildLedgerFile(4);
  const { code } = run(text, ['--full', '--since', '2026-10-02T00:00:00.000Z']);
  assert.equal(code, 0);
  const { code: futureCode } = run(text, ['--full', '--since', '2027-01-01T00:00:00.000Z']);
  assert.equal(futureCode, 0, '全部跳过不算失败（没有可证伪的条目）');
});

// ── 篡改必须被抓，且错误码明确 ────────────────────────────────────────────

test('改条目内容（summary）⇒ ENTRY_HASH_MISMATCH + exit 1', async () => {
  const { text } = await buildLedgerFile(3);
  const bad = tamper(text, (rows) => { rows['2'].summary.actualDelta = 0.99; });
  const { code, out } = run(bad, ['--full']);
  assert.equal(code, 1);
  assert.match(out, /ENTRY_HASH_MISMATCH at seq=2/);
  assert.match(out, /不修复、不重写/);
});

test('改 entryHash 本身却不改内容 ⇒ 重算与存量不符（摘要不是可信输入）', async () => {
  const { text } = await buildLedgerFile(2);
  const bad = tamper(text, (rows) => { rows['1'].chain.entryHash = `sha256:${'a'.repeat(64)}`; });
  const { code, out } = run(bad, ['--full']);
  assert.equal(code, 1);
  assert.match(out, /ENTRY_HASH_MISMATCH at seq=1/);
  assert.match(out, /PARENT_HASH_BROKEN at seq=2/);
});

test('删掉中间条目 ⇒ SEQ_GAP（禁止补占位，§4.4.4）', async () => {
  const { text } = await buildLedgerFile(4);
  const bad = tamper(text, (rows) => { delete rows['3']; });
  const { code, out } = run(bad, ['--full']);
  assert.equal(code, 1);
  assert.match(out, /SEQ_GAP at seq=3/);
});

test('删掉尾部条目：链内察觉不到（截断是哈希链的固有极限），锚点必须抓到', async () => {
  const { text, entries } = await buildLedgerFile(10);
  const bad = tamper(text, (rows) => { delete rows['10']; });

  // ① 纯链模式：尾部删除不留空洞，剩余条目各自存的仍是「追加那一刻」的前缀根，
  //    重放自然自洽 ⇒ 只能如实标出盲区（⛔ 不能假装抓得到）。
  const plain = run(bad, ['--full']);
  assert.equal(plain.code, 0, plain.out);
  assert.match(plain.out, /TAIL_TRUNCATION_UNCHECKABLE/);

  // ② 比对上一次锚点行（声称 seq=10 / count=10）：条目不见了 ⇒ 锚点走在链前面。
  const anchor = ANCHOR_HEAD + anchorRow({
    anchoredAt: '2026-10-05T08:00:00Z',
    seq: 10,
    headEntryHash: entries['10'].chain.entryHash,
    rollupRoot: entries['10'].chain.merkleRoot,
    entryCount: 10,
    prevCommit: 'GENESIS',
  }) + '\n';
  const withAnchor = run(bad, ['--anchor'], { 'evolution-ledger-anchor.md': anchor });
  assert.equal(withAnchor.code, 1, withAnchor.out);
  assert.match(withAnchor.out, /ANCHOR_AHEAD_OF_CHAIN/);
});

test('整链向前平移（重写 parentHash 使其自洽）⇒ 首条 GENESIS_MISMATCH 暴露', async () => {
  const { text } = await buildLedgerFile(3);
  const bad = tamper(text, (rows) => {
    rows['1'].chain.parentHash = `sha256:${'b'.repeat(64)}`;
  });
  const { code, out } = run(bad, ['--full']);
  assert.equal(code, 1);
  assert.match(out, /GENESIS_MISMATCH at seq=1/);
});

test('主键与 seq 不符（同一序号两条）⇒ 脚本自身出错 exit 2', async () => {
  const { text } = await buildLedgerFile(2);
  const doc = JSON.parse(text);
  doc.tables.evolution_ledger['99'] = doc.tables.evolution_ledger['2'];
  const { code, out } = run(`${JSON.stringify(doc, null, 2)}\n`, ['--full']);
  assert.equal(code, 2, out);
  assert.match(out, /LEDGER_KEY_MISMATCH/);
});

test('非本域文件 / BOM / 坏 JSON ⇒ exit 2，不与「校验不通过」混为一谈', async () => {
  const { code: foreign } = run(`${JSON.stringify({ unit: { name: 'other', version: 1 }, tables: {} })}\n`, ['--full']);
  assert.equal(foreign, 2);
  const { code: bom } = run(`\uFEFF${JSON.stringify({ unit: { name: UNIT_NAME, version: 1 }, tables: {} })}\n`, ['--full']);
  assert.equal(bom, 2);
  const { code: broken } = run('{ not json', ['--full']);
  assert.equal(broken, 2);
});

test('version 不等于 1 ⇒ LEDGER_VERSION（升 version 会 brick，继承取证表）', async () => {
  const { text } = await buildLedgerFile(1);
  const doc = JSON.parse(text);
  doc.unit.version = 2;
  const { code, out } = run(`${JSON.stringify(doc, null, 2)}\n`, ['--full']);
  assert.equal(code, 2, out);
  assert.match(out, /LEDGER_VERSION/);
});

// ── 锚点（§4.6 #4b / #9）──────────────────────────────────────────────────

test('锚点最新行与链 head 一致 ⇒ 通过，且如实标 ANCHOR_REMOTE_UNVERIFIED（§4.6 #9）', async () => {
  const { text, entries } = await buildLedgerFile(3);
  const head = entries['3'];
  const anchor = ANCHOR_HEAD + anchorRow({
    anchoredAt: '2026-10-05T08:00:00Z',
    seq: 3,
    headEntryHash: head.chain.entryHash,
    rollupRoot: head.chain.merkleRoot,
    entryCount: 3,
    prevCommit: 'GENESIS',
  }) + '\n';
  const { code, out } = run(text, ['--anchor'], { 'evolution-ledger-anchor.md': anchor });
  assert.equal(code, 0, out);
  assert.match(out, /ANCHOR_REMOTE_UNVERIFIED/, '临时目录无 git 上游可比对，必须明示信任层级');
  assert.match(out, /Trust level: L1/);
});

test('本周 0 新增（锚点行与 head 相同）⇒ 不得误报断链（§4.6 #4b）', async () => {
  const { text, entries } = await buildLedgerFile(2);
  const head = entries['2'];
  const anchor = ANCHOR_HEAD + [
    anchorRow({ anchoredAt: '2026-09-28T08:00:00Z', seq: 2, headEntryHash: head.chain.entryHash, rollupRoot: head.chain.merkleRoot, entryCount: 2, prevCommit: 'GENESIS' }),
    anchorRow({ anchoredAt: '2026-10-05T08:00:00Z', seq: 2, headEntryHash: head.chain.entryHash, rollupRoot: head.chain.merkleRoot, entryCount: 2, prevCommit: 'GENESIS' }),
  ].join('\n') + '\n';
  const { code, out } = run(text, ['--anchor'], { 'evolution-ledger-anchor.md': anchor });
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /ANCHOR_MISMATCH|ANCHOR_AHEAD_OF_CHAIN/);
});

test('锚定后链又前进 2 条（周中）⇒ 按锚点自己的 seq 比对，不误报（v1.0 判据在此必红）', async () => {
  const { text, entries } = await buildLedgerFile(4);
  // 上周锚点停在 seq=2；链已涨到 4，下一次锚定还没到 —— 这是常态，不是异常。
  const anchor = ANCHOR_HEAD + anchorRow({
    anchoredAt: '2026-09-28T08:00:00Z',
    seq: 2,
    headEntryHash: entries['2'].chain.entryHash,
    rollupRoot: entries['2'].chain.merkleRoot,
    entryCount: 2,
    prevCommit: 'GENESIS',
  }) + '\n';

  const { code, out } = run(text, ['--anchor'], { 'evolution-ledger-anchor.md': anchor });
  assert.equal(code, 0, out);
  assert.match(out, /ANCHOR_PREFIX_OK/);
  assert.doesNotMatch(out, /ANCHOR_MISMATCH|ANCHOR_AHEAD_OF_CHAIN/);

  // 同一份锚点，链上 seq=2 那条被改写 ⇒ 必须报红（以 git 锚点为准，链只是定位手段）
  const rewritten = tamper(text, (rows) => { rows['2'].summary.actualDelta = 0.9; });
  const red = run(rewritten, ['--anchor'], { 'evolution-ledger-anchor.md': anchor });
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /ANCHOR_MISMATCH|ENTRY_HASH_MISMATCH/);

  // 锚点追上 head（两行，末行 seq=4）⇒ 无未锚定条目
  const caught = ANCHOR_HEAD + [
    anchorRow({ anchoredAt: '2026-09-28T08:00:00Z', seq: 2, headEntryHash: entries['2'].chain.entryHash, rollupRoot: entries['2'].chain.merkleRoot, entryCount: 2, prevCommit: 'GENESIS' }),
    anchorRow({ anchoredAt: '2026-10-05T08:00:00Z', seq: 4, headEntryHash: entries['4'].chain.entryHash, rollupRoot: entries['4'].chain.merkleRoot, entryCount: 4, prevCommit: 'GENESIS' }),
  ].join('\n') + '\n';
  const up = run(text, ['--anchor'], { 'evolution-ledger-anchor.md': caught });
  assert.equal(up.code, 0, up.out);
  assert.match(up.out, /ANCHOR_UP_TO_DATE/);
});

test('ledger 在锚定后被改写 ⇒ ANCHOR_MISMATCH + exit 1（以 git 锚点为准）', async () => {
  const { text, entries } = await buildLedgerFile(2);
  const anchor = ANCHOR_HEAD + anchorRow({
    anchoredAt: '2026-10-05T08:00:00Z',
    seq: 2,
    headEntryHash: entries['2'].chain.entryHash,
    rollupRoot: entries['2'].chain.merkleRoot,
    entryCount: 2,
    prevCommit: 'GENESIS',
  }) + '\n';
  const bad = tamper(text, (rows) => { rows['2'].summary.actualDelta = 0.11; });
  const { code, out } = run(bad, ['--anchor'], { 'evolution-ledger-anchor.md': anchor });
  assert.equal(code, 1);
  assert.match(out, /ANCHOR_MISMATCH|ENTRY_HASH_MISMATCH/);
});

test('锚点声称的 seq 大于链 ⇒ ANCHOR_AHEAD_OF_CHAIN（伪造锚点）', async () => {
  const { text, entries } = await buildLedgerFile(2);
  const anchor = ANCHOR_HEAD + anchorRow({
    anchoredAt: '2026-10-05T08:00:00Z',
    seq: 7,
    headEntryHash: entries['2'].chain.entryHash,
    rollupRoot: entries['2'].chain.merkleRoot,
    entryCount: 2,
    prevCommit: 'GENESIS',
  }) + '\n';
  const { code, out } = run(text, ['--anchor'], { 'evolution-ledger-anchor.md': anchor });
  assert.equal(code, 1, out);
  assert.match(out, /ANCHOR_AHEAD_OF_CHAIN/);
});

test('锚点行形状非法（缺列 / 摘要串不合规 / Prev 非 GENESIS 也非 40 位）⇒ exit 2', async () => {
  const { text } = await buildLedgerFile(1);
  for (const badRow of [
    '| 2026-10-05T08:00:00Z | 1 | sha256:abc | sha256:def | 1 |',
    `| 2026-10-05T08:00:00Z | 1 | notahash | sha256:${'0'.repeat(64)} | 1 | GENESIS |`,
    `| 2026-10-05T08:00:00Z | 1 | sha256:${'0'.repeat(64)} | sha256:${'0'.repeat(64)} | 1 | HEAD |`,
  ]) {
    const anchor = `${ANCHOR_HEAD}${badRow}\n`;
    const { code, out } = run(text, ['--anchor'], { 'evolution-ledger-anchor.md': anchor });
    assert.equal(code, 2, `${badRow} ⇒ ${out}`);
    assert.match(out, /ANCHOR_ROW_SHAPE/);
  }
});

test('--anchors 在文件未入库时必须失败并给出原因（⛔ 不得恒绿）', async () => {
  const { text, entries } = await buildLedgerFile(1);
  const head = entries['1'];
  const anchor = ANCHOR_HEAD + anchorRow({
    anchoredAt: '2026-10-05T08:00:00Z',
    seq: 1,
    headEntryHash: head.chain.entryHash,
    rollupRoot: head.chain.merkleRoot,
    entryCount: 1,
    prevCommit: 'GENESIS',
  }) + '\n';
  const { code, out } = run(text, ['--anchors'], { 'evolution-ledger-anchor.md': anchor });
  assert.equal(code, 1, out);
  assert.match(out, /ANCHOR_GIT_UNAVAILABLE|ANCHOR_NOT_COMMITTED/);
});
