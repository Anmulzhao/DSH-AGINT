/**
 * model-scope 单元测试（2026-10-03）
 *
 * 覆盖三件事：
 *   ① 判据 —— buildModelScope / mergeModelScope / checkModelScope 的取值与合并。
 *   ② 渲染 —— frontmatter 扁平键 + 正文「## 适用模型」段。
 *   ③ **不拦截** —— 本族永不返回 blocker（老板拍板「不加门禁」）。
 *
 * 每条都配「该命中」与「不该命中」两例：本族判据接进 Phase 1 的
 * `allFindings` 与 blocker 判定同一批数据，一旦误升级成 blocker 会把
 * 模型字段取不到的旧候选全拒（v3 会话 / tool-stats 源恒 unknown）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildModelScope,
  unknownModelScope,
  normalizeModelScope,
  mergeModelScope,
  summarizeModelScope,
  renderModelFrontmatter,
  renderModelSection,
  checkModelScope,
  modelScopeWarningsOf,
  MODEL_SCOPE_RULES,
  MODEL_SCOPE_SEVERITY,
} from '../lib/model-scope.js';

/** 造一条带模型标识的 assistant/message 事件（形状取自生产 v4 实盘） */
function assistantMsg(provider, model) {
  return {
    type: 'assistant/message',
    time: 1,
    seq: 1,
    data: { turn: 1, step: 1, message: { source: { kind: 'assistant', provider, model }, content: [] } },
  };
}

const KNOWN = buildModelScope([
  assistantMsg('minimax-cn', 'MiniMax-M3.1-Flash-Preview'),
  assistantMsg('minimax-cn', 'MiniMax-M3.1-Flash-Preview'),
  assistantMsg('deepseek-official', 'deepseek-flash'),
]);

const byCode = (findings, code) => findings.find((f) => f.code === code);

// ── ① 判据 ──────────────────────────────────────────────────────────────

test('buildModelScope：从事件取到模型，按消息数降序、share 重算', () => {
  assert.equal(KNOWN.status, 'known');
  assert.equal(KNOWN.models.length, 2);
  assert.equal(KNOWN.models[0].model, 'MiniMax-M3.1-Flash-Preview');
  assert.equal(KNOWN.models[0].messages, 2);
  assert.equal(KNOWN.models[0].share, 0.6667);
  assert.equal(KNOWN.models[0].dominant, true);
  assert.equal(KNOWN.models[1].dominant, false);
  assert.deepEqual(KNOWN.providers, ['minimax-cn', 'deepseek-official']);
  assert.equal(KNOWN.dominant.model, 'MiniMax-M3.1-Flash-Preview');
});

test('buildModelScope：只有 provider 没 model 时也要留下（不丢弃证据）', () => {
  const s = buildModelScope([assistantMsg('some-provider', '')]);
  assert.equal(s.status, 'known');
  assert.equal(s.models[0].provider, 'some-provider');
  assert.equal(s.models[0].model, '');
});

test('buildModelScope：无模型字段 → status=unknown，**不猜**', () => {
  // v3 会话实测形状：没有任何 assistant message source
  const s = buildModelScope([{ type: 'tool/call', time: 1, seq: 1, data: { name: 'glob' } }]);
  assert.equal(s.status, 'unknown');
  assert.deepEqual(s.models, []);
  assert.equal(s.dominant, null);
});

test('buildModelScope：空事件数组 → unknown（不是崩溃）', () => {
  assert.equal(buildModelScope([]).status, 'unknown');
  assert.equal(buildModelScope(undefined).status, 'unknown');
  assert.equal(buildModelScope(null).status, 'unknown');
});

test('unverifiedOn 恒为空 —— 插件观察不到别的模型会怎么错（不编造）', () => {
  // 这条是**契约**：将来接上宿主模型清单时这条断言才允许改
  assert.deepEqual(KNOWN.unverifiedOn, []);
});

test('mergeModelScope：两侧按消息数并集，dominant 重算', () => {
  const a = buildModelScope([assistantMsg('p1', 'm1'), assistantMsg('p1', 'm1')]);
  const b = buildModelScope([assistantMsg('p2', 'm2')]);
  const m = mergeModelScope(a, b);
  assert.equal(m.status, 'known');
  assert.equal(m.models.length, 2);
  assert.equal(m.models.find((x) => x.model === 'm1').messages, 2);
  assert.equal(m.models.find((x) => x.model === 'm2').messages, 1);
  assert.equal(m.dominant.model, 'm1');
});

test('mergeModelScope：null / unknown 一侧不污染已知结果', () => {
  const a = buildModelScope([assistantMsg('p1', 'm1')]);
  assert.equal(mergeModelScope(a, null).models.length, 1);
  assert.equal(mergeModelScope(null, a).models.length, 1);
  assert.equal(mergeModelScope(a, unknownModelScope()).models.length, 1);
  assert.equal(mergeModelScope(a, { status: 'unknown', models: [] }).status, 'known');
});

