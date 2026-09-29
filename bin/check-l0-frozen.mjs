#!/usr/bin/env node
/**
 * check-l0-frozen.mjs — L0 FROZEN 契约变更检测（补 AGENTS.md / evolution-framework.md §8.2
 * 里「CI 任务检测到 L0 字段修改自动失败」这条**从未实现**的护栏）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * AGENTS.md：「L0 变更（agint-quality-contract FROZEN 字段）人类多签 + 7 天影子模式 +
 * major 版本 + 旧版保留 ≥3 minor 周期。**CI 自动失败检测**。」
 * docs/evolution-framework.md §8.2：「CI 禁改（CI 任务检测到 L0 字段修改自动失败）」。
 *
 * 实测（2026-09-29）：`bin/` 下 24 个脚本 grep `FROZEN` **零命中**，
 * `.github/workflows/` 目录**不存在**。也就是说这条护栏是**纸面约定** ——
 * 改 FROZEN 字段不会被任何自动化拦截，全靠人记得别改。
 * 这条脚本就是把它变成真的。
 *
 * ── 冻结单元怎么定 ──────────────────────────────────────────────────────────
 * 源文件 `plugins/agint-quality/agint-quality-contract/lib/index.js` 里 `@frozen`
 * 标记有 11 处，两种形态：
 *
 *   A 顶层尾随（7 处）：标记紧跟在完整声明之后
 *       export const EvalTargetSchema = z.object({ ... }).strict();
 *       <此处一行 @frozen 标记>
 *
 *   B 对象字面量内部首行（4 处）：标记在对象开头，冻结整个接口对象
 *       export const QualityEvaluatorIface = {
 *         <此处一行 @frozen 标记>
 *         name: 'QualityEvaluator',
 *         ...
 *       };
 *
 * 两种形态的「被冻结单元」都是**包含该标记的顶层 export 声明**。
 * 所以：单元 key = 顶层声明名，一个声明一个 hash。
 *
 * ── 归一化策略（决定什么算「变更」）─────────────────────────────────────────
 * 只剥离**独占整行**的注释（trim 后以 // 开头，或块注释的 * 行）：
 *  - 改注释 / 改格式**不报红**（不是契约变更）
 *  - 行尾注释**保留**（不猜，避免把字符串里的 // 误当注释剥掉）
 *  - 之后去掉所有空白（缩进/换行差异不算变更）
 *
 * 字段增删、类型改、枚举值改、方法签名改 —— 全部会改变归一化后的文本 ⇒ 报红。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   node bin/check-l0-frozen.mjs            # 检查；违例 exit 1
 *   node bin/check-l0-frozen.mjs --json     # 机器可读输出
 *   node bin/check-l0-frozen.mjs --update   # 显式更新基线（= 承认这次 L0 变更）
 *
 * `--update` 是**唯一的放行口**，且必须显式传 —— 与「多签」是两道不同的闸：
 * 本脚本管的是「有没有人发现」，多签管的是「允不允许」。它替代不了后者。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export const CONTRACT_PATH = 'plugins/agint-quality/agint-quality-contract/lib/index.js';
export const BASELINE_PATH = 'docs/l0-frozen-baseline.json';

/** 去掉独占整行的注释（不动行尾注释 —— 避免误剥字符串里的 //） */
function stripStandaloneComments(lines) {
  const out = [];
  let inBlock = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      continue;                       // 块注释内部整行丢弃
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true;
      continue;                       // 块注释首行丢弃
    }
    if (t.startsWith('//')) continue;  // 整行 // 注释丢弃
    if (t === '') continue;            // 空行丢弃
    out.push(raw);
  }
  return out;
}

/** 归一化：剥独立注释行 → 去掉所有空白 */
function normalize(code) {
  return stripStandaloneComments(code.split('\n')).join('').replace(/\s+/g, '');
}

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 找出所有顶层 export 声明的 [start,end] 行区间（0-based，含端点）。
 * 用括号深度扫描，字符串/注释里的括号不参与（够用：契约文件无正则字面量陷阱）。
 */
function topLevelExportRanges(lines) {
  const ranges = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^export\s+(const|function|class|let)\b/.test(line)) continue;
    const start = i;
    let depth = 0;
    let end = i;
    let started = false;
    for (let j = i; j < lines.length; j++) {
      const l = stripLineComments(lines[j]);
      for (const ch of l) {
        if (ch === '{' || ch === '(' || ch === '[') { depth++; started = true; }
        else if (ch === '}' || ch === ')' || ch === ']') depth--;
      }
      // 顶层单行声明（无括号）以 ; 结束
      if (!started && l.trimEnd().endsWith(';')) { end = j; break; }
      if (started && depth <= 0) {
        // 等到分号或闭合后收尾
        if (/[;}]/.test(l.trimEnd())) { end = j; break; }
      }
      if (!started && l.trim() === '' && j > i) { end = i; break; }
    }
    ranges.push({ start, end, name: declarationName(line) });
    i = end;
  }
  return ranges;
}

/** 去掉行尾注释（只处理不在字符串里的 // —— 简化：若 // 出现在引号外） */
function stripLineComments(line) {
  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '/' && line[i + 1] === '/' && !inS && !inD) return line.slice(0, i);
  }
  return line;
}

function declarationName(line) {
  const m = line.match(/^export\s+(?:const|function|class|let)\s+([A-Za-z0-9_$]+)/);
  return m ? m[1] : `<anon@${line.slice(0, 24)}>`;
}

