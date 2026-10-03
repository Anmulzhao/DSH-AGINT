/**
 * bin/anchor-frozen-set.mjs 回归（Phase 0.1 / Sprint 19 交付 5）
 *
 * 钉的是**预览脚本的判定**，不是哈希数学（哈希在 bin/lib/scenario-tier.test.mjs）：
 *   重算对账   → 清单自述 hash 与重算不一致 ⇒ exit 1（⛔ 不信清单自述值）
 *   判据未过   → criteriaOk=false ⇒ exit 1
 *   缺基线     → 清单没有 tierBaseline ⇒ exit 1
 *   未知参数   → exit 2（与「不可入账」的 1 区分）
 *   verify     → 命中 INTACT / 篡改 TAMPERED / 不存在 UNKNOWN（缺失≠通过）
 *   只读       → 跑完不产生任何新文件
 *
 * Run: node --test bin/anchor-frozen-set.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { frozenAggregateHash } from './lib/scenario-tier.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'anchor-frozen-set.mjs');
const NODE = process.execPath;

const HASH_OTHER = 'sha256:' + 'b'.repeat(64);

function u(id, extra = {}) {
  return { unitId: id, contentHash: `sha256:${id}${'0'.repeat(64 - id.length)}`, visibility: 'EVOLUTION', ...extra };
}

/** 造一份假清单：units + tierBaseline（hash 由真算法算，保证自洽）。 */
function makeInventory(over = {}) {
  const units = over.units ?? [u('a'), u('b'), u('f1')];
  const frozenUnitIds = over.frozenUnitIds ?? ['f1'];
  const frozenSet = units.filter((x) => frozenUnitIds.includes(x.unitId));
  const baseline = {
    tieringVersion: '1.0',
    frozenUnitIds,
    frozenCount: frozenUnitIds.length,
    frozenAggregateHash: over.hashOverride ?? frozenAggregateHash(frozenSet),
    failCount: 6,
    h1EvolutionMinFail: 4,
    h3FrozenFailProbeCap: 2,
    criteriaOk: over.criteriaOk ?? true,
    criteriaErrors: over.criteriaErrors ?? [],
    ...(over.baselineOverride ?? {}),
  };
  return { units, summary: { totalUnits: units.length }, tierBaseline: baseline };
}

/** 跑一次脚本，返回 {code, out}。storage 默认指向临时文件（不碰生产存储）。 */
function run({ inv, storageExists = false, storageTables = null, args = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'frozen-anchor-'));
  const invPath = join(dir, 'inventory.json');
  writeFileSync(invPath, JSON.stringify(inv), 'utf8');
  const stPath = join(dir, 'agint_evolution.json');
  if (storageExists) {
    writeFileSync(stPath, JSON.stringify({
      unit: { name: 'agint_evolution', version: 1 },
      tables: storageTables ?? { benchmark_frozen_set: {} },
    }), 'utf8');
  }
  let out = '';
  let code = 0;
  try {
    out = execFileSync(NODE, [SCRIPT, '--inventory', invPath, '--storage', stPath, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    code = err.status ?? 2;
  }
  return { code, out, dir, invPath, stPath };
}

test('01 自洽清单 ⇒ exit 0，且重算对账标一致', () => {
  const r = run({ inv: makeInventory(), storageExists: true });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /重算对账：一致/);
});

