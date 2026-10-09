/**
 * agint-evolution-driver: outcome-measurer.js（Phase 1.1 支点 1b / R1′）
 *
 * 两层测试：
 *   A~C 纯函数：TAP 汇总口径、delta 单位、可测条目的门槛。
 *   D~G 编排：真临时仓库 + 假 runner（**按当前文件内容决定通过数**）。
 *       假 runner 手里没有"我在跑哪个态"的参数 —— 它只能通过盘上看到的内容知道，
 *       于是"双态真的换了文件"这件事是被**证出来**的，不是被断言出来的。
 *
 * 覆盖的护栏（文件头那四条）：只换一个文件 / 换完核 sha / 裸工作树拒测 / 测不到不写行。
 * 另外逐个证：每种拒测都**没有**动过盘、**没有**落表（失败路径不留半成品）。
 *
 * Run: node --test plugins/agint-evolution-driver/test/outcome-measurer.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createOutcomeMeasurer,
  collectTestDependencies,
  packageRootOf,
  MEASURE_STATUS,
  parseTapSummary,
  computeActualDelta,
  isMeasurableEntry,
  sha256Buf,
  MAX_TEST_FILES,
} from '../lib/outcome-measurer.js';

import { scorePrediction } from '../lib/prediction-scoring.js';
import { computeHypothesisLock } from '../lib/predictor.js';
import { buildLockHypothesis } from '../lib/prediction-locker.js';

// ── 夹具 ──────────────────────────────────────────────────────────────────

const STAMP = '2026-10-03T08-00-00-000Z';
const CHANGED = 'plugins/agint-demo/lib/index.js';
const PREIMAGE = `.agint-preimage/plugins__agint-demo__lib__index.js__${STAMP}.bak`;
const CONTRACT = 'EVO-20261003-1';
const LOCKED_AT = '2026-10-03T07:59:00.000Z';

function entryOver(over = {}) {
  return {
    seq: 7,
    contractId: CONTRACT,
    timestamp: '2026-10-03T08:00:00.000Z',
    summary: {
      mutationType: 'PROMPT_MUTATION',
      changedPlugins: ['agint-demo'],
      targetMetric: 'SUCCESS_RATE',
      hypothesisDigest: '提高保守阈值，减少误发布',
      predictedDelta: 3.0,
      predictionSource: 'DEFAULT_RULE', // 实时路径与 predictedDelta 成对出现（ledger-writer 的证据门）
      decision: 'AUTO_DEPLOY',
    },
    references: { preimagePath: PREIMAGE },
    ...over,
  };
}

/**
 * 造一把**真锁**：与 `contract-manager.lockPrediction` 同一配方
 * （条目字段复原 hypothesis + lockedAt ⇒ 同一个 hash）。
 * ⛔ 夹具里随手写死一个 hash 是假契约 —— 篡改门会把每条都判红，
 *    于是测试要么恒红、要么被改成"关掉门禁"，两头都得不到证据。
 */
function lockRowFor(entry, over = {}) {
  const s = entry.summary;
  const hypothesis = {
    ...buildLockHypothesis({
      mutationType: s.mutationType,
      targetMetric: s.targetMetric,
      changedComponents: s.changedPlugins,
    }),
    predictedDelta: s.predictedDelta,
    predictionSource: s.predictionSource,
  };
  return {
    contractId: entry.contractId,
    hypothesisLock: computeHypothesisLock({ hypothesis, contractId: entry.contractId, createdAt: LOCKED_AT }),
    lockAlgorithm: 'sha256',
    lockedAt: LOCKED_AT,
    predictionSource: s.predictionSource ?? null,
    ...over,
  };
}

/** 假 runner：看盘上内容决定结果 —— 内容 = 基线 ⇒ 1/2；内容 = 候选 ⇒ 2/2。 */
function contentDrivenRunner({ dir, calls }) {
  return async ({ files }) => {
    const cur = String(await readFile(join(dir, CHANGED), 'utf8'));
    const marker = cur.includes('FIXED') ? 'FIXED' : 'BROKEN';
    calls.push({ n: calls.length + 1, marker, files: [...files] });
    return { ok: true, timedOut: false, stdout: tap(marker === 'FIXED' ? 2 : 1, marker === 'FIXED' ? 0 : 1), stderr: '', error: null };
  };
}

function tap(pass, fail, extra = {}) {
  return `# tests ${pass + fail + (extra.skipped ?? 0) + (extra.todo ?? 0)}
# suites 0
# pass ${pass}
# fail ${fail}
# cancelled ${extra.cancelled ?? 0}
# skipped ${extra.skipped ?? 0}
# todo ${extra.todo ?? 0}
`;
}

/** 落表 mock。返回的 evo 带 .rows / .store，供断言"有没有写行"。 */
function makeEvo({ entry = entryOver(), lock, entries = null } = {}) {
  const rows = new Map();
  const lockRow = lock === undefined ? lockRowFor(entry) : lock; // 传 null ⇒ 模拟锁行被删
  return {
    rows,
    lockRow,
    ledger: {
      findByContractId: async (id) => (entry && id === entry.contractId ? entry : null),
      list: async () => entries ?? (entry ? [entry] : []),
    },
    getContractLock: async (id) => {
      // 主条目用显式夹具（可能是"被删的锁"或"对不上的锁"）；
      // 批量场景里的其它条目按各自内容现算一把真锁 ⇒ 夹具不会替被测对象造假。
      if (id === entry?.contractId) return lockRow;
      const other = (entries ?? []).find((x) => x?.contractId === id);
      return other ? lockRowFor(other) : null;
    },
    getPredictionOutcome: async (id) => rows.get(id) ?? null,
    listPredictionOutcomes: async () => [...rows.values()],
    recordPredictionOutcome: async (r) => {
      if (rows.has(r.contractId)) throw new Error('prediction-outcome-already-exists');
      rows.set(r.contractId, r);
      return { ...r };
    },
  };
}

/** 旧版已部署服务：有 ledger，没有 1b 新加的表方法（重启前生产就是这个形状）。 */
function legacyEvo() {
  const e = makeEvo();
  const { recordPredictionOutcome, getPredictionOutcome, listPredictionOutcomes, ...rest } = e;
  return rest;
}

