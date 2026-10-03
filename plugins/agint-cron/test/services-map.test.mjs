/**
 * agint-cron: services 快照表接线回归（2026-10-04 生产实跑钉出的洞）
 *
 * 事故形状：jobs.js 的 ledger-anchor 读 `services['agint.evolution']`，
 * 而 index.js 的快照表从来没有这个键 ⇒ job 每次必报 not available。
 * lib/ 层的单测把 services 直传给 action，**绕过了快照表**，所以测不出来。
 * 本测试补上这一环：jobs.js 源码里引用的每个 `services['<key>']`
 * 都必须出现在 index.js 的 `services()` 字面量里。
 *
 * Run: node --test plugins/agint-cron/test/services-map.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jobsSrc = readFileSync(join(root, 'lib', 'jobs.js'), 'utf8');
const indexSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8');

const referenced = new Set(
  [...jobsSrc.matchAll(/services\['([^']+)'\]/g)].map((m) => m[1]),
);

// index.js 的快照表是 `const services = () => ({ ... })` 里的字符串键。
// 'agint.repoRoot' 用 config 传（同注释所言不进 ctx.get）——按键名出现在表字面量里即算接线。
const mapBlock = /const services = \(\) => \(\{([\s\S]*?)\n\s*\}\);/.exec(indexSrc);

// 已知豁免：引用了但全仓无人 provide 的键。`??` 兜底使它不炸，但静默降级。
// 列在这里 = 留案底，不是放过 —— 2026-10-04 记账：prompt-static-check 因此恒扫 0 根。
const EXEMPT = new Set(['agint.manifestsRoots']);

test('R1: jobs.js 引用的每个服务键都在 index.js 快照表里', () => {
  assert.ok(mapBlock, 'index.js 里找不到 services() 快照表（形状变了要同步改本测试）');
  const keys = new Set([...mapBlock[1].matchAll(/'([^']+)':/g)].map((m) => m[1]));
  const missing = [...referenced].filter((k) => !keys.has(k) && !EXEMPT.has(k));
  assert.deepEqual(missing, [], `jobs.js 引用了快照表没有的键：${missing.join(', ')}`);
});

test('R1b: 豁免名单本身要短，加新豁免必须写理由（防"测试红了改测试"）', () => {
  assert.ok(EXEMPT.size <= 1, `豁免超过 1 个说明接线继续漏，去补快照表而不是加豁免（现 ${EXEMPT.size} 个）`);
  for (const k of EXEMPT) assert.ok(referenced.has(k), `豁免键 ${k} 已不在 jobs.js 引用，删掉豁免`);
});

test('R2: 已知关键键在场（防正则被无意义满足）', () => {
  assert.ok(referenced.has('agint.evolution'), 'jobs.js 引用 agint.evolution 的正向锚点');
  assert.ok(mapBlock, '快照表已解析');
  const keys = new Set([...mapBlock[1].matchAll(/'([^']+)':/g)].map((m) => m[1]));
  for (const k of ['agint.evolution', 'agint.skillAutocreate', 'agint.evolve']) {
    assert.ok(keys.has(k), `快照表应包含 ${k}`);
  }
});
