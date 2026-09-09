#!/usr/bin/env node
/**
 * _verify-dim10.mjs — plugin-check 维度 10「文档-代码公式一致性」(advisory) v0.1
 *
 * 提案 57541772-362f-4aed-bd4b-a598350482a4 v0.1（advisory，不阻断）。
 *
 * 检测目标：plugin 的 README.md / CHANGELOG.md 里写了加权合成公式，但 plugins/
 * 全仓 grep 无实现代码（"schema only" 型脱节）。
 *
 * 触发背景：2026-09-09 核实 HARM 加权公式 0.2·H + 0.3·A + 0.3·R + 0.2·M 在
 * docs/ + README.md 共 4 处命中，但 plugins/ 全仓 0 实现——属报告指标，未参与
 * policy 决策。读者照公式找代码会落空。
 *
 * 设计要点：
 * - advisory（不阻断），输出 [WARN] 而非 [FAIL]
 * - 豁免机制：注释里有 `// ALLOW-FORMULA-DOC` 标记的公式静默通过
 *   （仿 dim5.5 fixture 软警告惯例，避免误杀"故意保留的设计稿公式"）
 * - 公式识别 4 类：
 *   (a) HARM 风格加权：`0.2·H + 0.3·A` 或 `0.2*H + 0.3*A`
 *   (b) harmWeights 字段：`harmWeights: { H: 0.2, A: 0.3, ... }`
 *   (c) 通用权重表：`weight = { key1: 0.X, key2: 0.Y }`
 *   (d) 显式合成：`score = 0.X * x + 0.Y * y` 或 `compositeScore = w1*x + w2*y`
 *
 * 实现验证：对每条公式提取特征 token（如 `0.2.*H`），
 * grep -rE 到 plugins/ lib/ + lib/ 之外代码（缩小范围避免误中 plugin 自身），
 * 命中 → OK；0 命中 → WARN。
 *
 * 用法：node bin/_verify-dim10.mjs <plugin-dir>
 *       node bin/_verify-dim10.mjs <plugin-dir> --scan-root <abs-path>
 *           # 覆盖扫描根（默认 = plugin 自身 lib/）
 *       node bin/_verify-dim10.mjs <plugin-dir> --strict
 *           # 严格模式：0 实现 → exit 1（默认 advisory → exit 0）
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join as pjoin, relative, dirname, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
if (!args[0]) {
  console.error('usage: node bin/_verify-dim10.mjs <plugin-dir> [--scan-root <abs>] [--strict]');
  process.exit(2);
}

const pluginDir = args[0];
let scanRoot = null;
let strict = false;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--scan-root' && args[i+1]) { scanRoot = args[i+1]; i++; }
  else if (args[i] === '--strict') { strict = true; }
}

if (!existsSync(pluginDir)) {
  console.error(`[FAIL] plugin 目录不存在：${pluginDir}`);
  process.exit(1);
}

// 默认扫描根：找仓根 → 仓根/plugins/
//   - pluginDir 在 .../plugins/agint-X/ 时 → .../plugins/
//   - pluginDir 在 .../fixtures/dim10-detect/fixture-X/ 时 → pluginDir 同级（因为 fixtures/ 不在 plugins/ 下）
function findRepoRoot(start) {
  let cur = resolve(start);
  let prev = '';
  while (cur !== prev) {
    if (existsSync(pjoin(cur, '.git'))) return cur;
    prev = cur;
    cur = dirname(cur);
  }
  return null;
}

if (!scanRoot) {
  const repoRoot = findRepoRoot(pluginDir);
  // 优先用仓根（plugin 自己 + 仓内任何代码都可能含实现）
  if (repoRoot && existsSync(repoRoot)) {
    scanRoot = repoRoot;
  } else {
    scanRoot = dirname(pluginDir);
  }
}

console.log(`[dim10] plugin = ${pluginDir}`);
console.log(`[dim10] scan root = ${scanRoot}`);

/**
 * 公式识别器：扫 markdown 文件，返回 [{ file, line, formula, type, allow }]
 *   type ∈ { 'harm', 'harmWeights', 'weights', 'composite' }
 *   allow = true 表示该公式有豁免标记
 */
