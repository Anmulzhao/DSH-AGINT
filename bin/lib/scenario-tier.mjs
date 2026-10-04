/**
 * bin/lib/scenario-tier.mjs —— Phase 0.1「Frozen Benchmark 三层隔离」判据层
 *
 * 目标：让三层隔离从**文档**变成**代码里生效的约束**。
 * 路线图验收原文：三层物理隔离、Frozen 集的 hash 落 evolution-memory 防篡改、
 * Validation 与 Frozen 只增不减。本模块提供这三条的**判据**（纯函数）。
 *
 * ⛔ 判据不写进 cron、不写进 UI。它只被两类调用方使用：
 *   1. `bin/build-scenario-inventory.mjs`（生成器 + `--check`）
 *   2. `eval/scenarios/driver.js`（读端门：进化视图只加载 Evolution 层）
 *
 * ## 为什么标签存 sidecar 而不写进 scenario JSON
 *
 * `contentHash` 是对**场景单元内容**算的（`canonicalHash(u, {prefix:true})`）。
 * 把 `visibility` / `labelAuthority` 写进 `.scenario.json` ⇒ 123 个 contentHash
 * 全部变化 ⇒ 「Frozen 集防篡改基线」这条不变量自毁：你无法再证明某个单元
 * 自冻结以来没被改过，因为改它的**标签**就等于改它的 hash。
 * 判据与被评对象必须不同池（与 R2 技能金标同构：判据在 `eval/skills/`，
 * 被改的只有 `SKILL.md`）。
 *
 * ## 为什么「只加字段不过滤」等于没做
 *
 * 字段是标注，过滤才是隔离。本模块导出 `selectVisible()`，driver 用它决定
 * 加载哪些单元 —— 那是三层隔离**唯一真正起作用的地方**。
 *
 * 零依赖：只用 node:fs / node:path + 同目录的 canonical-json.mjs。
 */

import { readFileSync } from 'node:fs';
import { canonicalHash } from './canonical-json.mjs';

/** visibility 枚举（Phase 0 维度）。顺序即「从最可见到最不可见」。 */
export const TIER_VALUES = Object.freeze(['EVOLUTION', 'VALIDATION', 'FROZEN']);

/** labelAuthority 枚举（external-anchor 维度）。 */
export const LABEL_AUTHORITY_VALUES = Object.freeze(['UNSET', 'SILVER', 'GOLD', 'HELDOUT']);

/**
 * 默认值。**如实反映现状**，不是规划目标：
 *   EVOLUTION = 当前该单元可被进化过程访问（三层隔离未真正分层时全部如此）
 *   UNSET     = 无外部锚定的真值标签（external-anchor 提案已存档）
 */
export const DEFAULT_TIER = 'EVOLUTION';
export const DEFAULT_LABEL_AUTHORITY = 'UNSET';

/** sidecar 文件格式版本。改结构时升，改枚举值时按 compatibility-matrix 判断。 */
export const TIERING_VERSION = '1.0';

/**
 * H4 每域最低样本量（evaluation-protocol-v1.md §7 限制 1）。
 * 单元数 < 3 的 domain 全留 Evolution Set ⇒ 它们永远进不了 Frozen。
 * 已知命中：`dream` = 1、`memory` = 1。
 */
export const H4_MIN_DOMAIN_UNITS = 3;

/** H1/H2 的比例常数（docs/eval/three-tier-quota.md §2）。 */
export const H1_EVOLUTION_FAIL_RATIO = 0.6;
export const H2_FROZEN_NEW_RATIO = 0.6;

/**
 * H1：Evolution 必须保留的存量 fail 下限 = ⌈0.6 × fail数⌉。
 * @param {number} failCount
 */
export function h1EvolutionMinFail(failCount) {
  const n = Number(failCount);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.ceil(H1_EVOLUTION_FAIL_RATIO * n);
}

/**
 * H3：Frozen 里可用的存量 fail 探针上限 = fail数 − ⌈0.6 × fail数⌉。
 *
 * ⚠️ 这个上限是**算术结果**，不是偏好（three-tier-quota.md §2.1）。
 * 当前 fail = 5 ⇒ 5 − 3 = 2。fail 数变化时必须重算，不许沿用旧值。
 *
 * @param {number} failCount
 */
