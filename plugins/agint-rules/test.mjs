/**
 * agint-rules: unit tests for the pattern-matching logic. Pure functions
 * only — replays compilePattern / argText / seedRules shape so we can verify
 * the seed patterns actually catch what they claim to catch without
 * booting the full host plane.
 *
 * Run: node packages/agint-rules/test.mjs
 */

import assert from 'node:assert/strict';

// Mirror of host/lib/index.js helpers (kept tiny on purpose).
function compilePattern(rule) {
  try {
    return new RegExp(rule.pattern, rule.flags || undefined);
  } catch {
    return null;
  }
}
function argText(name, args) {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return args;
  if (Array.isArray(args)) {
    if (name === 'bash') return (args.command || args.cmd || '').toString();
    return JSON.stringify(args);
  }
  if (typeof args === 'object') {
    if (typeof args.command === 'string') return args.command;
    if (typeof args.cmd === 'string') return args.cmd;
    return JSON.stringify(args);
  }
  return String(args);
}

// Mirror of seed rules.
const seed = [
  {
    id: 'bash-rm-rf-root',
    tool: 'bash',
    pattern: '\\brm\\s+-[a-zA-Z]*[rfRF][a-zA-Z]*\\s+(/\\*?\\s*|~/\\s*|~\\s*|\\$HOME\\s*)(?!\\S)',
    flags: 'i',
    action: 'deny',
  },
  {
    id: 'bash-git-push-force-main',
    tool: 'bash',
    pattern: 'git\\s+push\\s+(?:--force(?:\\b|-)|-f\\b)[^|;&]*\\b(?:origin\\s+)?(?:main|master)\\b',
    flags: 'i',
    action: 'ask',
  },
  {
    id: 'bash-npm-publish',
    tool: 'bash',
    pattern: '\\bnpm\\s+publish\\b|\\bpnpm\\s+publish\\b|\\byarn\\s+publish\\b',
    flags: '',
    action: 'advisory',
  },
];

function classify(tool, args) {
  const text = argText(tool, args);
  const hits = [];
  for (const r of seed) {
    if (r.tool !== '*' && r.tool !== tool) continue;
    const re = compilePattern(r);
    if (re && re.test(text)) hits.push({ id: r.id, action: r.action });
  }
  return hits;
}

const cases = [
  // --- bash-rm-rf-root (deny) ---
  ['bash', { command: 'rm -rf /' }, ['bash-rm-rf-root']],
  ['bash', { command: 'rm -rf ~' }, ['bash-rm-rf-root']],
  ['bash', { command: 'rm -rf $HOME' }, ['bash-rm-rf-root']],
  ['bash', { command: 'rm -rf /*' }, ['bash-rm-rf-root']],
  ['bash', { command: 'rm -fr /' }, ['bash-rm-rf-root']], // upper-case flags
  ['bash', { command: 'rm /var/log/foo.log' }, []], // single file, ok
  ['bash', { command: 'rm -rf /tmp/build' }, []], // specific path
  ['bash', { command: 'rm -r build dist' }, []], // specific paths

  // --- bash-git-push-force-main (ask) ---
  ['bash', { command: 'git push --force origin main' }, ['bash-git-push-force-main']],
  ['bash', { command: 'git push -f origin main' }, ['bash-git-push-force-main']],
  ['bash', { command: 'git push --force origin master' }, ['bash-git-push-force-main']],
  ['bash', { command: 'git push origin main' }, []], // not forced
  ['bash', { command: 'git push --force origin feature/x' }, []], // not main
  ['bash', { command: 'git push --force-with-lease origin main' }, ['bash-git-push-force-main']], // -with-lease still hits

  // --- bash-npm-publish (advisory) ---
  ['bash', { command: 'npm publish' }, ['bash-npm-publish']],
  ['bash', { command: 'pnpm publish --tag next' }, ['bash-npm-publish']],
  ['bash', { command: 'yarn publish' }, ['bash-npm-publish']],
  ['bash', { command: 'npm install foo' }, []], // not publish
  ['bash', { command: 'npm run build' }, []],

  // --- Tool filter (only bash rules) ---
  ['web', { command: 'rm -rf /' }, []], // bash rules don't fire on web tool
  ['subagent', { task: 'npm publish something' }, []],

  // --- argText fallbacks ---
  ['bash', 'rm -rf /', ['bash-rm-rf-root']], // string args
];

let passed = 0;
let failed = 0;
for (const [tool, args, expected] of cases) {
  const hits = classify(tool, args);
  const got = hits.map((h) => h.id);
  try {
    assert.deepEqual(got, expected);
    passed += 1;
    console.log(`✓ ${tool} ${JSON.stringify(args).slice(0, 60)} → ${JSON.stringify(got)}`);
  } catch (e) {
    failed += 1;
    console.log(`✗ ${tool} ${JSON.stringify(args).slice(0, 60)}`);
    console.log(`   expected ${JSON.stringify(expected)}`);
    console.log(`   got      ${JSON.stringify(got)}`);
  }
}

// ---- Regression: buildAdvisoryMessage must emit a *valid* UserMessage ----
// 2026-09-16: this plugin used to inject a bare { source, content } object
// (no `id`, no `role`). dsh's write path tolerated it, but the resume/replay
// validator (assertMessageEventShape) rejects `user/message` events without a
// non-empty `id` + `role === 'user'` — so every session that received an
// advisory became un-openable ("session event at seq N lacks an identified
// message"). 14 bad events across 12 sessions were bricked.
//
// This test imports the REAL function from lib/index.js. It requires the dsh
// host packages to be resolvable (set NODE_PATH to the dsh nested node_modules,
// i.e. the AppData install). If dsh can't be resolved, we SKIP rather than
// fail, so the pure tests above still run in a host-less CI.
try {
  const mod = await import('./lib/index.js');
  const msg = mod.buildAdvisoryMessage('bash', [
    { ruleId: 'bash-npm-publish', level: 'L3', reason: '发布前请核对版本号' },
  ]);
  assert.equal(msg.role, 'user', 'advisory message must carry role:user');
  assert.equal(typeof msg.id, 'string', 'advisory message must carry an id');
  assert.ok(msg.id.length > 0, 'advisory id must be non-empty');
  assert.equal(msg.source.kind, 'plugin', 'advisory source.kind must be plugin');
  assert.equal(msg.source.plugin, 'agint-rules', 'advisory source.plugin must be set');
  assert.ok(
    Array.isArray(msg.content) && msg.content.length > 0 && msg.content[0].type === 'text',
    'advisory content must be a non-empty text block',
  );
  passed += 1;
  console.log('✓ buildAdvisoryMessage emits a valid UserMessage (role/id/source/content)');
} catch (e) {
  const isResolution =
    e && (e.code === 'ERR_MODULE_NOT_FOUND' ||
      (typeof e.message === 'string' && /Cannot find (package|module)/.test(e.message)));
  if (isResolution) {
    console.log('⊘ buildAdvisoryMessage shape test SKIPPED (dsh host packages not resolvable; set NODE_PATH to the AppData dsh/node_modules)');
  } else {
    failed += 1;
    console.log('✗ buildAdvisoryMessage shape regression: ' + (e && e.message));
  }
}

console.log(`\n${passed} passed, ${failed} failed (${cases.length + 1} cases incl. advisory shape)`);
process.exit(failed === 0 ? 0 : 1);