// 契约测试：§4.3 不变量 + §九「订阅契约核验」+ K19/K20 schema 护栏 + 端到端（count-only → live）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

import * as plugin from '../lib/index.js';
import * as schema from '../lib/schema.js';
import * as storage from '../lib/storage.js';
import { makePresetsDir, makeStatsJsonl, mockCtx, fakeEventBus, rec, cleanup } from './_helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, '..');
const PLUGINS_ROOT = join(PLUGIN_DIR, '..');
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-13T00:00:00Z');

/** 设计稿 §5.1 明确标注「P2-1 v0.2 设计，源码尚未落地」的 topic —— 不算违规，但必须显式登记 */
const PENDING_TOPICS = new Set(['trajectory.recorded']);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(m?js|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 把注释与字符串字面量掩码成等长空格（保留换行）——与仓库级 K19 护栏同法。
 * 少了这一步，注释里写的反例（如"不要写 required: false"）会被误判成违例。
 */
function maskCode(src) {
  let out = '';
  let state = 'code';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    const blank = () => { out += c === '\n' ? '\n' : ' '; i++; };
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += ' '; i++; continue; }
      if (c === '"') { state = 'dq'; out += ' '; i++; continue; }
      if (c === '`') { state = 'tpl'; out += ' '; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') { blank(); if (c === '\n') state = 'code'; continue; }
    if (state === 'block') {
      out += c === '\n' ? '\n' : ' ';
      if (c === '*' && n === '/') { out += ' '; i += 2; state = 'code'; continue; }
      i++; continue;
    }
    if (c === '\\') { out += '  '; i += 2; continue; }
    out += c === '\n' ? '\n' : ' ';
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) state = 'code';
    i++;
  }
  return out;
}

