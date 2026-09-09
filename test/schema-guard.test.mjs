// K19 全仓 schema 护栏（仓库级）
//
// 规则：dsh loader 用 ajv 严格模式校验工具参数 schema，任何 `type: "object"`
// 必须显式声明 `additionalProperties: true | false`，否则**整条 preset 拒绝挂载**，
// UI 冒泡成 "agentPresets/list failed: Failed to fetch"（用户被挡在门外）。
//
// 2026-09-09 首次翻车：agint-skill-autocreate v0.3.0 的 `autocreate_modify`
// 参数 `skillDraft` 漏写 → agint preset 起不来。当时护栏只装在那一个插件的
// test/ 里，其余 20+ 插件照旧裸奔。这份是把它提到仓库级的版本：
// 自动发现 plugins/**/lib/**/*.js 全部源文件，一次跑完。
//
// 扫描方法（零依赖，仓库无 node_modules 也能 node --test）：
//   1. 先把字符串字面量与注释「掩码」成等长空格（保留换行以维持行号），
//      这样花括号计数不会被 `'{'`、`// }` 之类的内容带偏；
//   2. 在掩码后的源码里找每处 `type: 'object'`；
//   3. 向前找最近的 `{`，再向后做 brace-balance 找到配对的 `}`；
//   4. 取原文切片，断言其中包含 `additionalProperties: true|false`。
// 比「只匹配 `{ type: 'object'` 开头」的旧版更稳——字段顺序任意也能抓到。
//
// 需要放行某处（例如它不是工具参数、只是内部元数据）时，在该 object 所在行
// 或紧邻上一行加：`/* schema-guard: ignore */`。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SCAN = join(REPO_ROOT, 'plugins');
// 允许外部指定扫描根：bin/plugin-check.sh 会传 K19_SCAN_ROOT=$DSH_PLUGINS_ROOT，
// 这样宿主运行副本（真正被 dsh 加载的那份）也能被同一套护栏扫到。
const SCAN_ROOT = process.env.K19_SCAN_ROOT
  ? resolve(process.env.K19_SCAN_ROOT)
  : DEFAULT_SCAN;
const IS_REPO_SCAN = SCAN_ROOT === DEFAULT_SCAN;

// ---------- 目标发现 ----------

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile() && /\.m?js$/.test(entry.name)) out.push(p);
  }
  return out;
}

// 只扫 lib/ 下的源文件：工具 schema 定义处。
// test/、scripts/、示例目录不扫（那里的 object 字面量不是工具参数）。
function collectTargets() {
  return walk(SCAN_ROOT)
    .filter((p) => p.split(sep).includes('lib'))
    .sort();
}

// ---------- 掩码：把字符串和注释替换成空格，保留换行 ----------

