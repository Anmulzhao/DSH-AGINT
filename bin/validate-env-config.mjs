#!/usr/bin/env node
/**
 * bin/validate-env-config.mjs — 机器级环境配置启动校验（Phase -1.4）
 *
 * 干什么：仓库已把机器私有绝对路径掏空、改走环境变量（DSH_PROJECT_ROOT 等）。
 * 但「谁没配 / 配了个不存在的路径 / 又有人把绝对路径硬编码回 lib」这三件事，
 * 装完不检查就会静默坏掉。本脚本在启动时（或安装后手动）把这三件事一次查清。
 *
 * 它只读、不写，也不改 process.env —— 真正把 .env 灌进运行时是 dsh-app-boot 的
 * loadLayeredEnv() 的活。本脚本是「体检报告」，不是「加载器」。
 *
 * 变量优先级（与 respawn.js / dsh 启动器一致：越靠前越权威）：
 *   process.env  >  .agint-env.local（本机 override，gitignore）  >  .env（仓库层）
 *
 * 跑法：
 *   node bin/validate-env-config.mjs
 *   node bin/validate-env-config.mjs --strict   # 有 FAIL 项则 exit 1（供 CI/门禁）
 *   node bin/validate-env-config.mjs --json
 *   node bin/validate-env-config.mjs --repo-root=D:/DSH/project源码/DSH-AGINT
 *
 * 退出码：0 = 无 FAIL；1 = --strict 下有 FAIL（缺 required 或路径不存在或发现硬编码绝对路径）。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const arg = (k, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : dflt;
};
const has = (k) => argv.includes(`--${k}`);
const STRICT = has('strict');
const AS_JSON = has('json');

const REPO_ROOT = resolve(arg('repo-root', process.env.AGINT_HOME || process.cwd()));

// ── 被跟踪的环境通道 ────────────────────────────────────────────────────────
// required=1 的变量若完全没配 → FAIL（其余仅 info/warn）。
// pathLike=1 的变量会检查目录/文件是否真实存在。
const CHANNELS = [
  { key: 'AGINT_HOME', required: 0, pathLike: 1, note: 'AGINT 仓根（非数据目录）' },
  { key: 'DSH_HOME', required: 1, pathLike: 1, note: 'dsh 运行数据基目录，storages 在其下' },
  { key: 'DSH_WIKI_ROOT', required: 0, pathLike: 1, note: 'wiki 根' },
  { key: 'DSH_PROJECT_ROOT', required: 0, pathLike: 1, note: 'DSH-AGINT checkout 根（喂 C3 dsh-agint 槽位）' },
  { key: 'DSH_INPUT_GATEWAY_REPOS', required: 0, pathLike: 2, note: '追加 git 仓库，格式 id=path;path2' },
];

// ── 简易 dotenv 解析（KEY=VALUE，# 注释，去引号）─────────────────────────────
function parseEnvFile(p) {
  const out = {};
  if (!existsSync(p)) return out;
  let text;
  try { text = readFileSync(p, 'utf8'); } catch { return out; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const repoDotenv = parseEnvFile(join(REPO_ROOT, '.env'));
const localEnv = parseEnvFile(join(REPO_ROOT, '.agint-env.local'));

function effective(key) {
  if (process.env[key]) return { value: process.env[key], from: 'process.env' };
  if (localEnv[key]) return { value: localEnv[key], from: '.agint-env.local' };
  if (repoDotenv[key]) return { value: repoDotenv[key], from: '.env' };
  return { value: null, from: 'unset' };
}

// pathLike=2（DSH_INPUT_GATEWAY_REPOS）里的每个 path 也要存在性检查
function pathsOf(ch) {
  const { value } = ch;
  if (!value) return [];
  if (ch.pathLike === 2) {
    return value.split(/[;,]/).map((s) => s.trim()).filter(Boolean)
      .map((seg) => { const eq = seg.indexOf('='); return eq > 0 ? seg.slice(eq + 1).trim() : seg; });
  }
  return [value];
}

// ── 硬编码机器绝对路径扫描（防回潮）──────────────────────────────────────────
// 麒麟/Linux 机路径 /home/... 和 Windows 用户绝对路径 <盘>:\Users\... 都是机器私有事实，
// 不该出现在 lib 源码里（Phase -1.4）。用两段独立匹配，避免正则反向引用。
const LINUX_ABS = /["'`]\/home\/[A-Za-z0-9_./-]+["'`]/;
const WIN_ABS = /[A-Za-z]:[\\/]{1,2}Users[\\/]/;
function hasMachineAbsPath(line) {
  return LINUX_ABS.test(line) || WIN_ABS.test(line);
}
function scanHardcodedPaths(dir, acc) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.agint-preimage' || e.name === 'test' || e.name === 'tests') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) scanHardcodedPaths(full, acc);
    else if (/\.(js|mjs)$/.test(e.name) && !/\.test\.(mjs|js)$/.test(e.name)) {
      let text;
      try { text = readFileSync(full, 'utf8'); } catch { continue; }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        // 跳过注释行（本文件的说明里就带示例路径）
        const t = lines[i].trim();
        if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue;
        if (hasMachineAbsPath(lines[i])) acc.push({ file: full.replace(REPO_ROOT + '/', ''), line: i + 1, text: t.slice(0, 80) });
      }
    }
  }
  return acc;
}
const hardcoded = scanHardcodedPaths(join(REPO_ROOT, 'plugins'), []);

// ── 汇总每个通道状态 ────────────────────────────────────────────────────────
const rows = CHANNELS.map((ch) => {
  const eff = effective(ch.key);
  let status = 'ok';
  const detail = [];
  if (!eff.value) {
    status = ch.required ? 'FAIL' : 'unset';
    detail.push(ch.required ? '必填项未配置' : '未配置（可选）');
  } else if (ch.pathLike) {
    for (const p of pathsOf({ ...ch, value: eff.value })) {
      const abs = isAbsolute(p) ? p : join(REPO_ROOT, p);
      const ok = existsSync(abs) && statSync(abs).isDirectory();
      if (!ok) { status = 'FAIL'; detail.push(`路径不存在: ${p}`); }
    }
    if (status === 'ok') detail.push('全部路径存在');
  }
  return { key: ch.key, value: eff.value, from: eff.from, status, note: ch.note, detail };
});

const failCount = rows.filter((r) => r.status === 'FAIL').length + hardcoded.length;
const fail = STRICT && failCount > 0;

// ── 输出 ────────────────────────────────────────────────────────────────────
if (AS_JSON) {
  console.log(JSON.stringify({ repoRoot: REPO_ROOT, channels: rows, hardcodedMachinePaths: hardcoded, failCount }, null, 2));
} else {
  console.log('机器级环境配置校验（Phase -1.4）');
  console.log(`  repoRoot: ${REPO_ROOT}`);
  console.log(`  .env 存在: ${existsSync(join(REPO_ROOT, '.env'))} | .agint-env.local 存在: ${existsSync(join(REPO_ROOT, '.agint-env.local'))}`);
  console.log('');
  for (const r of rows) {
    const mark = r.status === 'ok' ? '✅' : r.status === 'FAIL' ? '⛔' : '·';
    const val = r.value ? `${r.value}  [${r.from}]` : '(未配置)';
    console.log(`${mark} ${r.key.padEnd(24)} ${r.status.padEnd(5)} ${val}`);
    if (r.detail.length) console.log(`     └ ${r.detail.join('; ')}  // ${r.note}`);
  }
  console.log('');
  console.log(`lib 源码硬编码机器绝对路径：${hardcoded.length ? '⛔ ' + hardcoded.length + ' 处（应改走 env）' : '✅ 0 处'}`);
  for (const h of hardcoded.slice(0, 10)) console.log(`     ${h.file}:${h.line}  ${h.text}`);
  console.log('');
  console.log(failCount === 0 ? '判定：HEALTHY' : (STRICT ? `判定：FAIL（${failCount} 项）` : `判定：注意（${failCount} 项，未加 --strict 不阻断）`));
}

process.exit(fail ? 1 : 0);
