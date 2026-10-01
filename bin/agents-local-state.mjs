#!/usr/bin/env node
// 本机实况自动同步器 —— **按归属拆成两个文件**
//
// 背景（2026-09-07 提案）：AGENTS.md 里的「本机实况快照」全是手写的，反复过期
// （例：文档写 13 个 preset tool rows，host 实际 16 个）。本脚本把这件事自动化。
//
// 2026-10-01 拆分的原因（多机仓库）：原设计把**每台机器私有的实测值**（DSH_HOME
// 绝对路径、host 挂载插件版本、cron tick 时间、仓库↔host 同步状态）写进了一个
// **两台机器共享提交的文件**。后果不是「过期」而是「对另一台机器 outright 错误」
// —— Windows 机器提交后，Linux 机器读到的 AGENTS.md 会声称自己的 DSH_HOME 是
// `C:\Users\Administrator\.dsh`。谁最后跑，谁的机器就是仓库事实。
//
// 拆分后按「谁来决定这个值」分：
//   AGENTS.md（入库，两机字节相同）  —— 仓库级事实：仓库版本 / preset tool rows /
//     preset skills。只从**仓库**读，不碰 host 部署位，所以两台机器产出必然一致。
//   AGENTS.local.md（.gitignore）   —— 本机私有实测：DSH_HOME / 仓库↔host 同步 /
//     host 挂载插件 / profile patch 段 / cron 实况 / 本机时间戳。
//
// 用法：
//   node bin/agents-local-state.mjs           # 探测并回写两个文件的标记块
//   node bin/agents-local-state.mjs --check   # 只检查是否过期；过期 exit 1，不写
//
// 设计约束：
// - 零依赖（仓库无 node_modules 也能跑）
// - 跨平台：路径一律走 join()/DSH_HOME env；写盘固定 LF，Windows 上不会被编辑器
//   转成 CRLF 后导致每次 --check 都误报 STALE
// - 只动 BEGIN/END 标记之间的内容，绝不碰 AGENTS.md 其他部分
// - hash 比对用 lib/index.js（2026-09-04「仓库 ≠ host 加载点」教训的自动化）

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS_MD = join(REPO_ROOT, 'AGENTS.md');
// 本机私有块：不入库（.gitignore），两台机器各持一份
const AGENTS_LOCAL = join(REPO_ROOT, 'AGENTS.local.md');
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const HOST_PLUGINS_DIR = join(DSH_HOME, 'profiles', 'web', 'plugins');
const HOST_PRESET_DIR = join(DSH_HOME, '.agent-presets', 'agint');
const HOST_PATCH_YML = join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml');
const HOST_CRON_JSON = join(DSH_HOME, 'storages', 'agint_cron.json');
const REPO_PLUGINS_DIR = join(REPO_ROOT, 'plugins');
// 仓库级事实只从仓库读 —— 这是两台机器产出相同字节的关键，绝不能回退到 host 部署位
const REPO_PRESET_YML = join(REPO_ROOT, 'presets', 'agint', 'agent.cordis.yml');
const REPO_PRESET_SKILLS = join(REPO_ROOT, 'presets', 'agint', 'skills');

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
    // ⚠️ v 前缀可选（仓库两种格式并存：`## v0.6.5` 与 `## 0.6.6`），输出统一带 v。
    // 否则新条目不写 v 时正则跳过它、倒退抓到更旧的带 v 条目 —— 实锤：
    // mutator 0.6.7 期间本探测器显示 v0.6.5（2026-09-29）。
    const m = cl.match(/^##\s+(v?[\d][\w.-]*)/m);
    if (m) return m[1].startsWith('v') ? m[1] : `v${m[1]}`;
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

  // preset tool rows —— ⚠️ 读**仓库** presets/agint/agent.cordis.yml，不读 host 部署位。
  // 这是「两台机器产出相同字节」的关键：读部署位的话，Windows 机器装过什么就决定
  // 仓库里写什么，Linux 机器跑一次就把它改回去，来回打架。
  let presetRows = [];
  try {
    const yml = readFileSync(REPO_PRESET_YML, 'utf8');
    presetRows = [...yml.matchAll(/^- id: (agint-[a-z0-9-]+)-tools\s*$/gm)].map((m) => m[1]);
  } catch { /* preset missing */ }

  // preset skills —— 同理，读仓库 presets/agint/skills
  const presetSkills = listDirs(REPO_PRESET_SKILLS);

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

// ── 入库块：只放仓库级事实。两台机器跑出来必须字节相同（否则 git 天天打架）──
function renderRepo(p) {
  return [
    BEGIN,
    '## 仓库实况（自动生成）',
    '',
    '> 本块由 `bin/agents-local-state.mjs` 回写，**只含仓库级事实**，任何机器跑出来都一样。',
    '> 与上文任何手写快照冲突时以本块为准。勿手改；更新方式：`node bin/agents-local-state.mjs`。',
    '>',
    '> ⚠️ **本机实测值（DSH_HOME 绝对路径、host 挂载插件版本、cron tick、仓库↔host 同步状态）不在这里**',
    '> —— 它们两台机器各不相同，写进来会让一台机器把另一台的事实覆盖掉。',
    '> 本机那份见 `AGENTS.local.md`（已 .gitignore，每台机器各持一份，由同一脚本生成）。',
    '',
    `- **仓库版本**：${p.repoVersion}（VERSION 表首行）`,
    `- **preset tool rows**（${p.presetRows.length} 个）：${p.presetRows.join('、') || '无'}`,
    `- **preset skills**（${p.presetSkills.length} 个）：${p.presetSkills.join('、') || '无'}`,
    '',
    END,
  ].join('\n');
}

// ── 不入库块：纯本机私有。含绝对路径是应该的 —— 它永远不会被另一台机器读到 ──
function renderLocal(p) {
  const now = new Date();
  const ts = `${now.toISOString().slice(0, 10)} ${now.toTimeString().slice(0, 5)} UTC`;

  const pluginList = [...p.host.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([n, v]) => `${n}@${v.version}`)
    .join('、');

  const syncLine = p.host.size === 0
    ? '⚠️ 未探测到 host 插件目录（DSH_HOME 无 profiles/web/plugins？）'
    : p.drift.length === 0 && p.hostOnly.length === 0 && p.repoOnly.length === 0
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

  const hostList = pluginList || '（未探测到）';

  return [
    BEGIN,
    '# 本机实况（自动生成，**不入库**）',
    '',
    '> 本文件由 `bin/agents-local-state.mjs` 生成，已在 `.gitignore` 中。',
    `> 本机探测时间：${ts}。勿手改；更新方式：` + '`node bin/agents-local-state.mjs`。',
    '>',
    '> 为什么要单独一个文件：这些值**每台机器都不同**（绝对路径、host 版本、cron tick）。',
    '> 原先它们写在 AGENTS.md 里，谁最后跑谁的机器就成了仓库事实，另一台机器读到的',
    '> 不是过期而是 outright 错误。仓库级事实见 AGENTS.md 的「仓库实况」块。',
    '',
    `- **DSH_HOME**：\`${DSH_HOME}\``,
    '  （推导：优先 `$DSH_HOME`；未设置时取用户主目录下的 `.dsh`）',
    `- **本机平台**：${process.platform} / ${process.arch}，Node ${process.version}`,
    `- **仓库根**：\`${REPO_ROOT}\``,
    `- **仓库 ↔ host 同步**：${syncLine}`,
    `- **host 挂载插件**（${p.host.size} 个）：${hostList}`,
    `- **cordis.patch.yml agint 段**（host web profile，${p.patchSegs.length} 个）：${p.patchSegs.join('、') || '无'}`,
    `- **cron 实况**（${p.cronJobs.length} 个 job，按最近 tick 排序）：${cronLine}`,
    '',
    END,
  ].join('\n');
}

// 跨机器读写：统一 LF。Windows 编辑器可能把已入库的块转成 CRLF，
// 那会让 --check 每次都误报 STALE —— 比对前先归一。
const norm = (s) => s.replace(/\r\n/g, '\n');

function inject(block, file) {
  const doc = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const d = norm(doc);
  const b = d.indexOf(BEGIN);
  const e = d.indexOf(END);
  let next;
  if (b !== -1 && e !== -1) {
    next = d.slice(0, b) + block + d.slice(e + END.length);
  } else {
    next = d.replace(/\s*$/, '\n') + '\n' + block + '\n';
  }
  if (next !== d) writeFileSync(file, next, 'utf8');
  return next !== d;
}

const checkOnly = process.argv.includes('--check');
const p = probe();
const targets = [
  { label: 'AGENTS.md（入库·仓库实况）', file: AGENTS_MD, block: renderRepo(p) },
  { label: 'AGENTS.local.md（不入库·本机实况）', file: AGENTS_LOCAL, block: renderLocal(p) },
];

function readBlock(file) {
  if (!existsSync(file)) return null;
  const d = norm(readFileSync(file, 'utf8'));
  const b = d.indexOf(BEGIN);
  const e = d.indexOf(END);
  return b !== -1 && e !== -1 ? d.slice(b, e + END.length) : null;
}

if (checkOnly) {
  let stale = 0;
  for (const t of targets) {
    const existing = readBlock(t.file);
    if (existing === t.block) {
      console.log(`OK: ${t.label} 与实测一致，无漂移。`);
      continue;
    }
    stale++;
    console.log(`STALE: ${t.label} 过期（或缺失）。变化点：`);
    if (existing) {
      for (const line of t.block.split('\n')) {
        if (line.startsWith(BEGIN) || line.startsWith(END) || line.startsWith('##')) continue;
        if (!existing.includes(line)) console.log('  + ' + line.slice(0, 160));
      }
      for (const line of existing.split('\n')) {
        if (line.startsWith(BEGIN) || line.startsWith(END) || line.startsWith('##') || line.startsWith('>') || line.startsWith('#')) continue;
        if (!t.block.includes(line)) console.log('  - ' + line.slice(0, 160));
      }
    } else {
      console.log('  （标记块不存在，需要首次写入）');
    }
  }
  process.exit(stale ? 1 : 0);
}

for (const t of targets) {
  const changed = inject(t.block, t.file);
  console.log(changed
    ? `${t.label} 已回写：${t.file}`
    : `${t.label} 已是最新，无需改动：${t.file}`);
}
