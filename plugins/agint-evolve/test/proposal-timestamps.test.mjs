// agint-evolve 提案台时间戳回归（2026-10-27 事故）。
//
// 事故：proposalSchema 漏声明 createdAt / updatedAt ⇒ 存储域 open 时 zod 把
// 这两个键 strip 掉 ⇒ ① listProposals 排序 `b.createdAt.localeCompare(...)`
// 抛 TypeError（工具 evolve_proposals 全挂）；② setStatus 用「已 strip 的内存行」
// 写回磁盘，把该行的 createdAt 永久抹掉。
// 同日还查出第二个面：工具 output schema 是 additionalProperties:false，
// 却没声明 2026-10-27 新增的字段 ⇒ evolve_propose / evolve_set_status 每次调用
// 都被 DSH strict 输出校验打回（而且「先落库后校验」⇒ 报错时提案已经写进库）。
//
// 这一组用例钉的是**行为承诺**：
//   ① propose() 返回的行带非空 createdAt / updatedAt
//   ② listProposals() 不抛，且按 createdAt 倒序
//   ③ setStatus() 之后磁盘那一行的 createdAt 仍在（不被写坏）
//   ④ 三个工具的 output schema 声明字段集 ⊇ 实际返回字段集（声明与实现同步）
//
// 运行：node --import ./test/_stub-register.mjs --test test/proposal-timestamps.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { apply as applyTools } from '../lib/tools.js';

/**
 * 复刻真实存储域的两条关键语义（取证：dsh-storage-domain/lib/index.js）
 *   ① open 时逐行过 schema：parsed = tableSpec.valueSchema.parse(raw)（:371）
 *      ⇒ zod object 默认 strip 未知键 —— schema 没声明的字段在内存里消失。
 *   ② put 原样落盘、不重跑 schema：unit.putRecord(table, key, value)（:461）
 *      + KvTableImpl.put 里 records.set(key, value)（:257-268）
 *      ⇒ 内存里被 strip 过的行，写回磁盘就是坏的。
 */
