/**
 * 执行层：把「检测结论」变成「真的把仓库同步 + 部署到部署位」。
 *
 * 红线（AGENTS.md）：
 *   - 更新/部署属高风险动作 ⇒ 必须显式 confirm=true，工具描述里写明 ASK-gated；
 *   - 每周自动部署 ≤ 3 次（跨周累计）—— 这里不做自动部署计数，只在返回值里
 *     提醒「本次是第 N 次本周部署」由调用方（agent）判断；
 *   - 本插件**不重启宿主**：重启由 agint-restart 的 restart_request 承担（自带冷却/熔断）。
 *     理由：本进程就是宿主，自杀式重启会让工具调用无返回、结果丢失。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { runGit } from './git.js';

/** 部署安装脚本的超时（毫秒）。装 100+ 插件 + 备份，给 15 分钟。 */
export const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000;


/**
 * 找可用的 bash。
 *
 * 本机 Git Bash 不在 PATH 里的概率不低（dsh 是 GUI 起的，继承不到用户 PATH）。
 * @returns {Promise<string|null>} bash 可执行文件路径
 */
export async function resolveBash(explicit, git = runGit) {
  if (explicit) return explicit;
  const probe = (cmd) => new Promise((resolve) => {
    execFile(cmd, ['-c', 'echo ok'], { timeout: 10_000, windowsHide: true }, (err) => resolve(!err));
  });
  if (await probe('bash')) return 'bash';
  return bashViaGit(git);
}

