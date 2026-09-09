#!/usr/bin/env node
/**
 * bin/t2-reconcile.mjs — T2 切流量对账脚本（Sprint 16 / W2）
 *
 * 干什么：回答一个问题 —— 「事件总线这条新路，和原来的直连老路，结果一样吗？」
 * T2 的门禁是「影子 vs 直连一致率 ≥ 99%」，但没有脚本量这个数，门禁就是空话。
 * 本脚本从生产存储离线算出这个数。
 *
 * 三条边怎么对账：
 *   - A1 evolution.proposed：事件里的 proposalId ↔ evolution_log 里
 *     tags 含 'event-bus' 的影子行（targetId）。算影子覆盖率。
 *   - A7 metrics.snapshot：事件批次的 key 集合 ↔ agint_metrics.json 里的
 *     metrics key 集合。算 key 覆盖率。（运行时另有 self-model 的内存对账器，
 *     两者互为交叉验证：内存版重启清零，本脚本能看历史。）
 *   - 全局门禁：死信率、sync 订阅数（T2 前置条件表里的两项）。
 *
 * 时序陷阱（重要）：A1 的 3 条事件全发生在 2026-09-04，而影子写入的契约修复
 * 是 09-07 才上线的。修复前的事件本来就不该有影子行。所以必须用 --since
 * 把观察窗口卡在修复之后，否则会得出「影子链路 0% 覆盖」的假结论。
 *
 * 跑法：
 *   node bin/t2-reconcile.mjs
 *   node bin/t2-reconcile.mjs --edge=A1 --since=2026-09-07
 *   node bin/t2-reconcile.mjs --json
 *   node bin/t2-reconcile.mjs --storage=C:/Users/Administrator/.dsh/storages
 *
 * 退出码：0 = 无 FAIL（INSUFFICIENT 不算失败），1 = 有边 FAIL。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (k, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : dflt;
};
const has = (k) => argv.includes(`--${k}`);

const EDGE = (arg('edge', 'ALL') || 'ALL').toUpperCase();
const SINCE = arg('since', '2026-09-07'); // 默认卡在 A1 影子契约修复之后
const MIN_SAMPLES = Number(arg('min-samples', '20'));
const AS_JSON = has('json');
const DEFAULT_HOME = join(homedir(), '.dsh');
const STORAGE = resolve(arg('storage', process.env.DSH_HOME || join(DEFAULT_HOME, 'storages')));

// ── 工具 ────────────────────────────────────────────────────────────────────
function readJson(file) {
  const p = join(STORAGE, file);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/** 存储行有两种形态：{ rows: {k: v} } 或直接数组/对象。统一成数组。 */
function rowsOf(table) {
  if (!table) return [];
  if (Array.isArray(table)) return table;
  if (table.rows && typeof table.rows === 'object') return Object.values(table.rows);
  return Object.values(table);
}

function tableOf(store, name) {
  if (!store?.tables) return [];
  return rowsOf(store.tables[name]);
}

const rate = (num, den) => (den > 0 ? Number((num / den).toFixed(4)) : null);
const pct = (r) => (r === null ? '—' : `${(r * 100).toFixed(2)}%`);

function verdict(samples, okRate, minSamples = MIN_SAMPLES) {
  if (samples < minSamples) return 'INSUFFICIENT';
  return okRate === null ? 'INSUFFICIENT' : (okRate >= 0.99 ? 'PASS' : 'FAIL');
}

// ── 全局门禁 ────────────────────────────────────────────────────────────────
function reconcileGates(bus) {
  const events = tableOf(bus, 'events');
  const dead = tableOf(bus, 'deadletter');
  const deadRate = rate(dead.length, events.length + dead.length);
  return {
    events: events.length,
    deadletter: dead.length,
    deadletterRate: deadRate,
    deadletterVerdict: deadRate === null ? 'INSUFFICIENT' : (deadRate < 0.005 ? 'PASS' : 'FAIL'),
  };
}

