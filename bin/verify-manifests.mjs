#!/usr/bin/env node
/**
 * bin/verify-manifests.mjs —— 插件 manifest 一致性门禁（Tier A）
 *
 * 查什么（设计 §5.2.5：插件 manifest 一致性，PR 门禁）：
 *   插件有两份身份声明：manifest.json（AGINT PLUGIN-SPEC）与 package.json（npm）。
 *   两份各自演进，改了一个忘改另一个 ⇒ 挂载脚本按 manifest 读 name/main，
 *   依赖解析按 package.json 读 —— 两边对不上时，症状是「挂上了但不是我以为的那个」，
 *   而且**不报错**。
 *
 * 权威源（2026-10-02 实测）：
 *   bin/agint-mount.sh:150,199 读 manifest.json 的 .name / .main / .config 来决定挂载；
 *   install/install.sh:734-747 把仓库 manifest.json **逐字节**同步到 host。
 *   ⇒ **manifest.json 是运行时权威**；package.json 是 npm 解析侧。
 *   因此 name / main 以 manifest 为准；version 谁是权威**没有文档定义**
 *   （实测 34 个插件里 14 个两边不一致），故 version 漂移只报不拦，等定权威源。
 *
 * 挂载声明才是「谁需要 manifest」的判据（2026-10-02 修订，修掉 3 处误报）：
 *   旧版对 plugins/* 做 glob，凡目录无 manifest.json 一律报警。实测 3 处全是误报 ——
 *     · agint-quality        是嵌套父容器，patch 里挂的是它的子模块，父目录本就不该有 manifest
 *     · agint-search-tools   在 cordis.patch.yml 里完全没有挂载声明
 *     · agint-session-extract 同上
 *   挂载脚本（agint-mount.sh）只处理 patch 里声明过的条目，所以**没被声明的目录缺 manifest
 *   不是风险**。改为从 cordis.patch.yml 的 `name: ./plugins/...` 行反查真实挂载集合，
 *   与 v0.9.0 的 4d 冒烟门禁同一思路：条目来源必须是 patch 里的真实声明，不是目录 glob。
 *   ⚠️ 正则必须锚定行首：patch 里存在被注释掉的条目（`# - id: agint-quality-report`），
 *      不锚定会把注释行当成真挂载（实测会多算 1 条）。
 *
 * 分档原则（为什么不一律 FAIL）：
 *   修订后实测 22 处不一致：14 处 version 漂移、8 处声明了却不存在的文件。
 *   ⚠️ 一个一上来就红的门禁比没有门禁更糟：它训练人忽略红灯。
 *   所以：破坏性的（name / main 指错）设 ERROR 默认拦；
 *        漂移性的设 WARN，`--strict` 才升级为失败（对齐 check-wiring 的 --strict 惯例）。
 *
 * 用法：
 *   node bin/verify-manifests.mjs            默认：只拦 ERROR
 *   node bin/verify-manifests.mjs --strict   ERROR + WARN 都拦
 *   node bin/verify-manifests.mjs --json      CI 消费
 *
 * 退出码：0 = 通过 / 1 = 有需处理项 / 2 = 脚本自身出错
 *
 * 零依赖：只用 node:fs / node:path / node:url。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const STRICT = argv.includes('--strict');

/** 顶层 plugins/ 下不作为独立插件参与校验的目录（聚合壳等）。 */
const SKIP_DIRS = new Set(['node_modules', 'lib', 'test']);

/**
 * manifest 里声明的相对路径字段 → 语义名。
 * 这些路径被 /install.sh 与挂载脚本引用，指向不存在的文件 = 声明在说谎。
 */
const DECLARED_PATH_FIELDS = [
  ['spec.docs.readme', (s) => s?.docs?.readme],
  ['spec.changelog', (s) => s?.changelog],
  ['spec.tests.entry', (s) => s?.tests?.entry],
];

const PATCH_FILE = join(REPO_ROOT, 'cordis.patch.yml');

