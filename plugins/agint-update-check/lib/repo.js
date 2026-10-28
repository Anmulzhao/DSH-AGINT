/**
 * 仓库探测层：把 git 跑起来，产出结构化报告。
 *
 * 与 detect.js（纯函数）的分工：这一层碰 fs 与子进程，detect.js 只做翻译。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runGit, gitOut } from './git.js';
import {
  parseRepoVersion,
  parseCommitLines,
  summarizeGitStatus,
  classifyChanges,
  deriveImpact,
  buildBlockers,
  buildQuestion,
} from './detect.js';

/** 判断目录像不像 AGINT 仓库根：既有 .git 也有 plugins/。 */
export function looksLikeRepo(dir) {
  if (!dir) return false;
  try {
    return existsSync(join(dir, '.git')) && existsSync(join(dir, 'plugins'));
  } catch {
    return false;
  }
}

/**
 * 找仓库根。优先级：config → AGINT_REPO_ROOT → AGINT_HOME。
 *
 * 每个候选都必须过 looksLikeRepo —— 本机 AGINT_HOME 指的是**数据根**（D:/DSH/AGINT-date），
 * 不是仓库根；指错会把「检测远端」变成对空目录的一通操作，还报「已更新」。
 *
 * @param {{configRoot?: string, env?: Record<string,string|undefined>}} [opts]
 * @returns {{root: string, source: string}|null}
 */
export function resolveRepoRoot({ configRoot, env = process.env } = {}) {
  const candidates = [];
  if (configRoot) {
    const absCfg = resolve(configRoot);
    // 显式 config 优先：给错了就报「找不到仓库根」，不悄悄回退到环境变量
    // （本机 AGINT_HOME 指向的是数据根，回退会找错地方）。
    return looksLikeRepo(absCfg) ? { root: absCfg, source: 'config' } : null;
  }
  if (env.AGINT_REPO_ROOT) candidates.push({ root: env.AGINT_REPO_ROOT, source: 'AGINT_REPO_ROOT' });
  if (env.AGINT_HOME) candidates.push({ root: env.AGINT_HOME, source: 'AGINT_HOME' });
  for (const c of candidates) {
    const abs = resolve(c.root);
    if (looksLikeRepo(abs)) return { root: abs, source: c.source };
  }
  return null;
}

/** 本地插件目录名（用来识别远端新增的插件）。 */
export function listLocalPlugins(root) {
  try {
    return readdirSync(join(root, 'plugins'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('agint-'))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** 读 VERSION 里的仓库版本（兼容矩阵表首行）。 */
export function readRepoVersion(root) {
  try {
    return parseRepoVersion(readFileSync(join(root, 'VERSION'), 'utf8'));
  } catch {
    return null;
  }
}

/** 从 `git ls-remote` 输出里取 sha。 */
export function parseLsRemoteSha(stdout) {
  const line = String(stdout || '').trim().split('\n')[0] || '';
  const sha = line.split(/\s+/)[0] || '';
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}
/**
 * 主探测：读本地 HEAD、查远端 head、算 ahead/behind、看变更影响面。
 *
 * 只读语义（重要）：
 *   - ls-remote 纯读，不碰本地任何引用；
 *   - fetch 只在「远端 != 本地」时才发生，且只取对象（--no-tags），
 *     不切分支、不动工作区；
 *   - 快路径（远端 == 本地）全程零写入、零网络写。
 *
 * @param {{root: string, remote?: string, branch?: string, fetch?: boolean, git?: Function}} opts
 * @returns {Promise<object>} 报告
 */
export async function inspectRepo({ root, remote = 'origin', branch = 'main', fetch = true, git = runGit } = {}) {
  const cwd = { cwd: root };
  const report = {
    ok: false,
    repo: { root, remote, branch },
    checkedAt: new Date().toISOString(),
    error: null,
    local: null,
    upstream: null,
    comparison: { ahead: null, behind: null, upToDate: false, diverged: false },
    commits: [],
    changes: null,
    impact: null,
    blockers: [],
    question: null,
  };

  const head = await gitOut(['rev-parse', 'HEAD'], cwd);
  if (!head) {
    report.error = '仓库不可用：git rev-parse HEAD 失败（不是 git 仓库，或 git 不在 PATH）';
    return report;
  }
  const curBranch = await gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const statusRes = await git(['status', '--porcelain'], cwd);
  // 用原始 stdout（不 trim）：porcelain 首行的状态码前缀靠前导空格定位
  const dirtyRaw = statusRes.ok ? statusRes.stdout : '';
  report.local = {
    sha: head,
    shortSha: head.slice(0, 7),
    branch: curBranch || branch,
    version: readRepoVersion(root),
    dirty: summarizeGitStatus(dirtyRaw),
  };

  // 远端 head：ls-remote 纯读。
  const ls = await git(['ls-remote', '--heads', remote, branch], { ...cwd, timeoutMs: 30_000 });
  const remoteSha = ls.ok ? parseLsRemoteSha(ls.stdout) : null;
  report.upstream = {
    sha: remoteSha,
    shortSha: remoteSha ? remoteSha.slice(0, 7) : null,
    version: null,
    reachable: !!ls.ok && !!remoteSha,
    error: ls.ok ? (remoteSha ? null : `远端没有分支 ${remote}/${branch}`) : (ls.error || 'ls-remote 失败'),
  };
  if (!remoteSha) {
    report.error = `无法读取远端状态：${report.upstream.error}`;
    report.blockers = buildBlockers(report);
    return report;
  }

  // 只有远端 != 本地才 fetch（快路径零写入）。
  let fetchError = null;
  if (remoteSha !== head && fetch) {
    const f = await git(['fetch', '--no-tags', '--quiet', remote, branch], { ...cwd, timeoutMs: 120_000 });
    if (!f.ok) fetchError = f.error || 'fetch 失败';
  }

  const behindRaw = remoteSha === head ? '0' : await gitOut(['rev-list', '--count', `${head}..${remoteSha}`], cwd);
  const aheadRaw = await gitOut(['rev-list', '--count', `${remoteSha}..${head}`], cwd);
  const behind = behindRaw === null ? null : Number(behindRaw);
  const ahead = aheadRaw === null ? null : Number(aheadRaw);
  report.comparison = {
    ahead,
    behind,
    upToDate: behind === 0 && ahead === 0,
    diverged: (ahead || 0) > 0 && (behind || 0) > 0,
  };

  const commitText = (behind || 0) > 0
    ? await gitOut(['log', '--format=%h%x09%ad%x09%s', '--date=short', `${head}..${remoteSha}`], cwd)
    : null;
  report.commits = parseCommitLines(commitText).slice(0, 30);

  const fileText = (behind || 0) > 0
    ? await gitOut(['diff', '--name-only', head, remoteSha], cwd)
    : null;
  const files = fileText ? fileText.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  report.changes = classifyChanges(files, listLocalPlugins(root));
  report.impact = deriveImpact(report.changes);

  const versionText = await gitOut(['show', `${remoteSha}:VERSION`], cwd);
  report.upstream.version = parseRepoVersion(versionText);

  if (fetchError) {
    report.error = `取远端对象失败（fetch）：${fetchError}；只能确认远端 head=${remoteSha.slice(0, 7)}，无法计算差异`;
  }
  report.blockers = buildBlockers(report);
  report.question = buildQuestion(report);
  report.ok = true;
  return report;
}