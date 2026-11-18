/**
 * agint-rules: 规则引擎自保护（提案「护住规则引擎自身」A1/A2/A3，2026-11-17 落地）
 *
 * Run: node --test plugins/agint-rules/test/self-protection.test.mjs
 *
 * 起因（实测取证）：rule_check(rule_set_enabled, {id, enabled:false}) → NO_MATCH；
 *   rule_list 实况里无一条规则覆盖 rule_add / rule_remove / rule_set_enabled
 *   ⇒ 被门禁约束的 agent 可以把 deny 规则关掉 —— 看守自己的锁由被看守者拆。
 *
 * 这组断言锁两件事：
 *   1. 补种口径 —— seedIfEmpty 原本「规则表非空就 return」⇒ 老装机永远拿不到
 *      这三条自保护规则（写在代码里的门禁形同虚设）。现在必须**无条件**补种。
 *   2. 幂等口径 —— 重复 boot 不重复播种；被停用的自保护规则会被重新启用。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';

const SELF_PROTECTION_IDS = [
  'rule-disable-forbidden',
  'rule-remove-needs-human',
  'rule-add-reason-needs-human',
];

function makeStore() {
  const tables = new Map();
  const domain = {
    async table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const rows = tables.get(name);
      return {
        get: (id) => rows.get(id),
        put: async (id, value) => { rows.set(id, value); },
        delete: async (id) => rows.delete(id),
        entries: () => [...rows.entries()],
        get size() { return rows.size; },
      };
    },
    async close() {},
  };
  const storageDomain = { async open() { return domain; } };
  return { tables, storageDomain };
}

function boot(store) {
  const provided = new Map();
  const ctx = {
    get: (k) => provided.get(k) ?? null,
    provide: (k, v) => { provided.set(k, v); },
    effect: () => () => {},
    on: () => () => {},
    storageDomain: store.storageDomain,
    logger: { warn: () => {}, error: () => {} },
  };
  apply(ctx, {});
  const rules = ctx.get('agint.rules');
  assert.ok(rules, 'agint.rules 服务未注册 —— 下面的用例全是空转');
  return { rules, ctx };
}

const EXISTING_RULE = {
  id: 'legacy-rule',
  tool: 'bash',
  pattern: 'npm\\s+publish',
  flags: '',
  action: 'advisory',
  level: 'L2',
  reason: '老装机已存在的规则',
};

test('规则表非空时仍无条件补种三条自保护规则（老装机也拿得到）', async () => {
  const store = makeStore();
  const { rules } = boot(store);
  await rules.list({});
  await rules.add(EXISTING_RULE);

  const r = await rules.seedIfEmpty();
  assert.equal(r.guardAdded, 3, '非空表上没有补种自保护规则 —— 写在代码里的门禁形同虚设');
  assert.equal(r.seeded, false, '非空表上不该走整表播种路径');

  for (const id of SELF_PROTECTION_IDS) {
    const rec = await rules.get(id);
    assert.ok(rec, `自保护规则没补上：${id}`);
    assert.equal(rec.enabled, true);
  }
  // 三条的档位：一条 deny（禁止停用）、两条 ask（删除/新增需人工确认）
  const byId = {};
  for (const id of SELF_PROTECTION_IDS) byId[id] = await rules.get(id);
  assert.equal(byId['rule-disable-forbidden'].action, 'deny');
  assert.equal(byId['rule-remove-needs-human'].action, 'ask');
  assert.equal(byId['rule-add-reason-needs-human'].action, 'ask');
});

test('重复播种幂等：第二次 boot 不重复补种', async () => {
  const store = makeStore();
  const { rules } = boot(store);
  await rules.list({});
  await rules.add(EXISTING_RULE);
  await rules.seedIfEmpty();
  const again = await rules.seedIfEmpty();
  assert.equal(again.guardAdded, 0, '第二次播种又补了一遍 —— 会被 lint 判成 duplicate-pattern');
});

test('被停用的自保护规则会被重新启用（停用自保护正是要堵的失效形态）', async () => {
  const store = makeStore();
  const { rules } = boot(store);
  await rules.list({});
  await rules.add(EXISTING_RULE);
  await rules.seedIfEmpty();

  // 绕过引擎直接改存储层，把自保护规则停用（模拟存量被关掉的装机）
  const rows = store.tables.get('rule');
  const rec = rows.get('rule-disable-forbidden');
  rows.set('rule-disable-forbidden', { ...rec, enabled: false });

  const r = await rules.seedIfEmpty();
  assert.equal(r.guardHealed, 1, '停用的自保护规则没被重新启用');
  assert.equal((await rules.get('rule-disable-forbidden')).enabled, true);
});

test('已有等价规则时跳过补种（同 tool + 同 action + 同 pattern 不重复播种）', async () => {
  const store = makeStore();
  const { rules } = boot(store);
  await rules.list({});
  await rules.add(EXISTING_RULE);
  await rules.add({
    id: 'my-own-disable-guard',
    tool: 'rule_set_enabled',
    pattern: '"enabled":false',
    flags: '',
    action: 'deny',
    level: 'L1',
    reason: '我自己写的等价规则',
  });

  const r = await rules.seedIfEmpty();
  assert.equal(r.guardAdded, 2, '等价规则已存在却仍补种了 —— 会撞 duplicate-pattern');
  assert.equal(await rules.get('rule-disable-forbidden'), null, '被覆盖的那条不该补');
});

test('lint() 不把补种后的自保护规则判成 duplicate-pattern', async () => {
  const store = makeStore();
  const { rules } = boot(store);
  await rules.list({});
  await rules.add(EXISTING_RULE);
  await rules.seedIfEmpty();

  const issues = await rules.lint();
  const dup = issues.filter((i) => i.kind === 'duplicate-pattern');
  assert.equal(dup.length, 0, `lint 误报：${JSON.stringify(dup)}`);
});
