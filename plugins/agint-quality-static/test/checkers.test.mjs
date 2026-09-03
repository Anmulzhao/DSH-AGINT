/**
 * test/checkers.test.mjs — Sprint 10 v0.6.3 #4
 *
 * 4 族 checker 单元测试（≥12 用例）：dependency-audit / storage-boundary /
 * env-access / contract-reference。
 *
 * 注意（L0-frozen 保护）：本文件**不允许**出现被 contract-reference 检查的字面串；
 * 需要它时用 CONTRACT_TOKEN 拼接，避免 grep 自检误报。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHECKERS = resolve(__dirname, '../lib/checkers');

// Windows 上裸绝对路径（D:\...）会被 ESM 解析器当成 URL scheme，
// 报 ERR_UNSUPPORTED_ESM_URL_SCHEME；动态 import 必须走 pathToFileURL。
const { checkDependencyAudit } = await import(pathToFileURL(join(CHECKERS, 'dependency-audit.js')).href);
const { checkStorageBoundary } = await import(pathToFileURL(join(CHECKERS, 'storage-boundary.js')).href);
const { checkEnvAccess } = await import(pathToFileURL(join(CHECKERS, 'env-access.js')).href);
const { checkContractReference } = await import(pathToFileURL(join(CHECKERS, 'contract-reference.js')).href);
const { loadProfile } = await import(pathToFileURL(resolve(__dirname, '../lib/static-profile.js')).href);

// 拼接而非直写，避免本测试文件被 contract-reference 自检 grep 命中
const CONTRACT_TOKEN = ['agint', 'quality', 'contract'].join('-');

const profile = loadProfile();

/** 合成一个临时 pluginDir；files 是 { 相对路径: 内容 }。 */
function makePluginDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'agint-static-'));
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

// ---------- dependency-audit ----------

test('dependency-audit: happy path → 0 findings', async () => {
  const dir = makePluginDir({
    'package.json': JSON.stringify({
      name: 'agint-x',
      dependencies: { zod: '^3.0.0', '@deepseek-ai/dsh-cordis': '*' },
      devDependencies: { '@deepseek-ai/agint-memory': '*' },
    }),
  });
  try {
    const findings = await checkDependencyAudit({ pluginDir: dir, profile });
    assert.deepEqual(findings, []);
  } finally { cleanup(dir); }
});

test('dependency-audit: unauthorized dep → 1 blocker', async () => {
  const dir = makePluginDir({
    'package.json': JSON.stringify({ name: 'agint-x', dependencies: { lodash: '^4.0.0' } }),
  });
  try {
    const findings = await checkDependencyAudit({ pluginDir: dir, profile });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].family, 'dependency-audit');
    assert.equal(findings[0].severity, 'blocker');
    assert.match(findings[0].message, /unauthorized dependency: lodash/);
    assert.match(findings[0].location, /package\.json$/);
  } finally { cleanup(dir); }
});

test('dependency-audit: missing package.json → blocker with "not found"', async () => {
  const dir = makePluginDir({ 'lib/foo.js': 'export const a = 1;\n' });
  try {
    const findings = await checkDependencyAudit({ pluginDir: dir, profile });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'blocker');
    assert.match(findings[0].message, /not found/);
  } finally { cleanup(dir); }
});

test('dependency-audit: malformed JSON → blocker with parse error', async () => {
  const dir = makePluginDir({ 'package.json': '{ not valid json ' });
  try {
    const findings = await checkDependencyAudit({ pluginDir: dir, profile });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'blocker');
    assert.match(findings[0].message, /parse error/);
  } finally { cleanup(dir); }
});

test('dependency-audit: multiple unauthorized deps across blocks → 2 blockers', async () => {
  const dir = makePluginDir({
    'package.json': JSON.stringify({
      dependencies: { axios: '*' },
      peerDependencies: { chalk: '*' },
      optionalDependencies: { zod: '*' },
    }),
  });
  try {
    const findings = await checkDependencyAudit({ pluginDir: dir, profile });
    assert.equal(findings.length, 2);
    const names = findings.map(f => f.message).sort().join('|');
    assert.match(names, /axios/);
    assert.match(names, /chalk/);
  } finally { cleanup(dir); }
});

// ---------- storage-boundary ----------

test('storage-boundary: happy path (no fs write) → 0 findings', async () => {
  const dir = makePluginDir({ 'lib/foo.js': 'export function f() { return 42; }\n' });
  try {
    assert.deepEqual(await checkStorageBoundary({ pluginDir: dir, profile }), []);
  } finally { cleanup(dir); }
});

test('storage-boundary: direct fs write to agint_evolution → blocker', async () => {
  const dir = makePluginDir({
    'lib/bad.js': [
      "import fs from 'node:fs';",
      "fs.writeFile('agint_evolution/foo.json', '{}', () => {});",
    ].join('\n') + '\n',
  });
  try {
    const findings = await checkStorageBoundary({ pluginDir: dir, profile });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].family, 'storage-boundary');
    assert.equal(findings[0].severity, 'blocker');
    assert.match(findings[0].message, /agint_evolution/);
    // 分隔符字符类：POSIX 是 '/'，Windows 是 '\'（跨平台断言）
    assert.match(findings[0].location, /lib[\/\\]bad\.js:2$/);
  } finally { cleanup(dir); }
});

