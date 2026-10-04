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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// ⛔⛔ 2026-10-04：这两条从「断言字面数字 123」改成「断言数字自洽」。
//
// 为什么改：de500af（rules ask/advisory 档，+8 单元）把真实值推到 131，
// 但这些断言写死 123 ⇒ 全部变红。而断言的**本意**是「口径自洽」
// （声明的总数 == 实测的总数），不是「总数恰好是 123」。
// 写死数字会让「加场景」这个正常动作必然破坏测试 ⇒ 逼着人养成
// 「测试一红就去改数字」的习惯，从而掩盖真正的口径断裂。
//
// ⛔ 关键：必须挂在 **REPO_INVENTORY**（入仓清单）上，不能挂 `inventory`。
//   `inventory` 来自本文件顶部 runStatic() —— 每次跑都现生成，
//   它的数字与生成器逻辑**同源**，永远自洽 ⇒ 挂它等于什么都没测。
//   只有 REPO_INVENTORY 是**已落盘的历史产物**，才会与人手写的文本一起腐化。
//   （本条踩过：先挂在 inventory 上，注入口径断裂后测试却全绿 —— 因为
//     注入改的是文件，而断言读的是现生成对象。）
function declaredTotal(inv) {
  return Number((inv.scope.included.match(/权威总数\s*(\d+)/) ?? [])[1] ?? NaN);
}
function declaredScopeTotal(inv) {
  return Number((inv.unitScope.match(/权威总数\s*=\s*(\d+)/) ?? [])[1] ?? NaN);
}
function declaredDedicatedUnits(inv) {
  return Number((inv.unitScope.match(/(\d+)\s*个可执行单元/) ?? [])[1] ?? NaN);
}

test('★ 口径边界已拍板并写入清单：权威总数 = driver 口径，dedicated 不进分母', () => {
  const inv = REPO_INVENTORY;
  assert.match(inv.scope.dedicatedDecision, /维持独立 runner/);
  assert.match(inv.scope.dedicatedDecision, /UNKNOWN/);
  // 边界句必须写进 unitScope（定义旁边），否则两个粒度会在不同文档里混用
  assert.match(inv.unitScope, /driver 口径/);
  assert.match(inv.unitScope, /反转条件/);
  // ⚠️ 声明的总数必须能从文本里**解析出来** —— 解析不到说明有人把数字改成
  //   了别的形式（或删了），那时下面的自洽断言会因 NaN 比较而假绿，必须先拦住。
  assert.ok(Number.isInteger(declaredTotal(inv)), `scope.included 解析不到权威总数：${inv.scope.included}`);
  assert.ok(Number.isInteger(declaredScopeTotal(inv)), `unitScope 解析不到权威总数：${inv.unitScope}`);
  assert.ok(Number.isInteger(declaredDedicatedUnits(inv)), 'unitScope 解析不到 dedicated 单元数');
});

test('★ 入仓清单：声明的权威总数 == 实测 units.length（口径自洽，防数字腐化）', () => {
  const inv = REPO_INVENTORY;
  // 上一条的**实质**：scope.included 与 unitScope 两处声明的总数都必须等于
  // 清单里真实的 units.length。三者任一脱节即为口径断裂。
  assert.equal(
    declaredTotal(inv),
    inv.units.length,
    'scope.included 声明的权威总数与入仓清单实测不符 —— 重跑生成器刷新（数字已函数化，不需手改）',
  );
  assert.equal(
    declaredScopeTotal(inv),
    inv.units.length,
    'unitScope 声明的权威总数与 scope.included 不一致 ⇒ 同一份清单里两个粒度打架',
  );
  assert.equal(
    declaredDedicatedUnits(inv),
    inv.dedicatedUnits.count,
    'unitScope 声明的 dedicated 单元数与 dedicatedUnits.count 不符',
  );
});

