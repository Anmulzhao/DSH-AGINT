#!/usr/bin/env node
/**
 * eval/run-baseline-regression.mjs — Sprint 12 B3 真 cron hook 入口
 *
 * 用途：
 *   - 加载 plugins/agint-evolve/lib/index.js 真 plugin
 *   - 调 `agint.evolve.recordBaselineRun({channel:'mount', passRate, passed, total})`
 *     写一行 baseline_history
 *   - 调 `agint.evolve.baselineGate('mount')` 读回上一周期 frozen 状态
 *   - 调 `agint.evolve.listBaselineHistory({channel:'mount'})` 输出倒序表
 *
 * 设计：
 *   - 用 mkdtemp 临时目录做 reviews root（不污染用户 reviews/）
 *   - 用最小 mock storageDomain（与 driver.js makeMockStorageDomain 同型）
 *   - 默认 passRate=1.0、passed=12、total=12（happy path 占位）
 *   - 接受 `--pass-rate=N` `--passed=N` `--total=N` 注入真实回归结果
 *
 * 退出码：
 *   - 0 = 写行成功 + baselineGate 读回一致
 *   - 1 = 写行失败 / 一致性失败
 *
 * 用法：
 *   node eval/run-baseline-regression.mjs
 *   node eval/run-baseline-regression.mjs --pass-rate=0.92 --passed=11 --total=12
 */

import { readFile, mkdir, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGINT_ROOT = resolve(__dirname, '..');

// ── 解析 CLI 参数 ──────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const eq = a.indexOf('=');
      if (eq === -1) return [a.slice(2), 'true'];
      return [a.slice(2, eq), a.slice(eq + 1)];
    }),
);
const passRate = args['pass-rate'] !== undefined ? Number(args['pass-rate']) : 1.0;
const passed = args['passed'] !== undefined ? Number(args['passed']) : 12;
const total = args['total'] !== undefined ? Number(args['total']) : 12;
const channel = args['channel'] ?? 'mount';

// ── 临时 reviews root + mock storage ───────────────────────────
const root = await mkdtemp(join(tmpdir(), 'agint-evolve-run-'));
const tables = new Map();

const ctx = {
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

// ── 真 plugin apply ────────────────────────────────────────────
const { apply } = await import(`${AGINT_ROOT}/plugins/agint-evolve/lib/index.js`);
apply(ctx, { root });
const evo = ctx.get('agint.evolve');
if (!evo) {
  console.error('[FAIL] agint.evolve 服务未注册');
  process.exit(1);
}

// ── 1) 写一行 baseline_history ─────────────────────────────────
const recorded = await evo.recordBaselineRun({
  channel,
  passRate,
  passed,
  total,
  source: 'eval:run-baseline-regression',
});

console.log('\n[agint-evolve baseline-regression run]\n');
console.log(`  channel      ${recorded.channel}`);
console.log(`  passRate     ${recorded.passRate}`);
console.log(`  passed/total ${recorded.passed}/${recorded.total}`);
console.log(`  frozen       ${recorded.frozen}`);
console.log(`  source       ${recorded.source}`);
console.log(`  ranAt        ${recorded.ranAt}`);

// ── 2) baselineGate 读回 ───────────────────────────────────────
const gate = await evo.baselineGate(channel);
console.log('\n[baselineGate readback]\n');
console.log(`  frozen       ${gate.frozen}`);
console.log(`  lastRunAt    ${gate.lastRunAt}`);
console.log(`  source       ${gate.source}`);

// ── 3) 一致性检查 ──────────────────────────────────────────────
const consistencyOk =
  gate.frozen === recorded.frozen &&
  gate.lastRunAt === recorded.ranAt;

if (!consistencyOk) {
  console.error('\n[FAIL] baselineGate 与 recordBaselineRun 不一致');
  await rm(root, { recursive: true, force: true });
  process.exit(1);
}

// ── 4) listBaselineHistory 倒序表 ──────────────────────────────
const history = await evo.listBaselineHistory({ channel });
console.log(`\n[baseline_history] channel=${channel} 行数=${history.length}\n`);
console.log(`${'ranAt'.padEnd(28)} ${'passRate'.padStart(9)} ${'passed/total'.padStart(13)}  frozen  source`);
console.log('─'.repeat(80));
for (const r of history) {
  const fr = r.frozen ? 'true ' : 'false';
  console.log(
    `${r.ranAt.padEnd(28)} ${r.passRate.toFixed(3).padStart(9)} ${`${r.passed}/${r.total}`.padStart(13)}  ${fr}    ${r.source}`,
  );
}
console.log('─'.repeat(80));

// ── 5) 持久化检查：mock storage tables 已写入 ──────────────────
const tableSize = ctx._tables.get('baseline_history')?.size ?? 0;
console.log(`\n[storage] baseline_history 行数 = ${tableSize}`);

// ── 清理 ────────────────────────────────────────────────────────
await rm(root, { recursive: true, force: true });

console.log(`\n[summary] PASS — wrote 1 baseline_history row, baselineGate readback consistent`);
console.log(`  channel=${channel} passRate=${passRate.toFixed(3)} frozen=${recorded.frozen}`);

// 退出码：frozen=true 时退出 1（与"frozen 通道冻结"语义对齐）
process.exit(recorded.frozen ? 1 : 0);
