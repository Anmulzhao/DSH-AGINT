#!/usr/bin/env node
/**
 * bin/propose-frozen-candidates.mjs —— Frozen 首期 10 单元**候选提案**（只读）
 *
 * ## 它与 anchor-frozen-set.mjs 的分工
 *
 *   anchor-frozen-set.mjs   回答「当前清单里 Frozen 是谁、能不能入账」—— 快照预览
 *   本脚本                  回答「首期 10 个该选谁」—— 候选提案
 *
 * ⛔ 本脚本**不改任何东西**：不写 sidecar、不写清单、不入账。
 *   分配是老板的决定，本脚本只把「哪些能选、为什么选它、有什么约束」摆出来。
 *
 * ## 为什么要机器挑，而不是我挑
 *
 * 首期 10 个要同时满足四条算术约束（H1/H2/H3/H4），
 * 而其中三条（H2 新编写比例、H3 fail 探针上限、H4 域最小单元数）
 * 在不同 fail 数 / 域分布下会给出不同答案。人手挑过一次，
 * 下次 fail 数一变（现在是 6）约束就漂了，而没人会重算。
 *
 * ⇒ 候选由 `checkTierAssignment()` 的同一份判据算出并**当场验证**。
 *   本脚本末尾会把候选方案喂回判据层，输出 H2/H3/H4 的实测校验结果；
 *   若不满足，脚本报 NOT_SATISFIED 而不是硬凑一个 10。
 *
 * ## ⛔ 新编写单元当前是 0 个 —— 这不是疏漏
 *
 * H2 要求 Frozen 里 ≥60% 是新编写的。仓库里**一个新编的 Frozen 单元都没有**
 * （123 个全是存量）。所以本提案给的是「6 个待创作槽位」而不是 6 个具体单元：
 * 槽位带「该覆盖哪个域 / 为什么」，具体场景要人写。
 * ⛔ 绝不把存量单元包装成「新编写」来凑 H2 —— 那是把判据糊过去，
 *   而 H2 的整个作用就是防止「用见过的题考自己」。
 *
 * 用法：
 *   node bin/propose-frozen-candidates.mjs
 *   node bin/propose-frozen-candidates.mjs --json
 *   node bin/propose-frozen-candidates.mjs --inventory <路径>
 *   node bin/propose-frozen-candidates.mjs --out docs/frozen-first-batch-proposal-<日期>.md
 *   node bin/propose-frozen-candidates.mjs --previous-frozen auto|none|<id,id,…>
 *   node bin/propose-frozen-candidates.mjs --strategy blind-first|existing-first
 *   node bin/propose-frozen-candidates.mjs --spare <n>
 * 退出码：0 = 提案自洽（判据全过）· 1 = 约束不满足 · 2 = 脚本自身出错
 *
 * ## ⛔ 2026-10-09 修：H5 基线与「已锚集合」此前完全没进本脚本
 *
 * 现象：`frozen-2026-10-04T17-17-14-144Z` 早已入账 4 个 Frozen 单元，而本脚本
 * 把每个单元的 visibility 一律重置成 EVOLUTION 再重选，于是产出的「首期 10」
 * 实际是一个**替换集**：它只保留了旧锚 4 个里的 1 个。判据层 H5「只增不减」
 * （`scenario-tier.mjs` 对 `previousFrozenIds` 做子集检查）在门禁里会红，
 * 但本脚本自检时**根本没传 previousFrozenIds** ⇒ 自检静默跳过 H5 ⇒
 * 提案自称「判据全过」，实跑必被门禁拒。
 *
 * 修法（两处，缺一不可）：
 *   1. 旧锚单元**先锁定**为 FROZEN 并计入名额，剩余名额才参与分配；
 *   2. 自检把 `previousFrozenIds` 传进 `checkTierAssignment`，H5 进 `satisfied`。
 * 默认从 inventory 的 `tierBaseline.frozenUnitIds` 读基线（`--previous-frozen none` 可关）。
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkTierAssignment,
  frozenAggregateHash,
  h1EvolutionMinFail,
  h3FrozenFailProbeCap,
  H1_EVOLUTION_FAIL_RATIO,
  H2_FROZEN_NEW_RATIO,
  H4_MIN_DOMAIN_UNITS,
} from './lib/scenario-tier.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const DEFAULT_INVENTORY = join(REPO_ROOT, 'eval', 'scenarios', 'inventory.json');

/** 首期 Frozen 名额（设计稿 §2.4.3：新编 6 + 现有 4 = 10）。 */
export const FIRST_PHASE_SIZE = 10;

/**
 * ⛔ 真实存量 fail（**排除负控制**）—— 2026-10-04 A3 槽位 1 踩到。
 *
 * 负控制（`negativeControl: true`）是「故意让判据变红」的测试夹具，
 * **预期就是 FAIL**，不算真实缺陷。`scenario-tier.mjs` 的 `checkTierAssignment`
 * 已把它们从 `failCount` 里排除；本模块原先**自己数 `lastKnownStatus === 'FAIL'`**
 * ⇒ 两边口径不一致（判据说 4、提案器说 7）⇒ 提案自相矛盾、H1/H3 全错。
 *
 * ⇒ 三处数 fail 全部改走这一个过滤器，**不各数一套**。
 * 口径与 `checkTierAssignment` 逐字一致（判据不信脚本自述，两边同源）。
 */
export const isRealFail = (u) => u?.lastKnownStatus === 'FAIL' && u?.negativeControl !== true;
export const realFails = (units) => units.filter(isRealFail);

/**
 * 安全红线域 —— 漏检代价**不对称地高**，故在未覆盖域里享有最高优先级。
 * 这不是偏好：安装器的路径穿越 / 覆盖 / 回滚一旦回归，损失远大于同规模的
 * 功能性退化，而它在 Frozen 里 0 覆盖时**完全不可见**。
 */
export const SECURITY_CRITICAL_DOMAINS = Object.freeze(['install-security']);

