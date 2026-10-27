// agint-evolve 提案「成立条件」回归（提案 567dabed，2026-10-27）。
//
// 事故：提案 a85ef850 在 2026-10-09 12:58 立项「用 Q2 最丑归因标定权重」，
// 当时 q2Worst 按绝对扣分排序 ⇒ 该建议成立；同日 13:07 落地的 f51d3280 把排序
// 改成 ratio(deduction/maxWeight)，而 deduction = maxWeight × g(value, threshold)
// ⇒ 权重被约掉、归因只由阈值决定 ⇒ 这条提案**静默失效**，却仍挂在台账里「待批」
// 18 天，直到人工点开才发现方法已无意义。同期还有两条互斥提案（#3 要求「归因与
// 权重解耦」、#8 要求「用归因标定权重」）出自同一份复审、相隔 24 分钟立项。
//
// 这一组用例钉的是**行为承诺**：
//   ① propose() 自动记下当前判尺口径（oracle 提供 formulaVersion 时）
//   ② 口径变了 ⇒ listProposals/getProposal 带出 staleSince（'r2→r4'）
//   ③ 没记口径的历史行 / oracle 未挂载 ⇒ staleSince 为空（未知 ≠ 失效）
//   ④ staleSince 是派生值，**绝不落盘**（落盘就会在下次口径变更时变成过期事实）
//   ⑤ conflictsWith 指向已生效提案（applied/approved）⇒ 拒绝创建
//   ⑥ conflictsWith 指向未生效提案（proposed/rejected/wontfix）⇒ 允许，并留档
//
// 运行：node --test test/proposal-provenance.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

/**
 * 复刻真实存储域两条关键语义（取证：dsh-storage-domain/lib/index.js）：
 *  ① open 时逐行 valueSchema.parse(raw) ⇒ zod strip 未知键 + 填 default
 *  ② put 原样落盘、不重跑 schema
 */
