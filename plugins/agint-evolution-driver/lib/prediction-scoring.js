/**
 * agint-evolution-driver —— prediction-scoring.js
 *
 * Phase 1 交付物 1 §2.3：预测质量评分模型（DA / MC / IF / PQ）+ §2.4.3 死区判定。
 *
 * ## 它补的是哪个洞
 *
 * 进化决策链路「诊断 → 变异 → 沙箱 → 裁决」里**没有"预期"这一环**。
 * 缺了它就无法区分「真的变好」与「碰巧」，跑了多少期进化都沉淀不下工程知识，
 * Phase 2 的 Mutation Strategy Learning 更是无从谈起（没有「策略 → 效果」的训练数据）。
 *
 * ## ⛔ 本模块最关键的设计：为什么不能只看"误差小"
 *
 * 若把「预测误差越小越好」当目标，系统会学会一个**退化策略**：
 * 永远预测 Δ=0。多数变异效果确实微弱，预测 0 的平均误差最小、校准分最高，
 * 但这个预测**毫无信息量** —— 这就是「刷分」。
 *
 * 所以设计成**双维度**：既奖励「准」（MC），也奖励「敢」（IF），
 * 再用方向正确性（DA）作**乘数因子**一票否决：
 *
 *   PQ = DA × (0.6 × MC + 0.4 × IF)
 *
 * DA 之所以是乘数而不是加项：预测「大幅回归」但实际「小幅改善」这类错误，
 * 幅度分数可能还不低，若用加法会被掩盖；方向错了就是 0 分（真实 > 讨好）。
 *
 * ## 三条边界（改代码前先读）
 *
 * 1. **纯函数，零副作用，零依赖**。不读存储、不发事件、不写文件。
 *    所有需要副作用的接线（写 contract_locks / 发 locked 事件）由 caller 负责 ——
 *    本轮 Sprint 21 只交付可单测的纯函数（宿主 contract-manager 尚未存在，见文末）。
 * 2. **τ_metric 缺省值来自设计附录 B，标定来源是「4 周实测 IQR」**。
 *    冷启动期用缺省；重标定规则是 `max(缺省值, 实测IQR)`（只放宽不收紧），
 *    防止噪声大时被误判成「预测不准」。实测 IQR 未回填前，本模块**不假装**有。
 * 3. **τ_deadzone 的第二个成分「评估噪声标准差」本轮恒缺省**。
 *    设计 §2.4.3 写的是 `max(0.5 × τ_metric, 噪声标准差)`，但生产侧目前
 *    **没有**可取的噪声标准差字段（outcome.baselineNoiseStd 无人写入）。
 *    本模块按 `0.5 × τ_metric` 计算并把噪声项设计成**可注入参数**，
 *    拿不到就不编（返回 null 并在 deadZoneBasis 标注），符合「禁止兜底造数」。
 *
 * ## 与既有枚举的对齐（2026-10-02 取证结论）
 *
 * 设计 §2.3.4 写的 mutationType 是 `TOOL/MEMORY/WORKFLOW/PROMPT/MIDDLEWARE`，
 * 但生产 FROZEN 枚举 `agint-mutator/lib/schema.js:21` 是
 * `PROMPT_MUTATION / TOOL_SYNTHESIS / STRATEGY_REWRITE`。
 * **以生产为准**（知识桶 key 依赖它，且 MEMORY 类在 mutator 侧无对应 kind）。
 * targetMetric 则与 `evolution-contract-v1.schema.json` 的枚举一致。
 *
 * ## ⚠️ 与设计文档的 3 处已拍板偏差（改代码前先读）
 *
 * 差分测试（对照独立参照实现，336 组 0 分歧）确认下列偏差**归属设计文档本身**，
 * 非实现 bug。均经大鱼 2026-10-02 拍板：
 *
 * 1. **方向冲突优先于死区**（见 directionalAccuracy 内注释）。
 *    设计 §2.3.2 死区规则与同段维度1 / 附录A行3 / 验收标准 #3 三处对撞，
 *    以「一票否决」为准。
 * 2. **IF=0 ⇒ PQ=0**（见 ZERO_INFO_PQ 内注释）。
 *    否则照原公式实现，验收标准 #2「预测0 时 PQ<0.25」必然判红（实算 0.29~0.30）。
 * 3. **附录 A 速查表两行算术有误**：行4（+0.0/+0.1）设计写 0.194，
 *    公式实为 **0.290**（0.388 = 0.4×0.97，MC 权重 0.6 被误写成 0.4）；
 *    行6（+4.0/+0.2）设计写 0.47，公式实为 **0.284**。
 *    **本实现以 §2.3.3 公式为准**，单测里对这两行标注已知偏差。
 */

