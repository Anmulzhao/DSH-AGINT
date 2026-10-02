/**
 * agint-evolution-memory: ledger 外部锚定（Phase 1 交付物 3 §4.4.2）
 *
 * ## 锚定 = 把链头摘要写进一个**由 git 历史记账**的文件，然后本地 commit
 *
 * 内部链（`ledger.js`）证明的是「这张表没被改过」，但它证明不了「这张表没被
 * 整段截掉」—— 删掉尾部若干条不留空洞，剩余条目各自存的仍是追加那一刻的前缀值，
 * 重放自洽（`bin/verify-ledger-chain.mjs` 把这个盲区明说成
 * TAIL_TRUNCATION_UNCHECKABLE）。要抓截断，必须有一个**链外**的计数器与摘要，
 * 而它的不可篡改性由 git 提交历史提供（§4.4.5 信任层级 L1）。
 *
 * ## ⛔ 只 commit，绝不 push
 *
 * push 是把本机内容推给共享远端的**对外动作**，风险与本地提交不在一个量级
 * （覆盖别人、污染历史、把不该外传的数据发出去）。L1→L2 的升级必须由人确认后
 * 手工完成；本模块连 push 的代码都不写，避免「以后顺手加上」。
 *
 * ## ⛔ 为什么做成宿主服务方法，不做成 bin/ 脚本
 *
 * `ledger.js` 头部已取证：宿主把整个 unit 读进内存，每次 putRecord 用内存态
 * **整体重写**文件（last-write-wins）。所以独立进程写 `agint_evolution.json`
 * 的 `anchorStatus` 会在下一次宿主写入时被静默覆盖。锚定必须跑在宿主里，
 * 由 cron 任务调用（`plugins/agint-cron/lib/jobs.js` 的 `ledger-anchor`）。
 * 设计稿 §6.1/§6.5 原文写的是 `bin/anchor-ledger.mjs`，已按此结论修正，
 * 那个脚本现在只做**只读预览**。
 *
 * ## 一次锚定做的事（顺序即语义，不可调换）
 *
 *   1. 取链头与条目数（没条目就 NOOP，空链没什么可锚定）
 *   2. 反查上一锚点行的引入 commit ⇒ 新行的 Prev Anchor Commit
 *      （首行固定 GENESIS：一个 commit 的 SHA 不可能出现在它自己的内容里，§4.4.1 勘误 #6）
 *   3. 追加一行（只追加；⛔ 不改写历史行）
 *   4. `git add` + `git commit` **只带本文件 pathspec** —— 别把别人暂存的东西卷进来
 *   5. 提交失败 ⇒ 把文件内容还原，报告 ANCHOR_COMMIT_FAILED
 *      （留在工作区里没进 git 的一行不是锚点，写回 anchorStatus 就是撒谎）
 *   6. 提交成功 ⇒ 回写 ledger 的 anchorStatus/anchorSeq（经 service，绝不直写文件）
 *   7. 发 `evolution.ledger.anchored` 事件（观测失败不阻断，§4.3.4 纪律 3）
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertUtcMillisIso } from './canonical.js';

const errMessage = (err) => (err instanceof Error ? err.message : String(err));

/** §4.4.1 的表头 —— 校验器按同样的列序解析，改这里必须同步改它。 */
export const ANCHOR_HEADER = '# Evolution Ledger 外部锚点\n\n'
  + '由 `agint-cron` 的 `ledger-anchor` 任务追加，一行 = 一次锚定。\n'
  + '⛔ 只追加，不改写历史行；每行的 Prev Anchor Commit 指向**上一行**的引入 commit。\n'
  + '校验：`node bin/verify-ledger-chain.mjs --anchors`\n\n'
  + '| 锚定时间(UTC) | Ledger Seq | Head Entry Hash | Rollup Root | Entry Count | Prev Anchor Commit |\n'
  + '|---|---|---|---|---|---|\n';

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^(GENESIS|[0-9a-f]{40})$/;

/** 仓库根：lib/ → 插件目录 → plugins/ → 仓库根。部署到别处时用 anchorFile 注入覆盖。 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function renderRow({ anchoredAt, seq, headEntryHash, rollupRoot, entryCount, prevCommit }) {
  return `| ${anchoredAt} | ${seq} | ${headEntryHash} | ${rollupRoot} | ${entryCount} | ${prevCommit} |\n`;
}

/**
 * 自己数一遍已有的数据行。
 * 不 import 校验器：校验器是**独立**的第二双眼睛（§4.4.3 独立性纪律 #1），
 * 锚定侧复用它就等于让被检者自己出体检报告。这里只需要行数以定位末行。
 */
function countDataRows(text) {
  if (!text) return 0;
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length !== 6) continue;
    if (/^锚定时间/.test(cells[0])) continue;
    if (/^[-\s:]+$/.test(cells.join(''))) continue;
    n++;
  }
  return n;
}