test('口径自洽：dedicated 单元不得出现在计量总数里', () => {
  assert.equal(inventory.summary.totalUnits, inventory.units.length);
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

// ────────────────────────────────────────────────────────────────────────────
// Phase 0.1 三层隔离（Sprint 19）
//
// 重心理念：字段是标注，**过滤才是隔离**。下面三组分别钉住
//   ① 生成器真的吐出两个字段且三层计数自洽
//   ② --check 真的会红（把门临时放宽 ⇒ 必须变红，否则是假防线）
//   ③ contentHash 一条都没变（防「顺手把标签写进场景文件」）
// ────────────────────────────────────────────────────────────────────────────

const TIERING_PATH = join(REPO_ROOT, 'eval', 'tiers', 'agint-tiering.json');

/** 读入仓 sidecar 的原文（绝不在测试里写入仓文件）。 */
function repoTiering() {
  return JSON.parse(readFileSync(TIERING_PATH, 'utf8'));
}

/**
 * 在临时目录里跑一次 --check。
 *
 * @param {(t: object) => void} mutateTiering  改 sidecar（在副本上改）
 * @param {(i: object) => void} mutateOutInv   改「上一版清单」（在副本上改，用于造 H5 基线）
 */
function runCheck(mutateTiering = () => {}, mutateOutInv = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'inv-check-'));
  const tieringPath = join(dir, 'tiering.json');
  const outPath = join(dir, 'inventory.json');
  const t = repoTiering();
  mutateTiering(t);
  writeFileSync(tieringPath, `${JSON.stringify(t, null, 2)}\n`, 'utf8');
  const inv = JSON.parse(readFileSync(join(REPO_ROOT, 'eval', 'scenarios', 'inventory.json'), 'utf8'));
  mutateOutInv(inv);
  writeFileSync(outPath, `${JSON.stringify(inv, null, 2)}\n`, 'utf8');

  const r = spawnSync(NODE, [SCRIPT, '--check', `--tiering=${tieringPath}`, `--out=${outPath}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('★ 入仓清单：全部单元都带 visibility 与 labelAuthority', () => {
  for (const u of REPO_INVENTORY.units) {
    assert.ok(u.visibility, `${u.unitId} 缺 visibility`);
    assert.ok(u.labelAuthority, `${u.unitId} 缺 labelAuthority`);
  }
  // 与 sidecar 登记数对齐 —— sidecar 是三层标签的真源，条目数必须与清单一致。
  // ⛔ 2026-10-04：原先写死 123，de500af +8 单元后必然变红。改成与 sidecar 比对：
  //   口径断裂（sidecar 与清单不同步）才会红，单纯「加场景」不会。
  const sidecar = JSON.parse(
    readFileSync(join(REPO_ROOT, 'eval', 'tiers', 'agint-tiering.json'), 'utf8'),
  );
  assert.equal(
    REPO_INVENTORY.units.length,
    Object.keys(sidecar.units).length,
    '清单单元数与 sidecar 登记数不一致 ⇒ sidecar 需补登记并重跑 --emit-tiering',
  );
});

test('★ 三层计数加总必须等于总数（有单元层名非法时会小于总数）', () => {
  const t = REPO_INVENTORY.summary.tierCounts;
  assert.equal(t.EVOLUTION + t.VALIDATION + t.FROZEN, REPO_INVENTORY.summary.totalUnits);
  assert.equal(REPO_INVENTORY.summary.tierSum, REPO_INVENTORY.units.length);
});

test('★ quality 占比已回写且与实测一致（配额 §3.2 要求产出里给实际占比）', () => {
  const q = REPO_INVENTORY.summary.qualityRatio;
  assert.equal(q.domain, 'quality');
  // ⛔ 2026-10-04：原先写死 count=57 / total=123 / ratio=57/123。
  //   写死 count 尤其危险 —— 它把「quality 域有多少单元」也变成了常量，
  //   任何域归类调整或场景增删都会让它变红，而**红的原因与这条断言的本意无关**
  //   （本意是「回写的占比 == 实测占比」）。改为从 units 重算并比对：
  //   真正要守的是「回写值不能自己漂」，这才是 §3.2 的要求。
  const realQuality = REPO_INVENTORY.units.filter((u) => u.domain === 'quality').length;
  assert.equal(q.count, realQuality, 'qualityRatio.count 与 units 里实数的 quality 域单元数不符');
  assert.equal(q.total, REPO_INVENTORY.units.length, 'qualityRatio.total 与单元总数不符');
  assert.ok(
    Math.abs(q.ratio - realQuality / REPO_INVENTORY.units.length) < 1e-9,
    `qualityRatio.ratio 回写值 ${q.ratio} 与实算 ${realQuality / REPO_INVENTORY.units.length} 不符`,
  );
  // 占比本身也留个量级护栏：quality 单域占四成以上，若哪天归类逻辑崩了
  // 让它变成 0% 或 100%，上面对齐也发现不了 —— 那才是 §3.2 真正防的风险。
  assert.ok(q.ratio > 0 && q.ratio < 1, `quality 占比 ${q.ratio} 越界，域归类可能已崩`);
});

test('★ 入仓清单必须是完整模式产物（否则 H1/H3 会被跳过，判据不全）', () => {
  assert.equal(REPO_INVENTORY.reconciliation.measuredBy, 'driver.js 全量回归实测');
  assert.deepEqual(REPO_INVENTORY.tierBaseline.criteriaSkipped, []);
  assert.equal(REPO_INVENTORY.tierBaseline.criteriaOk, true);
});

test('★ Frozen 基线已落盘：名单 + 聚合 hash + H1/H3 重算值', () => {
  const b = REPO_INVENTORY.tierBaseline;
  // ⛔⛔ 2026-10-04：这条原先写死了**修复前**的一组值
  //   （frozenUnitIds=[]、failCount=6、h1=4、h3=2），而 2026-10-04 修掉
  //   3 个假 fail + 修 failCount 口径后，真值变成 frozenCount=4 / failCount=2 /
  //   h1=2 / h3=0 ⇒ 全部对不上。
  //
  // 但这条断言的**本意**从来不是「Frozen 恰好为空、fail 恰好是 6」，
  // 而是「四个字段都落盘了，且彼此自洽」。写死具体值会让任何真实变化
  // （新增 Frozen、fail 数变动）都变成红灯，诱导人去改断言而不是查原因。
  //
  // 改为：断言字段**存在且合法**，再断言 h1/h3 与 failCount 在算术上自洽
  //（⌈0.6×n⌉ 与 n−⌈0.6×n⌉）。这样任何真实变化都能通过，而口径断裂会红。
  assert.ok(Array.isArray(b.frozenUnitIds), 'frozenUnitIds 必须是数组');
  assert.equal(
    b.frozenUnitIds.length,
    b.frozenCount,
    'frozenUnitIds 长度与 frozenCount 不符',
  );
  assert.match(b.frozenAggregateHash, /^sha256:[0-9a-f]{64}$/, 'hash 必须是 sha256:<64 hex>（空集也要有合法 hash —— 空集是事实，不是缺失）');

  // h1/h3 必须与 failCount 在算术上自洽（判据的算法在 scenario-tier.mjs）
  const n = b.failCount;
  const expectedH1 = Math.ceil(0.6 * n);
  const expectedH3 = n - expectedH1;
  assert.equal(b.h1EvolutionMinFail, expectedH1, `h1 应为 ⌈0.6 × ${n}⌉ = ${expectedH1}`);
  assert.equal(b.h3FrozenFailProbeCap, expectedH3, `h3 应为 ${n} − ${expectedH1} = ${expectedH3}`);

  // 真值锚定：FROZEN 层确实落了 4 个存量单元（首期 Frozen 的既成事实，
  // 改动它属「Frozen 只增不减」范畴，H5 会拦 ⇒ 这里锚住是安全的）。
  assert.equal(b.frozenCount, 4, '首期 Frozen 是 4 个存量单元，增减须走 sidecar + H5 评审');
  assert.equal(b.statusKnown, true, 'statusKnown=false 时 H1/H3 会被跳过，这条断言的前提就不成立');
});

// ── --check 的红绿自证 ──────────────────────────────────────────────────────
test('--check 基线：不动任何东西 ⇒ 退出码 0', () => {
  const r = runCheck();
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /--check 通过/);
});

test('★ --check 抓非法 visibility 枚举', () => {
  const r = runCheck((t) => {
    const k = Object.keys(t.units)[0];
    t.units[k].visibility = 'frozen';
  });
  assert.equal(r.status, 1, '非法枚举居然通过了 ⇒ 门禁是摆设');
  assert.match(r.stderr, /不在枚举/);
});

test('★ --check 抓非法 labelAuthority 枚举', () => {
  const r = runCheck((t) => {
    const k = Object.keys(t.units)[0];
    t.units[k].labelAuthority = 'PLATINUM';
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /labelAuthority/);
});

test('★ --check 抓缺映射（删一条 sidecar 条目）', () => {
  const r = runCheck((t) => {
    delete t.units[Object.keys(t.units)[0]];
  });
  assert.equal(r.status, 1, '缺映射给默认值兜底 ⇒ 「缺失映射」这条判据永远绿');
  assert.match(r.stderr, /没有映射条目/);
});

test('★ --check 抓 H5：Frozen 集变少', () => {
  // 造一个「上一版有 3 个 Frozen、这一版只剩 2 个」的局面
  const r = runCheck(
    (t) => {
      const ks = Object.keys(t.units);
      t.units[ks[0]].visibility = 'FROZEN';
      t.units[ks[1]].visibility = 'FROZEN';
    },
    (inv) => {
      const ks = inv.units.map((u) => u.unitId);
      inv.tierBaseline.frozenUnitIds = [ks[0], ks[1], 'gone-unit'];
    },
  );
  assert.equal(r.status, 1, 'Frozen 缩减竟然放行 ⇒ H5 没生效');
  assert.match(r.stderr, /H5 违例/);
  assert.match(r.stderr, /gone-unit/);
});

test('★ --check 抓 quality 占比漂移（入仓值 vs 重算值）', () => {
  const r = runCheck(() => {}, (inv) => {
    // 刻意写入与实测不符的占比（total 用清单真实总数，只让 count/ratio 偏），
    // 验证 --check 真的在比对而不是摆设。
    const total = inv.units.length;
    inv.summary.qualityRatio = { domain: 'quality', count: 1, total, ratio: 1 / total };
  });
  assert.equal(r.status, 1, '占比回写错了却不报 ⇒ 「回写」这条判据是摆设');
  assert.match(r.stderr, /quality 占比漂移/);
});

test('★ --check 抓单元级漂移（改一条 contentHash）', () => {
  const r = runCheck(() => {}, (inv) => {
    inv.units[0].contentHash = 'sha256:' + 'f'.repeat(64);
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /单元级漂移/);
});

test('★ --check 抓「实测有、入仓清单没有」的单元（新增场景忘了重生成）', () => {
  // 从「上一版清单」里删掉一条 ⇒ 这一版相对它就是新增 ⇒ 必须报出来要求补登记。
  const r = runCheck(() => {}, (inv) => {
    inv.units = inv.units.slice(1);
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /清单新增单元/);
});

test('★ --check 抓「入仓清单有、实测没有」的单元（场景被删，H5 需人工确认）', () => {
  const r = runCheck(() => {}, (inv) => {
    inv.units.push({ ...inv.units[0], unitId: 'ghost-unit', contentHash: 'sha256:' + 'a'.repeat(64) });
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /清单少了单元/);
  assert.match(r.stderr, /ghost-unit/);
});

// ── 防「顺手把标签写进场景文件」的护栏 ──────────────────────────────────────
test('★ 重新生成的 contentHash 必须一条都不变（sidecar 方案的护栏）', () => {
  const fresh = runStatic();
  const before = new Map(REPO_INVENTORY.units.map((u) => [u.unitId, u.contentHash]));
  const after = new Map(fresh.inventory.units.map((u) => [u.unitId, u.contentHash]));
  assert.equal(before.size, after.size);
  const changed = [...before.keys()].filter((id) => before.get(id) !== after.get(id));
  assert.deepEqual(
    changed,
    [],
    `contentHash 变了 ${changed.length} 条 ⇒ 标签被写进了场景文件，` +
      `Frozen 防篡改基线随之失效：${changed.slice(0, 5).join(', ')}`,
  );
});

test('★ 三层标签来自 sidecar，不是写死在生成器里', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.match(src, /eval\/tiers\/agint-tiering\.json/, '生成器必须默认读 sidecar');
  const t = repoTiering();
  assert.equal(t.tieringVersion, '1.0');
  // ⛔ 2026-10-04：原先写死 123。改为与清单比对 —— 「sidecar 每个单元都显式登记」
  // 才是这条断言的本意（sidecar note 里写明：缺映射即判据失败，不给默认值兜底）。
  // 写死 123 会在新增场景后必然变红，诱导人去改数字而不是补登记。
  assert.equal(
    Object.keys(t.units).length,
    REPO_INVENTORY.units.length,
    'sidecar 登记数与清单单元数不一致 ⇒ 有单元漏登记（sidecar 要求显式登记，不给默认兜底）',
  );
});
