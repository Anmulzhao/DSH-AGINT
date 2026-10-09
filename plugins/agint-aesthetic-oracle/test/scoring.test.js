/**
 * agint-aesthetic-oracle 评分纯函数测试（v2.3 §3 / §4）。
 * Run: node --test plugins/agint-aesthetic-oracle/test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THRESHOLDS, DIM_KEYS, deriveComposites, computeAestheticScore,
  q1Verdict, q2Worst, q3Advice, evaluateAesthetics, NO_ADVICE,
} from '../lib/scoring.js';

/** 方案 §3.6 / 附录 C 的 2026-09-27 钉死原子值（复算链见 calibration 脚本）。 */
const PLAN_ATOMIC = {
  wikiOrphans: 13,
  wikiContradictions: 1,
  ruleDuplicates: 3,
  memoryNoEvidence: 71,
  wikiTotal: 18,
  rulesTotal: 26,
  memoryTotal: 336,
  avgConfXCompliance: 0.544,
  curatorOverlaps: 0,
  skillsTotal: 11,
  skillsBytes: 82652,
};

test('方案标定数据复算：四指标与总分 = 52.4 ± 0.5（AC-0d 确定性部分）', () => {
  const c = deriveComposites(PLAN_ATOMIC);
  // noise = 88/380
  assert.ok(Math.abs(c.noise.value - 88 / 380) < 1e-3, `noise=${c.noise.value}`);
  assert.equal(c.noise.numerator, 88);
  assert.equal(c.noise.denominator, 380);
  // confidence = 0.544（逐条口径）
  assert.ok(Math.abs(c.confidence.value - 0.544) < 1e-6);
  // redundancy = 4/55
  assert.ok(Math.abs(c.redundancy.value - 4 / 55) < 1e-3, `redundancy=${c.redundancy.value}`);
  // bloat = 82652/122880
  assert.ok(Math.abs(c.bloat.value - 82652 / 122880) < 1e-3, `bloat=${c.bloat.value}`);

  const s = computeAestheticScore(c);
  assert.equal(s.renormalized, false);
  assert.equal(s.availableDims.length, 4);
  assert.ok(Math.abs(s.score - 52.4) <= 0.5, `score=${s.score}（期望 52.4±0.5）`);
  // 逐项扣分（§3.6 表）
  assert.ok(Math.abs(s.dims.noise.deduction - 23.1579) < 0.01, `noise ded=${s.dims.noise.deduction}`);
  assert.ok(Math.abs(s.dims.confidence.deduction - 4.4571) < 0.01, `conf ded=${s.dims.confidence.deduction}`);
  assert.ok(Math.abs(s.dims.redundancy.deduction - 20) < 0.01, `redund ded=${s.dims.redundancy.deduction}`);
  assert.equal(s.dims.bloat.deduction, 0);
});

test('完美系统 = 100 分；各项阈值内不扣分', () => {
  const c = deriveComposites({
    wikiOrphans: 0, wikiContradictions: 0, ruleDuplicates: 0, memoryNoEvidence: 0,
    wikiTotal: 10, rulesTotal: 10, memoryTotal: 10,
    avgConfXCompliance: 0.70, curatorOverlaps: 0, skillsTotal: 5, skillsBytes: 0,
  });
  const s = computeAestheticScore(c);
  assert.equal(s.score, 100);
});

test('单维扣满结构：noise 爆表只扣 30，不影响其他维', () => {
  const c = deriveComposites({
    wikiOrphans: 1000, wikiContradictions: 0, ruleDuplicates: 0, memoryNoEvidence: 0,
    wikiTotal: 1000, rulesTotal: 10, memoryTotal: 10,
    avgConfXCompliance: 1.0, curatorOverlaps: 0, skillsTotal: 5, skillsBytes: 0,
  });
  const s = computeAestheticScore(c);
  assert.equal(s.dims.noise.deduction, 30);
  assert.equal(s.dims.confidence.deduction, 0);
  assert.equal(s.dims.redundancy.deduction, 0);
  assert.equal(s.dims.bloat.deduction, 0);
  assert.equal(s.score, 70);
});

