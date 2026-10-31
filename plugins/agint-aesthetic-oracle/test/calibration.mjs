#!/usr/bin/env node
/**
 * 判尺标定拟合器（提案 a6e6e1d9 第四步，2026-10-27）。
 *
 * 存在理由：`a85ef850`「用 Q2 最丑归因标定权重」在 r2 之后**数学上失效** ——
 * r2 把 Q2 排序改成 `ratio = deduction / maxWeight`，而
 * `deduction = maxWeight × g(value, threshold)`（lib/scoring.js:327-336）
 * ⇒ 权重在分子分母被约掉。实测：36 条历史样本、随机 500 组权重（和为 100、
 * 含极端分配）⇒ **0 组**改变任何一条样本的归因；而把 CONFIDENCE 从 0.70
 * 调到 0.55 能翻 **24/36**。所以：
 *
 *   阈值 ← 用 Q2 归因吻合度标定（有自由度）
 *   权重 ← 用「总分变化方向 ↔ 人工整体感知」标定（另一列标注、另一个目标函数）
 *
 * ⛔ 本脚本的三条纪律（measure-before-quota §四）：
 *   ① 没有标注就**不拟合**，并明写「0 条已标注，无法拟合」——不是「拟合失败」；
 *   ② 独立样本按 **ISO 周**去重（同周 daily 读数高度相关，按日计数会把 5 周
 *      吹成 34 条）；样本不足时拒绝出参数，只说清还差多少；
 *   ③ 在当前样本上对参数无区分力的维度，显式标 `unidentifiable`，不装作拟合过。
 *
 * 用法：
 *   node test/calibration.mjs                       # 读 $AGINT_DATA_HOME/storages/agint_aesthetic_oracle.json
 *   node test/calibration.mjs --store <path>        # 指定存储文件
 *   node test/calibration.mjs --samples <dump.json> # 用 calibrationSamples() 的 JSON 转储
 *   node test/calibration.mjs --worksheet           # 打印待标注清单（每周一行 + 命令）
 *
 * 退出码：0 = 正常（含「无法拟合」这一诚实结果）；2 = 输入不可读 / 公式复算不自洽。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  THRESHOLDS, DIM_WEIGHTS, DIM_KEYS, FORMULA_VERSION, dimDeduction,
} from '../lib/scoring.js';

const DIMS = DIM_KEYS;
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

// ── 载入样本 ───────────────────────────────────────────────────────────────

function defaultStore() {
  const home = process.env.AGINT_DATA_HOME || process.env.DSH_HOME || '';
  return home ? join(home, 'storages', 'agint_aesthetic_oracle.json') : '';
}

function fromStore(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const rows = Object.values(raw?.tables?.oracle_broadcasts ?? {});
  return rows
    .filter((r) => r?.outcome === 'ok' && (r.kind === 'daily' || r.kind === 'weekly'))
    .filter((r) => Number.isFinite(Date.parse(r.ts ?? '')))
    .sort((a, b) => (a.ts < b.ts ? -1 : 1))
    .map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      score: r.score,
      verdict: r.verdict,
      machineWorst: r.worstKey || null,
      composites: r.composites ?? null,
      humanVerdict: r.humanVerdict ?? null,
      humanOverall: r.humanOverall ?? null,
      humanNote: r.humanNote ?? '',
    }));
}

function fromDump(path) {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const samples = Array.isArray(j) ? j : (j.samples ?? []);
  if (!Array.isArray(samples)) throw new Error('--samples 文件里没有 samples 数组');
  return samples.map((s) => ({
    id: s.id ?? '',
    ts: s.ts,
    kind: s.kind ?? 'daily',
    score: s.score ?? null,
    verdict: s.verdict ?? '',
    machineWorst: s.machineWorst ?? null,
    composites: s.composites ?? null,
    humanVerdict: s.humanVerdict ?? null,
    humanOverall: s.humanOverall ?? null,
    humanNote: s.humanNote ?? '',
  }));
}

let samples;
try {
  const dump = flag('--samples');
  const store = flag('--store') || defaultStore();
  if (dump) samples = fromDump(dump);
  else if (store && existsSync(store)) samples = fromStore(store);
  else {
    console.error(`✗ 找不到存储：${store || '(AGINT_DATA_HOME / DSH_HOME 均未设置)'}`);
    console.error('  用 --store <path> 或 --samples <dump.json> 指定样本来源。');
    process.exit(2);
  }
} catch (e) {
  console.error(`✗ 读取样本失败：${e.message}`);
  process.exit(2);
}

// ── 公式复算自检：本脚本的「参数化扣分」必须与 scoring.js 完全一致 ─────────
//
// 为什么要自检：拟合器必须能把阈值/权重当**变量**扫，而 scoring.js 的
// dimDeduction 读的是模块常量。抄一份参数化版本就有漂移风险 —— 漂移了还谈
// 「标定」等于用一把自制的尺去校原尺。所以开跑前先用当前参数对拍一遍。

function deduction(key, value, T = THRESHOLDS, W = DIM_WEIGHTS) {
  switch (key) {
    case 'noise': return W.noise * Math.min(value / T.NOISE_RATIO, 1);
    case 'confidence': return W.confidence * Math.max((T.CONFIDENCE - value) / T.CONFIDENCE, 0);
    case 'redundancy': return W.redundancy * Math.min(value / T.REDUNDANCY, 1);
    case 'bloat': return W.bloat * Math.min(Math.max(0, value - 1), T.BLOAT_SATURATION);
    default: return null;
  }
}

function selfCheck() {
  const probes = [0, 0.005, 0.02, 0.05, 0.1, 0.3, 0.5, 0.7, 0.9, 1, 1.5, 2.5, 4, 10];
  const bad = [];
  for (const key of DIMS) {
    for (const v of probes) {
      const a = deduction(key, v);
      const b = dimDeduction(key, v);
      if (b === null || Math.abs(a - b) > 1e-9) bad.push(`${key}@${v}: 本脚本 ${a} ≠ scoring ${b}`);
    }
  }
  if (bad.length) {
    console.error('✗ 公式复算不自洽（拟合器的扣分函数已与 scoring.js 漂移）：');
    for (const line of bad.slice(0, 8)) console.error(`   ${line}`);
    console.error('  ⇒ 先修 test/calibration.mjs 的 deduction()，再谈标定。');
    process.exit(2);
  }
}
selfCheck();

// ── 基本统计 ───────────────────────────────────────────────────────────────

const isoWeek = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

/** 独立样本 = 一个 ISO 周一行（取该周最后一条），因为同周 daily 读数高度相关。 */
function weeklyDedup(rows) {
  const map = new Map();
  for (const r of rows) {
    const wk = isoWeek(r.ts);
    if (!wk) continue;
    const prev = map.get(wk);
    if (!prev || r.ts > prev.ts) map.set(wk, r);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([week, r]) => ({ week, ...r }));
}

