#!/usr/bin/env node
/**
 * wiki-build — 把 wiki 目录变成表示层（阶段 3，2026-11-07）。
 *
 * 产出三页（全部带生成标记，可重建）：
 *   README.md         总索引：按领域列出每篇 + 一句话原文摘要 + 生成页入口
 *   _口径缺口总览.md   跨文档聚合「口径缺口 / 口径冲突 / 待确认」，逐字引用 + 行号回查
 *   _依据反查.md       制度名称 → 被哪些文档引用（只收 ≥2 篇引用的）
 *
 * # 用法
 *   node bin/wiki-build.mjs --root D:/DSH/AGINT-date/wiki            # 只打印计划，不写盘
 *   node bin/wiki-build.mjs --root ... --write                        # 落盘
 *   node bin/wiki-build.mjs --root ... --check                        # 只判是否漂移
 *   node bin/wiki-build.mjs --root ... --write --prune                # 同时清掉过期的生成页
 *
 * # 退出码
 *   0  正常（dry-run）/ 已是最新（--check）/ 写入成功
 *   1  --check 发现漂移（有页要写或有过期生成页）；dry-run 下恒为 0
 *   2  硬失败：逐字校验不通过、链接断链、参数错误
 *
 * ⚠️ 退出码 1 是**正常业务结果**（需要重建），不是故障。消费方（cron 门禁）
 *    必须按 `drift` 字段判，不要按退出码反推「崩了」。
 *
 * # 纪律
 *   - 默认 **不写盘**。写盘必须显式 --write。
 *   - 人工页（存在但没有生成标记）**永不覆盖**，只报告 refused。
 *   - 逐字校验不过就直接退 2：宁可不出页，也不出摘要化的页（博客实测摘要化丢 57 条里的 16 条）。
 */

import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import {
  buildPlan,
  planWrites,
  verifyVerbatim,
  checkLinks,
  summarizePlan,
  BUILD_DEFAULTS,
} from '../plugins/agint-wiki/lib/representation.js';
import { GEN_MARKER_PREFIX } from '../plugins/agint-wiki/lib/marker.js';

const argv = process.argv.slice(2);
const argOf = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(name);

const ROOT = argOf('--root') ?? process.env.AGINT_WIKI_ROOT ?? null;
const AS_JSON = has('--json');
const WRITE = has('--write');
const CHECK = has('--check');
const PRUNE = has('--prune');
const MIN_SOURCES = Number(argOf('--min-sources', String(BUILD_DEFAULTS.minSources)));
const MAX_RATIO = Number(argOf('--max-ratio', String(BUILD_DEFAULTS.maxRatio)));

if (!ROOT) {
  console.error('wiki-build: 需要 --root <wiki 目录>，或设置 AGINT_WIKI_ROOT');
  process.exit(2);
}

const root = resolve(ROOT);

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(abs));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(relative(root, abs).replace(/\\/g, '/'));
  }
  return out.sort();
}

const paths = await walk(root);
if (paths.length === 0) {
  console.error(`wiki-build: ${root} 下没有 .md 文件`);
  process.exit(2);
}

const files = [];
const existing = new Map();
for (const p of paths) {
  const content = await readFile(join(root, p), 'utf8');
  files.push({ path: p, content });
  existing.set(p, content.replace(/\r\n/g, '\n'));
}

const plan = buildPlan(files, { minSources: MIN_SOURCES, maxRatio: MAX_RATIO });
const summary = summarizePlan(plan);

// ── 硬门槛：逐字校验与链接完整性 ──────────────────────────────────
const violations = verifyVerbatim(plan, files);
const broken = checkLinks(plan, files.map((f) => f.path));
if (violations.length || broken.length) {
  const payload = { ok: false, violations: violations.slice(0, 20), broken: broken.slice(0, 20) };
  if (AS_JSON) console.log(JSON.stringify(payload, null, 2));
  else {
    console.error(`wiki-build: 硬失败 —— 逐字校验 ${violations.length} 条、断链 ${broken.length} 条`);
    for (const v of violations.slice(0, 10)) console.error(`  [非逐字] ${v.page}: ${v.text}`);
    for (const b of broken.slice(0, 10)) console.error(`  [断链]   ${b.page} → ${b.target}`);
  }
  process.exit(2);
}

