/**
 * ledger-anchor.test.mjs —— 外部锚定的写入侧（§4.4.2）
 *
 * 用**真 git 仓库**（临时目录 git init）跑，不用假 git：
 *   锚定的全部价值都建立在「这一行进了提交历史」上，mock 掉 git 就等于
 *   把被测对象本身 mock 掉了 —— 那种测试恒绿。
 *
 * 三条不可让的判据（对应 lib/ledger-anchor.js 头部的顺序）：
 *   ① 没提交成功 ⇒ 锚点文件必须还原，⛔ 不得留下「看起来锚过了」的行
 *   ② 只提交本文件 ⇒ 别人暂存的东西不能被卷进锚定提交
 *   ③ 提交成功后才回写 anchorStatus ⇒ 顺序反了就是撒谎
 *
 * Run: node --test plugins/agint-evolution-memory/test/ledger-anchor.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLedgerService } from '../lib/ledger.js';
import { createLedgerAnchorService, ANCHOR_HEADER } from '../lib/ledger-anchor.js';

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

/** 临时 git 仓库：一次 commit 都没有，HEAD 指向未born分支 —— 锚定自己会创建首个提交。 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ledger-anchor-'));
  mkdirSync(join(dir, 'docs'), { recursive: true });
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'ledger-anchor-test']);
  git(['config', 'commit.gpgsign', 'false']);
  // 留一个无关文件，方便测「工作区里有别人的改动」时锚定会不会误伤
  writeFileSync(join(dir, 'README.md'), '# fixture\n', 'utf8');
  git(['add', 'README.md']);
  git(['commit', '-qm', 'init fixture']);
  return {
    dir,
    anchorFile: join(dir, 'docs', 'evolution-ledger-anchor.md'),
    git,
    commitCount: (path) => Number(git(['rev-list', '--count', 'HEAD', '--', path]).trim()),
    filesInHead: () => git(['show', '--name-only', '--format=', 'HEAD']).trim().split(/\r?\n/),
    headSha: () => git(['rev-parse', 'HEAD']).trim(),
  };
}

function makeLedger(count, { now = () => '2026-10-02T08:00:00.000Z' } = {}) {
  const table = makeTable();
  const ledger = createLedgerService({ getTable: async () => table, now, warn: () => {}, bump: () => {} });
  const append = (i) => ledger.appendEntry({
    contractId: `EVO-A${i}`,
    generation: 'GEN-003',
    summary: {
      mutationType: 'PROMPT_MUTATION',
      changedPlugins: ['agint-mutator'],
      targetMetric: 'aesthetic_pass_rate',
      hypothesisDigest: `digest-${i}`,
      predictedDelta: 0.05,
      actualDelta: 0.06,
      decision: 'AUTO_DEPLOY',
    },
    references: { abTestId: `AB-A${i}` },
  });
  return { ledger, table, append };
}

const fixedNow = () => '2026-10-05T08:00:00.000Z';

function dataRows(text) {
  return (text ?? '').split(/\r?\n/).filter((l) => /^\|\s*\d{4}-\d{2}-\d{2}T/.test(l.trim()));
}

test('空链：NOOP 且不产生任何提交（没有可锚定的东西）', async () => {
  const repo = makeRepo();
  const { ledger } = makeLedger(0);
  const svc = createLedgerAnchorService({ ledger, anchorFile: repo.anchorFile, repoRoot: repo.dir, now: fixedNow });
  const res = await svc.anchor();
  assert.equal(res.anchored, false);
  assert.equal(res.code, 'LEDGER_EMPTY');
  assert.equal(existsSync(repo.anchorFile), false, '空链不得创建锚点文件');
  assert.equal(repo.commitCount('docs/evolution-ledger-anchor.md'), 0);
});

test('首次锚定：建行 + 提交 + 回写 anchorStatus，prevCommit 为 GENESIS', async () => {
  const repo = makeRepo();
  const { ledger, append } = makeLedger(0);
  for (let i = 1; i <= 3; i++) await append(i);
  const svc = createLedgerAnchorService({ ledger, anchorFile: repo.anchorFile, repoRoot: repo.dir, now: fixedNow });

  const res = await svc.anchor();
  assert.equal(res.anchored, true, JSON.stringify(res));
  assert.equal(res.row.seq, 3);
  assert.equal(res.row.entryCount, 3);
  assert.equal(res.row.prevCommit, 'GENESIS', '首行只能指向字面 GENESIS：本行的 commit SHA 不可能出现在本行里（§4.4.1 勘误 #6）');
  assert.equal(res.row.anchorSeq, 1);

  const text = readFileSync(repo.anchorFile, 'utf8');
  assert.match(text, /锚定时间\(UTC\)/);
  const rows = dataRows(text);
  assert.equal(rows.length, 1);
  assert.match(rows[0], new RegExp(`\\| ${res.row.headEntryHash} \\| ${res.row.rollupRoot} \\| 3 \\| GENESIS \\|`));

  assert.equal(repo.commitCount('docs/evolution-ledger-anchor.md'), 1);
  assert.equal(res.commit, repo.git(['log', '-1', '--format=%H', '--', 'docs/evolution-ledger-anchor.md']).trim());

  const head = await ledger.getHead();
  assert.equal(head.anchorStatus, 'ANCHORED');
  assert.equal(head.anchorSeq, 1);
  // 回写不得破坏链：entryHash 仍要能由条目自身重算出来
  const { computeEntryHash } = await import('../lib/ledger-hash.js');
  assert.equal(computeEntryHash(head), head.chain.entryHash, 'markAnchored 之后条目必须仍自证完好');
});

test('第二次锚定：只追加一行，prevCommit 指向上一次的提交', async () => {
  const repo = makeRepo();
  const { ledger, append } = makeLedger(0);
  for (let i = 1; i <= 2; i++) await append(i);
  const svc = createLedgerAnchorService({ ledger, anchorFile: repo.anchorFile, repoRoot: repo.dir, now: fixedNow });
  const first = await svc.anchor();
  for (let i = 3; i <= 5; i++) await append(i);
  const second = await svc.anchor();

  assert.equal(second.anchored, true, JSON.stringify(second));
  assert.equal(second.row.anchorSeq, 2);
  assert.equal(second.row.seq, 5);
  assert.equal(second.row.prevCommit, first.commit, 'Prev Anchor Commit = 上一**行**的引入 commit');
  assert.equal(dataRows(readFileSync(repo.anchorFile, 'utf8')).length, 2);
  assert.equal(repo.commitCount('docs/evolution-ledger-anchor.md'), 2);
  assert.notEqual(second.row.headEntryHash, first.row.headEntryHash, '链已前进，两行的 head 必须不同');
});

test('0 新增也要留一行：证明本周确实锚过（不是「链没动 = 没锚」）', async () => {
  const repo = makeRepo();
  const { ledger, append } = makeLedger(0);
  await append(1);
  const svc = createLedgerAnchorService({ ledger, anchorFile: repo.anchorFile, repoRoot: repo.dir, now: fixedNow });
  const a = await svc.anchor();
  const b = await svc.anchor();
  assert.equal(b.anchored, true, JSON.stringify(b));
  assert.equal(b.row.seq, a.row.seq);
  assert.equal(b.row.prevCommit, a.commit);
  assert.equal(dataRows(readFileSync(repo.anchorFile, 'utf8')).length, 2);
});

test('⛔ 提交不了就还原：不留「看起来锚过了」的行，也不回写 anchorStatus', async () => {
  const repo = makeRepo();
  const { ledger, append } = makeLedger(0);
  await append(1);
  const good = (args) => {
    const r = spawnSync('git', ['-C', repo.dir, ...args], { encoding: 'utf8' });
    return r.status === 0 ? { ok: true, out: r.stdout } : { ok: false, error: (r.stderr || '').trim() };
  };
  let commits = 0;
  const svc = createLedgerAnchorService({
    ledger,
    anchorFile: repo.anchorFile,
    repoRoot: repo.dir,
    now: fixedNow,
    git: (args) => {
      if (args[0] === 'commit' && ++commits === 2) return { ok: false, error: 'fixture: commit hook 拒绝' };
      return good(args);
    },
  });
  const first = await svc.anchor();
  assert.equal(first.anchored, true);

  const res = await svc.anchor();
  assert.equal(res.anchored, false);
  assert.equal(res.code, 'ANCHOR_COMMIT_FAILED');
  const text = readFileSync(repo.anchorFile, 'utf8');
  assert.equal(dataRows(text).length, 1, '失败的锚定不得把第二行留在文件里');
  assert.match(text, /锚定时间\(UTC\)/, '第一次锚定的行必须原样保留');
  const head = await ledger.getHead();
  assert.equal(head.anchorSeq, 1, '回写不得前进 —— 只有进了 git 的锚点才算锚点');
});

test('只提交锚点文件：别人暂存的改动不能被卷进来', async () => {
  const repo = makeRepo();
  const { ledger, append } = makeLedger(0);
  await append(1);
  writeFileSync(join(repo.dir, 'somewhere-else.txt'), '别人的在途改动\n', 'utf8');
  repo.git(['add', 'somewhere-else.txt']); // 人已暂存，等着自己的提交

  const svc = createLedgerAnchorService({ ledger, anchorFile: repo.anchorFile, repoRoot: repo.dir, now: fixedNow });
  const res = await svc.anchor();
  assert.equal(res.anchored, true, JSON.stringify(res));
  assert.deepEqual(repo.filesInHead(), ['docs/evolution-ledger-anchor.md'],
    '锚定提交只能包含锚点文件（裸 git commit 会把索引里别人的东西一起提走）');
  assert.equal(repo.git(['status', '--porcelain', '--', 'somewhere-else.txt']).trim(), 'A  somewhere-else.txt',
    '别人的暂存必须还在');
});

test('已有行却没进 git ⇒ ANCHOR_FILE_UNCOMMITTED，拒绝继续', async () => {
  const repo = makeRepo();
  const { ledger, append } = makeLedger(0);
  await append(1);
  const fakeRow = `| 2026-09-28T08:00:00.000Z | 99 | ${'sha256:' + 'a'.repeat(64)} | ${'sha256:' + 'b'.repeat(64)} | 99 | GENESIS |\n`;
  writeFileSync(repo.anchorFile, ANCHOR_HEADER + fakeRow, 'utf8');

  const svc = createLedgerAnchorService({ ledger, anchorFile: repo.anchorFile, repoRoot: repo.dir, now: fixedNow });
  const res = await svc.anchor();
  assert.equal(res.anchored, false);
  assert.equal(res.code, 'ANCHOR_FILE_UNCOMMITTED');
  assert.equal(dataRows(readFileSync(repo.anchorFile, 'utf8')).length, 1, '不得在伪造行后面追加真行');
});

test('非 UTC 毫秒形态的时间源 ⇒ 直接抛，不写半行', async () => {
  const repo = makeRepo();
  const { ledger, append } = makeLedger(0);
  await append(1);
  const svc = createLedgerAnchorService({
    ledger, anchorFile: repo.anchorFile, repoRoot: repo.dir, now: () => '2026-10-05 08:00',
  });
  await assert.rejects(() => svc.anchor(), /anchoredAt/);
  assert.equal(existsSync(repo.anchorFile), false);
});

test('preview 只读：不落盘、不提交', async () => {
  const repo = makeRepo();
  const { ledger, append } = makeLedger(0);
  await append(1);
  const before = repo.headSha();
  const svc = createLedgerAnchorService({ ledger, anchorFile: repo.anchorFile, repoRoot: repo.dir, now: fixedNow });
  const p = await svc.preview();
  assert.equal(p.seq, 1);
  assert.equal(p.prevCommit, 'GENESIS');
  assert.equal(existsSync(repo.anchorFile), false);
  assert.equal(repo.headSha(), before);
});

test('事件发布是 best-effort：bus 抛错不影响已完成的锚定', async () => {
  const repo = makeRepo();
  const { ledger, append } = makeLedger(0);
  await append(1);
  const warns = [];
  let seen = null;
  const svc = createLedgerAnchorService({
    ledger,
    anchorFile: repo.anchorFile,
    repoRoot: repo.dir,
    now: fixedNow,
    warn: (m) => warns.push(m),
    publish: async (topic, payload) => { seen = { topic, payload }; throw new Error('bus down'); },
  });
  const res = await svc.anchor();
  assert.equal(res.anchored, true, JSON.stringify(res));
  assert.equal(seen.topic, 'evolution.ledger.anchored');
  assert.equal(seen.payload.headSeq, 1);
  assert.match(warns.join('\n'), /事件发布失败/);
});

/**
 * 端到端：锚定写完，独立校验器必须认这一行。
 *
 * 这是本文件最重要的一条 —— 写入侧与校验侧是两套实现（§4.4.3 独立性纪律 #1），
 * 只有一致，锚点才算「被第二双眼睛看过」。列序、时间形态、hash 串格式任何一处
 * 对不上，这里就红。
 */
