/**
 * agint-rules: 工具 execute() **运行时返回值** vs output.schema 一致性守卫。
 *
 * 样板来源：plugins/agint-self-model/test/tool-output-conformance.test.mjs
 * （提案 1255b37a 后续动作第 1 条：「把本文件的模式抄给其余工具模块」）。
 * 样板写死的四条，本文件逐条对应：
 *   ① 每个模块配**该模块真实形状**的 fixture（不得用「对任何服务返回 []」的通用桩）；
 *   ② 至少一条**否定对照**：同一 schema 下喂必然违规的值 → 违规数组非空 + assertConforms 抛错；
 *   ③ 正向用例必须走到**非空**分支；
 *   ④ 断言口径固定为 validateJsonSchemaValue(tool.output.schema, await tool.execute(...)) 返回空数组。
 *
 * 本模块的 fixture = **真 Service + 内存版 storage domain**：
 *   lib/index.js 把规则表放在 storageDomain 的 `rule` 表里
 *   （lib/index.js:86-90 defineDomain；lib/index.js:489-496 的 table()）。
 *   这里给一个**内存实现的 storage domain**（Map 当表），不接生产存储，
 *   于是 seedIfEmpty / seedEpistemic / check / lint / audit 跑的都是真逻辑真数据：
 *   规则行来自 lib/index.js 自己的 seedRules（lib/index.js:95 起）与
 *   epistemicSeedRules（lib/index.js:304 起）—— 是该模块真实形状，不是通用桩。
 *
 * Run with: node --test plugins/agint-rules/test/tool-output-conformance.test.mjs
 *           （cwd = 仓库根 D:\DSH\project源码\DSH-AGINT）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

const require = createRequire(import.meta.url);
const plugin = require('../lib/index.js');
const toolsModule = require('../lib/tools.js');

const EXPECTED_TOOLS = [
  'rule_check', 'rule_list', 'rule_audit', 'rule_lint',
  'rule_add', 'rule_remove', 'rule_set_enabled',
];

/**
 * 内存版 storage domain：open(spec) → { table(name) }，
 * table 提供 get/put/delete/entries（lib/index.js:583-640 用到的全部方法）。
 * 这是**该模块真实形状**的存储替身（单表 `rule`），不是通用桩。
 */
function makeStorageDomain() {
  const tables = new Map();
  const domain = {
    async table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const rows = tables.get(name);
      return {
        get: (id) => rows.get(id),
        put: async (id, row) => { rows.set(id, row); return row; },
        delete: async (id) => rows.delete(id),
        entries: () => [...rows.entries()],
        get size() { return rows.size; },
      };
    },
    async close() {},
  };
  return { open: async () => domain };
}

/** 起真 Service（lib/index.js apply）+ 捕获 ctx.on 注册的钩子（audit 计数要用）。 */
function startService() {
  const provided = new Map();
  const handlers = new Map();
  const ctx = {
    get: (k) => provided.get(k) ?? null,
    provide: (k, v) => { provided.set(k, v); },
    effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {}; } catch { return () => {}; } },
    on: (event, handler) => { handlers.set(event, handler); return () => {}; },
    storageDomain: makeStorageDomain(),
    logger: { warn() {}, error() {} },
  };
  plugin.apply(ctx, {});
  const rules = ctx.get('agint.rules');
  assert.ok(rules, 'agint.rules 服务未注册 —— 下面的用例全是空转');
  return { rules, handlers };
}

/** 捕获 tools.js 注册的 7 个工具（defineTool 产物）。tools.js 用**方括号**取服务。 */
function captureTools(rules) {
  const registered = [];
  const ctx = { tools: { register: (t) => { registered.push(t); return () => {}; } }, 'agint.rules': rules };
  toolsModule.apply(ctx);
  return { tools: Object.fromEntries(registered.map((t) => [t.name, t])), registered };
}

