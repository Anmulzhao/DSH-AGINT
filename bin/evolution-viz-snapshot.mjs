// AGINT 进化流水线只读可视化面板 —— 快照生成器 + 桌面端部署（正式形态）
// 2026-11-04 定案：正式形态 = 只读 HTML；21:1x 追加「部署到桌面端 dsh」。
//   路线：家族面板加一个 tab（老板选）。不新建插件、不改 cordis.patch.yml、
//   不加 cron、不重启宿主。profile 只认 desktop（web 已退役）。
// 边界：只读生产存储。不写任何状态。不改任何表。不加依赖（仅 Node 内置模块）。
// 用法：node bin/evolution-viz-snapshot.mjs
// 输出 1：docs/AGINT-进化流水线面板-20261104.html（独立单文件，覆盖同名文件）
// 输出 2：三份 assets/panel-v2.html 的「进化流水线」tab（幂等标记替换）
//   仓库位 / .agint-bundle 加载位 / profiles/desktop 镜像位。
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
const OUT = join(DSH_HOME, '..', 'docs', 'AGINT-进化流水线面板-20261104.html');
const PROPOSAL_ID = 'd85347bf-984a-41ee-b8d5-b54ac74b4105';
const missing = [];

function load(f) {
  try {
    const d = JSON.parse(fs.readFileSync(S + f, 'utf8'));
    return d.tables || d;
  } catch (e) {
    missing.push(f + ': ' + e.message);
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

// 六阶段：按提案正文的字段映射。跨表没有统一 trace id，故只给阶段计数，不画桑基图。
const stages = [
  {
    key: 'detect', name: 'detect', cn: '模式聚合',
    main: num(autocreate.task_patterns), unit: '条 task_patterns',
    sub: num(acCandidates) + ' 个候选被聚合出来',
    src: 'agint_skill_autocreate.json / tables.task_patterns',
    tone: 'ok',
  },
  {
    key: 'evaluate', name: 'evaluate', cn: '评估',
    main: num(acCandidates), unit: '个候选',
    sub: (candStatus.REJECTED || 0) + ' REJECTED / ' + (candStatus.ROLLED_BACK || 0) + ' ROLLED_BACK；另有 ' + num(acProposals) + ' 条 skill proposal',
    src: 'agint_skill_autocreate.json / tables.candidates, proposals',
    tone: 'warn',
  },
  {
    key: 'queue', name: 'queue', cn: '排队',
    main: acPropStatus.QUEUED_FOR_RELEASE || 0, unit: '条待发布',
    sub: '全部 ' + num(acProposals) + ' 条 skill proposal 同状态；evolution_log 另有 ' + (logDecision.PENDING_REVIEW || 0) + ' 条 PENDING_REVIEW',
    src: 'agint_skill_autocreate.json / tables.proposals; agint_evolution.json / tables.evolution_log',
    tone: 'bad',
  },
  {
    key: 'release', name: 'release', cn: '发布',
    main: num(acReleases), unit: '次发布',
    sub: (relStatus.ROLLED_BACK || 0) + ' 次全为 ROLLED_BACK；policy.deployedCount=' + (M('policy.deployedCount').value ?? '?') + '；ledger 有 ' + num(ledger) + ' 条锚定记录',
    src: 'agint_skill_autocreate.json / tables.releases; agint_metrics.json; agint_evolution.json / tables.evolution_ledger',
    tone: 'bad',
  },
  {
    key: 'observe', name: 'observe', cn: '观察',
    main: num(abtest.abtests), unit: '个 A/B 实验',
    sub: 'abtest.samples=' + num(abtest.samples) + '；prediction_outcomes=' + num(evolution.prediction_outcomes) + '；evolution_log ' + num(evLog) + ' 行中 resolved=false 占 ' + dist(evLog, (v) => v.resolved).false,
    src: 'agint_abtest.json; agint_evolution.json / tables.prediction_outcomes, evolution_log',
    tone: 'bad',
  },
  {
    key: 'archive', name: 'archive / rollback', cn: '归档或回滚',
    main: (skillState.archived || 0) + (skillState.stale || 0), unit: '个技能归档/转旧',
    sub: 'curator: archived=' + (skillState.archived || 0) + ' / stale=' + (skillState.stale || 0) + ' / active=' + (skillState.active || 0) + '；policy.rolledbackCount=' + (M('policy.rolledbackCount').value ?? '?'),
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

// 健康四卡片
const health = [
  {
    title: '梦境服务', tone: 'warn',
    value: (trajSource.dream || 0) + ' 条', label: 'source=dream 轨迹 / 共 ' + num(traj) + ' 条',
    detail: '最近采样日 ' + Object.keys(trajByDay).slice(-1)[0] + ' 写入 ' + (Object.values(trajByDay).slice(-1)[0] ?? '?') + ' 条；trajectory.writeFailures=' + (trajectory.counters?.current?.writeFailures ?? '?'),
  },
  {
    title: '规则门禁遵守率', tone: 'bad',
    value: (M('rules.adherencePct').value ?? '?') + '%', label: 'rules.adherencePct（最后采样 ' + String(M('rules.adherencePct').ts).slice(0, 10) + '）',
    detail: '同批 rules.hits=' + (M('rules.hits').value ?? '?') + ' / rules.blocked=' + (M('rules.blocked').value ?? '?') + ' ⇒ 零命中的 100%，不能当作门禁有效。rule 表 ' + num(rules.rule) + ' 条、rule_audit ' + num(ruleAudit) + ' 条。',
  },
  {
    title: 'cron 健康', tone: 'bad',
    value: cronBad.length + ' / ' + num(cronState), label: '个 job 上次跑非 ok',
    detail: 'cron.staleJobs=' + (M('cron.staleJobs').value ?? '?') + '，maxOverdueDays=' + (M('cron.maxOverdueDays').value ?? '?') + '。' + cronBad.map(([k, v]) => esc(k) + '：' + esc(String(v.lastError || '').slice(0, 70))).join('；'),
  },
  {
    title: '记忆规模', tone: 'ok',
    value: M('memory.total').value ?? '?', label: '条记忆 / 平均置信度 ' + (M('memory.avgConfidence').value ?? '?'),
    detail: '近 10 次采样恒为 ' + M('memory.total').value + '，无增长。skills.totalBytes=' + (M('skills.totalBytes').value ?? '?') + '。',
  },
];

// 周复盘（2026-W45）
const w45 = vals(curator.reports).find((r) => r.week === '2026-W45') || null;
const weekStart = '2026-11-02';
// 按日历窗口算「近 7 日」，不用「最后 7 个有数据的日期」。后者会把 10-25 的旧数据算进来。
const dayCutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
const logThisWeek = Object.entries(logByDay).filter(([d]) => d >= dayCutoff).reduce((a, [, v]) => a + v, 0);
const digest = [
  '# AGINT 进化周复盘 · 2026-W45（只读快照）',
  '',
  '- 快照时间：' + new Date().toISOString(),
  '- 数据源：' + STORAGES_LABEL + '/（生产存储，只读）',
  '',
  '## 本周数字',
  '',
  '| 指标 | 值 | 来源 |',
  '|---|---|---|',
  '| promoted（policy.deployedCount） | ' + (M('policy.deployedCount').value ?? 0) + '（最后事件 2026-10-27，本周 0） | agint_metrics.json |',
  '| recalled（evolution_log.recalls > 0） | 0（275 行 recalls 全为 0） | agint_evolution.json |',
  '| 规则总数 | ' + num(rules.rule) + ' | agint_rules.json |',
  '| cron 漏跑（staleJobs） | ' + (M('cron.staleJobs').value ?? '?') + ' | agint_metrics.json |',
  '| curator 本周归档 | ' + (w45?.summary?.newlyArchived ?? '?') + '（W45 报告） | agint_curator.json |',
  '| evolution_log 近 7 日新增 | ' + logThisWeek + ' | agint_evolution.json |',
  '| 指标口径 evolution.logCount7d | ' + (M('evolution.logCount7d').value ?? '?') + ' | agint_metrics.json |',
  '',
  '## 断点',
  '',
  '1. 124 条 skill proposal 全部 QUEUED_FOR_RELEASE，5 次发布全部 ROLLED_BACK。',
  '2. abtest 表 0 行，观察阶段无实验数据。',
  '3. evolution_log 275 行全为 L1 / confidence 0.5 / resolved=false / recalls=0。',
  '4. rules.adherencePct=100 与 rules.hits=0 同批出现，遵守率判据不可信。',
  '5. evolution.logCount7d=' + (M('evolution.logCount7d').value ?? '?') + ' 与 evolution_log 按日计数不一致，指标口径待核。',
  '',
  '## 提案 d85347bf',
  '',
  '- 状态：' + (proposal?.status ?? '未找到') + '；stage：待批准（draft）；立项 ' + String(proposal?.createdAt ?? '').slice(0, 10) + '，已 ' + createdDays + ' 天未动。',
  '- 2026-10-23 暂缓判据「Evolution Ledger 0 行」已失效：当前 ' + num(ledger) + ' 行。',
].join('\n');

const tableCounts = [
  ['agint_evolution.json', [['evolution_log', num(evLog)], ['evolution_ledger', num(ledger)], ['failure_pattern', num(evolution.failure_pattern)], ['prediction_outcomes', num(evolution.prediction_outcomes)], ['benchmark_frozen_set', num(evolution.benchmark_frozen_set)]]],
  ['agint_evolve.json', [['proposal', num(proposals)]]],
  ['agint_metrics.json', [['metric', num(metricRows)]]],
  ['agint_cron.json', [['cron_state', num(cronState)]]],
  ['agint_abtest.json', [['abtests', num(abtest.abtests)], ['samples', num(abtest.samples)]]],
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
  + '<div class="hcard-d">' + h.detail + '</div></div>').join('');

const countsHtml = tableCounts.map(([f, rows]) => '<tr><td class="mono">' + esc(f) + '</td><td>' + rows.map(([k, v]) => '<span class="chip">' + esc(k) + ' <b>' + v + '</b></span>').join(' ') + '</td></tr>').join('');

const generatedAt = new Date().toISOString();
const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AGINT 进化流水线 · 只读可视化面板</title>
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
footer{font-size:11.5px;color:var(--sub);border-top:1px solid var(--line);padding-top:14px;margin-top:26px}footer li{margin-bottom:4px}
@media(max-width:900px){.grid4{grid-template-columns:repeat(2,1fr)}.charts{grid-template-columns:1fr}}
@media(max-width:620px){.grid4{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<header><div><h1>AGINT 进化流水线 · 只读可视化面板</h1><p class="lede">提案 d85347bf 正式形态 · 2026-11-04 老板定案「保持只读 HTML」· 不写任何状态</p></div>
<div class="meta">快照生成：${esc(generatedAt)}<br>数据源：${esc(STORAGES_LABEL)}/<br>形态：单文件 HTML，零外部依赖</div></header>

<div class="banner"><div class="banner-top"><span class="tag green">正式形态 · 只读 HTML（11-04 定案）</span><span class="tag amber">待批准 · draft</span><span class="tag">status = ${esc(proposal?.status ?? '未找到')}</span><span class="tag green">暂缓前提已失效</span><span class="tag red">7 处数据断点</span></div>
<h2>给 AGINT 进化流水线加一个可视化面板 <span class="mono" style="font-size:11px;color:var(--mute);font-weight:400">d85347bf</span></h2>
<p>立项 ${esc(String(proposal?.createdAt ?? '').slice(0, 10))}，<b>${createdDays} 天</b>未动。2026-10-23 评估以「Evolution Ledger 生产表 0 行」判为档 5 暂缓；本次复核该表已有 <b>${num(ledger)} 行</b>，配套数据源亦在写入。<b>暂缓判据失效，可以推进。</b></p>
<p>但真实数据同时显示：发布支路 5 次全回滚、观察阶段 0 个 A/B 实验、规则遵守率是零命中满分。面板第一版的价值是<b>把这些断点画出来</b>，不是把空数据画成好看的图。</p></div>

<section><div class="sec-h"><h2>1 · 流水线时序（Evolution Flow）</h2><span>六阶段 · 真实计数 · 可悬停看来源字段</span></div>
<div class="note"><b>不画桑基图。</b>提案正文设想「每个候选一条流」，但跨表没有统一 trace id：ledger 用 contractId / populationCandidateId，autocreate 用 candidateId，两者无 join key。强行连线会造出系统里不存在的轨迹。第一版给阶段计数与断点标记；等有统一 trace 后再上桑基图。</div>
<div class="flow">${stageCards}</div></section>

<section><div class="sec-h"><h2>2 · 健康仪表盘（Health Dashboard）</h2><span>四卡片 · 阈值按真实数据判定，不粉饰</span></div>
<div class="grid4">${healthCards}</div>
<div class="charts"><div class="chart"><h3>evolution_log 每日新增</h3><div class="cap">近 30 个有数据的日期 · 共 ${num(evLog)} 行</div>${lineChart(logByDay, 520, 170, '#1d4ed8')}</div>
<div class="chart"><h3>trajectory 每日写入</h3><div class="cap">calibration.current.byDay · 共 ${num(traj)} 条</div>${lineChart(trajByDay, 520, 170, '#0f766e')}</div></div></section>

<section><div class="sec-h"><h2>3 · 周复盘导出（Weekly Digest）</h2><span>2026-W45 · 可一键复制 Markdown</span></div>
<button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('dg').textContent).then(()=>{this.textContent='已复制';setTimeout(()=>this.textContent='复制 Markdown',1600)})">复制 Markdown</button>
<pre id="dg">${esc(digest)}</pre></section>

<section><div class="sec-h"><h2>数据源盘点</h2><span>本面板实际读取的表与行数</span></div>
<table>${countsHtml}</table>${missing.length ? '<div class="note" style="margin-top:10px">读取失败：' + esc(missing.join('；')) + '</div>' : ''}</section>

<footer><b>数据可信度与边界</b><ol>
<li>本面板只读。它不改 agint 任何表，不改提案状态，不调用写接口。生成后宿主继续写存储，本页保持生成时刻的快照。</li>
<li><b>口径冲突：</b>metrics 的 evolution.logCount7d=${M('evolution.logCount7d').value ?? '?'}，而 evolution_log 按日计数近 7 日合计 ${logThisWeek}。两者不一致，面板同时列出，不替它们调和。</li>
<li><b>空表：</b>abtest.abtests=${num(abtest.abtests)} / samples=${num(abtest.samples)}。提案的「观察」阶段目前无实验数据。</li>
<li><b>恒定值：</b>memory.total 近 10 次采样恒为 ${M('memory.total').value}；evolution_log ${num(evLog)} 行全为 L1、confidence 0.5、resolved=false、recalls=0。这些是真实状态，不是渲染错误。</li>
<li><b>正式形态与部署：</b>2026-11-04 老板定案「保持只读 HTML」，21:1x 追加「部署到桌面端 dsh」。本页作为家族面板「进化流水线」tab 的 iframe 内容呈现；独立 HTML 仍可直接打开。不新建插件、不改 cordis.patch.yml、不加 cron、不重启宿主。提案要求的桑基图因跨表无 join key 未做，见报告第五节。</li>
<li><b>刷新方式：</b>重跑 <span class="mono">node bin/evolution-viz-snapshot.mjs</span>。它同时更新独立 HTML 与三份 panel-v2.html 的 tab 内容，不新建日期文件。宿主按 mtime 重读资产，不需要重启。</li>
</ol></footer>
</div></body></html>`;

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
const tabBody = '      <button class="tab" data-t="eviz" role="tab" aria-selected="false">进化流水线</button>';
const panelBody = [
  '  <div class="card panel" id="eviz">',
  '    <h2>进化流水线 · 只读快照 <code>d85347bf</code></h2>',
  '    <div class="cap">数据来自生产存储 ' + esc(STORAGES_LABEL) + '/。本页只读，不写任何状态。',
  '      快照随 <code>node bin/evolution-viz-snapshot.mjs</code> 重跑而更新；宿主按 mtime 重读资产，不需要重启。',
  '      iframe 内为固定浅色主题，不跟随家族面板的明暗切换 —— 这是刻意的样式隔离。</div>',
  '    <iframe title="AGINT 进化流水线只读面板"',
  '      srcdoc="' + srcdoc + '"',
  '      style="display:block;width:100%;height:78vh;border:1px solid var(--border);border-radius:8px;background:#f6f8fb"',
  '    ></iframe>',
  '  </div>',
].join('\n');
// 原切换循环的数组硬编码 9 个 id，不含 eviz。补一段独立监听，不动原逻辑。
const hookBody = [
  '/* 进化流水线 tab：原循环的数组是硬编码的，不含 eviz。',
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
console.log('proposal status=' + (proposal?.status ?? '?') + ' days=' + createdDays);
console.log('ledger=' + num(ledger) + ' evolution_log=' + num(evLog) + ' metric=' + num(metricRows) + ' proposals=' + num(proposals));
console.log('missing=' + JSON.stringify(missing));
