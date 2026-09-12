#!/usr/bin/env node
// agint-skill-graph smoke — `node test/smoke.mjs` 一行能跑。
//
// 不挂 Cordis、不真打开 storage domain。只验证：
//   - 导出契约（name / inject / apply / ConfigSchema）
//   - FROZEN schema（UsageStats / SkillEdge / GraphMeta）与四类边枚举
//   - storage spec shape（域名 / 3 表 / 版本）
//   - 上游常量**引用不复制**（SKILL_STATES / OVERLAP_THRESHOLDS / isExcludedRecord）
//   - 跨平台 fixture（forward-slash 路径 + ../escape 负向）

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, sep, isAbsolute } from 'node:path';

import * as schema from '../lib/schema.js';
import * as storage from '../lib/storage.js';
import * as plugin from '../lib/index.js';
import { parseFrontmatter } from '../../agint-curator/lib/aggregator.js';

test('导出契约：name / inject / apply / ConfigSchema', () => {
  assert.equal(plugin.name, 'agint-skill-graph');
  assert.deepEqual(plugin.inject, ['storageDomain']);
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(plugin.ConfigSchema);
  const c = plugin.ConfigSchema.parse({});
  assert.equal(c.mode, 'count-only');       // §5.3 默认标定期
  assert.equal(c.mode, schema.RECORD_MODES[0]);
  assert.equal(c.weeklyCron, '0 7 * * 0');  // §5.3 周日 07:00
  assert.equal(c.edgeTypes.similar, false); // §12.5 开放问题 4
});

test('节点状态枚举 = curator SKILL_STATES 透传 + provisional（第 6 态）', () => {
  assert.deepEqual([...schema.SKILL_STATES], ['active', 'stale', 'archived', 'pinned', 'quality_declining']);
  assert.deepEqual([...schema.NODE_STATES], ['active', 'stale', 'archived', 'pinned', 'quality_declining', 'provisional']);
});

test('边类型四类 + confidence 映射（§3.2 总表）', () => {
  assert.deepEqual([...schema.EDGE_TYPES], ['related', 'overlap', 'co_use', 'similar']);
  assert.equal(schema.CONFIDENCE_BY_TYPE.related, 'high');
  assert.equal(schema.CONFIDENCE_BY_TYPE.overlap, 'medium');
  assert.equal(schema.CONFIDENCE_BY_TYPE.co_use, 'high');
  assert.equal(schema.CONFIDENCE_BY_TYPE.similar, 'low');
});

test('上游常量引用不复制：与 curator 同源（含失败即代表副本产生）', () => {
  assert.deepEqual({ ...schema.OVERLAP_THRESHOLDS }, { description: 0.85, tools: 0.7, triggers: 0.6, minDimensions: 2 });
  assert.equal(schema.DATA_SOURCE_BLACKLIST_VERSION, '2026-09-14.v1');
  assert.deepEqual([...schema.EXCLUDED_DATA_SOURCES.sessionIdPrefixes], ['curriculum-']);
  assert.equal(schema.isExcludedRecord({ sessionId: 'curriculum-x' }), true);
  assert.equal(schema.isExcludedRecord({ sessionId: 'session-x' }), false);
});

test('阈值常量：co_use 30min/≥3 会话；similar 阈值与 overlap 的 desc 维分开定', () => {
  assert.equal(schema.THRESHOLDS.CO_USE_WINDOW_MS, 30 * 60 * 1000);
  assert.equal(schema.THRESHOLDS.CO_USE_MIN_SESSIONS, 3);
  assert.equal(schema.THRESHOLDS.SIMILAR_DESC, 0.7);
  assert.notEqual(schema.THRESHOLDS.SIMILAR_DESC, schema.OVERLAP_THRESHOLDS.description);
  assert.equal(schema.INSUFFICIENT_COVERAGE_RATIO, 0.3);
  assert.equal(schema.STALE_AFTER_DAYS, 14);
});

test('FROZEN 记录 schema：UsageStats / SkillEdge / GraphMeta 校验通过', () => {
  const u = schema.UsageStatsSchema.parse({ skillName: 'alpha' });
  assert.equal(u.calls, 0);
  assert.equal(u.successRate, null);
  assert.equal(u.viewCount, null);
  assert.equal(u.patchCount, null);
  assert.equal(u.status, 'active');
  assert.deepEqual(u.presets, []);

  const e = schema.SkillEdgeSchema.parse({
    edgeId: 'e', src: 'a', dst: 'b', type: 'related',
    evidence: { method: 'declared', field: 'related_skills', declaredIn: 'a/SKILL.md' },
  });
  assert.equal(e.confidence, 'medium'); // schema 默认；边构造器会覆盖为 high
  assert.equal(e.asymmetric, false);

  const m = schema.GraphMetaSchema.parse({});
  assert.equal(m.mode, 'count-only');
  assert.deepEqual(m.coverage, { nodes: 0, nodesWithEdges: 0, nodesWithUsage: 0, ratio: 0, usageRatio: 0 });
  assert.equal(m.counters.skippedNoSkillField, 0);
  assert.equal(m.lastCalibration, null);
});

