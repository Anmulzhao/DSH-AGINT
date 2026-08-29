/**
 * types.ts — agint-event-bus v0.7.0 公共类型定义
 *
 * 不变量（设计稿 Sprint12 §A2 + AGENTS.md 红线）：
 *   - 不导出 process / Buffer / setInterval 等 ambient 依赖
 *   - 不引用 quality-contract / mount-result FROZEN 接口
 *   - 所有时序信息走 ctx（host 平面 cordis fiber clock 或外部传入）
 */
/** Schema 版本（与 schema yaml schemaVersion 对齐） */
export const EVENT_BUS_SCHEMA_VERSION = 1;
