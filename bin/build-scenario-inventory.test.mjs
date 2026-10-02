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

test('★ dedicated 单元粒度 = runner 的实际执行粒度（不是「一个文件一个单元」）', () => {
  const d = inventory.dedicatedUnits;
  // 旧版按文件计数 ⇒ 2 个单元且 unitId 全是 "( unnamed )"。
  // 实测两个 runner 的取数：mutator 19 场景 / counterfactual 10 fixture。
  assert.equal(d.count, 29, `dedicated 应为 29 个可执行单元，实得 ${d.count}`);
  assert.equal(d.fileCount, 2);
  assert.equal(
    d.units.filter((u) => u.unitKind === 'fixture').length,
    10,
    'counterfactual 的 10 条 fixture 粒度不对',
  );
  assert.equal(
    d.units.filter((u) => u.unitKind === 'scenario').length,
    19,
    'mutator 的 19 个场景粒度不对',
  );
});

test('★ 每个 dedicated 单元都有可唯一标识的 unitId（不得再出现 unnamed）', () => {
  for (const u of inventory.dedicatedUnits.units) {
    assert.ok(u.unitId && !u.unitId.includes('unnamed'), `unitId 无效：${u.unitId}`);
    assert.match(u.unitId, /\//, 'unitId 应带文件归属前缀，否则分层/导出时丢上下文');
    assert.ok(u.executedBy, `${u.unitId} 未标注由哪个 runner 执行`);
  }
});

test('★ 口径边界已拍板并写入清单：123 = driver 口径，dedicated 不进分母', () => {
  assert.match(inventory.scope.dedicatedDecision, /维持独立 runner/);
  assert.match(inventory.scope.dedicatedDecision, /UNKNOWN/);
  assert.match(inventory.scope.included, /123/);
  // 边界句必须写进 unitScope（定义旁边），否则 123/125 会在不同文档里混用
  assert.match(inventory.unitScope, /123（driver 口径）/);
  assert.match(inventory.unitScope, /29 个可执行单元/);
  assert.match(inventory.unitScope, /反转条件/);
});

test('口径自洽：dedicated 单元不得出现在计量总数里', () => {
  assert.equal(inventory.summary.totalUnits, 123);
  const inScope = inventory.units.some((u) => u.sourceFile.includes('/dedicated/'));
  assert.equal(inScope, false, 'dedicated 单元混进了 driver 计量范围');
  assert.equal(inventory.dedicatedUnits.count, inventory.dedicatedUnits.units.length);
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

// ── FAIL 差集对账（用户要求：12 → 5 的 −7 必须逐项溯源）─────────────────────
// ⚠️ 这一组必须读**完整模式的入仓清单**：上面 `inventory` 是 --static-only 产物，
// lastKnownStatus 全为 UNKNOWN，拿它比对 FAIL 集合会永远得到空集（假绿）。
const REPO_INVENTORY = JSON.parse(
  readFileSync(join(REPO_ROOT, 'eval', 'scenarios', 'inventory.json'), 'utf8'),
);
test('★ FAIL 差集对账已落盘，且排除「改名/删除导致静默失忆」', () => {
  const r = REPO_INVENTORY.reconciliation?.failSetReconciliation;
  assert.ok(r, '缺少 failSetReconciliation 段 —— 12→5 的 −7 不能被一句「部分已修复」带过');
  assert.equal(REPO_INVENTORY.reconciliation.measuredBy, 'driver.js 全量回归实测', '入仓清单必须是完整模式产物');
  assert.equal(r.confirmed.renamedOrRemoved, 0, '若有改名/删除，说明我们丢掉过已知问题的追踪');
  assert.match(r.irreducible, /从未被任何 artifact 记录/, '必须写明无法逐项复原的原因');
  assert.match(r.method, /worktree/);
});

test('对账结论与当前实测 FAIL 集合自洽（防止日后漂移）', () => {
  const r = REPO_INVENTORY.reconciliation.failSetReconciliation;
  const actualFails = REPO_INVENTORY.units
    .filter((u) => u.lastKnownStatus === 'FAIL')
    .map((u) => u.unitId)
    .sort();
  const claimed = [
    ...r.confirmed.currentlyFailingThatExistedThen,
    ...r.confirmed.currentlyFailingThatAreNew,
  ].sort();
  assert.deepEqual(
    actualFails,
    claimed,
    `对账里登记的 FAIL 与实测不符：\n实测 ${JSON.stringify(actualFails)}\n登记 ${JSON.stringify(claimed)}`,
  );
});

test('对账必须声明 remediation：本清单即首个持久化的 fail 名单', () => {
  const r = REPO_INVENTORY.reconciliation.failSetReconciliation;
  assert.match(r.remediation, /持久化/);
  // 且 attribution.pendingUnits 必须真的列出当前 fail
  assert.deepEqual(
    [...REPO_INVENTORY.attribution.pendingUnits].sort(),
    REPO_INVENTORY.units.filter((u) => u.lastKnownStatus === 'FAIL').map((u) => u.unitId).sort(),
  );
});

test('对账口径：声称值 104/92/12 必须与文档一致，不得被悄悄改写', () => {
  assert.equal(inventory.reconciliation.claimedTotal, 104);
  assert.equal(inventory.reconciliation.claimedPass, 92);
  assert.equal(inventory.reconciliation.claimedFail, 12);
  assert.match(inventory.reconciliation.claimSource, /Sprint12|路线图/);
});
