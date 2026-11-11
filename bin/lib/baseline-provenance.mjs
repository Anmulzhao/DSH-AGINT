#!/usr/bin/env node
/**
 * bin/lib/baseline-provenance.mjs —— 判定基准的独立人工签发与逐条实算。
 *
 * ## 它解决什么
 *
 * `bin/export-evolution-package.mjs` 的 `03-evaluation/PROVENANCE.json` 原先
 * 把 `baselineAnchored: false` / `baselineProvenance: 'NOT_ANCHORED'` 写死。
 * 写死的声明有两个问题：
 *   1. 它永远为真，直到有人改代码 —— 有人签发了也不会升级。
 *   2. 它永远为假，直到有人改代码 —— 没有签发时也无法逐条说明缺在哪。
 * 规范 §2.1 明确要求「R2 不可用不得硬编码」，本模块把该声明改成实算。
 *
 * ## 职责边界
 *
 * - 签发记录存在**独立表** `baseline_attestation`，不挂在 model-visible 的
 *   `evolution_addSuccess` 上，也不回写 `benchmark_frozen_set` 原行
 *   （后者是「只增不改、同 setId 二次写入拒绝」的防篡改留证，回写即破纪律）。
 * - `humanValidated` 由本模块硬设为 `true`，不接受调用方传参。
 *   签发是人工动作；让机器传 `true` 等于把代签冒充人签。
 * - 纯函数，零外部依赖，只 import 同目录的 `canonical-json.mjs`。
 *   宿主内 cron job 不 import 本模块（bin/ 不在部署位，见 K147）。
 */

import { canonicalHash } from './canonical-json.mjs';

/** 可签发的两类判定基准。穷举，不在表内的一律不参与判定。 */
export const ATTESTABLE_TABLES = Object.freeze(['success_template', 'benchmark_frozen_set']);
export const ATTESTATION_TABLE = 'baseline_attestation';

export const PROVENANCE_STATES = Object.freeze([
  'ANCHORED', 'PARTIALLY_ANCHORED', 'NOT_ANCHORED',
]);

/**
 * 行内容 hash 要排除的字段。
 *
 * `success_template.lastRecall` / `recalls` / `updatedAt` 在**正常读取**时就会变
 * （召回计数递增）。若把它们算进 hash，一次正常召回会让所有签发判成 STALE，
 * 每周都假阳性 —— 一个永远误报的校验等于没有校验。
 * canonical-json.mjs 的 `excludeKeys` 是递归的；本域两类行都是扁平结构，
 * 嵌套同名 key 不存在，故安全。
 */
export const ROW_VOLATILE_KEYS = Object.freeze(['lastRecall', 'recalls', 'updatedAt']);

/** 对一行基准算确定性内容摘要。 */
export function rowHash(row) {
  return canonicalHash(row, { prefix: true, excludeKeys: [...ROW_VOLATILE_KEYS] });
}

/** 取行的主键：frozen set 用 setId，success template 用 id。 */
export function targetIdOf(kind, row) {
  const v = kind === 'benchmark_frozen_set'
    ? (row?.setId ?? row?.id)
    : (row?.id ?? row?.setId);
  return v === undefined || v === null ? '' : String(v);
}

/**
 * 构造一条签发记录。由 `bin/attest-baseline.mjs` 调用。
 *
 * `signedAt` 允许调用方传入（便于测试固定时钟）；生产路径不传，由本函数取时钟。
 * `humanValidated` 不进参数表 —— 见文件头注释。
 */
export function makeAttestation({
  targetKind, targetId, row, signedBy, mandate,
  signedAt, reproduceCommand,
}) {
  if (!ATTESTABLE_TABLES.includes(targetKind)) {
    throw new Error(`makeAttestation: 不支持的 targetKind ${String(targetKind)}`);
  }
  if (!targetId) throw new Error('makeAttestation: targetId is required');
  if (!signedBy) throw new Error('makeAttestation: signedBy is required（人工签发必须署名）');
  if (!mandate) throw new Error('makeAttestation: mandate is required（必须记录授权来源）');
  const at = signedAt ?? new Date().toISOString();
  return {
    id: `att-${targetKind}-${targetId}`,
    targetKind,
    targetId: String(targetId),
    contentHash: rowHash(row),
    signedBy: String(signedBy),
    signedAt: at,
    mandate: String(mandate),
    reproduceCommand: reproduceCommand
      ?? `node bin/attest-baseline.mjs --check --target=${targetKind}:${targetId}`,
    humanValidated: true,
    createdAt: at,
  };
}

/** 认 dict 与 array 两种存储形态（K138：函数名承诺的覆盖面 = 实际覆盖面）。 */
function rowsOf(tables, name) {
  const t = tables?.[name];
  if (Array.isArray(t)) return t;
  if (t && typeof t === 'object') return Object.values(t);
  return [];
}