const { writes, unchanged, refused } = planWrites(plan.pages, existing);

// 过期生成页：目录里有生成标记、但本次计划不产出的页
const planned = new Set(plan.pages.map((p) => p.path));
const stale = [...existing.entries()]
  .filter(([p, c]) => c.startsWith(GEN_MARKER_PREFIX) && !planned.has(p))
  .map(([p]) => p);

const report = {
  root,
  ...summary,
  unchanged: unchanged.length,
  writes: writes.map((w) => ({ path: w.path, action: w.action, bytes: w.bytes })),
  refused,
  stale,
  rejects: plan.rejects,
  coverage: plan.metrics.coverage,
  docs: plan.docs.map((d) => ({ path: d.path, bytes: d.bytes, sections: d.sections, isIndex: d.isIndex })),
};

if (WRITE) {
  let wrote = 0;
  for (const w of writes) {
    await writeFile(join(root, w.path), w.content, 'utf8');
    wrote += 1;
  }
  let pruned = 0;
  if (PRUNE) {
    for (const p of stale) {
      await unlink(join(root, p));
      pruned += 1;
    }
  }
  report.ok = true;
  report.wrote = wrote;
  report.pruned = pruned;
  if (AS_JSON) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`wiki-build: 写入 ${wrote} 页（未变 ${unchanged.length}）${pruned ? `，清理 ${pruned} 页` : ''}`);
    for (const w of writes) console.log(`  ${w.action === 'create' ? '+' : '~'} ${w.path} (${w.bytes} B)`);
    if (stale.length && !pruned) console.log(`  ⚠️ 过期生成页 ${stale.length} 个未清理（加 --prune 才删）：${stale.join(', ')}`);
    for (const r of refused) console.log(`  ⛔ 拒绝覆盖人工页：${r.path}`);
    for (const r of plan.rejects) console.log(`  ⊘ 未生成 ${r.page}：${r.reason} — ${r.detail}`);
  }
  process.exit(0);
}

if (CHECK) {
  const drift = writes.length > 0 || stale.length > 0;
  report.ok = !drift;
  report.drift = drift;
  if (AS_JSON) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`wiki-build --check: ${drift ? '漂移' : '已是最新'}`);
    for (const w of writes) console.log(`  ${w.action === 'create' ? '缺失' : '需更新'} ${w.path}`);
    for (const p of stale) console.log(`  过期 ${p}`);
    for (const r of plan.rejects) console.log(`  ⊘ ${r.page}：${r.reason}`);
  }
  process.exit(drift ? 1 : 0);
}

// 默认：只打印计划
report.ok = true;
report.dryRun = true;
if (AS_JSON) console.log(JSON.stringify(report, null, 2));
else {
  console.log('wiki-build（dry-run，未写盘）');
  console.log(`  语料 ${summary.corpusDocs} 篇 / ${summary.corpusBytes} B`);
  console.log(`  计划 ${summary.generatedPages} 页 / ${summary.generatedBytes} B ⇒ 占比 ${summary.corpusRatio}`);
  for (const p of summary.perPage) console.log(`    ${p.path}  ${p.bytes} B  源 ${p.sources} 篇  占比 ${p.ratio}`);
  console.log(`  待写 ${writes.length}，未变 ${unchanged.length}，拒写人工页 ${refused.length}`);
  for (const w of writes) console.log(`  ${w.action === 'create' ? '+' : '~'} ${w.path} (${w.bytes} B)`);
  for (const r of refused) console.log(`  ⛔ ${r.path}：人工页，不覆盖`);
  for (const p of stale) console.log(`  ⊘ 过期生成页 ${p}（--write --prune 清理）`);
  for (const r of plan.rejects) console.log(`  ⊘ 未生成 ${r.page}：${r.reason} — ${r.detail}`);
  const c = plan.metrics.coverage;
  console.log(`  覆盖：缺口 ${c.gapsItems} 条 / ${c.gapsSources} 篇；共享制度 ${c.citationsShared} 部`);
  if (c.tableOnlyDocs.length) {
    console.log(`  ⚠️ 有缺口/待确认小节但写成表格、抽不出条目（${c.tableOnlyDocs.length} 篇）：`);
    for (const p of c.tableOnlyDocs) console.log(`     ${p}`);
  }
  console.log('  （加 --write 才落盘）');
}
process.exit(0);
