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
 * 分档原则（为什么不一律 FAIL）：
 *   实测当前有 26 处不一致，其中 14 处是 version 漂移、8 处是声明了却不存在的文件。
 *   一刀切 FAIL ⇒ 门禁第一天就红 26 处 ⇒ 没人会去修，只会学会绕过它。
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
 */
export function checkPlugin(pluginDir, dirName) {
  const errors = [];
  const warnings = [];
  const mPath = join(pluginDir, 'manifest.json');
  const pPath = join(pluginDir, 'package.json');
  const hasM = existsSync(mPath);
  const hasP = existsSync(pPath);

  if (!hasM) {
    warnings.push({
      plugin: dirName,
      kind: 'MANIFEST_MISSING',
      detail: '无 manifest.json —— 挂载脚本（bin/agint-mount.sh:99）会直接 fail',
    });
    return { errors, warnings, hasManifest: false, hasPackage: hasP };
  }

  const mr = readJsonSafe(mPath);
  if (!mr.ok) {
    errors.push({ plugin: dirName, kind: 'MANIFEST_UNPARSEABLE', detail: mr.error });
    return { errors, warnings, hasManifest: true, hasPackage: hasP };
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

  return { errors, warnings, hasManifest: true, hasPackage: hasP };
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

  const errors = [];
  const warnings = [];
  const stats = { plugins: dirs.length, withManifest: 0, withPackage: 0 };

  for (const dir of dirs) {
    const r = checkPlugin(join(PLUGINS_DIR, dir), dir);
    if (r.hasManifest) stats.withManifest++;
    if (r.hasPackage) stats.withPackage++;
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }

  const failed = errors.length > 0 || (STRICT && warnings.length > 0);

  if (AS_JSON) {
    console.log(
      JSON.stringify({ stats, errors, warnings, strict: STRICT, failed }, null, 2),
    );
  } else {
    console.log(
      `[verify-manifests] 扫描 ${stats.plugins} 个插件目录` +
        `（manifest ${stats.withManifest} / package ${stats.withPackage}）`,
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
