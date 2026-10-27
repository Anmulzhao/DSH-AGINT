/**
 * agint-abtest v0.6.4 — Sprint 10 #9 收口
 *
 * Prompt-A/B 测试基础设施独立 Cordis 插件（设计稿 §二.6）。
 *
 * Service 契约（FROZEN 签名）：
 *   agint.abtest = {
 *     start({ variantA, variantB, taskSuite, significanceThreshold }) → { testId, status: 'running' },
 *     report({ testId }) → { winner: 'A'|'B'|'inconclusive', pValue, effectSize, samples },
 *     listTests() → { tests: [{ testId, status, variantA, variantB, createdAt }] },
 *   };
 *
 * 统计护栏（设计稿 §二.6 + §六 §6.4）：
 *   - 任务集 ≥10 启动（老板拍板初版宽松，跑 2 周后收紧到 ≥30）
 *   - pValue Bonferroni 校正：adjustedAlpha = α / taskSuite.length
 *   - effectSize（Cohen's d）≥0.3 才判定 winner
 *   - 样本量不足 → 'inconclusive'（不强行判 winner）
 *
 * 统计纯函数（lib/statistics.js）独立可测：
 *   - welchTTest(samplesA, samplesB) → { t, df, pValue }
 *   - bonferroniAdjust(alpha, numTests) → adjustedAlpha
 *   - cohensD(samplesA, samplesB) → number
 *   - decideWinner({ samplesA, samplesB, threshold, taskSuite }) → 终态
 *
 * 独立存储域：
 *   - agint_abtest
 *   - 2 表: abtests (上限 50) + samples (上限 10000)
 *
 * L0-frozen 保护（设计稿 §七 + §不做事）：
 *   - 不引用 quality-contract FROZEN 接口（注释里也不许直接写完整字段名）
 *   - 不修改 contract 任何签名
 *   - 不引入新的中心化服务（仅 AB 平台）
 *
 * 行数预算：**已取消**（2026-10-26，老板拍板）。原设计稿 §十.1 的「≤150 行」
 *   不再作为约束 —— 它在本插件 169 行时就已被突破，后来者要么违规要么硬拆文件，
 *   两种结果都比「按职责划分文件」更差。文件大小仍受通用工程判断约束，但不再设阈值。
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { welchTTest, bonferroniAdjust, cohensD, decideWinner } from './statistics.js';

const name = 'agint-abtest';
const inject = ['storageDomain'];

const Config = z.object({}).optional();

const LIMITS = { ABTESTS: 50, SAMPLES: 10000 };

// ── 内部 zod schema ───────────────────────────────────────────────────
const VariantSchema = z.object({
  promptId: z.string().min(1),
  version: z.string().min(1),
});
const AbtestRecordSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('abtest'),
  status: z.enum(['running', 'completed', 'inconclusive', 'aborted']),
  variantA: VariantSchema,
  variantB: VariantSchema,
  taskSuite: z.array(z.string()).min(10),
  significanceThreshold: z.number().min(0).max(1).default(0.05),
  createdAt: z.string(),
});
const SampleRecordSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('sample'),
  testId: z.string().min(1),
  variant: z.enum(['A', 'B']),
  score: z.number(),
  taskId: z.string(),
  createdAt: z.string(),
});

const spec = defineDomain({
  name: 'agint_abtest',
  version: 1,
  tables: {
    abtests: { valueSchema: AbtestRecordSchema },
    samples: { valueSchema: SampleRecordSchema },
  },
});

function randomId(prefix) {
  const c = globalThis.crypto;
  const id = c && typeof c.randomUUID === 'function' ? c.randomUUID() : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${id}`;
}

function nowIso() { return new Date().toISOString(); }

// ── 实验生命周期事件发布（2026-10-26）──────────────────────────────────
// 背景：本插件此前对事件总线零感知（check-wiring 查 E' 的 UNWIRED）——
//   `agint.abtest.start / report` 的 A/B 结论**从未送达任何下游**。
//
// 为什么值得发（不是为凑门禁绿）：
//   A/B 结论是 D-QAF 决策链的证据之一（哪个变体更好、显著与否）。它此前只活在
//   `agint_abtest` 存储域里，quality-eval / metrics 要看结论只能反查存储；一旦结论
//   要参与自动部署判定，就没有时间锚点可对齐。⇒ started / concluded 两个时刻上总线。
//
// ⚠️ 如实声明：**接线 ≠ 通电**。本插件存储域 `agint_abtest` 至今仍 DEAD
//   （`agint_abtest.json` 从未生成），说明 start() 从未被真实调用过 —— 接上发布侧
//   只是「一旦有实验就能发」，不等于会有生产数据。让该域通电需真实跑一次 A/B，属独立议题。
//
// 红线（沿用 agint-rules / agint-mount 的接线纪律，K63/K64 教训）：
//   1. start/report 的返回值与抛错语义一律不变，发布是 best-effort。
//   2. 三形态探测（gap 文档 §6.4）：分服务名 → 伞键 getService → 伞键 get。
//      只查伞键会恒 undefined 并静默降级，当年 mount 的 10 处发布就是这么空转的。
//   3. 不切 T2：主路径仍是存储直写，本条是影子广播。
function resolveBusPublish(ctx) {
  const bind = (bus) => (bus && typeof bus.publish === 'function' ? bus.publish.bind(bus) : null);
  const probes = [
    () => (typeof ctx.get === 'function' ? ctx.get('agint.eventBus.publish') : null),
    () => bind(typeof ctx.getService === 'function' ? ctx.getService('agint.eventBus') : null),
    () => bind(typeof ctx.get === 'function' ? ctx.get('agint.eventBus') : null),
  ];
  for (const probe of probes) {
    try {
      const fn = probe();
      if (typeof fn === 'function') return fn;
    } catch { /* 试下一种形态 */ }
  }
  return null;
}

