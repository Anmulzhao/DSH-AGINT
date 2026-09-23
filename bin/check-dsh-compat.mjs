#!/usr/bin/env node
/**
 * check-dsh-compat.mjs — dsh 升级后的 AGINT 兼容性静态门禁（L0）
 *
 * # 为什么需要它
 *
 * AGINT 是 dsh 的**插件集合**，不是独立程序。它对 dsh 的耦合是「名字级」的：
 * preset / patch 里写着一串 `@deepseek-ai/dsh-*` 包名和工具名，由 dsh loader 在运行期解析。
 * 上游一旦改名 / 弃用 / 换解析规则，AGINT 不会报错在 AGINT 的代码里，而是表现为：
 *
 *   - 整张 preset 拒绝挂载（UI 只显示「加载失败」，**不落日志**）
 *   - N 条官方插件行 `never started`
 *   - 某个插件被静默 disable
 *
 * 历史上真实踩过三次（都写在 VERSION 的兼容矩阵里）：
 *   1. `@deepseek-ai/dsh-workflow-worker-thread@0.0.1-rc.3` 是 RC 包，dsh GA 后不带了
 *      → 整张 preset 拒绝挂载。
 *   2. 0.1.7 起包名由复数 `dsh-agent-presets` 改为单数 `dsh-agent-preset`，且不再扫
 *      `.agent-presets/` 目录 → 必须显式声明式注册，否则 preset 不可见。
 *   3. 0.1.7 起 preset 走 `cordis:include`，子条目 baseUrl 挪到 `.agent-presets/<id>/`
 *      → 裸包名解析不到 node_modules → 23 条官方插件行 never started。
 *
 * 这三次的共同点：**都是静态可判定的**（名字在不在、版本满不满足），
 * 但每次都靠人肉 grep + 事后发现。本脚本把这三件（以及 0.1.7 新加的 peer 校验）
 * 变成一条命令。
 *
 * # 检查项
 *
 *   A. 悬挂包名   —— AGINT 引用的 `@deepseek-ai/dsh-*` 在本机 dsh 里是否真的存在
 *   B. peer 预演  —— 用 dsh 同款规则预演 0.1.7+ 的插件兼容性校验，预测谁会被拒
 *   C. 版本漂移   —— VERSION 兼容矩阵写的 tested 版本 vs 本机实际版本
 *   D. 改名残留   —— 已知改名的包有没有残留旧名
 *
 * # 用法
 *
 *   node bin/check-dsh-compat.mjs            # 人类可读报告
 *   node bin/check-dsh-compat.mjs --json     # 机器可读（给 CI / 技能编排用）
 *   node bin/check-dsh-compat.mjs --strict   # info 级也算失败
 *
 * 退出码：0 = 通过；1 = 有问题；2 = 环境不满足（找不到 dsh / semver）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = new Set(process.argv.slice(2));
const AS_JSON = args.has('--json');
const STRICT = args.has('--strict');

/* ------------------------------------------------------------------ *
 * 0. 定位本机正在跑的那份 dsh
 * ------------------------------------------------------------------ */

/** 跨平台候选：npm 全局安装位。按优先级排列。 */
function dshRootCandidates() {
  const out = [];
  if (process.env.DSH_ROOT) out.push(process.env.DSH_ROOT);
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  if (appData) out.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  if (localAppData) out.push(path.join(localAppData, 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  out.push('/usr/local/lib/node_modules/@deepseek-ai/dsh');
  out.push('/usr/lib/node_modules/@deepseek-ai/dsh');
  out.push(path.join(REPO_ROOT, 'node_modules', '@deepseek-ai', 'dsh'));
  // 最后兜底：问 npm 自己
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (root) out.push(path.join(root, '@deepseek-ai', 'dsh'));
  } catch { /* 没有 npm 就跳过 */ }
  return out;
}

function findDshRoot() {
  for (const dir of dshRootCandidates()) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (pkg.name === '@deepseek-ai/dsh') return { dir, version: pkg.version };
      } catch { /* 继续找下一个 */ }
    }
  }
  return null;
}

