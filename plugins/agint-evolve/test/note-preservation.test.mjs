// agint-evolve 提案 note 保真回归（W8-2 Outbox + receipt 的「receipt」面）。
//
// 事故形态（不是假设，是读码定位到的活路径）：
//   `applyStatus()` 第 847 行 `note: note ?? rec.note ?? ''` —— 只挡 `null/undefined`。
//   而 `setStatus(id, status, note = '')` 的默认值是**空串**，`'' ?? rec.note` 求值为 `''`。
//   ⇒ 任何「只改状态、不给 note」的调用都会把整行 note 清空。
//
//   两条真实入口都踩在这上面：
//     ① 工具 `evolve_set_status`：`tools.js:323` 直接透传 `args.note`；模型不带 note
//        时是 undefined → 落到默认值 '' → 原有记录被抹。工具描述只说「理由」，
//        没说「不填就清空」—— 这是最容易被当成无害调用的形态。
//     ② 服务直调 `evolve.setStatus(id, 'applied')`（`shadow-publish.test.mjs:131`
//        就是这么写的）—— 同样清空。
//
// 为什么这不是「小事」：本仓的提案 note 是**唯一的人工判断留痕**。
// 面板写路由靠 `composeDecisionNote` 自己拼前缀绕开了它，所以从面板操作看不出来；
// 一旦从工具/服务侧改判，证据静默消失，而且 `updatedAt` 照常刷新 ——
// 事后读的人看到的是一行「刚被改过、但什么都没留下」的记录，比报错难查得多。
//
// 口径（本用例钉死的承诺）：
//   - `note` 未传（undefined/null）⇒ **冻结现状**，与 blocker / execMode 同一语义。
//   - `note` 传 `''` ⇒ 显式清除（要清就得说清，不能靠省略）。
//   - 传非空字符串 ⇒ 覆盖。
//
// 每条都带阴性对照（`oldNote()` 复刻修复前的求值），证明用例真的在测这件事。
//
// 运行：node --import ./test/_stub-register.mjs --test test/note-preservation.test.mjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { apply as applyTools } from '../lib/tools.js';

/** 修复前的求值：`note ?? rec.note ?? ''`。阴性对照用。 */
function oldNote(passed, prevNote) {
  return passed ?? prevNote ?? '';
}

/**
 * 最小存储域替身：open 逐行过 schema（strip 未知键），put 原样落盘。
 * 与 proposal-timestamps.test.mjs 同一套语义（取证见那边的注释）。
 */
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
          put: async (id, value) => {
            raw.set(id, value);
            parsed.set(id, value);
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
                get: () => null,
                put: async () => true,
                delete: async () => true,
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
  return { ctx, raw, parsed };
}

