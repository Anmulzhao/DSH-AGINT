/**
 * agint-rules: preset-scoped tools (rule_check / rule_list / rule_audit /
 * rule_lint / rule_add / rule_remove / rule_set_enabled).
 *
 * Preset row (agent.agint.yml):
 *   - id: agint-rules-tools
 *     name: ../../plugins/agint-rules/lib/tools.js
 *
 * Consumes the host agint.rules service.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'agint-rules-tools';
const inject = ['tools', 'agint.rules'];

function apply(ctx) {
  const rules = ctx['agint.rules'];

  ctx.tools.register(defineTool({
    name: 'rule_check',
    description: '检查一个任务或工具调用是否命中已注册的 agint 规则。返回三类命中：deny(硬阻断)、ask(询问确认)、advisory(建议提醒)。应在执行高风险工具调用前调用。',
    parameters: {
      tool: { type: 'string', description: '工具名(如 "bash")。与 args 一起精确匹配。' },
      args: { type: 'object', description: '工具参数对象。', additionalProperties: true },
      task: { type: 'string', description: '任务描述。仅在不带 tool/args 时用作粗筛(命中所有工具的规则)。' },
    },
    output: {
      // K20: BOTH execute paths now return the same shape — coarse path fills
      // `tool: '*'`. Schema can therefore require `tool` (no optional anymore).
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          tool: { type: 'string', required: true },
          matched: { type: 'number', required: true },
          deny: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                ruleId: { type: 'string', required: true },
                action: { type: 'string', required: true },
                level: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          ask: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                ruleId: { type: 'string', required: true },
                action: { type: 'string', required: true },
                level: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          advisory: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                ruleId: { type: 'string', required: true },
                action: { type: 'string', required: true },
                level: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          invalidPatterns: {
            type: 'array', required: true,
            // items must be a bare type — `required` is only valid at the
            // properties level of the value schema DSL (K2-family; caught by
            // standingKeyFor strict validation).
            items: { type: 'string' },
          },
        },
      },
      render(_a, v) {
        if (v.matched === 0) {
          return [{ type: 'text', text: 'rule_check: NO_MATCH — 没有规则命中这个调用。' }];
        }
        const lines = [`rule_check: matched=${v.matched}`];
        if (v.deny.length) lines.push('  DENY (硬阻断):');
        v.deny.forEach((d) => lines.push(`    [${d.ruleId}] ${d.reason}`));
        if (v.ask.length) lines.push('  ASK (请求确认):');
        v.ask.forEach((d) => lines.push(`    [${d.ruleId}] ${d.reason}`));
        if (v.advisory.length) lines.push('  ADVISORY (建议):');
        v.advisory.forEach((d) => lines.push(`    [${d.ruleId}] ${d.reason}`));
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      // Two modes: concrete (tool + args) or coarse (task → matched against
      // every enabled rule with tool='*'). Both branches now return a SHARED
      // shape — coarse fills `tool: '*'` so downstream consumers never branch
      // on field presence. K20 fix: coarse no longer drops `tool`.
      if (args.tool || args.args) {
        return rules.check(args.tool ?? '*', args.args ?? '');
      }
      const task = String(args.task ?? '');
      const list = await rules.list({ enabled: true });
      const hits = [];
      const invalidPatterns = [];
      for (const r of list) {
        // Only broad tool rules are matched against raw task text.
        if (r.tool !== '*') continue;
        let re;
        try {
          re = new RegExp(r.pattern, r.flags || undefined);
        } catch {
          invalidPatterns.push(r.id);
          continue;
        }
        if (re.test(task)) {
          hits.push({ ruleId: r.id, action: r.action, level: r.level, reason: r.reason });
        }
      }
      return {
        tool: '*',
        matched: hits.length,
        deny: hits.filter((h) => h.action === 'deny'),
        ask: hits.filter((h) => h.action === 'ask'),
        advisory: hits.filter((h) => h.action === 'advisory'),
        invalidPatterns,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rule_list',
    description: '列出所有已注册的 agint 规则。可按 action / tool / enabled 过滤。',
    parameters: {
      action: { type: 'string', description: '按 action 过滤: advisory | ask | deny。' },
      tool: { type: 'string', description: '按工具名过滤(如 "bash")。' },
      enabled: { type: 'boolean', description: '按启用状态过滤。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          rules: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                tool: { type: 'string', required: true },
                pattern: { type: 'string', required: true },
                flags: { type: 'string', required: true },
                action: { type: 'string', required: true },
                level: { type: 'string', required: true },
                reason: { type: 'string', required: true },
                enabled: { type: 'boolean', required: true },
                createdAt: { type: 'string', required: true },
                updatedAt: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render(_a, v) {
        if (v.rules.length === 0) return [{ type: 'text', text: 'rule_list: 没有规则' }];
        const lines = [`rule_list: ${v.rules.length} 条`];
        v.rules.forEach((r) => {
          lines.push(`  ${r.enabled ? '✓' : '✗'} [${r.action.padEnd(8)}] ${r.id.padEnd(28)} tool=${r.tool.padEnd(6)} /${r.pattern}/${r.flags}  ${r.reason.slice(0, 60)}`);
        });
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute(args) {
      const filter = {};
      if (args.action) filter.action = args.action;
      if (args.tool) filter.tool = args.tool;
      if (typeof args.enabled === 'boolean') filter.enabled = args.enabled;
      return rules.list(filter).then((rules) => ({ rules }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rule_audit',
    description: '返回 agint-rules 当前的命中审计(hits/denies/asks/advisories)。用于统计门禁遵守率、指标序列。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          rules: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                ruleId: { type: 'string', required: true },
                hits: { type: 'number', required: true },
                denies: { type: 'number', required: true },
                asks: { type: 'number', required: true },
                advisories: { type: 'number', required: true },
              },
            },
          },
          totals: {
            type: 'object', additionalProperties: false,
            properties: {
              hits: { type: 'number', required: true },
              denies: { type: 'number', required: true },
              asks: { type: 'number', required: true },
              advisories: { type: 'number', required: true },
            },
          },
        },
      },
      render(_a, v) {
        const t = v.totals;
        const lines = [
          `rule_audit: totals hits=${t.hits} denies=${t.denies} asks=${t.asks} advisories=${t.advisories}`,
        ];
        v.rules.forEach((r) => {
          lines.push(`  [${r.ruleId.padEnd(30)}] hits=${r.hits}  deny=${r.denies}  ask=${r.asks}  adv=${r.advisories}`);
        });
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute() {
      return rules.audit();
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rule_lint',
    description: '扫描规则表: 报告编译失败的 pattern 与重复模式。仅在加规则或怀疑规则冲突时调用。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          issues: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                ruleId: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                detail: { type: 'string' },
                with: { type: 'string' },
              },
            },
          },
        },
      },
      render(_a, v) {
        if (v.issues.length === 0) return [{ type: 'text', text: 'rule_lint: 0 issues — 规则表健康' }];
        const lines = [`rule_lint: ${v.issues.length} issue(s)`];
        v.issues.forEach((i) => {
          const tail = i.with ? ` (与 ${i.with} 冲突)` : (i.detail ? ` (${i.detail})` : '');
          lines.push(`  ! [${i.kind}] ${i.ruleId}${tail}`);
        });
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute() {
      return rules.lint().then((issues) => ({ issues }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rule_add',
    description: '添加一条新规则。pattern 是正则表达式源串(不含斜杠);flags 是正则 flags 串(如 "i")。添加后立即生效。',
    parameters: {
      id: { type: 'string', description: '规则 id(可选, 不传则自动生成)。' },
      tool: { type: 'string', required: true, description: '目标工具名(如 "bash"), "*" 表示任意工具。' },
      pattern: { type: 'string', required: true, description: '正则表达式源串。' },
      flags: { type: 'string', description: '正则 flags(如 "i")。' },
      action: { type: 'string', required: true, description: 'advisory | ask | deny。' },
      level: { type: 'string', description: 'L1-L4 严重度(默认 L2)。' },
      reason: { type: 'string', required: true, description: '命中时显示给模型的原因说明。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          rule: {
            type: 'object', additionalProperties: true,
            properties: {
              id: { type: 'string', required: true },
              tool: { type: 'string', required: true },
              pattern: { type: 'string', required: true },
              flags: { type: 'string', required: true },
              action: { type: 'string', required: true },
              level: { type: 'string', required: true },
              reason: { type: 'string', required: true },
              enabled: { type: 'boolean', required: true },
              createdAt: { type: 'string', required: true },
              updatedAt: { type: 'string', required: true },
            },
          },
        },
      },
      render(_a, v) {
        return [{ type: 'text', text: `rule_add: OK [${v.rule.action}] ${v.rule.id} /${v.rule.pattern}/${v.rule.flags} → tool=${v.rule.tool}` }];
      },
    },
    execute(args) {
      return rules.add({
        id: args.id,
        tool: args.tool,
        pattern: args.pattern,
        flags: args.flags,
        action: args.action,
        level: args.level,
        reason: args.reason,
      }).then((rule) => ({ rule }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rule_remove',
    description: '按 id 删除一条规则。',
    parameters: {
      id: { type: 'string', required: true, description: '规则 id。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          removed: { type: 'boolean', required: true },
        },
      },
      render(_a, v) {
        return [{ type: 'text', text: v.removed ? 'rule_remove: OK' : 'rule_remove: 没有找到这条规则' }];
      },
    },
    execute(args) {
      return rules.remove(args.id).then((removed) => ({ removed }));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rule_set_enabled',
    description: '启用或禁用一条已有规则(不删除)。用于临时绕过测试。',
    parameters: {
      id: { type: 'string', required: true, description: '规则 id。' },
      enabled: { type: 'boolean', required: true, description: 'true 启用, false 禁用。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          rule: {
            oneOf: [
              { type: 'object', additionalProperties: true },
              { type: 'null' },
            ],
            required: true,
          },
        },
      },
      render(_a, v) {
        return [{ type: 'text', text: v.rule ? `rule_set_enabled: OK [${v.rule.id}] enabled=${v.rule.enabled}` : 'rule_set_enabled: 没有找到这条规则' }];
      },
    },
    execute(args) {
      return rules.setEnabled(args.id, args.enabled).then((rule) => ({ rule }));
    },
  }));

  // First-boot seed (idempotent).
  void rules.seedIfEmpty().then(
    (r) => {
      if (r.seeded) console.log(`[agint-rules] seeded ${r.count} default rules`);
    },
    () => { /* domain not ready yet; will retry on first tool call */ },
  );
}

export { apply, inject, name };