async function makeRepo({ withNodeModules = true, withTest = true, testSource = 'export default 1;\n' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agint-outcome-'));
  await mkdir(join(dir, 'plugins', 'agint-demo', 'lib'), { recursive: true });
  await mkdir(join(dir, '.agint-preimage'), { recursive: true });
  if (withTest) {
    await mkdir(join(dir, 'plugins', 'agint-demo', 'test'), { recursive: true });
    await writeFile(join(dir, 'plugins', 'agint-demo', 'test', 'demo.test.mjs'), testSource);
  }
  if (withNodeModules) await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, CHANGED), 'export const v = "FIXED";\n');
  await writeFile(join(dir, PREIMAGE), 'export const v = "BROKEN";\n');
  const files = [CHANGED, PREIMAGE];
  if (withTest) files.push('plugins/agint-demo/test/demo.test.mjs');
  if (withNodeModules) files.push('node_modules/.keep');
  return { dir, files };
}

/** 统一的被测构造器。 */
function build({ dir, files, evo, runner, opts = {} }) {
  const warns = [];
  const measurer = createOutcomeMeasurer(
    { get: (n) => (n === 'agint.evolution' ? evo : null) },
    {
      listRepoFiles: async () => files,
      runTests: runner,
      warn: (m, e) => warns.push([m, e]),
      now: () => '2026-10-03T09:00:00.000Z',
      ...opts,
    },
  );
  return { measurer, warns };
}

// ── A. TAP 汇总口径 ──────────────────────────────────────────────────────

test('A1: 真 TAP 汇总行 → 计数与 passRate', () => {
  const s = parseTapSummary(tap(11, 0));
  assert.equal(s.passed, 11);
  assert.equal(s.total, 11);
  assert.equal(s.passRate, 1);
});

test('A2: 没有汇总行 → null（判"输出不是 node:test"，不是判 0 分）', () => {
  assert.equal(parseTapSummary(''), null);
  assert.equal(parseTapSummary('Command not found: node'), null);
  assert.equal(parseTapSummary(undefined), null);
});

test('A3: cancelled 不进分母（仪器故障 ≠ 回归），但单独冒出来给上层判超时', () => {
  const s = parseTapSummary(tap(3, 1, { cancelled: 7 }));
  assert.equal(s.total, 4, '分母只算 pass+fail+skipped+todo');
  assert.equal(s.cancelled, 7);
  assert.equal(s.passRate, 0.75);
});

test('A4: skipped / todo 进分母不进分子（口径如实，两侧同一套文件 ⇒ delta 不受影响）', () => {
  const s = parseTapSummary(tap(8, 0, { skipped: 2, todo: 1 }));
  assert.deepEqual(
    { passed: s.passed, failed: s.failed, total: s.total, passRate: s.passRate },
    { passed: 8, failed: 0, total: 11, passRate: 8 / 11 },
  );
});

test('A5: 全 0（一条都没跑到）→ passRate null，不给 0 分', () => {
  const s = parseTapSummary(tap(0, 0));
  assert.equal(s.total, 0);
  assert.equal(s.passRate, null);
});

// ── B. actualDelta 单位 ──────────────────────────────────────────────────

test('B1: actualDelta = (候选 − 基线) × 100，单位百分点（与 τ=3.0pp 同量纲）', () => {
  assert.ok(Math.abs(computeActualDelta(8 / 11, 1) - (3 / 11) * 100) < 1e-9);
  assert.equal(computeActualDelta(0.5, 1), 50);
  assert.equal(computeActualDelta(1, 0.5), -50, '回归必须是负数');
});

test('B2: 任一侧缺失 → null（⛔ 不是 0：写 0 就等于伪造了一次"无改进"证据）', () => {
  assert.equal(computeActualDelta(null, 1), null);
  assert.equal(computeActualDelta(1, undefined), null);
  assert.equal(computeActualDelta(NaN, 1), null);
});

// ── C. 可测条目门槛 ──────────────────────────────────────────────────────

test('C1: 只有改动留在盘上的决策可测（REJECT/ABSTAIN 已回滚，没有改后态）', () => {
  assert.equal(isMeasurableEntry(entryOver({ summary: { ...entryOver().summary, decision: 'AUTO_DEPLOY' } })).ok, true);
  assert.equal(isMeasurableEntry(entryOver({ summary: { ...entryOver().summary, decision: 'PENDING_REVIEW' } })).ok, true);
  for (const d of ['REJECT', 'ABSTAIN']) {
    const r = isMeasurableEntry(entryOver({ summary: { ...entryOver().summary, decision: d } }));
    assert.equal(r.ok, false, `${d} 不该测`);
    assert.equal(r.status, MEASURE_STATUS.NOT_MEASURABLE);
  }
});

test('C2: 没 preimagePath 的条目不可测（没备份就没有基线）', () => {
  const r = isMeasurableEntry(entryOver({ references: {} }));
  assert.equal(r.ok, false);
  assert.equal(r.status, MEASURE_STATUS.NO_PREIMAGE);
});

// ── D. 双态真跑（真临时仓库）────────────────────────────────────────────

let repo;
before(async () => { repo = await makeRepo(); });
after(async () => { await rm(repo.dir, { recursive: true, force: true }); });

test('D1: 一次成功测量 —— 双态真换了文件、落一行、算完就换回来', async () => {
  const calls = [];
  const evo = makeEvo();
  const { measurer } = build({ dir: repo.dir, files: repo.files, evo, runner: contentDrivenRunner({ dir: repo.dir, calls }) });

  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });

  assert.equal(res.status, MEASURE_STATUS.MEASURED, JSON.stringify(res));
  assert.equal(res.ok, true);
  assert.equal(res.needsAttention, false);

  // 1) 真的跑了两侧，且两侧看到的盘上内容不同 ⇒ 换文件这条路是通的
  assert.equal(calls.length, 2);
  assert.equal(calls[0].marker, 'FIXED', '先跑候选态（盘上现状）');
  assert.equal(calls[1].marker, 'BROKEN', '跑基线态时必须已换成 preimage');
  assert.deepEqual(calls[0].files, ['plugins/agint-demo/test/demo.test.mjs'], '两侧跑的是同一子集');
  assert.deepEqual(calls[1].files, calls[0].files);

  // 2) 数字
  assert.equal(res.baseline.passRate, 0.5);
  assert.equal(res.candidate.passRate, 1);
  assert.equal(res.actualDelta, 50);
  assert.equal(res.isDeadZone, false, '50pp ≫ 死区 1.5pp');
  const expectPq = scorePrediction({ predictedDelta: 3.0, actualDelta: 50, targetMetric: 'SUCCESS_RATE' });
  assert.equal(res.predictionQuality, expectPq.pq);

  // 3) 复原：跑完盘上还是候选态
  const after1 = String(await readFile(join(repo.dir, CHANGED), 'utf8'));
  assert.equal(after1.trim(), 'export const v = "FIXED";'.trim());
  assert.equal(res.restoreVerified, true);

  // 4) 落表内容
  assert.equal(evo.rows.size, 1);
  const row = evo.rows.get(CONTRACT);
  assert.equal(row.method, 'TEST_CORPUS_PAIR_RUN');
  assert.equal(row.targetMetric, 'SUCCESS_RATE');
  assert.equal(row.changedPath, CHANGED);
  assert.equal(row.measuredAt, '2026-10-03T09:00:00.000Z');
  assert.equal(row.predictedDelta, 3.0);
  assert.equal(row.baselineNoiseStd, null, '拿不到就不编');
  assert.equal(row.evidence.preimagePath, PREIMAGE);
  assert.equal(row.evidence.ledgerSeq, 7);
  assert.equal(row.evidence.hypothesisLock, evo.lockRow.hypothesisLock);
  assert.equal(row.evidence.candidateSha, sha256Buf(Buffer.from('export const v = "FIXED";\n')));
  assert.equal(row.evidence.baselineSha, sha256Buf(Buffer.from('export const v = "BROKEN";\n')));
});