test('锚定产物经 bin/verify-ledger-chain.mjs --anchor 判定为通过', async () => {
  const repo = makeRepo();
  const { ledger, table, append } = makeLedger(0);
  for (let i = 1; i <= 3; i++) await append(i);
  const svc = createLedgerAnchorService({ ledger, anchorFile: repo.anchorFile, repoRoot: repo.dir, now: fixedNow });
  assert.equal((await svc.anchor()).anchored, true);
  for (let i = 4; i <= 5; i++) await append(i);
  assert.equal((await svc.anchor()).anchored, true);

  const ledgerFile = join(repo.dir, 'agint_evolution.json');
  const doc = {
    unit: { name: 'agint_evolution', version: 1 },
    global: null,
    tables: { evolution_ledger: Object.fromEntries(table.entries()) },
  };
  writeFileSync(ledgerFile, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');

  const HERE = dirname(fileURLToPath(import.meta.url));
  const script = join(HERE, '..', '..', '..', 'bin', 'verify-ledger-chain.mjs');
  const r = spawnSync(process.execPath, [
    script, '--anchor', '--ledger', ledgerFile, '--anchor-file', repo.anchorFile,
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /Chain integrity: 5 entries, seq 1-5, no gap/);
  // 末行 seq=5 == head ⇒ 已追平；上一行 seq=3 的记录也必须在文件里读得出来
  assert.match(r.stdout, /ANCHOR_UP_TO_DATE/);
});
