/**
 * types.ts — agint-event-bus v0.7.0 公共类型定义
 *
 * 不变量（设计稿 Sprint12 §A2 + AGENTS.md 红线）：
 *   - 不导出 process / Buffer / setInterval 等 ambient 依赖
 *   - 不引用 quality-contract / mount-result FROZEN 接口
 *   - 所有时序信息走 ctx（host 平面 cordis fiber clock 或外部传入）
 */

/** Schema 版本（与 schema yaml schemaVersion 对齐） */
export const EVENT_BUS_SCHEMA_VERSION = 1 as const;

/** 投递模式：sync 仅限门禁边（全局 ≤ 3）；async 是默认 */
export type DeliveryMode = 'sync' | 'async';

/** 单次发布结果（publish Service 返回） */
export interface PublishResult {
  /** 总线是否接受（schema 校验通过） */
  accepted: boolean;
  /** 已被路由的订阅者 id 列表（投递成功 / 投递排队中） */
  deliveredTo: string[];
  /** 立即落到死信的订阅者 id 列表（schema 校验失败 / handler 永久拒绝） */
  deadLettered: string[];
  /** publish 时生成的 envelope.id（bus 可能代填） */
  envelopeId: string;
  /** publish 时生成的 traceId（envelope.traceId 缺失时由总线生成） */
  traceId: string;
}

/** Subscription 完整形态（订阅 Service 入参 + 内部状态） */
export interface Subscription {
  /** 订阅方插件名 */
  subscriber: string;
  /** 订阅 topic 列表（精确匹配） */
  topics: string[];
  /** 投递模式 */
  mode: DeliveryMode;
  /** mode=sync 时必填（哲学对齐审查）；空字符串硬抛错 */
  reason: string;
  /** sync 超时（默认 10000ms） */
  timeoutMs: number;
  /** 重试配置（async 专用） */
  retry: {
    maxAttempts: number;
    backoffMs: number;
  };
}

/** Unsubscribe 返回函数（subscribe Service 返回） */
export type Unsubscribe = () => void;

/** handler 签名：任意返回值；抛错视为投递失败 */
export type Handler = (envelope: import('./envelope.js').EventEnvelope) => Promise<void> | void;

/** 内部订阅记录（subscriptions 表） */
export interface SubscriptionRecord extends Subscription {
  /** 唯一订阅 id（create 时生成） */
  id: string;
  /** 注册时刻（ISO） */
  createdAt: string;
  /** handler 引用（不持久化，只在内存） */
  handler: Handler;
}

/** inspect 返回的 EventLogEntry（含死信状态） */
export interface EventLogEntry {
  /** 事件 id（envelope.id） */
  id: string;
  /** topic */
  topic: string;
  /** source */
  source: string;
  /** traceId */
  traceId: string;
  /** occurredAt 时刻 */
  occurredAt: string;
  /** 各订阅者投递结果（id → status） */
  deliveries: Record<string, 'DELIVERED' | 'DEAD_LETTERED' | 'FAILED' | 'PENDING'>;
  /** 落库的 EventEnvelope 全文（仅保留部分字段供检索） */
  payloadPreview?: unknown;
}

/** inspect 过滤条件（所有字段可选） */
export interface InspectFilter {
  topic?: string;
  traceId?: string;
  source?: string;
  since?: string;   // ISO 起点
  until?: string;   // ISO 终点
  limit?: number;   // 默认 100
}

/** EventBusContext：抽象 ctx（host 平面） */
export interface EventBusContext {
  /** 持久化存储 handle（agint_event_bus 域） */
  tables: {
    events: TableHandle;
    deadletter: TableHandle;
  };
  /** 复用 agint-evolution-memory 的 EvolutionLogBuffer（logBuffered 抽象） */
  logBuffered: (entry: {
    id: string;
    evidence: string;
    pattern?: string;
    reason?: string;
  }) => Promise<void> | void;
  /** sync 超时时降级 PENDING_REVIEW 的回调（沙箱不可用语义对齐） */
  pendingReview: (input: { source: string; topic: string; reason: string }) => Promise<void> | void;
  /** 健康度指标 sink（sync 计数 / 死信率 / 平均延迟）—— host 平面 metrics 服务（注入即用） */
  metrics?: (key: string, delta: number) => void;
}

/** 极简 TableHandle（与 @deepseek-ai/dsh-storage-domain.table() 同形） */
export interface TableHandle {
  get: (id: string) => Promise<unknown | null>;
  put: (id: string, value: unknown) => Promise<void>;
  delete: (id: string) => Promise<void>;
  entries: () => AsyncIterable<[string, unknown]> | Iterable<[string, unknown]>;
  size?: () => Promise<number>;
}