/**
 * 从 cordis.patch.yml 反查「真正被挂载的插件目录」。
 *
 * 为什么不用目录 glob：见文件头注释。核心是挂载脚本只处理 patch 里声明过的条目。
 *
 * 目录归属的判定：条目形如 `./plugins/<dir>/<...>/lib/index.js`，但 `<...>` 有多深
 * 无法从字符串推断（顶层插件是 `X/lib/index.js`，quality 子模块是
 * `agint-quality/agint-quality-contract/lib/index.js`）。
 * 判据 = **最深的那层含有 manifest.json 或 package.json 的目录** —— 那才是插件根。
 * 两个实侧都成立：agint-memory/lib 无 manifest ⇒ 归到 agint-memory；
 * agint-quality/agint-quality-contract 有 package.json ⇒ 归到子模块而非父容器。
 *
 * @returns {{ok: boolean, reason?: string, dirs: Set<string>, entries: number}}
 */
export function loadMountedPluginDirs() {
  if (!existsSync(PATCH_FILE)) {
    return { ok: false, reason: `找不到 ${PATCH_FILE}`, dirs: new Set(), entries: 0 };
  }
  let yml;
  try {
    yml = readFileSync(PATCH_FILE, 'utf8');
  } catch (e) {
    return { ok: false, reason: `读取失败：${e?.message || e}`, dirs: new Set(), entries: 0 };
  }
  // ⚠️ 锚定行首：patch 里存在被注释掉的挂载条目，不锚定会误算进来。
  const specs = [
    ...new Set(
      [...yml.matchAll(/^\s*name:\s*['"]?(\.\/plugins\/[^'"\s]+)['"]?\s*$/gm)].map((m) => m[1]),
    ),
  ];
  const dirs = new Set();
  for (const spec of specs) {
    const parts = spec.replace(/^\.\/plugins\//, '').split('/');
    let picked = parts[0];
    for (let i = parts.length - 1; i >= 1; i--) {
      const cand = parts.slice(0, i).join('/');
      if (
        existsSync(join(PLUGINS_DIR, cand, 'manifest.json')) ||
        existsSync(join(PLUGINS_DIR, cand, 'package.json'))
      ) {
        picked = cand;
        break;
      }
    }
    dirs.add(picked);
  }
  if (dirs.size === 0) {
    return { ok: false, reason: 'patch 里未解析出任何 ./plugins/ 挂载条目', dirs, entries: specs.length };
  }
  return { ok: true, dirs, entries: specs.length };
}

function readJsonSafe(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** main 字段归一：'./lib/index.js' 与 'lib/index.js' 视为等价（实测存在这种写法差异）。 */
function normalizeMain(v) {
  if (typeof v !== 'string') return null;
  return v.replace(/^\.\//, '');
}

/**
 * 校验单个插件目录。抽成独立函数是为了可测：ERROR 级（name / main 指错）
 * 当前在真实仓库里是 0 处，光跑真实仓库无法证明它「该红时会红」，
 * 必须有能造坏数据的入口。
 *
 * @param {string} pluginDir 插件目录绝对路径
 * @param {string} dirName   目录名（用于 name 一致性比对）
 * @param {{mounted?: boolean}} opts
 *        mounted = 该目录是否在 cordis.patch.yml 里被声明挂载。
 *        默认 true（拿不到挂载声明时退化为「都当作已挂载」，保守不漏报）。
 *        只有 mounted 时缺 manifest 才算 ERROR —— 未挂载的目录挂载脚本根本不读。
 */
export function checkPlugin(pluginDir, dirName, opts = {}) {
  const mounted = opts.mounted !== false;
  const errors = [];
  const warnings = [];
  const notes = [];
  const mPath = join(pluginDir, 'manifest.json');
  const pPath = join(pluginDir, 'package.json');
  const hasM = existsSync(mPath);
  const hasP = existsSync(pPath);

  if (!hasM) {
    if (mounted) {
      // ERROR：被声明挂载却无 manifest ⇒ 挂载脚本读不到 .name/.main 直接 fail。
      // 该类在真实仓库当前为 0 处（3 处旧报全是误报），所以升级不引入新红灯。
      errors.push({
        plugin: dirName,
        kind: 'MANIFEST_MISSING',
        detail: '已挂载但无 manifest.json —— 挂载脚本（bin/agint-mount.sh:99）会直接 fail',
      });
    } else {
      notes.push({
        plugin: dirName,
        kind: 'NOT_MOUNTED_NO_MANIFEST',
        detail: 'cordis.patch.yml 无挂载声明，且无 manifest.json —— 挂载脚本不读它，不校验',
      });
    }
    return { errors, warnings, notes, hasManifest: false, hasPackage: hasP, mounted };
  }

  const mr = readJsonSafe(mPath);
  if (!mr.ok) {
    errors.push({ plugin: dirName, kind: 'MANIFEST_UNPARSEABLE', detail: mr.error });
    return { errors, warnings, notes, hasManifest: true, hasPackage: hasP, mounted };
  }
  const m = mr.value;

  // ── ERROR 级：身份错误（挂载会挂到错的 id / 找不到入口）──────────────
  if (typeof m.name === 'string' && m.name !== dirName) {
    errors.push({
      plugin: dirName,
      kind: 'NAME_DIR_MISMATCH',
      detail: `manifest.name="${m.name}" 与目录名 "${dirName}" 不一致`,
    });
  }

  if (typeof m.main === 'string' && normalizeMain(m.main)) {
    if (!existsSync(join(pluginDir, normalizeMain(m.main)))) {
      errors.push({
        plugin: dirName,
        kind: 'MAIN_NOT_FOUND',
        detail: `manifest.main="${m.main}" 指向的文件不存在`,
      });
    }
  }

  if (!hasP) {
    warnings.push({ plugin: dirName, kind: 'PACKAGE_MISSING', detail: '无 package.json' });
  } else {
    const pr = readJsonSafe(pPath);
    if (!pr.ok) {
      errors.push({ plugin: dirName, kind: 'PACKAGE_UNPARSEABLE', detail: pr.error });
    } else {
      const p = pr.value;
      if (p.name && m.name && p.name !== m.name) {
        errors.push({
          plugin: dirName,
          kind: 'NAME_MISMATCH',
          detail: `manifest.name="${m.name}" ≠ package.name="${p.name}"`,
        });
      }
      if (p.version && m.version && p.version !== m.version) {
        warnings.push({
          plugin: dirName,
          kind: 'VERSION_DRIFT',
          detail: `manifest.version=${m.version} ≠ package.version=${p.version}（权威源未定义，见脚本头注释）`,
        });
      }
      if (p.main && m.main && normalizeMain(p.main) !== normalizeMain(m.main)) {
        warnings.push({
          plugin: dirName,
          kind: 'MAIN_MISMATCH',
          detail: `manifest.main="${m.main}" ≠ package.main="${p.main}"`,
        });
      }
    }
  }

  // ── WARN 级：声明了却不存在的文件 ────────────────────────────────────
  const spec = m.spec || {};
  for (const [label, get] of DECLARED_PATH_FIELDS) {
    const rel = get(spec);
    if (typeof rel !== 'string' || rel === '') continue;
    if (!existsSync(join(pluginDir, rel))) {
      warnings.push({
        plugin: dirName,
        kind: 'DECLARED_FILE_MISSING',
        detail: `${label}="${rel}" 指向的文件不存在`,
      });
    }
  }

  for (const f of ['name', 'version', 'description', 'main']) {
    if (m[f] === undefined || m[f] === '') {
      warnings.push({ plugin: dirName, kind: 'FIELD_MISSING', detail: `manifest.${f} 缺失` });
    }
  }

  return { errors, warnings, notes, hasManifest: true, hasPackage: hasP, mounted };
}

function main() {
  if (!existsSync(PLUGINS_DIR)) {
    console.error(`[verify-manifests] 找不到 ${PLUGINS_DIR}`);
    process.exit(2);
  }

  const dirs = readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();

  const mount = loadMountedPluginDirs();
  // 拿不到挂载声明时退化：全部按「已挂载」校验（宁可多报，不可漏报），并显式告警。
  const mountKnown = mount.ok;

  const errors = [];
  const warnings = [];
  const notes = [];
  const stats = { plugins: dirs.length, withManifest: 0, withPackage: 0, mounted: 0, notMounted: 0 };

  for (const dir of dirs) {
    const isMounted = mountKnown ? mount.dirs.has(dir) : true;
    if (isMounted) stats.mounted++;
    else stats.notMounted++;
    const r = checkPlugin(join(PLUGINS_DIR, dir), dir, { mounted: isMounted });
    if (r.hasManifest) stats.withManifest++;
    if (r.hasPackage) stats.withPackage++;
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    notes.push(...r.notes);
  }

  // 嵌套挂载目录（如 agint-quality/agint-quality-contract）不在顶层 glob 范围内。
  // ⛔ 已知覆盖缺口，显式列出而不是假装没看见 —— 见下方输出说明。
  const uncovered = mountKnown
    ? [...mount.dirs].filter((d) => d.includes('/')).sort()
    : [];

  if (!mountKnown) {
    warnings.push({
      plugin: '(全局)',
      kind: 'MOUNT_SOURCE_UNREADABLE',
      detail: `无法从 cordis.patch.yml 解析挂载集合（${mount.reason}）—— 已退化为「全部按已挂载校验」，可能多报`,
    });
  }

  const failed = errors.length > 0 || (STRICT && warnings.length > 0);

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          stats,
          mountSource: { file: 'cordis.patch.yml', ok: mountKnown, entries: mount.entries, reason: mount.reason },
          uncoveredNestedMounts: uncovered,
          errors,
          warnings,
          notes,
          strict: STRICT,
          failed,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `[verify-manifests] 扫描 ${stats.plugins} 个插件目录` +
        `（manifest ${stats.withManifest} / package ${stats.withPackage}）`,
    );
    console.log(
      `  挂载判据：cordis.patch.yml ${mountKnown ? `${mount.entries} 条声明 → ${mount.dirs.size} 个插件目录` : `不可用（${mount.reason}）`}` +
        ` · 顶层已挂载 ${stats.mounted} / 未挂载 ${stats.notMounted}`,
    );
    console.log(`  ERROR ${errors.length} 处 · WARN ${warnings.length} 处` + (STRICT ? ' · --strict' : ''));

    if (errors.length > 0) {
      console.log(`\n  ✗ ERROR（默认即失败）:`);
      for (const e of errors) console.log(`     [${e.plugin}] ${e.kind}: ${e.detail}`);
    }
    if (warnings.length > 0) {
      console.log(`\n  ⚠️ WARN（${STRICT ? 'strict 模式下计为失败' : '默认不拦，--strict 才拦'}）:`);
      for (const w of warnings) console.log(`     [${w.plugin}] ${w.kind}: ${w.detail}`);
    }
    if (notes.length > 0) {
      console.log(`\n  · 不校验（未挂载，非问题）:`);
      for (const n of notes) console.log(`     [${n.plugin}] ${n.detail}`);
    }
    if (uncovered.length > 0) {
      console.log(
        `\n  ⚠️ 覆盖缺口：以下 ${uncovered.length} 个已挂载插件位于嵌套目录，不在本次顶层扫描范围内：`,
      );
      for (const d of uncovered) console.log(`     ${d}`);
      console.log(
        `     （纳入需先修 checkPlugin 的 name 比对：它拿全路径比 manifest.name，嵌套目录会误报 NAME_DIR_MISMATCH）`,
      );
    }
    if (errors.length === 0 && warnings.length === 0) {
      console.log('\n  ✓ 全部一致');
    }
  }

  process.exit(failed ? 1 : 0);
}

// 被 import 时（单测）不执行主流程，否则 process.exit 会把测试进程一起带走。
const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main();
