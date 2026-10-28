/**
 * agint-update-check —— 检测 agint 远程仓的最新状态，并询问用户是否更新 / 部署。
 *
 * ## 这个插件解决什么
 * AGINT 仓库（DSH-AGINT）自己会往前走，但「仓库走到哪了」和「部署位跑到哪了」是两件事。
 * 以前只能靠人记得去 fetch、看 diff、再手动跑安装脚本。本插件把它变成三件事：
 *   1) 随时可问：模型调 agint_update_check → 拿到「本地/远端差多少、变了什么、要不要部署」；
 *   2) 主动发现：插件自带定时检查，发现远端有更新就往用户会话投一条「要不要更新」；
 *   3) 谨慎执行：agint_update_apply 必须 confirm=true；分叉 / 脏工作区一律拒绝并说明原因。
 *
 * ## 边界（红线）
 *   - 只读探测：ls-remote 纯读；fetch 只取对象，不动工作区、不切分支。
 *   - 写操作：只做「快进合并 + 装到部署位」，**不重启宿主** —— 重启交给 agint-restart 的
 *     restart_request（自带冷却与熔断）；否则本进程自杀、工具调用无返回。
 *   - 不猜：找不到仓库根 / 读不到 profile / 找不到 bash ⇒ 报错，不猜默认值去执行。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { inspectRepo, resolveRepoRoot } from './repo.js';
import { buildNoticeText } from './detect.js';
import { applyUpdate, readDeploymentProfile } from './apply.js';

const name = 'agint-update-check';

/** tools 必须 inject 才能注册 model-visible 工具。 */
const inject = ['tools'];

/** 周期检测间隔（默认 6 小时）。短到不漏、长到不吵。 */
export const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** 状态文件名（落在 $DSH_HOME/storages 下）。 */
export const STATE_FILE_NAME = 'agint_update_check.json';

/**
 * 归一化配置（不引 zod —— 少一个依赖少一份门禁负担）。
 * @param {object} config
 * @returns {object}
 */
export function normalizeConfig(config = {}) {
  const env = process.env;
  const dshHome = config.dshHome || env.DSH_HOME || null;
  return {
    repoRoot: config.repoRoot || null,
    remote: config.remote || 'origin',
    branch: config.branch || 'main',
    checkIntervalMs: Number.isFinite(config.checkIntervalMs) && config.checkIntervalMs > 0
      ? config.checkIntervalMs
      : DEFAULT_CHECK_INTERVAL_MS,
    dshHome,
    statePath: config.statePath || (dshHome ? join(dshHome, 'storages', STATE_FILE_NAME) : null),
    profile: config.profile || null,
    bashPath: config.bashPath || null,
    notify: config.notify !== false,
    autoCheck: config.autoCheck !== false,
  };
}

