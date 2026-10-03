// bin/lib/scenario-tier.test.mjs —— 三层隔离判据层的单测（Tier A，零外部依赖）
//
// ⛔ 红绿自证纪律：本文件每条判据都做过「把门临时放宽 ⇒ 测试立刻变红」的反向验证。
//    验证方法见文件末尾 `SELF_PROOF` 注释块（记录放宽了哪一行、红了哪几条）。
//    放宽后不红的测试等于没测 —— 那是「假防线」，比没有测试更糟。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TIER_VALUES,
  LABEL_AUTHORITY_VALUES,
  DEFAULT_TIER,
  H4_MIN_DOMAIN_UNITS,
  h1EvolutionMinFail,
  h3FrozenFailProbeCap,
  normalizeTierMap,
  assignTiers,
  selectVisible,
  assertNoLeak,
  frozenAggregateHash,
  summarizeTiers,
  domainRatio,
  checkTierAssignment,
} from './scenario-tier.mjs';

/** 造一条 unit。默认值即「最无趣的合法单元」。 */
function u(unitId, over = {}) {
  return {
    unitId,
    domain: 'quality',
    lastKnownStatus: 'PASS',
    contentHash: 'sha256:' + 'a'.repeat(64),
    visibility: 'EVOLUTION',
    labelAuthority: 'UNSET',
    ...over,
  };
}

// ── 枚举与默认值 ────────────────────────────────────────────────────────────
test('枚举封闭：三层三个值、标签四个值，顺序即可见性由宽到严', () => {
  assert.deepEqual([...TIER_VALUES], ['EVOLUTION', 'VALIDATION', 'FROZEN']);
  assert.deepEqual([...LABEL_AUTHORITY_VALUES], ['UNSET', 'SILVER', 'GOLD', 'HELDOUT']);
  assert.equal(DEFAULT_TIER, 'EVOLUTION', '默认层必须是最宽的那层（如实反映「当前全部可被进化访问」）');
});

test('H1/H3 是算术结果，不是写死的常数', () => {
  // 当前实测 fail = 5 ⇒ H1 下限 3、H3 上限 2（three-tier-quota.md §2.1）
  assert.equal(h1EvolutionMinFail(5), 3);
  assert.equal(h3FrozenFailProbeCap(5), 2);
  // fail 数变 12（设计原假设）⇒ 上限必须跟着重算，不许沿用 2
  assert.equal(h1EvolutionMinFail(12), 8);
  assert.equal(h3FrozenFailProbeCap(12), 4);
  // fail 数变 0 ⇒ 上下限都是 0，不得出现负数
  assert.equal(h3FrozenFailProbeCap(0), 0);
  assert.equal(h1EvolutionMinFail(0), 0);
});

// ── sidecar 解析 ────────────────────────────────────────────────────────────
test('sidecar 正常解析：124 条显式映射全收下', () => {
  const r = normalizeTierMap({
    tieringVersion: '1.0',
    units: {
      a: { visibility: 'FROZEN', labelAuthority: 'GOLD' },
      b: { visibility: 'EVOLUTION', labelAuthority: 'UNSET' },
    },
  });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.entries.size, 2);
  assert.deepEqual(r.entries.get('a'), { visibility: 'FROZEN', labelAuthority: 'GOLD' });
});

test('⛔ 非法 visibility 必须报错（枚举封闭）', () => {
  const r = normalizeTierMap({ tieringVersion: '1.0', units: { a: { visibility: 'frozen', labelAuthority: 'UNSET' } } });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /visibility/);
  assert.match(r.errors[0], /不在枚举/);
});

test('⛔ 非法 labelAuthority 必须报错（枚举封闭）', () => {
  const r = normalizeTierMap({ tieringVersion: '1.0', units: { a: { visibility: 'EVOLUTION', labelAuthority: 'gold' } } });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /labelAuthority/);
});

test('⛔ 版本不符必须报错（防止旧格式被静默接受）', () => {
  const r = normalizeTierMap({ tieringVersion: '9.9', units: {} });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /tieringVersion/);
});