function maskLiterals(src) {
  let out = '';
  let inStr = null;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    const push = (ch) => { out += ch === '\n' ? '\n' : ' '; };

    if (inLine) {
      push(c);
      if (c === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      push(c);
      if (c === '*' && n === '/') { out += ' '; i++; inBlock = false; }
      continue;
    }
    if (inStr) {
      push(c);
      if (c === '\\') { out += ' '; i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; out += '  '; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; out += '  '; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = c; out += ' '; continue; }
    out += c;
  }
  return out;
}

// ---------- 核心扫描 ----------

function findObjectSchemasMissingAdditionalProps(src) {
  const masked = maskLiterals(src);
  // 注意：正则跑在**原文**上。掩码会连 `'object'` 这个字面量一起抹成空格，
  // 所以不能在掩码里找关键词；但掩码与原文等长，索引一一对应，
  // 拿原文匹配到的位置去掩码里做括号运算即可。
  const re = /type\s*:\s*['"]object['"]/g;
  const issues = [];
  let m;

  while ((m = re.exec(src)) !== null) {
    // 掩码后若连 `type` 关键字都没了，说明这处位于字符串或注释里 —— 不算 schema。
    // 只校验关键字本身：m[0] 里的 `'object'` 是字符串字面量，掩码后必然是空格，
    // 不能拿整个 m[0] 去比。
    if (masked.slice(m.index, m.index + 4) !== 'type') continue;
    const hitIdx = m.index;

    // 向前找所属对象字面量的起始 `{`
    let start = -1;
    for (let i = hitIdx; i >= 0; i--) {
      const c = masked[i];
      if (c === '}') break;              // 先撞上闭合，说明不在同一个对象里
      if (c === '{') { start = i; break; }
    }
    if (start < 0) continue;

    // 向后 brace-balance 找配对的 `}`
    let depth = 0;
    let end = -1;
    for (let i = start; i < masked.length; i++) {
      if (masked[i] === '{') depth++;
      else if (masked[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) continue;

    const body = src.slice(start, end + 1);
    // 键存在即放行：值可以是 true/false，也可以是变量（如 `additionalProperties: addl`，
    // 由上游计算得出）。静态分析判定不了运行时值，作者写了这个键就说明他知道约束。
    if (/\badditionalProperties\s*:/.test(body)) continue;

    // 显式放行标记（本行或紧邻上一行）
    const lineStart = src.lastIndexOf('\n', start) + 1;
    const prevLineStart = src.lastIndexOf('\n', lineStart - 2) + 1;
    const ctx = src.slice(prevLineStart, end + 1);
    if (/schema-guard:\s*ignore/.test(ctx)) continue;

    const lineNo = src.slice(0, start).split('\n').length;
    issues.push({ line: lineNo, preview: body.slice(0, 140).replace(/\s+/g, ' ') });
  }
  return issues;
}

// ---------- 测试 ----------

test('K19 全仓护栏：所有 type:"object" schema 必须显式 additionalProperties', () => {
  const targets = collectTargets();
  assert.ok(targets.length > 0, 'plugins/ 下没扫到任何 lib/*.js，发现逻辑可能坏了');

  const report = [];
  for (const file of targets) {
    const src = readFileSync(file, 'utf8');
    for (const issue of findObjectSchemasMissingAdditionalProps(src)) {
      report.push(`${relative(REPO_ROOT, file)}:${issue.line}\n    ${issue.preview}`);
    }
  }

  assert.deepEqual(
    report,
    [],
    `\n发现 ${report.length} 处 object schema 未声明 additionalProperties：\n\n  ` +
      report.join('\n  ') +
      '\n\n修复：给对象 schema 加 `additionalProperties: true`（自由形状）或 `false`' +
      '（封闭形状，已枚举全部 properties）。\n' +
      '原因：dsh loader 用 ajv 严格模式校验，缺这个字段会让**整个 preset 挂载失败**，' +
      'UI 只报 "Failed to fetch"，排查成本极高。\n' +
      '确属误报（非工具参数）时，在该处加 `/* schema-guard: ignore */`。\n',
  );
});

test('K19 护栏覆盖面自检：确实扫到了全仓 lib（防止发现逻辑坏掉变成空转）', (t) => {
  // 扫宿主运行副本时插件数量不定，覆盖面断言只在默认仓内扫描下生效
  if (!IS_REPO_SCAN) return t.skip('K19_SCAN_ROOT 外部模式，跳过覆盖面断言');

  const targets = collectTargets().map((p) => relative(REPO_ROOT, p).split(sep).join('/'));
  assert.ok(
    targets.length >= 20,
    `只扫到 ${targets.length} 个 lib 源文件，护栏可能在空转：${targets.join(', ')}`,
  );
  // 2026-09-09 事故原点，必须被覆盖
  assert.ok(
    targets.includes('plugins/agint-skill-autocreate/lib/tools.js'),
    'agint-skill-autocreate/lib/tools.js 未进入扫描范围',
  );
});

test('K19 护栏自检：扫描器能识别正确/错误两种写法', () => {
  const bad = "const t = { name: 'x', parameters: { foo: { type: 'object' } } };";
  const good = "const t = { parameters: { foo: { type: 'object', additionalProperties: true } } };";
  const reordered = "const t = { properties: { a: 1 }, type: 'object', additionalProperties: false };";
  const ignored = "/* schema-guard: ignore */\nconst t = { type: 'object' };";
  const withVar = "const addl = true;\nconst t = { type: 'object', properties: p, additionalProperties: addl };";
  const inString = "const s = 'type: \\'object\\' is fine';";
  const inComment = "// { type: 'object' }\nconst x = 1;";

  assert.equal(findObjectSchemasMissingAdditionalProps(bad).length, 1, '漏写应被抓到');
  assert.equal(findObjectSchemasMissingAdditionalProps(good).length, 0, '声明了不应报错');
  assert.equal(findObjectSchemasMissingAdditionalProps(reordered).length, 0, '字段顺序无关');
  assert.equal(findObjectSchemasMissingAdditionalProps(ignored).length, 0, 'ignore 标记应放行');
  assert.equal(findObjectSchemasMissingAdditionalProps(withVar).length, 0, '变量值应放行');
  assert.equal(findObjectSchemasMissingAdditionalProps(inString).length, 0, '字符串内不应误报');
  assert.equal(findObjectSchemasMissingAdditionalProps(inComment).length, 0, '注释内不应误报');
});
