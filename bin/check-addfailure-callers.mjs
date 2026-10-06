#!/usr/bin/env node
/**
 * check-addfailure-callers.mjs — addFailure 调用点值域门禁（防复发，立项 H6 配套）
 *
 * ── 为什么 ────────────────────────────────────────────────────────────────
 * 2026-10-06 实测：全仓 14 个 `addFailure({` 调用点里 7 个传越界 category/severity
 * （mount/population/prompt/governance/harmony/self-model）。旧行为 `.parse()` 抛错
 * 被调用方 catch{} 静默吞 ⇒ 真实失败无声丢行、diagnosis 供料饿死（8 行 vs 门槛 10）。
 * evolution-memory 0.6.14 已把入口收口（映射表归一化，`docs/立项-失败供料通道修复-20261006.md`）。
 * 本脚本防的是**复发**：新的调用点传一个映射表没有的值 ⇒ CI/本地 exit 1，
 * 而不是又多一条静默死路。
 *
 * ── 判据 ──────────────────────────────────────────────────────────────────
 * 值域单一真源 = `plugins/agint-evolution-memory/lib/schema.js` 的
 * FAILURE_CATEGORIES / FAILURE_SEVERITIES / FAILURE_CATEGORY_MAP / FAILURE_SEVERITY_MAP。
 * 调用点字面量合法条件：category ∈ 枚举 ∪ 映射键；severity ∈ 枚举 ∪ 映射键。
 * 非字面量（`category: someVar`）记 dynamic 不判负——值域由运行时归一化兜底。
 *
 * 用法：node bin/check-addfailure-callers.mjs          （扫描全仓）
 *      import { scanPluginLibs, checkSource } from ...  （测试用）
 *
 * 注：老板 §6 决策点 3「是否接入 plugin-check.sh 阻断位」**未拍** ⇒ 本脚本暂不进
 * plugin-check，先独立可跑；拍板后在 plugin-check.sh 末尾加一行即可。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import {
  FAILURE_CATEGORIES,
  FAILURE_SEVERITIES,
  FAILURE_CATEGORY_MAP,
  FAILURE_SEVERITY_MAP,
} from '../plugins/agint-evolution-memory/lib/schema.js';

const ALLOWED_CATEGORY = new Set([...FAILURE_CATEGORIES, ...Object.keys(FAILURE_CATEGORY_MAP)]);
const ALLOWED_SEVERITY = new Set([...FAILURE_SEVERITIES, ...Object.keys(FAILURE_SEVERITY_MAP)]);

const WINDOW = 500; // addFailure({ 之后多少字符内找值字面量

function walkLibFiles(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkLibFiles(p, out);
    else if (e.isFile() && e.name.endsWith('.js') && !e.name.includes('.bak-')) out.push(p);
  }
  return out;
}

/** 单文件源码 → 违规列表 + dynamic 计数（纯函数，测试直接用） */
export function checkSource(src, label = '<string>') {
  const violations = [];
  const dynamics = [];
  const re = /addFailure\(\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const win = src.slice(m.index, m.index + WINDOW);
    const catLit = win.match(/category:\s*'([^']*)'/);
    const catDyn = /category:\s*(?!')([A-Za-z_][\w.]*\w)/.exec(win);
    const sevLit = win.match(/severity:\s*'([^']*)'/);
    const sevDyn = /severity:\s*(?!')([A-Za-z_][\w.]*\w)/.exec(win);
    if (catLit && !ALLOWED_CATEGORY.has(catLit[1])) violations.push({ file: label, kind: 'category', value: catLit[1] });
    if (sevLit && !ALLOWED_SEVERITY.has(sevLit[1])) violations.push({ file: label, kind: 'severity', value: sevLit[1] });
    if (catLit === null && catDyn) dynamics.push({ file: label, kind: 'category', value: catDyn[1] });
    if (sevLit === null && sevDyn) dynamics.push({ file: label, kind: 'severity', value: sevDyn[1] });
  }
  return { violations, dynamics };
}

export function scanPluginLibs(pluginsDir) {
  const files = walkLibFiles(pluginsDir, []);
  const all = { violations: [], dynamics: [], files: files.length, sites: 0 };
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (!src.includes('addFailure')) continue;
    const r = checkSource(src, relative(process.cwd(), f).replace(/\\/g, '/'));
    all.sites += r.violations.length + r.dynamics.length;
    all.violations.push(...r.violations);
    all.dynamics.push(...r.dynamics);
  }
  return all;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pluginsDir = join(process.cwd(), 'plugins');
  const r = scanPluginLibs(pluginsDir);
  console.log(`check-addfailure-callers：扫描 ${r.files} 个 lib 文件`);
  for (const d of r.dynamics) console.log(`  dynamic（不判负）: ${d.file} ${d.kind}=${d.value}`);
  if (r.violations.length) {
    for (const v of r.violations) console.error(`  ✖ 越界字面量: ${v.file} ${v.kind}='${v.value}'（不在 枚举∪映射表，见 schema.js FAILURE_CATEGORY_MAP）`);
    console.error(`结论: FAIL（${r.violations.length} 处）`);
    process.exit(1);
  }
  console.log('结论: PASS（0 越界字面量）');
}
