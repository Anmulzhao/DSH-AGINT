/**
 * agint-upstream-watch v0.3 — 判读质量仪器（校准）单测。
 *
 * 这一组测试守的是**最有价值也最容易做歪**的东西：判读器对自己的判断负责。
 * 三个方向都必须钉住：
 *   1. 该判「成立」的判成立（`confirmed`）
 *   2. 该判「误报」的判误报（`false-positive`：当时说符号被删，其实还在）
 *   3. 该判「漏报」的判漏报（`false-negative`：当时说没风险，其实符号没了）
 * ⛔ 只钉 1、2 会让判读器学成「全都报 breaking」；只钉 3 会让它学成「什么都不报」。
 *
 * 全部离线：安装树用临时目录夹具，不碰本机 dsh。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildPrediction, findBackfillTargets, evaluateOutcome, summarizeCalibration, calibrationForQuality,
} from '../lib/calibration.js';
import { resolveAgintRoot } from '../lib/depface.js';

/** 造一棵假安装树：DSH_ROOT 指向主包目录，依赖包在它的 node_modules 下。 */
function fakeInstall({ dshVersion = '0.2.2-alpha.2', pkgs = {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'upw-cal-'));
  const root = join(base, 'dsh');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: dshVersion }));
  for (const [name, spec] of Object.entries(pkgs)) {
    const dir = join(root, 'node_modules', ...name.split('/'));
    mkdirSync(join(dir, 'lib', 'types'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: spec.version ?? dshVersion }));
    if (spec.dts !== null) {
      writeFileSync(join(dir, 'lib', 'types', 'index.d.ts'), spec.dts ?? '');
    }
  }
  return { root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const factsOf = (over = {}) => ({
  tag: 'dsh-v0.2.2-alpha.2',
  targetVersion: '0.2.2-alpha.2',
  installedVersion: '0.2.1-rc.3',
  depFace: [
    {
      pkg: '@deepseek-ai/dsh-tools', from: '0.2.1-rc.3', to: '0.2.2-alpha.2',
      usedCount: 2, usedNames: ['defineTool', 'ToolDefinition'],
      usedImpact: 'elsewhere', verdict: 'breaking', overallImpact: 'elsewhere',
    },
    {
      pkg: '@deepseek-ai/dsh-storage-domain', from: '0.2.1-rc.3', to: '0.2.2-alpha.2',
      usedCount: 2, usedNames: ['defineDomain', 'domainTable'],
      usedImpact: 'additive', verdict: 'additive', overallImpact: 'additive',
    },
  ],
  hostFace: { from: '0.2.1-rc.3', to: '0.2.2-alpha.2', overallImpact: 'none', semanticImpact: 'warn', semanticDeltas: [{ kind: 'engine-raised', severity: 'warn' }] },
  ...over,
});

// ── 1. 预测清单 ──
test('buildPrediction 只收有使用面的包，并留下符号名', () => {
  const p = buildPrediction(factsOf());
  assert.equal(p.packages.length, 2);
  assert.deepEqual(p.packages[0].usedNames, ['defineTool', 'ToolDefinition']);
  assert.equal(p.installedAtPredict, '0.2.1-rc.3');
  assert.equal(p.host.engineRaised, true);
  assert.equal(p.host.blocking, false);
  // ⛔ 阴性对照：usedCount=0 的包不进清单（没有符号可对拍）
  const p2 = buildPrediction(factsOf({ depFace: [{ pkg: 'x', usedCount: 0, usedNames: [], usedImpact: 'none' }] }));
  assert.equal(p2.packages.length, 0);
});

test('buildPrediction 对空 facts 不炸（阴性对照）', () => {
  const p = buildPrediction(undefined);
  assert.deepEqual(p.packages, []);
  assert.equal(p.targetVersion, null);
});

// ── 2. 回填时机 ──
test('findBackfillTargets 只在「已装版本精确等于该判读目标」时命中', () => {
  const digests = [
    { tag: 'dsh-v0.2.2-alpha.2', targetVersion: '0.2.2-alpha.2' },
    { tag: 'dsh-v0.3.0', targetVersion: '0.3.0' },
  ];
  const hit = findBackfillTargets('0.2.2-alpha.2', digests);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].tag, 'dsh-v0.2.2-alpha.2');
  // ⛔ 阴性对照：装了更新的版本时，不该拿旧预测去对拍
  assert.equal(findBackfillTargets('0.3.0', digests).length, 1);
  assert.equal(findBackfillTargets('0.2.1-rc.3', digests).length, 0);
  // 已回填的跳过
  assert.equal(findBackfillTargets('0.2.2-alpha.2', digests, new Set(['dsh-v0.2.2-alpha.2'])).length, 0);
});