const weekly = weeklyDedup(samples);
const annotatedVerdict = weekly.filter((s) => s.humanVerdict !== null);
const annotatedOverall = weekly.filter((s) => s.humanOverall === 'better' || s.humanOverall === 'worse');

const machineCount = Object.fromEntries(DIMS.map((k) => [k, 0]));
let noDim = 0;
for (const s of samples) {
  if (s.machineWorst && s.machineWorst in machineCount) machineCount[s.machineWorst] += 1;
  else if (!s.machineWorst) noDim += 1;
}

console.log(`判尺标定拟合器 · 公式 ${FORMULA_VERSION}`);
console.log('');
console.log('【样本清单】');
console.log(`  广播条数（ok · daily/weekly）：${samples.length}`);
console.log(`  独立样本（按 ISO 周去重）    ：${weekly.length} 周${weekly.length ? `（${weekly[0].week} … ${weekly[weekly.length - 1].week}）` : ''}`);
console.log(`  机器判的最丑维分布           ：${DIMS.map((k) => `${k} ${machineCount[k]}`).join(' · ')} · 无扣分维 ${noDim}`);
console.log(`  已标注 humanVerdict          ：${annotatedVerdict.length}/${weekly.length} 周`);
console.log(`  已标注 humanOverall          ：${annotatedOverall.length}/${weekly.length} 周`);

const silentDims = DIMS.filter((k) => machineCount[k] === 0);
if (silentDims.length) {
  console.log(`  ⚠ 机器从不判为最丑的维：${silentDims.join(' / ')} ⇒ 这些维的阈值当前 **unidentifiable**`);
}

// ── --worksheet：待标注清单 ────────────────────────────────────────────────

