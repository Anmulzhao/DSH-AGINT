/**
 * AGINT 进化架构图 —— 数据层（单一真源）
 *
 * 为什么单独成文件：架构图原先由 `bin/evolution-viz-snapshot.mjs` 在生成时
 * 把读数烤进 srcdoc，与家族面板其余 9 个 tab 的实时聚合是**两条数据通道**。
 * 实测两轨时点差 13m52s、域交集只有 5 个（2026-11-15）。要「架构图也实时」，
 * 必须让生成器与 HTTP 路由调**同一个**聚合函数，否则两套口径必然漂。
 *
 * 三种消费方：
 *  1. `lib/index.js` 的 GET /api/agint-family/v2/arch（实时）
 *  2. `bin/evolution-viz-snapshot.mjs`（离线快照 / 独立 HTML 首屏）
 *  3. 测试与门禁（纯函数，可注入 storagesDir / now）
 *
 * 三态纪律（同 v2-data）：
 *  - 有数显示数
 *  - 域不存在显示 —（灰），不是 0
 *  - 表存在但 0 行显示 0 并注明
 *
 * 边界：只读 storages。不写任何状态。只用 Node 内置模块。
 */

import fs from 'node:fs';
import { join } from 'node:path';
import { aggPending, aggOracle, aggUpstream } from './v2-data.js';

export const TONE = {
  ok: { label: '活跃（有真实读数）', stroke: '#15803d', fill: '#f0fdf4', chip: '#15803d' },
  warn: { label: '可疑 / 待核', stroke: '#b45309', fill: '#fffbeb', chip: '#b45309' },
  bad: { label: '断点（本次无数据）', stroke: '#b91c1c', fill: '#fef2f2', chip: '#b91c1c' },
  frozen: { label: '外置冻结', stroke: '#6d28d9', fill: '#f5f3ff', chip: '#6d28d9' },
  human: { label: '人工闸门', stroke: '#1d4ed8', fill: '#eef2ff', chip: '#1d4ed8' },
  idle: { label: '无快照读数', stroke: '#94a3b8', fill: '#f8fafc', chip: '#64748b' },
};

export const EDGE = {
  live: { label: '主链路 · 真实读写 / 触发', stroke: '#1d4ed8', dot: '#1d4ed8', dash: '', arrow: 'ar-live' },
  break: { label: '断点 · 本次无数据 / 全回滚', stroke: '#b91c1c', dot: '#b91c1c', dash: '5 5', arrow: '' },
  frozen: { label: '外置判据 · 系统碰不到', stroke: '#6d28d9', dot: '#6d28d9', dash: '3 4', arrow: '' },
  human: { label: '人工闸门 · 默认拒绝', stroke: '#1d4ed8', dot: '#1d4ed8', dash: '2 4', arrow: '' },
  feedback: { label: '反馈回流 · 闭环', stroke: '#0f766e', dot: '#0f766e', dash: '', arrow: 'ar-fb' },
};

const NO_DATA = '—';
export const AX = 140, AW = 990, NH = 68, NGAP = 24, RX0 = 1184;
export const LAYER_Y0 = 30, LAYER_STEP = 88, LAYER_BAND_H = 78;
export const VB_W = 1240, VB_H = 650;

