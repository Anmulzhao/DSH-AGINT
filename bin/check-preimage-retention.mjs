#!/usr/bin/env node
// bin/check-preimage-retention.mjs —— preimage 保留期门禁（Phase 3 交付物三，Tier A）
//
// 职责：检查 .agint-preimage/ 的占用与最旧条目，**只告警不删除**。
//
// ⛔ 为什么只告警不删除（Phase 3 设计 §5.4 原文）：
//   ① 删除是不可逆动作，需人工确认
//   ② preimage 是**回滚的唯一依据**（`restoreFromPreimage` 不依赖 git，
//      见 agint-evolution-driver/lib/index.js:1264）⇒ 误删 = 永久失去该期回滚能力
//   ③ 若确需清理，走「先归档到 .agint-backups/」的可恢复路径
//
// ⭐ 保留期标准（docs/specs/evolution-package-v1.md §7.1）：≥90 天或 ≥20 期，取较长者。
//   「期」= 不同的进化批次（按时间戳去重后的批次数），不是文件数 ——
//   同一期可能备份多个文件，按文件数算会把单期算成多期。
//
// 退出码：0 = OK 或 WARN（不阻塞）；1 = 越界且处于「即将影响导出」的状态。

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PREIMAGE_DIR = join(REPO_ROOT, '.agint-preimage');

const RETENTION_DAYS = 90;
const RETENTION_PERIODS = 20;

const errors = [];
const warns = [];
const notes = [];

if (!existsSync(PREIMAGE_DIR)) {
  // 不是故障：preimage 目录是 runtime 期自动建的，还没进过化就是空的
  console.log('[check-preimage-retention] .agint-preimage/ 不存在 —— 尚未产生 preimage 备份');
  console.log('  · 这是正常状态（没跑过进化就没有备份），不是门禁失败');
  process.exit(0);
}

const files = readdirSync(PREIMAGE_DIR).filter((f) => f.endsWith('.bak'));
if (files.length === 0) {
  console.log('[check-preimage-retention] .agint-preimage/ 为空 —— 无备份可检查');
  process.exit(0);
}

/**
 * 从文件名解析原始路径与时间戳。
 *
 * 命名格式（实测）：<原路径用 __ 分隔>__<ISO 时间戳>.bak
 * 例：plugins__agint-skill-autocreate__test__x.test.mjs__2026-09-29T09-34-01-413Z.bak
 *
 * ⚠️ 时间戳里的分隔符是 `-` 不是 `:`（`05-26-53-216Z`），正则要按这个写 ——
 *    写成 `T\d{2}:\d{2}` 会一条都匹配不上，且**表现为「无法解析」而不是报错**，
 *    很容易被当成「文件格式不对」，实际是解析器写错了。
 *
 * ⭐ 用**文件名里的时间戳**而不是 mtime：mtime 会被复制/同步/检出改写，
 * 而时间戳是生成时写死的。用 mtime 会得出「备份很新」的错误结论（K49 同源）。
 */
function parseName(file) {
  const m = file.match(/^(.*)__(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.bak$/);
  if (!m) return { file, sourcePath: null, stamp: null, at: null };
  const stamp = m[2];
  // 2026-09-29T05-26-53-216Z → 2026-09-29T05:26:53.216Z
  const iso = stamp.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    '$1T$2:$3:$4.$5Z',
  );
  const at = new Date(iso);
  return {
    file,
    sourcePath: m[1].split('__').join('/'),
    stamp,
    at: Number.isNaN(at.getTime()) ? null : at,
  };
}

const entries = files.map(parseName);
const unparsed = entries.filter((e) => e.at === null);
const parsed = entries.filter((e) => e.at !== null).sort((a, b) => a.at - b.at);

/** 「期」= 不同时间戳（同一批进化会备份多个文件）。 */
const periods = new Set(parsed.map((e) => e.stamp));

let totalBytes = 0;
for (const f of files) totalBytes += statSync(join(PREIMAGE_DIR, f)).size;

const now = Date.now();
const oldest = parsed[0] ?? null;
const oldestAgeDays = oldest ? Math.floor((now - oldest.at.getTime()) / 86400000) : null;

console.log('[check-preimage-retention] preimage 保留期检查');
console.log(`  备份文件 ${files.length} 个 · 覆盖 ${periods.size} 期 · 占用 ${(totalBytes / 1024).toFixed(1)} KB`);
if (oldest) {
  console.log(`  最旧一条：${oldest.stamp}（${oldestAgeDays} 天前）${oldest.sourcePath ? ` · ${oldest.sourcePath}` : ''}`);
} else {
  console.log('  最旧一条：无法解析（文件名不符 <路径>__<ISO>.bak 格式）');
}
console.log(`  保留期标准：≥${RETENTION_DAYS} 天 或 ≥${RETENTION_PERIODS} 期（取较长者）`);

// ── 判据 ────────────────────────────────────────────────────────────────────
if (unparsed.length > 0) {
  warns.push(
    `${unparsed.length} 个文件名不符合 <路径>__<ISO>.bak 格式，无法解析期次：` +
      `${unparsed.slice(0, 3).map((e) => e.file).join(', ')}${unparsed.length > 3 ? ' …' : ''}`,
  );
}

if (oldestAgeDays !== null && oldestAgeDays > RETENTION_DAYS) {
  const over = oldestAgeDays - RETENTION_DAYS;
  warns.push(
    `最旧备份已 ${oldestAgeDays} 天，超过 ${RETENTION_DAYS} 天保留期 ${over} 天。` +
      `⚠️ 该期若要导出 R1 级包，preimage 必须还在 —— 超期不代表已丢失，但**已无回滚依据**。`,
  );
}

if (periods.size > RETENTION_PERIODS) {
  warns.push(
    `期数 ${periods.size} 超过 ${RETENTION_PERIODS} 期上界。` +
      `⚠️ 建议归档到 .agint-backups/（可恢复路径），不要直接删。`,
  );
}

// 越久越危险：超过 2 倍保留期 ⇒ 阻塞（那已经是「事实上失去回滚依据」）
if (oldestAgeDays !== null && oldestAgeDays > RETENTION_DAYS * 2) {
  errors.push(
    `最旧备份 ${oldestAgeDays} 天（> 2×${RETENTION_DAYS} 天）。` +
      `该期已实质失去回滚依据。需人工决定：归档还是接受失去。` +
      `⛔ 本门禁不会替你删除。`,
  );
}

if (oldestAgeDays !== null && periods.size > 0) {
  notes.push(
    `最早可导出的期次：${oldest.stamp}` +
      `（导出 R1 级包需要该期的 preimage；缺则该期只能降级并显式告警）`,
  );
}

for (const n of notes) console.log(`  · ${n}`);
if (warns.length > 0) {
  console.log(`\n  WARN ${warns.length} 处：`);
  for (const w of warns) console.log(`    ~ ${w}`);
  console.log('\n  ⛔ 本门禁只告警不删除（删除 preimage = 永久失去该期回滚能力，不可逆）。');
}
if (errors.length > 0) {
  console.error(`\n  ❌ ERROR ${errors.length} 处：`);
  for (const e of errors) console.error(`    ✗ ${e}`);
  process.exit(1);
}
console.log('\n  ✅ 在保留期范围内');
process.exit(0);