test('storage-boundary: fs write to unrelated path → 0 findings', async () => {
  const dir = makePluginDir({
    'lib/ok.js': "import fs from 'node:fs';\nfs.writeFileSync('/tmp/scratch.txt', 'hi');\n",
  });
  try {
    assert.deepEqual(await checkStorageBoundary({ pluginDir: dir, profile }), []);
  } finally { cleanup(dir); }
});

test('storage-boundary: domain literal on a later line within lookahead → blocker', async () => {
  const dir = makePluginDir({
    'lib/multi.js': [
      "import fs from 'node:fs';",
      'fs.appendFileSync(',
      '  buildPath(',
      "    'agint_memory',",
      "  ), 'x');",
    ].join('\n') + '\n',
  });
  try {
    const findings = await checkStorageBoundary({ pluginDir: dir, profile });
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /agint_memory/);
  } finally { cleanup(dir); }
});

test('storage-boundary: skips lib/checkers/ and node_modules/ (self-scan guard)', async () => {
  const bad = "import fs from 'node:fs';\nfs.writeFileSync('agint_metrics/x.json', '{}');\n";
  const dir = makePluginDir({
    'lib/checkers/evil.js': bad,
    'lib/node_modules/dep/index.js': bad,
    'lib/clean.js': 'export const ok = 1;\n',
  });
  try {
    assert.deepEqual(await checkStorageBoundary({ pluginDir: dir, profile }), []);
  } finally { cleanup(dir); }
});

// ---------- env-access ----------

test('env-access: allowlisted var → 0 findings', async () => {
  const dir = makePluginDir({ 'lib/env.js': 'const h = process.env.DSH_HOME;\nexport default h;\n' });
  try {
    assert.deepEqual(await checkEnvAccess({ pluginDir: dir, profile }), []);
  } finally { cleanup(dir); }
});

test('env-access: non-allowlisted var → warn finding', async () => {
  const dir = makePluginDir({ 'lib/env.js': 'const k = process.env.SECRET_API_KEY;\nexport default k;\n' });
  try {
    const findings = await checkEnvAccess({ pluginDir: dir, profile });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].family, 'env-access');
    assert.equal(findings[0].severity, 'warn');
    assert.match(findings[0].message, /SECRET_API_KEY/);
    assert.match(findings[0].location, /lib[\/\\]env\.js:1$/);
  } finally { cleanup(dir); }
});

test('env-access: bracket form process.env["X"] → warn finding', async () => {
  const dir = makePluginDir({ 'lib/env.js': "const t = process.env['MY_TOKEN'];\nexport default t;\n" });
  try {
    const findings = await checkEnvAccess({ pluginDir: dir, profile });
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /MY_TOKEN/);
  } finally { cleanup(dir); }
});

test('env-access: root index.js is scanned too', async () => {
  const dir = makePluginDir({ 'index.js': 'export const z = process.env.WEIRD_FLAG;\n' });
  try {
    const findings = await checkEnvAccess({ pluginDir: dir, profile });
    assert.equal(findings.length, 1);
    assert.match(findings[0].location, /index\.js:1$/);
  } finally { cleanup(dir); }
});

// ---------- contract-reference ----------

test('contract-reference: clean plugin → 0 findings', async () => {
  const dir = makePluginDir({ 'lib/clean.js': "import { z } from 'zod';\nexport default z;\n" });
  try {
    assert.deepEqual(await checkContractReference({ pluginDir: dir, profile }), []);
  } finally { cleanup(dir); }
});

test('contract-reference: import of forbidden contract → blocker', async () => {
  const dir = makePluginDir({
    'lib/leak.js': `import something from '${CONTRACT_TOKEN}';\nexport default something;\n`,
  });
  try {
    const findings = await checkContractReference({ pluginDir: dir, profile });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].family, 'contract-reference');
    assert.equal(findings[0].severity, 'blocker');
    assert.match(findings[0].location, /lib[\/\\]leak\.js:1$/);
    assert.match(findings[0].message, /reference found at/);
  } finally { cleanup(dir); }
});

test('contract-reference: self-skip — lib/checkers/ never scanned', async () => {
  const dir = makePluginDir({
    'lib/checkers/contract-reference.js': `const P = /${CONTRACT_TOKEN}/g;\nexport default P;\n`,
    'lib/checkers/other.js': `// mentions ${CONTRACT_TOKEN} in a comment\n`,
    'lib/clean.js': 'export const ok = 1;\n',
  });
  try {
    assert.deepEqual(await checkContractReference({ pluginDir: dir, profile }), []);
  } finally { cleanup(dir); }
});

test('contract-reference: real agint-quality-static plugin dir itself → 0 findings', async () => {
  const selfDir = resolve(__dirname, '..');
  const findings = await checkContractReference({ pluginDir: selfDir, profile });
  assert.deepEqual(findings, [], `unexpected: ${JSON.stringify(findings)}`);
});
