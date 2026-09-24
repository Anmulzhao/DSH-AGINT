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
 * 已知缺陷排除（KNOWN_MISSES）：窗口内若有**已归因且已修复**的漏写（如 09-21
 * 09:15 那条是 b2d9edb 修复前的 domain-not-ready 静默丢），不计入样本 —— 否则
 * 历史 bug 的实例会让这条边永远判不过。排除必须带 reason 并原样打印，
 * 且**随时可用 --no-exclude-known 看未排除的原始数**，防止排除名单变成后门。
 *
 * 判定放宽（PASS_WEAK）：A1 是低频边，自然流量攒够 20 条要几个月。样本不足但
 * 「窗口内 100% 全中」时判 PASS_WEAK（弱证据：只说明未观察到漏写）。
 * 有漏写、或样本 < --full-coverage-min，一律打回 INSUFFICIENT。
 *
 * 跑法：
 *   node bin/t2-reconcile.mjs
 *   node bin/t2-reconcile.mjs --edge=A1 --since=2026-09-07
 *   node bin/t2-reconcile.mjs --edge=A1 --no-exclude-known   # 看未排除的原始数
 *   node bin/t2-reconcile.mjs --full-coverage-min=3          # 收紧放宽通道
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
// 放宽通道下限：样本不够 20 条，但「窗口内全中」且达到这个数 → 判弱证据 PASS。
// 理由：A1 是低频边（真实提案），靠自然流量攒 20 条要几个月。等样本攒够再切，
// 等于把「已修复且验证过的边」无限期挂起。所以放行，但必须标口径、留痕。
const FULL_COVERAGE_MIN = Number(arg('full-coverage-min', '2'));
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

/**
 * 判定三档：PASS（样本足 + 达标） / PASS_WEAK（小样本全覆盖，弱证据） / FAIL / INSUFFICIENT。
 *
 * ⚠️ PASS_WEAK 不是"降标准"，是"标口径"：它要求**窗口内 100% 全中**（一条漏写都不许有），
 * 只是不要求样本量。含义是「修复后未观察到漏写」，不是「统计上证明可靠」。
 * 样本攒够 20 条后会自动升级为 PASS，无需再改代码。
 */
