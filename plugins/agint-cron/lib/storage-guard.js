/**
 * agint-cron/lib/storage-guard.js — 存储域体积 / 行数 / 日增 的每日度量（纯逻辑）。
 *
 * 为什么要有它（2026-11-12 取证）：
 *   · AGINT 有 27 个 cron job，**没有一个负责存储清理**（逐条核对，负责清理的 0 个）；
 *   · 28 项指标里**没有一项覆盖存储体积或日增**（逐条核对，覆盖存储的 0 项）；
 *   · `agint_metrics` 域 `metric` 表每次采集为每个 key put 一条**全新 uuid 行**
 *     （agint-metrics/lib/service.js），表声明无任何上限 ⇒ 实测 4624 行 / 1.59 MB 且只增不减；
 *   · `agint_trajectory` 域的 90 天 / 1800 条 / 64 MB 三重约束**早就写好了**，
 *     但接线端空着（agint-trajectory/lib/schema.js 的 PRUNE_CRON 注释自认
 *     「本版只暴露 prune()，调度由外部 cron 接」）⇒ 策略存在但永不执行。
 *
 * 本文件是**只读**的：扫目录、读 JSON、算指标。它不删任何东西、不改任何域。
 * 真正的回收在 storage-prune.js（且默认 dry-run）。
 *
 * 口径（每个数字都要能说清它是什么）：
 *   storage.bytes.<domain>      每个**存储域文件**（$DSH_HOME/storages/*.json）的字节。
 *                                剔除 `.bak-*` 与隐藏 `.tmp`（它们不是域数据）。
 *   storage.rows.<domain>.<table>  每个表的行数（域文件 tables.<table> 的键数）。
 *   storage.dailyDelta.bytes     今日快照总量 − 昨日快照总量（**首次运行只有基线，delta=0**）。
 *   storage.dailyDelta.rows      同上（行数）。
 *   storage.writeAmplification   昨日磁盘写入量 ÷ 净增量。**本版取不到写入量 ⇒ 恒为 -1**
 *                                并在 meta 里注明「不可得」（不拿别的数冒充它）。
 *   storage.events.topTopic      事件表（agint_event_bus 域 events 表）Top-N topic 与占比。
 *                                值域是 number（metric 表 value 必须是数字）⇒
 *                                value = Top-1 的条数，topic 名单与占比放 meta。
 *   storage.backup.bytes         `.bak-*` 与隐藏 `.tmp` 占用的字节。
 *
 * ⛔ **第一批 delta 必然为空/0，这是预期状态，不是故障**：净增需要「昨日快照」，
 *   首次运行只落基线、次日才有 delta。任何把首日 delta=0 判成「存储没长」的告警
 *   都是误判 —— 本文件用 meta.baseline=true 明确标出「这天的 0 是基线，不是净增」。
 */

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** per-record 事件表 topic 抽样的上限（全读 3 万个文件太慢） */
export const TOPIC_SAMPLE_FILES = 2000;

/** 存储度量快照文件名（放在 $DSH_HOME 根，不放 storages/ —— 理由见文末） */
export const SNAPSHOT_FILE = 'agint_storage_guard.json';
/** 快照保留份数：只留最近 2 天（今天 + 昨天），文件自己不许膨胀 */
export const SNAPSHOT_KEEP = 2;
/** 单文件解析上限：超过就不解析（行数记 -1），避免一个巨型域把宿主内存打爆 */
export const MAX_PARSE_BYTES = 64 * 1024 * 1024;
/** Top-N topic 的 N */
export const TOPIC_TOP_N = 5;

/**
 * 定位 DSH_HOME。
 * 优先 $DSH_HOME（宿主进程里有，见 AGENTS.local.md 的实测），退回 ~/.dsh。
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const v = env?.DSH_HOME;
  if (typeof v === 'string' && v.trim()) return v.trim();
  return join(home, '.dsh');
}

/**
 * 定位存储根。
 * @param {object} opts
 * @param {string} [opts.root] 显式覆盖（机器私有路径由配置给，不写死）
 */
export function resolveStorageRoot({ env = process.env, home = homedir(), root = null } = {}) {
  if (typeof root === 'string' && root.trim()) return root.trim();
  return join(resolveDshHome(env, home), 'storages');
}

function isBackupName(name) {
  return name.includes('.bak-');
}

function isHiddenTmp(name) {
  return name.startsWith('.') && name.endsWith('.tmp');
}

/**
 * 扫存储根：域字节 / 表行数 / 备份占用 / 事件 topic 分布。
 * 只读。任何单文件失败都记进 errors，不中断整体扫描。
 */
/**
 * 递归统计一个 per-record 布局的目录：`<dir>/<table>/<key>.json`。
 *
 * 深度固定两层（目录 → 表目录 → 记录文件），不无限递归。
 * @param {string} dirPath
 * @returns {{bytes:number, files:number, rows:number, tables:Array<{table:string,rows:number}>}}
 */