const num = (o) => Object.keys(o || {}).length;
const vals = (o) => (o && typeof o === 'object' ? Object.values(o) : []);
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
function dist(o, f) {
  const m = {};
  for (const v of vals(o)) {
    const k = String(f(v));
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}
function byDayOf(rows, dateFn) {
  const m = {};
  for (const v of vals(rows)) {
    const d = String(dateFn(v) || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) m[d] = (m[d] || 0) + 1;
  }
  return m;
}
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((t - y0) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + '-W' + String(w).padStart(2, '0');
}

/** tool_stats 是 4k+ 行 jsonl，30s 轮询重复读没必要。按 mtime 缓存。 */
const toolCache = new Map();
function readToolStats(storagesDir, nowMs) {
  const p = join(storagesDir, 'agint_tool_stats.jsonl');
  let st;
  try { st = fs.statSync(p); } catch { return { state: 'missing', calls: null, fails: null, lines: 0 }; }
  const hit = toolCache.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.value;
  let calls = 0, fails = 0, lines = 0;
  const cutoff = nowMs - 30 * 86400000;
  try {
    const text = fs.readFileSync(p, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      const ts = Number(r.ts) || 0;
      if (ts && ts < cutoff) continue;
      lines++;
      calls++;
      if (r.ok === false) fails++;
    }
  } catch (e) {
    return { state: 'error', reason: (e && e.code) || 'read-error', calls: null, fails: null, lines: 0 };
  }
  const value = { state: 'ok', calls, fails, lines, windowDays: 30 };
  toolCache.set(p, { mtimeMs: st.mtimeMs, value });
  return value;
}

/**
 * 事件总线的 topic 级发布数。
 *
 * ⛔ 不在本函数里遍历 `agint_event_bus/events/`：实测 20424 个记录文件，
 * 30s 轮询会打爆磁盘。优先用 `/v2/data` 已算好的 bus 段（同进程缓存），
 * 没有就退回单文件口径并**明确标注**它是哪个口径，不冒充全量。
 */
function readEvents(storagesDir, v2) {
  if (v2 && isObj(v2.bus) && typeof v2.bus.total === 'number') {
    const topics = Array.isArray(v2.bus.topics)
      ? v2.bus.topics.map((t) => (Array.isArray(t) ? { topic: String(t[0]), count: Number(t[1]) || 0 } : { topic: String(t.topic || '?'), count: Number(t.count) || 0 }))
      : [];
    topics.sort((a, b) => b.count - a.count);
    return { state: 'ok', source: 'v2/data（per-record 全量）', total: v2.bus.total, deadletter: v2.bus.deadletter ?? null, topics: topics.slice(0, 12), topicCount: topics.length };
  }
  const single = join(storagesDir, 'agint_event_bus.json');
  const perRecord = join(storagesDir, 'agint_event_bus', 'events');
  if (fs.existsSync(perRecord)) {
    return { state: 'deferred', source: 'per-record（2 万+ 文件，等 /v2/data 首拉后并入）', total: null, deadletter: null, topics: [], topicCount: null };
  }
  try {
    const d = JSON.parse(fs.readFileSync(single, 'utf8'));
    const t = d.tables || d;
    const events = t.events || {};
    const counts = {};
    for (const v of vals(events)) counts[v && v.topic ? String(v.topic) : '?'] = (counts[v && v.topic ? String(v.topic) : '?'] || 0) + 1;
    const topics = Object.entries(counts).map(([topic, count]) => ({ topic, count })).sort((a, b) => b.count - a.count);
    return { state: 'ok', source: 'agint_event_bus.json（单文件，可能是迁移前快照）', total: num(events), deadletter: null, topics: topics.slice(0, 12), topicCount: topics.length };
  } catch (e) {
    return { state: 'missing', reason: '无 per-record 目录、无单文件', source: 'none', total: null, deadletter: null, topics: [], topicCount: null };
  }
}

/**
 * 边声明表 —— **结构语义的唯一真源**，同时也是 `bin/check-arch-edges.mjs` 的输入。
 *
 * `basis` 写这条关系凭什么成立（文档章节 / 代码事实），供校验视图与门禁核对。
 * `breakWhen(ctx)` 只有返回 true 才维持断点；数据恢复后自动改回 live，
 * 避免「一次性断点」被永久画成红色。返回 null 表示该边不参与动态判定。
 */
export const EDGE_DECL = [
  ['host', 'metrics', 'live', '挂载 host Service', 'docs/architecture.md · 采集层', null],
  ['host', 'cron', 'live', 'tick 调度', 'docs/architecture.md · 调度平面', null],
  ['host', 'trajectory', 'live', 'tools/result 监听', 'docs/architecture.md · 轨迹采集', null],
  ['host', 'rules', 'live', 'tools/pre 瀑布', 'docs/architecture.md · 门禁瀑布', null],
  ['host', 'upstream', 'live', '发行记录抓取（cron）', 'plugins/agint-upstream-watch', null],
  ['metrics', 'evoMem', 'live', '每日指标写入', 'docs/architecture.md · 进化记忆', null],
  ['cron', 'dream', 'live', '03:00 night-dream', 'plugins/agint-dream · cron', null],
  ['trajectory', 'skillAc', 'live', '任务模式聚合', 'plugins/agint-skill-autocreate', null],
  ['rules', 'memory', 'live', '门禁瀑布约束写入', 'plugins/agint-rules · 写入前瀑布', null],
  ['evoMem', 'eval', 'live', '评估读 4 源', 'docs/evolution-framework.md', null],
  ['dream', 'eval', 'live', '梦境候选 → 评估', 'plugins/agint-dream · 候选产出', null],
  ['memory', 'baseline', 'frozen', '外置，系统碰不到', 'eval/capability-baseline', null],
  ['skillAc', 'observe', 'break', '观察阶段无数据', 'agint_abtest 域 / 实验回流', (c) => c.abMissing || c.abtests === 0],
  ['eval', 'propose', 'live', '复盘 → 提案', 'plugins/agint-evolve', null],
  ['eval', 'mutator', 'live', '评估 → 变异探索', 'plugins/agint-mutator', null],
  ['baseline', 'propose', 'frozen', '锚定约束', 'eval/capability-baseline · 锚定', null],
  ['observe', 'curriculum', 'break', '无实验回流', 'agint_curriculum 队列 / 实验回流', (c) => c.abMissing || c.abtests === 0],
  ['propose', 'gates', 'live', '候选处方', 'bin/autonomous-write-gate.mjs', null],
  ['curriculum', 'queue', 'break', '无课程挑战写入', 'agint_skill_autocreate.proposals', (c) => c.acProposals === 0],
  ['mutator', 'release', 'break', '无发布记录', 'agint_skill_autocreate.releases', (c) => c.acReleases === 0],
  ['gates', 'human', 'human', '24h 撤销窗口', 'bin/autonomous-write-gate.mjs · G5', null],
  ['release', 'outcomes', 'break', '无实验数据', 'prediction_outcomes / abtest', (c) => c.acReleases === 0],
  ['queue', 'outcomes', 'break', '无观察样本', 'agint_skill_autocreate.proposals', (c) => c.acProposals === 0],
  ['outcomes', 'baseline', 'feedback', '下周对拍 actualDelta', 'prediction_outcomes.measuredAt', null],
  ['human', 'gates', 'feedback', '否决回落默认拒绝', 'G5 人工否决', null],
  ['outcomes', 'metrics', 'feedback', '下一轮观察', 'metrics 时序回写', null],
];

/**
 * 聚合一次架构图模型。纯函数（注入 storagesDir/now/v2），不写盘。
 *
 * @param {object} opts
 * @param {string} opts.storagesDir  storages 绝对路径
 * @param {number} [opts.now]        当前毫秒（测试注入）
 * @param {object|null} [opts.v2]    `/v2/data` 的 bus/tools 段（可选，用于事件链与工具产出）
 * @param {string} [opts.storageLabel] 展示用符号路径
 */
export function collectArchData(opts = {}) {
  const storagesDir = opts.storagesDir;
  if (!storagesDir) throw new Error('collectArchData: storagesDir 必填');
  const nowMs = Number(opts.now) || Date.now();
  const storageLabel = opts.storageLabel || '$DSH_HOME/storages';
  const v2 = isObj(opts.v2) ? opts.v2 : null;

  const missing = [];
  const missingFiles = [];
  const domainMissing = new Set();
  /**
   * ⛔ 机器私有事实不入库（AGENTS.md 第 16 条）：ENOENT 的 message 含 storages 绝对路径，
   * 这段文字会被烤进 panel-v2.html（仓内文件）。一律去掉 message，只留错误码；
   * 其它来源的 reason 也把 storagesDir 前缀换回符号路径。
   */
  const sanitizeReason = (s) => String(s ?? '').replaceAll(storagesDir, '$DSH_HOME/storages').slice(0, 200);
  function load(file) {
    try {
      const d = JSON.parse(fs.readFileSync(join(storagesDir, file), 'utf8'));
      return d.tables || d;
    } catch (e) {
      const code = e && e.code ? String(e.code) : 'read-error';
      if (code === 'ENOENT') {
        missingFiles.push(file);
        domainMissing.add(file);
      }
      missing.push(file + ': ' + code);
      return {};
    }
  }

  const evolution = load('agint_evolution.json');
  const evolve = load('agint_evolve.json');
  const metrics = load('agint_metrics.json');
  const cron = load('agint_cron.json');
  const abtest = load('agint_abtest.json');
  const curator = load('agint_curator.json');
  const trajectory = load('agint_trajectory.json');
  const autocreate = load('agint_skill_autocreate.json');
  const rules = load('agint_rules.json');
  const curriculum = load('agint_curriculum.json');
  const mutator = load('agint_mutator.json');
  const population = load('agint_population.json');
  const selfModel = load('agint_self_model.json');

  const evLog = evolution.evolution_log || {};
  const ledger = evolution.evolution_ledger || {};
  const proposals = evolve.proposal || {};
  const metricRows = metrics.metric || {};
  const cronState = cron.cron_state || {};
  const traj = trajectory.trajectories || {};
  const skillStates = curator.skill_states || {};
  const acCandidates = autocreate.candidates || {};
  const acProposals = autocreate.proposals || {};
  const acReleases = autocreate.releases || {};

  const statusDist = dist(proposals, (v) => v.status || '?');
  const logDecision = dist(evLog, (v) => v.decision || '?');
  const logByDay = dist(evLog, (v) => String(v.createdAt || v.ts || '').slice(0, 10));
  const candStatus = dist(acCandidates, (v) => v.status || v.state || '?');
  const acPropStatus = dist(acProposals, (v) => v.status || '?');
  const relStatus = dist(acReleases, (v) => v.status || '?');
  const skillState = dist(skillStates, (v) => v.state || '?');
  const trajByDay = trajectory.calibration?.current?.byDay || {};
  const trajSource = dist(traj, (v) => v.source || '?');
  const cronBad = Object.entries(cronState).filter(([, v]) => v && v.lastResult !== 'ok');
  const ruleAudit = rules.rule_audit || {};

  const latestMetric = (key) => {
    const r = vals(metricRows).filter((x) => x && x.key === key).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    return r.length ? r[r.length - 1] : { value: null, ts: '' };
  };
  const M = (k) => latestMetric(k).value;
  const Mrow = (k) => latestMetric(k);
  const adherence = M('rules.adherencePct');
  const hits = M('rules.hits');
  const zeroHitFull = Number(hits) === 0 && Number(adherence) === 100;
  const memTotal = M('memory.total') ?? NO_DATA;
  const abMissing = domainMissing.has('agint_abtest.json');

  const curriculumRows = vals(curriculum.challenges);
  // 判据必须与 v2-data.js 的 PENDING_SPECS['curriculum-challenge'].select 一致（status==='open'），
  // 否则 KPI 与「队列」视图会对同一个队列报出两个数。
  const curriculumPending = curriculumRows.filter((r) => r && r.status === 'open').length;
  const mutatorRows = Object.keys(mutator || {}).reduce((a, k) => (Array.isArray(Object.values(mutator[k] || {})[0]) ? a : a), 0);
  const mutatorCount = num(mutator) ? vals(mutator).reduce((a, v) => a + (isObj(v) ? num(v) : 0), 0) : 0;
  const popCount = isObj(population) ? Object.keys(population).reduce((a, k) => a + (isObj(population[k]) ? num(population[k]) : 0), 0) : 0;
  const selfModelCount = isObj(selfModel) ? Object.keys(selfModel).length : 0;

  const tools = readToolStats(storagesDir, nowMs);
  const events = readEvents(storagesDir, v2);
  const pendingAgg = (() => { try { return aggPending(storagesDir); } catch (e) { return { queues: [], error: (e && e.code) || 'read-error' }; } })();
  const queues = (Array.isArray(pendingAgg.queues) ? pendingAgg.queues : []).map((q) => (
    q && q.reason ? { ...q, reason: sanitizeReason(q.reason) } : q
  ));
  const oracleAgg = (() => { try { return aggOracle(storagesDir); } catch (e) { return { state: 'error', reason: (e && e.code) || 'read-error' }; } })();
  const upstreamAgg = (() => { try { return aggUpstream(storagesDir); } catch (e) { return { state: 'error', reason: (e && e.code) || 'read-error' }; } })();

  const oracleCards = Array.isArray(oracleAgg.cards) ? oracleAgg.cards : [];
  const oracleHistory = Array.isArray(oracleAgg.history) ? oracleAgg.history : [];
  const oracleTopic = oracleAgg.latest?.topic || oracleCards[0]?.topic || null;
  const upCounts = upstreamAgg.counts || {};

  const pendingTotal = queues.reduce((a, q) => a + (q.kind === 'action' && typeof q.pending === 'number' ? q.pending : 0), 0);
  const supplyTotal = queues.reduce((a, q) => a + (q.kind === 'supply' && typeof q.pending === 'number' ? q.pending : 0), 0);

  const dayCutoff = new Date(nowMs - 7 * 86400000).toISOString().slice(0, 10);
  const logThisWeek = Object.entries(logByDay).filter(([d]) => d >= dayCutoff).reduce((a, [, v]) => a + v, 0);
  const logCount7d = M('evolution.logCount7d');
  const currentWeek = isoWeek(new Date(nowMs));

  const sparkMetric = byDayOf(metricRows, (v) => v.ts);
  const sparkProp = byDayOf(proposals, (v) => v.createdAt || v.updatedAt || v.ts);
  const sparkOut = byDayOf(evolution.prediction_outcomes, (v) => v.measuredAt || v.createdAt || v.recordedAt || v.ts);
  const SPARK = { evoMem: logByDay, trajectory: trajByDay, metrics: sparkMetric, propose: sparkProp, outcomes: sparkOut };

  const proposalAging = (() => {
    const days = vals(proposals)
      .filter((p) => p && (p.status === 'proposed' || p.status === 'approved'))
      .map((p) => {
        const t = Date.parse(p.createdAt || p.updatedAt || '');
        return Number.isFinite(t) ? Math.floor((nowMs - t) / 86400000) : null;
      })
      .filter((x) => typeof x === 'number' && x >= 0)
      .sort((a, b) => a - b);
    if (!days.length) return { oldestDays: null, medianDays: null, n: 0 };
    return { oldestDays: days[days.length - 1], medianDays: days[Math.floor(days.length / 2)], n: days.length };
  })();

  const ctx = {
    abMissing, abtests: num(abtest.abtests), acProposals: num(acProposals), acReleases: num(acReleases),
    curriculumPending, oracleCards: oracleCards.length, pendingTotal,
  };

  /* ── 节点（21 个；L0 新增「上游扰动」） ─────────────────────────────── */
  const layers = [
    { key: 'L0', name: '运行时宿主', hint: 'dsh web / patch 层', nodes: [
      { id: 'host', name: 'dsh 宿主与挂载', code: 'cordis.patch.yml → host Services',
        value: num(cronState), unit: '个 job 已注册', tone: 'ok',
        src: 'agint_cron.json / tables.cron_state',
        detail: '宿主层本身不落 storages 快照；这里用已注册 cron job 数证明调度平面活着。preset tool rows / 插件数权威值见 AGENTS.md 自动块，本页不重复计数。' },
      { id: 'upstream', name: '上游扰动', code: 'agint-upstream-watch · dsh 发行',
        value: upstreamAgg.state === 'ok' ? (upCounts.digests ?? 0) : NO_DATA,
        unit: upstreamAgg.state === 'ok' ? '份发行判读' : '域不存在 / 未启用',
        tone: upstreamAgg.state !== 'ok' ? 'idle' : ((upCounts.blockers ?? 0) > 0 ? 'bad' : ((upCounts.judged ?? 0) === 0 ? 'warn' : 'ok')),
        src: 'agint_upstream_watch.json / tables.digests',
        detail: upstreamAgg.state !== 'ok'
          ? 'agint_upstream_watch 域不可得 ⇒ 上游判读未启用或从未跑过。⛔ 这不是「上游无变化」。'
          : '判读 ' + (upCounts.judged ?? 0) + ' / 失败 ' + (upCounts.failed ?? 0) + ' / 阻断 ' + (upCounts.blockers ?? 0) + ' / 语义告警 ' + (upCounts.semanticWarn ?? 0) + '。最新 ' + (upstreamAgg.latest?.tag || '—') + '。' },
    ] },
    { key: 'L1', name: '信号采集', hint: '每次调用 / 每日 / tick', nodes: [
      { id: 'metrics', name: '指标采集', code: 'agint.metrics', value: num(metricRows), unit: '条 metric 时序', tone: 'ok',
        src: 'agint_metrics.json / tables.metric', detail: '每次采集落一条 KV 时序，供评估引擎读取。按表内实际行数计数。' },
      { id: 'cron', name: '调度', code: 'agint.cron', value: cronBad.length + ' / ' + num(cronState), unit: '个 job 非 ok', tone: cronBad.length ? 'bad' : 'ok',
        src: 'agint_cron.json / tables.cron_state', detail: 'lastResult≠ok 的 job 数按当次快照判定。staleOverdue=' + (M('cron.staleOverdue') ?? '?') + '，staleInactive=' + (M('cron.staleInactive') ?? '?') + '。' },
      { id: 'trajectory', name: '轨迹', code: 'agint.trajectory', value: num(traj), unit: '条轨迹', tone: 'ok',
        src: 'agint_trajectory.json / tables.trajectories', detail: 'source=dream 的轨迹 ' + (trajSource.dream || 0) + ' 条；calibration.current.byDay 覆盖 ' + Object.keys(trajByDay).length + ' 个有数据的日期。' },
      { id: 'rules', name: '门禁瀑布', code: 'agint.rules', value: num(rules.rule), unit: '条规则', tone: zeroHitFull ? 'bad' : 'warn',
        src: 'agint_rules.json / tables.rule, rule_audit', detail: 'adherencePct=' + (adherence ?? '?') + '%、hits=' + (hits ?? '?') + '。' + (zeroHitFull ? '零命中的满分不能当作门禁有效。' : '本次有真实命中，遵守率可读但仍需独立复核。') },
    ] },
    { key: 'L2', name: '记忆与沉淀', hint: 'KV 状态 / 独立进化域', nodes: [
      { id: 'memory', name: '任务记忆', code: 'agint.memory', value: memTotal, unit: '条记忆', tone: 'warn',
        src: 'agint_metrics.json / metric[memory.total]', detail: '本次读数 ' + memTotal + '，平均置信度 ' + (M('memory.avgConfidence') ?? '?') + '。是否长期恒定需另跑 metrics_series，本页不替它下结论。' },
      { id: 'dream', name: '梦境', code: 'agint.dream · 03:00', value: trajSource.dream || 0, unit: '条 dream 轨迹', tone: (trajSource.dream || 0) > 0 ? 'warn' : 'bad',
        src: 'agint_trajectory.json / tables.trajectories[source=dream]', detail: '每日 03:00 cron 触发 light → REM → deep 三阶段。这里只统计 source=dream 的轨迹条数，不推断梦境质量。' },
      { id: 'evoMem', name: '进化记忆（独立域）', code: 'agint.evolution', value: num(evLog), unit: '行 evolution_log', tone: 'ok',
        src: 'agint_evolution.json / tables.*', detail: 'evolution_ledger=' + num(ledger) + '、failure_pattern=' + num(evolution.failure_pattern) + '、prediction_outcomes=' + num(evolution.prediction_outcomes) + '、benchmark_frozen_set=' + num(evolution.benchmark_frozen_set) + '。与任务记忆物理隔离。' },
      { id: 'skillAc', name: '技能候选', code: 'agint_skill_autocreate', value: num(autocreate.task_patterns), unit: '条 task_patterns', tone: 'ok',
        src: 'agint_skill_autocreate.json / tables.*', detail: 'candidates=' + num(acCandidates) + '、proposals=' + num(acProposals) + '、releases=' + num(acReleases) + '。表存在但为 0 行时显示 0，不写成「全部排队」。' },
    ] },
    { key: 'L3', name: '评估与外部判据', hint: '尺子放到系统外', nodes: [
      { id: 'eval', name: '评估引擎 / 神谕层', code: 'quality-eval · aesthetic-oracle',
        value: oracleAgg.state === 'ok' ? oracleCards.length : NO_DATA,
        unit: oracleAgg.state === 'ok' ? '条判词卡' : '神谕域不可得',
        tone: oracleAgg.state !== 'ok' ? 'idle' : (oracleCards.length ? 'ok' : 'warn'),
        src: 'agint_aesthetic_oracle.json / tables.oracle_cards, oracle_broadcasts',
        detail: oracleAgg.state !== 'ok'
          ? '神谕层存储域不可得（' + sanitizeReason(oracleAgg.reason) + '）。⛔ 不是「神谕没开过口」。'
          : '判词卡 ' + oracleCards.length + ' 条、广播史 ' + oracleHistory.length + ' 条、最新档 ' + (oracleTopic || '—') + '。评分链路永久零 LLM，aesthetic_score 是内部卫生公式、不是智能分数；判据不读任何分数字段。' },
      { id: 'baseline', name: '能力基线（冻结集）', code: 'capability-baseline · SEALED', value: NO_DATA, unit: '外置冻结集（仓库文件）', tone: 'frozen',
        src: 'eval/capability-baseline/sets/*.json', detail: '该子系统是运行时结构节点，不在本页读取的 storages 域内；三份集合密封并以 contentHash 校验，运行时只读。GOLD 是「运营者授权 · agent 执行 · 非人类验证」的机械真值，capabilityConclusion 恒 null，不得据此宣称能力水平。' },
      { id: 'observe', name: '观察 / 遵守率', code: 'agint_abtest · rules', value: abMissing ? NO_DATA : num(abtest.abtests), unit: abMissing ? '域不存在（非 0 行）' : '个 A/B 实验',
        tone: abMissing ? 'idle' : (num(abtest.abtests) > 0 ? 'ok' : 'bad'),
        src: 'agint_abtest.json / tables.abtests, samples', detail: abMissing
          ? 'agint_abtest.json 不在 storages ⇒ 域不存在。⛔ 这与「表存在但 0 行实验」是两件事，本页显示 — 而不是 0。'
          : 'abtests=' + num(abtest.abtests) + '、samples=' + num(abtest.samples) + '；rules.adherencePct=' + (adherence ?? '?') + '%、hits=' + (hits ?? '?') + '。' },
    ] },
    { key: 'L4', name: '进化决策', hint: '提案 / 课程 / 变异', nodes: [
      { id: 'propose', name: '提案', code: 'agint.evolve', value: num(proposals), unit: '条 proposal', tone: 'ok',
        src: 'agint_evolve.json / tables.proposal',
        detail: '状态分布：' + JSON.stringify(statusDist) + '；待批 ' + (statusDist.proposed || 0) + ' · 已批准 ' + (statusDist.approved || 0) + '。批准 / 拒绝 / wontfix 是面板唯一的人工写入口（在提案台 tab）。' },
      { id: 'curriculum', name: '课程挑战', code: 'agint-curriculum',
        value: curriculumRows.length ? curriculumRows.length : (curriculumRows.length === 0 && !domainMissing.has('agint_curriculum.json') ? 0 : NO_DATA),
        unit: curriculumRows.length || !domainMissing.has('agint_curriculum.json') ? '条挑战（' + curriculumPending + ' 待做）' : '域不存在',
        tone: !domainMissing.has('agint_curriculum.json') ? (curriculumPending > 0 ? 'warn' : 'ok') : 'idle',
        src: 'agint_curriculum.json / tables.challenges',
        detail: 'challenges=' + curriculumRows.length + ' 条，其中待做 ' + curriculumPending + '；attempts=' + num(curriculum.attempts) + '、audit_log=' + num(curriculum.audit_log) + '。队列明细见检查器「队列」视图。' },
      { id: 'mutator', name: '变异与种群', code: 'agint-mutator · population',
        value: mutatorCount || popCount || NO_DATA,
        unit: (mutatorCount || popCount) ? ('条变异/种群记录') : '无可读表',
        tone: (mutatorCount || popCount) ? 'warn' : 'idle',
        src: 'agint_mutator.json · agint_population.json',
        detail: 'mutator 记录 ' + mutatorCount + '、population 记录 ' + popCount + '。只统计可读行数，不推断变异质量或种群适应度。' },
    ] },
    { key: 'L5', name: '闸门与投递', hint: '默认拒绝 · 允许 ≠ 写入', nodes: [
      { id: 'gates', name: '五闸', code: 'autonomous-write-gate', value: NO_DATA, unit: 'defaultDeny · G1–G5', tone: 'human',
        src: 'bin/autonomous-write-gate.mjs', detail: '该子系统是运行时结构节点，不在本页读取的 storages 域内。G1 只认字面量 on；G2 只认外部冻结证据；G3 目标白名单；G4 可证伪预测；G5 人工否决 + 24h 撤销。闸全过只到「允许投递候选」，⛔ 不等于已写入生产。' },
      { id: 'queue', name: '候选队列', code: 'proposal_queue', value: num(acProposals), unit: '条 skill proposal', tone: num(acProposals) > 0 ? 'bad' : 'warn',
        src: 'agint_skill_autocreate.json / tables.proposals', detail: '本次 ' + num(acProposals) + ' 行' + (num(acProposals) === 0 ? '（表存在但无记录，⛔ 不是「全部排队」）' : '，状态分布 ' + JSON.stringify(acPropStatus)) + '。' },
      { id: 'release', name: '发布与挂载', code: 'release · mount · abtest', value: num(acReleases), unit: '次发布', tone: num(acReleases) > 0 ? 'bad' : 'warn',
        src: 'agint_skill_autocreate.json / tables.releases; agint_metrics.json', detail: '本次 releases=' + num(acReleases) + ' 行，状态分布 ' + JSON.stringify(relStatus) + '；policy.deployedCount=' + (M('policy.deployedCount') ?? '?') + '。' },
    ] },
    { key: 'L6', name: '反馈闭环', hint: '对拍 / 人类最终否决', nodes: [
      { id: 'outcomes', name: '预测对拍', code: 'prediction_outcomes', value: num(evolution.prediction_outcomes), unit: '条对拍记录', tone: 'warn',
        src: 'agint_evolution.json / tables.prediction_outcomes', detail: '事先写死 predictedDelta 与来源，下一 ISO 周重读同一张表算 actualDelta；不符就如实记为预测失败，不解释成能力退步。' },
      { id: 'human', name: '人工否决 · 24h', code: 'veto · humanVerdict', value: NO_DATA, unit: '人类最终否决权', tone: 'human',
        src: 'eval/gated-features/生产投递评审单.md', detail: '该子系统是运行时结构节点，不在本页读取的 storages 域内。判尺标定需要人来判断，系统自己给自己标注会退回自评循环。本页不代填、不计数人工标注。' },
    ] },
  ];

  layers.forEach((L, i) => { L.y = LAYER_Y0 + i * LAYER_STEP; });
  const layoutLayer = (L) => {
    const n = L.nodes.length;
    if (n === 1) {
      const w = 520;
      return [{ ...L.nodes[0], x: AX + (AW - w) / 2, y: L.y, w, h: NH, layer: L.key }];
    }
    const w = (AW - NGAP * (n - 1)) / n;
    return L.nodes.map((node, i) => ({ ...node, x: AX + i * (w + NGAP), y: L.y, w, h: NH, layer: L.key }));
  };
  const nodes = layers.flatMap(layoutLayer);
  const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));

  /* ── 边（26 条；断点按当次判据，可自动恢复） ───────────────────────── */
  const edges = EDGE_DECL.map(([from, to, kind, label, basis, breakWhen], i) => {
    let k = kind;
    if (kind === 'break' && typeof breakWhen === 'function') {
      let still = true;
      try { still = breakWhen(ctx) === true; } catch { still = true; }
      if (!still) k = 'live';
    }
    return { i, from, to, kind: k, declaredKind: kind, label, basis };
  });

  const edgeEvidence = {
    'skillAc->observe': abMissing ? 'agint_abtest.json 域不存在（不是 0 行实验）' : (num(abtest.abtests) === 0 ? 'abtest.abtests=0（表存在但无实验）' : 'abtests=' + num(abtest.abtests) + '（已恢复）'),
    'observe->curriculum': '课程挑战 ' + curriculumRows.length + ' 条（待做 ' + curriculumPending + '）；实验回流 ' + (abMissing ? '域不存在' : num(abtest.abtests) + ' 个'),
    'curriculum->queue': 'skill proposal ' + num(acProposals) + ' 行（0 = 无写入积压）',
    'mutator->release': 'releases ' + num(acReleases) + ' 行；mutator ' + mutatorCount + ' / population ' + popCount,
    'release->outcomes': 'releases ' + num(acReleases) + ' 行；prediction_outcomes ' + num(evolution.prediction_outcomes) + ' 条',
    'queue->outcomes': 'skill proposal ' + num(acProposals) + ' 行；无观察样本回写',
  };
  edges.forEach((e) => { const k = e.from + '->' + e.to; if (edgeEvidence[k]) e.evidence = edgeEvidence[k]; });

  const deg = {};
  edges.forEach((e) => {
    deg[e.from] = deg[e.from] || { i: 0, o: 0 };
    deg[e.to] = deg[e.to] || { i: 0, o: 0 };
    deg[e.from].o++; deg[e.to].i++;
  });
  nodes.forEach((n) => { n.deg = deg[n.id] || { i: 0, o: 0 }; });

  const exOf = (id) => {
    const n = nodeById[id];
    const table = {
      host: [['cron_state', num(cronState)]],
      upstream: [['digests', upstreamAgg.state === 'ok' ? (upCounts.digests ?? 0) : '—']],
      metrics: [['metric', num(metricRows)]],
      cron: [['cron_state', num(cronState)]],
      trajectory: [['trajectories', num(traj)]],
      rules: [['rule', num(rules.rule)], ['rule_audit', num(ruleAudit)]],
      memory: [['metric[memory.total]', memTotal]],
      dream: [['dream 源轨迹', trajSource.dream || 0]],
      evoMem: [['evolution_log', num(evLog)], ['evolution_ledger', num(ledger)], ['failure_pattern', num(evolution.failure_pattern)], ['prediction_outcomes', num(evolution.prediction_outcomes)], ['benchmark_frozen_set', num(evolution.benchmark_frozen_set)]],
      skillAc: [['task_patterns', num(autocreate.task_patterns)], ['candidates', num(acCandidates)], ['proposals', num(acProposals)], ['releases', num(acReleases)]],
      eval: [['oracle_cards', oracleAgg.state === 'ok' ? oracleCards.length : '—'], ['oracle_broadcasts', oracleAgg.state === 'ok' ? oracleHistory.length : '—']],
      baseline: [['仓库冻结集', '—']],
      observe: abMissing ? [['域不存在', '—']] : [['abtests', num(abtest.abtests)], ['samples', num(abtest.samples)]],
      propose: [['proposal', num(proposals)]],
      curriculum: [['challenges', curriculumRows.length], ['attempts', num(curriculum.attempts)]],
      mutator: [['mutator', mutatorCount], ['population', popCount]],
      gates: [['不在快照域', '—']],
      queue: [['proposals', num(acProposals)]],
      release: [['releases', num(acReleases)]],
      outcomes: [['prediction_outcomes', num(evolution.prediction_outcomes)]],
      human: [['不在快照域', '—']],
    };
    return table[id] || [];
  };
  const subOf = (id) => {
    const map = {
      host: '30d 工具 ' + (tools.state === 'ok' ? tools.calls : '—') + ' 次 · 失败 ' + (tools.state === 'ok' ? tools.fails : '—'),
      upstream: upstreamAgg.state === 'ok' ? ('判读 ' + (upCounts.judged ?? 0) + ' · 阻断 ' + (upCounts.blockers ?? 0)) : '域不可得',
      metrics: '近 30 日 ' + Object.keys(sparkMetric).length + ' 个采样日',
      cron: 'staleOverdue ' + (M('cron.staleOverdue') ?? '?') + ' · maxOverdue ' + (M('cron.maxOverdueDays') ?? '?'),
      trajectory: 'dream ' + (trajSource.dream || 0) + ' 条 · ' + Object.keys(trajByDay).length + ' 个采样日',
      rules: 'adherence ' + (adherence ?? '?') + '% · hits ' + (hits ?? '?'),
      memory: 'avgConfidence ' + (M('memory.avgConfidence') ?? '?'),
      dream: '03:00 · light → REM → deep',
      evoMem: 'ledger ' + num(ledger) + ' · fp ' + num(evolution.failure_pattern) + ' · po ' + num(evolution.prediction_outcomes) + ' · bfs ' + num(evolution.benchmark_frozen_set),
      skillAc: [num(autocreate.task_patterns), num(acCandidates), num(acProposals), num(acReleases)].join(' → ') + ' （patterns→cand→prop→rel）',
      eval: oracleAgg.state === 'ok' ? ('最新 ' + (oracleTopic || '—') + ' · 广播 ' + oracleHistory.length) : '神谕域不可得',
      baseline: 'SEALED · contentHash · 非人类验证',
      observe: abMissing ? '域不存在，不是 0 行实验' : ('samples ' + num(abtest.samples)),
      propose: (statusDist.proposed || 0) + ' 待批 · ' + (statusDist.approved || 0) + ' 已批',
      curriculum: '待做 ' + curriculumPending + ' / 共 ' + curriculumRows.length,
      mutator: 'mutator ' + mutatorCount + ' · pop ' + popCount,
      gates: 'G1 on · G2 GOLD/HELDOUT · G5 24h',
      queue: num(acProposals) === 0 ? '表存在但无记录' : JSON.stringify(acPropStatus),
      release: 'deployedCount ' + (M('policy.deployedCount') ?? '?') + ' · ' + JSON.stringify(relStatus),
      outcomes: '下一 ISO 周对拍 actualDelta',
      human: '人工标注不代填',
    };
    return map[id] || '';
  };

  /* ── 诊断面（原健康 / 支路 / 复盘 / 数据源） ───────────────────────── */
  const stages = [
    { key: 'detect', name: 'detect', cn: '模式聚合', main: num(autocreate.task_patterns), unit: '条 task_patterns', tone: num(autocreate.task_patterns) > 0 ? 'ok' : 'warn',
      sub: num(acCandidates) + ' 个候选被聚合出来' + (num(acCandidates) === 0 ? '（本轮无候选）' : ''),
      src: 'agint_skill_autocreate.json / tables.task_patterns' },
    { key: 'evaluate', name: 'evaluate', cn: '评估', main: num(acCandidates), unit: '个候选', tone: num(acCandidates) > 0 ? 'warn' : 'bad',
      sub: (candStatus.REJECTED || 0) + ' REJECTED / ' + (candStatus.ROLLED_BACK || 0) + ' ROLLED_BACK；' + num(acProposals) + ' 条 skill proposal',
      src: 'agint_skill_autocreate.json / tables.candidates, proposals' },
    { key: 'queue', name: 'queue', cn: '排队', main: acPropStatus.QUEUED_FOR_RELEASE || 0, unit: '条待发布', tone: num(acProposals) > 0 ? 'bad' : 'warn',
      sub: num(acProposals) === 0 ? 'proposals 表本次为 0 行（表存在但无记录），不是「全部排队」' : num(acProposals) + ' 条 skill proposal；evolution_log 另有 ' + (logDecision.PENDING_REVIEW || 0) + ' 条 PENDING_REVIEW',
      src: 'agint_skill_autocreate.json / tables.proposals; agint_evolution.json / tables.evolution_log' },
    { key: 'release', name: 'release', cn: '发布', main: num(acReleases), unit: '次发布', tone: num(acReleases) > 0 ? (relStatus.ROLLED_BACK === num(acReleases) ? 'bad' : 'ok') : 'warn',
      sub: num(acReleases) === 0 ? 'releases 表本次为 0 行（表存在但无记录）；policy.deployedCount=' + (M('policy.deployedCount') ?? '?') : (relStatus.ROLLED_BACK || 0) + ' 次 ROLLED_BACK / 共 ' + num(acReleases) + ' 次；ledger ' + num(ledger) + ' 条锚定记录',
      src: 'agint_skill_autocreate.json / tables.releases; agint_metrics.json; agint_evolution.json / tables.evolution_ledger' },
    { key: 'observe', name: 'observe', cn: '观察', main: abMissing ? '—' : num(abtest.abtests), unit: abMissing ? '域不存在' : '个 A/B 实验', tone: abMissing ? 'warn' : (num(abtest.abtests) > 0 ? 'ok' : 'bad'),
      sub: abMissing ? 'agint_abtest.json 不在 storages ⇒ 域不存在（不是 0 行实验）；prediction_outcomes=' + num(evolution.prediction_outcomes) + '；evolution_log ' + num(evLog) + ' 行' : 'abtest.samples=' + num(abtest.samples) + '；prediction_outcomes=' + num(evolution.prediction_outcomes) + '；evolution_log ' + num(evLog) + ' 行',
      src: 'agint_abtest.json（可能不存在）; agint_evolution.json / tables.prediction_outcomes, evolution_log' },
    { key: 'archive', name: 'archive / rollback', cn: '归档或回滚', main: (skillState.archived || 0) + (skillState.stale || 0), unit: '个技能归档/转旧', tone: 'warn',
      sub: 'curator: archived=' + (skillState.archived || 0) + ' / stale=' + (skillState.stale || 0) + ' / active=' + (skillState.active || 0) + '；policy.rolledbackCount=' + (M('policy.rolledbackCount') ?? '该 key 不存在'),
      src: 'agint_curator.json / tables.skill_states; agint_metrics.json' },
  ];

  const trajDays = Object.keys(trajByDay).sort();
  const lastTrajDay = trajDays.length ? trajDays[trajDays.length - 1] : '—';
  const vitals = [
    { title: '梦境服务', tone: (trajSource.dream || 0) > 0 ? 'warn' : 'bad', value: (trajSource.dream || 0) + ' 条', label: 'source=dream 轨迹 / 共 ' + num(traj) + ' 条',
      detail: '最近采样日 ' + lastTrajDay + ' 写入 ' + (trajByDay[lastTrajDay] ?? '?') + ' 条；trajectory.writeFailures=' + (trajectory.counters?.current?.writeFailures ?? '?') },
    { title: '规则门禁遵守率', tone: zeroHitFull ? 'bad' : 'warn', value: (adherence ?? '?') + '%', label: 'rules.adherencePct（最后采样 ' + String(Mrow('rules.adherencePct').ts).slice(0, 10) + '）',
      detail: '同批 rules.hits=' + (hits ?? '?') + ' / rules.blocked=' + (M('rules.blocked') ?? '?') + ' ⇒ ' + (zeroHitFull ? '零命中的 100%，不能当作门禁有效' : '本次有真实命中，遵守率可读但仍需独立复核') + '。rule 表 ' + num(rules.rule) + ' 条、rule_audit ' + num(ruleAudit) + ' 条。' },
    { title: 'cron 健康', tone: cronBad.length > 0 ? 'bad' : 'ok', value: cronBad.length + ' / ' + num(cronState), label: '个 job 上次跑非 ok',
      detail: 'cron.staleOverdue=' + (M('cron.staleOverdue') ?? '?') + '，cron.staleInactive=' + (M('cron.staleInactive') ?? '?') + '，maxOverdueDays=' + (M('cron.maxOverdueDays') ?? '?') + '。' + (cronBad.length ? cronBad.map(([k, v]) => k + '：' + String(v.lastError || '').slice(0, 70)).join('；') : '本次无 lastResult≠ok 的 job。') },
    { title: '待办积压', tone: pendingTotal > 0 ? 'warn' : 'ok', value: pendingTotal + ' / ' + supplyTotal, label: '待办（人能动手） / 供给（等上游）',
      detail: '队列共 ' + queues.length + ' 条，明细见「队列」视图。⛔ 「域不存在」显示为灰、pending=null，不折成 0。' },
  ];

  const reportWeeks = vals(curator.reports).map((r) => r.week || r.weekKey || '').filter(Boolean).sort();
  const latestWeek = reportWeeks.length ? reportWeeks[reportWeeks.length - 1] : currentWeek;
  const latestReport = vals(curator.reports).find((r) => (r.week || r.weekKey) === latestWeek) || null;
  const recalledRows = vals(evLog).filter((v) => Number(v.recalls || 0) > 0).length;
  const resolvedFalse = dist(evLog, (v) => v.resolved).false || 0;
  const breakLines = [];
  if (abMissing) breakLines.push('agint_abtest.json 域不存在（不是 0 行实验），「观察」阶段无数据源。');
  else if (num(abtest.abtests) === 0) breakLines.push('abtest.abtests=0 / samples=0，表存在但无实验数据。');
  if (zeroHitFull) breakLines.push('rules.adherencePct=100 与 rules.hits=0 同批出现，遵守率判据不可信。');
  if (num(acProposals) === 0) breakLines.push('skill_autocreate.proposals 本次 0 行（无待发布积压）。');
  if (num(acReleases) > 0 && relStatus.ROLLED_BACK === num(acReleases)) breakLines.push(num(acReleases) + ' 次发布全部 ROLLED_BACK。');
  if (resolvedFalse > 0) breakLines.push('evolution_log ' + num(evLog) + ' 行中 resolved=false 占 ' + resolvedFalse + ' 行。');
  if (logCount7d !== null && Number(logCount7d) !== logThisWeek) breakLines.push('evolution.logCount7d=' + logCount7d + ' 与 evolution_log 按日计数近 7 日合计 ' + logThisWeek + ' 不一致，口径待核。');
  if (curriculumPending > 0) breakLines.push('课程挑战 ' + curriculumPending + ' 条待做（agint_curriculum.challenges）。');
  if (!breakLines.length) breakLines.push('本次快照未检出上述结构性断点。');

  const digest = [
    '# AGINT 进化周复盘 · ' + currentWeek + '（只读）',
    '',
    '- 生成时间：' + new Date(nowMs).toISOString(),
    '- 数据源：' + storageLabel + '/（生产存储，只读）',
    '',
    '## 本周数字',
    '',
    '| 指标 | 值 | 来源 |',
    '|---|---|---|',
    '| promoted（policy.deployedCount） | ' + (M('policy.deployedCount') ?? '?') + ' | agint_metrics.json |',
    '| recalled（evolution_log.recalls > 0） | ' + recalledRows + ' / ' + num(evLog) + ' 行 | agint_evolution.json |',
    '| 规则总数 | ' + num(rules.rule) + ' | agint_rules.json |',
    '| cron 漏跑（staleOverdue / staleInactive） | ' + (M('cron.staleOverdue') ?? '?') + ' / ' + (M('cron.staleInactive') ?? '?') + ' | agint_metrics.json |',
    '| curator 最新周报 | ' + latestWeek + '（newlyArchived=' + (latestReport?.summary?.newlyArchived ?? '?') + '） | agint_curator.json |',
    '| evolution_log 近 7 日新增 | ' + logThisWeek + ' | agint_evolution.json |',
    '| 指标口径 evolution.logCount7d | ' + (logCount7d ?? '?') + ' | agint_metrics.json |',
    '| 待办 / 供给 | ' + pendingTotal + ' / ' + supplyTotal + ' | aggPending（9 队列） |',
    '| 神谕判词卡 / 广播 | ' + (oracleAgg.state === 'ok' ? oracleCards.length + ' / ' + oracleHistory.length : '域不可得') + ' | agint_aesthetic_oracle.json |',
    '',
    '## 断点（按当次数据判定）',
    '',
    ...breakLines.map((s, i) => (i + 1) + '. ' + s),
  ].join('\n');

  const tableCounts = [
    ['agint_evolution.json', [['evolution_log', num(evLog)], ['evolution_ledger', num(ledger)], ['failure_pattern', num(evolution.failure_pattern)], ['prediction_outcomes', num(evolution.prediction_outcomes)], ['benchmark_frozen_set', num(evolution.benchmark_frozen_set)]]],
    ['agint_evolve.json', [['proposal', num(proposals)]]],
    ['agint_metrics.json', [['metric', num(metricRows)]]],
    ['agint_cron.json', [['cron_state', num(cronState)]]],
    ['agint_abtest.json', abMissing ? [['域不存在（非 0 行）', '—']] : [['abtests', num(abtest.abtests)], ['samples', num(abtest.samples)]]],
    ['agint_curator.json', [['skill_states', num(skillStates)], ['reports', num(curator.reports)], ['audit_log', num(curator.audit_log)]]],
    ['agint_trajectory.json', [['trajectories', num(traj)]]],
    ['agint_skill_autocreate.json', [['task_patterns', num(autocreate.task_patterns)], ['candidates', num(acCandidates)], ['proposals', num(acProposals)], ['releases', num(acReleases)]]],
    ['agint_rules.json', [['rule', num(rules.rule)], ['rule_audit', num(ruleAudit)]]],
    ['agint_aesthetic_oracle.json', oracleAgg.state === 'ok' ? [['oracle_cards', oracleCards.length], ['oracle_broadcasts', oracleHistory.length]] : [['域不可得', '—']]],
    ['agint_curriculum.json', [[ 'challenges', curriculumRows.length], ['attempts', num(curriculum.attempts)]]],
    ['agint_upstream_watch.json', upstreamAgg.state === 'ok' ? [['digests', upCounts.digests ?? 0]] : [['域不可得', '—']]],
    ['agint_mutator.json · agint_population.json', [['mutator', mutatorCount], ['population', popCount]]],
    ['agint_tool_stats.jsonl', [[tools.state === 'ok' ? '30d 调用' : '未读到', tools.state === 'ok' ? tools.calls : '—']]],
  ];

  const liveCount = edges.filter((e) => e.kind === 'live').length;
  const breakCount = edges.filter((e) => e.kind === 'break').length;
  const feedbackCount = edges.filter((e) => e.kind === 'feedback').length;
  const frozenCount = edges.filter((e) => e.kind === 'frozen').length;
  const humanCount = edges.filter((e) => e.kind === 'human').length;
  const measuredCount = nodes.filter((n) => n.value !== NO_DATA).length;

  const kpis = [
    ['节点', nodes.length, ''],
    ['主链路', liveCount, 'ok'],
    ['断点', breakCount, 'bad'],
    ['回流', feedbackCount, 'ok'],
    ['域缺失', missingFiles.length, 'bad'],
    ['待办 / 供给', pendingTotal + ' / ' + supplyTotal, pendingTotal > 0 ? 'warn' : ''],
    ['神谕卡', oracleAgg.state === 'ok' ? oracleCards.length : '—', oracleAgg.state === 'ok' ? '' : 'bad'],
    ['课程待做', curriculumPending, curriculumPending > 0 ? 'warn' : ''],
    ['遵守率', (adherence ?? '?') + '%', zeroHitFull ? 'bad' : 'warn'],
    ['cron 非 ok', cronBad.length + '/' + num(cronState), cronBad.length ? 'bad' : 'ok'],
    ['记忆', memTotal, ''],
    ['近 7 日 log', logThisWeek, ''],
  ];

  const bounds = {
    logCount7d, logThisWeek, consistent: Number(logCount7d) === logThisWeek,
    missingFiles, missingReasons: missing.slice(),
    measured: measuredCount, structural: nodes.length - measuredCount,
    breakCount, liveCount, feedbackCount,
    storageLabel, currentWeek,
    oracleState: oracleAgg.state || 'unknown',
    upstreamState: upstreamAgg.state || 'unknown',
    eventsState: events.state,
    toolsState: tools.state,
    pendingError: pendingAgg.error || null,
  };

  return {
    generatedAt: new Date(nowMs).toISOString(),
    storageLabel,
    missing,
    missingFiles,
    domains: tableCounts,
    counts: { nodes: nodes.length, edges: edges.length, live: liveCount, break: breakCount, feedback: feedbackCount, frozen: frozenCount, human: humanCount, measured: measuredCount, structural: nodes.length - measuredCount },
    kpis,
    layers: layers.map((L) => ({ key: L.key, name: L.name, hint: L.hint, y: L.y, nodes: L.nodes.map((n) => n.id) })),
    nodes,
    edges,
    sparkSeries: SPARK,
    stages,
    vitals,
    digest,
    currentWeek,
    queues,
    oracle: { state: oracleAgg.state || 'unknown', reason: oracleAgg.reason || null, cards: oracleCards.length, history: oracleHistory.length, topic: oracleTopic, latest: oracleAgg.latest || null },
    upstream: { state: upstreamAgg.state || 'unknown', counts: upCounts, latest: upstreamAgg.latest || null },
    events,
    tools,
    proposals: { total: num(proposals), byStatus: statusDist, queueCount: statusDist.proposed || 0, aging: proposalAging, source: 'storages' },
    selfModelCount,
    bounds,
  };
}

export { NO_DATA };
