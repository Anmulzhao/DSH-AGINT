/**
 * agint-aesthetic-oracle: 评分纯函数模块（v2.3 方案 §3 / §4；公式 r2，2026-10-09）。
 *
 * 纯函数：输入原子值 → 输出四指标 + 美总分 + 美之三问。零 I/O、零服务访问、
 * 零 LLM——公式是确定性的，任何人拿到同样的原子值必须算出同样的分数。
 * （唯一非本地依赖是 node:crypto 的 sha1，用于算判尺指纹 scaleHash——
 *   纯计算、无 I/O、不引入不确定性。）
 * 公式 r2 三处修复（提案 f51d3280，老板 2026-10-09 批准）：
 *   1. bloat 扣分加上界（BLOAT_SATURATION=1.5，修复无界线性罚）
 *   2. Q1 加效应量门槛（EFFECT_EPSILON，消除日抖动判定翻转）
 *   3. Q2 改 ratio 排序（归因与维度权重解耦）
 * 公式 r3 一处拆解（提案 51e6e24f，2026-10-09）：噪声比与冗余度的双计分子
 *   ——重复/矛盾条目归 redundancy，noise 只留死条目（详见 deriveComposites）。
 *
 * 分层纪律（方案 C / §9.4 的对偶面）：
 *   - 原子观测归 agint-metrics（summary()/series() 的 key + meta）
 *   - 复合派生（本文件）归神谕层；noise_ratio / aesthetic_score 永远不进 metrics
 *
 * v2.3 语义修复的落点（对照评审 P0/P1）：
 *   - §3.1 噪声比（P0-2）：分子 = 「在系统内」的无引用/无证据/重复条目；
 *     REJECTED 候选是门禁正常工作的证据，不进分子
 *   - §3.2 决策确信度：AVG(conf × evidence_compliance)，逐条相乘（不是均值×覆盖率）
 *   - §3.3 冗余度（P1-7）：三域合并公式，分子分母同口径
 *   - §3.4 臃肿度：预算 120KB = 11 技能 × 8-12KB（prompt 工程经验值）
 *   - §4 Q1（P1-4）：恶化≥2→丑；恶化<2 且改善≥3→美；其余→持平（全排序无洞）
 */

import { createHash } from 'node:crypto';

/**
 * 评分公式版本（2026-10-09 引入）。广播 payload 透传，用于历史趋势分段解读：
 * 版本切换前后的总分不可直接比。
 *   r2：bloat 扣分加上界（min(...,1.5)，修复总分可为负的无界罚）；
 *       Q1 加效应量门槛 ε（消除日抖动导致的判定翻转）；
 *       Q2 改按 ratio（deduction/maxWeight）排序（归因与权重解耦）。
 *   r3：噪声比与冗余度的**双计分子拆解**（提案 51e6e24f，2026-10-09）。
 *       旧口径下同一处 wiki 矛盾 / 重复规则同时进 noise 与 redundancy 两个分子
 *       ⇒ 总分被扣两次，且 Q2 归因时两维互相争夺「最丑」。r3 把重复/矛盾归
 *       redundancy，noise 只留「死条目」（无入链 / 无证据）。
 *       标定复算随之变化：noise 88/380→84/380（0.2316→0.2211）、总分 52.4→53.4。
 *   r4：bloat 从**固定总量预算**改为**单技能体积预算**（2026-10-23，判尺规模
 *       不变性修复）。旧口径 b = Σbytes / 120KB，而 120KB 是按「11 技能 ×
 *       10.9KB」定的固定总量；技能数增长到 20 后预算不跟涨 ⇒ 指标实际测的是
 *       「技能数量」而非「体积失控」。生产实测 2026-10-22：221853 B / 20 =
 *       10.83KB，落在方案 §3.4 自定的 8–12KB 合理区间内，但旧口径 b=1.805、
 *       扣 24.15 分（满分 30）——纯口径假扣，总分被压低 24 分。
 *       r4 定 b = (Σbytes / skillsTotal) / 11170，11170 = 122880/11 保留原标定
 *       基准 ⇒ 09-27 标定样本（11 技能 / 82652 B）复算值 0.6727 完全不变，
 *       历史标定钉仍成立；只有「技能数变了」的时期读数被纠正。
 *
 * ⛔ 版本号只增不减，且**只用于公式结构变更**。阈值/权重的参数微调不 bump
 * 版本，由 scaleHash（见下）自动分段——否则每改一次参数就要人工记一次版本，
 * 漏记则历史趋势被误读为连续（提案 98c8e911）。
 */