test('⛔ 缺 units 段必须报错', () => {
  const r = normalizeTierMap({ tieringVersion: '1.0' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /缺少 units/);
});

// ── 缺失映射 ────────────────────────────────────────────────────────────────
test('⛔ 单元缺映射 ⇒ 硬错，不给默认值兜底', () => {
  const r = assignTiers([u('a'), u('b')], new Map([['a', { visibility: 'EVOLUTION', labelAuthority: 'UNSET' }]]));
  assert.equal(r.ok, false, '缺映射静默取默认 = 「缺失映射」这条判据永远绿');
  assert.match(r.errors[0], /b/);
  assert.match(r.errors[0], /没有映射条目/);
});

test('全部有映射 ⇒ 挂上两个字段且不改其他字段', () => {
  const entries = new Map([
    ['a', { visibility: 'FROZEN', labelAuthority: 'GOLD' }],
    ['b', { visibility: 'VALIDATION', labelAuthority: 'SILVER' }],
  ]);
  const r = assignTiers([u('a'), u('b')], entries);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.units[0].visibility, 'FROZEN');
  assert.equal(r.units[0].labelAuthority, 'GOLD');
  assert.equal(r.units[0].contentHash, 'sha256:' + 'a'.repeat(64), 'contentHash 不许被赋值流程改动');
});

// ── 读端门（三层隔离唯一真正起作用的地方）──────────────────────────────────
test('★ selectVisible 默认最严：不传 tier ⇒ 只看得见 Evolution', () => {
  const units = [u('a', { visibility: 'EVOLUTION' }), u('b', { visibility: 'FROZEN' }), u('c', { visibility: 'VALIDATION' })];
  assert.deepEqual(selectVisible(units).map((x) => x.unitId), ['a']);
  assert.deepEqual(selectVisible(units, undefined).map((x) => x.unitId), ['a']);
  assert.deepEqual(selectVisible(units, 'EVOLUTION').map((x) => x.unitId), ['a']);
});

test('★ selectVisible 传 ALL 才能看全部（宽视图必须显式请求）', () => {
  const units = [u('a'), u('b', { visibility: 'FROZEN' })];
  assert.equal(selectVisible(units, 'ALL').length, 2);
});

test('★ selectVisible 对非法层名 fail-closed（退回 EVOLUTION，不是退回 ALL）', () => {
  const units = [u('a'), u('b', { visibility: 'FROZEN' })];
  assert.deepEqual(selectVisible(units, 'NOPE').map((x) => x.unitId), ['a']);
});

test('★ assertNoLeak：混进别的层 ⇒ 报错并点名', () => {
  assert.deepEqual(assertNoLeak([u('a')], 'EVOLUTION'), []);
  const errs = assertNoLeak([u('a'), u('b', { visibility: 'FROZEN' })], 'EVOLUTION');
  assert.equal(errs.length, 1);
  assert.match(errs[0], /读端门漏出/);
  assert.match(errs[0], /b:FROZEN/);
});

test('★ assertNoLeak：层名非法 ⇒ 报错（否则「什么都查不出来」的调用会一路绿灯）', () => {
  const errs = assertNoLeak([u('a')], 'ALL');
  assert.equal(errs.length, 1);
  assert.match(errs[0], /不是合法层名/);
});

// ── Frozen 聚合 hash ────────────────────────────────────────────────────────
test('★ frozenAggregateHash 对 Frozen 集变化敏感（改一条 contentHash 即变）', () => {
  const h1 = frozenAggregateHash([u('a', { visibility: 'FROZEN' })]);
  const h2 = frozenAggregateHash([u('a', { visibility: 'FROZEN', contentHash: 'sha256:' + 'b'.repeat(64) })]);
  assert.notEqual(h1, h2, 'Frozen 单元内容变了而聚合 hash 不变 = 防篡改基线失效');
});

test('★ frozenAggregateHash 对「加入一条 Frozen」敏感', () => {
  const h1 = frozenAggregateHash([u('a', { visibility: 'FROZEN' })]);
  const h2 = frozenAggregateHash([u('a', { visibility: 'FROZEN' }), u('b', { visibility: 'FROZEN' })]);
  assert.notEqual(h1, h2);
});

test('★ frozenAggregateHash 对「非 Frozen 单元变化」不敏感（只锁冻结集）', () => {
  const h1 = frozenAggregateHash([u('a', { visibility: 'FROZEN' }), u('z')]);
  const h2 = frozenAggregateHash([u('a', { visibility: 'FROZEN' }), u('z', { contentHash: 'sha256:' + 'c'.repeat(64) })]);
  assert.equal(h1, h2);
});

