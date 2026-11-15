// AGINT 进化架构图 —— 只读快照生成器 + 家族面板部署（正式形态）
// 2026-11-15 由「进化流水线 · 六阶段时序」升级为「进化架构图 · 系统动态」：
//   分层拓扑 + 真实读写/触发关系 + 反馈闭环。流动粒子表示链路方向与拓扑，
//   ⛔ 不表示实时流量、不代表吞吐或成功率；节点读数每次重跑从 storages 现取。
// 2026-11-15 二次优化（紧凑版）：原「图 + 4 个独立 section + 大 banner + 长 footer」
//   改为一屏工作区：顶栏 KPI + 架构图 + 5 视图检查器（节点/支路/健康/复盘/数据源）
//   + 折叠边界。信息密度提到节点内（副读数 / 真实 sparkline / 上下游度数 / 层统计），
//   画布 840→650、层间距 110→88，4 个部分不再是独立页面区块。
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
    : '该提案 ID 已不在当前 agint_evolve.json 的 proposal 表（本次 ' + num(proposals) + ' 条），旧版面板围绕它的「待批准 / 档 5 暂缓」叙事已不适用。'),
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

// 坐标：单一真源 LAYER_Y0 / LAYER_STEP / NH，避免 7 层手写 y 漂移。
// 紧凑版：层间距 110→88、节点高 78→68、画布 840→650，同时塞进更多真实读数。
const AX = 140, AW = 990, NH = 68, NGAP = 24, RX0 = 1184;
const LAYER_Y0 = 30, LAYER_STEP = 88, LAYER_BAND_H = 78;
const VB_W = 1240, VB_H = 650;
// archLayers 里的 y 字段只是可读性标注，渲染一律用这里算出的值。
archLayers.forEach((L, i) => { L.y = LAYER_Y0 + i * LAYER_STEP; });
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

// ── 信息密度：把原「健康 / 数据源 / 支路」的读数压进架构图节点本身 ────────
function byDayOf(rows, dateFn) {
  const m = {};
  for (const v of vals(rows)) {
    const d = String(dateFn(v) || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) m[d] = (m[d] || 0) + 1;
  }
  return m;
}
const sparkMetric = byDayOf(metricRows, (v) => v.ts);
const sparkProp = byDayOf(proposals, (v) => v.createdAt || v.updatedAt || v.ts);
const sparkOut = byDayOf(evolution.prediction_outcomes, (v) => v.measuredAt || v.createdAt || v.recordedAt || v.ts);
const SPARK = { evoMem: logByDay, trajectory: trajByDay, metrics: sparkMetric, propose: sparkProp, outcomes: sparkOut };

