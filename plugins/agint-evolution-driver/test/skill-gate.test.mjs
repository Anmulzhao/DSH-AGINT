/**
 * agint-evolution-driver: skill-gate.js（Phase 1.1 支点 1b / R2 技能门禁集）
 *
 * 盯的是三条判据，不是实现：
 *   ① 只有 `addedBy:'boss'` + UTC 毫秒 `approvedAt` 的 case 进分母（裁判不能是选手）；
 *   ② 未签核 / 0 条已签核 ⇒ `passRate: null` ⇒ 上层记 NO_EVIDENCE（⛔ 不是 0 分）；
 *   ③ case 形状不合法或正则坏 ⇒ **仪器故障**（ok:false），不许被读成"技能不合格"。
 * 另加一条等价性锁：本文件自带的 frontmatter 解析器必须与
 * `agint-quality-static/lib/checkers/skill-format.js` 对"四个必填字段齐不齐"给出同一答案。
 *
 * Run: node --test plugins/agint-evolution-driver/test/skill-gate.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GATE_KINDS, GATE_APPROVER,
  parseSkillFrontmatter, validateCase, splitCases, evalCase, runSkillGate, createSkillGateRunner,
} from '../lib/skill-gate.js';
import { checkSkillFormat } from '../../agint-quality-static/lib/checkers/skill-format.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKILL_DIR = join(REPO, 'presets', 'agint', 'skills');
const STAMP = '2026-10-03T09:00:00.000Z';

const boss = (o) => ({ addedBy: GATE_APPROVER, approvedAt: STAMP, ...o });
const agent = (o) => ({ addedBy: 'agent', approvedAt: null, ...o });
const yes = () => true;

// ── 1. 已签核才算数 ───────────────────────────────────────────────────────

test('G1: 只有 boss 签核（addedBy + UTC 毫秒 approvedAt 两栏都对）的 case 进分母', () => {
  const doc = { cases: [
    boss({ id: 'a', kind: GATE_KINDS.BODY_MUST_INCLUDE, expect: 'x' }),
    agent({ id: 'b', kind: GATE_KINDS.BODY_MUST_INCLUDE, expect: 'x' }),
    { id: 'c', kind: GATE_KINDS.BODY_MUST_INCLUDE, expect: 'x', addedBy: GATE_APPROVER, approvedAt: null },
    { id: 'd', kind: GATE_KINDS.BODY_MUST_INCLUDE, expect: 'x', addedBy: GATE_APPROVER, approvedAt: '2026-10-03' },
  ] };
  const { approved, proposed } = splitCases(doc);
  assert.deepEqual(approved.map((c) => c.id), ['a'], '⛔ agent 签的、缺 approvedAt 的、时间形状不对的一条都不算');
  assert.deepEqual(proposed.map((c) => c.id).sort(), ['b', 'c', 'd']);
});

test('G2: 全未签核 ⇒ passRate null（上层据此记 NO_EVIDENCE，不写行）', () => {
  const out = runSkillGate({
    skillText: '---\nname: demo\n---\nbody',
    caseDoc: { cases: [agent({ id: 'a', kind: GATE_KINDS.BODY_MUST_INCLUDE, expect: 'body' })] },
    repoRoot: REPO, exists: yes,
  });
  assert.equal(out.ok, true, '没人签不是仪器坏，是能判的太少');
  assert.equal(out.passRate, null);
  assert.equal(out.total, 0);
  assert.equal(out.approvedCount, 0);
  assert.equal(out.proposedCount, 1, '待签核条数要报出来 —— 它是"槽是空的"这句话的证据');
});

// ── 2. 五类 kind 的判法 ──────────────────────────────────────────────────

test('G3: body 三类（含正则），命中的方向不许反', () => {
  const text = '用 ASD 写。C:/x 不能出现。';
  const run = (c) => evalCase({ c, skillText: text, parsed: null, repoRoot: REPO, exists: yes });
  assert.equal(run({ kind: GATE_KINDS.BODY_MUST_INCLUDE, expect: 'ASD' }), true);
  assert.equal(run({ kind: GATE_KINDS.BODY_MUST_INCLUDE, expect: '不存在' }), false);
  assert.equal(run({ kind: GATE_KINDS.BODY_MUST_NOT_INCLUDE, expect: '不存在' }), true);
  assert.equal(run({ kind: GATE_KINDS.BODY_MUST_NOT_INCLUDE, expect: 'ASD' }), false);
  assert.equal(run({ kind: GATE_KINDS.BODY_MUST_NOT_MATCH, expect: '[A-Za-z]:[\\\\/]' }), false, '有盘符 = 这条不过');
  assert.equal(run({ kind: GATE_KINDS.BODY_MUST_NOT_MATCH, expect: 'zzz' }), true);
});

test('G4: frontmatter/field 三种 op', () => {
  const parsed = parseSkillFrontmatter('---\nname: demo\ndescription: hi there\n---\nbody');
  const run = (c) => evalCase({ c, skillText: '', parsed, repoRoot: REPO, exists: yes });
  assert.equal(run({ kind: GATE_KINDS.FRONTMATTER_FIELD, field: 'name', op: 'equals', expect: 'demo' }), true);
  assert.equal(run({ kind: GATE_KINDS.FRONTMATTER_FIELD, field: 'name', op: 'equals', expect: 'Demo' }), false);
  assert.equal(run({ kind: GATE_KINDS.FRONTMATTER_FIELD, field: 'description', op: 'contains', expect: 'there' }), true);
  assert.equal(run({ kind: GATE_KINDS.FRONTMATTER_FIELD, field: 'description', op: 'regex', expect: '^hi' }), true);
  assert.equal(run({ kind: GATE_KINDS.FRONTMATTER_FIELD, field: 'missing', op: 'equals', expect: 'demo' }), false);
  assert.equal(validateCase({ id: 'v', kind: GATE_KINDS.FRONTMATTER_FIELD, field: 'name', op: 'equals', expect: '' }).ok, false,
    '空 expect 会白拿一分（缺字段时实际值也是空串）⇒ 形状层面就拒');
});

test('G5: reference/path-exists 只看反引号里的仓内路径，且全部存在才过', () => {
  let want = null;
  const exists = (p) => (want ? p.endsWith(want) : false);
  const run = (text) => evalCase({
    c: { kind: GATE_KINDS.REFERENCE_PATH_EXISTS }, skillText: text, parsed: null, repoRoot: '/repo', exists,
  });
  assert.equal(run('见 `docs/a.md`'), false, 'exists 全 false ⇒ 不过');
  want = 'docs/a.md';
  assert.equal(run('见 `docs/a.md`'), true);
  assert.equal(run('见 `docs/a.md` 与 `wiki/b.md`'), false, '两个引用里有一个不存在 ⇒ 不过');
  assert.equal(run('没有反引号引用'), true, '没有引用 = 空真：这条不该拦住任何技能');
  assert.equal(run('`/etc/passwd` 不算'), true, '⛔ 只认 docs|wiki|eval|bin|plugins|presets 前缀，别把绝对路径喂给 fs');
});

// ── 3. 仪器故障与技能不合格分开 ──────────────────────────────────────────

test('G6: case 形状不合法 ⇒ ok:false + SKILL_GATE_INVALID 前缀（不是判技能失败）', () => {
  const bad = [
    { id: null, kind: 'body/must-include', expect: 'x' },              // 缺 id
    { id: 'k', kind: 'body/must-sing', expect: 'x' },                   // kind 不认
    { id: 'r', kind: GATE_KINDS.BODY_MUST_NOT_MATCH, expect: '(' },     // 正则坏
    { id: 'f', kind: GATE_KINDS.FRONTMATTER_FIELD, field: 'name', op: 'whatever', expect: 'x' },
    { id: 'e', kind: GATE_KINDS.BODY_MUST_INCLUDE, expect: '' },        // expect 空
  ];
  for (const c of bad) {
    const v = validateCase(c);
    assert.equal(v.ok, false, `本该拒掉：${JSON.stringify(c)}`);
    assert.match(v.reason, /^CASE_/);
  }
  const out = runSkillGate({
    skillText: 'body', caseDoc: { cases: [boss({ id: 'r', kind: GATE_KINDS.BODY_MUST_NOT_MATCH, expect: '(' })] },
    repoRoot: REPO, exists: yes,
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /^SKILL_GATE_INVALID/);
});

test('G7: 已签核 case 混合 ⇒ passed/failed/total 与 details 一一对应', () => {
  const out = runSkillGate({
    skillText: '---\nname: demo\n---\n含 ASD 词',
    caseDoc: { cases: [
      boss({ id: 'ok1', kind: GATE_KINDS.BODY_MUST_INCLUDE, expect: 'ASD' }),
      boss({ id: 'no1', kind: GATE_KINDS.BODY_MUST_INCLUDE, expect: '没有这个词' }),
      boss({ id: 'ok2', kind: GATE_KINDS.FRONTMATTER_FIELD, field: 'name', op: 'equals', expect: 'demo' }),
      agent({ id: 'skip', kind: GATE_KINDS.BODY_MUST_INCLUDE, expect: 'ASD' }),
    ] },
    repoRoot: REPO, exists: yes,
  });
  assert.equal(out.total, 3, '分母只含已签核');
  assert.equal(out.passed, 2);
  assert.equal(out.failed, 1);
  assert.equal(out.passRate, 2 / 3);
  assert.deepEqual(out.details.map((d) => d.id), ['ok1', 'no1', 'ok2']);
});

// ── 4. runner 契约 ───────────────────────────────────────────────────────

test('G8: runner 认 [SKILL.md, *.cases.json] 这一对，配不成对就是仪器故障', async () => {
  const read = async (p) => {
    if (p.endsWith('.cases.json')) return JSON.stringify({ cases: [boss({ id: 'a', kind: GATE_KINDS.BODY_MUST_INCLUDE, expect: 'hit' })] });
    return 'body says hit';
  };
  const runner = createSkillGateRunner({ read, exists: yes });
  const ok = await runner({ repoRoot: '/r', files: ['presets/agint/skills/demo/SKILL.md', 'eval/skills/agint/demo.cases.json'] });
  assert.equal(ok.ok, true);
  assert.equal(ok.gate.passRate, 1);

  for (const files of [
    ['presets/agint/skills/demo/SKILL.md'],                       // 没标签
    ['eval/skills/agint/demo.cases.json'],                        // 没技能
    ['a/SKILL.md', 'b/SKILL.md', 'a.cases.json', 'b.cases.json'], // 配多了
  ]) {
    const r = await runner({ repoRoot: '/r', files });
    assert.equal(r.ok, false, `该拒：${files.join(',')}`);
    assert.match(r.error, /^SKILL_GATE_FILE_PAIR_BAD/);
  }
});

test('G9: 读不到文件 / case JSON 不合法 ⇒ 都是仪器故障，各有名字', async () => {
  const files = ['presets/x/skills/y/SKILL.md', 'y.cases.json'];
  const runnerNoFile = createSkillGateRunner({
    read: async (p) => { if (p.endsWith('SKILL.md')) throw new Error('ENOENT'); return '{"cases":[]}'; },
    exists: yes,
  });
  const r1 = await runnerNoFile({ repoRoot: '/r', files });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /^SKILL_GATE_READ_FAILED/);

  const runnerBadJson = createSkillGateRunner({ read: async (p) => (p.endsWith('.cases.json') ? '{not json' : 'body'), exists: yes });
  const r2 = await runnerBadJson({ repoRoot: '/r', files });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /^SKILL_GATE_CASE_UNPARSEABLE/);
});

// ── 5. frontmatter 解析器与既有 checker 等价 ────────────────────────────

test('G10: 对全仓 32 个真技能，本文件的解析器与 skill-format checker 对"必填齐不齐"同判', async () => {
  const names = readdirSync(SKILL_DIR).filter((n) => existsSync(join(SKILL_DIR, n, 'SKILL.md')));
  let checked = 0;
  for (const name of names) {
    const dir = join(SKILL_DIR, name);
    const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    const parsed = parseSkillFrontmatter(text);
    const ours = ['name', 'description', 'triggers', 'tools'].every((k) => {
      const v = parsed?.fields?.[k];
      return Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim().length > 0;
    });
    const findings = await checkSkillFormat({ pluginDir: dir, profile: {} });
    const theirs = !findings.some((f) => /frontmatter 缺必填字段/.test(f.message));
    assert.equal(ours, theirs, `${name}: 两个解析器判得不一致 ⇒ 第二真相源在漂`);
    checked += 1;
  }
  assert.ok(checked >= 9, `至少该核到 agint preset 的 9 个技能（实到 ${checked}）`);
});

// ── 6. 候选槽的形状（老板签核的接口） ───────────────────────────────────

test('G11: 生成的候选槽全部未签核 ⇒ 一台空仪器（total 0），签一条就活一条', () => {
  const dir = join(REPO, 'eval', 'skills', 'agint');
  const files = readdirSync(dir).filter((f) => f.endsWith('.cases.json'));
  assert.equal(files.length, 9, 'agint preset 9 个技能 ⇒ 9 个槽');
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const { approved, invalid } = splitCases(doc);
    assert.equal(approved.length, 0, `${f}: 候选槽里不该有已签核条目`);
    assert.equal(invalid.length, 0, `${f}: 候选 case 的形状必须本来就合法（老板只改两个字段）`);
    assert.ok(doc.cases.length >= 6, `${f}: 每槽至少 6 条候选`);
    assert.equal(doc.status, 'CANDIDATE-UNAPPROVED');
  }
});