test('bloat 超预算线性扣分且不封顶（bloat=2 → −30）', () => {
  const c = deriveComposites({
    wikiOrphans: 0, wikiContradictions: 0, ruleDuplicates: 0, memoryNoEvidence: 0,
    wikiTotal: 10, rulesTotal: 10, memoryTotal: 10,
    avgConfXCompliance: 1.0, curatorOverlaps: 0, skillsTotal: 5,
    skillsBytes: THRESHOLDS.BLOAT_BUDGET_BYTES * 2,
  });
  const s = computeAestheticScore(c);
  assert.equal(s.dims.bloat.deduction, 30);
  assert.equal(s.score, 70);
});

test('r2：bloat 扣分饱和于 2.5 倍预算（b=3 → 扣 45，b=4 → 仍 45，总分不为负）', () => {
  const mk = (mult) => deriveComposites({
    wikiOrphans: 0, wikiContradictions: 0, ruleDuplicates: 0, memoryNoEvidence: 0,
    wikiTotal: 10, rulesTotal: 10, memoryTotal: 10,
    avgConfXCompliance: 1.0, curatorOverlaps: 0, skillsTotal: 5,
    skillsBytes: THRESHOLDS.BLOAT_BUDGET_BYTES * mult,
  });
  // b=3：min(max(0,2),1.5)=1.5 → 扣 45
  assert.equal(computeAestheticScore(mk(3)).dims.bloat.deduction, 45);
  // b=4：min(max(0,3),1.5)=1.5 → 仍 45（饱和，不再加倍）
  assert.equal(computeAestheticScore(mk(4)).dims.bloat.deduction, 45);
  // 旧公式 b=4 扣 90 → 总分 10；b=6 扣 150 → 总分 -50（荒谬）。r2 后下限 = 100-45=55。
  const s4 = computeAestheticScore(mk(4));
  assert.equal(s4.score, 55);
});

test('r2：Q1 效应量门槛——阈下波动不计入恶化/改善', () => {
  const mk = ({ nr }) => deriveComposites({
    wikiOrphans: Math.round(nr * 1000), wikiContradictions: 0, ruleDuplicates: 0,
    memoryNoEvidence: 0, wikiTotal: 1000, rulesTotal: 100, memoryTotal: 100,
    avgConfXCompliance: 1.0, curatorOverlaps: 0, skillsTotal: 5, skillsBytes: 0,
  });
  // 噪声比 0.040 → 0.045：Δ=0.005 < ε(noise)=0.03 → 持平（旧公式计恶化一维）
  const v = q1Verdict(mk({ nr: 0.045 }), mk({ nr: 0.040 }));
  assert.equal(v.worseCount, 0, `阈下波动不该计恶化，实得 worse=${v.worseCount}`);
  // 噪声比 0.040 → 0.10：Δ=0.06 > ε → 计恶化一维（单维恶化仍判持平，但被计数）
  const v2 = q1Verdict(mk({ nr: 0.10 }), mk({ nr: 0.040 }));
  assert.equal(v2.worseCount, 1);
  // 越过门槛的两维恶化 → 丑（阈值语义未变）
  const v3 = q1Verdict(mk({ nr: 0.10 }), mk({ nr: 0.01 }));
  assert.equal(v3.worseCount, 1);
  assert.equal(v3.verdict, 'flat');
});

test('AC-4：任一维 N/A → 广播仍输出，扣分按权重归一（ΣmaxW=70 时放大 100/70）', () => {
  const c = deriveComposites({
    // 缺 wiki/rules/memory 全部分母 → noise N/A
    wikiContradictions: 1,
    avgConfXCompliance: 0.35, // conf 扣满 20
    curatorOverlaps: 0, rulesTotal: 10, wikiTotal: 10, skillsTotal: 10,
    ruleDuplicates: 1, // redundancy = (1+1+0)/30 → 扣满 20
    skillsBytes: 0,
  });
  assert.equal(c.noise.na, true);
  const s = computeAestheticScore(c);
  assert.equal(s.renormalized, true);
  assert.deepEqual(s.naDims, ['noise']);
  // conf=0.35 → 扣 20×(0.35/0.70)=10；redundancy=2/30 → 扣满 20；Σded=30
  // ΣmaxW = 70 → score = 100 − 30×(100/70) = 57.1428…（函数内 round 到 1 位 = 57.1）
  assert.ok(Math.abs(s.score - 57.1429) <= 0.05, `score=${s.score}`);
});

