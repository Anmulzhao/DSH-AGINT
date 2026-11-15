// AGINT 进化架构图 —— 只读快照生成器 + 家族面板部署（正式形态）
// 2026-11-15 由「进化流水线 · 六阶段时序」升级为「进化架构图 · 系统动态」：
//   分层拓扑 + 真实读写/触发关系 + 反馈闭环。流动粒子表示链路方向与拓扑，
//   ⛔ 不表示实时流量、不代表吞吐或成功率；节点读数每次重跑从 storages 现取。
// 三态纪律：有数显示数；域不存在显示 —（灰，不是 0）；表存在但 0 行显示 0 并注明。
//   ⛔ 结构节点若不在本快照数据源内，显示 — 而不编造数字，不拿 0 冒充没测过。
// 2026-11-04 定案的部署路线不变：家族面板一个 tab、不新建插件、不改
//   cordis.patch.yml、不加 cron、不重启宿主（readV2Html 按 mtime 缓存）。
// 边界：只读生产存储。不写任何状态。不改任何表。不加依赖（仅 Node 内置模块）。
// 用法：node bin/evolution-viz-snapshot.mjs
// 输出 1：docs/AGINT-进化架构图.html（独立单文件，覆盖同名文件）
// 输出 2：三份 assets/panel-v2.html 的「进化架构图」tab（幂等标记替换）
//   仓库位 / .agint-bundle 加载位 / profiles/<profile.json> 镜像位。
// 零重启依据：family-panel/lib/index.js:102-115 的 readV2Html() 按 mtime 缓存。
// 刷新：重跑本脚本。宿主继续写存储时页面不会自动更新。
// ⛔ 本文件是正式资产，不是 _ 前缀一次性产物，不要按临时文件清理。

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 路径一律推导，不写死绝对路径（AGENTS.md 第 16 条红线：机器私有事实不入库）。
// REPO_ROOT = 本仓根（脚本在 bin/ 下，往上一级）。
// DSH_HOME  = 生产存储与部署位所在目录，两台机器不同。
//   缺 env 时回落到本机约定值，只影响本机运行，不进库。
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DSH_HOME = process.env.DSH_HOME || 'D:/DSH/AGINT-date';
const STORAGES = join(DSH_HOME, 'storages');
const S = STORAGES + '/';
// 展示用的数据源标签用**符号路径**，不用绝对路径：这段文字会被烤进
// panel-v2.html（仓内文件），绝对路径属机器私有事实，AGENTS.md 第 16 条红线不入库。
const STORAGES_LABEL = '$DSH_HOME/storages';
const OUT = join(DSH_HOME, '..', 'docs', 'AGINT-进化架构图.html');
const PROPOSAL_ID = 'd85347bf-984a-41ee-b8d5-b54ac74b4105';
const missing = [];
// 域不存在 ≠ 表内 0 行。面板必须把两者区分开（灰 — / 数字 0）。
const domainMissing = new Set();