/**
 * 盲区解锁的**顺序**（不是按缺口大小机械排序）。
 *
 * 两条互相拉扯的判据，显式写成常量才不会每次靠临场感觉：
 *   ① 解锁效率（新增可见域 / 投入名额）：cron / metrics 各缺 1 ⇒ 1.0 域 per 名额；
 *      memory / dream 各缺 2 ⇒ 0.5。⇒ 便宜的先做。
 *   ② 盲区的**严重性**：memory 与 dream 都只有 1 个单元，是
 *      `evaluation-protocol-v1.md` §7 限制 1 登记的最严重盲区 —— 这两个域的
 *      能力退化在 Frozen 里**完全不可观测**。但二者写作确定性差很远：
 *      memory 的写入 / 召回 / decay 语义可写确定性断言；dream 依赖 LLM 生成
 *      与跨夜整合，断言最脆，flaky 风险最高 ⇒ 排最后，宁可留到下一期。
 * ⇒ 顺序：cron（最便宜）→ metrics（最便宜）→ memory（核心盲区，值得 2 名额）
 *        → dream（最脆，名额有剩才做）。
 */
export const BLIND_SPOT_UNLOCK_ORDER = Object.freeze(['cron', 'metrics', 'memory', 'dream']);

/**
 * 值得用**低效率**换的核心盲区（当前只有 memory）。
 *
 * 效率 = 新增可见域 / 投入名额：memory 缺 2 ⇒ 0.5 域 per 名额，而给一个
 * 未覆盖的合格域写 1 个单元就是 1.0。纯按效率排，memory 该排在 cover 之后。
 * 但 memory 是「进化到底有没有学到东西」的最终载体：它 0 覆盖意味着
 * 记忆能力的退化在 Frozen 里**完全不可观测**（§7 限制 1 的两个域之一）。
 * ⇒ 明确接受 0.5 的效率，把它排在 cover 之前。dream 不接受 —— 它同样缺 2，
 *   但断言依赖 LLM 生成与跨夜整合，flaky 风险最高，宁可留到下一期。
 */
export const CORE_BLIND_SPOT_DOMAINS = Object.freeze(['memory']);

/** 槽位分配策略。默认 `blind-first`（见 allocateNewSlots 的论证）。 */
export const SLOT_STRATEGIES = Object.freeze(['blind-first', 'existing-first']);
export const DEFAULT_SLOT_STRATEGY = 'blind-first';

// ── 候选筛选（纯函数）─────────────────────────────────────────────────────

/**
 * 哪些域可以进 Frozen —— H4：该域单元数必须 ≥ `H4_MIN_DOMAIN_UNITS`。
 *
 * ⭐ 这一条会**直接否掉 4 个域 6 个单元**：cron(2) / dream(1) / memory(1) / metrics(2)。
 *   其中 dream 与 memory 只有 1 个单元，是 `evaluation-protocol-v1.md` §7 限制 1
 *   登记的那个盲区（这两个域的能力提升无法被 Frozen 检出）——
 *   本脚本把它量化成「要进 Frozen，得先给该域各写 2 个单元」。
 */
export function eligibleDomains(units) {
  const totals = {};
  for (const u of units) {
    const d = u.domain ?? 'UNKNOWN';
    totals[d] = (totals[d] ?? 0) + 1;
  }
  const eligible = [];
  const blocked = [];
  for (const [domain, count] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
    const entry = { domain, unitCount: count, eligible: count >= H4_MIN_DOMAIN_UNITS };
    if (entry.eligible) eligible.push(entry);
    else {
      blocked.push({
        ...entry,
        shortBy: H4_MIN_DOMAIN_UNITS - count,
        note: `H4：该域 ${count} 个单元 < ${H4_MIN_DOMAIN_UNITS} ⇒ 不得进 Frozen。`
          + (count <= 2 ? `要解锁需先给该域新编 ${H4_MIN_DOMAIN_UNITS - count} 个单元。` : ''),
      });
    }
  }
  return { eligible, blocked, totals };
}

/**
 * 存量 fail 探针候选（FROZEN 里的存量单元按上限取几个）。
 *
 * ⛔ H3 上限是**算术结果**：cap = fail数 − ⌈0.6 × fail数⌉，随 fail 数重算。
 *   fail=6 ⇒ cap=2。这个数**不读文档常量**（three-tier-quota.md 里写的是 fail=5，
 *   那是旧快照；`benchmark-isolation-v1.md` §8 偏差 1 已记过这件事）。
 *
 * 选哪几个：在合格域内，**按域分散**优先（一个域最多取 1 个），
 * 否则 10 个 Frozen 可能全落在一个域里，测不出跨域能力变化。
 */
export function selectFailProbes(units, { cap, eligibleDomainSet }) {
  const pool = units
    .filter(isRealFail)
    .filter((u) => eligibleDomainSet.has(u.domain ?? 'UNKNOWN'))
    .sort((a, b) => {
      const da = a.domain ?? '';
      const db = b.domain ?? '';
      if (da !== db) return da.localeCompare(db);
      return String(a.unitId).localeCompare(String(b.unitId));
    });
  const picked = [];
  const usedDomains = new Set();
  const overflow = [];
  for (const u of pool) {
    if (picked.length >= cap) break;
    if (usedDomains.has(u.domain)) { overflow.push(u); continue; }
    picked.push(u);
    usedDomains.add(u.domain);
  }
  // 域不够分时（合格 fail 全落同一域）放宽：允许同域第二个，但仍受 cap 约束
  for (const u of overflow) {
    if (picked.length >= cap) break;
    picked.push(u);
  }
  const skippedByH4 = units
    .filter((u) => isRealFail(u) && !eligibleDomainSet.has(u.domain ?? 'UNKNOWN'))
    .map((u) => ({ unitId: u.unitId, domain: u.domain, reason: `H4：域 ${u.domain} 单元数不足，fail 探针也进不了 Frozen` }));
  return { picked, cap, skippedByH4, eligibleFailCount: pool.length };
}

/**
 * 存量 PASS 候选（补足 10 − 新编写 6 − fail 探针 N 的余额）。
 *
 * 选法：在合格域里按**域分散 + 域权重反比**排序 ——
 *   quality 占 46.3%，若不压低，10 个 Frozen 里会有 5 个来自同一域。
 *   排序键 = 该域当前单元占比（越低越优先），同占比按 unitId 稳定排序。
 */
