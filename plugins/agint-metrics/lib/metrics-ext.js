/**
 * agint-metrics: 扩展采集块（2026-09-27，美的神谕层 Day 0 / 方案 C）。
 *
 * 原子观测归 metrics，复合派生归神谕层（`agint-aesthetic-oracle`）——本文件
 * 只做**原子采集**，不做任何复合派生（noise_ratio / aesthetic_score 等复合
 * 指标永远不进 metrics，神谕层红线 §9.4 的对偶面）。
 *
 * Day 0 新增 4 个原子 key（v2.3 方案 §3.0）：
 *   autocreate.candidatesRejected — skill-autocreate 候选表 status=REJECTED 计数
 *                                   （门禁正常工作的证据，不进美的噪声分子）
 *   skills.totalBytes             — 两处 skills 根 Σ SKILL.md 字节（臃肿度分子）
 *   evolution.logCount7d          — 近 7 天进化日志数（活跃度分子）
 *   evolution.logCount30d         — 近 30 天进化日志数（活跃度分母）
 *
 * 注意：REJECTED 候选**在系统外**（三道门拒绝），采集它是为了门禁健康视角；
 * 神谕层的噪声比分子用的是「在系统内」的脏条目，两者语义不同，别混。
 *
 * 防御块纪律与 metrics.js 相同：任一 source 缺席 / 抛错 → 跳过该 key，不失败。
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 4 个新原子 key 的定义（与 METRIC_DEFS 合并后 summary 可见）。 */
export const METRIC_DEFS_EXT = [
  { key: 'autocreate.candidatesRejected', label: '技能候选拒绝数（门禁工作证据）', unit: 'count', source: 'skillAutocreate' },
  { key: 'skills.totalBytes', label: '技能提示词总量（两处 skills 根 SKILL.md 字节和）', unit: 'bytes', source: 'skillsFs' },
  { key: 'evolution.logCount7d', label: '近 7 天进化日志数（排除 oracle 审计条目）', unit: 'count', source: 'evolution' },
  { key: 'evolution.logCount30d', label: '近 30 天进化日志数（排除 oracle 审计条目）', unit: 'count', source: 'evolution' },
];

/** memory 无证据 id 清单的 meta 上限（防 meta 膨胀；全量清单由神谕层建议里引用机制而非逐一罗列）。 */
export const NO_EVIDENCE_IDS_CAP = 50;

// ── skills 文件系统 source ──────────────────────────────────────────────────

/**
 * 默认两处 skills 根：
 *   1. $DSH_HOME/skills                       — 用户级（AGINT 自动生成的技能落这里，重装不丢）
 *   2. $DSH_HOME/.agent-presets/agint/skills  — agint preset 自带技能的部署位
 * 返回真实存在的目录；都不存在时返回空数组（collect 跳过该 key）。
 */
export function defaultSkillRoots(env = process.env) {
  const home = env.DSH_HOME || env.HOME || '';
  if (!home) return [];
  const candidates = [
    join(home, 'skills'),
    join(home, '.agent-presets', 'agint', 'skills'),
  ];
  return candidates.filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
}

/**
 * 造一个 skills 文件系统 source：懒遍历两处 skills 根，统计 SKILL.md 字节。
 * 每次调用 re-walk（collect 一天一次，成本可忽略；§7 预算 ≤1s/天）。
 *
 * @param {string[]} roots — 目录列表（测试可传临时目录）
 */
export function makeSkillsFsSource(roots = defaultSkillRoots()) {
  return {
    /** @returns {{ totalBytes: number, fileCount: number, roots: string[], missingRoots: string[] }} */
    measure() {
      let totalBytes = 0;
      let fileCount = 0;
      const found = [];
      const missing = [];
      for (const root of roots) {
        try {
          const n = walkSkillMd(root, (bytes) => { totalBytes += bytes; fileCount += 1; });
          if (n > 0 || statSync(root).isDirectory()) found.push(root);
        } catch { missing.push(root); }
      }
      return { totalBytes, fileCount, roots: found, missingRoots: missing };
    },
  };
}

/** 递归遍历目录，对每个 SKILL.md 调 onFile(字节)；返回命中的文件数。 */
function walkSkillMd(dir, onFile) {
  let count = 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) count += walkSkillMd(p, onFile);
    else if (e.isFile() && e.name === 'SKILL.md') {
      try { onFile(statSync(p).size); count += 1; } catch { /* 文件刚被删 → 跳过 */ }
    }
  }
  return count;
}

