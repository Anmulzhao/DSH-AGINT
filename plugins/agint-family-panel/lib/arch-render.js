/**
 * AGINT 进化架构图 —— 渲染层（单一真源）
 *
 * 两个调用方：
 *  1. `bin/evolution-viz-snapshot.mjs` → renderArchPage() 产离线快照 / 独立 HTML
 *  2. `lib/index.js` 的 GET /v2/arch → renderArchFragments() 产实时片段
 *
 * ⛔ 为什么模板只能有一份：若生成器与路由各写一套 HTML，口径与措辞必然漂，
 *   而这正是本次「实时聚合」改造要消除的问题（原先是静态 srcdoc vs /v2/data）。
 *
 * 浏览器端只做 DOM 更新（applyModel），不重写模板 —— 片段由服务端渲染后下发。
 */

import { TONE, EDGE, NO_DATA, VB_W, VB_H, LAYER_BAND_H } from './arch-data.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cut = (s, max) => (String(s ?? '').length > max ? String(s).slice(0, max - 1) + '…' : String(s ?? ''));

export function lineChart(series, w, h, color) {
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

export function sparkSvg(series, w, h, color) {
  const e = Object.entries(series || {}).filter(([k]) => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort(([a], [b]) => a.localeCompare(b)).slice(-30);
  if (e.length < 2) return '';
  const max = Math.max(1, ...e.map(([, v]) => v));
  const pts = e.map(([, v], i) => [(i / (e.length - 1)) * w, h - 2 - (v / max) * (h - 4)]);
  const last = pts[pts.length - 1];
  return '<polyline points="' + pts.map(([x, y]) => x.toFixed(1) + ',' + y.toFixed(1)).join(' ')
    + '" fill="none" stroke="' + color + '" stroke-width="1.3" stroke-linejoin="round" opacity=".85"/>'
    + '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="1.8" fill="' + color + '"/>';
}

/* ── SVG ─────────────────────────────────────────────────────────────── */

function renderLayersSvg(model) {
  return model.layers.map((L, i) => {
    const nodes = L.nodes.map((id) => model.nodes.find((n) => n.id === id)).filter(Boolean);
    const measured = nodes.filter((n) => n.value !== NO_DATA).length;
    const stat = L.name + '：' + nodes.length + ' 节点 / ' + measured + ' 有读数';
    return '<rect x="134" y="' + (L.y - 8) + '" width="1002" height="' + LAYER_BAND_H + '" rx="10" fill="'
      + (i % 2 ? '#eef2f7' : '#f4f7fb') + '" opacity=".72"/>'
      + '<text x="16" y="' + (L.y + 4) + '" font-size="9.5" font-weight="700" fill="#94a3b8">' + L.key + '</text>'
      + '<text x="16" y="' + (L.y + 20) + '" font-size="11.5" font-weight="700" fill="#334155">' + esc(L.name) + '</text>'
      + '<text x="16" y="' + (L.y + 34) + '" font-size="8.5" fill="#94a3b8">' + esc(L.hint) + '</text>'
      + '<text x="16" y="' + (L.y + 48) + '" font-size="8.5" fill="#64748b">' + esc(stat) + '</text>'
      + '<text x="1126" y="' + (L.y + 4) + '" text-anchor="end" font-size="8.5" fill="#94a3b8">' + esc(L.key + ' · ' + nodes.length + ' 节点') + '</text>';
  }).join('');
}

function renderNodesSvg(model) {
  const series = model.sparkSeries || {};
  return model.nodes.map((n) => {
    const t = TONE[n.tone] || TONE.idle;
    const d = n.deg || { i: 0, o: 0 };
    const spark = series[n.id] ? sparkSvg(series[n.id], 46, 18, t.chip) : '';
    return '<g class="node" data-node="' + n.id + '" data-tone="' + n.tone + '" role="button" tabindex="0" aria-label="' + esc(n.name) + '">'
      + '<rect data-f="box" x="' + n.x.toFixed(1) + '" y="' + n.y + '" width="' + n.w.toFixed(1) + '" height="' + n.h
      + '" rx="8" fill="' + t.fill + '" stroke="' + t.stroke + '" stroke-width="1.4"/>'
      + '<rect data-f="bar" x="' + n.x.toFixed(1) + '" y="' + n.y + '" width="3.5" height="' + n.h + '" rx="2" fill="' + t.stroke + '"/>'
      + '<circle data-f="dot" cx="' + (n.x + n.w - 12).toFixed(1) + '" cy="' + (n.y + 12) + '" r="3.5" fill="' + t.stroke + '"/>'
      + '<text x="' + (n.x + 12).toFixed(1) + '" y="' + (n.y + 17) + '" font-size="11.5" font-weight="700" fill="#1c2733">' + esc(cut(n.name, 13)) + '</text>'
      + '<text x="' + (n.x + 12).toFixed(1) + '" y="' + (n.y + 30) + '" font-size="8.5" fill="#64748b" font-family="ui-monospace,Consolas,monospace">' + esc(cut(n.code, Math.floor(n.w / 5.6))) + '</text>'
      + '<g data-f="spark" transform="translate(' + (n.x + n.w - 58).toFixed(1) + ',' + (n.y + 22) + ')">' + spark + '</g>'
      + '<text data-f="value" x="' + (n.x + 12).toFixed(1) + '" y="' + (n.y + 50) + '" font-size="17" font-weight="750" fill="' + t.chip + '">' + esc(String(n.value)) + '</text>'
      + '<text data-f="unit" x="' + (n.x + n.w - 10).toFixed(1) + '" y="' + (n.y + 50) + '" text-anchor="end" font-size="9" fill="#64748b">' + esc(cut(n.unit, 15)) + '</text>'
      + '<text data-f="sub" x="' + (n.x + 12).toFixed(1) + '" y="' + (n.y + 62) + '" font-size="8.5" fill="#64748b">' + esc(cut(n.sub, Math.floor(n.w / 5.4) - 7)) + '</text>'
      + '<text x="' + (n.x + n.w - 10).toFixed(1) + '" y="' + (n.y + 62) + '" text-anchor="end" font-size="8.5" fill="#94a3b8">↑' + d.i + ' ↓' + d.o + '</text>'
      + '</g>';
  }).join('');
}

function edgePath(e, model, rx) {
  const byId = Object.fromEntries(model.nodes.map((n) => [n.id, n]));
  const a = byId[e.from], b = byId[e.to];
  if (!a || !b) return '';
  const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y;
  if (e.kind !== 'feedback') {
    const my = (y1 + y2) / 2;
    return 'M' + x1.toFixed(1) + ',' + y1.toFixed(1)
      + ' C' + x1.toFixed(1) + ',' + my.toFixed(1) + ' ' + x2.toFixed(1) + ',' + my.toFixed(1)
      + ' ' + x2.toFixed(1) + ',' + y2.toFixed(1);
  }
  const ax = a.x + a.w, ay = a.y + a.h / 2, gy = y2 - 10;
  return 'M' + ax.toFixed(1) + ',' + ay.toFixed(1)
    + ' L' + rx + ',' + ay.toFixed(1) + ' L' + rx + ',' + gy.toFixed(1)
    + ' L' + x2.toFixed(1) + ',' + gy.toFixed(1) + ' L' + x2.toFixed(1) + ',' + y2.toFixed(1);
}

function renderEdgesSvg(model) {
  const byId = Object.fromEntries(model.nodes.map((n) => [n.id, n]));
  let fbSeq = 0;
  return model.edges.map((e) => {
    const st = EDGE[e.kind] || EDGE.live;
    const rx = 1184 + fbSeq * 16;
    if (e.kind === 'feedback') fbSeq++;
    const d = edgePath(e, model, rx);
    if (!d) return '';
    const marker = st.arrow ? ' marker-end="url(#' + st.arrow + ')"' : '';
    const dash = st.dash ? ' stroke-dasharray="' + st.dash + '"' : '';
    const op = e.kind === 'break' ? '.7' : (e.kind === 'feedback' ? '.6' : '.4');
    let body = '<path data-f="path" d="' + d + '" fill="none" stroke="' + st.stroke + '" stroke-width="'
      + (e.kind === 'feedback' ? 2 : 1.5) + '" stroke-opacity="' + op + '"' + dash + marker + '/>';
    if (e.kind !== 'break') {
      const dur = { live: 2.9, frozen: 5.4, human: 4.6, feedback: 3.8 }[e.kind] || 2.9;
      const count = e.kind === 'feedback' ? 2 : 1;
      for (let k = 0; k < count; k++) {
        const begin = ((e.i * 0.31 + k * dur / count) % dur).toFixed(2);
        body += '<circle data-f="particle" r="' + (e.kind === 'feedback' ? 3.6 : 3) + '" fill="' + st.dot
          + '" opacity=".92"><animateMotion dur="' + dur + 's" begin="' + begin
          + 's" repeatCount="indefinite" path="' + d + '"/></circle>';
      }
    } else {
      const a = byId[e.from], b = byId[e.to];
      const mx = (a.x + a.w / 2 + b.x + b.w / 2) / 2, my = (a.y + a.h + b.y) / 2;
      body += '<g data-f="breakmark"><circle cx="' + mx.toFixed(1) + '" cy="' + my.toFixed(1) + '" r="8.5" fill="#fff" stroke="#b91c1c" stroke-width="1.4"/>'
        + '<text x="' + mx.toFixed(1) + '" y="' + (my + 3.4).toFixed(1) + '" text-anchor="middle" font-size="9" font-weight="700" fill="#b91c1c">断</text></g>';
    }
    if (e.kind !== 'feedback') {
      const a0 = byId[e.from], b0 = byId[e.to];
      const lx = (a0.x + a0.w / 2 + b0.x + b0.w / 2) / 2;
      const ly = (a0.y + a0.h + b0.y) / 2 - 4;
      body += '<text class="elabel" x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1)
        + '" text-anchor="middle" font-size="8" fill="' + st.stroke
        + '" paint-order="stroke" stroke="#fff" stroke-width="2.6">' + esc(cut(e.label, 12)) + '</text>';
    }
    return '<g data-edge="' + e.i + '" data-kind="' + e.kind + '"><title>' + esc((byId[e.from]?.name || e.from) + ' → ' + (byId[e.to]?.name || e.to) + '：' + e.label + (e.evidence ? '（' + e.evidence + '）' : ''))
      + '</title>' + body + '</g>';
  }).join('');
}

export function renderSvg(model) {
  return '<svg id="arch" viewBox="0 0 ' + VB_W + ' ' + VB_H + '" width="100%" role="img" aria-label="AGINT 进化架构图：分层子系统、信号流与反馈闭环">'
    + '<defs>'
    + '<marker id="ar-live" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#1d4ed8" opacity=".75"/></marker>'
    + '<marker id="ar-fb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#0f766e" opacity=".85"/></marker>'
    + '</defs>' + renderLayersSvg(model)
    + '<g id="edges">' + renderEdgesSvg(model) + '</g><g id="nodes">' + renderNodesSvg(model) + '</g>'
    + '<text x="1226" y="26" text-anchor="end" font-size="10" font-weight="700" fill="#0f766e">↑ 反馈回流（右侧）</text>'
    + '</svg>';
}

/* ── 视图片段 ─────────────────────────────────────────────────────────── */

function renderKpis(model) {
  return model.kpis.map(([k, v, t]) => '<span class="kpi ' + (t || '') + '"><b>' + esc(String(v)) + '</b>' + esc(k) + '</span>').join('');
}

function renderOverview(model) {
  const c = model.counts;
  return '<div class="detail" id="detail"><h3>系统总览</h3>'
    + '<div class="kv">点击任意节点查看<b>读数、来源表、状态与上下游</b>；7 个视图承载支路 / 健康 / 复盘 / 数据源 / 队列 / 校验。</div>'
    + '<div class="kv">本次 <b>' + c.nodes + '</b> 节点 / <b>' + c.edges + '</b> 关系：主链路 ' + c.live + ' · 断点 ' + c.break + ' · 回流 ' + c.feedback + '；<b>' + c.measured + '</b> 个有 storages 读数，<b>' + c.structural + '</b> 个结构节点显示 —。</div>'
    + '<div class="kv">节点内小折线是<b>真实按日序列</b>，右下 ↑↓ 是上下游度数；副读数来自该节点关联的表，详细来源见「数据源」视图。</div>'
    + '<div class="kv">右上状态点：<b>实时</b> = 已从 <span class="mono">/v2/arch</span> 覆盖；<b>离线快照</b> = 服务不可达，读数停在生成时刻。</div>'
    + '</div>';
}

function renderBranch(model) {
  return '<div class="strip">'
    + model.stages.map((s, i) => '<div class="cell tone-' + s.tone + '" title="' + esc(s.src) + '">'
      + '<b>' + (i + 1) + ' · ' + esc(s.name) + '</b>'
      + '<span class="cv">' + esc(String(s.main)) + '</span>'
      + '<span class="cs">' + esc(s.sub) + '</span></div>').join('<div class="sep">→</div>')
    + '</div><div class="hint">⛔ 不画桑基图：跨表无统一 trace id（ledger 用 contractId/populationCandidateId，autocreate 用 candidateId），强行连线会造出系统里不存在的轨迹。节点内 <span class="mono">patterns→cand→prop→rel</span> 即本支路的压缩形态。</div>';
}

function renderVitals(model) {
  return '<div class="hstrip">'
    + model.vitals.map((h) => '<div class="hcell tone-' + h.tone + '"><span>' + esc(h.title) + '</span><b>' + esc(h.value)
      + '</b><small>' + esc(h.detail) + '</small></div>').join('')
    + '</div>';
}

function renderDigest(model) {
  return '<pre class="dg" id="dg">' + esc(model.digest) + '</pre>';
}

function renderSrc(model) {
  return model.nodes.map((n) => '<div class="srcrow" data-goto="' + n.id + '"><b>' + esc(n.name) + '</b>'
    + '<span class="mono">' + esc(n.src) + '</span>'
    + (n.tables || []).map(([k, v]) => '<span class="chip">' + esc(k) + ' <b>' + esc(String(v)) + '</b></span>').join('')
    + '</div>').join('')
    + (model.missing.length ? '<div class="hint bad">⛔ 域不存在（不是 0 行）：' + esc(model.missingFiles.join('；') || model.missing.join('；')) + '</div>' : '');
}

function renderQueues(model) {
  const rows = model.queues.map((q) => {
    const state = q.state && q.state !== 'ok'
      ? '<span class="tagw">' + esc(q.state) + '</span>'
      : '<span class="tago">ok</span>';
    const n = typeof q.pending === 'number' ? String(q.pending) : '—';
    const items = (q.items || []).slice(0, 3).map((x) => esc(String(x.id ?? x.domain ?? x.name ?? '').slice(0, 14))).filter(Boolean).join(' · ');
    return '<div class="qrow"><b>' + esc(q.label) + '</b>'
      + '<span class="kbadge ' + (q.kind === 'supply' ? 'supply' : 'action') + '">' + (q.kind === 'supply' ? '供给' : '待办') + '</span>'
      + '<span class="qn">' + esc(n) + '</span>' + state
      + '<span class="qi">' + (items || (q.reason ? esc(String(q.reason).slice(0, 40)) : '无条目')) + '</span></div>';
  }).join('');
  const total = model.queues.reduce((a, q) => a + (q.kind === 'action' && typeof q.pending === 'number' ? q.pending : 0), 0);
  const supply = model.queues.reduce((a, q) => a + (q.kind === 'supply' && typeof q.pending === 'number' ? q.pending : 0), 0);
  return '<div class="qsum">待办 <b>' + total + '</b>（人能直接动手）· 供给 <b>' + supply + '</b>（等上游攒够）。'
    + ' ⛔ <b>域不存在显示 — 且标 unavailable，不是 0</b>；「本机没开这个插件」与「这个队列是空的」是两件事。</div>'
    + (rows || '<div class="hint">未读到任何队列（aggPending 不可用）。</div>')
    + '<div class="hint">完整 9 队列表格与条目详情见「待办」tab。本视图只做架构视角的归位，不复制审批动作。</div>';
}

function renderCheck(model) {
  const rows = model.edges.map((e) => {
    const st = EDGE[e.kind] || EDGE.live;
    const byId = Object.fromEntries(model.nodes.map((n) => [n.id, n]));
    return '<div class="ckrow"><i class="ln" style="border-top-color:' + st.stroke + (st.dash ? ';border-top-style:dashed' : '') + '"></i>'
      + '<b>' + esc((byId[e.from]?.name || e.from) + ' → ' + (byId[e.to]?.name || e.to)) + '</b>'
      + '<span class="kind">' + esc(e.kind) + (e.declaredKind !== e.kind ? '（声明 ' + esc(e.declaredKind) + '，本次已恢复）' : '') + '</span>'
      + '<span class="basis">' + esc(e.basis || '—') + '</span>'
      + (e.evidence ? '<span class="ev">' + esc(e.evidence) + '</span>' : '') + '</div>';
  }).join('');
  return '<div class="hint">结构关系由 <span class="mono">arch-data.js</span> 的 <span class="mono">EDGE_DECL</span> 声明，'
    + '每条带 <b>basis</b>（凭什么成立）与可选的当次 <b>evidence</b>。⛔ 不拿 Q1 的源码扫描 hits 自动生成边：'
    + '注释命中 / 伞键不可达 / 无提供方都会被误建成依赖。</div>'
    + rows
    + '<div class="hint">' + (model.missing.length ? '⚠ 本次域缺失：' + esc(model.missingFiles.join('；')) : '✓ 本次无域缺失') + '</div>';
}

export function renderArchFragments(model) {
  return {
    kpis: renderKpis(model),
    overview: renderOverview(model),
    branch: renderBranch(model),
    vitals: renderVitals(model),
    digest: renderDigest(model),
    src: renderSrc(model),
    queues: renderQueues(model),
    check: renderCheck(model),
  };
}

/* ── 完整页面（生成器用） ──────────────────────────────────────────────── */

const CSS = `
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
.stamp b{font-weight:700;letter-spacing:.02em}
.stamp.live b{color:#15803d}.stamp.snap b{color:#b45309}
.stamp i{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px;background:#94a3b8;vertical-align:middle}
.stamp.live i{background:#15803d}.stamp.snap i{background:#b45309}
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
.tabs{display:flex;align-items:center;gap:0;border-bottom:1px solid var(--line);padding:0 9px;overflow-x:auto}
.tb{font:inherit;font-size:10.5px;padding:6px 9px;border:0;border-bottom:2px solid transparent;background:none;color:var(--sub);cursor:pointer;white-space:nowrap}
.tb:hover{color:var(--blue)}.tb.on{color:var(--blue);border-bottom-color:var(--blue);font-weight:700}
.selfcheck{margin-left:auto;font-size:9.5px;font-weight:700;color:var(--ok);white-space:nowrap}.selfcheck.bad{color:var(--bad)}
.views{height:152px;overflow:auto;padding:7px 11px}
.view{display:none}.view.on{display:block}
.detail h3{margin:0 0 4px;font-size:12.5px}
.detail .kv{font-size:10.5px;color:var(--sub);margin:2px 0}.detail .kv b{color:var(--ink)}
.detail .rel{font-size:10px;color:var(--sub);border-top:1px dashed var(--line);margin-top:5px;padding-top:5px;column-count:2;column-gap:16px}
.navbtn{font:inherit;font-size:10px;padding:2px 8px;margin:4px 6px 0 0;border:1px solid #c7d7ff;border-radius:5px;background:#eef2ff;color:var(--blue);cursor:pointer}
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
.dg{background:#0f172a;color:#dbe4f0;border-radius:6px;padding:8px 10px;font:10px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;margin:0;max-height:136px;overflow:auto}
.srcrow{display:flex;align-items:center;gap:6px;padding:3px 6px;border-bottom:1px dashed var(--line);cursor:pointer;flex-wrap:wrap}
.srcrow:hover{background:#eef2ff}
.srcrow>b{font-size:10px;min-width:118px}.srcrow>.mono{font-size:9px;color:var(--mute);min-width:200px}
.qsum{font-size:10px;color:var(--sub);margin-bottom:4px}
.qrow{display:flex;align-items:center;gap:7px;padding:3px 4px;border-bottom:1px dashed var(--line);font-size:10px}
.qrow>b{min-width:180px}.qrow .qn{font-weight:750;font-size:12px;min-width:20px;text-align:right}
.kbadge{font-size:9px;border-radius:3px;padding:0 4px;border:1px solid #e5eaf1;background:#f6f8fb;color:var(--sub)}
.kbadge.supply{border-color:#f3dca8;background:#fffbeb;color:#8a6a1e}
.tago{font-size:9px;color:var(--ok)}.tagw{font-size:9px;color:var(--warn)}
.qrow .qi{color:var(--mute);font-size:9.5px;margin-left:auto;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ckrow{display:flex;align-items:center;gap:6px;padding:2px 4px;border-bottom:1px dashed var(--line);font-size:9.5px;flex-wrap:wrap}
.ckrow .ln{width:14px;height:0;border-top:2px solid;display:inline-block;flex:none}
.ckrow>b{font-size:10px;min-width:170px}.ckrow .kind{color:var(--mute);min-width:54px}
.ckrow .basis{color:var(--sub);min-width:180px}.ckrow .ev{color:var(--warn)}
.foot{display:flex;align-items:center;gap:12px;margin-top:5px;font-size:9.5px;color:var(--mute);flex-wrap:wrap}
details summary{cursor:pointer;color:var(--blue);font-size:9.5px}
.bounds{padding:6px 10px;background:#fff;border:1px solid var(--line);border-radius:6px;margin-top:4px;line-height:1.65;font-size:10px;max-width:1100px}
.empty{font-size:10px;color:var(--mute)}
@media(max-width:900px){.hstrip{grid-template-columns:repeat(2,1fr)}}
`;

export function renderArchPage(model, opts = {}) {
  const frag = renderArchFragments(model);
  const toneLegend = Object.entries(TONE).map(([, t]) => '<span class="lg"><i class="sq" style="background:' + t.fill + ';border-color:' + t.stroke + '"></i>' + t.label + '</span>').join('');
  const edgeLegend = Object.entries(EDGE).map(([, e]) => '<span class="lg"><i class="ln" style="border-top-color:' + e.stroke + (e.dash ? ';border-top-style:dashed' : '') + '"></i>' + e.label + '</span>').join('');
  const live = model.counts;
  const snapJson = JSON.stringify(model).replace(/</g, '\\u003c');
  const title = opts.title || 'AGINT 进化架构图 · 系统动态';
  const mode = opts.mode === 'live' ? 'live' : 'snapshot';
  const modeText = mode === 'live' ? '实时聚合' : '离线快照';

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style></head><body><div class="app">

<header class="top">
<div class="brand">AGINT 进化架构图<span id="brandMode">· 系统动态 · ${esc(modeText)}</span></div>
<div class="kpis" id="kpis">${frag.kpis}</div>
<div class="stamp ${mode === 'live' ? 'live' : 'snap'}" id="stamp"><i></i><b id="stampMode">${esc(modeText)}</b> <span id="stampText">${esc(model.generatedAt)}</span><br>${esc(model.storageLabel)}/ · ${model.domains.length} 域</div>
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
<div class="canvas"><div class="arch-scroll">${renderSvg(model)}</div></div>
<div class="inspect">
<div class="tabs">
<button class="tb on" data-v="node">节点</button>
<button class="tb" data-v="branch">支路 · 六阶段</button>
<button class="tb" data-v="vitals">健康</button>
<button class="tb" data-v="digest">复盘 · ${esc(model.currentWeek)}</button>
<button class="tb" data-v="src">数据源 · ${model.domains.length} 域</button>
<button class="tb" data-v="queues">队列 · ${model.queues.length}</button>
<button class="tb" data-v="check">校验 · ${live.edges}</button>
<span class="selfcheck" id="selfcheck">自检…</span>
</div>
<div class="views">
<div class="view on" id="v-node">${frag.overview}</div>
<div class="view" id="v-branch">${frag.branch}</div>
<div class="view" id="v-vitals">${frag.vitals}</div>
<div class="view" id="v-digest">${frag.digest}</div>
<div class="view" id="v-src">${frag.src}</div>
<div class="view" id="v-queues">${frag.queues}</div>
<div class="view" id="v-check">${frag.check}</div>
</div>
</div>
</div>

<div class="foot">
<details><summary>边界与口径（点开）</summary><div class="bounds">
<b>① 动态的含义：</b>流动粒子表示真实存在的读写 / 触发 / 回流关系与方向（依据 docs/architecture.md 与 AGENTS.md），⛔ 不是实时流量、不代表吞吐或成功率；${live.break} 条断点边不画粒子，不把空数据画成好看的流动线。<br>
<b>② 三态纪律：</b>有数显示数；域不存在显示 <b>—</b>（不是 0）；表存在但 0 行显示 0 并注明。本次 ${model.missingFiles.length} 个域不存在：${esc(model.missingFiles.join('；')) || '无'}。${live.structural} 个运行时结构节点不在本页读取的 storages 域内，只画拓扑位置。<br>
<b>③ 口径与不自评：</b>logCount7d=${model.bounds.logCount7d ?? '?'} vs 按日近 7 日 ${model.bounds.logThisWeek}（${model.bounds.consistent ? '本次一致' : '不一致，同时列出不调和'}）；外置冻结集是「运营者授权 · agent 执行 · 非人类验证」的机械真值，capabilityConclusion 恒 null，⛔ 不据此宣称能力水平；人工标注不代填。aesthetic_score 是内部卫生公式，不是智能分数。<br>
<b>④ 刷新与两形态：</b><span class="mono">/v2/arch</span> 可达时每 30s 覆盖一次（切回可见立即重取），状态点显示「实时」；不可达（如以 <span class="mono">file://</span> 打开独立 HTML）时停在<b>离线快照</b>并显示生成时刻，⛔ 不假装实时。生成器 <span class="mono">node bin/evolution-viz-snapshot.mjs</span> 仍负责刷新首屏快照与三份面板副本。<br>
<b>⑤ 只读：</b>本页不改任何表 / 提案状态 / 写接口；审批与导出留在家族面板对应 tab。节点详情里的「去提案台」只做 <span class="mono">postMessage</span> 导航，不执行写操作。
</div></details>
<span>粒子=拓扑方向，非实时指标 · 断点不画粒子 · 只读不写状态</span>
</div>
</div>
<script>
(function(){
  'use strict';
  var SNAP = ${snapJson};
  var svg = document.getElementById('arch');
  var detail = document.getElementById('detail');
  var kpis = document.getElementById('kpis');
  var stamp = document.getElementById('stamp');
  var stampText = document.getElementById('stampText');
  var map = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
  function es(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return map[c]; }); }
  var M = SNAP;
  var byId = {};
  M.nodes.forEach(function(n){ byId[n.id] = n; });
  var selected = null;

  var tabs = document.querySelectorAll('.tb');
  var views = { node:'v-node', branch:'v-branch', vitals:'v-vitals', digest:'v-digest', src:'v-src', queues:'v-queues', check:'v-check' };
  function setView(v){
    for(var i=0;i<tabs.length;i++){ tabs[i].classList.toggle('on', tabs[i].getAttribute('data-v')===v); }
    Object.keys(views).forEach(function(k){ var el=document.getElementById(views[k]); if(el) el.classList.toggle('on', k===v); });
  }
  function bindTabs(){
    tabs = document.querySelectorAll('.tb');
    for(var ti=0;ti<tabs.length;ti++){
      (function(t){ t.onclick = function(){ setView(t.getAttribute('data-v')); }; })(tabs[ti]);
    }
  }
  bindTabs();

  function rel(id){
    var ins=M.edges.filter(function(e){return e.to===id;}), outs=M.edges.filter(function(e){return e.from===id;});
    function row(e){ return '<div>· '+es(e.kind)+'：'+es(e.label)+'（'+es((byId[e.from]||{}).name||e.from)+' → '+es((byId[e.to]||{}).name||e.to)+'）'+(e.evidence?'<br><span style="color:#b45309">证据：'+es(e.evidence)+'</span>':'')+'</div>'; }
    return '<div class="rel"><b>上游（'+ins.length+'）</b>'+(ins.length?ins.map(row).join(''):'<div>· 无</div>')
      +'<b style="display:block;margin-top:4px">下游（'+outs.length+'）</b>'+(outs.length?outs.map(row).join(''):'<div>· 无</div>')+'</div>';
  }
  function chips(n){
    return (n.tables&&n.tables.length) ? '<div class="chips">'+n.tables.map(function(t){ return '<span class="chip">'+es(t[0])+' <b>'+es(String(t[1]))+'</b></span>'; }).join('')+'</div>' : '';
  }
  function navBtns(id){
    var map2 = { propose:'prop', curriculum:'pend', queue:'prop', release:'prop', outcomes:'prop', rules:'q3', skillAc:'pend', eval:'oracle', upstream:'prop', host:'q1' };
    var t = map2[id];
    if(!t) return '';
    var label = { prop:'去提案台（唯一写入口）', pend:'去待办', q1:'去 Q1 依赖拓扑', q3:'去 Q3 腐化判定', oracle:'去神谕判词' }[t] || '去详情';
    /* 上游判读 2026-11-18 起折进提案台 #upDetails：跳 tab 同时带上要展开的块 id。 */
    var open = '';
    if(id==='upstream'){ label='去上游判读（提案台内）'; open=' data-open="upDetails"'; }
    return '<button class="navbtn" data-nav="'+t+'"'+open+'>'+label+' →</button>';
  }
  function show(id){
    var n=byId[id]; if(!n) return;
    selected = id;
    detail.innerHTML='<h3>'+es(n.name)+' <span class="mono" style="font-size:10px;color:var(--mute);font-weight:400">'+es(n.layer)+' · '+es(n.code)+'</span></h3>'
      +'<div class="kv">读数：<b>'+es(n.value)+'</b> '+es(n.unit)+' ｜ 状态：<b>'+es((TONE_LABEL[n.tone]||n.tone))+'</b> ｜ 上下游：<b>↑'+(n.deg?n.deg.i:0)+' ↓'+(n.deg?n.deg.o:0)+'</b></div>'
      +'<div class="kv">副读数：'+es(n.sub)+'</div>'
      +'<div class="kv">来源：<span class="mono">'+es(n.src)+'</span></div>'+chips(n)
      +'<div class="kv" style="margin-top:4px">'+es(n.detail)+'</div>'+navBtns(id)+rel(id);
    var gs=document.querySelectorAll('#arch .node');
    for(var i=0;i<gs.length;i++){ gs[i].classList.toggle('sel', gs[i].getAttribute('data-node')===id); }
    setView('node');
  }
  var TONE_LABEL = { ok:'活跃（有真实读数）', warn:'可疑 / 待核', bad:'断点（本次无数据）', frozen:'外置冻结', human:'人工闸门', idle:'无快照读数' };

  function bindNodes(){
    var gs=document.querySelectorAll('#arch .node');
    for(var i=0;i<gs.length;i++){
      (function(g){
        g.onclick=function(){ show(g.getAttribute('data-node')); };
        g.onkeydown=function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); show(g.getAttribute('data-node')); } };
      })(gs[i]);
    }
    var rows=document.querySelectorAll('.srcrow');
    for(var ri=0;ri<rows.length;ri++){
      (function(r){ r.onclick=function(){ show(r.getAttribute('data-goto')); }; })(rows[ri]);
    }
  }
  bindNodes();

  if (document.addEventListener) {
    document.addEventListener('click', function(e){
      var b = e.target && e.target.closest && e.target.closest('[data-nav]');
      if(!b) return;
      try { if(window.parent && window.parent !== window) window.parent.postMessage({ type:'agint-nav', target:b.getAttribute('data-nav'), open:b.getAttribute('data-open')||'' }, '*'); } catch(err){}
    });
  }

  var paused=false;
  var motionBtn=document.getElementById('motionBtn');
  function setPaused(p){
    paused=p;
    if(svg && typeof svg.pauseAnimations==='function'){ if(p){ svg.pauseAnimations(); } else { svg.unpauseAnimations(); } }
    motionBtn.textContent=p?'▶ 动态':'⏸ 动态';
    motionBtn.classList.toggle('on', !p);
  }
  motionBtn.onclick=function(){ setPaused(!paused); };
  if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches){ setPaused(true); }
  else { motionBtn.classList.add('on'); }

  var labelBtn=document.getElementById('labelBtn');
  labelBtn.onclick=function(){
    var on=document.body.classList.toggle('show-labels');
    labelBtn.classList.toggle('on', on);
  };

  var copyBtn=document.getElementById('copyBtn');
  copyBtn.onclick=function(){
    var g=document.getElementById('dg'); var txt=g?g.textContent:'';
    function done(){ copyBtn.textContent='已复制'; setTimeout(function(){ copyBtn.textContent='复制复盘'; },1600); }
    if(typeof navigator!=='undefined' && navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(txt).then(done, done);
    } else { done(); }
  };

  function selfcheck(){
    var sc=document.getElementById('selfcheck');
    var nodeOk=document.querySelectorAll('#arch .node').length===M.nodes.length;
    var edgeOk=document.querySelectorAll('#arch [data-edge]').length===M.edges.length;
    var linkOk=M.edges.every(function(e){ return !!byId[e.from] && !!byId[e.to]; });
    var viewOk=Object.keys(views).every(function(k){ return !!document.getElementById(views[k]); });
    var ok=nodeOk&&edgeOk&&linkOk&&viewOk;
    sc.className='selfcheck'+(ok?'':' bad');
    sc.textContent=ok
      ? '自检通过 · '+M.nodes.length+' 节点 / '+M.edges.length+' 关系 / 7 视图'+(LIVE?' · 实时':' · 快照')
      : '自检未通过（节点='+nodeOk+' 边='+edgeOk+' 链路='+linkOk+' 视图='+viewOk+'）';
  }
  var LIVE=false;
  selfcheck();

  function setStamp(mode, at, note){
    var live = mode==='live';
    LIVE = live;
    var txt = live ? '实时聚合' : '离线快照';
    stamp.className='stamp '+(live?'live':'snap');
    /* 模式必须是显式徽标：只给一个 ISO 时间戳，悬挂时会被误读成实时。 */
    stamp.innerHTML='<i></i><b id="stampMode">'+txt+'</b> <span id="stampText">'+es(at)+'</span><br>'+es(note||'');
    stampText=document.getElementById('stampText');
    var bm=document.getElementById('brandMode');
    if(bm) bm.textContent='· 系统动态 · '+txt;
  }

  var toneMap = {
    ok:{stroke:'#15803d',fill:'#f0fdf4',chip:'#15803d'},
    warn:{stroke:'#b45309',fill:'#fffbeb',chip:'#b45309'},
    bad:{stroke:'#b91c1c',fill:'#fef2f2',chip:'#b91c1c'},
    frozen:{stroke:'#6d28d9',fill:'#f5f3ff',chip:'#6d28d9'},
    human:{stroke:'#1d4ed8',fill:'#eef2ff',chip:'#1d4ed8'},
    idle:{stroke:'#94a3b8',fill:'#f8fafc',chip:'#64748b'}
  };
  function applyModel(next, fragments){
    if(!next || !next.nodes) return;
    M = next; byId = {};
    M.nodes.forEach(function(n){ byId[n.id] = n; });
    M.nodes.forEach(function(n){
      var g = document.querySelector('#arch .node[data-node="'+n.id+'"]');
      if(!g) return;
      var t = toneMap[n.tone] || toneMap.idle;
      g.setAttribute('data-tone', n.tone);
      var box=g.querySelector('[data-f="box"]'), bar=g.querySelector('[data-f="bar"]'), dot=g.querySelector('[data-f="dot"]');
      if(box){ box.setAttribute('fill',t.fill); box.setAttribute('stroke',t.stroke); }
      if(bar) bar.setAttribute('fill',t.stroke);
      if(dot) dot.setAttribute('fill',t.stroke);
      var v=g.querySelector('[data-f="value"]'); if(v){ v.textContent=String(n.value); v.setAttribute('fill',t.chip); }
      var u=g.querySelector('[data-f="unit"]'); if(u) u.textContent=n.unit;
      var s=g.querySelector('[data-f="sub"]'); if(s) s.textContent=n.sub;
    });
    M.edges.forEach(function(e){
      var g = document.querySelector('#arch [data-edge="'+e.i+'"]');
      if(!g) return;
      g.setAttribute('data-kind', e.kind);
      var st = { live:'#1d4ed8', break:'#b91c1c', frozen:'#6d28d9', human:'#1d4ed8', feedback:'#0f766e' }[e.kind] || '#1d4ed8';
      var p=g.querySelector('[data-f="path"]');
      if(p){
        p.setAttribute('stroke', st);
        if(e.kind==='break') p.setAttribute('stroke-dasharray','5 5'); else p.removeAttribute('stroke-dasharray');
        p.setAttribute('stroke-opacity', e.kind==='break'?'.7':(e.kind==='feedback'?'.6':'.4'));
      }
      var ttl=g.querySelector('title');
      if(ttl) ttl.textContent = ((byId[e.from]||{}).name||e.from)+' → '+((byId[e.to]||{}).name||e.to)+'：'+e.label+(e.evidence?'（'+e.evidence+'）':'');
    });
    if(fragments){
      if(kpis) kpis.innerHTML = fragments.kpis;
      ['branch','vitals','digest','src','queues','check'].forEach(function(k){
        var el=document.getElementById('v-'+k);
        if(el && fragments[k]!=null) el.innerHTML = fragments[k];
      });
      if(!selected){
        var ov=document.getElementById('v-node');
        if(ov && fragments.overview) ov.innerHTML = fragments.overview;
      }
    }
    if(selected) show(selected);
    bindTabs(); bindNodes(); selfcheck();
  }

  var timer=null, failCount=0;
  function fetchLive(){
    if(!window.fetch) return;
    fetch('/api/agint-family/v2/arch',{cache:'no-store'}).then(function(r){
      if(!r.ok) throw new Error('HTTP '+r.status);
      return r.json();
    }).then(function(d){
      if(!d || !d.ok || !d.model) throw new Error('bad payload');
      failCount = 0;
      applyModel(d.model, d.fragments);
      setStamp('live', d.generatedAt, '/v2/arch · 30s 轮询');
    }).catch(function(err){
      failCount++;
      setStamp('snapshot', M.generatedAt, '请求失败 · ' + String(err && err.message || err).slice(0,40));
      // 路由未注册时（重启前返回 401/404）不要每 30s 打一次：退避到 5 分钟。
      // 宿主重启后自动恢复实时，无需刷新页面。
      if(failCount === 3 && timer){ clearInterval(timer); timer = setInterval(fetchLive, 300000); }
    });
  }
  fetchLive();
  timer = setInterval(fetchLive, 30000);
  if(document.addEventListener){
    document.addEventListener('visibilitychange', function(){ if(!document.hidden) fetchLive(); });
  }
})();
</script>
</body></html>`;
}