export function h3FrozenFailProbeCap(failCount) {
  const n = Number(failCount);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n - h1EvolutionMinFail(n);
}

// ── sidecar 解析 ────────────────────────────────────────────────────────────

/**
 * 校验并归一 sidecar 映射文件的内容。
 *
 * 形状（TIERING_VERSION = 1.0）：
 *   {
 *     "tieringVersion": "1.0",
 *     "units": { "<unitId>": { "visibility": "EVOLUTION", "labelAuthority": "UNSET" } }
 *   }
 *
 * ⛔ 每个 unitId 都必须**显式**登记。不给「缺失即取默认」的静默兜底 ——
 *    否则 `--check` 的「缺失映射」这条判据永远绿，等于没写。
 *
 * @param {unknown} raw 已解析的 JSON
 * @returns {{ok: boolean, errors: string[], entries: Map<string, {visibility:string, labelAuthority:string}>, meta: object}}
 */
export function normalizeTierMap(raw) {
  const errors = [];
  const entries = new Map();
  const meta = { tieringVersion: null, unitCount: 0 };

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['tiering 文件顶层必须是对象'], entries, meta };
  }
  meta.tieringVersion = typeof raw.tieringVersion === 'string' ? raw.tieringVersion : null;
  if (meta.tieringVersion !== TIERING_VERSION) {
    errors.push(
      `tieringVersion = ${JSON.stringify(meta.tieringVersion)}，本模块只认 ${TIERING_VERSION}`,
    );
  }
  if (raw.units === null || typeof raw.units !== 'object' || Array.isArray(raw.units)) {
    return { ok: false, errors: [...errors, 'tiering 文件缺少 units 对象'], entries, meta };
  }

  for (const [unitId, v] of Object.entries(raw.units)) {
    if (typeof unitId !== 'string' || unitId === '') {
      errors.push('units 里出现空的 unitId 键');
      continue;
    }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      errors.push(`${unitId}：映射条目必须是对象，实得 ${JSON.stringify(v)}`);
      continue;
    }
    if (!TIER_VALUES.includes(v.visibility)) {
      errors.push(
        `${unitId}：visibility = ${JSON.stringify(v.visibility)} 不在枚举 ${TIER_VALUES.join('/')}`,
      );
      continue;
    }
    if (!LABEL_AUTHORITY_VALUES.includes(v.labelAuthority)) {
      errors.push(
        `${unitId}：labelAuthority = ${JSON.stringify(v.labelAuthority)} 不在枚举 ${LABEL_AUTHORITY_VALUES.join('/')}`,
      );
      continue;
    }
    entries.set(unitId, { visibility: v.visibility, labelAuthority: v.labelAuthority });
  }

  meta.unitCount = entries.size;
  return { ok: errors.length === 0, errors, entries, meta };
}

/**
 * 读盘版。读不到 / 解析失败 ⇒ ok=false 且 errors 有内容（调用方 fail-closed）。
 *
 * @param {string} absPath
 */
export function readTierMap(absPath) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(absPath, 'utf8'));
  } catch (e) {
    return {
      ok: false,
      errors: [`tiering 文件读不到或不是合法 JSON：${absPath} — ${e.message}`],
      entries: new Map(),
      meta: { tieringVersion: null, unitCount: 0 },
    };
  }
  return normalizeTierMap(raw);
}

// ── 赋值 ────────────────────────────────────────────────────────────────────

/**
 * 给每个 unit 挂上 visibility / labelAuthority。
 *
 * @param {Array<{unitId: string}>} units
 * @param {Map<string, {visibility:string, labelAuthority:string}>} entries
 * @returns {{ok: boolean, errors: string[], units: Array<object>}}
 */
export function assignTiers(units, entries) {
  const errors = [];
  const out = [];
  for (const u of units) {
    const m = entries.get(u.unitId);
    if (!m) {
      errors.push(`${u.unitId}：tiering 文件里没有映射条目（缺映射 = 无法定层，不给默认值兜底）`);
      continue;
    }
    out.push({ ...u, visibility: m.visibility, labelAuthority: m.labelAuthority });
  }
  return { ok: errors.length === 0, errors, units: out };
}

