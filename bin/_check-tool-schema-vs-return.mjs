// 工具 schema vs 实际返回 的形状比对（C2 静态扫描）。
//
// 背景：提案 394b7c0f「agint-rules 工具 schema：rule_list 等工具返回含未声明
//   字段导致 strict 校验失败」。agint-rules 已修（tools.js:156-181 声明了
//   frozenness / claim* 字段）。但同型 bug 可能在别的插件里还在。
//
// 做法（静态，不跑宿主）：
//   1. 遍历 plugins/**/lib/tools.js
//   2. 找出每个 defineTool 的 output.schema（含 additionalProperties:false 的）
//   3. 找出该 tool 的 execute 里 return 的对象字面量键集
//   4. 差集 = 「返回了但 schema 没声明」⇒ strict 模式会拒绝整个返回值
//
// ⛔ 已知局限（§3.22 同型纪律：结论不得夸大）：
//   - 只查同文件内的 return {...} 字面量；跨文件 service 方法、运行时拼装
//     的返回对象静态查不出来 ⇒ 会漏检。
//   - 只查键名，不查类型。
//   - 本脚本定位是「抓明显的漏」，不是完备证明。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 用 fileURLToPath，别用 URL.pathname（中文路径会被 percent-encode，§3.12 同型坑）
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGINS = join(ROOT, 'plugins');

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === 'tools.js') out.push(p);
  }
  return out;
}

const files = walk(PLUGINS);
const findings = [];

for (const f of files) {
  const src = readFileSync(f, 'utf8');

  // 切分 defineTool 块：从 defineTool( 开始的括号平衡块
  const blocks = [];
  const re = /\bdefineTool\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) { blocks.push(src.slice(m.index, i + 1)); break; }
    }
  }

  for (const b of blocks) {
    const nameM = /name:\s*['"]([^'"]+)['"]/.exec(b);
    if (!nameM) continue;
    const toolName = nameM[1];

    // 输出 schema：找 output: { schema: ... } 块
    const outM = /output:\s*\{[\s\S]*?schema:\s*\{/;
    const outIdx = b.search(outM);
    if (outIdx < 0) continue;
    let depth = 0, si = b.indexOf('{', b.indexOf('schema:', outIdx));
    let schemaBlock = null;
    for (let i = si; i < b.length; i++) {
      if (b[i] === '{') depth++;
      else if (b[i] === '}' && --depth === 0) { schemaBlock = b.slice(si, i + 1); break; }
    }
    if (!schemaBlock) continue;

    const strict = /additionalProperties:\s*false/.test(schemaBlock);
    if (!strict) continue; // 非 strict 不会拒字段

    // schema 顶层 properties 的键
    const declared = new Set();
    const propsIdx = schemaBlock.indexOf('properties:');
    if (propsIdx >= 0) {
      let d2 = 0, pi = schemaBlock.indexOf('{', propsIdx);
      let pb = null;
      for (let i = pi; i < schemaBlock.length; i++) {
        if (schemaBlock[i] === '{') d2++;
        else if (schemaBlock[i] === '}' && --d2 === 0) { pb = schemaBlock.slice(pi, i + 1); break; }
      }
      if (pb) {
        // 只取第一层键：形如 `  key: {` 或 `  key: { required: true,`
        const kre = /(?:^|[{,\n])\s*'?([A-Za-z_$][\w$]*)'?\s*:\s*\{/g;
        let km;
        while ((km = kre.exec(pb)) !== null) declared.add(km[1]);
      }
    }
    if (declared.size === 0) continue;

    // execute 里 return { ... } 的键
    const returned = new Map();
    const retRe = /\breturn\s*\{([^{}]*)\}/g;
    let rm;
    const execIdx = b.indexOf('execute');
    const execBody = execIdx >= 0 ? b.slice(execIdx) : b;
    while ((rm = retRe.exec(execBody)) !== null) {
      for (const raw of rm[1].split(',')) {
        const piece = raw.trim();
        if (!piece || piece.startsWith('...')) continue;
        const key = piece.split(':')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(key)) {
          if (!returned.has(key)) returned.set(key, execBody.slice(0, rm.index).split('\n').length);
        }
      }
    }

    const missing = [...returned.keys()].filter((k) => !declared.has(k));
    if (missing.length > 0) {
      findings.push({
        file: relative(ROOT, f),
        tool: toolName,
        missing: missing.map((k) => `${k}@L${returned.get(k)}`),
        declared: [...declared].sort(),
      });
    }
  }
}

console.log(`扫描 tools.js: ${files.length} 个（plugins/**/lib/tools.js）`);
console.log(`strict(additionalProperties:false) 工具中，返回字段未声明的: ${findings.length} 处`);
for (const f of findings) {
  console.log(`\n  ${f.file}  tool=${f.tool}`);
  console.log(`    返回了但 schema 未声明: ${f.missing.join(', ')}`);
  console.log(`    schema 已声明: ${f.declared.join(', ')}`);
}
if (findings.length === 0) console.log('\n  无命中（注意：本脚本只查同文件字面量，可能漏检）');
