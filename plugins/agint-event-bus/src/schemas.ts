/**
 * schemas.ts — agint-event-bus v0.7.0 zod 校验
 *
 * 严格对齐 `schemas/event-bus.schema.yaml` FROZEN 字面（设计稿 §A2）：
 *   - EventEnvelope 8 字段：id / topic / version / occurredAt / source / traceId / payload（required）；correlationId（optional）
 *   - Subscription 5 字段：subscriber / topics / mode（required）；reason / timeoutMs / retry（optional）
 *   - reason 仅在 mode=sync 时 minLength >= 1（空字符串硬抛错）
 *
 * FROZEN：与 yaml 同时冻结；变更走 L0 治理。
 */

import { z } from 'zod';

/**
 * topic 正则：小写 + . 分段（2-4 段）
 *
 * 2026-09-23 修订：首段原为 `[a-z][a-z0-9]*`（**禁连字符**），与后续段
 * `[a-z][a-z0-9-]*`（允许连字符）不一致。该不一致使「插件短名含连字符」的插件
 * 无法发布/订阅任何事件 —— `skill-autocreate.*`(14) / `skill-graph.updated` /
 * `compress-guard.*`(2) 共 17 个 topic 自建成起即静默失效（P0-1 设计稿明文规定了
 * 这些名字，与 schema 从未交叉校验过）。放宽后与后续段同规则。
 *
 * ⚠️ 三处必须同步（少改一处 = 修复被静默回退）：
 *   1. 单一事实源 `schemas/event-bus.schema.yaml` 的 `topic.pattern`
 *   2. 本源文件 `src/schemas.ts`（tsc 的输入）
 *   3. 产物 `lib/schemas.js`（运行时真正加载的那份；改 src 不重编译则产物不更新，
 *      而只改产物不重编译则下次 `npm run build` 会覆盖回旧正则）
 * 取证：生产存储 941 条事件中 12 种 topic 全部符合新规则（零回归）。
 */
export const TopicSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,3}$/, {
    message: 'topic must match ^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*){1,3}$',
  });

/** 重试配置 */
export const RetryConfigSchema = z.object({
  maxAttempts: z.number().int().min(1).default(3),
  backoffMs: z.number().int().min(50).default(500),
});

/** EventEnvelope（FROZEN 顶层 8 字段） */
export const EventEnvelopeSchema = z.object({
  id: z.string().uuid({ message: 'envelope.id must be UUID' }),
  topic: TopicSchema,
  version: z.number().int().min(1, { message: 'version must be >= 1' }),
  occurredAt: z.string().datetime({ message: 'occurredAt must be ISO date-time' }),
  source: z.string().min(1, { message: 'source is required' }),
  traceId: z.string().min(1, { message: 'traceId is required (bus will fill if missing)' }),
  correlationId: z.string().optional(),
  payload: z.unknown(),
});

/**
 * Subscription：mode=sync 时 reason 必填 + 非空字符串（哲学对齐审查前置）
 *
 * 实现方式：先放宽 reason（任意 string），再在 mode=sync 上做 .refine 二次校验。
 * 空字符串硬抛错的契约在此处落地。
 */
export const SubscriptionSchema = z
  .object({
    subscriber: z.string().min(1, { message: 'subscriber is required' }),
    topics: z.array(TopicSchema).min(1, { message: 'at least one topic required' }),
    mode: z.enum(['sync', 'async']),
    reason: z.string().default(''),
    timeoutMs: z.number().int().min(100).max(60000).default(10000),
    retry: RetryConfigSchema.default({ maxAttempts: 3, backoffMs: 500 }),
  })
  .superRefine((val, ctx) => {
    if (val.mode === 'sync') {
      if (typeof val.reason !== 'string' || val.reason.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reason'],
          message:
            'mode=sync requires a non-empty reason (sync is reserved for policy-boundary edges; justify via reason for philosophy-alignment audit)',
        });
      }
    }
  });

/** 校验 envelope（接受 unknown） */
export function validateEnvelope(input: unknown): import('./envelope.js').EventEnvelope {
  const r = EventEnvelopeSchema.safeParse(input);
  if (!r.success) {
    const messages = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`EventEnvelope validation failed: ${messages}`);
  }
  return r.data as import('./envelope.js').EventEnvelope;
}

/** 校验 subscription */
export function validateSubscription(input: unknown): import('./types.js').Subscription {
  const r = SubscriptionSchema.safeParse(input);
  if (!r.success) {
    const messages = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Subscription validation failed: ${messages}`);
  }
  // reason 在 mode=async 场景可空字符串；归一为 '' 以便内部统一判断
  const out: import('./types.js').Subscription = {
    subscriber: r.data.subscriber,
    topics: [...r.data.topics],
    mode: r.data.mode,
    reason: r.data.reason ?? '',
    timeoutMs: r.data.timeoutMs,
    retry: { ...r.data.retry },
  };
  return out;
}
