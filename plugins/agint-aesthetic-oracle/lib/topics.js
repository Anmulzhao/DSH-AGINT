/**
 * lib/topics.js — oracle.* 事件 payload 合同（v2.3 方案 §5 硬规则 2）。
 *
 * event-bus 的契约边界（schemas/event-bus.schema.yaml 第 12/64 行）：
 *   「不冻结：topic payload 子 schema（由发布方插件自带独立演进，正交）」。
 * ⇒ 「schema 注册」的正确落点 = 发布方自带合同 + publish 前自校验，
 *   **不是**改 event-bus（那是人家的 FROZEN 面）。
 *
 * 本文件是 oracle.daily / oracle.weekly / oracle.monthly / oracle.alert 四个
 * topic 的单一事实源；人读版合同在 schemas/oracle-topics.schema.yaml（同目录惯例
 * 对齐 event-bus）。违约 payload **不发布**（坏数据不进事件历史），落痕
 * outcome=schema-rejected —— 合同失败必须可见，静默 false 是这行的头号杀手。
 */

import { z } from 'zod';
import { KIND_TOPIC } from './broadcast.js';

/** topic → kind 反查（recordBroadcast 落痕需要合法 kind）。 */
export const TOPIC_KIND = Object.freeze(
  Object.fromEntries(Object.entries(KIND_TOPIC).map(([k, t]) => [t, k])),
);

/** 三档广播 payload（daily/weekly/monthly 同构，kind literal 区分）。 */
const tieredShape = (kind) =>
  z.object({
    kind: z.literal(kind),
    /** 数据时间戳（§5 asOf 硬规则；缓存回退时透出的是缓存时点，诚实优先）。 */
    asOf: z.string(),
    score: z.number().nullable(),
    verdict: z.enum(['beautiful', 'ugly', 'flat']),
    worstKey: z.string().nullable(),
    lines: z.array(z.string()),
    text: z.string(),
    /**
     * 输出模式（§8.1.6，v2.4 新增可观测字段）：
     *   'template'           — v2.3 模板化输出（kill-switch=off 或 LLM 未启用）
     *   'llm'                — LLM 增强档生效（L1 措辞 / L2 深挖 / L3 润色至少一级成功）
     *   'heuristic-degraded' — LLM 调用失败降级回模板（§6.1 不阻断广播）
     * 缺省 = 'template'（向后兼容 v0.3.0 已发布的事件）。
     */
    mode: z.enum(['template', 'llm', 'heuristic-degraded']).default('template'),
    /** 评分公式版本（r2，2026-10-09）：版本切换前后总分不可直接比，分段解读。 */
    formulaVersion: z.string().optional(),
    /** 缓存回退标注（§6.1 series 缓存）：数据距今天数；新鲜广播不传。 */
    staleDays: z.number().int().min(0).optional(),
  });

/** oracle.alert：双形态合同 —— 内部告警（reason 形）与程序化警报广播（text 形）。 */
const alertSchema = z
  .object({
    // 内部告警形（沉默 24h / 配额违规 / summary 不可用）
    reason: z.string().optional(),
    since: z.string().optional(),
    violations: z.number().int().optional(),
    error: z.string().optional(),
    // 程序化警报广播形（runBroadcast('alert') 出口）
    kind: z.literal('alert').optional(),
    asOf: z.string().optional(),
    score: z.number().nullable().optional(),
    verdict: z.enum(['beautiful', 'ugly', 'flat']).optional(),
    worstKey: z.string().nullable().optional(),
    lines: z.array(z.string()).optional(),
    text: z.string().optional(),
  })
  .refine((v) => (typeof v.reason === 'string' && v.reason.trim().length > 0)
      || (typeof v.text === 'string' && v.text.trim().length > 0), {
    message: 'oracle.alert payload requires non-empty reason or text',
  });

/** topic → payload schema。新 topic 必须先在这里立合同（缺合同 = 拒发）。 */
export const TOPIC_PAYLOAD_SCHEMAS = Object.freeze({
  'oracle.daily': tieredShape('daily'),
  'oracle.weekly': tieredShape('weekly'),
  'oracle.monthly': tieredShape('monthly'),
  'oracle.alert': alertSchema,
});

/**
 * 发布前自校验（纯函数）。
 * @returns {{ ok: true } | { ok: false, issues: string }}
 */
export function validateTopicPayload(topic, payload) {
  const schema = TOPIC_PAYLOAD_SCHEMAS[topic];
  if (!schema) return { ok: false, issues: `no payload contract for topic '${topic}'` };
  const r = schema.safeParse(payload);
  if (r.success) return { ok: true };
  const issues = r.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, issues };
}
