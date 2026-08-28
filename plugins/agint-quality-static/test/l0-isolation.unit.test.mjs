/**
 * test/l0-isolation.unit.test.mjs — Sprint 11 v0.6.5 l0-isolation 单元测试
 *
 * 设计稿 §4.4 ADR-11-4 三项 L0 隔离检查的纯函数级单测（≥8 用例）。
 * 故意破坏注入测试见 l0-isolation.smoke.test.mjs（4 个 case）。
 *
 * 注意（L0-frozen 保护）：本文件**不允许**出现被 contract-reference 检查的字面串；
 * 需要它时用 CONTRACT_TOKEN 拼接，避免 grep 自检误报。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const { checkL0Isolation, checkSignatureCompatibility, checkDomainIsolation, checkDependencyWhitelist, SUBCHECKS } =
  await import(join(ROOT, 'lib/checkers/l0-isolation.js'));
const { loadProfile, FROZEN_SIGNATURES } =
  await import(join(ROOT, 'lib/static-profile.js'));

const profile = loadProfile();

// 拼接而非直写，避免本测试文件被 contract-reference 自检 grep 命中
const CONTRACT_TOKEN = ['agint', 'quality', 'contract'].join('-');

/** 合成一个临时 pluginDir；files 是 { 相对路径: 内容 }。 */
function makePluginDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'agint-l0-iso-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** 工具：构造 manifest JSON 字符串 */
function manifestStr(fields) {
  return JSON.stringify({
    name: 'agint-synth-happy',
    cordis: { provides: ['agint.echo'], events: [], tools: [] },
    storage: { domains: ['agint_synth_echo'], schemaVersion: 1, atomic: 'json' },
    ...fields,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 子检查 ① signatureCompatibility
// ─────────────────────────────────────────────────────────────────────────────

test('signatureCompatibility: clean manifest → 0 findings', () => {
  const m = JSON.parse(manifestStr({}));
  const findings = checkSignatureCompatibility({
    manifest: m, profile, manifestPath: '<test>',
  });
  assert.deepEqual(findings, []);
});

test('signatureCompatibility: provides collides with FROZEN schema name → blocker', () => {
  const m = JSON.parse(manifestStr({
    cordis: { provides: ['agint.EvalResult'], events: [], tools: [] },
  }));
  const findings = checkSignatureCompatibility({
    manifest: m, profile, manifestPath: '<test>',
  });
  const blockers = findings.filter(f => f.severity === 'blocker');
  assert.ok(blockers.length >= 1, `expected ≥1 blocker, got ${JSON.stringify(findings)}`);
  assert.match(blockers[0].message, /signatureCompatibility/);
  assert.match(blockers[0].message, /FROZEN schema 'EvalResult'/);
});

test('signatureCompatibility: provides collides with FROZEN interface name → blocker', () => {
  const m = JSON.parse(manifestStr({
    cordis: { provides: ['agint.QualityEvaluator'], events: [], tools: [] },
  }));
  const findings = checkSignatureCompatibility({
    manifest: m, profile, manifestPath: '<test>',
  });
  const blockers = findings.filter(f => f.severity === 'blocker');
  assert.ok(blockers.length >= 1, `expected ≥1 blocker, got ${JSON.stringify(findings)}`);
  assert.match(blockers[0].message, /FROZEN interface 'QualityEvaluator'/);
});

test('signatureCompatibility: provides impersonates agint.quality namespace → blocker', () => {
  const m = JSON.parse(manifestStr({
    cordis: { provides: ['agint.quality.clone', 'agint.quality.fake'], events: [], tools: [] },
  }));
  const findings = checkSignatureCompatibility({
    manifest: m, profile, manifestPath: '<test>',
  });
  const blockers = findings.filter(f => f.severity === 'blocker');
  assert.ok(blockers.length >= 2, `expected ≥2 blockers (2 impersonations), got ${JSON.stringify(findings)}`);
  for (const b of blockers) {
    assert.match(b.message, /impersonates FROZEN namespace/);
  }
});

test('signatureCompatibility: missing manifest → blocker (synth artifact must have manifest)', () => {
  const findings = checkSignatureCompatibility({
    manifest: null, profile, manifestPath: '<test>',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'blocker');
  assert.match(findings[0].message, /manifest\.json missing or unreadable/);
});

test('signatureCompatibility: non-array provides → warn (mount will reject downstream)', () => {
  const m = { name: 'agint-synth-x', cordis: { provides: 'agint.x' } };
  const findings = checkSignatureCompatibility({
    manifest: m, profile, manifestPath: '<test>',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'warn');
  assert.match(findings[0].message, /provides is missing or not array/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 子检查 ② domainIsolation
// ─────────────────────────────────────────────────────────────────────────────

test('domainIsolation: clean synth domain → 0 findings', () => {
  const m = JSON.parse(manifestStr({
    storage: { domains: ['agint_synth_echo'], schemaVersion: 1, atomic: 'json' },
  }));
  const findings = checkDomainIsolation({
    manifest: m, profile, manifestPath: '<test>',
  });
  assert.deepEqual(findings, []);
});

test('domainIsolation: tries to write agint_meta → blocker', () => {
  const m = JSON.parse(manifestStr({
    storage: { domains: ['agint_meta', 'agint_synth_echo'], schemaVersion: 1, atomic: 'json' },
  }));
  const findings = checkDomainIsolation({
    manifest: m, profile, manifestPath: '<test>',
  });
  const blockers = findings.filter(f => f.severity === 'blocker');
  assert.equal(blockers.length, 1);
  assert.match(blockers[0].message, /domainIsolation/);
  assert.match(blockers[0].message, /'agint_meta' violates synth-only policy/);
});

test('domainIsolation: tries to use ANY existing agint_* domain → blocker', () => {
  const m = JSON.parse(manifestStr({
    storage: { domains: ['agint_memory', 'agint_evolution'], schemaVersion: 1, atomic: 'json' },
  }));
  const findings = checkDomainIsolation({
    manifest: m, profile, manifestPath: '<test>',
  });
  const blockers = findings.filter(f => f.severity === 'blocker');
  assert.equal(blockers.length, 2);
  for (const b of blockers) assert.match(b.message, /violates synth-only policy/);
});

test('domainIsolation: empty domains array → blocker', () => {
  const m = JSON.parse(manifestStr({
    storage: { domains: [], schemaVersion: 1, atomic: 'json' },
  }));
  const findings = checkDomainIsolation({
    manifest: m, profile, manifestPath: '<test>',
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'blocker');
  assert.match(findings[0].message, /missing or empty/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 子检查 ③ dependencyWhitelist
// ─────────────────────────────────────────────────────────────────────────────

test('dependencyWhitelist: clean sources (only allowed hosts) → 0 findings', async () => {
  const dir = makePluginDir({
    'manifest.json': manifestStr({}),
    'package.json': JSON.stringify({ name: 'agint-synth-echo', dependencies: {} }),
    'lib/index.js': [
      "import { memory } from '@deepseek-ai/agint-memory';",
      "import { metrics } from '@deepseek-ai/agint-metrics';",
      "import { cron } from '@deepseek-ai/agint-cron';",
      'export const x = 1;',
    ].join('\n') + '\n',
  });
  try {
    const findings = await checkDependencyWhitelist({ pluginDir: dir, profile });
    assert.deepEqual(findings, []);
  } finally { cleanup(dir); }
});

test('dependencyWhitelist: require() form of allowed host → 0 findings', async () => {
  const dir = makePluginDir({
    'manifest.json': manifestStr({}),
    'lib/index.js': "const m = require('@deepseek-ai/agint-memory');\nexport default m;\n",
  });
  try {
    const findings = await checkDependencyWhitelist({ pluginDir: dir, profile });
    assert.deepEqual(findings, []);
  } finally { cleanup(dir); }
});

test('dependencyWhitelist: dynamic import() form of allowed host → 0 findings', async () => {
  const dir = makePluginDir({
    'manifest.json': manifestStr({}),
    'lib/index.js': "const m = await import('@deepseek-ai/agint-cron');\nexport default m;\n",
  });
  try {
    const findings = await checkDependencyWhitelist({ pluginDir: dir, profile });
    assert.deepEqual(findings, []);
  } finally { cleanup(dir); }
});

test('dependencyWhitelist: tries to require agint-quality-static → blocker', async () => {
  // 用完整 namespaced 形式（@deepseek-ai/...），与产物真实写法一致
  const STATIC_TOKEN = ['agint', 'quality', 'static'].join('-');
  const NAMESPACED = `@deepseek-ai/${STATIC_TOKEN}`;
  const dir = makePluginDir({
    'manifest.json': manifestStr({}),
    'lib/bad.js': `import x from '${NAMESPACED}';\nexport default x;\n`,
  });
  try {
    const findings = await checkDependencyWhitelist({ pluginDir: dir, profile });
    const blockers = findings.filter(f => f.severity === 'blocker');
    assert.equal(blockers.length, 1);
    assert.match(blockers[0].message, /dependencyWhitelist/);
    assert.match(blockers[0].message, /unauthorized host service/);
    // implementation 输出完整 @deepseek-ai/... 包名
    assert.match(blockers[0].message, new RegExp(`'${NAMESPACED}'`),
      `expected full namespaced name, got: ${blockers[0].message}`);
  } finally { cleanup(dir); }
});

test('dependencyWhitelist: tries to require agint-mutator (兄弟插件) → blocker', async () => {
  const dir = makePluginDir({
    'manifest.json': manifestStr({}),
    'lib/bad.js': "import { mutate } from '@deepseek-ai/agint-mutator';\nexport default mutate;\n",
  });
  try {
    const findings = await checkDependencyWhitelist({ pluginDir: dir, profile });
    const blockers = findings.filter(f => f.severity === 'blocker');
    assert.equal(blockers.length, 1);
    assert.match(blockers[0].message, /unauthorized host service '@deepseek-ai\/agint-mutator'/);
  } finally { cleanup(dir); }
});

test('dependencyWhitelist: non-namespaced agint-* package → blocker (防呆)', async () => {
  const dir = makePluginDir({
    'manifest.json': manifestStr({}),
    'lib/bad.js': "import x from 'agint-evil';\nexport default x;\n",
  });
  try {
    const findings = await checkDependencyWhitelist({ pluginDir: dir, profile });
    const blockers = findings.filter(f => f.severity === 'blocker');
    assert.equal(blockers.length, 1);
    assert.match(blockers[0].message, /non-namespaced agint package 'agint-evil'/);
  } finally { cleanup(dir); }
});

test('dependencyWhitelist: skips lib/checkers/ and node_modules/ (self-scan guard)', async () => {
  // 故意把违规 import 放在 lib/checkers/ 下（应被跳过）和 node_modules/ 下（应被跳过）
  const bad = "import x from '@deepseek-ai/agint-mutator';\nexport default x;\n";
  const dir = makePluginDir({
    'manifest.json': manifestStr({}),
    'lib/checkers/inner.js': bad,
    'lib/node_modules/dep/index.js': bad,
    'lib/clean.js': 'export const ok = 1;\n',
  });
  try {
    const findings = await checkDependencyWhitelist({ pluginDir: dir, profile });
    assert.deepEqual(findings, []);
  } finally { cleanup(dir); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 外层 checkL0Isolation 集成
// ─────────────────────────────────────────────────────────────────────────────

test('checkL0Isolation: clean synth artifact → 0 findings', async () => {
  const dir = makePluginDir({
    'manifest.json': manifestStr({}),
    'package.json': JSON.stringify({ name: 'agint-synth-echo', dependencies: {} }),
    'lib/index.js': "import { memory } from '@deepseek-ai/agint-memory';\nexport const x = 1;\n",
  });
  try {
    const findings = await checkL0Isolation({ pluginDir: dir, profile });
    assert.deepEqual(findings, []);
  } finally { cleanup(dir); }
});

test('checkL0Isolation: all 3 sub-checks fail → ≥3 blockers (one per sub-check)', async () => {
  const dir = makePluginDir({
    'manifest.json': JSON.stringify({
      name: 'agint-synth-evil',
      cordis: { provides: ['agint.EvalResult'], events: [], tools: [] },
      storage: { domains: ['agint_meta'], schemaVersion: 1, atomic: 'json' },
    }),
    'lib/bad.js': "import x from '@deepseek-ai/agint-mutator';\nexport default x;\n",
  });
  try {
    const findings = await checkL0Isolation({ pluginDir: dir, profile });
    const families = new Set(findings.filter(f => f.severity === 'blocker').map(f => f.message));
    assert.ok([...families].some(m => m.includes('signatureCompatibility')), 'signature blocker missing');
    assert.ok([...families].some(m => m.includes('domainIsolation')), 'domain blocker missing');
    assert.ok([...families].some(m => m.includes('dependencyWhitelist')), 'deps blocker missing');
  } finally { cleanup(dir); }
});

test('checkL0Isolation: l0IsolationOnly=true skips non-synth artifacts (mount 防误伤)', async () => {
  const dir = makePluginDir({
    'manifest.json': JSON.stringify({
      name: 'agint-mutator', // 既有插件
      cordis: { provides: ['agint.EvalResult'], events: [], tools: [] }, // 但故意冲突
      storage: { domains: ['agint_meta'], schemaVersion: 1, atomic: 'json' }, // 也冲突
    }),
    'lib/bad.js': "import x from '@deepseek-ai/agint-mutator';\nexport default x;\n",
  });
  try {
    const synthOnlyProfile = loadProfile('agint-default', { l0IsolationOnly: true });
    const findings = await checkL0Isolation({ pluginDir: dir, profile: synthOnlyProfile });
    assert.deepEqual(findings, [], `l0IsolationOnly should skip non-synth artifacts, got ${JSON.stringify(findings)}`);
  } finally { cleanup(dir); }
});

test('checkL0Isolation: l0IsolationOnly=true still scans synth artifacts (positive case)', async () => {
  const dir = makePluginDir({
    'manifest.json': JSON.stringify({
      name: 'agint-synth-evil', // 命名命中 → 视为 synth
      cordis: { provides: ['agint.EvalResult'], events: [], tools: [] },
      storage: { domains: ['agint_meta'], schemaVersion: 1, atomic: 'json' },
    }),
    'lib/bad.js': "import x from '@deepseek-ai/agint-mutator';\nexport default x;\n",
  });
  try {
    const synthOnlyProfile = loadProfile('agint-default', { l0IsolationOnly: true });
    const findings = await checkL0Isolation({ pluginDir: dir, profile: synthOnlyProfile });
    assert.ok(findings.length >= 3, `expected ≥3 blockers, got ${JSON.stringify(findings)}`);
  } finally { cleanup(dir); }
});

test('SUBCHECKS exports the 3 sub-check name constants', () => {
  assert.equal(SUBCHECKS.signatureCompatibility, 'signatureCompatibility');
  assert.equal(SUBCHECKS.domainIsolation, 'domainIsolation');
  assert.equal(SUBCHECKS.dependencyWhitelist, 'dependencyWhitelist');
});

test('FROZEN_SIGNATURES contains the 7 schema names', () => {
  assert.equal(FROZEN_SIGNATURES.schemas.length, 7);
  for (const n of ['EvalTarget', 'EvalResult', 'Decision', 'DecisionKind', 'HARM', 'DimensionScore', 'DreamPhase']) {
    assert.ok(FROZEN_SIGNATURES.schemas.includes(n), `missing ${n}`);
  }
});

test('FROZEN_SIGNATURES contains the 4 interface names', () => {
  assert.equal(FROZEN_SIGNATURES.interfaces.length, 4);
  for (const n of ['QualityEvaluator', 'QualityPolicy', 'QualityReporter', 'QualityLifecycle']) {
    assert.ok(FROZEN_SIGNATURES.interfaces.includes(n), `missing ${n}`);
  }
});
