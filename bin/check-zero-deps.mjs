#!/usr/bin/env node
/**
 * bin/check-zero-deps.mjs —— 零第三方依赖纪律门禁（G9，Tier A）
 *
 * 为什么需要它（设计 §5.2.1 G9 + §附录 C 修订说明第 3 条）：
 *   设计文档明确「运行时消费的 schema 一律 JSON，避免引入 yaml npm 依赖
 *   （AGINT 仓不引入第三方运行时依赖）」。这是一条**纪律**，而纪律如果不进
 *   门禁，就只是一句会被人忘记的话 —— 加依赖的那个 PR 不会有任何红灯。
 *
 * ★ 现实校准（2026-10-02 实测，别照抄设计想当然）：
 *   仓库里确实存在裸包名 import，但它们**都不是** npm 引入的第三方依赖：
 *     - @deepseek-ai/*  —— dsh 宿主 runtime 提供（install.sh 建 junction 解析）
 *     - zod             —— install.sh 步骤 1.5 从 dsh node_modules bootstrap
 *     - react           —— 仅出现在 __ModuleLoader__ 的浏览器模块表上下文
 *   一刀切禁所有裸包名 ⇒ 现有代码 55+ 处立刻全红 ⇒ 门禁第一天就被绕过。
 *   ⚠️ 一个一上来就红的门禁，比没有门禁更糟：它训练人学会忽略红灯。
 *   因此白名单是**必需的**，且必须 checked-in 且每条带 reason
 *   （G5：没有门禁的排除名单就是后门）。
 *
 * 扫描范围（设计 §5.2.1）：bin/ 与 plugins/<plugin>/lib/
 *   —— 不扫 test/：测试里会出现模板串写的假包名（如 ${CONTRACT_TOKEN}）。
 *
 * 用法：
 *   node bin/check-zero-deps.mjs            人读输出
 *   node bin/check-zero-deps.mjs --json     CI 消费
 *   node bin/check-zero-deps.mjs --strict   BUILTIN_NO_PREFIX 也算失败
 *
 * 退出码（对齐 check-wiring.mjs）：0 = 无违规 / 1 = 有违规 / 2 = 脚本自身出错
 *
 * 零依赖：只用 node:fs / node:path / node:url。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_PATH = join(REPO_ROOT, 'docs', 'zero-deps-allowlist.json');

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const STRICT = argv.includes('--strict');

/** Node 内置模块（不带 node: 前缀时用于提示，不算第三方）。 */
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'crypto', 'dgram',
  'dns', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
  'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm',
  'worker_threads', 'zlib',
]);

const SCAN_EXTS = /\.(m?js|cjs|mts|ts)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'test', '__tests__', 'dist', 'build']);
// ⛔ 跳过测试文件：单测里为了验证「能拦住第三方包」，会写 'express' / 'lodash'
//    这类假包名做夹具（见 bin/check-zero-deps.test.mjs）。它们不是运行时依赖，
//    扫进来只会让门禁自己把自己判红 —— 一个连自己都过不了的门禁没人会信。
//    代价：测试文件里真加了 npm 依赖不会被扫到。可接受 —— 纪律针对的是运行时代码。
const SKIP_FILE_RE = /\.(test|spec)\.(m?js|cjs|ts)$/;

// ── 白名单 ──────────────────────────────────────────────────────────────────
// ⛔ 清单文件缺失 = 门禁失去治理入口，直接报错而不是静默放行（对齐 check-wiring）。
let allowlist;
try {
  allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
} catch (e) {
  console.error(`[check-zero-deps] 读不到白名单 ${ALLOWLIST_PATH}: ${e?.message || e}`);
  process.exit(2);
}
const allowPrefixes = (allowlist.allowPrefixes || []).map((x) => x.prefix);
const allowExact = new Set((allowlist.allowExact || []).map((x) => x.name));

// ── 收集文件 ────────────────────────────────────────────────────────────────
function collectFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collectFiles(abs, acc);
    } else if (SCAN_EXTS.test(e.name) && !e.name.endsWith('.d.ts') && !SKIP_FILE_RE.test(e.name)) {
      acc.push(abs);
    }
  }
  return acc;
}

function scanTargets() {
  const out = [];
  out.push(...collectFiles(join(REPO_ROOT, 'bin')));
  const pluginsDir = join(REPO_ROOT, 'plugins');
  if (!existsSync(pluginsDir)) return out;
  for (const e of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const libDir = join(pluginsDir, e.name, 'lib');
    if (existsSync(libDir)) out.push(...collectFiles(libDir));
  }
  return out;
}