/** 迷你折线：只画真实按日序列；点数 < 2 就不画，不造平滑曲线充数。 */
function sparkSvg(series, w, h, color) {
  const e = Object.entries(series).filter(([k]) => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort(([a], [b]) => a.localeCompare(b)).slice(-30);
  if (e.length < 2) return '';
  const max = Math.max(1, ...e.map(([, v]) => v));
  const pts = e.map(([, v], i) => [(i / (e.length - 1)) * w, h - 2 - (v / max) * (h - 4)]);
  const last = pts[pts.length - 1];
  return '<polyline points="' + pts.map(([x, y]) => x.toFixed(1) + ',' + y.toFixed(1)).join(' ')
    + '" fill="none" stroke="' + color + '" stroke-width="1.3" stroke-linejoin="round" opacity=".85"/>'
    + '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="1.8" fill="' + color + '"/>';
}

/** sub = 节点内副读数（第二行）；tables = 该节点实际关联的 storages 表与行数。 */
const EX = {
  host:       { sub: 'preset 工具行权威值见 AGENTS.md', tables: [['cron_state', num(cronState)]] },
  metrics:    { sub: '近 30 日 ' + Object.keys(sparkMetric).length + ' 个采样日', tables: [['metric', num(metricRows)]] },
  cron:       { sub: 'staleOverdue ' + (M('cron.staleOverdue').value ?? '?') + ' · maxOverdue ' + (M('cron.maxOverdueDays').value ?? '?'), tables: [['cron_state', num(cronState)]] },
  trajectory: { sub: 'dream ' + (trajSource.dream || 0) + ' 条 · ' + Object.keys(trajByDay).length + ' 个采样日', tables: [['trajectories', num(traj)]] },
  rules:      { sub: 'adherence ' + (adherence ?? '?') + '% · hits ' + (hits ?? '?'), tables: [['rule', num(rules.rule)], ['rule_audit', num(ruleAudit)]] },
  memory:     { sub: 'avgConfidence ' + (M('memory.avgConfidence').value ?? '?'), tables: [['metric[memory.total]', memTotal]] },
  dream:      { sub: '03:00 · light → REM → deep', tables: [['dream 源轨迹', trajSource.dream || 0]] },
  evoMem:     { sub: 'ledger ' + num(ledger) + ' · fp ' + num(evolution.failure_pattern) + ' · po ' + num(evolution.prediction_outcomes) + ' · bfs ' + num(evolution.benchmark_frozen_set),
                tables: [['evolution_log', num(evLog)], ['evolution_ledger', num(ledger)], ['failure_pattern', num(evolution.failure_pattern)], ['prediction_outcomes', num(evolution.prediction_outcomes)], ['benchmark_frozen_set', num(evolution.benchmark_frozen_set)]] },
  skillAc:    { sub: [num(autocreate.task_patterns), num(acCandidates), num(acProposals), num(acReleases)].join(' → ') + ' （patterns→cand→prop→rel）',
                tables: [['task_patterns', num(autocreate.task_patterns)], ['candidates', num(acCandidates)], ['proposals', num(acProposals)], ['releases', num(acReleases)]] },
  eval:       { sub: '评分链路永久零 LLM', tables: [['不在快照域', '—']] },
  baseline:   { sub: 'SEALED · contentHash · 非人类验证', tables: [['仓库冻结集', '—']] },
  observe:    { sub: abMissing ? '域不存在，不是 0 行实验' : 'samples ' + num(abtest.samples),
                tables: abMissing ? [['域不存在', '—']] : [['abtests', num(abtest.abtests)], ['samples', num(abtest.samples)]] },
  propose:    { sub: JSON.stringify(statusDist), tables: [['proposal', num(proposals)]] },
  curriculum: { sub: '本快照未采集队列读数', tables: [['不在快照域', '—']] },
  mutator:    { sub: '本快照未采集读数', tables: [['不在快照域', '—']] },
  gates:      { sub: 'G1 on · G2 GOLD/HELDOUT · G5 24h', tables: [['不在快照域', '—']] },
  queue:      { sub: num(acProposals) === 0 ? '表存在但无记录' : JSON.stringify(acPropStatus), tables: [['proposals', num(acProposals)]] },
  release:    { sub: 'deployedCount ' + (M('policy.deployedCount').value ?? '?') + ' · ' + JSON.stringify(relStatus), tables: [['releases', num(acReleases)]] },
  outcomes:   { sub: '下一 ISO 周对拍 actualDelta', tables: [['prediction_outcomes', num(evolution.prediction_outcomes)]] },
  human:      { sub: '人工标注不代填', tables: [['不在快照域', '—']] },
};
const exOf = (id) => EX[id] || { sub: '', tables: [] };

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
  // 回流走右侧直角折线：层间距 88 / 节点高 68 ⇒ 空隙 20px，水平段取 y2-10 落在正中。
  const ax = a.x + a.w, ay = a.y + a.h / 2, gy = y2 - 10;
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
  // 关系标签默认隐藏，由顶栏「关系标签」开关切换，避免 25 条边把图糊住。
  if (e.kind !== 'feedback') {
    const a0 = nodeById[e.from], b0 = nodeById[e.to];
    const lx = (a0.x + a0.w / 2 + b0.x + b0.w / 2) / 2;
    const ly = (a0.y + a0.h + b0.y) / 2 - 4;
    const short = e.label.length > 12 ? e.label.slice(0, 11) + '…' : e.label;
    body += '<text class="elabel" x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1)
      + '" text-anchor="middle" font-size="8" fill="' + st.stroke
      + '" paint-order="stroke" stroke="#fff" stroke-width="2.6">' + esc(short) + '</text>';
  }
  return '<g data-edge="' + e.i + '"><title>' + esc(nodeById[e.from].name + ' → ' + nodeById[e.to].name + '：' + e.label)
    + '</title>' + body + '</g>';
}).join('');

