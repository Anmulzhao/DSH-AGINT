/**
 * 纯函数层：把 git 的原始输出翻译成「人话 + 机器可判」的结构。
 *
 * 为什么要单独一层（不直接写在工具里）：
 *   1) 这一层不碰 fs、不碰 child_process ⇒ 可以用假数据单测；
 *   2) 「什么算需要部署 / 需要重启」的判定口径只此一份 —— 工具输出、周期检测的
 *      提示语、文档都从这里出，不会出现两处口径漂移。
 */

/** 版本号：形如 v0.15.0（取 VERSION 兼容矩阵表首行的 AGINT 列）。 */
const VERSION_RE = /^\|\s*(v\d+\.\d+\.\d+)\s*\|/m;

/**
 * 从 VERSION（AGINT ↔ dsh 兼容矩阵）里取仓库版本。
 *
 * 口径与 bin/agents-local-state.mjs 一致（AGENTS.md「仓库版本」就来自这里）。
 * @param {string} text
 * @returns {string|null}
 */
export function parseRepoVersion(text) {
  if (!text) return null;
  const m = VERSION_RE.exec(text);
  return m ? m[1] : null;
}

/**
 * 解析 `git log --format=%h%x09%ad%x09%s` 的输出。
 * @param {string} text
 * @returns {{sha: string, date: string, subject: string}[]}
 */
export function parseCommitLines(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    out.push({ sha: parts[0], date: parts[1], subject: parts.slice(2).join('\t') });
  }
  return out;
}

/**
 * 解析 `git status --porcelain` 的输出。
 * @param {string} text
 * @returns {{count: number, files: {code: string, path: string}[]}}
 */
export function summarizeGitStatus(text) {
  const files = [];
  for (const line of (text || '').split('\n')) {
    if (!line.trim()) continue;
    files.push({ code: line.slice(0, 2).trim(), path: line.slice(3).trim() });
  }
  return { count: files.length, files };
}
/**
 * 把变更文件清单分类，回答「这次更新要不要重新部署 / 要不要重启宿主」。
 *
 * 口径（改这里等于改部署判断，必须同步改 docs/plugins/agint-update-check.md）：
 *   - pluginCode  plugins/<x>/lib/** 插件代码  → 部署后**必须重启宿主**才生效
 *   - newPlugins 本地没有的新插件目录      → 部署后必须重启宿主
 *   - mount       cordis.patch.yml / presets/ → 挂载行变了，必须重新部署
 *   - installer   install/**                → 安装器变了，要重新部署
 *   - docsOnly    只有文档改动              → 不必部署（但仍可同步仓库）
 *
 * @param {string[]} files git diff --name-only 的输出（已去空行）
 * @param {string[]} localPluginDirs 本地已存在的插件目录名
 */
/** 插件代码路径判定：plugins/<x>/lib/** 与 plugins/<x>/src/**。 */
function isPluginCodePath(p) {
  return p.includes('/lib/') || p.includes('/src/') || p.startsWith('lib/') || p.startsWith('src/');
}
/** 插件元数据路径判定：manifest.json / package.json。 */
function isPluginMetaPath(p) {
  const name = p.slice(p.lastIndexOf('/') + 1);
  return name === 'manifest.json' || name === 'package.json';
}
export function classifyChanges(files, localPluginDirs = []) {
  const known = new Set(localPluginDirs);
  const out = {
    total: (files || []).length,
    pluginCode: [],
    newPlugins: [],
    pluginMeta: [],
    mount: false,
    installer: false,
    docsOnly: (files || []).length > 0,
    other: [],
  };
  for (const raw of files || []) {
    const p = String(raw).replace(/\\/g, '/');
    if (p.startsWith('plugins/')) {
      const seg = p.slice('plugins/'.length).split('/');
      const plugin = seg[0];
      if (!known.has(plugin)) {
        if (!out.newPlugins.includes(plugin)) out.newPlugins.push(plugin);
        out.docsOnly = false;
        continue;
      }
      if (isPluginCodePath(p)) { out.pluginCode.push(p); out.docsOnly = false; continue; }
      if (isPluginMetaPath(p)) { out.pluginMeta.push(p); out.docsOnly = false; continue; }
      out.other.push(p);
      continue;
    }
    if (p === 'cordis.patch.yml' || p.startsWith('presets/')) { out.mount = true; out.docsOnly = false; continue; }
    if (p.startsWith('install/')) { out.installer = true; out.docsOnly = false; continue; }
    if (p.startsWith('docs/') || p.startsWith('wiki/') || p.endsWith('.md')) continue;
    out.other.push(p);
    out.docsOnly = false;
  }
  return out;
}

