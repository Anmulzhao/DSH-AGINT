#!/usr/bin/env node
/**
 * _verify-dim5_5.mjs — node 版 plugin-check 维度 5.5 soft warning 复刻
 * 抄自 bin/plugin-check.sh line 178-195 的 bash 逻辑，shell → js 等价改写。
 * 用于在无 bash 环境下复测 dim5.5 跨平台 fixture 提示是否合理。
 * 用法：node bin/_verify-dim5_5.mjs <plugin-dir>
 */
import { existsSync, readFileSync } from 'node:fs';
import { join as pjoin } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node bin/_verify-dim5_5.mjs <plugin-dir>');
  process.exit(2);
}

const mfPath = pjoin(dir, 'manifest.json');
if (!existsSync(mfPath)) {
  console.log('[SKIP] manifest.json 缺失，dim5.5 不适用');
  process.exit(0);
}
const mf = JSON.parse(readFileSync(mfPath, 'utf8'));

const fsPerm = mf.spec?.permissions?.fs ?? mf.permissions?.fs ?? [];
if (!Array.isArray(fsPerm) || fsPerm.length === 0) {
  console.log('[SKIP] permissions.fs 为空，dim5.5 不适用');
  process.exit(0);
}

const testEntry = mf.spec?.tests?.entry ?? mf.tests?.entry ?? 'test/smoke.mjs';
const testPath = pjoin(dir, testEntry);
if (!existsSync(testPath)) {
  console.log('[SKIP] test fixture 缺失，dim5.5 跳过');
  process.exit(0);
}
const src = readFileSync(testPath, 'utf8');

// 正向：含 .md 字符串字面量（可能是路径）
const fwdRe = /['"][a-zA-Z0-9_./-]*[a-zA-Z0-9_.-]+\.md['"]/;
// 负向：含 ../
const evilRe = /\.\.\//;
const hasFwd = fwdRe.test(src);
const hasEvil = evilRe.test(src);

console.log(`[dim5.5] permissions.fs=${JSON.stringify(fsPerm)} test=${testEntry}`);
console.log(`[dim5.5] forward-slash 路径字面量: ${hasFwd ? '✓' : '✗'}`);
console.log(`[dim5.5] ../escape 负向 case: ${hasEvil ? '✓' : '✗'}`);

if (!hasFwd || !hasEvil) {
  console.log('[WARN] 建议加 forward-slash 路径 + ../escape 负向 case');
  process.exit(1);
}
console.log('[OK] 跨平台 fixture 已覆盖');
process.exit(0);