const layerStat = archLayers.map((L) => {
  const ids = L.nodes.map((n) => n.id);
  const measured = ids.filter((id) => nodeById[id].value !== NO_DATA).length;
  return L.name + '：' + ids.length + ' 节点 / ' + measured + ' 有读数';
});
const archLayersSvg = archLayers.map((L, i) =>
  '<rect x="134" y="' + (L.y - 8) + '" width="1002" height="' + LAYER_BAND_H + '" rx="10" fill="'
  + (i % 2 ? '#eef2f7' : '#f4f7fb') + '" opacity=".72"/>'
  + '<text x="16" y="' + (L.y + 4) + '" font-size="9.5" font-weight="700" fill="#94a3b8">' + L.key + '</text>'
  + '<text x="16" y="' + (L.y + 20) + '" font-size="11.5" font-weight="700" fill="#334155">' + esc(L.name) + '</text>'
  + '<text x="16" y="' + (L.y + 34) + '" font-size="8.5" fill="#94a3b8">' + esc(L.hint) + '</text>'
  + '<text x="16" y="' + (L.y + 48) + '" font-size="8.5" fill="#64748b">' + esc(layerStat[i]) + '</text>'
  + '<text x="1126" y="' + (L.y + 4) + '" text-anchor="end" font-size="8.5" fill="#94a3b8">' + esc(L.key + ' · ' + L.nodes.length + ' 节点') + '</text>'
).join('');

// 上下游度数：让「动态关系」在节点内也可见，不必点开检查器。
const deg = {};
archEdges.forEach((e) => {
  deg[e.from] = deg[e.from] || { i: 0, o: 0 };
  deg[e.to] = deg[e.to] || { i: 0, o: 0 };
  deg[e.from].o++; deg[e.to].i++;
});

const archNodesSvg = archNodes.map((n) => {
  const t = TONE[n.tone];
  const cut = (s, max) => (s.length > max ? s.slice(0, max - 1) + '…' : s);
  const ex = exOf(n.id);
  const spark = SPARK[n.id] ? sparkSvg(SPARK[n.id], 46, 18, t.chip) : '';
  const d = deg[n.id] || { i: 0, o: 0 };
  return '<g class="node" data-node="' + n.id + '" role="button" tabindex="0" aria-label="' + esc(n.name) + '">'
    + '<rect x="' + n.x.toFixed(1) + '" y="' + n.y + '" width="' + n.w.toFixed(1) + '" height="' + n.h
    + '" rx="8" fill="' + t.fill + '" stroke="' + t.stroke + '" stroke-width="1.4"/>'
    + '<rect x="' + n.x.toFixed(1) + '" y="' + n.y + '" width="3.5" height="' + n.h + '" rx="2" fill="' + t.stroke + '"/>'
    + '<circle cx="' + (n.x + n.w - 12).toFixed(1) + '" cy="' + (n.y + 12) + '" r="3.5" fill="' + t.stroke + '"/>'
    + '<text x="' + (n.x + 12).toFixed(1) + '" y="' + (n.y + 17) + '" font-size="11.5" font-weight="700" fill="#1c2733">' + esc(cut(n.name, 13)) + '</text>'
    + '<text x="' + (n.x + 12).toFixed(1) + '" y="' + (n.y + 30) + '" font-size="8.5" fill="#64748b" font-family="ui-monospace,Consolas,monospace">' + esc(cut(n.code, Math.floor(n.w / 5.6))) + '</text>'
    + (spark ? '<g transform="translate(' + (n.x + n.w - 58).toFixed(1) + ',' + (n.y + 22) + ')">' + spark + '</g>' : '')
    + '<text x="' + (n.x + 12).toFixed(1) + '" y="' + (n.y + 50) + '" font-size="17" font-weight="750" fill="' + t.chip + '">' + esc(String(n.value)) + '</text>'
    + '<text x="' + (n.x + n.w - 10).toFixed(1) + '" y="' + (n.y + 50) + '" text-anchor="end" font-size="9" fill="#64748b">' + esc(cut(n.unit, 15)) + '</text>'
    + '<text x="' + (n.x + 12).toFixed(1) + '" y="' + (n.y + 62) + '" font-size="8.5" fill="#64748b">' + esc(cut(ex.sub, Math.floor(n.w / 5.4) - 7)) + '</text>'
    + '<text x="' + (n.x + n.w - 10).toFixed(1) + '" y="' + (n.y + 62) + '" text-anchor="end" font-size="8.5" fill="#94a3b8">↑' + d.i + ' ↓' + d.o + '</text>'
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
    tone: n.tone, toneLabel: TONE[n.tone].label, src: n.src, detail: n.detail, layer: n.layer,
    sub: exOf(n.id).sub, tables: exOf(n.id).tables, deg: deg[n.id] || { i: 0, o: 0 } })),
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