test('D2: 重跑幂等 —— 第二次直接返回 IDEMPOTENT，⛔ 不再换文件', async () => {
  const calls = [];
  const evo = makeEvo();
  const { measurer } = build({ dir: repo.dir, files: repo.files, evo, runner: contentDrivenRunner({ dir: repo.dir, calls }) });
  await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(calls.length, 2);
  const res2 = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(res2.status, MEASURE_STATUS.IDEMPOTENT);
  assert.equal(calls.length, 2, '幂等路径不得再跑一次测试');
  assert.equal(evo.rows.size, 1);
});

test('D3: 没预测的条目也测（predictedDelta=null ⇒ pq=null + pqReason，喂 τ 标定）', async () => {
  const e = entryOver({ summary: { ...entryOver().summary, predictedDelta: null } });
  const evo = makeEvo({ entry: e });
  const { measurer } = build({ dir: repo.dir, files: repo.files, evo, runner: contentDrivenRunner({ dir: repo.dir, calls: [] }) });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(res.status, MEASURE_STATUS.MEASURED);
  assert.equal(res.predictedDelta, null);
  assert.equal(res.predictionQuality, null);
  assert.equal(evo.rows.get(CONTRACT).pqReason, 'NOT_PREDICTED');
});

test('D4: 回归（候选比基线差）记负 delta，方向错 ⇒ DA=0 ⇒ PQ=0', async () => {
  const e = entryOver({ summary: { ...entryOver().summary, predictedDelta: 3.0 } });
  const evo = makeEvo({ entry: e });
  // 反向夹具：盘上=坏内容（候选），preimage=好内容（基线）
  const r2 = await makeRepo();
  await writeFile(join(r2.dir, CHANGED), 'export const v = "BROKEN";\n');
  await writeFile(join(r2.dir, PREIMAGE), 'export const v = "FIXED";\n');
  const { measurer } = build({ dir: r2.dir, files: r2.files, evo, runner: contentDrivenRunner({ dir: r2.dir, calls: [] }) });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: r2.dir });
  assert.equal(res.status, MEASURE_STATUS.MEASURED);
  assert.equal(res.actualDelta, -50);
  assert.equal(res.predictionQuality, 0, '方向判反 ⇒ DA=0 ⇒ PQ=0（一票否决）');
  assert.equal(res.needsAttention, false);
  const cur = String(await readFile(join(r2.dir, CHANGED), 'utf8'));
  assert.equal(cur.includes('BROKEN'), true, '回归场景同样要复原成盘上现状');
  await rm(r2.dir, { recursive: true, force: true });
});

// ── E. 拒测路径：一律"没跑、没换、没落表" ────────────────────────────────

test('E1: 缺 repoRoot / 缺 listRepoFiles / 服务无表方法 —— 三种没仪器都拒', async () => {
  const evo = makeEvo();
  const calls = [];
  const runner = contentDrivenRunner({ dir: repo.dir, calls });

  const m1 = createOutcomeMeasurer({ get: () => evo }, { listRepoFiles: async () => repo.files, runTests: runner });
  assert.equal((await m1.measureOne({ contractId: CONTRACT, repoRoot: null })).status, MEASURE_STATUS.NO_REPOROOT);

  const m2 = createOutcomeMeasurer({ get: () => evo }, { runTests: runner });
  assert.equal((await m2.measureOne({ contractId: CONTRACT, repoRoot: repo.dir })).status, MEASURE_STATUS.NO_REPO_FILE_LIST);

  const m3 = createOutcomeMeasurer({ get: () => legacyEvo() }, { listRepoFiles: async () => repo.files, runTests: runner });
  const r3 = await m3.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(r3.status, MEASURE_STATUS.SERVICE_UNAVAILABLE);
  assert.deepEqual(r3.missing, ['recordPredictionOutcome', 'getPredictionOutcome']);

  assert.equal(calls.length, 0, '三条拒测都不该跑过测试');
  assert.equal(evo.rows.size, 0);
});

test('E2: 逐条门槛 —— 决策/指标/preimage/后续改动/裸工作树/覆盖门/超大子集', async () => {
  const cases = [
    ['REJECT 不测', { entry: entryOver({ summary: { ...entryOver().summary, decision: 'REJECT' } }) }, MEASURE_STATUS.NOT_MEASURABLE],
    ['指标不是通过率', { entry: entryOver({ summary: { ...entryOver().summary, targetMetric: 'TOKEN_EFFICIENCY' } }) }, MEASURE_STATUS.UNSUPPORTED_METRIC],
    ['无 preimagePath', { entry: entryOver({ references: {} }) }, MEASURE_STATUS.NO_PREIMAGE],
    ['preimage 名字解不出', { entry: entryOver({ references: { preimagePath: 'backup/whatever.bak' } }) }, MEASURE_STATUS.PREIMAGE_UNPARSEABLE],
    ['preimagePath 为空', { entry: entryOver({ references: { preimagePath: '' } }) }, MEASURE_STATUS.NO_PREIMAGE],
    ['同文件后来又被改过', { entries: [entryOver(), entryOver({ contractId: 'EVO-LATER', seq: 8, timestamp: '2026-10-03T10:00:00.000Z' })] }, MEASURE_STATUS.SUPERSEDED],
  ];
  for (const [label, cfg, want] of cases) {
    const calls = [];
    const evo = makeEvo({ entry: cfg.entry ?? entryOver(), entries: cfg.entries ?? null });
    const { measurer } = build({
      dir: repo.dir,
      files: cfg.files ?? repo.files,
      evo,
      runner: contentDrivenRunner({ dir: repo.dir, calls }),
    });
    const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
    assert.equal(res.status, want, `${label} 应判 ${want}，实得 ${res.status}`);
    assert.equal(res.ok, false);
    assert.equal(calls.length, 0, `${label}：拒测不得跑测试`);
    assert.equal(evo.rows.size, 0, `${label}：拒测不得落表`);
  }
});