export function scanPerRecordDir(dirPath) {
  const out = { bytes: 0, files: 0, rows: 0, tables: [] };
  let tableDirs;
  try {
    tableDirs = readdirSync(dirPath, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return out;
  }
  for (const td of tableDirs) {
    const tablePath = join(dirPath, td.name);
    let files;
    try { files = readdirSync(tablePath, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.json')); }
    catch { continue; }
    let bytes = 0;
    for (const f of files) {
      try { bytes += statSync(join(tablePath, f.name)).size; } catch { /* ignore */ }
    }
    out.bytes += bytes;
    out.files += files.length;
    out.rows += files.length;
    out.tables.push({ table: td.name, rows: files.length });
  }
  return out;
}

/**
 * 抽样统计 per-record 事件表的 topic 分布（全读太慢：3 万条 = 3 万次文件读）。
 * @param {string} eventsDir
 * @param {number} limit
 */
export function sampleTopics(eventsDir, limit = 2000) {
  const counts = new Map();
  let total = 0;
  let sampled = 0;
  let files;
  try { files = readdirSync(eventsDir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.json')); }
  catch { return { topics: [], total: 0, sampled: false }; }
  for (const f of files.slice(0, limit)) {
    let doc;
    try { doc = JSON.parse(readFileSync(join(eventsDir, f.name), 'utf8')); }
    catch { continue; }
    const rec = doc?.record ?? doc;
    const topic = rec?.envelope?.topic ?? rec?.topic ?? '(unknown)';
    counts.set(topic, (counts.get(topic) ?? 0) + 1);
    sampled++;
  }
  total = files.length;
  return {
    topics: [...counts.entries()].map(([topic, count]) => ({ topic, count })).sort((a, b) => b.count - a.count),
    total,
    sampled: sampled < files.length,
  };
}

export function scanStorage(root, { now = Date.now(), maxParseBytes = MAX_PARSE_BYTES } = {}) {
  const out = {
    root,
    scannedAt: new Date(now).toISOString(),
    domains: [],
    dirs: [],
    topicsSampled: false,
    totalBytes: 0,
    domainBytes: 0,
    totalRows: 0,
    backupBytes: 0,
    backups: [],
    tmpFiles: [],
    topics: [],
    eventsTotal: 0,
    errors: [],
  };
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    out.errors.push({ file: root, error: String(error?.message ?? error) });
    return out;
  }

  for (const entry of entries) {
    // ── 目录 = per-record 布局的存储单元（2026-11-12 补）────────────────────
    //
    // ⛔ 为什么必须扫目录：event bus 已切到 per-record 布局，数据在
    // `<storages>/agint_event_bus/events/<id>.json` 这样的**目录树**里。
    // 只扫 *.json 文件 ⇒ 新布局的数据完全不被度量 ⇒ 旧的 single 文件不再增长
    // ⇒ 日增恒为 0 ⇒ **监控对新布局失明**（最坏的一类：看起来「存储没长」，
    // 实际数据在另一个地方疯长）。
    if (entry.isDirectory()) {
      const dirName = entry.name;
      const stat = scanPerRecordDir(join(root, dirName));
      if (stat.files === 0 && stat.bytes === 0) continue;
      out.totalBytes += stat.bytes;
      out.domainBytes += stat.bytes;
      out.totalRows += stat.rows;
      out.dirs.push({
        domain: dirName, dir: dirName, layout: 'per-record',
        bytes: stat.bytes, files: stat.files, rows: stat.rows, tables: stat.tables,
      });
      // 事件表 topic 分布：per-record 下每条记录一个文件，全读太慢 ⇒ 抽样
      // （上限 TOPIC_SAMPLE_FILES），并在结果里标明抽样口径，不假装是全量。
      if (dirName === 'agint_event_bus' && out.topics.length === 0) {
        const sample = sampleTopics(join(root, dirName, 'events'), TOPIC_SAMPLE_FILES);
        out.eventsTotal = sample.total;
        out.topics = sample.topics;
        out.topicsSampled = sample.sampled;
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const name = entry.name;
    const path = join(root, name);
    let st;
    try { st = statSync(path); } catch { continue; }

    if (isBackupName(name)) {
      out.backups.push({ name, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() });
      out.backupBytes += st.size;
      continue;
    }
    if (isHiddenTmp(name)) {
      out.tmpFiles.push({
        name,
        bytes: st.size,
        mtime: new Date(st.mtimeMs).toISOString(),
        ageHours: Math.round(((now - st.mtimeMs) / 3600_000) * 100) / 100,
      });
      out.backupBytes += st.size;      // 备份口径含孤儿 .tmp（任务书口径）
      continue;
    }

    // 其余常规文件计入总量（含 .jsonl 等非域文件）
    out.totalBytes += st.size;
    if (!name.endsWith('.json')) continue;

    out.domainBytes += st.size;
    const domain = name.slice(0, -'.json'.length);
    if (st.size > maxParseBytes) {
      out.domains.push({ domain, file: name, bytes: st.size, rows: -1, tables: [], parseSkipped: 'too-large' });
      out.errors.push({ file: name, error: `size ${st.size} > maxParseBytes ${maxParseBytes}（行数不可知，记 -1）` });
      continue;
    }
    let doc = null;
    try {
      doc = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      out.domains.push({ domain, file: name, bytes: st.size, rows: -1, tables: [], parseSkipped: 'malformed' });
      out.errors.push({ file: name, error: String(error?.message ?? error) });
      continue;
    }
    const unitName = typeof doc?.unit?.name === 'string' ? doc.unit.name : domain;
    const tables = [];
    let rows = 0;
    for (const [tableName, records] of Object.entries(doc?.tables ?? {})) {
      const n = records && typeof records === 'object' ? Object.keys(records).length : 0;
      tables.push({ table: tableName, rows: n });
      rows += n;
    }
    out.domains.push({ domain, unit: unitName, file: name, bytes: st.size, rows, tables });
    out.totalRows += rows;

    // 事件表 topic 分布（只对 agint_event_bus 域做，避免为它再解析一遍）
    //
    // ⚠️ 2026-11-12：若存在同名 per-record 目录，则**当前活跃布局是目录**，
    //   旧的 single 文件只是回滚备份（不再增长）⇒ topic 分布必须取自目录，
    //   否则会报出「静止的旧分布」，看起来像没变化。
    const hasPerRecordDir = existsSync(join(root, 'agint_event_bus'));
    if ((unitName === 'agint_event_bus' || domain === 'agint_event_bus') && !hasPerRecordDir) {
      const counts = new Map();
      const events = doc?.tables?.events;
      if (events && typeof events === 'object') {
        for (const rec of Object.values(events)) {
          const topic = rec?.topic ?? rec?.envelope?.topic ?? '(unknown)';
          counts.set(topic, (counts.get(topic) ?? 0) + 1);
        }
      }
      out.eventsTotal = [...counts.values()].reduce((a, b) => a + b, 0);
      out.topics = [...counts.entries()]
        .map(([topic, count]) => ({
          topic,
          count,
          share: out.eventsTotal > 0 ? Math.round((count / out.eventsTotal) * 10000) / 10000 : 0,
        }))
        .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic))
        .slice(0, TOPIC_TOP_N);
    }
  }

  out.backups.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  out.tmpFiles.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return out;
}

/** 快照的日期键（UTC 日） */
export function dayKey(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 读快照文件（不存在 ⇒ 空快照，不抛） */
export function loadSnapshot(path) {
  try {
    const raw = readFileSync(path, 'utf8');
    const doc = JSON.parse(raw);
    const snapshots = Array.isArray(doc?.snapshots) ? doc.snapshots : [];
    return { version: doc?.version ?? 1, snapshots };
  } catch {
    return { version: 1, snapshots: [] };
  }
}

/**
 * 写快照文件（只保留最近 SNAPSHOT_KEEP 份，文件自己不许膨胀）。
 * 写失败不抛 —— 调用方把它记成 skipped 原因。
 */
export function saveSnapshot(path, snapshot, { keep = SNAPSHOT_KEEP } = {}) {
  const existing = loadSnapshot(path);
  const today = snapshot.date;
  const kept = existing.snapshots
    .filter((s) => s && s.date !== today)
    .concat([snapshot])
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, keep);
  const doc = { version: 1, updatedAt: new Date().toISOString(), snapshots: kept };
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return doc;
}

/**
 * 造指标行（key / value / unit / label / meta）。
 * 固定族 5 条 + 每域 1 条 + 每表 1 条。
 */
export function buildGuardMetrics({ scan, previous = null, today = null }) {
  const metrics = [];
  const baseline = !previous;
  const windowDays = previous && previous.date && today
    ? Math.max(1, Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(previous.date + 'T00:00:00Z')) / 86_400_000))
    : 0;
  const deltaMeta = {
    baseline,
    windowDays,
    previousDate: previous?.date ?? null,
    note: baseline
      ? '首次运行：只落基线，昨日快照不存在 ⇒ delta 恒为 0（预期状态，不是故障）'
      : '今日快照 − 昨日快照',
  };

  for (const d of scan.domains ?? []) {
    metrics.push({
      key: `storage.bytes.${d.domain}`,
      value: d.bytes,
      unit: 'bytes',
      label: `存储域 ${d.domain} 体积`,
      meta: { file: d.file, rows: d.rows, parseSkipped: d.parseSkipped ?? null },
    });
    for (const t of d.tables ?? []) {
      metrics.push({
        key: `storage.rows.${d.domain}.${t.table}`,
        value: t.rows,
        unit: 'count',
        label: `存储表 ${d.domain}.${t.table} 行数`,
        meta: { file: d.file },
      });
    }
  }

  // per-record 布局的目录（2026-11-12 补）：单独归口，不与同名 .json 文件的
  // 指标 key 冲突（同一个 domain 名可能同时存在 single 旧文件与 per-record 目录）。
  for (const d of scan.dirs ?? []) {
    metrics.push({
      key: `storage.bytes.perrecord.${d.domain}`,
      value: d.bytes,
      unit: 'bytes',
      label: `per-record 目录 ${d.domain} 体积`,
      meta: { dir: d.dir, layout: 'per-record', files: d.files, rows: d.rows },
    });
    for (const t of d.tables ?? []) {
      metrics.push({
        key: `storage.rows.perrecord.${d.domain}.${t.table}`,
        value: t.rows,
        unit: 'count',
        label: `per-record 表 ${d.domain}.${t.table} 行数`,
        meta: { dir: d.dir, layout: 'per-record' },
      });
    }
  }
  // 事件表的**活跃**行数：per-record 目录里的文件数才是当前布局的真实行数
  // （旧的 single 文件是回滚备份，不再增长 —— 拿它算行数会高估且不再变化）。
  const activeEvents = (scan.dirs ?? []).find((d) => d.domain === 'agint_event_bus');
  if (activeEvents) {
    const ev = (activeEvents.tables ?? []).find((t) => t.table === 'events');
    metrics.push({
      key: 'storage.events.activeRows',
      value: ev?.rows ?? 0,
      unit: 'count',
      label: '事件表活跃行数（per-record 当前布局）',
      meta: { layout: 'per-record', dir: activeEvents.dir, note: '旧的 single 文件是回滚备份，不再增长' },
    });
  }

  metrics.push({
    key: 'storage.dailyDelta.bytes',
    value: baseline ? 0 : (scan.totalBytes - (previous?.totalBytes ?? 0)),
    unit: 'bytes',
    label: '存储净增字节（今日 − 昨日）',
    meta: deltaMeta,
  });
  metrics.push({
    key: 'storage.dailyDelta.rows',
    value: baseline ? 0 : (scan.totalRows - (previous?.totalRows ?? 0)),
    unit: 'count',
    label: '存储净增行数（今日 − 昨日）',
    meta: deltaMeta,
  });
  metrics.push({
    key: 'storage.writeAmplification',
    value: -1,
    unit: 'ratio',
    label: '写放大（昨日写入量 ÷ 净增字节）',
    // ⛔ 取不到磁盘写入量就写 -1 并说明，**不拿别的数冒充它**（measure-before-quota：
    //   分母/分子口径没定义清楚时，宁可留空也不要造一个假指标）。
    meta: {
      unavailable: true,
      note: '磁盘写入量不可测（宿主未暴露写放大计数）⇒ -1 表示「未取到」，不是「放大倍数为 -1」',
    },
  });
  metrics.push({
    key: 'storage.events.topTopic',
    value: scan.topics?.[0]?.count ?? 0,
    unit: 'count',
    label: '事件表 Top-1 topic 条数（名单见 meta.top）',
    meta: {
      total: scan.eventsTotal ?? 0,
      top: scan.topics ?? [],
      note: 'metric 表 value 必须是数字 ⇒ value=Top-1 条数；topic 名单与占比在 meta.top',
    },
  });
  metrics.push({
    key: 'storage.backup.bytes',
    value: scan.backupBytes ?? 0,
    unit: 'bytes',
    label: '备份与孤儿临时文件占用（.bak-* + 隐藏 .tmp）',
    meta: {
      bakCount: scan.backups?.length ?? 0,
      bakBytes: (scan.backups ?? []).reduce((a, b) => a + b.bytes, 0),
      tmpCount: scan.tmpFiles?.length ?? 0,
      tmpBytes: (scan.tmpFiles ?? []).reduce((a, b) => a + b.bytes, 0),
    },
  });

  return metrics;
}

/** 快照的紧凑形态（只存能算 delta 的量，文件自己有上限） */
export function toSnapshot(scan, { now = Date.now() } = {}) {
  const domains = {};
  const tables = {};
  for (const d of scan.domains ?? []) {
    domains[d.domain] = d.bytes;
    for (const t of d.tables ?? []) tables[`${d.domain}.${t.table}`] = t.rows;
  }
  return {
    date: dayKey(now),
    takenAt: new Date(now).toISOString(),
    totalBytes: scan.totalBytes ?? 0,
    domainBytes: scan.domainBytes ?? 0,
    totalRows: scan.totalRows ?? 0,
    backupBytes: scan.backupBytes ?? 0,
    domains,
    tables,
  };
}