// ── τ 参数表（设计附录 B）────────────────────────────────────────────────

/**
 * τ_metric：该指标的历史波动尺度（IQR），MC 与 IF 都以它归一化。
 * 缺省值来源：设计附录 B「标定来源 = 缺省值，4 周后按实测 IQR 重标定」。
 */
export const TAU_METRIC = Object.freeze({
  SUCCESS_RATE: 3.0,
  TOKEN_EFFICIENCY: 8.0,
  LATENCY: 15.0,
  REGRESSION: 0.5,
});

/**
 * 二值指标：不适用 PQ，单独统计（设计附录 B 末行）。
 * 记在这里是为了让「查不到 τ」有明确归因，而不是静默当 0 处理。
 */
export const BINARY_METRICS = Object.freeze(['SAFETY']);

/** τ_deadzone 的缺省系数（设计附录 B 给的全是 0.5 × τ_metric）。 */
export const DEADZONE_TAU_FACTOR = 0.5;

/** 桶置信度三级门槛（设计 §2.3.4）。 */
export const CONFIDENCE_THRESHOLDS = Object.freeze({
  STABLE: 10,
  PROVISIONAL: 5,
});

/**
 * mutationType：以生产 FROZEN 枚举为准（见文件头「与既有枚举的对齐」）。
 * 从 mutator 抄一份而非 import —— 插件间不互相 import lib（会产生跨插件耦合），
 * 由测试断言两侧一致。
 */
export const MUTATION_TYPES = Object.freeze([
  'PROMPT_MUTATION',
  'TOOL_SYNTHESIS',
  'STRATEGY_REWRITE',
]);

// ── §2.3.1 指标标准化 ───────────────────────────────────────────────────

/**
 * 相对 baseline 的百分比变化，消除量纲差异。
 *
 *   normalizedDelta = (candidate - baseline) / max(|baseline|, ε) × 100%
 *   ε = baseline 的 1%（防止除零）
 *
 * ⚠️ baseline 为 0 时：真实场景里 baseline=0 不代表「无变化」（如 Safety Violation
 * 从 0 变 1 是严重恶化），但也确实**无法用相对量表达**。此处返回 null 并由
 * caller 标 NO_EVIDENCE —— 不用 0 冒充（设计 §2.3.1 + 经验教训 §3.1）。
 *
 * @param {number} baseline
 * @param {number} candidate
 * @returns {number|null} 百分比变化；无法表达时 null
 */
export function normalizedDelta(baseline, candidate) {
  if (!Number.isFinite(baseline) || !Number.isFinite(candidate)) return null;
  const eps = Math.abs(baseline) * 0.01;
  const denom = Math.max(Math.abs(baseline), eps);
  // baseline=0 ⇒ denom=0 ⇒ 除零。返回 null 让上层标 NO_EVIDENCE，不返回 Infinity。
  if (denom === 0) return null;
  return ((candidate - baseline) / denom) * 100;
}

// ── §2.4.3 死区判定 ─────────────────────────────────────────────────────

/**
 * 取某指标的 τ_metric。
 * @param {string} targetMetric
 * @returns {number|null} 二值指标或未知指标返回 null
 */
export function tauFor(targetMetric) {
  const tau = TAU_METRIC[targetMetric];
  return Number.isFinite(tau) ? tau : null;
}

/**
 * 死区阈值 τ_deadzone = max(0.5 × τ_metric, 评估噪声标准差)。
 *
 * @param {string} targetMetric
 * @param {number|null} [baselineNoiseStd] 生产侧目前无人写入该值；缺省即不参与
 * @returns {{ threshold:number|null, basis:string }}
 *          threshold 为 null ⇒ 该指标不适用（未知指标 / 二值指标）
 *          basis 记录实际生效的成分，避免"看起来算过了其实没算"
 */
export function deadZoneThreshold(targetMetric, baselineNoiseStd = null) {
  const tau = tauFor(targetMetric);
  if (tau === null) {
    return { threshold: null, basis: BINARY_METRICS.includes(targetMetric) ? 'BINARY_METRIC' : 'UNKNOWN_METRIC' };
  }
  const fromTau = DEADZONE_TAU_FACTOR * tau;
  if (Number.isFinite(baselineNoiseStd) && baselineNoiseStd > fromTau) {
    return { threshold: baselineNoiseStd, basis: 'NOISE_STD' };
  }
  return { threshold: fromTau, basis: 'TAU_FACTOR' };
}