test('E2b: preimage 名的 `__` 有损编码解出不存在的路径 ⇒ 核清单拦下，拒测', async () => {
  const r = await makeRepo();
  const odd = '.agint-preimage/plugins__agint-demo__lib__index__x.js__2026-10-03T08-00-00-000Z.bak';
  await writeFile(join(r.dir, odd), 'export const v = "BROKEN";\n');
  const calls = [];
  const evo = makeEvo({ entry: entryOver({ references: { preimagePath: odd } }) });
  const { measurer } = build({ dir: r.dir, files: [...r.files, odd], evo, runner: contentDrivenRunner({ dir: r.dir, calls }) });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: r.dir });
  // 解出的是 plugins/agint-demo/lib/index/x.js —— 仓库清单里没有这个文件
  assert.equal(res.status, MEASURE_STATUS.PREIMAGE_UNPARSEABLE);
  assert.equal(res.reason, 'CHANGED_PATH_NOT_FOUND');
  assert.equal(calls.length, 0);
  assert.equal(evo.rows.size, 0);
  await rm(r.dir, { recursive: true, force: true });
});

test('E3: 裸工作树 + 测试文件引裸包名 ⇒ 拒测（实测的 23/123 假基线就是这么来的）', async () => {
  // 零依赖仓库（根上没有 node_modules）里，测试文件 import 'zod' ⇒ 必然假基线。
  // 这正是提案 0738af45 要保住的那半：放宽的是判据，不是放行假基线。
  const bare = await makeRepo({ withNodeModules: false, testSource: "import { z } from 'zod';\nexport default z;\n" });
  const calls = [];
  const evo = makeEvo();
  const { measurer } = build({ dir: bare.dir, files: bare.files, evo, runner: contentDrivenRunner({ dir: bare.dir, calls }) });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: bare.dir });
  assert.equal(res.status, MEASURE_STATUS.NO_TEST_RUNTIME);
  assert.equal(res.reason, 'TEST_DEPS_MISSING');
  assert.equal(res.zeroDepRepo, true);
  assert.deepEqual(res.missing.map((m) => m.package), ['zod']);
  assert.equal(calls.length, 0);
  assert.equal(evo.rows.size, 0);
  await rm(bare.dir, { recursive: true, force: true });
});

test('E3b: 零依赖仓库 + 测试只引 node: 内置/相对路径 ⇒ 放行（旧判据会永久误杀）', async () => {
  // 提案 0738af45 的实测场景：根无 node_modules，但被测脚本本来就跑得起来。
  const bare = await makeRepo({ withNodeModules: false, testSource: "import { readFile } from 'node:fs/promises';\nimport { x } from '../lib/index.js';\nexport default readFile;\n" });
  await writeFile(join(bare.dir, 'plugins', 'agint-demo', 'lib', 'index.js'), 'export const x = 1;\n');
  const calls = [];
  const evo = makeEvo();
  const { measurer } = build({
    dir: bare.dir,
    files: [...bare.files, 'plugins/agint-demo/lib/index.js'],
    evo,
    runner: contentDrivenRunner({ dir: bare.dir, calls }),
  });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: bare.dir });
  assert.notEqual(res.status, MEASURE_STATUS.NO_TEST_RUNTIME);
  assert.equal(calls.length, 2, '候选态 + 基线态各跑一次 —— 真的量了');
  await rm(bare.dir, { recursive: true, force: true });
});

test('E3c: 相对导入拉进来的 lib 引裸包名 ⇒ 照样拒测（不许靠只看测试文件蒙混过关）', async () => {
  const bare = await makeRepo({ withNodeModules: false, testSource: "import { x } from '../lib/index.js';\nexport default x;\n" });
  await writeFile(join(bare.dir, 'plugins', 'agint-demo', 'lib', 'index.js'), "import { z } from 'zod';\nexport const x = z;\n");
  const calls = [];
  const evo = makeEvo();
  const { measurer } = build({
    dir: bare.dir,
    files: [...bare.files, 'plugins/agint-demo/lib/index.js'],
    evo,
    runner: contentDrivenRunner({ dir: bare.dir, calls }),
  });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: bare.dir });
  assert.equal(res.status, MEASURE_STATUS.NO_TEST_RUNTIME);
  assert.equal(res.reason, 'TEST_DEPS_MISSING');
  assert.equal(calls.length, 0);
  await rm(bare.dir, { recursive: true, force: true });
});

test('E3d: 插件自带 node_modules（向上查找）⇒ 放行，不必仓库根有', async () => {
  // 本仓真实布局：plugins/<name>/node_modules/zod 软链到 dsh 自带包。
  const bare = await makeRepo({ withNodeModules: false, testSource: "import { z } from 'zod';\nexport default z;\n" });
  await mkdir(join(bare.dir, 'plugins', 'agint-demo', 'test', 'node_modules', 'zod'), { recursive: true });
  const calls = [];
  const evo = makeEvo();
  const { measurer } = build({
    dir: bare.dir,
    files: bare.files,
    evo,
    runner: contentDrivenRunner({ dir: bare.dir, calls }),
  });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: bare.dir });
  assert.notEqual(res.status, MEASURE_STATUS.NO_TEST_RUNTIME);
  assert.equal(calls.length, 2);
  await rm(bare.dir, { recursive: true, force: true });
});

test('E3e: 注释里的 import 举例不算依赖（剥注释，防假阳性把放行又变回误杀）', async () => {
  // 规格注释里写「`import x from 'a'`」是常态（outcome-measurer.js 自己就这么写）。
  // 不剥注释 ⇒ 'a' 被当成裸包名探不到 ⇒ 又是一刀切拒测。
  const { dir } = await makeRepo({ withNodeModules: false });
  await writeFile(join(dir, 'plugins/agint-demo', 'test', 'demo.test.mjs'),
    "// 举例：import x from 'a';\n/* 举例：import { y } from 'b'; */\nimport { readFile } from 'node:fs/promises';\nexport default readFile;\n");
  const deps = await collectTestDependencies({ repoRoot: dir, files: ['plugins/agint-demo/test/demo.test.mjs'] });
  assert.equal(deps.ok, true);
  assert.deepEqual(deps.missing, []);
  await rm(dir, { recursive: true, force: true });
});