export function selectExistingPasses(units, { need, eligibleDomainSet, excludeIds }) {
  const totals = {};
  for (const u of units) totals[u.domain ?? 'UNKNOWN'] = (totals[u.domain ?? 'UNKNOWN'] ?? 0) + 1;
  const total = units.length || 1;
  const pool = units
    .filter((u) => u.lastKnownStatus === 'PASS')
    .filter((u) => eligibleDomainSet.has(u.domain ?? 'UNKNOWN'))
    .filter((u) => !excludeIds.has(u.unitId))
    .map((u) => ({
      unit: u,
      domainShare: (totals[u.domain ?? 'UNKNOWN'] ?? 0) / total,
    }))
    .sort((a, b) => {
      if (a.domainShare !== b.domainShare) return a.domainShare - b.domainShare;
      const da = a.unit.domain ?? '';
      const db = b.unit.domain ?? '';
      if (da !== db) return da.localeCompare(db);
      return String(a.unit.unitId).localeCompare(String(b.unit.unitId));
    });

  const picked = [];
  const usedDomains = new Set();
  const needCount = Math.max(0, Number(need) || 0);
  // 第一轮：一域一个（最大化域覆盖）
  for (const cand of pool) {
    if (picked.length >= needCount) break;
    if (usedDomains.has(cand.unit.domain)) continue;
    picked.push(cand.unit);
    usedDomains.add(cand.unit.domain);
  }
  // 第二轮：还有缺口就放宽域约束
  for (const cand of pool) {
    if (picked.length >= needCount) break;
    if (picked.includes(cand.unit)) continue;
    picked.push(cand.unit);
  }
  return { picked, need: needCount, filled: picked.length >= needCount, domainSpread: [...usedDomains] };
}

/**
 * 新编写槽位：按合格域的**当前单元数缺口**分配。
 *
 * ⭐ 槽位分给「单元最少但已合格」的域，理由是 Frozen 集的作用是
 *   **跨域**检出能力变化。往单元已经很多的域（quality 57 个）再补题，
 *   边际信息量最低。
 *
 * ⛔ 槽位是「该写什么方向」，不是「写好了的单元」。本脚本不生成场景文件 ——
 *   创作型工作量属人，且自动生成的场景会带着生成器的偏见进基准。
 */
export function proposeNewSlots(units, { need, eligibleDomainSet }) {
  const totals = {};
  for (const u of units) totals[u.domain ?? 'UNKNOWN'] = (totals[u.domain ?? 'UNKNOWN'] ?? 0) + 1;
  const eligible = Object.entries(totals)
    .filter(([d, c]) => eligibleDomainSet.has(d) && c >= H4_MIN_DOMAIN_UNITS)
    .sort((a, b) => a[1] - b[1])            // 单元少的域优先
    .map(([domain, count]) => ({ domain, currentUnits: count }));

  const slots = [];
  let i = 0;
  while (slots.length < need && eligible.length > 0) {
    const target = eligible[i % eligible.length];
    const round = Math.floor(i / eligible.length) + 1;
    slots.push({
      slotId: `NEW-${String(slots.length + 1).padStart(2, '0')}`,
      domain: target.domain,
      round,
      currentUnits: target.currentUnits,
      direction: `为域 ${target.domain} 新编第 ${round} 个 Frozen 单元（当前该域 ${target.currentUnits} 个存量单元）`,
      acceptance: [
        `必须新增独立的 .scenario.json 单元，⛔ 不得复制现有单元的断言`,
        `入库后须重跑 node bin/build-scenario-inventory.mjs 并确认 contentHash 变化条数 = 新增条数`,
        `labelAuthority 建议标 GOLD（判定基准由人手签核，不靠模型自评）`,
      ],
    });
    i += 1;
  }
  return { slots, filled: slots.length >= need };
}

/**
 * 新编写槽位分配器（2026-10-09 新增，`blind-first` 策略）。
 *
 * ## 为什么槽位要优先投**被 H4 否掉的域**
 *
 * 一个槽位有两重收益，旧分配器只拿到了第一重：
 *   ① 恒定收益 —— 只要是新编单元，就计入 H2 的分子（任何域都行）；
 *   ② 边际收益 —— 把某个域补到 H4 门槛（≥3 单元），**解锁**该域进 Frozen 的资格；
 *      且补满后新编单元自己就占得住名额。一石二鸟。
 * ⛔ 旧分配器只投「已合格的域」⇒ ② 恒为 0 ⇒ 盲区永远不解锁：
 *   dream / memory / cron / metrics 会一直停在 Frozen 视野外。
 *
 * 解锁效率（域名额比）不同，故按**缺口升序**投：
 *   cron / metrics 各缺 1 ⇒ 1 名额解锁 1 域（1.0 域/名额）
 *   dream / memory 各缺 2 ⇒ 2 名额解锁 1 域（0.5 域/名额）
 * ⛔ 且必须**一次补齐**：给缺 2 的域只投 1 个，域数 1→2 仍 < 3 ⇒
 *   该单元自己进不了 Frozen，名额白花（这是本策略最容易踩的坑）。
 *   ⇒ 剩余名额不足 shortBy 时，跳过该域并记进 notes，绝不半途投。
 *
 * ## 为什么要排除「已被 Frozen 覆盖的域」和「纯 e2e 域」
 *
 * - 已覆盖域：Frozen 要推断的是「哪个域漂移了」。同一域的第 2 个探针只提高
 *   该域的估计精度，而名额给未覆盖域能多拿一个域的可见性 ⇒ 覆盖优先于精度。
 * - 纯 e2e 域（当前 mount 域 8 个单元全是 e2e）：Frozen 的统计量是
 *   「同一单元跨时间的结果差」，要求测量方差 << 真实漂移。e2e 依赖真实
 *   进程 / 端口 / 重启竞态，方差显著高于 integration ⇒ 会把环境噪声
 *   误报成能力回归。首期不投（排序沉底，名额够也不会先取它）。
 *
 * @returns {{slots: Array, notes: string[]}} slots 已按优先级排好，调用方取前 need 个
 */
