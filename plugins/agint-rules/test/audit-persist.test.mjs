/**
 * agint-rules: rule_audit 计数持久化回归（提案 09ae2017，2026-11-02）
 *
 * Run: node --test plugins/agint-rules/test/audit-persist.test.mjs
 *
 * 背景：计数原本只是 `lib/index.js` 里的一个内存 Map，dsh 重启即清零 ⇒
 *   「这条 ask 门禁历史上到底拦过多少次」永远答不出来（2026-09-07
 *   abtest_start 两次调用是否被 tools/pre-execute 拦过，回溯不到就是当时的
 *   实测卡点）。现在计数落进本域 `rule_audit` 表，启动时载回内存。
 *
 * 本文件锁死几组契约（每组都对着一个具体的失败方式）：
 *   1. spec 契约 —— version 仍为 1 且声明了 rule_audit 表。
 *      ⛔ 有人把 version 改成 2 ⇒ dsh-storage-json 的 parse() 抛
 *      version-mismatch ⇒ 整个 domain.open 失败 ⇒ 规则门禁全部消失，
 *      而且界面不报错。这条断言就是那道闸。
 *   2. 落库 —— 命中后 put 真写进 rule_audit（字段齐全）。
 *   3. 重启不清零 —— **同一份存储**起第二个实例，audit() 能看到上一次的数。
 *   4. 基线 + delta 合并 —— 新实例继续命中时是累加，不是把基线覆盖成 1。
 *   5. audit() 仍**同步** —— agint-metrics 读 `rules.audit().totals` 时不 await，
 *      改成 Promise 会让 rules.hits / adherencePct 静默变恒 0（K113 型坑）。
 *   6. 写盘失败不影响拦截 —— deny 判定不依赖存盘。
 *   7. 关闭时补写 —— 不显式 flush，disposer 也要把脏计数写完。
 *   8. 删规则不删历史 —— rule_audit 是账本，删规则不等于那段历史没发生。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';

/**
 * 假存储：`tables` 在多个插件实例之间**共享** —— 这就是「磁盘」。
 * 每个实例拿到的是同一份 Map，于是「重启」= 再 apply 一次。
 */
function makeStore() {
  const tables = new Map();   // tableName -> Map(key -> value)
  const state = { specSeen: null, writes: [], failPut: false };

  const domain = {
    async table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const rows = tables.get(name);
      return {
        get: (id) => rows.get(id),
        put: async (id, value) => {
          if (state.failPut) throw new Error('disk full (test)');
          state.writes.push({ table: name, id, value });
          rows.set(id, value);
        },
        delete: async (id) => rows.delete(id),
        entries: () => [...rows.entries()],
        get size() { return rows.size; },
      };
    },
    async close() {},
  };

  const storageDomain = {
    async open(spec) {
      state.specSeen = spec;
      return domain;
    },
  };

  return { tables, state, storageDomain };
}

/** 起一个插件实例（= 一次进程启动）。返回真服务、钩子、告警、disposer。 */
function boot(store) {
  const provided = new Map();
  const handlers = new Map();
  const warns = [];
  const disposers = [];
  const ctx = {
    get: (k) => provided.get(k) ?? null,
    provide: (k, v) => { provided.set(k, v); },
    effect: (fn) => {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
      return () => {};
    },
    on: (event, handler) => { handlers.set(event, handler); return () => {}; },
    storageDomain: store.storageDomain,
    logger: { warn: (msg, extra) => warns.push({ msg, extra }), error: () => {} },
  };
  apply(ctx, {});
  const rules = ctx.get('agint.rules');
  assert.ok(rules, 'agint.rules 服务未注册 —— 下面的用例全是空转');
  return { rules, handlers, warns, disposers, ctx };
}

const DENY_RULE = {
  id: 'deny-persist-test',
  tool: 'bash',
  pattern: 'rm\\s+-rf\\s+/',
  flags: '',
  action: 'deny',
  level: 'L1',
  reason: '测试用：禁止删根',
};

/** 走真 pre-execute 钩子命中一次 deny */
async function fireDeny(handlers) {
  const hook = handlers.get('tools/pre-execute');
  assert.ok(hook, '没有捕获到 tools/pre-execute 钩子');
  return hook({ name: 'bash', arguments: { command: 'rm -rf /' } }, async () => ({ kind: 'accept' }));
}

