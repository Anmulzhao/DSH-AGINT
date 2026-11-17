/**
 * agint-event-bus/lib/migrate.js —— single 布局 → per-record 布局的迁移与补迁。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * dsh 的 `single` 布局每次 `put` 都**整份原子重写文件**
 * （@deepseek-ai/dsh-storage-json/lib/index.js:166-170）。event bus 的
 * events 表已涨到 28.6 MB / 3 万余行 ⇒ 每次写事件都重写 28.6 MB。
 * 本机实测（/tmp/agint_bloat/scale_bench.mjs，单条 630 B）：
 *
 *   |  N   | single 每条写 | per-record 每条写 |
 *   |  300 |   11.57 ms    |     7.69 ms       |
 *   | 3000 |   26.08 ms    |     4.76 ms       |
 *   | 6000 |   34.79 ms    |     6.51 ms       |
 *
 * single 的每条写成本随规模**线性增长**（11.6 → 34.8 ms），per-record 恒定。
 * 生产规模（3 万余行）外推：每条写 45 ms → 6.5 ms（7×），
 * 日磁盘写入 18.3 GB → 约 1.2 MB。
 *
 * 切换方式**不改 dsh 源码**（改 node_modules 是 AGINT 明令禁止的越界，且会被
 * npm 升级静默覆盖，见 patches/dsh-builtin-toggles/README.md 2026-10-21 老板令），
 * 而是靠域声明的 `layout` 字段（DomainSpec.layout，dsh-storage-domain
 * lib/types/spec.d.ts:43；defineDomain lib/index.js:65-68 透传）。
 *
 * ── 两个必须做对的细节 ──────────────────────────────────────────────────────
 * ① **单记录文档格式**：`{ version, record }`，序列化用
 *    `JSON.stringify({version, record}, null, 2)` + 尾部 '\n'
 *    （dsh-storage-json 的 serializeRecord / parseRecord）。本机用**生产真实
 *    事件**写入再用 dsh 的 loadAll() 读回，逐字节一致。
 *
 * ② **补迁必须在 domain open() 之前完成**：dsh 的 domain 在 open() 时做一次
 *    loadAll() 把介质读进内存，之后内存与磁盘不再自动同步（只有 put/delete
 *    更新两边）。若在切换**之后**补迁，会造成「文件里有、内存里没有」的分叉：
 *    那些事件在读侧（deliveryHistory 等）查不到，prune 也删不到它们。
 *    ⇒ 插件在 open 之前 await 一次补迁，让 loadAll 读到完整数据。
 *
 * ── 水位线 ──────────────────────────────────────────────────────────────────
 * 补迁必须幂等：反复运行不能重复写、不能覆盖更新的数据。用水位线文件记录
 * 「已迁到哪」：已迁记录的最大 occurredAt + 源文件的 mtime/size。
 * 源文件 mtime/size 与水位线一致 ⇒ 没有新事件 ⇒ 直接跳过（避免每次启动
 * 都重读 28.6 MB 旧文件）。
 *
 * 本模块被**两处**共用：插件的启动前补迁、一次性迁移脚本。
 * 两处共用同一份实现，避免行为漂移。
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, statSync,
  renameSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

/** 存储域名（= 域声明的 name） */
export const UNIT_NAME = 'agint_event_bus';
/** single 布局的介质：<storages>/agint_event_bus.json */
export const SINGLE_FILE = 'agint_event_bus.json';
/** per-record 布局的介质：<storages>/agint_event_bus/ 目录 */
export const PER_RECORD_DIR = 'agint_event_bus';
/** 水位线文件：<storages>/agint_event_bus_migration.json */
export const WATERMARK_FILE = 'agint_event_bus_migration.json';
/** per-record 布局下的表目录名 */
export const EVENTS_TABLE_DIR = 'events';

/**
 * 推导存储根：优先 $DSH_HOME，退回 ~/.dsh。
 * ⚠️ 不要写死绝对路径 —— AGENT 守则明确两台机器路径不同（Linux / Windows）。
 * @param {object} [env]
 * @param {string} [home]
 * @returns {string|null}
 */
export function resolveStoragesRoot(env = process.env, home = process.env.HOME) {
  const base = env?.DSH_HOME || (home ? join(home, '.dsh') : '');
  return base ? join(base, 'storages') : null;
}

/**
 * per-record 单记录文档的序列化（与 dsh 的 serializeRecord 一致）。
 * @param {unknown} record
 * @returns {string}
 */
export function serializePerRecord(record) {
  return `${JSON.stringify({ version: 1, record }, null, 2)}\n`;
}

/**
 * 读 single 布局文件的 events 表。
 * @param {string} singlePath
 * @returns {Array<{key:string,value:object,occurredAt:string}>}
 */
export function readSingleEvents(singlePath) {
  if (!existsSync(singlePath)) return [];
  let doc;
  try {
    doc = JSON.parse(readFileSync(singlePath, 'utf8'));
  } catch {
    return [];
  }
  const table = doc?.tables?.events ?? {};
  return Object.entries(table).map(([key, value]) => ({
    key,
    value,
    occurredAt: String(value?.envelope?.occurredAt ?? value?.occurredAt ?? ''),
  }));
}

/**
 * 读水位线。
 * @param {string} path
 * @returns {{lastOccurredAt:string, sourceMtime:number, sourceSize:number, migrated:number}|null}
 */