test('mergeModelScope：同一模型重复计入时消息数累加（不是覆盖）', () => {
  const a = buildModelScope([assistantMsg('p1', 'm1')]);
  const b = buildModelScope([assistantMsg('p1', 'm1'), assistantMsg('p1', 'm1')]);
  const m = mergeModelScope(a, b);
  assert.equal(m.models.length, 1);
  assert.equal(m.models[0].messages, 3);
});

test('normalizeModelScope：缺字段 / 垃圾输入不抛，落到 unknown', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { status: 'weird' }]) {
    assert.equal(normalizeModelScope(bad).status, 'unknown');
  }
  // 合法 known 但 models 空 → 也退 unknown（不谎称「已知」）
  assert.equal(normalizeModelScope({ status: 'known', models: [] }).status, 'unknown');
});

test('normalizeModelScope：剥掉不合法字符（防注入到 frontmatter）', () => {
  const s = normalizeModelScope({
    status: 'known',
    models: [{ provider: 'p\r\nname: evil', model: 'm', messages: 1, share: 1, dominant: true }],
  });
  assert.ok(!s.models[0].provider.includes('\n'));
  assert.ok(!s.models[0].provider.includes(': '));
});

// ── ②b 防注入（安全不变量）────────────────────────────────────────────

test('【安全】含 YAML 危险字符的模型名被剥成空，不进 frontmatter 清单', () => {
  // safeToken 是白名单（[\w.@:/+-]）⇒ 危险字符在到达 yamlScalar 之前就没了。
  // 这条断言守的是「不许出现 observed + 空清单」这种自相矛盾形态。
  for (const danger of ['~weird', '*star', 'has: colon', 'a #hash', 'a\nb', 'quo"te']) {
    const s = normalizeModelScope({
      status: 'known',
      models: [{ provider: '', model: danger, messages: 1, share: 1, dominant: true }],
      providers: [],
      dominant: { provider: '', model: danger, dominant: true },
    });
    const fm = renderModelFrontmatter(s);
    assert.equal(fm['model-scope'], 'unknown', `"${danger}" 应退化为 unknown`);
    assert.deepEqual(fm['verified-on'], []);
    const md = renderModelSection(s);
    assert.match(md, /无法确定/, `"${danger}" 的正文段也应说无法确定`);
    assert.ok(!md.includes('未标注模型'), '不逐条列「未标注模型」');
  }
});

