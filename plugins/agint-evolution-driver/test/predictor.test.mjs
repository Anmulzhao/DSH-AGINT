/**
 * predictor 测试（Phase 1 交付物 1 §2.4 / Sprint 21 模块 2）。
 *
 * 覆盖：三级预测来源（判定条件 / 优先级 / 降级规则）+ hypothesisLock
 * （纯函数性 + 已锁定 / 冲突 / 无匹配三类边界）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREDICTION_SOURCES,
  SOURCE_PRIORITY,
  DEFAULT_RULE_CONFIDENCE,
  STABLE_SAMPLE_THRESHOLD,
  ANALOGY_OVERLAP_THRESHOLD,
  DEFAULT_RULE_TABLE,
  canonicalStringify,
  computeHypothesisLock,
  verifyHypothesisLock,
  knowledgeBaseConfidence,
  predictFromKnowledgeBase,
  predictFromAnalogy,
  predictFromDefaultRule,
  componentOverlap,
  generatePrediction,
  LOCK_ALGORITHM,
} from '../lib/predictor.js';

const SR = 'SUCCESS_RATE';
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

const STABLE_BUCKET = {
  bucketKey: 'PROMPT_MUTATION::SUCCESS_RATE',
  confidence: 'STABLE',
  sampleSize: 23,
  medianActualDelta: 2.8,
  iqrActualDelta: 1.4,
};
const ONE_HISTORY = [{
  contractId: 'EVO-2026-001',
  changedComponents: [{ pluginName: 'agint-memory' }],
  actualDelta: 4,
}];

// ─────────────────────────────────────────────────────────────────────
// 三级来源：优先级与常量
// ─────────────────────────────────────────────────────────────────────

test('来源优先级：L3 → L2 → L1 单向排列，Level 1 兜底恒在末位', () => {
  assert.deepEqual([...SOURCE_PRIORITY], ['KNOWLEDGE_BASE', 'ANALOGY', 'DEFAULT_RULE']);
  assert.equal(SOURCE_PRIORITY[0], PREDICTION_SOURCES.KNOWLEDGE_BASE);
  assert.equal(SOURCE_PRIORITY[SOURCE_PRIORITY.length - 1], PREDICTION_SOURCES.DEFAULT_RULE);
});

test('常量与设计 §2.4.1 / §2.3.4 一致', () => {
  assert.equal(DEFAULT_RULE_CONFIDENCE, 0.2, '设计明文固定 0.2');
  assert.equal(STABLE_SAMPLE_THRESHOLD, 10);
  assert.equal(ANALOGY_OVERLAP_THRESHOLD, 0.5);
  assert.equal(LOCK_ALGORITHM, 'sha256');
});

test('Level 1 规则表覆盖 3 个 mutationType × 4 指标且条目非空', () => {
  const kinds = Object.keys(DEFAULT_RULE_TABLE);
  assert.deepEqual(kinds, ['PROMPT_MUTATION', 'TOOL_SYNTHESIS', 'STRATEGY_REWRITE']);
  for (const k of kinds) {
    for (const [metric, e] of Object.entries(DEFAULT_RULE_TABLE[k])) {
      assert.ok(Number.isFinite(e.predictedDelta), `${k}::${metric} 缺省值非有限`);
      assert.ok(typeof e.ruleId === 'string' && e.ruleId.length > 0, `${k}::${metric} 缺 ruleId`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────
// L3 知识库先验
// ─────────────────────────────────────────────────────────────────────

test('L3: STABLE 桶可用，输出桶的中位实际变化', () => {
  const r = predictFromKnowledgeBase(STABLE_BUCKET, { tau: 3.0 });
  assert.equal(r.ok, true);
  assert.equal(r.predictedDelta, 2.8);
  assert.equal(r.basis.bucketKey, 'PROMPT_MUTATION::SUCCESS_RATE');
  assert.equal(r.basis.sampleSize, 23);
});

test('L3: ⛔ 冷启动纪律 —— 非 STABLE 桶一律不生成先验', () => {
  for (const conf of ['CALIBRATING', 'PROVISIONAL', undefined, 'GARBAGE']) {
    const r = predictFromKnowledgeBase({ ...STABLE_BUCKET, confidence: conf }, { tau: 3.0 });
    assert.equal(r.ok, false, `${conf} 桶不应可用`);
    assert.equal(r.predictedDelta, null, `${conf} 桶不得输出预测值`);
    assert.match(r.reason, /^BUCKET_NOT_STABLE/);
  }
});

test('L3: 桶缺失 / 中位值非有限 ⇒ 不可用（不编造）', () => {
  assert.equal(predictFromKnowledgeBase(null).reason, 'BUCKET_ABSENT');
  assert.equal(predictFromKnowledgeBase(undefined).reason, 'BUCKET_ABSENT');
  const noMedian = predictFromKnowledgeBase({ ...STABLE_BUCKET, medianActualDelta: null }, { tau: 3 });
  assert.equal(noMedian.ok, false);
  assert.equal(noMedian.reason, 'BUCKET_NO_MEDIAN');
});

test('L3 收敛度：IQR 越大越不自信，单调且恒为正（无悬崖）', () => {
  const tau = 3.0;
  assert.equal(knowledgeBaseConfidence(0, tau), 1, '完全一致 ⇒ 1');
  near(knowledgeBaseConfidence(tau, tau), 0.5, 1e-12, 'IQR=τ ⇒ 恰好半数');
  const seq = [0, 0.5, 1, 2, 3, 5, 10, 100].map((iqr) => knowledgeBaseConfidence(iqr, tau));
  for (let i = 1; i < seq.length; i++) {
    assert.ok(seq[i] < seq[i - 1], `IQR 增大时置信度必须下降（第 ${i} 个）`);
    assert.ok(seq[i] > 0, '置信度恒为正，桶之间始终保持区分度');
  }
});

test('L3 收敛度：τ 或 IQR 不可用时返回 null（不猜数）', () => {
  assert.equal(knowledgeBaseConfidence(1, null), null);
  assert.equal(knowledgeBaseConfidence(1, 0), null);
  assert.equal(knowledgeBaseConfidence(NaN, 3), null);
});

test('L3 收敛度：IQR 远大于中位数时仍保持正置信度（初版线性公式会归零，已修）', () => {
  // median=2.8, IQR=3.4 ⇒ IQR > |median|，旧公式 1-IQR/median 会 clamp 到 0
  const r = predictFromKnowledgeBase(STABLE_BUCKET, { tau: 3.0 });
  assert.ok(r.confidence > 0, 'STABLE 桶不该被判成毫无信心');
  const wide = predictFromKnowledgeBase(
    { ...STABLE_BUCKET, medianActualDelta: 0.5, iqrActualDelta: 40 },
    { tau: 3.0 },
  );
  assert.ok(wide.confidence > 0 && wide.confidence < 0.2, `极散桶应低但非零，实际 ${wide.confidence}`);
});

// ─────────────────────────────────────────────────────────────────────
// L2 类比推断
// ─────────────────────────────────────────────────────────────────────

test('componentOverlap: Jaccard 相似度，两侧皆空必须为 0（不是 1）', () => {
  assert.equal(componentOverlap([], []), 0);
  assert.equal(componentOverlap([{ pluginName: 'a' }], []), 0);
  assert.equal(componentOverlap([], [{ pluginName: 'a' }]), 0);
  assert.equal(componentOverlap([{ pluginName: 'a' }], [{ pluginName: 'a' }]), 1);
  assert.equal(componentOverlap([{ pluginName: 'a' }], [{ pluginName: 'b' }]), 0);
  near(componentOverlap([{ pluginName: 'a' }], [{ pluginName: 'a' }, { pluginName: 'b' }]), 0.5);
  // 多个组件取并集
  near(componentOverlap(
    [{ pluginName: 'a' }, { pluginName: 'b' }],
    [{ pluginName: 'a' }, { pluginName: 'b' }, { pluginName: 'c' }],
  ), 2 / 3);
});

test('componentOverlap: 非法输入不抛错，返回 0（降级而非崩）', () => {
  assert.equal(componentOverlap(null, [{ pluginName: 'a' }]), 0);
  assert.equal(componentOverlap(undefined, undefined), 0);
  assert.equal(componentOverlap([{}], [{ pluginName: 'a' }]), 0, '缺 pluginName 视为无交集');
});

test('L2: 重叠度 ≥0.5 的历史参与加权平均', () => {
  const r = predictFromAnalogy({
    changedComponents: [{ pluginName: 'agint-memory' }],
    history: [
      { contractId: 'E1', changedComponents: [{ pluginName: 'agint-memory' }], actualDelta: 4 },
      { contractId: 'E2', changedComponents: [{ pluginName: 'agint-memory' }, { pluginName: 'p2' }], actualDelta: 6 },
    ],
  });
  assert.equal(r.ok, true);
  // overlap: E1=1, E2=0.5 ⇒ (4*1 + 6*0.5)/1.5 = 4.667
  near(r.predictedDelta, 4.666666666666667, 1e-9);
  assert.deepEqual(r.basis.analogousContracts, ['E1', 'E2']);
  assert.equal(r.basis.matched, 2);
});

test('L2: 全部历史重叠度不足 ⇒ 不可用', () => {
  const r = predictFromAnalogy({
    changedComponents: [{ pluginName: 'agint-memory' }],
    history: [{ contractId: 'E1', changedComponents: [{ pluginName: 'other' }], actualDelta: 4 }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NO_ANALOGOUS_HISTORY');
  assert.equal(r.predictedDelta, null);
});

test('L2: 缺 actualDelta / 非有限的记录不参与（无实测值不能当先验）', () => {
  const r = predictFromAnalogy({
    changedComponents: [{ pluginName: 'a' }],
    history: [
      { contractId: 'E1', changedComponents: [{ pluginName: 'a' }] },
      { contractId: 'E2', changedComponents: [{ pluginName: 'a' }], actualDelta: null },
      { contractId: 'E3', changedComponents: [{ pluginName: 'a' }], actualDelta: NaN },
    ],
  });
  assert.equal(r.ok, false);
  assert.equal(r.basis.considered, 3);
  assert.equal(r.basis.matched, 0);
});

test('L2: 样本量修正单调递增且不超过 1', () => {
  const conf = (n) => {
    const history = Array.from({ length: n }, (_, i) => ({
      contractId: `E${i}`,
      changedComponents: [{ pluginName: 'a' }],
      actualDelta: 1,
    }));
    return predictFromAnalogy({ changedComponents: [{ pluginName: 'a' }], history }).confidence;
  };
  const seq = [1, 2, 5, 10, 50].map(conf);
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] > seq[i - 1], '样本越多越自信');
  for (const c of seq) assert.ok(c > 0 && c <= 1, `置信度须在 (0,1]，实际 ${c}`);
});

test('L2: bestOverlap 恒不超过 1（1 条强相似不被样本量因子压垮）', () => {
  const history = Array.from({ length: 50 }, (_, i) => ({
    contractId: `E${i}`,
    changedComponents: [{ pluginName: 'a' }],
    actualDelta: 1,
  }));
  const r = predictFromAnalogy({ changedComponents: [{ pluginName: 'a' }], history });
  assert.ok(r.confidence <= 1);
  near(r.basis.bestOverlap, 1);
});

// ─────────────────────────────────────────────────────────────────────
// L1 规则缺省
// ─────────────────────────────────────────────────────────────────────

test('L1: 命中规则返回缺省值 + 固定 0.2 置信度 + 显式标注「非推断」', () => {
  const r = predictFromDefaultRule({ mutationType: 'PROMPT_MUTATION', targetMetric: SR });
  assert.equal(r.ok, true);
  assert.equal(r.predictedDelta, 1.0);
  assert.equal(r.confidence, DEFAULT_RULE_CONFIDENCE);
  assert.equal(r.basis.isDefaultEstimate, true);
  assert.equal(r.basis.defaultRuleId, 'DR-PROMPT-SUCCESS');
  assert.match(r.basis.caution, /缺省估计，非推断/);
});

test('L1: 规则表无对应条目 ⇒ 不可用（不用 0 或任何数字兜底）', () => {
  const r = predictFromDefaultRule({ mutationType: 'NO_SUCH_KIND', targetMetric: SR });
  assert.equal(r.ok, false);
  assert.equal(r.predictedDelta, null);
  assert.equal(r.reason, 'NO_DEFAULT_RULE');
  const badMetric = predictFromDefaultRule({ mutationType: 'PROMPT_MUTATION', targetMetric: 'NOPE' });
  assert.equal(badMetric.ok, false);
});

test('L1: 缺省值取小值（生产实证 AUTO_DEPLOY 仅 23.3%，宁可低估不可高估）', () => {
  for (const [kind, metrics] of Object.entries(DEFAULT_RULE_TABLE)) {
    for (const [metric, e] of Object.entries(metrics)) {
      assert.ok(
        Math.abs(e.predictedDelta) <= 2.0,
        `${kind}::${metric} 缺省值 ${e.predictedDelta} 偏激进，与生产 23.3% 自动部署率不符`,
      );
    }
  }
});

// ─────────────────────────────────────────────────────────────────────
// generatePrediction：优先级与降级链
// ─────────────────────────────────────────────────────────────────────

test('L3 可用时不触发降级', () => {
  const r = generatePrediction({
    mutationType: 'PROMPT_MUTATION',
    targetMetric: SR,
    bucket: STABLE_BUCKET,
    history: ONE_HISTORY,
    changedComponents: [{ pluginName: 'agint-memory' }],
  });
  assert.equal(r.predictionSource, PREDICTION_SOURCES.KNOWLEDGE_BASE);
  assert.equal(r.fallbackFrom, null);
  assert.equal(r.attempts.length, 1, '命中即停，不应继续尝试低级来源');
});

test('L3 不可用 ⇒ 降 L2，fallbackFrom 记录降级起点', () => {
  const r = generatePrediction({
    mutationType: 'PROMPT_MUTATION',
    targetMetric: SR,
    bucket: { ...STABLE_BUCKET, confidence: 'CALIBRATING' },
    history: ONE_HISTORY,
    changedComponents: [{ pluginName: 'agint-memory' }],
  });
  assert.equal(r.predictionSource, PREDICTION_SOURCES.ANALOGY);
  assert.equal(r.fallbackFrom, PREDICTION_SOURCES.KNOWLEDGE_BASE);
  assert.equal(r.attempts[0].reason, 'BUCKET_NOT_STABLE:CALIBRATING');
});

test('L2/L3 均不可用 ⇒ 降 L1', () => {
  const r = generatePrediction({ mutationType: 'TOOL_SYNTHESIS', targetMetric: 'LATENCY' });
  assert.equal(r.predictionSource, PREDICTION_SOURCES.DEFAULT_RULE);
  assert.equal(r.fallbackFrom, PREDICTION_SOURCES.ANALOGY);
  assert.equal(r.confidence, DEFAULT_RULE_CONFIDENCE);
});

test('三级全不可用 ⇒ 返回 null + NO_PREDICTION_AVAILABLE（不编造）', () => {
  const r = generatePrediction({ mutationType: 'UNKNOWN_KIND', targetMetric: SR });
  assert.equal(r.predictedDelta, null);
  assert.equal(r.predictionSource, null);
  assert.equal(r.reason, 'NO_PREDICTION_AVAILABLE');
  assert.equal(r.attempts.length, 3, '三级都要尝试过并记录原因');
});

test('冷启动纪律端到端：CALIBRATING 桶里的值绝不进入预测', () => {
  const r = generatePrediction({
    mutationType: 'PROMPT_MUTATION',
    targetMetric: SR,
    bucket: { ...STABLE_BUCKET, confidence: 'CALIBRATING', sampleSize: 3, medianActualDelta: 99 },
  });
  assert.notEqual(r.predictedDelta, 99, '不得使用未达标的桶');
  assert.equal(r.predictionSource, PREDICTION_SOURCES.DEFAULT_RULE);
});

test('minConfidence：置信度不足则继续降级，且边界可复现（恰等则保留）', () => {
  const args = {
    mutationType: 'PROMPT_MUTATION',
    targetMetric: SR,
    history: ONE_HISTORY,
    changedComponents: [{ pluginName: 'agint-memory' }],
  };
  near(predictFromAnalogy({ changedComponents: args.changedComponents, history: ONE_HISTORY }).confidence, 0.5, 1e-12);
  assert.equal(generatePrediction({ ...args, minConfidence: 0.4 }).predictionSource, PREDICTION_SOURCES.ANALOGY);
  assert.equal(generatePrediction({ ...args, minConfidence: 0.5 }).predictionSource, PREDICTION_SOURCES.ANALOGY, '恰等则保留');
  assert.equal(generatePrediction({ ...args, minConfidence: 0.5001 }).predictionSource, PREDICTION_SOURCES.DEFAULT_RULE);
  assert.ok(generatePrediction({ ...args, minConfidence: 0.5001 }).attempts[1].downgradedByConfidence);
});

test('⛔ minConfidence 不得掐断 Level 1 兜底（gate 高于 0.2 仍要出预测）', () => {
  for (const gate of [0.6, 0.9, 1.0]) {
    const r = generatePrediction({ mutationType: 'PROMPT_MUTATION', targetMetric: SR, minConfidence: gate });
    assert.equal(r.predictionSource, PREDICTION_SOURCES.DEFAULT_RULE,
      `gate=${gate} 时 L1 被门限拒绝 ⇒ 降级链被掐断`);
    assert.equal(r.attempts[2].gateExempt, true);
    assert.equal(r.predictionBasis.isDefaultEstimate, true, '兜底仍须标注为缺省估计');
  }
});

test('降级方向是单向的：attempts 顺序恒为 L3→L2→L1', () => {
  const r = generatePrediction({ mutationType: 'PROMPT_MUTATION', targetMetric: SR });
  assert.deepEqual(r.attempts.map((a) => a.source), [...SOURCE_PRIORITY]);
});

test('降级链可解释：每一级的失败原因都被记录', () => {
  const r = generatePrediction({ mutationType: 'PROMPT_MUTATION', targetMetric: SR });
  assert.equal(r.attempts[0].reason, 'BUCKET_ABSENT');
  assert.equal(r.attempts[1].reason, 'NO_ANALOGOUS_HISTORY');
  assert.equal(r.attempts[2].ok, true);
});

// ─────────────────────────────────────────────────────────────────────
// hypothesisLock：纯函数性
// ─────────────────────────────────────────────────────────────────────

const H = {
  predictedDelta: 4.0,
  targetMetric: SR,
  changedComponents: [{ pluginName: 'agint-memory', filesChanged: ['a.js'], changeType: 'MODIFY' }],
};
const BASE = { hypothesis: H, contractId: 'EVO-2026-001', createdAt: '2026-10-02T04:15:00Z' };

test('computeHypothesisLock: 格式为 sha256:<64 hex>', () => {
  const lock = computeHypothesisLock(BASE);
  assert.match(lock, /^sha256:[0-9a-f]{64}$/);
});

test('computeHypothesisLock: ⛔ 纯函数性 —— 重复调用结果恒等', () => {
  const a = computeHypothesisLock(BASE);
  const b = computeHypothesisLock(BASE);
  const c = computeHypothesisLock({ hypothesis: { ...H }, contractId: 'EVO-2026-001', createdAt: '2026-10-02T04:15:00Z' });
  assert.equal(a, b);
  assert.equal(a, c, '深拷贝等价的输入必须同 lock');
});

test('computeHypothesisLock: key 书写顺序不影响结果（canonical 排序生效）', () => {
  const reordered = {
    changedComponents: [{ changeType: 'MODIFY', filesChanged: ['a.js'], pluginName: 'agint-memory' }],
    targetMetric: SR,
    predictedDelta: 4.0,
  };
  assert.equal(computeHypothesisLock({ ...BASE, hypothesis: reordered }), computeHypothesisLock(BASE));
});

test('computeHypothesisLock: 预测内容 / contractId / createdAt 任一变化 ⇒ lock 变化', () => {
  const lock = computeHypothesisLock(BASE);
  assert.notEqual(computeHypothesisLock({ ...BASE, hypothesis: { ...H, predictedDelta: 4.1 } }), lock, '改预测值');
  assert.notEqual(computeHypothesisLock({ ...BASE, contractId: 'EVO-2026-002' }), lock, '换 Contract');
  assert.notEqual(computeHypothesisLock({ ...BASE, createdAt: '2026-10-03T04:15:00Z' }), lock, '换时间');
  assert.notEqual(
    computeHypothesisLock({ ...BASE, hypothesis: { ...H, changedComponents: [{ pluginName: 'agint-dream', filesChanged: ['a.js'], changeType: 'MODIFY' }] } }),
    lock,
    '换改动组件',
  );
});

test('⛔ createdAt 参与摘要：同一 hypothesis 换 Contract 必须不同 lock（防复制旧预测）', () => {
  const h = { predictedDelta: 3.0, targetMetric: SR };
  const a = computeHypothesisLock({ hypothesis: h, contractId: 'EVO-001', createdAt: 'T1' });
  const b = computeHypothesisLock({ hypothesis: h, contractId: 'EVO-002', createdAt: 'T1' });
  assert.notEqual(a, b);
});

// ─────────────────────────────────────────────────────────────────────
// hypothesisLock：已锁定 / 冲突 / 无匹配
// ─────────────────────────────────────────────────────────────────────

test('已锁定且未被篡改 ⇒ ok:true, reason:null', () => {
  const lock = computeHypothesisLock(BASE);
  const r = verifyHypothesisLock({ storedLock: lock, ...BASE });
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
  assert.equal(r.recomputed, lock);
});

test('冲突（预测被事后改写）⇒ ok:false + CONTRACT_TAMPERED', () => {
  const lock = computeHypothesisLock(BASE);
  const r = verifyHypothesisLock({ storedLock: lock, ...BASE, hypothesis: { ...H, predictedDelta: 99 } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'CONTRACT_TAMPERED');
  assert.notEqual(r.recomputed, lock);
});

test('冲突：contractId / createdAt 被改也算篡改', () => {
  const lock = computeHypothesisLock(BASE);
  assert.equal(verifyHypothesisLock({ storedLock: lock, ...BASE, contractId: 'EVO-OTHER' }).reason, 'CONTRACT_TAMPERED');
  assert.equal(verifyHypothesisLock({ storedLock: lock, ...BASE, createdAt: '2026-01-01T00:00:00Z' }).reason, 'CONTRACT_TAMPERED');
});

test('无匹配（无 lock 记录）⇒ ok:false + LOCK_MISSING（缺失≠通过）', () => {
  for (const stored of [null, undefined, '', 0, false]) {
    const r = verifyHypothesisLock({ storedLock: stored, ...BASE });
    assert.equal(r.ok, false, `storedLock=${String(stored)} 不得判通过`);
    assert.equal(r.reason, 'LOCK_MISSING');
    assert.equal(r.recomputed, null);
  }
});

test('verifyHypothesisLock: 篡改场景下仍返回重算值供人工取证', () => {
  const lock = computeHypothesisLock(BASE);
  const r = verifyHypothesisLock({ storedLock: lock, ...BASE, hypothesis: { ...H, predictedDelta: 0 } });
  assert.match(r.recomputed, /^sha256:/);
});

// ─────────────────────────────────────────────────────────────────────
// canonical 序列化与 fail-closed
// ─────────────────────────────────────────────────────────────────────

test('canonicalStringify: key 按码点排序、无空格', () => {
  assert.equal(canonicalStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalStringify({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}');
  assert.equal(canonicalStringify([1, 2]), '[1,2]');
  assert.equal(canonicalStringify({}), '{}');
});

test('canonicalStringify: 中文与 emoji 原样保留（跨环境一致）', () => {
  assert.equal(canonicalStringify({ k: '中文' }), '{"k":"中文"}');
  assert.equal(canonicalStringify({ k: '😀' }), '{"k":"😀"}');
  // 代理对字符按码点而非 UTF-16 码元排序
  const s = canonicalStringify({ '😀': 1, '': 2 });
  assert.equal(s, '{"":2,"😀":1}');
});

test('canonicalStringify: undefined 省略 / null 保留（JSON 语义）', () => {
  assert.equal(canonicalStringify({ a: undefined, b: null }), '{"b":null}');
  assert.equal(canonicalStringify([undefined]), '[null]');
});

test('canonicalStringify: -0 归一为 0（避免两值产出不同字节）', () => {
  assert.equal(canonicalStringify({ z: -0 }), '{"z":0}');
  assert.equal(canonicalStringify({ z: 0 }), '{"z":0}');
});

test('⛔ 非有限数字 fail-closed 抛错（撞 hash = 漏检）', () => {
  for (const v of [NaN, Infinity, -Infinity]) {
    assert.throws(() => canonicalStringify({ x: v }), TypeError, `未拦截 ${v}`);
    assert.throws(() => computeHypothesisLock({ hypothesis: { x: v }, contractId: 'c', createdAt: 't' }), TypeError);
  }
});

test('⛔ bigint / function / symbol 不可序列化，抛错而非静默降级', () => {
  assert.throws(() => canonicalStringify({ b: 1n }), /bigint/);
  assert.throws(() => canonicalStringify({ f: () => {} }), /function/);
  assert.throws(() => canonicalStringify({ s: Symbol('x') }), /symbol/);
});

test('⛔ computeHypothesisLock: 非法参数一律 fail-closed', () => {
  const cases = [
    ['hypothesis 非对象', { hypothesis: 'x', contractId: 'c', createdAt: 't' }],
    ['hypothesis 为 null', { hypothesis: null, contractId: 'c', createdAt: 't' }],
    ['hypothesis 为数组', { hypothesis: [], contractId: 'c', createdAt: 't' }],
    ['hypothesis 缺失', { contractId: 'c', createdAt: 't' }],
    ['contractId 空串', { hypothesis: H, contractId: '', createdAt: 't' }],
    ['contractId 非字符串', { hypothesis: H, contractId: 123, createdAt: 't' }],
    ['createdAt 空串', { hypothesis: H, contractId: 'c', createdAt: '' }],
    ['createdAt 非字符串', { hypothesis: H, contractId: 'c', createdAt: 1 }],
  ];
  for (const [label, args] of cases) {
    assert.throws(() => computeHypothesisLock(args), TypeError, label);
  }
});

test('嵌套结构与中文混合时 lock 稳定（回归：序列化须递归排序）', () => {
  const h1 = { z: 1, a: { 词: [1, { b: 2, a: 1 }] } };
  const h2 = { a: { 词: [1, { a: 1, b: 2 }] }, z: 1 };
  assert.equal(
    computeHypothesisLock({ hypothesis: h1, contractId: 'C', createdAt: 'T' }),
    computeHypothesisLock({ hypothesis: h2, contractId: 'C', createdAt: 'T' }),
  );
});
