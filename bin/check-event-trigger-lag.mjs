#!/usr/bin/env node
/**
 * bin/check-event-trigger-lag.mjs —— 事件触发链路终态滞后门禁
 * （2026-11-12，评估报告 §七：「每步都要配一条『事件发出后 N 分钟内
 *   下游有终态记录』的 check」，§4.2：「失败也要发终态事件」）
 *
 * 步骤 1 的两条快路径：
 *   input.signal.host.skills-change → curator-weekly（完整 run）
 *   curator.run-completed(dryRun:false) → evolve-review
 * 本门禁只核第一段：触发事件发出后 N 分钟内，下游必须留下**终态记录**
 * （curator.run-completed 成功 / curator.run-failed 失败都算）。
 * 只发成功事件会让链静默断在半路，所以失败终态同样计入。
 *
 * ⛔ 口径边界（防假绿，必须照此措辞）：
 *   - 判据是**时间邻近**，不是因果证明。cron 兜底恰好落在窗口内的
 *     curator.run-completed 也会计入 ⇒ `OK` 不等于「事件桥确实跑过」。
 *     要证明通电，另看 eventTrigger.status() 与终态事件的 payload.trigger
 *     （2026-11-12 起事件触发写 `event:<topic>`，cron 写 `cron:curator-weekly`）。
 *   - 窗口内 0 条触发事件 ⇒ `NO_TRIGGER_EVENTS` + verified:false：
 *     **不判绿也不判红**，明确「链路未通电 / 窗口内无流量」。
 *   - 未部署事件桥时实跑大概率 `TERMINAL_MISSING`（真缺口，不是脚本 bug）。
 *
 * ⛔ 双数据源（2026-11-12 重启后新增，这是本脚本最容易被悄悄废掉的地方）：
 *   生产 `agint_event_bus` 域已由 **single 布局**切到 **per-record 布局**
 *   （`storages/agint_event_bus/events/<uuid>.json`，消除每次写整份重写
 *   28.6MB 的写放大）。旧 `storages/agint_event_bus.json` 从此**冻结在迁移
 *   水位线**，不再更新。只认旧文件 ⇒ 最近 24h 永远读到 0 条 ⇒ 静默假绿。
 *   因此默认同时读两处、按 `envelope.id` 合并去重；报告里显式列出每个
 *   数据源的条数，让「看见了什么」可被核对。
 *   迁移水位线见 `storages/agint_event_bus_migration.json`（只搬 30 天窗口，
 *   更早的历史仍只在旧 JSON 里 ⇒ 不能只取新目录）。
 *
 * ⛔ 开关生效基线（2026-11-12 补，验收遗留 2）：
 *   事件桥在 `docs/event-trigger-activation.json` 记录的时刻才通电。此前窗口
 *   里的历史触发本来就没有任何事件桥可指望，把它们算进 verdict 会让门禁
 *   **永远红在历史欠账上**，反而淹没「生效之后链路是否健康」这个真问题。
 *   基线只做「分离 + 如实计数」，不是放宽判据：
 *     - 生效前触发 → `preActivation.{triggerCount, missingCount, ...}`，
 *       不进 missing、不进 matched、不影响 verdict；欠账数字仍原样可见，
 *       没被删除也没被改写。
 *     - **windowMin / 时间邻近配对 / 失败终态口径一个都不改**。
 *     - 生效后窗口内 0 条触发 ⇒ 仍 `NO_TRIGGER_EVENTS` + `verified:false`
 *       （⛔ 最关键的反假绿护栏：过滤不能把「没流量」变成「全绿」）。
 *     - `--no-baseline` 随时复现旧的全量严格口径；`--effective-from` 可临时覆盖。
 *   ⛔ 不许为了让门禁转绿而前移 `activatedAt`，见基线文件 maintenance 字段。
 *
 * 用法：
 *   node bin/check-event-trigger-lag.mjs                 # 默认最近 24h，双源 + 生效基线
 *   node bin/check-event-trigger-lag.mjs --since 2026-11-12T00:00:00Z
 *   node bin/check-event-trigger-lag.mjs --window-min 60 --json
 *   node bin/check-event-trigger-lag.mjs --no-baseline  # 复现全量严格口径
 *   node bin/check-event-trigger-lag.mjs --effective-from 2026-11-12T04:15:38.852Z
 *   node bin/check-event-trigger-lag.mjs --storage <path>              # 离线单源
 *   node bin/check-event-trigger-lag.mjs --storage <path> --record-dir <dir>
 * 退出码：0 = OK / NO_TRIGGER_EVENTS，1 = TERMINAL_MISSING，2 = 脚本自身出错
 *
 * 零依赖：只用 node:fs / node:path / node:url。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const TRIGGER_TOPIC = 'input.signal.host.skills-change';
export const TERMINAL_TOPICS = Object.freeze(['curator.run-completed', 'curator.run-failed']);
export const DEFAULT_WINDOW_MIN = 30;
export const DEFAULT_DAYS = 1;
const BUS_REL = join('storages', 'agint_event_bus.json');
const BUS_DIR_REL = join('storages', 'agint_event_bus');
export const RECORD_SUBDIR = 'events';
/** 默认基线文件：相对本脚本定位，不依赖 cwd / DSH_HOME。 */
export const ACTIVATION_FILE = fileURLToPath(
  new URL('../docs/event-trigger-activation.json', import.meta.url),
);