test('E3f: packageRootOf —— 作用域包取两段，普通包取首段', () => {
  assert.equal(packageRootOf('zod'), 'zod');
  assert.equal(packageRootOf('zod/lib/x.js'), 'zod');
  assert.equal(packageRootOf('@deepseek-ai/dsh-tools'), '@deepseek-ai/dsh-tools');
  assert.equal(packageRootOf('@deepseek-ai/dsh-tools/lib/y.js'), '@deepseek-ai/dsh-tools');
});

test('E4: 覆盖门 —— 筛不出测试触达被改文件 ⇒ NO_EVIDENCE 且不写行', async () => {
  const notest = await makeRepo({ withTest: false });
  const calls = [];
  const evo = makeEvo();
  const { measurer } = build({ dir: notest.dir, files: notest.files, evo, runner: contentDrivenRunner({ dir: notest.dir, calls }) });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: notest.dir });
  assert.equal(res.status, MEASURE_STATUS.NO_EVIDENCE);
  assert.equal(res.reason, 'NO_EVIDENCE');
  assert.equal(calls.length, 0);
  assert.equal(evo.rows.size, 0, '⛔ 测不到不是度量，一行都不能写');
  await rm(notest.dir, { recursive: true, force: true });
});

test('E5: 子集超过命令行上限 ⇒ 拒测（不是截断前 N 个偷偷测）', async () => {
  const many = [CHANGED, PREIMAGE];
  for (let i = 0; i <= MAX_TEST_FILES; i++) many.push(`plugins/agint-demo/test/t${i}.test.mjs`);
  const evo = makeEvo();
  const calls = [];
  const { measurer } = build({ dir: repo.dir, files: many, evo, runner: contentDrivenRunner({ dir: repo.dir, calls }) });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(res.status, MEASURE_STATUS.TEST_SET_TOO_LARGE);
  assert.equal(res.count, MAX_TEST_FILES + 1);
  assert.equal(calls.length, 0);
  assert.equal(evo.rows.size, 0);
});

test('E6: 动手前发现文件被别的会话改过 ⇒ CONCURRENT_WRITE，只跑了候选态、没换文件', async () => {
  const calls = [];
  const evo = makeEvo();
  // runner 契约：只吃 { repoRoot, files, timeoutMs }（measurer 不传目录别名）
  const runner = async ({ repoRoot }) => {
    const cur = String(await readFile(join(repoRoot, CHANGED), 'utf8'));
    calls.push(cur.includes('FIXED') ? 'FIXED' : 'OTHER');
    if (calls.length === 1) {
      // 候选态跑完，另一会话往同一个文件写了一行
      await writeFile(join(repoRoot, CHANGED), 'export const v = "FIXED"; // touched by hand\n');
    }
    return { ok: true, timedOut: false, stdout: tap(2, 0), stderr: '', error: null };
  };
  const { measurer } = build({ dir: repo.dir, files: repo.files, evo, runner });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(res.status, MEASURE_STATUS.CONCURRENT_WRITE);
  assert.equal(calls.length, 1, '⛔ 不换文件 ⇒ 基线态根本不跑');
  assert.equal(evo.rows.size, 0);
  const cur = String(await readFile(join(repo.dir, CHANGED), 'utf8'));
  assert.equal(cur.includes('touched by hand'), true, '探测到并发后不得动过别人的文件');
  await writeFile(join(repo.dir, CHANGED), 'export const v = "FIXED";\n'); // 恢复共享夹具
});

test('E7: runner 输出不可解析 / 起不来 ⇒ 两个不同状态，都落回候选态', async () => {
  const unparsable = await makeRepo();
  const e1 = makeEvo();
  const { measurer: m1 } = build({ dir: unparsable.dir, files: unparsable.files, evo: e1, runner: async () => ({ ok: true, timedOut: false, stdout: 'no tap here', stderr: 'x', error: null }) });
  const r1 = await m1.measureOne({ contractId: CONTRACT, repoRoot: unparsable.dir });
  assert.equal(r1.status, MEASURE_STATUS.RUNNER_UNPARSABLE);
  assert.equal(r1.side, 'candidate');
  assert.equal(e1.rows.size, 0);
  await rm(unparsable.dir, { recursive: true, force: true });

  const broken = await makeRepo();
  const e2 = makeEvo();
  const { measurer: m2 } = build({ dir: broken.dir, files: broken.files, evo: e2, runner: async () => ({ ok: false, timedOut: false, stdout: '', stderr: 'ENOENT node', error: 'spawn ENOENT' }) });
  assert.equal((await m2.measureOne({ contractId: CONTRACT, repoRoot: broken.dir })).status, MEASURE_STATUS.RUNNER_FAILED);
  await rm(broken.dir, { recursive: true, force: true });

  const slow = await makeRepo();
  const e3 = makeEvo();
  const { measurer: m3 } = build({ dir: slow.dir, files: slow.files, evo: e3, runner: async () => ({ ok: false, timedOut: true, stdout: '', stderr: '', error: 'timeout' }) });
  assert.equal((await m3.measureOne({ contractId: CONTRACT, repoRoot: slow.dir })).status, MEASURE_STATUS.RUNNER_TIMEOUT);
  await rm(slow.dir, { recursive: true, force: true });
});

test('E8: 基线态跑挂了也照样换回候选态（finally 不看结果）', async () => {
  const r = await makeRepo();
  const calls = [];
  const evo = makeEvo();
  const runner = async ({ repoRoot }) => {
    const cur = String(await readFile(join(repoRoot, CHANGED), 'utf8'));
    calls.push(cur.includes('FIXED') ? 'FIXED' : 'BROKEN');
    if (calls.length === 2) return { ok: true, timedOut: false, stdout: 'garbage', stderr: '', error: null };
    return { ok: true, timedOut: false, stdout: tap(2, 0), stderr: '', error: null };
  };
  const { measurer } = build({ dir: r.dir, files: r.files, evo, runner });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: r.dir });
  assert.equal(res.status, MEASURE_STATUS.RUNNER_UNPARSABLE);
  assert.equal(res.side, 'baseline');
  assert.equal(calls.length, 2);
  const cur = String(await readFile(join(r.dir, CHANGED), 'utf8'));
  assert.equal(cur.includes('FIXED'), true, '基线跑挂之后必须已经换回候选态');
  assert.equal(evo.rows.size, 0);
  await rm(r.dir, { recursive: true, force: true });
});