export const FORMULA_VERSION = 'r4';

// ── 阈值常量（v2.3 §3；改这里 = 改判尺，须走评审）────────────────────────────
//
// ⚠ **本组常量至今无回测依据**（提案 a85ef850「权重真标定」，2026-10-09 核账结论）：
//   取证方式 = 全仓 grep（`docs/**/*.md` 与全仓 `*.md` 中「标定/权重/0.30」共 30 处
//   命中，逐条核对**全部属于 agint-quality / agint-trajectory 等别的插件的权重表**）；
//   神谕层这 7 个常量在仓库文档、wiki、reviews/ 周报里**没有一处标定语据**。
//   下面各条注释写的是**经验估算**——那是「拍得比随便拍好一点」，不是「测出来的」。
//   ⛔ 别把它当标定引用。
//   回测路线（老板 2026-10-09 拍板：先建标注采集，再标定）：先让周报固定产出
//   「机器归因（Q2 最丑维）vs 人工认定」的对照样本，攒够 8-12 周再拟合——
//   7 个常量拿 2 个样本去拟合是欠定的，比不拟合更危险。

export const THRESHOLDS = {
  /** 噪声比阈值（§3.1）。经验值，**无回测依据**（见上方裁决说明）。
   *  口径（r3）：分子 = 已纳入度量条目中的「死条目」占比（wiki 孤岛 + 无证据记忆），
   *  分母 = wiki + rules + memory 全量。达到该值 = 满扣 30 分。 */
  NOISE_RATIO: 0.30,
  /** 决策确信度下限（§3.2）。经验值，**无回测依据**。
   *  口径：AVG(conf × evidence_compliance)，低于该值按比例扣分，满扣 20。 */
  CONFIDENCE: 0.70,
  /** 冗余度阈值（§3.3）。经验值，**无回测依据**。
   *  口径（r3）：矛盾/重复条目的唯一记账处，达到该值 = 满扣 20。 */
  REDUNDANCY: 0.05,
  /** 单技能体积预算字节（r4）：11170 = 122880 / 11。
   *  来源：原 BLOAT_BUDGET_BYTES（120KB）是按「11 技能 × 10.9KB」定的固定总量。
   *  r4 把它还原成**每技能**预算，让预算总额随 skillsTotal 走。
   *  ⚠ 保留 122880/11 这个基准，是为了让 09-27 标定样本复算值不变（0.6727）。
   *  代价：单技能 10.9KB 本身仍是「技能数 × 单文件经验体积」的乘积估算，
   *  **非回测所得**（属提案 a85ef850 待办）。 */
  BLOAT_BUDGET_PER_SKILL_BYTES: 11170,
  /** 绝对上界兜底（r4）：Σbytes 超过该值即按超出比例追加进 b。
   *  为什么需要：per-skill 判定对「一万个 1KB 技能」失效——每个都不超体积，
   *  但总量爆炸。600KB ≈ 54 个正常技能的体量，正常增长不会触发。
   *  这一条是**防绕过**，不是主判据。 */
  BLOAT_ABS_CEILING_BYTES: 600 * 1024,
  /** 臃肿度扣分饱和倍数：b=2.5 倍预算后不再加倍扣（r2：修复无界罚）。
   *  这 1.5 是 r2 当天按「不要让 bloat 以绝对优势碾压 Q2 归因」定的工程判断，
   *  **未经回测**。 */
  BLOAT_SATURATION: 1.5,
};

/**
 * Q1 效应量门槛（r2）：|Δ| 低于该值的维度视为持平，不计入恶化/改善。
 * 取各维阈值的 10%——日频指标在阈值 10% 内的波动无行动意义。
 */
export const EFFECT_EPSILON = {
  noise: 0.03,
  confidence: 0.07,
  redundancy: 0.005,
  bloat: 0.1,
};

/** 四维权重（§3.6 权重累减结构：避免一项满分掩盖四项差）。
 *  ⚠ noise/bloat 各 30、confidence/redundancy 各 20 —— 同样是经验分配，
 *  **无回测依据**（这正是提案 a85ef850 的正题）。改动本表会改变 scaleHash。 */
export const DIM_WEIGHTS = {
  noise: 30,
  confidence: 20,
  redundancy: 20,
  bloat: 30,
};

export const DIM_KEYS = ['noise', 'confidence', 'redundancy', 'bloat'];