/** 等服务 ready（ready 链里含基线载入；list() 会 await 它） */
async function settled(rules) {
  await rules.list({});
}

/** 轮询等某条审计行出现在「磁盘」上（最多 500ms） */
async function waitForRow(store, ruleId, ms = 500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const row = store.tables.get('rule_audit')?.get(ruleId);
    if (row) return row;
    await new Promise((r) => setTimeout(r, 5));
  }
  return null;
}

// ───────────────────── 1. spec 契约 ─────────────────────

test('spec：version 仍为 1，且声明了 rule_audit 表（升版本会打挂存量存储）', async () => {
  const store = makeStore();
  const { rules } = boot(store);
  await settled(rules);

  assert.equal(store.state.specSeen.name, 'agint_rules');
  assert.equal(
    store.state.specSeen.version, 1,
    'agint_rules 域版本被改了 —— 存量 agint_rules.json 是 version 1，'
    + 'version-mismatch 会让整个 domain.open 失败、规则门禁全部消失',
  );
  assert.deepEqual(
    Object.keys(store.state.specSeen.tables).sort(),
    ['rule', 'rule_audit'],
    'rule_audit 表没声明，或表名被改',
  );
});

// ───────────────────── 2. 落库 ─────────────────────

test('命中后计数真写进 rule_audit（hits/denies/lastHitAt 齐全）', async () => {
  const store = makeStore();
  const { rules, handlers } = boot(store);
  await settled(rules);
  await rules.add(DENY_RULE);

  const verdict = await fireDeny(handlers);
  assert.equal(verdict.kind, 'deny', '前提不成立：钩子没给出 deny');
  await rules._flushAudit();

  const rows = store.tables.get('rule_audit');
  assert.ok(rows, 'rule_audit 表没被创建');
  const row = rows.get(DENY_RULE.id);
  assert.ok(row, '计数没有落库 —— 重启后必然归零');
  assert.equal(row.hits, 1);
  assert.equal(row.denies, 1);
  assert.equal(row.asks, 0);
  assert.equal(row.epistemics, 0);
  assert.equal(typeof row.lastHitAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(row.lastHitAt)), `lastHitAt 不是合法时间：${row.lastHitAt}`);
  assert.equal(row.firstHitAt, row.lastHitAt, '首次命中时 firstHitAt 应等于 lastHitAt');
  // 落库行必须只含 schema 声明的键（脏值会在下一次 open 时变成 invalid-record
  // ⇒ 整个 domain 打不开 ⇒ 规则门禁全消失）
  assert.deepEqual(
    Object.keys(row).sort(),
    ['advisories', 'asks', 'denies', 'epistemics', 'firstHitAt', 'hits', 'lastHitAt'],
  );
});

// ───────────────────── 2b. 自动落库（不显式 flush） ─────────────────────

test('命中后**无需**显式 flush 也会自动落库（微任务合并）', async () => {
  // 这条锁的是 bump() 末尾那次 queueFlush()。少了它，生产上只有「优雅关闭」
  // 会补写；一旦进程被硬杀 / 崩溃，整段历史就没了 —— 而那正是本提案要解决的场景。
  const store = makeStore();
  const { rules, handlers } = boot(store);
  await settled(rules);
  await rules.add(DENY_RULE);

  await fireDeny(handlers);
  // 不调 _flushAudit，不跑 disposer，只等自己的微任务窗口
  const row = await waitForRow(store, DENY_RULE.id);
  assert.ok(row, 'bump 之后没有自动落库 —— 进程硬杀就会丢掉这段历史');
  assert.equal(row.hits, 1);
});

// ───────────────────── 3. 重启不清零 ─────────────────────

test('重启不清零：同一份存储起第二个实例，audit() 看得到上一次的计数', async () => {
  const store = makeStore();

  const first = boot(store);
  await settled(first.rules);
  await first.rules.add(DENY_RULE);
  await fireDeny(first.handlers);
  await first.rules._flushAudit();
  const beforeRestart = first.rules.audit();
  assert.equal(beforeRestart.totals.hits, 1, '前提不成立：重启前就没有计数');

  // 「重启」= 新实例，存储不动
  const second = boot(store);
  await settled(second.rules);

  const after = second.rules.audit();
  assert.equal(after.totals.hits, 1, `重启后 hits=${after.totals.hits} —— 计数清零了`);
  assert.equal(after.totals.denies, 1);
  const row = after.rules.find((r) => r.ruleId === DENY_RULE.id);
  assert.ok(row, '重启后 audit 里没有这条规则');
  assert.equal(row.hits, 1);
  assert.equal(typeof row.lastHitAt, 'string', '重启后丢了 lastHitAt');
});