test('E9: 换不回去 ⇒ RESTORE_FAILED + needsAttention，且不落表', async () => {
  const calls = [];
  const evo = makeEvo();
  let writeCount = 0;
  const real = await import('node:fs/promises');
  const { measurer, warns } = build({
    dir: repo.dir,
    files: repo.files,
    evo,
    runner: contentDrivenRunner({ dir: repo.dir, calls }),
    opts: {
      write: async (abs, buf) => {
        writeCount += 1;
        if (writeCount === 2) throw new Error('EBUSY mock（复原写失败）');
        return real.writeFile(abs, buf);
      },
    },
  });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(res.status, MEASURE_STATUS.RESTORE_FAILED);
  assert.equal(res.needsAttention, true, '仓库此刻仍是基线态 —— 必须冒到上层');
  assert.equal(evo.rows.size, 0);
  assert.ok(warns.some(([m]) => /候选态未恢复/.test(m)), '要有升级告警');
  // 收尾：手工把仓库恢复原状，别把临时目录留在坏态
  await real.writeFile(join(repo.dir, CHANGED), 'export const v = "FIXED";\n');
});

// ── F. 复原核不上 sha：写行但带标记 ─────────────────────────────────────

test('F1: 复原后 sha 不一致 ⇒ 仍落表但 restoreVerified:false + needsAttention', async () => {
  const calls = [];
  const evo = makeEvo();
  const real = await import('node:fs/promises');
  let readCount = 0;
  const { measurer, warns } = build({
    dir: repo.dir,
    files: repo.files,
    evo,
    runner: contentDrivenRunner({ dir: repo.dir, calls }),
    opts: {
      read: async (abs) => {
        readCount += 1;
        const buf = await real.readFile(abs);
        // 第 4 次读 = 复原后核对用的那一次（1 候选现状 / 2 preimage / 3 换前复核 / 4 换后复核）：
        // 给它一份不同内容的字节，模拟"写回去了但没真恢复"
        if (abs.endsWith('index.js') && readCount >= 4) return Buffer.from('export const v = "FIXED"; /* drifted */\n');
        return buf;
      },
    },
  });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(res.status, MEASURE_STATUS.MEASURED);
  assert.equal(res.restoreVerified, false);
  assert.equal(res.needsAttention, true);
  assert.equal(evo.rows.get(CONTRACT).restoreVerified, false, '标记必须写进数据，⛔ 不能靠事后人记得');
  assert.ok(warns.some(([m]) => /sha 不一致/.test(m)));
});

// ── H. 篡改门（§2.4.2 第 6 步的调用点）─────────────────────────────────

test('H1: 条目里的 predictedDelta 被改写 ⇒ CONTRACT_TAMPERED，不跑测试、不换文件、不写行', async () => {
  const e = entryOver();
  const evo = makeEvo({ entry: e });
  // 篡改 = **只动存储**（锁行原样留着）。若改条目也顺手重算锁，那条记录就自洽了，
  // 测的是"没被改过"的情形 —— 假夹具（与 §3.14 bus envelopeId 同一条教训）。
  e.summary.predictedDelta = 9.9;
  const calls = [];
  const { measurer, warns } = build({ dir: repo.dir, files: repo.files, evo, runner: contentDrivenRunner({ dir: repo.dir, calls }) });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(res.status, MEASURE_STATUS.CONTRACT_TAMPERED);
  assert.equal(res.auditStatus, 'CONTRACT_TAMPERED');
  assert.equal(calls.length, 0, '⛔ 门禁在任何副作用之前');
  assert.equal(String(await readFile(join(repo.dir, CHANGED), 'utf8')), 'export const v = "FIXED";\n');
  assert.equal(evo.rows.size, 0, '篡改过的预测不得进 PQ 与知识桶');
  assert.ok(warns.some(([m]) => /预测锁校验未过/.test(m)), '必须出声');
});

test('H2: 链上写着预测、锁行却不在了（删证据）⇒ 同样拒测并点名 LOCK_ROW_MISSING', async () => {
  const evo = makeEvo({ lock: null });
  const calls = [];
  const { measurer } = build({ dir: repo.dir, files: repo.files, evo, runner: contentDrivenRunner({ dir: repo.dir, calls }) });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(res.status, MEASURE_STATUS.CONTRACT_TAMPERED);
  assert.equal(res.auditStatus, 'LOCK_ROW_MISSING');
  assert.equal(calls.length, 0);
  assert.equal(evo.rows.size, 0);
});

test('H3: 摘要成分复原不出来（缺 predictionSource）⇒ UNEVIDENCED_HYPOTHESIS，⛔ 不当通过', async () => {
  const e = entryOver();
  const evo = makeEvo({ entry: e }); // 锁按完整条目算；存储里随后抽掉 predictionSource
  e.summary.predictionSource = null;
  const calls = [];
  const { measurer } = build({ dir: repo.dir, files: repo.files, evo, runner: contentDrivenRunner({ dir: repo.dir, calls }) });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(res.status, MEASURE_STATUS.CONTRACT_TAMPERED);
  assert.deepEqual(res.missing, ['predictionSource']);
  assert.equal(calls.length, 0);
});

test('H4: 没有预测的条目不受篡改门影响（actualDelta 仍是真观测，喂 τ 重标定）', async () => {
  const e = entryOver({ summary: { ...entryOver().summary, predictedDelta: null, predictionSource: null } });
  const evo = makeEvo({ entry: e, lock: null });
  const { measurer } = build({ dir: repo.dir, files: repo.files, evo, runner: contentDrivenRunner({ dir: repo.dir, calls: [] }) });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(res.status, MEASURE_STATUS.MEASURED, JSON.stringify(res));
  assert.equal(res.predictedDelta, null);
  assert.equal(evo.rows.get(CONTRACT).evidence.hypothesisLock, null);
});

// ── G. 批量：measurePending ──────────────────────────────────────────────

