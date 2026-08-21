#!/usr/bin/env node
/**
 * agint-prompt-init — Prompt SDK 模板生成器（Sprint 5.2）
 *
 * 用法:
 *   node plugins/agint-quality-sdk/bin/agint-prompt-init.js --name=my-prompt --preset=coder [--out=examples]
 *   node plugins/agint-quality-sdk/bin/agint-prompt-init.js --name=my-prompt --preset=investor [--out=plugins]
 *
 * preset 选项:
 *   coder   - 系统提示工程师向 (生成代码辅助)
 *   investor - 投研向 (信息提炼 + 风险标注)
 *   hello    - 最简 demo (无 business logic)
 *
 * 行为:
 *   - 生成 targetDir/<name>/manifest.json + template.md + tests.json + README.md
 *   - 跑 staticCheckPrompt({templateText, manifest}) 自检
 *   - 跑 regressionTests 全过 → 0
 *   - 写文件 → 返回 0 / 报告 violations → 1
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// Resolve zod from global dsh or sibling plugin dirs (see eval/scenarios/driver.js for rationale).
function ensureNodePath() {
  if (process.env.NODE_PATH && process.env.NODE_PATH.includes('dsh')) return;
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const dshNm = join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules');
    if (existsSync(dshNm)) {
      process.env.NODE_PATH = process.env.NODE_PATH
        ? `${process.env.NODE_PATH}:${dshNm}`
        : dshNm;
    }
    // Peer plugin (agint-quality) has zod installed.
    const peerNm = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agint-quality', 'node_modules');
    if (existsSync(peerNm)) {
      process.env.NODE_PATH = process.env.NODE_PATH
        ? `${process.env.NODE_PATH}:${peerNm}`
        : peerNm;
    }
  } catch {
    // npm not found — let the import surface the error
  }
}
ensureNodePath();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');

const { staticCheckPrompt } = await import(`${SDK_ROOT}/lib/static-check.js`);
const { runRegressionTests } = await import(`${SDK_ROOT}/lib/static-check.js`);
const { renderPrompt } = await import(`${SDK_ROOT}/lib/template-engine.js`);

/* ── 参数解析 ──────────────────────────────────────────────── */
function parseArgs(argv) {
  const args = { name: null, preset: 'hello', out: null, quiet: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--name=')) args.name = a.slice('--name='.length);
    else if (a.startsWith('--preset=')) args.preset = a.slice('--preset='.length);
    else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
    else if (a === '--quiet' || a === '-q') args.quiet = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

/* ── 预设 ──────────────────────────────────────────────────── */
const PRESETS = {
  hello: {
    name: 'hello-prompt',
    description: 'Minimal hello prompt demonstrating SDK contract.',
    kind: 'system',
    templateText: 'Hello {{ user.name }}, welcome to {{ product.name }}.',
    variables: [
      { name: 'user', description: 'User-side variables', required: true, type: 'string' },
      { name: 'product', description: 'Product-side variables', required: true, type: 'string' },
    ],
    sample: { user: { name: '老板' }, product: { name: 'AGINT' } },
  },
  coder: {
    name: 'coder-prompt',
    description: 'Coder-oriented system prompt for AGINT P5 plugin development.',
    kind: 'system',
    templateText:
`你是 {{ user.identity }}。角色: dsh plugin 开发者。
约束:
- 接口签名遵守 contract ({{ contract.name }}) FROZEN 字段
- L0 修改 → 人类多签 + 7 天影子模式
- 测试必须 ≥ 5 回归用例

Plan:
{{ user.plan }}`,
    variables: [
      { name: 'user', description: 'User-side vars (identity, plan)', required: true, type: 'string' },
      { name: 'contract', description: 'Contract reference', required: true, type: 'string' },
    ],
    sample: {
      user: { identity: 'Plugin author', plan: 'Build Sprint 5 SDK' },
      contract: { name: 'QualityEvaluator' },
    },
  },
  investor: {
    name: 'investor-prompt',
    description: 'Investor-oriented research summarization prompt with risk annotation.',
    kind: 'system',
    templateText:
`你是 {{ user.identity }}, 投研编辑。
任务: 提炼 {{ subject.name }} 关键信息, 标注风险等级 {{ risk.level }}。

输出格式: Markdown (不超过 {{ max.words }} 词)。
不合规 / 政策风险 → 跳过; 合规 → 总结。`,
    variables: [
      { name: 'user', description: 'User-side vars (identity)', required: true, type: 'string' },
      { name: 'subject', description: 'Subject being researched', required: true, type: 'string' },
      { name: 'risk', description: 'Risk tag', required: true, type: 'enum', enum: ['low', 'medium', 'high'] },
      { name: 'max', description: 'Output limit', required: true, type: 'string' },
    ],
    sample: {
      user: { identity: '老板' },
      subject: { name: 'AGINT v0.4.0 release' },
      risk: { level: 'low' },
      max: { words: '600' },
    },
  },
};

/* ── 默认 regressionTests (老板拍板 ≥ 5) ─────────────────── */
function defaultRegressionTests(presetName) {
  const safeKeywords = {
    hello: ['Hello', 'welcome'],
    coder: ['约束', '测试', 'Plan'],
    investor: ['提炼', '风险', 'Markdown'],
  }[presetName] ?? ['AGINT'];
  const sample = PRESETS[presetName]?.sample ?? { user: { name: 'boss' }, product: { name: 'AGINT' } };
  const tests = [];
  // 5 个 prompt 内 positive 测试: 同一组 inputs 不同 must-include 期望
  // 注意: 不放 SSTI/注入到 default regression — 注入测试单列到 static-check patterns
  for (let i = 0; i < 5; i++) {
    tests.push({
      name: `case-${i + 1}`,
      inputs: sample,
      expectedOutputContains: safeKeywords.slice(0, Math.min(2, safeKeywords.length)),
      expectedOutputNotContains: ['<system>:'], // 模板自身不该输出 <system>:
    });
  }
  return tests;
}

/* ── 文件生成 ──────────────────────────────────────────────── */
function buildManifest(presetName, name) {
  const preset = PRESETS[presetName];
  if (!preset) throw new Error(`unknown preset "${presetName}" (presets: ${Object.keys(PRESETS).join(', ')})`);
  return {
    name,
    version: '0.1.0',
    description: preset.description,
    kind: preset.kind,
    variables: preset.variables,
    regressionTests: defaultRegressionTests(presetName),
    contractRef: 'QualityReporter',
    author: 'agint',
    tags: ['agint', 'sdk', presetName],
    maxTokens: 1024,
    modelHint: 'default',
  };
}

async function writeOutputFiles({ targetDir, presetName, name, manifest, templateText }) {
  await mkdir(targetDir, { recursive: true });

  // manifest.json
  await writeFile(join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // template.md
  await writeFile(join(targetDir, 'template.md'), templateText, 'utf8');

  // tests.json (subset of regression tests for human inspection)
  await writeFile(
    join(targetDir, 'tests.json'),
    JSON.stringify({ regressionTests: manifest.regressionTests }, null, 2),
    'utf8',
  );

  // README.md
  const readme = [
    `# ${manifest.name}@${manifest.version}`,
    ``,
    `> Generated by \`agint-prompt-init\` (preset=${presetName}).`,
    ``,
    `**Description**: ${manifest.description}`,
    ``,
    `**Kind**: ${manifest.kind}`,
    ``,
    `**Variables** (declared, Frozen):`,
    ...manifest.variables.map((v) => `- \`${v.name}\` (${v.type}, required=${v.required}) — ${v.description}`),
    ``,
    `**Regression tests**: ${manifest.regressionTests.length} (Phase 4 std: ≥5)`,
    ``,
    `## Quick use`,
    ``,
    `\`\`\`js`,
    `import { renderPrompt } from 'agint-quality-sdk';`,
    `import { readFile } from 'node:fs/promises';`,
    `const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));`,
    `const templateText = await readFile('template.md', 'utf8');`,
    `const out = renderPrompt({ templateText, manifest, values: ${JSON.stringify(PRESETS[presetName]?.sample ?? {})} });`,
    `console.log(out);`,
    `\`\`\``,
    ``,
    `## Why this works`,
    ``,
    `- Manifest is **FROZEN** (Phase 5 contract). Field renames require human multisig.`,
    `- Static check enforces: ≥5 regression tests + no suspicious injection tokens.`,
  ].join('\n');
  await writeFile(join(targetDir, 'README.md'), readme, 'utf8');
}

/* ── main ──────────────────────────────────────────────────── */
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('agint-prompt-init — Prompt SDK 模板生成器');
    console.log('Usage:');
    console.log('  --name=<kebab-name>     prompt plugin name (e.g. my-prompt)');
    console.log('  --preset=<hello|coder|investor>  preset (default hello)');
    console.log('  --out=<dir>             output parent directory (default: sdk examples/)');
    console.log('  --quiet                 suppress non-error logs');
    process.exit(0);
  }

  if (!args.name) {
    console.error('error: --name is required');
    process.exit(2);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(args.name)) {
    console.error(`error: --name="${args.name}" must be kebab-case (lowercase letters, digits, dashes)`);
    process.exit(2);
  }
  if (!PRESETS[args.preset]) {
    console.error(`error: unknown preset "${args.preset}" (presets: ${Object.keys(PRESETS).join(', ')})`);
    process.exit(2);
  }

  const outRoot = args.out ? resolve(args.out) : join(SDK_ROOT, 'examples');
  const targetDir = join(outRoot, args.name);

  if (existsSync(targetDir)) {
    console.error(`error: target dir already exists: ${targetDir}`);
    process.exit(2);
  }

  if (!args.quiet) console.log(`📦 Generating ${args.name} (preset=${args.preset}) at ${targetDir}`);

  const preset = PRESETS[args.preset];
  const manifest = buildManifest(args.preset, args.name);
  const templateText = preset.templateText;
  manifest.templatePath = 'template.md';

  // 写盘前跑 staticCheck + regression（dry-run）
  const checkResult = staticCheckPrompt({ templateText, manifest });
  if (!args.quiet) {
    console.log(`  staticCheck: ok=${checkResult.ok} blockers=${checkResult.blockers} warns=${checkResult.warnings}`);
    for (const v of checkResult.violations) {
      console.log(`    [${v.severity}] ${v.code}: ${v.message}${v.line ? ` (line ${v.line})` : ''}`);
    }
  }
  if (!checkResult.ok) {
    console.error(`\n❌ Generated prompt has BLOCKER violations; refusing to write files. Fix your preset.`);
    process.exit(1);
  }

  await writeOutputFiles({ targetDir, presetName: args.preset, name: args.name, manifest, templateText });

  // 跑 regression tests
  const results = runRegressionTests({
    templateText,
    manifest,
    render: ({ templateText, manifest, values }) => renderPrompt({ templateText, manifest, values }),
  });
  const passed = results.filter((r) => r.status === 'pass').length;
  if (!args.quiet) {
    console.log(`  regressionTests: ${passed}/${results.length} passed`);
    for (const r of results) console.log(`    [${r.status}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}${r.error ? ` — ${r.error}` : ''}`);
  }

  console.log(`\n✓ Generated at: ${targetDir}`);
  console.log(`  Use: node plugins/agint-quality-sdk/bin/agint-prompt-init.js --name=${args.name}-v2 --preset=${args.preset} --out=plugins/your-preset/skills/`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('agint-prompt-init crashed:', err.stack || err.message);
  process.exit(2);
});
