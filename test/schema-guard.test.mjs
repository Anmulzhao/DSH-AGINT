// K19 全仓 schema 护栏（仓库级）
//
// 规则一（K19）：dsh loader 用 ajv 严格模式校验工具参数 schema，任何 `type: "object"`
// 必须显式声明 `additionalProperties: true | false`，否则**整条 preset 拒绝挂载**，
// UI 冒泡成 "agentPresets/list failed: Failed to fetch"（用户被挡在门外）。
//
// 规则二（K20，2026-09-10 翻车后补）：值 schema DSL 里 `required` **只要出现就
// 必须是 true**。`@deepseek-ai/dsh-tools/lib/index.js` 的编译期检查：
//   if (Object.hasOwn(task.property, "required") && task.property.required !== true)
//     authorError(`${task.path}.required must be true when present`);
// 而 `defineTool()` 内部就会调用编译（parameterSchemaSpecToJsonSchema / 
// valueSchemaSpecToJsonSchema），所以写 `required: false` 会在 **preset 加载时**
// 直接抛错 → 整条 preset 挂掉，表现与 K19 一模一样（新建会话发不了消息）。
// 可选参数的正确写法是**干脆不写 required**。
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

// ---------- K20：`required` 出现时必须为 true ----------

function findRequiredFalse(src) {
  // 跑在掩码后源码上：注释/字符串里的 "required: false" 字样不算违规
  const masked = maskLiterals(src);
  const re = /required\s*:\s*false/g;
  const hits = [];
  let m;
  while ((m = re.exec(masked)) !== null) {
    hits.push(masked.slice(0, m.index).split('\n').length);
  }
  return hits;
}

test('K20 护栏：工具 schema 里不得出现 required:false（出现即必须是 true）', () => {
  // 只扫工具定义文件：其它 lib 里的 required:false 是普通配置对象，与 dsh schema DSL 无关
  const targets = collectTargets().filter((p) => p.endsWith(`${sep}tools.js`));
  assert.ok(targets.length > 0, '没扫到任何 lib/tools.js，发现逻辑可能坏了');

  const report = [];
  for (const file of targets) {
    const src = readFileSync(file, 'utf8');
    for (const line of findRequiredFalse(src)) {
      report.push(`${relative(REPO_ROOT, file)}:${line}`);
    }
  }

  assert.deepEqual(
    report,
    [],
    `\n发现 ${report.length} 处 required:false：\n\n  ` + report.join('\n  ') +
      '\n\n修复：把 `required: false` 整个删掉——值 schema DSL 中，不写 required 就是可选。\n' +
      '原因：dsh-tools 编译期断言 `required must be true when present`，而 defineTool()\n' +
      '在 preset 加载时就会编译，抛错会让**整条 preset 挂载失败**（新建会话发不了消息）。\n',
  );
});

