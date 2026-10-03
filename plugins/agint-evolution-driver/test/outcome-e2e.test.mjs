/**
 * 端到端：真实临时 git 仓库 + 真实 node --test + 真实 agint-evolution-memory 服务
 *
 * 单元层（outcome-measurer.test.mjs）用假 runner 与假 evo，证的是判据分支。
 * 本文件证的是**接起来真的跑得通**，四件事缺一不可：
 *   1. 真子进程跑真测试 —— 两侧结果差异来自真文件内容，不是我编的 TAP 串。
 *   2. 真 memory 服务落表 —— 写进去的 entry 必须过 `predictionOutcomeEntrySchema`，
 *      schema 在这里是**裁判**，不是装饰（单测里的 mock 不吃 schema）。
 *   3. 真 Ledger 条目 —— 测量以链上条目为输入（preimagePath / predictedDelta 都从链读）。
 *   4. 真 hash 的篡改门 —— 锁行必须按 lockPrediction 的配方算出来，
 *      夹具里写死一个 hash 会让每条都判红（那正是 mock 失真的经典形状）。
 *
 * Run: node --test plugins/agint-evolution-driver/test/outcome-e2e.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOutcomeMeasurer, MEASURE_STATUS } from '../lib/outcome-measurer.js';
import { computeHypothesisLock } from '../lib/predictor.js';
import { buildLockHypothesis } from '../lib/prediction-locker.js';

const LOCKED_AT = '2026-10-03T07:59:00.000Z';

/** 与 contract-manager.lockPrediction 同一配方造一把真锁（夹具写死 hash 会被篡改门全判红）。 */
function realLock(entry) {
  const s = entry.summary;
  return computeHypothesisLock({
    hypothesis: {
      ...buildLockHypothesis({
        mutationType: s.mutationType,
        targetMetric: s.targetMetric,
        changedComponents: s.changedPlugins,
      }),
      predictedDelta: s.predictedDelta,
      predictionSource: s.predictionSource,
    },
    contractId: entry.contractId,
    createdAt: LOCKED_AT,
  });
}

const CONTRACT = 'EVO-CC82368A';
const STAMP = '2026-10-03T08-00-00-000Z';
const CHANGED = 'plugins/agint-e2e/lib/index.js';
const PREIMAGE = `.agint-preimage/plugins__agint-e2e__lib__index.js__${STAMP}.bak`;

/** 候选态（改后）：正确；preimage（改前）：把加法写成了返回常量。 */
const CODE_FIXED = 'export function add(a, b) { return a + b; }\n';
const CODE_BROKEN = 'export function add(a, b) { return 42; }\n';