export function allocateNewSlots({
  units = [],
  want = 0,
  eligibleDomainSet = new Set(),
  blocked = [],
  coveredDomainSet = new Set(),
  strategy = DEFAULT_SLOT_STRATEGY,
} = {}) {
  const notes = [];
  const list = Array.isArray(units) ? units : [];
  if (strategy === 'existing-first') {
    return { slots: proposeNewSlots(list, { need: want, eligibleDomainSet }).slots, notes };
  }

  const totals = {};
  const kinds = {};
  for (const u of list) {
    const d = u.domain ?? 'UNKNOWN';
    totals[d] = (totals[d] ?? 0) + 1;
    kinds[d] = kinds[d] ?? new Set();
    if (u.kind) kinds[d].add(u.kind);
  }
  const total = list.length || 1;
  const plan = [];

  // ── 阶段 1：高性价比解锁（缺 1 个的域 + 核心盲区白名单）──
  const rank = (d) => {
    const i = BLIND_SPOT_UNLOCK_ORDER.indexOf(d);
    return i < 0 ? BLIND_SPOT_UNLOCK_ORDER.length : i;
  };
  const isCore = (d) => CORE_BLIND_SPOT_DOMAINS.includes(d);
  const ordered = [...blocked].sort(
    (a, b) =>
      rank(a.domain) - rank(b.domain)
      || (a.shortBy ?? 0) - (b.shortBy ?? 0)
      || String(a.domain).localeCompare(String(b.domain)),
  );
  const unlockRest = [];
  const takeUnlock = (b) => {
    const need = b.shortBy ?? H4_MIN_DOMAIN_UNITS - b.unitCount;
    if (need > want - plan.length) {
      notes.push(
        `域 ${b.domain} 还差 ${need} 个单元才达 H4，本轮剩余名额 ${want - plan.length} 不足`
        + ` ⇒ 不给它槽位（投一半解锁不了，名额白花），留到下一期。`,
      );
      return;
    }
    for (let k = 0; k < need; k += 1) {
      plan.push({ domain: b.domain, phase: 'unlock', unlockIndex: k + 1, unlockNeed: need });
    }
  };
  for (const b of ordered) {
    if (plan.length >= want) break;
    // ⛔ 缺 ≥2 且不在核心白名单里的域（当前是 dream）**先不投**：
    //   它的解锁效率 0.5 域/名额，低于给未覆盖合格域写 1 个单元（1.0）。
    //   名额有剩（阶段 3）再回来投它，绝不让它挤掉阶段 2 的保底覆盖。
    if ((b.shortBy ?? 0) > 1 && !isCore(b.domain)) {
      unlockRest.push(b);
      continue;
    }
    takeUnlock(b);
  }

  // ── 阶段 2：未覆盖的合格域（安全红线 → 非纯 e2e → 域占比降序）──
  const coverPool = [...eligibleDomainSet]
    .filter((d) => !coveredDomainSet.has(d))
    .map((d) => ({
      domain: d,
      share: (totals[d] ?? 0) / total,
      security: SECURITY_CRITICAL_DOMAINS.includes(d),
      e2eOnly: (kinds[d]?.size ?? 0) === 1 && kinds[d].has('e2e'),
    }))
    .sort(
      (a, b) =>
        Number(b.security) - Number(a.security)
        || Number(a.e2eOnly) - Number(b.e2eOnly)
        || b.share - a.share
        || a.domain.localeCompare(b.domain),
    );
  for (let i = 0; plan.length < want && coverPool.length > 0; i += 1) {
    const t = coverPool[i % coverPool.length];
    plan.push({ domain: t.domain, phase: 'cover', round: Math.floor(i / coverPool.length) + 1 });
  }

  // ── 阶段 3：名额还有剩 ⇒ 回到阶段 1 里被跳过的低效率解锁域 ──
  for (const b of unlockRest) {
    if (plan.length >= want) break;
    takeUnlock(b);
  }
  if (unlockRest.length && plan.length < want) {
    notes.push(`低效率解锁域（${unlockRest.map((b) => b.domain).join(', ')}）本轮拿不满名额 ⇒ 留到下一期。`);
  }

  // ── 阶段 4：还不够就退回合格域轮转（含已覆盖域），绝不空着 ──
  if (plan.length < want) {
    for (const s of proposeNewSlots(list, { need: want - plan.length, eligibleDomainSet }).slots) {
      plan.push({ domain: s.domain, phase: 'fallback' });
    }
  }

  const slots = plan.slice(0, want).map((p, idx) => {
    const n = String(idx + 1).padStart(2, '0');
    const cur = totals[p.domain] ?? 0;
    const why =
      p.phase === 'unlock'
        ? `解锁域 ${p.domain}：该域当前 ${cur} 个单元 < ${H4_MIN_DOMAIN_UNITS} ⇒ 补第 ${p.unlockIndex}/${p.unlockNeed} 个，补齐后该域合格`
        : p.phase === 'cover'
          ? ` Frozen 尚未覆盖域 ${p.domain}（第 ${p.round} 轮）`
          : `补足余额：为域 ${p.domain} 新编第 ${p.round ?? 1} 个 Frozen 单元`;
    return {
      slotId: `NEW-${n}`,
      domain: p.domain,
      phase: p.phase,
      currentUnits: cur,
      direction: `为域 ${p.domain} 新编第 ${
        plan.slice(0, idx + 1).filter((x) => x.domain === p.domain).length
      } 个 Frozen 单元（当前该域 ${cur} 个存量单元）`,
      why,
      acceptance: [
        '必须新增独立的 .scenario.json 单元，⛔ 不得复制现有单元的断言',
        '入库后须重跑 node bin/build-scenario-inventory.mjs 并确认 contentHash 变化条数 = 新增条数',
        'labelAuthority 建议标 GOLD（判定基准由人手签核，不靠模型自评）',
      ],
    };
  });
  return { slots, notes };
}

// ── 提案主体 ──────────────────────────────────────────────────────────────

/**
 * 生成首期 Frozen 候选提案（纯函数）。
 *
 * @param {object} input
 * @param {Array} input.units inventory.json 的 units
 * @param {number} [input.failCount] 存量 fail 数；省略则从 units 数
 * @param {number} [input.size] 名额，默认 10
 */