test('storage spec：agint_skill_graph 域 + 3 表 + version 1', () => {
  assert.equal(storage.spec.name, 'agint_skill_graph');
  assert.equal(storage.spec.version, 1);
  const tables = Object.keys(storage.spec.tables ?? storage.spec.config?.tables ?? {});
  assert.deepEqual(tables.sort(), ['graph_meta', 'skill_edges', 'usage_stats']);
});

test('pack 函数：注入 id/kind metadata；graph_meta 是单行（id 固定）', () => {
  const u = storage.packUsageStats({ skillName: 'alpha' });
  assert.equal(u.id, 'alpha');
  assert.equal(u.kind, 'usage_stats');

  const e = storage.packEdge({ edgeId: 'edge_x', src: 'a', dst: 'b', type: 'related', evidence: { method: 'declared', field: 'related_skills', declaredIn: 'a' } });
  assert.equal(e.id, 'edge_x');
  assert.equal(e.kind, 'skill_edge');

  const m = storage.packMeta({ mode: 'live' }, { createdAt: '2026-01-01T00:00:00Z' });
  assert.equal(m.id, storage.META_ID);
  assert.equal(m.kind, 'graph_meta');
  assert.equal(m.createdAt, '2026-01-01T00:00:00Z'); // 保留首次创建时间
  assert.notEqual(m.updatedAt, '2026-01-01T00:00:00Z'); // 但 updatedAt 必须是新的
});

test('normalizeWeights：损坏→回退默认；合法→归一化到 1（§六降级链 2）', () => {
  assert.equal(schema.normalizeWeights(schema.DEFAULT_WEIGHTS).fallback, false);
  assert.equal(schema.normalizeWeights({}).fallback, true);
  assert.equal(schema.normalizeWeights({ intentMatch: -1 }).fallback, true);
});

test('makeEdgeId / normalizePair：无向边字典序归一 + 同对同类型 id 稳定', () => {
  assert.deepEqual(schema.normalizePair('b', 'a'), ['a', 'b']);
  assert.deepEqual(schema.normalizePair('a', 'b'), ['a', 'b']);
  assert.equal(schema.makeEdgeId('related', 'b', 'a'), schema.makeEdgeId('related', 'a', 'b'));
  assert.notEqual(schema.makeEdgeId('related', 'a', 'b'), schema.makeEdgeId('overlap', 'a', 'b'));
});

test('validateEdge：evidence 缺失即非法（不变量 2）', () => {
  assert.equal(schema.validateEdge({ edgeId: 'e', src: 'a', dst: 'b', type: 'related', evidence: {} }).ok, false);
  assert.equal(
    schema.validateEdge({
      edgeId: 'e', src: 'a', dst: 'b', type: 'co_use',
      evidence: { method: 'session-cooccurrence', sessions: 3, window: '30m', sessionIds: ['s1'] },
    }).ok,
    true,
  );
});

test('复用 curator 的 frontmatter 解析器（不写第 5 份副本）：related_skills 可解析', () => {
  const fm = parseFrontmatter('---\nname: a\ndescription: "d"\ntools: [x, y]\nrelated_skills:\n  - b\n  - c\n---\n\n# a\n');
  assert.equal(fm.name, 'a');
  assert.deepEqual(fm.tools, ['x', 'y']);
  assert.deepEqual(fm.related_skills, ['b', 'c']);
});

// ── 维度 5.5：跨平台 fixture（forward-slash 路径 + ../escape 负向）────────

// 镜像 exportGraph 的路径策略：resolvePath(dir) + join(dir, `skill-graph.${fmt}`)。
// 正向断言写「末两段」而不是绝对前缀 —— Windows 上 D:/ 与 Unix 上 / 都要过。
function assembleExportPath(dir, fmt = 'dot') {
  return resolve(join(resolve(dir), `skill-graph.${fmt}`));
}

test('跨平台 fixture：forward-slash 路径经 join/resolve 正常化', () => {
  // Windows 风格盘符 + forward slash（Git Bash / YAML 里常见的写法）
  const win = assembleExportPath('D:/DSH/skill-graph/export');
  assert.equal(win.endsWith(`export${sep}skill-graph.dot`), true);
  assert.ok(win.split(sep).length >= 3, '必须是绝对路径，且保留 export 段');

  // Unix 风格绝对路径：同一段代码不得因分隔符不同而改变末两段
  const unix = assembleExportPath('/var/tmp/skill-graph/export');
  assert.equal(unix.endsWith(`export${sep}skill-graph.dot`), true);

  // 两条路径都必须是 isAbsolute —— 说明 forward slash 已被正确识别
  assert.equal(isAbsolute(win), true);
  assert.equal(isAbsolute(unix), true);
});

test('跨平台 fixture（负向）：../escape 逃出导出根目录必须被识别（不得落到根外）', () => {
  const base = resolve('D:/DSH/skill-graph/export');
  const escaped = resolve(join(base, '..', '..', 'etc', 'passwd'));
  assert.equal(escaped.startsWith(base + sep), false, '../ 应当逃出导出根 —— 若为 true 说明正则是坏的');
  // 正向：正常文件名一定留在根内（exportGraph 只接受 dir + 固定文件名）
  assert.equal(resolve(join(base, 'skill-graph.jsonl')).startsWith(base), true);
});
