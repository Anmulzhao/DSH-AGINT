// plugin 目标枚举测试（0.3.5，老板 2026-10-14 拍板方案 2：plugin + skill 都评）。
//
// 背景（2026-10-14 实测）：weekly 路径走 enumerateTargets()，它此前只扫技能
//   目录、且只收名字含 'agint' 的技能 ⇒ 本机只枚举到 1 个
//   （$DSH_HOME/skills 6 个目录含 agint 的 0；
//    .agent-presets/agint/skills 10 个目录含 agint 的 1）
//   ⇒ quality_eval_run_now 返回 evaluated=1，与「9 个 core plugin」口径不符。
//
// ⛔ 纪律（Playbook §3.5）：mock 复刻真实契约。ctx.loader.entries() 的真实形状是
//   **迭代器不是数组**（agint-mascot v0.1.1 踩过：Array.isArray 会把健康宿主
//   读成 warn），id 在 entry.options.id、fallback entry.id。这里全按真实形状造。

import test from 'node:test';
import assert from 'node:assert/strict';
import { enumeratePluginTargets } from '../lib/plugin-targets.js';

/** 造真实 loader 形状：entries() 返回迭代器（不是数组）。 */
function makeLoader(entries) {
  return {
    loader: {
      entries() {
        // 真实宿主返回迭代器 —— 这里用 generator 复刻，不用数组
        return (function* () {
          for (const e of entries) yield e;
        })();
      },
    },
  };
}

function pluginEntry(id, opts = {}) {
  return { options: { id, ...opts }, disabled: false, fiber: { state: 2 } };
}

test('取证：真实形状下能枚举出 plugin 目标（迭代器 + options.id）', () => {
  const ctx = makeLoader([
    pluginEntry('agint-memory'),
    pluginEntry('agint-rules'),
    pluginEntry('agint-wiki'),
  ]);
  const { targets, reason } = enumeratePluginTargets(ctx, 'agint-', 'agint-quality-eval');
  assert.equal(reason, null, `不应降级，实得 reason=${reason}`);
  assert.deepEqual(
    targets.map((t) => t.id).sort(),
    ['agint-memory', 'agint-rules', 'agint-wiki'],
  );
  assert.ok(targets.every((t) => t.kind === 'plugin'));
});

test('⛔ entries() 是迭代器不是数组：用 Array.isArray 判形状会误判（先例 mascot v0.1.1）', () => {
  const ctx = makeLoader([pluginEntry('agint-cron')]);
  const raw = ctx.loader.entries();
  assert.equal(Array.isArray(raw), false, '真实 entries() 不是数组 —— 测试不得假设它是');
  const { targets } = enumeratePluginTargets(ctx, 'agint-', null);
  assert.equal(targets.length, 1, '即便不是数组也必须能枚举出来');
});

test('id 取 options.id，缺 options 时 fallback entry.id', () => {
  const ctx = makeLoader([
    { options: { id: 'agint-a' } },
    { id: 'agint-b' },            // 无 options
    { options: {} },               // 无 id ⇒ 跳过
  ]);
  const { targets } = enumeratePluginTargets(ctx, 'agint-', null);
  assert.deepEqual(targets.map((t) => t.id).sort(), ['agint-a', 'agint-b']);
});

test('命名空间过滤：非 agint- 前缀的宿主 plugin 不进评估池', () => {
  const ctx = makeLoader([
    pluginEntry('agint-memory'),
    pluginEntry('dsh-tool-bash'),
    pluginEntry('dsh-web'),
  ]);
  const { targets } = enumeratePluginTargets(ctx, 'agint-', null);
  assert.deepEqual(targets.map((t) => t.id), ['agint-memory']);
});

test('显式 disabled 的 plugin 不评估（它没在跑）', () => {
  const ctx = makeLoader([
    pluginEntry('agint-a'),
    { options: { id: 'agint-b' }, disabled: true },
  ]);
  const { targets } = enumeratePluginTargets(ctx, 'agint-', null);
  assert.deepEqual(targets.map((t) => t.id), ['agint-a']);
});

test('⛔ 自评排除：枚举层就剔掉 selfId，不产"拒绝自评"的失败记录', () => {
  const ctx = makeLoader([
    pluginEntry('agint-memory'),
    pluginEntry('agint-quality-eval'),   // 自己
  ]);
  const { targets } = enumeratePluginTargets(ctx, 'agint-', 'agint-quality-eval');
  assert.deepEqual(targets.map((t) => t.id), ['agint-memory']);
});

test('去重：同名 id 只收一次', () => {
  const ctx = makeLoader([
    pluginEntry('agint-a'),
    pluginEntry('agint-a'),
  ]);
  const { targets } = enumeratePluginTargets(ctx, 'agint-', null);
  assert.equal(targets.length, 1);
});

test('⛔ 读不到要出声：loader 缺失 ⇒ 空数组 + reason，不是静默 0', () => {
  const r1 = enumeratePluginTargets({}, 'agint-', null);
  assert.deepEqual(r1.targets, []);
  assert.equal(r1.reason, 'loader-unavailable');

  const r2 = enumeratePluginTargets({ loader: {} }, 'agint-', null);
  assert.equal(r2.reason, 'loader-unavailable');
});

test('⛔ 读不到要出声：entries() 抛错 ⇒ reason=loader-threw', () => {
  const ctx = {
    loader: {
      entries() { throw new Error('boom'); },
    },
  };
  const r = enumeratePluginTargets(ctx, 'agint-', null);
  assert.deepEqual(r.targets, []);
  assert.match(r.reason, /^loader-threw:/);
});

test('⛔ 读不到要出声：entries() 返回非集合 ⇒ reason=loader-entries-not-iterable', () => {
  const ctx = { loader: { entries: () => 42 } };
  const r = enumeratePluginTargets(ctx, 'agint-', null);
  assert.deepEqual(r.targets, []);
  assert.equal(r.reason, 'loader-entries-not-iterable');
});

test('空名册 ⇒ 空数组 + reason=null（空是真空，不是读不到）', () => {
  const r = enumeratePluginTargets(makeLoader([]), 'agint-', null);
  assert.deepEqual(r.targets, []);
  assert.equal(r.reason, null, '空名册与读不到必须可区分');
});