if (argv.includes('--worksheet')) {
  console.log('');
  console.log('【待标注清单】每周一行；humanVerdict 填“这周你实际动手处理的最丑维”。');
  console.log('');
  console.log('  ISO 周   | 周内条数 | 机器最丑 | 分数   | 人工最丑（待填） | 整体（待填）');
  console.log('  ---------|---------|---------|--------|-----------------|------------');
  const perWeek = new Map();
  for (const s of samples) {
    const wk = isoWeek(s.ts);
    perWeek.set(wk, (perWeek.get(wk) ?? 0) + 1);
  }
  for (const s of weekly) {
    const hv = s.humanVerdict ?? '—';
    const ho = s.humanOverall ?? '—';
    const score = typeof s.score === 'number' ? s.score.toFixed(1) : '—';
    console.log(`  ${s.week}  | ${String(perWeek.get(s.week) ?? 0).padStart(7)} | ${String(s.machineWorst ?? '(无)').padEnd(10)}| ${score.padStart(6)} | ${String(hv).padEnd(16)}| ${ho}`);
  }
  console.log('');
  console.log('  写入方式（都会落盘到 oracle_broadcasts）。把 <…> 换成实际判断后逐条执行：');
  console.log('');
  for (const s of weekly) {
    console.log(`  # ${s.week}　机器判 ${s.machineWorst ?? '(无扣分维)'}`);
    console.log(`  node ~/.workbuddy/skills/agint-offline-harness/scripts/agint-harness.mjs \\`);
    console.log(`    oracle-annotate ${s.ts} --verdict <noise|confidence|redundancy|bloat|none> --overall <better|worse|flat> --note '<依据>'`);
  }
  console.log('');
  console.log('  ⛔ 取「本周期实际动手处理的最丑维度」，不是「读数上看起来最糟的」——');
  console.log('     后者机器已经判了，再抄一遍等于自己证明自己。');
  console.log('  ⛔ 标完必须重启 dsh（install/redeploy.sh --no-install）：运行中的 dsh 持有整域内存副本，');
  console.log('     下次写入会用内存版覆盖磁盘，外部标注会被静默冲掉。');
  process.exit(0);
}

// ── 一、阈值拟合（目标函数 = Q2 归因吻合度）────────────────────────────────

const NOISE_GRID = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5];
const CONF_GRID = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];
const RED_GRID = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1];

function predictWorst(composites, T, W = DIM_WEIGHTS) {
  let best = null;
  for (const key of DIMS) {
    const v = composites?.[key];
    if (!Number.isFinite(v)) continue;
    const ratio = deduction(key, v, T, W) / (W[key] || 1);
    if (!best || ratio > best.ratio) best = { key, ratio };
  }
  return best ? best.key : null;
}

function verdictMatches(predicted, human) {
  if (human === 'none') return predicted === null;
  return predicted === human;
}

console.log('');
console.log('【一、阈值标定】目标函数：Σ 1[q2Worst(θ) = humanVerdict]（分母 = 已标注周数）');