/**
 * Q1 总分门（r4，2026-10-23）：票数判定说「在变美」，但总分实际比基线低超过该值
 * ⇒ 降级为「持平」，并在 note 里写明抵消幅度。
 *
 * 为什么需要：Q1 是**票数制**，只看恶化/改善的维数，不看幅度。生产实测
 * 2026-10-11~10-22 共 12 次 daily，verdict 全部「在变美」，同期总分 93.1→66.9
 * （−26.2）。机制是 3 维微改善 + 1 维暴跌 24 分 → 票数 3:1 → 判美。
 * 一个 45% 时间都在说「在变美」的判官，它的意见不构成信息。
 *
 * ⛔ 为什么**不改加权**（如 score × 票数）：加权会让 Q1 变成总分的函数，
 *   Q1 就失去独立信息。Q1 的价值是「多维方向的**一致性**检查」，
 *   不是总分的复读。总分门只处理「方向一致但量级相反」这一种矛盾。
 *
 * ⚠ −10 是工程判断，**非回测所得**：满分 100 的 10% ＝ 超过单维最大权重
 *   （30）的三分之一被一维吃掉。属提案 a85ef850 待标定范围。
 *
 * ⛔ 本常量**不进 SCALE_SPEC / scaleHash**：它不改变任何分数，只改变判决。
 *   分数仍可比，历史趋势不受影响；把它塞进判尺指纹会让「判决逻辑调整」
 *   被误读成「尺子换了」。
 */
export const Q1_SCORE_GATE_DELTA = -10;

/**
 * 判尺指纹（提案 98c8e911，2026-10-09）：THRESHOLDS / DIM_WEIGHTS /
 * EFFECT_EPSILON 三组常量的 sha1 前 8 位。
 *
 * 为什么与 formulaVersion 互补（粗/细两级）：
 *   - formulaVersion = **公式结构**变更（分子组成、扣分形状、排序键）。
 *     结构变了，跨版本总分不可比 ⇒ 必须人工 bump。
 *   - scaleHash = **参数取值**变更（阈值 0.30→0.25、权重 30→25、ε 调参）。
 *     分数仍可比（同结构），但趋势解读要看 hash 是否分段 ⇒ 应自动可测，
 *     靠人工记版本字符串必然漏记，漏记即「历史趋势被误读为连续」。
 *
 * 纳入 EFFECT_EPSILON 是超出提案原文的一处收紧：提案只列 THRESHOLDS +
 * DIM_WEIGHTS，但 ε 同样是决定 Q1 判定的判尺参数——它变了而 hash 不变，
 * 恰好制造出这次要消灭的那种「静默漂移」。
 *
 * key 排序：对象字面量里调整 key 书写顺序不应改变判尺指纹（那只是代码风格
 * 变动，不是尺子变了），故序列化前统一按 key 排序。**不要**手搓哈希实现——
 * 用 node:crypto 的 sha1（无 I/O，不破坏本模块的纯函数属性）。
 */
export const SCALE_SPEC = Object.freeze({
  thresholds: Object.freeze({ ...THRESHOLDS }),
  weights: Object.freeze({ ...DIM_WEIGHTS }),
  effectEpsilon: Object.freeze({ ...EFFECT_EPSILON }),
});

export const stableStringify = (o) => `{${Object.keys(o).sort()
  .map((k) => `${JSON.stringify(k)}:${JSON.stringify(o[k])}`).join(',')}}`;

/** 判尺指纹（8 位十六进制）。广播 payload 透传，供下游按指纹分段趋势。 */
export const scaleHash = createHash('sha1')
  .update(stableStringify(SCALE_SPEC))
  .digest('hex')
  .slice(0, 8);

/**
 * Q3 无真实证据可依时的诚实占位（§4 真实关：建议必须绑定 lint 证据，
 * 查不到就明说，不许兜底编一句）。调用方（renderReport / buildWeeklyProposals /
 * L1 措辞增强）见它即知「本日无可执行建议」——渲染原样透出，提案跳过，
 * LLM 不再拿它润色。
 */
export const NO_ADVICE = '本日无可执行建议';

const round = (n, d = 4) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ── §3 派生：原子值 → 四个复合比率 ─────────────────────────────────────────

