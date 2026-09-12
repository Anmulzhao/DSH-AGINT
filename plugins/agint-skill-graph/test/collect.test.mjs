// 取数层测试（§3.3 主口径 + §2.1 R8 节点全集）。
// 覆盖设计稿 §九 验收项：「主口径正确性」与「零数据诚实」的取数侧。

import test from 'node:test';
import assert from 'node:assert/strict';

import { scanNodes, collectSkillCalls, aggregateUsage, readJsonl } from '../lib/collect.js';
import { makePresetsDir, makeStatsJsonl, rec, cleanup } from './_helpers.mjs';

const NOW = Date.parse('2026-09-13T00:00:00Z');
const DAY = 86_400_000;

test('主口径：tool==="skill" 取 args.name，其余记录进 skippedNoSkillField', () => {
  const records = [
    rec(NOW - DAY, 'skill', { name: 'alpha' }),
    rec(NOW - DAY, 'skill', { name: 'alpha' }),
    rec(NOW - DAY, 'skill', { name: 'beta' }),
    rec(NOW - DAY, 'pwsh', { command: 'ls' }),
    rec(NOW - DAY, 'bash', { command: 'ls' }),
  ];
  const { calls, skippedNoSkillField, total } = collectSkillCalls(records, {
    lookbackDays: 30, nowMs: NOW, knownNames: new Set(['alpha', 'beta']),
  });
  assert.equal(total, 5);
  assert.equal(calls.length, 3);
  assert.equal(skippedNoSkillField, 2);
  assert.deepEqual(calls.map((c) => c.skillName).sort(), ['alpha', 'alpha', 'beta']);
});

test('守恒式：total = calls + skippedNoSkillField + unknownSkillName + 被排除/窗口外', () => {
  const records = [
    rec(NOW - DAY, 'skill', { name: 'alpha' }),           // calls
    rec(NOW - DAY, 'skill', { name: 'ghost' }),            // unknownSkillName
    rec(NOW - DAY, 'skill', {}),                           // 名字缺失 → skipped
    rec(NOW - DAY, 'pwsh', {}),                            // skipped
    rec(NOW - 999 * DAY, 'skill', { name: 'alpha' }),      // 窗口外 → 丢弃
    rec(NOW - DAY, 'skill', { name: 'alpha' }, { sessionId: 'curriculum-1' }), // 黑名单 → 丢弃
  ];
  const r = collectSkillCalls(records, { lookbackDays: 30, nowMs: NOW, knownNames: new Set(['alpha']) });
  assert.equal(r.calls.length, 1);
  assert.equal(r.unknownSkillName, 1);
  assert.equal(r.skippedNoSkillField, 2);
  // 6 条总记录 = 1 采用 + 1 unknown + 2 skipped + 2（窗口外 + 黑名单）
  assert.equal(r.calls.length + r.unknownSkillName + r.skippedNoSkillField + 2, r.total);
});

test('复用 curator 黑名单：curriculum- 前缀整条丢弃（不新写第 4 份过滤逻辑）', () => {
  const records = [
    rec(NOW - DAY, 'skill', { name: 'alpha' }, { sessionId: 'curriculum-weekly-1' }),
    rec(NOW - DAY, 'skill', { name: 'alpha' }, { sessionId: 'session-abc' }),
  ];
  const r = collectSkillCalls(records, { lookbackDays: 30, nowMs: NOW, knownNames: new Set(['alpha']) });
  assert.equal(r.calls.length, 1);
  assert.equal(r.skippedNoSkillField, 0);
});

test('window 过滤容忍轻微时钟漂移，但超 lookback 即丢', () => {
  const records = [
    rec(NOW + 1000, 'skill', { name: 'alpha' }),        // 未来 1s（容忍）
    rec(NOW - 31 * DAY, 'skill', { name: 'alpha' }),    // 超 30 天窗口
  ];
  const r = collectSkillCalls(records, { lookbackDays: 30, nowMs: NOW, knownNames: new Set(['alpha']) });
  assert.equal(r.calls.length, 1);
});