test('★ frozenAggregateHash 对 labelAuthority 迁移不敏感（HELDOUT→GOLD 是合法降级）', () => {
  const h1 = frozenAggregateHash([u('a', { visibility: 'FROZEN', labelAuthority: 'HELDOUT' })]);
  const h2 = frozenAggregateHash([u('a', { visibility: 'FROZEN', labelAuthority: 'GOLD' })]);
  assert.equal(h1, h2, '合法的标签降级被算成篡改 = 假阳性');
});

test('空 Frozen 集也返回合法 hash（空集是事实，不是缺失）', () => {
  assert.match(frozenAggregateHash([u('a')]), /^sha256:[0-9a-f]{64}$/);
});

// ── summary 回写 ────────────────────────────────────────────────────────────
test('summarizeTiers：三层计数加总必须等于总数', () => {
  const units = [u('a'), u('b'), u('c', { visibility: 'FROZEN' }), u('d', { visibility: 'VALIDATION' })];
  const s = summarizeTiers(units);
  assert.equal(s.tierCounts.EVOLUTION, 2);
  assert.equal(s.tierCounts.FROZEN, 1);
  assert.equal(s.tierCounts.VALIDATION, 1);
  assert.equal(s.tierSum, 4, '三层计数加总 ≠ 总数 ⇒ 有单元层名非法');
  assert.deepEqual(s.unknownVisibility, []);
});

test('summarizeTiers：非法层名必须单独列出，不混进三层计数', () => {
  const s = summarizeTiers([u('a'), u('b', { visibility: 'FROZENN' })]);
  assert.equal(s.tierSum, 1);
  assert.deepEqual(s.unknownVisibility, ['FROZENN']);
});

test('★ quality 占比回写（配额 §3.2 单域主导风险的观测字段）', () => {
  const units = [u('a'), u('b'), u('c', { domain: 'dream' })];
  const r = domainRatio(units, 'quality');
  assert.equal(r.count, 2);
  assert.equal(r.total, 3);
  assert.ok(Math.abs(r.ratio - 2 / 3) < 1e-9);
});

test('domainRatio 空清单 ⇒ ratio 0，不得除零得到 NaN', () => {
  const r = domainRatio([], 'quality');
  assert.equal(r.ratio, 0);
});

// ── checkTierAssignment 判据 ────────────────────────────────────────────────
test('判据：全合法分配 ⇒ ok', () => {
  const r = checkTierAssignment({
    units: [
      u('f1', { lastKnownStatus: 'FAIL' }),
      u('f2', { lastKnownStatus: 'FAIL' }),
      u('f3', { lastKnownStatus: 'FAIL' }),
      u('fa', { lastKnownStatus: 'FAIL', visibility: 'FROZEN' }),
      u('fb', { lastKnownStatus: 'FAIL', visibility: 'FROZEN' }),
    ],
    previousFrozenIds: ['fa', 'fb'],
  });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.observed.failCount, 5);
  assert.equal(r.observed.h1EvolutionMinFail, 3);
  assert.equal(r.observed.h3FrozenFailProbeCap, 2);
});

test('★ H5：Frozen 集缩减 ⇒ 报错并点名被删的单元', () => {
  const r = checkTierAssignment({
    units: [u('fa', { visibility: 'FROZEN' }), u('b')],
    previousFrozenIds: ['fa', 'gone'],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /H5 违例/.test(e)), r.errors.join('; '));
  assert.ok(r.errors.some((e) => /gone/.test(e)));
});