/**
 * 是否落入死区（|actual| < τ_deadzone ⇒ NO_MATERIAL_CHANGE）。
 *
 * 理由（设计 §2.4.3）：把噪声当改进会污染知识库，导致后续预测**系统性乐观**。
 *
 * @param {number} actualDelta
 * @param {string} targetMetric
 * @param {number|null} [baselineNoiseStd]
 * @returns {{ isDeadZone:boolean, threshold:number|null, basis:string }}
 */
export function isDeadZone(actualDelta, targetMetric, baselineNoiseStd = null) {
  const { threshold, basis } = deadZoneThreshold(targetMetric, baselineNoiseStd);
  if (threshold === null || !Number.isFinite(actualDelta)) {
    // 判不了 ≠ 判成"有实质变化"。不可判定时按"非死区"但 basis 会暴露原因，
    // 且上层 PQ 计算会因 tau=null 而返回 NO_EVIDENCE，不会伪装成有效评分。
    return { isDeadZone: false, threshold, basis };
  }
  return { isDeadZone: Math.abs(actualDelta) < threshold, threshold, basis };
}

// ── §2.3.2 三维度评分 ───────────────────────────────────────────────────

/**
 * 维度 1：方向正确性 Directional Accuracy（二值，权重最高，作为乘数因子）。
 *
 *   DA = 1    sign(predicted) == sign(actual)
 *   DA = 0.5  |actual| < τ_deadzone（方向不可判定）
 *   DA = 0    方向相反
 *
 * ⛔ **方向冲突优先于死区**（2026-10-02 大鱼拍板）。设计 §2.3.2 把死区写在
 * DA=0.5 那档，但同段维度 1、附录 A 行3（预测 +4.0 / 实际 -1.0 → DA=0）、
 * 以及验收标准 #3「方向错一票否决：sign 不符时 PQ == 0，**无论 MC 多高**」
 * 都要求方向相反时判 0。三处对撞时以「一票否决」为准：
 * 死区的存在理由是「方向**不可判定**」，而方向已经判定了（且判反）时，
 * 恰恰是最需要拉警报的情形 —— 拿 DA=0.5 去赦免它，等于把最严重的错误
 * （预测变好、实际变差，会误导后续策略）降级成「方向不可知」。
 *
 * 代价如实交代：预测 +4.0 / 实际 -1.0 实际只有 1.0pp 偏差（小于 τ_deadzone=1.5），
 * 死区判据本该放过它；本实现按验收 #3 判 0。宁可漏放一次轻微误判，
 * 不可放过一次方向性错误 —— 真实 > 讨好。
 *
 * @param {number} predictedDelta
 * @param {number} actualDelta
 * @param {boolean} isDeadZoneActual 由 isDeadZone() 传入，避免重复算阈值
 * @returns {0|0.5|1}
 */
export function directionalAccuracy(predictedDelta, actualDelta, isDeadZoneActual) {
  // 方向冲突（一票否决）—— 优先于死区
  const signConflict = predictedDelta !== 0 && actualDelta !== 0
    && Math.sign(predictedDelta) !== Math.sign(actualDelta);
  if (signConflict) return 0;
  if (isDeadZoneActual) return 0.5;
  if (actualDelta === 0) return 0.5;
  if (predictedDelta === 0) return 0; // 预测"无变化"而实际有方向 ⇒ 方向未命中
  return 1;
}

/**
 * 维度 2：幅度校准 Magnitude Calibration（连续 0~1）。
 *
 *   MC = exp(-|predicted - actual| / τ_metric)
 *
 * 误差 = τ 时 MC ≈ 0.37；误差远小于 τ 时 MC → 1。
 *
 * @param {number} predictedDelta
 * @param {number} actualDelta
 * @param {string} targetMetric
 * @returns {number|null} τ 未知时 null
 */
export function magnitudeCalibration(predictedDelta, actualDelta, targetMetric) {
  const tau = tauFor(targetMetric);
  if (tau === null || tau <= 0) return null;
  if (!Number.isFinite(predictedDelta) || !Number.isFinite(actualDelta)) return null;
  const err = Math.abs(predictedDelta - actualDelta);
  return Math.exp(-err / tau);
}

/**
 * 维度 3：信息量 Informativeness（连续 0~1）—— 防保守刷分的核心维度。
 *
 *   IF = min(|predicted| / τ_metric, 1.0)
 *
 * 预测 Δ=0 ⇒ IF=0（完全无信息）；预测 |Δ| ≥ τ ⇒ IF=1（充分大胆）。
 *
 * @param {number} predictedDelta
 * @param {string} targetMetric
 * @returns {number|null}
 */
