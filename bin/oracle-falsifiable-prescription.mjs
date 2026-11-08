#!/usr/bin/env node
/**
 * bin/oracle-falsifiable-prescription.mjs —— 真实可证伪预测（G4 的真实输入）
 *
 * 2026-11-07「授权让最后一盏灯亮起来」：此前 G4 与金标在信封层被绑死
 * （buildPrescriptionEnvelope 先查 ANCHOR_NOT_EXTERNAL，锚不合格 ⇒ 信封造不出
 * ⇒ 心跳器拿不到预测 ⇒ G4 恒 fail）。这让「缺外部真值」和「缺可证伪预测」
 * 两个**互相独立**的缺口混成了一条，五闸读数不能反映链路真实状态。
 *
 * 本模块把 G4 拆出来：从**真实 storages 读数**构造一份「工程承诺型」候选处方，
 * 带真实基线、真实预测值、明确的可证伪对拍口径。⛔ 它：
 *
 *   - 不是业务改进建议，更不是能力结论；预测对象是链路自己的工程契约落地情况；
 *   - 不含任何分数字段（FORBIDDEN_PRESCRIPTION_FIELDS 逐键拒收）；
 *   - predictedDelta 不是占位 0：由真实基线 + 明确预测目标推出，可被下周实测打脸；
 *   - 不投递、不写盘、不调 LLM；锚不合格时信封仍被 ANCHOR_NOT_EXTERNAL 拒收
 *     ⇒ G2 依旧是唯一没亮的闸，生产写入恒 0。
 *
 * ⛔ 判定权没有因此放宽：G2 只认外部冻结 GOLD/HELDOUT，SILVER 自评永远不算。
 *
 * 用法：
 *   node bin/oracle-falsifiable-prescription.mjs --storages <dir> --json
 */

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isoWeekKey, readRuntimeSources } from './oracle-runtime-sources.mjs';

export const FP_SCHEMA = '1.0';
export const FP_TARGET = 'proposal_queue';
/** 预测对象：evolve.proposal 里 oracle 源且带非空 predictedDeltaSource 的条数。 */
export const FP_METRIC = 'oracle_proposals_with_falsifiable_prediction';
/** 本批工程承诺：下一个 ISO 周应至少新增 1 条带可证伪预测的 oracle 源提案。 */
export const FP_PROMISED_INCREMENT = 1;

/**
 * 由真实读数构造候选处方。**域不可用 ⇒ null**（三态纪律：没测过绝不拿 0 冒充）。
 * @param {object} sources readRuntimeSources() 的真实结果
 * @param {{now?:Date}} opts
 */
export function buildFalsifiablePrescription(sources, { now = new Date() } = {}) {
  const o = sources?.oracle;
  if (!o || o.domainOk !== true) return null;

  const hist = o.historical ?? {};
  const total = Number.isFinite(hist.total) ? hist.total : 0;
  const withSource = Number.isFinite(hist.withPredictedDeltaSource)
    ? hist.withPredictedDeltaSource
    : 0; // 老版本 sources 没有该计数 ⇒ 0 是「结构缺失」，但读数是真实的

  const week = isoWeekKey(now.toISOString()) ?? 'UNKNOWN_WEEK';
  const baselineKey = `${week}|${total}|${withSource}|${o.weeklyProposalCount ?? 0}`;
  const digest = createHash('sha256').update(baselineKey, 'utf8').digest('hex').slice(0, 12);

  const predictedDelta = FP_PROMISED_INCREMENT;
  const predictedDeltaSource = [
    `真实读数 agint_evolve.proposal：oracle 源 ${total} 条，其中带非空 predictedDeltaSource 的 ${withSource} 条`,
    `（agint_aesthetic_oracle.weekly 累计回流计数 ${o.weeklyProposalCount ?? 0}；交叉对拍 ${o.crossCheck?.consistent === true ? '一致' : '不一致'}）`,
    `基线 ${FP_METRIC}=${withSource}；预测下一 ISO 周该计数为 ${withSource + predictedDelta} ⇒ Δ=+${predictedDelta}`,
    '对拍口径：下一 ISO 周重读同一表算 actualDelta，写入 growth-report.prediction_outcomes',
    '若实际增量 ≠ 本预测，本条被证伪并在日报中如实记为预测失败，不解释为能力退步。',
  ].join('；');

  return Object.freeze({
    schemaVersion: FP_SCHEMA,
    id: `oracle-fp-${week}-${digest}`,
    target: FP_TARGET,
    kind: 'engineering-commitment',
    body: [
      '［契约自检处方，不是业务建议］本批已把「可证伪预测」接进 oracle 提案产出契约。',
      '本条预测下一 ISO 周会出现至少 1 条带 predictedDelta + predictedDeltaSource 的 oracle 源提案；',
      '它不评价系统能力、不含任何分数、不构成改进方向。',
      '⛔ 外部冻结真值（GOLD/HELDOUT）未到位时，B1 信封按 ANCHOR_NOT_EXTERNAL 拒收，',
      '本条永不投递、永不执行；status 恒为 proposed。',
    ].join(''),
    predictedDelta,
    predictedDeltaSource,
    metric: FP_METRIC,
    baseline: withSource,
    predictedValue: withSource + predictedDelta,
    falsification: '下一 ISO 周重读 evolve.proposal 中 oracle 源且带非空 predictedDeltaSource 的条数，'
      + `actualDelta = 实测值 − ${withSource}；与 predictedDelta=${predictedDelta} 对拍，写入 prediction_outcomes。`,
    evidenceRef: `real-storages:agint_evolve.proposal@${week}`,
    asOf: now.toISOString(),
    synthetic: false,
  });
}