function load(f) {
  try {
    const d = JSON.parse(fs.readFileSync(S + f, 'utf8'));
    return d.tables || d;
  } catch (e) {
    missing.push(f + ': ' + e.message);
    domainMissing.add(f);
    return {};
  }
}
const num = (o) => Object.keys(o || {}).length;
const vals = (o) => (o && typeof o === 'object' ? Object.values(o) : []);
function dist(o, f) {
  const m = {};
  for (const v of vals(o)) {
    const k = String(f(v));
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}
function latest(rows, key) {
  const r = vals(rows).filter((x) => x && x.key === key).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return r.length ? r[r.length - 1] : { value: null, ts: '' };
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
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

const proposal = proposals[PROPOSAL_ID] || null;
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

const M = (k) => latest(metricRows, k);
const createdDays = proposal && proposal.createdAt
  ? Math.floor((Date.now() - Date.parse(proposal.createdAt)) / 86400000) : null;

// 六阶段（已降级为「支路明细」，不再是主视图）：全部按当次数据判定。
// ⛔ 不沿用 11-08 的「124 条全排队 / 5 次全回滚 / 恒为 875」等历史结论。
const abMissing = domainMissing.has('agint_abtest.json');
const stages = [
  {
    key: 'detect', name: 'detect', cn: '模式聚合',
    main: num(autocreate.task_patterns), unit: '条 task_patterns',
    sub: num(acCandidates) + ' 个候选被聚合出来' + (num(acCandidates) === 0 ? '（本轮无候选）' : ''),
    src: 'agint_skill_autocreate.json / tables.task_patterns',
    tone: num(autocreate.task_patterns) > 0 ? 'ok' : 'warn',
  },
  {
    key: 'evaluate', name: 'evaluate', cn: '评估',
    main: num(acCandidates), unit: '个候选',
    sub: (candStatus.REJECTED || 0) + ' REJECTED / ' + (candStatus.ROLLED_BACK || 0) + ' ROLLED_BACK；' + num(acProposals) + ' 条 skill proposal',
    src: 'agint_skill_autocreate.json / tables.candidates, proposals',
    tone: num(acCandidates) > 0 ? 'warn' : 'bad',
  },
  {
    key: 'queue', name: 'queue', cn: '排队',
    main: acPropStatus.QUEUED_FOR_RELEASE || 0, unit: '条待发布',
    sub: num(acProposals) === 0
      ? 'proposals 表本次为 0 行（表存在但无记录），不是「全部排队」'
      : num(acProposals) + ' 条 skill proposal；evolution_log 另有 ' + (logDecision.PENDING_REVIEW || 0) + ' 条 PENDING_REVIEW',
    src: 'agint_skill_autocreate.json / tables.proposals; agint_evolution.json / tables.evolution_log',
    tone: num(acProposals) > 0 ? 'bad' : 'warn',
  },
  {
    key: 'release', name: 'release', cn: '发布',
    main: num(acReleases), unit: '次发布',
    sub: num(acReleases) === 0
      ? 'releases 表本次为 0 行（表存在但无记录）；policy.deployedCount=' + (M('policy.deployedCount').value ?? '?')
      : (relStatus.ROLLED_BACK || 0) + ' 次 ROLLED_BACK / 共 ' + num(acReleases) + ' 次；ledger ' + num(ledger) + ' 条锚定记录',
    src: 'agint_skill_autocreate.json / tables.releases; agint_metrics.json; agint_evolution.json / tables.evolution_ledger',
    tone: num(acReleases) > 0 ? (relStatus.ROLLED_BACK === num(acReleases) ? 'bad' : 'ok') : 'warn',
  },
  {
    key: 'observe', name: 'observe', cn: '观察',
    main: abMissing ? '—' : num(abtest.abtests), unit: abMissing ? '域不存在' : '个 A/B 实验',
    sub: abMissing
      ? 'agint_abtest.json 不在 storages ⇒ 域不存在（不是 0 行实验）；prediction_outcomes=' + num(evolution.prediction_outcomes) + '；evolution_log ' + num(evLog) + ' 行'
      : 'abtest.samples=' + num(abtest.samples) + '；prediction_outcomes=' + num(evolution.prediction_outcomes) + '；evolution_log ' + num(evLog) + ' 行',
    src: 'agint_abtest.json（可能不存在）; agint_evolution.json / tables.prediction_outcomes, evolution_log',
    tone: abMissing ? 'warn' : (num(abtest.abtests) > 0 ? 'ok' : 'bad'),
  },
  {
    key: 'archive', name: 'archive / rollback', cn: '归档或回滚',
    main: (skillState.archived || 0) + (skillState.stale || 0), unit: '个技能归档/转旧',
    sub: 'curator: archived=' + (skillState.archived || 0) + ' / stale=' + (skillState.stale || 0) + ' / active=' + (skillState.active || 0) + '；policy.rolledbackCount=' + (M('policy.rolledbackCount').value ?? '该 key 不存在'),
    src: 'agint_curator.json / tables.skill_states; agint_metrics.json',
    tone: 'warn',
  },
];

// 折线图（纯 SVG，无外部依赖）
function lineChart(series, w, h, color) {
  const entries = Object.entries(series).filter(([k]) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort(([a], [b]) => a.localeCompare(b)).slice(-30);
  if (!entries.length) return '<div class="empty">无可用序列</div>';
  const max = Math.max(1, ...entries.map(([, v]) => v));
  const pad = { l: 34, r: 12, t: 12, b: 26 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const pts = entries.map(([, v], i) => [pad.l + (entries.length === 1 ? iw / 2 : (i / (entries.length - 1)) * iw), pad.t + ih - (v / max) * ih]);
  const poly = pts.map(([x, y]) => x.toFixed(1) + ',' + y.toFixed(1)).join(' ');
  const area = poly + ' ' + pts[pts.length - 1][0].toFixed(1) + ',' + (pad.t + ih) + ' ' + pts[0][0].toFixed(1) + ',' + (pad.t + ih);
  let grid = '';
  for (let i = 0; i <= 2; i++) {
    const y = pad.t + (ih / 2) * i;
    const label = Math.round(max - (max / 2) * i);
    grid += '<line x1="' + pad.l + '" y1="' + y + '" x2="' + (w - pad.r) + '" y2="' + y + '" stroke="#e8ebf0" stroke-width="1"/>';
    grid += '<text x="' + (pad.l - 6) + '" y="' + (y + 4) + '" text-anchor="end" font-size="10" fill="#8a94a6">' + label + '</text>';
  }
  const dots = pts.map(([x, y], i) => '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="2.4" fill="' + color + '"><title>' + entries[i][0] + ' : ' + entries[i][1] + '</title></circle>').join('');
  const first = entries[0][0].slice(5), last = entries[entries.length - 1][0].slice(5);
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '" role="img" aria-label="时间序列">' + grid
    + '<polygon points="' + area + '" fill="' + color + '" opacity="0.09"/>'
    + '<polyline points="' + poly + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round"/>' + dots
    + '<text x="' + pad.l + '" y="' + (h - 6) + '" font-size="10" fill="#8a94a6">' + first + '</text>'
    + '<text x="' + (w - pad.r) + '" y="' + (h - 6) + '" text-anchor="end" font-size="10" fill="#8a94a6">' + last + '</text></svg>';
}

// 健康四卡片：阈值与措辞按当次数据判定，不粉饰、不沿用旧快照结论。
const hits = M('rules.hits').value;
const adherence = M('rules.adherencePct').value;
const zeroHitFull = Number(hits) === 0 && Number(adherence) === 100;
const trajDays = Object.keys(trajByDay).sort();
const lastTrajDay = trajDays.length ? trajDays[trajDays.length - 1] : '—';
const health = [
  {
    title: '梦境服务', tone: (trajSource.dream || 0) > 0 ? 'warn' : 'bad',
    value: (trajSource.dream || 0) + ' 条', label: 'source=dream 轨迹 / 共 ' + num(traj) + ' 条',
    detail: '最近采样日 ' + lastTrajDay + ' 写入 ' + (trajByDay[lastTrajDay] ?? '?') + ' 条；trajectory.writeFailures=' + (trajectory.counters?.current?.writeFailures ?? '?'),
  },
  {
    title: '规则门禁遵守率', tone: zeroHitFull ? 'bad' : 'warn',
    value: (adherence ?? '?') + '%', label: 'rules.adherencePct（最后采样 ' + String(M('rules.adherencePct').ts).slice(0, 10) + '）',
    detail: '同批 rules.hits=' + (hits ?? '?') + ' / rules.blocked=' + (M('rules.blocked').value ?? '?') + ' ⇒ ' + (zeroHitFull ? '零命中的 100%，不能当作门禁有效' : '本次有真实命中，遵守率可读但仍需独立复核') + '。rule 表 ' + num(rules.rule) + ' 条、rule_audit ' + num(ruleAudit) + ' 条。',
  },
  {
    title: 'cron 健康', tone: cronBad.length > 0 ? 'bad' : 'ok',
    value: cronBad.length + ' / ' + num(cronState), label: '个 job 上次跑非 ok',
    detail: 'cron.staleOverdue=' + (M('cron.staleOverdue').value ?? '?') + '，cron.staleInactive=' + (M('cron.staleInactive').value ?? '?') + '，maxOverdueDays=' + (M('cron.maxOverdueDays').value ?? '?') + '。' + (cronBad.length ? cronBad.map(([k, v]) => k + '：' + String(v.lastError || '').slice(0, 70)).join('；') : '本次无 lastResult≠ok 的 job。'),
  },
  {
    title: '记忆规模', tone: 'ok',
    value: String(M('memory.total').value ?? '?'), label: '条记忆 / 平均置信度 ' + (M('memory.avgConfidence').value ?? '?'),
    detail: '本次读数 ' + (M('memory.total').value ?? '?') + '；是否长期恒定需另跑 metrics_series 复核，本页不替它下结论。skills.totalBytes=' + (M('skills.totalBytes').value ?? '?') + '。',
  },
];

// 周复盘：ISO 周、断点、提案状态全部按当次数据生成，不写死 W45 / 124 条 / 5 次回滚。
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((t - y0) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + '-W' + String(w).padStart(2, '0');
}
const currentWeek = isoWeek(new Date());
const reportWeeks = vals(curator.reports).map((r) => r.week || r.weekKey || '').filter(Boolean).sort();
const latestWeek = reportWeeks.length ? reportWeeks[reportWeeks.length - 1] : currentWeek;
const latestReport = vals(curator.reports).find((r) => (r.week || r.weekKey) === latestWeek) || null;
const recalledRows = vals(evLog).filter((v) => Number(v.recalls || 0) > 0).length;
const resolvedFalse = dist(evLog, (v) => v.resolved).false || 0;
// 按日历窗口算「近 7 日」，不用「最后 7 个有数据的日期」。后者会把旧数据算进来。
const dayCutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const logThisWeek = Object.entries(logByDay).filter(([d]) => d >= dayCutoff).reduce((a, [, v]) => a + v, 0);
const breakLines = [];
if (abMissing) breakLines.push('agint_abtest.json 域不存在（不是 0 行实验），「观察」阶段无数据源。');
else if (num(abtest.abtests) === 0) breakLines.push('abtest.abtests=0 / samples=0，表存在但无实验数据。');
if (zeroHitFull) breakLines.push('rules.adherencePct=100 与 rules.hits=0 同批出现，遵守率判据不可信。');
if (num(acProposals) === 0) breakLines.push('skill_autocreate.proposals 本次 0 行（无待发布积压）。');
if (num(acReleases) > 0 && relStatus.ROLLED_BACK === num(acReleases)) breakLines.push(num(acReleases) + ' 次发布全部 ROLLED_BACK。');
if (resolvedFalse > 0) breakLines.push('evolution_log ' + num(evLog) + ' 行中 resolved=false 占 ' + resolvedFalse + ' 行。');
const logCount7d = M('evolution.logCount7d').value;
if (logCount7d !== null && Number(logCount7d) !== logThisWeek) breakLines.push('evolution.logCount7d=' + logCount7d + ' 与 evolution_log 按日计数近 7 日合计 ' + logThisWeek + ' 不一致，口径待核。');
if (!breakLines.length) breakLines.push('本次快照未检出上述结构性断点。');
const digest = [
  '# AGINT 进化周复盘 · ' + currentWeek + '（只读快照）',
  '',
  '- 快照时间：' + new Date().toISOString(),
  '- 数据源：' + STORAGES_LABEL + '/（生产存储，只读）',
  '',
  '## 本周数字',
  '',
  '| 指标 | 值 | 来源 |',
  '|---|---|---|',
  '| promoted（policy.deployedCount） | ' + (M('policy.deployedCount').value ?? '?') + ' | agint_metrics.json |',
  '| recalled（evolution_log.recalls > 0） | ' + recalledRows + ' / ' + num(evLog) + ' 行 | agint_evolution.json |',
  '| 规则总数 | ' + num(rules.rule) + ' | agint_rules.json |',
  '| cron 漏跑（staleOverdue / staleInactive） | ' + (M('cron.staleOverdue').value ?? '?') + ' / ' + (M('cron.staleInactive').value ?? '?') + ' | agint_metrics.json |',
  '| curator 最新周报 | ' + latestWeek + '（newlyArchived=' + (latestReport?.summary?.newlyArchived ?? '?') + '） | agint_curator.json |',
  '| evolution_log 近 7 日新增 | ' + logThisWeek + ' | agint_evolution.json |',
  '| 指标口径 evolution.logCount7d | ' + (logCount7d ?? '?') + ' | agint_metrics.json |',
  '',
  '## 断点（按当次数据判定）',
  '',
  ...breakLines.map((s, i) => (i + 1) + '. ' + s),
  '',
  '## 历史提案 d85347bf',
  '',
  '- ' + (proposal
    ? '状态：' + proposal.status + '；立项 ' + String(proposal.createdAt ?? '').slice(0, 10) + '，已 ' + createdDays + ' 天未动。'
    : '该提案 ID 已不在当前 agint_evolve.json 的 proposal 表（本次 ' + num(proposals) + ' 条），旧版面板围绕它的「待批准 / 暂缓判据失效」叙事不再适用。'),
  '- Evolution Ledger 当前 ' + num(ledger) + ' 行。',
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
];

const stageCards = stages.map((s, i) => '<div class="stage tone-' + s.tone + '" title="' + esc(s.src) + '">'
  + '<div class="stage-h"><span class="stage-i">' + (i + 1) + '</span><span class="stage-n">' + esc(s.name) + '</span><span class="stage-cn">' + esc(s.cn) + '</span></div>'
  + '<div class="stage-v">' + s.main.toLocaleString() + '<span class="stage-u">' + esc(s.unit) + '</span></div>'
  + '<div class="stage-s">' + esc(s.sub) + '</div>'
  + '<div class="stage-src">来源：' + esc(s.src) + '</div>'
  + '</div>').join('<div class="arrow">→</div>');

const healthCards = health.map((h) => '<div class="hcard tone-' + h.tone + '"><div class="hcard-t">' + esc(h.title) + '</div>'
  + '<div class="hcard-v">' + esc(h.value) + '</div><div class="hcard-l">' + esc(h.label) + '</div>'
  + '<div class="hcard-d">' + esc(h.detail) + '</div></div>').join('');

const countsHtml = tableCounts.map(([f, rows]) => '<tr><td class="mono">' + esc(f) + '</td><td>' + rows.map(([k, v]) => '<span class="chip">' + esc(k) + ' <b>' + v + '</b></span>').join(' ') + '</td></tr>').join('');

// ── 进化架构图：分层拓扑 + 真实读数 + 信号流动 ─────────────────────────
// 关系依据 docs/architecture.md「数据流：复盘 + 评估闭环」与 AGENTS.md 子系统清单。
// ⛔ 粒子只表示「真实存在的读写/触发关系与方向」，不表示实时流量、不代表吞吐或成功率。
// ⛔ 结构节点若不在本快照的 9 个 storages 域内，读数显示 —，不编造数字、不拿 0 冒充。

const TONE = {
  ok:     { label: '活跃（有真实读数）', stroke: '#15803d', fill: '#f0fdf4', chip: '#15803d' },
  warn:   { label: '可疑 / 待核',       stroke: '#b45309', fill: '#fffbeb', chip: '#b45309' },
  bad:    { label: '断点（本次无数据）', stroke: '#b91c1c', fill: '#fef2f2', chip: '#b91c1c' },
  frozen: { label: '外置冻结',           stroke: '#6d28d9', fill: '#f5f3ff', chip: '#6d28d9' },
  human:  { label: '人工闸门',           stroke: '#1d4ed8', fill: '#eef2ff', chip: '#1d4ed8' },
  idle:   { label: '无快照读数',         stroke: '#94a3b8', fill: '#f8fafc', chip: '#64748b' },
};
const EDGE = {
  live:     { label: '主链路 · 真实读写 / 触发', stroke: '#1d4ed8', dot: '#1d4ed8', dash: '', arrow: 'ar-live' },
  break:    { label: '断点 · 本次无数据 / 全回滚', stroke: '#b91c1c', dot: '#b91c1c', dash: '5 5', arrow: '' },
  frozen:   { label: '外置判据 · 系统碰不到', stroke: '#6d28d9', dot: '#6d28d9', dash: '3 4', arrow: '' },
  human:    { label: '人工闸门 · 默认拒绝', stroke: '#1d4ed8', dot: '#1d4ed8', dash: '2 4', arrow: '' },
  feedback: { label: '反馈回流 · 闭环', stroke: '#0f766e', dot: '#0f766e', dash: '', arrow: 'ar-fb' },
};
const NO_DATA = '—';
const memTotal = M('memory.total').value ?? NO_DATA;
const STRUCT = '该子系统是运行时结构节点，不在本快照读取的 9 个 storages 域内。本页只画它在闭环中的位置，不编造读数。';

const archLayers = [
  { key: 'L0', name: '运行时宿主', hint: 'dsh web / patch 层', y: 56, nodes: [
    { id: 'host', name: 'dsh 宿主与挂载', code: 'cordis.patch.yml → host Services',
      value: num(cronState), unit: '个 job 已注册', tone: 'ok',
      src: 'agint_cron.json / tables.cron_state',
      detail: '宿主层本身不落 storages 快照；这里用已注册 cron job 数证明调度平面活着。preset tool rows / 插件数的权威值见 AGENTS.md 自动块，本页不重复计数。' },
  ] },
  { key: 'L1', name: '信号采集', hint: '每次调用 / 每日 / tick', y: 166, nodes: [
    { id: 'metrics', name: '指标采集', code: 'agint.metrics', value: num(metricRows), unit: '条 metric 时序', tone: 'ok',
      src: 'agint_metrics.json / tables.metric', detail: '每次采集落一条 KV 时序，供评估引擎读取。按表内实际行数计数。' },
    { id: 'cron', name: '调度', code: 'agint.cron', value: cronBad.length + ' / ' + num(cronState), unit: '个 job 非 ok', tone: cronBad.length ? 'bad' : 'ok',
      src: 'agint_cron.json / tables.cron_state', detail: 'lastResult≠ok 的 job 数按当次快照判定。staleOverdue=' + (M('cron.staleOverdue').value ?? '?') + '，staleInactive=' + (M('cron.staleInactive').value ?? '?') + '。' },
    { id: 'trajectory', name: '轨迹', code: 'agint.trajectory', value: num(traj), unit: '条轨迹', tone: 'ok',
      src: 'agint_trajectory.json / tables.trajectories', detail: 'source=dream 的轨迹 ' + (trajSource.dream || 0) + ' 条；calibration.current.byDay 覆盖 ' + Object.keys(trajByDay).length + ' 个有数据的日期。' },
    { id: 'rules', name: '门禁瀑布', code: 'agint.rules', value: num(rules.rule), unit: '条规则', tone: zeroHitFull ? 'bad' : 'warn',
      src: 'agint_rules.json / tables.rule, rule_audit', detail: 'adherencePct=' + (adherence ?? '?') + '%、hits=' + (hits ?? '?') + '。' + (zeroHitFull ? '零命中的满分不能当作门禁有效。' : '本次有真实命中，遵守率可读但仍需独立复核。') },
  ] },
  { key: 'L2', name: '记忆与沉淀', hint: 'KV 状态 / 独立进化域', y: 276, nodes: [
    { id: 'memory', name: '任务记忆', code: 'agint.memory', value: memTotal, unit: '条记忆', tone: 'warn',
      src: 'agint_metrics.json / metric[memory.total]', detail: '本次读数 ' + memTotal + '，平均置信度 ' + (M('memory.avgConfidence').value ?? '?') + '。是否长期恒定需另跑 metrics_series，本页不替它下结论。' },
    { id: 'dream', name: '梦境', code: 'agint.dream · 03:00', value: trajSource.dream || 0, unit: '条 dream 轨迹', tone: (trajSource.dream || 0) > 0 ? 'warn' : 'bad',
      src: 'agint_trajectory.json / tables.trajectories[source=dream]', detail: '每日 03:00 cron 触发 light → REM → deep 三阶段。这里只统计 source=dream 的轨迹条数，不推断梦境质量。' },
    { id: 'evoMem', name: '进化记忆（独立域）', code: 'agint_evolution', value: num(evLog), unit: '行 evolution_log', tone: 'ok',
      src: 'agint_evolution.json / tables.*', detail: 'evolution_ledger=' + num(ledger) + '、failure_pattern=' + num(evolution.failure_pattern) + '、prediction_outcomes=' + num(evolution.prediction_outcomes) + '、benchmark_frozen_set=' + num(evolution.benchmark_frozen_set) + '。与任务记忆物理隔离。' },
    { id: 'skillAc', name: '技能候选', code: 'agint_skill_autocreate', value: num(autocreate.task_patterns), unit: '条 task_patterns', tone: 'ok',
      src: 'agint_skill_autocreate.json / tables.*', detail: 'candidates=' + num(acCandidates) + '、proposals=' + num(acProposals) + '、releases=' + num(acReleases) + '。表存在但为 0 行时显示 0，不写成「全部排队」。' },
  ] },
  { key: 'L3', name: '评估与外部判据', hint: '尺子放到系统外', y: 386, nodes: [
    { id: 'eval', name: '评估引擎 / 神谕层', code: 'quality-eval · aesthetic-oracle', value: NO_DATA, unit: '不在本快照数据源', tone: 'idle',
      src: 'docs/evolution-framework.md · AGENTS.md', detail: STRUCT + ' 评分链路永久零 LLM，aesthetic_score 是内部卫生公式、不是智能分数；判据不读任何分数字段。' },
    { id: 'baseline', name: '能力基线（冻结集）', code: 'capability-baseline · SEALED', value: NO_DATA, unit: '外置冻结集（仓库文件）', tone: 'frozen',
      src: 'eval/capability-baseline/sets/*.json', detail: STRUCT + ' 三份集合密封并以 contentHash 校验，运行时只读。GOLD 是「运营者授权 · agent 执行 · 非人类验证」的机械真值，capabilityConclusion 恒 null，不得据此宣称能力水平。' },
    { id: 'observe', name: '观察 / 遵守率', code: 'agint_abtest · rules', value: abMissing ? NO_DATA : num(abtest.abtests), unit: abMissing ? '域不存在（非 0 行）' : '个 A/B 实验', tone: abMissing ? 'idle' : (num(abtest.abtests) > 0 ? 'ok' : 'bad'),
      src: 'agint_abtest.json / tables.abtests, samples', detail: abMissing
        ? 'agint_abtest.json 不在 storages ⇒ 域不存在。⛔ 这与「表存在但 0 行实验」是两件事，本页显示 — 而不是 0。'
        : 'abtests=' + num(abtest.abtests) + '、samples=' + num(abtest.samples) + '；rules.adherencePct=' + (adherence ?? '?') + '%、hits=' + (hits ?? '?') + '。' },
  ] },
  { key: 'L4', name: '进化决策', hint: '提案 / 课程 / 变异', y: 496, nodes: [
    { id: 'propose', name: '提案', code: 'agint.evolve', value: num(proposals), unit: '条 proposal', tone: 'ok',
      src: 'agint_evolve.json / tables.proposal', detail: '状态分布：' + JSON.stringify(statusDist) + '。批准 / 拒绝 / wontfix 是面板唯一的人工写入口。' },
    { id: 'curriculum', name: '课程挑战', code: 'agint-curriculum', value: NO_DATA, unit: '不在本快照数据源', tone: 'idle',
      src: 'AGENTS.md 子系统清单', detail: STRUCT + ' 自主课程学习链路，本快照未采集其队列读数。' },
    { id: 'mutator', name: '变异与种群', code: 'agint-mutator · population', value: NO_DATA, unit: '不在本快照数据源', tone: 'idle',
      src: 'AGENTS.md 子系统清单', detail: STRUCT + ' 候选变异与种群支路，本快照未采集其读数。' },
  ] },
  { key: 'L5', name: '闸门与投递', hint: '默认拒绝 · 允许 ≠ 写入', y: 606, nodes: [
    { id: 'gates', name: '五闸', code: 'autonomous-write-gate', value: NO_DATA, unit: 'defaultDeny · G1–G5', tone: 'human',
      src: 'bin/autonomous-write-gate.mjs', detail: STRUCT + ' G1 只认字面量 on；G2 只认外部冻结证据；G3 目标白名单；G4 可证伪预测；G5 人工否决 + 24h 撤销。闸全过只到「允许投递候选」，⛔ 不等于已写入生产。' },
    { id: 'queue', name: '候选队列', code: 'proposal_queue', value: num(acProposals), unit: '条 skill proposal', tone: num(acProposals) > 0 ? 'bad' : 'warn',
      src: 'agint_skill_autocreate.json / tables.proposals', detail: '本次 ' + num(acProposals) + ' 行' + (num(acProposals) === 0 ? '（表存在但无记录，⛔ 不是「全部排队」）' : '，状态分布 ' + JSON.stringify(acPropStatus)) + '。' },
    { id: 'release', name: '发布与挂载', code: 'release · mount · abtest', value: num(acReleases), unit: '次发布', tone: num(acReleases) > 0 ? 'bad' : 'warn',
      src: 'agint_skill_autocreate.json / tables.releases; agint_metrics.json', detail: '本次 releases=' + num(acReleases) + ' 行，状态分布 ' + JSON.stringify(relStatus) + '；policy.deployedCount=' + (M('policy.deployedCount').value ?? '?') + '。' },
  ] },
  { key: 'L6', name: '反馈闭环', hint: '对拍 / 人类最终否决', y: 716, nodes: [
    { id: 'outcomes', name: '预测对拍', code: 'prediction_outcomes', value: num(evolution.prediction_outcomes), unit: '条对拍记录', tone: 'warn',
      src: 'agint_evolution.json / tables.prediction_outcomes', detail: '事先写死 predictedDelta 与来源，下一 ISO 周重读同一张表算 actualDelta；不符就如实记为预测失败，不解释成能力退步。' },
    { id: 'human', name: '人工否决 · 24h', code: 'veto · humanVerdict', value: NO_DATA, unit: '人类最终否决权', tone: 'human',
      src: 'eval/gated-features/生产投递评审单.md', detail: STRUCT + ' 判尺标定需要人来判断，系统自己给自己标注会退回自评循环。本页不代填、不计数人工标注。' },
  ] },
];

// 坐标：左侧 0..130 放层标签，主区 140..1130；右侧 1184..1224 留给回流折线。
const AX = 140, AW = 990, NH = 78, NGAP = 26, RX0 = 1184;
const VB_W = 1240, VB_H = 840;
function layout(L) {
  const n = L.nodes.length;
  if (n === 1) {
    const w = 520;
    return [{ ...L.nodes[0], x: AX + (AW - w) / 2, y: L.y, w, h: NH, layer: L.key }];
  }
  const w = (AW - NGAP * (n - 1)) / n;
  return L.nodes.map((node, i) => ({ ...node, x: AX + i * (w + NGAP), y: L.y, w, h: NH, layer: L.key }));
}
const archNodes = archLayers.flatMap(layout);
const nodeById = Object.fromEntries(archNodes.map((n) => [n.id, n]));

// 每条边都是一条真实存在的读写 / 触发 / 回流关系；break = 本次快照里这条链路没有数据。
const archEdges = [
  ['host', 'metrics', 'live', '挂载 host Service'],
  ['host', 'cron', 'live', 'tick 调度'],
  ['host', 'trajectory', 'live', 'tools/result 监听'],
  ['host', 'rules', 'live', 'tools/pre 瀑布'],
  ['metrics', 'evoMem', 'live', '每日指标写入'],
  ['cron', 'dream', 'live', '03:00 night-dream'],
  ['trajectory', 'skillAc', 'live', '任务模式聚合'],
  ['rules', 'memory', 'live', '门禁瀑布约束写入'],
  ['evoMem', 'eval', 'live', '评估读 4 源'],
  ['dream', 'eval', 'live', '梦境候选 → 评估'],
  ['memory', 'baseline', 'frozen', '外置，系统碰不到'],
  ['skillAc', 'observe', 'break', '观察阶段无数据'],
  ['eval', 'propose', 'live', '复盘 → 提案'],
  ['eval', 'mutator', 'live', '评估 → 变异探索'],
  ['baseline', 'propose', 'frozen', '锚定约束'],
  ['observe', 'curriculum', 'break', '无实验回流'],
  ['propose', 'gates', 'live', '候选处方'],
  ['curriculum', 'queue', 'break', '无课程挑战写入'],
  ['mutator', 'release', 'break', '无发布记录'],
  ['gates', 'human', 'human', '24h 撤销窗口'],
  ['release', 'outcomes', 'break', '无实验数据'],
  ['queue', 'outcomes', 'break', '无观察样本'],
  ['outcomes', 'baseline', 'feedback', '下周对拍 actualDelta'],
  ['human', 'gates', 'feedback', '否决回落默认拒绝'],
  ['outcomes', 'metrics', 'feedback', '下一轮观察'],
].map(([from, to, kind, label], i) => ({ from, to, kind, label, i }));

function edgePath(e, rx) {
  const a = nodeById[e.from], b = nodeById[e.to];
  const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y;
  if (e.kind !== 'feedback') {
    const my = (y1 + y2) / 2;
    return 'M' + x1.toFixed(1) + ',' + y1.toFixed(1)
      + ' C' + x1.toFixed(1) + ',' + my.toFixed(1) + ' ' + x2.toFixed(1) + ',' + my.toFixed(1)
      + ' ' + x2.toFixed(1) + ',' + y2.toFixed(1);
  }
  // 回流走右侧直角折线：水平段落在层间空隙（目标层上方 26px），不穿任何节点。
  const ax = a.x + a.w, ay = a.y + a.h / 2, gy = y2 - 26;
  return 'M' + ax.toFixed(1) + ',' + ay.toFixed(1)
    + ' L' + rx + ',' + ay.toFixed(1) + ' L' + rx + ',' + gy.toFixed(1)
    + ' L' + x2.toFixed(1) + ',' + gy.toFixed(1) + ' L' + x2.toFixed(1) + ',' + y2.toFixed(1);
}

let fbSeq = 0;
const archEdgesSvg = archEdges.map((e) => {
  const st = EDGE[e.kind];
  const rx = RX0 + fbSeq * 16;
  if (e.kind === 'feedback') fbSeq++;
  const d = edgePath(e, rx);
  const marker = st.arrow ? ' marker-end="url(#' + st.arrow + ')"' : '';
  const dash = st.dash ? ' stroke-dasharray="' + st.dash + '"' : '';
  const op = e.kind === 'break' ? '.7' : (e.kind === 'feedback' ? '.6' : '.4');
  let body = '<path d="' + d + '" fill="none" stroke="' + st.stroke + '" stroke-width="'
    + (e.kind === 'feedback' ? 2 : 1.5) + '" stroke-opacity="' + op + '"' + dash + marker + '/>';
  if (e.kind !== 'break') {
    const dur = { live: 2.9, frozen: 5.4, human: 4.6, feedback: 3.8 }[e.kind];
    const count = e.kind === 'feedback' ? 2 : 1;
    for (let k = 0; k < count; k++) {
      const begin = ((e.i * 0.31 + k * dur / count) % dur).toFixed(2);
      body += '<circle r="' + (e.kind === 'feedback' ? 3.6 : 3) + '" fill="' + st.dot
        + '" opacity=".92"><animateMotion dur="' + dur + 's" begin="' + begin
        + 's" repeatCount="indefinite" path="' + d + '"/></circle>';
    }
  } else {
    const a = nodeById[e.from], b = nodeById[e.to];
    const mx = (a.x + a.w / 2 + b.x + b.w / 2) / 2, my = (a.y + a.h + b.y) / 2;
    body += '<circle cx="' + mx.toFixed(1) + '" cy="' + my.toFixed(1) + '" r="8.5" fill="#fff" stroke="#b91c1c" stroke-width="1.4"/>'
      + '<text x="' + mx.toFixed(1) + '" y="' + (my + 3.4).toFixed(1) + '" text-anchor="middle" font-size="9" font-weight="700" fill="#b91c1c">断</text>';
  }
  return '<g data-edge="' + e.i + '"><title>' + esc(nodeById[e.from].name + ' → ' + nodeById[e.to].name + '：' + e.label)
    + '</title>' + body + '</g>';
}).join('');

const archLayersSvg = archLayers.map((L, i) =>
  '<rect x="134" y="' + (L.y - 10) + '" width="1002" height="96" rx="10" fill="'
  + (i % 2 ? '#eef2f7' : '#f4f7fb') + '" opacity=".72"/>'
  + '<text x="16" y="' + (L.y + 8) + '" font-size="10" font-weight="700" fill="#94a3b8">' + L.key + '</text>'
  + '<text x="16" y="' + (L.y + 28) + '" font-size="12.5" font-weight="700" fill="#334155">' + esc(L.name) + '</text>'
  + '<text x="16" y="' + (L.y + 45) + '" font-size="9" fill="#94a3b8">' + esc(L.hint) + '</text>'
).join('');

const archNodesSvg = archNodes.map((n) => {
  const t = TONE[n.tone];
  const cut = (s, max) => (s.length > max ? s.slice(0, max - 1) + '…' : s);
  return '<g class="node" data-node="' + n.id + '" role="button" tabindex="0" aria-label="' + esc(n.name) + '">'
    + '<rect x="' + n.x.toFixed(1) + '" y="' + n.y + '" width="' + n.w.toFixed(1) + '" height="' + n.h
    + '" rx="9" fill="' + t.fill + '" stroke="' + t.stroke + '" stroke-width="1.5"/>'
    + '<rect x="' + n.x.toFixed(1) + '" y="' + n.y + '" width="4" height="' + n.h + '" rx="2" fill="' + t.stroke + '"/>'
    + '<circle cx="' + (n.x + n.w - 13).toFixed(1) + '" cy="' + (n.y + 15) + '" r="4" fill="' + t.stroke + '"/>'
    + '<text x="' + (n.x + 14).toFixed(1) + '" y="' + (n.y + 23) + '" font-size="13" font-weight="700" fill="#1c2733">' + esc(cut(n.name, 13)) + '</text>'
    + '<text x="' + (n.x + 14).toFixed(1) + '" y="' + (n.y + 39) + '" font-size="9.5" fill="#64748b" font-family="ui-monospace,Consolas,monospace">' + esc(cut(n.code, Math.floor(n.w / 6))) + '</text>'
    + '<text x="' + (n.x + 14).toFixed(1) + '" y="' + (n.y + 64) + '" font-size="20" font-weight="750" fill="' + t.chip + '">' + esc(String(n.value)) + '</text>'
    + '<text x="' + (n.x + n.w - 12).toFixed(1) + '" y="' + (n.y + 64) + '" text-anchor="end" font-size="10" fill="#64748b">' + esc(cut(n.unit, 16)) + '</text>'
    + '</g>';
}).join('');

const archSvg = '<svg id="arch" viewBox="0 0 ' + VB_W + ' ' + VB_H + '" width="100%" role="img" aria-label="AGINT 进化架构图：分层子系统、信号流与反馈闭环">'
  + '<defs>'
  + '<marker id="ar-live" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#1d4ed8" opacity=".75"/></marker>'
  + '<marker id="ar-fb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#0f766e" opacity=".85"/></marker>'
  + '</defs>' + archLayersSvg
  + '<g id="edges">' + archEdgesSvg + '</g><g id="nodes">' + archNodesSvg + '</g>'
  + '<text x="1226" y="26" text-anchor="end" font-size="10" font-weight="700" fill="#0f766e">↑ 反馈回流（右侧）</text>'
  + '</svg>';

// 交互数据：节点详情 + 上下游关系。JSON 里的 < 转义，避免 </script> 提前闭合 iframe 脚本。
const archDetail = {
  nodes: archNodes.map((n) => ({ id: n.id, name: n.name, code: n.code, value: String(n.value), unit: n.unit,
    tone: n.tone, toneLabel: TONE[n.tone].label, src: n.src, detail: n.detail, layer: n.layer })),
  edges: archEdges.map((e) => ({ from: e.from, to: e.to, fromName: nodeById[e.from].name, toName: nodeById[e.to].name,
    kind: e.kind, kindLabel: EDGE[e.kind].label, label: e.label })),
};
const archJson = JSON.stringify(archDetail).replace(/</g, '\\u003c');
const toneLegend = Object.entries(TONE).map(([, t]) => '<span class="lg"><i class="sq" style="background:' + t.fill + ';border-color:' + t.stroke + '"></i>' + t.label + '</span>').join('');
const edgeLegend = Object.entries(EDGE).map(([, e]) => '<span class="lg"><i class="ln" style="border-top-color:' + e.stroke + (e.dash ? ';border-top-style:dashed' : '') + '"></i>' + e.label + '</span>').join('');
const liveCount = archEdges.filter((e) => e.kind === 'live').length;
const breakCount = archEdges.filter((e) => e.kind === 'break').length;
const feedbackCount = archEdges.filter((e) => e.kind === 'feedback').length;
const measuredCount = archNodes.filter((n) => n.value !== NO_DATA).length;

const generatedAt = new Date().toISOString();
const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AGINT 进化架构图 · 系统动态（只读快照）</title>
<style>
:root{--bg:#f6f8fb;--card:#fff;--line:#e3e8ef;--ink:#1c2733;--sub:#5b6879;--mute:#8a94a6;--ok:#15803d;--warn:#b45309;--bad:#b91c1c;--blue:#1d4ed8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif}
.wrap{max-width:1240px;margin:0 auto;padding:28px 24px 60px}
header{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin-bottom:18px;flex-wrap:wrap}
h1{font-size:23px;margin:0 0 4px;letter-spacing:.2px}.lede{color:var(--sub);font-size:13px;margin:0}
.meta{font-size:12px;color:var(--mute);text-align:right;line-height:1.8}.mono{font-family:ui-monospace,Consolas,monospace}
.banner{background:#fff;border:1px solid var(--line);border-left:4px solid var(--blue);border-radius:10px;padding:16px 18px;margin-bottom:22px}
.banner-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.tag{font-size:11px;padding:2px 9px;border-radius:20px;background:#eef2ff;color:var(--blue);border:1px solid #dbe4ff;font-weight:600}
.tag.amber{background:#fffbeb;color:var(--warn);border-color:#fde68a}.tag.green{background:#f0fdf4;color:var(--ok);border-color:#bbf7d0}.tag.red{background:#fef2f2;color:var(--bad);border-color:#fecaca}
.banner h2{font-size:15px;margin:0}.banner p{margin:6px 0 0;color:var(--sub);font-size:13px}
.banner b{color:var(--ink)}
section{margin-bottom:26px}.sec-h{display:flex;align-items:baseline;gap:10px;margin-bottom:10px}
.sec-h h2{font-size:16px;margin:0}.sec-h span{font-size:12px;color:var(--mute)}
.note{background:#fff;border:1px solid var(--line);border-radius:9px;padding:11px 14px;font-size:12.5px;color:var(--sub);margin-bottom:12px}
.note b{color:var(--ink)}
.flow{display:flex;align-items:stretch;gap:6px;overflow-x:auto;padding-bottom:6px}
.stage{flex:1 1 0;min-width:172px;background:#fff;border:1px solid var(--line);border-top:3px solid var(--mute);border-radius:9px;padding:12px 13px}
.stage.tone-ok{border-top-color:var(--ok)}.stage.tone-warn{border-top-color:var(--warn)}.stage.tone-bad{border-top-color:var(--bad)}
.stage-h{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:9px}
.stage-i{width:18px;height:18px;border-radius:50%;background:#eef2f7;color:var(--sub);font-size:11px;display:grid;place-items:center;font-weight:700}
.stage-n{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;font-weight:700}.stage-cn{font-size:11px;color:var(--mute)}
.stage-v{font-size:27px;font-weight:700;line-height:1.1;letter-spacing:-.5px}.stage-u{font-size:11px;font-weight:400;color:var(--sub);margin-left:5px;letter-spacing:0}
.stage-s{font-size:11.5px;color:var(--sub);margin-top:8px;min-height:46px}
.stage-src{font-size:10px;color:var(--mute);border-top:1px dashed var(--line);padding-top:7px;margin-top:8px;word-break:break-all}
.tone-bad .stage-v{color:var(--bad)}.tone-warn .stage-v{color:var(--warn)}.tone-ok .stage-v{color:var(--ok)}
.arrow{display:grid;place-items:center;color:#b8c2d0;font-size:17px;flex:0 0 12px}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.hcard{background:#fff;border:1px solid var(--line);border-radius:9px;padding:14px 15px;border-top:3px solid var(--mute)}
.hcard.tone-ok{border-top-color:var(--ok)}.hcard.tone-warn{border-top-color:var(--warn)}.hcard.tone-bad{border-top-color:var(--bad)}
.hcard-t{font-size:12px;color:var(--sub);font-weight:600}.hcard-v{font-size:25px;font-weight:700;margin:5px 0 1px;letter-spacing:-.5px}
.tone-bad .hcard-v{color:var(--bad)}.tone-warn .hcard-v{color:var(--warn)}.tone-ok .hcard-v{color:var(--ok)}
.hcard-l{font-size:11px;color:var(--mute);margin-bottom:8px}.hcard-d{font-size:11.5px;color:var(--sub);border-top:1px dashed var(--line);padding-top:8px}
.charts{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
.chart{background:#fff;border:1px solid var(--line);border-radius:9px;padding:14px 16px}.chart h3{font-size:13px;margin:0 0 2px}.chart .cap{font-size:11px;color:var(--mute);margin-bottom:6px}
.empty{color:var(--mute);font-size:12px;padding:20px 0}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:9px;overflow:hidden;font-size:12px}
td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}td:first-child{width:230px;color:var(--sub)}
.chip{display:inline-block;background:#f2f5f9;border:1px solid #e5eaf1;border-radius:5px;padding:1px 7px;margin:2px 4px 2px 0;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--sub)}.chip b{color:var(--ink)}
pre{background:#0f172a;color:#dbe4f0;border-radius:9px;padding:16px 18px;font:12px/1.65 ui-monospace,Consolas,monospace;overflow:auto;max-height:420px;margin:0}
.btn{background:var(--blue);color:#fff;border:0;border-radius:6px;padding:7px 14px;font-size:12px;cursor:pointer;margin-bottom:10px}.btn:hover{opacity:.88}
.btn.ghost{background:#fff;color:var(--blue);border:1px solid #c7d7ff;margin-bottom:0}.btn.ghost:hover{opacity:.75}
.statbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}
.stat{background:#fff;border:1px solid var(--line);border-radius:9px;padding:10px 15px;min-width:128px}
.stat b{display:block;font-size:23px;line-height:1.2;font-variant-numeric:tabular-nums}.stat span{font-size:11px;color:var(--mute)}
.arch-shell{background:#fff;border:1px solid var(--line);border-radius:11px;padding:14px 14px 12px}
.arch-top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}
.legend{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--sub)}
.lg{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}.lg i{display:inline-block}
.lg .sq{width:11px;height:11px;border:1.5px solid;border-radius:3px}.lg .ln{width:17px;height:0;border-top:2px solid}
.arch-scroll{overflow-x:auto}#arch{display:block;width:100%;min-width:920px;height:auto}
#arch .node{cursor:pointer}#arch .node:hover rect:first-child{stroke-width:2.6}#arch .node.sel rect:first-child{stroke-width:3}
.detail{margin-top:12px;background:#f8fafc;border:1px solid var(--line);border-radius:9px;padding:14px 16px;min-height:104px}
.detail h3{margin:0 0 6px;font-size:15px}.detail .kv{font-size:12px;color:var(--sub);margin:3px 0}.detail .kv b{color:var(--ink)}
.detail .rel{font-size:11.5px;color:var(--sub);border-top:1px dashed var(--line);margin-top:9px;padding-top:8px}
.selfcheck{font-size:11.5px;font-weight:700;color:var(--ok);margin-top:10px}.selfcheck.bad{color:var(--bad)}
details{margin-top:10px}details summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--blue)}
footer{font-size:11.5px;color:var(--sub);border-top:1px solid var(--line);padding-top:14px;margin-top:26px}footer li{margin-bottom:4px}
@media(max-width:900px){.grid4{grid-template-columns:repeat(2,1fr)}.charts{grid-template-columns:1fr}}
@media(max-width:620px){.grid4{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<header><div><h1>AGINT 进化架构图 · 系统动态</h1><p class="lede">分层拓扑 · 真实信号流 · 反馈闭环 · 只读快照（2026-11-15 由「进化流水线」升级）</p></div>
<div class="meta">快照生成：${esc(generatedAt)}<br>数据源：${esc(STORAGES_LABEL)}/（9 个域，只读）<br>形态：单文件 HTML，零外部依赖</div></header>

<div class="banner"><div class="banner-top"><span class="tag green">正式形态 · 只读 HTML</span><span class="tag">分层架构图</span><span class="tag amber">${breakCount} 处断点链路</span><span class="tag red">${missing.length} 个域不存在</span><span class="tag green">不写任何状态</span></div>
<h2>不再是一条流水线，而是一张会动的系统结构图</h2>
<p>旧版把进化画成「六阶段线性时序」，并把 11-08 的读数与提案故事烤进页面。本版改为<b>分层架构图</b>：L0 宿主 → L1 采集 → L2 记忆 → L3 判据 → L4 决策 → L5 闸门投递 → L6 反馈回流，<b>连线上流动的信号表示各子系统之间真实存在的读写 / 触发 / 回流关系</b>，右侧绿色折线是闭环。六阶段降为图中一条支路的明细。</p>
<p>所有读数、状态色、断点判定、周复盘文字<b>每次重跑都从生产 storages 现取</b>。本次读到 ${num(metricRows)} 条 metric、${num(evLog)} 行 evolution_log、${num(proposals)} 条 proposal；提案 d85347bf ${proposal ? '仍在表中' : '已不在当前 proposal 表'}，旧版围绕它的「待批准 / 暂缓判据失效」叙事<b>已不再适用</b>。</p></div>

<div class="statbar">
<div class="stat"><b>${archNodes.length}</b><span>架构节点</span></div>
<div class="stat"><b>${measuredCount}</b><span>有 storages 读数</span></div>
<div class="stat"><b>${liveCount}</b><span>主链路（活跃）</span></div>
<div class="stat"><b style="color:var(--bad)">${breakCount}</b><span>断点链路</span></div>
<div class="stat"><b style="color:var(--ok)">${feedbackCount}</b><span>反馈回流</span></div>
<div class="stat"><b>${missing.length}</b><span>域不存在（非 0）</span></div>
</div>

<section><div class="sec-h"><h2>1 · 进化架构图（Evolution Architecture）</h2><span>${archLayers.length} 层 · ${archNodes.length} 节点 · ${archEdges.length} 条关系 · 点节点看来源</span></div>
<div class="note"><b>「动态」到底表示什么。</b>沿连线移动的小圆点表示<b>真实存在的读写 / 触发 / 回流关系与方向</b>（依据 docs/architecture.md「复盘 + 评估闭环」与 AGENTS.md 子系统清单），⛔ <b>不是实时流量</b>，不代表吞吐、频率或成功率。节点读数取自本次快照，宿主继续写存储时本页不会自动变化。红色虚线<b>不画粒子</b> —— 那是本次快照里没有数据的真实断点，把空数据画成流动的线是不诚实的。</div>
<div class="arch-shell">
<div class="arch-top"><div class="legend">${toneLegend}</div><button class="btn ghost" id="motionBtn">⏸ 暂停动态</button></div>
<div class="legend" style="margin-bottom:10px">${edgeLegend}</div>
<div class="arch-scroll">${archSvg}</div>
<div class="detail" id="detail"><h3>系统总览</h3>
<div class="kv">点击图中任意节点，查看它的<b>真实读数、来源字段、状态判定与上下游链路</b>。</div>
<div class="kv">本次快照共 <b>${archNodes.length}</b> 个节点、<b>${archEdges.length}</b> 条关系；<b>${measuredCount}</b> 个节点有 storages 读数，<b>${archNodes.length - measuredCount}</b> 个是运行时结构节点（显示 <b>—</b>，不编造数字）。</div>
<div class="kv">红色「断」标记共 <b>${breakCount}</b> 处；右侧绿色折线是 <b>${feedbackCount}</b> 条反馈回流，构成闭环。</div>
</div>
<div class="selfcheck" id="selfcheck">数据自检：检查中…</div>
</div></section>

<section><div class="sec-h"><h2>2 · 支路明细：技能自动创建六阶段</h2><span>原「进化流水线」时序，现降为图中一条支路</span></div>
<details><summary>展开六阶段计数（按当次数据判定，不沿用历史结论）</summary>
<div class="note" style="margin-top:10px"><b>不画桑基图。</b>跨表没有统一 trace id：ledger 用 contractId / populationCandidateId，autocreate 用 candidateId，两者无 join key。强行连线会造出系统里不存在的轨迹。这里只给阶段计数与断点标记。</div>
<div class="flow" style="margin-top:10px">${stageCards}</div></details></section>

<section><div class="sec-h"><h2>3 · 健康仪表盘（Health Dashboard）</h2><span>四卡片 · 阈值按当次数据判定，不粉饰</span></div>
<div class="grid4">${healthCards}</div>
<div class="charts"><div class="chart"><h3>evolution_log 每日新增</h3><div class="cap">近 30 个有数据的日期 · 共 ${num(evLog)} 行</div>${lineChart(logByDay, 520, 170, '#1d4ed8')}</div>
<div class="chart"><h3>trajectory 每日写入</h3><div class="cap">calibration.current.byDay · 共 ${num(traj)} 条</div>${lineChart(trajByDay, 520, 170, '#0f766e')}</div></div></section>

<section><div class="sec-h"><h2>4 · 周复盘导出（Weekly Digest）</h2><span>${currentWeek} · 断点与数字按当次数据生成</span></div>
<button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('dg').textContent).then(()=>{this.textContent='已复制';setTimeout(()=>this.textContent='复制 Markdown',1600)})">复制 Markdown</button>
<pre id="dg">${esc(digest)}</pre></section>

<section><div class="sec-h"><h2>5 · 数据源盘点</h2><span>本页实际读取的表与行数</span></div>
<table>${countsHtml}</table>${missing.length ? '<div class="note" style="margin-top:10px"><b>⛔ 域不存在（不是 0 行）：</b>' + esc(missing.join('；')) + '。面板显示 — 而不是 0，也不把它计入「实验数为 0」。</div>' : ''}</section>

<footer><b>数据可信度与边界</b><ol>
<li>本页只读。它不改 agint 任何表，不改提案状态，不调用写接口。生成后宿主继续写存储，本页保持生成时刻的快照。</li>
<li><b>三态纪律：</b>有数显示数；域不存在显示 <b>—</b>（灰，⛔ 不是 0）；表存在但 0 行显示 0 并注明。本次 ${missing.length} 个域不存在：${esc(missing.join('；')) || '无'}。</li>
<li><b>结构节点：</b>${archNodes.length - measuredCount} 个子系统不在本快照的 9 个 storages 域内（宿主 / 评估引擎 / 冻结集 / 课程 / 变异 / 五闸 / 人工否决），只画拓扑位置，读数显示 —。<b>不编造数字，不拿 0 冒充没测过。</b></li>
<li><b>动态的含义：</b>粒子表示链路拓扑与信号方向，不表示实时流量；${breakCount} 条断点链路不画粒子。⛔ 不把空数据画成好看的流动线。</li>
<li><b>口径冲突：</b>metrics 的 evolution.logCount7d=${logCount7d ?? '?'}，而 evolution_log 按日计数近 7 日合计 ${logThisWeek}。${Number(logCount7d) === logThisWeek ? '本次两者一致。' : '两者不一致，面板同时列出，不替它们调和。'}</li>
<li><b>不替 AGINT 评估自己：</b>外置冻结集是「运营者授权 · agent 执行 · 非人类验证」的机械真值，capabilityConclusion 恒 null；本页不据此宣称能力水平或能力变化。人工标注需由人填写，本页不代填。</li>
<li><b>正式形态与部署：</b>2026-11-04 定案「保持只读 HTML」的路线不变；2026-11-15 由「进化流水线」tab 升级为「进化架构图」tab。本页作为家族面板该 tab 的 iframe 内容呈现，独立 HTML 仍可直接打开。不新建插件、不改 cordis.patch.yml、不加 cron、不重启宿主。桑基图因跨表无 join key 未做。</li>
<li><b>刷新方式：</b>重跑 <span class="mono">node bin/evolution-viz-snapshot.mjs</span>。它同时更新独立 HTML 与三份 panel-v2.html 的 tab 内容；宿主按 mtime 重读资产，不需要重启。⛔ 想看新状态就重跑，本页不会自己动。</li>
</ol></footer>
</div>
<script>
(function(){
  'use strict';
  var D = ${archJson};
  var svg = document.getElementById('arch');
  var byId = {};
  D.nodes.forEach(function(n){ byId[n.id] = n; });
  var detail = document.getElementById('detail');
  var map = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
  function es(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return map[c]; }); }
  function rel(id){
    var ins = D.edges.filter(function(e){ return e.to === id; });
    var outs = D.edges.filter(function(e){ return e.from === id; });
    function row(e){ return '<div>· ' + es(e.kindLabel) + '：' + es(e.label) + '（' + es(e.fromName) + ' → ' + es(e.toName) + '）</div>'; }
    return '<div class="rel"><b>上游（' + ins.length + '）</b>' + (ins.length ? ins.map(row).join('') : '<div>· 无</div>')
      + '<b style="display:block;margin-top:6px">下游（' + outs.length + '）</b>' + (outs.length ? outs.map(row).join('') : '<div>· 无</div>') + '</div>';
  }
  function show(id){
    var n = byId[id]; if(!n) return;
    detail.innerHTML = '<h3>' + es(n.name) + ' <span class="mono" style="font-size:11px;color:var(--mute);font-weight:400">' + es(n.layer) + ' · ' + es(n.code) + '</span></h3>'
      + '<div class="kv">读数：<b>' + es(n.value) + '</b> ' + es(n.unit) + ' ｜ 状态：<b>' + es(n.toneLabel) + '</b></div>'
      + '<div class="kv">来源：<span class="mono">' + es(n.src) + '</span></div>'
      + '<div class="kv" style="margin-top:6px">' + es(n.detail) + '</div>' + rel(id);
    var gs = document.querySelectorAll('#arch .node');
    for(var i = 0; i < gs.length; i++){ gs[i].classList.toggle('sel', gs[i].getAttribute('data-node') === id); }
  }
  var gs = document.querySelectorAll('#arch .node');
  for(var i = 0; i < gs.length; i++){
    (function(g){
      g.addEventListener('click', function(){ show(g.getAttribute('data-node')); });
      g.addEventListener('keydown', function(e){ if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); show(g.getAttribute('data-node')); } });
    })(gs[i]);
  }
  var paused = false;
  var btn = document.getElementById('motionBtn');
  function setPaused(p){
    paused = p;
    if(typeof svg.pauseAnimations === 'function'){ if(p){ svg.pauseAnimations(); } else { svg.unpauseAnimations(); } }
    btn.textContent = p ? '▶ 继续动态' : '⏸ 暂停动态';
  }
  btn.addEventListener('click', function(){ setPaused(!paused); });
  if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches){ setPaused(true); }
  var sc = document.getElementById('selfcheck');
  var nodeOk = document.querySelectorAll('#arch .node').length === D.nodes.length;
  var edgeOk = document.querySelectorAll('#arch [data-edge]').length === D.edges.length;
  var linkOk = D.edges.every(function(e){ return !!byId[e.from] && !!byId[e.to]; });
  var dataOk = D.nodes.every(function(n){ return !!n.name && !!n.src && n.value !== undefined; });
  var ok = nodeOk && edgeOk && linkOk && dataOk;
  sc.className = 'selfcheck' + (ok ? '' : ' bad');
  sc.textContent = ok
    ? '数据自检：通过 · ' + D.nodes.length + ' 个节点 / ' + D.edges.length + ' 条关系全部可解析，读数均来自本次 storages 快照，无手写数字'
    : '数据自检：未通过（节点=' + nodeOk + ' 边=' + edgeOk + ' 链路=' + linkOk + ' 数据=' + dataOk + '）';
})();
</script>
</body></html>`;

// ── 桌面端部署：把面板注入家族面板 v2 的新 tab ──────────────────────
// 零重启依据：family-panel/lib/index.js:102-115 的 readV2Html() 按 mtimeMs 缓存，
// 文件改了，下次请求 /api/agint-family/v2 就重读。不改 patch、不新建插件、不加 cron。
// 三副本：仓库位 → .agint-bundle 加载位 → profiles/desktop 镜像位。
// 仓库位从脚本自身位置推导；两个部署位从 DSH_HOME 推导，并按实际布局探测
// （web profile 已退役，只认 desktop；profile 名从 .agint-bundle/profile.json 读）。
const PROFILE_NAME = (() => {
  try {
    const p = JSON.parse(fs.readFileSync(join(DSH_HOME, '.agint-bundle', 'profile.json'), 'utf8'));
    return p.profile || 'desktop';
  } catch { return 'desktop'; }
})();
const PANEL_V2_PATHS = [
  join(REPO_ROOT, 'plugins', 'agint-family-panel', 'assets', 'panel-v2.html'),
  join(DSH_HOME, '.agint-bundle', 'plugins', 'agint-family-panel', 'assets', 'panel-v2.html'),
  join(DSH_HOME, 'profiles', PROFILE_NAME, 'plugins', 'agint-family-panel', 'assets', 'panel-v2.html'),
];
const MARK = {
  tab: ['<!-- AGINT-EVIZ-TAB-BEGIN -->', '<!-- AGINT-EVIZ-TAB-END -->'],
  panel: ['<!-- AGINT-EVIZ-PANEL-BEGIN -->', '<!-- AGINT-EVIZ-PANEL-END -->'],
  hook: ['/* AGINT-EVIZ-HOOK-BEGIN */', '/* AGINT-EVIZ-HOOK-END */'],
};

/** HTML 属性值转义。浏览器解码 srcdoc 属性后拿回原始 HTML 文档。 */
function attrEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 有标记就替换标记间内容；没有就按锚点首次插入。幂等，可反复刷新。 */
function upsert(text, [begin, end], body, anchor, after = true) {
  const block = begin + '\n' + body + '\n' + end;
  const i = text.indexOf(begin);
  if (i !== -1) {
    const j = text.indexOf(end, i + begin.length);
    if (j !== -1) return { text: text.slice(0, i) + block + text.slice(j + end.length), first: false };
  }
  const k = text.indexOf(anchor);
  if (k === -1) throw new Error('锚点未找到: ' + anchor.slice(0, 70));
  const at = after ? k + anchor.length : k;
  return { text: text.slice(0, at) + '\n' + block + text.slice(at), first: true };
}

const srcdoc = attrEscape(html);
const tabBody = '      <button class="tab" data-t="eviz" role="tab" aria-selected="false">进化架构图</button>';
const panelBody = [
  '  <div class="card panel" id="eviz">',
  '    <h2>进化架构图 · 系统动态（只读快照）</h2>',
  '    <div class="cap">分层拓扑 + 真实信号流 + 反馈闭环，读数来自生产存储 ' + esc(STORAGES_LABEL) + '/。',
  '      连线上流动的圆点表示<b>链路方向与拓扑</b>，不是实时流量；红色虚线是本次快照的真实断点，不画粒子。',
  '      ⛔ 本页只读、不写任何状态；点节点可看读数与来源。快照随 <code>node bin/evolution-viz-snapshot.mjs</code> 重跑而更新，宿主按 mtime 重读资产，不需要重启。',
  '      iframe 内为固定浅色主题，不跟随家族面板的明暗切换 —— 这是刻意的样式隔离。</div>',
  '    <iframe title="AGINT 进化架构图（只读）"',
  '      srcdoc="' + srcdoc + '"',
  '      style="display:block;width:100%;height:86vh;border:1px solid var(--border);border-radius:8px;background:#f6f8fb"',
  '    ></iframe>',
  '  </div>',
].join('\n');
// 原切换循环的数组硬编码 9 个 id，不含 eviz。补一段独立监听，不动原逻辑。
const hookBody = [
  '/* 进化架构图 tab：原循环的数组是硬编码的，不含 eviz。',
  '   每次点击把 eviz 的 .on 设成「点的就是它」，点别的 tab 会自然关掉它。 */',
  'tabs.addEventListener("click",e=>{',
  '  const b=e.target.closest(".tab"); if(!b) return;',
  '  document.getElementById("eviz")?.classList.toggle("on", b.dataset.t==="eviz");',
  '});',
].join('\n');

const ANCHOR_TAB = '<div class="tabs" id="tabs" role="tablist" aria-label="面板分区">';
const ANCHOR_PANEL = '  <!-- ═══════════ 待办 ═══════════ -->';
const ANCHOR_HOOK = '\n</script>';

const injectReport = [];
for (const p of PANEL_V2_PATHS) {
  const src = fs.readFileSync(p, 'utf8');
  const r1 = upsert(src, MARK.tab, tabBody, ANCHOR_TAB, true);
  const r2 = upsert(r1.text, MARK.panel, panelBody, ANCHOR_PANEL, false);
  const r3 = upsert(r2.text, MARK.hook, hookBody, ANCHOR_HOOK, false);
  fs.writeFileSync(p, r3.text, 'utf8');
  injectReport.push({
    path: p,
    first: r1.first || r2.first || r3.first,
    bytes: Buffer.byteLength(r3.text, 'utf8'),
    // sha 按**归一行尾后**算：部署位历史上带 CRLF（Windows 部署产生），
    // 仓库位是 LF。按原始字节算会把行尾差异误报成「三副本不一致」。
    // 归一后仍不一致 ⇒ 内容真分叉，那才是要查的。
    sha: createHash('sha256').update(r3.text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16),
  });
}

fs.mkdirSync(join(DSH_HOME, '..', 'docs'), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log('WROTE ' + OUT);
console.log('bytes=' + Buffer.byteLength(html, 'utf8') + ' srcdocBytes=' + Buffer.byteLength(srcdoc, 'utf8'));
for (const r of injectReport) console.log('INJECT ' + (r.first ? 'FIRST ' : 'UPDATE') + r.bytes + 'B sha=' + r.sha + ' ' + r.path);
console.log('三副本 sha256 一致=' + (new Set(injectReport.map((r) => r.sha)).size === 1));
console.log('arch layers=' + archLayers.length + ' nodes=' + archNodes.length + ' edges=' + archEdges.length
  + ' live=' + liveCount + ' break=' + breakCount + ' feedback=' + feedbackCount
  + ' measured=' + measuredCount + ' structural=' + (archNodes.length - measuredCount));
console.log('proposal=' + (proposal ? proposal.status : 'ABSENT(已不在 proposal 表)') + ' days=' + createdDays);
console.log('ledger=' + num(ledger) + ' evolution_log=' + num(evLog) + ' metric=' + num(metricRows) + ' proposals=' + num(proposals));
console.log('missing=' + JSON.stringify(missing));
