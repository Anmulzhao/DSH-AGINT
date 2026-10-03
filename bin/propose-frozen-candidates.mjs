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
 * 退出码：0 = 提案自洽（判据全过）· 1 = 约束不满足 · 2 = 脚本自身出错
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
    .filter((u) => u.lastKnownStatus === 'FAIL')
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
    .filter((u) => u.lastKnownStatus === 'FAIL' && !eligibleDomainSet.has(u.domain ?? 'UNKNOWN'))
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

// ── 提案主体 ──────────────────────────────────────────────────────────────

/**
 * 生成首期 Frozen 候选提案（纯函数）。
 *
 * @param {object} input
 * @param {Array} input.units inventory.json 的 units
 * @param {number} [input.failCount] 存量 fail 数；省略则从 units 数
 * @param {number} [input.size] 名额，默认 10
 */
export function proposeFrozenCandidates({ units = [], failCount = null, size = FIRST_PHASE_SIZE } = {}) {
  const list = Array.isArray(units) ? units : [];
  const fail = Number.isFinite(Number(failCount)) && failCount !== null
    ? Number(failCount)
    : list.filter((u) => u.lastKnownStatus === 'FAIL').length;

  const dom = eligibleDomains(list);
  const eligibleDomainSet = new Set(dom.eligible.map((d) => d.domain));

  // H2：≥60% 必须是新编写 ⇒ 向上取整。这是算术，不是偏好。
  const newRequired = Math.ceil(H2_FROZEN_NEW_RATIO * size);
  const cap = h3FrozenFailProbeCap(fail);
  const minFail = h1EvolutionMinFail(fail);

  const probes = selectFailProbes(list, { cap, eligibleDomainSet });
  const passes = selectExistingPasses(list, {
    need: size - newRequired - probes.picked.length,
    eligibleDomainSet,
    excludeIds: new Set(probes.picked.map((u) => u.unitId)),
  });
  const news = proposeNewSlots(list, { need: newRequired, eligibleDomainSet });

  const chosenIds = [...probes.picked, ...passes.picked].map((u) => u.unitId);
  const totalChosen = chosenIds.length + news.slots.length;

  // ── 当场把候选方案喂回判据层验证 ──
  // 判据层吃的是「单元 + visibility」，而新编写槽位此刻**还不是单元**。
  // ⇒ 用「影子单元」喂：只验 H3（fail 探针数）与 H4（域单元数），
  //    H1 验的是 EVOLUTION 侧保留量，H2 由配额算术保证（见 satisfied.h2）。
  const shadowUnits = list.map((u) => ({ ...u, visibility: 'EVOLUTION' }));
  for (const id of chosenIds) {
    const idx = shadowUnits.findIndex((u) => u.unitId === id);
    if (idx >= 0) shadowUnits[idx] = { ...shadowUnits[idx], visibility: 'FROZEN' };
  }
  const verdict = checkTierAssignment({ units: shadowUnits, statusKnown: true, failCount: fail });

  const h3Ok = probes.picked.length <= cap;
  // ⛔ 判据层的 H4 只在**存在 FROZEN 单元**时才检查。
  //   合格域为 0 时 proposals 里一个 FROZEN 都没有 ⇒ errors 里不会有 H4 条目
  //   ⇒ 纯「errors 无 H4」会 vacuous true，把「一个域都选不出」印成 ✅。
  //   所以额外要求：至少有一个合格域存在，否则 H4 判为不满足。
  const h4Ok = dom.eligible.length > 0 && !verdict.errors.some((e) => e.startsWith('H4'));
  const h2Ok = news.slots.length >= newRequired;
  const h1Ok = !verdict.errors.some((e) => e.startsWith('H1'));

  return {
    size,
    failCount: fail,
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
    totals: {
      existingChosen: chosenIds.length,
      newSlots: news.slots.length,
      sum: totalChosen,
      complete: totalChosen === size,
    },
    satisfied: {
      h1: h1Ok,
      h2: h2Ok,
      h3: h3Ok,
      h4: h4Ok,
      all: h1Ok && h2Ok && h3Ok && h4Ok,
    },
    verdict: {
      ok: verdict.ok,
      errors: verdict.errors,
      observed: verdict.observed,
    },
    // 候选集合一旦定下，它的聚合 hash 就是「入账后防篡改」的基线。
    // 这里给的是**存量部分**的 hash（影子单元里被标 FROZEN 的那些），
    // 新编写单元入库后 hash 会变 —— 那是预期的，不是漂移。
    provisionalAggregateHash: frozenAggregateHash(shadowUnits),
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
  L.push(`> 生成器：\`bin/propose-frozen-candidates.mjs\`（只读）· 存量 fail ${p.failCount} 个 · 名额 ${p.size}`);
  L.push('> ⛔ 本文件是**提案**不是决定。分配要老板点头，入账要部署后走宿主方法');
  L.push('> `agint.evolution.recordFrozenSet(entry)`（独立进程直写会被 last-write-wins 覆盖）。');
  L.push('');
  L.push('## 1. 名额从哪来（算术，不是偏好）');
  L.push('');
  L.push('| 约束 | 公式 | 值 | 含义 |');
  L.push('|---|---|---|---|');
  L.push(`| H2 | ⌈${p.budget.newRatio} × ${p.size}⌉ | **${p.budget.newRequired}** | Frozen 里至少这么多要新编写 |`);
  L.push(`| H3 | ${p.budget.failProbeCapFormula} | **${p.budget.failProbeCap}** | 存量 fail 探针上限 |`);
  L.push(`| H1 | ⌈${H1_EVOLUTION_FAIL_RATIO} × ${p.failCount}⌉ | **${p.budget.evolutionMinFail}** | Evolution 侧必须保留的 fail 下限 |`);
  L.push(`| H4 | 域单元数 ≥ ${p.budget.h4MinDomainUnits} | — | 单元太少的域不得进 Frozen |`);
  L.push('');
  L.push('> ⚠️ H3 的上限随 fail 数重算。`docs/specs/three-tier-quota.md` 记的是 fail=5 ⇒ cap=2，'
    + `那是旧快照；当前 fail=${p.failCount} ⇒ cap=${p.budget.failProbeCap}。本表不读文档常量。`);
  L.push('');

  L.push('## 2. 存量候选（从现有 123 个里选）');
  L.push('');
  L.push(`### 2.1 存量 fail 探针 ${p.existing.failProbes.length} 个（上限 ${p.budget.failProbeCap}）`);
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

  L.push(`### 2.2 存量 PASS ${p.existing.passes.length} 个（补足余额）`);
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

  L.push(`## 3. 新编写槽位 ${p.newSlots.length} 个（占 ${p.budget.newRequired} 名额）`);
  L.push('');
  L.push('> ⛔ 仓库里**新编写的 Frozen 单元当前是 0 个**（123 个全是存量）。');
  L.push('> 所以这里是**槽位**（该往哪个域写、写什么方向），不是已写好的单元。');
  L.push('> 绝不把存量单元标成「新编写」来凑 H2 —— H2 的作用就是防止「用见过的题考自己」。');
  L.push('');
  L.push('| 槽位 | 域 | 方向 | 该域现有单元 |');
  L.push('|---|---|---|---|');
  for (const s of p.newSlots) {
    L.push(`| \`${s.slotId}\` | ${s.domain} | ${s.direction} | ${s.currentUnits} |`);
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

  L.push('## 4. H4 否掉的域（要进 Frozen 得先补单元）');
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

  L.push('## 5. 判据自检（候选方案当场喂回判据层）');
  L.push('');
  L.push('| 判据 | 结果 | 依据 |');
  L.push('|---|---|---|');
  L.push(`| H1 Evolution 保留 fail ≥ ${p.budget.evolutionMinFail} | ${p.satisfied.h1 ? '✅' : '❌'} | Evolution 层实测保留量 |`);
  L.push(`| H2 新编写 ≥ ${p.budget.newRequired} | ${p.satisfied.h2 ? '✅' : '❌'} | 槽位数 ${p.newSlots.length}（尚未写成单元） |`);
  L.push(`| H3 存量 fail 探针 ≤ ${p.budget.failProbeCap} | ${p.satisfied.h3 ? '✅' : '❌'} | 实选 ${p.existing.failProbes.length} |`);
  L.push(`| H4 域单元数 ≥ ${p.budget.h4MinDomainUnits} | ${p.satisfied.h4 ? '✅' : '❌'} | 合格域 ${p.domains.eligible.length} 个 · 判据层 H4 报错 ${p.verdict.errors.filter((e) => e.startsWith('H4')).length} 条 |`);
  L.push('');
  L.push(`合计：存量 ${p.totals.existingChosen} + 新写 ${p.totals.newSlots} = **${p.totals.sum}** / 名额 ${p.size} ${p.totals.complete ? '✅' : '❌ 不足'}`);
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
  L.push('1. 老板从上面 10 个候选里点定（存量 4 个 + 新写 6 个的方向）');
  L.push('2. 新写 6 个场景文件 → 重跑 `build-scenario-inventory.mjs` 确认 contentHash 变化数 = 6');
  L.push('3. 把 10 个单元的 `visibility` 改成 `FROZEN` 写进 sidecar `eval/tiers/agint-tiering.json`');
  L.push('4. 跑 `node bin/build-scenario-inventory.mjs --check` 确认判据全绿（含 H5 首版无基线）');
  L.push('5. 部署 + 重启后走 `agint.evolution.recordFrozenSet(entry)` 入账，并用 `node bin/anchor-frozen-set.mjs` 对账');
  L.push('');
  L.push('*只读脚本：它不写 sidecar、不写清单、不入账。第 3 步起需要人操作。*');
  return `${L.join('\n')}\n`;
}

// ── main ──────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const opts = { json: false, inventory: DEFAULT_INVENTORY, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--inventory') opts.inventory = argv[++i];
    else throw new Error(`未知参数：${a}`);
  }
  if (!existsSync(opts.inventory)) throw new Error(`清单不存在：${opts.inventory}`);
  const inv = JSON.parse(readFileSync(opts.inventory, 'utf8'));
  const units = Array.isArray(inv.units) ? inv.units : [];
  const failCount = inv.summary?.failCount ?? null;

  const proposal = proposeFrozenCandidates({ units, failCount });
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
