// agint-evolve smoke: 一行可跑的最小验证（node test/smoke.mjs → 退出码 0）。
// Sprint 12 B3：覆盖 baselineGate / recordBaselineRun / listBaselineHistory
// + storage domain schemaVersion=2 + baseline_history 表可读写。
//
// 用最小 mock ctx（不依赖 dsh 运行时），与 driver.js makeMockStorageDomain 同型。

import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

function makeMockCtx() {
  const tables = new Map(); // tableName → Map<id, value>
  return {
    storageDomain: {
      async open(spec) {
        return {
          name: spec.name,
          version: spec.version,
          table(name) {
            let t = tables.get(name);
            if (!t) { t = new Map(); tables.set(name, t); }
            return {
              get: (id) => t.get(id) ?? null,
              put: async (id, value) => { t.set(id, value); return true; },
              delete: async (id) => t.delete(id),
              entries: () => [...t.entries()],
            };
          },
          async close() {},
        };
      },
    },
    _tables: tables,
    _effects: [],
    _provides: new Map(),
    effect(fn) { this._effects.push(fn()); },
    provide(k, v) { this._provides.set(k, v); },
    get(k) { return this._provides.get(k) ?? null; },
    on() {},
    setInterval() { return { dispose() {} }; },
  };
}

async function main() {
  // reviews root：临时目录，避免污染用户 reviews/
  const root = await mkdtemp(join(tmpdir(), 'agint-evolve-smoke-'));

  const ctx = makeMockCtx();
  apply(ctx, { root });
  const evo = ctx.get('agint.evolve');
  assert.ok(evo, 'agint.evolve 服务已注册');

  // 1. baselineGate 空数据 → frozen=false, lastRunAt=null, source='empty'
  const empty = await evo.baselineGate('mount');
  assert.equal(empty.frozen, false, '空数据 frozen=false');
  assert.equal(empty.lastRunAt, null, '空数据 lastRunAt=null');
  assert.equal(empty.source, 'empty', '空数据 source=empty');
  assert.equal(empty.since, null, '空数据 since=null');

  // 2. recordBaselineRun 写一行（passRate=1.0 → frozen=false）
  const r1 = await evo.recordBaselineRun({
    channel: 'mount',
    passRate: 1.0,
    passed: 12,
    total: 12,
  });
  assert.equal(r1.channel, 'mount');
  assert.equal(r1.passRate, 1.0);
  assert.equal(r1.frozen, false);
  assert.equal(r1.id, r1.ranAt, 'id === ranAt (毫秒级 ISO)');

  // 3. baselineGate 读到 r1 → frozen=false
  const gate1 = await evo.baselineGate('mount');
  assert.equal(gate1.frozen, false);
  assert.equal(gate1.lastRunAt, r1.ranAt);
  assert.equal(gate1.source, 'cron:baseline-regression-suite');

  // 4. recordBaselineRun 写第二行（passRate=0.5 < 0.95 → frozen=true）
  const r2 = await evo.recordBaselineRun({
    channel: 'mount',
    passRate: 0.5,
    passed: 5,
    total: 10,
  });
  assert.equal(r2.frozen, true, 'passRate<0.95 触发 frozen=true');

  // 5. baselineGate 默认返回最近一行（r2）
  const gate2 = await evo.baselineGate('mount');
  assert.equal(gate2.frozen, true);
  assert.equal(gate2.lastRunAt, r2.ranAt);

  // 6. baselineGate since 过滤
  const gate3 = await evo.baselineGate('mount', { since: r1.ranAt });
  assert.ok(gate3.lastRunAt >= r1.ranAt, 'since 过滤生效');
  // r1 自身等于 since 边界，> 才取（>），因此 gate3 应是 r2
  assert.equal(gate3.lastRunAt, r2.ranAt);

  // 7. baselineGate channel 过滤（不存在的 channel）
  const gate4 = await evo.baselineGate('nonexistent');
  assert.equal(gate4.frozen, false);
  assert.equal(gate4.source, 'empty');

  // 8. listBaselineHistory 倒序
  const all = await evo.listBaselineHistory({ channel: 'mount' });
  assert.equal(all.length, 2);
  assert.equal(all[0].ranAt, r2.ranAt, '倒序：最新在前');
  assert.equal(all[1].ranAt, r1.ranAt);

  // 9. 既有 propose / listProposals 仍可用（兼容 v0.1.0）
  const p = await evo.propose({ title: 't', body: 'b' });
  assert.ok(p.id);
  const list = await evo.listProposals();
  assert.equal(list.length, 1);

  // 9b. 2026-10-27：approved 可以带 blocker（批准的是方向，不是「现在能动手」）
  assert.equal(list[0].blocker, '', '新建提案 blocker 归一为空串，不是 undefined');
  assert.equal(list[0].unblockCondition, '');
  const blocked = await evo.setStatus(p.id, 'approved', '批方向', {
    blocker: '等 8-12 周人工标注样本', unblockCondition: '样本 ≥8 周且人工标注覆盖',
  });
  assert.equal(blocked.status, 'approved');
  assert.equal(blocked.blocker, '等 8-12 周人工标注样本');
  assert.equal(blocked.unblockCondition, '样本 ≥8 周且人工标注覆盖');
  assert.equal((await evo.listProposals({ blocked: true })).length, 1, 'blocked=true 只挑阻塞的');
  assert.equal((await evo.listProposals({ blocked: false })).length, 0);

  // 9c. 不传 blocker = 冻结原值（改状态不能把上次写的阻塞原因洗掉）
  const kept = await evo.setStatus(p.id, 'approved', '只改理由');
  assert.equal(kept.blocker, '等 8-12 周人工标注样本', '⛔ 不传 blocker 必须保持原值，不许静默清空');

  // 9d. 落地即解除阻塞，但原原因要转写进 note（不静默丢证据）
  const applied = await evo.setStatus(p.id, 'applied', '已在 X 落地');
  assert.equal(applied.blocker, '', 'applied 同时挂 blocker 是自相矛盾');
  assert.equal(applied.unblockCondition, '');
  assert.match(applied.note, /解除阻塞（原：等 8-12 周人工标注样本）/, '原阻塞原因转写进 note');

  // 9e. 历史行（加字段前写入，没有这两个键）读出来必须归一成空串
  const raw = ctx._tables.get('proposal');
  raw.set('legacy', { id: 'legacy', title: '老行', body: 'b', category: 'other', status: 'approved', source: '', note: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  const legacy = await evo.getProposal('legacy');
  assert.equal(legacy.blocker, '', '⛔ 字段缺席 ≠ 阻塞原因未知，一律归一为空串');
  assert.equal(legacy.unblockCondition, '');

  // 10. storage domain 已注册 baseline_history + proposal 两张表
  assert.ok(ctx._tables.has('baseline_history'), 'baseline_history 表存在');
  assert.ok(ctx._tables.has('proposal'), 'proposal 表存在');
  assert.equal(ctx._tables.get('baseline_history').size, 2, '2 行 baseline_history');

  // 11. 路径纪律（permissions.fs 的 fixture 面）—— clean() 三道闸各打一发。
  //     补这一组是为了消掉 plugin-check「permissions.fs 非空但 smoke 缺跨平台 fixture」
  //     的长期 WARN：声明了 read:plugins / write:reviews，就得有用例证明路径不被带出去。
  // 11a. 正向：正斜杠相对路径可读（Windows 反斜杠归一化那次的回归面）
  await writeFile(join(root, 'ok.md'), '# ok\n', 'utf8');
  const okRead = await evo.readReview('ok.md');
  assert.equal(okRead?.content, '# ok\n', '正斜杠相对路径必须可读');

  // 11b. 负向：`../` 逃逸必须被拒（归一化不能削弱安全）
  await assert.rejects(
    () => evo.readReview('../../etc/passwd.md'),
    /escapes root/,
    '⛔ ../ 逃逸必须抛 escapes root —— 归一化的目的不是放宽边界',
  );

  // 11c. 绝对路径：前导 / 被剥掉后回归 root 内的真实路径 ⇒ 读得到，
  //      且返回体的 path 必须是相对 root 的路径（不把盘符路径带回模型侧）。
  //      2026-11-08 更正（提案 e4f77535）：旧断言写 equal(absLike, null)，
  //      与它自己的文案「读得到但用相对路径寻址」矛盾 —— 错的是断言，不是实现。
  //      安全边界是「不许逃出 root」，不是「不许用绝对路径」。
  const absLike = await evo.readReview(`/${join(root, 'ok.md')}`);
  assert.equal(absLike?.content, '# ok\n', 'root 内的绝对路径应当读得到');
  assert.equal(absLike?.path, 'ok.md', '返回体必须用相对路径寻址，不泄漏盘符路径');

  // 11c-bis. 2026-11-11 Linux 回归：多个前导斜杠只能剥 1 个。
  //   旧实现 replace(/^\/+/,'') 把 `///tmp/root/ok.md` 剥成相对路径
  //   `tmp/root/ok.md`，resolve(root, ...) 得到 root/tmp/root/ok.md ⇒ 恒读不到。
  const multiSlash = await evo.readReview(`//${join(root, 'ok.md')}`);
  assert.equal(multiSlash?.content, '# ok\n', '多个前导斜杠仍须解析成 root 内的绝对路径');
  assert.equal(multiSlash?.path, 'ok.md', '多前导斜杠的返回体仍用相对路径寻址');

  // 11c-bis-neg. 多前导斜杠指向 root 外依旧必须被拒，证明修复没放宽边界。
  await assert.rejects(
    () => evo.readReview(`//${join(tmpdir(), 'agint-evolve-escape.md')}`),
    /escapes root/,
    '⛔ root 外的多前导斜杠绝对路径必须抛 escapes root',
  );

  // 11c-neg. 负控制：指向 root 外的绝对路径必须被拒，证明归一化没削弱边界。
  await assert.rejects(
    () => evo.readReview(`/${join(tmpdir(), 'agint-evolve-escape.md')}`),
    /escapes root/,
    '⛔ root 外的绝对路径必须抛 escapes root',
  );

  await rm(root, { recursive: true, force: true });
  console.log(`agint-evolve smoke: ok (baselineGate / recordBaselineRun / listBaselineHistory / 兼容 v0.1.0)`);
}

main().catch((err) => {
  console.error('agint-evolve smoke FAIL:', err);
  process.exit(1);
});