if (annotatedVerdict.length === 0) {
  console.log('  ⛔ 0 条已标注 ⇒ **无法拟合**（这不是“拟合失败”，是没有 ground truth）。');
  console.log(`     还差：至少 4 个已标注周才有初步区分力，建议 8-12 周（现 ${weekly.length} 周可标）。`);
  console.log('     先跑 `node test/calibration.mjs --worksheet` 拿待标注清单。');
} else if (annotatedVerdict.length < 4) {
  console.log(`  ⚠ 只有 ${annotatedVerdict.length} 周已标注（< 4）：网格搜索必然过拟合，本脚本拒绝出参数。`);
} else {
  const rows = [];
  for (const nr of NOISE_GRID) {
    for (const cf of CONF_GRID) {
      for (const rd of RED_GRID) {
        const T = { ...THRESHOLDS, NOISE_RATIO: nr, CONFIDENCE: cf, REDUNDANCY: rd };
        let hit = 0;
        for (const s of annotatedVerdict) {
          if (verdictMatches(predictWorst(s.composites, T), s.humanVerdict)) hit += 1;
        }
        rows.push({ nr, cf, rd, hit, rate: hit / annotatedVerdict.length, T });
      }
    }
  }
  rows.sort((a, b) => b.hit - a.hit || (a.nr + a.cf + a.rd) - (b.nr + b.cf + b.rd));
  const cur = {
    nr: THRESHOLDS.NOISE_RATIO, cf: THRESHOLDS.CONFIDENCE, rd: THRESHOLDS.REDUNDANCY,
  };
  const curHit = annotatedVerdict.filter(
    (s) => verdictMatches(predictWorst(s.composites, THRESHOLDS), s.humanVerdict),
  ).length;

  console.log(`  已标注 ${annotatedVerdict.length} 周，网格 ${rows.length} 组：`);
  console.log('');
  console.log('  NOISE  CONF  RED  命中  吻合率');
  for (const r of rows.slice(0, 8)) {
    console.log(`  ${r.nr.toFixed(2)}   ${r.cf.toFixed(2)}  ${r.rd.toFixed(2)}  ${String(r.hit).padStart(2)}/${annotatedVerdict.length}  ${(r.rate * 100).toFixed(0)}%`);
  }
  const best = rows[0];
  const ties = rows.filter((r) => r.hit === best.hit).length;
  console.log('');
  console.log(`  当前参数 NOISE ${cur.nr} / CONF ${cur.cf} / RED ${cur.rd} ⇒ ${curHit}/${annotatedVerdict.length}（${Math.round((curHit / annotatedVerdict.length) * 100)}%）`);
  console.log(`  最优组合 ⇒ ${best.hit}/${annotatedVerdict.length}（${(best.rate * 100).toFixed(0)}%）`
    + (ties > 1 ? `　⚠ 并列最优 ${ties} 组 —— 在它们之间**无法做选择**，样本量不足时这是常态，不许挑一个当结论` : ''));

  // 可辨识性：在当前样本上，单独动某个参数是否会改变任何一条预测
  const ident = (name, grid, key) => {
    let changed = 0;
    for (const g of grid) {
      const T = { ...THRESHOLDS, [key]: g };
      if (annotatedVerdict.some((s) => predictWorst(s.composites, T) !== predictWorst(s.composites, THRESHOLDS))) changed += 1;
    }
    return { name, changed, of: grid.length };
  };
  const idents = [
    ident('NOISE_RATIO', NOISE_GRID, 'NOISE_RATIO'),
    ident('CONFIDENCE', CONF_GRID, 'CONFIDENCE'),
    ident('REDUNDANCY', RED_GRID, 'REDUNDANCY'),
  ];
  console.log('');
  console.log('  可辨识性（单独扰动该参数、其余不变，有多少个候选值能改变至少一条预测）：');
  for (const i of idents) {
    const tag = i.changed === 0 ? '  ⛔ unidentifiable（当前样本上无区分力，不许声称标定过）' : '';
    console.log(`    ${i.name.padEnd(12)} ${i.changed}/${i.of}${tag}`);
  }
  console.log(`    BLOAT_SATURATION / BLOAT_BUDGET_PER_SKILL_BYTES  ⛔ unidentifiable —— 机器从未判 bloat 为最丑，本条不拟合`);
}

// ── 二、权重拟合（目标函数 = 总分变化方向 ↔ 人工整体感知）──────────────────

/** 参数化总分（与 scoring.js computeAestheticScore 同式：按可用维权重归一）。 */
function scoreWith(composites, W) {
  let sumDed = 0;
  let sumMaxW = 0;
  for (const key of DIMS) {
    const v = composites?.[key];
    if (!Number.isFinite(v)) continue;
    sumDed += deduction(key, v, THRESHOLDS, W);
    sumMaxW += W[key] ?? 0;
  }
  if (sumMaxW === 0) return null;
  return 100 - sumDed * (100 / sumMaxW);
}

console.log('');
console.log('【二、权重标定】目标函数：Σ 1[sign(Δscore(w)) = humanOverall]（分母 = 相邻已标注周对数）');
console.log('  ⛔ 为什么不用 verdict(w)：Q1 是**票数制**（恶化维数 ≥2 判丑、改善 ≥3 判美），');
console.log('     权重只通过 r4 总分门（Q1_SCORE_GATE_DELTA）间接影响判决 ⇒ 它同样是近权重不变量。');
console.log('     拿一个不随参数变化的目标拟合权重，就是 a85ef850 那个坑的第二次踩法。');