// ── A1：事件 ↔ 影子行 ───────────────────────────────────────────────────────
function reconcileA1(bus, evo) {
  const events = tableOf(bus, 'events')
    .filter((r) => r?.envelope?.topic === 'evolution.proposed');
  const inWindow = events.filter((r) => String(r?.envelope?.occurredAt ?? '') >= SINCE);
  const stale = events.length - inWindow.length;

  const log = tableOf(evo, 'evolution_log');
  const isShadow = (r) => Array.isArray(r?.tags) && r.tags.includes('event-bus');
  const shadow = log.filter(isShadow);
  const direct = log.filter((r) => !isShadow(r));

  const busIds = new Set(inWindow.map((r) => r?.envelope?.payload?.proposalId).filter(Boolean));
  const shadowIds = new Set(shadow.map((r) => r?.targetId).filter(Boolean));
  const directIds = new Set(direct.map((r) => r?.targetId).filter(Boolean));

  const shadowHit = [...busIds].filter((id) => shadowIds.has(id)).length;
  const shadowCoverage = rate(shadowHit, busIds.size);
  const pairs = [...shadowIds].filter((id) => directIds.has(id)).length;
  const unionSize = new Set([...shadowIds, ...directIds]).size;
  const consistency = rate(pairs, unionSize);

  return {
    eventsTotal: events.length,
    eventsInWindow: inWindow.length,
    eventsStale: stale,
    shadowRows: shadow.length,
    directRows: direct.length,
    shadowCoverage,
    consistency,
    verdict: verdict(busIds.size, shadowCoverage),
    note: stale > 0
      ? `${stale} 条事件早于 --since=${SINCE}（影子契约修复前），不计入判定`
      : null,
  };
}

// ── A7：事件 key ↔ metrics 存储 key ─────────────────────────────────────────
// v0.7.3 起 self-model 的影子对账统计会落 metrics_ingest 单行表（节流 5 分钟），
// 这里一并读出「运行时一致率」——它才是 T2 门禁的正主（影子 vs 直连），
// 下面的 key 覆盖率是离线交叉验证。两者互证：内存版有节流落盘 + 重启清零，
// 本脚本看历史；离线版只验 key 结构，不验对账判定。
function shadowStatsOf(selfModel) {
  const rows = tableOf(selfModel, 'metrics_ingest');
  const latest = rows.find((r) => r?.id === 'latest') ?? rows[0] ?? null;
  if (!latest?.stats) return null;
  const s = latest.stats;
  return {
    persistedAt: latest.persistedAt ?? null,
    events: s.events ?? null,
    batches: s.batches ?? null,
    compared: s.compared ?? null,
    matched: s.matched ?? null,
    mismatched: s.mismatched ?? null,
    skipped: s.skipped ?? null,
    valueDrift: s.valueDrift ?? null,
    consistencyRate: typeof s.consistencyRate === 'number' ? s.consistencyRate : null,
    lastComparedAt: s.lastComparedAt ?? null,
  };
}

