#!/usr/bin/env node
/**
 * agint-wiki smoke test (v0.4 windows-path-escape fix validation).
 *
 * Covers three layers required by plugin-preflight:
 *   1. import: module loads cleanly (no schema / export errors)
 *   2. apply: can mount into a mock ctx, exposes `agint.wiki` service
 *   3. waterfall-equivalent: write/read/list/search/lint round-trip, with
 *      explicit Windows path-escape regression (clean() must accept a forward-
 *      slash relative path even when root is a Windows backslash absolute).
 *
 * Exit 0 = pass. Exit non-zero = smoke FAILED (stops safe-update).
 *
 * Run: node plugins/agint-wiki/test/smoke.mjs
 */
import { mkdtemp, rm, writeFile as wf, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { strict as assert } from 'node:assert';

import { apply, Config, inject, name } from '../lib/index.js';

console.log(`[smoke] module=${name} inject=${JSON.stringify(inject)}`);

// ── 1. import ──
assert.equal(name, 'agint-wiki', 'name must be "agint-wiki"');
assert.deepEqual(inject, [], 'host service has no inject deps');
assert.equal(typeof apply, 'function', 'apply must be a function');
assert.equal(typeof Config.parse, 'function', 'Config must be a zod schema');
console.log('[smoke] import ✓');

// ── 2. apply ──
const tmpRoot = await mkdtemp(join(tmpdir(), 'agint-wiki-smoke-'));
console.log(`[smoke] tmp root = ${tmpRoot}`);

const provided = new Map();
const ctx = {
  provide(service, value) { provided.set(service, value); },
};

// Config schema check (zod)
const cfg = Config.parse({ root: tmpRoot });
await apply(ctx, cfg);
const wiki = provided.get('agint.wiki');
assert.ok(wiki, 'apply must call ctx.provide("agint.wiki")');
for (const fn of ['read', 'write', 'remove', 'list', 'search', 'lint']) {
  assert.equal(typeof wiki[fn], 'function', `wiki.${fn} must be a function`);
}
console.log('[smoke] apply ✓ (provides=agint.wiki, methods=read/write/remove/list/search/lint)');

// ── 3. round-trip + Windows path regression ──
let pass = 0;
let fail = 0;

const checks = [
  // path: simple basename (forward slash)
  ['forward-slash basename', 'hello.md', '# hello\n'],
  // path: nested directory (forward slash)
  ['forward-slash nested', 'sub/dir/note.md', '# note\n'],
  // path: already-trimmed leading slash (lib strips ^/+)
  ['leading-slash stripped', '/leading.md', '# leading\n'],
];

for (const [label, relPath, content] of checks) {
  try {
    const { path: savedPath, bytes } = await wiki.write(relPath, content);
    assert.equal(savedPath, relPath.replace(/^\/+/, ''), `saved path mismatch: ${savedPath}`);
    assert.ok(bytes > 0, `bytes should be > 0, got ${bytes}`);

    const readBack = await wiki.read(relPath);
    assert.ok(readBack, `read(${relPath}) returned null`);
    assert.equal(readBack.content, content, `content mismatch on ${relPath}`);

    console.log(`  ✓ ${label}: ${relPath} (${bytes}B)`);
    pass++;
  } catch (err) {
    console.log(`  ✗ ${label}: ${relPath} → ${err.message}`);
    fail++;
  }
}

// list + search + lint round-trip
const list = await wiki.list();
assert.ok(list.length >= 3, `list should return >=3 entries, got ${list.length}`);
console.log(`[smoke] list returned ${list.length} entries ✓`);

const hits = await wiki.search('hello');
assert.ok(hits.length >= 1, `search("hello") should hit`);
assert.equal(hits[0].path, 'hello.md', 'top hit should be hello.md');
console.log(`[smoke] search "hello" → ${hits[0].path}:${hits[0].line} ✓`);

// ── 3b. lint: 「条目自相矛盾」 vs 「作者警告」 must be told apart ──
// Positive sample: a ⚠️ line sitting in a correction/contradiction context
//   (two mutually conflicting claims) → must be RED.
// Negative sample: an author warning line that states no conflict at all —
//   the exact shape that used to be miscounted as a contradiction —
//   → must surface in the separate `warnings` bucket, never in `contradictions`.
// Index sample: the same conflict on README.md → exempt from the verdict.
await wiki.write(
  'conflicting.md',
  '# conflicting\n\n- 本条目认定推理档位固定为 3。\n- ⚠️ 更正：推理档位固定为 1，与上文矛盾。\n',
);
await wiki.write(
  'author-warning.md',
  '# author-warning\n\n- ⚠️ 排查禁忌：不要用 grep UNSUPPORTED_REASONING_EFFORT 判断是否报错，须结构化解析 data.type。\n',
);
await wiki.write(
  'README.md',
  `# index\n\n- 本索引认定矛盾判据即 content.includes('⚠️')。\n- ⚠️ 更正：矛盾判据另有口径，与上文矛盾。\n`,
);

const listWithFixtures = await wiki.list();
const lintReport = await wiki.lint();
assert.equal(lintReport.checked, listWithFixtures.length, 'lint.checked should match list length');
assert.equal(lintReport.brokenLinks.length, 0, 'no broken links in fresh fixture');

assert.ok(Array.isArray(lintReport.contradictions), 'lint.contradictions must be an array');
for (const c of lintReport.contradictions) {
  assert.equal(typeof c.path, 'string', 'each contradiction must carry .path, not a bare filename string');
  assert.equal(typeof c.line, 'number', 'each contradiction must carry a 1-based .line for review');
  assert.equal(typeof c.snippet, 'string', 'each contradiction must carry the matched .snippet for review');
}
const flagged = lintReport.contradictions.filter((c) => c.path === 'conflicting.md');
assert.equal(flagged.length, 1, `positive sample must be flagged exactly once, got ${JSON.stringify(lintReport.contradictions)}`);
assert.ok(flagged[0].snippet.includes('更正'), 'flagged .snippet must be reviewable (should show the conflicting claim)');
assert.equal(
  lintReport.contradictions.some((c) => c.path === 'author-warning.md'),
  false,
  'an author warning with no conflicting claim must NOT be counted as a contradiction',
);
assert.ok(Array.isArray(lintReport.warnings), 'suspected ⚠️ hits must surface in lint.warnings, not be silently dropped');
for (const w of lintReport.warnings) {
  assert.equal(typeof w.path, 'string', 'each warning must carry .path, not a bare filename string');
  assert.equal(typeof w.line, 'number', 'each warning must carry a 1-based .line for review');
  assert.equal(typeof w.snippet, 'string', 'each warning must carry the matched .snippet for review');
}
const suspected = lintReport.warnings.find((w) => w.path === 'author-warning.md');
assert.ok(suspected, 'author-warning.md must be reported as 疑似 (suspected) in lint.warnings');
assert.ok(
  suspected.snippet.includes('排查禁忌'),
  `suspected .snippet must show the ⚠️ line so a human can re-check it, got ${suspected.snippet}`,
);
assert.equal(
  lintReport.contradictions.some((c) => c.path === 'README.md'),
  false,
  'index page (README.md) must be exempt from the contradiction verdict',
);
console.log(
  `[smoke] lint: checked=${lintReport.checked} broken=${lintReport.brokenLinks.length} contradictions=${lintReport.contradictions.length} warnings=${lintReport.warnings.length} ✓`,
);

// ── 4. negative case: still rejects path-escape attempts ──
let escapeBlocked = 0;
for (const evil of ['../escape.md', '../../etc/passwd.md']) {
  try {
    await wiki.write(evil, 'evil');
    console.log(`  ✗ ESCAPE NOT BLOCKED: ${evil}`);
    fail++;
  } catch (err) {
    if (/path escapes root/.test(err.message)) {
      console.log(`  ✓ escape blocked: ${evil}`);
      escapeBlocked++;
    } else {
      console.log(`  ✗ wrong error for ${evil}: ${err.message}`);
      fail++;
    }
  }
}
assert.equal(escapeBlocked, 2, 'must block both ../ and ../../ escape attempts');
console.log('[smoke] path-escape negative tests ✓');

// ── cleanup ──
await rm(tmpRoot, { recursive: true, force: true });
console.log(`[smoke] cleaned tmp root: ${tmpRoot}`);

// ── summary ──
const sep_ = sep; // platform native separator (used only for display)
console.log(`[smoke] separator=${sep_} pass=${pass} fail=${fail} escape-blocked=${escapeBlocked}`);
if (fail > 0) {
  console.error(`[smoke] FAILED: ${fail} round-trip case(s) failed`);
  process.exit(1);
}
console.log('[smoke] PASS ✓');