/**
 * agint-evolution-driver —— bucket-writer.js（B 包写端）
 *
 * 把 prediction_outcomes 聚合成 knowledge_buckets（设计 §2.5.1）。
 * 调用点：measureOutcomes 在 measurePending 之后（随周 job outcome-measure）。
 *
 * 纪律：
 * - mutationType 只从 ledger 条目 summary 取，⛔ 不猜（取不到 ⇒ 跳过计数）。
 * - pq=null（NOT_PREDICTED）不进桶：没有预测就没有校准样本。
 * - DA 从存储字段重算（directionalAccuracy 纯函数）——记录不存 DA，但可复现。
 * - 桶是派生统计：upsert 覆盖合法；源头 prediction_outcomes 不可覆盖 ⇒ 可重建。
 * - 永不抛（cron 外壳纪律）；服务缺方法 ⇒ SERVICE_UNAVAILABLE（部署顺序差一度不炸）。
 */

import { aggregateBucket, directionalAccuracy } from './prediction-scoring.js';

export function createBucketWriter(ctx, { warn = () => {}, now = () => new Date().toISOString() } = {}) {
  const dep = (n) => (ctx && typeof ctx.get === 'function' ? ctx.get(n) : null);

  async function rebuild() {
    const empty = { ok: true, bucketsWritten: 0, sampleTotal: 0, skipped: { noLedgerEntry: 0, noMutationType: 0, noPQ: 0 } };
    try {
      const evo = dep('agint.evolution');
      const missing = ['listPredictionOutcomes', 'recordKnowledgeBucket']
        .filter((m) => typeof evo?.[m] !== 'function');
      if (typeof evo?.ledger?.list !== 'function') missing.push('ledger.list');
      if (missing.length > 0) {
        return { ...empty, ok: false, status: 'SERVICE_UNAVAILABLE', missing };
      }

      const outcomes = await evo.listPredictionOutcomes();
      const entries = await evo.ledger.list();
      const byContract = new Map(entries.map((e) => [e?.contractId, e]));

      const groups = new Map();
      const skipped = { noLedgerEntry: 0, noMutationType: 0, noPQ: 0 };
      for (const r of outcomes) {
        if (!Number.isFinite(r?.predictionQuality)) { skipped.noPQ += 1; continue; }
        const entry = byContract.get(r.contractId);
        if (!entry) { skipped.noLedgerEntry += 1; continue; }
        const mutationType = entry.summary?.mutationType;
        if (typeof mutationType !== 'string' || mutationType === '') { skipped.noMutationType += 1; continue; }
        const key = `${mutationType}::${r.targetMetric}`;
        if (!groups.has(key)) groups.set(key, { mutationType, targetMetric: r.targetMetric, records: [] });
        groups.get(key).records.push({
          pq: r.predictionQuality,
          actualDelta: r.actualDelta,
          DA: directionalAccuracy(r.predictedDelta, r.actualDelta, r.isDeadZone === true),
          isDeadZone: r.isDeadZone === true,
        });
      }

      let bucketsWritten = 0;
      let sampleTotal = 0;
      for (const { mutationType, targetMetric, records } of groups.values()) {
        const bucket = aggregateBucket({ mutationType, targetMetric, records });
        await evo.recordKnowledgeBucket({ ...bucket, lastUpdated: now() });
        bucketsWritten += 1;
        sampleTotal += records.length;
      }
      return { ok: true, bucketsWritten, sampleTotal, skipped };
    } catch (error) {
      const msg = error?.message ?? String(error);
      warn('bucket-writer: 聚合落表失败（已收回，不毁整轮测量）', { error: msg });
      return { ...empty, ok: false, status: 'RECORD_FAILED', error: msg };
    }
  }

  return { rebuild };
}

export default { createBucketWriter };