/**
 * 路径安全：target 必须在 root 之内。
 *
 * 为什么要自己判：Windows 上 `startsWith(root + '/')` 这类检查恒不成立（分隔符是 \\），
 * 且 `..` 能直接逃出根目录。state 文件路径来自配置，值得多这一道。
 *
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function isInside(root, target) {
  if (!root || !target) return false;
  const r = resolve(root);
  const t = resolve(target);
  if (t === r) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return t.startsWith(prefix);
}
/** 读状态文件（不存在 / 坏 JSON → null）。 */
export function readState(statePath) {
  if (!statePath) return null;
  try {
    if (!existsSync(statePath)) return null;
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

/** 写状态文件。路径越界直接拒绝（不写）。 */
export function writeState(statePath, state) {
  if (!statePath) return false;
  try {
    const dir = join(statePath, '..');
    if (!isInside(dir, statePath)) return false;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 把报告压成人话（工具 render 与通知文案共用同一份口径）。 */
export function formatReport(report) {
  if (!report) return ['agint_update_check: 无数据'];
  if (report.error) return [`agint_update_check: ${report.error}`];
  const cmp = report.comparison || {};
  const lines = [];
  lines.push(`仓库：${report.repo?.root ?? '?'}`);
  lines.push(`本地：${report.local?.version || report.local?.shortSha || '?'} (${report.local?.shortSha || '?'})　远端：${report.upstream?.version || report.upstream?.shortSha || '?'} (${report.upstream?.shortSha || '?'})`);
  lines.push(cmp.upToDate ? '状态：已是最新' : `状态：落后 ${cmp.behind ?? '?'} 个提交（本地另有 ${cmp.ahead ?? 0} 个未推送提交）`);
  const commits = report.commits || [];
  if (commits.length) {
    lines.push('最近变更：');
    for (const c of commits.slice(0, 10)) lines.push(`  ${c.sha} ${c.date} ${c.subject}`);
  }
  const reasons = report.impact?.reasons || [];
  if (reasons.length) lines.push(`影响面：${reasons.join('；')}`);
  const blockers = report.blockers || [];
  if (blockers.length) {
    lines.push('注意：');
    for (const b of blockers) lines.push(`  - ${b}`);
  }
  if (report.question) lines.push(report.question);
  return lines;
}
/** 存进状态文件的精简快照（不要把整个报告塞进去）。 */
export function summarizeReport(report) {
  const r = report || {};
  return {
    checkedAt: r.checkedAt || null,
    ok: !!r.ok,
    error: r.error || null,
    local: r.local ? { sha: r.local.sha, shortSha: r.local.shortSha, version: r.local.version, dirtyCount: r.local.dirty?.count ?? 0 } : null,
    upstream: r.upstream ? { sha: r.upstream.sha, shortSha: r.upstream.shortSha, version: r.upstream.version } : null,
    comparison: r.comparison || null,
    impact: r.impact || null,
    question: r.question || null,
  };
}

/**
 * 插件主体：注册 3 个 model-visible 工具 + 一个自持周期检查。
 *
 * @param {object} ctx cordis ctx
 * @param {object} config
 */
function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);
  const tools = ctx.tools;
  if (!tools || typeof tools.register !== 'function') return;

  /** agents 服务是软依赖：缺席时只是不主动投递，工具照常可用。 */
  let agentsScope = null;

  async function runCheck() {
    const root = resolveRepoRoot({ configRoot: cfg.repoRoot });
    if (!root) {
      return {
        ok: false,
        error: '找不到 AGINT 仓库根：config.repoRoot / 环境变量 AGINT_REPO_ROOT / AGINT_HOME 都没有指向一个同时含 .git 与 plugins/ 的目录',
        repo: null,
        local: null,
        upstream: null,
        comparison: { ahead: null, behind: null, upToDate: false, diverged: false },
        commits: [],
        changes: null,
        impact: null,
        blockers: [],
        question: null,
        checkedAt: new Date().toISOString(),
      };
    }
    const report = await inspectRepo({ root: root.root, remote: cfg.remote, branch: cfg.branch });
    report.repoRootSource = root.source;
    return report;
  }

  function loadState() {
    return readState(cfg.statePath) || { lastNotifiedSha: null, lastCheckedAt: null, lastReport: null };
  }

  function saveState(patch) {
    const next = { ...loadState(), ...patch };
    writeState(cfg.statePath, next);
    return next;
  }
  // ── 工具 1：检测（只读）────────────────────────────────────────────
  tools.register(defineTool({
    name: 'agint_update_check',
    description:
      '检测 AGINT 仓库（DSH-AGINT）的远端最新状态：本地 HEAD 与远端 main 相差多少提交、' +
      '变了哪些文件、是否需要重新部署与重启宿主。只读，不改仓库、不动工作区。' +
      '若发现更新，返回里的 question 字段就是**要问用户的那句话** —— 请据此向用户确认' +
      '「是否更新并部署」，得到明确同意后再调用 agint_update_apply。',
    parameters: {
      refresh: { type: 'boolean', description: 'true = 强制重新联网检测（默认也会联网，此参数用于忽略上次结果）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          upToDate: { type: 'boolean' },
          question: { type: 'string' },
          summary: { type: 'string' },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.summary || 'agint_update_check: 无输出' }],
    },
    async execute(args) {
      const report = await runCheck();
      const summary = formatReport(report).join('\n');
      saveState({ lastCheckedAt: report.checkedAt, lastReport: summarizeReport(report) });
      return {
        ok: report.ok,
        upToDate: !!(report.comparison && report.comparison.upToDate),
        question: report.question || '',
        summary,
        blockers: report.blockers || [],
        behind: report.comparison?.behind ?? null,
        ahead: report.comparison?.ahead ?? null,
        local: report.local || null,
        upstream: report.upstream || null,
        impact: report.impact || null,
        commits: report.commits || [],
        error: report.error || '',
      };
    },
  }));

  // ── 工具 2：更新 + 部署（写）────────────────────────────────────────
  tools.register(defineTool({
    name: 'agint_update_apply',
    description:
      '把 AGINT 仓库快进到远端最新，并（可选）装到部署位。' +
      '**ASK-gated — destructive write**：必须先把「有多少新提交、影响面是什么」告诉用户，' +
      '拿到明确同意后再调用，且必须传 confirm=true。' +
      '安全约束：本地有未推送提交（分叉）或工作区有未提交改动 ⇒ 拒绝并说明原因，' +
      '本工具不代劳 merge / rebase / stash。' +
      '本工具**不重启宿主**（dsh 插件不热重载）—— 请另用 restart_request {confirm:true} 重启。',
    parameters: {
      confirm: { type: 'boolean', required: true, description: '必须为 true，表示用户已明确同意本次更新与部署' },
      mode: { type: 'string', description: 'sync = 只把仓库同步到远端最新；deploy = 同步并装到部署位（默认 deploy）' },
      allowDirty: { type: 'boolean', description: 'true = 工作区有未提交改动时也强行尝试（默认拒绝）' },
      dryRun: { type: 'boolean', description: 'true = 只返回将要执行的计划，不真的执行' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          applied: { type: 'boolean' },
          stage: { type: 'string' },
          reason: { type: 'string' },
          nextStep: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.summary || JSON.stringify(v) }],
    },
    async execute(args) {
      if (!args || args.confirm !== true) {
        return {
          applied: false,
          stage: 'confirm',
          reason: '未确认：缺少 confirm=true。更新与部署是高风险动作，必须先向用户说明并取得同意。',
          nextStep: '',
          summary: 'agint_update_apply: 未执行（缺少 confirm=true）',
        };
      }
      const report = await runCheck();
      if (!report.ok) {
        return {
          applied: false,
          stage: 'check',
          reason: report.error || '检测失败',
          nextStep: '',
          summary: `agint_update_apply: 未执行 —— ${report.error || '检测失败'}`,
        };
      }
      const profile = cfg.profile || readDeploymentProfile(cfg.dshHome);
      const result = await applyUpdate({
        report,
        root: report.repo.root,
        mode: args.mode === 'sync' ? 'sync' : 'deploy',
        dshHome: cfg.dshHome,
        profile,
        bashPath: cfg.bashPath,
        allowDirty: args.allowDirty === true,
        dryRun: args.dryRun === true,
      });
      const lines = [
        `agint_update_apply: ${result.applied ? '已执行' : '未完成'}（阶段：${result.stage}）`,
        ...(result.reason ? [`原因：${result.reason}`] : []),
        ...(result.steps || []).map((s) => `  · ${s.title}`),
        ...(result.deploy?.tail || []).slice(-10).map((t) => `  | ${t}`),
        ...(result.nextStep ? [`下一步：${result.nextStep}`] : []),
      ];
      return { ...result, summary: lines.join('\n') };
    },
  }));
  // ── 工具 3：状态（不联网）──────────────────────────────────────────
  tools.register(defineTool({
    name: 'agint_update_status',
    description:
      '查看 agint-update-check 的上次检测结果（不联网、不动仓库）。' +
      '用于回答「上次查的时候远端是什么状态」「上次有没有通知过用户」。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.summary || 'agint_update_status: 无状态' }],
    },
    async execute() {
      const state = loadState();
      const r = state.lastReport || {};
      const lines = [];
      lines.push(`上次检测：${state.lastCheckedAt || '（还没检测过）'}`);
      if (r.error) lines.push(`错误：${r.error}`);
      if (r.comparison) {
        lines.push(`落后 ${r.comparison.behind ?? '?'} 个提交；本地另有 ${r.comparison.ahead ?? 0} 个未推送提交`);
      }
      lines.push(`已通知过的远端版本：${state.lastNotifiedSha || '（无）'}`);
      if (r.question) lines.push(r.question);
      return { ok: true, summary: lines.join('\n'), lastCheckedAt: state.lastCheckedAt || '', lastReport: r };
    },
  }));

  // ── 主动投递（agents 软依赖）──────────────────────────────────────
  function buildNoticeMessage(text) {
    return {
      role: 'user',
      id: randomUUID(),
      source: {
        kind: `plugin:${name}`,
        plugin: name,
        form: 'notice',
        summary: 'agint-update-check: 检测到远端有未同步的新版本',
      },
      content: [{ type: 'text', text }],
    };
  }

  function deliverNotice(text) {
    try {
      const agents = agentsScope?.agents;
      if (!agents) return false;
      const roots = typeof agents.roots === 'function' ? agents.roots() : [];
      const list = typeof agents.list === 'function' ? agents.list() : [];
      const target = (roots && roots[0]) || (list && list[0]) || null;
      if (!target) return false;
      const msg = buildNoticeMessage(text);
      if (typeof target.followup === 'function') { target.followup(msg); return true; }
      if (typeof target.inject === 'function') { target.inject(msg); return true; }
      return false;
    } catch {
      return false;
    }
  }

  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const report = await runCheck();
      saveState({ lastCheckedAt: report.checkedAt, lastReport: summarizeReport(report) });
      if (!cfg.notify || !report.ok) return;
      const behind = report.comparison?.behind || 0;
      if (!behind) return;
      const sha = report.upstream?.sha || null;
      const state = loadState();
      if (sha && state.lastNotifiedSha === sha) return;
      const text = buildNoticeText(report);
      if (!text) return;
      if (deliverNotice(text)) saveState({ lastNotifiedSha: sha });
    } catch {
      /* 周期检测失败不打扰用户（静默：下一轮再试） */
    } finally {
      ticking = false;
    }
  }

  // ── 定时器（must-dispose：dispose 时必须清掉）─────────────────────────
  if (cfg.autoCheck) {
    const start = () => { void tick(); };
    if (typeof ctx.setInterval === 'function') {
      const handle = ctx.setInterval(start, cfg.checkIntervalMs);
      ctx.effect(() => handle.dispose);
    } else {
      const handle = setInterval(start, cfg.checkIntervalMs);
      ctx.effect(() => () => clearInterval(handle));
    }
  }

  // agents 软注入：缺席时只是不主动投递，工具照常可用。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['agents'], (scope) => { agentsScope = scope; });
    } catch {
      /* 服务缺席：忽略 */
    }
  }
}

export { apply, inject, name };