// ───────────────────── 4. 基线 + delta 合并 ─────────────────────

test('新实例继续命中是累加，不是把基线覆盖成 1', async () => {
  const store = makeStore();

  const first = boot(store);
  await settled(first.rules);
  await first.rules.add(DENY_RULE);
  await fireDeny(first.handlers);
  await first.rules._flushAudit();

  const second = boot(store);
  await settled(second.rules);
  await fireDeny(second.handlers);
  await second.rules._flushAudit();

  const after = second.rules.audit();
  assert.equal(after.totals.hits, 2, `两次命中后 hits=${after.totals.hits}，应为 2`);
  assert.equal(store.tables.get('rule_audit').get(DENY_RULE.id).hits, 2, '落库值被覆盖成 1');
});

// ───────────────────── 5. audit() 保持同步 ─────────────────────

test('audit() 仍是同步返回（否则 agint-metrics 会静默变恒 0）', async () => {
  const store = makeStore();
  const { rules } = boot(store);
  await settled(rules);

  const value = rules.audit();
  assert.equal(
    typeof value?.then, 'undefined',
    'audit() 变成 Promise 了 —— agint-metrics 的 `rules.audit().totals` 不 await，'
    + 'rules.hits / rules.adherencePct 会静默变成恒 0',
  );
  assert.equal(typeof value.totals.hits, 'number');
  assert.equal(typeof value.totals.epistemics, 'number');
});

// ───────────────────── 6. 写失败不影响拦截 ─────────────────────

test('落库失败只告警：deny 判定照旧，计数在内存里照旧累加', async () => {
  const store = makeStore();
  const { rules, handlers, warns } = boot(store);
  await settled(rules);
  await rules.add(DENY_RULE);

  store.state.failPut = true;
  const verdict = await fireDeny(handlers);
  assert.equal(verdict.kind, 'deny', '存盘失败把拦截结果带崩了（不可接受）');
  assert.match(verdict.reason, /deny-persist-test/);

  await rules._flushAudit();
  assert.ok(
    warns.some((w) => /audit persist failed/.test(w.msg)),
    `落库失败没有告警：${JSON.stringify(warns)}`,
  );
  assert.equal(rules.audit().totals.hits, 1, '内存计数被存盘失败带崩了');

  // 恢复后下一次 flush 要把脏行补上（不是永久丢失）
  store.state.failPut = false;
  await rules._flushAudit();
  assert.equal(store.tables.get('rule_audit')?.get(DENY_RULE.id)?.hits, 1, '恢复后脏行没有补写');
});

// ───────────────────── 7. 关闭时补写 ─────────────────────

test('不显式 flush，关闭时的 disposer 也把脏计数写完', async () => {
  const store = makeStore();
  const first = boot(store);
  await settled(first.rules);
  await first.rules.add(DENY_RULE);
  await fireDeny(first.handlers);

  // 只等微任务窗口过去还不够 —— 这里**故意**不调 _flushAudit
  await Promise.resolve();
  await first.disposers[0]();

  const row = store.tables.get('rule_audit')?.get(DENY_RULE.id);
  assert.ok(row, '关闭时没补写计数 —— 每次退出都会丢最后一段历史');
  assert.equal(row.hits, 1);
});

// ───────────────────── 8. 删规则不删历史 ─────────────────────

test('rule_remove 不删计数：历史账本与规则表分开', async () => {
  const store = makeStore();
  const { rules, handlers } = boot(store);
  await settled(rules);
  await rules.add(DENY_RULE);
  await fireDeny(handlers);
  await rules._flushAudit();

  await rules.remove(DENY_RULE.id);
  const still = rules.audit().rules.find((r) => r.ruleId === DENY_RULE.id);
  assert.ok(still, '删规则把历史计数也删了');
  assert.equal(still.hits, 1);
  assert.equal(store.tables.get('rule_audit').get(DENY_RULE.id).hits, 1);

  // 再重启一次，历史仍在（内存与存储的口径必须一致）
  const again = boot(store);
  await settled(again.rules);
  assert.ok(again.rules.audit().rules.some((r) => r.ruleId === DENY_RULE.id && r.hits === 1));
});