/**
 * 从原子值派生四指标。任一所需原子缺席 → 该指标 { na: true }（广播降 N/A，
 * 总分权重归一，AC-4）。
 *
 * @param {object} a 原子值
 * @param {number} [a.wikiOrphans] wiki 无入链条目数
 * @param {number} [a.wikiContradictions] wiki 矛盾标记数
 * @param {number} [a.ruleDuplicates] rule_lint 命中的 duplicate-pattern 数
 * @param {number} [a.memoryNoEvidence] memory evidence 顶层字段为空的条数
 * @param {number} [a.wikiTotal] wiki 全量页数
 * @param {number} [a.rulesTotal] 规则全量数
 * @param {number} [a.memoryTotal] memory 全量条数
 * @param {number} [a.avgConfXCompliance] Σ(conf×[evidence非空])/N（metrics meta 增补）
 * @param {number} [a.curatorOverlaps] curator 判定的技能重叠对数（可缺省 0；
 *   Day 0 未入 metrics 原子表，当前实测恒 0，接入路径 = metrics-ext 后续增 key）
 * @param {number} [a.skillsTotal] SKILL.md 个数（冗余度分母；r4 起同时是臃肿度的
 *   单技能体积分母——缺席则 bloat 判 N/A，不退回总量口径）
 * @param {number} [a.skillsBytes] Σ SKILL.md 字节（臃肿度分子）
 * @returns {{noise: object, confidence: object, redundancy: object, bloat: object}}
 */
export function deriveComposites(a = {}) {
  const na = (reason) => ({ value: null, na: true, reason });

  // noise = (orphans + noEvidence) / (wiki+rules+memory)   ← r3
  //
  // r3 拆解（提案 51e6e24f）：旧口径分子含 wikiContradictions 与 ruleDuplicates，
  // 而 redundancy 分子也含这两项 ⇒ 同一处病灶被扣两次分，且 Q2 归因时两维互相
  // 争夺「最丑」（数据源层共享 2/3 的分子，两维并不独立）。
  // r3 语义分工：**noise 只数死条目**（无入链的 wiki 孤岛、无证据的记忆），
  // **重复/矛盾归 redundancy**（§3.3 的职责）。
  //
  // 分母口径（评审必问项，写在这里而不是散文里）：分母保持
  // wiki+rules+memory 不变 = 「已纳入度量的条目总量」这个**共同基座**。
  //   代价（已知且接受）：rulesTotal 进分母但无对应分子项（r3 起重复规则不再算
  //   噪声），会稀释 noise 比值——这正是「拆解」要表达的意思：规则层的重复问题
  //   归冗余度记账，不该再让噪声比替它扣一次分。
  //   备选方案（未采纳）：分母同步去掉 rulesTotal。但那会让两个维度的分母各自
  //   不同源，而冗余度分母本就跨 rules+wiki+skills 三域；共同基座更易解读。
  //   ⚠ 本阈值 NOISE_RATIO 至今**无回测依据**（属提案 a85ef850 权重真标定待办），
  //   r3 只改分子结构、不动阈值——避免在没有标定数据时连改两个数。
  let noise;
  {
    const numParts = [a.wikiOrphans, a.memoryNoEvidence];
    const denParts = [a.wikiTotal, a.rulesTotal, a.memoryTotal];
    if (numParts.every(isNum) && denParts.every(isNum)) {
      const num = numParts.reduce((s, v) => s + v, 0);
      const den = denParts.reduce((s, v) => s + v, 0);
      noise = den > 0
        ? { value: round(num / den), na: false, numerator: num, denominator: den }
        : na('分母为 0（wiki/rules/memory 全空）');
    } else {
      noise = na('原子值缺席（wiki.orphans / memory.total）');
    }
  }

  // confidence = AVG(conf × compliance)——metrics 已按逐条口径聚合（avgConfXCompliance）
  const confidence = isNum(a.avgConfXCompliance)
    ? { value: round(a.avgConfXCompliance), na: false }
    : na('avgConfXCompliance 缺席（memory.list 不可用）');

  // redundancy = (duplicates + contradictions + curator_overlaps) / (rules+wiki+skills)
  //
  // r3 起，本维是重复/矛盾类问题的**唯一记账处**（noise 分子已移除这两项）。
  let redundancy;
  {
    const overlaps = a.curatorOverlaps ?? 0;
    const numParts = [a.ruleDuplicates, a.wikiContradictions, overlaps];
    const denParts = [a.rulesTotal, a.wikiTotal, a.skillsTotal];
    if (numParts.every(isNum) && denParts.every(isNum)) {
      const num = numParts.reduce((s, v) => s + v, 0);
      const den = denParts.reduce((s, v) => s + v, 0);
      redundancy = den > 0
        ? { value: round(num / den), na: false, numerator: num, denominator: den }
        : na('分母为 0（rules/wiki/skills 全空）');
    } else {
      redundancy = na('原子值缺席（rulesTotal / wikiTotal / skillsTotal）');
    }
  }

  // bloat = 单技能平均体积 / 单技能预算（r4）
  //
  // ⛔ r3 及以前是 b = Σbytes / 120KB。120KB 是「11 技能 × 10.9KB」的固定总量，
  //    技能数增长后预算不跟涨 ⇒ 指标测的是「技能数量」而不是「体积失控」。
  //    生产证据（2026-10-22）：221853 B / 20 技能 = 10.83KB，落在方案自定的
  //    8–12KB 合理区间，旧口径却给 b=1.805、扣 24.15 分（满分 30）。
  //
  // r4 口径：b = (Σbytes / skillsTotal) / BLOAT_BUDGET_PER_SKILL_BYTES。
  //   判据含义从「总量超没超一个固定数」变成「单个技能平均写多大」。
  //   缺 skillsTotal 时**不退回总量口径**——那会让同名字段在不同轮次含义不同，
  //   是更隐蔽的口径漂移。直接 N/A 走权重归一（AC-4），让缺数据可见。
  let bloat;
  {
    const bytes = a.skillsBytes;
    const count = a.skillsTotal;
    if (!isNum(bytes)) {
      bloat = na('skillsBytes 缺席（skills 文件系统不可达）');
    } else if (!isNum(count) || count <= 0) {
      bloat = na('skillsTotal 缺席或为 0（单技能体积口径无分母，不退回总量口径）');
    } else {
      const perSkill = (bytes / count) / THRESHOLDS.BLOAT_BUDGET_PER_SKILL_BYTES;
      // 绝对上界兜底：per-skill 对「一万个 1KB 技能」失效，超界按比例追加。
      const overCeiling = bytes > THRESHOLDS.BLOAT_ABS_CEILING_BYTES
        ? 1 + (bytes - THRESHOLDS.BLOAT_ABS_CEILING_BYTES) / THRESHOLDS.BLOAT_ABS_CEILING_BYTES
        : 0;
      bloat = {
        value: round(Math.max(perSkill, overCeiling)),
        na: false,
        bytes,
        skillsTotal: count,
        perSkillBytes: Math.round(bytes / count),
        perSkillBudget: THRESHOLDS.BLOAT_BUDGET_PER_SKILL_BYTES,
        budget: Math.round(count * THRESHOLDS.BLOAT_BUDGET_PER_SKILL_BYTES),
        // 判定被哪一路驱动：volume（单技能体积）/ ceiling（绝对上界）。
        // 广播与审计靠它区分「技能写太胖」与「技能太多」——两者处理动作不同。
        drivenBy: overCeiling > perSkill ? 'ceiling' : 'volume',
      };
    }
  }

  return { noise, confidence, redundancy, bloat };
}