// ── 3. 对拍四分支 ──
test('漏报：当时判 additive，升级后 AGINT 用到的符号没了', () => {
  const inst = fakeInstall({
    pkgs: {
      '@deepseek-ai/dsh-tools': { dts: 'export declare function defineTool(): void;' }, // ToolDefinition 没了
    },
  });
  try {
    const pred = buildPrediction(factsOf({ depFace: [{
      pkg: '@deepseek-ai/dsh-tools', from: '0.2.1-rc.3', to: '0.2.2-alpha.2',
      usedCount: 2, usedNames: ['defineTool', 'ToolDefinition'], usedImpact: 'additive',
    }] }));
    const o = evaluateOutcome({ prediction: pred, installedVersion: '0.2.2-alpha.2', repoRoot: inst.root, env: { DSH_ROOT: inst.root } });
    assert.equal(o.status, 'ok');
    assert.equal(o.falseNegative, 1, '符号没了 = 漏报');
    assert.equal(o.perPackage[0].verdict, 'false-negative');
    assert.deepEqual(o.perPackage[0].missingUsed, ['ToolDefinition']);
    assert.match(o.perPackage[0].note, /漏报/);
  } finally { inst.cleanup(); }
});

test('误报：当时判 breaking，升级后符号其实都还在', () => {
  const inst = fakeInstall({
    pkgs: {
      '@deepseek-ai/dsh-tools': { dts: 'export declare function defineTool(): void;\nexport declare interface ToolDefinition {}' },
    },
  });
  try {
    const pred = buildPrediction(factsOf({ depFace: [{
      pkg: '@deepseek-ai/dsh-tools', from: '0.2.1-rc.3', to: '0.2.2-alpha.2',
      usedCount: 2, usedNames: ['defineTool', 'ToolDefinition'], usedImpact: 'breaking',
    }] }));
    const o = evaluateOutcome({ prediction: pred, installedVersion: '0.2.2-alpha.2', repoRoot: inst.root, env: { DSH_ROOT: inst.root } });
    assert.equal(o.falsePositive, 1, '说删了但还在 = 误报');
    assert.equal(o.perPackage[0].verdict, 'false-positive');
    assert.match(o.perPackage[0].note, /误报/);
  } finally { inst.cleanup(); }
});

test('成立：当时判 breaking，升级后符号确实不在', () => {
  const inst = fakeInstall({
    pkgs: { '@deepseek-ai/dsh-tools': { dts: 'export declare function other(): void;' } },
  });
  try {
    const pred = buildPrediction(factsOf({ depFace: [{
      pkg: '@deepseek-ai/dsh-tools', from: '0.2.1-rc.3', to: '0.2.2-alpha.2',
      usedCount: 1, usedNames: ['defineTool'], usedImpact: 'breaking',
    }] }));
    const o = evaluateOutcome({ prediction: pred, installedVersion: '0.2.2-alpha.2', repoRoot: inst.root, env: { DSH_ROOT: inst.root } });
    assert.equal(o.confirmed, 1);
    assert.equal(o.perPackage[0].verdict, 'confirmed');
  } finally { inst.cleanup(); }
});