const FORMULA_PATTERNS = [
  {
    type: 'harm',
    // 匹配 `0.2·H + 0.3·A + 0.3·R + 0.2·M` 或 `0.2*H + 0.3*A` 风格
    re: /(\d+\.\d+)\s*[·\*]\s*([A-Za-z])\s*\+\s*(\d+\.\d+)\s*[·\*]\s*([A-Za-z])/,
  },
  {
    type: 'harmWeights',
    // 匹配 `harmWeights: { H: 0.2, A: 0.3, ... }`
    re: /harmWeights\s*[:=]\s*\{\s*([A-Za-z])\s*:\s*([\d.]+)\s*,\s*([A-Za-z])\s*:\s*([\d.]+)/,
  },
  {
    type: 'weights',
    // 匹配 `weights: { key1: 0.X, key2: 0.Y }` 通用权重表
    // 或 `weight: key1=0.X, key2=0.Y` 单行形式（quality-eval README line 43 用）
    re: /weight[s]?\s*[:=]\s*(?:\{[^}]*?\b([a-zA-Z_]+)\s*[:=]\s*([\d.]+)[^}]*?\b([a-zA-Z_]+)\s*[:=]\s*([\d.]+)|([a-zA-Z_]+)\s*=\s*([\d.]+)\s*,\s*([a-zA-Z_]+)\s*=\s*([\d.]+))/,
  },
  {
    type: 'composite',
    // 匹配 `score = 0.X * x + 0.Y * y` 或 `compositeScore(...)`
    re: /(?:compositeScore|computeComposite|score)\s*=?\s*\(?[^=]*(\d+\.\d+)\s*\*\s*([a-zA-Z_]+)/,
  },
];

function scanMarkdownForFormulas(filePath) {
  if (!existsSync(filePath)) return [];
  const src = readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  const findings = [];

  // 豁免标记：本文件任一行有 `<!-- ALLOW-FORMULA-DOC -->` 或 `// ALLOW-FORMULA-DOC`
  const allowFile = /ALLOW-FORMULA-DOC/.test(src);

  lines.forEach((line, idx) => {
    // 单行豁免：`<!-- ALLOW-FORMULA-DOC this line -->` 紧贴公式
    const allowLine = /ALLOW-FORMULA-DOC/.test(line);

    for (const { type, re } of FORMULA_PATTERNS) {
      const m = line.match(re);
      if (m) {
        findings.push({
          file: filePath,
          line: idx + 1,
          type,
          formula: line.trim().slice(0, 80),
          matchGroups: m,  // 保留原始捕获组，buildProbeRegex 时用
          allow: allowLine || allowFile,
        });
      }
    }
  });
  return findings;
}

/**
 * 把识别到的公式转成 JS 正则 RegExp 对象（用于查实现）
 * 关键设计：
 *   - 用 JS 正则（支持 lookbehind + word boundary），不依赖系统 grep
 *   - 用 `(?<!\w)` lookbehind 替代 `\b` 避免 `metric_b` 下划线边界问题
 *   - 用 `\s*` 容忍 `0.5  *  metric_b` 这种空白变体
 */
function buildProbeRegex(type, m) {
  let body;
  if (type === 'harm') {
    body = `${escapeRegex(m[1])}\\s*\\*?\\s*(?<!\\w)${escapeRegex(m[2])}(?!\\w)`;
  } else if (type === 'harmWeights') {
    body = `(?<!\\w)${escapeRegex(m[1])}(?!\\w)\\s*:\\s*${escapeRegex(m[2])}`;
  } else if (type === 'weights') {
    // weights 正则分两种形式：
    //   - block 形式 `weights: { key1: 0.X, ... }`：m[1] = key1, m[2] = val1, m[3] = key2, m[4] = val2
    //   - 单行形式 `weight: key1=0.X, key2=0.Y`：m[5] = key1, m[6] = val1, m[7] = key2, m[8] = val2
    // probe 用宽松模式 `key\s*[:=]\s*value`（兼容两种实现形式）
    if (m[1] !== undefined) {
      const key = m[1], val = m[2];
      body = `(?<!\\w)${escapeRegex(key)}(?!\\w)\\s*[:=]\\s*${escapeRegex(val)}`;
    } else {
      const key = m[5], val = m[6];
      body = `(?<!\\w)${escapeRegex(key)}(?!\\w)\\s*[:=]\\s*${escapeRegex(val)}`;
    }
  } else if (type === 'composite') {
    body = `${escapeRegex(m[1])}\\s*\\*\\s*(?<!\\w)${escapeRegex(m[2])}(?!\\w)`;
  } else {
    return null;
  }
  return new RegExp(body);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 遍历 scanRoot 下所有 .js/.mjs/.ts 文件，用正则找实现
 * 排除 pluginDir 自身（README 引用别处的实现算"外部实现"）
 */
function findImplementation(re, scanRoot, pluginDir) {
  const hits = [];
  walk(scanRoot, (filePath) => {
    if (!/\.(js|mjs|ts)$/.test(filePath)) return;
    const abs = resolve(filePath);
    // 排除 bin/ 目录（plugin-check / _verify-dim* 是检测脚本，不算"实现"）
    if (abs.includes(`${sep}bin${sep}`)) return;
    // 排除 fixtures 目录中**被检测 plugin 自身以外**的 fixture
    // （即 fixture-A 跑 dim10 时，fixture-A 自身的 lib/ 应被算 self-impl，
    //   fixture-B 的 lib/ 不应算 fixture-A 的实现——避免 cross-fixture 误报）
    if (abs.includes(`${sep}fixtures${sep}`)) {
      const absPlugin = resolve(pluginDir);
      if (!abs.startsWith(absPlugin)) return;
    }
    try {
      const src = readFileSync(filePath, 'utf8');
      if (re.test(src)) {
        hits.push(filePath);
      }
    } catch (_) { /* ignore unreadable */ }
  });
  return hits;
}

function walk(root, fn) {
  if (!existsSync(root)) return;
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    const p = pjoin(root, ent.name);
    if (ent.isDirectory()) walk(p, fn);
    else if (ent.isFile()) fn(p);
  }
}

/**
 * 用 grep -rE 在 scanRoot 找 probePattern（避免 plugin 自身目录）
 * （v0.1 旧实现，已被 findImplementation 替代，仅保留作 fallback）
 */
function grepImplementation(probe, excludeDir) {
  if (!probe) return { hit: false, files: [] };
  try {
    const out = execFileSync('grep', [
      '-rE', '--include=*.js', '--include=*.mjs', '--include=*.ts',
      probe,
      scanRoot,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 10 * 1024 * 1024,
    });
    const files = out.trim().split('\n')
      .map((l) => l.split(':')[0])
      .filter((f, i, a) => a.indexOf(f) === i);
    return { hit: files.length > 0, files };
  } catch (e) {
    return { hit: false, files: [] };
  }
}

// ── 主流程 ──
const mdFiles = [
  pjoin(pluginDir, 'README.md'),
  pjoin(pluginDir, 'CHANGELOG.md'),
];
let total = 0, warns = 0, oks = 0, skipped = 0;

for (const f of mdFiles) {
  const findings = scanMarkdownForFormulas(f);
  if (findings.length === 0) continue;
  console.log(`\n[dim10] scan ${relative(process.cwd(), f)} (${findings.length} formula hit${findings.length === 1 ? '' : 's'})`);

  for (const fnd of findings) {
    total++;
    if (fnd.allow) {
      console.log(`  [SKIP] line ${fnd.line} (${fnd.type}) ALLOW-FORMULA-DOC 标记：${fnd.formula}`);
      skipped++;
      continue;
    }

    const re = buildProbeRegex(fnd.type, fnd.matchGroups);
    const implFiles = re ? findImplementation(re, scanRoot, pluginDir) : [];

    if (implFiles.length > 0) {
      console.log(`  [ OK ] line ${fnd.line} (${fnd.type}) 实现命中：`);
      implFiles.slice(0, 3).forEach((p) => console.log(`         ${relative(process.cwd(), p)}`));
      oks++;
    } else {
      console.log(`  [WARN] line ${fnd.line} (${fnd.type}) 文档有公式但 plugins/ 无外部实现：${fnd.formula}`);
      console.log(`         probe: ${re}`);
      warns++;
    }
  }
}

console.log(`\n[dim10] 汇总：${total} 公式，${oks} OK / ${warns} WARN / ${skipped} SKIP`);
const exitCode = strict && warns > 0 ? 1 : 0;
process.exit(exitCode);