/** apply 里的 seedIfEmpty / seedEpistemic 是 fire-and-forget（lib/index.js:770-785），等它落表。 */
async function waitForSeededRules(rules) {
  for (let i = 0; i < 100; i++) {
    const list = await rules.list({});
    if (list.length > 0) return list;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('seedIfEmpty 没能在 2s 内把种子规则写进表');
}

/** host 第二道门的真调用口径：validateJsonSchemaValue 返回**违规数组**（空数组 = 通过）。 */
function violationsOf(tool, value, label) {
  return validateJsonSchemaValue(tool.output.schema, value, `value(${label})`);
}

function assertConforms(tool, value, label) {
  const violations = violationsOf(tool, value, label);
  assert.deepEqual(
    violations,
    [],
    `${label} 过不了 ${tool.name} 的 output schema：\n${violations.join('\n')}`,
  );
}

test('前提自检：7 个 rules 工具都被捕获，且 output.schema 根是 object', async () => {
  const { rules } = startService();
  const { tools, registered } = captureTools(rules);
  assert.equal(registered.length, EXPECTED_TOOLS.length, `注册工具数 ${registered.length} ≠ 7`);
  for (const name of EXPECTED_TOOLS) assert.ok(tools[name], `缺工具 ${name}`);
  for (const name of EXPECTED_TOOLS) {
    assert.equal(tools[name].output.schema.type, 'object', `${name}.output.schema 根不是 object`);
  }
});

test('否定对照（通用口径）：裸返回数组过不了 object schema —— 护栏不是空转', async () => {
  const { rules } = startService();
  const { tools } = captureTools(rules);

  const bareTool = defineTool({
    name: 'nc_rule_check_bare_array',
    description: 'negative control: execute() 裸返回数组',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { tool: { required: true, type: 'string' } } },
      render: () => [{ type: 'text', text: 'nc' }],
    },
    execute: () => [{ ruleId: 'bash-rm-rf-root', action: 'deny' }],
  });

  const raw = await bareTool.execute({});
  assert.ok(Array.isArray(raw), '前提不成立：替身没有裸返回数组');
  const violations = violationsOf(bareTool, raw, 'nc-bare-array');
  assert.ok(violations.length > 0, '护栏空转：裸数组竟然过了 object schema');
  assert.ok(
    violations.some((v) => /must be an object/.test(v)),
    `违规信息里没有 host 的那句 "must be an object"：${JSON.stringify(violations)}`,
  );
  assert.throws(
    () => assertConforms(bareTool, raw, 'nc-bare-array'),
    /must be an object/,
    'assertConforms 对裸数组没有报错：断言被削弱了',
  );
  assert.equal(tools.rule_check.output.schema.type, 'object');
});

test('否定对照（本模块特有）：rule_check 缺 required 的 matched ⇒ 必然违规', async () => {
  const { rules } = startService();
  const { tools } = captureTools(rules);
  const tool = tools.rule_check;

  // rule_check 的 output.schema 把 tool/matched/deny/ask/advisory/invalidPatterns 全列 required
  const bad = { tool: 'bash' };
  const violations = violationsOf(tool, bad, 'check-missing-matched');
  assert.ok(violations.length > 0, '护栏空转：缺 required 字段竟然合规');
  assert.throws(
    () => assertConforms(tool, bad, 'check-missing-matched'),
    /schema|matched|required/i,
    'assertConforms 对缺 required 字段没有报错',
  );
});

test('正向：rule_add 真写进规则表，返回的 rule 行过自己的 schema', async () => {
  const { rules } = startService();
  const { tools } = captureTools(rules);

  const value = await tools.rule_add.execute({
    id: 'nc-rule-1', tool: 'bash', pattern: 'rm\\s+-rf', flags: 'i',
    action: 'deny', level: 'L1', reason: '测试用规则',
  });
  assert.ok(value.rule, 'rule 为空');
  assert.equal(value.rule.id, 'nc-rule-1');
  assert.equal(value.rule.enabled, true);
  assert.equal(typeof value.rule.createdAt, 'string');
  assertConforms(tools.rule_add, value, 'rule_add');
});

