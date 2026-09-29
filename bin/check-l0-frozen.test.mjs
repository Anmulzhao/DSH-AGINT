// bin/check-l0-frozen.test.mjs — L0 FROZEN 变更检测的测试
//
// 这条护栏本身是「没人实现过的东西」（AGENTS.md 与 evolution-framework.md §8.2 都写
// 「CI 自动失败检测」，实测 bin/ 下 24 脚本 grep FROZEN 零命中、.github/workflows 不存在）。
// **护栏的护栏**是它自己的测试：一条从不报错的检测器比没有检测器更危险 ——
// 它会让人以为 L0 有人看着。
//
// 因此本文件的核心不是「跑通了」，而是**证明它该红时真的会红**。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Windows 上绝对路径必须转 file:// URL 才能被 ESM loader 接受
const { extractFrozenUnits, check, updateBaseline, CONTRACT_PATH, BASELINE_PATH } =
  await import(pathToFileURL(join(__dirname, 'check-l0-frozen.mjs')).href);

const REAL_CONTRACT = readFileSync(join(__dirname, '..', ...CONTRACT_PATH.split('/')), 'utf8');

/** 造一个临时 repo：contract 源 + 可选基线 */
function makeRepo(contractSrc, { withBaseline = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'l0test-'));
  const c = join(root, ...CONTRACT_PATH.split('/'));
  mkdirSync(dirname(c), { recursive: true });
  writeFileSync(c, contractSrc, 'utf8');
  if (withBaseline) updateBaseline({ repoRoot: root });
  return root;
}

function cleanup(root) { rmSync(root, { recursive: true, force: true }); }

// ── 提取层 ────────────────────────────────────────────────────────────────
test('提取层：真实契约的单元数必须等于源码里 @frozen 的出现次数', () => {
  const units = extractFrozenUnits(REAL_CONTRACT);
  const markers = (REAL_CONTRACT.match(/@frozen/g) || []).length;
  assert.equal(Object.keys(units).length, markers,
    `漏提取了：@frozen 标记 ${markers} 处，提取到 ${Object.keys(units).length} 个单元`);
});

test('提取层：A 尾随形态与 B 对象内部形态都要能定位到正确的声明', () => {
  const units = extractFrozenUnits(REAL_CONTRACT);
  // A 形态（标记紧跟在声明之后）
  for (const n of ['EvalTargetSchema', 'HARMSchema', 'DimensionScoreSchema',
    'EvalResultSchema', 'DecisionKindSchema', 'DecisionSchema', 'DreamPhaseSchema']) {
    assert.ok(units[n], `A 形态单元 ${n} 未提取到`);
    assert.ok(units[n].hash.length === 16);
  }
  // B 形态（标记在对象字面量首行）
  for (const n of ['QualityEvaluatorIface', 'QualityPolicyIface',
    'QualityReporterIface', 'QualityLifecycleIface']) {
    assert.ok(units[n], `B 形态单元 ${n} 未提取到`);
  }
});

// ── 正向：不该报红的不得报红（误报是这类工具的头号死法）────────────────────
test('无变更时必须 PASS', () => {
  const root = makeRepo(REAL_CONTRACT);
  try { assert.equal(check({ repoRoot: root }).ok, true); }
  finally { cleanup(root); }
});

test('改注释不得报红（注释不是契约）', () => {
  const root = makeRepo(REAL_CONTRACT);
  try {
    const p = join(root, ...CONTRACT_PATH.split('/'));
    writeFileSync(p, REAL_CONTRACT.replace(
      'export const DecisionKindSchema',
      '// 决策枚举（这段注释是测试加的，不该触发 L0 告警）\nexport const DecisionKindSchema',
    ), 'utf8');
    assert.equal(check({ repoRoot: root }).ok, true, '改注释被误判成 L0 变更');
  } finally { cleanup(root); }
});

test('改缩进/换行不得报红（格式化不是契约）', () => {
  const root = makeRepo(REAL_CONTRACT);
  try {
    const p = join(root, ...CONTRACT_PATH.split('/'));
    const reformatted = REAL_CONTRACT
      .replace("  homogeneity: z.number().min(0).max(1),",
        "    homogeneity:   z.number().min(0).max(1),");
    writeFileSync(p, reformatted, 'utf8');
    assert.equal(check({ repoRoot: root }).ok, true, '纯格式化被误判成 L0 变更');
  } finally { cleanup(root); }
});

// ── 负向：该报红的必须报红（本文件的核心）─────────────────────────────────
test('改 FROZEN 枚举值必须报红', () => {
  const root = makeRepo(REAL_CONTRACT);
  try {
    const p = join(root, ...CONTRACT_PATH.split('/'));
    writeFileSync(p, REAL_CONTRACT.replace("'PENDING_REVIEW',", "'PENDING_HUMAN_REVIEW',"), 'utf8');
    const r = check({ repoRoot: root });
    assert.equal(r.ok, false, '改了决策枚举居然没报红 —— 这条护栏失效了');
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].kind, 'modified');
    assert.equal(r.violations[0].name, 'DecisionKindSchema');
  } finally { cleanup(root); }
});