function reconcileA7(bus, metrics, selfModel) {
  const events = tableOf(bus, 'events')
    .filter((r) => r?.envelope?.topic === 'metrics.snapshot');
  const inWindow = events.filter((r) => String(r?.envelope?.occurredAt ?? '') >= SINCE);

  // 按 occurredAt 攒批（与运行时对账器同口径）
  const batches = new Map();
  for (const r of inWindow) {
    const at = r?.envelope?.payload?.generatedAt || r?.envelope?.occurredAt;
    if (!batches.has(at)) batches.set(at, new Set());
    if (r?.envelope?.payload?.key) batches.get(at).add(r.envelope.payload.key);
  }
  const batchKeys = [...batches.values()];
  const eventKeys = new Set(batchKeys.flatMap((s) => [...s]));

  // 存储里表名是 `metric`（单数），不同版本可能不同，做容错
  const metricRows = ['metric', 'metrics'].map((n) => tableOf(metrics, n)).find((r) => r.length > 0) ?? [];
  const storedKeys = new Set(metricRows.map((r) => r?.key).filter(Boolean));
  const latest = batchKeys[batchKeys.length - 1] ?? new Set();

  const hit = [...latest].filter((k) => storedKeys.has(k)).length;
  const coverage = rate(hit, latest.size);
  const shadow = shadowStatsOf(selfModel);

  return {
    eventsTotal: events.length,
    eventsInWindow: inWindow.length,
    batches: batches.size,
    eventKeys: eventKeys.size,
    storedKeys: storedKeys.size,
    latestBatchKeys: latest.size,
    keyCoverage: coverage,
    ...(shadow
      ? Object.fromEntries(Object.entries(shadow).map(([k, v]) => [`shadow${k[0].toUpperCase()}${k.slice(1)}`, v]))
      : { shadow: null }),
    verdict: verdict(latest.size, coverage, 3), // A7 单批 key 少，门槛放低
    note: [
      '值漂移不参与判定（事件批次与直连快照天然有时差，见 lib/metricsIngest.js 文件头）',
      shadow
        ? `运行时影子对账：${shadow.compared ?? 0} 次比对，一致率 ${pct(shadow.consistencyRate)}（落盘于 ${shadow.persistedAt ?? '?'}）`
        : '运行时影子统计尚未落盘（需 self-model ≥ v0.7.3 且有 A7 事件流入）',
    ].join('；'),
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const bus = readJson('agint_event_bus.json');
const evo = readJson('agint_evolution.json');
const metrics = readJson('agint_metrics.json');
const selfModel = readJson('agint_self_model.json');

if (!bus) {
  console.error(`读不到事件总线存储：${join(STORAGE, 'agint_event_bus.json')}`);
  console.error('提示：用 --storage=<dir> 指定，或设 DSH_HOME 环境变量。');
  process.exit(2);
}

const result = {
  generatedAt: new Date().toISOString(),
  storage: STORAGE,
  since: SINCE,
  minSamples: MIN_SAMPLES,
  gates: reconcileGates(bus),
  edges: {},
};
if (EDGE === 'ALL' || EDGE === 'A1') result.edges.A1 = reconcileA1(bus, evo);
if (EDGE === 'ALL' || EDGE === 'A7') result.edges.A7 = reconcileA7(bus, metrics, selfModel);

if (AS_JSON) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const line = (s) => console.log(s);
  line('T2 切流量对账报告');
  line('='.repeat(56));
  line(`生成时间  ${result.generatedAt}`);
  line(`存储目录  ${STORAGE}`);
  line(`观察起点  ${SINCE}（早于此的事件不计入判定）`);
  line(`最小样本  ${MIN_SAMPLES}`);
  line('');

  const g = result.gates;
  line(`[全局门禁] 事件 ${g.events} 条 / 死信 ${g.deadletter} 条`);
  line(`  死信率 ${pct(g.deadletterRate)}  ${g.deadletterVerdict === 'PASS' ? '✓ 达标 (<0.5%)' : '✗ 未达标'}`);
  line('');

  for (const [name, e] of Object.entries(result.edges)) {
    const mark = { PASS: '✓', FAIL: '✗', INSUFFICIENT: '!' }[e.verdict] ?? '?';
    line(`[${name}]  ${mark} ${e.verdict}`);
    for (const [k, v] of Object.entries(e)) {
      if (k === 'verdict' || k === 'note') continue;
      if (v !== null && typeof v === 'object') continue;
      line(`  ${String(k).padEnd(18)} ${v === null ? '—' : v}`);
    }
    if (e.note) line(`  注：${e.note}`);
    line('');
  }

  line('判定说明：PASS=一致率≥99% 且样本够；INSUFFICIENT=样本不足，不是失败，');
  line('          但意味着这条边现在不能进 T2 切换；FAIL=一致率不达标，需查链路。');
}

const failed = Object.values(result.edges).filter((e) => e.verdict === 'FAIL');
process.exit(failed.length > 0 ? 1 : 0);
