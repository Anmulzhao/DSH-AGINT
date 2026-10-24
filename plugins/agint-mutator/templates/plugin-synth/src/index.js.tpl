/**
 * {{PLUGIN_ID}} — AGINT TOOL_SYNTHESIS 合成产物
 * ==========================================================================
 *
 * 【本文件的身份】
 *   TOOL_SYNTHESIS 产物的可执行载体。
 *   骨架（import / name / inject / 存储域定义 / apply 收尾）由 agint-mutator 提供，
 *   **方法体来自 payload 的 stubs**（2026-10-25 老板拍板：不限制代码生成方式，
 *   原 ADR-11-2 的「必须模板生成 / 禁止自由生成任意代码」约束已移除）。
 *
 * 【命名契约（骨架提供，非内容约束）】
 *   - 服务键 = `{{SERVICE_KEY}}`，落 `agint.synth.*` 命名空间
 *   - 存储域 = `{{DOMAIN}}`，落 `agint_synth_*` 前缀
 *   - `inject = ['storageDomain']`，零 agint.* host service 依赖
 *
 *   ⛔ 上列三项是产物能被 dsh 加载、能被 l0-isolation 接受的最低形态。
 *      方法体内容不受限，但内容引入的 import / 域名 / 权限由下游
 *      quality-static 与 quality-sandbox 真拦（前置约束移除后，它们是唯一防线）。
 *
 * 【意图（Intent）】
 *   {{INTENT}}
 *
 * 【声明的签名（signature）】
 *   {{SIGNATURE}}
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

const name = '{{PLUGIN_ID}}';
const inject = ['storageDomain'];

const Config = z.object({}).strict();

const InputSchema = z.object({
  input: z.string().min(1).max(1024),
}).strict();

const OutputSchema = z.object({
  input: z.string(),
  ts: z.string(),
  instanceId: z.string(),
}).strict();

const spec = defineDomain({
  name: '{{DOMAIN}}',
  version: 1,
  tables: {
    {{TABLE}}: { valueSchema: OutputSchema },
  },
});

function apply(ctx) {
  let domain = null;
  let domainError = null;
  let disposed = false;

  ctx.effect(() => {
    return () => {
      disposed = true;
      if (domain) return domain.close();
    };
  });

  const ready = ctx.storageDomain.open(spec).then(
    (d) => {
      if (disposed) {
        void d.close().catch(() => {});
        return null;
      }
      domain = d;
      return d;
    },
    (error) => {
      domainError = error;
      return null;
    },
  );

  const table = async () => {
    if (disposed) throw new Error('{{PLUGIN_ID}}: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('{{PLUGIN_ID}}: domain unavailable');
    return d.table('{{TABLE}}');
  };

  const randomId = () => {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return `r-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  };

  const service = {
    version() {
      return {
        name: '{{SERVICE_KEY}}',
        version: '{{VERSION}}',
        kind: 'synth',
        storageDomain: '{{DOMAIN}}',
        toolName: '{{TOOL_NAME}}',
      };
    },

    schemas: {
      Input: InputSchema,
      Output: OutputSchema,
    },

{{METHODS}}
  };

  ctx.provide('{{SERVICE_KEY}}', service);
}

export { Config, apply, inject, name };
