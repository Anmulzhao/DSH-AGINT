#!/usr/bin/env node
/**
 * bin/oracle-runtime-sources.mjs —— 受控链路的**真实数据源层**（只读）
 *
 * 2026-11-07「开始接线，大胆一些」：把上一批的三个纯函数模块接到真实对象上。
 * 本层负责从真实 storages / 冻结集 / 环境读出接线所需的全部输入。
 *
 * ⛔ 只读：不写任何 storage 域、不写冻结集、不改评分常量、不调 LLM。
 * ⛔ 存储根不给就抛错，绝不 fallback 到 ~/.dsh（复用 evolution-evidence 的 resolveStorages）。
 * ⛔ 三态纪律：真 0（查过、确实没有）与「没测过」必须分开；
 *    域缺失 / 损坏记 { value:null, reason }，绝不拿 0 冒充。
 * ⛔ 不伪造真值：0 条冻结标签时 labelAuthority 恒为 UNSET；只有真值到位
 *    才从集合文件里读真实 authority，绝不凭空写 GOLD。
 *
 * ⚠ 已查明的真实缺口（2026-11-07）：oracle_broadcasts 的 weekly 行只存
 *    `proposals` **计数**，不存处方正文 ⇒ 无法从存储复原候选处方。
 *    本层如实记为「未落盘」，不编造处方内容。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyBaseline, DEFAULT_SETS_DIR, EXTERNAL_AUTHORITIES } from './capability-baseline.mjs';
import { readSwitch, AUTONOMOUS_WRITE_SWITCH_ENV } from './autonomous-write-gate.mjs';
import { resolveStorages } from './evolution-evidence.mjs';

export const SOURCES_SCHEMA = '1.1';
export const ORACLE_DOMAIN = 'agint_aesthetic_oracle';
export const EVOLVE_DOMAIN = 'agint_evolve';
export const EVOLVE_PROPOSAL_TABLE = 'proposal';
export const BASELINE_EVIDENCE_PREFIX = 'capability-baseline:sets@';
/** B1 信封要求提案行自带的契约字段（外部锚另由冻结集提供）。 */
export const PRESCRIPTION_CONTRACT_FIELDS = Object.freeze(['predictedDelta', 'predictedDeltaSource', 'body']);

function tri(value, reason = '', sampleSize = null) {
  return { value, reason, sampleSize };
}

/** 普通 JSON 域表 → 行数组。⛔ 不用 table.entries()（返回元组迭代器）。 */
export function rowsOf(table) {
  if (!table || typeof table !== 'object') return [];
  return Object.entries(table)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([id, v]) => ({ id, ...v }));
}

/** 读一个真实 storage 域文件，附带三态状态。 */
export function readDomainTables(storages, domain) {
  const file = join(storages, `${domain}.json`);
  if (!existsSync(file)) {
    return { ok: false, reason: `DOMAIN_MISSING: ${file} 不存在`, tables: {}, file };
  }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const tables = data && typeof data === 'object' && data.tables && typeof data.tables === 'object'
      ? data.tables : (data ?? {});
    return { ok: true, reason: '', tables, file, unit: data?.unit ?? null };
  } catch (e) {
    return { ok: false, reason: `DOMAIN_CORRUPT: ${e.message}`, tables: {}, file };
  }
}

/**
 * 读**真实历史处方**：evolve `proposal` 表里 source 含 oracle 的行。
 * ⛔ 不做语义判断（不猜「这条是不是改尺子」），只做机器可验的结构字段对拍：
 *    B1 信封要求 predictedDelta / predictedDeltaSource / body；外部锚另看冻结集。
 * 0 条可用是查过的真 0，不是「没测过」。
 */
