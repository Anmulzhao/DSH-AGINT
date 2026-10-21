#!/usr/bin/env node
/**
 * bin/check-boundary.mjs —— AGINT 能力边界门禁
 *
 * WHY
 * ---
 * `docs/capability-boundary.md` 把「一件事该 dsh 做还是 AGINT 做」写成了契约。
 * 但契约如果只停在文档里，它就是一句会被人忘记的话 —— 新插件照样造轮子，
 * 机器私有路径照样进库，宿主改一次照样瞎。
 *
 * 所以本门禁把契约里**可机械判定**的三条变成红灯：
 *   B1 机器私有绝对路径不得进入库文件
 *   B2 宿主层能力不得在 AGINT 侧自建（会话文件发现 / zstd 解压 / token 计量）
 *   B3 边界契约的插件归属表必须覆盖 plugins/ 下的每一个插件
 *
 * ★ 为什么用基线对账，而不是「违规即红」
 *   现实是 B1/B2 现在**已经有存量**（见 docs/capability-boundary.md §4 F2/F3/F4）。
 *   一上来就全红的门禁比没有门禁更糟：它训练人学会忽略红灯（对齐 check-zero-deps 的教训）。
 *   所以规则是：
 *     · 命中项不在基线里  ⇒ ERROR，exit 1（**新增越界 = 红**）
 *     · 命中项在基线里    ⇒ INFO（**已知欠账**，附编号与 reason）
 *     · 基线项代码里已消失 ⇒ INFO（已修，建议从基线移除）
 *   基线文件是 checked-in 的，且每条必须带 reason —— 没有门禁的排除名单就是后门（G5）。
 *
 * 用法：
 *   node bin/check-boundary.mjs            人读输出
 *   node bin/check-boundary.mjs --json     机器读
 *   node bin/check-boundary.mjs --strict    基线里的欠账也算失败（收敛期用）
 *
 * 退出码：0 = 无新增违规 / 1 = 有新增违规 / 2 = 脚本自身出错
 *
 * 零依赖：只用 node:fs / node:path / node:url。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(REPO_ROOT, 'docs', 'boundary-baseline.json');
const CONTRACT_PATH = join(REPO_ROOT, 'docs', 'capability-boundary.md');

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const STRICT = argv.includes('--strict');

// ── 扫描范围 ────────────────────────────────────────────────────────────────
// 只扫运行时代码：plugins/<plugin>/lib/** 与 plugins/<plugin>/*.js（入口）。
// ⛔ 不扫 test/ 与 fixtures/：测试里会出现模板串写的假路径与假包名。
const SCAN_EXTS = /\.(m?js|cjs)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'test', '__tests__', 'fixtures', 'dist', 'build']);
const SKIP_FILE_RE = /\.(test|spec)\.(m?js|cjs)$/;

// ── B1 机器私有绝对路径 ─────────────────────────────────────────────────────
// 盘符 + 路径分隔符。排除 `://`（URL 的协议分隔符，https:// 不算盘符）。
const RE_ABS_PATH = /(?<![\w.])([A-Za-z]):[\\/](?![\\/])/g;

/**
 * 行级代码掩码：标出**真正含代码**的行。
 *
 * 为什么用行级而不是全字符状态机：全状态机要正确处理「字符串里的 //」与
 * 「正则里的引号」，两处都容易写错，而写错的表现是**门禁漏报**（比误报更坏）。
 * 行级判定只依赖三件事：行首是 `//`、行首是 `/*`、处于块注释区间内 ——
 * 本仓注释风格统一，这三件事足够准。
 *
 * 代价：代码行**尾部**的行注释不会被剥掉（如 `const x = 1; // D:/foo`）。
 * 因此 B1 路径判定额外要求路径落在**字符串字面量内** —— 尾部注释里的路径
 * 不是字符串，不会被匹配。
 */
export function codeLineMask(src) {
  const lines = src.split('\n');
  const mask = new Array(lines.length).fill(true);
  let inBlock = false;
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (inBlock) {
      mask[i] = false;
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('//')) {
      mask[i] = false;
      continue;
    }
    if (t.startsWith('/*')) {
      mask[i] = false;
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
    // 行内开启块注释：这一行本身算代码行，但后续行进块注释区
    const bi = t.indexOf('/*');
    if (bi >= 0 && !t.includes('*/')) inBlock = true;
  }
  return mask;
}

/**
 * 提取一行里的字符串字面量内容（单引号 / 双引号 / 模板串）。
 * 跳过转义。返回内容数组（不含引号）。
 */
export function extractStringLiterals(line) {
  const out = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    const q = line[i];
    if (q !== "'" && q !== '"' && q !== '`') {
      i += 1;
      continue;
    }
    let j = i + 1;
    let buf = '';
    while (j < n) {
      if (line[j] === '\\') {
        buf += line[j + 1] ?? '';
        j += 2;
        continue;
      }
      if (line[j] === q) break;
      buf += line[j];
      j += 1;
    }
    out.push(buf);
    i = j + 1;
  }
  return out;
}

