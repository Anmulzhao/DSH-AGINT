// bin/build-scenario-inventory.test.mjs — 交付物 0（场景 Inventory）的测试
//
// 重心不是「脚本能跑」，而是验收项 2/3/5/6 可自动复核：
//   2 清单完整（units 数 = summary.totalUnits + unitId 唯一）
//   3 对账完成或显式声明
//   5 零依赖
//   6 降级模式可用
//
// ⚠️ 本测试只跑 --static-only（不执行 driver.js），因此属 **Tier A**，
//    可在无 dsh 环境的 ubuntu-latest 上跑。完整模式（含 delta≠0 → exit 2）
//    属 Tier B，需 dsh 运行时，不在本文件覆盖范围内 —— 分层验证纪律
//    （设计 §7.1）：不得把这里的全绿说成「Inventory 已验证」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SCRIPT = join(__dirname, 'build-scenario-inventory.mjs');
const NODE = process.execPath;

/** 跑一次降级模式，返回 { status, inventory }。 */
function runStatic() {
  const dir = mkdtempSync(join(tmpdir(), 'inventory-test-'));
  const out = join(dir, 'inventory.json');
  const r = spawnSync(NODE, [SCRIPT, '--static-only', `--out=${out}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const inventory = JSON.parse(readFileSync(out, 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', inventory };
}

const { status, stderr, inventory } = runStatic();

// ── 降级模式基本行为 ────────────────────────────────────────────────────────
test('降级模式退出码 0，且显式声明未完成实测对账', () => {
  assert.equal(status, 0, `stderr: ${stderr}`);
  assert.equal(inventory.reconciliation.complete, false);
  assert.equal(inventory.reconciliation.measuredTotal, null);
  assert.equal(inventory.reconciliation.measuredBy, 'STATIC_ONLY（未执行 driver.js）');
  assert.match(stderr, /降级模式/, '降级模式必须在 stderr 上大声说自己是降级模式');
});

test('降级模式所有单元状态为 UNKNOWN —— 不得用推算值冒充实测值', () => {
  assert.ok(
    inventory.units.every((u) => u.lastKnownStatus === 'UNKNOWN'),
    '降级模式出现非 UNKNOWN 状态 = 状态是猜的',
  );
});

// ── 验收项 2：清单完整 ──────────────────────────────────────────────────────
test('units 数组长度必须等于 summary.totalUnits', () => {
  assert.equal(inventory.units.length, inventory.summary.totalUnits);
});

test('unitId 全局唯一（验收项 2 的断言）', () => {
  const ids = inventory.units.map((u) => u.unitId);
  assert.equal(new Set(ids).size, ids.length);
});

test('每个单元都带 sha256: 前缀的 contentHash', () => {
  for (const u of inventory.units) {
    assert.match(u.contentHash, /^sha256:[0-9a-f]{64}$/, `unitId=${u.unitId}`);
  }
});

test('unitsPerFile 的合计必须等于 totalUnits（防止漏扫文件）', () => {
  const sum = Object.values(inventory.summary.unitsPerFile).reduce((a, b) => a + b, 0);
  assert.equal(sum, inventory.summary.totalUnits);
});

test('计量单位定义非空且可操作（验收项 1）', () => {
  assert.ok(inventory.unitDefinition && inventory.unitDefinition.length > 0);
  assert.match(inventory.unitDefinition, /driver\.js/);
});

// ── 验收项 6：dedicated 的边界处理 ──────────────────────────────────────────
test('dedicated 单元不在计量范围内，但被如实记录（不静默丢弃）', () => {
  assert.ok(inventory.dedicatedUnits.count > 0, 'dedicated 段为空 = 数据被丢了');
  const inScope = inventory.units.some((u) => u.sourceFile.includes('/dedicated/'));
  assert.equal(inScope, false, 'dedicated 单元混进了 driver 计量范围');
  assert.equal(inventory.dedicatedUnits.count, inventory.dedicatedUnits.units.length);
});

test('scope 段必须声明 dedicated 归属是待拍板事项（附录 C.2 第 9 项）', () => {
  assert.match(inventory.scope.dedicatedDecisionPending, /C\.2|拍板/);
});

// ── domain 归类（设计 §2.2.3）──────────────────────────────────────────────
test('domain 归类：抽查四个代表性前缀', () => {
  const byFile = new Map();
  for (const u of inventory.units) byFile.set(u.sourceFile, u.domain);
  assert.equal(byFile.get('eval/scenarios/agint-mount-s11-01-happy.scenario.json'), 'mount');
  assert.equal(byFile.get('eval/scenarios/agint-memory.scenario.json'), 'memory');
  assert.equal(byFile.get('eval/scenarios/install-security.scenario.json'), 'install-security');
  assert.equal(byFile.get('eval/scenarios/agint-sprint6-pipeline.scenario.json'), 'pipeline');
});

test('不应出现 UNCLASSIFIED domain —— 出现即代表归类表漏了新文件', () => {
  const bad = inventory.units.filter((u) => u.domain === 'UNCLASSIFIED');
  assert.equal(bad.length, 0, `未归类：${bad.map((u) => u.sourceFile).join(', ')}`);
});

// ── 归因归属（设计 §6.3：Phase 0 不做归因）─────────────────────────────────
test('failCategory 恒为 null，且归因归属被显式记录 —— 不用占位值冒充已归因', () => {
  for (const u of inventory.units) assert.equal(u.failCategory, null);
  assert.match(inventory.attribution.owner, /Sprint 17/);
  assert.match(inventory.attribution.phase0Role, /不做归因/);
});

// ── 验收项 5：零第三方依赖 ──────────────────────────────────────────────────
test('脚本本身零第三方依赖：import 只允许 node:* 或相对路径', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  const imports = [...src.matchAll(/^\s*(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(
    (m) => m[1],
  );
  assert.ok(imports.length > 0, '没解析到任何 import —— 正则失效了，测试本身不可信');
  for (const spec of imports) {
    assert.ok(
      spec.startsWith('node:') || spec.startsWith('.'),
      `第三方/裸包名 import: ${spec}`,
    );
  }
});

test('对账口径：声称值 104/92/12 必须与文档一致，不得被悄悄改写', () => {
  assert.equal(inventory.reconciliation.claimedTotal, 104);
  assert.equal(inventory.reconciliation.claimedPass, 92);
  assert.equal(inventory.reconciliation.claimedFail, 12);
  assert.match(inventory.reconciliation.claimSource, /Sprint12|路线图/);
});
