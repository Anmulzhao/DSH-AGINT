/**
 * 测试用 fixture：造一个最小插件目录树，覆盖档案层的四种身份形态。
 *
 * 形态来源是**生产里真实存在的四种**（不是编的）：
 *   ① 正常：manifest + package + CHANGELOG + lib
 *   ② 只有 package：agint-quality 家族的嵌套子包形态
 *   ③ 只有代码：agint-session-source 形态（连 package.json 都没有）
 *   ④ 壳 + 真身：plugins/agint-quality-eval（无 lib、0.1.0）与
 *      plugins/agint-quality/agint-quality-eval（有 lib、0.2.0）并存
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MANIFEST = (over) => JSON.stringify({
  name: over.name,
  version: over.version,
  description: over.description ?? `${over.name} 的一句话职责。第二句不该出现在首句里。`,
  main: 'lib/index.js',
  agint: { kind: 'host', tier: 1, stability: 'alpha', owner: 'anmul' },
  spec: {
    cordis: {
      inject: ['webServer'],
      optionalInject: over.optionalInject ?? [],
      provides: over.provides ?? [],
      consumes: over.consumes ?? [],
      events: [],
      tools: [],
    },
    storage: { domains: over.domains ?? [], schemaVersion: 1 },
    dependencies: {},
    mountOrder: over.mountOrder ?? 10,
    permissions: { env: ['DSH_HOME'], fs: ['read:storages'], network: [], shell: over.shell ?? [] },
    lifecycle: { intervals: 'none', listeners: 'none', tools: 'none', shutdown: 'graceful' },
    tests: { command: 'node test/smoke.mjs' },
    docs: { serviceDocs: over.serviceDocs ?? {} },
    changelog: 'CHANGELOG.md',
    compatSince: '0.1.0',
  },
}, null, 2);

const CHANGELOG = `# Changelog — demo

## 0.2.0 — 2026-10-22

### 新增
- 第二版

## 0.1.0 (2026-10-01) — 初版

- 第一版
`;

function writePlugin(root, name, files) {
  const dir = join(root, name);
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
}

export function makeDossierFixture() {
  const root = mkdtempSync(join(tmpdir(), 'agint-dossier-'));

  // ① 正常
  writePlugin(root, 'agint-normal', {
    'manifest.json': MANIFEST({
      name: 'agint-normal', version: '0.2.0',
      provides: ['agint.a', 'agint.a.sub'],
      serviceDocs: { 'agint.a': '服务 A 的自述' },
      consumes: ['agint.b', 'agint.neverUsed'],
      optionalInject: ['agint.opt'],
      domains: ['agint_a'],
    }),
    'package.json': JSON.stringify({ name: 'agint-normal', version: '0.2.0' }),
    'CHANGELOG.md': CHANGELOG,
    'README.md': '# normal\n',
    'lib/index.js': "export const a = 1;\nctx.get('agint.b');\nctx.provide('agint.a', {});\n// ctx.get('agint.a')\n",
    'lib/extra.js': 'export const b = 2;\n',
    'test/smoke.mjs': '// 不应计入代码体量\n',
  });

  // ② 只有 package（版本与 manifest 无关，此例就没有 manifest）
  writePlugin(root, 'agint-pkg-only', {
    'package.json': JSON.stringify({ name: 'agint-pkg-only', version: '0.3.0', description: '只有身份，没有契约。' }),
    'lib/index.js': 'export const x = 1;\n',
  });

  // ③ 只有代码
  writePlugin(root, 'agint-code-only', {
    'lib/index.js': 'export const y = 2;\n',
  });

  // ④ 壳（无 lib、0.1.0）+ 嵌套真身（有 lib、0.2.0）
  writePlugin(root, 'agint-shell', {
    'manifest.json': MANIFEST({ name: 'agint-shell', version: '0.1.0', provides: ['agint.s'] }),
    'package.json': JSON.stringify({ name: 'agint-shell', version: '0.1.0' }),
    'CHANGELOG.md': CHANGELOG,
    'README.md': '# shell\n',
  });
  writePlugin(root, 'agint-container', {
    'package.json': JSON.stringify({ name: 'agint-container', version: '0.0.1' }),
    'agint-shell/manifest.json': MANIFEST({ name: 'agint-shell', version: '0.2.0', provides: ['agint.s', 'agint.s.two'] }),
    'agint-shell/package.json': JSON.stringify({ name: 'agint-shell', version: '0.2.0' }),
    'agint-shell/CHANGELOG.md': CHANGELOG,
    'agint-shell/README.md': '# real\n',
    'agint-shell/lib/index.js': 'ctx.provide("agint.s", {});\nctx.provide("agint.s.two", {});\n',
  });

  return root;
}