// 明确允许出现盘符的地方：AGINT_HOME / DSH_HOME 这类**环境变量占位**的默认值，
// 以及明确的相对路径回退（如 'D:/Tools' 属机器私有，必须报）。
// 例外只给「变量插值形态」：`${AGINT_HOME}/...` 之类，天然不含盘符，无需例外。
// 例外给 Windows 的 `C:` 出现在纯文本注释里的情况也不开 —— 注释里的机器私有路径
// 同样会误导另一台机器（AGENTS.md 红线：机器私有事实不进入库文件）。

// ── B2 宿主层能力自建 ───────────────────────────────────────────────────────
// 每条规则给出：类别、判定正则、为什么属于宿主层。
const HOST_CAPABILITY_RULES = [
  {
    id: 'session-log-name-table',
    // 会话日志文件名表：宿主改了名，AGINT 这张表就瞎（2026-09-22 事故，断了 12 天）。
    re: /session\.v\d+\.jsonl\.zstd/g,
    why: '会话日志命名属宿主格式，应消费 ctx.sessionQuery，不该在 AGINT 侧持名字表',
  },
  {
    id: 'zstd-self-decompress',
    // 自建 zstd 解压：宿主已有会话持久化与 sessionQuery 解码能力。
    re: /['"]-dc['"]|zstd\.exe|\bzstd\s+-d/g,
    why: 'zstd 解压属宿主层；AGINT 应读上游已解码内容，不该自己拉二进制',
  },
  {
    id: 'token-metering-selfbuild',
    // 自建 token 计量：dsh 0.2.1 已有 ctx.tokenMeter（确定性、不调模型）。
    re: /\b(tokenCost|avgTokenCost|promptTokens|completionTokens|totalTokenCount)\b/g,
    why: 'token 计量属宿主层（ctx.tokenMeter），AGINT 只该消费',
  },
];

// ── 基线 ────────────────────────────────────────────────────────────────────
// ⛔ 基线文件缺失 = 门禁失去记账入口，直接报错而不是静默放行。
let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
} catch (e) {
  console.error(`[check-boundary] 读不到基线 ${BASELINE_PATH}: ${e?.message || e}`);
  process.exit(2);
}
const baselineItems = Array.isArray(baseline.items) ? baseline.items : [];
const baselineByKey = new Map(baselineItems.map((it) => [`${it.category}|${it.file}`, it]));

// ── 文件收集 ────────────────────────────────────────────────────────────────
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
    } else if (SCAN_EXTS.test(e.name) && !SKIP_FILE_RE.test(e.name)) {
      acc.push(abs);
    }
  }
  return acc;
}

function scanTargets() {
  const out = [];
  const pluginsDir = join(REPO_ROOT, 'plugins');
  if (!existsSync(pluginsDir)) return out;
  for (const e of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const pdir = join(pluginsDir, e.name);
    const libDir = join(pdir, 'lib');
    if (existsSync(libDir)) out.push(...collectFiles(libDir));
    // 顶层入口（index.js 等）
    for (const f of readdirSync(pdir, { withFileTypes: true })) {
      if (f.isFile() && SCAN_EXTS.test(f.name) && !SKIP_FILE_RE.test(f.name)) {
        out.push(join(pdir, f.name));
      }
    }
  }
  return out;
}

// ── B3 归属表覆盖 ───────────────────────────────────────────────────────────
// 解析契约 §2 的表格第一列。粗解析（`| name | v | 层 | ...`），
// 但足以保证「新增插件必须被裁决归属」，且不依赖 Markdown 全文命中。
function contractOwnedPlugins() {
  let md;
  try {
    md = readFileSync(CONTRACT_PATH, 'utf8');
  } catch {
    return null;
  }
  const set = new Set();
  const re = /^\|\s*\*{0,2}(agint-[a-z0-9-]+)\*{0,2}\s*\|/gm;
  let m;
  while ((m = re.exec(md))) set.add(m[1]);
  return set;
}

function topLevelPlugins() {
  const pluginsDir = join(REPO_ROOT, 'plugins');
  const out = [];
  for (const e of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.startsWith('agint-')) out.push(e.name);
  }
  return out.sort();
}

/**
 * 扫一个文件的边界违规。纯函数，可被单测直接调用。
 * @param {string} src 源码
 * @param {string} rel 仓库相对路径（用于报告）
 */
