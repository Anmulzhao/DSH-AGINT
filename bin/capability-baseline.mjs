#!/usr/bin/env node
/**
 * bin/capability-baseline.mjs —— 冻结能力基准集只读校验器（A2）
 *
 * 用途：校验 eval/capability-baseline/sets/ 三份冻结集的**完整性**，
 *       并如实报出「有多少条可用于判定的外部冻结标签」。
 *
 * ⛔ 本脚本不产出任何能力结论。判定权归外部冻结基准与授权人工。
 * ⛔ 只读；不写 storages、不写 set 文件、不 import 任何插件代码。
 * ⛔ 资源根用 import.meta.url 定位，不用 process.cwd()。
 *
 * 三态纪律：
 *   - 表在、0 行 ⇒ 真 0（usableFrozenLabels.value = 0）
 *   - 表缺失 / 损坏 ⇒ value = null + reason
 *   - 0 标签时 capabilityConclusion = { value: null, reason }，绝不写「能力为零」
 *
 * 用法：
 *   node bin/capability-baseline.mjs                       # 打印 markdown
 *   node bin/capability-baseline.mjs --dir <sets-dir> --json
 *   node bin/capability-baseline.mjs --out <file>
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalHash } from './lib/canonical-json.mjs';
import { LABEL_AUTHORITY_VALUES } from './lib/scenario-tier.mjs';

export const SCHEMA_VERSION = 1;
export const LAYERS = Object.freeze(['L0', 'L1', 'L2', 'L3', 'L4', 'L5']);
export const SET_NAMES = Object.freeze(['gold', 'verify', 'heldout']);
export const EXTERNAL_AUTHORITIES = Object.freeze(['GOLD', 'HELDOUT']);
export const DEFAULT_SETS_DIR = fileURLToPath(new URL('../eval/capability-baseline/sets/', import.meta.url));

/** 三态读数。 */
function tri(value, reason = '', sampleSize = null) {
  return { value, reason, sampleSize };
}

