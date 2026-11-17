// agint-evolve evolve_set_status 派生字段回归（2026-11-03）。
//
// 事故：v0.24.0 引入 stage 九档时，`ticketStage()` 的四个派生值
// (`stage` / `stageSide` / `stageLabel` / `stageWhy`) 被写进了 `evolve_set_status`
// 的 **output schema 并标 required**，但 `execute()` 的返回体没有它们 ——
// `evolve_proposals` 因为直接返回 `listProposals()` 的行（自带 decorateProposal）而幸免，
// `evolve_set_status` 是手工拼返回体，于是 **每次调用必被 DSH strict 校验打回**。
//
// 为什么这条特别贵：仓库的写路径是「先落库、后校验」⇒ 报错的时候状态**已经改完了**。
// 调用方看到失败、重试一次，得到的是「状态没变」的幂等短路 —— 两边对不上账。
//
// 这一组钉死三件事：
//   S1 返回体带齐四个 stage 字段，且**值随状态真的变**（不是硬编码 draft）
//   S2 ⛔ 阴性对照：假装 evolve 没有 ticketStage()（老版本服务）时，字段仍必须存在
//      —— 空 schema 位不是「缺字段」的理由；`additionalProperties:false` 下缺一个就全废
//   S3 声明集 ⊇ 返回集（与本目录 proposal-timestamps ④ 同一护栏，但覆盖这次新增的两项）
//
// 运行：node --import ./test/_stub-register.mjs --test test/set-status-derived.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { apply as applyTools } from '../lib/tools.js';

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
    _registered: [],
    provide(k, v) { this._provides.set(k, v); },
    get(k) { return this._provides.get(k) ?? null; },
    effect(fn) { this._effects.push(fn()); },
    on() {},
    setInterval() { return { dispose() {} }; },
  };
  ctx.tools.register = (definition) => { ctx._registered.push(definition); };
  return { ctx, raw };
}

