/**
 * Q3 判定层的真实数据回放（2026-10-04）。
 *
 * 为什么需要它：面板的十条判定写在 assets/panel-v2.html 的 <script> 里，既不能被
 * node --test 直接跑，又没有第二个实现能对照。本文件把判定**逐条按面板同一口径**
 * 在 Node 里复刻一遍，跑在生产三源（~/.dsh/storages）+ 部署位源码上。
 *
 * ⛔ 它不是面板的第二个实现，而是「面板判据的可执行规格」：两份逻辑必须一起改。
 *    口径漂移的代价由下面每条断言的注释写明。
 *
 * 用法：node test/q3-verdicts.test.mjs（需本机已跑过一次 dsh，storages 存在）
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { collectV2Data, resolveV2Dirs } from '../lib/v2-data.js';

const DSH = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const PLUGINS = join(DSH, 'profiles', 'web', 'plugins');
const STORAGES = join(DSH, 'storages');
/** 仓库位根目录（走与生产同一套回退：AGINT_HOME → AGINT_REPO_ROOT → 自身路径）。 */
const REPO_ROOT = resolveV2Dirs({ DSH_HOME: DSH }).repoPluginsDir === null
  ? null
  : resolve(resolveV2Dirs({ DSH_HOME: DSH }).repoPluginsDir, '..');
const haveData = existsSync(join(STORAGES, 'agint_event_bus.json')) && existsSync(PLUGINS);
if (!haveData) {
  console.log(`SKIP：本机无部署位或 storages（DSH_HOME=${DSH}），真数据回放跳过`);
  process.exit(0);
}
const D = collectV2Data({ pluginsDir: PLUGINS, storagesDir: STORAGES, repoPluginsDir: null, repoPluginsSource: 'unresolved' },
  { force: true, cache: new Map() });

// ── 面板同口径的前置量（改面板时同步改这里） ──
const HOST_KEYS = new Set(['agents', 'subagents', 'skills', 'sandbox', 'approval', 'openvikingMemory',
  'dshHome', 'profilesDir', 'sessionQuery', 'sessionPersistence', 'agentDefaultModel', 'goals', 'layout']);
function providerOf(s) {
  if (D.scan.provided[s]) return D.scan.provided[s];
  const p = s.split('.');
  while (p.length > 2) { p.pop(); if (D.scan.provided[p.join('.')]) return D.scan.provided[p.join('.')]; }
  return null;
}
const byPlugin = {};
for (const [pl, file, line, svc, kind] of D.scan.hits) {
  (byPlugin[pl] ??= { code: new Map(), comment: [], umbrella: [] });
  if (kind === 'code') { if (!byPlugin[pl].code.has(svc)) byPlugin[pl].code.set(svc, []); byPlugin[pl].code.get(svc).push({ file, line }); }
  else if (kind === 'comment') byPlugin[pl].comment.push({ svc, file, line });
  else byPlugin[pl].umbrella.push({ svc, file, line });
}

// 同族即同一依赖（2026-10-05，与面板 assets/panel-v2.html 同口径）：
// cordis 服务键点分层级，声明命名空间而代码取子键（声明 agint.eventBus、调
// ctx.get('agint.eventBus.publish')）是本仓主流写法，反向同理。严格等值比会凭空
// 造出 11 条假「文档腐化」。互为前缀即算有依据。
const famIn = (svc, arr) => arr.some((k) => k === svc || k.startsWith(`${svc}.`) || svc.startsWith(`${k}.`));
const codeSvcs = (g) => [...g.code.keys()];
const commentSvcs = (g) => g.comment.map((c) => c.svc);
const umbrellaSvcs = (g) => g.umbrella.map((u) => u.svc);
const unbackedOf = (g, s) => !famIn(s, codeSvcs(g)) && !famIn(s, commentSvcs(g)) && !famIn(s, umbrellaSvcs(g));
const commentOnlyOf = (g, s) => !famIn(s, codeSvcs(g)) && (famIn(s, commentSvcs(g)) || famIn(s, umbrellaSvcs(g)));

