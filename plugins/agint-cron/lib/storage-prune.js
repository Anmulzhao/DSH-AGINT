/**
 * agint-cron/lib/storage-prune.js — 存储回收（周任务，默认 dry-run）。
 *
 * 三件事（AGINT 侧此前**一件都没做**）：
 *   ① 调各域自带的 prune 能力（trajectory / eventBus / metrics / toolStats /
 *      skillAutocreate）—— 缺席就跳过，**记下跳过原因**，绝不报错中断；
 *   ② 一次性存量回收：`.bak-*` 只留最近 1 份（其余先打包 tar.gz 归档到
 *      `$DSH_HOME/.agint-backups/`，再删中间份）；
 *   ③ 清理孤儿 `.tmp`（mtime 早于 24 小时；活跃写入的 tmp 一定是刚产生的）。
 *
 * ⛔ **默认 dry-run = true**，理由（老板 2026-11-12 倾向，本实现采纳）：
 *   这个 job 是**无人值守**的定时任务，而删除是不可逆动作。默认真删意味着
 *   「某天配置错了 / 某个 tmp 其实还在用 / 某个 bak 是唯一的备份」都会在
 *   没人盯着的时候发生，且**没有回滚**。默认 dry-run 把「不可逆」变成
 *   「显式传 { dryRun: false } 才发生」—— 破坏性动作必须由人显式开一次。
 *   代价（诚实记下）：默认档下存量回收永远不落地，需要人工/配置开一次 apply；
 *   这比「悄悄删掉生产备份」安全得多。
 *
 * 每个步骤都 try/catch：单步失败不许中断整体（周任务跑一半崩掉，比少清一点更糟）。
 */