export function readWatermark(path) {
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    if (!doc || typeof doc !== 'object') return null;
    return {
      lastOccurredAt: String(doc.lastOccurredAt ?? ''),
      sourceMtime: Number(doc.sourceMtime ?? 0),
      sourceSize: Number(doc.sourceSize ?? 0),
      migrated: Number(doc.migrated ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * 写水位线（原子写：临时文件 + rename）。
 * @param {string} path
 * @param {object} data
 */
export function writeWatermark(path, data) {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  // 原子替换：先删旧再改名（POSIX rename 覆盖原子，但 node 的 renameSync 在
  // Windows 上不能覆盖已存在文件 ⇒ 显式删旧再改名）
  try { unlinkSync(path); } catch { /* ignore */ }
  renameSync(tmp, path);
}

/**
 * 规划迁移：哪些记录要迁、哪些跳过、为什么。
 *
 * 规则：
 *  - **只迁保留窗口内**的记录（默认 30 天）：窗口外的老记录在切换后就不存在了，
 *    本来也要被保留策略清掉，没必要搬。
 *  - 已有水位线时，只迁 `occurredAt > watermark.lastOccurredAt` 的（幂等）。
 *  - 源文件 mtime/size 与水位线一致 ⇒ 无新增 ⇒ 整体跳过（省掉每次启动重读 28.6 MB）。
 *
 * @param {object} args
 * @param {string} args.singlePath
 * @param {object|null} args.watermark
 * @param {number} [args.maxAgeDays=30]
 * @param {number} [args.now]
 * @returns {{entries:Array, totalRows:number, staleRows:number, alreadyMigrated:number, unchanged:boolean}}
 */
export function planMigration({ singlePath, watermark = null, maxAgeDays = 30, now = Date.now() }) {
  let st = null;
  try { st = statSync(singlePath); } catch { /* 不存在 */ }
  const all = readSingleEvents(singlePath);
  const cutoff = now - maxAgeDays * 86_400_000;

  const unchanged = Boolean(
    watermark && st
    && watermark.sourceMtime === st.mtimeMs
    && watermark.sourceSize === st.size,
  );

  const entries = [];
  let staleRows = 0;
  let alreadyMigrated = 0;
  for (const row of all) {
    const ts = Date.parse(row.occurredAt);
    if (!Number.isFinite(ts) || ts < cutoff) { staleRows++; continue; }   // 窗口外：不清迁
    if (watermark && watermark.lastOccurredAt && row.occurredAt <= watermark.lastOccurredAt) {
      alreadyMigrated++;
      continue;
    }
    entries.push(row);
  }
  return { entries, totalRows: all.length, staleRows, alreadyMigrated, unchanged };
}

/**
 * 执行迁移（把计划中的记录写成 per-record 单记录文档）。
 *
 * @param {object} args
 * @param {string} args.storageRoot 存储根（<storages>）
 * @param {number} [args.maxAgeDays=30]
 * @param {boolean} [args.dryRun=true]  true = 只算不写
 * @param {number} [args.now]
 * @returns {{migrated:number, skipped:number, failed:number, bytes:number, dryRun:boolean,
 *            watermarkPath:string, lastOccurredAt:string, unchanged:boolean, totalRows:number}}
 */
export function applyMigration({
  storageRoot, maxAgeDays = 30, dryRun = true, now = Date.now(),
}) {
  const singlePath = join(storageRoot, SINGLE_FILE);
  const eventsDir = join(storageRoot, PER_RECORD_DIR, EVENTS_TABLE_DIR);
  const watermarkPath = join(storageRoot, WATERMARK_FILE);

  const watermark = readWatermark(watermarkPath);
  const plan = planMigration({ singlePath, watermark, maxAgeDays, now });

  if (plan.unchanged && plan.entries.length === 0) {
    return {
      migrated: 0,
      planned: 0,
      skipped: plan.alreadyMigrated,
      staleRows: plan.staleRows,
      failed: 0,
      bytes: 0,
      dryRun,
      watermarkPath,
      lastOccurredAt: watermark?.lastOccurredAt ?? '',
      unchanged: true,
      totalRows: plan.totalRows,
    };
  }

  let migrated = 0;
  let failed = 0;
  let bytes = 0;
  let lastOccurredAt = watermark?.lastOccurredAt ?? '';
  // planned = 计划迁入的条数（dry-run 与真跑都一样算，避免 dry-run 报 0 的假象）
  const planned = plan.entries.length;
  if (!dryRun) {
    mkdirSync(eventsDir, { recursive: true });
    for (const row of plan.entries) {
      try {
        const text = serializePerRecord(row.value);
        writeFileSync(join(eventsDir, `${row.key}.json`), text, 'utf8');
        migrated++;
        bytes += Buffer.byteLength(text, 'utf8');
        if (row.occurredAt > lastOccurredAt) lastOccurredAt = row.occurredAt;
      } catch {
        failed++;
      }
    }
    let st = null;
    try { st = statSync(singlePath); } catch { /* ignore */ }
    writeWatermark(watermarkPath, {
      lastOccurredAt,
      sourceMtime: st?.mtimeMs ?? 0,
      sourceSize: st?.size ?? 0,
      migrated: (watermark?.migrated ?? 0) + migrated,
      updatedAt: new Date(now).toISOString(),
      note: 'single→per-record 迁移水位线；补迁只处理 occurredAt > lastOccurredAt 的记录',
    });
  } else {
    for (const row of plan.entries) {
      bytes += Buffer.byteLength(serializePerRecord(row.value), 'utf8');
      if (row.occurredAt > lastOccurredAt) lastOccurredAt = row.occurredAt;
    }
  }

  return {
    migrated,
    planned,
    skipped: plan.alreadyMigrated,
    staleRows: plan.staleRows,
    failed,
    bytes,
    dryRun,
    watermarkPath,
    lastOccurredAt,
    unchanged: false,
    totalRows: plan.totalRows,
  };
}