/** 本机 dsh 真实安装的 @deepseek-ai/* 包集合（含扁平化提升到父级的）。 */
function installedPackages(dshRoot) {
  const found = new Map();
  const scopes = [
    path.join(dshRoot, 'node_modules', '@deepseek-ai'),
    path.join(path.dirname(dshRoot), '@deepseek-ai'), // npm root/node_modules/@deepseek-ai
    path.join(path.dirname(path.dirname(dshRoot)), '@deepseek-ai'),
  ];
  for (const scope of new Set(scopes)) {
    if (!fs.existsSync(scope)) continue;
    for (const name of fs.readdirSync(scope)) {
      const manifest = path.join(scope, name, 'package.json');
      if (!fs.existsSync(manifest)) continue;
      if (!found.has(name)) {
        try { found.set(name, JSON.parse(fs.readFileSync(manifest, 'utf8')).version ?? '?'); }
        catch { found.set(name, '?'); }
      }
    }
  }
  return found;
}

function loadSemver(dshRoot) {
  const candidates = [
    path.join(dshRoot, 'node_modules', 'semver'),
    path.join(path.dirname(dshRoot), 'semver'),
    path.join(path.dirname(path.dirname(dshRoot)), 'semver'),
    'semver',
  ];
  for (const c of new Set(candidates)) {
    try { return require(c); } catch { /* 试下一个 */ }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 1. 扫描 AGINT 对 dsh 的引用
 * ------------------------------------------------------------------ */

/** 需要扫的目录：这些地方写的包名/工具名会被 dsh loader 真实解析。 */
const SCAN_DIRS = ['presets', 'profile-patches', 'patches', 'install', 'plugins'];
const SCAN_EXT = new Set(['.yml', '.yaml', '.json', '.sh', '.mjs', '.js', '.ps1']);
const PKG_RE = /@deepseek-ai\/dsh[A-Za-z0-9._-]*/g;

/** YAML/配置里 `name: '@deepseek-ai/dsh-x'` 形式 —— loader 会真的去解析它。 */
const NAME_VALUE_RE = /^\s*(?:-\s*)?name:\s*['"]?(@deepseek-ai\/dsh[A-Za-z0-9._-]*)/;

/**
 * 注释行前缀。注释里提到的旧包名**不是**生效引用 —— 历史上适配说明就写在注释里
 * （如 cordis.patch.yml 记录了「复数 dsh-agent-presets 止于 0.1.6」），
 * 不跳过会把「已正确适配」误报成「必然解析失败」。
 */
const COMMENT_RE = {
  '.yml': /^\s*(#|$)/,
  '.yaml': /^\s*(#|$)/,
  '.sh': /^\s*(#|$)/,
  '.ps1': /^\s*(#|$)/,
  '.js': /^\s*(\/\/|\/\*|\*|$)/,
  '.mjs': /^\s*(\/\/|\/\*|\*|$)/,
  '.json': /$^/, // JSON 无注释
};

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SCAN_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function scanReferences() {
  const refs = new Map(); // pkg -> { critical: Set<file>, info: Set<file> }
  const add = (pkg, file, critical) => {
    if (!refs.has(pkg)) refs.set(pkg, { critical: new Set(), info: new Set() });
    refs.get(pkg)[critical ? 'critical' : 'info'].add(path.relative(REPO_ROOT, file).replace(/\\/g, '/'));
  };
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(REPO_ROOT, dir))) {
      // package.json 的 peerDependencies 归 B 项处理，但其中的引用仍然登记
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split(/\r?\n/);
      const ext = path.extname(file);
      const commentRE = COMMENT_RE[ext];
      for (const line of lines) {
        if (commentRE && commentRE.test(line)) continue; // 注释里提到 ≠ 生效引用
        const m = line.match(NAME_VALUE_RE);
        // 只有 preset/patch YAML 的 name: 值会被 loader 直接解析 —— 失败即静默 disable
        // 或整张 preset 拒绝挂载。shell 脚本里的包名有条件分支与兜底，降级为 info。
        const critical = (ext === '.yml' || ext === '.yaml') && Boolean(m);
        for (const hit of line.matchAll(PKG_RE)) {
          const pkg = hit[0];
          if (/[-.]$/.test(pkg)) continue; // 不完整包名（通配写法 / 字符串拼接前缀）
          add(pkg, file, critical);
        }
      }
    }
  }
  return refs;
}

/* ------------------------------------------------------------------ *
 * 2. 各检查项
 * ------------------------------------------------------------------ */

/** D 项：已知改名表。新增坑就往这里加一行（这是知识沉淀的位置）。 */
const RENAMED = [
  {
    from: '@deepseek-ai/dsh-agent-presets',
    to: '@deepseek-ai/dsh-agent-preset',
    since: '0.1.7',
    why: '0.1.7 起 dsh 不再自动扫 .agent-presets/ 目录，包名由复数改单数，必须显式声明式注册',
  },
  {
    from: '@deepseek-ai/dsh-workflow-worker-thread',
    to: '@deepseek-ai/dsh-workflow-ptc',
    since: '0.1.1',
    why: 'RC 包已 GA 为 ptc，新版 dsh 不带旧包 → 整张 preset 拒绝挂载',
  },
];

/** A 项：悬挂包名 —— referenced 但本机 dsh 里不存在。 */
function checkDangling(refs, installed) {
  const issues = [];
  for (const [pkg, where] of refs) {
    if (pkg === '@deepseek-ai/dsh') continue;
    if (installed.has(pkg)) continue;
    // 裸包也可能以 scoped 短名形式存在（如 dsh-tools 由运行时注入）
    const bare = pkg.replace(/^@deepseek-ai\//, '');
    if (installed.has(bare)) continue;
    const level = where.critical.size > 0 ? 'critical' : 'info';
    issues.push({
      level,
      kind: 'dangling-package',
      package: pkg,
      files: [...where.critical, ...where.info].slice(0, 6),
      message: `AGINT 引用了 ${pkg}，但本机 dsh 里没装这个包`,
      remedy: '上游改名/弃用了。对照 VERSION 兼容矩阵与 dsh package.json deps 换成新包名，否则该行会被静默 disable 或整张 preset 拒绝挂载',
    });
  }
  return issues;
}

/** B 项：0.1.7+ 的 peer 兼容性校验预演，规则与 dsh app-boot 保持一致。 */
function checkPeerCompatibility(semver, runtimeVersion, installed) {
  const issues = [];
  const manifests = [];
  for (const dir of ['plugins', 'eval']) {
    for (const file of walk(path.join(REPO_ROOT, dir))) {
      if (path.basename(file) === 'package.json') manifests.push(file);
    }
  }
  const rootManifest = path.join(REPO_ROOT, 'package.json');
  if (fs.existsSync(rootManifest)) manifests.push(rootManifest);

  for (const file of manifests) {
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const peers = pkg.peerDependencies;
    if (!peers || typeof peers !== 'object') continue;

    const bad = {};
    for (const [name, range] of Object.entries(peers)) {
      if (typeof range !== 'string') continue;
      if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;
      // 与 app-boot 一致：workspace:* 视为当前 runtime 版本，恒通过
      const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtimeVersion : range;
      const ok = requirement.trim() !== ''
        && semver.satisfies(runtimeVersion, requirement, { includePrerelease: true });
      if (!ok) bad[name] = range;
    }
    if (Object.keys(bad).length === 0) continue;

    // dsh 侧还要求：不兼容时 manifest 必须有非空 name/version，否则直接 throw
    const missingIdentity = [];
    if (typeof pkg.name !== 'string' || pkg.name.trim() === '') missingIdentity.push('name');
    if (typeof pkg.version !== 'string' || pkg.version.trim() === '') missingIdentity.push('version');

    issues.push({
      level: 'critical',
      kind: 'peer-incompatible',
      file: path.relative(REPO_ROOT, file).replace(/\\/g, '/'),
      package: `${pkg.name ?? '?'}@${pkg.version ?? '?'}`,
      peers: bad,
      runtimeVersion,
      missingIdentity,
      message: `${pkg.name ?? file} 声明的 peer ${JSON.stringify(bad)} 不满足 dsh ${runtimeVersion}`,
      remedy: missingIdentity.length
        ? `manifest 缺 ${missingIdentity.join('/')}，dsh 会直接 throw（不是 disable）。补齐字段`
        : `放宽 peer range，或用 \`dsh plugin allow-version\` 对 ${pkg.name}@${pkg.version} 做精确版本豁免`,
    });
  }
  return issues;
}

/** C 项：VERSION 兼容矩阵声明的 tested 版本 vs 本机实际。 */
function checkVersionDrift(runtimeVersion) {
  const versionFile = path.join(REPO_ROOT, 'VERSION');
  if (!fs.existsSync(versionFile)) return [];
  const text = fs.readFileSync(versionFile, 'utf8');
  const issues = [];
  // 取矩阵里第一行（即「当前」那一行）
  const rows = text.split('\n').filter((l) => /^\|\s*v?\d+\.\d+\.\d+\s*\|/.test(l.trim()));
  if (rows.length === 0) return issues;
  const cells = rows[0].split('|').map((s) => s.trim()).filter(Boolean);
  const [agint, minimum, tested] = cells;
  if (tested && tested !== runtimeVersion) {
    issues.push({
      level: 'info',
      kind: 'version-drift',
      declared: tested,
      actual: runtimeVersion,
      message: `VERSION 矩阵说 AGINT ${agint} 在 dsh ${tested} 上测过，本机实际是 ${runtimeVersion}`,
      remedy: '实测通过后更新 VERSION 矩阵的 dsh tested 列；没测过就先跑 L1 真机冒烟',
    });
  }
  if (minimum && !/^\d/.test(minimum)) {
    issues.push({ level: 'info', kind: 'version-matrix-unparsed', message: `无法解析 minimum=${minimum}` });
  }
  if (minimum && /^\d/.test(minimum)) {
    // 粗判：本机版本低于声明的 minimum（字符串比较兜底，无 semver 也能用）
    const cmp = (a, b) => {
      const pa = a.split(/[.-]/), pb = b.split(/[.-]/);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = Number(pa[i] ?? 0), nb = Number(pb[i] ?? 0);
        if (na !== nb) return na < nb ? -1 : 1;
      }
      return 0;
    };
    if (cmp(runtimeVersion, minimum) < 0) {
      issues.push({
        level: 'critical',
        kind: 'below-minimum',
        message: `本机 dsh ${runtimeVersion} 低于 AGINT 要求的 minimum ${minimum}`,
        remedy: '升级 dsh 或降级 AGINT',
      });
    }
  }
  return issues;
}

/** D 项：已知改名的旧包名是否还有残留。 */
function checkRenames(refs, installed) {
  const issues = [];
  for (const r of RENAMED) {
    const where = refs.get(r.from);
    if (!where) continue;
    const stillExists = installed.has(r.from);
    // 只在注释里提到旧名 = 已适配的痕迹，不构成风险；真正写在 name: 值里才是活引用
    const level = where.critical.size > 0 ? 'critical' : 'info';
    issues.push({
      level,
      kind: 'renamed-package',
      package: r.from,
      successor: r.to,
      since: r.since,
      files: [...where.critical, ...where.info].slice(0, 6),
      message: `仍在引用旧包名 ${r.from}（${r.since} 起已改为 ${r.to}）`,
      remedy: r.why + (stillExists ? '；当前机器上旧包仍在，未来升级会消失' : '；本机已无此包 → 该行必然解析失败'),
    });
  }
  return issues;
}

/* ------------------------------------------------------------------ *
 * 3. 主流程
 * ------------------------------------------------------------------ */

const dsh = findDshRoot();
if (!dsh) {
  console.error('找不到 @deepseek-ai/dsh 安装位置。设置 DSH_ROOT=<dsh 包目录> 再跑。');
  process.exit(2);
}
const semver = loadSemver(dsh.dir);
if (!semver) {
  console.error('找不到 semver（应在 dsh 的 node_modules 里）。设置 DSH_ROOT 指向正确的 dsh 包目录。');
  process.exit(2);
}

const installed = installedPackages(dsh.dir);
const refs = scanReferences();
const issues = [
  ...checkDangling(refs, installed),
  ...checkPeerCompatibility(semver, dsh.version, installed),
  ...checkVersionDrift(dsh.version),
  ...checkRenames(refs, installed),
];

const critical = issues.filter((i) => i.level === 'critical');
const info = issues.filter((i) => i.level === 'info');

const report = {
  dshRoot: dsh.dir,
  dshVersion: dsh.version,
  installedDshPackages: installed.size,
  referencedDshPackages: refs.size,
  critical: critical.length,
  info: info.length,
  issues,
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`dsh ${dsh.version}  @ ${dsh.dir}`);
  console.log(`本机已装 @deepseek-ai/* : ${installed.size} 个 | AGINT 引用 : ${refs.size} 个`);
  console.log('');
  if (issues.length === 0) {
    console.log('✅ 静态契约检查通过：无悬挂包名、无 peer 不兼容、无版本漂移、无改名残留');
  } else {
    for (const [label, list] of [['🔴 CRITICAL', critical], ['🔵 INFO', info]]) {
      if (list.length === 0) continue;
      console.log(`${label} (${list.length})`);
      for (const i of list) {
        console.log(`  - [${i.kind}] ${i.message}`);
        if (i.files?.length) console.log(`      位置: ${i.files.join(', ')}`);
        if (i.remedy) console.log(`      处置: ${i.remedy}`);
      }
      console.log('');
    }
  }
}

const failed = critical.length > 0 || (STRICT && info.length > 0);
process.exit(failed ? 1 : 0);
