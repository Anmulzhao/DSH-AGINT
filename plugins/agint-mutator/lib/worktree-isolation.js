/**
 * lib/worktree-isolation.js — W6（v0.7.0）：把 mutator 的「写 postimage」这一步挪进
 * 宿主 Git worktree 里做，验完再一次性写回主工作区。
 *
 * ══ 为什么（不是"用上新能力"，是修一个真实的并发窗口）══
 *
 * `commit()` 当前顺序是：
 *   ① 读 preimage → ② **直接写主工作区** postimage → ③ sandbox 验 → ④ policy 决策
 *   → ⑤ REJECT 就把 preimage 写回去。
 *
 * ②③ 之间有一个**真实时间窗**：postimage 已经躺在主工作区里，而 sandbox 是子进程 +
 * 30s 超时（`agint-quality-sandbox` 的 MODE_PRESETS）。这段时间里：
 *   - 另一个 agent 会话（本仓有并发写者）读到的就是**未验证的** postimage —— 它把这
 *     当成"当前代码"继续改，改完提交；
 *   - 人工 `git status` / 打包 / 部署脚本拿到的是半成品；
 *   - 进程在这期间被杀（本机是有前科的：inspector fatal、SAFE_DELETE 拦收尾）⇒ 主工作区
 *     永久留下未验证内容，且 commits 表里**没有**这条记录 ⇒ `rollback()` 查不到 ⇒ 无凭据回滚。
 *
 * worktree 隔离把 ②③ 挪到一个独立 checkout 里：主工作区在整个验证期间**不变**，
 * 验证通过才写回（写回是一瞬间的同步动作，窗口从"30 秒级"压到"亚毫秒级"）。
 *
 * ══ 边界（这三条不是可选项）══
 *
 * 1. ⛔ `ctx.worktrees.create()` **会调 `workingDirectory.set(agent, path)`** ——
 *    它切换的是**调用者 agent 的当前工作目录**，不是某个局部变量。
 *    （站源码：`dsh-experimental-worktree/lib/index.js:357` `path: await this.ctx.workingDirectory.set(agent, path, signal)`）
 *    所以用完必须 `set` 回来；且**必须放在 try/finally 里**，否则一次失败就把整个
 *    agent 会话的 cwd 永久挪到 `.agents/worktrees/<branch>` 下面。
 *    拿不到 workingDirectory 服务时**整个隔离路径直接放弃**（降级回直写），
 *    绝不"先建了再说"—— 建了换不回来比不建糟得多。
 *
 * 2. ⛔ 服务**只有 `create()`，没有 remove/prune**（源码里除了 createCheckout 没有任何
 *    清理入口，且 create 的失败路径明确写 "Any created checkout and branch are retained"）。
 *    所以本模块自己用 `git worktree remove --force` + `git branch -D` 清，
 *    并把它写成 best-effort：清理失败只记 warning，**不影响 commit 结果**。
 *
 * 3. ⛔ 主工作区 HEAD ≠ worktree 的 `baseCommit` ⇒ 拒绝隔离。
 *    理由：preimage 是从**主工作区**读的。若两者 HEAD 不同，worktree 里那个文件的内容
 *    可能根本不是 preimage（比如主工作区有未提交改动、或停在别的 commit）。
 *    此时在主工作区写回 postimage，等于用一份"基于旧 base 算出的 postimage"覆盖
 *    "基于新 base 的当前内容" —— 静默丢改动。**降级回直写**（那才是原来的语义）。
 *
 * 4. 路径护栏：`targetPath` 必须落在 worktree 内（`..` / 绝对路径直接拒）。
 *    `deriveTargetPath` 目前只产出三种固定形态，但它是**字符串拼**出来的
 *    （`plugins/${pluginId}/prompts/${p.promptId}.md`，promptId 来自 payload），
 *    而 promptId 是 caller 传的。这里不假设它干净。
 */

import * as nodeFs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isAbsolute, resolve, sep, dirname } from 'node:path';

/** 默认值刻意保守：worktree 只在这一批 mutation 期间存在，名字带前缀便于人工辨认。 */
const DEFAULT_BRANCH_PREFIX = 'agint-mut/';

/**
 * 纯函数：把 targetPath 安全地拼到 root 下。越界直接抛。
 * @param {string} root    worktree 绝对路径
 * @param {string} targetPath 仓库相对路径
 * @returns {string} 绝对路径
 */
export function resolveInside(root, targetPath) {
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    throw new Error('worktree-isolation: targetPath 为空');
  }
  if (isAbsolute(targetPath)) {
    throw new Error(`worktree-isolation: targetPath 不允许是绝对路径（${targetPath}）`);
  }
  const absRoot = resolve(root);
  const abs = resolve(absRoot, targetPath);
  // 加 sep 防 `/repo-evil` 前缀骗过 `/repo` 这种 startswith 检查
  if (abs !== absRoot && !abs.startsWith(absRoot + sep)) {
    throw new Error(`worktree-isolation: targetPath 越出 worktree 根（${targetPath}）`);
  }
  return abs;
}