// 判据 1：从未接线
// ⛔ 与面板同步（2026-10-05）：**没有任何消费声明的插件一律不报**。
//    旧分支在 decl 为空时照样推 no-decl 行、拿注释命中当证据，实测把
//    agint-family-panel 自己列成从未接线（它 lib/index.js:431 有可执行 ctx.get）。
const neverWired = [];
for (const [pl, g] of Object.entries(byPlugin)) {
  if (g.code.size > 0) continue;
  if (D.pluginKinds[pl]?.checker) continue;
  const decl = D.manifestConsumes[pl] ?? [];
  if (decl.length === 0) continue;
  const unbacked = decl.filter((s) => unbackedOf(g, s));
  const commented = decl.filter((s) => commentOnlyOf(g, s) && famIn(s, commentSvcs(g)));
  if (unbacked.length || commented.length) neverWired.push({ pl, why: 'unbacked', unbacked, commented });
}

// 判据 2：无提供方（只查家族键）
// ⛔ 与面板同口径（assets/panel-v2.html 判据①「无提供方只对 agint.* 家族键成立」）：
//    声明补边把宿主服务键也认成边了（agint-mascot 的 tools / loader / pet —— dsh
//    提供，本仓不可能 provide）。只按 HOST_KEYS 清单排除会随宿主加键而失真，
//    所以这里直接用前缀判家族键，HOST_KEYS 留作双保险。
const isFamilyKey = (svc) => svc.startsWith('agint.');
const npBySvc = {};
for (const [pl, g] of Object.entries(byPlugin)) {
  for (const [svc] of g.code) {
    if (!isFamilyKey(svc)) continue;
    if (!providerOf(svc) && svc !== 'agint.rules' && !HOST_KEYS.has(svc)) (npBySvc[svc] ??= []).push(pl);
  }
}

// 判据 3：文档腐化（同族算依据，见上方 famIn）
const rotted = [];
for (const [pl, decl] of Object.entries(D.manifestConsumes)) {
  const g = byPlugin[pl];
  if (!g) continue;
  const missing = decl.filter((s) => unbackedOf(g, s));
  if (missing.length) rotted.push({ pl, missing });
}

// 判据 4：manifest 漏写
const undeclared = Object.entries(byPlugin)
  .filter(([pl, g]) => !D.manifestConsumes[pl] && g.code.size >= 5)
  .map(([pl, g]) => `${pl}(${g.code.size})`);

// 判据 5：僵尸候选（三源全零 + 形态豁免）
const OWNER = [['memory_provider_', 'agint-memory-provider'], ['memory_', 'agint-memory'], ['wiki_', 'agint-wiki'],
  ['rule_', 'agint-rules'], ['cron_', 'agint-cron'], ['job_', 'agint-cron'], ['dream_', 'agint-dream'],
  ['evolve_', 'agint-evolve'], ['metrics_', 'agint-metrics'], ['eventBus_', 'agint-event-bus'], ['curator_', 'agint-curator'],
  ['autocreate_', 'agint-skill-autocreate'], ['selfModel_', 'agint-self-model'], ['skillGraph_', 'agint-skill-graph'],
  ['mutator_', 'agint-mutator'], ['population_', 'agint-population'], ['mount_', 'agint-mount'], ['abtest_', 'agint-abtest'],
  ['diagnosis_', 'agint-diagnosis'], ['diagnose_', 'agint-diagnosis'], ['input_gateway_', 'agint-input-gateway'],
  ['curriculum_', 'agint-curriculum'], ['quality_eval_', 'agint-quality-eval'], ['tool_stats_', 'agint-tool-stats'],
  ['agint_search', 'agint-search'], ['compress_guard_', 'agint-compress-guard'], ['restart_', 'agint-restart'],
  ['evolution_ledger', 'agint-evolution-driver'], ['evolution_', 'agint-evolution-memory'], ['recall_store', 'agint-ov-strategy']];
const owner = (t) => { for (const [p, o] of OWNER) if (t.startsWith(p)) return o; return null; };
const nBy = {}, busBy = {};
for (const t of D.tools.rows ?? []) { const o = owner(t.t); if (o) nBy[o] = (nBy[o] ?? 0) + t.n; }
for (const [s, n] of D.bus.sources ?? []) busBy[s] = n;
const universe = [...new Set([...D.scan.familyDirs, ...Object.keys(byPlugin), ...Object.keys(nBy), ...Object.keys(busBy)])]
  .filter((p) => p.startsWith('agint-'));
