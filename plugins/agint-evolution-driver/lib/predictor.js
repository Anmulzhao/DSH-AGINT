/**
 * agint-evolution-driver —— predictor.js
 *
 * Phase 1 交付物 1 §2.4：预测生成机制（三级来源）+ §2.4.2 预测锁定（hypothesisLock）。
 *
 * ## 它补的是哪个洞
 *
 * `prediction-scoring.js` 解决「怎么给预测打分」，本模块解决「预测从哪来、
 * 以及怎么防止事后编造」。两者必须成对：只有打分没有生成，PQ 会永远是无源之水；
 * 只有生成没有锁定，看到结果后再补一个预测就能把校准分刷好看 —— 整个
 * 「可验证的自进化」命题就垮了。
 *
 * ## 三级来源：为什么必须分三级，且必须降级
 *
 * 预测不能由 LLM 凭空生成（经验教训 §3.1：禁止无证据兜底）。按可靠性递减：
 *
 *   Level 3 KNOWLEDGE_BASE —— 知识库同类型桶的历史中位数（需 STABLE 桶）
 *   Level 2 ANALOGY        —— changedComponents 重叠度 ≥0.5 的历史 Contract 加权平均
 *   Level 1 DEFAULT_RULE   —— 静态规则表缺省值（冷启动期，固定低置信度）
 *
 * **降级方向是单向的：L3 → L2 → L1**。任一级「不可用」或「置信度不足」
 * 就降到下一级，绝不反向跳级。Level 1 永远可用（这是它存在的意义），
 * 但它的 confidence 固定 0.2 且必须在 Contract 里标注
 * `predictionSource: "DEFAULT_RULE"` —— 设计 §2.4.1 明确：
 * **不允许把 Level 1 的缺省猜测当作「系统预测能力」来宣传**（真实 > 讨好）。
 *
 * ## 冷启动纪律（与 self-model 的 cold-start 守门一致）
 *
 * `SampleSize < 10` 的桶标记 CALIBRATING，**不得用于生成新预测的先验**。
 * 这条纪律落在 L3 的准入判定里（L3 只吃 STABLE 桶），不靠调用方自觉。
 *
 * ## ⛔ 边界（改代码前先读）
 *
 * 1. **纯函数、零副作用、零外部可变状态**。不读存储、不读时钟、不读环境变量、
 *    不发事件。相同输入始终返回相同输出 —— 这是 hypothesisLock 可信的前提，
 *    也是本模块全部函数的契约。
 * 2. **canonical 序列化在插件侧自实现**，不 import `bin/lib/canonical-json.mjs`。
 *    原因：`install.sh` 只把 `plugins/` + `cordis.patch.yml` + `package.json`
 *    同步进 bundle（`BUNDLE_PLUGINS_SRC`），`bin/` **不随包部署** ⇒ 插件内
 *    import 它会在生产直接 `ERR_MODULE_NOT_FOUND`。
 *    确定性契约与 Phase 0 `bin/lib/canonical-json.mjs` 逐条对齐（key 按码点排序、
 *    无空格、UTF-8 无 BOM、-0 归一为 0、非有限数 fail-closed 抛错），
 *    并由 `bin/verify-prediction-lock.mjs` 与宿主侧实现做同值对拍。
 * 3. **hypothesisLock 锁的是「预测内容」而非「整个 Contract」**。
 *    设计 §2.4.2 写 `sha256(hypothesis JSON + contractId + createdAt)`，
 *    故 `createdAt` 参与摘要 —— 同一份 hypothesis 在不同 Contract 上必须得到
 *    不同的 lock，否则复制粘贴一条旧预测就能冒充新预测。
 */

// node:crypto 是 node: 内置模块（宿主提供，不违反零第三方依赖纪律）。
import { createHash } from 'node:crypto';

// τ_metric 表从同插件的评分模块取（单一事实源，避免两份表分叉）。
// 同插件内 lib/ 互相 import 不构成跨插件耦合（不违反插件边界纪律）。
import { tauFor as tauForMetric } from './prediction-scoring.js';

