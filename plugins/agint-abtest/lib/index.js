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
 * 行数预算（设计稿 §十.1）：≤150 行
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
    if (t.entries().length >= LIMITS.ABTESTS) {
      throw new Error(`abtests table full (cap ${LIMITS.ABTESTS})`);
    }
    const id = randomId('abt');
    const entry = AbtestRecordSchema.parse({
      id, kind: 'abtest', status: 'running',
      variantA, variantB, taskSuite, significanceThreshold,
      createdAt: nowIso(),
    });
    await t.put(entry.id, entry);
    return { testId: entry.id, status: entry.status };
  }

  // ── Service: report ───────────────────────────────────────────────
  async function report({ testId }) {
    if (!testId) throw new Error('report: testId 必填');
    const tT = await t_tests();
    const testEntry = tT.entries().find((e) => e.id === testId);
    if (!testEntry) throw new Error(`report: testId='${testId}' 在 abtests 表里查不到`);
    const tS = await t_samples();
    const samplesA = tS.entries().filter((s) => s.testId === testId && s.variant === 'A').map((s) => s.score);
    const samplesB = tS.entries().filter((s) => s.testId === testId && s.variant === 'B').map((s) => s.score);
    const decision = decideWinner({
      samplesA, samplesB,
      threshold: testEntry.significanceThreshold,
      taskSuite: testEntry.taskSuite,
    });
    // 顺手标 status 落 abtests 表（不影响 FROZEN 签名）
    const updated = { ...testEntry, status: decision.winner === 'inconclusive' ? 'inconclusive' : 'completed' };
    await tT.put(updated.id, updated);
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
    const tests = t.entries().map((e) => ({
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