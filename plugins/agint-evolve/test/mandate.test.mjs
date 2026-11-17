// agint-evolve 审批凭据 Mandate（W8-3，2026-11-03）。
//
// 要解决的形态：
//   `approved` 现在只说「同意做」，没说「同意改哪些东西」。
//   执行器把 proposalId 交给 driver，driver 从**提案正文里抽路径**
//   （`extractRepoPaths`）再写仓库 —— 也就是说「改哪里」在执行的那一刻才被决定。
//   正文后来被编辑、或者路径抽取规则变宽，都能让一次批准覆盖到没人批过的文件。
//
// Mandate 就是把「批准时的范围」固化下来：policyVersion + proposalId + 允许路径。
// 执行前核对：超出范围 ⇒ **不得沿用原批准**，必须重新走审批。
//
// 三条口径（本用例钉死）：
//   M1 批准时落凭据：从正文抽出的路径 + 当时的 policyVersion
//   M2 ⛔ 正文被改宽 ⇒ 凭据失效（不静默放行）
//   M3 判定是**三态**：ok / mismatch / unknown
//      —— unknown（老提案没凭据）**不等于** mismatch（越权）。混为一谈会让
//         升级瞬间把所有老提案判成越权，全部停摆。
//
// 运行：node --import ./test/_stub-register.mjs --test test/mandate.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { checkMandate, mandatePaths, MANDATE_STATES } from '../lib/mandate.js';

// ── 纯函数层：范围判定 ──────────────────────────────────────────────

test('M0 mandatePaths 归一：去重、排序、剥 ./ 与行号', () => {
  const got = mandatePaths(['plugins/b.md', './plugins/a.js:120', 'plugins/b.md', '  plugins/c/  ']);
  assert.deepEqual(got, ['plugins/a.js', 'plugins/b.md', 'plugins/c']);
});

test('M0b mandatePaths 丢掉空串与非字符串，不抛', () => {
  assert.deepEqual(mandatePaths([null, undefined, '', 42, {}]), []);
  assert.deepEqual(mandatePaths(undefined), []);
  assert.deepEqual(mandatePaths('not-an-array'), []);
});

// ── M1 批准时落凭据 ────────────────────────────────────────────────

