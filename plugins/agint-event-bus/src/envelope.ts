/**
 * envelope.ts — EventEnvelope 构造与字段归一（设计稿 §A2）
 *
 * 设计原则：
 *   - envelopeId 缺失时总线代填 UUIDv4（一致性：所有 envelope 必有 id）
 *   - traceId 缺失时总线代填（设计稿 §A2 注：traceId 必填）
 *   - occurredAt 缺失时总线代填当前时刻（允许发布方记"事件发生"时间）
 *   - topic 必填 + 强制 schema 正则
 *
 * 不存 ambient 依赖（process / Buffer / 原生 timer）；时间由 ctx 或外部传入，
 * 兜底走 globalThis.Date（合法 ambient，非 timer）。
 */

import { randomUUID } from 'node:crypto';
import { validateEnvelope, TopicSchema } from './schemas.js';
import type { EventBusContext } from './types.js';

export interface EventEnvelope {
  id: string;
  topic: string;
  version: number;
  occurredAt: string;
  source: string;
  traceId: string;
  correlationId?: string;
  payload: unknown;
}

export interface PublishInput {
  id?: string;
  topic: string;
  version?: number;
  occurredAt?: string;
  source: string;
  traceId?: string;
  correlationId?: string;
  payload?: unknown;
}

/**
 * 构造并校验 EventEnvelope。
 *  - 缺失字段按"总线代填"语义补齐（id / traceId / occurredAt / version）
 *  - topic / source 必填，缺失直接抛错（不可代填）
 *  - 走 zod 校验（FROZEN 字段顺序与 yaml 一致）
 */
export function makeEnvelope(input: PublishInput): EventEnvelope {
  if (!input || typeof input !== 'object') {
    throw new Error('makeEnvelope: input must be an object');
  }
  if (!input.topic || typeof input.topic !== 'string') {
    throw new Error('makeEnvelope: topic is required (string)');
  }
  // topic 正则预校验（zod 内同样会校验，这里早抛更明确）
  if (!TopicSchema.safeParse(input.topic).success) {
    throw new Error(`makeEnvelope: topic "${input.topic}" does not match required pattern`);
  }
  if (!input.source || typeof input.source !== 'string') {
    throw new Error('makeEnvelope: source is required (string, plugin name)');
  }

  const now = new Date().toISOString();
  const candidate: EventEnvelope = {
    id: input.id ?? randomUUID(),
    topic: input.topic,
    version: input.version ?? 1,
    occurredAt: input.occurredAt ?? now,
    source: input.source,
    traceId: input.traceId ?? randomUUID(),
    correlationId: input.correlationId,
    payload: input.payload ?? {},
  };

  // zod 全字段校验（含 id uuid / occurredAt datetime / source min 1）
  return validateEnvelope(candidate);
}

/**
 * 把已解析好的对象再校验一次（外部来源时不信任输入）。
 * 不替代 makeEnvelope；用于 publish 内部校验。
 */
export function assertEnvelope(envelope: unknown): EventEnvelope {
  return validateEnvelope(envelope);
}

/**
 * 精简 inspect 视图（不暴露 payload 全文，仅保留预览）。
 * payload 预览默认 200 字符截断（不进 storage 落盘；内存视图用）。
 */
export function previewEntry(envelope: EventEnvelope): unknown {
  if (envelope.payload === undefined || envelope.payload === null) return null;
  try {
    const s = JSON.stringify(envelope.payload);
    if (s.length <= 200) return envelope.payload;
    return { __truncated: true, preview: s.slice(0, 200) + '…' };
  } catch {
    return { __nonSerializable: true };
  }
}

/** 通过 ctx.logBuffered（EvolutionLogBuffer 适配）记一条 envelope 构造日志 */
export async function logEnvelopeBuilt(
  ctx: EventBusContext,
  envelope: EventEnvelope,
  note: string,
): Promise<void> {
  if (!ctx.logBuffered) return;
  await ctx.logBuffered({
    id: `event-bus-built-${envelope.id}`,
    evidence: `topic=${envelope.topic} source=${envelope.source} version=${envelope.version}`,
    pattern: envelope.topic,
    reason: note,
  });
}