// ── 读端门 ──────────────────────────────────────────────────────────────────

/**
 * 按可见层过滤单元 —— **三层隔离唯一真正起作用的地方**。
 *
 * ⛔ 默认最严：`tier` 省略或无法识别 ⇒ 按 `EVOLUTION` 过滤。
 *    想看全部必须显式传 `'ALL'`（清单/全量门禁的口径），不传就拿最窄视图。
 *    理由：隔离的价值在于「进化路径默认看不见 Frozen」，把宽视图做成默认
 *    等于把门开成默认开 —— 与本项目「fail-closed」纪律相反。
 *
 * @param {Array<{visibility?: string}>} units
 * @param {'EVOLUTION'|'VALIDATION'|'FROZEN'|'ALL'} [tier]
 */
export function selectVisible(units, tier) {
  const list = Array.isArray(units) ? units : [];
  if (tier === 'ALL') return [...list];
  const want = TIER_VALUES.includes(tier) ? tier : DEFAULT_TIER;
  return list.filter((u) => u.visibility === want);
}

/**
 * 断言「给出去的这批单元里，没有任何一条属于别的层」。
 *
 * 为什么在 `selectVisible` 之外还要一层：过滤写错（比如写成 `!==`）时，
 * 返回值仍然是个数组，调用方看不出来。这道断言把「漏出」变成硬错误。
 *
 * @param {Array<{unitId?: string, visibility?: string}>} units
 * @param {'EVOLUTION'|'VALIDATION'|'FROZEN'} tier
 * @returns {string[]} 错误列表（空 = 无漏出）
 */
export function assertNoLeak(units, tier) {
  const list = Array.isArray(units) ? units : [];
  if (!TIER_VALUES.includes(tier)) {
    return [`assertNoLeak：tier = ${JSON.stringify(tier)} 不是合法层名`];
  }
  const leaked = list.filter((u) => u.visibility !== tier).map((u) => `${u.unitId ?? '?'}:${u.visibility}`);
  if (leaked.length === 0) return [];
  return [
    `读端门漏出：视图要求 ${tier}，但里面混了 ${leaked.length} 条别的层 —— ${leaked.slice(0, 10).join(', ')}`,
  ];
}

// ── Frozen 聚合 hash ────────────────────────────────────────────────────────

/**
 * Frozen 集的聚合 hash：把「这一版冻结集是哪些单元、各自内容是什么」压成一个值。
 *
 * 入账后即可回答「Frozen 集被偷偷改过没有」：改任一 Frozen 单元的
 * `contentHash`、增删任一 Frozen 单元，聚合 hash 都会变。
 *
 * ⚠️ 只对 `{unitId, contentHash}` 做哈希，**不含 labelAuthority** ——
 *    后者是标签维度的状态迁移（HELDOUT → GOLD 是合法的一次性降级），
 *    把它算进来会让「合法降级」被误判成「Frozen 集被篡改」。
 *
 * @param {Array<{unitId: string, contentHash: string, visibility?: string}>} units
 * @returns {string} `sha256:<64 hex>`（空集也返回合法 hash —— 空集是个事实，不是缺失）
 */
export function frozenAggregateHash(units) {
  const list = Array.isArray(units) ? units : [];
  const frozen = list
    .filter((u) => u.visibility === 'FROZEN')
    .map((u) => ({ unitId: u.unitId, contentHash: u.contentHash }))
    .sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0));
  return canonicalHash({ tieringVersion: TIERING_VERSION, frozen }, { prefix: true });
}

/**
 * 三层计数 + 域占比（供 summary 回写，配额 §3.2 要求回写实际占比）。
 *
 * @param {Array<{visibility?: string, domain?: string}>} units
 */