// ── 融合：原 4 个独立 section 变成架构图检查器的视图 + 顶栏 KPI ──────────
const kpiHtml = [
  ['节点', archNodes.length, ''],
  ['主链路', liveCount, 'ok'],
  ['断点', breakCount, 'bad'],
  ['回流', feedbackCount, 'ok'],
  ['域缺失', missing.length, 'bad'],
  ['dream 轨迹', trajSource.dream || 0, 'warn'],
  ['遵守率', (adherence ?? '?') + '%', zeroHitFull ? 'bad' : 'warn'],
  ['cron 非 ok', cronBad.length + '/' + num(cronState), cronBad.length ? 'bad' : 'ok'],
  ['记忆', memTotal, ''],
  ['近 7 日 log', logThisWeek, ''],
].map(([k, v, t]) => '<span class="kpi ' + t + '"><b>' + esc(String(v)) + '</b>' + esc(k) + '</span>').join('');

// 视图「支路」：六阶段压成一行 6 格，取代原独立 section。
const branchHtml = '<div class="strip">'
  + stages.map((s, i) => '<div class="cell tone-' + s.tone + '" title="' + esc(s.src) + '">'
    + '<b>' + (i + 1) + ' · ' + esc(s.name) + '</b>'
    + '<span class="cv">' + esc(String(s.main)) + '</span>'
    + '<span class="cs">' + esc(s.sub) + '</span></div>').join('<div class="sep">→</div>')
  + '</div><div class="hint">⛔ 不画桑基图：跨表无统一 trace id（ledger 用 contractId/populationCandidateId，autocreate 用 candidateId），强行连线会造出系统里不存在的轨迹。节点内 <span class="mono">patterns→cand→prop→rel</span> 即本支路的压缩形态。</div>';

// 视图「健康」：4 张紧凑卡 + 两张真实按日序列，取代原仪表盘 section。
const healthHtml = '<div class="hstrip">'
  + health.map((h) => '<div class="hcell tone-' + h.tone + '"><span>' + esc(h.title) + '</span><b>' + esc(h.value)
    + '</b><small>' + esc(h.detail) + '</small></div>').join('')
  + '</div><div class="charts2">'
  + '<div class="mini"><b>evolution_log 每日新增 · 共 ' + num(evLog) + ' 行</b>' + lineChart(logByDay, 380, 92, '#1d4ed8') + '</div>'
  + '<div class="mini"><b>trajectory 每日写入 · 共 ' + num(traj) + ' 条</b>' + lineChart(trajByDay, 380, 92, '#0f766e') + '</div>'
  + '</div>';

// 视图「复盘」：原周复盘导出，Markdown 全文；复制按钮移到顶栏。
const digestHtml = '<pre class="dg" id="dg">' + esc(digest) + '</pre>';

// 视图「数据源」：按架构图节点组织（不是按文件），点行可跳回对应节点。
const srcHtml = archNodes.map((n) => {
  const ex = exOf(n.id);
  return '<div class="srcrow" data-goto="' + n.id + '"><b>' + esc(n.name) + '</b>'
    + '<span class="mono">' + esc(n.src) + '</span>'
    + ex.tables.map(([k, v]) => '<span class="chip">' + esc(k) + ' <b>' + esc(String(v)) + '</b></span>').join('')
    + '</div>';
}).join('') + (missing.length ? '<div class="hint bad">⛔ 域不存在（不是 0 行）：' + esc(missing.join('；')) + '</div>' : '');

