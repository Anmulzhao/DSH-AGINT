/**
 * agint-evolution-driver —— outcome-measurer.js
 *
 * Phase 1.1 支点 **1b / R1′** 的测量本体：把一次**已经落在仓库里**的变异，
 * 用「同一条测试子集跑两遍（改后态 / 改前态）」量成一条 `actualDelta`。
 *
 * ## 它补的是哪个洞
 *
 * 1a 让系统在评估之前就把 `predictedDelta` 锁进了 `contract_locks`。
 * 但锁只有对面那半 —— 没有实测，PQ 永远算不出来，τ 永远标不了，
 * Phase 2 的「策略 → 效果」训练集永远是空的。本文件写的就是那另一半。
 *
 * ## 为什么是"双态跑同一子集"，不是"场景集"或"全仓 passRate"
 *
 * 2026-10-03 拿一次真实历史变异做的对照实验（详见
 * `D:/DSH/_1b_actualDelta尺子方案_20261003.md` §8）：
 *   - `eval/scenarios` 场景集 123 条：改前改后**逐条零差异** ⇒ 看不见这处改动。
 *   - 按被改文件筛出的测试子集（3 条）：3/3 → 2/3 ⇒ **看得见**。
 *   - 全仓 1928 条 passRate：只动 0.05pp，远小于死区 1.5pp ⇒ 会被读成"无实质变化"。
 * 筛子集的判断在 `outcome-scope.js`（纯函数），本文件只做它的外部世界那一侧。
 *
 * ## 四条护栏（每条都是"不写就会出事故"换来的）
 *
 * 1. ⛔ **只换一个文件，且必须在 repoRoot 内**。基线态靠把被改文件临时换回
 *    preimage 得到。换之前核过 `abs` 落在 `repoRoot` 下，且不碰 `.git/`、`.agint-preimage/`。
 * 2. ⛔ **换完必须换回来，且核 sha**。跑完基线立刻写回候选态字节，再读一次算 sha
 *    与换出前对比 ⇒ `restoreVerified`。核不上照实写进记录并升级告警，
 *    ⛔ 不许把这条测量悄悄当成正常（Schema 注释里就要求带着这个标记）。
 * 3. ⛔ **裸工作树直接拒测**。没有 `node_modules` 的 worktree 会得到假基线
 *    23/123（实测：插件 `import 'zod'` 全报 ERR_MODULE_NOT_FOUND）。
 *    量出来是垃圾就必须拒绝量，不是量了再解释。
 * 4. ⛔ **测不到 ≠ 没改进**。覆盖门筛不出测试 ⇒ `NO_EVIDENCE`，
 *    `prediction_outcomes` 里**一行都不写**（设计 §4.2.5）。
 *
 * ## 没有预测的条目也测
 *
 * `predictedDelta` 为 null 时照样落表：PQ 记 null + `pqReason='NOT_PREDICTED'`，
 * 但 `actualDelta` 是真观测。理由：τ_metric 的重标定要的就是"4 周实测 IQR"，
 * 只测预测过的那些 ⇒ 标定永远凑不齐样本。
 *
 * ## 本模块永不抛
 *
 * 与 `prediction-locker.js` 同一条外壳纪律：所有失败都以 `{ ok:false, status }` 返回 + `warn`。
 * 理由：跑在 cron 里，抛一次就把整轮对账带走。
 * 唯一的硬副作用（换文件）由 `finally` 保证回滚；回滚失败额外带
 * `needsAttention: true` 冒到 summary，由上层决定升级方式。
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve as pathResolve, sep } from 'node:path';

import { parsePreimagePath, deriveTestFiles, planTestScope } from './outcome-scope.js';
import { scorePrediction, deadZoneThreshold } from './prediction-scoring.js';

/** 终态枚举。只有 `MEASURED` 与 `IDEMPOTENT` 会在表里留下行。 */
export const MEASURE_STATUS = Object.freeze({
  MEASURED: 'MEASURED',                        // 一次真测量，已落表
  IDEMPOTENT: 'IDEMPOTENT',                    // 同 contractId 已有记录（重跑的正常形状）
  NO_REPOROOT: 'NO_REPOROOT',                  // 没仓库根，无从谈"哪个文件的改前态"
  NO_REPO_FILE_LIST: 'NO_REPO_FILE_LIST',      // 未注入 listRepoFiles ⇒ 判据跑不起来
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',  // agint.evolution 缺表方法（插件未部署或未重启）
  NOT_MEASURABLE: 'NOT_MEASURABLE',            // REJECT/ABSTAIN：改动已回滚，没有"改后态"可测
  NO_LEDGER_ENTRY: 'NO_LEDGER_ENTRY',          // 有锁没条目：这次进化没入链
  NO_PREIMAGE: 'NO_PREIMAGE',                  // 条目里没 preimagePath：没备份就没有基线
  UNSUPPORTED_METRIC: 'UNSUPPORTED_METRIC',    // 目标指标不是通过率，本仪器量不了
  PREIMAGE_UNPARSEABLE: 'PREIMAGE_UNPARSEABLE', // 名字解不出路径，或解出的路径不在仓库里
  PREIMAGE_MISSING: 'PREIMAGE_MISSING',        // 备份文件不在盘上
  SUPERSEDED: 'SUPERSEDED',                    // 同文件后来又被改过：归因不唯一
  NO_TEST_RUNTIME: 'NO_TEST_RUNTIME',          // 裸工作树（无 node_modules）⇒ 假基线，拒测
  NO_EVIDENCE: 'NO_EVIDENCE',                  // 覆盖门：筛不出测试触达被改文件
  TEST_SET_TOO_LARGE: 'TEST_SET_TOO_LARGE',    // 子集大到命令行装不下，宁可不测
  RUNNER_FAILED: 'RUNNER_FAILED',              // 进程起不来
  RUNNER_UNPARSABLE: 'RUNNER_UNPARSABLE',      // 输出里没有 node:test 的 TAP 汇总行
  RUNNER_TIMEOUT: 'RUNNER_TIMEOUT',            // 超时，或有 cancelled 计数
  CONCURRENT_WRITE: 'CONCURRENT_WRITE',        // 动手前发现文件已变：不是我们要测的那个态
  RESTORE_FAILED: 'RESTORE_FAILED',            // 换不回候选态（仓库此刻仍是基线态！）
  RECORD_FAILED: 'RECORD_FAILED',              // 测量成立但落表抛错
});

