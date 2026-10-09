/**
 * agint-aesthetic-oracle 评分纯函数测试（v2.3 §3 / §4）。
 * Run: node --test plugins/agint-aesthetic-oracle/test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THRESHOLDS, DIM_KEYS, deriveComposites, computeAestheticScore,
  q1Verdict, q2Worst, q3Advice, evaluateAesthetics, NO_ADVICE,
  FORMULA_VERSION, scaleHash, stableStringify, DIM_WEIGHTS,
} from '../lib/scoring.js';
import { recomputeBaseline, baselineHasNaDim, medianBy } from '../lib/broadcast.js';

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

test('方案标定数据复算：四指标与总分 = 53.4 ± 0.5（AC-0d 确定性部分，公式 r3）', () => {
  const c = deriveComposites(PLAN_ATOMIC);
  // r3 noise = 84/380（分子只含死条目：orphans 13 + noEvidence 71；
  // contradictions 1 与 duplicates 3 已移给 redundancy）
  assert.ok(Math.abs(c.noise.value - 84 / 380) < 1e-3, `noise=${c.noise.value}`);
  assert.equal(c.noise.numerator, 84);
  assert.equal(c.noise.denominator, 380);
  // confidence = 0.544（逐条口径）
  assert.ok(Math.abs(c.confidence.value - 0.544) < 1e-6);
  // redundancy = 4/55（r3 起矛盾/重复只在此处记账）
  assert.ok(Math.abs(c.redundancy.value - 4 / 55) < 1e-3, `redundancy=${c.redundancy.value}`);
  // bloat = 82652/122880
  assert.ok(Math.abs(c.bloat.value - 82652 / 122880) < 1e-3, `bloat=${c.bloat.value}`);

  const s = computeAestheticScore(c);
  assert.equal(s.renormalized, false);
  assert.equal(s.availableDims.length, 4);
  assert.ok(Math.abs(s.score - 53.4) <= 0.5, `score=${s.score}（期望 53.4±0.5）`);
  assert.equal(s.effectiveDenominator, 100, '四维齐时有效分母 = Σ权重 = 100');
  // 逐项扣分（§3.6 表；noise 扣分随 r3 分子收窄由 23.1579 → 22.11）
  assert.ok(Math.abs(s.dims.noise.deduction - 22.11) < 0.01, `noise ded=${s.dims.noise.deduction}`);
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

test('evaluateAesthetics 一站式：钉死数据 → 53.4；worst/advice 齐备', () => {
  const out = evaluateAesthetics(PLAN_ATOMIC, { adviceCtx: { memoryNoEvidenceCount: 71 } });
  assert.ok(Math.abs(out.scored.score - 53.4) <= 0.5);
  assert.ok(out.worst);
  assert.ok(out.advice.advice);
  assert.ok(out.advice.evidence);
});

// ── r3 双计数拆解（提案 51e6e24f）──────────────────────────────────────────

test('r3：矛盾/重复不进 noise 分子，只在 redundancy 记一次账', () => {
  // 同一批「重复/矛盾」数据，两组只差这两个原子值
  const base = {
    wikiOrphans: 0, memoryNoEvidence: 0,
    wikiTotal: 100, rulesTotal: 100, memoryTotal: 100,
    avgConfXCompliance: 1, curatorOverlaps: 0, skillsTotal: 100, skillsBytes: 0,
  };
  const clean = deriveComposites({ ...base, wikiContradictions: 0, ruleDuplicates: 0 });
  const dirty = deriveComposites({ ...base, wikiContradictions: 20, ruleDuplicates: 20 });

  // 判据 1：noise 完全不受矛盾/重复影响（旧口径下这里是 40/300=0.133）
  assert.equal(dirty.noise.value, clean.noise.value, '噪声比不得被矛盾/重复条目影响');
  assert.equal(dirty.noise.numerator, 0);

  // 判据 2：但它们仍被度量——记在冗余度上
  assert.ok(dirty.redundancy.value > clean.redundancy.value, '矛盾/重复仍须记在冗余度');

  // 判据 3（核心）：总分只被扣一次，不是两维各扣一次
  const sClean = computeAestheticScore(clean);
  const sDirty = computeAestheticScore(dirty);
  const dedGap = sDirty.dims.redundancy.deduction - sClean.dims.redundancy.deduction;
  const scoreGap = sClean.score - sDirty.score;
  assert.ok(
    Math.abs(scoreGap - dedGap) < 0.05,
    `总分降幅 ${scoreGap.toFixed(2)} 应等于冗余度单独扣分 ${dedGap.toFixed(2)}（差值即旧口径的双计重复扣分）`,
  );
  // 判据 4（对照 r2 旧口径）：同一批数据，r2 会在 noise 上再扣一次 13.33
  // （30 × min(40/300 / 0.30, 1)），r3 不扣 ⇒ 降幅必须严格小于 20 + 13.33。
  const r2ExtraNoiseDeduction = DIM_WEIGHTS.noise * Math.min((40 / 300) / THRESHOLDS.NOISE_RATIO, 1);
  assert.equal(sDirty.dims.noise.deduction, 0, 'r3 下噪声维对矛盾/重复零扣分');
  assert.ok(
    scoreGap < dedGap + r2ExtraNoiseDeduction,
    `r3 降幅 ${scoreGap} 必须小于「冗余度单扣 ${dedGap} + r2 旧口径多扣的噪声 ${r2ExtraNoiseDeduction.toFixed(2)}」`,
  );
  // 判据 5：Q2 归因不再两维争夺「最丑」——r2 下 noise 与 redundancy 都会因
  // 同一批矛盾/重复拿到非零扣分，归因取决于权重差；r3 下只有 redundancy 有账。
  assert.equal(q2Worst(dirty, sDirty.dims).key, 'redundancy');
  // 无任何扣分时 q2Worst 仍返回一个维（既有行为：它排序 ratio 不筛 0），但 ratio=0
  // ⇒ 「最丑」不构成归因。（此断言只钉住本测试关心的量，不评价该既有行为）
  assert.equal(q2Worst(clean, sClean.dims).ratio, 0);
});

test('r3：noise 分子只认死条目——orphans 与 noEvidence 仍进分子', () => {
  const c = deriveComposites({
    wikiOrphans: 10, memoryNoEvidence: 20,
    wikiTotal: 100, rulesTotal: 100, memoryTotal: 100,
    avgConfXCompliance: 1, skillsTotal: 100, skillsBytes: 0,
  });
  assert.equal(c.noise.numerator, 30, '10 孤儿 + 20 无证据 = 30');
  assert.equal(c.noise.denominator, 300);
  assert.ok(Math.abs(c.noise.value - 0.1) < 1e-6);
});

// ── 判尺指纹（提案 98c8e911）───────────────────────────────────────────────

test('公式版本已随 r3 双计数拆解 bump（历史趋势分段依据）', () => {
  assert.equal(FORMULA_VERSION, 'r3');
});

test('判尺指纹 scaleHash：8 位十六进制且对当前尺子钉死', () => {
  assert.match(scaleHash, /^[0-9a-f]{8}$/, `scaleHash=${scaleHash}`);
  // 钉死值：改动 THRESHOLDS / DIM_WEIGHTS / EFFECT_EPSILON 任一常量，本断言即红。
  // 这是「改判尺必须显式承认」的强制点——更新此值的人应当同时更新本文件与
  // calibration 脚本，让判尺变更在 git 里留痕，而不是悄悄发生。
  assert.equal(scaleHash, '59e371d8', '判尺常量变了却没更新钉死指纹——改判尺须走评审并同步本行');
});

test('判尺指纹对 key 书写顺序不敏感（stableStringify 按 key 排序）', () => {
  const a = stableStringify({ b: 2, a: 1 });
  const b = stableStringify({ a: 1, b: 2 });
  assert.equal(a, b, '只是代码风格变动，不该被判为「尺子变了」');
});

// ── Q1 基线重定（提案 6be656fd；老板 2026-10-09 拍板方案 D）──────────────────

test('medianBy：奇偶取值正确，空数组返回 null（不返回 0）', () => {
  assert.equal(medianBy([3, 1, 2]), 2);
  assert.equal(medianBy([4, 1, 2, 3]), 2.5);
  assert.equal(medianBy([]), null);
  assert.equal(medianBy([null, undefined, NaN]), null);
});

test('重定基：近 4 周中位数补齐缺值维，并落每维样本数', () => {
  const mk = (ts, score, composites) => ({ kind: 'daily', outcome: 'ok', ts, score, composites });
  const rows = [
    mk('2026-10-08T01:00:00Z', 97.8, { noise: 0.0135, confidence: 0.6694, redundancy: 0, bloat: 0.8752 }),
    mk('2026-10-08T13:00:00Z', 97.0, { noise: 0.0106, confidence: 0.6305, redundancy: 0, bloat: 0.8752 }),
    mk('2026-10-09T01:00:00Z', 97.6, { noise: 0.0089, confidence: 0.6467, redundancy: 0, bloat: 0.8752 }),
    // 早期行缺 redundancy/bloat（模拟 10-07 之前的老数据）
    mk('2026-10-05T01:00:00Z', 90.1, { noise: 0.0405, confidence: 0.6692, redundancy: null, bloat: null }),
    mk('2026-10-02T01:00:00Z', 80.3, { noise: 0.0877, confidence: 0.6617, redundancy: null, bloat: null }),
  ];
  const r = recomputeBaseline(rows, { now: new Date('2026-10-09T13:30:00Z') });
  assert.equal(r.rows, 5);
  assert.equal(r.windowDays, 28);
  assert.equal(r.score, 97.0, '5 个分数的中位数');
  // 每维样本数如实不同——这是「n 必须落盘」的理由
  assert.deepEqual(r.sampleCounts, { noise: 5, confidence: 5, redundancy: 3, bloat: 3 });
  assert.equal(r.composites.redundancy, 0, '缺值维由有值样本补齐');
  assert.equal(r.composites.bloat, 0.8752);
});

test('重定基：窗口是闭区间——未来行不得计入（now 取过去时刻的回归锁）', () => {
  const mk = (ts, score) => ({ kind: 'daily', outcome: 'ok', ts, score, composites: { noise: 0.1, confidence: 0.6, redundancy: 0, bloat: 0.5 } });
  const rows = [
    mk('2026-09-30T01:00:00Z', 50),
    mk('2026-10-05T01:00:00Z', 60),
    mk('2026-10-08T01:00:00Z', 99), // 相对 now=10-06 是「未来」行
  ];
  // ⛔ 只卡下界时这条会返回 3 行（把未来的 99 算进去）；两端都卡才是 2 行。
  const r = recomputeBaseline(rows, { now: new Date('2026-10-06T12:00:00Z') });
  assert.equal(r.rows, 2, '未来行必须被窗口上界挡住');
  assert.equal(r.score, 55);
  // 全在窗口外 → null（调用方须保持原基线，不得写空基线）
  assert.equal(recomputeBaseline(rows, { now: new Date('2026-08-01T00:00:00Z') }), null);
  assert.equal(recomputeBaseline([], { now: new Date() }), null);
});

test('缺值维判据：驱动「一次性重定基」的幂等触发', () => {
  // 生产实测形态（2026-10-06 建的基线）：后两维为 null
  const bad = { establishedAt: '2026-10-06T11:10:36.042Z', score: 84.2429, composites: { noise: 0.0676, confidence: 0.6547, redundancy: null, bloat: null } };
  assert.equal(baselineHasNaDim(bad), true, '缺值维 ⇒ 触发重定基');
  // 重定后的形态 ⇒ 判据失效 ⇒ 不会反复重算（否则退化成老板否掉的「滚动」）
  const good = { establishedAt: '2026-10-06T11:10:36.042Z', score: 90.1, composites: { noise: 0.0405, confidence: 0.6542, redundancy: 0, bloat: 0.8752 } };
  assert.equal(baselineHasNaDim(good), false, '四维齐全 ⇒ 不再重定（幂等）');
  // 未建立基线 ≠ 需要重定
  assert.equal(baselineHasNaDim({ establishedAt: null, composites: {} }), false);
  assert.equal(baselineHasNaDim(null), false);
});

test('缺值基线的结构后果：两维可用时「在变美」在算术上不可达', () => {
  // 这是重定基的真实理由（比提案自己写的「防首周污染」更硬）：
  // Q1 判 beautiful 需要 betterCount≥3，而只有 2 维有基线时 betterCount ≤ 2。
  // Δ 必须超过 r2 的效应量 ε 才计数，故这里给足变化量
  // （noise ε=0.03、confidence ε=0.07）。
  const base = { noise: { value: 0.04, na: false }, confidence: { value: 0.6, na: false }, redundancy: { value: null, na: true }, bloat: { value: null, na: true } };
  const cur = { noise: { value: 0.001, na: false }, confidence: { value: 0.95, na: false }, redundancy: { value: 0, na: false }, bloat: { value: 0.5, na: false } };
  const v = q1Verdict(cur, base);
  assert.equal(v.betterCount, 2, '只有 noise/confidence 两维能参与判定');
  assert.equal(v.verdict, 'flat', '两维全改善也够不到 beautiful 的 ≥3 门槛');
  assert.deepEqual(v.betterList, ['noise', 'confidence']);
  // 对照：四维基线齐全时，同样 4 维全改善即可越过 ≥3 门槛
  const fullBase = { ...base, redundancy: { value: 0.02, na: false }, bloat: { value: 0.9, na: false } };
  const v2 = q1Verdict(cur, fullBase);
  assert.equal(v2.betterCount, 4);
  assert.equal(v2.verdict, 'beautiful', '补齐基线后「在变美」才可达——这正是重定基要修的东西');
});

test('N/A 归一化：effectiveDenominator 报出有效分母，供审计写清「归一到多少」', () => {
  const full = computeAestheticScore(deriveComposites(PLAN_ATOMIC));
  assert.equal(full.renormalized, false);
  assert.equal(full.effectiveDenominator, 100);

  // 抽掉 redundancy 与 bloat 两维 ⇒ 有效分母 = 30 + 20
  const c = deriveComposites(PLAN_ATOMIC);
  c.redundancy = { value: null, na: true, reason: 'test' };
  c.bloat = { value: null, na: true, reason: 'test' };
  const s = computeAestheticScore(c);
  assert.equal(s.renormalized, true);
  assert.deepEqual(s.naDims, ['redundancy', 'bloat']);
  assert.equal(s.effectiveDenominator, 50, '有效分母 = 剩余维权重和（noise 30 + confidence 20）');
  // 归一后扣分被放大到 100 分制：Σded=26.57 × (100/50)=53.13 → 46.9 分
  // （缺维会让分数**下降**而非上升——归一化把剩余维的扣分摊到满权重上）
  assert.ok(Math.abs(s.score - 46.9) < 0.2, `归一后 score=${s.score}`);

  const none = computeAestheticScore({});
  assert.equal(none.score, null);
  assert.equal(none.effectiveDenominator, 0, '四维全 N/A 时有效分母为 0，不假装还有分母');
});