function subscribedTopics() {
  const src = readFileSync(join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');
  const inTopicsArray = [...src.matchAll(/^\s*'([a-z][a-z0-9-]*\.[a-z0-9-]+)',\s*$/gm)].map((m) => m[1]);
  const inStatusMap = [...src.matchAll(/'(curator\.[a-z-]+)':\s*'/g)].map((m) => m[1]);
  return [...new Set([...inTopicsArray, ...inStatusMap])];
}

test('§九 订阅契约核验：每个订阅的 topic 都能在**发布方**源码里 grep 命中（或显式登记为未落地）', () => {
  const topics = subscribedTopics();
  assert.ok(topics.length >= 10, `只解析出 ${topics.length} 个 topic，解析逻辑可能坏了: ${topics.join(',')}`);

  const otherSources = walk(PLUGINS_ROOT)
    .filter((p) => !p.startsWith(PLUGIN_DIR + sep))
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n');

  const missing = [];
  for (const t of topics) {
    if (PENDING_TOPICS.has(t)) continue;
    if (!otherSources.includes(t)) missing.push(t);
  }
  assert.deepEqual(missing, [],
    `以下订阅 topic 在任何发布方源码里都找不到（K30：订阅前先 grep 事件名）:\n  ${missing.join('\n  ')}`);

  // PENDING 清单不能腐烂：登记项必须仍在订阅列表里
  for (const t of PENDING_TOPICS) assert.ok(topics.includes(t), `PENDING_TOPICS 里的 ${t} 已不在订阅列表，请清理`);
});

test('§九：本插件发布的事件（skill-graph.updated）在自身源码中确实 publish', () => {
  const src = readFileSync(join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');
  assert.ok(src.includes("publishEvent('skill-graph.updated'"), 'skill-graph.updated 未发布');
  // §2.2：不新建冗余事件 —— v0.1 计划的 skill-graph.consolidate-proposed 已删除
  assert.equal(src.includes('skill-graph.consolidate-proposed'), false);
});

test('§4.3 不变量 3/4：对上游只读（不调用 curator 任何写方法；不触碰 policy/HARM/evolution 决策）', () => {
  const src = readFileSync(join(PLUGIN_DIR, 'lib', 'index.js'), 'utf8');
  for (const forbidden of ['curator.pin', 'curator.unpin', 'curator.archive', 'curator.unarchive', 'curator.run(']) {
    assert.equal(src.includes(forbidden), false, `出现上游写调用：${forbidden}`);
  }
  for (const forbidden of ['qualityPolicy', 'qualityEvaluator', 'mutator', 'population', 'harmWeights']) {
    assert.equal(src.includes(forbidden), false, `图谱不得进入决策路径：${forbidden}`);
  }
  // 唯一允许的跨插件写，是"提交提案"（只建议不执行）
  assert.ok(src.includes('agint.evolve'), 'proposeConsolidate 应走 evolve 提案通道');
  assert.ok(src.includes('proposeConsolidate'), 'proposeConsolidate 必须存在');
});

test('§4.3 不变量 5：主键恒为 skillName（无第二套 ID 空间）', () => {
  const files = [join(PLUGIN_DIR, 'lib', 'schema.js'), join(PLUGIN_DIR, 'lib', 'index.js'), join(PLUGIN_DIR, 'lib', 'query.js')];
  for (const f of files) {
    const code = maskCode(readFileSync(f, 'utf8'));
    assert.equal(/\bskillId\b/.test(code), false, `${relative(PLUGIN_DIR, f)} 不得引入 skillId（curator 与全库都不存在这个 ID）`);
  }
  const schemaCode = maskCode(readFileSync(files[0], 'utf8'));
  assert.ok(schemaCode.includes('skillName'), 'skillName 必须是主键');
});

test('K19/K20 护栏：本插件 lib 下每个 type:"object" 都声明 additionalProperties，且无 required:false', () => {
  const files = walk(join(PLUGIN_DIR, 'lib'));
  assert.ok(files.length >= 6, `lib 下只找到 ${files.length} 个源文件`);
  const bad = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const masked = maskCode(src);
    const re = /type\s*:\s*['"]object['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      // 掩码后连 type 关键字都没了 = 位于注释/字符串里，不是 schema
      if (masked.slice(m.index, m.index + 4) !== 'type') continue;
      let start = -1;
      for (let i = m.index; i >= 0; i--) {
        if (masked[i] === '}') break;
        if (masked[i] === '{') { start = i; break; }
      }
      if (start < 0) continue;
      let depth = 0; let end = -1;
      for (let i = start; i < masked.length; i++) {
        if (masked[i] === '{') depth++;
        else if (masked[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      const body = src.slice(start, end + 1);
      if (!/\badditionalProperties\s*:/.test(body)) bad.push(`${relative(PLUGIN_DIR, f)}: 缺 additionalProperties`);
    }
    if (/required\s*:\s*false/.test(masked)) bad.push(`${relative(PLUGIN_DIR, f)}: 出现 required:false`);
  }
  assert.deepEqual(bad, []);
});

test('storage spec：agint_skill_graph 域 + 3 表 + version 1', () => {
  assert.equal(storage.spec.name, 'agint_skill_graph');
  assert.equal(storage.spec.version, 1);
  const tables = Object.keys(storage.spec.tables ?? storage.spec.config?.tables ?? {});
  assert.deepEqual(tables.sort(), ['graph_meta', 'skill_edges', 'usage_stats']);
  assert.equal(schema.DOMAIN_NAME, 'agint_skill_graph');
  assert.equal(schema.SCHEMA_VERSION, 1);
});

test('导出契约：name / inject / apply / ConfigSchema', async () => {
  assert.equal(plugin.name, 'agint-skill-graph');
  assert.deepEqual(plugin.inject, ['storageDomain']);
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(plugin.ConfigSchema);
  const c = plugin.ConfigSchema.parse({});
  assert.equal(c.mode, 'count-only');                              // §5.3 默认标定期
  assert.equal(c.edgeTypes.similar, false);                        // §12.5 开放问题 4：默认关
  assert.equal(c.edgeTypes.related, true);
  assert.equal(c.recommendMode, 'list');                           // §六 主方案
  assert.equal(c.weeklyCron, '0 7 * * 0');
  assert.equal(c.coUseMinSessions, 3);
  assert.deepEqual({ ...c.recommendWeights }, { ...schema.DEFAULT_WEIGHTS });
});

// ── 端到端：count-only 标定期 → 切 live ────────────────────────────────

function setup({ mode = 'count-only' } = {}) {
  const presetsDir = makePresetsDir({
    p1: [
      { name: 'alpha', description: 'github push flow', triggers: ['github'], tools: ['bash'], related_skills: ['beta'] },
      { name: 'beta', description: 'git commit', triggers: ['git'], tools: ['bash'] },
      { name: 'gamma', description: 'memory notes' },
    ],
  });
  const toolStatsPath = makeStatsJsonl([
    rec(NOW - DAY, 'skill', { name: 'alpha' }, { sessionId: 's1' }),
    rec(NOW - DAY, 'skill', { name: 'beta' }, { sessionId: 's1' }),
    rec(NOW - DAY, 'pwsh', { command: 'ls' }),
  ]);
  const bus = fakeEventBus();
  const ctx = mockCtx({ 'agint.eventBus.subscribe': bus.subscribe, 'agint.eventBus.publish': bus.publish });
  plugin.apply(ctx, { presetsDir, toolStatsPath, mode });
  return { svc: ctx._provided['agint.skillGraph'], ctx, bus, presetsDir, toolStatsPath };
}

test('e2e-1 标定期：count-only 只写 meta（正式数据表 0 行），但标定报告给出"若转 live 会得到什么"', async () => {
  const { svc, ctx, presetsDir, toolStatsPath } = setup();
  try {
    const r = await svc.updateFull({ nowMs: NOW, trigger: 'test' });
    assert.equal(r.mode, 'count-only');
    assert.equal(r.nodes, 3);
    assert.equal(r.edgesByType.related, 1);      // alpha↔beta 的声明边
    assert.equal(r.calibration.nodes, 3);
    assert.equal(r.calibration.edges, 1);
    assert.equal(r.calibration.promotable, true);
    // 正式表必须是空的（只扫不落）
    assert.equal(ctx._domain.table('usage_stats').entries().length, 0);
    assert.equal(ctx._domain.table('skill_edges').entries().length, 0);
    // meta 里有标定报告
    const cov = await svc.getCoverage();
    assert.equal(cov.mode, 'count-only');
    assert.equal(cov.lastCalibration.edges, 1);
    assert.equal(cov.health, 'EMPTY');           // 标定期图确实是空的 → 必须显式 EMPTY
    assert.ok(cov.counters.skippedNoSkillField >= 1);
  } finally { cleanup(presetsDir, toolStatsPath); }
});

test('e2e-2 切 live：related 边与 usage_stats 落盘，health/coverage 转为真实值', async () => {
  const { svc, ctx, presetsDir, toolStatsPath } = setup();
  try {
    await assert.rejects(() => svc.setMode('live'), /标定期/); // §5.3：没跑过标定期就切 → 抛错
    await svc.updateFull({ nowMs: NOW });
    await svc.setMode('live');
    const r = await svc.updateFull({ nowMs: NOW });
    assert.equal(r.mode, 'live');
    assert.equal(r.edgesAdded, 1);

    const edges = ctx._domain.table('skill_edges').entries().map(([, v]) => v);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].type, 'related');
    assert.equal(edges[0].confidence, 'high');
    assert.equal(edges[0].kind, 'skill_edge');

    const usage = ctx._domain.table('usage_stats').entries().map(([, v]) => v);
    assert.equal(usage.length, 3);
    const alpha = usage.find((u) => u.skillName === 'alpha');
    assert.equal(alpha.calls, 1);                // 主口径：那条 tool==='skill' 的记录
    assert.equal(alpha.successRate, null);       // 不编造
    assert.equal(alpha.viewCount, null);

    const r2 = await svc.updateFull({ nowMs: NOW });
    assert.equal(r2.edgesAdded, 0);              // 幂等：重跑不再新增
    assert.equal(r2.edgesRemoved, 0);

    const cov = await svc.getCoverage();
    assert.equal(cov.edges, 1);
    assert.equal(cov.health, 'OK');              // 1 条边 / 3 节点 = 0.667 ≥ 0.3
    assert.equal(cov.signature.nodesWithEdges, 2);

    // M4：neighbors / clusters 可用且带证据
    const nb = await svc.neighbors('beta');
    assert.equal(nb.length, 1);
    assert.equal(nb[0].evidence.method, 'declared');
    const cs = await svc.clusters({ type: 'related' });
    assert.equal(cs.length, 1);
    assert.deepEqual(cs[0].members, ['alpha', 'beta']);
  } finally { cleanup(presetsDir, toolStatsPath); }
});

test('e2e-3 事件链路：curator.overlap-detected → overlap 边；状态事件 → 节点 status 同步', async () => {
  const { svc, ctx, bus, presetsDir, toolStatsPath } = setup({ mode: 'live' });
  try {
    await svc.updateFull({ nowMs: NOW });
    await bus.emit('curator.overlap-detected', {
      skillA: 'alpha', skillB: 'beta',
      similarity: { desc: 0.9, tools: 1, triggers: 0.1, descHit: true, toolsHit: true, triggersHit: false, dimsMet: 2 },
    });
    let edges = ctx._domain.table('skill_edges').entries().map(([, v]) => v);
    assert.equal(edges.filter((e) => e.type === 'overlap').length, 1);
    assert.equal(edges.find((e) => e.type === 'overlap').evidence.dimsMet, undefined);
    assert.equal(edges.find((e) => e.type === 'overlap').evidence.similarity.dimsMet, 2);

    // 同一对再报一次 consolidate-proposed → 边上打 reviewSuggested（不新建同名事件）
    await bus.emit('curator.consolidate-proposed', { skillA: 'alpha', skillB: 'beta', recommendation: '考虑整合' });
    edges = ctx._domain.table('skill_edges').entries().map(([, v]) => v);
    assert.equal(edges.find((e) => e.type === 'overlap').evidence.reviewSuggested, true);

    // 生命周期事件 → status 同步（先落盘行再改）
    const row = ctx._domain.table('usage_stats').entries().find(([, v]) => v.skillName === 'beta');
    assert.equal(row[1].status, 'active');
    await bus.emit('curator.skill-archived', { skillName: 'beta' });
    const after = ctx._domain.table('usage_stats').entries().find(([, v]) => v.skillName === 'beta');
    assert.equal(after[1].status, 'archived');

    // 发出去的事件也要能看到
    assert.ok(bus._published.some((e) => e.topic === 'skill-graph.updated'));
    assert.equal(bus._published.find((e) => e.topic === 'skill-graph.updated').source, 'agint-skill-graph');
  } finally { cleanup(presetsDir, toolStatsPath); }
});

test('fail-open（不变量 1）：domain 打不开时 updateFull 不 throw，各 Service 返回空而降级', async () => {
  const presetsDir = makePresetsDir({ p1: [{ name: 'alpha' }] });
  const ctx = mockCtx({}, { openFails: true });
  plugin.apply(ctx, { presetsDir, mode: 'count-only' });
  const svc = ctx._provided['agint.skillGraph'];
  try {
    const r = await svc.updateFull({ nowMs: NOW });     // 不 throw
    assert.equal(r.nodes, 0);
    assert.ok(r.error);
    assert.deepEqual(await svc.neighbors('alpha', {}), []);
    assert.deepEqual(await svc.clusters({}), []);
    assert.equal(await svc.getStats('alpha'), null);
    const rec2 = await svc.recommend({ intent: 'x' });
    assert.equal(rec2.status, 'INSUFFICIENT_DATA');
    const cov = await svc.getCoverage();
    assert.equal(cov.health, 'EMPTY');
    await svc.exportGraph;   // 存在性（不在本用例触发落盘）
  } finally { cleanup(presetsDir); }
});

test('标定期切档护栏：count-only 下 overlap 事件进缓冲，不落正式图（可观测）', async () => {
  const bus = fakeEventBus();
  const presetsDir = makePresetsDir({ p1: [{ name: 'alpha' }, { name: 'beta' }] });
  const ctx = mockCtx({ 'agint.eventBus.subscribe': bus.subscribe, 'agint.eventBus.publish': bus.publish });
  plugin.apply(ctx, { presetsDir, mode: 'count-only' });
  const svc = ctx._provided['agint.skillGraph'];
  try {
    await svc.updateFull({ nowMs: NOW });
    await bus.emit('curator.overlap-detected', {
      skillA: 'alpha', skillB: 'beta', similarity: { dimsMet: 2, desc: 0.9, tools: 1, triggers: 0, descHit: true, toolsHit: true, triggersHit: false },
    });
    assert.equal(ctx._domain.table('skill_edges').entries().length, 0);
    // 但下次标定会把它算进"若转 live 会得到多少条边"
    const r = await svc.updateFull({ nowMs: NOW });
    assert.equal(r.edgesByType.overlap, 1);
    assert.equal(r.calibration.edgesByType.overlap, 1);
  } finally { cleanup(presetsDir); }
});

test('导出：exportGraph 落 runtime 目录（DOT/JSONL），路径经 path.join 组装', async () => {
  const { svc, presetsDir, toolStatsPath } = setup({ mode: 'live' });
  const outDir = join(presetsDir, '..', `skillgraph-export-${Date.now()}`);
  try {
    await svc.updateFull({ nowMs: NOW });
    const dot = await svc.exportGraph({ format: 'dot', dir: outDir });
    assert.equal(dot.format, 'dot');
    assert.ok(readFileSync(dot.path, 'utf8').includes('digraph skill_graph'));
    assert.ok(statSync(dot.path).size > 0);
    const jsonl = await svc.exportGraph({ format: 'jsonl', dir: outDir });
    assert.ok(readFileSync(jsonl.path, 'utf8').includes('"type":"related"'));
  } finally { cleanup(presetsDir, toolStatsPath, outDir); }
});

test('e2e-4（§七 T8）整合链路：簇 → proposeConsolidate → 走 agint.evolve.propose（只建议不执行）', async () => {
  const calls = [];
  const evolve = {
    propose: async (arg) => { calls.push(arg); return { id: 'prop_test_1' }; },
  };
  const bus = fakeEventBus();
  const presetsDir = makePresetsDir({
    p1: [
      { name: 'alpha', related_skills: ['beta'] },
      { name: 'beta' },
    ],
  });
  const ctx = mockCtx({
    'agint.eventBus.subscribe': bus.subscribe,
    'agint.eventBus.publish': bus.publish,
    'agint.evolve': evolve,
  });
  plugin.apply(ctx, { presetsDir, mode: 'live' });
  const svc = ctx._provided['agint.skillGraph'];
  try {
    await svc.updateFull({ nowMs: NOW });

    // ① 簇可查（related 边把 alpha/beta 连成连通分量）
    const groups = await svc.clusters({ types: ['related', 'overlap'], minSize: 2 });
    const hit = groups.find((g) => g.members.join(',') === 'alpha,beta');
    assert.ok(hit, 'alpha/beta 应构成一个簇');
    assert.ok(hit.evidence.length >= 1, '簇必须带证据（M4）');

    // ② 提案走 evolve 通道，参数可审计
    const r = await svc.proposeConsolidate(hit.clusterId);
    assert.equal(r.proposalId, 'prop_test_1');
    assert.equal(r.clusterId, hit.clusterId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].category, 'skill');
    assert.equal(calls[0].source, 'agint-skill-graph');
    assert.match(calls[0].title, /alpha/);
    assert.match(calls[0].body, /证据/, '提案正文必须带上边证据');
    assert.match(calls[0].body, /不.*执行|只.*建议/, '必须声明"只建议不执行"');

    // ③ 未知 clusterId → 显式抛错（不静默）
    await assert.rejects(() => svc.proposeConsolidate('cluster_nope'), /cluster not found/);
  } finally { cleanup(presetsDir); }
});

test('e2e-4 负向：agint.evolve 未挂载 → proposeConsolidate 显式抛错（不变量：绝不静默）', async () => {
  const presetsDir = makePresetsDir({ p1: [{ name: 'alpha', related_skills: ['beta'] }, { name: 'beta' }] });
  const ctx = mockCtx({});
  plugin.apply(ctx, { presetsDir, mode: 'live' });
  const svc = ctx._provided['agint.skillGraph'];
  try {
    await svc.updateFull({ nowMs: NOW });
    // 与 proposeConsolidate 内部同参（types: ['related','overlap']）——
    // clusterId 由 types 参与生成，不同参数会得到不同 id（本次测试自己踩的坑）
    const groups = await svc.clusters({ types: ['related', 'overlap'], minSize: 2 });
    assert.equal(groups.length, 1);
    await assert.rejects(() => svc.proposeConsolidate(groups[0].clusterId), /not available/);
  } finally { cleanup(presetsDir); }
});