const zeroRows = universe.filter((pl) => !(nBy[pl] > 0) && !(busBy[pl] > 0));
const EXEMPT = { container: '聚合容器', library: '纯函数库', 'tool-only': '纯工具', sdk: '服务库', unmounted: '未挂载', checker: '静态检查器' };
const exemptZ = zeroRows.filter((p) => EXEMPT[D.pluginKinds[p]?.kind]);
const realZ = zeroRows.filter((p) => !EXEMPT[D.pluginKinds[p]?.kind]);

// ── 断言：这些是 2026-10-04 修完后的目标状态 ──

// ① 嵌套插件的提供方必须被认出（此前 agint.qualityEvaluator / qualityPolicy 被误报「无提供方」）
assert.equal(D.scan.provided['agint.qualityEvaluator'], 'agint-quality-eval', 'qualityEvaluator 提供方未认出（嵌套扫描失效？）');
assert.equal(D.scan.provided['agint.qualityPolicy'], 'agint-quality-policy', 'qualityPolicy 提供方未认出');

// ② 无提供方必须为空（家族键全部有提供方）
assert.deepEqual(Object.keys(npBySvc), [], `仍有家族键无提供方：${Object.keys(npBySvc).join(',')}`);

// ③ 文档腐化 = 已知悬空声明集合（2026-10-05 冻结）。
//    并 optionalInject 口径后新暴露的 5 条是**真实契约缺口**，不是误报：
//    逐条 grep 过对应插件 lib/，声明的服务代码里从不取用（详见每条后面括注）。
//    处理方案（删声明 / 补接线）待老板拍；先冻结成期望值——**新增一条就变红**。
const KNOWN_STALE_DECL = {
  'agint-event-bus': ['agint.memory'], // 只 provide 不消费 memory
  'agint-input-gateway': ['agint.memory'], // 网关只发事件，未接 memory
  'agint-mount': ['agint.population.ingest'], // 声明了 ingest 上报，代码无 population 引用
  'agint-population': ['agint.diagnosis', 'agint.memory', 'agint.qualitySandbox'], // 文档写「软依赖 6 个」，实取 3 个
  'agint-skill-graph': ['agint.skillAutocreate'], // 走 skill-autocreate.* 事件，不取其服务
};
const asMap = (rows) => Object.fromEntries(rows.map((r) => [r.pl, [...r.missing].sort()]));
const expectedStale = Object.fromEntries(Object.entries(KNOWN_STALE_DECL).map(([k, v]) => [k, [...v].sort()]));
assert.deepEqual(asMap(rotted), expectedStale,
  `文档腐化集合漂移：实测 ${JSON.stringify(asMap(rotted))} / 冻结 ${JSON.stringify(expectedStale)}`);

// ④ quality-static（checker）不得出现在「从未接线」里——它 code 边为 0 是职责
assert.ok(!neverWired.some((x) => x.pl === 'agint-quality-static'),
  'quality-static 是 checker（扫别的插件源码里的 token），被误判「从未接线」');
// evolution-driver 曾因 dep() 间接形态被误判，现在 9 条 code 边
assert.ok((byPlugin['agint-evolution-driver']?.code.size ?? 0) >= 9,
  `evolution-driver code 边应≥9（dep() 间接形态未识别），实际 ${byPlugin['agint-evolution-driver']?.code.size ?? 0}`);
// 「从未接线」总数必须收敛（修前 14 行噪音）
assert.ok(neverWired.length <= 3, `「从未接线」行数 ${neverWired.length} 偏多，判据可能又松了`);

// ⑤ 僵尸候选：六个已知容器/工具/库/面板/SDK 必须全部落在形态豁免内，一个都不许被当死代码
for (const p of ['agint-family-panel', 'agint-quality', 'agint-quality-report',
  'agint-quality-sdk', 'agint-search-tools', 'agint-session-extract']) {
  assert.ok(exemptZ.includes(p), `${p} 未被形态豁免（kind=${D.pluginKinds[p]?.kind}）—— 禁止把容器/工具/库/面板/SDK 当僵尸`);
  assert.ok(!realZ.includes(p), `${p} 被列为真僵尸候选—— 这是误报`);
}
assert.ok(exemptZ.length >= 7, `形态豁免数 ${exemptZ.length} 偏少`);