/**
 * 由分类结果推出「要不要部署 / 要不要重启」以及人话理由。
 * @param {object} changes classifyChanges 的结果
 * @returns {{needsDeploy: boolean, needsRestart: boolean, reasons: string[]}}
 */
export function deriveImpact(changes) {
  const c = changes || {};
  const reasons = [];
  let needsDeploy = false;
  let needsRestart = false;
  const code = c.pluginCode || [];
  const news = c.newPlugins || [];
  if (code.length) {
    needsDeploy = true; needsRestart = true;
    reasons.push(`插件代码变更 ${code.length} 处（部署后必须重启宿主才生效）`);
  }
  if (news.length) {
    needsDeploy = true; needsRestart = true;
    reasons.push(`新增插件 ${news.join('、')}（需重新部署 + 重启宿主）`);
  }
  if (c.mount) {
    needsDeploy = true; needsRestart = true;
    reasons.push('挂载行 / preset 变更（需重新部署 + 重启宿主）');
  }
  if (c.installer) {
    needsDeploy = true;
    reasons.push('安装器变更（需重新部署）');
  }
  if (!needsDeploy && c.docsOnly) reasons.push('仅文档变更：同步仓库即可，不必部署');
  if (!reasons.length) reasons.push('无影响部署的改动');
  return { needsDeploy, needsRestart, reasons };
}
/**
 * 列出「现在不能安全快进」的原因。
 *
 * 这些是**给人看的阻断理由**，不是拒绝理由 —— 真正的拒绝在 apply 侧（confirm / 分叉 / 脏工作区）。
 * @param {object} report inspectRepo 的结果
 * @returns {string[]}
 */
export function buildBlockers(report) {
  const r = report || {};
  const cmp = r.comparison || {};
  const dirty = r.local?.dirty || { count: 0 };
  const out = [];
  if (dirty.count > 0) {
    out.push(`工作区有 ${dirty.count} 处未提交改动（快进合并会失败，需先提交或 stash）`);
  }
  if ((cmp.ahead || 0) > 0 && (cmp.behind || 0) > 0) {
    out.push(`本地与远端已分叉（ahead ${cmp.ahead} / behind ${cmp.behind}），快进合并不成立，需人工决定 merge 还是 rebase`);
  } else if ((cmp.ahead || 0) > 0) {
    out.push(`本地有 ${cmp.ahead} 个未推送提交，快进合并会改写本地历史，需人工确认`);
  }
  return out;
}

/**
 * 生成「问用户的那句话」。
 *
 * 没有更新时返回 null —— **不要**无更新也问一句，否则每次都是噪音。
 * @param {object} report inspectRepo 的结果
 * @returns {string|null}
 */
export function buildQuestion(report) {
  const r = report || {};
  if (r.error) return null;
  const cmp = r.comparison || {};
  if (!cmp.behind) return null;
  const from = r.local?.version || r.local?.shortSha || 'local';
  const to = r.upstream?.version || r.upstream?.shortSha || 'remote';
  return `检测到 agint 远端有 ${cmp.behind} 个新提交（本地 ${from} → 远端 ${to}）。是否现在更新并部署？`;
}

/**
 * 生成周期检测用的通知文案（投递给用户会话）。
 *
 * 文案纪律（agint-restart v0.7.1 事故教训）：只写状态，不写「请自主决定下一步」这类
 * 行动指令 —— 那会被模型当成新指令执行，形成自维持循环。这里明确要求用户回话。
 * @param {object} report inspectRepo 的结果
 * @returns {string|null}
 */
export function buildNoticeText(report) {
  const r = report || {};
  if (r.error) return null;
  const cmp = r.comparison || {};
  if (!cmp.behind) return null;
  const from = r.local?.version || r.local?.shortSha || 'local';
  const to = r.upstream?.version || r.upstream?.shortSha || 'remote';
  const impact = (r.impact?.reasons || []).join('；');
  return [
    '[agint-update-check] 检测到仓库有未同步的新版本。',
    `本地 ${from} → 远端 ${to}，落后 ${cmp.behind} 个提交。`,
    impact ? `影响面：${impact}` : '',
    '需要更新时回复「更新 agint」；不需要就忽略这条。',
  ].filter(Boolean).join('\n');
}