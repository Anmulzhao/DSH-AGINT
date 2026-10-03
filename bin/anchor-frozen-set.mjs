#!/usr/bin/env node
/**
 * bin/anchor-frozen-set.mjs —— Frozen 集快照**预览**（只读）
 *
 * ## 为什么它不执行入账
 *
 * 宿主存储后端把整个 unit 读进内存，每次 putRecord 用内存态整体重写文件
 * （`@deepseek-ai/dsh-storage-json/lib/index.js:215-226`，自述 last-write-wins）
 * ⇒ 独立进程写 `agint_evolution.json` 里的 `benchmark_frozen_set`，会在宿主下一次
 * 写入时被**静默覆盖**。同一条结论的先例见 `bin/anchor-ledger.mjs` 文件头。
 *
 * 所以入账的唯一合法路径是**宿主服务方法**：
 *   agint.evolution.recordFrozenSet({ ... })   // plugins/agint-evolution-memory/lib/frozen-set.js
 * 它由部署后的插件提供（本轮代码态已就绪，部署 + 重启需另行授权）。
 *
 * ## 这个脚本做的事
 *
 *   1. 读 `eval/scenarios/inventory.json` 的 `tierBaseline`
 *   2. **重算**聚合 hash 并与清单里记的值对账
 *      （清单被人手改过 ⇒ hash 对不上 ⇒ 拒绝入账，⛔ 不信清单里的自述值）
 *   3. 预览将要写入的那一条 entry
 *   4. 只读打开生产存储文件，报告 `benchmark_frozen_set` 现有行数与最后一条
 *      —— 这是「数据态到底几行」的取证出口
 *   5. `--verify=<setId>` 时拿当前 hash 比一条历史快照（INTACT / TAMPERED / UNKNOWN）
 *
 * ⛔ 不写清单、不写存储、不 commit。任何写动作都可能与宿主抢同一个文件。
 *
 * 用法：
 *   node bin/anchor-frozen-set.mjs
 *   node bin/anchor-frozen-set.mjs --json
 *   node bin/anchor-frozen-set.mjs --verify=frozen-2026-10-03T11-00-00-000Z
 *   node bin/anchor-frozen-set.mjs --inventory <路径> --storage <路径>
 * 退出码：0 = 可入账 / 1 = 前置不满足 / 2 = 脚本自身出错
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { frozenAggregateHash, TIERING_VERSION, summarizeTiers } from './lib/scenario-tier.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const DEFAULT_INVENTORY = join(REPO_ROOT, 'eval', 'scenarios', 'inventory.json');
const DEFAULT_STORAGE = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'storages', 'agint_evolution.json')
  : join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'storages', 'agint_evolution.json');

function parseArgs(argv) {
  const opts = { inventory: DEFAULT_INVENTORY, storage: DEFAULT_STORAGE, json: false, verify: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--inventory') opts.inventory = argv[++i];
    else if (a === '--storage') opts.storage = argv[++i];
    else if (a === '--verify') opts.verify = argv[++i];
    else if (a.startsWith('--verify=')) opts.verify = a.slice('--verify='.length);
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  if (opts.inventory === undefined || opts.storage === undefined || opts.verify === '') {
    throw new Error('参数缺值');
  }
  return opts;
}

function readJson(path, what) {
  if (!existsSync(path)) throw new Error(`${what}_MISSING: ${path}`);
  const raw = readFileSync(path, 'utf8');
  try { return JSON.parse(raw); } catch (err) { throw new Error(`${what}_UNPARSEABLE: ${err.message}`); }
}

/** 只读打开生产存储，报告 benchmark_frozen_set 现状。读不到 ⇒ 记 blocker，不炸。 */
function readStorage(path) {
  const out = { file: path, exists: existsSync(path), rows: null, last: null, blockers: [] };
  if (!out.exists) {
    out.blockers.push('STORAGE_MISSING: 生产存储文件不存在 ⇒ 无从判断已入账几行');
    return out;
  }
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    if (doc?.unit?.name !== 'agint_evolution') {
      out.blockers.push(`STORAGE_FOREIGN_UNIT: unit.name=${JSON.stringify(doc?.unit?.name)}`);
      return out;
    }
    const t = doc.tables?.benchmark_frozen_set;
    // 宿主整单元格式：文件里没有的表补空 Map，多出来的表忽略
    // （dsh-storage-json/lib/index.js:110-113）⇒ 表不存在 = 0 行，不是错误。
    const rows = t && typeof t === 'object' ? Object.values(t) : [];
    out.rows = rows.length;
    out.last = rows.length === 0 ? null : rows.reduce((acc, r) => (
      acc === null || String(r.capturedAt) > String(acc.capturedAt) ? r : acc
    ), null);
    if (out.last) {
      out.last = {
        setId: out.last.setId, capturedAt: out.last.capturedAt,
        frozenCount: out.last.frozenCount, frozenAggregateHash: out.last.frozenAggregateHash,
      };
    }
  } catch (err) {
    out.blockers.push(`STORAGE_UNPARSEABLE: ${err.message}`);
  }
  return out;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(
      '用法：node bin/anchor-frozen-set.mjs [--inventory <路径>] [--storage <路径>] '
      + '[--verify=<setId>] [--json]\n只读预览，不写任何文件。\n',
    );
    return 0;
  }

  const inv = readJson(opts.inventory, 'INVENTORY');
  const units = Array.isArray(inv.units) ? inv.units : [];
  const base = inv.tierBaseline ?? null;
  const blockers = [];

  if (!base) blockers.push('TIER_BASELINE_MISSING: 清单里没有 tierBaseline ⇒ 先跑 bin/build-scenario-inventory.mjs');
  if (units.length === 0) blockers.push('INVENTORY_EMPTY: 清单里没有单元');

  // 重算对账：不信清单自述的 hash，自己按 {unitId, contentHash} 算一遍。
  let recomputed = null;
  if (base) {
    const frozenIds = new Set(base.frozenUnitIds ?? []);
    recomputed = frozenAggregateHash(units.filter((u) => frozenIds.has(u.unitId)));
    if (recomputed !== base.frozenAggregateHash) {
      blockers.push(`HASH_MISMATCH: 清单自述 ${base.frozenAggregateHash}，重算 ${recomputed}`
        + ' ⇒ 清单被手改过或单元内容变了，⛔ 不许入账');
    }
    if (base.criteriaOk === false) {
      blockers.push(`CRITERIA_NOT_OK: 判据未过 ⇒ ${JSON.stringify(base.criteriaErrors ?? [])}`);
    }
  }

  const tiers = summarizeTiers(units);
  const storage = readStorage(opts.storage);
  blockers.push(...storage.blockers);

  const nextEntry = base ? {
    setId: `frozen-${String(new Date().toISOString()).replace(/[:.]/g, '-')}`,
    capturedAt: '<入账时刻，由宿主时钟写入>',
    tieringVersion: base.tieringVersion ?? TIERING_VERSION,
    frozenCount: (base.frozenUnitIds ?? []).length,
    frozenUnitIds: base.frozenUnitIds ?? [],
    frozenAggregateHash: base.frozenAggregateHash,
    inventoryTotalUnits: units.length,
    failCount: base.failCount ?? 0,
    h1EvolutionMinFail: base.h1EvolutionMinFail ?? 0,
    h3FrozenFailProbeCap: base.h3FrozenFailProbeCap ?? 0,
    source: 'bin/anchor-frozen-set.mjs',
    note: '',
  } : null;

  let verifyResult = null;
  if (opts.verify && base) {
    const rows = [];
    if (existsSync(opts.storage) && storage.rows > 0) {
      const doc = JSON.parse(readFileSync(opts.storage, 'utf8'));
      rows.push(...Object.values(doc.tables.benchmark_frozen_set));
    }
    const hit = rows.find((r) => r.setId === opts.verify);
    if (!hit) {
      verifyResult = { ok: false, code: 'UNKNOWN', detail: `快照 ${opts.verify} 不存在（缺失≠通过）` };
    } else if (hit.frozenAggregateHash !== recomputed) {
      verifyResult = {
        ok: false, code: 'TAMPERED',
        expected: hit.frozenAggregateHash, actual: recomputed,
        detail: 'Frozen 集内容与快照不一致',
      };
    } else {
      verifyResult = { ok: true, code: 'INTACT' };
    }
  }

  const out = {
    inventory: opts.inventory,
    inventoryTotalUnits: units.length,
    tierCounts: tiers.tierCounts,
    recomputedAggregateHash: recomputed,
    declaredAggregateHash: base?.frozenAggregateHash ?? null,
    nextEntry,
    storage,
    verify: opts.verify ? { setId: opts.verify, ...verifyResult } : null,
    blockers,
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    process.stdout.write(`清单：${opts.inventory}（${units.length} 单元）\n`);
    process.stdout.write(`三层计数：${JSON.stringify(tiers.tierCounts)}\n`);
    process.stdout.write(`Frozen 集合：${(base?.frozenUnitIds ?? []).length} 单元`
      + `，聚合 hash ${base?.frozenAggregateHash ?? '—'}\n`);
    if (recomputed) {
      process.stdout.write(`重算对账：${recomputed === base.frozenAggregateHash ? '一致 ✓' : '不一致 ✗'}\n`);
    }
    process.stdout.write(`生产表 benchmark_frozen_set：`
      + (storage.rows === null ? '读不到' : `${storage.rows} 行`)
      + (storage.last ? `，最后一条 ${storage.last.setId}（${storage.last.frozenCount} 单元）` : '') + '\n');
    if (nextEntry) {
      process.stdout.write('下一次入账将写入这一条（setId/capturedAt 由宿主时钟定）：\n');
      process.stdout.write(`${JSON.stringify(nextEntry, null, 2)}\n`);
    }
    if (verifyResult) {
      const detail = verifyResult.detail ? ` —— ${verifyResult.detail}` : '';
      process.stdout.write(`比对 ${opts.verify}：${verifyResult.code}${detail}\n`);
    }
    for (const b of blockers) process.stdout.write(`~ ${b}\n`);
    if (blockers.length === 0) {
      process.stdout.write('→ 实际入账请走宿主服务：agint.evolution.recordFrozenSet(entry)；'
        + '⛔ 不要在本脚本里写存储文件（last-write-wins 会被宿主覆盖）。\n');
    }
  }
  return blockers.length > 0 ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ error: msg, mode: 'error' }, null, 2)}\n`);
  } else {
    process.stderr.write(`✗ 预览失败（退出码 2，与「不可入账」区分）：${msg}\n`);
  }
  process.exitCode = 2;
}