test('成立：当时判 elsewhere，升级后符号都在（阴性对照的另一半）', () => {
  const inst = fakeInstall({
    pkgs: { '@deepseek-ai/dsh-tools': { dts: 'export declare function defineTool(): void;' } },
  });
  try {
    const pred = buildPrediction(factsOf({ depFace: [{
      pkg: '@deepseek-ai/dsh-tools', from: '0.2.1-rc.3', to: '0.2.2-alpha.2',
      usedCount: 1, usedNames: ['defineTool'], usedImpact: 'elsewhere',
    }] }));
    const o = evaluateOutcome({ prediction: pred, installedVersion: '0.2.2-alpha.2', repoRoot: inst.root, env: { DSH_ROOT: inst.root } });
    assert.equal(o.confirmed, 1);
    assert.equal(o.falseNegative, 0);
    assert.equal(o.falsePositive, 0);
  } finally { inst.cleanup(); }
});

// ── 4. 不下结论的三种情形 ──
test('版本不匹配 ⇒ unknown，不当成「预测正确」', () => {
  const inst = fakeInstall({ pkgs: { '@deepseek-ai/dsh-tools': { dts: 'export declare function defineTool(): void;' } } });
  try {
    const pred = buildPrediction(factsOf());
    const o = evaluateOutcome({ prediction: pred, installedVersion: '0.3.0', repoRoot: inst.root, env: { DSH_ROOT: inst.root } });
    assert.equal(o.status, 'unknown');
    assert.equal(o.confirmed, 0);
    assert.match(o.reason, /口径不同/);
  } finally { inst.cleanup(); }
});

test('找不到安装位置 ⇒ 记为不可判，不算通过', () => {
  const inst = fakeInstall({ pkgs: {} }); // 空树
  try {
    // ⛔ 包名必须**本机绝不存在**：早先这里用的是 dsh-tools + 空夹具，
    //    在仓库位跑能通过（祖先链没有 dsh 包），在部署位跑就失败 ——
    //    `createRequire(自身路径)` 会解析到 `.agint-bundle/node_modules` 里真实的 dsh-tools。
    //    测试不该依赖"运行在哪个目录"。
    const pred = buildPrediction(factsOf({ depFace: [{
      pkg: '@deepseek-ai/definitely-not-installed-pkg', from: '0.2.1-rc.3', to: '0.2.2-alpha.2',
      usedCount: 1, usedNames: ['defineTool'], usedImpact: 'additive',
    }] }));
    const o = evaluateOutcome({ prediction: pred, installedVersion: '0.2.2-alpha.2', repoRoot: inst.root, env: { DSH_ROOT: inst.root } });
    assert.equal(o.unverifiable, 1);
    assert.equal(o.confirmed, 0);
    assert.equal(o.perPackage[0].verdict, 'unverifiable');
  } finally { inst.cleanup(); }
});

test('接口面为空 ⇒ 不可判（阴性对照：不是漏报）', () => {
  const inst = fakeInstall({ pkgs: { '@deepseek-ai/dsh-tools': { dts: null } } });
  try {
    const pred = buildPrediction(factsOf({ depFace: [{
      pkg: '@deepseek-ai/dsh-tools', from: '0.2.1-rc.3', to: '0.2.2-alpha.2',
      usedCount: 1, usedNames: ['defineTool'], usedImpact: 'additive',
    }] }));
    const o = evaluateOutcome({ prediction: pred, installedVersion: '0.2.2-alpha.2', repoRoot: inst.root, env: { DSH_ROOT: inst.root } });
    assert.equal(o.unverifiable, 1);
    assert.equal(o.falseNegative, 0, '没读到接口面不能算成「符号没了」');
  } finally { inst.cleanup(); }
});

