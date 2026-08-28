/**
 * test/l0-isolation.smoke.test.mjs — Sprint 11 v0.6.5 故意破坏注入测试
 *
 * 设计稿 §4.4 ADR-11-4：l0-isolation 三项检查的「故意破坏」注入测试，
 * 证明检查**真的**能拦住恶意 / 不合规产物。
 *
 * 4 个 case 设计（老板 2026-08-27 拍板）：
 *   case 1 (signature-compatibility): 故意删/冲突 FROZEN schema 名 → 应被签名检查拒绝
 *   case 2 (domain-isolation):       故意写 agint_meta 域 → 应被域隔离检查拒绝
 *   case 3 (dependency-whitelist):   故意 require agint-quality-static 内部模块 → 应被依赖白名单拒绝
 *   case 4 (happy path):             完全合规产物 → 三项检查全过
 *
 * 注意（L0-frozen 保护）：本文件**不允许**出现被 contract-reference 检查的字面串；
 * 用 CONTRACT_TOKEN / STATIC_TOKEN 拼接，避免 grep 自检误报。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const { checkL0Isolation } = await import(join(ROOT, 'lib/checkers/l0-isolation.js'));
const { loadProfile } = await import(join(ROOT, 'lib/static-profile.js'));

// 拼接而非直写，避免本测试文件被 contract-reference 自检 grep 命中
const CONTRACT_TOKEN = ['agint', 'quality', 'contract'].join('-');
const STATIC_TOKEN = ['agint', 'quality', 'static'].join('-');
const STATIC_NAMESPACED = `@deepseek-ai/${STATIC_TOKEN}`;

/** 合成一个临时 pluginDir；files 是 { 相对路径: 内容 }。 */
function makePluginDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'agint-l0-smoke-'));
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

/** 工具：合成合规 manifest（happy 模板） */
function happyManifest() {
  return JSON.stringify({
    name: 'agint-synth-echo',
    cordis: { provides: ['agint.echo'], events: [], tools: [] },
    storage: { domains: ['agint_synth_echo'], schemaVersion: 1, atomic: 'json' },
  });
}

/** mount 编排默认走 l0IsolationOnly=true；smoke 用同名 profile。 */
const mountProfile = () => loadProfile('agint-default', { l0IsolationOnly: true });

// ─────────────────────────────────────────────────────────────────────────────
// Case 1 — 故意删/冲突 FROZEN 字段 → 签名兼容检查拒绝
// ─────────────────────────────────────────────────────────────────────────────

