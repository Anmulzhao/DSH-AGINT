/**
 * frozen-anchor 入参计算单测（2026-10-04）
 *
 * 钉的是三件事：
 *  1. **hash 一律取清单里的**，绝不自己重算 —— 重算= 第二套口径 = 防篡改基线失效。
 *  2. **失败一律显式抛错**：清单读不到 / JSON 坏 / 无 tierBaseline /
 *     criteriaOk 非 true / Frozen 为 0 / hash 非法 —— 都不许静默返回空对象。
 *     返回空对象会让 job 报「成功」而生产表仍是 0 行。
 *  3. **repoRoot 未配 ⇒ 抛错**，不静默跳过（「没配」≠「没有变更」）。
 *
 * Run: node --test plugins/agint-cron/test/frozen-anchor.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeFrozenEntry } from '../lib/frozen-anchor-core.js';

const REAL_HASH = 'sha256:a2a7fd9ff4174a81a67e7ba0a76f1d1383c45a9f879b9486b3d4f02d095e08ab';

/** 造一个临时「仓库」：只有 eval/scenarios/inventory.json。 */
function makeRepo(tb, units) {
  const root = mkdtempSync(join(tmpdir(), 'frozen-anchor-'));
  mkdirSync(join(root, 'eval', 'scenarios'), { recursive: true });
  writeFileSync(
    join(root, 'eval', 'scenarios', 'inventory.json'),
    JSON.stringify({ tierBaseline: tb, units: units ?? [] }, null, 2),
    'utf8',
  );
  return root;
}

/** 一份通过判据的 tierBaseline（形状取自 2026-10-04 实测清单）。 */
const GOOD_TB = {
  tieringFile: 'eval/tiers/agint-tiering.json',
  tieringVersion: '1.0',
  note: 'test',
  frozenCount: 2,
  frozenUnitIds: ['a-frozen', 'b-frozen'],
  frozenAggregateHash: REAL_HASH,
  failCount: 6,
  h1EvolutionMinFail: 4,
  h3FrozenFailProbeCap: 2,
  criteriaOk: true,
  criteriaErrors: [],
  criteriaSkipped: [],
  statusKnown: true,
};

const GOOD_UNITS = [
  { unitId: 'a-frozen', visibility: 'FROZEN', lastKnownStatus: 'FAIL' },
  { unitId: 'b-frozen', visibility: 'FROZEN', lastKnownStatus: 'PASS' },
  { unitId: 'c-evo', visibility: 'EVOLUTION', lastKnownStatus: 'FAIL' },
  { unitId: 'd-evo', visibility: 'EVOLUTION', lastKnownStatus: 'FAIL' },
  { unitId: 'e-evo', visibility: 'EVOLUTION', lastKnownStatus: 'FAIL' },
  { unitId: 'f-evo', visibility: 'EVOLUTION', lastKnownStatus: 'FAIL' },
];

