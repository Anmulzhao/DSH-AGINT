/**
 * agint-evolve 二·C 章节单测 —— 美之三问归因样本（权重真标定的采集面）。
 *
 * 提案 a85ef850；老板 2026-10-09 拍板「先建标注采集，再标定」。
 *
 * 钉的是**三态诚实**（measure-before-quota §四）：
 *   服务缺席 ≠ 采到 0 条；采到 0 条 ≠ 无问题；N 条待标注 ≠ N 条吻合。
 *   humanVerdict=null 是「还没标」，把它读成「标了没差异」会让下游以为标定已通过。
 *
 * Run: node --test plugins/agint-evolve/test/report-oracle-calibration.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReport, renderOracleCalibration } from '../lib/report.js';

const base = {
  collectedAt: '2026-10-09T00:00:00.000Z',
  memory: { total: 10, byType: { lesson: 3, decision: 2, preference: 1, pattern: 4 }, byLevel: {}, avgConfidence: 0.7 },
  wiki: { checked: 3, brokenLinks: [], contradictions: [], orphans: [], healthy: true },
  cron: { healthy: true, issues: [], jobs: [] },
  rules: { totals: { hits: 5, denies: 0, asks: 0 }, fired: [], lintIssues: [] },
};

const sample = (ts, machineWorst, humanVerdict = null) => ({
  ts, kind: 'daily', score: 97.6, verdict: 'flat',
  machineWorst, composites: { noise: 0.0089 }, humanVerdict,
});

function render(data) {
  const lines = [];
  renderOracleCalibration(lines, data);
  return lines.join('\n');
}

test('服务缺席：明写不可用，且声明这不是「本周无样本」', () => {
  const md = render(undefined);
  assert.match(md, /未挂载或不可用/);
  assert.match(md, /不是[^「]*「本周无归因样本」/);
  assert.doesNotMatch(md, /采到 \*\*0 条\*\*/, '缺席不得渲染成 0 条');
});

test('采到 0 条：如实印 0 条，并声明它不是「没有问题」', () => {
  const md = render({ formulaVersion: 'r3', scaleHash: '59e371d8', samples: [] });
  assert.match(md, /采到 \*\*0 条\*\*/);
  assert.match(md, /不是「没有问题」/);
  assert.match(md, /r3/, '判尺口径仍要透出——0 条样本也发生在某个尺子下');
});

test('样本全部待标注：印「N/N 尚未标注」，禁止出现吻合率', () => {
  const md = render({
    formulaVersion: 'r3', scaleHash: '59e371d8',
    samples: [
      sample('2026-10-07T01:00:00Z', 'redundancy'),
      sample('2026-10-08T01:00:00Z', 'redundancy'),
      sample('2026-10-09T01:00:00Z', 'bloat'),
    ],
  });
  assert.match(md, /采到 \*\*3 条\*\*/);
  assert.match(md, /3\/3 条尚未人工标注/);
  assert.match(md, /null = 还没标，不是「标了没差异」/);
  assert.match(md, /8-12 周/, '须给出拟合样本量要求');
  assert.doesNotMatch(md, /一致 0 条|0%/,
    '未标注样本不得折算成「一致 0 条」——那是把缺标注当成不吻合');
  // 机器侧分布照印（这是采集的本意）
  assert.match(md, /\| redundancy \| 2 \| 2 \|/);
  assert.match(md, /\| bloat \| 1 \| 1 \|/);
});

test('部分标注：吻合率的分母是已标注数，不是总数', () => {
  const md = render({
    formulaVersion: 'r3', scaleHash: '59e371d8',
    samples: [
      sample('2026-10-07T01:00:00Z', 'redundancy', 'redundancy'), // 吻合
      sample('2026-10-08T01:00:00Z', 'redundancy', 'bloat'),        // 不吻合
      sample('2026-10-09T01:00:00Z', 'noise'),                        // 待标注
      sample('2026-10-09T05:00:00Z', 'noise'),                        // 待标注
    ],
  });
  assert.match(md, /已标注 2\/4 条/);
  assert.match(md, /一致 1 条（50%）/);
  assert.match(md, /未标注 2 条/);
  assert.match(md, /分母是已标注数/);
});

test('无扣分维的轮次归入「（无扣分维）」，不与四维混算', () => {
  const md = render({
    formulaVersion: 'r3', scaleHash: '59e371d8',
    samples: [sample('2026-10-08T01:00:00Z', null), sample('2026-10-09T01:00:00Z', null)],
  });
  assert.match(md, /\| （无扣分维） \| 2 \| 2 \|/);
});

test('周报正文确实含该章节（接线不是孤儿函数）', () => {
  const md = buildReport({
    date: '2026-10-09',
    snapshot: { ...base, oracleCalibration: { formulaVersion: 'r3', scaleHash: '59e371d8', samples: [sample('2026-10-09T01:00:00Z', 'bloat')] } },
    findings: [],
  });
  assert.match(md, /## 二·C、美之三问归因样本/);
  assert.match(md, /判尺指纹 59e371d8/);

  // 服务缺席时章节仍在，且说明缺席含义（静默跳过 = 假防线）
  const md2 = buildReport({ date: '2026-10-09', snapshot: base, findings: [] });
  assert.match(md2, /## 二·C、美之三问归因样本/);
  assert.match(md2, /未挂载或不可用/);
});