export function findViolations(src, rel) {
  const findings = [];
  const srcLines = src.split('\n');
  const mask = codeLineMask(src);

  // B1 机器私有路径：路径必须落在**字符串字面量内**且所在行是代码行
  for (let li = 0; li < srcLines.length; li += 1) {
    if (!mask[li]) continue;
    for (const lit of extractStringLiterals(srcLines[li])) {
      for (const m of lit.matchAll(RE_ABS_PATH)) {
        findings.push({
          category: 'machine-private-path',
          file: rel,
          line: li + 1,
          evidence: m[0].trim(),
          why: '机器私有绝对路径不得进库（AGENTS.md 红线）；本机值进 AGENTS.local.md',
        });
      }
    }
  }

  // B2 宿主层能力自建：只看代码行（注释里的举例不算）
  for (let li = 0; li < srcLines.length; li += 1) {
    if (!mask[li]) continue;
    const line = srcLines[li];
    for (const rule of HOST_CAPABILITY_RULES) {
      for (const m of line.matchAll(rule.re)) {
        findings.push({
          category: rule.id,
          file: rel,
          line: li + 1,
          evidence: m[0].trim(),
          why: rule.why,
        });
      }
    }
  }
  return findings;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
function main() {
  const files = scanTargets();
  const findings = [];

  for (const abs of files) {
    let src;
    try {
      src = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(REPO_ROOT, abs).split(sep).join('/');
    findings.push(...findViolations(src, rel));
  }

  // 去重：同一文件同一类别同一行只报一次
  const seen = new Set();
  const deduped = [];
  for (const f of findings) {
    const k = `${f.category}|${f.file}|${f.line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(f);
  }

  // 与基线对账
  const errors = [];
  const known = [];
  const hitKeys = new Set();
  for (const f of deduped) {
    const key = `${f.category}|${f.file}`;
    hitKeys.add(key);
    const b = baselineByKey.get(key);
    if (b) known.push({ ...f, baseline: b });
    else errors.push(f);
  }
  const stale = baselineItems.filter((it) => !hitKeys.has(`${it.category}|${it.file}`));

  // B3
  const owned = contractOwnedPlugins();
  const uncovered = [];
  if (owned) {
    for (const p of topLevelPlugins()) {
      if (!owned.has(p)) uncovered.push(p);
    }
  } else {
    errors.push({
      category: 'contract-missing',
      file: relative(REPO_ROOT, CONTRACT_PATH).split(sep).join('/'),
      line: 0,
      evidence: 'read failed',
      why: '边界契约文件不可读 ⇒ B3 无法判定',
    });
  }
  for (const p of uncovered) {
    errors.push({
      category: 'plugin-unclassified',
      file: `plugins/${p}`,
      line: 0,
      evidence: p,
      why: '新增插件未在 docs/capability-boundary.md §2 归属表里裁决归属',
    });
  }

  const failed = errors.length > 0 || (STRICT && known.length > 0);

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          scannedFiles: files.length,
          errors,
          known: known.map((k) => ({ category: k.category, file: k.file, line: k.line, id: k.baseline?.id, reason: k.baseline?.reason })),
          staleBaseline: stale.map((s) => ({ id: s.id, category: s.category, file: s.file })),
          contractPath: relative(REPO_ROOT, CONTRACT_PATH).split(sep).join('/'),
          baselinePath: relative(REPO_ROOT, BASELINE_PATH).split(sep).join('/'),
          strict: STRICT,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`[check-boundary] 扫描 ${files.length} 个运行时文件（plugins/*/lib + 顶层入口）`);
    console.log(`  契约: ${relative(REPO_ROOT, CONTRACT_PATH).split(sep).join('/')}   基线: ${relative(REPO_ROOT, BASELINE_PATH).split(sep).join('/')}`);

    if (known.length > 0) {
      console.log(`\n  ℹ️ 已知欠账 ${known.length} 处（基线登记，非新增）:`);
      for (const k of known) {
        console.log(`     [${k.baseline?.id ?? '?'}] ${k.file}:${k.line}  ${k.category}  — ${k.baseline?.reason ?? ''}`);
      }
    }

    if (stale.length > 0) {
      console.log(`\n  ⓘ 基线已失效 ${stale.length} 条（代码里已消失，建议从基线移除）:`);
      for (const s of stale) console.log(`     [${s.id}] ${s.file}  ${s.category}`);
    }

    if (errors.length > 0) {
      console.log(`\n  ✗ 新增越界 ${errors.length} 处（exit 1）:`);
      for (const e of errors) {
        console.log(`     ${e.file}${e.line ? ':' + e.line : ''}  [${e.category}]  ${e.evidence}`);
        console.log(`        └ ${e.why}`);
      }
      console.log(
        `\n  处置：① 改为消费 dsh 上游能力；② 确有理由自建 ⇒ 在 ` +
          `${relative(REPO_ROOT, BASELINE_PATH).split(sep).join('/')} 登记条目并写明 reason。`,
      );
    } else {
      console.log('\n  ✓ 无新增越界');
    }

    if (STRICT && known.length > 0) {
      console.log(`\n  ⚠️ --strict：已知欠账 ${known.length} 处也算失败（收敛期用）`);
    }
  }

  process.exit(failed ? 1 : 0);
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main();