function verdict(samples, okRate, minSamples = MIN_SAMPLES) {
  if (samples >= minSamples) {
    return okRate === null ? 'INSUFFICIENT' : (okRate >= 0.99 ? 'PASS' : 'FAIL');
  }
  if (samples >= FULL_COVERAGE_MIN && okRate === 1) return 'PASS_WEAK';
  return 'INSUFFICIENT';
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
/**
 * 已知缺陷排除名单：这些 proposalId 的漏写有**明确归因且已修复**。
 * 计入样本会把「历史 bug 的实例」误算成「当前链路故障」，让这条边永远过不了。
 * 排除必须留痕（下面会原样打印 reason），不接受无理由剔除。
 */
const KNOWN_MISSES = [
  {
    id: '3c988611-01ef-47d7-b616-fb5f4046ae6c',
    at: '2026-09-21T09:15:53.896Z',
    reason: 'fix-20260921 (b2d9edb) 前：domain 未就绪即调用 → 影子写入被静默丢弃；该 bug 已于 09-21 17:29:49 落位修复',
  },
];

function reconcileA1(bus, evo) {
  const events = tableOf(bus, 'events')
    .filter((r) => r?.envelope?.topic === 'evolution.proposed');
  const inWindow = events.filter((r) => String(r?.envelope?.occurredAt ?? '') >= SINCE);
  const stale = events.length - inWindow.length;

  // --no-exclude-known：关掉排除名单看原始数。防排除名单变成"掩盖问题的后门"。
  const missIds = has('no-exclude-known') ? new Set() : new Set(KNOWN_MISSES.map((k) => k.id));
  const excluded = inWindow.filter((r) => missIds.has(r?.envelope?.payload?.proposalId));
  const effective = inWindow.filter((r) => !missIds.has(r?.envelope?.payload?.proposalId));

  const log = tableOf(evo, 'evolution_log');
  const isShadow = (r) => Array.isArray(r?.tags) && r.tags.includes('event-bus');
  const shadow = log.filter(isShadow);
  const direct = log.filter((r) => !isShadow(r));

  const busIds = new Set(effective.map((r) => r?.envelope?.payload?.proposalId).filter(Boolean));
  const shadowIds = new Set(shadow.map((r) => r?.targetId).filter(Boolean));
  const directIds = new Set(direct.map((r) => r?.targetId).filter(Boolean));

  const shadowHit = [...busIds].filter((id) => shadowIds.has(id)).length;
  const shadowCoverage = rate(shadowHit, busIds.size);

  // ⚠️ 口径修正：影子行与直连行是**同一张表的互斥写入**（一条提案只落一行，
  // 谁先写谁写），不是"各写一份再比对"。所以 shadowIds ∩ directIds 恒为 0，
  // 原 `consistency` 恒等于 0 —— 那不是链路故障，是指标本身不成立。
  // 本边的门禁指标是 shadowCoverage（总线事件 → 影子行的覆盖率）。
  // 这里只在**确实存在可配对直连行**时才输出 consistency，否则给 null 并说明。
  const pairs = [...shadowIds].filter((id) => directIds.has(id)).length;
  const unionSize = new Set([...shadowIds, ...directIds]).size;
  const consistency = pairs > 0 ? rate(pairs, unionSize) : null;

  const notes = [];
  if (stale > 0) notes.push(`${stale} 条事件早于 --since=${SINCE}（影子契约修复前），不计入判定`);
  if (excluded.length > 0) {
    notes.push(`排除 ${excluded.length} 条已归因的已知缺陷：${excluded
      .map((r) => `${r?.envelope?.payload?.proposalId}（${KNOWN_MISSES.find((k) => k.id === r?.envelope?.payload?.proposalId)?.reason ?? '?'}）`)
      .join('；')}`);
  }
  if (consistency === null) {
    notes.push('consistency 不适用：影子/直连为互斥写入（一条提案只落一行），无法算写入差集；门禁以 shadowCoverage 为准');
  }

  return {
    eventsTotal: events.length,
    eventsInWindow: inWindow.length,
    eventsStale: stale,
    eventsExcludedKnown: excluded.length,
    samples: busIds.size,
    minSamples: MIN_SAMPLES,
    fullCoverageMin: FULL_COVERAGE_MIN,
    shadowRows: shadow.length,
    directRows: direct.length,
    shadowCoverage,
    consistency,
    verdict: verdict(busIds.size, shadowCoverage),
    note: notes.length > 0 ? notes.join('；') : null,
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
    // v0.7.5：判别「没结算」vs「没收到」的关键字段（self-model < 0.7.5 恒为 null）
    lastIngestAt: s.lastIngestAt ?? null,
  };
}

/**
 * v0.7.5：A7 停滞诊断。
 * 旧实现只在批切换（generatedAt 变化）时落盘 ⇒ 「批从未切换」与「handler 从未被调用」
 * 在落盘数据上长得一模一样（都表现为 compared 不涨）。有了 lastIngestAt 才能分开：
 *   lastIngestAt 在涨 + compared 不涨 ⇒ 收到了，但批切换语义没触发
 *   lastIngestAt 也不涨            ⇒ handler 没被调用（订阅/投递侧问题）
 */
function stagnationNote(shadow, lastEventAt) {
  if (!shadow) return null;
  const ing = shadow.lastIngestAt ?? null;
  const cmp = shadow.lastComparedAt ?? null;
  if (!ing && !cmp) return null;
  const parts = [`最后一次收到事件 ${ing ?? '未知'}`];
  if (lastEventAt && ing && ing < lastEventAt) {
    parts.push(`⚠️ 事件侧最新一条是 ${lastEventAt}（更晚）⇒ handler 疑似未收到，查订阅/投递`);
  } else if (cmp && ing && ing > cmp) {
    parts.push(`⚠️ 收到过事件但自 ${cmp} 起未结算 ⇒ 批切换语义问题`);
  }
  return parts.join('；');
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
      stagnationNote(shadow, inWindow.length ? inWindow.map((r) => String(r?.envelope?.occurredAt ?? '')).sort().pop() : null),
    ].filter(Boolean).join('；'),
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
  fullCoverageMin: FULL_COVERAGE_MIN,
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
  line(`最小样本  ${MIN_SAMPLES}（放宽通道：样本 ≥${FULL_COVERAGE_MIN} 且 100% 全覆盖 → PASS_WEAK）`);
  line('');

  const g = result.gates;
  line(`[全局门禁] 事件 ${g.events} 条 / 死信 ${g.deadletter} 条`);
  line(`  死信率 ${pct(g.deadletterRate)}  ${g.deadletterVerdict === 'PASS' ? '✓ 达标 (<0.5%)' : '✗ 未达标'}`);
  line('');

  for (const [name, e] of Object.entries(result.edges)) {
    const mark = { PASS: '✓', PASS_WEAK: '~', FAIL: '✗', INSUFFICIENT: '!' }[e.verdict] ?? '?';
    line(`[${name}]  ${mark} ${e.verdict}`);
    for (const [k, v] of Object.entries(e)) {
      if (k === 'verdict' || k === 'note') continue;
      if (v !== null && typeof v === 'object') continue;
      line(`  ${String(k).padEnd(18)} ${v === null ? '—' : v}`);
    }
    if (e.note) line(`  注：${e.note}`);
    line('');
  }

  line(`判定说明：PASS=样本 ≥${MIN_SAMPLES} 且覆盖率 ≥99%（强证据）；`);
  line(`          PASS_WEAK(~)=样本 ${FULL_COVERAGE_MIN}~${MIN_SAMPLES - 1} 但窗口内 100% 全覆盖（弱证据：`);
  line('          只说明「未观察到漏写」，不说明「统计上可靠」；样本攒够会自动升级为 PASS）；');
  line('          INSUFFICIENT=样本不足或有漏写，意味着这条边现在不能进 T2 切换；');
  line('          FAIL=覆盖率不达标，需查链路。');
}

const failed = Object.values(result.edges).filter((e) => e.verdict === 'FAIL');
process.exit(failed.length > 0 ? 1 : 0);