if (annotatedOverall.length < 5) {
  console.log(`  ⛔ 已标注 humanOverall 的周只有 ${annotatedOverall.length} 个（< 5）⇒ **无法拟合权重**。`);
  console.log('     需要连续两周都有标注才能构成一对方向样本；请继续用 --worksheet 标注。');
} else {
  const grid = [];
  for (let a = 0; a <= 100; a += 5) {
    for (let b = 0; a + b <= 100; b += 5) {
      for (let c = 0; a + b + c <= 100; c += 5) {
        const d = 100 - a - b - c;
        if (a === 0 || b === 0 || c === 0 || d === 0) continue; // 权重为 0 会把该维挤出归因
        grid.push({ noise: a, confidence: b, redundancy: c, bloat: d });
      }
    }
  }
  const EPS = 1.0; // |Δscore| < 1 分视为持平：日内噪声本身就有这个量级
  const rows = [];
  for (const W of grid) {
    let hit = 0;
    let pairs = 0;
    for (let i = 1; i < annotatedOverall.length; i += 1) {
      const prev = annotatedOverall[i - 1];
      const cur = annotatedOverall[i];
      const sp = scoreWith(prev.composites, W);
      const sc = scoreWith(cur.composites, W);
      if (!Number.isFinite(sp) || !Number.isFinite(sc)) continue;
      const delta = sc - sp;
      const pred = Math.abs(delta) < EPS ? 'flat' : (delta > 0 ? 'better' : 'worse');
      pairs += 1;
      if (pred === cur.humanOverall) hit += 1;
    }
    if (pairs > 0) rows.push({ W, hit, pairs });
  }
  rows.sort((a, b) => b.hit - a.hit);
  console.log(`  已标注 ${annotatedOverall.length} 周、可用 ${rows[0]?.pairs ?? 0} 对方向样本，网格 ${rows.length} 组：`);
  console.log('');
  console.log('  noise/conf/red/bloat  命中   吻合率');
  for (const r of rows.slice(0, 8)) {
    const { noise, confidence, redundancy, bloat } = r.W;
    console.log(`  ${String(noise).padStart(2)}/${String(confidence).padStart(2)}/${String(redundancy).padStart(2)}/${String(bloat).padStart(2)}        ${String(r.hit).padStart(2)}/${r.pairs}   ${((r.hit / r.pairs) * 100).toFixed(0)}%`);
  }
  const curHit = (() => {
    let hit = 0;
    for (let i = 1; i < annotatedOverall.length; i += 1) {
      const sp = scoreWith(annotatedOverall[i - 1].composites, DIM_WEIGHTS);
      const sc = scoreWith(annotatedOverall[i].composites, DIM_WEIGHTS);
      const delta = sc - sp;
      const pred = Math.abs(delta) < EPS ? 'flat' : (delta > 0 ? 'better' : 'worse');
      if (pred === annotatedOverall[i].humanOverall) hit += 1;
    }
    return hit;
  })();
  console.log('');
  console.log(`  当前权重 ${DIM_WEIGHTS.noise}/${DIM_WEIGHTS.confidence}/${DIM_WEIGHTS.redundancy}/${DIM_WEIGHTS.bloat} ⇒ ${curHit}/${annotatedOverall.length - 1}`);
}

console.log('');
console.log('【结论】');
const enoughThresholds = annotatedVerdict.length >= 4;
const enoughWeights = annotatedOverall.length >= 5;
if (annotatedVerdict.length === 0 && annotatedOverall.length === 0) {
  console.log('  本周期**没有任何人工标注** ⇒ 本脚本不做拟合，也不输出「建议参数」。');
  console.log('  这不是脚本失败：ground truth 只能由人给，机器替人推断等于伪造标签。');
} else if (!enoughThresholds && !enoughWeights) {
  console.log('  标注样本仍不足以支撑改判尺：上面的命中率**只作现状读数**，不构成标定结论。');
  console.log('  改 THRESHOLDS / DIM_WEIGHTS 会改 scaleHash，历史趋势需分段解释 —— 走评审，别直接改常量。');
} else {
  const which = [enoughThresholds ? '阈值' : null, enoughWeights ? '权重' : null].filter(Boolean).join(' / ');
  console.log(`  已够对 ${which} 跑一次拟合 —— 但上面是**候选读数**，不是结论：`);
  console.log('    · 并列最优多组时不得挑一个当答案（等于用样本噪声当证据）；');
  console.log('    · 改 THRESHOLDS / DIM_WEIGHTS 会改 scaleHash 与历史可比性，须走评审并记 formulaVersion；');
  console.log('    · 动常量前先把「同一批样本上当前参数 vs 候选参数」的对照写进周报，留可复核的痕。');
}