test('G1: 扫链只测"该测且没测过"的条目，limit 生效，deferred 可见', async () => {
  const a = entryOver({ contractId: 'EVO-A', seq: 1 });
  const b = entryOver({ contractId: 'EVO-B', seq: 2, summary: { ...entryOver().summary, decision: 'REJECT' } });  const c = entryOver({ contractId: 'EVO-C', seq: 3 });
  const entries = [a, b, c];
  const evo = makeEvo({ entry: a, entries });
  const calls = [];
  const { measurer } = build({ dir: repo.dir, files: repo.files, evo, runner: contentDrivenRunner({ dir: repo.dir, calls }) });

  const out = await measurer.measurePending({ repoRoot: repo.dir, limit: 1 });
  assert.equal(out.scanned, 3);
  assert.equal(out.measurable, 2, 'EVO-B 是 REJECT ⇒ 不算可测');
  assert.equal(out.attempted, 1);
  assert.equal(out.deferred, 1);
  assert.equal(out.counts[MEASURE_STATUS.MEASURED], 1);
  assert.equal(out.results[0].contractId, 'EVO-A');

  // 第二轮：A 已落表 ⇒ 不再计入待测，取 C
  const evo2 = evo;
  const out2 = await measurer.measurePending({ repoRoot: repo.dir, limit: 1 });
  assert.equal(out2.measurable, 1, 'A 已测过 ⇒ 待测只剩 C');
  assert.equal(out2.attempted, 1);
  assert.equal(out2.results[0].contractId, 'EVO-C');
  assert.equal(evo2.rows.size, 2);
});

test('G2: 批量入口在服务不可用 / 无 repoRoot 时如实返回，不抛', async () => {
  const m1 = createOutcomeMeasurer({ get: () => null }, { listRepoFiles: async () => [] });
  assert.equal((await m1.measurePending({ repoRoot: repo.dir })).status, MEASURE_STATUS.SERVICE_UNAVAILABLE);
  const m2 = createOutcomeMeasurer({ get: () => makeEvo() }, { listRepoFiles: async () => [] });
  assert.equal((await m2.measurePending({ repoRoot: null })).status, MEASURE_STATUS.NO_REPOROOT);
});

// ── I. R2 技能门禁：第二台仪器（2026-10-03 老板拍 7-1=1 / 7-2=1 / 7-3=1）─────
//
// 这一节盯四件事：① 仪器按 scope 的 rule 选（技能档 ⛔ 不许去 spawn node --test）；
// ② 双态真的换了 SKILL.md 且换回来；③ 槽是空的（无人签核）⇒ NO_EVIDENCE 且不写行；
// ④ 篡改门仍在**任何副作用之前** —— 我把指标门挪到了覆盖门之后，这道没挪。

const SKILL_REL = 'presets/agint/skills/demo/SKILL.md';
const CASE_REL = 'eval/skills/agint/demo.cases.json';
const SKILL_PRE = `.agint-preimage/presets__agint__skills__demo__SKILL.md__${STAMP}.bak`;
const SIGN = '2026-10-03T07:00:00.000Z';
const CANDIDATE_TEXT = '---\nname: demo\n---\n必须段 A\n必须段 B\n';
const BASELINE_TEXT = '---\nname: demo\n---\n必须段 A\n';

function skillEntry({ metric = 'unspecified', predictedDelta = null, lock = undefined, ...rest } = {}) {
  const base = entryOver();
  const summary = {
    ...base.summary,
    targetMetric: metric,
    changedPlugins: [],
    predictedDelta,
    predictionSource: predictedDelta === null ? null : base.summary.predictionSource,
  };
  return { evo: makeEvo({ entry: { ...base, ...rest, summary, references: { preimagePath: SKILL_PRE } }, lock }), entry: summary };
}

async function makeSkillRepo({ approved = 2, badShape = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agint-skill-gate-'));
  await mkdir(join(dir, '.agint-preimage'), { recursive: true });
  await mkdir(join(dir, 'presets', 'agint', 'skills', 'demo'), { recursive: true });
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, SKILL_REL), CANDIDATE_TEXT);
  await writeFile(join(dir, SKILL_PRE), BASELINE_TEXT);
  const cases = [];
  if (badShape) {
    cases.push({ id: 'broken-regex', kind: 'body/must-not-match', expect: '(', addedBy: 'boss', approvedAt: SIGN });
  } else {
    if (approved >= 1) cases.push({ id: 'has-a', kind: 'body/must-include', expect: '必须段 A', addedBy: 'boss', approvedAt: SIGN });
    if (approved >= 2) cases.push({ id: 'has-b', kind: 'body/must-include', expect: '必须段 B', addedBy: 'boss', approvedAt: SIGN });
  }
  await mkdir(join(dir, 'eval', 'skills', 'agint'), { recursive: true });
  await writeFile(join(dir, CASE_REL), JSON.stringify({ skill: 'demo', cases }));
  return { dir, files: [SKILL_REL, SKILL_PRE, CASE_REL, 'node_modules/.keep'] };
}

test('I1: 技能档走门禁 runner，双态真换文件 ⇒ +50pp 落表，method=SKILL_GATE_PAIR_RUN', async () => {
  const repo = await makeSkillRepo({ approved: 2 });
  const { evo } = skillEntry();                       // 条目链上 targetMetric='unspecified'
  const testCalls = [];
  const { measurer } = build({
    dir: repo.dir, files: repo.files, evo,
    runner: (a) => { testCalls.push(a); return { ok: true, timedOut: false, stdout: '', stderr: '' }; },
  });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(res.status, MEASURE_STATUS.MEASURED, JSON.stringify(res));
  assert.equal(testCalls.length, 0, '⛔ 技能档不许去 spawn node --test（仪器选型错了就会 >0）');
  assert.equal(res.actualDelta, 50, '基线 1/2 → 候选 2/2 = +50 百分点');
  assert.equal(res.method, 'SKILL_GATE_PAIR_RUN');
  const row = evo.rows.get(CONTRACT);
  assert.equal(row.method, 'SKILL_GATE_PAIR_RUN');
  assert.deepEqual(row.testFiles, [SKILL_REL, CASE_REL], '7-3=1：testFiles 语义 = 触达面文件');
  assert.equal(row.targetMetric, 'SUCCESS_RATE', '门禁按构造产通过率 ⇒ 死区按 3.0pp 那档取');
  assert.equal(row.evidence.entryTargetMetric, 'unspecified', '⛔ 不是改写历史：条目原话必须留在证据里');
  assert.equal(row.baseline.total, 2);
  assert.equal(row.candidate.passed, 2);
  assert.equal(row.restoreVerified, true);
  assert.equal(await readFile(join(repo.dir, SKILL_REL), 'utf8'), CANDIDATE_TEXT, '跑完必须仍是候选态');
  await rm(repo.dir, { recursive: true, force: true });
});