function makeMockCtx(seeds = []) {
  const raw = new Map();      // 磁盘形态：原样存
  const parsed = new Map();   // 内存形态：过 schema
  let spec = null;
  for (const row of seeds) raw.set(row.id, row);
  const ctx = {
    storageDomain: {
      async open(domainSpec) {
        spec = domainSpec;
        const tables = new Map();
        const schemaOf = (table) => domainSpec.tables[table]?.valueSchema;
        const parseTable = (table, id, value) => {
          const s = schemaOf(table);
          if (!s) return value;
          try {
            return s.parse(value);
          } catch {
            return value;
          }
        };
        // 装载：raw → parse（strip 在这里发生）
        for (const [id, value] of raw.entries()) parsed.set(id, parseTable('proposal', id, value));
        tables.set('proposal', {
          get: (id) => parsed.get(id) ?? null,
          put: async (id, value) => {
            raw.set(id, value);       // 落盘：原样
            parsed.set(id, value);    // 内存：原样（不重跑 schema）
            return true;
          },
          delete: async (id) => raw.delete(id),
          entries: () => [...parsed.entries()],
        });
        return {
          name: domainSpec.name,
          version: domainSpec.version,
          table: (name) => {
            if (!tables.has(name)) {
              tables.set(name, {
                get: (id) => null,
                put: async (id, value) => { raw.set(`${name}:${id}`, value); return true; },
                delete: async (id) => true,
                entries: () => [],
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
    _registered: [],
    provide(k, v) { this._provides.set(k, v); },
    get(k) { return this._provides.get(k) ?? null; },
    effect(fn) { this._effects.push(fn()); },
    on() {},
    setInterval() { return { dispose() {} }; },
  };
  ctx.tools.register = (definition) => { ctx._registered.push(definition); };
  return { ctx, raw, parsed, getSpec: () => spec };
}

async function withApp(fn, seeds = []) {
  const root = await mkdtemp(join(tmpdir(), 'agint-evolve-ts-'));
  const { ctx, raw, parsed } = makeMockCtx(seeds);
  apply(ctx, { root });   // 这一步内部会 open 存储域 ⇒ raw 里的行过一次 schema
  const evolve = ctx.get('agint.evolve');
  try {
    await fn({ ctx, evolve, raw, parsed });
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

test('① propose() 返回的行带非空 createdAt / updatedAt', async () => {
  await withApp(async ({ evolve }) => {
    const rec = await evolve.propose({ title: '新提案', body: '正文', category: 'other' });
    assert.equal(typeof rec.createdAt, 'string');
    assert.notEqual(rec.createdAt, '', 'createdAt 不能为空：空串会让排序失去意义');
    assert.notEqual(rec.updatedAt, '');
  });
});

test('② listProposals() 不抛，且按 createdAt 倒序', async () => {
  await withApp(async ({ evolve }) => {
    const rows = await evolve.listProposals({});
    assert.ok(Array.isArray(rows));
    const ids = rows.map((r) => r.id);
    assert.deepEqual(ids, ['p-b', 'p-a'], '必须按 createdAt 倒序（新提案在前）');
    for (const r of rows) {
      assert.equal(typeof r.createdAt, 'string', 'createdAt 不能是 undefined（那正是排序崩溃的根因）');
    }
  }, [
    seedRow({ id: 'p-a', createdAt: '2026-10-01T00:00:00.000Z' }),
    seedRow({ id: 'p-b', createdAt: '2026-10-05T00:00:00.000Z' }),
  ]);
});

test('③ setStatus() 之后磁盘那一行的 createdAt 仍在（不被写坏）', async () => {
  await withApp(async ({ evolve, raw }) => {
    const updated = await evolve.setStatus('p-a', 'approved', '批了');
    assert.equal(updated.status, 'approved');
    assert.equal(raw.get('p-a').createdAt, '2026-10-01T00:00:00.000Z',
      '写回磁盘的行不能丢 createdAt（丢一次就永久丢）');
  }, [seedRow({ id: 'p-a', createdAt: '2026-10-01T00:00:00.000Z' })]);
});

test('④ 三个工具的 output schema 声明字段集 ⊇ 实际返回字段集', async () => {
  await withApp(async ({ ctx, evolve }) => {
    ctx['agint.evolve'] = evolve;
    applyTools(ctx);

    const declared = new Map(ctx._registered.map((t) => [t.name, t.output?.schema]));
    for (const name of ['evolve_propose', 'evolve_proposals', 'evolve_set_status']) {
      assert.ok(declared.has(name), `工具 ${name} 未注册`);
    }

    // evolve_propose
    const proposed = await ctx._registered.find((t) => t.name === 'evolve_propose').execute(
      { title: '校验用提案', body: '正文', category: 'other' },
    );
    assertDeclaredCovers('evolve_propose', declared.get('evolve_propose'), proposed);

    // evolve_proposals（items 逐条）
    const listed = await ctx._registered.find((t) => t.name === 'evolve_proposals').execute({});
    const itemSchema = declared.get('evolve_proposals').properties.proposals.items;
    assert.ok(Array.isArray(listed.proposals) && listed.proposals.length > 0);
    for (const item of listed.proposals) assertDeclaredCovers('evolve_proposals.items', itemSchema, item);

    // evolve_set_status
    const status = await ctx._registered.find((t) => t.name === 'evolve_set_status').execute(
      { id: 'p-a', status: 'approved' },
    );
    assertDeclaredCovers('evolve_set_status', declared.get('evolve_set_status'), status);
  }, [seedRow({ id: 'p-a' })]);
});

/** 断言 output schema 覆盖了返回体的全部字段，且必填字段都在。 */
function assertDeclaredCovers(label, schema, value) {
  assert.ok(schema, `${label}: 缺 output schema`);
  const props = schema.properties ?? {};
  const returned = Object.keys(value ?? {});
  const undeclared = returned.filter((k) => !(k in props));
  assert.deepEqual(undeclared, [], `${label}: 返回体有未声明字段（additionalProperties:false ⇒ 会被 strict 校验打回）`);
  const missing = Object.entries(props)
    .filter(([, spec]) => spec && spec.required === true)
    .map(([k]) => k)
    .filter((k) => !(k in (value ?? {})));
  assert.deepEqual(missing, [], `${label}: 返回体缺必填字段`);
}