function makeMockCtx(seeds = []) {
  const raw = new Map();
  const parsed = new Map();
  for (const row of seeds) raw.set(row.id, row);
  const ctx = {
    storageDomain: {
      async open(domainSpec) {
        const schemaOf = (table) => domainSpec.tables[table]?.valueSchema;
        const parseRow = (table, value) => {
          const s = schemaOf(table);
          if (!s) return value;
          try { return s.parse(value); } catch { return value; }
        };
        for (const [id, value] of raw.entries()) parsed.set(id, parseRow('proposal', value));
        return {
          name: domainSpec.name,
          version: domainSpec.version,
          table: (name) => ({
            get: (id) => (name === 'proposal' ? parsed.get(id) ?? null : null),
            put: async (id, value) => {
              if (name === 'proposal') { raw.set(id, value); parsed.set(id, value); }
              return true;
            },
            delete: async (id) => { raw.delete(id); parsed.delete(id); return true; },
            entries: () => (name === 'proposal' ? [...parsed.entries()] : []),
            values: async () => [],
            clear: async () => true,
            size: async () => 0,
          }),
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
    logger: { warn() {} },
  };
  return { ctx, raw, parsed };
}

async function withApp(fn, { seeds = [], oracle } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agint-evolve-prov-'));
  const { ctx, raw } = makeMockCtx(seeds);
  // oracle 必须在 apply 之前挂上：currentFormulaVersion 是现取 ctx.get 的。
  if (oracle) ctx._provides.set('agint.aestheticOracle', oracle);
  apply(ctx, { root });
  const evolve = ctx.get('agint.evolve');
  try {
    await fn({ ctx, evolve, raw });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const seedRow = (over) => ({
  id: 'p-seed-1',
  title: '种子提案',
  body: '正文',
  category: 'other',
  status: 'proposed',
  source: '',
  note: '',
  blocker: '',
  unblockCondition: '',
  execMode: 'manual',
  execAt: '',
  execState: 'idle',
  execAttempts: 0,
  execError: '',
  execStartedAt: '',
  execFinishedAt: '',
  autoExecutable: true,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});

test('① propose() 自动记下当前判尺口径', async () => {
  await withApp(async ({ evolve }) => {
    const rec = await evolve.propose({ title: '新提案', body: '正文' });
    assert.equal(rec.formulaVersion, 'r4', 'oracle 报 r4 ⇒ 新提案的成立口径就是 r4');
    assert.equal(rec.staleSince, '', '刚创建不可能已经失效');
    assert.deepEqual(rec.conflictsWith, [], '没声明互斥 ⇒ 空数组，不是 undefined');
  }, { oracle: { formulaVersion: 'r4' } });
});

test('② 口径变了 ⇒ listProposals/getProposal 带出 staleSince', async () => {
  await withApp(async ({ evolve }) => {
    const rows = await evolve.listProposals({});
    const one = rows.find((r) => r.id === 'p-old');
    assert.equal(one.staleSince, 'r2→r4', '立项按 r2、当前 r4 ⇒ 必须标出差值');
    assert.equal((await evolve.getProposal('p-old')).staleSince, 'r2→r4');
    const fresh = rows.find((r) => r.id === 'p-new');
    assert.equal(fresh.staleSince, '', '口径一致的提案不许标黄');
  }, {
    oracle: { formulaVersion: 'r4' },
    seeds: [
      seedRow({ id: 'p-old', createdAt: '2026-10-01T00:00:00.000Z', formulaVersion: 'r2' }),
      seedRow({ id: 'p-new', createdAt: '2026-10-05T00:00:00.000Z', formulaVersion: 'r4' }),
    ],
  });
});

test('③ 没记口径 / oracle 未挂载 ⇒ staleSince 为空（未知 ≠ 失效）', async () => {
  await withApp(async ({ evolve }) => {
    const rows = await evolve.listProposals({});
    assert.equal(rows[0].staleSince, '', '历史行没有 formulaVersion ⇒ 不能判它失效');
  }, { oracle: { formulaVersion: 'r4' }, seeds: [seedRow({ id: 'p-unknown' })] });

  await withApp(async ({ evolve }) => {
    const rows = await evolve.listProposals({});
    assert.equal(rows[0].staleSince, '', 'oracle 未挂载 ⇒ 当前口径未知 ⇒ 无法比较');
  }, { seeds: [seedRow({ id: 'p-unknown2', formulaVersion: 'r2' })] });
});

test('④ staleSince 是派生值，不落盘', async () => {
  await withApp(async ({ evolve, raw }) => {
    const rows = await evolve.listProposals({});
    assert.equal(rows[0].staleSince, 'r2→r4');
    assert.equal('staleSince' in raw.get('p-old'), false, '派生值不进存储行（否则下次口径变更时会变成过期事实）');
    // setStatus 写回同样不得把派生值带进磁盘
    await evolve.setStatus('p-old', 'approved', '批了');
    assert.equal('staleSince' in raw.get('p-old'), false);
    assert.equal(raw.get('p-old').formulaVersion, 'r2', '写回必须保留立项时的口径快照');
  }, {
    oracle: { formulaVersion: 'r4' },
    seeds: [seedRow({ id: 'p-old', formulaVersion: 'r2' })],
  });
});

test('⑤ 与已生效提案（applied / approved）互斥 ⇒ 拒绝创建', async () => {
  await withApp(async ({ evolve }) => {
    await assert.rejects(
      () => evolve.propose({ title: '互斥提案', body: '正文', conflictsWith: ['p-applied'] }),
      /互斥/,
      'applied = 已生效，与之互斥的提案不该进池',
    );
    await assert.rejects(
      () => evolve.propose({ title: '互斥提案', body: '正文', conflictsWith: ['p-approved'] }),
      /互斥/,
    );
  }, {
    oracle: { formulaVersion: 'r4' },
    seeds: [
      seedRow({ id: 'p-applied', status: 'applied' }),
      seedRow({ id: 'p-approved', status: 'approved' }),
    ],
  });
});

test('⑥ 与未生效提案声明互斥 ⇒ 允许创建，并留档 conflictsWith', async () => {
  await withApp(async ({ evolve, raw }) => {
    const rec = await evolve.propose({
      title: '配套提案',
      body: '正文',
      conflictsWith: ['p-proposed', 'p-rejected', 'p-gone'],
    });
    assert.deepEqual(rec.conflictsWith, ['p-proposed', 'p-rejected', 'p-gone']);
    assert.deepEqual(raw.get(rec.id).conflictsWith, ['p-proposed', 'p-rejected', 'p-gone']);
  }, {
    oracle: { formulaVersion: 'r4' },
    seeds: [
      seedRow({ id: 'p-proposed', status: 'proposed' }),
      seedRow({ id: 'p-rejected', status: 'rejected' }),
    ],
  });
});
