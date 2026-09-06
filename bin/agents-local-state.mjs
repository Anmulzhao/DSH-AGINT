#!/usr/bin/env node
// AGENTS.md「本机实况」自动同步器
//
// 背景（2026-09-07 提案）：AGENTS.md 里的「本机实况快照」全是手写的，反复过期
// （例：文档写 13 个 preset tool rows，host 实际 16 个）。文档自己都写了三遍
// 「不要相信本文档字面，先实测 host 端」。本脚本把这件事自动化：
// 探测本机 host 真实状态 → 回写 AGENTS.md 文末标记块。
//
// 用法：
//   node bin/agents-local-state.mjs           # 探测并回写 AGENTS.md 标记块
//   node bin/agents-local-state.mjs --check   # 只检查是否过期；过期 exit 1，不写
//
// 设计约束：
// - 零依赖（仓库无 node_modules 也能跑）
// - 只动 BEGIN/END 标记之间的内容，绝不碰 AGENTS.md 其他部分
// - hash 比对用 lib/index.js（2026-09-04「仓库 ≠ host 加载点」教训的自动化）

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS_MD = join(REPO_ROOT, 'AGENTS.md');
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const HOST_PLUGINS_DIR = join(DSH_HOME, 'profiles', 'web', 'plugins');
const HOST_PRESET_DIR = join(DSH_HOME, '.agent-presets', 'agint');
const HOST_PATCH_YML = join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml');
const HOST_CRON_JSON = join(DSH_HOME, 'storages', 'agint_cron.json');
const REPO_PLUGINS_DIR = join(REPO_ROOT, 'plugins');

const BEGIN = '<!-- LOCAL-STATE:BEGIN (自动生成，勿手改) -->';
const END = '<!-- LOCAL-STATE:END -->';

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function listDirs(dir) {
  try {
    return readdirSync(dir).filter((n) => {
      try { return statSync(join(dir, n)).isDirectory(); } catch { return false; }
    });
  } catch { return []; }
}