// ⑥ repoDirs 在部署位不可得时必须照实降级，且给出可执行修法（不猜）
assert.ok(Array.isArray(D.repoDirs) || (D.repoDirs && typeof D.repoDirs.reason === 'string' && D.repoDirs.reason.length > 0),
  'repoDirs 既不是数组也没给 reason');

// ── 报告 ──
console.log('Q3 判定真实数据回放（部署位 + 生产三源）：');
console.log(`  从未接线 ${neverWired.length} 行：${neverWired.map((x) => x.pl + '/' + x.why).join('、') || '无'}`);
console.log(`  无提供方 ${Object.keys(npBySvc).length} 行 / 文档腐化 ${rotted.length} 行`);
console.log(`  manifest 漏写 ${undeclared.length} 个：${undeclared.join('、') || '无'}`);
console.log(`  僵尸：三源全零 ${zeroRows.length}，形态豁免 ${exemptZ.length}，真候选 ${realZ.length}${realZ.length ? '：' + realZ.join('、') : ''}`);
console.log(`  repoDirs：${Array.isArray(D.repoDirs) ? D.repoDirs.length + ' 个目录' : '降级 — ' + D.repoDirs.reason}`);

// ─────────────────────────────────────────────────────────────────────────────
// 契约类断言必须在**仓库位**再跑一遍。
//
// ⛔ 为什么：部署位的 manifest 要等同步才有consumes。上面那段跑在部署位上，
//   「文档腐化 = 0」这类断言在**未同步**时会空转（manifest 里没有 consumes ⇒
//   没有声明可比），于是「把身份规则改坏」也照样绿 —— 2026-10-04 实测：
//   身份规则退化成「顶层名占位」时，本文件全部断言仍 PASS，只有 v2-data-v03 变红。
//   验收跑在没同步的副本上 = 验收了个寂寞（K47.7）。
//
// 仓库位口径用同一套判据，要求「漏写 = 0 且悬空声明 = KNOWN_STALE_DECL 冻结集合」。
// ─────────────────────────────────────────────────────────────────────────────
const REPO_PLUGINS = resolve(REPO_ROOT, 'plugins');
if (existsSync(REPO_PLUGINS)) {
  const R = collectV2Data(
    { pluginsDir: REPO_PLUGINS, storagesDir: STORAGES, repoPluginsDir: REPO_PLUGINS, repoPluginsSource: 'self-path' },
    { force: true, cache: new Map() },
  );
  const rBy = {};
  for (const [pl, , , svc, kind] of R.scan.hits) {
    (rBy[pl] ??= { code: new Set(), comment: new Set(), umbrella: new Set() });
    rBy[pl][kind].add(svc);
  }
  const rUndeclared = Object.entries(rBy).filter(([pl, g]) => !R.manifestConsumes[pl] && g.code.size >= 5).map(([pl]) => pl);
  assert.deepEqual(rUndeclared, [], `仓库位 manifest 漏写：${rUndeclared.join(',')}（契约未跟上代码）`);
  const rRot = [];
  for (const [pl, decl] of Object.entries(R.manifestConsumes)) {
    const g = rBy[pl];
    if (!g) continue;
    const all = [...g.code, ...g.comment, ...g.umbrella];
    const miss = decl.filter((s) => !all.some((k) => k === s || k.startsWith(`${s}.`) || s.startsWith(`${k}.`)));
    if (miss.length) rRot.push({ pl, missing: miss });
  }
  assert.deepEqual(asMap(rRot), expectedStale,
    `仓库位文档腐化集合漂移：实测 ${JSON.stringify(asMap(rRot))}（声明了但同族代码无对应调用）`);
  console.log(`仓库位口径：声明消费覆盖 ${Object.keys(R.manifestConsumes).length} 个插件，漏写 0 / 悬空声明 ${Object.keys(expectedStale).length} 个插件（与部署位同一冻结集合）✓`);
} else {
  console.log('仓库位口径：跳过（未找到仓库 plugins/，契约类断言未在仓库位复核）');
}

console.log('q3-verdicts.test.mjs PASS');