/**
 * agint-dream 记忆维护（阶段 2）单测。
 *
 * 重点不是「函数能跑」，而是三条判据：
 *   ① 证据审计只判存在性，不判语义真假（断链标记，路径缺失才算）；
 *   ② 预加载 0 结果必须自解释（reason 非空），且负控制能出候选；
 *   ③ 纯函数：调用前后输入对象不变。
 *
 * 跑法：node --test test/memory-maintenance.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractEvidencePaths,
  auditMemoryEvidence,
  selectPreloadCandidates,
  summarizeDecay,
  buildMaintenanceReport,
  summarizeMaintenance,
  MAINTENANCE_DEFAULTS,
} from '../lib/memory-maintenance.js';

const NOW = Date.UTC(2026, 10, 7, 4, 0, 0);

const entry = (over = {}) => ({
  id: 'm1',
  type: 'lesson',
  content: '示例记忆',
  level: 'L1',
  confidence: 0.9,
  recalls: 0,
  resolved: false,
  evidence: 'docs/lessons/a.md',
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

test('默认门槛与报告口径', () => {
  assert.equal(MAINTENANCE_DEFAULTS.minConfidence, 0.8);
  assert.equal(MAINTENANCE_DEFAULTS.minRecalls, 3);
  assert.equal(MAINTENANCE_DEFAULTS.maxPreload, 10);
});

test('evidence 路径提取：去重、去尾标点、忽略绝对路径与通配符', () => {
  const paths = extractEvidencePaths(
    '见 docs/lessons/a.md。另见 docs/lessons/a.md 与 bin/x.mjs, 还有 D:\\DSH\\abs.md 和 docs/*.md',
  );
  assert.deepEqual(paths.sort(), ['bin/x.mjs', 'docs/lessons/a.md']);
});

test('evidence 非字符串（对象）也能提路径', () => {
  const paths = extractEvidencePaths({ note: 'see plugins/x/lib/index.js:12' });
  assert.deepEqual(paths, ['plugins/x/lib/index.js']);
});

test('⭐ 路径提取负控制：带连字符的前缀不许被截断成仓库根前缀', () => {
  // 2026-11-07 真数据踩到：agint-quality-eval/ 被截成 eval/，agent-presets/ 被截成 presets/
  const paths = extractEvidencePaths(
    'location=plugins/agint-quality/agint-quality-eval/lib/index.js line 272；'
    + '另见 agent-presets/src/index.ts:110 与 plugins/agint-quality/agint-quality-eval/lib/tools.js',
  );
  assert.deepEqual(paths.sort(), [
    'plugins/agint-quality/agint-quality-eval/lib/index.js',
    'plugins/agint-quality/agint-quality-eval/lib/tools.js',
  ]);
  assert.ok(!paths.includes('eval/lib/index.js'), '截断片段不许出现');
  assert.ok(!paths.includes('presets/src/index.ts'), '截断片段不许出现');
});

test('⭐ 扩展名负控制：.json 不许被当成 .js 截断', () => {
  const paths = extractEvidencePaths(
    'plugins/agint-self-model/package.json peerDeps；docs/wiring-exemptions.json:54-59',
  );
  assert.deepEqual(paths.sort(), [
    'docs/wiring-exemptions.json',
    'plugins/agint-self-model/package.json',
  ]);
  assert.ok(!paths.some((p) => p.endsWith('package.js')), 'package.json 不许截成 package.js');
  assert.ok(!paths.some((p) => p.endsWith('wiring-exemptions.js')), '.json 不许截成 .js');
});

test('证据审计：空证据与无路径分开计数，不合并成一个数', () => {
  const r = auditMemoryEvidence([
    entry({ id: 'a', evidence: '' }),
    entry({ id: 'b', evidence: 'tool=ask session=2026-09-03' }),
  ], { repoRoot: 'C:/repo' });
  assert.equal(r.noEvidence, 1);
  assert.equal(r.noPaths, 1);
  assert.equal(r.ok, 0);
  assert.equal(r.brokenCount, 0);
});

test('证据审计：路径全在 = ok；断一条 = broken（只标记，不改写）', () => {
  const entries = [
    entry({ id: 'ok1', evidence: 'docs/ok.md' }),
    entry({ id: 'bad1', evidence: 'docs/gone.md + bin/ok.mjs' }),
  ];
  const snapshot = JSON.stringify(entries);
  const r = auditMemoryEvidence(entries, {
    repoRoot: 'C:/repo',
    exists: (abs) => abs.replace(/\\/g, '/').endsWith('docs/ok.md') || abs.replace(/\\/g, '/').endsWith('bin/ok.mjs'),
  });
  assert.equal(r.ok, 1);
  assert.equal(r.brokenCount, 1);
  assert.equal(r.broken[0].id, 'bad1');
  assert.equal(r.broken[0].path, 'docs/gone.md');
  assert.equal(JSON.stringify(entries), snapshot, '审计不许改输入');
});

test('证据审计：没给 repoRoot ⇒ 一律 unverifiable，不假装绿', () => {
  const r = auditMemoryEvidence([entry({ evidence: 'docs/ok.md' })]);
  assert.equal(r.unverifiable, 1);
  assert.equal(r.ok, 0);
  assert.equal(r.reason, 'repo-root-missing');
});

test('证据审计：空池给 pool-empty，不返回 null', () => {
  const r = auditMemoryEvidence([], { repoRoot: 'C:/repo' });
  assert.equal(r.considered, 0);
  assert.equal(r.reason, 'pool-empty');
});

test('预加载：recalls 全 0 时返回空，且 reason 指明是「召回没在记」', () => {
  const entries = [entry({ confidence: 0.95 }), entry({ id: 'm2', confidence: 0.9 })];
  const r = selectPreloadCandidates(entries);
  assert.equal(r.picked, 0);
  assert.equal(r.recallsAllZero, true);
  assert.match(r.reason, /recalls-all-zero/);
  assert.equal(r.nearest.missingRecalls, 3);
  assert.equal(r.nearest.missingConfidence, 0);
});

test('预加载：门槛满足才入选，按 score 降序取前 N', () => {
  const entries = [
    entry({ id: 'high', confidence: 0.95, recalls: 8 }),
    entry({ id: 'mid', confidence: 0.85, recalls: 4 }),
    entry({ id: 'low', confidence: 0.9, recalls: 1 }),
  ];
  const r = selectPreloadCandidates(entries, { maxPreload: 2 });
  assert.equal(r.eligible, 2);
  assert.deepEqual(r.candidates.map((c) => c.id), ['high', 'mid']);
  assert.equal(r.recallsAllZero, false);
});

test('⭐ 预加载负控制：门槛降到 0 必须出候选（证明不是恒空）', () => {
  const entries = [entry({ confidence: 0.5, recalls: 0 })];
  const soft = selectPreloadCandidates(entries);
  assert.equal(soft.picked, 0);
  const hard = selectPreloadCandidates(entries, { minConfidence: 0, minRecalls: 0 });
  assert.equal(hard.picked, 1);
  assert.equal(hard.candidates[0].id, 'm1');
});

test('预加载排除：已解决条目与 L2 不进候选', () => {
  const entries = [
    entry({ id: 'done', resolved: true, confidence: 1, recalls: 99 }),
    entry({ id: 'old', level: 'L2', confidence: 1, recalls: 99 }),
  ];
  const r = selectPreloadCandidates(entries);
  assert.equal(r.picked, 0);
  assert.equal(r.eligible, 0);
});

test('衰减体检：分布与三条红旗', () => {
  const entries = [
    entry({ id: 'a', level: 'L1', confidence: 0.5 }),
    entry({ id: 'b', level: 'L2', confidence: 0.9 }),
    entry({ id: 'c', level: 'L1', confidence: 0.5, resolved: true }),
  ];
  const r = summarizeDecay(entries);
  assert.equal(r.total, 3);
  assert.deepEqual(r.levels, { L1: 2, L2: 1 });
  assert.equal(r.resolved, 1);
  assert.equal(r.defaultConfidence, 2);
  assert.equal(r.flags.recallsAllZero, true);
  assert.equal(r.flags.nothingResolved, false);
  assert.equal(r.flags.defaultConfidenceMajority, true);
});

test('汇总报告：三项齐全，JSON 安全（无 undefined）', () => {
  const r = buildMaintenanceReport([entry()], { repoRoot: 'C:/repo', exists: () => true, nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.generatedAt, '2026-11-07T04:00:00.000Z');
  assert.ok(r.evidence && r.preload && r.decay);
  const json = JSON.stringify(r);
  assert.ok(!json.includes('undefined'), json);
});

test('summarizeMaintenance 压平后字段齐全', () => {
  const r = buildMaintenanceReport([entry()], { repoRoot: 'C:/repo', exists: () => true, nowMs: NOW });
  const s = summarizeMaintenance(r);
  assert.equal(s.pool, 1);
  assert.equal(s.evidenceBroken, 0);
  assert.equal(s.preloadPicked, 0);
  assert.equal(s.recallsAllZero, true);
});