/**
 * 把一条落盘记录归一成判据用的形状。
 * ⚠️ 兼容三种形状：
 *   ① 旧 single 表的存量行（顶层 topic / occurredAt）
 *   ② 新 single 表精简行 { envelope, deliveries }
 *   ③ per-record 文件 { version, record: { envelope, deliveries } }
 * `id` 用于跨源去重；取不到就留 null（此时合并时**不去重**，宁可重复计数，
 * 也不能把两条同毫秒的技能变更误合并成一条 ⇒ 那是漏报，等于假绿）。
 */
function normalizeRow(r) {
  if (!r || typeof r !== 'object') return null;
  const env = r.envelope && typeof r.envelope === 'object' ? r.envelope : r;
  const topic = typeof env.topic === 'string' ? env.topic : null;
  const occurredAt = typeof env.occurredAt === 'string' ? env.occurredAt : null;
  if (!topic || !occurredAt || Number.isNaN(Date.parse(occurredAt))) return null;
  return {
    id: typeof env.id === 'string' ? env.id : null,
    topic,
    occurredAt,
    ts: Date.parse(occurredAt),
    payload: env.payload ?? null,
  };
}

/** 从 single 布局的事件总线存储 JSON 抽事件。 */
export function collectEvents(raw) {
  const tbl = raw?.tables?.events ?? raw?.events ?? raw;
  const rows = Array.isArray(tbl)
    ? tbl
    : Object.values(tbl && typeof tbl === 'object' ? tbl : {});
  const out = [];
  for (const r of rows) {
    const e = normalizeRow(r);
    if (e) out.push(e);
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** 从 per-record 布局目录抽事件；目录不存在时如实返回 available:false。 */
export function collectRecordDir(dir) {
  const eventsDir = join(dir, RECORD_SUBDIR);
  let names;
  try {
    names = readdirSync(eventsDir).filter((n) => n.endsWith('.json'));
  } catch (e) {
    return {
      events: [], fileCount: 0, errors: 0, dir: eventsDir,
      available: false, error: e?.message ?? String(e),
    };
  }
  const out = [];
  let errors = 0;
  for (const n of names) {
    try {
      const parsed = JSON.parse(readFileSync(join(eventsDir, n), 'utf8'));
      const e = normalizeRow(parsed?.record ?? parsed);
      if (e) out.push(e);
    } catch {
      errors += 1; // 单个坏文件不阻断整轮；errors 会在报告里显形
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return { events: out, fileCount: names.length, errors, dir: eventsDir, available: true };
}

/** 跨源合并：有 envelope.id 才按 id 去重，无 id 一律保留（保守，防漏报）。 */
export function mergeEvents(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const e of list ?? []) {
      if (e.id) {
        const key = `id:${e.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(e);
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * 读开关生效基线。
 * ⛔ 读不到 / 文件损坏 / 时间不可解析 ⇒ 返回 null，退回「无基线」的严格口径，
 *    绝不因为基线缺失而放宽判据（那才是真假绿）。
 */
export function loadActivation(explicitPath = null) {
  const path = explicitPath ?? ACTIVATION_FILE;
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const at = Date.parse(raw?.activatedAt ?? '');
    if (!Number.isFinite(at)) return null;
    return { at, path, activatedAt: new Date(at).toISOString() };
  } catch {
    return null;
  }
}

/**
 * 纯判据，可离线单测。
 * @param {Array<{topic:string,occurredAt:string,ts:number,payload:any}>} events
 * @param {{since?:number, windowMin?:number, now?:number, effectiveFrom?:number|null}} opts
 *        effectiveFrom = 开关生效时刻（毫秒）；null/undefined ⇒ 旧行为（全量追责）
 */
export function evaluateLag(events, {
  since = 0, windowMin = DEFAULT_WINDOW_MIN, now = Date.now(), effectiveFrom = null,
} = {}) {
  const windowMs = windowMin * 60_000;
  const allTriggers = events.filter(
    (e) => e.topic === TRIGGER_TOPIC && e.ts >= since && e.ts <= now,
  );
  const terminals = events.filter((e) => TERMINAL_TOPICS.includes(e.topic));
  const hasBaseline = Number.isFinite(effectiveFrom);

  // ⛔ 生效后零触发不得判绿：verified 只看 evaluated，0 条 ⇒ NO_TRIGGER_EVENTS
  const pre = hasBaseline ? allTriggers.filter((e) => e.ts < effectiveFrom) : [];
  const triggers = hasBaseline
    ? allTriggers.filter((e) => e.ts >= effectiveFrom)
    : allTriggers;

  const match = (t) => terminals.find((x) => x.ts >= t.ts && x.ts <= t.ts + windowMs);
  const matched = [];
  const missing = [];
  for (const t of triggers) {
    const hit = match(t);
    if (hit) {
      matched.push({
        triggerAt: t.occurredAt,
        terminalTopic: hit.topic,
        terminalAt: hit.occurredAt,
        lagMs: hit.ts - t.ts,
      });
    } else {
      missing.push({ triggerAt: t.occurredAt, windowMin });
    }
  }
  const preMissing = pre.filter((t) => !match(t));

  const verdict = triggers.length === 0
    ? 'NO_TRIGGER_EVENTS'
    : (missing.length > 0 ? 'TERMINAL_MISSING' : 'OK');
  return {
    verdict,
    verified: triggers.length > 0,
    since: new Date(since).toISOString(),
    now: new Date(now).toISOString(),
    effectiveFrom: hasBaseline ? new Date(effectiveFrom).toISOString() : null,
    evaluatedSince: new Date(hasBaseline ? Math.max(since, effectiveFrom) : since).toISOString(),
    windowMin,
    triggerCount: triggers.length,
    totalTriggerCount: allTriggers.length,
    terminalCount: terminals.length,
    failedTerminalCount: terminals.filter((x) => x.topic === 'curator.run-failed').length,
    matched,
    missing,
    preActivation: {
      triggerCount: pre.length,
      missingCount: preMissing.length,
      firstTriggerAt: pre.length ? pre[0].occurredAt : null,
      lastTriggerAt: pre.length ? pre[pre.length - 1].occurredAt : null,
      note: '开关生效前的历史触发，已从 verdict 分离；欠账如实保留，不删除、不改写、不参与判绿',
    },
    attribution: 'time-proximity-only（仅按时间邻近配对，不证明因果关系；cron 兜底产生的终态也计入）',
  };
}

export function parseArgs(argv = []) {
  const out = {
    days: DEFAULT_DAYS, windowMin: DEFAULT_WINDOW_MIN, json: false,
    storage: null, recordDir: null, since: null,
    effectiveFrom: null, activationFile: null, noBaseline: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--since') out.since = Date.parse(argv[++i] ?? '');
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--window-min') out.windowMin = Number(argv[++i]);
    else if (a === '--storage') out.storage = argv[++i];
    else if (a === '--record-dir') out.recordDir = argv[++i];
    else if (a === '--effective-from') out.effectiveFrom = Date.parse(argv[++i] ?? '');
    else if (a === '--activation-file') out.activationFile = argv[++i];
    else if (a === '--no-baseline') out.noBaseline = true;
  }
  return out;
}

function storageRoot() {
  return process.env.DSH_HOME
    ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh');
}

export function busStoragePath(explicit = null) {
  if (explicit) return explicit;
  return join(storageRoot(), BUS_REL);
}

export function recordDirPath(explicit = null) {
  if (explicit) return explicit;
  return join(storageRoot(), BUS_DIR_REL);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!Number.isFinite(args.since) && args.since !== null) args.since = null;
  if (!Number.isFinite(args.effectiveFrom) && args.effectiveFrom !== null) args.effectiveFrom = null;
  if (!Number.isFinite(args.windowMin) || args.windowMin <= 0) {
    console.error('[check-event-trigger-lag] --window-min 必须是正数');
    return 2;
  }
  const now = Date.now();
  const since = args.since !== null
    ? args.since
    : now - (Number.isFinite(args.days) && args.days > 0 ? args.days : DEFAULT_DAYS) * 86_400_000;

  // ── 生效基线（验收遗留 2）─────────────────────────────────────────────
  // 优先级：--no-baseline > --effective-from > --activation-file / 默认基线文件
  let effectiveFrom = null;
  let activation = null;
  if (!args.noBaseline) {
    if (args.effectiveFrom !== null) {
      effectiveFrom = args.effectiveFrom;
      activation = { kind: 'cli', at: new Date(effectiveFrom).toISOString(), path: null };
    } else {
      const loaded = loadActivation(args.activationFile);
      if (loaded) {
        effectiveFrom = loaded.at;
        activation = { kind: 'file', at: loaded.activatedAt, path: loaded.path };
      }
    }
  }

  const singlePath = busStoragePath(args.storage);
  const sources = [];
  let singleEvents = [];
  try {
    singleEvents = collectEvents(JSON.parse(readFileSync(singlePath, 'utf8')));
    sources.push({ kind: 'single', path: singlePath, count: singleEvents.length, available: true });
  } catch (e) {
    // 显式 --storage 指向坏文件时给警告，但只要 per-record 目录有数据就继续
    sources.push({
      kind: 'single', path: singlePath, count: 0, available: false,
      error: e?.message ?? String(e),
    });
  }

  // ⛔ 显式 --storage 且未给 --record-dir ⇒ 纯离线单源复核，不误读生产目录
  const dirPath = args.recordDir ?? (args.storage ? null : recordDirPath());
  let dirResult = { events: [], fileCount: 0, errors: 0, dir: null, available: false };
  if (dirPath) {
    dirResult = collectRecordDir(dirPath);
    sources.push({
      kind: 'per-record', path: dirResult.dir, count: dirResult.events.length,
      files: dirResult.fileCount, errors: dirResult.errors, available: dirResult.available,
    });
  }

  const events = mergeEvents(singleEvents, dirResult.events);
  if (events.length === 0) {
    console.error('[check-event-trigger-lag] 两个事件源都读不到事件，判据不可用：');
    for (const s of sources) console.error(`  ${s.kind}: ${s.path} (${s.error ?? '0 条'})`);
    return 2;
  }

  const report = evaluateLag(events, {
    since, windowMin: args.windowMin, now, effectiveFrom,
  });
  report.storage = singlePath;
  report.sources = sources;
  report.eventCount = events.length;
  report.duplicatesMerged = singleEvents.length + dirResult.events.length - events.length;
  report.activation = activation;

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[check-event-trigger-lag] 数据源 ${sources.map((s) => `${s.kind}=${s.count}`).join(' + ')} · 合并去重后 ${events.length} 条`);
    for (const s of sources) {
      if (!s.available) console.log(`  ⚠️ ${s.kind} 不可用：${s.path}${s.error ? ` — ${s.error}` : ''}`);
      else if (s.kind === 'per-record' && s.errors > 0) console.log(`  ⚠️ per-record 有 ${s.errors} 个文件解析失败（已跳过，不影响其余）`);
    }
    console.log(`  窗口 since=${report.since} · windowMin=${report.windowMin} · 触发 ${report.triggerCount} 条 / 终态 ${report.terminalCount} 条（失败终态 ${report.failedTerminalCount} 条）`);
    if (report.effectiveFrom) {
      console.log(`  生效基线 ${report.effectiveFrom}（${activation?.kind === 'cli' ? '命令行指定' : '基线文件'}）· 评估下界 ${report.evaluatedSince} · 生效前 ${report.preActivation.triggerCount} 条触发已分离（其中 ${report.preActivation.missingCount} 条无终态，属历史欠账，不参与判绿）`);
    }
    if (report.verdict === 'OK') {
      console.log(`  ✓ OK — ${report.matched.length} 条触发全部在窗口内有终态记录`);
    } else if (report.verdict === 'NO_TRIGGER_EVENTS') {
      console.log('  ⚠️ NO_TRIGGER_EVENTS — 评估窗口内 0 条技能变更；链路未通电，**不判绿也不判红**（verified=false）');
    } else {
      console.log(`  ✗ TERMINAL_MISSING — ${report.missing.length} 条触发在 ${report.windowMin} 分钟内无终态记录：`);
      for (const m of report.missing.slice(0, 10)) console.log(`      ${m.triggerAt}`);
      if (report.missing.length > 10) console.log(`      … 另 ${report.missing.length - 10} 条`);
    }
    console.log(`  ⚠️ 口径：${report.attribution}`);
    if (report.effectiveFrom) console.log('  ⚠️ 基线只改变评估下界，windowMin / 时间邻近口径未变；--no-baseline 可复现全量严格口径');
  }
  return report.verdict === 'TERMINAL_MISSING' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
