/**
 * lib/dedup.js — Sprint 15 P0-2 T1 重叠检测（设计稿 §7.3）
 *
 * 三维度重叠检测，对 active + stale 状态的技能两两比较：
 *   维度 1 描述重叠   ：description + triggers 合并文本 Jaccard ≥ 0.85
 *   维度 2 工具重叠   ：frontmatter tools 列表 Jaccard ≥ 0.7
 *   维度 3 场景重叠   ：triggers 列表 Jaccard ≥ 0.6
 * 三个维度中 ≥2 个达标 → 「重叠候选对」+ 推荐动作。
 *
 * 推荐动作（设计稿 §3.1 [4]）：
 *   保留使用频率高 / 成功率高的那个，建议归档另一个；
 *   两者数据相近 → 建议 review（人工判断是否 consolidate，Sprint 16）。
 *
 * 纯函数，无 I/O。性能：O(n²) 对比较，token 集合 Jaccard 毫秒级；
 * 500 技能 = 124,750 对 ≈ 秒级（性能验收 ≤30s）。
 */

// ── 默认阈值（P0-2 §7.3）───────────────────────────────────────────────

export const OVERLAP_THRESHOLDS = Object.freeze({
  description: 0.85,  // 描述维度
  tools: 0.7,         // 工具维度
  triggers: 0.6,      // 场景维度
  minDimensions: 2,   // 达标维度数
});

/** 词法 token：英文/数字词 + 中文单字（覆盖中英混合描述） */
export function tokenize(text) {
  const t = String(text ?? '').toLowerCase();
  const latin = t.match(/[a-z0-9][a-z0-9_-]*/g) ?? [];
  const cjk = t.match(/[\u4e00-\u9fff]/g) ?? [];
  return new Set([...latin, ...cjk]);
}

/** Jaccard 相似度 = |A∩B| / |A∪B|；空集对 → 0 */
export function jaccard(setA, setB) {
  if (!setA || !setB || setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  const [small, big] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const x of small) if (big.has(x)) inter++;
  const union = small.size + big.size - inter;
  return inter / union;
}

/** 列表 Jaccard（数组形态便捷函数） */
export function arrayJaccard(a, b) {
  return jaccard(new Set(a ?? []), new Set(b ?? []));
}

/** 描述文本 Jaccard（description + triggers 合并） */
export function descSimilarity(a, b) {
  return jaccard(tokenize(a), tokenize(b));
}

/** 技能输入归一化：兼容 scanSkills 输出（name/description/triggers/tools/usage）与 skill_states 记录 */
function norm(skill) {
  return {
    skillName: skill.skillName ?? skill.name,
    description: skill.description ?? '',
    triggers: skill.triggers ?? skill.frontmatter?.triggers ?? [],
    tools: skill.tools ?? skill.frontmatter?.tools ?? [],
    useCount: skill.usage?.useCount ?? 0,
    successRate: skill.usage?.successRate ?? null,
  };
}

/**
 * 单个技能对的相似度三维度。
 * @returns {{ desc:number, tools:number, triggers:number, descHit:boolean, toolsHit:boolean, triggersHit:boolean, dimsMet:number }}
 */
export function overlapOf(a, b, thresholds = OVERLAP_THRESHOLDS) {
  const na = norm(a);
  const nb = norm(b);
  const desc = descSimilarity(`${na.description} ${na.triggers.join(' ')}`, `${nb.description} ${nb.triggers.join(' ')}`);
  const tools = arrayJaccard(na.tools, nb.tools);
  const triggers = arrayJaccard(na.triggers, nb.triggers);
  const descHit = desc >= thresholds.description;
  const toolsHit = tools >= thresholds.tools;
  const triggersHit = triggers >= thresholds.triggers;
  return {
    desc: round3(desc), tools: round3(tools), triggers: round3(triggers),
    descHit, toolsHit, triggersHit,
    dimsMet: (descHit ? 1 : 0) + (toolsHit ? 1 : 0) + (triggersHit ? 1 : 0),
  };
}

function round3(x) { return Math.round(x * 1000) / 1000; }

/**
 * 推荐动作：保留更优技能，归档另一个。
 * 优劣比较：useCount 优先，次 successRate；无差异 → review（consolidate 留 Sprint 16）。
 * @returns {{ keep:string, archive:string, rationale:string }}
 */
export function recommend(keepSkill, otherSkill) {
  const a = norm(keepSkill);
  const b = norm(otherSkill);
  const score = (s) => s.useCount * 1000 + (s.successRate ?? 0) * 100;
  if (score(a) > score(b)) {
    return { keep: a.skillName, archive: b.skillName, rationale: `保留 ${a.skillName}（使用 ${a.useCount} 次，成功率 ${fmtRate(a.successRate)}），建议归档 ${b.skillName}` };
  }
  if (score(b) > score(a)) {
    return { keep: b.skillName, archive: a.skillName, rationale: `保留 ${b.skillName}（使用 ${b.useCount} 次，成功率 ${fmtRate(b.successRate)}），建议归档 ${a.skillName}` };
  }
  return {
    keep: null, archive: null,
    rationale: `${a.skillName} 与 ${b.skillName} 使用数据相近，建议人工 review（consolidate 整合留 Sprint 16）`,
  };
}

function fmtRate(r) { return r == null ? '未知' : `${Math.round(r * 100)}%`; }

/**
 * 批量重叠检测：所有输入技能两两比较，≥minDimensions 维达标 → 候选对。
 * @param {Array} skills  技能列表（scanSkills 输出或 skill_states 记录）
 * @param {Object} opts   { thresholds, includeStates: 只对指定 state 比较 }
 * @returns {Array<{ skillA, skillB, dims, recommendation }>}
 */
export function detectOverlaps(skills, opts = {}) {
  const thresholds = opts.thresholds ?? OVERLAP_THRESHOLDS;
  const list = (skills ?? []).filter((s) => {
    if (!opts.includeStates) return true;
    const st = s.state ?? 'active';
    return opts.includeStates.includes(st);
  });
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const dims = overlapOf(list[i], list[j], thresholds);
      if (dims.dimsMet >= thresholds.minDimensions) {
        pairs.push({
          skillA: norm(list[i]).skillName,
          skillB: norm(list[j]).skillName,
          dims,
          recommendation: recommend(list[i], list[j]),
        });
      }
    }
  }
  // 按达标维度数降序（越重叠越靠前）
  return pairs.sort((a, b) => b.dims.dimsMet - a.dims.dimsMet);
}
