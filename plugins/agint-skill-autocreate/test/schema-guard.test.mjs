// 静态 schema 护栏：扫描 lib/tools.js，确保每个 `{ type: 'object' }` schema
// 都显式声明 `additionalProperties: true | false`。
//
// 背景：dsh 的 loader 在 preset mount 阶段对工具参数做严格 JSON Schema 校验
//（ajv 严格模式），未声明 `additionalProperties` 会让整个 preset 挂载失败，
// UI 报 "agentPresets/list failed: Failed to fetch"（实际是 mount 异常冒泡）。
// 2026-09-09 v0.3.1 自检：autocreate_modify 的 `skillDraft` 漏写，整条 agint
// preset 加载失败。
//
// 复现成本：低（漏一个字段 → dsh 起不来），影响大（用户被挡在门外）。
// 解法成本：低（写个 30 行的 brace-balancing 扫描器）。值。
//
// 扫描器：简单状态机，跟踪字符串/转义/嵌套花括号，定位每个 `type: 'object'`
// 所在的最小对象字面量，断言其 body 内含 `additionalProperties` 赋值。
// 不依赖任何 npm 包，仓库无 node_modules 也能跑。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const TARGETS = [
  join(here, '..', 'lib', 'tools.js'),
];

function findObjectSchemasMissingAdditionalProps(src) {
  const re = /\{\s*type\s*:\s*['"]object['"]/g;
  const issues = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index;
    // 从 start 位置向后找匹配的花括号，记录 body 文本
    let depth = 0;
    let i = start;
    let inStr = null;        // ' " 或 `
    let esc = false;
    let inLineComment = false;
    let inBlockComment = false;
    for (; i < src.length; i++) {
      const c = src[i];
      const n = src[i + 1];
      if (inLineComment) {
        if (c === '\n') inLineComment = false;
        continue;
      }
      if (inBlockComment) {
        if (c === '*' && n === '/') { inBlockComment = false; i++; }
        continue;
      }
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '/' && n === '/') { inLineComment = true; i++; continue; }
      if (c === '/' && n === '*') { inBlockComment = true; i++; continue; }
      if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;     // 找不到配对，跳过
    const body = src.slice(start, i + 1);
    if (!/additionalProperties\s*:\s*(true|false)/.test(body)) {
      // 行号（用于错误信息）
      const lineNo = src.slice(0, start).split('\n').length;
      issues.push({ line: lineNo, preview: body.slice(0, 120).replace(/\n/g, '\\n') });
    }
  }
  return issues;
}

test('K19 schema 护栏：所有 type:"object" schema 必须显式 additionalProperties', () => {
  for (const f of TARGETS) {
    const src = readFileSync(f, 'utf8');
    const issues = findObjectSchemasMissingAdditionalProps(src);
    assert.deepEqual(
      issues,
      [],
      `${f} 发现 ${issues.length} 个未声明 additionalProperties 的 object schema：\n` +
        issues.map((i) => `  L${i.line}: ${i.preview}`).join('\n') +
        '\n\n修复方法：给对象 schema 加上 `additionalProperties: true`（自由形状）' +
        '或 `false`（封闭形状，已枚举所有 properties）。原因：dsh loader 用严格 ' +
        'JSON Schema 校验，缺这个字段会让整个 preset 加载失败。',
    );
  }
});
