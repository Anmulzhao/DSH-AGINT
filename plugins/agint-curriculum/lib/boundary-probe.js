/**
 * agint-curriculum: boundary-probe（§4.3 [1]）——能力边界探测。
 *
 * 输入 self-model snapshot（权威数据，§4.2 方案 B），输出「该练什么」的
 * 有序列表。**纯函数**：输入（capabilities + calibrationSummary + 配置 +
 * 当前时间）→ 输出（待练域列表 + unverifiable 列表），无副作用。
 *
 * 筛选规则（§4.3 [1]）：
 *   - status === 'UNCERTAIN'                    → 必练（能力缺口）
 *   - calibrationSummary.miscalibrated 命中     → 必练（校准失准，缺口同级）
 *   - status === 'CAN' 但 lastVerifiedAt 超过
 *     stale_reverify_days 未复验                → 复验
 *
 * 排序：按「缺口大小 × 久未验证」。
 *   score = gapWeight × (nowMs − lastVerifiedAtMs)
 *   gapWeight：UNCERTAIN = 2，miscalibrated = 2（缺口同级，叠加至多 4），
 *              CAN 复验 = 1
 *   lastVerifiedAt 缺失 → 视为 epoch（最久未验证，优先练）。
 *
 * C1（§4.4）：无法自动判定的域（不在 4 个模板域内）→ 不生成挑战，
 * 进入 unverifiable 列表（Q5 拍板 A：诚实留白）。
 */

import { TEMPLATE_DOMAINS } from './schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} snapshot self-model snapshot（agint.selfModel.snapshot() 返回值）
 * @param {object} opts { staleReverifyDays, nowMs }
 * @returns {{ domains: Array, unverifiable: Array }}
 */
export function probeDomains(snapshot, { staleReverifyDays = 30, nowMs = Date.now() } = {}) {
  const capabilities = Array.isArray(snapshot?.capabilities) ? snapshot.capabilities : [];
  const miscalibrated = new Set(Array.isArray(snapshot?.calibrationSummary?.miscalibrated)
    ? snapshot.calibrationSummary.miscalibrated
    : []);

  const seen = new Map(); // domain → aggregate

  for (const cap of capabilities) {
    const domain = cap?.domain;
    if (!domain || typeof domain !== 'string' || !domain.length) continue;

    const status = cap.status;
    const verifiedAt = typeof cap.lastVerifiedAt === 'string' && cap.lastVerifiedAt
      ? Date.parse(cap.lastVerifiedAt)
      : NaN;

    let reason = [];
    let gapWeight = 0;

    if (status === 'UNCERTAIN') {
      reason.push('capability UNCERTAIN（能力缺口）');
      gapWeight = Math.max(gapWeight, 2);
    }
    if (miscalibrated.has(domain)) {
      reason.push('calibration miscalibrated（校准失准）');
      gapWeight += 2; // 与 UNCERTAIN 同级缺口；叠加最多 4
    }
    if (status === 'CAN' && Number.isNaN(verifiedAt)) {
      reason.push('CAN 但无 lastVerifiedAt（从未复验）');
      gapWeight = Math.max(gapWeight, 1);
    } else if (status === 'CAN' && (nowMs - verifiedAt) > staleReverifyDays * DAY_MS) {
      const days = Math.floor((nowMs - verifiedAt) / DAY_MS);
      reason.push(`CAN 超过 ${days} 天未复验`);
      gapWeight = Math.max(gapWeight, 1);
    }

    if (gapWeight === 0) continue; // 不在任何筛选条件 → 不练

    const age = Number.isNaN(verifiedAt) ? nowMs : Math.max(0, nowMs - verifiedAt);
    const prev = seen.get(domain);
    if (prev) {
      // 同域多能力：合并 reason，权重取最大
      prev.reason = [...new Set([...prev.reason, ...reason])];
      prev.gapWeight = Math.max(prev.gapWeight, gapWeight);
      prev.age = Math.max(prev.age, age);
      prev.status = prev.status === 'UNCERTAIN' || status === 'UNCERTAIN' ? 'UNCERTAIN' : prev.status;
    } else {
      seen.set(domain, { domain, status, reason, gapWeight, age });
    }
  }

  const verifiable = [];
  const unverifiable = [];
  for (const entry of seen.values()) {
    const item = {
      domain: entry.domain,
      status: entry.status,
      reason: entry.reason,
      verifiable: TEMPLATE_DOMAINS.includes(entry.domain),
      score: entry.gapWeight * (entry.age + 1),
    };
    if (item.verifiable) {
      verifiable.push(item);
    } else {
      unverifiable.push({ ...item, reason: [...item.reason, 'domain 不在 4 个模板域内，无法自动判定（C1/Q5）'] });
    }
  }

  verifiable.sort((a, b) => b.score - a.score);
  unverifiable.sort((a, b) => b.score - a.score);

  return {
    domains: verifiable.map(({ domain, status, reason }) => ({ domain, status, reason })),
    unverifiable: unverifiable.map(({ domain, status, reason }) => ({ domain, status, reason })),
  };
}

/**
 * 同域 24h 冷却检查（7.1 风险缓解：UNCERTAIN 域过多 → 挑战生成量爆炸）。
 * @param {Array<{domain,lastGeneratedAt}>} generated 已生成的挑战（按域去重取最近）
 * @param {object} opts { cooldownHours, nowMs }
 * @returns {string[]} 冷却中（禁止生成）的域列表
 */
export function coolingDomains(generated, { cooldownHours = 24, nowMs = Date.now() } = {}) {
  const byDomain = new Map();
  for (const g of generated) {
    const ts = g?.lastGeneratedAt ? Date.parse(g.lastGeneratedAt) : NaN;
    if (!Number.isNaN(ts)) {
      const prev = byDomain.get(g.domain) ?? 0;
      if (ts > prev) byDomain.set(g.domain, ts);
    }
  }
  const out = [];
  for (const [domain, ts] of byDomain) {
    if (nowMs - ts < cooldownHours * 60 * 60 * 1000) out.push(domain);
  }
  return out.sort();
}