// ── 扩展计算块 ──────────────────────────────────────────────────────────────

/** await 一个可能是 promise 的值（服务可能同步或异步）。 */
async function awaitMaybe(v) {
  return v && typeof v.then === 'function' ? await v : v;
}

/**
 * 计算扩展原子指标。与 metrics.js computeMetrics 同构：sources 缺席/抛错跳过。
 * @param {{skillAutocreate?: object, evolution?: object, skillsFs?: object}} sources
 * @returns {Promise<Array<{key,label,value,unit,meta}>>}
 */
export async function computeMetricsExt(sources) {
  const out = [];
  const defs = new Map(METRIC_DEFS_EXT.map((d) => [d.key, d]));
  const push = (key, value, meta = {}) => {
    const def = defs.get(key);
    if (!def || value === null || value === undefined || Number.isNaN(value)) return;
    out.push({ key, label: def.label, value, unit: def.unit, meta: JSON.stringify(meta) });
  };

  // ---- skill-autocreate：候选拒绝数（门禁健康视角）----
  // 主路径 stats()（一次聚合返回 byStatus）；stats 缺席时退化 listCandidates 全量自数。
  const autocreate = sources?.skillAutocreate;
  if (autocreate) {
    try {
      if (typeof autocreate.stats === 'function') {
        const st = await awaitMaybe(autocreate.stats());
        const byStatus = st?.candidates?.byStatus ?? {};
        push('autocreate.candidatesRejected', byStatus.REJECTED ?? 0, { byStatus, total: st?.candidates?.total ?? null });
      } else if (typeof autocreate.listCandidates === 'function') {
        const list = await awaitMaybe(autocreate.listCandidates({ limit: 1_000_000 }));
        const arr = Array.isArray(list) ? list : [];
        push('autocreate.candidatesRejected',
          arr.filter((c) => c?.status === 'REJECTED').length,
          { total: arr.length, via: 'listCandidates' });
      }
    } catch { /* source unhealthy → skip */ }
  }

  // ---- evolution：近 7 / 30 天日志数（活跃度视角）----
  // ⚠ §3.5 硬规则（任何迭代不得移除）：**排除 targetKind 以 oracle 开头的条目**
  // —— 神谕层自己的审计日志永远不算系统的活跃度（观察者不得用自身写入改变
  // 被观察系统）。排除必须在采集侧做：神谕层只读 summary，拿不到明细。
  // 一次取 30 天窗（limit 放大到全量——getLogRange 默认 limit=200 会截断计数），
  // 7d 从 30d 结果里按 ts 本地过滤，省一次服务调用且两窗口径一致。
  const evolution = sources?.evolution;
  if (evolution && typeof evolution.getLogRange === 'function') {
    try {
      const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const since7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const rows = await awaitMaybe(evolution.getLogRange({ fromDate: since30, limit: 1_000_000 }));
      const arr = Array.isArray(rows) ? rows : [];
      const isOracle = (r) => String(r?.targetKind ?? '').startsWith('oracle');
      const excludedOracle = arr.filter(isOracle).length;
      const systemRows = arr.filter((r) => !isOracle(r));
      push('evolution.logCount7d', systemRows.filter((r) => String(r?.ts ?? r?.createdAt ?? '') >= since7).length, { since: since7, excludedOracle });
      push('evolution.logCount30d', systemRows.length, { since: since30, excludedOracle });
    } catch { /* skip */ }
  }

  // ---- skills 文件系统：SKILL.md 字节总量（臃肿度分子）----
  const skillsFs = sources?.skillsFs;
  if (skillsFs && typeof skillsFs.measure === 'function') {
    try {
      const m = await awaitMaybe(skillsFs.measure());
      // 全部根不存在 = 没有可扫的数据面 → 跳过该 key（记 0 会让"没装技能"
      // 在臃肿度公式里看起来很美，语义错误）。至少一个根存在时 0 字节才真实。
      if (Array.isArray(m.roots) && m.roots.length === 0) {
        /* skip：no scan target */
      } else {
        push('skills.totalBytes', m.totalBytes, { fileCount: m.fileCount, roots: m.roots, missingRoots: m.missingRoots });
      }
    } catch { /* skip */ }
  }

  return out;
}

/** 描述一个扩展指标 key（供工具渲染）。 */
export function describeMetricExt(key) {
  return METRIC_DEFS_EXT.find((d) => d.key === key) ?? null;
}