/** Publish one abtest event. Never throws — bus failure must not break the contract. */
async function publishAbtestEvent({ ctx, topic, payload }) {
  const publish = resolveBusPublish(ctx);
  if (!publish) return { published: false, reason: 'eventBus-unavailable' };
  try {
    const result = await publish({ topic, version: 1, source: 'agint-abtest', payload });
    return { published: true, envelopeId: result?.envelopeId, deliveredTo: result?.deliveredTo ?? 0 };
  } catch (err) {
    try {
      ctx.logger?.warn?.(`abtest: ${topic} publish failed`, {
        error: err instanceof Error ? err.message : String(err ?? 'unknown'),
      });
    } catch { /* noop */ }
    return { published: false, reason: 'publish-failed' };
  }
}

function apply(ctx, config) {
  let domain = null, domainError = null, disposed = false;
  ctx.effect(() => () => { disposed = true; if (domain) return domain.close(); });

  const ready = ctx.storageDomain.open(spec).then(
    (d) => { if (disposed) { void d.close().catch(() => {}); return null; } domain = d; return d; },
    (error) => { domainError = error; return null; },
  );

  const table = async (name) => {
    if (disposed) throw new Error('agint-abtest: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-abtest: domain unavailable');
    return d.table(name);
  };
  const t_tests = () => table('abtests');
  const t_samples = () => table('samples');

  // ── Service: start ───────────────────────────────────────────────
  async function start({ variantA, variantB, taskSuite, significanceThreshold = 0.05 }) {
    if (!variantA || !variantB) throw new Error('start: variantA + variantB 必填');
    if (!Array.isArray(taskSuite) || taskSuite.length < 10) {
      throw new Error(`start: taskSuite 长度 ${taskSuite?.length ?? 0} < 10（设计稿 §二.6 + 老板拍板初版宽松门槛）`);
    }
    const t = await t_tests();
    if (t.size >= LIMITS.ABTESTS) {
      throw new Error(`abtests table full (cap ${LIMITS.ABTESTS})`);
    }
    const id = randomId('abt');
    const entry = AbtestRecordSchema.parse({
      id, kind: 'abtest', status: 'running',
      variantA, variantB, taskSuite, significanceThreshold,
      createdAt: nowIso(),
    });
    await t.put(entry.id, entry);
    // 影子广播：实验开始。落库之后才发 —— 没落成的实验不该出现在总线上。
    await publishAbtestEvent({
      ctx,
      topic: 'abtest.started',
      payload: {
        testId: entry.id,
        variantA: entry.variantA,
        variantB: entry.variantB,
        taskSuiteSize: entry.taskSuite.length,
        significanceThreshold: entry.significanceThreshold,
      },
    });
    return { testId: entry.id, status: entry.status };
  }

  // ── Service: report ───────────────────────────────────────────────
  async function report({ testId }) {
    if (!testId) throw new Error('report: testId 必填');
    const tT = await t_tests();
    const testEntry = tT.entries().find((e) => e.id === testId);
    if (!testEntry) throw new Error(`report: testId='${testId}' 在 abtests 表里查不到`);
    const tS = await t_samples();
    // 2026-10-13：table.entries() 返回迭代器；Node 的 Iterator Helpers 让迭代器
    // **有** .filter/.map，但返回的仍是迭代器而非数组 ⇒ .length 全 undefined。
    // 必须先 [...entries()] 展开成数组。（实测：it.map(...) → isArray=false）
    const samplesA = [...tS.entries()].filter((s) => s.testId === testId && s.variant === 'A').map((s) => s.score);
    const samplesB = [...tS.entries()].filter((s) => s.testId === testId && s.variant === 'B').map((s) => s.score);
    const decision = decideWinner({
      samplesA, samplesB,
      threshold: testEntry.significanceThreshold,
      taskSuite: testEntry.taskSuite,
    });
    // 顺手标 status 落 abtests 表（不影响 FROZEN 签名）
    const updated = { ...testEntry, status: decision.winner === 'inconclusive' ? 'inconclusive' : 'completed' };
    await tT.put(updated.id, updated);
    // 影子广播：实验结论。只带结论标量，不落全量分数（防事件体膨胀）。
    await publishAbtestEvent({
      ctx,
      topic: 'abtest.concluded',
      payload: {
        testId: updated.id,
        winner: decision.winner,
        pValue: decision.pValue,
        effectSize: decision.effectSize,
        status: updated.status,
        samples: decision.samples,
      },
    });
    return {
      winner: decision.winner,
      pValue: decision.pValue,
      effectSize: decision.effectSize,
      samples: decision.samples,
    };
  }

  // ── Service: listTests ────────────────────────────────────────────
  async function listTests() {
    const t = await t_tests();
    const tests = [...t.entries()].map((e) => ({
      testId: e.id, status: e.status, variantA: e.variantA, variantB: e.variantB, createdAt: e.createdAt,
    }));
    return { tests };
  }

  ctx.provide('agint.abtest', {
    start, report, listTests,
    limits: LIMITS,
    _internal: { bonferroniAdjust, cohensD, welchTTest }, // 测试可见
  });
}

export { Config, apply, name, inject };