export function readHistoricalPrescriptions(storages, { anchorAvailable = false } = {}) {
  const domain = readDomainTables(storages, EVOLVE_DOMAIN);
  if (!domain.ok) {
    return {
      ok: false,
      total: 0,
      eligible: 0,
      reason: `EVOLVE_DOMAIN_UNAVAILABLE: ${domain.reason}`,
      missingFields: [],
      anchorAvailable,
      withPredictedDeltaSource: 0,
      statusDistribution: {},
      samples: [],
    };
  }
  const rows = rowsOf(domain.tables[EVOLVE_PROPOSAL_TABLE])
    .filter((r) => String(r.source ?? '').includes('oracle'));
  const missing = new Set();
  let eligible = 0;
  // 真实基线：oracle 源提案里已带可证伪预测来源的条数（G4 工程承诺的对拍基线）。
  let withPredictedDeltaSource = 0;
  for (const r of rows) {
    const lack = PRESCRIPTION_CONTRACT_FIELDS.filter((f) => r[f] === null || r[f] === undefined || r[f] === '');
    lack.forEach((f) => missing.add(f));
    if (!lack.includes('predictedDeltaSource')) withPredictedDeltaSource += 1;
    if (lack.length === 0 && anchorAvailable) eligible += 1;
  }
  const statusDistribution = rows.reduce((m, r) => {
    const k = r.status ?? 'unknown'; m[k] = (m[k] ?? 0) + 1; return m;
  }, {});
  return {
    ok: true,
    total: rows.length,
    eligible,
    eligibleReason: rows.length === 0
      ? 'NO_HISTORICAL_PRESCRIPTIONS: evolve 里没有 oracle 源提案'
      : `历史提案 ${rows.length} 条；带 predictedDeltaSource 的 ${withPredictedDeltaSource} 条；`
        + `缺契约字段 [${[...missing].join(', ') || '无'}]；`
        + `外部锚可用=${anchorAvailable} ⇒ 满足受控投递契约的 ${eligible} 条`,
    missingFields: [...missing],
    anchorAvailable,
    withPredictedDeltaSource,
    statusDistribution,
    samples: rows.slice(0, 2).map((r) => ({
      id: r.id, title: String(r.title ?? '').slice(0, 60), status: r.status,
      bodyLength: String(r.body ?? '').length,
    })),
  };
}