const generatedAt = new Date().toISOString();
const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AGINT 进化架构图 · 系统动态（只读快照）</title>
<style>
:root{--bg:#f6f8fb;--card:#fff;--line:#e3e8ef;--ink:#1c2733;--sub:#5b6879;--mute:#8a94a6;--ok:#15803d;--warn:#b45309;--bad:#b91c1c;--blue:#1d4ed8}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:12.5px/1.5 -apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif}
.app{max-width:1280px;margin:0 auto;padding:9px 12px 10px}
.mono{font-family:ui-monospace,Consolas,monospace}
.top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:7px}
.brand{font-size:15px;font-weight:750;white-space:nowrap}.brand span{font-size:10.5px;color:var(--mute);font-weight:400;margin-left:5px}
.kpis{display:flex;gap:4px;flex-wrap:wrap;flex:1}
.kpi{display:inline-flex;align-items:baseline;gap:4px;background:#fff;border:1px solid var(--line);border-radius:5px;padding:2px 7px;font-size:10px;color:var(--sub);white-space:nowrap}
.kpi b{font-size:12.5px;color:var(--ink);font-variant-numeric:tabular-nums}
.kpi.ok b{color:var(--ok)}.kpi.warn b{color:var(--warn)}.kpi.bad b{color:var(--bad)}
.stamp{font-size:9.5px;color:var(--mute);text-align:right;line-height:1.45;white-space:nowrap}
.bench{background:#fff;border:1px solid var(--line);border-radius:9px;overflow:hidden}
.bench-head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:5px 10px;border-bottom:1px solid var(--line);background:#f8fafc;flex-wrap:wrap}
.legend{display:flex;gap:9px;flex-wrap:wrap;font-size:9.5px;color:var(--sub)}
.lg{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}.lg i{display:inline-block}
.lg .sq{width:9px;height:9px;border:1.5px solid;border-radius:2px}.lg .ln{width:14px;height:0;border-top:2px solid}
.tools{display:flex;gap:5px}
.tools button{font:inherit;font-size:10px;padding:3px 9px;border:1px solid var(--line);border-radius:5px;background:#fff;color:var(--sub);cursor:pointer;white-space:nowrap}
.tools button:hover{border-color:var(--blue);color:var(--blue)}
.tools button.on{background:#eef2ff;border-color:#c7d7ff;color:var(--blue)}
.canvas{padding:1px 6px 0}
.arch-scroll{overflow-x:auto}
#arch{display:block;width:100%;max-width:1240px;min-width:1000px;height:auto;margin:0 auto}
#arch .node{cursor:pointer}#arch .node:hover rect:first-child{stroke-width:2.4}#arch .node.sel rect:first-child{stroke-width:3}
.elabel{display:none}body.show-labels .elabel{display:inline}
.inspect{border-top:1px solid var(--line);background:#fbfcfe}
.tabs{display:flex;align-items:center;gap:0;border-bottom:1px solid var(--line);padding:0 9px}
.tb{font:inherit;font-size:10.5px;padding:6px 10px;border:0;border-bottom:2px solid transparent;background:none;color:var(--sub);cursor:pointer;white-space:nowrap}
.tb:hover{color:var(--blue)}.tb.on{color:var(--blue);border-bottom-color:var(--blue);font-weight:700}
.selfcheck{margin-left:auto;font-size:9.5px;font-weight:700;color:var(--ok);white-space:nowrap}.selfcheck.bad{color:var(--bad)}
.views{height:138px;overflow:auto;padding:7px 11px}
.view{display:none}.view.on{display:block}
.detail h3{margin:0 0 4px;font-size:12.5px}
.detail .kv{font-size:10.5px;color:var(--sub);margin:2px 0}.detail .kv b{color:var(--ink)}
.detail .rel{font-size:10px;color:var(--sub);border-top:1px dashed var(--line);margin-top:5px;padding-top:5px;column-count:2;column-gap:16px}
.chips{margin-top:3px}
.chip{display:inline-block;background:#f2f5f9;border:1px solid #e5eaf1;border-radius:4px;padding:1px 6px;margin:2px 4px 2px 0;font:10px ui-monospace,Consolas,monospace;color:var(--sub)}.chip b{color:var(--ink)}
.strip{display:flex;align-items:stretch;gap:4px;overflow-x:auto}
.cell{flex:1;min-width:132px;background:#fff;border:1px solid var(--line);border-top:2px solid var(--mute);border-radius:5px;padding:5px 7px}
.cell.tone-ok{border-top-color:var(--ok)}.cell.tone-warn{border-top-color:var(--warn)}.cell.tone-bad{border-top-color:var(--bad)}
.cell b{display:block;font:700 10px ui-monospace,Consolas,monospace}.cell .cv{display:block;font-size:15px;font-weight:750;line-height:1.25}
.cell .cs{display:block;font-size:9.5px;color:var(--sub);line-height:1.35}
.sep{display:grid;place-items:center;color:#b8c2d0;font-size:12px}
.hint{font-size:9.5px;color:var(--mute);margin-top:5px}.hint.bad{color:var(--bad)}
.hstrip{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.hcell{background:#fff;border:1px solid var(--line);border-top:2px solid var(--mute);border-radius:5px;padding:4px 7px;min-width:0}
.hcell.tone-ok{border-top-color:var(--ok)}.hcell.tone-warn{border-top-color:var(--warn)}.hcell.tone-bad{border-top-color:var(--bad)}
.hcell span{font-size:9.5px;color:var(--sub)}.hcell b{display:block;font-size:15px;line-height:1.25}
.hcell small{display:block;font-size:9px;color:var(--sub);line-height:1.35;max-height:26px;overflow:hidden}
.charts2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:5px}
.mini{background:#fff;border:1px solid var(--line);border-radius:5px;padding:3px 8px}.mini b{font-size:9.5px}
.dg{background:#0f172a;color:#dbe4f0;border-radius:6px;padding:8px 10px;font:10px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;margin:0;max-height:124px;overflow:auto}
.srcrow{display:flex;align-items:center;gap:6px;padding:3px 6px;border-bottom:1px dashed var(--line);cursor:pointer;flex-wrap:wrap}
.srcrow:hover{background:#eef2ff}
.srcrow>b{font-size:10px;min-width:118px}.srcrow>.mono{font-size:9px;color:var(--mute);min-width:200px}
.foot{display:flex;align-items:center;gap:12px;margin-top:5px;font-size:9.5px;color:var(--mute);flex-wrap:wrap}
details summary{cursor:pointer;color:var(--blue);font-size:9.5px}
.bounds{padding:6px 10px;background:#fff;border:1px solid var(--line);border-radius:6px;margin-top:4px;line-height:1.65;font-size:10px;max-width:1100px}
@media(max-width:900px){.hstrip{grid-template-columns:repeat(2,1fr)}.charts2{grid-template-columns:1fr}}
</style></head><body><div class="app">

<header class="top">
<div class="brand">AGINT 进化架构图<span>· 系统动态 · 只读快照</span></div>
<div class="kpis">${kpiHtml}</div>
<div class="stamp">${esc(generatedAt)}<br>${esc(STORAGES_LABEL)}/ · 9 域</div>
</header>

<div class="bench">
<div class="bench-head">
<div class="legend">${toneLegend}<span class="lg" style="color:var(--mute)">│</span>${edgeLegend}</div>
<div class="tools">
<button id="motionBtn">⏸ 动态</button>
<button id="labelBtn">关系标签</button>
<button id="copyBtn">复制复盘</button>
</div>
</div>
<div class="canvas"><div class="arch-scroll">${archSvg}</div></div>
<div class="inspect">
<div class="tabs">
<button class="tb on" data-v="node">节点</button>
<button class="tb" data-v="branch">支路 · 六阶段</button>
<button class="tb" data-v="health">健康 · 趋势</button>
<button class="tb" data-v="digest">复盘 · ${currentWeek}</button>
<button class="tb" data-v="src">数据源 · ${tableCounts.length} 域</button>
<span class="selfcheck" id="selfcheck">自检…</span>
</div>
<div class="views">
<div class="view on" id="v-node"><div class="detail" id="detail"><h3>系统总览</h3>
<div class="kv">点击任意节点查看<b>读数、来源表、状态与上下游</b>；下方 5 个视图承载支路 / 健康 / 复盘 / 数据源，不再另开页面区块。</div>
<div class="kv">本次 <b>${archNodes.length}</b> 节点 / <b>${archEdges.length}</b> 关系：主链路 ${liveCount} · 断点 ${breakCount} · 回流 ${feedbackCount}；<b>${measuredCount}</b> 个有 storages 读数，<b>${archNodes.length - measuredCount}</b> 个结构节点显示 —。</div>
<div class="kv">节点内右上小折线是<b>真实按日序列</b>（evolution_log / trajectory / metric / proposal / prediction_outcomes），右下 ↑↓ 是上下游度数；副读数来自该节点关联的表。</div>
</div></div>
<div class="view" id="v-branch">${branchHtml}</div>
<div class="view" id="v-health">${healthHtml}</div>
<div class="view" id="v-digest">${digestHtml}</div>
<div class="view" id="v-src">${srcHtml}</div>
</div>
</div>
</div>

<div class="foot">
<details><summary>边界与口径（点开）</summary><div class="bounds">
<b>① 动态的含义：</b>流动粒子表示真实存在的读写 / 触发 / 回流关系与方向（依据 docs/architecture.md 与 AGENTS.md），⛔ 不是实时流量、不代表吞吐或成功率；${breakCount} 条断点边不画粒子，不把空数据画成好看的流动线。<br>
<b>② 三态纪律：</b>有数显示数；域不存在显示 <b>—</b>（不是 0）；表存在但 0 行显示 0 并注明。本次 ${missing.length} 个域不存在：${esc(missing.join('；')) || '无'}。${archNodes.length - measuredCount} 个运行时结构节点不在 9 个 storages 域内，只画拓扑位置。<br>
<b>③ 口径与不自评：</b>logCount7d=${logCount7d ?? '?'} vs 按日近 7 日 ${logThisWeek}（${Number(logCount7d) === logThisWeek ? '本次一致' : '不一致，同时列出不调和'}）；外置冻结集是「运营者授权 · agent 执行 · 非人类验证」的机械真值，capabilityConclusion 恒 null，⛔ 不据此宣称能力水平；人工标注不代填。<br>
<b>④ 只读与刷新：</b>本页不改任何表 / 提案状态 / 写接口；重跑 <span class="mono">node bin/evolution-viz-snapshot.mjs</span> 同步独立 HTML 与三份面板副本，宿主按 mtime 重读资产、不需要重启。⛔ 想看新状态就重跑，本页不会自己动。
</div></details>
<span>粒子=拓扑方向，非实时指标 · 断点不画粒子 · 只读不写状态</span>
</div>
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

  var tabs = document.querySelectorAll('.tb');
  var views = { node:'v-node', branch:'v-branch', health:'v-health', digest:'v-digest', src:'v-src' };
  function setView(v){
    for(var i=0;i<tabs.length;i++){ tabs[i].classList.toggle('on', tabs[i].getAttribute('data-v')===v); }
    Object.keys(views).forEach(function(k){ var el=document.getElementById(views[k]); if(el) el.classList.toggle('on', k===v); });
  }
  for(var ti=0;ti<tabs.length;ti++){
    (function(t){ t.addEventListener('click', function(){ setView(t.getAttribute('data-v')); }); })(tabs[ti]);
  }

  function rel(id){
    var ins=D.edges.filter(function(e){return e.to===id;}), outs=D.edges.filter(function(e){return e.from===id;});
    function row(e){ return '<div>· '+es(e.kindLabel)+'：'+es(e.label)+'（'+es(e.fromName)+' → '+es(e.toName)+'）</div>'; }
    return '<div class="rel"><b>上游（'+ins.length+'）</b>'+(ins.length?ins.map(row).join(''):'<div>· 无</div>')
      +'<b style="display:block;margin-top:4px">下游（'+outs.length+'）</b>'+(outs.length?outs.map(row).join(''):'<div>· 无</div>')+'</div>';
  }
  function chips(n){
    return n.tables.length ? '<div class="chips">'+n.tables.map(function(t){ return '<span class="chip">'+es(t[0])+' <b>'+es(String(t[1]))+'</b></span>'; }).join('')+'</div>' : '';
  }
  function show(id){
    var n=byId[id]; if(!n) return;
    detail.innerHTML='<h3>'+es(n.name)+' <span class="mono" style="font-size:10px;color:var(--mute);font-weight:400">'+es(n.layer)+' · '+es(n.code)+'</span></h3>'
      +'<div class="kv">读数：<b>'+es(n.value)+'</b> '+es(n.unit)+' ｜ 状态：<b>'+es(n.toneLabel)+'</b> ｜ 上下游：<b>↑'+n.deg.i+' ↓'+n.deg.o+'</b></div>'
      +'<div class="kv">副读数：'+es(n.sub)+'</div>'
      +'<div class="kv">来源：<span class="mono">'+es(n.src)+'</span></div>'+chips(n)
      +'<div class="kv" style="margin-top:4px">'+es(n.detail)+'</div>'+rel(id);
    var gs=document.querySelectorAll('#arch .node');
    for(var i=0;i<gs.length;i++){ gs[i].classList.toggle('sel', gs[i].getAttribute('data-node')===id); }
    setView('node');
  }
  var gs=document.querySelectorAll('#arch .node');
  for(var i=0;i<gs.length;i++){
    (function(g){
      g.addEventListener('click',function(){ show(g.getAttribute('data-node')); });
      g.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); show(g.getAttribute('data-node')); } });
    })(gs[i]);
  }
  var rows=document.querySelectorAll('.srcrow');
  for(var ri=0;ri<rows.length;ri++){
    (function(r){ r.addEventListener('click',function(){ show(r.getAttribute('data-goto')); }); })(rows[ri]);
  }

  var paused=false;
  var motionBtn=document.getElementById('motionBtn');
  function setPaused(p){
    paused=p;
    if(typeof svg.pauseAnimations==='function'){ if(p){ svg.pauseAnimations(); } else { svg.unpauseAnimations(); } }
    motionBtn.textContent=p?'▶ 动态':'⏸ 动态';
    motionBtn.classList.toggle('on', !p);
  }
  motionBtn.addEventListener('click',function(){ setPaused(!paused); });
  if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches){ setPaused(true); }
  else { motionBtn.classList.add('on'); }

  var labelBtn=document.getElementById('labelBtn');
  labelBtn.addEventListener('click',function(){
    var on=document.body.classList.toggle('show-labels');
    labelBtn.classList.toggle('on', on);
  });

  var copyBtn=document.getElementById('copyBtn');
  copyBtn.addEventListener('click',function(){
    var txt=document.getElementById('dg').textContent;
    function done(){ copyBtn.textContent='已复制'; setTimeout(function(){ copyBtn.textContent='复制复盘'; },1600); }
    if(typeof navigator!=='undefined' && navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(txt).then(done, done);
    } else { done(); }
  });

  var sc=document.getElementById('selfcheck');
  var nodeOk=document.querySelectorAll('#arch .node').length===D.nodes.length;
  var edgeOk=document.querySelectorAll('#arch [data-edge]').length===D.edges.length;
  var linkOk=D.edges.every(function(e){ return !!byId[e.from] && !!byId[e.to]; });
  var dataOk=D.nodes.every(function(n){ return !!n.name && !!n.src && n.value!==undefined && Array.isArray(n.tables); });
  var viewOk=Object.keys(views).every(function(k){ return !!document.getElementById(views[k]); });
  var ok=nodeOk&&edgeOk&&linkOk&&dataOk&&viewOk;
  sc.className='selfcheck'+(ok?'':' bad');
  sc.textContent=ok
    ? '自检通过 · '+D.nodes.length+' 节点 / '+D.edges.length+' 关系 / 5 视图 / 读数均来自 storages'
    : '自检未通过（节点='+nodeOk+' 边='+edgeOk+' 链路='+linkOk+' 数据='+dataOk+' 视图='+viewOk+'）';
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
  '    <div class="cap">一屏工作区：顶栏 KPI + 分层架构图 + 5 视图检查器（节点 / 支路 / 健康 / 复盘 / 数据源）。',
  '      流动的圆点表示<b>链路方向与拓扑</b>，不是实时流量；红色虚线是真实断点，不画粒子。点节点看读数、来源表与上下游。',
  '      ⛔ 只读、不写任何状态。重跑 <code>node bin/evolution-viz-snapshot.mjs</code> 刷新；宿主按 mtime 重读资产，不需要重启。</div>',
  '    <iframe title="AGINT 进化架构图（只读）"',
  '      srcdoc="' + srcdoc + '"',
  '      style="display:block;width:100%;height:88vh;max-height:860px;min-height:620px;border:1px solid var(--border);border-radius:8px;background:#f6f8fb"',
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
console.log('canvas=' + VB_W + 'x' + VB_H + ' inspectorViews=5 sparks=' + Object.keys(SPARK).length
  + ' edgeLabels=' + archEdges.filter((e) => e.kind !== 'feedback').length);
console.log('proposal=' + (proposal ? proposal.status : 'ABSENT(已不在 proposal 表)') + ' days=' + createdDays);
console.log('ledger=' + num(ledger) + ' evolution_log=' + num(evLog) + ' metric=' + num(metricRows) + ' proposals=' + num(proposals));
console.log('missing=' + JSON.stringify(missing));