// ── §3.6 评分：四比率 → 美总分（N/A 权重归一）──────────────────────────────

/**
 * 扣分计算（单维）。返回 null 表示该维 N/A 不参与。
 *   noise      : 30 × min(nr / 0.30, 1)
 *   confidence : 20 × max((0.70 − c) / 0.70, 0)
 *   redundancy : 20 × min(r / 0.05, 1)
 *   bloat      : 30 × min(max(0, b − 1), 1.5)（r2：饱和于 2.5 倍预算，
 *                修复无界线性罚——旧公式 b=3 扣 60、b=4 扣 90，总分可为负
 *                且 bloat 以绝对优势碾压 Q2 归因）
 */
export function dimDeduction(key, value) {
  const T = THRESHOLDS;
  switch (key) {
    case 'noise': return DIM_WEIGHTS.noise * Math.min(value / T.NOISE_RATIO, 1);
    case 'confidence': return DIM_WEIGHTS.confidence * Math.max((T.CONFIDENCE - value) / T.CONFIDENCE, 0);
    case 'redundancy': return DIM_WEIGHTS.redundancy * Math.min(value / T.REDUNDANCY, 1);
    case 'bloat': return DIM_WEIGHTS.bloat * Math.min(Math.max(0, value - 1), T.BLOAT_SATURATION);
    default: return null;
  }
}

/**
 * 美总分（§3.6）。可用维度扣分按权重占比归一回 100 分制（AC-4：缺 key 时
 * 广播仍输出，公式重新归一到剩余维度）：
 *   score = 100 − Σded × (100 / ΣmaxWeight_available)
 * 全维可用时 ΣmaxWeight=100，退化为原公式。
 *
 * @returns {{score: number|null, dims: object, availableDims: string[], naDims: string[],
 *            renormalized: boolean, effectiveDenominator: number}}
 */
