/**
 * agint-skill-autocreate: storage domain 声明 + entry pack/unpack。
 *
 * 设计稿 §4.1：storage domain `agint_skill_autocreate`（与 agint /
 * agint_evolution / agint_diagnosis / agint_metrics 互斥），5 张表：
 *   task_patterns / candidates / proposals / releases / audit_log
 *
 * proposals / releases 表在 Sprint 14 先建（避免后续 schemaVersion 破环性
 * 变更），Sprint 15/16 才写入。
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import {
  TaskPatternSchema,
  CandidateSchema,
  AuditLogSchema,
  LIMITS,
} from './schema.js';

// ── storage entry schema（业务字段 + storage metadata）──────────────────

const taskPatternEntrySchema = TaskPatternSchema.extend({
  id: z.string().min(1),
  kind: z.literal('task_pattern'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const candidateEntrySchema = CandidateSchema.extend({
  id: z.string().min(1),
  kind: z.literal('skill_candidate'),
  createdAt: z.string(),
});

// releases 表 Sprint 16 写入；schema 按设计稿 §4.4 + Sprint16-设计稿 §5 收紧
// （无存量行，新增字段安全；status 仍是 OBSERVING/STABLE/ROLLED_BACK 三态）
const releaseEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.literal('skill_release'),
  createdAt: z.string(),
  candidateId: z.string(),
  skillName: z.string(),
  version: z.string(),
  snapshot: z.record(z.any()).default({}),
  observationEndAt: z.string().nullable().default(null),
  observationMetrics: z.record(z.any()).nullable().default(null),
  status: z.enum(['OBSERVING', 'STABLE', 'ROLLED_BACK']).default('OBSERVING'),
  rollbackAt: z.string().nullable().default(null),
  rollbackReason: z.string().nullable().default(null),
  // Sprint 16：发布主体 + 预算计数归属周（含已回滚的发布——回滚也算消耗预算）
  releasedBy: z.enum(['auto', 'human']).default('auto'),
  budgetWeek: z.string().nullable().default(null),
  // B4 形状 A（2026-10-03 老板拍板）：skill-identity 修复提案（observe() 宽限机制）。
  // null = 无提案；{code, reason, proposedAt, deadlineAt, dismissed} = 提案期内；
  // dismissed=true = 人工拍板保留（identity 门放行，走正常观察）。
  // 存量行无此字段 → default null，parse 向后安全。
  identityFixProposal: z.record(z.any()).nullable().default(null),
});

// proposals 表 Sprint 15 写入（Phase 3 通过后转正）；§7.2 字段（rankingScore /
// evidenceLevel / provisional / status='QUEUED_FOR_RELEASE'）Sprint 15 扩展落地，
// 保持宽松（skillDraft / evalResults 为 record，防 schemaVersion 破环性变更）
const proposalEntrySchema = z.object({
  id: z.string().min(1),
  kind: z.literal('skill_proposal'),
  createdAt: z.string(),
  candidateId: z.string(),
  skillDraft: z.record(z.any()),
  evalResults: z.record(z.any()).default({}),
  // ── Sprint 15 §7.2（P0-1 输出 → P0-2 策展人排序消费）──
  rankingScore: z.number().nullable().default(null),
  evidenceLevel: z.enum(['E0', 'E1']).nullable().default(null),
  provisional: z.boolean().default(true),
  status: z.enum(['QUEUED_FOR_RELEASE']).default('QUEUED_FOR_RELEASE'),
  estimatedBenefit: z.record(z.any()).nullable().default(null),
});

const auditLogEntrySchema = AuditLogSchema.extend({
  id: z.string().min(1),
  kind: z.literal('audit_log'),
});

// ── domain spec ──────────────────────────────────────────────────────────

const name = 'agint-skill-autocreate';

const spec = defineDomain({
  name: 'agint_skill_autocreate',
  version: 1,
  tables: {
    task_patterns: { valueSchema: taskPatternEntrySchema },
    candidates: { valueSchema: candidateEntrySchema },
    proposals: { valueSchema: proposalEntrySchema },
    releases: { valueSchema: releaseEntrySchema },
    audit_log: { valueSchema: auditLogEntrySchema },
  },
  // Sprint 14 → Sprint 15 schema 迁移漏做：staging 表里 42 条候选 (sc_20260917_xxx + sc_20260918_bc0a06)
  // 仍是 Sprint 14 扁平 manifest.json 形态。autocreate 所有 list/stats 接口因此抛
  // "stored record does not match its schema" 500。官方机制 backup-and-skip 让错配记录
  // 自动备份到 <domain>.bak/<table>/<key>.json 后跳过，不阻断 domain 打开。
  // 证据：2026-09-18 P0 复现 → README/.tmp/pending-patches 留痕。备份位置安全可恢复。
  invalidRecords: 'backup-and-skip',
});

// ── 上限检查（§4：超限 warn，不自动 prune；audit_log 例外滚动清理）────────

const TABLE_TO_LIMIT_KEY = {
  task_patterns: 'TASK_PATTERNS',
  candidates: 'CANDIDATES',
  proposals: 'CANDIDATES', // 设计稿未单列 proposals 上限，跟随 candidates
  releases: 'RELEASES',
  audit_log: 'AUDIT_LOG',
};

function checkLimit(table, count) {
  const key = TABLE_TO_LIMIT_KEY[table];
  const cap = key ? LIMITS[key] : undefined;
  if (typeof cap === 'number' && count > cap) {
    return { table, count, limit: cap, _warn: `${table} count ${count} > limit ${cap}` };
  }
  return null;
}

// ── 工具函数 ─────────────────────────────────────────────────────────────

function randomId(prefix) {
  const c = globalThis.crypto;
  const uuid = c && typeof c.randomUUID === 'function' ? c.randomUUID() : `d-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}_${uuid}` : uuid;
}

function nowIso() {
  return new Date().toISOString();
}

/** 日期前缀 id：设计稿示例形如 tp_20260907_001；这里用 tp_YYYYMMDD_<uuid 前 6 位> */
function datedId(prefix) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const c = globalThis.crypto;
  const rand = c && typeof c.randomUUID === 'function'
    ? c.randomUUID().replace(/-/g, '').slice(0, 6)
    : Math.random().toString(36).slice(2, 8);
  return `${prefix}_${day}_${rand}`;
}