test('02 清单自述 hash 被手改 ⇒ exit 1 且报 HASH_MISMATCH（⛔ 不信自述值）', () => {
  const r = run({ inv: makeInventory({ hashOverride: HASH_OTHER }), storageExists: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /HASH_MISMATCH/);
});

test('03 criteriaOk=false ⇒ exit 1 且带上判据错误', () => {
  const r = run({
    inv: makeInventory({ criteriaOk: false, criteriaErrors: ['H5 缩减：x 被移出 Frozen'] }),
    storageExists: true,
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /CRITERIA_NOT_OK/);
  assert.match(r.out, /H5 缩减/);
});

test('04 清单没有 tierBaseline ⇒ exit 1（TIER_BASELINE_MISSING）', () => {
  const r = run({ inv: { units: [u('a')], summary: {} }, storageExists: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /TIER_BASELINE_MISSING/);
});

test('05 生产存储文件不存在 ⇒ exit 1（STORAGE_MISSING，不许当成 0 行糊过去）', () => {
  const r = run({ inv: makeInventory(), storageExists: false });
  assert.equal(r.code, 1);
  assert.match(r.out, /STORAGE_MISSING/);
});

test('06 存储里没有 benchmark_frozen_set 表 ⇒ 报 0 行而不是报错（宿主补空 Map）', () => {
  const r = run({ inv: makeInventory(), storageExists: true, storageTables: { evolution_log: {} } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /benchmark_frozen_set：0 行/);
});

test('07 --verify 命中且一致 ⇒ INTACT', () => {
  const inv = makeInventory();
  const setId = 'frozen-2026-10-03T11-00-00-000Z';
  const r = run({
    inv,
    storageExists: true,
    storageTables: {
      benchmark_frozen_set: {
        [setId]: { setId, capturedAt: '2026-10-03T11:00:00.000Z', frozenAggregateHash: inv.tierBaseline.frozenAggregateHash },
      },
    },
    args: ['--verify', setId],
  });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /：INTACT/);
});

test('08 --verify 命中但 hash 变了 ⇒ TAMPERED 且列出 expected/actual', () => {
  const inv = makeInventory();
  const setId = 'frozen-2026-10-03T11-00-00-000Z';
  const r = run({
    inv,
    storageExists: true,
    storageTables: { benchmark_frozen_set: { [setId]: { setId, capturedAt: '2026-10-03T11:00:00.000Z', frozenAggregateHash: HASH_OTHER } } },
    args: ['--verify', setId],
  });
  assert.match(r.out, /TAMPERED/);
  assert.match(r.out, /HASH 变了|Frozen 集内容与快照不一致/);
});

test('09 --verify 找不到快照 ⇒ UNKNOWN（缺失≠通过）', () => {
  const r = run({ inv: makeInventory(), storageExists: true, args: ['--verify', 'nope'] });
  assert.match(r.out, /UNKNOWN/);
  assert.match(r.out, /缺失≠通过/);
});

test('10 未知参数 ⇒ exit 2，与「不可入账」的 exit 1 区分开', () => {
  const r = run({ inv: makeInventory(), storageExists: true, args: ['--bogus'] });
  assert.equal(r.code, 2);
  assert.match(r.out, /未知参数/);
});

test('11 只读：跑完临时目录里没有多出任何文件（⛔ 脚本不写盘）', () => {
  const r = run({ inv: makeInventory(), storageExists: true });
  const files = readdirSync(r.dir).sort();
  assert.deepEqual(files, ['agint_evolution.json', 'inventory.json']);
  // 顺带确认存储文件内容没被改写
  const doc = JSON.parse(readFileSync(r.stPath, 'utf8'));
  assert.deepEqual(doc.tables, { benchmark_frozen_set: {} });
});

test('12 --json 输出可解析，且 nextEntry 带齐入账所需字段', () => {
  const r = run({ inv: makeInventory(), storageExists: true, args: ['--json'] });
  assert.equal(r.code, 0, r.out);
  const doc = JSON.parse(r.out);
  const e = doc.nextEntry;
  for (const k of ['tieringVersion', 'frozenCount', 'frozenUnitIds', 'frozenAggregateHash',
    'inventoryTotalUnits', 'failCount', 'h1EvolutionMinFail', 'h3FrozenFailProbeCap', 'source']) {
    assert.ok(k in e, `nextEntry 缺字段 ${k}`);
  }
  assert.equal(doc.storage.rows, 0);
});
