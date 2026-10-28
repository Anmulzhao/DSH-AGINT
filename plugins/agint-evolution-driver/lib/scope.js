/**
 * agint-evolution-driver/lib/scope.js —— 提案「执行范围」的会计层（纯逻辑，无 IO / 无 ctx）。
 *
 * ## 它补的是哪个洞
 *
 * 一次自动执行的**原子单元**是「一个文件里的一次编辑」—— mutator.propose 的入参形态
 * （promptPayload.oldText/newText 必须在目标文件里唯一命中）结构上就不可能跨文件原子。
 * 而提案是**按主题**写的：一条提案常常横跨好几个文件，甚至要求先抽出一个共用模块。
 * 这个能力差是结构性的，改提示词抹不平，只能**记账**。
 *
 * 没有这层记账，系统会犯两类错，各有一份实测：
 *
 *   - v0.8.0 之前：第一个目标答 `applicable=false` ⇒ 整条提案判死刑，而真正该改的两个
 *     替身**一次都没被读过**（提案 `846f4fbb`，2026-10-28 14:42，attempts=2 用尽，
 *     产出逐字相同 = 第二次尝试零信息增益）。
 *   - v0.8.0 之后：逐个目标尝试 ⇒ 第 1 个目标改成功就算 `succeeded`，提案被标
 *     `applied`、`execError=''`；而它在 3 个单元里只覆盖了 1 个
 *     （23:31 提交 bd7c5b3 只改了 `agint-evolve/test/_stub-dsh-tools.mjs`，
 *     `agint-input-gateway/test/_stub-storage-domain.mjs` 仍原样透传、共用模块没建、
 *     冒烟里的真调断言也没有）。
 *
 * **后者更危险**：假死刑至少还把提案留在队列里；假完成会把后续一切入口一起关掉
 * （台账说它已 applied，没人会再去翻正文里的第二处）。
 *
 * ## 判定口径（全部确定性，绝不问 LLM）
 *
 *   unitsTotal       正文解析出的目标文件数 + 正文是否要求新建资产（是则 +1）
 *   unitsApplied     本次真正写入的单元数（0 或 1）
 *   remainingUnits   已解析、但**这一次没轮到**的目标（排在 applied 之后的那些）
 *   requiresNewAsset 正文出现「抽共用 / 共用模块 / 新增文件 / `plugins/_shared/`」为真
 *   complete         只有「改了一个目标 ∧ 没有剩余目标 ∧ 不要求新建资产」才为真
 *
 * ⛔ 「试过但被模型否掉」的目标**不算**剩余：模型当场答过 applicable=false，再记成
 *    欠账会让每一条单文件提案都自称 incomplete（`846f4fbb` 的前两个目标正是样板文件）。
 * ⛔ 该函数只做记账，**不做路由决策** —— 该不该继续跑是调用方的事（见 index.js）。
 *
 * ⛔ 本文件不许碰存储、不许读 env、不许拿 Date.now()。
 */

/** 正文里「要求新建资产」的信号。命中任一即认为提案多出一个单元（新文件 / 共用模块）。 */
const NEW_ASSET_HINTS = [
  [/抽\s*(一\s*)?份?\s*(共用|共享|公共)/u, '要求抽共用模块'],
  [/(共用|共享|公共)\s*(模块|替身|基类|工具|文件)/u, '提到共用模块'],
  [/(新建|新增)\s*(一个)?\s*(共用|共享|公共)?\s*(文件|模块)/u, '要求新建文件/模块'],
  [/plugins\/_shared\//u, '正文写出共用目录路径'],
];

/**
 * 检测正文是否要求「新建一个资产」（共用模块 / 新文件）。
 *
 * @param {string} text 提案正文（含标题亦可）
 * @returns {string[]} 命中的理由（空数组 = 没有这类要求）
 */
export function detectNewAssetIntent(text) {
  const s = String(text ?? '');
  const out = [];
  for (const [re, label] of NEW_ASSET_HINTS) {
    if (re.test(s) && !out.includes(label)) out.push(label);
  }
  return out;
}

/**
 * 计算一次执行的范围覆盖情况。
 *
 * @param {object} opts
 * @param {Array<{type?:string,id?:string}>} opts.targets 解析出的有序目标（同 index.js 的口径）
 * @param {string} [opts.body] 提案正文（用于判断是否要求新建资产）
 * @param {number} [opts.appliedIndex] 本次真正写入的目标下标（-1 = 没写）
 * @param {boolean} [opts.requiresNewAsset] 显式指定；缺省按正文自动判
 * @returns {{
 *   unitsTotal:number, unitsApplied:number, remainingUnits:string[],
 *   requiresNewAsset:boolean, newAssetEvidence:string[], complete:boolean,
 *   reason:string, note:string
 * }}
 */
export function analyzeProposalScope(opts = {}) {
  const targets = (Array.isArray(opts.targets) ? opts.targets : [])
    .filter(Boolean)
    .map((t) => (typeof t === 'string' ? { id: t } : t));
  const ids = targets.map((t) => String(t?.id ?? ''));

  const newAssetEvidence = detectNewAssetIntent(opts.body ?? opts.text ?? '');
  const requiresNewAsset = typeof opts.requiresNewAsset === 'boolean'
    ? opts.requiresNewAsset
    : newAssetEvidence.length > 0;

  const rawIndex = Number(opts.appliedIndex);
  const ai = Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < ids.length ? rawIndex : -1;
  const unitsApplied = ai >= 0 ? 1 : 0;
  // applied 之后的目标 = 这次没试过（applied 之前的都被模型当场否掉了，不算欠账）。
  const remainingUnits = ai >= 0 ? ids.slice(ai + 1) : ids.slice();

  const unitsTotal = ids.length + (requiresNewAsset ? 1 : 0);
  const complete = unitsApplied === 1 && remainingUnits.length === 0 && !requiresNewAsset;

  const appliedPart = unitsApplied === 1 ? `已落地 ${ids[ai]}` : '本次没有单元落地';
  const remainingPart = remainingUnits.length
    ? `未覆盖目标 ${remainingUnits.length} 个：${remainingUnits.join('、')}`
    : '';
  const newAssetPart = requiresNewAsset
    ? `正文要求新建资产：${newAssetEvidence.join('、')}`
    : '';
  const reason = [remainingPart, newAssetPart].filter(Boolean).join('；');
  const note = complete
    ? `范围记账 1/1：${appliedPart}，无剩余单元`
    : `范围记账 ${unitsApplied}/${unitsTotal}：${appliedPart}${reason ? `；${reason}` : ''}`
      + ' —— 提案不应按「已落地」结案';

  return {
    targets: ids,
    unitsTotal,
    unitsApplied,
    remainingUnits,
    requiresNewAsset,
    newAssetEvidence,
    complete,
    reason,
    note,
  };
}