test('扫描节点全集：3 预设同名技能去重为 1 个节点，presets 与 relatedSkills 取并集', async () => {
  const dir = makePresetsDir({
    p1: [{ name: 'alpha', description: 'a', triggers: ['t1'], tools: ['echo'], related_skills: ['beta'] },
      { name: 'beta', description: 'b' }],
    p2: [{ name: 'alpha', description: 'a', triggers: ['t2'], tools: ['ls'], related_skills: ['gamma'] },
      { name: 'gamma', description: 'g' }],
    p3: [{ name: 'alpha', description: 'a' }],
  });
  try {
    const { nodes, scanFailures } = await scanNodes(dir);
    assert.equal(scanFailures, 0);
    assert.deepEqual(nodes.map((n) => n.skillName), ['alpha', 'beta', 'gamma']);
    const alpha = nodes.find((n) => n.skillName === 'alpha');
    assert.deepEqual(alpha.presets, ['p1', 'p2', 'p3']);
    assert.deepEqual([...alpha.triggers].sort(), ['t1', 't2']);
    assert.deepEqual([...alpha.tools].sort(), ['echo', 'ls']);
    assert.deepEqual([...alpha.relatedSkills].sort(), ['beta', 'gamma']);
    // 声明溯源：三份 SKILL.md 都是声明来源，各自记一份（related 边的 declaredIn 指向具体文件）
    assert.equal(Object.keys(alpha.declarations).length, 3);
    const declared = Object.values(alpha.declarations).flat();
    assert.deepEqual([...declared].sort(), ['beta', 'gamma']);
  } finally { cleanup(dir); }
});

test('扫描：presets 目录不存在 → 空数组且不抛（fail-open）', async () => {
  const { nodes, scanFailures } = await scanNodes('D:/definitely/not/here/__nope__');
  assert.deepEqual(nodes, []);
  assert.equal(scanFailures, 0);
});

test('扫描：SKILL.md 不可读 → 计入 scanFailures（丢弃可观测）', async () => {
  const dir = makePresetsDir({ p1: [{ name: 'alpha' }] });
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(`${dir}/p1/skills/broken`, { recursive: true }); // 只有目录，没有 SKILL.md
    const { nodes, scanFailures } = await scanNodes(dir);
    assert.equal(nodes.length, 1);
    assert.equal(scanFailures, 1);
  } finally { cleanup(dir); }
});

test('聚合：calls/lastUsedAt/firstUsedAt 正确；successRate 与 view/patchCount 恒 null（不编造）', () => {
  const nodes = [{ skillName: 'alpha', dirName: 'alpha', presets: ['p1'] }];
  const calls = [
    { ts: NOW - 2 * DAY, sessionId: 's1', skillName: 'alpha', ok: true },
    { ts: NOW - DAY, sessionId: 's1', skillName: 'alpha', ok: false },
  ];
  const map = aggregateUsage(nodes, calls);
  const u = map.get('alpha');
  assert.equal(u.calls, 2);
  assert.equal(u.firstUsedAt, new Date(NOW - 2 * DAY).toISOString());
  assert.equal(u.lastUsedAt, new Date(NOW - DAY).toISOString());
  // §3.3：技能级成功率不可得是这类系统的固有属性（Hermes 同样没有）→ 恒 null
  assert.equal(u.successRate, null);
  assert.equal(u.viewCount, null);
  assert.equal(u.patchCount, null);
});

test('readJsonl：文件不存在 → 空数组不抛；坏行被跳过', async () => {
  assert.deepEqual(await readJsonl('D:/definitely/not/here/__nope__.jsonl'), []);
  const { writeFileSync } = await import('node:fs');
  const p = makeStatsJsonl([]);
  writeFileSync(p, '{"ok":1}\nNOT JSON\n{"ok":2}\n', 'utf8');
  try {
    const rows = await readJsonl(p);
    assert.equal(rows.length, 2);
  } finally { cleanup(p); }
});