test('M1 approve 时按正文路径落 mandate（含 policyVersion）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agint-mandate-'));
  const ctx = makeMockCtx([]);
  apply(ctx, { root });
  const evolve = ctx.get('agint.evolve');
  try {
    const p = await evolve.propose({
      title: '改两个文件',
      body: '需要改 `plugins/agint-evolve/lib/index.js` 与 `plugins/agint-evolve/lib/tools.js`。',
      category: 'plugin',
    });
    const approved = await evolve.setStatus(p.id, 'approved', '批准范围就是这两个文件');
    const m = approved.mandate;
    assert.ok(m, 'approve 之后必须有 mandate');
    assert.equal(m.proposalId, p.id);
    assert.deepEqual(m.paths, [
      'plugins/agint-evolve/lib/index.js',
      'plugins/agint-evolve/lib/tools.js',
    ]);
    assert.equal(typeof m.grantedAt, 'string');
    assert.notEqual(m.grantedAt, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M1b 正文里没有可识别路径 ⇒ mandate.paths 为空数组而非 undefined', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agint-mandate-'));
  const ctx = makeMockCtx([]);
  apply(ctx, { root });
  const evolve = ctx.get('agint.evolve');
  try {
    const p = await evolve.propose({ title: '纯文字提案', body: '这里没有任何反引号路径。', category: 'other' });
    const approved = await evolve.setStatus(p.id, 'approved', '批准');
    assert.deepEqual(approved.mandate.paths, [],
      '空范围要显式是 []，"抽不到路径"不能被读成"什么都能改"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── M2 ⛔ 正文改宽 ⇒ 凭据失效 ───────────────────────────────────────

test('M2 正文在批准后被改宽 ⇒ checkMandate 判 mismatch（不静默放行）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agint-mandate-'));
  const ctx = makeMockCtx([]);
  apply(ctx, { root });
  const evolve = ctx.get('agint.evolve');
  try {
    const p = await evolve.propose({
      title: '改一个文件',
      body: '只改 `plugins/agint-evolve/lib/index.js`。',
      category: 'plugin',
    });
    const approved = await evolve.setStatus(p.id, 'approved', '批准');
    // 批准后正文被人改宽，多出一个文件
    const widened = {
      ...approved,
      body: '只改 `plugins/agint-evolve/lib/index.js` 与 `plugins/agint-evolve/lib/schema.js`。',
    };
    const verdict = checkMandate(widened);
    assert.equal(verdict.state, MANDATE_STATES.MISMATCH);
    assert.deepEqual(verdict.extra, ['plugins/agint-evolve/lib/schema.js'],
      '要指出具体多出来哪个路径，否则人不知道在哪儿越权');
    assert.ok(verdict.reason.includes('超出批准范围'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('M2b 正文收窄 ⇒ 仍然 ok（少改不算越权）', () => {
  const rec = {
    id: 'p1', status: 'approved',
    body: '只改 `plugins/a.js`。',
    mandate: { proposalId: 'p1', paths: ['plugins/a.js', 'plugins/b.js'], grantedAt: '2026-11-03T00:00:00Z', policyVersion: '' },
  };
  const verdict = checkMandate(rec);
  assert.equal(verdict.state, MANDATE_STATES.OK,
    '批准了两个文件只改一个，没越权 —— 判 mismatch 会让「保守执行」反而被拦');
});

test('M2c 路径完全相同 ⇒ ok', () => {
  const rec = {
    id: 'p1', status: 'approved',
    body: '改 `plugins/b.js` 和 `plugins/a.js`。',
    mandate: { proposalId: 'p1', paths: ['plugins/a.js', 'plugins/b.js'], grantedAt: 'x', policyVersion: '' },
  };
  assert.equal(checkMandate(rec).state, MANDATE_STATES.OK, '顺序不同不算差异（已归一排序）');
});

// ── M3 ⛔ 三态：unknown ≠ mismatch ────────────────────────────────

test('M3 老提案没有 mandate ⇒ unknown，不是 mismatch', () => {
  const legacy = { id: 'p-old', status: 'approved', body: '改 `plugins/x.js`' };
  const verdict = checkMandate(legacy);
  assert.equal(verdict.state, MANDATE_STATES.UNKNOWN,
    '⛔ 升级瞬间所有老提案都没有 mandate —— 判成 mismatch 会把它们集体停摆');
  assert.notEqual(verdict.state, MANDATE_STATES.MISMATCH);
});

test('M3b 没有路径可判（正文无路径 + 空 mandate）⇒ unknown 而不是 ok', () => {
  const rec = {
    id: 'p1', status: 'approved', body: '没有路径',
    mandate: { proposalId: 'p1', paths: [], grantedAt: 'x', policyVersion: '' },
  };
  assert.equal(checkMandate(rec).state, MANDATE_STATES.UNKNOWN,
    '两边都空 = 没有范围可比，说 ok 等于宣称"验过了"');
});

test('M3c mandate.proposalId 与提案不符 ⇒ mismatch（凭据被挪用了）', () => {
  const rec = {
    id: 'p1', status: 'approved', body: '改 `plugins/a.js`',
    mandate: { proposalId: 'p2', paths: ['plugins/a.js'], grantedAt: 'x', policyVersion: '' },
  };
  const verdict = checkMandate(rec);
  assert.equal(verdict.state, MANDATE_STATES.MISMATCH);
  assert.ok(verdict.reason.includes('凭据'), '要说清是凭据归属错了，不是路径错了');
});

// ── M4 只读：checkMandate 不改传入对象 ────────────────────────────

test('M4 checkMandate 不修改入参（判据必须是只读的）', () => {
  const rec = {
    id: 'p1', status: 'approved', body: '改 `plugins/a.js`',
    mandate: { proposalId: 'p1', paths: ['plugins/a.js'], grantedAt: 'x', policyVersion: '' },
  };
  const snapshot = JSON.stringify(rec);
  checkMandate(rec);
  assert.equal(JSON.stringify(rec), snapshot);
});

// ── 辅助：最小存储域替身（同其它用例一套语义）──────────────────────

function makeMockCtx(seeds = []) {
  const raw = new Map();
  const parsed = new Map();
  for (const row of seeds) raw.set(row.id, row);
  const ctx = {
    storageDomain: {
      async open(domainSpec) {
        const tables = new Map();
        const schemaOf = (table) => domainSpec.tables[table]?.valueSchema;
        const parseTable = (table, id, value) => {
          const s = schemaOf(table);
          if (!s) return value;
          try { return s.parse(value); } catch { return value; }
        };
        for (const [id, value] of raw.entries()) parsed.set(id, parseTable('proposal', id, value));
        tables.set('proposal', {
          get: (id) => parsed.get(id) ?? null,
          put: async (id, value) => { raw.set(id, value); parsed.set(id, value); return true; },
          delete: async (id) => raw.delete(id),
          entries: () => [...parsed.entries()],
        });
        return {
          name: domainSpec.name,
          version: domainSpec.version,
          table: (name) => {
            if (!tables.has(name)) {
              tables.set(name, {
                get: () => null, put: async () => true,
                delete: async () => true, entries: () => [],
              });
            }
            return tables.get(name);
          },
          async close() {},
        };
      },
    },
    tools: { register() {} },
    _provides: new Map(),
    _effects: [],
    provide(k, v) { this._provides.set(k, v); },
    get(k) { return this._provides.get(k) ?? null; },
    effect(fn) { this._effects.push(fn()); },
    on() {},
    setInterval() { return { dispose() {} }; },
  };
  return ctx;
}