export function summarizeTiers(units) {
  const list = Array.isArray(units) ? units : [];
  const tierCounts = Object.fromEntries(TIER_VALUES.map((t) => [t, 0]));
  const unknown = [];
  for (const u of list) {
    if (TIER_VALUES.includes(u.visibility)) tierCounts[u.visibility] += 1;
    else unknown.push(String(u.visibility));
  }
  const total = list.length;
  const domainCounts = {};
  for (const u of list) domainCounts[u.domain ?? 'UNKNOWN'] = (domainCounts[u.domain ?? 'UNKNOWN'] || 0) + 1;
  return {
    total,
    tierCounts,
    tierSum: TIER_VALUES.reduce((a, t) => a + tierCounts[t], 0),
    unknownVisibility: unknown,
    domainCounts: Object.fromEntries(Object.entries(domainCounts).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

/**
 * 单域占比（quality 单域主导风险的观测字段）。
 *
 * @param {Array<{domain?: string}>} units
 * @param {string} domain
 */
export function domainRatio(units, domain) {
  const list = Array.isArray(units) ? units : [];
  const total = list.length;
  const count = list.filter((u) => u.domain === domain).length;
  return { domain, count, total, ratio: total === 0 ? 0 : count / total };
}

// ── 判据 ────────────────────────────────────────────────────────────────────

/**
 * tier 分配合法性判据。纯函数：不读盘、不取时钟。
 *
 * 覆盖：
 *   - 枚举封闭（visibility / labelAuthority）
 *   - H5 Validation 与 Frozen 只增不减（对 `previousFrozenIds` 做子集检查）
 *   - H3 随 fail 数重算（Frozen 里的存量 fail 探针 ≤ h3FrozenFailProbeCap）
 *   - H1 Evolution 保留 ≥⌈0.6×fail数⌉ 个 fail
 *   - H4 低样本量域（< 3 单元）不得进 Frozen
 *   - quality 占比回写（返回 observed 供调用方写进 summary）
 *
 * @param {object} input
 * @param {Array<{unitId:string, visibility:string, labelAuthority:string, domain:string, lastKnownStatus?:string}>} input.units
 * @param {string[]} [input.previousFrozenIds] 上一版入账的 Frozen 名单（H5 基线）
 * @param {number} [input.failCount] 存量 fail 数（**必须已排除负控制**，即等于本函数
 *        按 units 实算出的真存量 fail 数）。省略时从 units 里数
 *        `lastKnownStatus === 'FAIL' && negativeControl !== true`。
 *        ⛔ 传「含负控制」的全量 FAIL 数会被口径护栏判为 error（2026-10-04 起）——
 *        分子分母不同口径会让 H1 下限虚高到数学上永不可满足。
 * @param {boolean} [input.statusKnown=true] units 里的 lastKnownStatus 是不是**实测值**。
 *        ⛔ 静态门禁（不跑 driver）必须传 false —— 那时 H1/H3 的输入根本不存在，
 *        拿上一版的 fail 数去配这一版「0 个 FAIL」会**稳定产出假阳性**。
 *        跳过必须显式记进 `observed.skipped`，不许静默通过（静默 = 假防线）。
 * @param {object} [input.quota] { evolution, validation, frozen }；给了才校验配额数（默认不校验）
 * @returns {{ok: boolean, errors: string[], observed: object}}
 */
export function checkTierAssignment(input = {}) {
  const units = Array.isArray(input.units) ? input.units : [];
  const errors = [];

  // ── 枚举封闭 ──
  const tierCounts = Object.fromEntries(TIER_VALUES.map((t) => [t, 0]));
  const labelCounts = Object.fromEntries(LABEL_AUTHORITY_VALUES.map((t) => [t, 0]));
  for (const u of units) {
    if (!TIER_VALUES.includes(u.visibility)) {
      errors.push(`${u.unitId}：visibility = ${JSON.stringify(u.visibility)} 不在枚举 ${TIER_VALUES.join('/')}`);
    } else {
      tierCounts[u.visibility] += 1;
    }
    if (!LABEL_AUTHORITY_VALUES.includes(u.labelAuthority)) {
      errors.push(
        `${u.unitId}：labelAuthority = ${JSON.stringify(u.labelAuthority)} 不在枚举 ${LABEL_AUTHORITY_VALUES.join('/')}`,
      );
    } else {
      labelCounts[u.labelAuthority] += 1;
    }
  }

  // ⛔⛔ 2026-10-04（A3 槽位 1 踩到）：**负控制（negative control）必须从 fail 集合里排除。**
  //
  // 负控制 = 「故意构造 inputs 让判据变红」的测试夹具，用来证明判据真在守。
  // 它们**预期就是 FAIL** —— 若把它们算进 failCount，会：
  //   ① 污染 H1 下限（本轮：4 个真存量 + 3 个负控制 ⇒ H1 从 4 变 5，
  //      而真实存量只有 4 个 ⇒ 判据要求「保留 5 个 fail」永远不可能满足）；
  //   ② 污染 A4 归因器与 driver 的 fail 队列（归因会去找根本不存在的缺陷）。
  //
  // 判定口径用**显式字段** `negativeControl: true`（写在场景的 `_meta` 里、由生成器带下来），
  // ⛔ 不用「id 里有 negctl 字样」这类隐式约定 —— 隐式约定无法审计、改个名就失效。
  const isNegativeControl = (u) => u?.negativeControl === true;
  const failUnits = units.filter((u) => u.lastKnownStatus === 'FAIL' && !isNegativeControl(u));
  const negativeControlCount = units.filter(
    (u) => u.lastKnownStatus === 'FAIL' && isNegativeControl(u),
  ).length;

  // ⛔⛔ 2026-10-04：failCount 入参与内部自算的**口径一致性护栏**。
  //
  // 背景（真实事故）：调用方 build-scenario-inventory.mjs 传的是 `measured.fail`
  // —— driver 报的全部 FAIL，**含负控制**（7）；而本函数内部的 failUnits 已按
  // `!isNegativeControl` 排除负控制（4）。同一个「存量 fail 数」在上下游用了两套
  // 口径 ⇒ 分子按 4 算、分母按 7 算 ⇒ h1min = ⌈0.6×7⌉ = 5，而真实可用存量
  // 总共只有 4 个 ⇒ **H1 在数学上永不可满足**，无论怎么调 tier 划分都过不了。
  //
  // 为什么之前没人发现：判据只管算，不问「你给我的数和我说的一样吗」。
  // 数值恰好合法（7 是正整数）⇒ 静默接受 ⇒ 死锁表现为「内容层样本不足」的
  // 假象，把排查引向完全错误的方向（我第一轮就判成了「清单是旧数据生成的」）。
  //
  // 现在入参与自算冲突时**直接报错**，把口径漂移变成显式失败。
  // 静态门禁（statusKnown=false）下 units 全是 UNKNOWN、自算为 0，此时入参是
  // 唯一来源、不校验 —— 但那一档本来就跳过 H1/H3，不构成同类风险。
  const failCountSelf = failUnits.length;
  const failCountGiven = input.failCount;
  const failCountGivenNum = Number(failCountGiven);
  const hasGiven =
    failCountGiven !== undefined &&
    failCountGiven !== null &&
    Number.isFinite(failCountGivenNum);
  const failCount = hasGiven ? failCountGivenNum : failCountSelf;
  if (input.statusKnown !== false && hasGiven && failCountGivenNum !== failCountSelf) {
    errors.push(
      `failCount 口径不一致：调用方传 ${failCountGivenNum}，但按 units 实算真存量 fail 为 ` +
        `${failCountSelf}（含负控制 ${negativeControlCount} 个，已按约定排除）。` +
        `两者必须同口径 —— 分子分母不一致会让 H1 下限虚高，` +
        `表现为「进化档样本不足」的假象。修法：调用方应传「排除负控制后的 FAIL 数」。`,
    );
  }

  const frozenIds = units.filter((u) => u.visibility === 'FROZEN').map((u) => u.unitId);
  const frozenSet = new Set(frozenIds);

  // ── H5：Frozen 只增不减 ──
  const prev = Array.isArray(input.previousFrozenIds) ? input.previousFrozenIds : null;
  const removed = prev ? prev.filter((id) => !frozenSet.has(id)) : [];
  if (removed.length > 0) {
    errors.push(
      `H5 违例：Frozen 集缩减了 ${removed.length} 个（${removed.slice(0, 10).join(', ')}）。` +
        `Frozen 与 Validation 只增不减 —— 缩减即视为基准被污染。`,
    );
  }

  // ── H3 / H1 依赖「这一版单元的实测状态」，静态门禁下输入不存在 ⇒ 显式跳过 ──
  const statusKnown = input.statusKnown !== false;
  const skipped = [];
  const cap = h3FrozenFailProbeCap(failCount);
  const minFail = h1EvolutionMinFail(failCount);

  if (!statusKnown) {
    skipped.push('H1', 'H3');
  } else {
    // ── H3：Frozen 里存量 fail 探针的上限随 fail 数重算 ──
    const frozenFailProbes = failUnits.filter((u) => u.visibility === 'FROZEN');
    if (frozenFailProbes.length > cap) {
      errors.push(
        `H3 违例：Frozen 里有 ${frozenFailProbes.length} 个存量 fail 探针，上限 ${cap}` +
          `（= fail 数 ${failCount} − ⌈0.6 × ${failCount}⌉ = ${minFail}）。` +
          `fail 数变化后必须重算，不得沿用旧上限。`,
      );
    }

    // ── H1：Evolution 必须保留 ≥⌈0.6×fail数⌉ 个 fail ──
    const evolutionFails = failUnits.filter((u) => u.visibility === 'EVOLUTION').length;
    if (evolutionFails < minFail) {
      errors.push(
        `H1 违例：Evolution 只保留 ${evolutionFails} 个存量 fail，下限 ${minFail}` +
          `（= ⌈0.6 × ${failCount}⌉）。进化集看不见足够的失败样本 ⇒ 学不到东西。`,
      );
    }
  }

  // ── H4：低样本量域不得进 Frozen ──
  const domainTotals = {};
  for (const u of units) domainTotals[u.domain ?? 'UNKNOWN'] = (domainTotals[u.domain ?? 'UNKNOWN'] || 0) + 1;
  for (const u of units.filter((x) => x.visibility === 'FROZEN')) {
    const d = u.domain ?? 'UNKNOWN';
    if ((domainTotals[d] ?? 0) < H4_MIN_DOMAIN_UNITS) {
      errors.push(
        `H4 违例：${u.unitId} 属 domain=${d}，该域只有 ${domainTotals[d]} 个单元 < ${H4_MIN_DOMAIN_UNITS}` +
          ` ⇒ 不得进 Frozen（样本量不足，进了也检不出该域的能力变化）。`,
      );
    }
  }

  // ── 配额（可选：只在显式给了 quota 时才校验）──
  if (input.quota && typeof input.quota === 'object') {
    for (const t of ['evolution', 'validation', 'frozen']) {
      const want = input.quota[t];
      if (!Number.isFinite(Number(want))) continue;
      const key = t.toUpperCase();
      if (tierCounts[key] !== Number(want)) {
        errors.push(`配额不符：${key} 实得 ${tierCounts[key]}，额定 ${want}（quota 来自 three-tier-quota.md §1）`);
      }
    }
  }

  const observed = {
    tierCounts,
    labelAuthorityCounts: labelCounts,
    failCount,
    // ⛔ failCount 的来源与自算值都要可观测：口径漂移是本函数唯一无法自查的错误
    //   （数值合法、算得出结果、只是分母大了）。不暴露自算值，排查就只能靠猜。
    failCountGiven: hasGiven ? failCountGivenNum : null,
    failCountSelfComputed: failCountSelf,
    failCountSource: hasGiven ? 'caller' : 'self-computed',
    // ⛔ 负控制被排除这件事必须**可观测**：静默排除 = 调用方看到 failCount 变小却不知道为什么
    //   （本轮真发生过：H1 从 4 悄悄变 5，没人知道是哪 3 个负控制干的）。
    //   显式列出数量与 id 名单，调用方能自己判断这个排除合不合理。
    negativeControlCount,
    negativeControlIds: units
      .filter((u) => u.lastKnownStatus === 'FAIL' && isNegativeControl(u))
      .map((u) => u.unitId),
    h1EvolutionMinFail: minFail,
    h3FrozenFailProbeCap: cap,
    frozenCount: frozenIds.length,
    frozenAggregateHash: frozenAggregateHash(units),
    qualityRatio: domainRatio(units, 'quality'),
    // ⛔ 显式列出被跳过的判据。静默跳过 = 调用方以为查过了 —— 那是假防线。
    skipped,
    statusKnown,
  };

  return { ok: errors.length === 0, errors, observed };
}
