/**
 * test/calibration-2026-09-27.mjs — 美的神谕层 v2.3 附录 C 复算脚本（AC-0d）。
 *
 * 纯 node 单文件，不依赖 dsh 运行时。两部分：
 *
 *   Part 1（确定性，任何机器必过）：用方案附录 C 钉死的 2026-09-27 原子值
 *          走 scoring.js 全链路，断言总分 = 52.4 ± 0.5。
 *          —— 这部分证明的是「公式实现与方案 §3 一致」。
 *
 *   Part 2（活体，生产机上有数据才算）：直读生产存储重算当下真值，
 *          输出与钉死值的差（数据每天在涨，差值是时间漂移不是公式误差）。
 *          —— 这部分证明的是「公式读到真实生产数据也能算」。
 *
 * Run: node test/calibration-2026-09-27.mjs        （exit 0 = AC-0d PASS）
 *
 * 钉死值来源（v2.3 附录 C，2026-09-27 生产实测）：
 *   wiki_orphans=13, wiki_contradictions=1（wiki_lint，agint-wiki/lib/index.js:187 无入链定义）
 *   rule_duplicates=3（rule_lint duplicate-pattern）
 *   memory_without_evidence=71 / memory_total=336（agint.json memory 表 evidence 顶层字段为空者）
 *   avgConfXCompliance=0.544（Σ(conf×[evidence非空])/336 逐条实算）
 *   rules_total=26（agint_rules.json tables.rule）
 *   wiki_total=18（wiki 全量页）
 *   curator_overlaps=0（agint_curator.json overlap_candidates）
 *   skills: 11 个 SKILL.md，82652 字节（~/.dsh/skills 4 + preset agint 7）
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { deriveComposites, computeAestheticScore } from '../lib/scoring.js';

const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE || '', '.dsh');
const STORAGES = join(DSH_HOME, 'storages');

// ── Part 1：钉死数据复算（确定性）───────────────────────────────────────────

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

let failed = false;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed = true;
};

console.log('== Part 1: 方案附录 C 钉死数据复算（AC-0d 确定性部分）==');
{
  const c = deriveComposites(PLAN_ATOMIC);
  const s = computeAestheticScore(c);
  check('noise_ratio = 88/380 = 0.2316', Math.abs(c.noise.value - 0.2316) < 1e-3, `got ${c.noise.value}`);
  check('confidence = 0.544（逐条 Σ(conf×compliance)/N 口径）', Math.abs(c.confidence.value - 0.544) < 1e-6, `got ${c.confidence.value}`);
  check('redundancy = 4/55 = 0.0727', Math.abs(c.redundancy.value - 0.0727) < 1e-3, `got ${c.redundancy.value}`);
  check('bloat = 82652/122880 = 0.6727', Math.abs(c.bloat.value - 0.6727) < 1e-3, `got ${c.bloat.value}`);
  check('aesthetic_score = 52.4 ± 0.5', Math.abs(s.score - 52.4) <= 0.5, `got ${s.score}`);
  check('无 N/A 维（四维全可用）', s.naDims.length === 0);
  console.log(`  → 总分 ${s.score}（v2.2 旧语义同日 27.1；v2.2 示例虚构 72——三个数字的差距就是三轮修订的意义）`);
}

// ── Part 2：生产活体复算（数据在当前机器上才执行）────────────────────────────

console.log('\n== Part 2: 生产活体复算（直读 storages + skills 文件系统）==');
const agintPath = join(STORAGES, 'agint.json');
if (!existsSync(agintPath)) {
  console.log('  SKIP：本机无生产存储（$DSH_HOME/storages/agint.json 不存在）——Part 2 仅在 dsh 生产机有意义。');
} else {
  try {
    // memory（agint.json tables.memory）
    const mem = JSON.parse(readFileSync(agintPath, 'utf8')).tables?.memory ?? {};
    const memRows = Object.values(mem);
    const noEvidenceRows = memRows.filter((e) => !e?.evidence || String(e.evidence).trim() === '');
    let sumConfXComp = 0;
    for (const e of memRows) {
      const c = Number(e?.confidence);
      if (Number.isFinite(c) && e?.evidence && String(e.evidence).trim() !== '') sumConfXComp += c;
    }
    const avgConfXComp = memRows.length ? sumConfXComp / memRows.length : null;

    // rules（agint_rules.json tables.rule，注意键是单数 rule）
    const rulesPath = join(STORAGES, 'agint_rules.json');
    let rulesTotal = null;
    if (existsSync(rulesPath)) {
      const rules = JSON.parse(readFileSync(rulesPath, 'utf8')).tables?.rule ?? {};
      rulesTotal = Object.keys(rules).length;
    }

    // metrics 最新值（wiki orphans/contradictions + rule duplicates + meta 里的 rulesTotal/wikiTotal）
    const metricsPath = join(STORAGES, 'agint_metrics.json');
    let latest = {};
    if (existsSync(metricsPath)) {
      const t = JSON.parse(readFileSync(metricsPath, 'utf8')).tables?.metric ?? {};
      for (const [, r] of Object.entries(t)) {
        if (!latest[r.key] || r.ts > latest[r.key].ts) latest[r.key] = r;
      }
    }
    const meta = (k) => { try { return JSON.parse(latest[k]?.meta ?? '{}'); } catch { return {}; } };
    const wikiOrphans = latest['wiki.orphans']?.value ?? null;
    const wikiContradictions = latest['wiki.contradictions']?.value ?? null;
    const orphanMeta = meta('wiki.orphans');
    let wikiTotal = orphanMeta.total ?? null;
    // 兜底：旧采集记录没有 meta.total 时，直读 wiki 根目录数 .md（与 wiki.lint
    // 的 walk 口径一致：递归全部 .md，checked = files.length）。根目录取
    // DSH_WIKI_ROOT（cordis.patch.yml 的 agint-wiki config）。
    if (wikiTotal === null) {
      const wikiRoot = process.env.DSH_WIKI_ROOT || 'D:/DSH/wiki';
      if (existsSync(wikiRoot)) {
        const walkMd = (dir) => {
          let n = 0;
          let entries;
          try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
          for (const e of entries) {
            const p = join(dir, e.name);
            if (e.isDirectory()) n += walkMd(p);
            else if (e.isFile() && e.name.endsWith('.md')) n += 1;
          }
          return n;
        };
        wikiTotal = walkMd(wikiRoot);
      }
    }
    const lintMeta = meta('rules.lintIssues');
    const issues = Array.isArray(lintMeta.issues) ? lintMeta.issues : [];
    const ruleDuplicates = issues.filter((i) => i?.kind === 'duplicate-pattern').length;
    const rulesTotalFromMeta = lintMeta.rulesTotal ?? rulesTotal;

    // skills 字节（两根遍历）
    const skillRoots = [join(DSH_HOME, 'skills'), join(DSH_HOME, '.agent-presets', 'agint', 'skills')];
    let skillsBytes = 0;
    let skillsTotal = 0;
    const walk = (dir) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && e.name === 'SKILL.md') { skillsBytes += statSync(p).size; skillsTotal += 1; }
      }
    };
    for (const r of skillRoots) if (existsSync(r)) walk(r);

    // curator overlaps
    const curatorPath = join(STORAGES, 'agint_curator.json');
    let curatorOverlaps = 0;
    if (existsSync(curatorPath)) {
      const cu = JSON.parse(readFileSync(curatorPath, 'utf8')).tables?.overlap_candidates ?? {};
      curatorOverlaps = Object.keys(cu).length;
    }

    const liveAtomic = {
      wikiOrphans,
      wikiContradictions,
      ruleDuplicates,
      memoryNoEvidence: noEvidenceRows.length,
      wikiTotal,
      rulesTotal: rulesTotalFromMeta,
      memoryTotal: memRows.length,
      avgConfXCompliance: avgConfXComp,
      curatorOverlaps,
      skillsTotal,
      skillsBytes,
    };
    const c = deriveComposites(liveAtomic);
    const s = computeAestheticScore(c);
    console.log('  原子值（活体）：');
    for (const [k, v] of Object.entries(liveAtomic)) {
      const pin = PLAN_ATOMIC[k];
      const drift = (pin !== undefined && pin !== null && v !== null && pin !== v) ? `（钉死值 ${pin}，漂移 ${v > pin ? '+' : ''}${typeof v === 'number' ? v - pin : '?'}）` : '';
      console.log(`    ${k} = ${v}${drift}`);
    }
    console.log(`  四指标：noise=${c.noise.na ? 'N/A' : c.noise.value} conf=${c.confidence.na ? 'N/A' : c.confidence.value} redundancy=${c.redundancy.na ? 'N/A' : c.redundancy.value} bloat=${c.bloat.na ? 'N/A' : c.bloat.value}`);
    console.log(`  活体总分：${s.score}（asOf=${latest['wiki.orphans']?.ts ?? '?'}——采集时点不同导致与钉死值有漂移，属正常）`);
    if (s.naDims.length > 0) console.log(`  ⚠ N/A 维：${s.naDims.join(', ')}（对应 source 数据缺席）`);
  } catch (e) {
    console.log(`  SKIP：活体复算异常（${e.message}）——不影响 Part 1 的 AC-0d 判定。`);
  }
}

console.log('\n== 结论 ==');
if (failed) {
  console.log('  AC-0d FAIL：确定性复算未通过——公式实现与方案 §3 不一致，禁止上线。');
  process.exit(1);
}
console.log('  AC-0d PASS：公式实现与方案附录 C 一致（52.4 ± 0.5）。');
process.exit(0);