const seedRow = (over) => ({
  id: 'p-stage-1',
  title: '待判提案',
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

const STAGE_KEYS = ['stage', 'stageSide', 'stageLabel', 'stageWhy'];

async function withTool(fn, seeds = [], wrapEvolve = null) {
  const root = await mkdtemp(join(tmpdir(), 'agint-evolve-stage-'));
  const { ctx, raw } = makeMockCtx(seeds);
  apply(ctx, { root });
  const evolve = ctx.get('agint.evolve');
  ctx['agint.evolve'] = wrapEvolve ? wrapEvolve(evolve) : evolve;
  applyTools(ctx);
  const tool = ctx._registered.find((t) => t.name === 'evolve_set_status');
  assert.ok(tool, 'evolve_set_status 未注册');
  try {
    await fn({ tool, evolve, raw });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ── S1 四件齐全，且真的在算 ───────────────────────────────────────────
test('S1 evolve_set_status 返回体带齐 stage 四件，且值随状态变化', async () => {
  await withTool(async ({ tool }) => {
    const out = await tool.execute({ id: 'p-stage-1', status: 'approved', note: '批' });
    for (const k of STAGE_KEYS) {
      assert.equal(typeof out[k], 'string', `${k} 必须是字符串（schema 声明 required）`);
      assert.notEqual(out[k], '', `${k} 不能是空串 —— 空串等于「有字段但没答案」，读的人分不清`);
    }
    // ⛔ 阴性对照：不能是硬编码。proposed 与 approved 的档位必须不同，
    //    否则「补字段」就退化成了「填个占位符骗过 schema」。
    const before = await tool.execute({ id: 'p-stage-1', status: 'proposed', note: '先改回' });
    assert.notEqual(before.stage, out.stage,
      'proposed 与 approved 落在不同档才说明 stage 是算出来的，不是常量');
  }, [seedRow()]);
});

test('S2 工具里的 stage 与 ticketStage() 对同一行给同一答案（不是工具自己发明的）', async () => {
  await withTool(async ({ tool, evolve }) => {
    const out = await tool.execute({ id: 'p-stage-1', status: 'rejected', note: '否' });
    // ⛔ 让 ticketStage 返回它自己对**磁盘那一行**的答案：不比对工具入参，
    //    比对的是「同一行、同一时刻」的判据 —— 否则比的是两行，结论没有意义。
    const direct = evolve.ticketStage({ ...seedRow(), status: 'rejected' });
    // 键名注意：ticketStage() 是短名 side/label/why，工具输出是 stageSide/stageLabel/stageWhy。
    assert.equal(out.stage, direct.stage, '档位必须一致');
    assert.equal(out.stageSide, direct.side, 'side ↔ stageSide 映射不能错位');
    assert.equal(out.stageLabel, direct.label, 'label ↔ stageLabel 映射不能错位');
    assert.equal(out.stageWhy, direct.why, 'why ↔ stageWhy 映射不能错位');
  }, [seedRow()]);
});

// ── S3 ⛔ 阴性对照：服务没有 ticketStage() 时字段仍必须存在 ─────────────
test('S3 老版本服务无 ticketStage() ⇒ 四件仍存在（缺一个就整个返回被打回）', async () => {
  const stripStage = (evolve) => {
    const clone = Object.create(Object.getPrototypeOf(evolve) ?? Object.prototype);
    for (const k of Object.keys(evolve)) clone[k] = evolve[k];
    // 模拟 v0.23.x：服务上没有 ticketStage
    delete clone.ticketStage;
    return clone;
  };
  await withTool(async ({ tool }) => {
    const out = await tool.execute({ id: 'p-stage-1', status: 'approved', note: '批' });
    for (const k of STAGE_KEYS) {
      assert.equal(typeof out[k], 'string',
        `${k} 在无 ticketStage() 时也必须是字符串 —— 降级要给空值，不能删键`);
    }
  }, [seedRow()], stripStage);
});

// ── S3b ⛔ 阴性对照：键名写错（side→stageSide）必须被抓到 ───────────────
// 2026-11-03 实测：最初实现写的是 `stage.stageSide`，而 ticketStage() 返回 `side`
// ⇒ 三个字段「存在、类型对、永远为空」，schema 照过、面板照显示空白。
// S4（声明集 ⊇ 返回集）抓不到它，因为键是齐的。必须靠 S1「不许空串」+ S2「映射不错位」。
test('S3b 阴性对照：读错键会产生「有字段但永远为空」—— 这正是 S1/S2 要拦的形态', async () => {
  // 复刻错误实现的取值方式
  const wrongRead = (stage) => ({
    stageSide: stage.stageSide,   // ← 假想中的错键
    stageLabel: stage.stageLabel,
    stageWhy: stage.stageWhy,
  });
  const truth = { stage: 'draft', side: 'person', label: '待批准', why: '还没人批准这条提案' };
  const got = wrongRead(truth);
  // 阴性对照：错键下三个值全是 undefined（→ 会被 ?? '' 兜成空串）
  assert.equal(got.stageSide, undefined, '读错键必须得到 undefined，以此自证 S2 的映射断言有意义');
  assert.equal(got.stageLabel, undefined);
  assert.equal(got.stageWhy, undefined);
  // 正确映射
  assert.equal(truth.side, 'person');
  assert.equal(truth.label, '待批准');
});

// ── S4 声明集 ⊇ 返回集（含本次新增的 execStartedAt / execFinishedAt）──
test('S4 output schema 声明的字段集 ⊇ 实际返回字段集', async () => {
  await withTool(async ({ tool }) => {
    const out = await tool.execute({ id: 'p-stage-1', status: 'approved', note: '批' });
    const props = tool.output.schema.properties;
    const declared = new Set(Object.keys(props));
    const undeclared = Object.keys(out).filter((k) => !declared.has(k));
    assert.deepEqual(undeclared, [],
      `返回了未声明字段会被 additionalProperties:false 打回：${undeclared.join(', ')}`);
    const missing = Object.entries(props)
      .filter(([, v]) => v.required === true)
      .map(([k]) => k)
      .filter((k) => !(k in out));
    assert.deepEqual(missing, [], `声明为 required 却没返回：${missing.join(', ')}`);
  }, [seedRow()]);
});