test('只有动态 import（~dynamic）⇒ 不可判，不硬凑', () => {
  const inst = fakeInstall({ pkgs: { '@deepseek-ai/dsh-schedule': { dts: 'export declare function x(): void;' } } });
  try {
    const pred = buildPrediction(factsOf({ depFace: [{
      pkg: '@deepseek-ai/dsh-schedule', from: '0.2.1-rc.3', to: '0.2.2-alpha.2',
      usedCount: 1, usedNames: ['~dynamic'], usedImpact: 'additive',
    }] }));
    const o = evaluateOutcome({ prediction: pred, installedVersion: '0.2.2-alpha.2', repoRoot: inst.root, env: { DSH_ROOT: inst.root } });
    assert.equal(o.unverifiable, 1);
    assert.equal(o.confirmed, 0);
  } finally { inst.cleanup(); }
});

// ── 5. 汇总口径 ──
test('summarizeCalibration：两个比率都用「包」做分母，且分开给', () => {
  const s = summarizeCalibration({
    digests: [{ tag: 'a' }, { tag: 'b' }, { tag: 'c' }],
    outcomes: [
      { tag: 'a', falsePositive: 1, falseNegative: 0, confirmed: 3, unverifiable: 0 },
      { tag: 'b', falsePositive: 0, falseNegative: 2, confirmed: 2, unverifiable: 0 },
    ],
    installedVersion: '0.2.2-alpha.2',
  });
  assert.equal(s.packagesChecked, 8);
  assert.equal(s.falsePositiveRate, 0.125);
  assert.equal(s.falseNegativeRate, 0.25);
  assert.equal(s.pending, 1, '判过但没对拍的算 pending');
  assert.equal(s.selfEvident, true);
});

test('零样本 ⇒ 比率为 null，state=pending/empty（阴性对照：不是 0%）', () => {
  const empty = summarizeCalibration({ digests: [], outcomes: [] });
  assert.equal(empty.state, 'empty');
  assert.equal(empty.falsePositiveRate, null);
  assert.equal(empty.selfEvident, false);
  const pending = summarizeCalibration({ digests: [{ tag: 'a' }], outcomes: [] });
  assert.equal(pending.state, 'pending');
  assert.equal(pending.pending, 1);
});

// ── 6. 交给 quality-eval 的形态 ──
test('calibrationForQuality 无样本时明说 insufficient，不给分', () => {
  const q = calibrationForQuality(summarizeCalibration({}));
  assert.equal(q.available, false);
  assert.match(q.reason, /尚无/);
  assert.equal(q.metrics, null);
});

test('calibrationForQuality 有漏报时出 warn（漏报比误报严重）', () => {
  const q = calibrationForQuality(summarizeCalibration({
    digests: [{ tag: 'a' }],
    outcomes: [{ tag: 'a', falsePositive: 1, falseNegative: 2, confirmed: 5, unverifiable: 0 }],
  }));
  assert.equal(q.available, true);
  const warn = q.findings.find((f) => f.severity === 'warn');
  assert.ok(warn, '漏报必须出 warn');
  assert.match(warn.message, /漏报/);
});

// ── 7. 扫描根解析（防「依赖面恒为空」的静默假绿）──
test('resolveAgintRoot 优先 AGINT_REPO_ROOT，且校验是真根', () => {
  const r = resolveAgintRoot({ AGINT_REPO_ROOT: '/home/kylin/projects/DSH/DSH-AGINT' });
  assert.equal(r.source, 'env');
  assert.equal(r.root, '/home/kylin/projects/DSH/DSH-AGINT');
  // ⛔ 阴性对照：指到一个没有 cordis.patch.yml + plugins 的目录时不能采信
  const bad = resolveAgintRoot({ AGINT_REPO_ROOT: '/tmp' });
  assert.notEqual(bad.source, 'env');
});

test('resolveAgintRoot 能从不存在的 env 退回自路径（部署位可用）', () => {
  const r = resolveAgintRoot({});
  assert.ok(['self-path', 'home', 'cwd'].includes(r.source));
  assert.ok(r.root);
});