test('正向：rule_check 命中 deny 规则（deny 非空、matched > 0）过自己的 schema', async () => {
  const { rules } = startService();
  const { tools } = captureTools(rules);
  await waitForSeededRules(rules);

  const value = await tools.rule_check.execute({ tool: 'bash', args: { command: 'rm -rf /' } });
  assert.equal(value.tool, 'bash');
  assert.ok(value.matched > 0, `matched=${value.matched}，没走到非空分支`);
  assert.ok(value.deny.length > 0, 'deny 为空：种子规则没命中 rm -rf /');
  assert.equal(typeof value.deny[0].ruleId, 'string');
  assert.ok(Array.isArray(value.ask) && Array.isArray(value.advisory) && Array.isArray(value.invalidPatterns));
  assertConforms(tools.rule_check, value, 'rule_check');
});

test('正向：rule_list 列出真种子规则（含 epistemic 断言字段）过自己的 schema', async () => {
  const { rules } = startService();
  const { tools } = captureTools(rules);
  await waitForSeededRules(rules);

  const value = await tools.rule_list.execute({});
  assert.ok(Array.isArray(value.rules) && value.rules.length > 0, 'rules 为空 —— 没走到非空分支');
  // 断言型种子（claim 通道）的字段也在 output schema 里声明过（tools.js rule_list items）
  const claimRule = value.rules.find((r) => r.id === 'epistemic-negated-existence');
  assert.ok(claimRule, '没有断言型种子规则：seedEpistemic 没跑');
  assert.equal(claimRule.claim, true);
  assert.equal(claimRule.claimKind, 'existence');
  assertConforms(tools.rule_list, value, 'rule_list');
});

test('正向：rule_audit 在真钩子命中后计数非空过自己的 schema', async () => {
  const { rules, handlers } = startService();
  const { tools } = captureTools(rules);
  await waitForSeededRules(rules);

  // audit 计数只在 ctx.on('tools/pre-execute') 钩子里 bump（lib/index.js:795-810）
  const hook = handlers.get('tools/pre-execute');
  assert.ok(hook, '没有捕获到 tools/pre-execute 钩子');
  const verdict = await hook({ name: 'bash', arguments: { command: 'rm -rf /' } }, async () => ({ kind: 'accept' }));
  assert.ok(verdict && verdict.kind, `pre-execute 钩子没有给出判定：${JSON.stringify(verdict)}`);

  const value = await tools.rule_audit.execute({});
  assert.ok(Array.isArray(value.rules) && value.rules.length > 0, 'audit.rules 为空 —— 钩子没 bump 计数');
  assert.ok(value.totals.hits > 0, `totals.hits=${value.totals.hits}，没走到非空分支`);
  assert.equal(typeof value.rules[0].epistemics, 'number');
  assertConforms(tools.rule_audit, value, 'rule_audit');
});

test('正向：rule_lint 报出非法 pattern（issues 非空）过自己的 schema', async () => {
  const { rules } = startService();
  const { tools } = captureTools(rules);
  await waitForSeededRules(rules);

  // 故意加一条编译不过的正则 —— compilePattern 返回 null（lib/index.js:147-155），lint 才报
  await tools.rule_add.execute({
    id: 'nc-bad-regex', tool: 'bash', pattern: '(', flags: '',
    action: 'advisory', level: 'L2', reason: '故意非法',
  });

  const value = await tools.rule_lint.execute({});
  assert.ok(Array.isArray(value.issues) && value.issues.length > 0, 'issues 为空 —— 没走到非空分支');
  const issue = value.issues.find((i) => i.ruleId === 'nc-bad-regex');
  assert.ok(issue, `没报出 nc-bad-regex：${JSON.stringify(value.issues)}`);
  assert.equal(issue.kind, 'invalid-pattern');
  assertConforms(tools.rule_lint, value, 'rule_lint');
});

test('正向：rule_set_enabled / rule_remove 的返回值过自己的 schema', async () => {
  const { rules } = startService();
  const { tools } = captureTools(rules);
  await waitForSeededRules(rules);

  const disabled = await tools.rule_set_enabled.execute({ id: 'bash-rm-rf-root', enabled: false });
  assert.ok(disabled.rule, 'rule 为空');
  assert.equal(disabled.rule.enabled, false);
  assertConforms(tools.rule_set_enabled, disabled, 'rule_set_enabled');

  const removed = await tools.rule_remove.execute({ id: 'bash-rm-rf-root' });
  assert.equal(removed.removed, true, 'removed 不为 true');
  assertConforms(tools.rule_remove, removed, 'rule_remove');
});