test('正常路径：入参四字段齐全，hash 取清单的（没被重算）', async () => {
  const root = makeRepo(GOOD_TB, GOOD_UNITS);
  try {
    const e = await computeFrozenEntry({ repoRoot: root });
    assert.equal(e.frozenAggregateHash, REAL_HASH, 'hash 必须原样取清单的');
    assert.equal(e.frozenCount, 2);
    assert.deepEqual([...e.frozenUnitIds].sort(), ['a-frozen', 'b-frozen']);
    assert.equal(e.tieringVersion, '1.0');
    assert.equal(e.inventoryTotalUnits, 6);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('H1/H3 由 failCount 现算（fail 数变了要跟着变，不读清单快照）', async () => {
  // GOOD_UNITS 里有 5 个 FAIL（a-frozen + c/d/e/f-evo），再加 5 个 = 10。
  // 清单里故意写 h1=99 / h3=99（过期快照）⇒ 真值应是 ceil(0.6*10)=6、H3=4。
  const tb = { ...GOOD_TB, h1EvolutionMinFail: 99, h3FrozenFailProbeCap: 99 };
  const units = [...GOOD_UNITS, ...Array.from({ length: 5 }, (_, i) => ({
    unitId: `x${i}`, visibility: 'EVOLUTION', lastKnownStatus: 'FAIL',
  }))];
  const root = makeRepo(tb, units);
  try {
    const e = await computeFrozenEntry({ repoRoot: root });
    assert.equal(e.failCount, 10, 'failCount 实测应为 10');
    assert.equal(e.h1EvolutionMinFail, 6, 'H1 必须现算 ceil(0.6*10)=6，不读清单的 99');
    assert.equal(e.h3FrozenFailProbeCap, 4, 'H3 = failCount − H1 = 4');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⛔ repoRoot 未配 ⇒ 显式抛错（不静默跳过）', async () => {
  await assert.rejects(() => computeFrozenEntry({}), /缺 repoRoot/);
  await assert.rejects(() => computeFrozenEntry({ repoRoot: '' }), /缺 repoRoot/);
});

test('⛔ 清单读不到 ⇒ 抛错并把路径打出来（别让人猜）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-anchor-empty-'));
  try {
    await assert.rejects(
      () => computeFrozenEntry({ repoRoot: root }),
      /清单读不到 .*inventory\.json.*repoRoot 配错/s,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⛔ 清单 JSON 坏 ⇒ 抛错（不返回空对象）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-anchor-bad-'));
  mkdirSync(join(root, 'eval', 'scenarios'), { recursive: true });
  writeFileSync(join(root, 'eval', 'scenarios', 'inventory.json'), '{ not json', 'utf8');
  try {
    await assert.rejects(() => computeFrozenEntry({ repoRoot: root }), /不是合法 JSON/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⛔ 缺 tierBaseline ⇒ 抛错并指向重跑生成器（K146）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frozen-anchor-notb-'));
  mkdirSync(join(root, 'eval', 'scenarios'), { recursive: true });
  writeFileSync(join(root, 'eval', 'scenarios', 'inventory.json'),
    JSON.stringify({ units: [] }), 'utf8');
  try {
    await assert.rejects(
      () => computeFrozenEntry({ repoRoot: root }),
      /没有 tierBaseline.*build-scenario-inventory/s,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⛔ criteriaOk 非 true ⇒ 拒绝入账（判据红着不许发通行证）', async () => {
  const root = makeRepo({ ...GOOD_TB, criteriaOk: false, criteriaErrors: ['H4: 域单元数不足'] }, GOOD_UNITS);
  try {
    await assert.rejects(
      () => computeFrozenEntry({ repoRoot: root }),
      /criteriaOk 不是 true.*H4/s,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⛔ Frozen 为 0 ⇒ 拒绝入账（否则「记了 1 行」看起来像已锚定）', async () => {
  const root = makeRepo({ ...GOOD_TB, frozenCount: 0, frozenUnitIds: [] }, []);
  try {
    await assert.rejects(() => computeFrozenEntry({ repoRoot: root }), /Frozen 层为 0/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⛔ hash 格式非法 ⇒ 抛错（sha256:<64 hex>）', async () => {
  for (const bad of ['sha256:zzz', 'abc', 'sha256:' + 'f'.repeat(63), '']) {
    const root = makeRepo({ ...GOOD_TB, frozenAggregateHash: bad }, GOOD_UNITS);
    try {
      await assert.rejects(
        () => computeFrozenEntry({ repoRoot: root }),
        /frozenAggregateHash 非法|不是合法 JSON/,
        `hash=${JSON.stringify(bad)} 应当被拒`,
      );
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('⛔ 名单条数与计数不一致 ⇒ 出warning（不静默，防基线被废）', async () => {
  const root = makeRepo({ ...GOOD_TB, frozenCount: 4, frozenUnitIds: ['a-frozen', 'b-frozen'] }, GOOD_UNITS);
  try {
    const e = await computeFrozenEntry({ repoRoot: root });
    assert.ok(e.__warning, '条数(2) vs 计数(4) 不一致必须出warning');
    assert.match(e.__warning, /条数\(2\).*计数\(4\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⛔ 清单没有 frozenUnitIds 时从 units 的 visibility 取（清单两种存法都要兜住）', async () => {
  const tb = { ...GOOD_TB };
  delete tb.frozenUnitIds;
  const root = makeRepo(tb, GOOD_UNITS);
  try {
    const e = await computeFrozenEntry({ repoRoot: root });
    assert.deepEqual([...e.frozenUnitIds].sort(), ['a-frozen', 'b-frozen']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('⛔ 本模块不 import eval 侧脚本（部署位没有 eval/，跨层 import 会让插件加载失败）', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(
    fileURLToPath(new URL('../lib/frozen-anchor-core.js', import.meta.url)), 'utf8',
  );
  // 代码行（剔注释）里不得出现指向仓库侧的相对/绝对 import
  const code = src.split(/\r?\n/)
    .filter((l) => { const t = l.trim(); return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*'); })
    .join('\n');
  assert.doesNotMatch(code, /from\s+['"][^'"]*bin\/lib\/scenario-tier/, '不得 import bin/lib/scenario-tier');
  assert.doesNotMatch(code, /from\s+['"][^'"]*\.\.\/\.\.\/\.\.\//, '不得跨层 import 仓库根');
  // 且必须自己算 H1/H3（现算），不能全靠清单
  assert.match(code, /Math\.ceil\(0\.6 \* failCount\)/, 'H1 必须现算');
});