test('给 FROZEN schema 加字段必须报红', () => {
  const root = makeRepo(REAL_CONTRACT);
  try {
    const p = join(root, ...CONTRACT_PATH.split('/'));
    writeFileSync(p, REAL_CONTRACT.replace(
      "  tags: z.array(z.string()).default([]),\n}).strict();",
      "  tags: z.array(z.string()).default([]),\n  sneakyNewField: z.boolean().optional(),\n}).strict();",
    ), 'utf8');
    const r = check({ repoRoot: root });
    assert.equal(r.ok, false, '给 .strict() schema 加字段居然没报红');
    assert.equal(r.violations[0].name, 'EvalTargetSchema');
  } finally { cleanup(root); }
});

test('改 FROZEN 接口方法签名必须报红', () => {
  const root = makeRepo(REAL_CONTRACT);
  try {
    const p = join(root, ...CONTRACT_PATH.split('/'));
    writeFileSync(p, REAL_CONTRACT.replace(
      "methods: ['evaluate(target: EvalTarget): Promise<EvalResult>'],",
      "methods: ['evaluate(target: EvalTarget, opts: any): Promise<EvalResult>'],",
    ), 'utf8');
    const r = check({ repoRoot: root });
    assert.equal(r.ok, false, '改接口签名居然没报红 —— 正是 L0 最该拦的那类');
    assert.equal(r.violations[0].name, 'QualityEvaluatorIface');
  } finally { cleanup(root); }
});

test('删掉一个 FROZEN 单元必须报红（removed）', () => {
  const root = makeRepo(REAL_CONTRACT);
  try {
    const p = join(root, ...CONTRACT_PATH.split('/'));
    // 整块删掉 DreamPhaseSchema（声明 + 其后的标记行）
    const src = REAL_CONTRACT.replace(
      /\/\*\* 梦境阶段枚举（来自 agint-dream） \*\/\nexport const DreamPhaseSchema = z\.enum\(\[[^\]]*\]\);\n\/\*\* @frozen \*\/\n/,
      '');
    assert.notEqual(src, REAL_CONTRACT, '测试前提失败：没删掉任何东西');
    writeFileSync(p, src, 'utf8');
    const r = check({ repoRoot: root });
    assert.equal(r.ok, false, '删掉 FROZEN 单元居然没报红');
    assert.equal(r.violations[0].kind, 'removed');
    assert.equal(r.violations[0].name, 'DreamPhaseSchema');
  } finally { cleanup(root); }
});

test('新增一个 FROZEN 单元必须报红（added）—— 防止「新契约悄悄进来」', () => {
  const root = makeRepo(REAL_CONTRACT);
  try {
    const p = join(root, ...CONTRACT_PATH.split('/'));
    writeFileSync(p, REAL_CONTRACT + "\nexport const BrandNewContract = z.object({ a: z.string() }).strict();\n/** @frozen */\n", 'utf8');
    const r = check({ repoRoot: root });
    assert.equal(r.ok, false, '新增 FROZEN 单元居然没报红');
    assert.equal(r.violations[0].kind, 'added');
    assert.equal(r.violations[0].name, 'BrandNewContract');
  } finally { cleanup(root); }
});

test('改 ADJUSTABLE 层不得报红（只有 FROZEN 受保护）', () => {
  const root = makeRepo(REAL_CONTRACT);
  try {
    const p = join(root, ...CONTRACT_PATH.split('/'));
    // QualityConfigSchema 属于 ADJUSTABLE 层（文件 :131 之后），不在任何 @frozen 单元里
    const src = REAL_CONTRACT.replace(
      'export const QualityConfigSchema = z.object({',
      'export const QualityConfigSchema = z.object({ extraKnob: z.number().default(1),');
    assert.notEqual(src, REAL_CONTRACT, '测试前提失败：没改到 ADJUSTABLE 层');
    writeFileSync(p, src, 'utf8');
    const r = check({ repoRoot: root });
    assert.equal(r.ok, true, 'ADJUSTABLE 层被改不该触发 L0 门禁（policy 就可以调它）');
  } finally { cleanup(root); }
});

// ── 缺基线时的行为 ────────────────────────────────────────────────────────
test('基线不存在时报错而不是静默 PASS', () => {
  const root = makeRepo(REAL_CONTRACT, { withBaseline: false });
  try {
    const r = check({ repoRoot: root });
    assert.equal(r.ok, false, '没有基线时若返回 ok=true，等于门禁默认敞开');
    assert.match(r.error, /基线不存在/);
  } finally { cleanup(root); }
});

test('--update 能建立基线，随后 check 即通过', () => {
  const root = makeRepo(REAL_CONTRACT, { withBaseline: false });
  try {
    const r = updateBaseline({ repoRoot: root });
    assert.equal(r.count, 11);
    assert.equal(check({ repoRoot: root }).ok, true);
  } finally { cleanup(root); }
});