// ── 预测来源枚举（设计 §2.4.1）─────────────────────────────────────────

export const PREDICTION_SOURCES = Object.freeze({
  KNOWLEDGE_BASE: 'KNOWLEDGE_BASE',
  ANALOGY: 'ANALOGY',
  DEFAULT_RULE: 'DEFAULT_RULE',
});

/**
 * 来源优先级：数字越小越可靠。降级按此顺序单向下降。
 * 导出为冻结数组便于调用方展示「为什么降到这一级」。
 */
export const SOURCE_PRIORITY = Object.freeze([
  PREDICTION_SOURCES.KNOWLEDGE_BASE,
  PREDICTION_SOURCES.ANALOGY,
  PREDICTION_SOURCES.DEFAULT_RULE,
]);

/** Level 1 缺省预测的固定置信度（设计 §2.4.1 明文规定）。 */
export const DEFAULT_RULE_CONFIDENCE = 0.2;

/** Level 3 只吃 STABLE 桶（设计 §2.3.4 冷启动纪律：CALIBRATING 桶不得作先验）。 */
export const STABLE_SAMPLE_THRESHOLD = 10;

/** Level 2 类比推断的 changedComponents 重叠度门槛（设计 §2.4.1）。 */
export const ANALOGY_OVERLAP_THRESHOLD = 0.5;

/**
 * Level 1 静态规则缺省表。
 *
 * ⚠️ **这些是「缺省估计，非推断」**（设计 §2.4.1 原文要求在 Contract 中标注）。
 * 取值依据是 `agint-mutator/lib/index.js` 的 `SOURCE_STUBS` 各 kind 自带的
 * `expectedEffect`（工具调用成功率 ≥80%、通过率 ≥95% 等工程目标），
 * 取其中位数量级作为保守缺省，**不是实测效果**。
 *
 * ⚠️ 保守程度的生产依据（`agint_evolution.json` 实测 202 条 evolution_log）：
 * AUTO_DEPLOY 仅 47/202 = 23.3%，且 `skill` 类 124 条**全部**是 PENDING_REVIEW、
 * `plugin` 类 12 条也全部 PENDING_REVIEW，只有 `composite` 类有 83.9% 自动部署。
 * ⇒ 多数改动类型在生产里根本没拿到过「有把握」的状态判定，
 *    故缺省值取小值并固定 confidence=0.2，**宁可低估不可高估**
 *    （高估会系统性抬高实际值，污染后续先验）。
 */
export const DEFAULT_RULE_TABLE = Object.freeze({
  PROMPT_MUTATION: Object.freeze({
    SUCCESS_RATE: { predictedDelta: 1.0, ruleId: 'DR-PROMPT-SUCCESS' },
    TOKEN_EFFICIENCY: { predictedDelta: 0.8, ruleId: 'DR-PROMPT-TOKEN' },
    LATENCY: { predictedDelta: -0.5, ruleId: 'DR-PROMPT-LATENCY' },
    REGRESSION: { predictedDelta: 0.1, ruleId: 'DR-PROMPT-REGRESSION' },
  }),
  TOOL_SYNTHESIS: Object.freeze({
    SUCCESS_RATE: { predictedDelta: 1.5, ruleId: 'DR-TOOL-SUCCESS' },
    TOKEN_EFFICIENCY: { predictedDelta: 1.0, ruleId: 'DR-TOOL-TOKEN' },
    LATENCY: { predictedDelta: -0.8, ruleId: 'DR-TOOL-LATENCY' },
    REGRESSION: { predictedDelta: 0.1, ruleId: 'DR-TOOL-REGRESSION' },
  }),
  STRATEGY_REWRITE: Object.freeze({
    SUCCESS_RATE: { predictedDelta: 0.8, ruleId: 'DR-STRATEGY-SUCCESS' },
    TOKEN_EFFICIENCY: { predictedDelta: 0.5, ruleId: 'DR-STRATEGY-TOKEN' },
    LATENCY: { predictedDelta: 0.5, ruleId: 'DR-STRATEGY-LATENCY' },
    REGRESSION: { predictedDelta: 0.1, ruleId: 'DR-STRATEGY-REGRESSION' },
  }),
});