/**
 * 跑一条 git 命令（不起 shell，argv 直传，避免任何注入面）。
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, code: number|null }>}
 */
function runGit(args, { cwd, timeoutMs = 30000 } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // 与 dsh worktree 服务同口径：禁掉一切"会让 git 行为不可预期"的选择器
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_INDEX_FILE: undefined,
          GIT_TERMINAL_PROMPT: '0',
        },
      });
    } catch (err) {
      resolvePromise({ ok: false, stdout: '', stderr: err.message, code: null });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      finish({ ok: false, stdout, stderr: `${stderr}\n[timeout ${timeoutMs}ms]`, code: null });
    }, timeoutMs);
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('error', (err) => finish({ ok: false, stdout, stderr: stderr + err.message, code: null }));
    child.on('close', (code) => finish({ ok: code === 0, stdout, stderr, code }));
  });
}

/**
 * 读主工作区 HEAD（短 hash 足够比对；用 full 更稳）。
 * @returns {Promise<string|null>} 不是 git 仓库 / git 不可用时返回 null
 */
export async function readHead(repoRoot) {
  const r = await runGit(['rev-parse', 'HEAD'], { cwd: repoRoot, timeoutMs: 10000 });
  if (!r.ok) return null;
  const v = r.stdout.trim();
  return v.length > 0 ? v : null;
}

/**
 * best-effort 清理：worktree checkout + 分支。
 *
 * ⛔ 必须 separate 两次：`git worktree remove` 只删 checkout 目录，**分支还在**；
 *    残留分支会让下次同名的 `create()` fail（服务侧 `show-ref --verify` 直接抛）。
 *    本模块的 branch 名带随机段，撞名概率极低，但人工清理时不删干净就是留垃圾。
 */
export async function disposeWorktree({ repoRoot, path, branch }) {
  const notes = [];
  const rm = await runGit(['worktree', 'remove', '--force', '--', path], { cwd: repoRoot });
  if (!rm.ok) notes.push(`worktree remove 失败：${rm.stderr.trim()}`);
  // prune 兜底：remove 失败时 admin 元数据可能残留，prune 让 git 自己收拾
  const pr = await runGit(['worktree', 'prune'], { cwd: repoRoot });
  if (!pr.ok) notes.push(`worktree prune 失败：${pr.stderr.trim()}`);
  if (branch) {
    const br = await runGit(['branch', '-D', '--', branch], { cwd: repoRoot });
    if (!br.ok) notes.push(`branch -D ${branch} 失败：${br.stderr.trim()}`);
  }
  return notes;
}

/**
 * 在 worktree 里跑一次「准备 → 写 postimage → 交给你验」，然后把结果交回调用方决定是否写回。
 *
 * 调用方（`commit()`）保留**全部**业务判断：preimage 比较、policy 决策、commits 表写入、
 * REJECT 恢复都不在这里。本模块只做一件事：**让 postimage 在被验证之前不落地主工作区**。
 *
 * @param {object} opts
 * @param {object} opts.ctx            cordis ctx（读 worktrees / workingDirectory / sandbox）
 * @param {string} opts.repoRoot       主工作区根（绝对路径）
 * @param {string} opts.targetPath     仓库相对路径
 * @param {string} opts.postimage      生成好的 postimage 内容
 * @param {string} [opts.branchPrefix] 分支名前缀
 * @param {(verify: {absTargetInWorktree: string, worktreePath: string}) => Promise<any>} [opts.verify]
 *        可选：在 worktree 里做验证（默认不传 —— commit() 自己拿 absTargetInWorktree 去调 sandbox）
 * @param {object} [opts.fs]           注入 fs（测试用）
 * @returns {Promise<{
 *   ok: boolean,
 *   reason?: string,
 *   worktreePath?: string,
 *   branch?: string,
 *   baseCommit?: string,
 *   absTargetInWorktree?: string,
 *   headBefore?: string,
 *   cleaned?: string[],
 *   verifyResult?: any,
 * }>}
 *   ok=false 的语义是「隔离没做成，可以安全地退回直写」，**不是**「commit 失败」。
 *   调用方必须区分这两件事。
 */