/** 单份 set 的加载（不抛，坏文件也如实返回）。 */
export function loadSet(dir, name) {
  const path = join(dir, `${name}.json`);
  if (!existsSync(path)) return { name, path, exists: false, parseError: null, data: null };
  try {
    return { name, path, exists: true, parseError: null, data: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (e) {
    return { name, path, exists: true, parseError: e.message, data: null };
  }
}

/** 校验单份 set 的密封性与样本形状。 */
export function checkSet(loaded) {
  const base = { name: loaded.name, exists: loaded.exists, sealed: 'MISSING', sampleCount: 0, errors: [], samples: [] };
  if (!loaded.exists) { base.errors.push('文件不存在'); return base; }
  if (loaded.parseError) { base.sealed = 'CORRUPT'; base.errors.push(`坏 JSON: ${loaded.parseError}`); return base; }

  const d = loaded.data;
  if (!d || !Array.isArray(d.samples)) {
    base.sealed = 'CORRUPT'; base.errors.push('samples 不是数组'); return base;
  }
  const samples = d.samples;
  base.samples = samples;
  base.sampleCount = samples.length;
  const hash = typeof d.contentHash === 'string' ? d.contentHash : '';

  if (samples.length === 0 && hash === '') {
    base.sealed = 'UNSEALED'; // 合法：本批真实状态
  } else if (hash === '') {
    base.sealed = 'CORRUPT'; base.errors.push('有样本但未密封（contentHash 为空）');
  } else {
    base.sealed = hash === canonicalHash(samples) ? 'SEALED' : 'CORRUPT';
    if (base.sealed === 'CORRUPT') base.errors.push('contentHash 与 samples 不符 ⇒ 疑似篡改');
  }

  for (const [i, s] of samples.entries()) {
    if (!s || typeof s !== 'object') { base.errors.push(`samples[${i}] 非对象`); continue; }
    if (typeof s.id !== 'string' || !s.id) base.errors.push(`samples[${i}] 缺 id`);
    if (!LAYERS.includes(s.layer)) base.errors.push(`samples[${i}].layer 不在 L0-L5`);
    if (!LABEL_AUTHORITY_VALUES.includes(s.labelAuthority)) base.errors.push(`samples[${i}].labelAuthority 非法枚举`);
    if (!(s.label === null || s.label === 'PASS' || s.label === 'REJECT')) base.errors.push(`samples[${i}].label 非法`);
  }
  if (base.errors.length) base.sealed = 'CORRUPT';
  return base;
}

/**
 * 主入口：只读校验三份冻结集。
 * @param {string} dir sets 目录
 */
export function verifyBaseline(dir = DEFAULT_SETS_DIR) {
  const checked = Object.fromEntries(SET_NAMES.map((n) => [n, checkSet(loadSet(dir, n))]));
  const missing = SET_NAMES.filter((n) => checked[n].sealed === 'MISSING');
  const corrupt = SET_NAMES.filter((n) => checked[n].sealed === 'CORRUPT');

  const all = SET_NAMES.flatMap((n) => checked[n].samples);
  const usable = all.filter((s) => s && EXTERNAL_AUTHORITIES.includes(s.labelAuthority)
    && (s.label === 'PASS' || s.label === 'REJECT'));

  // gold 与 heldout 的 id 交集；任一集不可读 ⇒ 无数据，不编 0。
  let overlap;
  if (missing.length || corrupt.length) {
    overlap = tri(null, 'SETS_NOT_READABLE: 有集缺失或损坏 ⇒ 无法核对 gold/heldout 交集');
  } else {
    const g = new Set(checked.gold.samples.map((s) => s?.id).filter(Boolean));
    const h = checked.heldout.samples.map((s) => s?.id).filter(Boolean);
    overlap = tri(h.filter((id) => g.has(id)).length, '', g.size + h.length);
  }

  const layerCoverage = Object.fromEntries(LAYERS.map((l) => [l,
    usable.filter((s) => s.layer === l).length]));

  let usableFrozenLabels;
  if (missing.length || corrupt.length) {
    usableFrozenLabels = tri(null, `SETS_NOT_READABLE: missing=${missing.join(',') || '无'} corrupt=${corrupt.join(',') || '无'}`);
  } else {
    usableFrozenLabels = tri(usable.length, '', all.length); // 0 是查过的真 0
  }

  let verdict;
  if (missing.length) verdict = 'MISSING_SETS';
  else if (corrupt.length || (overlap.value ?? 0) > 0) verdict = 'CORRUPT';
  else if (usable.length === 0) verdict = 'NO_FROZEN_LABELS';
  else verdict = 'READY';

  return {
    generatedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    dir,
    sets: Object.fromEntries(SET_NAMES.map((n) => [n, {
      sealed: checked[n].sealed,
      sampleCount: checked[n].sampleCount,
      errors: checked[n].errors,
    }])),
    frozenIntegrity: missing.length || corrupt.length
      ? tri(null, `missing=[${missing.join(',')}] corrupt=[${corrupt.join(',')}]`)
      : tri(overlap.value === 0 ? 'OK' : 'OVERLAP', '', all.length),
    goldHeldoutOverlap: overlap,
    layerCoverage,
    usableFrozenLabels,
    // ⛔ 恒定无值：判定权不在只读校验器。0 标签时尤其不许写「能力为零」。
    capabilityConclusion: tri(null, usable.length === 0
      ? 'NO_FROZEN_LABELS: 0 条外部冻结标签 ⇒ 拒绝出任何能力结论（⛔ 不可据此推断能力水平，也不等于「能力没变化」）'
      : 'JUDGEMENT_EXTERNAL: 判定权归外部冻结基准与授权人工，本只读校验器不产出任何能力结论'),
    verdict,
    disclaimer: '本脚本只校验冻结集完整性，不评估 AGINT 能力，不作判定。',
  };
}

/** 渲染 markdown。 */
export function renderMarkdown(r) {
  const L = [];
  L.push('# 冻结能力基准集 · 完整性体检');
  L.push('');
  L.push(`- 生成时间：${r.generatedAt}`);
  L.push(`- 目录：\`${r.dir}\``);
  L.push(`- 判词：**${r.verdict}** · schemaVersion ${r.schemaVersion}`);
  L.push('');
  L.push('## 三层状态');
  L.push('');
  L.push('| 集 | 密封状态 | 样本数 | 错误 |');
  L.push('|---|---|---:|---|');
  for (const n of SET_NAMES) {
    const s = r.sets[n];
    L.push(`| ${n} | ${s.sealed} | ${s.sampleCount} | ${s.errors.length ? s.errors.join('；') : '—'} |`);
  }
  L.push('');
  L.push('## 判据读数（三态）');
  L.push('');
  L.push(`- 可用外部冻结标签：**${r.usableFrozenLabels.value === null ? '无数据' : r.usableFrozenLabels.value}**${r.usableFrozenLabels.reason ? ` — ${r.usableFrozenLabels.reason}` : ''}`);
  L.push(`- gold ∩ heldout：**${r.goldHeldoutOverlap.value === null ? '无数据' : r.goldHeldoutOverlap.value}**${r.goldHeldoutOverlap.reason ? ` — ${r.goldHeldoutOverlap.reason}` : ''}（必须为 0）`);
  L.push(`- 完整性：${r.frozenIntegrity.value === null ? '无数据' : r.frozenIntegrity.value}${r.frozenIntegrity.reason ? ` — ${r.frozenIntegrity.reason}` : ''}`);
  L.push(`- L0–L5 覆盖：${Object.entries(r.layerCoverage).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  L.push('');
  L.push('## 能力结论');
  L.push('');
  L.push(`> ⛔ **不产出**。${r.capabilityConclusion.reason}`);
  L.push('');
  L.push(`> ${r.disclaimer}`);
  L.push('');
  return L.join('\n');
}

function parseArgs(argv) {
  const o = { json: false, out: null, dir: DEFAULT_SETS_DIR };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--out') o.out = argv[++i] ?? null;
    else if (a === '--dir') o.dir = argv[++i] ?? DEFAULT_SETS_DIR;
    else throw new Error(`未知参数：${a}`);
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const r = verifyBaseline(o.dir);
  if (o.json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else {
    const md = renderMarkdown(r);
    if (o.out) {
      writeFileSync(o.out, md, 'utf8');
      process.stdout.write(`已写入 ${o.out}\n  判词 ${r.verdict} · 可用冻结标签 ${r.usableFrozenLabels.value ?? '无数据'}\n`);
    } else process.stdout.write(md);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
