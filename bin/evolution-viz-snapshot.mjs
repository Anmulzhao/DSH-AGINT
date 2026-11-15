// AGINT 进化架构图 —— 离线快照生成器 + 家族面板部署（正式形态）
//
// 2026-11-16 起改为**单点数据 / 单点渲染**：
//   数据层 plugins/agint-family-panel/lib/arch-data.js（collectArchData）
//   渲染层 plugins/agint-family-panel/lib/arch-render.js（renderArchPage / renderArchFragments）
//   实时通道 lib/index.js 的 GET /api/agint-family/v2/arch 调**同一对**函数。
//   ⛔ 不要把读数或模板再写回本文件：两套实现必然漂，这正是本次改造要消除的问题
//      （原先静态 srcdoc 与 /v2/data 两轨，实测时点差 13m52s、域交集仅 5 个）。
//
// 本文件只负责：解析路径 → 聚合一次 → 渲染 → 写独立 HTML → 幂等注入三份面板副本。
//
// 输出：
//   1. docs/AGINT-进化架构图.html（独立单文件；file:// 打开时显示离线快照）
//   2. 三份 assets/panel-v2.html 的「进化架构图」tab（TAB / PANEL / HOOK 三段标记）
//
// 三态纪律：有数显示数；域不存在显示 —（灰，不是 0）；表存在但 0 行显示 0 并注明。
// 边界：只读生产存储。不写任何状态。不改任何表。不加依赖（仅 Node 内置模块）。
//
// 刷新：HTML 资产按 mtime 重读（零重启）；实时读数由 /v2/arch 每 30s 覆盖。
// ⛔ 本文件是正式资产，不是 _ 前缀一次性产物，不要按临时文件清理。

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectArchData } from '../plugins/agint-family-panel/lib/arch-data.js';
import { renderArchPage } from '../plugins/agint-family-panel/lib/arch-render.js';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DSH_HOME = process.env.DSH_HOME || 'D:/DSH/AGINT-date';
const STORAGES = join(DSH_HOME, 'storages');
const STORAGES_LABEL = '$DSH_HOME/storages';
const OUT = join(DSH_HOME, '..', 'docs', 'AGINT-进化架构图.html');

const model = collectArchData({ storagesDir: STORAGES, storageLabel: STORAGES_LABEL });
const html = renderArchPage(model, { mode: 'snapshot', title: 'AGINT 进化架构图 · 系统动态' });

// ── 部署：把面板注入家族面板 v2 的新 tab ────────────────────────────────
// 零重启依据：family-panel/lib/index.js 的 readV2Html() 按 mtimeMs 缓存。
// 不改 patch、不新建插件、不加 cron。
const PROFILE_NAME = (() => {
  try {
    const p = JSON.parse(fs.readFileSync(join(DSH_HOME, '.agint-bundle', 'profile.json'), 'utf8'));
    return p.profile || 'web';
  } catch { return 'web'; }
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
  '    <h2>进化架构图 · 系统动态 <span class="real">实时聚合</span></h2>',
  '    <div class="cap">一屏工作区：顶栏 KPI + 分层架构图 + 7 视图检查器（节点 / 支路 / 健康 / 复盘 / 数据源 / 队列 / 校验）。',
  '      流动的圆点表示<b>链路方向与拓扑</b>，不是实时流量；红色虚线是当次断点，不画粒子。点节点看读数、来源表与上下游。',
  '      <b>每 30s 从 <code>/api/agint-family/v2/arch</code> 覆盖一次</b>（切回可见立即重取）；服务不可达时停在离线快照并显示生成时刻，不假装实时。',
  '      ⛔ 只读、不写任何状态；审批与导出留在对应 tab。宿主按 mtime 重读资产，不需要重启。</div>',
  '    <iframe title="AGINT 进化架构图（只读 · 实时）"',
  '      srcdoc="' + srcdoc + '"',
  '      style="display:block;width:100%;height:88vh;max-height:880px;min-height:620px;border:1px solid var(--border);border-radius:8px;background:#f6f8fb"',
  '    ></iframe>',
  '  </div>',
].join('\n');
// 原切换循环的数组硬编码 9 个 id，不含 eviz。补一段独立监听，不动原逻辑。
// 同时接收 iframe 的导航消息（节点详情里的「去提案台」按钮），只切 tab、不执行写。
const hookBody = [
  '/* 进化架构图 tab：原循环的数组是硬编码的，不含 eviz。',
  '   每次点击把 eviz 的 .on 设成「点的就是它」，点别的 tab 会自然关掉它。 */',
  'tabs.addEventListener("click",e=>{',
  '  const b=e.target.closest(".tab"); if(!b) return;',
  '  document.getElementById("eviz")?.classList.toggle("on", b.dataset.t==="eviz");',
  '});',
  '/* 架构图 iframe → 父页导航：只切 tab，不代执行任何写操作。',
  '   校验来源是 eviz 里的那个 iframe，别的窗口发同样形状的消息一律忽略。 */',
  'window.addEventListener("message",e=>{',
  '  const d=e.data; if(!d||d.type!=="agint-nav") return;',
  '  const f=document.querySelector("#eviz iframe");',
  '  if(f&&e.source!==f.contentWindow) return;',
  '  const t=String(d.target||""); if(!/^[a-z0-9]+$/.test(t)) return;',
  '  const b=document.querySelector(\'.tab[data-t="\'+t+\'"]\');',
  '  if(b) b.click();',
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
    // sha 按归一行尾后算：部署位历史上带 CRLF，仓库位是 LF。
    sha: createHash('sha256').update(r3.text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16),
  });
}

fs.mkdirSync(join(DSH_HOME, '..', 'docs'), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
const c = model.counts;
console.log('WROTE ' + OUT);
console.log('bytes=' + Buffer.byteLength(html, 'utf8') + ' srcdocBytes=' + Buffer.byteLength(srcdoc, 'utf8'));
for (const r of injectReport) console.log('INJECT ' + (r.first ? 'FIRST ' : 'UPDATE') + r.bytes + 'B sha=' + r.sha + ' ' + r.path);
console.log('三副本 sha256 一致=' + (new Set(injectReport.map((r) => r.sha)).size === 1));
console.log('arch layers=' + model.layers.length + ' nodes=' + c.nodes + ' edges=' + c.edges
  + ' live=' + c.live + ' break=' + c.break + ' feedback=' + c.feedback
  + ' measured=' + c.measured + ' structural=' + c.structural);
console.log('inspectorViews=7 sparks=' + Object.keys(model.sparkSeries).length
  + ' queues=' + model.queues.length + ' domains=' + model.domains.length);
console.log('oracle=' + model.oracle.state + '(' + model.oracle.cards + ' 卡) upstream=' + model.upstream.state
  + ' events=' + model.events.state + ' tools=' + model.tools.state);
console.log('missing=' + JSON.stringify(model.missingFiles));
