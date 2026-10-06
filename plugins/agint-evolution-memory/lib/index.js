/**
 * agint-evolution-memory: host service plugin (provides `agint.evolution`).
 *
 * 物理隔离的进化记忆存储域，独立于任务记忆 `agint`。
 *   - 存储域：agint_evolution（独立 @deepseek-ai/dsh-storage-domain）
 *   - 三个表：
 *       evolutionLog      每次 D-QAF Phase 4 完成后追加
 *       failurePattern    REJECT 决策自动写入 + 周复盘归纳
 *       successTemplate   周复盘蒸馏（手工 / 自动化蒸馏均支持）
 *
 * 设计原则：
 *   - 物理隔离：跟任务记忆不同 storage domain，避免跨域污染
 *   - 自动化写入：logPhase4 / addFailure 由 D-QAF 流水线触发
 *   - 定向读取：仅在进化评估阶段被 D-QAF / dream deep 读取
 *   - 上限保护：failure 100 / template 50，超限返回 warn（不自动 prune）
 *   - 检索：线性扫 + lowercase substring（老板 2026-08-20 拍板）
 *   - 衰减：L1-L4 + confidence，跟 agint-memory 一致（纯复制 decay.js）
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-evolution-memory
 *         name: ./plugins/agint-evolution-memory/lib/index.js
 *         config: {}
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { join } from 'node:path';
import { z } from 'zod';
import {
  evolutionLogEntrySchema,
  failurePatternSchema,
  FAILURE_CATEGORIES,
  FAILURE_SEVERITIES,
  FAILURE_CATEGORY_MAP,
  FAILURE_SEVERITY_MAP,
  successTemplateSchema,
  contractLockEntrySchema,
  predictionOutcomeEntrySchema,
  ledgerEntrySchema,
  benchmarkFrozenSetSchema,
  LIMITS,
  matchesQuery,
} from './schema.js';
import { decayScan } from './decay.js';
import { createLogBuffer, DEFAULT_FLUSH_COUNT, DEFAULT_FLUSH_MS } from './log-buffer.js';
import { createLedgerService } from './ledger.js';
import { createLedgerAnchorService } from './ledger-anchor.js';
import { createLedgerRebuildService } from './ledger-rebuild.js';
import { createDefaultSourceLoader } from './ledger-rebuild-sources.js';
import { createFrozenSetService } from './frozen-set.js';

const name = 'agint-evolution-memory';
// fix-20260907（host 热修回灌）：eventBus.subscribe 原为软依赖（ctx.get 一次性
//   读取），但 loader 各行并行初始化，行顺序不保证 provide 先于消费，导致启动时
//   经常取不到而影子订阅永久降级。改为硬 inject 让 DI 等待服务就绪。
const inject = ['storageDomain', 'agint.eventBus.subscribe'];

// repoRoot 必须在此声明：宿主用本 schema 校验 patch 里的 config 块，
// 未声明的键会在到达 apply() 之前被 zod 剥掉（2026-10-04 ledger-anchor 三连败钉出；
// 对照组 driver 没有 Config ⇒ 值原样进 apply ⇒ 同机制一次通过）。
const Config = z.object({
  repoRoot: z.string().optional(),
}).optional();

// 三表 schema（用 zod）
const spec = defineDomain({
  name: 'agint_evolution',
  // ⚠️ version 保持 1，**加表不升版本**（2026-10-02 实测取证，勿改）。
  //
  // 依据（dsh-storage-json/lib/index.js 生产在用的整单元格式）：
  //   第 102 行 `if (version !== descriptor.version) throw version-mismatch`
  //   —— 整单元格式做的是**严格相等**校验，`compatibleVersions` 只对
  //      per-record 格式生效（acceptedStamps()，第 354 行），整单元完全不看它。
  //   第 110-113 行：`for (const table of descriptor.tables)`，文件里没有的表
  //      **补空 Map**，文件里多出来的表**直接忽略**。
  //
  // ⇒ 升 version 的后果：现有文件 unit.version=1 vs 新 descriptor=2
  //   ⇒ 直接 version-mismatch，**整个域打不开**，202 行 evolution_log /
  //   8 行 failure_pattern / 5 行 success_template 全部读不出来，
  //   且 recovery 是手动改生产存储文件（回滚代码不改文件就永久打不开）。
  // ⇒ 不升 version 加表的后果：现有 3 张表照常解析，新表补空 Map 从 0 行开始。
  //   已用生产文件副本实证：202 行全部保留，contract_locks 0 行。
  //
  // 代价（如实记录）：同一 version 下 schema 发生了扩张。dsh 未来若把
  // version 升级为「schema 破坏性变更的计数器」，这里需要补一次显式迁移。
  // 本仓可控（自有存储、无外部消费者），暂不为此冒生产不可用之险。
  version: 1,
  tables: {
    evolution_log: { valueSchema: evolutionLogEntrySchema },
    failure_pattern: { valueSchema: failurePatternSchema },
    success_template: { valueSchema: successTemplateSchema },
    // Phase 1 交付物 1 §2.5.1：预测锁定记录（hypothesisLock）
    contract_locks: { valueSchema: contractLockEntrySchema },
    // Phase 1.1 支点 1b / R1′：预测的**实际度量**（设计里 Sprint 24 的那张表）。
    // ⛔ 不参与链哈希、不回填链（§4.3.4 裁定）—— 用 contractId 与 Ledger 条目交叉引用。
    // 加表不升 version 的先例与本域生产文件行为，见本文件 51-73 行的取证注释。
    prediction_outcomes: { valueSchema: predictionOutcomeEntrySchema },
    // Phase 1 交付物 3 §4.3：进化账本（哈希链）。主键 = String(seq)，
    // 一个 contractId 一条（§4.3.4 纪律 6）；追加只经 lib/ledger.js。
    evolution_ledger: { valueSchema: ledgerEntrySchema },
    // Phase 0.1 / Sprint 19：Frozen 基准集快照（防篡改留证）。
    // 加表不升 version —— 依据见本文件 51-73 行的取证注释（整单元格式做严格相等
    // 校验，升版本会让生产 202 行 evolution_log 直接读不出来）。
    benchmark_frozen_set: { valueSchema: benchmarkFrozenSetSchema },
  },
});

function randomId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `e-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso() { return new Date().toISOString(); }

function apply(ctx, config) {
  let domain = null;
  let domainError = null;
  let disposed = false;

  ctx.effect(() => () => {
    disposed = true;
    if (domain) return domain.close();
  });

  const ready = ctx.storageDomain.open(spec).then(
    (d) => {
      if (disposed) { void d.close().catch(() => {}); return null; }
      domain = d;
      return d;
    },
    (error) => { domainError = error; return null; },
  );

  // Sprint 10 v0.6.4 #7：EvolutionLogBuffer 实例（domain ready 后创建）
  // memFallback = ctx.get('agint.memory')；domain ready 后才可访问 table
  //
  // fix-20260921（T1 真实触发实验实证）：原实现的 `logBuffer` 由 ready.then()
  //   异步赋值，而 logPhase4Buffered 直接 `logBuffer.enqueue(entry)` ——
  //   不查 null、也不 await ready。domain 就绪前的任何调用必抛
  //   `TypeError: Cannot read properties of null (reading 'enqueue')`，
  //   又被 shadow handler 的 catch{warn} 吞掉 ⇒ **事件永久丢失**。
  //   生产实证：evolution_log 168 条里 shadow-ingest 标记 = 0，
  //   即该影子链路自上线至今从未成功写入过一次。
  // 修法：改为显式 await 的 ensureLogBuffer()，拿不到实例时**降级到同步
  //   logPhase4 路径**（不丢事件），且每次降级都计数，让失败可观测。
  let logBufferPromise = null;
  function ensureLogBuffer() {
    if (!logBufferPromise) {
      logBufferPromise = ready.then((d) => {
        if (!d || disposed) return null;
        const memFallback = ctx.get('agint.memory') ?? { write: async () => ({ ok: false, reason: 'no-memFallback' }) };
        return createLogBuffer({
          storage: d,
          memFallback,
          flushCount: DEFAULT_FLUSH_COUNT,
          flushMs: DEFAULT_FLUSH_MS,
        });
      }).catch(() => null); // domain unavailable → null，caller 走同步降级
    }
    return logBufferPromise;
  }

  /** 计数指标（best-effort，失败不影响主路径） */
  const bump = (key, n = 1) => {
    try { if (typeof ctx.metrics === 'function') ctx.metrics(key, n); } catch { /* ignore */ }
  };

  // 失败必须暴露：订阅不可用 / payload 缺字段 / 写入抛错，三种情况都 warn。
  const warn = (msg, extra) => {
    try { if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(msg, extra ?? {}); } catch { /* noop */ }
  };

  const table = async (name) => {
    if (disposed) throw new Error('agint-evolution-memory: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-evolution-memory: domain unavailable');
    return d.table(name);
  };

  const t_log = () => table('evolution_log');
  const t_fail = () => table('failure_pattern');
  const t_template = () => table('success_template');
  const t_lock = () => table('contract_locks');
  const t_ledger = () => table('evolution_ledger');
  const t_outcome = () => table('prediction_outcomes');
  const t_frozen = () => table('benchmark_frozen_set');

  // ── Ledger（Phase 1 交付物 3 §4.3.4）─────────────────────────────────────
  // 链的**唯一写入口**。⛔ 不接 logBuffer：批量 flush 崩溃即 seq 空洞，
  // 而空洞在 ledger 里是安全事件（§4.3.4 纪律 2/3，lib/ledger.js 头部详述）。
  const ledger = createLedgerService({ getTable: t_ledger, now: nowIso, warn, bump });

  // ── 外部锚定（§4.4.2）────────────────────────────────────────────────────
  // 必须在宿主内跑：独立进程写 agint_evolution.json 会被宿主下一次 put 覆盖
  // （lib/ledger.js 头部取证）。所以这里是**服务方法**，由 cron 的 ledger-anchor
  // 任务调用；bin/anchor-ledger.mjs 退化为只读预览。
  // publish 用软依赖、调用时取：本方法只在 cron 触发时执行，远晚于插件装配，
  // 不会撞上 fix-20260907 那类「启动时一次性读取取不到」的时序问题。
  const ledgerAnchor = createLedgerAnchorService({
    ledger,
    now: nowIso,
    warn,
    bump,
    // 锚点写盘位置 = <repoRoot>/docs/evolution-ledger-anchor.md。默认值从模块自身
    // 位置退三级，只在全仓 checkout 里成立；部署位（.agint-bundle）退出来指向
    // bundle 根（无 docs/ ⇒ ENOENT，2026-10-04 实跑钉出）。repoRoot 走本机 config
    // override（HOME cordis.patch.yml，与 agint-cron/agint-evolution-driver 同机制、
    // 同值），⛔ 不入库写死 —— 两台机器各配各的（Phase -1.4 原则）。缺 config 时
    // 落回模块默认（开发仓直跑路径），行为不变。
    ...(config?.repoRoot
      ? { repoRoot: config.repoRoot, anchorFile: join(config.repoRoot, 'docs', 'evolution-ledger-anchor.md') }
      : {}),
    publish: async (topic, payload) => {
      const bus = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.publish') : null;
      if (typeof bus !== 'function') return false;
      // ⛔ 单参数 { topic, payload, source }：签名见 evolution-driver/lib/index.js:317
      // 的取证，多传参数会被 bus 静默丢成 accepted:false。
      const res = await bus({ topic, payload, source: name });
      return res?.accepted === true;
    },
  });

  // ── 历史重建（§4.3.5 / §4.6 #7）──────────────────────────────────────────
  // 取数与推导都不碰 fs 之外的写：apply 逐条走 ledger.appendEntry（唯一写入口）。
  // 时序硬约束由这里判定：链上已有实时条目 ⇒ 拒绝插入（lib/ledger-rebuild.js 头注）。
  const ledgerRebuild = createLedgerRebuildService({
    ledger,
    loadSources: createDefaultSourceLoader(),
    warn,
    bump,
  });

  // ── 写入 helpers ────────────────────────────────────────────────────────

  /** Append one evolution-log entry. Returns the persisted record. */
  async function logPhase4({ targetId, targetKind, decision, scores = {}, findings = [], tags = [] }) {
    if (!targetId) throw new Error('logPhase4: targetId is required');
    const entry = evolutionLogEntrySchema.parse({
      id: randomId(),
      kind: 'evolution-log',
      targetId,
      targetKind,
      decision,
      scores,
      findings,
      tags,
    });
    await (await t_log()).put(entry.id, entry);
    return { ...entry };
  }

  /**
   * logPhase4Buffered — Sprint 10 v0.6.4 #7 异步批量写入路径
   *
   * 与 logPhase4 同契约，但走 EvolutionLogBuffer 异步批量落盘。
   * 设计稿 §二.5：高频评估期（≥50 次 logPhase4 调用）从 50 次 → 5 次 I/O。
   *
   * 何时用：caller 自己决定（默认 caller 是 evaluateAll/decode/generate 流水线的
   * hot path；常规 caller 仍走 logPhase4 同步路径，保留向后兼容）。
   *
   * 不返回存储的 entry（异步）；返回 { queued: true, id } 即可。
   * 读时走 readLogRangeMerged（buffer + storage 合并视图），不破坏 storage。
   */
  async function logPhase4Buffered({ targetId, targetKind, decision, scores = {}, findings = [], tags = [] }) {
    if (!targetId) throw new Error('logPhase4Buffered: targetId is required');
    const entry = evolutionLogEntrySchema.parse({
      id: randomId(),
      kind: 'evolution-log',
      targetId,
      targetKind,
      decision,
      scores,
      findings,
      tags,
    });
    // fix-20260921：显式等待 buffer 就绪（含 domain 初始化），避免早调即丢。
    const buffer = await ensureLogBuffer();
    if (!buffer) {
      // 降级：存储域不可用 → 走同步路径，**不丢事件**，并计数暴露。
      bump('evolutionMemory.logPhase4Buffered.degraded');
      return logPhase4({ targetId, targetKind, decision, scores, findings, tags });
    }
    try {
      buffer.enqueue(entry);
      return { queued: true, id: entry.id };
    } catch (err) {
      // enqueue 抛错（如 disposed）同样降级同步，不静默丢。
      bump('evolutionMemory.logPhase4Buffered.enqueueFailed');
      warn('evolution-memory: logPhase4Buffered enqueue failed, fallback to sync', {
        id: entry.id,
        error: err instanceof Error ? err.message : String(err ?? 'unknown'),
      });
      return logPhase4({ targetId, targetKind, decision, scores, findings, tags });
    }
  }

  /**
   * readLogRangeMerged — Sprint 10 v0.6.4 #8 读时合并视图
   *
   * 返回 buffer + storage 合并的 evolution_log 视图（buffer 在前）。
   * 不污染 storage（buffer 仅在内存 + flush 后才落盘）。
   */
  async function readLogRangeMerged(opts = {}) {
    const buffer = await ensureLogBuffer();
    if (!buffer) {
      bump('evolutionMemory.readLogRangeMerged.degraded');
      return getLogRange(opts.query ?? {});
    }
    return buffer.readMerged(opts.query);
  }

  /**
   * flushLogBufferNow — Sprint 10 v0.6.4 #7 立即强制 flush
   */
  async function flushLogBufferNow() {
    const buffer = await ensureLogBuffer();
    if (!buffer) {
      bump('evolutionMemory.flushLogBufferNow.noBuffer');
      return { flushed: 0, lost: 0 };
    }
    return buffer.flush('manual');
  }

  // 退出钩子：ctx.effect() disposer 在 plugin dispose 时强制 flush（设计稿 §二.5 退出触发）。
  // 不注册 process.on(beforeExit/SIGTERM) — 那些会让 Node 测试 process 永久卡住等待 listener 释放。
  // 生产 dsh 的 SIGTERM 处理在 dsh 主进程统一接管；plugin 自身的优雅停机由 ctx.effect() disposer 链驱动。
  // fix-20260921：改为 await ensureLogBuffer()（原 `if (logBuffer)` 在实例未就绪时
  //   会**静默跳过 shutdown**，缓冲区里的残留条目随进程消失）。
  ctx.effect(() => () => {
    void ensureLogBuffer().then((buffer) => {
      if (buffer) void buffer.shutdown();
    }).catch(() => { /* noop */ });
  });

  /**
   * Add a failure pattern. If a pattern with the same text already exists,
   * increment its occurrences instead of creating a duplicate. Returns the
   * stored record.
   */
  async function addFailure({ pattern, category = 'other', severity = 'medium', evidence = '' }) {
    if (!pattern) throw new Error('addFailure: pattern is required');
    const t = await t_fail();
    // 查找重复
    for (const [id, rec] of t.entries()) {
      if (rec.pattern === pattern) {
        const updated = { ...rec, occurrences: (rec.occurrences ?? 1) + 1, updatedAt: nowIso(), lastRecall: nowIso() };
        await t.put(id, updated);
        return { ...updated, _deduped: true };
      }
    }
    // ── 值域归一化（方案 B，2026-10-06 立项）───────────────────────────
    // 旧行为：越界 category/severity 走 .parse 抛错，调用方多数 catch{} 静默吞
    // ⇒ 真实失败无声丢失（7/14 写入点结构性死路）。新行为：已知值按映射表归位、
    // 未知值落 'other'，原始值写进 coercedFrom 留痕并 console.warn 可见，
    // 不再抛错、不再丢行。映射表语义经老板逐条认可（立项档 §4/§6）。
    const coerced = [];
    let cat = category;
    if (!FAILURE_CATEGORIES.includes(cat)) {
      const mapped = FAILURE_CATEGORY_MAP[cat];
      cat = mapped ?? 'other';
      coerced.push(`category:${category}→${cat}${mapped ? '' : '(未知值)'}`);
    }
    let sev = severity;
    if (!FAILURE_SEVERITIES.includes(sev)) {
      const mapped = FAILURE_SEVERITY_MAP[sev];
      sev = mapped ?? 'medium';
      coerced.push(`severity:${severity}→${sev}${mapped ? '' : '(未知值)'}`);
    }
    if (coerced.length) {
      console.warn(`[agint-evolution-memory] addFailure 值域归一化: ${coerced.join('; ')} (pattern=${String(pattern).slice(0, 80)})`);
    }
    const entry = failurePatternSchema.parse({
      id: randomId(),
      kind: 'failure-pattern',
      pattern,
      category: cat,
      severity: sev,
      evidence,
      ...(coerced.length ? { coercedFrom: coerced.join('; ') } : {}),
    });
    await t.put(entry.id, entry);

    // 上限检查：超过 LIMITS.FAILURE_PATTERNS → 返回 warn
    const count = t.size;
    if (count > LIMITS.FAILURE_PATTERNS) {
      return { ...entry, _warn: `failure-patterns count ${count} > limit ${LIMITS.FAILURE_PATTERNS}` };
    }
    return { ...entry };
  }

  /**
   * Add a success template. No dedup — distinct templates are kept distinct.
   * Returns the stored record.
   */
  async function addSuccess({ template, sampleSize = 1, appliesTo = [], evidence = '' }) {
    if (!template) throw new Error('addSuccess: template is required');
    const t = await t_template();
    const entry = successTemplateSchema.parse({
      id: randomId(),
      kind: 'success-template',
      template,
      sampleSize,
      appliesTo,
      evidence,
    });
    await t.put(entry.id, entry);

    const count = t.size;
    if (count > LIMITS.SUCCESS_TEMPLATES) {
      return { ...entry, _warn: `success-templates count ${count} > limit ${LIMITS.SUCCESS_TEMPLATES}` };
    }
    return { ...entry };
  }

  // ── Contract 预测锁（Phase 1 交付物 1 §2.4.2）─────────────────────────

  /**
   * recordContractLock — 落一条预测锁定记录。
   *
   * 由 caller（driver）在 **mutation 执行之前**调用。本方法只负责
   * 「算好的 lock 存进表」，**不自己算 hash** —— 算 hash 的纯函数在
   * `agint-evolution-driver/lib/predictor.js`（computeHypothesisLock）。
   * 刻意分离：本插件不 import driver（跨插件 lib import 会造成耦合与加载顺序问题），
   * 由 driver 把结果传进来，职责边界清楚。
   *
   * ## 为什么要「不可覆盖」
   *
   * `put(key, ...)` 同 key 会**直接覆盖**。若允许同一 contractId 二次写入，
   * 攻击者（或 bug）只要重算一遍新 hash 覆盖旧值，篡改就查不出来了 ——
   * 锁也就失去了意义。所以：已存在同 contractId 的锁 ⇒ **拒绝并报 already_locked**，
   * 绝不覆盖（真实 > 讨好：宁可写入失败，也不能让「锁」名存实亡）。
   *
   * @param {object} params
   * @param {string} params.contractId
   * @param {string} params.hypothesisLock  `sha256:<64 hex>`
   * @param {string} params.lockedAt        ISO 时间串（caller 传入，本方法不取时钟）
   * @param {string|null} [params.predictionSource] KNOWLEDGE_BASE / ANALOGY / DEFAULT_RULE
   * @param {string|null} [params.lockEventId] 对应的 evolution.contract.locked 事件 id
   * @returns {Promise<object>} 落盘后的 entry
   * @throws 同 contractId 已锁 ⇒ Error('contract-lock-already-exists')
   */
  async function recordContractLock({
    contractId, hypothesisLock, lockedAt, predictionSource = null, lockEventId = null,
  }) {
    if (!contractId) throw new Error('recordContractLock: contractId is required');
    if (!hypothesisLock) throw new Error('recordContractLock: hypothesisLock is required');
    if (!lockedAt) throw new Error('recordContractLock: lockedAt is required');
    const t = await t_lock();
    if (t.get(contractId)) {
      // ⛔ 不可覆盖：见上方「为什么要不可覆盖」。重算 hash 覆盖旧值 = 篡改不留痕。
      throw new Error('contract-lock-already-exists');
    }
    const entry = contractLockEntrySchema.parse({
      hypothesisLock,
      lockAlgorithm: 'sha256',
      contractId,
      lockedAt,
      predictionSource: predictionSource ?? null,
      lockEventId: lockEventId ?? null,
    });
    await t.put(entry.contractId, entry);
    const count = t.size;
    if (count > LIMITS.CONTRACT_LOCKS) {
      return { ...entry, _warn: `contract_locks count ${count} > limit ${LIMITS.CONTRACT_LOCKS}` };
    }
    return { ...entry };
  }

  /**
   * getContractLock — 取某 Contract 的锁定记录。
   * 归档校验时与「重算的 hash」比对，不一致即 CONTRACT_TAMPERED。
   * @param {string} contractId
   * @returns {Promise<object|null>} 找不到返回 null（**缺失≠通过**，由 caller 判红）
   */
  async function getContractLock(contractId) {
    if (!contractId) return null;
    const t = await t_lock();
    const rec = t.get(contractId);
    return rec ? { ...rec } : null;
  }

  /**
   * listContractLocks — 列出全部锁定记录（供 Growth Report / 审计对账）。
   * @returns {Promise<Array<object>>}
   */
  async function listContractLocks() {
    const t = await t_lock();
    const out = [];
    for (const [, rec] of t.entries()) out.push({ ...rec });
    return out;
  }

  // ── Phase 1.1 支点 1b / R1′：预测的实际度量（设计里 Sprint 24 的那张表）────
  //
  // 本方法**只存不算**。跑测试、算 actualDelta、判死区全在 driver 的
  // `lib/outcome-measurer.js`；这里只做落盘 + 两道守门（不可覆盖、schema 校验）。
  // 分离的理由与 recordContractLock 同一条：本插件不 import driver 的 lib。

  /**
   * recordPredictionOutcome — 落一条「预测 vs 实测」记录。
   *
   * ## 为什么不可覆盖
   * 与 contract_locks 同一条纪律：度量记录是历史事实。可覆盖就意味着事后能挑一次
   * 好看的数字重写它 —— 这正是设计 §4.2.5 要拦的「反事后偏」。已存在同 contractId
   * ⇒ **拒绝并报 already-exists，绝不覆盖**。
   *
   * ## ⛔ 不回填链（§4.3.4 裁定「度量不回填链」）
   * 本表不参与 Ledger 链哈希。预测与实测的对应关系用 `contractId` 交叉引用：
   * 回填会让已锚定的 seq 全部重算，等于把锚点作废。
   *
   * @param {object} entry 形状见 `schema.js:predictionOutcomeEntrySchema`
   * @returns {Promise<object>} 落盘后的 entry（超限带 `_warn`）
   * @throws 缺 contractId ⇒ Error；同 contractId 已写 ⇒ Error('prediction-outcome-already-exists')
   */
  async function recordPredictionOutcome(entry) {
    if (!entry?.contractId) throw new Error('recordPredictionOutcome: contractId is required');
    const t = await t_outcome();
    if (t.get(entry.contractId)) {
      // ⛔ 不可覆盖：见上方「为什么要不可覆盖」。
      throw new Error('prediction-outcome-already-exists');
    }
    const parsed = predictionOutcomeEntrySchema.parse(entry);
    await t.put(parsed.contractId, parsed);
    const count = t.size;
    if (count > LIMITS.PREDICTION_OUTCOMES) {
      return { ...parsed, _warn: `prediction_outcomes count ${count} > limit ${LIMITS.PREDICTION_OUTCOMES}` };
    }
    return { ...parsed };
  }

  /**
   * getPredictionOutcome — 取某 Contract 的实测记录（幂等判据 + 对账用）。
   * @param {string} contractId
   * @returns {Promise<object|null>} 找不到返回 null（**缺失≠已测**，由 caller 判）
   */
  async function getPredictionOutcome(contractId) {
    if (!contractId) return null;
    const t = await t_outcome();
    const rec = t.get(contractId);
    return rec ? { ...rec } : null;
  }

  /**
   * listPredictionOutcomes — 列出全部实测记录。
   * Phase 1 收口门槛「非死区记录 ≥20 条」从这里数（⛔ 不是从 contract_locks 数 ——
   * 锁了没测出来的那些条，一条都不算证据）。
   * @returns {Promise<Array<object>>}
   */
  async function listPredictionOutcomes() {
    const t = await t_outcome();
    const out = [];
    for (const [, rec] of t.entries()) out.push({ ...rec });
    return out;
  }

  // ── Frozen 基准集快照（Phase 0.1 / Sprint 19）────────────────────────────
  //
  // 为什么落在这里而不是别处：三层隔离的验收原文要求「Frozen 集的 hash 落
  // evolution-memory 防篡改」。它是**进化记忆**，不是任务记忆，也不属于
  // 任何单个 Contract ⇒ 归本域。表结构见 schema.js 的 benchmarkFrozenSetSchema，
  // 服务逻辑见 lib/frozen-set.js。
  //
  // ⛔ 聚合 hash 由 caller 算好传进来（bin/lib/scenario-tier.mjs 的
  //    frozenAggregateHash）：本插件不 import eval 侧脚本 —— 部署位没有 eval/，
  //    跨层 import 会让插件在部署位加载失败。
  const frozenSet = createFrozenSetService({ getTable: t_frozen, now: nowIso, warn, bump });
  const recordFrozenSet = (p) => frozenSet.record(p);
  const getFrozenSet = (setId) => frozenSet.get(setId);
  const listFrozenSets = () => frozenSet.list();
  const verifyFrozenSet = (p) => frozenSet.verify(p);

  // ── 读取 helpers ────────────────────────────────────────────────────────

  /** Query failure patterns. opts: { query?, category?, severity?, limit? } */
  async function queryFailures(opts = {}) {
    const t = await t_fail();
    const out = [];
    for (const [id, rec] of t.entries()) {
      if (opts.category && rec.category !== opts.category) continue;
      if (opts.severity && rec.severity !== opts.severity) continue;
      if (opts.query && !matchesQuery(`${rec.pattern} ${rec.evidence ?? ''}`, opts.query)) continue;
      out.push({ id, ...rec });
    }
    out.sort((a, b) => (b.occurrences ?? 1) - (a.occurrences ?? 1) || b.updatedAt.localeCompare(a.updatedAt));
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 20;
    return out.slice(0, limit);
  }

  async function queryTemplates(opts = {}) {
    const t = await t_template();
    const out = [];
    for (const [id, rec] of t.entries()) {
      if (opts.query && !matchesQuery(`${rec.template} ${rec.evidence ?? ''}`, opts.query)) continue;
      if (opts.appliesTo && opts.appliesTo.length > 0) {
        const overlap = (rec.appliesTo ?? []).some((a) => opts.appliesTo.includes(a));
        if (!overlap) continue;
      }
      out.push({ id, ...rec });
    }
    out.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 20;
    return out.slice(0, limit);
  }

  /**
   * Get evolution-log entries in [fromDate, toDate] (inclusive). ISO date
   * strings (YYYY-MM-DD or full ISO). Limit defaults to 200.
   */
  async function getLogRange({ fromDate, toDate, limit = 200 } = {}) {
    const t = await t_log();
    const from = fromDate ? new Date(fromDate).getTime() : 0;
    const to = toDate ? new Date(toDate).getTime() + 86_400_000 : Date.now() + 1;
    const out = [];
    for (const [id, rec] of t.entries()) {
      const ts = Date.parse(rec.ts ?? rec.createdAt);
      if (Number.isFinite(ts) && (ts < from || ts > to)) continue;
      out.push({ id, ...rec });
    }
    out.sort((a, b) => (b.ts ?? b.createdAt).localeCompare(a.ts ?? a.createdAt));
    return out.slice(0, limit);
  }

  /**
   * Run a decay scan over all three tables. Returns a unified report.
   * Caller is responsible for applying the actions (we do NOT auto-apply,
   * matching the agint-memory pattern where apply is opt-in).
   */
  async function decayScanRun(opts = {}) {
    const out = { evolutionLog: null, failurePattern: null, successTemplate: null, applied: [], generatedAt: nowIso() };
    const now = opts.now ?? Date.now();
    for (const [kind, tGetter, tableName] of [
      ['evolutionLog', t_log, 'evolution_log'],
      ['failurePattern', t_fail, 'failure_pattern'],
      ['successTemplate', t_template, 'success_template'],
    ]) {
      const t = await tGetter();
      const entries = [...t.entries()];
      const scan = decayScan(entries, now);
      out[kind] = { ...scan };
      if (opts.apply) {
        for (const a of scan.actions) {
          const rec = t.get(a.id);
          if (!rec) continue;
          if (a.action === 'downgrade') {
            await t.put(a.id, { ...rec, level: a.to, updatedAt: nowIso() });
          } else if (a.action === 'clear') {
            await t.delete(a.id);
          }
          out.applied.push({ table: tableName, ...a });
        }
      }
    }
    return out;
  }

  async function stats() {
    const t1 = await t_log();
    const t2 = await t_fail();
    const t3 = await t_template();
    const t4 = await t_ledger();
    return {
      evolution_log: t1.size,
      failure_pattern: t2.size,
      success_template: t3.size,
      evolution_ledger: t4.size,
      limits: LIMITS,
    };
  }

  ctx.provide('agint.evolution', {
    logPhase4,
    logPhase4Buffered,    // Sprint 10 v0.6.4 #7 异步批量写入
    readLogRangeMerged,   // Sprint 10 v0.6.4 #8 读时合并视图
    flushLogBufferNow,    // Sprint 10 v0.6.4 #7 强制 flush
    addFailure,
    addSuccess,
    queryFailures,
    queryTemplates,
    // Phase 1 交付物 1 §2.5.1：预测锁定
    recordContractLock,
    getContractLock,
    listContractLocks,
    // Phase 1.1 支点 1b / R1′：实测落盘（同 contractId 不可覆盖 ⇒ measurer 重跑幂等）
    recordPredictionOutcome,
    getPredictionOutcome,
    listPredictionOutcomes,
    // Phase 0.1 / Sprint 19：Frozen 基准集快照（三层隔离的防篡改留证）
    recordFrozenSet,
    getFrozenSet,
    listFrozenSets,
    verifyFrozenSet,
    getLogRange,
    decayScanRun,
    stats,
    // Phase 1 交付物 3 §4.3.4：Ledger 是**唯一写入口**；driver / 锚定 cron /
    // 重建脚本一律经此命名空间，⛔ 不得直写 agint_evolution.json。
    ledger: {
      append: ledger.appendEntry,
      head: ledger.getHead,
      list: ledger.listEntries,
      findByContractId: ledger.findByContractId,
      proofFor: ledger.proofFor,
      markAnchored: ledger.markAnchored,
      stats: ledger.stats,
      // §4.4.2：外部锚定（cron `ledger-anchor` 调用；⛔ 只 commit，不 push）
      anchor: ledgerAnchor.anchor,
      anchorPreview: ledgerAnchor.preview,
      anchorFile: ledgerAnchor.anchorFile,
      // §4.3.5：历史重建（只读核对用 plan；apply 必须显式 true 且时序窗口未关）
      rebuildPlan: ledgerRebuild.plan,
      rebuild: ledgerRebuild.apply,
    },
    // 暴露 LIMIT 给上游读取
    limits: LIMITS,
  });

  // ── Sprint 12 A1：订阅 evolution.proposed → 写 evolution_log ──────────────
  // 设计稿 §A1：population → (bus) → evolution-memory 的异步通路。
  //
  // 【2026-09-25 T2 切换：本边已无「影子」语义，事件路径即唯一权威路径】
  // 生产取证（evolution_log 170 行）：`stage:proposed` 行**仅 2 条，且 100% 带
  //   'event-bus' 标签** —— **不存在任何直连写入的提案阶段记录**。
  //   ⇒ 上层 `evo.logPhase4()` 写的是 Phase 4 **决策**记录（decision 枚举四值），
  //      与本 handler 写的**提案阶段**记录是**两类不同记录，不是同一条的双写**。
  //   ⇒ 因此本边**没有直连可切**：流量自 A1 接线起就 100% 走事件。
  //   ⇒ **对账口径随之修正**（见 bin/t2-reconcile.mjs）：`shadowCoverage` 在此边上
  //      的真实语义是「事件 → 落库率」，**不是**「影子 vs 直连一致率」。
  //
  // ⛔ tag 兼容性（改动前必看，双向 grep 已确认消费方）：
  //   - 'event-bus'        → bin/t2-reconcile.mjs:141 `isShadow` 判定依赖，**不可移除**
  //   - 'shadow-ingest'    → eval/scenarios/driver.js:280 断言依赖，**不可移除**
  //      （名字已与语义不符——本边不再是影子；保留仅为不破坏主 driver 门禁）
  //   - 'stage:proposed'   → 本插件单测断言依赖
  //   新增 't2:authoritative' 标记权威身份（消费方只做 includes 判定，加 tag 安全）。
  // fix-20260907（提案 f9d8550b 真因）：原实现往 logPhase4Buffered 传了
  //   decision='PROPOSED' 和 targetKind='evolution.proposed:*'，两者都**不在**
  //   evolutionLogEntrySchema 的枚举里（decision 只允许 Phase 4 四决策；
  //   targetKind 只允许 plugin/skill/preset/composite）⇒ zod parse 必抛
  //   ⇒ 被空 catch 吞掉。
  // 结果：订阅注册成功、bus 返回 deliveredTo 包含本插件，看起来链路完全正常，
  //   但 evolution_log 永远 0 条 —— 教科书式 silent failure。
  // 修法：字段取枚举内合法值，"这是提案阶段"的语义改用 tags 保留（可查询）。
  try {
    // 兼容两种形态：1) 子键直查 ctx.get('agint.eventBus.subscribe')（sibling 范本）
    //              2) namespace 解析 ctx.get('agint.eventBus')?.subscribe（少数 host 变体）
    let subscribe = null;
    if (typeof ctx.get === 'function') {
      subscribe = ctx.get('agint.eventBus.subscribe');
      if (typeof subscribe !== 'function') {
        const ns = ctx.get('agint.eventBus');
        if (ns && typeof ns.subscribe === 'function') subscribe = ns.subscribe;
      }
    }
    if (typeof subscribe !== 'function') {
      warn('evolution-memory: shadow subscribe unavailable', {
        subscriber: 'agint-evolution-memory',
        topic: 'evolution.proposed',
        reason: 'agint.eventBus.subscribe not found in ctx',
      });
      // fix-20260907（host 热修回灌）：额外 emit 一条 metrics，让 silent-failure 不再 silent
      if (typeof ctx.metrics === 'function') {
        try { ctx.metrics('evolutionMemory.shadowSubscribe.missing', 1); } catch { /* ignore */ }
      }
    } else {
      const unsubscribe = subscribe(
        { subscriber: 'agint-evolution-memory', topics: ['evolution.proposed'], mode: 'async' },
        async (envelope) => {
          const p = envelope?.payload ?? {};
          if (!p.proposalId) {
            warn('evolution-memory: shadow ingest skipped (missing proposalId)', { topic: envelope?.topic });
            bump('evolutionMemory.shadowIngest.skippedNoId');
            return;
          }
          try {
            // 走 buffered 路径：高频期不阻塞 handler
            await logPhase4Buffered({
              targetId: p.proposalId,
              targetKind: 'plugin',
              decision: 'PENDING_REVIEW',
              scores: {},
              findings: [],
              tags: [
                'event-bus',
                'shadow-ingest',
                't2:authoritative',
                'stage:proposed',
                `origin:${p.origin || 'unknown'}`,
                `kind:${p.kind || 'unknown'}`,
              ],
            });
            // fix-20260921：成功也计数 —— 与下面的 failed 配对，使
            //   「收到事件数 = delivered 计数 = ok + failed」恒等式可校验。
            //   旧实现只有失败计数且失败只 warn，导致「投递了但没写入」不可观测。
            bump('evolutionMemory.shadowIngest.ok');
          } catch (err) {
            bump('evolutionMemory.shadowIngest.failed');
            warn('evolution-memory: shadow ingest failed', {
              proposalId: p.proposalId,
              error: err instanceof Error ? err.message : String(err ?? 'unknown'),
            });
          }
        },
      );
      ctx.effect(() => () => { try { if (typeof unsubscribe === 'function') unsubscribe(); } catch { /* ignore */ } });
    }
  } catch (err) {
    bump('evolutionMemory.shadowSubscribe.initFailed');
    warn('evolution-memory: shadow subscribe init failed', {
      error: err instanceof Error ? err.message : String(err ?? 'unknown'),
    });
  }
}

export { Config, apply, inject, name, spec };
