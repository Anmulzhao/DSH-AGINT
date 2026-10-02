#!/usr/bin/env node
/**
 * bin/anchor-ledger.mjs —— 锚定**预览**（只读）
 *
 * ## 为什么它不执行锚定
 *
 * 设计稿 v1.2 原文把这个脚本写成锚定的执行入口，实现时改判了：宿主存储后端
 * 把整个 unit 读进内存，每次 putRecord 用内存态整体重写文件
 * （`@deepseek-ai/dsh-storage-json/lib/index.js:215-226`，自述 last-write-wins）
 * ⇒ 独立进程改 `agint_evolution.json` 里的 `anchorStatus` 会在宿主下一次写入时
 * 被静默覆盖。锚定因此做成**宿主服务方法**
 * （`plugins/agint-evolution-memory/lib/ledger-anchor.js`，由 cron 任务
 * `ledger-anchor` 调用，Mon 10:15）。
 *
 * 这个脚本保留下来只做一件事：在跑 cron 之前，人可以先看一眼**下一次锚定会把
 * 什么写进锚点文件**，并对一下 git 是否干净。⛔ 它不写 ledger、不写锚点文件、
 * 不 commit —— 任何写动作都可能与宿主抢同一个文件。
 *
 * 校验链本身（以及逐 commit 的锚点历史重放）请用：
 *   node bin/verify-ledger-chain.mjs --full / --anchors
 *
 * 用法：
 *   node bin/anchor-ledger.mjs                 # 预览下一行 + git 状态提示
 *   node bin/anchor-ledger.mjs --json          # 机器可读
 *   node bin/anchor-ledger.mjs --ledger <路径> --anchor-file <路径>
 * 退出码：0 = 可锚定 / 1 = 空链或前置不满足 / 2 = 脚本自身出错
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const UNIT_NAME = 'agint_evolution';
const DEFAULT_LEDGER = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'storages', 'agint_evolution.json')
  : join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'storages', 'agint_evolution.json');
const DEFAULT_ANCHOR_FILE = join(REPO_ROOT, 'docs', 'evolution-ledger-anchor.md');

function parseArgs(argv) {
  const opts = { ledger: DEFAULT_LEDGER, anchorFile: DEFAULT_ANCHOR_FILE, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--ledger') opts.ledger = argv[++i];
    else if (a === '--anchor-file') opts.anchorFile = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return opts;
}

function readHead(path) {
  if (!existsSync(path)) throw new Error(`LEDGER_FILE_MISSING: ${path}`);
  const raw = readFileSync(path, 'utf8');
  let doc;
  try { doc = JSON.parse(raw); } catch (err) { throw new Error(`LEDGER_UNPARSEABLE: ${err.message}`); }
  if (doc?.unit?.name !== UNIT_NAME) throw new Error(`LEDGER_FOREIGN_UNIT: unit.name=${JSON.stringify(doc?.unit?.name)}`);
  const rows = doc.tables?.evolution_ledger;
  if (!rows || typeof rows !== 'object') return { head: null, entries: 0 };
  const entries = Object.values(rows).filter((e) => e && Number.isInteger(e.seq));
  const head = entries.reduce((acc, e) => (acc === null || e.seq > acc.seq ? e : acc), null);
  return { head, entries: entries.length };
}

/** 已有锚点行数 = 下一行的 anchorSeq - 1。与写入侧同判据，但这里只数不写。 */
function countAnchorRows(path) {
  if (!existsSync(path)) return 0;
  let n = 0;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length !== 6 || /^锚定时间/.test(cells[0]) || /^[-\s:]+$/.test(cells.join(''))) continue;
    n++;
  }
  return n;
}

function git(args) {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return `__GIT_ERROR__ ${(err.stderr || err.message || '').toString().trim().split('\n')[0]}`;
  }
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write('用法：node bin/anchor-ledger.mjs [--ledger <路径>] [--anchor-file <路径>] [--json]\n只读预览，不写任何文件。\n');
    return 0;
  }
  const relAnchor = opts.anchorFile.startsWith(REPO_ROOT)
    ? opts.anchorFile.slice(REPO_ROOT.length + 1).split(/[\\/]+/).join('/')
    : opts.anchorFile;
  const { head, entries } = readHead(opts.ledger);
  const prevRowCount = countAnchorRows(opts.anchorFile);
  const lastCommit = prevRowCount > 0 ? git(['log', '-1', '--format=%H', '--', relAnchor]) : 'GENESIS';
  const dirty = git(['status', '--porcelain', '--', relAnchor]);

  const out = {
    ledgerFile: opts.ledger,
    entries,
    anchorRowsAlready: prevRowCount,
    nextAnchorSeq: prevRowCount + 1,
    head: head && {
      seq: head.seq,
      entryHash: head.chain?.entryHash ?? null,
      merkleRoot: head.chain?.merkleRoot ?? null,
      anchorStatus: head.anchorStatus ?? null,
    },
    nextRow: null,
    git: { anchorFile: relAnchor, lastCommitOfAnchorFile: lastCommit, workingTreeState: dirty === '' ? 'clean' : dirty },
    blockers: [],
  };

  if (!head) {
    out.blockers.push('LEDGER_EMPTY: 链里没有条目 ⇒ 本轮没有可锚定的内容');
  } else {
    if (prevRowCount > 0 && (!/^[0-9a-f]{40}$/.test(lastCommit))) {
      out.blockers.push(`ANCHOR_FILE_UNCOMMITTED: 已有 ${prevRowCount} 行锚点却查不到对应提交（${lastCommit}）`);
    }
    if (dirty !== '') out.blockers.push('ANCHOR_FILE_DIRTY: 锚点文件有未提交改动 ⇒ 先处理它，别让它混进锚定提交');
    out.nextRow = {
      anchoredAt: new Date().toISOString(),
      seq: head.seq,
      headEntryHash: head.chain?.entryHash ?? null,
      rollupRoot: head.chain?.merkleRoot ?? null,
      entryCount: entries,
      prevCommit: prevRowCount === 0 ? 'GENESIS' : lastCommit,
    };
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    process.stdout.write(`Ledger 文件：${opts.ledger}\n`);
    process.stdout.write(`条目 ${entries}，head=${out.head ? out.head.seq : '—'}`
      + `，已有锚点行 ${prevRowCount}\n`);
    if (out.nextRow) {
      const r = out.nextRow;
      process.stdout.write('下一次锚定将写入这一行：\n');
      process.stdout.write(`| ${r.anchoredAt} | ${r.seq} | ${r.headEntryHash} | ${r.rollupRoot} | ${r.entryCount} | ${r.prevCommit} |\n`);
    }
    process.stdout.write(`锚点文件 ${out.git.anchorFile}：最后提交 ${String(out.git.lastCommitOfAnchorFile).slice(0, 12)}`
      + `，工作区 ${out.git.workingTreeState}\n`);
    for (const b of out.blockers) process.stdout.write(`~ ${b}\n`);
    if (out.blockers.length === 0) {
      process.stdout.write('→ 实际锚定由宿主服务执行：cron 任务 `ledger-anchor`（Mon 10:15）；'
        + '手工触发请走 agint.evolution.ledger.anchor()，⛔ 不要在本脚本里写文件。\n');
    }
  }
  return out.blockers.length > 0 ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ error: msg, mode: 'error' }, null, 2)}\n`);
  } else {
    process.stderr.write(`✗ 预览失败（退出码 2，与「不可锚定」区分）：${msg}\n`);
  }
  process.exitCode = 2;
}