export function informativeness(predictedDelta, targetMetric) {
  const tau = tauFor(targetMetric);
  if (tau === null || tau <= 0) return null;
  if (!Number.isFinite(predictedDelta)) return null;
  return Math.min(Math.abs(predictedDelta) / tau, 1.0);
}

// ── §2.3.3 综合评分 ─────────────────────────────────────────────────────

/** MC 与 IF 在 PQ 内的权重（设计 §2.3.3 固定值）。 */
export const PQ_WEIGHTS = Object.freeze({ MC: 0.6, IF: 0.4 });

/**
 * 零信息量预测的 PQ 上限（2026-10-02 大鱼拍板）。
 *
 * ⛔ **IF=0 ⇒ PQ=0**。设计 §2.2 指出本模块的核心风险是「预测刷分」：
 * 永远预测 Δ=0。因大多数变异效果微弱，预测 0 的 MC 反而接近 1
 * （误差小），靠公式算出来 PQ≈0.29~0.30 —— 而验收标准 #2 要求「< 0.25」，
 * **照原公式实现必然判红**。
 *
 * 选这条修法而非改验收门/改死区 DA 的理由：IF=0 的定义就是「预测 Δ=0，
 * 完全无信息量」（设计 §2.3.2 维度 3 原文）。零信息量的预测**没有任何
 * 可被校准的内容** —— 它不是「预测得不准」，而是「没预测」。给这种东西
 * 打 0.3 分，等于承认「摆烂也是本事」，与防刷分的设计初衷直接相反。
 *
 * 影响面：只压 IF=0 这一种退化策略（预测恒 0），不触碰 DA 规则，
 * 也不改变附录 A 其余各行的期望值 —— 真实预测（如 +4.0/+3.8 → 0.961）
 * 完全不受影响。
 */
export const ZERO_INFO_PQ = 0;

/**
 * 零信息量判定的 epsilon 阈值（IF 低于此值即视为「没预测」）。
 *
 * ⛔ 为什么不直接判 `IF === 0`（2026-10-02 单测实测揪出）：
 * 退化策略只要预测 **0.0001** 而非 0，IF = 0.000033 ≠ 0，
 * 于是 PQ = 0.5×(0.6×1+0.4×0.000033) ≈ **0.30** —— 完整地绕过了归零规则。
 * 一个专门防刷分的机制，若只认「恰好等于 0」，等于给刷分者留了一扇门：
 * 差一个数量级就豁免（真实 > 讨好 ⇒ 这种"技术上成立但实质作弊"的口子必须堵）。
 *
 * 阈值取 0.01 的依据：IF 自身是「信息量占 τ_metric 的比例」，
 * IF < 0.01 意味着预测幅度不足该指标噪声尺度的 1%
 * （SUCCESS_RATE τ=3.0 ⇒ 预测 < 0.03pp）。这在任何合理口径下都是「没预测」，
 * 而真正的预测（哪怕保守的 +0.5pp）IF = 0.167，完全不受影响。
 */
export const ZERO_INFO_EPSILON = 0.01;

/**
 * Prediction Quality = DA × (0.6 × MC + 0.4 × IF)，取值 [0, 1]。
 *
 * @param {object} input
 * @param {number} input.predictedDelta 预测的相对变化（%）
 * @param {number} input.actualDelta   实测的相对变化（%）
 * @param {string} input.targetMetric  指标名（决定 τ）
 * @param {number|null} [input.baselineNoiseStd] 评估噪声标准差，可注入
 * @returns {object} 评分结果；无法评分时 pq=null 且带 reason
 */
export function scorePrediction({ predictedDelta, actualDelta, targetMetric, baselineNoiseStd = null }) {
  const { basis: dzBasis } = deadZoneThreshold(targetMetric, baselineNoiseStd);
  if (BINARY_METRICS.includes(targetMetric)) {
    return { pq: null, reason: 'BINARY_METRIC_NOT_SCORED', DA: null, MC: null, IF: null, deadZoneBasis: dzBasis };
  }
  if (!Number.isFinite(predictedDelta) || !Number.isFinite(actualDelta)) {
    // Phase 0 允许 predictedDelta=null + NOT_PREDICTED。没有预测就没有校准可言，
    // 不用 0 冒充（设计 §2.6 与 contract schema 的 predictedDeltaNote 一致）。
    return { pq: null, reason: 'NOT_PREDICTED', DA: null, MC: null, IF: null, deadZoneBasis: dzBasis };
  }

  const dz = isDeadZone(actualDelta, targetMetric, baselineNoiseStd);
  const DA = directionalAccuracy(predictedDelta, actualDelta, dz.isDeadZone);
  const MC = magnitudeCalibration(predictedDelta, actualDelta, targetMetric);
  const IF = informativeness(predictedDelta, targetMetric);

  if (MC === null || IF === null) {
    return { pq: null, reason: 'UNKNOWN_METRIC', DA, MC, IF, isDeadZone: dz.isDeadZone, deadZoneThreshold: dz.threshold, deadZoneBasis: dz.basis };
  }

  // 零信息量（预测幅度不足 τ 的 1%）直接判 0：兑现验收标准 #2，
  // 堵住「永远预测 0 / 预测 0.0001」的退化策略。
  // 保留 MC/IF 原值返回，便于报告分项列示（真实 > 讨好：让人看得见为何是 0）。
  const isZeroInformation = IF < ZERO_INFO_EPSILON;
  const pq = isZeroInformation ? ZERO_INFO_PQ : DA * (PQ_WEIGHTS.MC * MC + PQ_WEIGHTS.IF * IF);
  return {
    pq,
    DA,
    MC,
    IF,
    isZeroInformation,
    isDeadZone: dz.isDeadZone,
    deadZoneThreshold: dz.threshold,
    deadZoneBasis: dz.basis,
    tau: tauFor(targetMetric),
  };
}