/** 只有这两种决策的改动**还在仓库里**（REJECT/ABSTAIN 已从 preimage 回滚）。 */
export const MEASURABLE_DECISIONS = Object.freeze(['AUTO_DEPLOY', 'PENDING_REVIEW']);

/** 本仪器只认得出"通过率"这一种效应量 —— 跑测试数数，别的量不出来。 */
export const MEASURABLE_METRICS = Object.freeze(['SUCCESS_RATE']);

/** 单次跑的默认上限（实测：全仓 60 秒，插件子集通常 <5 秒）。 */
export const DEFAULT_RUN_TIMEOUT_MS = 180_000;

/** 命令行能装的测试文件数上限（Windows 命令行 ~32k 字符，一个路径 ~80 字节）。 */
export const MAX_TEST_FILES = 40;

/** 一轮批量测量的默认条数上限（一期最多几个候选 ⇒ 5 条排得进周窗口）。 */
export const DEFAULT_OUTCOME_LIMIT = 5;

// ── 纯计算（可单测，不碰外部世界）────────────────────────────────────────

export function sha256Buf(buf) {
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

/**
 * TAP 汇总行 → 一侧计数。
 *
 * 分母自己加（`pass + fail + skipped + todo`），⛔ 不直接用 `# tests`：
 * `tests` 含 cancelled（超时被杀的那些），把一次跑挂掉的套件算成"通过率低"
 * 就是把仪器故障算成回归。`cancelled` 单独返回给 caller 判 RUNNER_TIMEOUT。
 *
 * 口径如实说明：skipped / todo 进分母不进分子 ⇒ 一次"全绿但有 3 条 skip"的
 * 跑出来是 8/11 不是 1。两侧同一套文件、同一份 skip ⇒ delta 不受影响。
 */
export function parseTapSummary(text) {
  const s = typeof text === 'string' ? text : '';
  const num = (label) => {
    const m = new RegExp(`^#[^\\S\\n]+${label}[^\\S\\n]+(\\d+)\\s*$`, 'm').exec(s);
    return m ? Number(m[1]) : null;
  };
  const pass = num('pass');
  const fail = num('fail');
  if (pass === null && fail === null) return null; // 没有汇总行 = 输出不是 node:test 的 TAP
  const passed = pass ?? 0;
  const failed = fail ?? 0;
  const skipped = num('skipped') ?? 0;
  const todo = num('todo') ?? 0;
  const cancelled = num('cancelled') ?? 0;
  const total = passed + failed + skipped + todo;
  return { passed, failed, skipped, todo, cancelled, total, passRate: total === 0 ? null : passed / total };
}

/**
 * actualDelta，单位 = **百分点**（与 `TAU_METRIC.SUCCESS_RATE = 3.0`「3.0pp」同量纲）。
 *
 * 任一侧比率缺失 ⇒ null（⛔ 不是 0）。写 0 会被读成"改了但没效果"，
 * 而 null 走的是上层那条"不写表"的路 —— 两者含义完全不同。
 */
export function computeActualDelta(baselinePassRate, candidatePassRate) {
  if (!Number.isFinite(baselinePassRate) || !Number.isFinite(candidatePassRate)) return null;
  return (candidatePassRate - baselinePassRate) * 100;
}

/** 是否可测条目：决策让改动留在盘上 + 有 preimage 备份。 */
export function isMeasurableEntry(entry) {
  if (!entry?.contractId) return { ok: false, status: MEASURE_STATUS.NO_LEDGER_ENTRY };
  const decision = entry?.summary?.decision;
  if (!MEASURABLE_DECISIONS.includes(decision)) {
    return { ok: false, status: MEASURE_STATUS.NOT_MEASURABLE, reason: `decision=${decision ?? 'null'}` };
  }
  if (!entry?.references?.preimagePath) {
    return { ok: false, status: MEASURE_STATUS.NO_PREIMAGE };
  }
  return { ok: true };
}

// ── 真实跑测试的 runner（可整体注入替换）─────────────────────────────────

/**
 * 在 repoRoot 跑 `node --test --test-reporter=tap <files>`。
 *
 * 用 `process.execPath` 而不是 `'node'`：PATH 里有没有 node 取决于谁起的宿主，
 * 而宿主自己就是 node 进程 ⇒ 拿自身可执行文件最稳。
 * 不拼 shell 字符串：`spawn` 走 argv 数组，路径里的空格/引号不构成命令注入面。
 *
 * ⚠️ 必须清掉 `NODE_TEST_CONTEXT`（E2E 实测踩到）：宿主若本身跑在 `node --test` 下
 * （测试套件、CI、以及本仓的一切端到端），这个环境变量会传给子进程，
 * 子 node 就认定"我在测试文件里递归" ⇒ 直接跳过跑文件、只打一行 warning。
 * 表现是 `RUNNER_UNPARSABLE` 而不是假数据 —— 守卫有效，但量不到就是量不到。
 */
export function nodeTestRunner({ repoRoot, files, timeoutMs = DEFAULT_RUN_TIMEOUT_MS }) {
  return new Promise((resolvePromise) => {
    const args = ['--test', '--test-reporter=tap', ...files];
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    let child;
    try {
      child = spawn(process.execPath, args, { cwd: repoRoot, windowsHide: true, env });
    } catch (error) {
      resolvePromise({ ok: false, timedOut: false, stdout: '', stderr: '', error: error?.message ?? String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise(r); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ ok: false, timedOut: true, stdout, stderr, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => {
      finish({ ok: false, timedOut: false, stdout, stderr, error: err?.message ?? String(err) });
    });
    child.on('close', () => {
      // node --test 在被测套件失败时非零退出 —— 那是**测量结果**，不是运行故障。
      // 所以这里不用 exitCode 判 ok，只看 caller 能否解析出汇总行。
      finish({ ok: true, timedOut: false, stdout, stderr, error: null });
    });
  });
}

// ── 工厂 ──────────────────────────────────────────────────────────────────

/**
 * @param {object} ctx  cordis 上下文（`ctx.get('agint.evolution')`，调用时取、不缓存）
 * @param {object} [opts]
 * @param {Function} [opts.listRepoFiles] `(repoRoot) => Promise<string[]>`。
 *        **故意不给默认实现**：仓库扫描在 `lib/index.js` 已有一份（带 `fs.scanRepo` 注入位），
 *        这里再抄一份就是第二个真相源；没注入就如实报 NO_REPO_FILE_LIST。
 * @param {Function} [opts.runTests]  覆盖 runner（单测用）
 * @param {Function} [opts.warn]
 * @param {Function} [opts.now]
 * @param {number}   [opts.timeoutMs]
 */
export function createOutcomeMeasurer(ctx, opts = {}) {
  const {
    listRepoFiles = null,
    runTests = nodeTestRunner,
    warn = () => {},
    now = () => new Date().toISOString(),
    read = readFile,
    write = writeFile,
    exists = existsSync,
    timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  } = opts;

  const dep = (n) => (ctx && typeof ctx.get === 'function' ? ctx.get(n) : null);

  /** 越界与噪声目录护栏：被换的文件必须在 repoRoot 内，且不在 .git / .agint-preimage 下。 */
  function insideRepo(repoRoot, rel) {
    const norm = String(rel).replace(/\\/g, '/');
    if (norm.startsWith('.git/') || norm.startsWith('.agint-preimage/')) return false;
    const root = repoRoot.endsWith(sep) ? repoRoot : `${repoRoot}${sep}`;
    return pathResolve(repoRoot, norm).startsWith(root);
  }

  /** 一侧跑完的判读：把 runner 结果换成 summary 或终态。 */
  async function runSide({ label, repoRoot, files }) {
    const res = await runTests({ repoRoot, files, timeoutMs });
    if (res?.timedOut) return { status: MEASURE_STATUS.RUNNER_TIMEOUT, side: label, error: res.error ?? null };
    const summary = parseTapSummary(res?.stdout);
    if (!summary) {
      return {
        status: res?.ok ? MEASURE_STATUS.RUNNER_UNPARSABLE : MEASURE_STATUS.RUNNER_FAILED,
        side: label,
        error: res?.error ?? null,
        stderrTail: String(res?.stderr ?? '').slice(-400) || null,
      };
    }
    if (summary.cancelled > 0) return { status: MEASURE_STATUS.RUNNER_TIMEOUT, side: label, cancelled: summary.cancelled };
    if (!Number.isFinite(summary.passRate)) {
      return { status: MEASURE_STATUS.NO_EVIDENCE, side: label, reason: '分母为 0（一条测试都没跑到）' };
    }
    return { side: label, run: summary };
  }

  /**
   * 测一条契约。永不抛。
   *
   * @param {object} input
   * @param {string} input.contractId
   * @param {string|null} input.repoRoot
   * @param {object[]} [input.entries] 批量时预先读好的 ledger 全表（省掉每条一次全表扫）
   */
  async function measureOne({ contractId, repoRoot, entries = null } = {}) {
    const fail = (status, extra = {}) => ({ ok: false, status, contractId: contractId ?? null, ...extra });

    if (!repoRoot) return fail(MEASURE_STATUS.NO_REPOROOT);
    if (typeof listRepoFiles !== 'function') return fail(MEASURE_STATUS.NO_REPO_FILE_LIST);

    const evo = dep('agint.evolution');
    const missing = ['recordPredictionOutcome', 'getPredictionOutcome', 'getContractLock']
      .filter((m) => typeof evo?.[m] !== 'function');
    if (typeof evo?.ledger?.findByContractId !== 'function') missing.push('ledger.findByContractId');
    if (missing.length > 0) {
      return fail(MEASURE_STATUS.SERVICE_UNAVAILABLE, {
        reason: `agint.evolution 缺少 ${missing.join(', ')}（插件未部署或未重启）`,
        missing,
      });
    }

    let changedAbs = null;
    let candidateBuf = null;
    let swapHappened = false;
    let restoreVerified = false;

    try {
      // 幂等在最前：已经测过的直接返回，不去动盘（重跑一轮不该再换一次文件）。
      const existing = await evo.getPredictionOutcome(contractId);
      if (existing) {
        return { ok: true, status: MEASURE_STATUS.IDEMPOTENT, contractId, seq: existing.evidence?.ledgerSeq ?? null };
      }

      let entry = Array.isArray(entries) ? entries.find((e) => e?.contractId === contractId) : null;
      if (!entry) entry = await evo.ledger.findByContractId(contractId);
      if (!entry) return fail(MEASURE_STATUS.NO_LEDGER_ENTRY);

      const gate = isMeasurableEntry(entry);
      if (!gate.ok) return fail(gate.status, { reason: gate.reason ?? null, decision: entry.summary?.decision ?? null });

      const metric = entry.summary?.targetMetric;
      if (!MEASURABLE_METRICS.includes(metric)) {
        return fail(MEASURE_STATUS.UNSUPPORTED_METRIC, {
          reason: `targetMetric=${metric ?? 'null'}；本仪器只量得出通过率`,
        });
      }

      const preimagePath = entry.references.preimagePath;
      const parsed = parsePreimagePath(preimagePath);
      if (!parsed.ok) return fail(MEASURE_STATUS.PREIMAGE_UNPARSEABLE, { reason: parsed.reason, preimagePath });
      const changedPath = parsed.repoRelPath;
      if (!insideRepo(repoRoot, changedPath)) {
        return fail(MEASURE_STATUS.PREIMAGE_UNPARSEABLE, { reason: 'CHANGED_PATH_OUTSIDE_REPO', changedPath });
      }
      const preimageAbs = pathResolve(repoRoot, preimagePath);
      if (!exists(preimageAbs)) return fail(MEASURE_STATUS.PREIMAGE_MISSING, { preimagePath });

      // 归因唯一性：同一路径后来又被别处改过 ⇒ 这条 delta 说不清是谁的贡献。
      const all = Array.isArray(entries) ? entries : await evo.ledger.list();
      const later = [];
      for (const e of all) {
        if (!e || e.contractId === contractId) continue;
        if (!(e.timestamp > entry.timestamp)) continue;
        const p = parsePreimagePath(e?.references?.preimagePath);
        if (p.ok && p.repoRelPath === changedPath) later.push(e.contractId);
      }
      if (later.length > 0) {
        return fail(MEASURE_STATUS.SUPERSEDED, { reason: `同文件后续条目：${later.join(', ')}` });
      }

      // 裸工作树守卫（护栏 3）
      if (!exists(join(repoRoot, 'node_modules'))) {
        return fail(MEASURE_STATUS.NO_TEST_RUNTIME, { reason: 'repoRoot 下没有 node_modules ⇒ 跑测试会得假基线' });
      }

      // 覆盖门（护栏 4）
      const repoFiles = await listRepoFiles(repoRoot);
      const scope = planTestScope({ changedPath, testFiles: deriveTestFiles(repoFiles), repoFiles });
      if (!scope.covered) {
        const status = scope.reason === 'CHANGED_PATH_NOT_FOUND' ? MEASURE_STATUS.PREIMAGE_UNPARSEABLE : MEASURE_STATUS.NO_EVIDENCE;
        return fail(status, { reason: scope.reason, rule: scope.rule, changedPath });
      }
      if (scope.files.length > MAX_TEST_FILES) {
        return fail(MEASURE_STATUS.TEST_SET_TOO_LARGE, { count: scope.files.length, rule: scope.rule });
      }

      // 动手前取现状：它既是"候选态"的定义，也是稍后要核回去的东西。
      changedAbs = pathResolve(repoRoot, changedPath);
      try {
        candidateBuf = await read(changedAbs);
      } catch (error) {
        return fail(MEASURE_STATUS.PREIMAGE_MISSING, { reason: `读被改文件失败：${error?.message ?? error}` });
      }
      const candidateSha = sha256Buf(candidateBuf);

      // 候选态先跑：这一刻盘上没有任何临时改动，失败也不用回滚。
      const cand = await runSide({ label: 'candidate', repoRoot, files: scope.files });
      if (cand.status) return fail(cand.status, { ...cand, changedPath, testFiles: scope.files });

      // 换基线态前的最后两道核：备份读得出、现状没被人动过。
      let baselineBuf;
      try {
        baselineBuf = await read(preimageAbs);
      } catch (error) {
        return fail(MEASURE_STATUS.PREIMAGE_MISSING, { reason: `读 preimage 失败：${error?.message ?? error}` });
      }
      const justBefore = await read(changedAbs).catch(() => null);
      if (!justBefore || sha256Buf(justBefore) !== candidateSha) {
        return fail(MEASURE_STATUS.CONCURRENT_WRITE, { changedPath });
      }

      // ── 从这里起有硬副作用：finally 必须把候选态换回去 ──
      let baseline;
      try {
        await write(changedAbs, baselineBuf);
        swapHappened = true;
        baseline = await runSide({ label: 'baseline', repoRoot, files: scope.files });
        if (baseline.status) return fail(baseline.status, { ...baseline, changedPath, testFiles: scope.files });
      } finally {
        try {
          await write(changedAbs, candidateBuf);
          const after = await read(changedAbs);
          restoreVerified = sha256Buf(after) === candidateSha;
          if (!restoreVerified) {
            warn('outcome-measurer: ⚠ 复原后 sha 不一致，该条测量带 restoreVerified:false 落表', { contractId, changedPath });
          }
        } catch (error) {
          warn('outcome-measurer: ⛔ 候选态未恢复，仓库仍处基线态，需人工处理', {
            contractId, changedPath, error: error?.message ?? error,
          });
          return { ...fail(MEASURE_STATUS.RESTORE_FAILED, { changedPath, error: error?.message ?? error }), needsAttention: true };
        }
      }

      const actualDelta = computeActualDelta(baseline.run.passRate, cand.run.passRate);
      if (actualDelta === null) {
        return fail(MEASURE_STATUS.NO_EVIDENCE, { reason: 'passRate 缺失，算不出 delta' });
      }

      const lock = await evo.getContractLock(contractId);
      const predictedDelta = Number.isFinite(entry.summary?.predictedDelta) ? entry.summary.predictedDelta : null;
      const scored = scorePrediction({
        predictedDelta,
        actualDelta,
        targetMetric: metric,
        baselineNoiseStd: null, // 生产无人写这个值 ⇒ 不参与（拿不到就不编，见 prediction-scoring 头注）
      });
      const dz = deadZoneThreshold(metric, null);
      // scorePrediction 只在"有预测可评"时给 isDeadZone；没预测时自己按阈值判。
      const isDeadZone = typeof scored.isDeadZone === 'boolean'
        ? scored.isDeadZone
        : (Number.isFinite(dz.threshold) ? Math.abs(actualDelta) < dz.threshold : false);

      const record = {
        contractId,
        measuredAt: now(),
        method: 'TEST_CORPUS_PAIR_RUN',
        targetMetric: metric,
        changedPath,
        testFiles: scope.files,
        baseline: {
          passed: baseline.run.passed, failed: baseline.run.failed,
          total: baseline.run.total, passRate: baseline.run.passRate,
        },
        candidate: {
          passed: cand.run.passed, failed: cand.run.failed,
          total: cand.run.total, passRate: cand.run.passRate,
        },
        actualDelta,
        predictedDelta,
        predictionQuality: scored.pq,
        pqReason: scored.reason ?? null,
        isDeadZone: Boolean(isDeadZone),
        deadZoneThreshold: dz.threshold,
        baselineNoiseStd: null,
        restoreVerified,
        evidence: {
          preimagePath,
          baselineSha: sha256Buf(baselineBuf),
          candidateSha,
          ledgerSeq: Number.isInteger(entry.seq) ? entry.seq : null,
          hypothesisLock: lock?.hypothesisLock ?? null,
        },
      };

      try {
        const saved = await evo.recordPredictionOutcome(record);
        if (saved?._warn) warn('outcome-measurer: prediction_outcomes 超限', { warn: saved._warn });
      } catch (error) {
        const msg = error?.message ?? String(error);
        if (msg.includes('already-exists')) {
          return { ok: true, status: MEASURE_STATUS.IDEMPOTENT, contractId, actualDelta };
        }
        warn('outcome-measurer: 落表失败（测量已做，未落盘）', { contractId, error: msg });
        return fail(MEASURE_STATUS.RECORD_FAILED, { error: msg, actualDelta });
      }

      return {
        ok: true,
        status: MEASURE_STATUS.MEASURED,
        contractId,
        changedPath,
        rule: scope.rule,
        testCount: scope.files.length,
        baseline: record.baseline,
        candidate: record.candidate,
        actualDelta,
        predictedDelta,
        predictionQuality: scored.pq,
        isDeadZone: record.isDeadZone,
        restoreVerified,
        // 护栏 2：核不上 sha 的那条要冒到上层，⛔ 不许悄悄算一次正常测量
        needsAttention: restoreVerified === false,
      };
    } catch (error) {
      // 外壳：本函数永不抛（cron 里抛一次带走整轮对账）。
      const msg = error?.message ?? String(error);
      warn('outcome-measurer: 意外异常（已吞并上报状态）', { contractId, error: msg });
      const extra = swapHappened && !restoreVerified
        ? { needsAttention: true, note: '异常发生在换文件之后且未核到复原' }
        : {};
      return fail(MEASURE_STATUS.RECORD_FAILED, { error: msg, ...extra });
    }
  }

  /**
   * 扫链，把"该测但还没测"的条目各测一遍。
   *
   * `limit` 是成本闸门：一次双态跑 = 2× 子集耗时，一期最多几个候选 ⇒ 默认 5 条排得进周窗口。
   * @returns {Promise<object>} { ok, scanned, measurable, attempted, deferred, counts, results }
   */
  async function measurePending({ repoRoot, limit = DEFAULT_OUTCOME_LIMIT } = {}) {
    if (!repoRoot) return { ok: false, status: MEASURE_STATUS.NO_REPOROOT, scanned: 0, attempted: 0, counts: {}, results: [] };
    const evo = dep('agint.evolution');
    if (typeof evo?.ledger?.list !== 'function' || typeof evo?.listPredictionOutcomes !== 'function') {
      return { ok: false, status: MEASURE_STATUS.SERVICE_UNAVAILABLE, scanned: 0, attempted: 0, counts: {}, results: [] };
    }
    const entries = await evo.ledger.list();
    const done = new Set((await evo.listPredictionOutcomes()).map((r) => r?.contractId));
    const pending = entries.filter((e) => isMeasurableEntry(e).ok && !done.has(e?.contractId));
    const picked = pending.slice(0, Math.max(0, limit));
    const results = [];
    for (const e of picked) {
      results.push(await measureOne({ contractId: e.contractId, repoRoot, entries }));
    }
    const counts = {};
    for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
    return {
      ok: true,
      scanned: entries.length,
      measurable: pending.length,
      attempted: picked.length,
      deferred: Math.max(0, pending.length - picked.length),
      counts,
      results,
    };
  }

  return { measureOne, measurePending };
}

export default { createOutcomeMeasurer, MEASURE_STATUS, MEASURABLE_DECISIONS, MEASURABLE_METRICS, parseTapSummary, computeActualDelta, sha256Buf, isMeasurableEntry };