test('I2: 槽是空的（0 条已签核）⇒ NO_EVIDENCE、没换文件、没落表', async () => {
  const repo = await makeSkillRepo({ approved: 0 });
  const { evo } = skillEntry();
  const { measurer } = build({ dir: repo.dir, files: repo.files, evo, runner: async () => ({ ok: true, timedOut: false, stdout: '' }) });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(res.status, MEASURE_STATUS.NO_EVIDENCE);
  assert.match(res.reason, /已签核 case 0 条/, '要报得出"空槽"而不是"跑挂了"');
  assert.equal(evo.rows.size, 0, '⛔ 测不到不是度量（设计 §4.2.5）');
  assert.equal(await readFile(join(repo.dir, SKILL_REL), 'utf8'), CANDIDATE_TEXT, '拒绝发生在换文件之前');
  await rm(repo.dir, { recursive: true, force: true });
});

test('I3: case 形状坏（正则不合法）⇒ SKILL_GATE_INVALID，不写行', async () => {
  const repo = await makeSkillRepo({ badShape: true });
  const { evo } = skillEntry();
  const { measurer } = build({ dir: repo.dir, files: repo.files, evo, runner: async () => ({ ok: true, timedOut: false, stdout: '' }) });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(res.status, MEASURE_STATUS.SKILL_GATE_INVALID);
  assert.match(res.error ?? res.reason ?? '', /SKILL_GATE_INVALID/);
  assert.equal(evo.rows.size, 0, '仪器故障不能伪装成一次回归');
  assert.equal(await readFile(join(repo.dir, SKILL_REL), 'utf8'), CANDIDATE_TEXT);
  await rm(repo.dir, { recursive: true, force: true });
});

test('I4: 条目预测的是别的量纲（TOKEN_EFFICIENCY）⇒ 拒测，⛔ 不拿门禁通过率顶', async () => {
  const repo = await makeSkillRepo({ approved: 2 });
  const { evo } = skillEntry({ metric: 'TOKEN_EFFICIENCY', predictedDelta: 8.0 });
  const { measurer } = build({ dir: repo.dir, files: repo.files, evo, runner: async () => ({ ok: true, timedOut: false, stdout: '' }) });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(res.status, MEASURE_STATUS.UNSUPPORTED_METRIC);
  assert.match(res.reason, /不拿门禁通过率去代替它/);
  assert.equal(evo.rows.size, 0);
  await rm(repo.dir, { recursive: true, force: true });
});

test('I5: 篡改门仍在副作用之前 —— 指标门挪走没把它挪走', async () => {
  const repo = await makeSkillRepo({ approved: 2 });
  const { evo } = skillEntry({ metric: 'SUCCESS_RATE', predictedDelta: 3.0, lock: null }); // 锁行被删
  const calls = [];
  const { measurer } = build({
    dir: repo.dir, files: repo.files, evo,
    runner: (a) => { calls.push(a); return { ok: true, timedOut: false, stdout: '' }; },
  });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(res.status, MEASURE_STATUS.CONTRACT_TAMPERED);
  assert.equal(evo.rows.size, 0);
  assert.equal(await readFile(join(repo.dir, SKILL_REL), 'utf8'), CANDIDATE_TEXT, '拒测发生在换文件之前');
  await rm(repo.dir, { recursive: true, force: true });
});

test('I6: 技能档没金标文件 ⇒ 覆盖门先拦（NO_EVIDENCE），runner 一次都不跑', async () => {
  const repo = await makeSkillRepo({ approved: 2 });
  const { evo } = skillEntry();
  let gateRuns = 0;
  const { measurer } = build({
    dir: repo.dir,
    files: repo.files.filter((f) => f !== CASE_REL),   // 金标文件不在清单里
    evo,
    runner: async () => ({ ok: true, timedOut: false, stdout: '' }),
    opts: { runSkillGate: async (a) => { gateRuns += 1; return { ok: true, timedOut: false, gate: { passed: 1, failed: 0, total: 1, passRate: 1, approvedCount: 1, proposedCount: 0 } }; } },
  });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(res.status, MEASURE_STATUS.NO_EVIDENCE);
  assert.equal(res.rule, 'SKILL_GATE_NO_CASE_FILE');
  assert.equal(gateRuns, 0);
  await rm(repo.dir, { recursive: true, force: true });
});

test('G3: 意外异常也不抛（外壳纪律）—— 内部 IO 炸了返回状态 + needsAttention', async () => {
  const evo = makeEvo();
  const calls = [];
  const { measurer, warns } = build({
    dir: repo.dir,
    files: repo.files,
    evo,
    runner: contentDrivenRunner({ dir: repo.dir, calls }),
    opts: { listRepoFiles: async () => { throw new Error('walk exploded'); } },
  });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(res.ok, false);
  assert.match(res.error, /walk exploded/);
  assert.equal(calls.length, 0);
  assert.ok(warns.some(([m]) => /意外异常/.test(m)));
});

// ── J. repoRoot 分隔符归一（Windows 误判护栏，2026-10-04 生产实跑钉出）────────

test('J1: repoRoot 用正斜杠配置时 insideRepo 必须放行（旧实现 Windows 恒 false ⇒ 全量测量被误判 PREIMAGE_UNPARSEABLE）', async () => {
  const slashDir = repo.dir.replace(/[\\/]/g, '/');
  const calls = [];
  const evo = makeEvo();
  const { measurer } = build({ dir: repo.dir, files: repo.files, evo, runner: contentDrivenRunner({ dir: repo.dir, calls }) });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: slashDir });
  assert.equal(res.status, MEASURE_STATUS.MEASURED, JSON.stringify(res));
  assert.equal(calls.length, 2, '斜杠归一不改「文件在仓库内」这个事实 ⇒ 两侧真跑');
});

test('J2: 反解出仓库外的路径仍被拒（护栏没因归一而放松）', async () => {
  const odd = `.agint-preimage/..__..__evil.js__${STAMP}.bak`;
  const evo = makeEvo({ entry: entryOver({ references: { preimagePath: odd } }) });
  const calls = [];
  const { measurer } = build({ dir: repo.dir, files: repo.files, evo, runner: contentDrivenRunner({ dir: repo.dir, calls }) });
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: repo.dir });
  assert.equal(res.status, MEASURE_STATUS.PREIMAGE_UNPARSEABLE, JSON.stringify(res));
  assert.equal(res.reason, 'CHANGED_PATH_OUTSIDE_REPO');
  assert.equal(calls.length, 0, '拒测不跑测试');
  assert.equal(evo.rows.size, 0, '拒测不落表');
});