// ── §2.4.2 预测锁定：canonical 序列化 + sha256 ──────────────────────────

/** 锁摘要的算法前缀标识。 */
export const LOCK_ALGORITHM = 'sha256';

/**
 * 按 Unicode 码点比较两个字符串。
 * （默认 `Array#sort` 是 UTF-16 码元序，遇到代理对会排错位 —— 中文/emoji
 * 场景下会产出与预期不同的字节序，跨环境对拍时表现为「假篡改告警」。）
 */
function compareByCodePoint(a, b) {
  if (a === b) return 0;
  const A = Array.from(a);
  const B = Array.from(b);
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i].codePointAt(0);
    const y = B[i].codePointAt(0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return A.length - B.length;
}

function serializeString(s) {
  // JSON.stringify 的转义规则与 RFC 8259 一致，且默认不 \u 转义非 ASCII
  // —— 中文原样保留，跨环境一致。
  return JSON.stringify(s);
}

function serializeNumber(n) {
  // ⛔ 不静默吞掉非有限数：`JSON.stringify(NaN) === 'null'`，
  // 会让 NaN / Infinity 与真正的 null 撞出同一个摘要。防篡改场景下
  // 撞 hash = 漏检，宁可 fail-closed 抛错（对齐 Phase 0 canonical-json.mjs）。
  if (!Number.isFinite(n)) {
    throw new TypeError(
      `hypothesisLock: 非有限数字不能参与 hash（会得到与 null 相同的摘要）: ${String(n)}`,
    );
  }
  // -0 归一为 0，避免 -0 与 0 产出不同字节。
  return JSON.stringify(n === 0 ? 0 : n);
}

