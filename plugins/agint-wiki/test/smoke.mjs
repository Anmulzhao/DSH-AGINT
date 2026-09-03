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

const lintReport = await wiki.lint();
assert.equal(lintReport.checked, list.length, 'lint.checked should match list length');
assert.equal(lintReport.brokenLinks.length, 0, 'no broken links in fresh fixture');
console.log(`[smoke] lint: checked=${lintReport.checked} broken=${lintReport.brokenLinks.length} ✓`);

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