export function computeAestheticScore(composites) {
  let sumDed = 0;
  let sumMaxW = 0;
  const dims = {};
  const availableDims = [];
  const naDims = [];
  for (const key of DIM_KEYS) {
    const c = composites?.[key];
    if (!c || c.na || !isNum(c.value)) {
      dims[key] = { available: false, deduction: null, maxWeight: DIM_WEIGHTS[key] };
      naDims.push(key);
      continue;
    }
    const ded = dimDeduction(key, c.value);
    dims[key] = { available: true, value: c.value, deduction: round(ded), maxWeight: DIM_WEIGHTS[key] };
    sumDed += ded;
    sumMaxW += DIM_WEIGHTS[key];
    availableDims.push(key);
  }
  if (availableDims.length === 0) {
    return {
      score: null, dims, availableDims, naDims,
      renormalized: false, effectiveDenominator: 0,
      note: '四维全部 N/A，无分可打',
    };
  }
  const renormalized = sumMaxW !== 100;
  const score = round(100 - sumDed * (100 / sumMaxW), 1);
  // effectiveDenominator（提案 392cb761，2026-10-09）：本轮实际参与打分的权重和。
  // 缺维时总分被重新归一到剩余维度——不把这个数吐出去，下游只能说「归一了」，
  // 说不清「归一到多少」，读者就会把「分数变高」误读成「系统变美」。
  return { score, dims, availableDims, naDims, renormalized, effectiveDenominator: sumMaxW };
}

// ── §4 美之三问 ─────────────────────────────────────────────────────────────

/**
 * Q1：这件事让系统更美了吗？（§4 v2.3 判定，P1-4 修复）
 *
 *   恶化项数 ≥ 2            → 「在变丑」
 *   恶化项数 < 2 且改善 ≥ 3  → 「在变美」
 *   其余                     → 「持平」
 *
 * 恶化/改善按维定义：noise ↑ = 恶化；confidence ↓ = 恶化；redundancy ↑ = 恶化；
 * bloat ↑ = 恶化。N/A 维不参与计数。基线缺席 → 持平（附注）。
 *
 * r2 效应量门槛：|Δ| < EFFECT_EPSILON[key] 的维度视为持平，不计入恶化/改善
 * ——旧公式 4 位小数非零即计数，噪声比 0.0405→0.0406 就算「恶化一维」，
 * 日频指标天然抖动会让 Q1 在「持平/变丑」间随机翻转。
 *
 * @param {object} current composites（deriveComposites 输出）
 * @param {object|null} baseline composites（首周基线；null = 未建立）
 * @param {{currentScore?: number, baselineScore?: number}} [opts]
 *   r4：总分门所需的两端总分。缺席则只按票数判定（向后兼容旧调用方）。
 */
export function q1Verdict(current, baseline, opts = {}) {
  if (!baseline) {
    return { verdict: 'flat', worseCount: 0, betterCount: 0, note: '基线未建立（首周起算）' };
  }
  const worseDims = { noise: 'up', confidence: 'down', redundancy: 'up', bloat: 'up' };
  let worseCount = 0;
  let betterCount = 0;
  const worseList = [];
  const betterList = [];
  for (const key of DIM_KEYS) {
    const c = current?.[key];
    const b = baseline?.[key];
    if (!c || c.na || !isNum(c.value) || !b || b.na || !isNum(b.value)) continue;
    const diff = round(c.value - b.value);
    const eps = EFFECT_EPSILON[key] ?? 0;
    if (Math.abs(diff) < eps) continue; // r2：阈下波动视为持平
    const worsening = worseDims[key] === 'up' ? diff > 0 : diff < 0;
    if (worsening) { worseCount += 1; worseList.push(key); } else { betterCount += 1; betterList.push(key); }
  }
  let verdict;
  let note = null;
  if (worseCount >= 2) verdict = 'ugly';
  else if (worseCount < 2 && betterCount >= 3) verdict = 'beautiful';
  else verdict = 'flat';
  // ── r4 总分门：方向一致但量级相反 ⇒ 不说「在变美」 ──────────────────────
  // 只拦 beautiful。ugly 不需要拦（它已经在报忧）。flat 不需要拦。
  const curScore = opts.currentScore;
  const baseScore = opts.baselineScore;
  if (verdict === 'beautiful' && isNum(curScore) && isNum(baseScore)) {
    const delta = round(curScore - baseScore, 1);
    if (delta <= Q1_SCORE_GATE_DELTA) {
      verdict = 'flat';
      note = `${betterCount} 维改善、${worseCount} 维恶化（${worseList.join('/')}），`
        + `但总分低于基线 ${Math.abs(delta)} 分——方向一致、量级相反，不判「在变美」`;
    }
  }
  return { verdict, worseCount, betterCount, worseList, betterList, note };
}