function serialize(value) {
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'undefined') return 'null'; // 数组槽位/裸值：与 JSON.stringify 对齐
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') return serializeNumber(value);
  if (t === 'string') return serializeString(value);
  if (t === 'bigint') {
    throw new TypeError('hypothesisLock: bigint 无 JSON 表示，请先显式转换为字符串');
  }
  if (t === 'function' || t === 'symbol') {
    throw new TypeError(`hypothesisLock: ${t} 不可序列化`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => serialize(v)).join(',')}]`;
  }
  // 对象 key 按码点字典序递归排序；undefined 值按 JSON 语义整个省略。
  const parts = [];
  for (const k of Object.keys(value).sort(compareByCodePoint)) {
    const v = value[k];
    if (v === undefined) continue;
    parts.push(`${serializeString(k)}:${serialize(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * 规范化 JSON（确定性序列化）。与 Phase 0 `bin/lib/canonical-json.mjs`
 * 的契约逐条一致：key 按 Unicode 码点排序、无空格、UTF-8、-0 归一、
 * 非有限数抛错。**插件侧不可 import bin/（不随 bundle 部署），故在此自实现。**
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalStringify(value) {
  return serialize(value);
}

/**
 * 计算 hypothesisLock。
 *
 *   hypothesisLock = sha256(canonical({ hypothesis, contractId, createdAt }))
 *
 * **纯函数**：不读时钟、不读存储、不发事件。`createdAt` 由调用方传入而非
 * 内部取 —— 内部取时钟会让「相同输入返回相同输出」这条契约失效，
 * 也让归档校验（重算比对）无法复现。
 *
 * 锁定的是**预测内容**而非整个 Contract：这样 outcome 回填（评估后写入）
 * 不会改变 lock，锁才真正只约束「预测不可事后编造」这一件事。
 *
 * @param {object} params
 * @param {object} params.hypothesis  Contract 的 hypothesis 段
 * @param {string} params.contractId  Contract ID
 * @param {string} params.createdAt   ISO 时间串（由调用方从 Contract 读取）
 * @returns {string} `sha256:<hex>`
 * @throws {TypeError} 非有限数字 / bigint / 函数等不可确定性序列化的输入
 */
export function computeHypothesisLock({ hypothesis, contractId, createdAt }) {
  if (hypothesis === null || typeof hypothesis !== 'object' || Array.isArray(hypothesis)) {
    throw new TypeError('computeHypothesisLock: hypothesis 必须是对象');
  }
  if (typeof contractId !== 'string' || contractId.length === 0) {
    throw new TypeError('computeHypothesisLock: contractId 必须是非空字符串');
  }
  if (typeof createdAt !== 'string' || createdAt.length === 0) {
    throw new TypeError('computeHypothesisLock: createdAt 必须是非空字符串');
  }
  const canonical = canonicalStringify({ hypothesis, contractId, createdAt });
  const hex = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `${LOCK_ALGORITHM}:${hex}`;
}

/**
 * 校验归档时重算的 lock 与锁定时记录的 lock 是否一致。
 *
 * 设计 §2.4.2 第 6 步：不匹配 → 标记 CONTRACT_TAMPERED，该 Contract
 * **不计入任何统计**。本函数只做**判定**，不做任何修复
 * —— 修复意味着重写历史，会让防篡改机制失效（靠谱 > 聪明）。
 *
 * @param {object} params
 * @param {string} params.storedLock   contract_locks 表中记录的 lock
 * @param {object} params.hypothesis   归档时的 hypothesis 段
 * @param {string} params.contractId
 * @param {string} params.createdAt
 * @returns {{ ok: boolean, recomputed: string, reason: string|null }}
 */
export function verifyHypothesisLock({ storedLock, hypothesis, contractId, createdAt }) {
  if (typeof storedLock !== 'string' || storedLock.length === 0) {
    // 无记录 ≠ 通过。锁定缺失本身就是异常，判红让调用方显式面对。
    return { ok: false, recomputed: null, reason: 'LOCK_MISSING' };
  }
  const recomputed = computeHypothesisLock({ hypothesis, contractId, createdAt });
  return {
    ok: recomputed === storedLock,
    recomputed,
    reason: recomputed === storedLock ? null : 'CONTRACT_TAMPERED',
  };
}

// ── §2.4.1 三级预测生成 ────────────────────────────────────────────────

/**
 * L3：知识库先验。
 *
 * 准入条件（全部满足才可用）：
 *   1. 存在该 `${mutationType}::${targetMetric}` 桶
 *   2. 桶的 `confidence === 'STABLE'`（即 sampleSize ≥ 10）—— 冷启动纪律
 *   3. `medianActualDelta` 有限（非 null）
 *
 * 输出：predicted = 桶的历史中位实际变化；confidence = **收敛度**
 * `1 / (1 + IQR/τ_metric)`。
 *
 * ⛔ 置信度公式的选型（2026-10-02 实现时推翻过一版）：
 * 初版用线性 `1 - IQR/max(|median|,1)`，实测两个缺陷 ——
 *   ① `IQR > |median|` 时（波动比信号还大）置信度**直接归零**，
 *      而该桶 sampleSize ≥ 10 已是 STABLE，不该被判成「毫无信心」；
 *      且所有 `IQR ≥ |median|` 的桶**全部塌成 0**，桶之间失去区分度。
 *   ② `IQR = |median|`（spread 恰为 1）与 `IQR > |median|` 都给 0，
 *      同一桶「差一点」与「差很远」两种写法产出相同置信度。
 * 现用 `1/(1+ IQR/τ)`：以 τ_metric（本设计自己的「有意义差异」尺度）
 * 为参照，有界 (0,1]、单调递减、无悬崖 —— IQR=τ 时恰为 0.5（半数），
 * IQR 远大于 τ 时趋近 0 但恒为正，桶之间始终保持区分度。
 *
 * @param {object|null} bucket knowledge_buckets 表的 value
 * @param {object} [opts]
 * @param {number|null} [opts.tau] 该指标的 τ_metric（缺省用内置表）
 * @returns {{ ok: boolean, predictedDelta: number|null, confidence: number, reason: string|null, basis: object }}
 */
export function predictFromKnowledgeBase(bucket, opts = {}) {
  if (!bucket || typeof bucket !== 'object') {
    return { ok: false, predictedDelta: null, confidence: 0, reason: 'BUCKET_ABSENT', basis: {} };
  }
  if (bucket.confidence !== 'STABLE') {
    // ⛔ 冷启动纪律：CALIBRATING / PROVISIONAL 桶一律不生成先验。
    return {
      ok: false,
      predictedDelta: null,
      confidence: 0,
      reason: `BUCKET_NOT_STABLE:${bucket.confidence ?? 'UNKNOWN'}`,
      basis: { bucketKey: bucket.bucketKey ?? null, sampleSize: bucket.sampleSize ?? 0 },
    };
  }
  const predicted = bucket.medianActualDelta;
  if (!Number.isFinite(predicted)) {
    return {
      ok: false,
      predictedDelta: null,
      confidence: 0,
      reason: 'BUCKET_NO_MEDIAN',
      basis: { bucketKey: bucket.bucketKey ?? null, sampleSize: bucket.sampleSize ?? 0 },
    };
  }
  const iqr = Number.isFinite(bucket.iqrActualDelta) ? Math.abs(bucket.iqrActualDelta) : null;
  const confidence = knowledgeBaseConfidence(iqr, opts.tau);
  return {
    ok: true,
    predictedDelta: predicted,
    confidence,
    reason: null,
    basis: {
      bucketKey: bucket.bucketKey ?? null,
      sampleSize: bucket.sampleSize ?? 0,
      iqrActualDelta: iqr,
    },
  };
}

/**
 * 知识桶收敛度：`1 / (1 + IQR/τ)`，取值 (0, 1]。
 *
 * - `IQR = 0` ⇒ 1.0（历史完全一致，最自信）
 * - `IQR = τ` ⇒ 0.5（波动恰好等于一个「有意义差异」的尺度）
 * - `IQR → ∞` ⇒ 趋近 0 但**恒为正**（桶之间始终保持区分度）
 *
 * τ 未知（二值指标 / 未登记指标）时返回 `null` —— 由调用方决定是否降级，
 * 不在这里猜一个数（`prediction-scoring.js` 的 `tauFor` 是同一张表的权威副本，
 * 此处按值传入以免插件内两个模块互相 import 造成循环依赖）。
 *
 * @param {number|null} iqr
 * @param {number|null} [tau]
 * @returns {number|null}
 */
export function knowledgeBaseConfidence(iqr, tau) {
  if (!Number.isFinite(iqr) || !Number.isFinite(tau) || tau <= 0) return null;
  return 1 / (1 + iqr / tau);
}

/**
 * 计算两组 changedComponents 的重叠度（Jaccard 相似度）。
 *
 * 组件标识取 `pluginName`（Phase 0 contract schema 的 required 字段）。
 * 两侧都为空 ⇒ 返回 0（**不能返回 1**：「与空集完全重叠」不是「完全相似」，
 * 返回 1 会让无信息的预测拿到满分相似度）。
 *
 * @param {Array<{pluginName?: string}>} a
 * @param {Array<{pluginName?: string}>} b
 * @returns {number} [0, 1]
 */
export function componentOverlap(a, b) {
  const sa = new Set((Array.isArray(a) ? a : []).map((x) => x?.pluginName).filter(Boolean));
  const sb = new Set((Array.isArray(b) ? b : []).map((x) => x?.pluginName).filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * L2：类比推断。
 *
 * 准入条件：存在至少 1 条与本次 `changedComponents` 重叠度 ≥ 0.5 的历史
 * Contract，且其 `actualDelta` 有限。
 *
 * 输出：predicted = 相似 Contract 的 actualDelta **按相似度加权平均**；
 * confidence = 最高相似度 × 样本量修正（相似历史越多越可信，但设上界，
 * 防止「100 条弱相似」压过「1 条强相似」——后者信息量更大）。
 *
 * @param {object} params
 * @param {Array<{pluginName?: string}>} params.changedComponents 本次改动
 * @param {Array<{contractId?: string, changedComponents?: Array, actualDelta?: number}>} params.history
 * @returns {{ ok: boolean, predictedDelta: number|null, confidence: number, reason: string|null, basis: object }}
 */
export function predictFromAnalogy({ changedComponents, history }) {
  const list = Array.isArray(history) ? history : [];
  const scored = [];
  for (const h of list) {
    if (!Number.isFinite(h?.actualDelta)) continue; // 缺实际值的记录不作类比依据
    const overlap = componentOverlap(changedComponents, h?.changedComponents);
    if (overlap < ANALOGY_OVERLAP_THRESHOLD) continue;
    scored.push({ contractId: h.contractId ?? null, actualDelta: h.actualDelta, overlap });
  }
  if (scored.length === 0) {
    return {
      ok: false,
      predictedDelta: null,
      confidence: 0,
      reason: 'NO_ANALOGOUS_HISTORY',
      basis: { considered: list.length, matched: 0, threshold: ANALOGY_OVERLAP_THRESHOLD },
    };
  }
  const totalWeight = scored.reduce((s, r) => s + r.overlap, 0);
  const predicted = scored.reduce((s, r) => s + r.actualDelta * r.overlap, 0) / totalWeight;
  const bestOverlap = Math.max(...scored.map((r) => r.overlap));
  // 样本量修正：sqrt(n)/(1+sqrt(n)) 递增趋近 1，单调且永不超过 1。
  const nFactor = Math.sqrt(scored.length) / (1 + Math.sqrt(scored.length));
  return {
    ok: true,
    predictedDelta: predicted,
    confidence: bestOverlap * nFactor,
    reason: null,
    basis: {
      matched: scored.length,
      threshold: ANALOGY_OVERLAP_THRESHOLD,
      bestOverlap,
      analogousContracts: scored.map((r) => r.contractId).filter(Boolean),
    },
  };
}

/**
 * L1：规则缺省（冷启动期唯一可用来源）。
 *
 * 准入条件：规则表里存在 `${mutationType}::${targetMetric}` 条目。
 * 缺失 ⇒ **不编造**（返回 ok:false，让调用方标 NO_EVIDENCE）。
 *
 * confidence 固定 0.2（设计 §2.4.1 明文），且 basis 里显式带
 * `isDefaultEstimate: true` —— 防止下游把它当「系统预测能力」宣传。
 *
 * @param {object} params
 * @param {string} params.mutationType
 * @param {string} params.targetMetric
 * @param {object} [params.table] 注入自定义规则表（测试用；缺省用内置表）
 * @returns {{ ok: boolean, predictedDelta: number|null, confidence: number, reason: string|null, basis: object }}
 */
export function predictFromDefaultRule({ mutationType, targetMetric, table }) {
  const t = table || DEFAULT_RULE_TABLE;
  const entry = t?.[mutationType]?.[targetMetric];
  if (!entry || !Number.isFinite(entry.predictedDelta)) {
    return {
      ok: false,
      predictedDelta: null,
      confidence: 0,
      reason: 'NO_DEFAULT_RULE',
      basis: { mutationType: mutationType ?? null, targetMetric: targetMetric ?? null },
    };
  }
  return {
    ok: true,
    predictedDelta: entry.predictedDelta,
    confidence: DEFAULT_RULE_CONFIDENCE,
    reason: null,
    basis: {
      defaultRuleId: entry.ruleId,
      isDefaultEstimate: true,
      caution: '缺省估计，非推断（设计 §2.4.1）',
    },
  };
}

/**
 * 生成预测：按 L3 → L2 → L1 依次尝试，首个可用者胜出。
 *
 * **降级是单向的**：任一级不可用或置信度不足就降到下一级，绝不反向跳级。
 * 每级失败的原因都记进 `attempts` 数组 —— 报告需要知道「为什么落到 L1」，
 * 否则 Level 1 的缺省值会被误读成「系统预测能力」（真实 > 讨好）。
 *
 * @param {object} params
 * @param {string} params.mutationType
 * @param {string} params.targetMetric
 * @param {object|null} [params.bucket]         knowledge_buckets 桶值
 * @param {Array} [params.history]               历史 Contract 记录
 * @param {Array<{pluginName?: string}>} [params.changedComponents]
 * @param {object} [params.defaultRuleTable]     注入规则表（测试用）
 * @param {number} [params.tau]                  该指标的 τ_metric（供 L3 收敛度计算）
 * @param {number} [params.minConfidence]        置信度**严格小于**此值则降级（缺省 0 = 不额外设门）
 * @returns {object} 预测结果（含 predictionSource / predictionBasis）
 */
export function generatePrediction({
  mutationType,
  targetMetric,
  bucket = null,
  history = [],
  changedComponents = [],
  defaultRuleTable,
  tau = null,
  minConfidence = 0,
}) {
  const attempts = [];
  const gate = Number.isFinite(minConfidence) ? minConfidence : 0;

  const tryLevel = (source, fn, opts = {}) => {
    const r = fn();
    const entry = {
      source,
      ok: r.ok,
      reason: r.reason,
      confidence: r.confidence,
    };
    if (r.ok && opts.skipGate) {
      // 该级豁免置信度门（仅 Level 1）—— 门限只用来在前两级之间做取舍，
      // 不得掐断最后的兜底。
      entry.gateExempt = true;
      attempts.push(entry);
      return {
        predictedDelta: r.predictedDelta,
        confidence: r.confidence,
        predictionSource: source,
        predictionBasis: r.basis,
      };
    }
    attempts.push(entry);
    if (!r.ok) return null;
    // ⚠️ 严格小于才降级：`confidence < gate`。用 `<=` 会让「恰好等于门限」
    // 的预测被降级，而边界等号本身没有业务含义（0.5 既是"半数"也是常见取值），
    // 判红还是判绿取决于浮点末位 ⇒ 不可复现。
    if (r.confidence < gate) {
      attempts[attempts.length - 1].downgradedByConfidence = true;
      return null;
    }
    return {
      predictedDelta: r.predictedDelta,
      confidence: r.confidence,
      predictionSource: source,
      predictionBasis: r.basis,
    };
  };

  const l3 = tryLevel(PREDICTION_SOURCES.KNOWLEDGE_BASE, () =>
    predictFromKnowledgeBase(bucket, { tau: tau ?? tauForMetric(targetMetric) }));
  if (l3) return { ...l3, fallbackFrom: null, attempts };

  const l2 = tryLevel(PREDICTION_SOURCES.ANALOGY, () =>
    predictFromAnalogy({ changedComponents, history }));
  if (l2) return { ...l2, fallbackFrom: PREDICTION_SOURCES.KNOWLEDGE_BASE, attempts };

  // ⚠️ **Level 1 不受 minConfidence 门约束**（这是本模块的核心保证）。
  // L1 的 confidence 恒为 0.2（设计 §2.4.1 明文），若把它也套进门限，
  // 任何 `minConfidence > 0.2` 的调用方都会把最后的兜底也拒掉 ⇒
  // 返回 null ⇒ 既没有 L2 也没有 L1，等于「无预测可用」。
  // 那不是「置信度不足所以不预测」，而是**置信度门把降级链掐断了** ——
  // 降级链存在的意义恰恰是提供兜底。
  // 置信度低不是问题，**没有置信度**才是；L1 诚实地标注自己
  // `isDefaultEstimate: true` + `predictionSource: "DEFAULT_RULE"`，
  // 让下游能识别「这是缺省估计」并按需人工复核（设计 §2.4.1 的原意）。
  const l1 = tryLevel(PREDICTION_SOURCES.DEFAULT_RULE, () =>
    predictFromDefaultRule({ mutationType, targetMetric, table: defaultRuleTable }), { skipGate: true });
  if (l1) return { ...l1, fallbackFrom: PREDICTION_SOURCES.ANALOGY, attempts };

  // ⛔ 连 Level 1 都无可用条目 ⇒ 不编造。返回 null 让调用方标 NO_EVIDENCE，
  // 绝不用 0 或任何兜底数字冒充预测（经验教训 §3.1）。
  return {
    predictedDelta: null,
    confidence: 0,
    predictionSource: null,
    predictionBasis: null,
    fallbackFrom: null,
    attempts,
    reason: 'NO_PREDICTION_AVAILABLE',
  };
}