export function proposeFrozenCandidates({
  units = [],
  failCount = null,
  size = FIRST_PHASE_SIZE,
  proposalSummaryFailCount = null,
  previousFrozenIds = null,
  spareSlots = 1,
  strategy = DEFAULT_SLOT_STRATEGY,
} = {}) {
  const list = Array.isArray(units) ? units : [];
  const fail = Number.isFinite(Number(failCount)) && failCount !== null
    ? Number(failCount)
    : realFails(list).length;

  const dom = eligibleDomains(list);
  const eligibleDomainSet = new Set(dom.eligible.map((d) => d.domain));

  // H2：≥60% 必须是新编写 ⇒ 向上取整。这是算术，不是偏好。
  const newRequired = Math.ceil(H2_FROZEN_NEW_RATIO * size);
  const cap = h3FrozenFailProbeCap(fail);
  const minFail = h1EvolutionMinFail(fail);

  // ── H5：已入账的 Frozen 只增不减 ⇒ 先锁定，再谈分配 ──────────────────
  // ⛔ 2026-10-09 前本脚本没有这一步：全员重置成 EVOLUTION 后重选，
  //    等于提议「替换」已锚集合，而门禁的 H5 只增不减会直接判违例。
  const prevRaw = Array.isArray(previousFrozenIds) ? previousFrozenIds : [];
  const prevIds = [...new Set(prevRaw.map((x) => String(x)).filter(Boolean))];
  const byId = new Map(list.map((u) => [u.unitId, u]));
  const lockedIds = prevIds.filter((id) => byId.has(id));
  const lockedMissing = prevIds.filter((id) => !byId.has(id));
  const lockedUnits = lockedIds.map((id) => byId.get(id));

  // 名额扣掉已锚部分后，剩下的才由「新编 + 存量新增」分。
  // ⛔ H2 的分子按**全集**算（⌈0.6 × size⌉），不是按剩余算 —— 否则旧锚越多
  //    新编要求越低，H2 会被悄悄稀释。
  const remaining = size - lockedIds.length;
  const existingQuota = remaining - newRequired - 0;
  const quotaConflict = existingQuota < 0; // 旧锚太多 ⇒ 名额装不下新编要求

  const probes = selectFailProbes(list, { cap, eligibleDomainSet });
  const passes = selectExistingPasses(list, {
    need: Math.max(0, Math.min(existingQuota - probes.picked.length, remaining)),
    eligibleDomainSet,
    excludeIds: new Set([...probes.picked.map((u) => u.unitId), ...lockedIds]),
  });

  const coveredDomainSet = new Set(
    [...lockedUnits, ...probes.picked, ...passes.picked].map((u) => u.domain ?? 'UNKNOWN'),
  );
  // 热备：H2 余量恰为 0（6/10 = 60.0%），任何一个新编单元写不出来就违规
  // ⇒ 多排 `spareSlots` 个候补槽位，不计入名额，出问题时顶上而不是降额。
  const alloc = allocateNewSlots({
    units: list,
    want: newRequired + Math.max(0, Number(spareSlots) || 0),
    eligibleDomainSet,
    blocked: dom.blocked,
    coveredDomainSet,
    strategy,
  });
  const news = { slots: alloc.slots.slice(0, newRequired) };
  const spare = alloc.slots.slice(newRequired);

  const chosenIds = [...probes.picked, ...passes.picked].map((u) => u.unitId);
  // ⛔ 已锚单元占名额（它们是 Frozen 的一部分），别把它漏在合计外 ——
  //    漏掉会让「合计 10」在现实里变成 14。
  const totalChosen = lockedIds.length + chosenIds.length + news.slots.length;

  // ── 当场把候选方案喂回判据层验证 ──
  // 判据层吃的是「单元 + visibility」，而新编写槽位此刻**还不是单元**。
  // ⇒ 用「影子单元」喂：只验 H3（fail 探针数）与 H4（域单元数），
  //    H1 验的是 EVOLUTION 侧保留量，H2 由配额算术保证（见 satisfied.h2）。
  //
  // ⛔ 2026-10-09：① 已锚单元必须保持 FROZEN（不是先全设 EVOLUTION 再重选）；
  //    ② 必须把 previousFrozenIds 传进去，否则 H5 根本不会被评估 —— 这正是
  //    本脚本此前「自称全过、实跑被门禁拒」的原因。
  const shadowUnits = list.map((u) => ({ ...u, visibility: 'EVOLUTION' }));
  for (const id of lockedIds) {
    const idx = shadowUnits.findIndex((u) => u.unitId === id);
    if (idx >= 0) shadowUnits[idx] = { ...shadowUnits[idx], visibility: 'FROZEN' };
  }
  for (const id of chosenIds) {
    const idx = shadowUnits.findIndex((u) => u.unitId === id);
    if (idx >= 0) shadowUnits[idx] = { ...shadowUnits[idx], visibility: 'FROZEN' };
  }
  // 新编槽位也要进影子集：H4 判的是「该域**总**单元数」，解锁域（cron/metrics/memory）
  // 靠的就是把槽位算进去才够 3 个。不算进去 ⇒ H4 会误判解锁失败。
  for (const s of news.slots) {
    shadowUnits.push({
      unitId: `SHADOW-${s.slotId}`,
      domain: s.domain,
      visibility: 'FROZEN',
      labelAuthority: 'GOLD',
      lastKnownStatus: 'PASS',
      negativeControl: false,
    });
  }
  const verdict = checkTierAssignment({
    units: shadowUnits,
    statusKnown: true,
    failCount: fail,
    previousFrozenIds: prevIds,
  });

  const h3Ok = probes.picked.length <= cap;
  // ⛔ 判据层的 H4 只在**存在 FROZEN 单元**时才检查。
  //   合格域为 0 时 proposals 里一个 FROZEN 都没有 ⇒ errors 里不会有 H4 条目
  //   ⇒ 纯「errors 无 H4」会 vacuous true，把「一个域都选不出」印成 ✅。
  //   所以额外要求：至少有一个合格域存在，否则 H4 判为不满足。
  const h4Ok = dom.eligible.length > 0 && !verdict.errors.some((e) => e.startsWith('H4'));
  const h2Ok = news.slots.length >= newRequired;
  const h1Ok = !verdict.errors.some((e) => e.startsWith('H1'));
  // H5：已入账的 Frozen 只增不减。⛔ 2026-10-09 前本脚本从不评估这一条。
  const h5Ok = !verdict.errors.some((e) => e.startsWith('H5'));

  return {
    size,
    failCount: fail,
    strategy,
    locked: {
      ids: lockedIds,
      missing: lockedMissing,
      units: lockedUnits.map(describeUnit),
      note: lockedIds.length
        ? 'H5 只增不减 ⇒ 这些单元已入账，本提案只能在此基础上加，不能替换。'
        : '无已入账 Frozen（首版无基线）⇒ H5 不约束。',
    },
    quotaConflict,
    // ⛔ 2026-10-04：负控制排除的**可观测**（静默排除 = 调用方不知道为什么 fail 数变了）。
    //   summaryFailCount = 清单汇总里的 fail 数（**含**负控制）；
    //   negativeControlCount = 被排除的负控制条数。
    //   两者之差应当等于 negativeControlCount —— 不等就是清单汇总口径坏了，要出声。
    summaryFailCount: proposalSummaryFailCount,
    negativeControlCount: list.filter(
      (u) => u?.lastKnownStatus === 'FAIL' && u?.negativeControl === true,
    ).length,
    budget: {
      newRequired,
      newRatio: H2_FROZEN_NEW_RATIO,
      failProbeCap: cap,
      failProbeCapFormula: `${fail} − ⌈${H1_EVOLUTION_FAIL_RATIO} × ${fail}⌉ = ${fail} − ${minFail}`,
      evolutionMinFail: minFail,
      h4MinDomainUnits: H4_MIN_DOMAIN_UNITS,
    },
    domains: dom,
    existing: {
      failProbes: probes.picked.map(describeUnit),
      failProbesSkippedByH4: probes.skippedByH4,
      passes: passes.picked.map(describeUnit),
      domainSpread: passes.domainSpread,
    },
    newSlots: news.slots,
    spareSlots: spare,
    slotNotes: alloc.notes,
    totals: {
      locked: lockedIds.length,
      existingChosen: chosenIds.length,
      newSlots: news.slots.length,
      spare: spare.length,
      sum: totalChosen,
      complete: totalChosen === size,
    },
    satisfied: {
      h1: h1Ok,
      h2: h2Ok,
      h3: h3Ok,
      h4: h4Ok,
      h5: h5Ok,
      noQuotaConflict: !quotaConflict,
      all: h1Ok && h2Ok && h3Ok && h4Ok && h5Ok && !quotaConflict,
    },
    verdict: {
      ok: verdict.ok,
      errors: verdict.errors,
      observed: verdict.observed,
    },
    // 候选集合一旦定下，它的聚合 hash 就是「入账后防篡改」的基线。
    // 这里给的是**存量部分**的 hash（影子单元里被标 FROZEN 的那些），
    // 新编写单元入库后 hash 会变 —— 那是预期的，不是漂移。
    // ⛔ SHADOW-* 只是为了让 H4 数到解锁域的槽位，不是真单元 ⇒ 必须排除，
    //    否则 hash 里混进「还没写出来的单元」，与入账后的真 hash 对不上。
    provisionalAggregateHash: frozenAggregateHash(
      shadowUnits.filter((u) => !String(u.unitId).startsWith('SHADOW-')),
    ),
  };
}

