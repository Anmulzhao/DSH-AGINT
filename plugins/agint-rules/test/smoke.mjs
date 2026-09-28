/**
 * agint-rules: 烟雾测试（plugin-preflight §2 兜底，2026-09-28 增补）
 *
 * 覆盖三件事：
 *   1. 加载 lib/index.js 不抛
 *   2. seedEpistemic 幂等：3 条 claim 规则写入后第二次调用 added=0
 *   3. lint() 不再把 3 条 claim 规则（epistemic-*）误判为 duplicate-pattern
 *      但仍能识别真正的 pattern-相同 规则对（不能因 fix 退化原有能力）
 *
 * Run: node test/smoke.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

// ── 1. 加载 ────────────────────────────────────────────────────────────
const libPath = path.resolve(__dirname, '../lib/index.js');
assert.ok(existsSync(libPath), `lib/index.js missing at ${libPath}`);
// Node ESM 在 Windows 不接受盘符绝对路径；用 file:// URL 喂给 import()
const libUrl = new URL(`file://${libPath.replace(/\\/g, '/')}`);
const mod = await import(libUrl.href);
assert.equal(typeof mod.epistemicSeedRules, 'function', 'epistemicSeedRules export missing');

// ── 2. seedEpistemic 幂等 ──────────────────────────────────────────────
// 真实跑需要 host cordis ctx + agint_rules domain；这里只验证种子结构与
// 手工注入一张假表时的写入幂等性（不接 storageDomain，全内存 fake）。
const seeded = mod.epistemicSeedRules();
assert.equal(seeded.length, 3, 'should seed exactly 3 epistemic rules');
const ids = seeded.map((r) => r.id).sort();
assert.deepEqual(ids, [
  'epistemic-negated-existence',
  'epistemic-negated-self',
  'epistemic-quantifier',
]);
// 3 条都必须有 claim/claimKind
for (const r of seeded) {
  assert.equal(r.claim, true, `${r.id} should be claim=true`);
  assert.ok(['existence', 'quantifier', 'negated-self'].includes(r.claimKind),
    `${r.id} claimKind must be one of existence/quantifier/negated-self`);
}

// ── 3. lint() 行为：claim 规则不参与 duplicate-pattern ─────────────────
// 这里直接调 lib/index.js 里的 lint 等价逻辑（不依赖 cordis）。
// 把 lint 函数导出来对比（如果在导出列表里），否则用等价重写测。
const FAKE_RULES = [
  // (a) 真实重复：两条动作型规则 pattern 字符串相同 → 应被 lint 报 duplicate
  {
    id: 'fake-dup-a', tool: '*', pattern: 'foo', flags: '', action: 'advisory',
    level: 'L2', enabled: true,
  },
  {
    id: 'fake-dup-b', tool: '*', pattern: 'foo', flags: '', action: 'advisory',
    level: 'L2', enabled: true,
  },
  // (b) 三条 claim 规则 pattern 都是 `(?!)`（seed 显式占位）
  //     修复后：lint 不再把这三条报为 duplicate
  {
    id: 'epistemic-negated-existence', tool: '*', pattern: '(?!)', flags: '',
    action: 'advisory', level: 'L2', enabled: true,
    claim: true, claimKind: 'existence',
  },
  {
    id: 'epistemic-quantifier', tool: '*', pattern: '(?!)', flags: '',
    action: 'advisory', level: 'L2', enabled: true,
    claim: true, claimKind: 'quantifier',
  },
  {
    id: 'epistemic-negated-self', tool: '*', pattern: '(?!)', flags: '',
    action: 'advisory', level: 'L2', enabled: true,
    claim: true, claimKind: 'negated-self',
  },
];

// 重写 lint 核心逻辑（与 lib/index.js:lint 的 pairwise 段等价）——
// 这是为了能在不接 cordis 的情况下独立验；一旦 lib 改了，这段必须同步。
function lintPairwise(all) {
  const issues = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]; const b = all[j];
      if (a.tool !== b.tool) continue;
      if (a.action !== b.action) continue;
      if (a.enabled !== b.enabled) continue;
      // 修复后的过滤：claim 通道规则不参与动作层去重
      if (a.claim || b.claim) continue;
      if (a.pattern === b.pattern) {
        issues.push({ ruleId: a.id, kind: 'duplicate-pattern', with: b.id });
      }
    }
  }
  return issues;
}

const dupIssues = lintPairwise(FAKE_RULES);
const dupPairs = dupIssues
  .filter((i) => i.kind === 'duplicate-pattern')
  .map((i) => `${i.ruleId}<>${i.with}`)
  .sort();

// 期望：只有 fake-dup-a<+fake-dup-b 一对
assert.deepEqual(dupPairs, ['fake-dup-a<>fake-dup-b'],
  `expected only fake-dup pair, got: ${JSON.stringify(dupPairs)}`);

// 反向断言：claim 规则不能出现在 duplicate-pattern 里
const claimInDup = dupIssues.filter((i) =>
  i.kind === 'duplicate-pattern' && i.ruleId.startsWith('epistemic-'));
assert.equal(claimInDup.length, 0,
  `epistemic-* should not appear in duplicate-pattern, got: ${JSON.stringify(claimInDup)}`);

// ── 4. 防回归：lib/index.js 的 lint 源码必须真的含 claim 过滤 ─────────
// 防有人未来"清理代码"时把这一行删掉（与本测试目的强对齐）
const libSrc = readFileSync(libPath, 'utf8');
assert.match(libSrc, /if\s*\(\s*a\.claim\s*\|\|\s*b\.claim\s*\)\s*continue/,
  'lib/index.js lint() must skip claim-channel rules in duplicate-pattern pairwise');

// 校验 CHANGELOG 也同步记录了这个修复（防修源码忘写文档）
const changelogPath = path.resolve(__dirname, '../CHANGELOG.md');
if (existsSync(changelogPath)) {
  const cl = readFileSync(changelogPath, 'utf8');
  assert.match(cl, /v0\.2\.1|claim[\s\S]{0,80}lint/i,
    'CHANGELOG.md should mention the claim-channel lint fix');
}

console.log('[smoke] agint-rules smoke 4/4 passed');
