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

  // 10. storage domain 已注册 baseline_history + proposal 两张表
  assert.ok(ctx._tables.has('baseline_history'), 'baseline_history 表存在');
  assert.ok(ctx._tables.has('proposal'), 'proposal 表存在');
  assert.equal(ctx._tables.get('baseline_history').size, 2, '2 行 baseline_history');

  await rm(root, { recursive: true, force: true });
  console.log(`agint-evolve smoke: ok (baselineGate / recordBaselineRun / listBaselineHistory / 兼容 v0.1.0)`);
}

main().catch((err) => {
  console.error('agint-evolve smoke FAIL:', err);
  process.exit(1);
});