export async function runIsolatedWrite({
  ctx,
  repoRoot,
  targetPath,
  postimage,
  branchPrefix = DEFAULT_BRANCH_PREFIX,
  verify,
  fs = nodeFs,
}) {
  const worktrees = ctx && typeof ctx.get === 'function' ? ctx.get('worktrees') : null;
  if (!worktrees || typeof worktrees.create !== 'function') {
    return { ok: false, reason: 'worktrees-service-unavailable' };
  }
  // ⛔ 见文件头边界 1：拿不回 cwd 就不能开工，否则 create() 建完换不回来
  const wd = ctx && typeof ctx.get === 'function' ? ctx.get('workingDirectory') : null;
  if (!wd || typeof wd.set !== 'function' || typeof wd.ensure !== 'function') {
    return { ok: false, reason: 'working-directory-service-unavailable' };
  }
  const agent = ctx.agent ?? ctx.session?.agent ?? null;
  if (!agent) {
    // create(agent, …) 的第一个参数决定「源仓库」与「文件策略」；没有它连仓库都定位不到
    return { ok: false, reason: 'no-agent-on-ctx' };
  }

  let path;
  try {
    path = resolveInside(repoRoot, targetPath);
  } catch (err) {
    return { ok: false, reason: `target-outside-repo: ${err.message}` };
  }

  // ⛔ 边界 3：主工作区 HEAD 必须先记下来，create 之后与 baseCommit 比对
  const headBefore = await readHead(repoRoot);
  if (headBefore === null) {
    return { ok: false, reason: 'repo-not-a-git-worktree' };
  }

  let originalCwd = null;
  let originalCwdRead = false;
  try {
    originalCwd = await wd.ensure(agent);
    originalCwdRead = true;
  } catch {
    return { ok: false, reason: 'working-directory-ensure-failed' };
  }

  const branch = `${branchPrefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let created = null;
  try {
    created = await worktrees.create(agent, { name: branch, from: 'HEAD' });
  } catch (err) {
    // create 失败时 cwd **可能**已经被改（服务是「Git 成功后才 set」，但失败路径不保证），
    // 所以这里也 set 回来。换回失败就如实报出来，别装作没事。
    const restoreErr = await restoreCwd(wd, agent, originalCwd, originalCwdRead);
    return { ok: false, reason: `worktree-create-failed: ${err.message}${restoreErr ? ` | cwd 还原失败: ${restoreErr}` : ''}` };
  }

  // ⛔ 用 out 变量而不是在 try 里直接 return：finally 会先跑完清理，
  //    清理结果（cleanupNotes）必须能进返回值，而 finally 改不了已算出的 return 值。
  const out = {
    ok: false,
    reason: 'unknown',
    worktreePath: created.path,
    branch: created.branch,
    baseCommit: created.baseCommit,
    headBefore,
    cleanupNotes: [],
  };
  try {
    // ⛔ 边界 3：baseCommit 必须等于 headBefore
    if (created.baseCommit && created.baseCommit !== headBefore) {
      out.reason = `base-commit-mismatch: worktree base=${created.baseCommit.slice(0, 12)} 主工作区 HEAD=${headBefore.slice(0, 12)}`;
      return out;
    }

    let absTarget;
    try {
      absTarget = resolveInside(created.path, targetPath);
    } catch (err) {
      out.reason = `target-outside-worktree: ${err.message}`;
      return out;
    }

    // —— 在 worktree 里写 postimage（主工作区在这里完全没被碰）
    await fs.mkdir(dirname(absTarget), { recursive: true });
    await fs.writeFile(absTarget, postimage, 'utf8');

    // —— 读回来核对：写进去的和要写的是不是同一份。
    //    worktree 是 fresh checkout，可能挂了 clean/smudge filter（服务侧已尽力关掉，
    //    但不假设）；读回不一致就说明这个 checkout 的字节语义与主工作区不同，
    //    此时写回主工作区会得到与验证时不同的内容 ⇒ 宁可降级。
    const readback = await fs.readFile(absTarget, 'utf8');
    if (readback !== postimage) {
      out.reason = 'worktree-readback-mismatch';
      return out;
    }

    if (typeof verify === 'function') {
      out.verifyResult = await verify({ absTargetInWorktree: absTarget, worktreePath: created.path });
    }

    out.ok = true;
    out.reason = undefined;
    out.absTargetInWorktree = absTarget;
    return out;
  } catch (err) {
    out.ok = false;
    out.reason = `worktree-write-failed: ${err.message}`;
    return out;
  } finally {
    // ⛔ 边界 1：cwd 还原放 finally 第一件事 —— 后面的清理再失败也不能连累它
    const restoreErr = await restoreCwd(wd, agent, originalCwd, originalCwdRead);
    if (restoreErr) out.cleanupNotes.push(`cwd 还原失败：${restoreErr}`);
    // ⛔ 边界 2：服务没有 remove，自己清
    if (created?.path) {
      const notes = await disposeWorktree({ repoRoot, path: created.path, branch: created.branch });
      out.cleanupNotes.push(...notes);
    }
  }
}

async function restoreCwd(wd, agent, originalCwd, originalCwdRead) {
  if (!originalCwdRead || typeof originalCwd !== 'string' || originalCwd.length === 0) {
    return '原 cwd 未知，无法还原';
  }
  try {
    await wd.set(agent, originalCwd);
    return null;
  } catch (err) {
    return err && err.message ? err.message : String(err);
  }
}