const TEST_FILE = 'plugins/agint-e2e/test/e2e.test.mjs';
const TEST_TEXT = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../lib/index.js';
test('add(1,2) 等于 3', () => { assert.equal(add(1, 2), 3); });
test('add(-1,1) 等于 0', () => { assert.equal(add(-1, 1), 0); });
`;

async function makeGitRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'agint-e2e-'));
  await mkdir(join(dir, 'plugins', 'agint-e2e', 'lib'), { recursive: true });
  await mkdir(join(dir, 'plugins', 'agint-e2e', 'test'), { recursive: true });
  await mkdir(join(dir, '.agint-preimage'), { recursive: true });
  // 裸工作树守卫要的真目录标记（本用例的测试不依赖任何第三方包）
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, CHANGED), CODE_FIXED);
  await writeFile(join(dir, PREIMAGE), CODE_BROKEN);
  await writeFile(join(dir, TEST_FILE), TEST_TEXT);
  return dir;
}

/** 起真 agint-evolution-memory（mock storageDomain，按表名分 Map）。 */
async function bootEvolutionService() {
  const tables = new Map();
  const tableOf = (name) => {
    if (!tables.has(name)) {
      const records = new Map();
      tables.set(name, {
        entries: () => [...records.entries()][Symbol.iterator](),
        keys: () => [...records.keys()][Symbol.iterator](),
        get: (k) => records.get(k),
        get size() { return records.size; },
        async put(k, v) { records.set(k, v); return true; },
      });
    }
    return tables.get(name);
  };
  const ctx = {
    storageDomain: { open: async () => ({ table: async (name) => tableOf(name), close: async () => {} }) },
    effect: (fn) => { fn(); },
    get: () => null,
    on: () => {},
    logger: { warn: () => {} },
    provide(name, val) { this._provided = this._provided ?? {}; this._provided[name] = val; },
  };
  const mod = await import('../../agint-evolution-memory/lib/index.js');
  mod.apply(ctx, {});
  await new Promise((r) => setImmediate(r));
  return { evo: ctx._provided['agint.evolution'], tableOf };
}

test('E2E: 双态真跑 → 真 delta → 过真 schema 落表 → 跑完文件回到候选态', async () => {
  const dir = await makeGitRepo();
  const { evo } = await bootEvolutionService();

  // ① 链上先有一条本次进化的条目（实时路径的产物形状）
  const appended = await evo.ledger.append({
    contractId: CONTRACT,
    generation: 'GEN-022',
    summary: {
      mutationType: 'PROMPT_MUTATION',
      changedPlugins: ['agint-e2e'],
      targetMetric: 'SUCCESS_RATE',
      hypothesisDigest: 'fix add()',
      predictedDelta: 3.0,
      actualDelta: null,
      predictionQuality: null,
      predictionSource: 'DEFAULT_RULE',
      decision: 'AUTO_DEPLOY',
    },
    references: { preimagePath: PREIMAGE },
    timestamp: '2026-10-03T08:00:00.000Z',
  });
  assert.equal(appended.ok !== false, true, JSON.stringify(appended));
  const seq = appended.entry.seq;

  // ② 锁在先（1a 的产物），且必须是**真锁**：篡改门会重算比对
  const hypothesisLock = realLock(appended.entry);
  await evo.recordContractLock({
    contractId: CONTRACT,
    hypothesisLock,
    lockedAt: LOCKED_AT,
    predictionSource: 'DEFAULT_RULE',
  });

  const warns = [];
  const measurer = createOutcomeMeasurer(
    { get: (n) => (n === 'agint.evolution' ? evo : null) },
    {
      listRepoFiles: async (root) => [CHANGED, TEST_FILE, PREIMAGE, 'node_modules/.keep'],
      warn: (m, e) => warns.push([m, e]),
      now: () => '2026-10-03T09:00:00.000Z',
    },
  );

  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: dir });

  // ③ 判读：真跑出来的数
  assert.equal(res.status, MEASURE_STATUS.MEASURED, JSON.stringify(res));
  assert.equal(res.baseline.total, 2, '基线跑了 2 条');
  assert.equal(res.baseline.passed, 0, 'preimage 里 add() 是坏的 ⇒ 全红');
  assert.equal(res.candidate.passed, 2, '候选态修好了 ⇒ 全绿');
  assert.equal(res.actualDelta, 100);
  assert.equal(res.isDeadZone, false);
  assert.equal(res.restoreVerified, true);
  assert.equal(warns.length, 0, `不该有任何告警：${JSON.stringify(warns)}`);

  // ④ 盘已复原
  assert.equal(String(await readFile(join(dir, CHANGED), 'utf8')), CODE_FIXED);
  // preimage 本身没被动过（只读它，不写它）
  assert.equal(String(await readFile(join(dir, PREIMAGE), 'utf8')), CODE_BROKEN);

  // ⑤ 表里那一行是真服务按真 schema 收下的
  const row = await evo.getPredictionOutcome(CONTRACT);
  assert.ok(row, 'recordPredictionOutcome 必须真的落了一行');
  assert.equal(row.method, 'TEST_CORPUS_PAIR_RUN');
  assert.equal(row.changedPath, CHANGED);
  assert.deepEqual(row.testFiles, [TEST_FILE]);
  assert.equal(row.predictedDelta, 3.0);
  assert.equal(row.actualDelta, 100);
  assert.ok(Number.isFinite(row.predictionQuality) && row.predictionQuality > 0 && row.predictionQuality < 1);
  assert.equal(row.evidence.ledgerSeq, seq);
  assert.equal(row.evidence.hypothesisLock, hypothesisLock);
  assert.equal(row.evidence.preimagePath, PREIMAGE);
  assert.match(row.evidence.candidateSha, /^sha256:[0-9a-f]{64}$/);
  assert.match(row.evidence.baselineSha, /^sha256:[0-9a-f]{64}$/);

  // ⑥ 再测一条不存在的：幂等，不会再跑一遍子进程
  const again = await measurer.measureOne({ contractId: CONTRACT, repoRoot: dir });
  assert.equal(again.status, MEASURE_STATUS.IDEMPOTENT);

  await rm(dir, { recursive: true, force: true });
});

test('E2E: 覆盖门在真仓库上同样成立 —— 改 README 没有任何测试触达 ⇒ 不写行', async () => {
  const dir = await makeGitRepo();
  const { evo } = await bootEvolutionService();
  const docRel = 'docs/AGINT-note.md';
  const docPre = '.agint-preimage/docs__AGINT-note.md__2026-10-03T08-00-00-000Z.bak';
  await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, docRel), '# note (改后)\n');
  await writeFile(join(dir, docPre), '# note (改前)\n');

  const appended = await evo.ledger.append({
    contractId: 'EVO-DOC1',
    generation: 'GEN-022',
    summary: {
      mutationType: 'PROMPT_MUTATION', changedPlugins: [], targetMetric: 'SUCCESS_RATE',
      hypothesisDigest: 'doc only', predictedDelta: 3.0, actualDelta: null, predictionQuality: null,
      predictionSource: 'DEFAULT_RULE', decision: 'AUTO_DEPLOY',
    },
    references: { preimagePath: docPre },
    timestamp: '2026-10-03T08:00:00.000Z',
  });
  await evo.recordContractLock({
    contractId: 'EVO-DOC1', hypothesisLock: realLock(appended.entry), lockedAt: LOCKED_AT,
    predictionSource: 'DEFAULT_RULE',
  });

  const measurer = createOutcomeMeasurer(
    { get: () => evo },
    { listRepoFiles: async () => [docRel, docPre, CHANGED, TEST_FILE, 'node_modules/.keep'] },
  );
  const res = await measurer.measureOne({ contractId: 'EVO-DOC1', repoRoot: dir });
  assert.equal(res.status, MEASURE_STATUS.NO_EVIDENCE);
  assert.equal(res.reason, 'NO_INSTRUMENT_FOR_TARGET_KIND');
  assert.equal(await evo.getPredictionOutcome('EVO-DOC1'), null, '⛔ 测不到不是度量');
  await rm(dir, { recursive: true, force: true });
});

test('E2E: 事后改写链上的预测值 ⇒ 篡改门在跑测试之前就拦下（真 hash、真服务、真盘）', async () => {
  const dir = await makeGitRepo();
  const { evo, tableOf } = await bootEvolutionService();
  const appended = await evo.ledger.append({
    contractId: CONTRACT,
    generation: 'GEN-022',
    summary: {
      mutationType: 'PROMPT_MUTATION', changedPlugins: ['agint-e2e'], targetMetric: 'SUCCESS_RATE',
      hypothesisDigest: 'fix add()', predictedDelta: 3.0, actualDelta: null, predictionQuality: null,
      predictionSource: 'DEFAULT_RULE', decision: 'AUTO_DEPLOY',
    },
    references: { preimagePath: PREIMAGE },
    timestamp: '2026-10-03T08:00:00.000Z',
  });
  await evo.recordContractLock({
    contractId: CONTRACT, hypothesisLock: realLock(appended.entry), lockedAt: LOCKED_AT,
    predictionSource: 'DEFAULT_RULE',
  });

  // 篡改：把存储里那条**条目的预测值**改掉（锁行原样留着 ⇒ 重算必对不上）。
  const ledger = tableOf('evolution_ledger');
  let targetKey = null;
  for (const [k, v] of ledger.entries()) if (v?.contractId === CONTRACT) targetKey = k;
  assert.ok(targetKey !== null, '条目应已按 seq 落进链表');
  const orig = ledger.get(targetKey);
  await ledger.put(targetKey, { ...orig, summary: { ...orig.summary, predictedDelta: 9.9 } });

  let ran = 0;
  const measurer = createOutcomeMeasurer(
    { get: () => evo },
    {
      listRepoFiles: async () => [CHANGED, TEST_FILE, PREIMAGE, 'node_modules/.keep'],
      runTests: async () => { ran += 1; return { ok: true, timedOut: false, stdout: '', stderr: '', error: null }; },
    },
  );
  const res = await measurer.measureOne({ contractId: CONTRACT, repoRoot: dir });

  assert.equal(res.status, MEASURE_STATUS.CONTRACT_TAMPERED, JSON.stringify(res));
  assert.equal(res.auditStatus, 'CONTRACT_TAMPERED');
  assert.equal(ran, 0, '⛔ 篡改门在前 ⇒ 一次测试都没跑、一次文件都没换');
  assert.equal(String(await readFile(join(dir, CHANGED), 'utf8')), CODE_FIXED, '盘上内容原样');
  assert.equal(await evo.getPredictionOutcome(CONTRACT), null, '篡改过的预测不得进 PQ / 知识桶');

  // 反向自愈：把条目改回原值 ⇒ 同一条现在可测（证明拒测的因是"对不上"而不是"门禁恒红"）
  await ledger.put(targetKey, orig);
  const measurer2 = createOutcomeMeasurer(
    { get: () => evo },
    { listRepoFiles: async () => [CHANGED, TEST_FILE, PREIMAGE, 'node_modules/.keep'] },
  );
  const back = await measurer2.measureOne({ contractId: CONTRACT, repoRoot: dir });
  assert.equal(back.status, MEASURE_STATUS.MEASURED, JSON.stringify(back));
  assert.equal(back.actualDelta, 100);
  await rm(dir, { recursive: true, force: true });
});
