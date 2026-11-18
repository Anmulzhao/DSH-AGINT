#!/usr/bin/env node
/**
 * bin/validate-env-config.mjs — 机器级环境配置启动校验（Phase -1.4 / 多机配置分层步 1-2）
 *
 * 干什么：仓库已把机器私有绝对路径掏空、改走环境变量。但「谁没配 / 配了个不存在的路径 /
 * 又有人把绝对路径硬编码回源码」这三件事，装完不检查就会静默坏掉。本脚本在启动时
 * （或安装后手动）把这三件事一次查清。
 *
 * 它只读、不写，也不改 process.env —— 真正把 .env 灌进运行时是 dsh-app-boot 的
 * loadLayeredEnv() 的活。本脚本是「体检报告」，不是「加载器」。
 *
 * 读文件与运行时加载器严格一致（dsh-app-boot lib/index.js loadLayeredEnv）：
 *   process.env  >  cwd/.env（project 层）  >  $DSH_HOME/.env（user 层）
 * ⛔ 不读 .agint-env.local —— 运行时加载器不读它，登记它只会造出「校验绿、运行坏」假象。
 * ⛔ DSH_ / XDG_ 前缀与 PATH/HOME 等是 bootstrap-only：写进任何 .env 运行时直接抛错，
 *    本脚本发现即 FAIL。DSH_HOME 只能由启动环境注入（start-dsh.cmd / compose / systemd）。
 *
 * 通道真源 = cordis.patch.yml 的 !!js 表达式（AGINT_REPO_ROOT ×4 / AGINT_DATA_HOME /
 * AGINT_WIKI_ROOT / DSH_HOME）+ input-gateway/respawn 消费的 DSH_* 通道。
 *
 * 跑法：
 *   node bin/validate-env-config.mjs
 *   node bin/validate-env-config.mjs --strict   # 有 FAIL 项则 exit 1（供 CI/门禁）
 *   node bin/validate-env-config.mjs --json
 *   node bin/validate-env-config.mjs --repo-root=<仓根> --cwd=<project 层目录>
 *
 * 退出码：0 = 无 FAIL；1 = --strict 下有 FAIL（缺 required / 路径不存在 / bootstrap 键入 .env / 硬编码绝对路径）。
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
const PROJECT_DIR = resolve(arg('cwd', process.cwd()));
// DSH_HOME 自身是 bootstrap-only，只能来自进程 env；兜底与 cordis 表达式同约定
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');

// ── 被跟踪的环境通道 ────────────────────────────────────────────────────────
// required=1 的变量若完全没配 → FAIL（其余仅 info/warn）。
// pathLike=1 的变量会检查目录/文件是否真实存在。
const CHANNELS = [
  { key: 'DSH_HOME', required: 1, pathLike: 1, note: 'dsh 运行数据基目录（bootstrap-only，只能启动环境注入）' },
  { key: 'AGINT_REPO_ROOT', required: 1, pathLike: 1, note: '仓库正本根（cordis 4 处 repoRoot 的真通道）' },
  { key: 'AGINT_DATA_HOME', required: 0, pathLike: 1, note: '数据根专用（dreams/wiki/reviews，优先于 AGINT_HOME）' },
  { key: 'AGINT_WIKI_ROOT', required: 0, pathLike: 1, note: 'agint wiki 根' },
  { key: 'AGINT_HOME', required: 0, pathLike: 1, note: 'AGINT 仓根（非数据目录；install.sh 推导用）' },
  { key: 'DSH_WIKI_ROOT', required: 0, pathLike: 1, note: '宿主 wiki 根（respawn 剥离重载通道）' },
  { key: 'DSH_PROJECT_ROOT', required: 0, pathLike: 1, note: 'DSH-AGINT checkout 根（喂 input-gateway dsh-agint 槽位）' },
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

const projectEnv = parseEnvFile(join(PROJECT_DIR, '.env'));
const userEnv = parseEnvFile(join(DSH_HOME, '.env'));

function effective(key) {
  if (process.env[key]) return { value: process.env[key], from: 'process.env' };
  if (projectEnv[key]) return { value: projectEnv[key], from: 'project-env(cwd/.env)' };
  if (userEnv[key]) return { value: userEnv[key], from: 'user-env($DSH_HOME/.env)' };
  return { value: null, from: 'unset' };
}

// ── bootstrap-only 键入 .env 检查（运行时加载器会直接抛错，这里提前拦）────────
const BOOTSTRAP_NAMES = new Set(['PATH', 'HOME', 'USERPROFILE', 'NODE_OPTIONS', 'NODE_PATH']);
const BOOTSTRAP_PREFIXES = ['DSH_', 'XDG_'];
function isBootstrapOnly(name) {
  const upper = name.toUpperCase();
  return BOOTSTRAP_NAMES.has(upper) || BOOTSTRAP_PREFIXES.some((p) => upper.startsWith(p));
}
const bootstrapViolations = [];
for (const [layer, values] of [['project-env(cwd/.env)', projectEnv], ['user-env($DSH_HOME/.env)', userEnv]]) {
  for (const key of Object.keys(values)) {
    if (isBootstrapOnly(key)) bootstrapViolations.push({ key, layer });
  }
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
// 机器私有绝对路径不该出现在源码里（Phase -1.4）。三类形态：
// Linux 用户路径 /home/...、Windows 盘符路径 <盘>:/ 或 <盘>:\（含非 Users 目录）。
// 盘符只认单字母 + 前置词边界 + 分隔符 + 路径首字符：把 https:// 、file:// 、
// 正则 name:\s 与字符类 [^\s:/@] 这类 URL/端口/字面量排掉
// （2026-11-18 扩扫描首版在这几处报过假阳性）。
// 范围：plugins/ + bin/ 的 .js/.mjs（跳过测试）+ 仓库根 cordis.patch.yml。
const LINUX_ABS = /["'`]\/home\/[A-Za-z0-9_./-]+["'`]/;
const DRIVE_ABS = /(?<![A-Za-z0-9_:])[A-Za-z]:(?:[\\/](?!\/)|\\\\)[A-Za-z0-9_.~]/;
function hasMachineAbsPath(line) {
  return LINUX_ABS.test(line) || DRIVE_ABS.test(line);
}
function isCommentLine(trimmed, isYaml) {
  if (isYaml) return trimmed.startsWith('#');
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}
function scanFile(full, isYaml, acc) {
  let text;
  try { text = readFileSync(full, 'utf8'); } catch { return acc; }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (isCommentLine(t, isYaml)) continue;
    if (hasMachineAbsPath(lines[i])) acc.push({ file: full.replace(REPO_ROOT + '/', '').replace(REPO_ROOT + '\\', ''), line: i + 1, text: t.slice(0, 80) });
  }
  return acc;
}
function scanHardcodedPaths(dir, acc) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.agint-preimage' || e.name === 'test' || e.name === 'tests') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) scanHardcodedPaths(full, acc);
    else if (/\.(js|mjs)$/.test(e.name) && !/\.test\.(mjs|js)$/.test(e.name)) scanFile(full, false, acc);
  }
  return acc;
}
let hardcoded = scanHardcodedPaths(join(REPO_ROOT, 'plugins'), []);
hardcoded = scanHardcodedPaths(join(REPO_ROOT, 'bin'), hardcoded);
const patchFile = join(REPO_ROOT, 'cordis.patch.yml');
if (existsSync(patchFile)) scanFile(patchFile, true, hardcoded);

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

const failCount = rows.filter((r) => r.status === 'FAIL').length + hardcoded.length + bootstrapViolations.length;
const fail = STRICT && failCount > 0;

// ── 输出 ────────────────────────────────────────────────────────────────────
if (AS_JSON) {
  console.log(JSON.stringify({ repoRoot: REPO_ROOT, projectDir: PROJECT_DIR, dshHome: DSH_HOME, channels: rows, bootstrapViolations, hardcodedMachinePaths: hardcoded, failCount }, null, 2));
} else {
  console.log('机器级环境配置校验（Phase -1.4 / 多机配置分层）');
  console.log(`  repoRoot: ${REPO_ROOT}`);
  console.log(`  project 层: ${join(PROJECT_DIR, '.env')} 存在: ${existsSync(join(PROJECT_DIR, '.env'))} | user 层: ${join(DSH_HOME, '.env')} 存在: ${existsSync(join(DSH_HOME, '.env'))}`);
  console.log('');
  for (const r of rows) {
    const mark = r.status === 'ok' ? '✅' : r.status === 'FAIL' ? '⛔' : '·';
    const val = r.value ? `${r.value}  [${r.from}]` : '(未配置)';
    console.log(`${mark} ${r.key.padEnd(24)} ${r.status.padEnd(5)} ${val}`);
    if (r.detail.length) console.log(`     └ ${r.detail.join('; ')}  // ${r.note}`);
  }
  console.log('');
  console.log(`bootstrap-only 键入 .env：${bootstrapViolations.length ? '⛔ ' + bootstrapViolations.length + ' 处（运行时加载器会抛错，只能启动环境注入）' : '✅ 0 处'}`);
  for (const v of bootstrapViolations) console.log(`     ${v.key} 在 ${v.layer}`);
  console.log('');
  console.log(`源码硬编码机器绝对路径：${hardcoded.length ? '⛔ ' + hardcoded.length + ' 处（应改走 env）' : '✅ 0 处'}`);
  for (const h of hardcoded.slice(0, 10)) console.log(`     ${h.file}:${h.line}  ${h.text}`);
  console.log('');
  console.log(failCount === 0 ? '判定：HEALTHY' : (STRICT ? `判定：FAIL（${failCount} 项）` : `判定：注意（${failCount} 项，未加 --strict 不阻断）`));
}

process.exit(fail ? 1 : 0);