function describeUnit(u) {
  return {
    unitId: u.unitId,
    domain: u.domain,
    kind: u.kind,
    lastKnownStatus: u.lastKnownStatus,
    sourceFile: u.sourceFile,
    contentHash: u.contentHash,
  };
}

// ── 渲染 ──────────────────────────────────────────────────────────────────

export function renderProposal(p) {
  const L = [];
  L.push('# Frozen 首期 10 单元候选提案');
  L.push('');
  L.push(`> 生成器：\`bin/propose-frozen-candidates.mjs\`（只读）· 存量 fail ${p.failCount} 个 · 名额 ${p.size} · 槽位策略 \`${p.strategy}\``);
  L.push('> ⛔ 本文件是**提案**不是决定。分配要老板点头，入账要部署后走宿主方法');
  L.push('> `agint.evolution.recordFrozenSet(entry)`（独立进程直写会被 last-write-wins 覆盖）。');
  if (p.locked?.ids?.length) {
    L.push(`> 🔒 **已入账 ${p.locked.ids.length} 个**（H5 只增不减）⇒ 本提案是「旧 ${p.locked.ids.length} + 新增 ${p.size - p.locked.ids.length}」，不是替换。`);
  }
  L.push('');
  L.push('## 1. 名额从哪来（算术，不是偏好）');
  L.push('');
  L.push('| 约束 | 公式 | 值 | 含义 |');
  L.push('|---|---|---|---|');
  L.push(`| H2 | ⌈${p.budget.newRatio} × ${p.size}⌉ | **${p.budget.newRequired}** | Frozen 里至少这么多要新编写 |`);
  L.push(`| H3 | ${p.budget.failProbeCapFormula} | **${p.budget.failProbeCap}** | 存量 fail 探针上限 |`);
  L.push(`| H1 | ⌈${H1_EVOLUTION_FAIL_RATIO} × ${p.failCount}⌉ | **${p.budget.evolutionMinFail}** | Evolution 侧必须保留的 fail 下限 |`);
  L.push(`| H4 | 域单元数 ≥ ${p.budget.h4MinDomainUnits} | — | 单元太少的域不得进 Frozen |`);
  L.push(`| H5 | Frozen 只增不减 | **${p.locked?.ids?.length ?? 0}** 个已入账 | 这些必须在集合里，少一个即判基准被污染 |`);
  L.push('');
  L.push('> ⚠️ H3 的上限随 fail 数重算。`docs/specs/three-tier-quota.md` 记的是 fail=5 ⇒ cap=2，'
    + `那是旧快照；当前 fail=${p.failCount} ⇒ cap=${p.budget.failProbeCap}。本表不读文档常量。`);
  L.push('');

  L.push(`## 2. 已入账部分（H5 锁定 ${p.locked?.ids?.length ?? 0} 个，不占新增名额的讨论）`);
  L.push('');
  if (p.locked?.units?.length) {
    L.push('| unitId | 域 | 类型 | 状态 |');
    L.push('|---|---|---|---|');
    for (const u of p.locked.units) {
      L.push(`| \`${u.unitId}\` | ${u.domain} | ${u.kind} | ${u.lastKnownStatus} |`);
    }
  } else {
    L.push('- （无 —— 首版无基线）');
  }
  if (p.locked?.missing?.length) {
    L.push('');
    L.push(`> ⚠️ 基线里有 ${p.locked.missing.length} 个 unitId 在清单中找不到：${p.locked.missing.join(', ')}`);
  }
  L.push('');

  L.push('## 3. 存量候选（本轮新增的存量单元）');
  L.push('');
  L.push(`### 3.1 存量 fail 探针 ${p.existing.failProbes.length} 个（上限 ${p.budget.failProbeCap}）`);
  L.push('');
  if (p.existing.failProbes.length === 0) {
    L.push('- （无 —— 合格域里没有 fail 单元）');
  } else {
    L.push('| unitId | 域 | 类型 | 文件 | 选它的理由 |');
    L.push('|---|---|---|---|---|');
    for (const u of p.existing.failProbes) {
      L.push(`| \`${u.unitId}\` | ${u.domain} | ${u.kind} | \`${u.sourceFile}\` | 已知会失败的探针：进 Frozen 后若它开始通过 = 真的变了 |`);
    }
  }
  L.push('');
  if (p.existing.failProbesSkippedByH4.length > 0) {
    L.push('**被 H4 否掉的 fail 单元**（不是漏选，是该域单元数不够）：');
    L.push('');
    for (const s of p.existing.failProbesSkippedByH4) L.push(`- \`${s.unitId}\`（${s.domain}）— ${s.reason}`);
    L.push('');
  }

  L.push(`### 3.2 存量 PASS ${p.existing.passes.length} 个（补足余额）`);
  L.push('');
  L.push('> 选法：合格域里**按域占比反比**排序（单元少的域优先），一轮一域一个。');
  L.push('> 原因：quality 域占 46.3%，不压低就会把名额吃掉一半。');
  L.push('');
  if (p.existing.passes.length === 0) {
    L.push('- （无）');
  } else {
    L.push('| unitId | 域 | 类型 | 文件 |');
    L.push('|---|---|---|---|');
    for (const u of p.existing.passes) L.push(`| \`${u.unitId}\` | ${u.domain} | ${u.kind} | \`${u.sourceFile}\` |`);
    L.push('');
    L.push(`域覆盖：${p.existing.domainSpread.join(' · ')}`);
  }
  L.push('');

  L.push(`## 4. 新编写槽位 ${p.newSlots.length} 个（占 ${p.budget.newRequired} 名额）`);
  L.push('');
  L.push('> ⛔ 仓库里**新编写的 Frozen 单元当前是 0 个**（123 个全是存量）。');
  L.push('> 所以这里是**槽位**（该往哪个域写、写什么方向），不是已写好的单元。');
  L.push('> 绝不把存量单元标成「新编写」来凑 H2 —— H2 的作用就是防止「用见过的题考自己」。');
  L.push('');
  L.push('| 槽位 | 域 | 阶段 | 为什么投这里 | 该域现有单元 |');
  L.push('|---|---|---|---|---|');
  for (const s of p.newSlots) {
    L.push(`| \`${s.slotId}\` | ${s.domain} | ${s.phase} | ${s.why ?? s.direction} | ${s.currentUnits} |`);
  }
  L.push('');
  if (p.newSlots.length > 0) {
    L.push('**每个槽位的验收条件**（与槽位一一对应）：');
    L.push('');
    for (const s of p.newSlots) {
      L.push(`- **${s.slotId}**（${s.domain}）`);
      for (const a of s.acceptance) L.push(`  - ${a}`);
    }
    L.push('');
  }

  if (p.spareSlots?.length) {
    L.push(`### 4.1 热备槽位 ${p.spareSlots.length} 个（不计入名额，抵 H2 零余量）`);
    L.push('');
    L.push(`> ⚠️ H2 余量为 0：新编 ${p.budget.newRequired} / 名额 ${p.size} = ${(p.budget.newRequired / p.size * 100).toFixed(1)}%，恰好等于阈值。`);
    L.push(`> 任何一个新编单元写不出来（或不达标）⇒ 比值掉到 ${p.budget.newRequired - 1}/${p.size} ⇒ 违规。`);
    L.push('> ⇒ 多排这几个候补：正式槽位出问题时**顶上**，而不是降额或拿存量充数。');
    L.push('');
    for (const s of p.spareSlots) L.push(`- \`${s.slotId}\` — 域 ${s.domain}（${s.why ?? s.direction}）`);
    L.push('');
  }
  if (p.slotNotes?.length) {
    L.push('**分配时的取舍记录**（不是错误，是为什么某个域没拿到槽位）：');
    L.push('');
    for (const n of p.slotNotes) L.push(`- ${n}`);
    L.push('');
  }

  L.push('## 5. H4 否掉的域（要进 Frozen 得先补单元）');
  L.push('');
  L.push('| 域 | 现有单元数 | 缺口 | 说明 |');
  L.push('|---|---|---|---|');
  for (const d of p.domains.blocked) {
    L.push(`| ${d.domain} | ${d.unitCount} | ${d.shortBy} | ${d.note} |`);
  }
  L.push('');
  L.push('> `dream` 与 `memory` 各只有 1 个单元 —— 这正是 `evaluation-protocol-v1.md` §7 限制 1');
  L.push('> 登记的盲区（这两个域的能力提升无法被 Frozen 检出）。本表把它量化成具体缺口。');
  L.push('');

  L.push('## 6. 判据自检（候选方案当场喂回判据层）');
  L.push('');
  L.push('| 判据 | 结果 | 依据 |');
  L.push('|---|---|---|');
  L.push(`| H1 Evolution 保留 fail ≥ ${p.budget.evolutionMinFail} | ${p.satisfied.h1 ? '✅' : '❌'} | Evolution 层实测保留量 |`);
  L.push(`| H2 新编写 ≥ ${p.budget.newRequired} | ${p.satisfied.h2 ? '✅' : '❌'} | 槽位数 ${p.newSlots.length}（尚未写成单元） |`);
  L.push(`| H3 存量 fail 探针 ≤ ${p.budget.failProbeCap} | ${p.satisfied.h3 ? '✅' : '❌'} | 实选 ${p.existing.failProbes.length} |`);
  L.push(`| H4 域单元数 ≥ ${p.budget.h4MinDomainUnits} | ${p.satisfied.h4 ? '✅' : '❌'} | 合格域 ${p.domains.eligible.length} 个 · 判据层 H4 报错 ${p.verdict.errors.filter((e) => e.startsWith('H4')).length} 条 |`);
  L.push(`| H5 Frozen 只增不减 | ${p.satisfied.h5 ? '✅' : '❌'} | 已入账 ${p.locked?.ids?.length ?? 0} 个全部在集合内 · 判据层 H5 报错 ${p.verdict.errors.filter((e) => e.startsWith('H5')).length} 条 |`);
  L.push('');
  L.push(`合计：已入账 ${p.totals.locked} + 存量新增 ${p.totals.existingChosen} + 新写 ${p.totals.newSlots} = **${p.totals.sum}** / 名额 ${p.size} ${p.totals.complete ? '✅' : '❌ 不足'}`);
  L.push('');
  if (p.verdict.errors.length > 0) {
    L.push('判据层报的错：');
    L.push('');
    for (const e of p.verdict.errors) L.push(`- ${e}`);
    L.push('');
  }
  L.push(`候选集合的临时聚合 hash：\`${p.provisionalAggregateHash}\``);
  L.push('');
  L.push('> ⚠️ 这个 hash 只覆盖**存量部分**。新编写单元入库后 hash 必然变化 —— 那是预期的，不是漂移。');
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 下一步（按顺序）');
  L.push('');
  L.push('1. 老板点定（含热备取舍：正式槽位写不出来时用热备顶上，不许拿存量充数降 H2）');
  L.push(`2. 新写 ${p.newSlots.length} 个场景文件 → 重跑 \`build-scenario-inventory.mjs\` 确认 contentHash 变化数 = ${p.newSlots.length}`);
  L.push('3. 把集合内单元的 `visibility` 改成 `FROZEN` 写进 sidecar `eval/tiers/agint-tiering.json`（已入账的那几个别动）');
  L.push('4. 跑 `node bin/build-scenario-inventory.mjs --check` 确认判据全绿（**含 H5**：已入账单元一个都不能少）');
  L.push('5. 部署 + 重启后走 `agint.evolution.recordFrozenSet(entry)` 入账，并用 `node bin/anchor-frozen-set.mjs` 对账');
  L.push('');
  L.push('*只读脚本：它不写 sidecar、不写清单、不入账。第 3 步起需要人操作。*');
  return `${L.join('\n')}\n`;
}