// ── §2.3.4 桶置信度 ─────────────────────────────────────────────────────

/**
 * 桶置信度三级判定（设计 §2.3.4）。
 *   n ≥ 10 → STABLE；n ≥ 5 → PROVISIONAL；否则 CALIBRATING
 *
 * ⚠️ 冷启动纪律：CALIBRATING 桶**不得**用于生成新预测的先验，也不得作为对外结论。
 * @param {number} sampleSize
 * @returns {'STABLE'|'PROVISIONAL'|'CALIBRATING'}
 */
export function bucketConfidence(sampleSize) {
  const n = Number.isFinite(sampleSize) ? sampleSize : 0;
  if (n >= CONFIDENCE_THRESHOLDS.STABLE) return 'STABLE';
  if (n >= CONFIDENCE_THRESHOLDS.PROVISIONAL) return 'PROVISIONAL';
  return 'CALIBRATING';
}

/**
 * 知识桶聚合（设计 §2.5.1 knowledge_buckets 表的 value 形状）。
 *
 * insight / recommendation **刻意不在这里生成** —— 设计 §2.5.2 注明确要求
 * 「由确定性映射链路生成（模板 + 统计量），不经过 LLM 润色层」，
 * 那是 Sprint 24 的独立职责。本函数只出统计量，样本不足时如实给空。
 *
 * @param {object} input
 * @param {string} input.mutationType
 * @param {string} input.targetMetric
 * @param {Array<{pq:number, actualDelta:number, DA:number, isDeadZone:boolean}>} input.records
 *        已剔除 pq=null（NO_EVIDENCE）与被篡改（CONTRACT_TAMPERED）的记录
 * @returns {object} 桶 value
 */
export function aggregateBucket({ mutationType, targetMetric, records }) {
  const bucketKey = `${mutationType}::${targetMetric}`;
  const list = Array.isArray(records) ? records : [];
  const sampleSize = list.length;
  const confidence = bucketConfidence(sampleSize);

  // 样本不足 ⇒ 统计量无意义，如实标 null 而非返回 0（0 会被误读成"效果为零"）
  if (sampleSize === 0) {
    return {
      bucketKey, sampleSize, confidence,
      meanPQ: null, medianActualDelta: null, iqrActualDelta: null,
      successRate: null, directionalAccuracy: null, deadZoneRate: null,
      lastUpdated: null,
    };
  }

  const pqs = list.map((r) => r.pq);
  const actuals = list.map((r) => r.actualDelta).sort((a, b) => a - b);
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const median = (xs) => (xs.length % 2 === 1
    ? xs[(xs.length - 1) / 2]
    : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2);
  // IQR：Q3 - Q1（线性插值法，与 numpy 默认一致）
  const quantile = (xs, q) => {
    const pos = (xs.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return lo === hi ? xs[lo] : xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
  };

  return {
    bucketKey,
    sampleSize,
    confidence,
    meanPQ: mean(pqs),
    medianActualDelta: median(actuals),
    iqrActualDelta: quantile(actuals, 0.75) - quantile(actuals, 0.25),
    // successRate 定义：PQ ≥ 0.6 的比例（设计 §2.5.1 注释）
    successRate: pqs.filter((p) => p >= 0.6).length / sampleSize,
    directionalAccuracy: list.filter((r) => r.DA === 1).length / sampleSize,
    deadZoneRate: list.filter((r) => r.isDeadZone).length / sampleSize,
    lastUpdated: null, // 由 caller（写入方）填，避免纯函数里取时钟
  };
}
