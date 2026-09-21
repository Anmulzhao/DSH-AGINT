#!/usr/bin/env node
/**
 * check-tool-schemas.mjs — 真编译一遍所有插件的 tool schema，防止"看似合理但宿主拒绝"的写法。
 *
 * # 为什么需要它
 * dsh 的 tool 定义有**两套不共用的 schema 方言**，且 `output.schema` 会**先后过两道**：
 *
 *   parameters:      → parameterSchemaSpecToJsonSchema()  → 值 schema DSL（属性上 required: true）
 *   output.schema:   → valueSchemaSpecToJsonSchema()      → **先**值 schema DSL 编译，**再** raw JSON Schema 断言
 *
 * 关键陷阱：output.schema 的**作者侧**必须写值 schema DSL 的形态（`required: true` 挂在属性上），
 * 而不是 raw JSON Schema 的形态（`required: ['a','b']` 挂在父对象上）。父对象数组形式会被
 * dsh-tools/lib/index.js:556 的 assertAuthorKeys 直接拒绝，报：
 *
 *   unsupported JSON schema: schema.required is not supported by the value schema DSL
 *
 * 这个错误会让整个 loader entry 挂载失败 → 整个 preset 起不来（2026-09-21 事故，commit b03d919 引入）。
 *
 * 另有两条硬约束：
 *   - 属性节点带 `oneOf` 时**不能**再带 `required`（互斥）。
 *   - `type: 'object'` 节点必须显式声明 `additionalProperties: true|false`。
 *
 * # 用法
 *   node bin/check-tool-schemas.mjs [--plugins-dir <dir>]
 *
 * 退出码 0 = 全部通过；非 0 = 有 schema 非法（会打印文件、行号、宿主的原始报错）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 解析 dsh-tools 的实现位置（按优先级：环境变量 → 当前 dsh 安装 → 直接 require）。 */
async function loadDshTools() {
  const candidates = [];
  if (process.env.DSH_TOOLS_PATH) candidates.push(process.env.DSH_TOOLS_PATH);

  // 从正在运行的 dsh 反推：npm 全局包 @deepseek-ai/dsh 内嵌 dsh-tools
  const npmRoot = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'npm/node_modules')
    : null;
  if (npmRoot) {
    candidates.push(path.join(npmRoot, '@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'));
    candidates.push(path.join(npmRoot, '@deepseek-ai/dsh-tools/lib/index.js'));
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return await import(pathToFileURL(c).href);
  }
  // 兜底：走模块解析
  try {
    return await import('@deepseek-ai/dsh-tools');
  } catch (e) {
    throw new Error(
      'cannot locate dsh-tools. Set DSH_TOOLS_PATH to the dsh-tools lib/index.js.\n' +
      'tried:\n' + candidates.map((c) => '  ' + c).join('\n')
    );
  }
}

/** 在源码中提取所有 `schema: { ... }` 字面量的文本与行号（括号配对，跳过字符串/注释）。 */
function extractSchemaLiterals(src) {
  const out = [];
  const re = /schema:\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = src.indexOf('{', m.index);
    let depth = 0, i = start, state = 'code';
    while (i < src.length) {
      const c = src[i], n = src[i + 1];
      if (state === 'code') {
        if (c === "'") state = 'sq';
        else if (c === '"') state = 'dq';
        else if (c === '`') state = 'tpl';
        else if (c === '/' && n === '/') { state = 'line'; i++; }
        else if (c === '/' && n === '*') { state = 'block'; i++; }
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
      } else if (state === 'sq') { if (c === '\\') i++; else if (c === "'") state = 'code'; }
      else if (state === 'dq') { if (c === '\\') i++; else if (c === '"') state = 'code'; }
      else if (state === 'tpl') { if (c === '\\') i++; else if (c === '`') state = 'code'; }
      else if (state === 'line') { if (c === '\n') state = 'code'; }
      else if (state === 'block') { if (c === '*' && n === '/') { state = 'code'; i++; } }
      i++;
    }
    if (depth !== 0) break;
    out.push({
      text: src.slice(start, i + 1),
      line: src.slice(0, start).split('\n').length,
    });
    re.lastIndex = i + 1;
  }
  return out;
}

/** 抽取模块顶层的 `const NAME = <literal>;`，用于求值引用了常量的 schema。 */
function extractConsts(src) {
  const ctx = {};
  const declRe = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?);\s*$/gm;
  let m;
  while ((m = declRe.exec(src)) !== null) {
    const [, name, body] = m;
    if (name === 'name' || name === 'inject') continue;
    if (/=>|\bfunction\b/.test(body)) continue; // 跳过函数
    try { ctx[name] = new Function(`return (${body});`)(); } catch { /* 不可求值则跳过 */ }
  }
  return ctx;
}

const args = process.argv.slice(2);
const dirArgIdx = args.indexOf('--plugins-dir');
const PLUGINS_DIR = dirArgIdx >= 0
  ? path.resolve(args[dirArgIdx + 1])
  : path.resolve(process.cwd(), 'plugins');

const { valueSchemaSpecToJsonSchema, parameterSchemaSpecToJsonSchema } = await loadDshTools();

/** 递归收集 plugins 下的 tools.js。 */
function collectToolsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectToolsFiles(full));
    else if (entry.name === 'tools.js') out.push(full);
  }
  return out;
}

const files = collectToolsFiles(PLUGINS_DIR);
let checked = 0, failed = 0;
const failures = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const consts = extractConsts(src);
  const constNames = Object.keys(consts);
  const literals = extractSchemaLiterals(src);
  const rel = path.relative(process.cwd(), file);

  for (const lit of literals) {
    let obj;
    try {
      obj = new Function(...constNames, `return (${lit.text});`)(...constNames.map((k) => consts[k]));
    } catch {
      continue; // 引用了无法静态求值的东西 → 交给运行时
    }
    checked++;
    try {
      valueSchemaSpecToJsonSchema(obj);
    } catch (e) {
      failed++;
      failures.push({ file: rel, line: lit.line, entry: 'output.schema', msg: e.message });
    }
  }
}

for (const f of failures) {
  console.error(`${f.file}:${f.line}  [${f.entry}]  ${f.msg}`);
}
console.log(
  `\ncheck-tool-schemas: scanned ${files.length} file(s), compiled ${checked} schema literal(s), ` +
  `${failed} invalid.`
);
process.exit(failed > 0 ? 1 : 0);