// CHANGELOG 首个 `## vX.Y.Z` 优先（package.json 里是 cordis 脚手架版本 0.1.0，无意义）
function pluginVersion(pluginDir) {
  try {
    const cl = readFileSync(join(pluginDir, 'CHANGELOG.md'), 'utf8');
    const m = cl.match(/^##\s+(v[\d][\w.-]*)/m);
    if (m) return m[1];
  } catch { /* no changelog */ }
  try {
    const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
    return pkg.version ? `pkg:${pkg.version}` : '—';
  } catch { return '—'; }
}

function probePlugins(baseDir) {
  const out = new Map();
  for (const name of listDirs(baseDir)) {
    if (!name.startsWith('agint-')) continue;
    const dir = join(baseDir, name);
    const entry = join(dir, 'lib', 'index.js');
    out.set(name, {
      version: pluginVersion(dir),
      hasEntry: existsSync(entry),
      hash: existsSync(entry) ? sha256(entry) : null,
    });
  }
  return out;
}

function probe() {
  const host = probePlugins(HOST_PLUGINS_DIR);
  const repo = probePlugins(REPO_PLUGINS_DIR);

  // 仓库 ↔ host 漂移（只比对两侧都有 lib/index.js 的）
  const drift = [];
  for (const [name, h] of host) {
    const r = repo.get(name);
    if (h.hash && r && r.hash && h.hash !== r.hash) drift.push(name);
  }
  const hostOnly = [...host.keys()].filter((n) => !repo.has(n));
  const repoOnly = [...repo.keys()].filter((n) => !host.has(n));

  // preset tool rows
  let presetRows = [];
  try {
    const yml = readFileSync(join(HOST_PRESET_DIR, 'agent.cordis.yml'), 'utf8');
    presetRows = [...yml.matchAll(/^- id: (agint-[a-z0-9-]+)-tools\s*$/gm)].map((m) => m[1]);
  } catch { /* preset missing */ }

  // preset skills
  const presetSkills = listDirs(join(HOST_PRESET_DIR, 'skills'));

  // host patch agint 段
  let patchSegs = [];
  try {
    const patch = readFileSync(HOST_PATCH_YML, 'utf8');
    patchSegs = [...new Set([...patch.matchAll(/^\s*- id: (agint-[a-z0-9-]+)\s*$/gm)].map((m) => m[1]))];
  } catch { /* patch missing */ }

  // cron 实况（agint_cron.json → cron_state: job → lastRunAt/lastResult）
  const cronJobs = [];
  try {
    const cron = JSON.parse(readFileSync(HOST_CRON_JSON, 'utf8'));
    const state = (cron.tables && cron.tables.cron_state) || {};
    for (const [name, v] of Object.entries(state)) {
      cronJobs.push({
        name,
        lastRunAt: (v && v.lastRunAt) || null,
        lastResult: (v && v.lastResult) || null,
      });
    }
    cronJobs.sort((a, b) => (b.lastRunAt || '').localeCompare(a.lastRunAt || ''));
  } catch { /* cron storage missing */ }

  // 仓库 VERSION 首行版本
  let repoVersion = '—';
  try {
    const ver = readFileSync(join(REPO_ROOT, 'VERSION'), 'utf8');
    repoVersion = (ver.match(/\|\s*(v[\d][\w.-]*)\s*\|/) || [])[1] || '—';
  } catch { /* no VERSION */ }

  return { host, repo, drift, hostOnly, repoOnly, presetRows, presetSkills, patchSegs, cronJobs, repoVersion };
}

function render(p) {
  const now = new Date();
  const ts = `${now.toISOString().slice(0, 10)} ${now.toTimeString().slice(0, 5)} UTC`;

  const pluginList = [...p.host.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([n, v]) => `${n}@${v.version}`)
    .join('、');

  const syncLine = p.drift.length === 0 && p.hostOnly.length === 0 && p.repoOnly.length === 0
    ? `${p.host.size}/${p.repo.size} 个插件 lib/index.js 哈希一致，无漂移 ✅`
    : `⚠️ lib/index.js 哈希漂移：${p.drift.join('、') || '无'}`
      + (p.hostOnly.length ? `；仅 host 有：${p.hostOnly.join('、')}` : '')
      + (p.repoOnly.length ? `；仅仓库有：${p.repoOnly.join('、')}` : '');

  const cronLine = p.cronJobs.length === 0
    ? '（agint_cron.json 无 cron_state 或不可读）'
    : p.cronJobs
        .map((j) => {
          const t = j.lastRunAt ? j.lastRunAt.slice(0, 16).replace('T', ' ') + 'Z' : 'never';
          const bad = j.lastResult && j.lastResult !== 'ok' ? ` ⚠️${j.lastResult}` : '';
          return `${j.name} ${t}${bad}`;
        })
        .join('、');

  return [
    BEGIN,
    '## 本机实况（自动生成）',
    '',
    `> 本块由 \`bin/agents-local-state.mjs\` 探测本机 host 实测回写，最近一次：${ts}。`,
    '> 与上文任何手写快照冲突时，**以本块为准**。勿手改；更新方式：`node bin/agents-local-state.mjs`。',
    '> 注：本段是部署报告，不是通用文档 —— 面向本机部署实况；新读者请以上方通用描述为准。',
    '',
    `- **仓库版本**：${p.repoVersion}（VERSION 表首行）`,
    `- **DSH_HOME**：\`${DSH_HOME}\``,
    `- **仓库 ↔ host 同步**：${syncLine}`,
    `- **host 挂载插件**（${p.host.size} 个）：${pluginList}`,
    `- **preset tool rows**（${p.presetRows.length} 个）：${p.presetRows.join('、') || '无'}`,
    `- **preset skills**（${p.presetSkills.length} 个）：${p.presetSkills.join('、') || '无'}`,
    `- **cordis.patch.yml agint 段**（host web profile，${p.patchSegs.length} 个）：${p.patchSegs.join('、') || '无'}`,
    `- **cron 实况**（${p.cronJobs.length} 个 job，按最近 tick 排序）：${cronLine}`,
    '',
    END,
  ].join('\n');
}

function inject(block) {
  const doc = readFileSync(AGENTS_MD, 'utf8');
  const b = doc.indexOf(BEGIN);
  const e = doc.indexOf(END);
  let next;
  if (b !== -1 && e !== -1) {
    next = doc.slice(0, b) + block + doc.slice(e + END.length);
  } else {
    next = doc.replace(/\s*$/, '\n\n') + block + '\n';
  }
  if (next !== doc) writeFileSync(AGENTS_MD, next);
  return next !== doc;
}

const checkOnly = process.argv.includes('--check');
const p = probe();
const block = render(p);

if (checkOnly) {
  const doc = readFileSync(AGENTS_MD, 'utf8');
  const b = doc.indexOf(BEGIN);
  const e = doc.indexOf(END);
  const existing = b !== -1 && e !== -1 ? doc.slice(b, e + END.length) : null;
  if (existing === block) {
    console.log('OK: AGENTS.md 本机实况块与 host 实测一致，无漂移。');
    process.exit(0);
  }
  console.log('STALE: AGENTS.md 本机实况块过期（或缺失）。变化点：');
  if (existing) {
    for (const line of block.split('\n')) {
      if (line.startsWith(BEGIN) || line.startsWith(END) || line.startsWith('##')) continue;
      if (!existing.includes(line)) console.log('  + ' + line.slice(0, 160));
    }
    for (const line of existing.split('\n')) {
      if (line.startsWith(BEGIN) || line.startsWith(END) || line.startsWith('##') || line.startsWith('>')) continue;
      if (!block.includes(line)) console.log('  - ' + line.slice(0, 160));
    }
  } else {
    console.log('  （标记块不存在，需要首次写入）');
  }
  process.exit(1);
}

const changed = inject(block);
console.log(changed ? 'AGENTS.md 本机实况块已回写。' : 'AGENTS.md 本机实况块已是最新，无需改动。');