/**
 * @param {object} deps
 * @param {object} deps.ledger            createLedgerService() 的返回值（链的唯一写入口）
 * @param {string} [deps.anchorFile]      锚点文件绝对路径
 * @param {string} [deps.repoRoot]        git -C 的目录
 * @param {() => string} deps.now         ISO(UTC, ms, Z) 时间源
 * @param {(msg: string, extra?: object) => void} [deps.warn]
 * @param {(key: string, n?: number) => void} [deps.bump]
 * @param {(topic: string, payload: object) => Promise<boolean>} [deps.publish]
 * @param {(args: string[]) => {ok: boolean, out?: string, error?: string}} [deps.git]
 */
export function createLedgerAnchorService({
  ledger,
  anchorFile = join(REPO_ROOT, 'docs', 'evolution-ledger-anchor.md'),
  repoRoot = REPO_ROOT,
  now,
  warn = () => {},
  bump = () => {},
  publish = null,
  git = null,
}) {
  if (!ledger || typeof ledger.getHead !== 'function' || typeof ledger.stats !== 'function') {
    throw new TypeError('createLedgerAnchorService: ledger 必须有 getHead/stats（用 createLedgerService 的返回值）');
  }
  if (typeof now !== 'function') throw new TypeError('createLedgerAnchorService: now 必须是函数');

  const relFile = anchorFile.startsWith(repoRoot)
    ? anchorFile.slice(repoRoot.length + 1).split(/[\\/]+/).join('/')
    : anchorFile;

  const runGit = git ?? ((args) => {
    const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', timeout: 30_000 });
    if (r.error) return { ok: false, error: `git ${args[0]}: ${r.error.message}` };
    if (r.status !== 0) {
      return { ok: false, error: (r.stderr || r.stdout || `git ${args.join(' ')} 退出码 ${r.status}`).trim() };
    }
    return { ok: true, out: r.stdout };
  });

  /**
   * 上一锚点行的引入 commit（= 最后一次触碰本文件的 commit）。
   *
   * ⚠️ 文件有行但 git 查不到 commit ⇒ 上一行根本没被锚定过，此时新行的
   * Prev Anchor Commit 无从填起，只能拒绝继续（ANCHOR_FILE_UNCOMMITTED）。
   */
  function lastCommitOfAnchorFile() {
    const r = runGit(['log', '-1', '--format=%H', '--', relFile]);
    if (!r.ok) return { ok: false, error: r.error };
    const sha = (r.out ?? '').trim();
    return { ok: true, commit: /^[0-9a-f]{40}$/.test(sha) ? sha : null };
  }

  function writeAtomic(text) {
    const tmp = `${anchorFile}.tmp-${process.pid}`;
    writeFileSync(tmp, text, 'utf8');
    try {
      renameSync(tmp, anchorFile);
    } catch (err) {
      // Windows 上同目录 rename 有个短暂的 EPERM 窗口（bin/probe-rename-eperm-window.mjs
      // 就是为量这个窗口而写的）。这里的文件是给人读的证据，不是热路径：
      // 退化成整份重写，坏行会被锚定前的形状自检和校验器抓住，不会伪装成好行。
      warn(`ledger.anchor: rename 失败，退化为直接写入 ${relFile}：${errMessage(err)}`);
      writeFileSync(anchorFile, text, 'utf8');
      try { unlinkSync(tmp); } catch { /* 残留临时文件不影响判定 */ }
    }
  }

  /**
   * 执行一次锚定。
   *
   * @returns {Promise<{anchored: boolean, code: string, detail?: string, row?: object, commit?: string}>}
   */
  async function anchor() {
    const head = await ledger.getHead();
    if (!head) {
      bump('ledger.anchor.noop');
      return { anchored: false, code: 'LEDGER_EMPTY', detail: '链里没有条目 ⇒ 本轮不写锚点行（空链无可锚定）' };
    }
    const st = await ledger.stats();
    const anchoredAt = assertUtcMillisIso(now(), 'anchoredAt');

    const existing = existsSync(anchorFile) ? readFileSync(anchorFile, 'utf8') : '';
    const prevRowCount = countDataRows(existing);

    let prevCommit = 'GENESIS';
    if (prevRowCount > 0) {
      const found = lastCommitOfAnchorFile();
      if (!found.ok) {
        bump('ledger.anchor.failed');
        return { anchored: false, code: 'ANCHOR_GIT_UNAVAILABLE', detail: found.error };
      }
      if (!found.commit) {
        bump('ledger.anchor.failed');
        return {
          anchored: false, code: 'ANCHOR_FILE_UNCOMMITTED',
          detail: `${relFile} 里有 ${prevRowCount} 行却没有对应提交 ⇒ 那些行不是锚点，先把它们提交或清理`,
        };
      }
      prevCommit = found.commit;
    }

    const row = {
      anchoredAt,
      seq: head.seq,
      headEntryHash: head.chain.entryHash,
      rollupRoot: head.chain.merkleRoot,
      entryCount: st.entries,
      prevCommit,
      anchorSeq: prevRowCount + 1,
    };
    // 提交前先自检形状：一个坏行进了 git 就成了永久伪造证据，比没锚更糟。
    if (!HASH_RE.test(row.headEntryHash) || !HASH_RE.test(row.rollupRoot)
      || !Number.isInteger(row.seq) || !COMMIT_RE.test(row.prevCommit)) {
      bump('ledger.anchor.failed');
      return { anchored: false, code: 'ANCHOR_ROW_SHAPE', detail: `待写入行形状非法：${JSON.stringify(row)}` };
    }

    const nextContent = (existing || ANCHOR_HEADER) + renderRow(row);
    writeAtomic(nextContent);

    const add = runGit(['add', '--', relFile]);
    if (!add.ok) { restore(existing); return fail('ANCHOR_GIT_ADD_FAILED', add.error); }
    // pathspec 提交：只提本文件。裸 `git commit` 会把**别人已暂存**的改动一起卷进
    // 这次锚定提交里 —— 那是篡改别人的意图，不可接受。
    const commit = runGit(['commit', '-m',
      `chore(evolution-ledger): 外部锚点 第${row.anchorSeq}次 seq=${row.seq} rollup=${row.rollupRoot.slice(7, 19)}`,
      '--', relFile]);
    if (!commit.ok) { restore(existing); return fail('ANCHOR_COMMIT_FAILED', commit.error); }

    const sha = lastCommitOfAnchorFile();
    if (!sha.ok || !sha.commit) {
      // 提交命令成功却查不到 commit：git 状态异常，如实报，不假装锚定完成
      return fail('ANCHOR_COMMIT_UNVERIFIED', sha.error ?? '提交后仍反查不到本文件的 commit');
    }

    // 回写 anchorStatus —— 只有**进了 git** 的锚点才有资格标记（纪律 5 的顺序）。
    let writeback = null;
    try {
      const already = await ledger.listEntries?.() ?? [];
      const lastMarked = already.reduce((acc, e) => (e.anchorStatus === 'ANCHORED' && e.seq > acc ? e.seq : acc), 0);
      const fromSeq = lastMarked + 1;
      if (fromSeq <= head.seq) {
        writeback = await ledger.markAnchored({ anchorSeq: row.anchorSeq, fromSeq, toSeq: head.seq });
      }
    } catch (err) {
      // 锚点已在 git 里，回写失败只是「表内标记落后」，下次锚定补上；
      // 不能反过来把已成功的锚定说成失败（会让人去删正确的锚点行）。
      warn(`ledger.anchor: markAnchored 回写失败（锚点行已提交，仅标记落后）：${errMessage(err)}`, { seq: head.seq });
      bump('ledger.anchor.writebackFailed');
      writeback = { failed: errMessage(err) };
    }

    if (typeof publish === 'function') {
      try {
        await publish('evolution.ledger.anchored', {
          anchorSeq: row.anchorSeq,
          headSeq: row.seq,
          headEntryHash: row.headEntryHash,
          rollupRoot: row.rollupRoot,
          entryCount: row.entryCount,
          commit: sha.commit,
          anchorFile: relFile,
        });
      } catch (err) {
        warn(`ledger.anchor: 事件发布失败（不影响锚定本身）：${errMessage(err)}`);
      }
    }

    bump('ledger.anchor.ok');
    return { anchored: true, code: 'ANCHORED', row, commit: sha.commit, writeback, anchorFile: relFile };

    function restore(previous) {
      // 只回退**本次**追加：还原到锚定前那份内容；锚定前文件不存在就把它删掉，
      // 留一个空文件会让人以为「锚点文件是空的」而不是「还没锚过」。
      try {
        if (previous) writeFileSync(anchorFile, previous, 'utf8');
        else if (existsSync(anchorFile)) unlinkSync(anchorFile);
      } catch (err) {
        warn(`ledger.anchor: 还原锚点文件失败，请手工检查 ${relFile}：${errMessage(err)}`);
      }
    }
    function fail(code, detail) {
      bump('ledger.anchor.failed');
      warn(`ledger.anchor: ${code} —— ${detail}`);
      return { anchored: false, code, detail };
    }
  }

  /** 只读预览：下一次锚定**会**写什么（不落盘、不 commit，给人对着看）。 */
  async function preview() {
    const head = await ledger.getHead();
    if (!head) return { anchored: false, code: 'LEDGER_EMPTY' };
    const st = await ledger.stats();
    const existing = existsSync(anchorFile) ? readFileSync(anchorFile, 'utf8') : '';
    const prevRowCount = countDataRows(existing);
    const found = prevRowCount > 0 ? lastCommitOfAnchorFile() : { ok: true, commit: null };
    return {
      anchorFile: relFile,
      anchorSeq: prevRowCount + 1,
      seq: head.seq,
      entryCount: st.entries,
      headEntryHash: head.chain.entryHash,
      rollupRoot: head.chain.merkleRoot,
      prevCommit: prevRowCount === 0 ? 'GENESIS' : (found.commit ?? 'ANCHOR_FILE_UNCOMMITTED'),
    };
  }

  return { anchor, preview, anchorFile: relFile };
}