/** 标准 ISO 周键（与 score-vs-evidence 的按周对照同口径）。 */
export function isoWeekKey(input) {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * ⛔ 从**真实集合文件**读 authority。0 标签 ⇒ UNSET；有标签但读不出合法
 * authority ⇒ UNSET（不猜 GOLD）。判定权始终在外部冻结真值。
 */
export function deriveAnchorAuthority(setsDir, baseline) {
  const n = baseline?.usableFrozenLabels?.value;
  if (n === null || n === undefined || n <= 0) return 'UNSET';
  for (const name of ['gold', 'heldout']) {
    try {
      const j = JSON.parse(readFileSync(join(setsDir, `${name}.json`), 'utf8'));
      if (Array.isArray(j.samples) && j.samples.length > 0 && EXTERNAL_AUTHORITIES.includes(j.authority)) {
        return j.authority;
      }
    } catch { /* 读不到就继续，绝不猜 */ }
  }
  return 'UNSET';
}

/**
 * 读全链接线所需的真实输入。
 * @param {{storages?:string, setsDir?:string, env?:object, switchOn?:boolean|null}} input
 */
export function readRuntimeSources({
  storages = null,
  setsDir = DEFAULT_SETS_DIR,
  env = process.env,
  switchOn = null,
} = {}) {
  const storagesRoot = resolveStorages(storages, env);
  const home = env.DSH_HOME || env.AGINT_DATA_HOME || null;
  const productionStorages = home ? resolve(join(home, 'storages')) : null;

  // ── oracle 域：广播 / 处方计数 / 判尺标注周样本 ────────────────────────
  const domain = readDomainTables(storagesRoot, ORACLE_DOMAIN);
  const broadcasts = domain.ok ? rowsOf(domain.tables.oracle_broadcasts) : [];
  const weekly = broadcasts
    .filter((r) => r.kind === 'weekly')
    .sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));

  const proposalCount = weekly.reduce((n, r) => n + (Number.isFinite(Number(r.proposals)) ? Number(r.proposals) : 0), 0);

  // ── 冻结集：外部锚定的唯一真值来源（处方 eligibility 依赖它）─────────
  const baseline = verifyBaseline(setsDir);
  const frozenLabels = baseline.usableFrozenLabels; // 三态：0 是真 0
  const labelAuthority = deriveAnchorAuthority(setsDir, baseline);
  const evidenceRef = `${BASELINE_EVIDENCE_PREFIX}${baseline.verdict}`;
  const anchorAvailable = frozenLabels.value > 0 && EXTERNAL_AUTHORITIES.includes(labelAuthority);

  // ── 真实历史处方：evolve.proposal 里 oracle 源的行 ──────────────────
  // ⚠ 2026-11-07 实测纠正：weekly.proposals 是**数字**（[0,1,2,2,2,0,0] 合计 7），
  //    不是数组；拿 Array.isArray 判会误读成「0 条回流」。处方正文确实落在
  //    evolve.proposal 里，7 条全 applied，但都不带可证伪预测 / 外部锚。
  const historical = readHistoricalPrescriptions(storagesRoot, { anchorAvailable });
  const prescriptionCandidates = !historical.ok
    ? tri(null, historical.reason)
    : tri(historical.eligible, historical.eligibleReason);

  const crossCheck = {
    broadcastWeeklyProposalCount: proposalCount,
    evolveOracleProposals: historical.total,
    consistent: proposalCount === historical.total,
    note: 'agint_aesthetic_oracle.weekly.proposals 计数 与 agint_evolve.proposal 的 oracle 源条数交叉对拍',
  };

  // 周样本：按 ISO 周分组，交给 B2 的 deriveAnnotation 判「真 0 / 没测过」。
  const byWeek = new Map();
  for (const r of broadcasts) {
    const wk = isoWeekKey(r.ts ?? r.asOf);
    if (!wk) continue;
    if (!byWeek.has(wk)) byWeek.set(wk, { week: wk, humanVerdict: null, humanOverall: null, composites: r.composites ?? null });
    const s = byWeek.get(wk);
    if (r.humanVerdict !== null && r.humanVerdict !== undefined && r.humanVerdict !== '') s.humanVerdict = r.humanVerdict;
    if (r.humanOverall !== null && r.humanOverall !== undefined && r.humanOverall !== '') s.humanOverall = r.humanOverall;
    if (!s.composites && r.composites) s.composites = r.composites;
  }
  const samples = [...byWeek.values()].sort((a, b) => a.week.localeCompare(b.week));

  const sw = switchOn === null ? readSwitch(env) : switchOn === true;

  return {
    schemaVersion: SOURCES_SCHEMA,
    storagesRoot,
    productionStorages,
    setsDir,
    oracle: {
      domainOk: domain.ok,
      domainReason: domain.reason,
      broadcasts: broadcasts.length,
      weeklyCount: weekly.length,
      weeklyProposalCount: proposalCount,
      lastWeekly: weekly.length ? {
        id: weekly[weekly.length - 1].id,
        ts: weekly[weekly.length - 1].ts,
        proposals: weekly[weekly.length - 1].proposals ?? null,
      } : null,
      prescriptionCandidates,
      historical,
      crossCheck,
    },
    anchor: {
      available: anchorAvailable,
      baselineVerdict: baseline.verdict,
      frozenLabels,              // ⛔ 三态，调用方不许直接当数字用
      labelAuthority,            // 0 标签 ⇒ UNSET，绝不伪造 GOLD
      verifiedBy: 'capability-baseline',
      evidenceRef,               // 相对标识，绝对路径不进库
      capabilityConclusion: baseline.capabilityConclusion,
    },
    annotations: {
      samples,
      independentWeeks: samples.length,
      source: domain.ok ? 'agint_aesthetic_oracle/oracle_broadcasts（按 ISO 周分组）' : '无数据',
    },
    switch: {
      envVar: AUTONOMOUS_WRITE_SWITCH_ENV,
      on: sw,
      detail: sw ? '显式打开（仅本次读数，不代表生产配置已改）' : '默认关闭',
    },
    disclaimer: '本层只读真实 storages 与冻结集，不写任何东西；labelAuthority 只在真值到位时才可能不是 UNSET。',
  };
}

export { resolveStorages };