export const Q1_VERDICT_TEXT = {
  beautiful: '在变美',
  ugly: '在变丑',
  flat: '持平',
};

/**
 * Q2：这件事最丑的地方在哪？（§4：指到指标级 + 来源）
 * r2：排序键 = **偏离度 ratio**（deduction / maxWeight），不是绝对扣分。
 * 旧口径按绝对扣分排序，noise/bloat（权重 30）天然压过 confidence/redundancy
 * （权重 20）——归因被权重差绑架。ratio 让「最丑」= 离自己阈值最远，
 * 与维度权重解耦。N/A 维不参与。
 */
export function q2Worst(composites, dims) {
  let worst = null;
  for (const key of DIM_KEYS) {
    const d = dims?.[key];
    const c = composites?.[key];
    if (!d?.available || !c || !isNum(c.value)) continue;
    const ratio = d.deduction / DIM_WEIGHTS[key];
    if (!worst || ratio > worst.ratio) {
      worst = {
        key,
        value: c.value,
        deduction: d.deduction,
        maxWeight: DIM_WEIGHTS[key],
        ratio: round(ratio),
      };
    }
  }
  return worst;
}

/**
 * Q3：建议怎么做才能更美？（§4 映射表，四条全量；纯机械动作 + 必附证据）
 *
 * ⛔ §4 真实关（2026-09-29 修复）：建议必须绑定真实 lint 证据——
 * 每条建议先查 ctx 里的实际清单，查不到就输出 NO_ADVICE（「本日无可执行
 * 建议」），不许兜底编一句。例：redundancy 最丑但 rule_lint 0 命中时，旧
 * 逻辑仍输出「合并 rule_lint 命中的 duplicate 规则」（编造）；现在先看
 * wiki 矛盾 / curator 重叠的真实分子，全空才回 NO_ADVICE。
 *
 * @param {string} worstKey q2Worst().key
 * @param {object} ctx 证据上下文（各清单；缺了相应字段就降级为机制引用）
 */
