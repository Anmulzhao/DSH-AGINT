#!/usr/bin/env node
/**
 * _verify-dim9.mjs — node 版 runtime-contract 维度 9 扫描（perl 不可用时 fallback）
 * 抄自 bin/plugin-check.sh line 99-125 的 perl 逻辑，正则同源。
 * 用法：node bin/_verify-dim9.mjs <lib/index.js>
 * 输出：第一行 RUNTIME_CONTRACT_OK / RUNTIME_CONTRACT_FAIL；后续是违例详情
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node bin/_verify-dim9.mjs <lib/index.js>');
  process.exit(2);
}
const src = readFileSync(file, 'utf8');

// 匹配 ctx.on('wf-event', [async] (args) => { body } 或 ctx.on('wf-event', arg => { body }
// wf-event: tools/pre-execute | tools/post-execute | tools/ptc-dispatch-log | agent/pre-step
const WF = '(tools/(?:pre-execute|post-execute|ptc-dispatch-log)|agent/pre-step)';
// body: 不嵌套 {} 的内容（一次括号配对），与 perl 原版一致
const RE = new RegExp(
  `ctx\\.on\\(\\s*['"]${WF}['"]\\s*,\\s*(async\\s+)?(?:\\(([^)]*)\\)|(\\w+))\\s*=>\\s*\\{((?:[^{}]|\\{[^{}]*\\})*)\\}`,
  'gs',
);

const hits = [];
let m;
while ((m = RE.exec(src)) !== null) {
  const evt = m[1];
  const isAsync = m[2];
  const args1 = m[3];
  const argname = m[4];
  const body = m[5];
  const args = args1 !== undefined ? args1 : (argname ?? '');
  // next 必须以独立 token 出现（避免 nextStep / nextTick）
  const hasNext = /\bnext\s*\(/.test(body);
  const trim = body.replace(/^\s+|\s+$/g, '');
  const empty = trim === '';
  if (empty) {
    hits.push(`EMPTY: ${evt} (args: ${args})`);
  } else if (!hasNext) {
    hits.push(`NO_NEXT: ${evt} (args: ${args})\n  body: ${body}`);
  }
}

if (hits.length > 0) {
  console.log('RUNTIME_CONTRACT_FAIL');
  console.log(hits.join('\n'));
  process.exit(1);
} else {
  console.log('RUNTIME_CONTRACT_OK');
  process.exit(0);
}