test('★ H5：Frozen 集增长允许（只增不减，增是合法的）', () => {
  // quality 域凑够 4 条，避免被 H4 拦（H4 是另一条门，本条只验 H5）
  const r = checkTierAssignment({
    units: [u('fa', { visibility: 'FROZEN' }), u('fb', { visibility: 'FROZEN' }), u('q1'), u('q2')],
    previousFrozenIds: ['fa'],
  });
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('★ H3：Frozen 里的 fail 探针超过重算后的上限 ⇒ 报错', () => {
  // fail = 5 ⇒ 上限 2。放 3 个 fail 进 Frozen 即违例。
  const r = checkTierAssignment({
    units: [
      u('f1', { lastKnownStatus: 'FAIL', visibility: 'FROZEN' }),
      u('f2', { lastKnownStatus: 'FAIL', visibility: 'FROZEN' }),
      u('f3', { lastKnownStatus: 'FAIL', visibility: 'FROZEN' }),
      u('f4', { lastKnownStatus: 'FAIL' }),
      u('f5', { lastKnownStatus: 'FAIL' }),
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /H3 违例/.test(e)), r.errors.join('; '));
  assert.match(r.errors.find((e) => /H3/.test(e)), /上限 2/);
});

test('★ H3 必须随 fail 数重算：fail=12 时 4 个探针合法，fail=5 时同样 4 个即违例', () => {
  const base = [
    u('p1', { lastKnownStatus: 'FAIL', visibility: 'FROZEN' }),
    u('p2', { lastKnownStatus: 'FAIL', visibility: 'FROZEN' }),
    u('p3', { lastKnownStatus: 'FAIL', visibility: 'FROZEN' }),
    u('p4', { lastKnownStatus: 'FAIL', visibility: 'FROZEN' }),
  ];
  const e5 = [...base, u('e1', { lastKnownStatus: 'FAIL' })];
  const r5 = checkTierAssignment({ units: e5 });
  assert.ok(r5.errors.some((e) => /H3 违例/.test(e)), 'fail=5 时 4 个探针必须违例（上限 2）');

  const e12 = [...base, ...Array.from({ length: 8 }, (_, i) => u(`e${i}`, { lastKnownStatus: 'FAIL' }))];
  const r12 = checkTierAssignment({ units: e12 });
  assert.ok(!r12.errors.some((e) => /H3 违例/.test(e)), 'fail=12 时 4 个探针合法（上限 4）');
  assert.equal(r12.observed.h3FrozenFailProbeCap, 4);
});

test('★ H1：Evolution 保留的 fail 少于 ⌈0.6×fail数⌉ ⇒ 报错', () => {
  const r = checkTierAssignment({
    units: [
      u('f1', { lastKnownStatus: 'FAIL', visibility: 'FROZEN' }),
      u('f2', { lastKnownStatus: 'FAIL', visibility: 'FROZEN' }),
      u('f3', { lastKnownStatus: 'FAIL', visibility: 'VALIDATION' }),
      u('f4', { lastKnownStatus: 'FAIL', visibility: 'VALIDATION' }),
      u('f5', { lastKnownStatus: 'FAIL', visibility: 'VALIDATION' }),
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /H1 违例/.test(e)), r.errors.join('; '));
  assert.match(r.errors.find((e) => /H1/.test(e)), /下限 3/);
});

test('★ H4：低样本量域不得进 Frozen（dream / memory 永远进不去）', () => {
  const r = checkTierAssignment({
    units: [
      u('q1', { visibility: 'FROZEN' }),
      u('q2', { visibility: 'FROZEN' }),
      u('q3', { visibility: 'FROZEN' }),
      u('dream-1', { domain: 'dream', visibility: 'FROZEN' }),
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /H4 违例/.test(e)), r.errors.join('; '));
  assert.match(r.errors.find((e) => /H4/.test(e)), /domain=dream/);
  assert.equal(H4_MIN_DOMAIN_UNITS, 3);
});

test('★ statusKnown=false 时跳过 H1/H3，且必须显式记进 observed.skipped', () => {
  // 静态门禁（不跑 driver）下单元状态全 UNKNOWN，拿上一版 fail 数去比对会稳定假阳性。
  const r = checkTierAssignment({
    units: [u('a', { lastKnownStatus: 'UNKNOWN' }), u('b', { lastKnownStatus: 'UNKNOWN' })],
    failCount: 5,
    statusKnown: false,
  });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.observed.skipped, ['H1', 'H3'], '跳过必须显式列出，不许静默通过');
  assert.equal(r.observed.statusKnown, false);
});

test('★ statusKnown=false 不豁免枚举/H4/H5 —— 只豁免依赖实测状态的那两条', () => {
  const r = checkTierAssignment({
    units: [u('a', { visibility: 'FROZEN', lastKnownStatus: 'UNKNOWN' })],
    statusKnown: false,
    previousFrozenIds: ['gone'],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /H5 违例/.test(e)), 'H5 仍要拦');
  assert.ok(r.errors.some((e) => /H4 违例/.test(e)), 'H4 仍要拦（只 1 个 quality 单元）');
});

test('★ 枚举封闭在判据层也要拦（不给非法值溜到 summary 里）', () => {
  const r = checkTierAssignment({ units: [u('a', { visibility: 'X' }), u('b', { labelAuthority: 'Y' })] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /visibility/.test(e) && /不在枚举/.test(e)));
  assert.ok(r.errors.some((e) => /labelAuthority/.test(e) && /不在枚举/.test(e)));
});

test('★ observed 必须回写 quality 占比（配额 §3.2 要求产出里给出实际占比）', () => {
  const r = checkTierAssignment({ units: [u('a'), u('b', { domain: 'dream' })] });
  assert.equal(r.observed.qualityRatio.domain, 'quality');
  assert.equal(r.observed.qualityRatio.count, 1);
  assert.equal(r.observed.qualityRatio.total, 2);
  assert.equal(r.observed.qualityRatio.ratio, 0.5);
});

test('★ observed 带 frozenAggregateHash，供入账使用', () => {
  const r = checkTierAssignment({ units: [u('a', { visibility: 'FROZEN' })] });
  assert.match(r.observed.frozenAggregateHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(r.observed.frozenCount, 1);
});

test('配额只在显式给了 quota 时才校验（不给 ⇒ 不因未分配而红）', () => {
  const units = [u('a'), u('b')];
  assert.equal(checkTierAssignment({ units }).ok, true);
  const r = checkTierAssignment({ units, quota: { evolution: 88, validation: 31, frozen: 10 } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /配额不符/.test(e) && /EVOLUTION/.test(e)));
});

// ────────────────────────────────────────────────────────────────────────────
// SELF_PROOF —— 红绿自证记录（2026-10-03）
//
// 方法：逐条把门的条件放宽，跑 `node --test bin/lib/scenario-tier.test.mjs`，
//       确认**对应的那条测试**变红；随后还原。放宽后不红的 = 假防线，删掉重写的。
//
// 驱动脚本：`D:\DSH\_tier_selfproof.py`（逐条改本模块源码 → 跑测试 → 还原）。
//
// | # | 放宽方式 | 实测变红的测试（条数） | 结论 |
// |---|---|---|---|
// | 1 | `normalizeTierMap` 去掉 visibility 枚举检查 | 1 ——「⛔ 非法 visibility 必须报错（枚举封闭）」 | ✅ 真门 |
// | 2 | `assignTiers` 缺映射时补 `DEFAULT_TIER` 兜底 | 1 ——「⛔ 单元缺映射 ⇒ 硬错」 | ✅ 真门 |
// | 3 | `selectVisible` 默认改成 'ALL' | 2 ——「默认最严」+「非法层名 fail-closed」 | ✅ 真门 |
// | 4 | `assertNoLeak` 改成恒返 [] | 1 ——「★ assertNoLeak：混进别的层」 | ✅ 真门 |
// | 5 | `frozenAggregateHash` 把 labelAuthority 也算进哈希 | 1 ——「对 labelAuthority 迁移不敏感」 | ✅ 真门 |
// | 6 | `checkTierAssignment` 删掉 H5 子集检查 | 1 ——「★ H5：Frozen 集缩减」 | ✅ 真门 |
// | 7 | `h3FrozenFailProbeCap` 写死返回 2 | 2 ——「H1/H3 是算术结果」+「★ H3 必须随 fail 数重算」 | ✅ 真门 |
// | 8 | `checkTierAssignment` 删掉 H4 检查 | 1 ——「★ H4：低样本量域不得进 Frozen」 | ✅ 真门 |
//
// ⚠️ 自证过程里踩到的坑（写在这，免得下次重复排查）：
//    `node --test` 在**非 TTY 子进程**下会退化成 spec reporter（输出 `✔ xxx`），
//    TAP 的 `not ok` 行一条都没有 ⇒ 自证脚本会把「全绿」误读成「全绿」而实际
//    根本没判。必须显式加 `--test-reporter=tap` 才拿得到机器可读结果。
//    「没跑起来的测试」与「全过的测试」输出不同但都会让人以为通过了。
//
// ⛔ 上表是**当时的实测**。改本模块任何判据后，必须重跑一遍同样的放宽实验，
//    否则「有测试」会退化成「有文件」。
// ────────────────────────────────────────────────────────────────────────────