/**
 * 逐条比对「生产基准行」与「独立签发记录」，实算锚定状态。
 *
 * 状态取值：
 *   ATTESTED            签发有效且内容 hash 一致
 *   UNATTESTED          该行没有任何签发记录
 *   STALE               签发后该行内容变了，必须重新签发
 *   INVALID_ATTESTATION 签发记录自称机器代签（humanValidated !== true）
 *   ORPHAN              签发记录指向不存在的行（行被删或 id 写错）
 *
 * ⛔ 空集不判 ANCHORED。0/N 的 vacuous truth 会让「根本没有基准」看起来
 *    像「全部基准都已锚定」，这正是 K133 要求汇总排除载体时防的同一类错。
 *
 * @param {object} tables agint_evolution.json 的 tables（或顶层形态）
 */
export function assessBaselineProvenance(tables = {}) {
  const byKey = new Map();
  for (const a of rowsOf(tables, ATTESTATION_TABLE)) {
    if (!a || !a.targetKind || !a.targetId) continue;
    byKey.set(`${a.targetKind}:${a.targetId}`, a);
  }

  const rows = [];
  const matched = new Set();

  for (const kind of ATTESTABLE_TABLES) {
    for (const r of rowsOf(tables, kind)) {
      const id = targetIdOf(kind, r);
      const base = { targetKind: kind, targetId: id };
      if (!id) {
        rows.push({ ...base, status: 'UNATTESTED', reason: '行缺少 id/setId，无法逐条比对' });
        continue;
      }
      const key = `${kind}:${id}`;
      const a = byKey.get(key);
      if (!a) {
        rows.push({ ...base, status: 'UNATTESTED', reason: '无独立人工签发记录' });
        continue;
      }
      matched.add(key);
      if (a.humanValidated !== true) {
        rows.push({
          ...base, status: 'INVALID_ATTESTATION',
          reason: '签发记录 humanValidated !== true（机器代签不得冒充人工签发）',
          signedBy: a.signedBy ?? null,
        });
        continue;
      }
      const actual = rowHash(r);
      if (a.contentHash !== actual) {
        rows.push({
          ...base, status: 'STALE',
          reason: '签发后该行内容已变化（contentHash 不符），需重新签发',
          expectedHash: a.contentHash ?? null, actualHash: actual,
          signedBy: a.signedBy ?? null,
        });
        continue;
      }
      rows.push({
        ...base, status: 'ATTESTED', reason: '', contentHash: actual,
        signedBy: a.signedBy ?? null, signedAt: a.signedAt ?? null,
      });
    }
  }

  for (const [key, a] of byKey) {
    if (matched.has(key)) continue;
    rows.push({
      targetKind: a.targetKind, targetId: a.targetId, status: 'ORPHAN',
      reason: '签发记录指向不存在的基准行（行被删除或 id 写错）',
      signedBy: a.signedBy ?? null,
    });
  }

  const count = (s) => rows.filter((r) => r.status === s).length;
  const candidates = rows.filter((r) => r.status !== 'ORPHAN');
  const counts = {
    total: candidates.length,
    attested: count('ATTESTED'),
    unattested: count('UNATTESTED'),
    stale: count('STALE'),
    invalid: count('INVALID_ATTESTATION'),
    orphan: count('ORPHAN'),
  };
  const blocking = counts.stale > 0 || counts.invalid > 0 || counts.orphan > 0;
  const baselineAnchored = counts.total > 0
    && counts.attested === counts.total
    && !blocking;

  let baselineProvenance = 'NOT_ANCHORED';
  if (baselineAnchored) baselineProvenance = 'ANCHORED';
  else if (counts.attested > 0 && !blocking) baselineProvenance = 'PARTIALLY_ANCHORED';

  const reasons = [];
  if (counts.total === 0) {
    reasons.push('生产存储无 success_template / benchmark_frozen_set 行 ⇒ 无可签发基准（空集不算已锚定）');
  }
  if (counts.unattested > 0) {
    reasons.push(`${counts.unattested}/${counts.total} 行无独立人工签发记录（判定基准与被评对象同池，未经外部确认）`);
  }
  if (counts.stale > 0) reasons.push(`${counts.stale} 行签发后内容已变，旧签发失效`);
  if (counts.invalid > 0) reasons.push(`${counts.invalid} 条签发记录不是人工签发`);
  if (counts.orphan > 0) reasons.push(`${counts.orphan} 条签发记录指向不存在的行`);
  if (baselineAnchored) reasons.push('全部基准行均有独立人工签发且内容未变');

  return {
    baselineAnchored,
    baselineProvenance,
    counts,
    reasons,
    rows,
    method: 'bin/lib/baseline-provenance.mjs#assessBaselineProvenance',
    volatileKeysExcluded: [...ROW_VOLATILE_KEYS],
  };
}