// ── sampleArgs 长度上限（2026-11-12）──────────────────────────────────────
//
// 病：task_patterns 的行内 `sampleArgs` 存的是**工具参数原文**，没有上限。
// 2026-11-12 生产实测：277 行 / 1.54 MB，均 3.3 KB，**最大单行 31.4 KB**
// ⇒ 一行 pattern 比一行审计日志大 30 倍，存储被单行撑爆的风险是真实的。
//
// 约束：**upsert 时**把 sampleArgs 的 JSON 序列化长度压到 SAMPLE_ARGS_MAX_CHARS
// 以内（保留前 2 KB，超出部分截断并打标记）。
//   · **不改任何已有字段名**（sampleArgs 仍是 sampleArgs，键仍是原键名）；
//   · 截断只动**值**，不动结构：值类型保持原样（对象仍是对象、字符串仍是字符串），
//     被裁的字符串尾部加 TRUNCATION_MARK 标记（消费方 templates.js 的
//     firstMeaningfulValue 只取前 60 字符，不受影响）；
//   · 预算耗尽时**丢后面的键**而不是丢整个工具 —— 保住「这个工具被用过」的事实。
//
// 为什么不在读的时候裁：读时裁会让"表里到底存了多少"永远说不清（三个真相），
// 而行体积是存储层的问题，应该在写入层解决。
const SAMPLE_ARGS_MAX_CHARS = 2048;
const TRUNCATION_MARK = '…[truncated]';

/**
 * 把 sampleArgs 压到长度上限内（纯函数，不改入参）。
 * 超限时：长字符串截断 + 标记；预算不够的键直接丢弃；形状（工具 → 参数对象）保持。
 */
function capSampleArgs(sampleArgs) {
  if (!sampleArgs || typeof sampleArgs !== 'object' || Array.isArray(sampleArgs)) {
    return sampleArgs ?? {};
  }
  let json;
  try { json = JSON.stringify(sampleArgs); } catch { return sampleArgs; }
  if (!json || json.length <= SAMPLE_ARGS_MAX_CHARS) return sampleArgs;

  const out = {};
  const sizeOf = () => { try { return JSON.stringify(out).length; } catch { return Infinity; } };
  const isObjValue = (v) => v && typeof v === 'object' && !Array.isArray(v);

  for (const [tool, rawArgs] of Object.entries(sampleArgs)) {
    const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs))
      ? rawArgs
      : { value: rawArgs };
    const clipped = {};
    out[tool] = clipped;                       // 先占位：保住「这个工具被用过」的事实
    if (sizeOf() > SAMPLE_ARGS_MAX_CHARS) { delete out[tool]; break; }
    for (const [k, v] of Object.entries(args)) {
      // 逐级收敛：原值 → 截断 512 → 截断 128 → 放弃这个键
      const candidates = [
        v,
        typeof v === 'string'
          ? v.slice(0, 512) + TRUNCATION_MARK
          : (isObjValue(v) ? JSON.stringify(v).slice(0, 512) + TRUNCATION_MARK : v),
        typeof v === 'string'
          ? v.slice(0, 128) + TRUNCATION_MARK
          : (isObjValue(v) ? JSON.stringify(v).slice(0, 128) + TRUNCATION_MARK : v),
      ];
      let placed = false;
      for (const cand of candidates) {
        clipped[k] = cand;
        if (sizeOf() <= SAMPLE_ARGS_MAX_CHARS) { placed = true; break; }
        delete clipped[k];
      }
      if (!placed) break;   // 连 128 都放不下 ⇒ 这个工具的其余键放弃
    }
  }
  return out;
}

// ── pack：业务字段 → storage record（补 metadata）────────────────────────

function packTaskPattern(business, existing) {
  const now = nowIso();
  return taskPatternEntrySchema.parse({
    id: existing?.id ?? datedId('tp'),
    kind: 'task_pattern',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...business,
    // sampleArgs 长度上限在这里生效（upsert 唯一入口）——见上方 SAMPLE_ARGS_MAX_CHARS 注释
    sampleArgs: capSampleArgs(business?.sampleArgs),
  });
}

function packCandidate(business) {
  return candidateEntrySchema.parse({
    id: datedId('sc'),
    kind: 'skill_candidate',
    createdAt: nowIso(),
    ...business,
  });
}

function packAudit(business) {
  return auditLogEntrySchema.parse({
    id: datedId('audit'),
    kind: 'audit_log',
    timestamp: nowIso(),
    ...business,
  });
}

export {
  name,
  spec,
  LIMITS,
  checkLimit,
  randomId,
  nowIso,
  datedId,
  packTaskPattern,
  packCandidate,
  packAudit,
  capSampleArgs,
  SAMPLE_ARGS_MAX_CHARS,
  taskPatternEntrySchema,
  candidateEntrySchema,
  releaseEntrySchema,
  proposalEntrySchema,
  auditLogEntrySchema,
};