import { readdirSync, statSync, unlinkSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { gzipSync } from 'node:zlib';

/** 每个域文件保留几份 .bak-*（其余归档后删除） */
export const KEEP_BACKUPS_PER_DOMAIN = 1;
/** 孤儿 .tmp 的判定阈值（小时） */
export const TMP_MAX_AGE_HOURS = 24;
/**
 * 「一次性 apply」标记文件：放在**存储根的上一级**（与 storage-guard 的快照同层）。
 *
 * 为什么需要它：storage-prune 是**无人值守**的定时任务，删除不可逆 ⇒ 默认 dry-run。
 * 但老板批准的一次性存量回收（80 份 .bak 快照 84.5 MB + 11 个孤儿 .tmp 19.4 MB）
 * 需要真跑一次。若为此改配置再重启一次，代价是一次多余的宿主重启；而「改配置」
 * 这种一次性开关也容易留在配置里忘了关（⇒ 长期真删，无人值守）。
 *
 * ⇒ 用标记文件表达「这一次例外」：标记存在 → 本次 apply（真删）→ 执行完**删掉标记**
 * ⇒ 自动回到 dry-run。语义明确、不会遗留、不需要重启。
 */
export const APPLY_ONCE_MARKER = 'agint_storage_prune_apply_once';

/**
 * 是否存在「一次性 apply」标记。
 * @param {string} markerPath
 * @returns {boolean}
 */
export function hasApplyOnceMarker(markerPath) {
  try { return existsSync(markerPath); } catch { return false; }
}

function listFiles(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * 从 `.bak-YYYYMMDD-HHMMSS` 文件名里解析排序用的时间戳。
 * @param {string} name
 * @returns {number} 毫秒时间戳；解析不到返回 NaN
 */
export function backupStamp(name) {
  const m = /\.bak-(\d{8})-(\d{6})/.exec(name);
  if (!m) return NaN;
  const t = Date.parse(`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4, 6)}Z`);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * 规划 .bak-* 回收：每个域文件只保留**最近 1 份**，其余进归档候选。
 *
 * ⚠️ 排序判据是**文件名里的时间戳**（`.bak-YYYYMMDD-HHMMSS`），不是文件 mtime：
 *   mtime 会因复制、恢复、rsync 而改变 ⇒ 同一批备份的 mtime 可能相同或错乱
 *   （本机实测：一次创建的两个备份 mtime 落在同一毫秒 ⇒ 按 mtime 排序不稳定，
 *   「保留最近一份」变成随机的）。文件名里的时间戳是备份自己的身份，稳定可预期。
 *   文件名解析不到时间戳时才退回 mtime。
 *
 * @returns {Array<{base:string, keep:string[], archive:Array<{name,path,bytes,mtime}>}>}
 */
export function planBackupCleanup(root, { keepPerDomain = KEEP_BACKUPS_PER_DOMAIN } = {}) {
  const plan = [];
  const groups = new Map();
  for (const name of listFiles(root)) {
    if (!name.includes('.bak-')) continue;
    const base = name.slice(0, name.indexOf('.bak-'));
    let st;
    try { st = statSync(join(root, name)); } catch { continue; }
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push({
      name, path: join(root, name), bytes: st.size, mtime: st.mtimeMs,
      stamp: backupStamp(name),
    });
  }
  for (const [base, list] of groups) {
    list.sort((a, b) => {
      const sa = Number.isFinite(a.stamp) ? a.stamp : a.mtime;
      const sb = Number.isFinite(b.stamp) ? b.stamp : b.mtime;
      if (sa !== sb) return sb - sa;                 // 新的在前
      return b.mtime - a.mtime;                     // 同一时刻 ⇒ 用 mtime 兜底
    });
    plan.push({
      base,
      keep: list.slice(0, keepPerDomain).map((f) => f.name),
      archive: list.slice(keepPerDomain),
    });
  }
  return plan;
}

/**
 * 规划孤儿 .tmp 清理：隐藏 + .tmp 后缀 + mtime 早于 maxAgeHours。
 * @returns {Array<{name,path,bytes,mtime,ageHours}>}
 */
export function planTmpCleanup(root, { maxAgeHours = TMP_MAX_AGE_HOURS, now = Date.now() } = {}) {
  const cutoff = now - maxAgeHours * 3600_000;
  const out = [];
  for (const name of listFiles(root)) {
    if (!name.startsWith('.') || !name.endsWith('.tmp')) continue;
    let st;
    try { st = statSync(join(root, name)); } catch { continue; }
    if (st.mtimeMs >= cutoff) continue;            // 活跃写入的 tmp 一定是刚产生的
    out.push({
      name,
      path: join(root, name),
      bytes: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      ageHours: Math.round(((now - st.mtimeMs) / 3600_000) * 100) / 100,
    });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** ustar 头（512 字节） */
function tarHeader(name, size, mtimeSec) {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100, 'utf8');
  buf.write('0000600\0', 100, 8, 'utf8');
  buf.write('0000000\0', 108, 8, 'utf8');
  buf.write('0000000\0', 116, 8, 'utf8');
  buf.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  buf.write(`${Math.floor(mtimeSec).toString(8).padStart(11, '0')}\0`, 136, 12, 'utf8');
  buf.write('        ', 148, 8, 'utf8');            // checksum 占位
  buf.write('0', 156, 1, 'utf8');                    // typeflag '0' = 普通文件
  buf.write('ustar\0', 257, 6, 'utf8');
  buf.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return buf;
}

/**
 * 打一个 tar.gz（纯 node 实现，不依赖系统 tar —— Windows/macOS 都能跑）。
 * @param {Array<{name:string, path:string}>} files
 * @returns {Buffer}
 */
export function buildTarGz(files) {
  const chunks = [];
  for (const f of files) {
    let content;
    try { content = readFileSync(f.path); } catch { continue; }
    chunks.push(tarHeader(f.name, content.length, Date.now() / 1000));
    chunks.push(content);
    const pad = (512 - (content.length % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));                    // 两个空块 = tar 结束标记
  return gzipSync(Buffer.concat(chunks));
}

/**
 * 执行 .bak-* 归档 + 删除。
 * @param {object} opts
 * @param {boolean} opts.dryRun true ⇒ 只算不落盘
 * @param {string} opts.backupDir 归档目录
 * @returns {{archivePath:string|null, archived:string[], deleted:string[], bytes:number, dryRun:boolean}}
 */
export function applyBackupArchive(plan, { backupDir, dryRun = true, now = Date.now() } = {}) {
  const toArchive = plan.flatMap((g) => g.archive);
  const bytes = toArchive.reduce((a, f) => a + f.bytes, 0);
  if (toArchive.length === 0) {
    return { archivePath: null, archived: [], deleted: [], bytes: 0, dryRun };
  }
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const archivePath = join(backupDir, `storages-bak-${stamp}.tar.gz`);
  if (dryRun) {
    return {
      archivePath,
      archived: toArchive.map((f) => f.name),
      deleted: [],
      bytes,
      dryRun: true,
    };
  }
  mkdirSync(backupDir, { recursive: true });
  const gz = buildTarGz(toArchive);
  writeFileSync(archivePath, gz);
  const deleted = [];
  for (const f of toArchive) {
    try {
      unlinkSync(f.path);
      deleted.push(f.name);
    } catch { /* 单个删不掉不阻断：归档已经落盘，数据不丢 */ }
  }
  return { archivePath, archived: toArchive.map((f) => f.name), deleted, bytes, dryRun: false };
}

/** 执行孤儿 .tmp 删除 */
export function applyTmpCleanup(plan, { dryRun = true } = {}) {
  const bytes = plan.reduce((a, f) => a + f.bytes, 0);
  if (dryRun) return { deleted: [], bytes, dryRun: true, candidates: plan.map((f) => f.name) };
  const deleted = [];
  for (const f of plan) {
    try {
      unlinkSync(f.path);
      deleted.push(f.name);
    } catch { /* ignore */ }
  }
  return { deleted, bytes, dryRun: false };
}

/** 一步的 skip/ok 记录（skip 必须写清「缺什么」） */
function skipped(step, reason) {
  return { step, status: 'skipped', reason };
}

/**
 * 跑一遍存储回收。
 *
 * @param {object} args
 * @param {object} args.services cron 的 services 快照（白名单）
 * @param {string} args.storageRoot 存储根
 * @param {boolean} [args.dryRun=true]
 * @param {string} [args.backupDir]
 * @returns {Promise<object>} 汇总（steps[] + files 段）
 */
export async function runStoragePrune({
  services = {}, storageRoot, dryRun = true, backupDir = null, now = Date.now(),
  tmpMaxAgeHours = undefined,
} = {}) {
  const steps = [];

  // ① 各域自带 prune —— 缺席是常态（eventBus/toolStats/skillAutocreate 至今
  //    没有提供 prune 能力），跳过并记原因，绝不报错。
  const pruneSteps = [
    ['trajectory', 'agint.trajectory.prune'],
    ['eventBus', 'agint.eventBus.prune'],
    ['metrics', 'agint.metrics.prune'],
    ['toolStats', 'agint.toolStats.prune'],
    ['skillAutocreate', 'agint.skillAutocreate.prunePatterns'],
  ];
  for (const [name, key] of pruneSteps) {
    const fn = services?.[key];
    if (typeof fn !== 'function') {
      steps.push(skipped(name, `${key} not available（服务缺席是常态）`));
      continue;
    }
    try {
      const r = await fn({ dryRun });
      steps.push({ step: name, status: 'ok', removed: r?.removed ?? 0, kept: r?.kept ?? null, detail: r ?? null });
    } catch (error) {
      steps.push({ step: name, status: 'error', reason: String(error?.message ?? error) });
    }
  }

  // ② 存量回收：.bak-* 归档 + 孤儿 .tmp
  const files = { backups: null, tmp: null, errors: [] };
  try {
    const backupPlan = planBackupCleanup(storageRoot);
    const tmpPlan = planTmpCleanup(storageRoot, { now, maxAgeHours: tmpMaxAgeHours ?? TMP_MAX_AGE_HOURS });
    const dir = backupDir ?? join(dirname(storageRoot), '.agint-backups');
    const applied = applyBackupArchive(backupPlan, { backupDir: dir, dryRun, now });
    const tmpApplied = applyTmpCleanup(tmpPlan, { dryRun });
    files.backups = {
      archivePath: applied.archivePath,
      archived: applied.archived,
      deleted: applied.deleted,
      bytes: applied.bytes,
      keepPerDomain: KEEP_BACKUPS_PER_DOMAIN,
      groups: backupPlan.map((g) => ({ base: g.base, keep: g.keep, archiveCount: g.archive.length })),
    };
    files.tmp = {
      deleted: tmpApplied.deleted,
      candidates: tmpPlan.map((f) => f.name),
      bytes: tmpApplied.bytes,
      maxAgeHours: TMP_MAX_AGE_HOURS,
    };
  } catch (error) {
    files.errors.push(String(error?.message ?? error));
  }

  return {
    dryRun,
    steps,
    files,
    totalFreedBytes: (files.backups?.bytes ?? 0) + (files.tmp?.bytes ?? 0),
  };
}