test('K20 护栏自检：扫描器能识别正确/错误两种写法', () => {
  const bad = "parameters: { a: { type: 'string', required: false } }";
  const badNoSpace = "parameters: { a: { type: 'string', required:false } }";
  const good = "parameters: { a: { type: 'string' }, b: { type: 'boolean', required: true } }";
  const inComment = "// 不要写 required: false\nconst x = 1;";
  const inString = "const s = 'required: false 是禁止的';";

  assert.equal(findRequiredFalse(bad).length, 1, 'required: false 应被抓到');
  assert.equal(findRequiredFalse(badNoSpace).length, 1, '无空格写法也应被抓到');
  assert.equal(findRequiredFalse(good).length, 0, '不写或写 true 不应报错');
  assert.equal(findRequiredFalse(inComment).length, 0, '注释里不应误报');
  assert.equal(findRequiredFalse(inString).length, 0, '字符串里不应误报');
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

// ---------- K21：`output.schema` 里 required 必须是 raw JSON Schema 形态 ----------
//
// 背景：DSH tool loader 对 `output.schema` 走 `assertSupportedJsonSchema()` 直通校验，
// 不经过 `valueSchemaSpecToJsonSchema()` 编译器。所以：
//   - `properties.{x}.required: true` 写法**无效**（subset 要求 `required` 挂在父对象
//     作为字符串数组）；
//   - `required: true` 与 `oneOf` 同级也被禁止（`json-schema.js:144` 的
//     `ONE_OF_SIBLING_KEYWORDS`）。
// 之前这俩错导致「无法切换到『智进』」loader 报错 4 工具（2026-09-20 第一轮）→
// 修完后**同一错**又在 3 个工具复发（第二/三轮）—— 同型 bug 不会自动收敛，必须靠
// 本护栏拦在 PR 之前。
//
// K21 只扫 `output:` 块（与 K20 的 `parameters:` 互补）；`parameters:` 仍可合法用
// `required: true` 散在 properties 上（那里会被 `parameterSchemaSpecToJsonSchema`
// 编译器收集到父级 required:[…]，DSH 子集校验在编译后才发生）。
//
// 放宽：`parameters:` 块里若也带 raw `required:[…]` 数组形态，K21 不报错（允许共存）。

/**
 * Find every `output: { schema: { ... } }` block in the file, then for each
 * property under `properties:` whose value is an object literal that contains
 * both `required: true` AND (a non-'object' `type` OR a sibling `oneOf`),
 * record (line, reason).
 *
 * Implementation note: we run two scans — one on the **masked** source (so
 * strings/comments don't leak false positives into brace counting), and one
 * on the **raw** source for the inner property-entry extraction (so we can
 * still see string contents like 'string'). Masking collapses string
 * contents to spaces, which would defeat the `type: 'string'` match — but
 * masking is only needed for brace balance, which we do first. Once we have
 * a property entry's start/end offsets in the raw source, we don't care
 * about brace-balance anymore.
 */
function findBadOutputRequired(src) {
  const masked = maskLiterals(src);
  const hits = [];

  let i = 0;
  while (true) {
    const outIdx = masked.indexOf('output:', i);
    if (outIdx === -1) break;
    // Find matching closing brace of the output object in the masked source.
    let j = masked.indexOf('{', outIdx + 'output:'.length);
    if (j === -1) break;
    let depth = 0;
    let end = -1;
    while (j < masked.length) {
      const c = masked[j];
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) { end = j + 1; break; }
      }
      j += 1;
    }
    if (end === -1) break;
    // Slice the **raw** source using the masked offsets (preserves brace
    // counts since masking is length-preserving).
    const block = src.slice(outIdx, end);

    // Inside the output block, find `properties: { ... }`.
    const propIdx = block.indexOf('properties:');
    if (propIdx === -1) { i = end; continue; }
    let k = propIdx + 'properties:'.length;
    // Skip whitespace, then expect '{'.
    while (k < block.length && (block[k] === ' ' || block[k] === '\n' || block[k] === '\t' || block[k] === '\r')) k += 1;
    if (k >= block.length || block[k] !== '{') { i = end; continue; }
    const propStart = k + 1;
    let pDepth = 1;
    let p = propStart;
    while (p < block.length && pDepth > 0) {
      const cc = block[p];
      if (cc === '{') pDepth += 1;
      else if (cc === '}') {
        pDepth -= 1;
        if (pDepth === 0) break;
      }
      p += 1;
    }
    const propBody = block.slice(propStart, p);

    // Each property entry: identifier (or quoted string) + ':' + value object.
    // For our purposes we only care about values that start with '{', so we
    // anchor on the literal `{` after the colon.
    const entryRe = /(\s*)([A-Za-z_$][A-Za-z0-9_$]*|\'[^\']*\'|\"[^\"]*\")\s*:\s*\{/g;
    let em;
    while ((em = entryRe.exec(propBody)) !== null) {
      const entryStart = em.index + em[0].length - 1; // position of '{'
      let d = 1;
      let q = entryStart + 1;
      while (q < propBody.length && d > 0) {
        const cc = propBody[q];
        if (cc === '{') d += 1;
        else if (cc === '}') {
          d -= 1;
          if (d === 0) { q += 1; break; }
        }
        q += 1;
      }
      const entryObj = propBody.slice(entryStart, q);
      if (!/\brequired\s*:\s*true\b/.test(entryObj)) continue;
      // Has `required: true`. Now check the violations.
      const hasOneOf = /\boneOf\s*:/.test(entryObj);
      // type match tolerates single/double quotes and spaces around the value
      const typeMatch = entryObj.match(/\btype\s*:\s*['"]?\s*([A-Za-z]+)\s*['"]?/);
      const t = typeMatch ? typeMatch[1] : null;
      const isNonObject = t !== null && t !== 'object';
      let reason = null;
      if (hasOneOf) reason = 'required 与 oneOf 同级（subset 禁止）';
      else if (isNonObject) reason = `required 写在 type:"${t}" 上（subset 仅允许 type:"object"）`;
      if (reason) {
        // Line number: count newlines in the raw source up to this entry.
        const approxPos = outIdx + propStart + em.index;
        const line = src.slice(0, approxPos).split('\n').length;
        hits.push({ line, key: em[2].replace(/^['"]|['"]$/g, ''), reason });
      }
    }
    i = end;
  }
  return hits;
}

test('K21 护栏：output.schema 里 required 必须是父级数组形态（不允许散在 properties.X 上）', () => {
  const targets = collectTargets().filter((p) => p.endsWith(`${sep}tools.js`));
  assert.ok(targets.length > 0, '没扫到任何 lib/tools.js，发现逻辑可能坏了');

  const report = [];
  for (const file of targets) {
    const src = readFileSync(file, 'utf8');
    for (const hit of findBadOutputRequired(src)) {
      report.push(`${relative(REPO_ROOT, file)}:${hit.line} ${hit.key} — ${hit.reason}`);
    }
  }

  assert.deepEqual(
    report,
    [],
    `\n发现 ${report.length} 处 output.schema 内 required 错位：\n\n  ` + report.join('\n  ') +
      '\n\n修复：把 properties.X 里的 `required: true` 删掉，统一挂到父对象的 `required: [\'X\']` 数组上。' +
      '\n`required` 与 `oneOf` 不能同级；必须 raw JSON Schema 形态。' +
      '\n\n原因：DSH loader 对 output.schema 走 `assertSupportedJsonSchema()` 直通，' +
      '\n不经过 `parameterSchemaSpecToJsonSchema` 编译器——所以 raw 形态是硬要求。' +
      '\n参考教训：AGINT-data/dreams/2026-09-20-智进加载失败-schema-required.md\n',
  );
});

test('K21 护栏自检：扫描器能识别正确/错误两种写法', () => {
  // Bad: required on scalar type
  const badScalar = "output: { schema: { type: 'object', properties: { x: { type: 'string', required: true } } } }";
  // Bad: required beside oneOf
  const badOneOf = "output: { schema: { properties: { x: { oneOf: [{type:'string'}], required: true } } } }";
  // Bad: required on array
  const badArray = "output: { schema: { properties: { x: { type: 'array', required: true } } } }";
  // Good: required lifted to parent object (DSH raw form)
  const goodParent = "output: { schema: { type: 'object', required: ['x'], properties: { x: { type: 'string' } } } }";
  // Good: object-typed property with required:true (K20-friendly in some paths,
  // but in output we still want it lifted; this test fixture is intentionally
  // a tricky one — kept here to verify the scanner distinguishes object vs
  // scalar). The scanner should flag it ONLY if type is non-object. Mark as
  // out-of-spec-on-purpose test input.
  const goodObject = "output: { schema: { type: 'object', properties: { x: { type: 'object', required: true, additionalProperties: false } } } }";
  // Good: parameters still uses author DSL (K20 valid, K21 does not scan)
  const goodParams = "parameters: { x: { type: 'string', required: true } }";
  // Good: in a comment
  const inComment = "// output: { properties: { x: { type: 'string', required: true } } }\nconst x = 1;";
  // Good: in a string
  const inString = "const s = 'output: properties: { x: required: true }';";

  const badScalarHits = findBadOutputRequired(badScalar);
  assert.equal(badScalarHits.length, 1, '标量上 required:true 应被抓到');
  assert.equal(badScalarHits[0].key, 'x');

  const badOneOfHits = findBadOutputRequired(badOneOf);
  assert.equal(badOneOfHits.length, 1, 'oneOf+required 同级应被抓到');

  const badArrayHits = findBadOutputRequired(badArray);
  assert.equal(badArrayHits.length, 1, 'array 上 required:true 应被抓到');

  assert.equal(findBadOutputRequired(goodParent).length, 0, '父级 required:[…] 形态应通过');
  assert.equal(findBadOutputRequired(goodObject).length, 0, 'type:"object" 上的 required:true 应通过（K21 只抓非 object）');
  assert.equal(findBadOutputRequired(goodParams).length, 0, 'parameters: 块不在 K21 扫描范围');
  assert.equal(findBadOutputRequired(inComment).length, 0, '注释内不应误报');
  assert.equal(findBadOutputRequired(inString).length, 0, '字符串内不应误报');
});