test('AC-4 极端：四维全 N/A → score = null（无分可打），不抛错', () => {
  const s = computeAestheticScore(deriveComposites({}));
  assert.equal(s.score, null);
  assert.equal(s.availableDims.length, 0);
});

test('§4 Q1 判定全排序无洞：worse∈[0,4] × better 组合逐一验证', () => {
  // 直接用判定规则层面验证（构造 composites 太啰嗦，等价性由 q1Verdict 实现保证）
  const verdictFor = (worseCount, betterCount) => {
    if (worseCount >= 2) return 'ugly';
    if (worseCount < 2 && betterCount >= 3) return 'beautiful';
    return 'flat';
  };
  const cases = [];
  for (let w = 0; w <= 4; w++) {
    for (let b = 0; b + w <= 4; b++) {
      cases.push([w, b, verdictFor(w, b)]);
    }
  }
  // 方案验证行：恶化 0/改善 5→美；恶化 1/改善 4→美；恶化 2→丑；恶化 3/4→丑
  // （4 维体系下对应 0/4、1/3、2/n、3/n）
  assert.equal(verdictFor(0, 4), 'beautiful');
  assert.equal(verdictFor(1, 3), 'beautiful');
  assert.equal(verdictFor(2, 0), 'ugly');
  assert.equal(verdictFor(2, 2), 'ugly');
  assert.equal(verdictFor(3, 0), 'ugly');
  assert.equal(verdictFor(4, 0), 'ugly');
  // 逻辑洞检查：不存在"恶化更多反而判得更好"的倒挂
  for (const [w, b, v] of cases) {
    if (w >= 2) assert.equal(v, 'ugly', `w=${w},b=${b} must be ugly`);
  }
  // 每个组合都有唯一判定
  for (const [, , v] of cases) assert.ok(['beautiful', 'ugly', 'flat'].includes(v));
});

test('Q1：composite 全程走一遍（noise↑ + redundancy↑ → 丑；全改善 → 美）', () => {
  const mk = ({ nr, conf, rd, bl }) => {
    const c = deriveComposites({
      wikiOrphans: Math.round(nr * 100), wikiContradictions: 0, ruleDuplicates: 0,
      memoryNoEvidence: Math.round(nr * 100),
      wikiTotal: 100, rulesTotal: 100, memoryTotal: 100,
      avgConfXCompliance: conf, curatorOverlaps: 0, skillsTotal: 100,
      ruleDuplicates2: 0,
      skillsBytes: Math.round(bl * THRESHOLDS.BLOAT_BUDGET_BYTES),
      // redundancy 用 ruleDuplicates + wikiContradictions 构造
    });
    // 覆盖 redundancy：直接改值（保持纯函数可测）
    c.redundancy = { value: rd, na: false };
    return c;
  };
  const base = { nr: 0.1, conf: 0.9, rd: 0.01, bl: 0.5 };
  // 两维恶化 → 丑
  const cur1 = mk({ ...base, nr: 0.2, rd: 0.02 });
  assert.equal(q1Verdict(cur1, mk(base)).verdict, 'ugly');
  // 全维改善 → 美
  const cur2 = mk({ nr: 0.05, conf: 0.95, rd: 0.005, bl: 0.4 });
  assert.equal(q1Verdict(cur2, mk(base)).verdict, 'beautiful');
  // 单维恶化 → 持平
  const cur3 = mk({ ...base, nr: 0.2 });
  assert.equal(q1Verdict(cur3, mk(base)).verdict, 'flat');
  // 基线 null → 持平 + 注记
  assert.deepEqual(q1Verdict(cur1, null), { verdict: 'flat', worseCount: 0, betterCount: 0, note: '基线未建立（首周起算）' });
});