export function q3Advice(worstKey, ctx = {}) {
  switch (worstKey) {
    case 'noise': {
      const ids = Array.isArray(ctx.memoryNoEvidenceIds) ? ctx.memoryNoEvidenceIds : null;
      const orphanList = Array.isArray(ctx.wikiOrphanFiles) ? ctx.wikiOrphanFiles : null;
      const noEvCount = isNum(ctx.memoryNoEvidenceCount) ? ctx.memoryNoEvidenceCount : 0;
      if (noEvCount > 0) {
        const detail = ids
          ? `（id 清单${ids.length >= 50 ? '前 50 条' : ''}：${ids.slice(0, 50).join(', ')}）`
          : '';
        return { advice: `为 ${noEvCount} 条无 evidence 记忆补证据${detail}`, evidence: 'memory 表 evidence 字段扫描' };
      }
      if (orphanList && orphanList.length > 0) {
        return {
          advice: `归档 wiki orphans（${orphanList.slice(0, 10).join('、')}${orphanList.length > 10 ? ' …' : ''}）`,
          evidence: 'wiki_lint 报告（orphans 明细）',
        };
      }
      return {
        advice: NO_ADVICE,
        evidence: `noise 分子实测：${noEvCount} 条无证据记忆 / ${orphanList?.length ?? 0} 个 wiki 孤儿 / 0 条重复规则`,
      };
    }
    case 'redundancy': {
      const issues = Array.isArray(ctx.ruleLintIssues) ? ctx.ruleLintIssues : [];
      const dups = issues.filter((i) => i?.kind === 'duplicate-pattern');
      if (dups.length > 0) {
        const pairs = dups.map((i) => `${i.ruleId}+${i.with}`).join(', ');
        return {
          advice: `合并 rule_lint 命中的 duplicate 规则${pairs ? `：${pairs}` : ''}`,
          evidence: 'rule_lint issues 明细',
        };
      }
      const contradFiles = Array.isArray(ctx.wikiContradictionFiles) ? ctx.wikiContradictionFiles : [];
      if (contradFiles.length > 0) {
        const names = contradFiles.slice(0, 5).join('、');
        return {
          advice: `解决 wiki 矛盾标记（${contradFiles.length} 处：${names}${contradFiles.length > 5 ? ' …' : ''}）`,
          evidence: 'wiki_lint contradictions 明细',
        };
      }
      const overlaps = isNum(ctx.curatorOverlaps) ? ctx.curatorOverlaps : 0;
      if (overlaps > 0) {
        return { advice: `归档 curator 判定的 ${overlaps} 对重叠技能`, evidence: 'curator overlaps 明细' };
      }
      return {
        advice: NO_ADVICE,
        evidence: `redundancy 分子实测：${dups.length} 条重复规则 / ${contradFiles.length} 处 wiki 矛盾 / ${overlaps} 对 curator 重叠`,
      };
    }
    case 'confidence': {
      const rows = Array.isArray(ctx.lowConfidenceNoEvidence) ? ctx.lowConfidenceNoEvidence : [];
      if (rows.length === 0) {
        return { advice: NO_ADVICE, evidence: '无证据条目清单为空，无具体条目可复核' };
      }
      // 口径对齐（2026-10-08）：rows 来自 metrics 的 noEvidence.ids，即
      // 「evidence 为空」的条目 id，**不含逐条 confidence**（avgConfXCompliance
      // 只给均值）。故此处只承诺「无证据」，不得升格为「低置信且无证据」。
      const head = '定向复核无证据的记忆条目';
      const detail = `（${rows.slice(0, 10).join(', ')}${rows.length > 10 ? ' …' : ''}）`;
      return { advice: `${head}${detail}`, evidence: 'memory id 清单（evidence 为空；confidence 未逐条下发，故不宣称低置信）' };
    }
    case 'bloat': {
      const bytes = isNum(ctx.skillsBytes) ? ctx.skillsBytes : null;
      const count = isNum(ctx.skillsTotal) && ctx.skillsTotal > 0 ? ctx.skillsTotal : null;
      // r4：预算随技能数走 ⇒ 没有 skillsTotal 就算不出预算，也就无从判定超限。
      // 此时返回 NO_ADVICE 而不是拿一个固定数硬判（那正是 r3 的病根）。
      if (bytes === null || count === null) {
        return {
          advice: NO_ADVICE,
          evidence: `skillsBytes=${bytes ?? '?'} / skillsTotal=${count ?? '?'}，单技能体积口径无法判定`,
        };
      }
      const budget = Math.round(count * THRESHOLDS.BLOAT_BUDGET_PER_SKILL_BYTES);
      const perSkillKb = ((bytes / count) / 1024).toFixed(1);
      const budgetKb = (THRESHOLDS.BLOAT_BUDGET_PER_SKILL_BYTES / 1024).toFixed(1);
      if (bytes <= budget) {
        return {
          advice: NO_ADVICE,
          evidence: `${count} 个技能共 ${bytes} 字节（均 ${perSkillKb}KB / 预算 ${budgetKb}KB），总量未超 ${budget} 字节`,
        };
      }
      // 绝对上界驱动时，问题在「技能太多」不在「单个太大」——动作不同，必须分开说。
      if (bytes > THRESHOLDS.BLOAT_ABS_CEILING_BYTES) {
        return {
          advice: `技能总量超绝对上界（${bytes} > ${THRESHOLDS.BLOAT_ABS_CEILING_BYTES} 字节，${count} 个）：归档 curator 判定陈旧/重叠技能`,
          evidence: 'curator overlaps / 陈旧检测输出（绝对上界判据，非单技能体积判据）',
        };
      }
      return {
        advice: `归档 curator 判定陈旧/重叠的技能（${count} 个技能共 ${bytes} 字节，均 ${perSkillKb}KB 超预算 ${budgetKb}KB）`,
        evidence: 'curator overlaps / 陈旧检测输出',
      };
    }
    default:
      return { advice: NO_ADVICE, evidence: `未知最丑维度 ${worstKey}，无可执行建议` };
  }
}

/**
 * 一步到位：原子值 → 完整美评结构（派生 + 总分 + 三问）。
 * 供 broadcast.js 与标定脚本共用——保证「测的就是跑的」。
 *
 * @param {object} atomic 原子值
 * @param {{baseline?: object|null, adviceCtx?: object, baselineScore?: number|null}} [opts]
 *   baselineScore 供 Q1 总分门（r4）使用；缺席则该门不生效（只按票数判）。
 */
export function evaluateAesthetics(atomic, { baseline = null, adviceCtx = {}, baselineScore = null } = {}) {
  const composites = deriveComposites(atomic);
  const scored = computeAestheticScore(composites);
  const verdict = q1Verdict(composites, baseline, {
    currentScore: scored.score,
    baselineScore,
  });
  const worst = scored.score !== null ? q2Worst(composites, scored.dims) : null;
  const advice = worst ? q3Advice(worst.key, adviceCtx) : { advice: null, evidence: null };
  return { composites, scored, verdict, worst, advice };
}
