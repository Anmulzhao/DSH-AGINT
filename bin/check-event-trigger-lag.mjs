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
 *     要证明通电，另看 eventTrigger.status() 与 curator.run-failed 是否出现。
 *   - 窗口内 0 条触发事件 ⇒ `NO_TRIGGER_EVENTS` + verified:false：
 *     **不判绿也不判红**，明确「链路未通电 / 窗口内无流量」。
 *   - 未部署事件桥时实跑大概率 `TERMINAL_MISSING`（真缺口，不是脚本 bug）。
 *
 * 用法：
 *   node bin/check-event-trigger-lag.mjs                 # 默认最近 24h
 *   node bin/check-event-trigger-lag.mjs --since 2026-11-12T00:00:00Z
 *   node bin/check-event-trigger-lag.mjs --window-min 60 --json
 *   node bin/check-event-trigger-lag.mjs --storage <path>   # 离线复核
 * 退出码：0 = OK / NO_TRIGGER_EVENTS，1 = TERMINAL_MISSING，2 = 脚本自身出错
 *
 * 零依赖：只用 node:fs / node:path / node:url。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TRIGGER_TOPIC = 'input.signal.host.skills-change';
export const TERMINAL_TOPICS = Object.freeze(['curator.run-completed', 'curator.run-failed']);
export const DEFAULT_WINDOW_MIN = 30;
export const DEFAULT_DAYS = 1;
const BUS_REL = join('storages', 'agint_event_bus.json');

/**
 * 从事件总线存储 JSON 抽出 topic / occurredAt / payload。
 * ⚠️ 兼容两种落盘形状：新写入 { envelope, deliveries }（2026-11-12 结构性
 *    冗余清理后），存量行还带顶层 topic / occurredAt。只认能解析的时间戳。
 */
export function collectEvents(raw) {
  const tbl = raw?.tables?.events ?? raw?.events ?? raw;
  const rows = Array.isArray(tbl)
    ? tbl
    : Object.values(tbl && typeof tbl === 'object' ? tbl : {});
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const env = r.envelope && typeof r.envelope === 'object' ? r.envelope : r;
    const topic = typeof env.topic === 'string' ? env.topic : null;
    const occurredAt = typeof env.occurredAt === 'string' ? env.occurredAt : null;
    if (!topic || !occurredAt || Number.isNaN(Date.parse(occurredAt))) continue;
    out.push({
      topic,
      occurredAt,
      ts: Date.parse(occurredAt),
      payload: env.payload ?? null,
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/**
 * 纯判据，可离线单测。
 * @param {Array<{topic:string,occurredAt:string,ts:number,payload:any}>} events
 * @param {{since?:number, windowMin?:number, now?:number}} opts
 */
export function evaluateLag(events, { since = 0, windowMin = DEFAULT_WINDOW_MIN, now = Date.now() } = {}) {
  const windowMs = windowMin * 60_000;
  const triggers = events.filter(
    (e) => e.topic === TRIGGER_TOPIC && e.ts >= since && e.ts <= now,
  );
  const terminals = events.filter((e) => TERMINAL_TOPICS.includes(e.topic));
  const matched = [];
  const missing = [];
  for (const t of triggers) {
    const hit = terminals.find((x) => x.ts >= t.ts && x.ts <= t.ts + windowMs);
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
  const verdict = triggers.length === 0
    ? 'NO_TRIGGER_EVENTS'
    : (missing.length > 0 ? 'TERMINAL_MISSING' : 'OK');
  return {
    verdict,
    verified: triggers.length > 0,
    since: new Date(since).toISOString(),
    now: new Date(now).toISOString(),
    windowMin,
    triggerCount: triggers.length,
    terminalCount: terminals.length,
    failedTerminalCount: terminals.filter((x) => x.topic === 'curator.run-failed').length,
    matched,
    missing,
    attribution: 'time-proximity-only（仅按时间邻近配对，不证明因果关系；cron 兜底产生的终态也计入）',
  };
}

export function parseArgs(argv = []) {
  const out = { days: DEFAULT_DAYS, windowMin: DEFAULT_WINDOW_MIN, json: false, storage: null, since: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--since') out.since = Date.parse(argv[++i] ?? '');
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--window-min') out.windowMin = Number(argv[++i]);
    else if (a === '--storage') out.storage = argv[++i];
  }
  return out;
}

export function busStoragePath(explicit = null) {
  if (explicit) return explicit;
  const root = process.env.DSH_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.dsh');
  return join(root, BUS_REL);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!Number.isFinite(args.since) && args.since !== null) args.since = null;
  if (!Number.isFinite(args.windowMin) || args.windowMin <= 0) {
    console.error('[check-event-trigger-lag] --window-min 必须是正数');
    return 2;
  }
  const now = Date.now();
  const since = args.since !== null
    ? args.since
    : now - (Number.isFinite(args.days) && args.days > 0 ? args.days : DEFAULT_DAYS) * 86_400_000;

  let raw;
  const path = busStoragePath(args.storage);
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`[check-event-trigger-lag] 读不到事件总线存储 ${path}: ${e?.message ?? e}`);
    return 2;
  }
  const report = evaluateLag(collectEvents(raw), { since, windowMin: args.windowMin, now });
  report.storage = path;

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[check-event-trigger-lag] ${path}`);
    console.log(`  窗口 since=${report.since} · windowMin=${report.windowMin} · 触发 ${report.triggerCount} 条 / 终态 ${report.terminalCount} 条（失败终态 ${report.failedTerminalCount} 条）`);
    if (report.verdict === 'OK') {
      console.log(`  ✓ OK — ${report.matched.length} 条触发全部在窗口内有终态记录`);
    } else if (report.verdict === 'NO_TRIGGER_EVENTS') {
      console.log('  ⚠️ NO_TRIGGER_EVENTS — 窗口内 0 条技能变更；链路未通电，**不判绿也不判红**（verified=false）');
    } else {
      console.log(`  ✗ TERMINAL_MISSING — ${report.missing.length} 条触发在 ${report.windowMin} 分钟内无终态记录：`);
      for (const m of report.missing.slice(0, 10)) console.log(`      ${m.triggerAt}`);
      if (report.missing.length > 10) console.log(`      … 另 ${report.missing.length - 10} 条`);
    }
    console.log(`  ⚠️ 口径：${report.attribution}`);
  }
  return report.verdict === 'TERMINAL_MISSING' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