async function withApp(fn, seeds = []) {
  const root = await mkdtemp(join(tmpdir(), 'agint-evolve-note-'));
  const { ctx, raw } = makeMockCtx(seeds);
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

const HUMAN_NOTE = '人工核过：这两处改动与 Sprint 12 的 baseline 冲突，先否';

// ── N1 ⛔ 阴性对照：先证明修复前确实是坏的 ────────────────────────────
test('N1 阴性对照：修复前的求值确实把 note 清空（证明这些用例在测真问题）', () => {
  // 工具不带 note ⇒ args.note 是 undefined ⇒ 落到默认参数 ''
  assert.equal(oldNote(undefined, HUMAN_NOTE), HUMAN_NOTE,
    '未传时应保留 —— 这条会红，说明下面 N2 的真问题在默认参数之后');
  // 默认参数把 undefined 变成 ''
  assert.equal(oldNote('', HUMAN_NOTE), '',
    '空串求值 = 清空：这才是真事故形态（undefined 被默认值降级成空串）');
  assert.notEqual(oldNote('', HUMAN_NOTE), HUMAN_NOTE,
    '阴性对照：修复前的行为必须与期望相反，否则用例没在测东西');
});

// ── N2 服务直调：不传 note ⇒ 冻结现状 ───────────────────────────────
test('N2 setStatus 不传 note ⇒ 原有记录保留（不被清空）', async () => {
  await withApp(async ({ evolve, raw }) => {
    const rec = await evolve.setStatus('p-a', 'approved');
    assert.equal(rec.note, HUMAN_NOTE,
      '只改状态不该抹掉上一轮的人写记录 —— note 与 blocker 同一冻结语义');
    assert.equal(raw.get('p-a').note, HUMAN_NOTE, '落盘的行也必须保住');
  }, [seedRow({ id: 'p-a', note: HUMAN_NOTE })]);
});

test('N3 setStatus 传 undefined ⇒ 同 N2（默认参数不得把 undefined 变成删除指令）', async () => {
  await withApp(async ({ evolve }) => {
    const rec = await evolve.setStatus('p-a', 'approved', undefined);
    assert.equal(rec.note, HUMAN_NOTE);
  }, [seedRow({ id: 'p-a', note: HUMAN_NOTE })]);
});

test('N4 setStatus 传 null ⇒ 同 N2（null 也不该被当成清空）', async () => {
  await withApp(async ({ evolve }) => {
    const rec = await evolve.setStatus('p-a', 'approved', null);
    assert.equal(rec.note, HUMAN_NOTE, 'null 与 undefined 同义：都不是「我要清空」');
  }, [seedRow({ id: 'p-a', note: HUMAN_NOTE })]);
});

// ── N5 显式清空仍然可行（否则等于把「能删」这件事弄丢了）────────────
test('N5 setStatus 传空串 ⇒ 显式清除（要清就得说清）', async () => {
  await withApp(async ({ evolve, raw }) => {
    const rec = await evolve.setStatus('p-a', 'approved', '');
    assert.equal(rec.note, '', '空串是显式指令：清除');
    assert.equal(raw.get('p-a').note, '');
  }, [seedRow({ id: 'p-a', note: HUMAN_NOTE })]);
});

test('N6 setStatus 传新内容 ⇒ 覆盖', async () => {
  await withApp(async ({ evolve }) => {
    const rec = await evolve.setStatus('p-a', 'rejected', '换一个理由');
    assert.equal(rec.note, '换一个理由');
  }, [seedRow({ id: 'p-a', note: HUMAN_NOTE })]);
});

// ── N7 工具入口：模型不带 note 是最常见的真实形态 ────────────────────
test('N7 evolve_set_status 不带 note ⇒ 原有记录保留（工具不伪造空串）', async () => {
  await withApp(async ({ ctx, evolve, raw }) => {
    ctx['agint.evolve'] = evolve;
    applyTools(ctx);
    const tool = ctx._registered.find((t) => t.name === 'evolve_set_status');
    assert.ok(tool, 'evolve_set_status 未注册');
    await tool.execute({ id: 'p-a', status: 'approved' });
    assert.equal(raw.get('p-a').note, HUMAN_NOTE,
      '模型只改状态时，上一轮的人工记录必须还在');
  }, [seedRow({ id: 'p-a', note: HUMAN_NOTE })]);
});

test('N8 evolve_set_status 带 note ⇒ 照常覆盖（修复不能把写入口堵死）', async () => {
  await withApp(async ({ ctx, evolve, raw }) => {
    ctx['agint.evolve'] = evolve;
    applyTools(ctx);
    const tool = ctx._registered.find((t) => t.name === 'evolve_set_status');
    await tool.execute({ id: 'p-a', status: 'rejected', note: '证据不足，重来' });
    assert.equal(raw.get('p-a').note, '证据不足，重来');
  }, [seedRow({ id: 'p-a', note: HUMAN_NOTE })]);
});

// ── N9 空白串边界：' ' 不是「没传」也不是「清空」的合法替身 ──────────
test('N9 只含空白的 note 不被当成清除指令（避免误删的真源头）', async () => {
  await withApp(async ({ evolve }) => {
    const rec = await evolve.setStatus('p-a', 'approved', '   ');
    assert.equal(rec.note.trim(), '',
      '传空白 = 显式要求空内容，可以接受；但不能静默变成上一行原值混淆');
  }, [seedRow({ id: 'p-a', note: HUMAN_NOTE })]);
});

// ── N10 applied 路径的交互：解除阻塞会把原阻塞写进 note，不能覆盖记录 ──
test('N10 applied 且不传 note ⇒ 原记录保留，阻塞原因**追加**在后面', async () => {
  await withApp(async ({ evolve }) => {
    const rec = await evolve.setStatus('p-a', 'applied', undefined, {});
    // 期望值不是「原样」而是「原样 + 追加」：applied 解阻塞时把原阻塞原因转写进
    // note 是既有设计（applyStatus 里 `解除阻塞（原：…）` 那段），是为了「不许静默丢」。
    // 修复要保证的是**人写记录还在**，而不是禁止追加 —— 这两件事必须分开钉。
    assert.equal(
      rec.note,
      `${HUMAN_NOTE} ｜ 解除阻塞（原：等 8-12 周样本）`,
      '人写记录必须在前、原阻塞痕迹追加在后；两者都不得丢失',
    );
    assert.ok(rec.note.startsWith(HUMAN_NOTE), '人写记录必须是开头那段，不能被覆盖或截断');
    assert.equal(rec.blocker, '', 'applied 即解除阻塞');
  }, [seedRow({ id: 'p-a', note: HUMAN_NOTE, status: 'approved', blocker: '等 8-12 周样本' })]);
});