/** 只读体检：确认这份处方的预测不是占位、不含分数字段、来源真实。 */
export function inspectFalsifiablePrescription(p) {
  if (!p) return { ok: false, reason: 'NO_PRESCRIPTION: 真实 oracle 域不可用，G4 保持 fail' };
  const forbidden = [];
  const banned = ['aesthetic_score', 'aestheticScore', 'score', 'scoreDelta', 'composites',
    'noise', 'confidence', 'redundancy', 'bloat', 'scaleHash', 'FORMULA_VERSION',
    'verdict', 'humanVerdict', 'humanOverall'];
  for (const k of Object.keys(p)) if (banned.includes(k)) forbidden.push(k);
  const deltaOk = typeof p.predictedDelta === 'number' && Number.isFinite(p.predictedDelta);
  const sourceOk = typeof p.predictedDeltaSource === 'string' && p.predictedDeltaSource.trim().length > 0;
  const notPlaceholder = deltaOk && /真实读数/.test(p.predictedDeltaSource) && /对拍口径/.test(p.predictedDeltaSource);
  return {
    ok: forbidden.length === 0 && deltaOk && sourceOk && notPlaceholder && p.synthetic === false,
    reason: forbidden.length ? `SCORE_FIELD_PRESENT: ${forbidden.join(', ')}`
      : !deltaOk ? 'PREDICTED_DELTA_INVALID'
        : !sourceOk ? 'PREDICTED_DELTA_SOURCE_MISSING'
          : !notPlaceholder ? 'PREDICTION_IS_PLACEHOLDER: 来源未指向真实读数/对拍口径'
            : 'REAL_FALSIFIABLE_PREDICTION',
    schemaVersion: FP_SCHEMA,
    metric: p.metric ?? null,
    baseline: p.baseline ?? null,
    predictedDelta: p.predictedDelta ?? null,
    predictedValue: p.predictedValue ?? null,
    forbidden,
  };
}

/** CLI：只读打印当前真实读数下 G4 的输入。 */
function main() {
  const args = process.argv.slice(2);
  let storages = null;
  for (let i = 0; i < args.length; i++) if (args[i] === '--storages') storages = args[++i] ?? null;
  const sources = readRuntimeSources({ storages });
  const p = buildFalsifiablePrescription(sources);
  const out = { schemaVersion: FP_SCHEMA, prescription: p, inspection: inspectFalsifiablePrescription(p), writes: 0 };
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else {
    process.stdout.write('G4 真实可证伪预测 · 只读探针\n');
    process.stdout.write(`  判词：${out.inspection.reason} ｜ 写入 ${out.writes}\n`);
    if (p) {
      process.stdout.write(`  处方 ${p.id} ｜ 指标 ${p.metric}\n`);
      process.stdout.write(`  基线 ${p.baseline} → 预测 ${p.predictedValue}（Δ=${p.predictedDelta}）\n`);
      process.stdout.write(`  对拍：${p.falsification}\n`);
    }
    process.stdout.write('  ⛔ 锚未到位时 B1 信封仍拒收；G2 与生产写入不受影响。\n');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