// ── main ──────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const opts = {
    json: false,
    inventory: DEFAULT_INVENTORY,
    out: null,
    previousFrozen: 'auto',
    strategy: DEFAULT_SLOT_STRATEGY,
    spare: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--inventory') opts.inventory = argv[++i];
    // auto = 读 inventory 的 tierBaseline.frozenUnitIds（与门禁同源）
    // none = 假装首版无基线（只为复现旧行为，别在决策时用）
    else if (a === '--previous-frozen') opts.previousFrozen = argv[++i];
    else if (a === '--strategy') opts.strategy = argv[++i];
    else if (a === '--spare') opts.spare = Number(argv[++i]);
    else throw new Error(`未知参数：${a}`);
  }
  if (!SLOT_STRATEGIES.includes(opts.strategy)) {
    throw new Error(`未知槽位策略：${opts.strategy}（可选 ${SLOT_STRATEGIES.join(' / ')}）`);
  }
  if (!existsSync(opts.inventory)) throw new Error(`清单不存在：${opts.inventory}`);
  const inv = JSON.parse(readFileSync(opts.inventory, 'utf8'));
  const units = Array.isArray(inv.units) ? inv.units : [];
  // ⛔ 2026-10-04：原先读 `inv.summary.failCount`，那是**清单汇总**，
  //   含负控制（负控制也是 FAIL）⇒ 与 checkTierAssignment 的口径不一致
  //   （实测：判据说 4、这里说 7 ⇒ 提案自相矛盾、H1/H3 全错）。
  // ⇒ 改为**现算**并走 realFails（与判据层同源）。汇总值只作参考，不作真值。
  const failCount = realFails(units).length;
  const summaryFailCount = inv.summary?.failCount ?? null;

  // H5 基线：与门禁 `build-scenario-inventory.mjs` 同一份来源（tierBaseline.frozenUnitIds）。
  // ⛔ 不同源就是「提案按 A 算、门禁按 B 判」—— 2026-10-09 踩的正是这个。
  let previousFrozenIds = [];
  if (opts.previousFrozen === 'auto') {
    previousFrozenIds = Array.isArray(inv.tierBaseline?.frozenUnitIds) ? inv.tierBaseline.frozenUnitIds : [];
  } else if (opts.previousFrozen !== 'none') {
    previousFrozenIds = String(opts.previousFrozen).split(',').map((s) => s.trim()).filter(Boolean);
  }

  const proposal = proposeFrozenCandidates({
    units,
    failCount,
    proposalSummaryFailCount: summaryFailCount,
    previousFrozenIds,
    spareSlots: opts.spare,
    strategy: opts.strategy,
  });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(proposal, null, 2)}\n`);
  } else if (opts.out) {
    // 写提案文档不是「改状态」：不改 sidecar、不改清单、不入账。
    writeFileSync(opts.out, renderProposal(proposal), 'utf8');
    process.stdout.write(`[propose-frozen-candidates] 📄 提案已写出：${opts.out}\n`);
    process.stdout.write(
      `  名额 ${proposal.totals.sum}/${proposal.size} · 四判据 ${proposal.satisfied.all ? '全过' : '未全过'}\n`,
    );
  } else {
    process.stdout.write(renderProposal(proposal));
  }
  // ⛔ 提案不完整或判据不过 ⇒ 非 0。不硬凑。
  process.exit(proposal.satisfied.all && proposal.totals.complete ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('propose-frozen-candidates.mjs')) {
  try {
    main();
  } catch (err) {
    console.error(`[propose-frozen-candidates] ❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