test('【安全】合法模型名（含 / . -）原样保留', () => {
  const s = normalizeModelScope({
    status: 'known',
    models: [{ provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash-Preview', messages: 3, share: 1, dominant: true }],
    providers: ['minimax-cn'],
    dominant: { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash-Preview', dominant: true },
  });
  assert.deepEqual(renderModelFrontmatter(s)['verified-on'], ['minimax-cn/MiniMax-M3.1-Flash-Preview']);
});

// ── ② 渲染：frontmatter ─────────────────────────────────────────────────

test('renderModelFrontmatter：known → 扁平键 verified-on 是可 grep 的串', () => {
  const fm = renderModelFrontmatter(KNOWN);
  assert.equal(fm['model-scope'], 'observed');
  assert.deepEqual(fm['verified-on'], [
    'minimax-cn/MiniMax-M3.1-Flash-Preview',
    'deepseek-official/deepseek-flash',
  ]);
  assert.match(fm['verified-on-note'], /2 个模型/);
});

test('renderModelFrontmatter：unknown → 显式 unknown + 明确说明（不留白）', () => {
  const fm = renderModelFrontmatter(unknownModelScope());
  assert.equal(fm['model-scope'], 'unknown');
  assert.deepEqual(fm['verified-on'], []);
  assert.match(fm['verified-on-note'], /未经任何模型验证/);
});

// ── ③ 渲染：正文段 ─────────────────────────────────────────────────────

test('renderModelSection：known → 列出模型 + 写跨模型复用注意', () => {
  const md = renderModelSection(KNOWN);
  assert.match(md, /^## 适用模型/);
  assert.match(md, /minimax-cn\/MiniMax-M3\.1-Flash-Preview/);
  assert.match(md, /占记录 67%/);
  assert.match(md, /跨模型复用注意/);
});

test('renderModelSection：unknown → 明说「无法确定」并给处置动作', () => {
  const md = renderModelSection(unknownModelScope());
  assert.match(md, /## 适用模型/);
  assert.match(md, /无法确定/);
  assert.match(md, /小样本/);
});

test('renderModelSection：保留通用性 —— 明确说「不是唯一可用对象」', () => {
  // 老板要求：技能主体跨模型可迁移，本段是附加说明，不能把技能锁死
  const md = renderModelSection(KNOWN);
  assert.match(md, /不是本技能的唯一可用对象/);
  assert.match(md, /步骤本身是通用的/);
});

test('renderModelSection：风险提示写成可执行动作，不写免责话术', () => {
  const md = renderModelSection(KNOWN);
  assert.match(md, /小样本/, '风险提示必须给可执行动作');
  assert.ok(!/可能(?:不|未)适用[。！]?$/.test(md.trim()), '不接受无信息量的免责话术');
});

test('renderModelSection：模型多于 4 个时截断展示并指路 manifest', () => {
  const many = buildModelScope([
    assistantMsg('p', 'm1'), assistantMsg('p', 'm1'), assistantMsg('p', 'm1'),
    assistantMsg('p', 'm2'), assistantMsg('p', 'm3'), assistantMsg('p', 'm4'),
    assistantMsg('p', 'm5'), assistantMsg('p', 'm6'),
  ]);
  const md = renderModelSection(many);
  assert.match(md, /另有 \d+ 个模型/);
  assert.match(md, /manifest\.json/);
});

// ── ④ 判据：checkModelScope ────────────────────────────────────────────

test('checkModelScope：单模型 + 正文有该段 → 零 finding', () => {
  const single = buildModelScope([assistantMsg('p1', 'm1')]);
  const f = checkModelScope({ scope: single, body: renderModelSection(single) });
  assert.deepEqual(f, []);
});

test('checkModelScope：unknown → 一条 warn，**不是 blocker**', () => {
  const f = checkModelScope({ scope: unknownModelScope() });
  assert.equal(f.length, 1);
  assert.equal(f[0].code, 'model-scope-unknown-source');
  assert.equal(f[0].severity, 'warn');
  assert.equal(f.filter((x) => x.severity === 'blocker').length, 0);
});

test('checkModelScope：多模型 → 提示未按模型区分步骤', () => {
  const f = checkModelScope({ scope: KNOWN, body: renderModelSection(KNOWN) });
  const hit = byCode(f, 'model-scope-unverified-transfer');
  assert.ok(hit, '应命中 model-scope-unverified-transfer');
  assert.match(hit.message, /2 个模型/);
  assert.match(hit.message, /未在目标模型上验证/);
});

test('checkModelScope：frontmatter 有归属但正文缺段 → warn', () => {
  const f = checkModelScope({ scope: KNOWN, body: '## 步骤\n\n1. 读文件' });
  assert.ok(byCode(f, 'model-section-missing-in-body'));
});

test('checkModelScope：draft 形态也能吃（不用手动传 scope）', () => {
  // 用**单模型** scope：多模型会额外产生一条 unverified-transfer warn
  const single = buildModelScope([assistantMsg('p1', 'm1')]);
  const draft = { frontmatter: { modelScope: single }, body: renderModelSection(single) };
  assert.deepEqual(checkModelScope({ draft }), []);
});

test('checkModelScope：草稿整个没有 modelScope → 零 finding（不是 unknown）', () => {
  // 手工草稿 / 存量候选：本来就没这个维度，报「来源未知」是误导
  assert.deepEqual(checkModelScope({ draft: { frontmatter: {}, body: '## 步骤\n\n1. x' } }), []);
  assert.deepEqual(checkModelScope({}), []);
  assert.deepEqual(checkModelScope({ draft: { frontmatter: { modelScope: null } } }), []);
});

test('【硬契约】本族永不产生 blocker（老板拍板不加门禁）', () => {
  const cases = [
    unknownModelScope(),
    KNOWN,
    buildModelScope([]),
    { status: 'known', models: [] },
    normalizeModelScope({ status: 'known' }),
  ];
  for (const scope of cases) {
    for (const body of ['', '## 步骤\n\n1. x', renderModelSection(scope)]) {
      const f = checkModelScope({ scope, body });
      assert.equal(f.filter((x) => x.severity === 'blocker').length, 0);
    }
  }
});

test('【硬契约】MODEL_SCOPE_RULES 无 blocker 档', () => {
  assert.equal(MODEL_SCOPE_SEVERITY, 'warn');
  for (const [, std] of MODEL_SCOPE_RULES) {
    assert.equal(typeof std, 'string');
    assert.ok(std.length > 10, '第二列必须是标准全文，不是 severity');
    assert.notEqual(std, 'blocker');
    assert.notEqual(std, 'warn');
  }
});

test('modelScopeWarningsOf 只取 warn', () => {
  const f = checkModelScope({ scope: unknownModelScope() });
  assert.equal(modelScopeWarningsOf(f).length, f.length);
});

// ── ⑤ 审计摘要 ─────────────────────────────────────────────────────────

test('summarizeModelScope：unknown 显式写出来（不留白会被读成「没这项」）', () => {
  const s = summarizeModelScope(unknownModelScope());
  assert.equal(s.status, 'unknown');
  assert.deepEqual(s.models, []);
});

test('summarizeModelScope：known 保留模型与占比、去掉 messages 噪声', () => {
  const s = summarizeModelScope(KNOWN);
  assert.equal(s.status, 'known');
  assert.equal(s.models.length, 2);
  assert.equal(s.models[0].model, 'MiniMax-M3.1-Flash-Preview');
  assert.ok(!('messages' in s.models[0]), '审计不需要消息数');
});