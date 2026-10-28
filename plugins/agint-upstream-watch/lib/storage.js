/**
 * agint-upstream-watch — 存储域定义。
 *
 * 三表：
 *   releases — 上游发行快照（按 tag 主键，幂等重放用）
 *   digests  — 每次判读的结果（事实 + 可选结论）
 *   config   — 配置覆盖
 *
 * ⛔ **新增字段一律 `nullish()`**。`.optional()` 只认 `undefined` 不认 `null`，
 *    生产存量记录里出现过 `null` 导致整域 open 校验失败、插件空转的现场
 *    （见 `agint-input-gateway/lib/storage.js` 的 CountersSchema 注释，同一个坑踩过两次）。
 *
 * ⛔ **域版本不升**。dsh 的 storage 后端会硬校验版本，升版本会让已经写进去的记录整表读不出来。
 *    alpha.2 起上游放宽成「读取接受已声明的旧版本」，但那要求当前 schema 能吃混合世代 ——
 *    没做到之前别指望它。
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

export const ReleaseSchema = z.object({
  tag: z.string().min(1),
  name: z.string().nullish(),
  publishedAt: z.string().nullish(),
  prerelease: z.boolean().nullish(),
  url: z.string().nullish(),
  entryCount: z.number().int().nullish(),
  breakingHits: z.number().int().nullish(),
  versionTracks: z.any().nullish(),
  fetchedAt: z.string().nullish(),
});

export const DigestSchema = z.object({
  tag: z.string().min(1),
  targetVersion: z.string().nullish(),
  level: z.string().nullish(),
  preStageChange: z.string().nullish(),
  /** 段 1 事实（整份 JSON） */
  facts: z.any().nullish(),
  /** 事实的一句话摘要，面板直接显示这一条 */
  factsSummary: z.string().nullish(),
  /** LLM 状态：'not-needed' | 'judged' | 'failed' | 'pending' */
  llmStatus: z.string().nullish(),
  llmReason: z.string().nullish(),
  /** 段 2 结论（仅 llmStatus='judged' 时有值） */
  verdict: z.string().nullish(),
  confidence: z.number().nullish(),
  headline: z.string().nullish(),
  rationale: z.string().nullish(),
  proposalIds: z.array(z.string()).nullish(),
  createdAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
});

export const ConfigSchema = z.object({
  id: z.literal('config'),
  /** 总开关（kill-switch 之外的软开关） */
  enabled: z.boolean().nullish(),
  /** 是否允许把判读结论写成提案。false 时只落事实，不碰提案台账 */
  autoPropose: z.boolean().nullish(),
  /** 单个发行版本最多产几条提案（防一次刷屏） */
  maxProposalsPerRelease: z.number().int().nullish(),
  provider: z.string().nullish(),
  model: z.string().nullish(),
  reasoningEffort: z.string().nullish(),
  agentPreset: z.string().nullish(),
  timeoutMs: z.number().int().nullish(),
  updatedAt: z.string().nullish(),
});

export const spec = defineDomain({
  name: 'agint_upstream_watch',
  version: 1,
  tables: {
    releases: { valueSchema: ReleaseSchema },
    digests: { valueSchema: DigestSchema },
    config: { valueSchema: ConfigSchema },
  },
});

export function emptyConfig() {
  const now = new Date().toISOString();
  return {
    id: 'config',
    enabled: true,
    autoPropose: true,
    maxProposalsPerRelease: 2,
    updatedAt: now,
  };
}