/** 从 git 的 exec-path 往上找 Git 根，猜 bin/bash（Git Bash 与 git 同根安装）。 */
async function bashViaGit(git) {
  const r = await git(['rev-parse', '--exec-path'], {});
  if (!r.ok) return null;
  let dir = String(r.stdout || '').trim();
  if (!dir) return null;
  for (let i = 0; i < 5; i++) {
    for (const name of ['bash.exe', 'bash']) {
      const candidate = join(dir, 'bin', name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return null;
}
/**
 * 读部署事实文件里的 profile 名。
 *
 * 真源 = $DSH_HOME/.agint-bundle/profile.json（install.sh 3.7 写入）。
 * 读不到就返回 null —— **不猜**：猜错 profile = 把插件装到另一个 profile 去。
 * @param {string} dshHome
 * @returns {string|null}
 */
export function readDeploymentProfile(dshHome) {
  if (!dshHome) return null;
  try {
    const raw = readFileSync(join(dshHome, '.agint-bundle', 'profile.json'), 'utf8');
    const doc = JSON.parse(raw);
    return typeof doc?.profile === 'string' && doc.profile ? doc.profile : null;
  } catch {
    return null;
  }
}

/**
 * 生成执行计划（dry-run 用）。
 *
 * @param {object} report inspectRepo 的结果
 * @param {{mode?: string, allowDirty?: boolean, profile?: string|null}} [opts]
 * @returns {{allowed: boolean, reason: string|null, steps: object[]}}
 */
export function planApply(report, opts = {}) {
  const mode = opts.mode || 'deploy';
  const steps = [];
  const r = report || {};
  if (r.error) return { allowed: false, reason: r.error, steps };
  const cmp = r.comparison || {};
  if (!cmp.behind) return { allowed: false, reason: '远端没有新提交，无需更新', steps };
  if ((cmp.ahead || 0) > 0) {
    return {
      allowed: false,
      reason: `本地有 ${cmp.ahead} 个未推送提交，快进合并会改写本地历史 —— 需要人工决定 merge 还是 rebase，本工具不代劳`,
      steps,
    };
  }
  const dirty = r.local?.dirty?.count || 0;
  if (dirty > 0 && !opts.allowDirty) {
    return {
      allowed: false,
      reason: `工作区有 ${dirty} 处未提交改动，快进合并会被 git 拒绝；请先提交或 stash（或显式 allowDirty=true 强行尝试）`,
      steps,
    };
  }
  steps.push({ id: 'fetch', title: `拉取远端对象（${r.upstream?.shortSha}）` });
  steps.push({ id: 'ff', title: `快进合并到 ${r.upstream?.shortSha}` });
  if (mode === 'deploy') {
    steps.push({ id: 'deploy', title: `install/install.sh --profile=${opts.profile || '(待探测)'}` });
    steps.push({ id: 'restart', title: '重启宿主使部署生效（restart_request，另行确认）' });
  }
  return { allowed: true, reason: null, steps };
}
/**
 * 快进合并到指定 sha。
 *
 * 用 merge --ff-only 而不是 pull：pull 会隐式 fetch、还可能走 merge 策略；
 * merge --ff-only 失败就失败，**绝不产生 merge commit**（改写历史是人工决策）。
 *
 * @param {{root: string, sha: string, git?: Function}} args
 */
export async function fastForward({ root, sha, git = runGit }) {
  return git(['merge', '--ff-only', sha], { cwd: root, timeoutMs: 60_000 });
}

/**
 * 跑 install/install.sh 把仓库内容铺到部署位。
 *
 * 只装不重启 —— 重启是宿主级动作，交给 agint-restart 的 restart_request。
 *
 * @param {{root: string, profile: string|null, dshHome?: string, bashPath?: string, timeoutMs?: number}} args
 * @returns {Promise<{ok: boolean, code: number, error: string|null, tail: string[]}>}
 */
export async function runDeploy({ root, profile, dshHome, bashPath, timeoutMs = DEPLOY_TIMEOUT_MS }) {
  const bash = await resolveBash(bashPath);
  if (!bash) {
    return { ok: false, code: 127, error: '找不到 bash（PATH 里没有，Git Bash 常见位置也没有）', tail: [] };
  }
  if (!profile) {
    return { ok: false, code: 2, error: '读不到部署 profile（$DSH_HOME/.agint-bundle/profile.json 缺失）—— 不猜 profile', tail: [] };
  }
  const script = join(root, 'install', 'install.sh');
  if (!existsSync(script)) {
    return { ok: false, code: 2, error: `安装脚本不存在：${script}`, tail: [] };
  }
  const env = { ...process.env };
  if (dshHome) env.DSH_HOME = dshHome;
  // install.sh 语义：AGINT_HOME = 源码根（不是数据根）。
  env.AGINT_HOME = root;
  // Git Bash 不认反斜杠路径 → 统一转正斜杠。
  const args = [script.replace(/\\/g, '/'), `--profile=${profile}`];
  const r = await new Promise((resolve) => {
    execFile(
      bash,
      args,
      { cwd: root, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          error: err ? (err.message || String(err)) : null,
        });
      },
    );
  });
  const combined = `${r.stdout}\n${r.stderr}`.split('\n');
  return { ok: r.ok, code: r.code, error: r.error, tail: combined.slice(-60).filter((s) => s.trim()) };
}

/**
 * 执行更新（同步 + 可选部署）。
 *
 * @param {object} args
 * @returns {Promise<object>}
 */
export async function applyUpdate(args) {
  const {
    report,
    root,
    mode = 'deploy',
    dshHome,
    profile,
    bashPath,
    allowDirty = false,
    dryRun = false,
    git = runGit,
  } = args;
  const plan = planApply(report, { mode, allowDirty, profile });
  if (!plan.allowed) {
    return { applied: false, stage: 'plan', reason: plan.reason, steps: plan.steps };
  }
  if (dryRun) {
    return { applied: false, stage: 'dry-run', reason: null, steps: plan.steps };
  }
  const sha = report?.upstream?.sha;
  const ff = await fastForward({ root, sha, git });
  if (!ff.ok) {
    return {
      applied: false,
      stage: 'fast-forward',
      reason: `快进合并失败：${(ff.stderr || ff.error || "").toString().trim()}`,
      steps: plan.steps,
    };
  }
  if (mode !== 'deploy') {
    return {
      applied: true,
      stage: 'sync',
      reason: null,
      steps: plan.steps,
      nextStep: '仓库已同步到远端最新；如需让部署位生效请再跑一次 mode=deploy',
    };
  }
  const deploy = await runDeploy({ root, profile, dshHome, bashPath });
  return {
    applied: deploy.ok,
    stage: 'deploy',
    reason: deploy.ok ? null : `部署失败：${deploy.error || ""}（exit ${deploy.code}）`,
    steps: plan.steps,
    deploy: { ok: deploy.ok, code: deploy.code, tail: deploy.tail },
    nextStep: deploy.ok
      ? '部署位已更新；dsh 插件不热重载，需要重启宿主才生效（restart_request {confirm:true}）'
      : '部署未完成：看 deploy.tail 定位；部署位有自动备份，可按 safe-update.sh rollback 回滚',
  };
}