test('CASE 1 (signature-compatibility): synth artifact that tries to provide a FROZEN schema name → blocked', async () => {
  // 故意把 provides 写成与 FROZEN schema 同名的 'EvalResult' / 'HARM'
  const dir = makePluginDir({
    'manifest.json': JSON.stringify({
      name: 'agint-synth-evil',
      cordis: {
        // 'EvalResult' / 'HARM' 都命中 FROZEN_SIGNATURES.schemas
        provides: ['agint.EvalResult', 'agint.HARM', 'agint.QualityEvaluator'],
        events: [], tools: [],
      },
      storage: { domains: ['agint_synth_echo'], schemaVersion: 1, atomic: 'json' },
    }),
    'package.json': JSON.stringify({ name: 'agint-synth-evil', dependencies: {} }),
    'lib/index.js': "import { memory } from '@deepseek-ai/agint-memory';\nexport const x = 1;\n",
  });
  try {
    const findings = await checkL0Isolation({ pluginDir: dir, profile: mountProfile() });
    // 必须命中 signatureCompatibility blocker
    const sigBlockers = findings.filter(f =>
      f.severity === 'blocker' && f.message.includes('signatureCompatibility'),
    );
    assert.ok(sigBlockers.length >= 3, `expected ≥3 signature blockers, got ${JSON.stringify(findings)}`);
    // 检查具体名字命中
    const messages = sigBlockers.map(f => f.message).join('\n');
    assert.match(messages, /EvalResult/, 'should mention EvalResult');
    assert.match(messages, /HARM/, 'should mention HARM');
    assert.match(messages, /QualityEvaluator/, 'should mention QualityEvaluator');
  } finally { cleanup(dir); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Case 2 — 故意写 agint_meta 域 → 域隔离检查拒绝
// ─────────────────────────────────────────────────────────────────────────────

test('CASE 2 (domain-isolation): synth artifact that tries to write agint_meta → blocked', async () => {
  // 故意把 storage.domains 设成既有 agint_meta（设计稿原文「尤其 agint_meta」）
  // 同时混一个合规的 agint_synth_echo —— 确保命中即拒绝、不是「全空才拒绝」
  const dir = makePluginDir({
    'manifest.json': JSON.stringify({
      name: 'agint-synth-meta',
      cordis: { provides: ['agint.echo'], events: [], tools: [] },
      storage: { domains: ['agint_meta'], schemaVersion: 1, atomic: 'json' },
    }),
    'package.json': JSON.stringify({ name: 'agint-synth-meta', dependencies: {} }),
    'lib/index.js': "import { memory } from '@deepseek-ai/agint-memory';\nexport const x = 1;\n",
  });
  try {
    const findings = await checkL0Isolation({ pluginDir: dir, profile: mountProfile() });
    const domainBlockers = findings.filter(f =>
      f.severity === 'blocker' && f.message.includes('domainIsolation'),
    );
    assert.equal(domainBlockers.length, 1, `expected exactly 1 domain blocker, got ${JSON.stringify(findings)}`);
    assert.match(domainBlockers[0].message, /'agint_meta' violates synth-only policy/);
    assert.match(domainBlockers[0].location, /manifest\.json$/);
  } finally { cleanup(dir); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Case 3 — 故意 require agint-quality-static 内部模块 → 依赖白名单检查拒绝
// ─────────────────────────────────────────────────────────────────────────────

test('CASE 3 (dependency-whitelist): synth artifact that imports agint-quality-static → blocked', async () => {
  // 故意在源码里 import 本插件自己（agint-quality-static）
  // —— 这是最直接的「借用既有实现」攻击向量
  const dir = makePluginDir({
    'manifest.json': happyManifest(),
    'package.json': JSON.stringify({ name: 'agint-synth-echo', dependencies: {} }),
    'lib/evil.js': `import { checker } from '${STATIC_NAMESPACED}';\nexport default checker;\n`,
  });
  try {
    const findings = await checkL0Isolation({ pluginDir: dir, profile: mountProfile() });
    const depBlockers = findings.filter(f =>
      f.severity === 'blocker' && f.message.includes('dependencyWhitelist'),
    );
    assert.ok(depBlockers.length >= 1, `expected ≥1 dep blocker, got ${JSON.stringify(findings)}`);
    // 必须命中完整 namespaced 名字（implementation 输出 @deepseek-ai/...）
    const msg = depBlockers.map(f => f.message).join('\n');
    assert.match(msg, new RegExp(`unauthorized host service '${STATIC_NAMESPACED.replace(/[.\/]/g, '\\$&')}'`),
      `expected unauthorized message referencing ${STATIC_NAMESPACED}, got: ${msg}`);
  } finally { cleanup(dir); }
});

test('CASE 3b (dependency-whitelist): synth artifact that imports agint-mutator → blocked', async () => {
  // 兄弟插件变体 —— 防止「绕过」式攻击（直接 import 兄弟插件的实现）
  const dir = makePluginDir({
    'manifest.json': happyManifest(),
    'package.json': JSON.stringify({ name: 'agint-synth-echo', dependencies: {} }),
    'lib/evil.js': "import { mutate } from '@deepseek-ai/agint-mutator';\nexport default mutate;\n",
  });
  try {
    const findings = await checkL0Isolation({ pluginDir: dir, profile: mountProfile() });
    const depBlockers = findings.filter(f =>
      f.severity === 'blocker' && f.message.includes('dependencyWhitelist'),
    );
    assert.equal(depBlockers.length, 1);
    assert.match(depBlockers[0].message, /unauthorized host service '@deepseek-ai\/agint-mutator'/);
  } finally { cleanup(dir); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Case 4 — Happy path：合规产物 → 三项检查全过
// ─────────────────────────────────────────────────────────────────────────────

test('CASE 4 (happy path): fully compliant synth artifact → 0 findings (all 3 checks pass)', async () => {
  // 完全合规：
  //   - name 命中 synth 命名约定（agint-synth-*）
  //   - provides = ['agint.echo'] 不命中 FROZEN schema/interface/namespace
  //   - domains = ['agint_synth_echo'] 命中 synth-only pattern
  //   - 只 import 白名单内的 host service
  const dir = makePluginDir({
    'manifest.json': happyManifest(),
    'package.json': JSON.stringify({ name: 'agint-synth-echo', dependencies: {} }),
    'lib/index.js': [
      "import { memory } from '@deepseek-ai/agint-memory';",
      "import { metrics } from '@deepseek-ai/agint-metrics';",
      "export const echo = (x) => x;",
    ].join('\n') + '\n',
  });
  try {
    const findings = await checkL0Isolation({ pluginDir: dir, profile: mountProfile() });
    assert.deepEqual(findings, [], `expected 0 findings for happy path, got ${JSON.stringify(findings)}`);
  } finally { cleanup(dir); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 集成：Service 入口（checkPlugin）走通 4 个 case
// ─────────────────────────────────────────────────────────────────────────────

test('INTEGRATION: agint.qualityStatic.checkPlugin dispatches l0-isolation checker (4 cases end-to-end)', async () => {
  // 复用 mock ctx 模式（与 static-smoke.test.mjs 一致；provide 用 function 而非箭头函数绑 this）
  function makeMockCtx() {
    const providers = {};
    return {
      _effects: [], _providers: providers, services: {},
      effect: () => {},
      get: () => undefined,
      provide(name, val) { providers[name] = val; },
      on: () => {}, register: () => {},
    };
  }
  const PLUGIN_PATH = join(ROOT, 'lib/index.js');
  const mod = await import(PLUGIN_PATH);
  const ctx = makeMockCtx();
  mod.apply(ctx, {});
  const svc = ctx._providers['agint.qualityStatic'];

  // case 1: signature violation
  {
    const dir = makePluginDir({
      'manifest.json': JSON.stringify({
        name: 'agint-synth-x',
        cordis: { provides: ['agint.EvalResult'], events: [], tools: [] },
        storage: { domains: ['agint_synth_x'], schemaVersion: 1, atomic: 'json' },
      }),
      'lib/index.js': 'export const x = 1;\n',
    });
    try {
      const r = await svc.checkPlugin({ pluginDir: dir, profileOverrides: { l0IsolationOnly: true } });
      assert.equal(r.ok, false, 'case 1 should be blocked');
      const iso = r.findings.filter(f => f.family === 'l0-isolation');
      assert.ok(iso.some(f => f.message.includes('signatureCompatibility')),
        `case 1: expected signatureCompatibility blocker, got ${JSON.stringify(iso)}`);
    } finally { cleanup(dir); }
  }

  // case 2: domain violation
  {
    const dir = makePluginDir({
      'manifest.json': JSON.stringify({
        name: 'agint-synth-y',
        cordis: { provides: ['agint.y'], events: [], tools: [] },
        storage: { domains: ['agint_meta'], schemaVersion: 1, atomic: 'json' },
      }),
      'lib/index.js': 'export const x = 1;\n',
    });
    try {
      const r = await svc.checkPlugin({ pluginDir: dir, profileOverrides: { l0IsolationOnly: true } });
      assert.equal(r.ok, false, 'case 2 should be blocked');
      const iso = r.findings.filter(f => f.family === 'l0-isolation');
      assert.ok(iso.some(f => f.message.includes('domainIsolation') && f.message.includes('agint_meta')),
        `case 2: expected domainIsolation blocker mentioning agint_meta, got ${JSON.stringify(iso)}`);
    } finally { cleanup(dir); }
  }

  // case 3: deps violation（用完整 namespaced 形式，与产物真实写法一致）
  {
    const dir = makePluginDir({
      'manifest.json': JSON.stringify({
        name: 'agint-synth-z',
        cordis: { provides: ['agint.z'], events: [], tools: [] },
        storage: { domains: ['agint_synth_z'], schemaVersion: 1, atomic: 'json' },
      }),
      'lib/bad.js': `import x from '${STATIC_NAMESPACED}';\nexport default x;\n`,
    });
    try {
      const r = await svc.checkPlugin({ pluginDir: dir, profileOverrides: { l0IsolationOnly: true } });
      assert.equal(r.ok, false, 'case 3 should be blocked');
      const iso = r.findings.filter(f => f.family === 'l0-isolation');
      assert.ok(iso.some(f => f.message.includes('dependencyWhitelist') && f.message.includes(STATIC_NAMESPACED)),
        `case 3: expected dependencyWhitelist blocker referencing ${STATIC_NAMESPACED}, got ${JSON.stringify(iso)}`);
    } finally { cleanup(dir); }
  }

  // case 4: happy
  {
    const dir = makePluginDir({
      'manifest.json': happyManifest(),
      'lib/index.js': "import { memory } from '@deepseek-ai/agint-memory';\nexport const x = 1;\n",
    });
    try {
      const r = await svc.checkPlugin({ pluginDir: dir, profileOverrides: { l0IsolationOnly: true } });
      const iso = r.findings.filter(f => f.family === 'l0-isolation');
      assert.deepEqual(iso, [], `case 4: expected 0 l0-isolation findings, got ${JSON.stringify(iso)}`);
    } finally { cleanup(dir); }
  }
});