// ── 提取 import/require 的 specifier ────────────────────────────────────────
const RE_STATIC_IMPORT = /(?:^|[\s;}])(?:import|export)\s[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const RE_BARE_IMPORT = /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g;
const RE_DYNAMIC_IMPORT = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const RE_REQUIRE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export function extractSpecifiers(src) {
  const specs = [];
  const push = (spec) => {
    // ⛔ 跳过模板串占位（测试里会出现 '${CONTRACT_TOKEN}' 之类的假包名）。
    if (spec.includes('${')) return;
    specs.push(spec);
  };
  for (const re of [RE_STATIC_IMPORT, RE_BARE_IMPORT, RE_DYNAMIC_IMPORT, RE_REQUIRE]) {
    for (const m of src.matchAll(re)) push(m[1]);
  }
  return specs;
}

// ── 判定 ────────────────────────────────────────────────────────────────────
export function classify(spec) {
  // 相对/绝对路径：仓库内部，永远合法
  if (spec.startsWith('.') || spec.startsWith('/')) return 'LOCAL';
  // node: 前缀
  if (spec.startsWith('node:')) return 'NODE_PREFIXED';
  // 白名单：前缀匹配
  for (const p of allowPrefixes) if (spec.startsWith(p)) return 'ALLOWLISTED';
  // 白名单：精确匹配
  if (allowExact.has(spec)) return 'ALLOWLISTED';
  // 裸内置模块：不是第三方，但建议补 node: 前缀
  if (NODE_BUILTINS.has(spec)) return 'BUILTIN_NO_PREFIX';
  return 'THIRD_PARTY';
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
function main() {
  const files = scanTargets();
  const violations = [];
  const builtinNoPrefix = [];
  const allowlisted = new Map();

  for (const abs of files) {
    let src;
    try {
      src = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(REPO_ROOT, abs).split(sep).join('/');
    const seen = new Set();
    for (const spec of extractSpecifiers(src)) {
      const kind = classify(spec);
      const key = `${rel}::${spec}`;
      if (seen.has(spec)) continue;
      seen.add(spec);
      if (kind === 'THIRD_PARTY') {
        violations.push({ file: rel, spec });
      } else if (kind === 'BUILTIN_NO_PREFIX') {
        builtinNoPrefix.push({ file: rel, spec });
      } else if (kind === 'ALLOWLISTED') {
        allowlisted.set(spec, (allowlisted.get(spec) || 0) + 1);
      }
    }
  }

  const strictFail = STRICT && builtinNoPrefix.length > 0;
  const failed = violations.length > 0 || strictFail;

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          scannedFiles: files.length,
          violations,
          builtinNoPrefix,
          allowlisted: Object.fromEntries([...allowlisted].sort()),
          allowlistPath: relative(REPO_ROOT, ALLOWLIST_PATH).split(sep).join('/'),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`[check-zero-deps] 扫描 ${files.length} 个文件（bin/ + plugins/*/lib/）`);
    console.log(`  白名单命中（允许）: ${[...allowlisted.keys()].sort().join(', ') || '(无)'}`);

    if (builtinNoPrefix.length > 0) {
      console.log(`\n  ⚠️ 裸内置模块 ${builtinNoPrefix.length} 处（建议补 node: 前缀，非第三方）:`);
      for (const v of builtinNoPrefix) console.log(`     ${v.file} → ${v.spec}`);
    }

    if (violations.length > 0) {
      console.log(`\n  ✗ 第三方依赖违规 ${violations.length} 处:`);
      for (const v of violations) console.log(`     ${v.file} → ${v.spec}`);
      console.log(
        `\n  若为宿主提供（dsh runtime / __ModuleLoader__ 浏览器模块表），` +
          `请向 ${relative(REPO_ROOT, ALLOWLIST_PATH).split(sep).join('/')} 添加条目并写明 reason。`,
      );
    } else {
      console.log('\n  ✓ 无第三方依赖违规');
    }
  }

  process.exit(failed ? 1 : 0);
}

// 被 import 时（单测）不执行主流程，否则 process.exit 会把测试进程一起带走。
// ⛔ 两侧必须是同一种形式：fileURLToPath 出来的是带反斜杠的 Windows 路径，
//    pathToFileURL().href 出来的是 file:/// URL —— 拿它俩比永远不相等，
//    结果是 main() 从不执行、门禁假绿（静默失败，比报错危险得多）。
const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main();