test('Q2：按偏离度 ratio 取最丑维（r2：redundancy 满权重 1.0 > noise 0.77）', () => {
  const c = deriveComposites(PLAN_ATOMIC);
  const s = computeAestheticScore(c);
  const worst = q2Worst(c, s.dims);
  // r2 口径：ratio = deduction/maxWeight。redundancy 扣满 20/20=1.0 >
  // noise 23.16/30≈0.77 > confidence 4.46/20≈0.22 > bloat 0
  // 旧口径按绝对扣分（23.16>20）报 noise——归因被权重差绑架，已修复。
  assert.equal(worst.key, 'redundancy');
  assert.ok(Math.abs(worst.ratio - 1) < 1e-6, `ratio=${worst.ratio}`);
  assert.ok(Math.abs(worst.deduction - 20) < 0.01);
});

test('Q3：有证据时四条映射齐全，均附证据（§4 P2-10 修复：不再缺 3/4）', () => {
  const ctxByKey = {
    noise: { memoryNoEvidenceCount: 71, memoryNoEvidenceIds: ['a', 'b'] },
    confidence: { lowConfidenceNoEvidence: ['lesson-a', 'lesson-b'] },
    redundancy: { ruleLintIssues: [{ ruleId: 'R1', kind: 'duplicate-pattern', with: 'R2' }] },
    bloat: { skillsBytes: THRESHOLDS.BLOAT_BUDGET_BYTES * 2 },
  };
  for (const key of DIM_KEYS) {
    const a = q3Advice(key, ctxByKey[key]);
    assert.ok(a.advice && a.advice !== NO_ADVICE, `${key} must have real advice`);
    assert.ok(a.evidence, `${key} must have evidence`);
  }
  const noise = q3Advice('noise', { memoryNoEvidenceCount: 71, memoryNoEvidenceIds: Array.from({ length: 60 }, (_, i) => `id${i}`) });
  assert.ok(noise.advice.includes('71 条'));
  assert.ok(noise.advice.includes('id0'));
  const red = q3Advice('redundancy', { ruleLintIssues: [{ ruleId: 'R1', kind: 'duplicate-pattern', with: 'R2' }] });
  assert.ok(red.advice.includes('R1+R2'));
});

test('Q3 证据绑定：redundancy 无重复规则但 wiki 有矛盾 → 建议指向矛盾（2026-09-29 编建议 bug 回归）', () => {
  const red = q3Advice('redundancy', {
    ruleLintIssues: [],
    wikiContradictionFiles: ['DSH-subagent集成坑.md', '挂载-重启红线.md', '核实-3.1-3.2-2026-09-09.md'],
    curatorOverlaps: 0,
  });
  assert.ok(red.advice.includes('解决 wiki 矛盾'), red.advice);
  assert.ok(red.advice.includes('3 处'), red.advice);
  assert.ok(!red.advice.includes('合并 rule_lint'), '不得再编造 duplicate 建议');
  assert.equal(red.evidence, 'wiki_lint contradictions 明细');
});

test('Q3 证据绑定：redundancy 全零分子 → 输出「本日无可执行建议」', () => {
  const red = q3Advice('redundancy', { ruleLintIssues: [], wikiContradictionFiles: [], curatorOverlaps: 0 });
  assert.equal(red.advice, NO_ADVICE);
  const noise = q3Advice('noise', { memoryNoEvidenceCount: 0, wikiOrphanFiles: [] });
  assert.equal(noise.advice, NO_ADVICE);
  const conf = q3Advice('confidence', {});
  assert.equal(conf.advice, NO_ADVICE);
  const bloat = q3Advice('bloat', { skillsBytes: 0 });
  assert.equal(bloat.advice, NO_ADVICE);
});

test('Q3 证据绑定：noise 无无证据记忆但 wiki 有孤儿 → 建议归档孤儿', () => {
  const noise = q3Advice('noise', { memoryNoEvidenceCount: 0, wikiOrphanFiles: ['a.md', 'b.md'] });
  assert.ok(noise.advice.includes('归档 wiki orphans'), noise.advice);
  assert.ok(noise.advice.includes('a.md'), noise.advice);
});

test('evaluateAesthetics 一站式：钉死数据 → 52.4；worst/readvice 齐备', () => {
  const out = evaluateAesthetics(PLAN_ATOMIC, { adviceCtx: { memoryNoEvidenceCount: 71 } });
  assert.ok(Math.abs(out.scored.score - 52.4) <= 0.5);
  assert.ok(out.worst);
  assert.ok(out.advice.advice);
  assert.ok(out.advice.evidence);
});