/**
 * 提取所有被 @frozen 标记的顶层声明 ⇒ { name: {hash, startLine, endLine, markerLine} }
 * @param {string} source contract/lib/index.js 全文
 */
export function extractFrozenUnits(source) {
  const lines = source.split('\n');
  const ranges = topLevelExportRanges(lines);
  const units = {};

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('@frozen')) continue;
    const markerLine = i + 1;                                  // 1-based，给人看的
    // 找到包含该标记的顶层声明：
    //  A 尾随形态：标记在声明**之后** ⇒ 取「结束行 < i 且离 i 最近」的那个
    //  B 内部形态：标记在声明**内部** ⇒ 取「开始行 ≤ i ≤ 结束行」的那个
    // ⚠️ A 形态必须取「最近」而不是「第一个」—— 用 find(x => x.end < i) 会把所有
    //    尾随标记都映射到同一个声明上，7 个 A 单元塌成 1 个（2026-09-29 踩过）。
    const inside = ranges.find((r) => i >= r.start && i <= r.end);
    const r = inside ?? ranges
      .filter((x) => x.end < i)
      .sort((a, b) => b.end - a.end)[0];
    if (!r) continue;
    const code = lines.slice(r.start, r.end + 1).join('\n');
    units[r.name] = {
      hash: sha256(normalize(code)),
      startLine: r.start + 1,
      endLine: r.end + 1,
      markerLine,
    };
  }
  return units;
}

export function check({ repoRoot = REPO_ROOT } = {}) {
  const contractAbs = join(repoRoot, CONTRACT_PATH);
  const baselineAbs = join(repoRoot, BASELINE_PATH);
  if (!existsSync(contractAbs)) {
    return { ok: false, error: `契约源文件不存在: ${CONTRACT_PATH}`, violations: [] };
  }
  const current = extractFrozenUnits(readFileSync(contractAbs, 'utf8'));
  const unitNames = Object.keys(current).sort();

  if (!existsSync(baselineAbs)) {
    return { ok: false, error: `基线不存在: ${BASELINE_PATH}（先跑 --update 建立）`, violations: [], current };
  }
  const baseline = JSON.parse(readFileSync(baselineAbs, 'utf8'));
  const baseUnits = baseline.units || {};

  const violations = [];
  for (const name of unitNames) {
    if (!baseUnits[name]) {
      violations.push({ kind: 'added', name, detail: `新增了 @frozen 单元 ${name}（基线中无）` });
    } else if (baseUnits[name].hash !== current[name].hash) {
      violations.push({
        kind: 'modified', name,
        detail: `@frozen 单元 ${name} 内容已变（${baseUnits[name].hash} → ${current[name].hash}）`,
      });
    }
  }
  for (const name of Object.keys(baseUnits)) {
    if (!current[name]) {
      violations.push({ kind: 'removed', name, detail: `@frozen 单元 ${name} 被删除` });
    }
  }

  return { ok: violations.length === 0, violations, current, baseline: baseUnits, unitNames };
}

export function updateBaseline({ repoRoot = REPO_ROOT } = {}) {
  const contractAbs = join(repoRoot, CONTRACT_PATH);
  const baselineAbs = join(repoRoot, BASELINE_PATH);
  const current = extractFrozenUnits(readFileSync(contractAbs, 'utf8'));
  const payload = {
    _comment: 'L0 FROZEN 契约哈希基线。改这个文件 = 承认一次 L0 变更。' +
      'AGENTS.md 要求：人类多签 + 7 天影子 + major 版本 + 旧版保留 ≥3 minor。' +
      '生成方式：node bin/check-l0-frozen.mjs --update',
    _source: CONTRACT_PATH,
    _hashAlgo: 'sha256(去独立注释行 + 去所有空白) 前 16 位',
    generatedAt: new Date().toISOString(),
    units: current,
  };
  mkdirSync(dirname(baselineAbs), { recursive: true });
  writeFileSync(baselineAbs, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return { path: BASELINE_PATH, count: Object.keys(current).length };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');

  if (args.includes('--update')) {
    const r = updateBaseline();
    console.log(`✅ 基线已更新：${r.path}（${r.count} 个 @frozen 单元）`);
    console.log('   ⚠️ 这等于承认一次 L0 变更 —— 仍需人类多签 + 7 天影子 + major 版本。');
    process.exit(0);
  }

  const r = check();
  if (r.error) {
    console.error(`❌ ${r.error}`);
    process.exit(2);
  }
  if (asJson) {
    console.log(JSON.stringify({ ok: r.ok, unitCount: r.unitNames.length, violations: r.violations }, null, 2));
  } else if (r.ok) {
    console.log(`✅ L0 FROZEN 契约未变更（${r.unitNames.length} 个受保护单元）`);
    for (const n of r.unitNames) console.log(`   · ${n}`);
  } else {
    console.error(`❌ L0 FROZEN 契约被改动：${r.violations.length} 处违例`);
    for (const v of r.violations) console.error(`   [${v.kind}] ${v.detail}`);
    console.error('\n   这是 L0 变更。AGENTS.md 要求：人类多签 + 7 天影子模式 + major 版本');
    console.error('   + 旧版保留 ≥3 minor 周期。确认无误后显式跑：');
    console.error('     node bin/check-l0-frozen.mjs --update');
  }
  process.exit(r.ok ? 0 : 1);
}
