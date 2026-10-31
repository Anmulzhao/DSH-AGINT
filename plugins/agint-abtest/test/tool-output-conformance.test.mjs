
/**
 * agint-abtest: 工具 execute() **运行时返回值** vs output.schema 一致性守卫。
 *
 * 样板来源：plugins/agint-self-model/test/tool-output-conformance.test.mjs
 * （提案 1255b37a 后续动作第 1 条：把本文件的模式抄给其余工具模块）。
 * 本文件满足样板列出的 4 条硬要求：
 *   ① fixture 是本模块真实形状 —— 这里直接起 agint-abtest 的**真实 provider**
 *      （lib/index.js apply + 内存 storage domain），不是「对任何服务返回 []」
 *      的通用桩；
 *   ② 至少一条否定对照（见「否定对照」用例）；
 *   ③ 正向用例走到非空分支（tests 非空 / samples=20 / testId 非空）；
 *   ④ 断言口径 = validateJsonSchemaValue(tool.output.schema, await tool.execute(...))
 *      返回空数组。tool.output.schema 已是 raw JSON Schema，不再过
 *      valueSchemaSpecToJsonSchema。
 *
 * 取证：
 *   - 工具导出形状：plugins/agint-abtest/lib/tools.js（3 个工具
 *     abtest_list_tests / abtest_report / abtest_start）；
 *   - 服务契约：plugins/agint-abtest/lib/index.js:244 ctx.provide('agint.abtest', ...)
 *   - 内存 storage domain 脚手架抄自 plugins/agint-abtest/test/abtest-smoke.test.mjs
 *     （同插件既有测试，保证不是自造形状）。
 *
 * Run with: node --test plugins/agint-abtest/test/tool-output-conformance.test.mjs
 *           （cwd = 仓库根）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

const require = createRequire(import.meta.url);
const plugin = require('../lib/index.js');
const toolsModule = require('../lib/tools.js');

/** 内存版 storage domain（抄自 plugins/agint-abtest/test/abtest-smoke.test.mjs 的 makeMockCtx）。 */
function makeCtx() {
  const providers = {};
  const tables = {};
  return {
    _providers: providers,
    _tables: tables,
    storageDomain: {
      open: async () => ({
        async table(name) {
          if (!tables[name]) tables[name] = new Map();
          return {
            put: async (id, value) => { tables[name].set(id, value); return true; },
            get: (id) => tables[name].get(id) ?? null,
            delete: async (id) => { tables[name].delete(id); return true; },
            entries: () => Array.from(tables[name].values()),
          };
        },
      }),
    },
    get: (name) => providers[name] ?? null,
    provide: (name, val) => { providers[name] = val; },
    effect: () => {},
    on: () => {},
  };
}

/**
 * 起真实 agint.abtest provider（lib/index.js apply）+ 捕获 tools.js 注册的 3 个工具。
 * tools.js 用方括号取服务（ctx['agint.abtest']），必须显式挂。
 */
function start() {
  const ctx = makeCtx();
  plugin.apply(ctx, {});
  const abtest = ctx._providers['agint.abtest'];
  assert.ok(abtest, 'agint.abtest provider 未注册');
  const registered = [];
  const toolCtx = { tools: { register: (t) => { registered.push(t); return () => {}; } } };
  toolCtx['agint.abtest'] = abtest;
  toolsModule.apply(toolCtx);
  const tools = Object.fromEntries(registered.map((t) => [t.name, t]));
  return { ctx, abtest, tools, registered };
}

/** host 第二道门的真调用口径：validateJsonSchemaValue 返回违规数组（空数组 = 通过）。 */
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

/** host 侧硬门槛 taskSuite.length >= 10（tools.js TASK_SUITE_MIN）。 */
function taskSuite(n = 10) {
  return Array.from({ length: n }, (_, k) => `task-${k + 1}`);
}

const EXPECTED_TOOLS = ['abtest_list_tests', 'abtest_report', 'abtest_start'];

test('前提自检：3 个 abtest 工具都被捕获，schema 根是 object（否则后面的全绿是空转）', () => {
  const { tools, registered } = start();
  assert.equal(registered.length, EXPECTED_TOOLS.length, `注册工具数 ${registered.length} ≠ 3`);
  for (const name of EXPECTED_TOOLS) {
    assert.ok(tools[name], `缺工具 ${name}`);
    assert.equal(tools[name].output.schema.type, 'object', `${name}.output.schema 根不是 object`);
  }
});

test('否定对照：同一 schema 下喂必然违规的值（裸数组）⇒ 违规数组非空 + assertConforms 抛错', () => {
  const { tools } = start();
  const tool = tools.abtest_list_tests;
  const bare = [{ testId: 'abt-x', status: 'running' }];
  const violations = violationsOf(tool, bare, 'nc-bare-array');
  assert.ok(violations.length > 0, '护栏空转：裸数组竟然过了 object schema，本测试无判别力');
  assert.match(violations.join('\n'), /object/, `违规信息里没有提到 object：${JSON.stringify(violations)}`);
  assert.throws(
    () => assertConforms(tool, bare, 'nc-bare-array'),
    /output schema/,
    'assertConforms 对裸数组没有报错：断言被削弱了',
  );
});

test('正向：abtest_start 真实返回过自己的 schema（非空分支：testId + status）', async () => {
  const { tools } = start();
  const value = await tools.abtest_start.execute({
    variantA: { promptId: 'sys-prompt', version: 'v1' },
    variantB: { promptId: 'sys-prompt', version: 'v2' },
    taskSuite: taskSuite(10),
    significanceThreshold: 0.05,
  });
  assert.ok(value && typeof value.testId === 'string' && value.testId.length > 0, `start 没产出 testId：${JSON.stringify(value)}`);
  assert.equal(value.status, 'running');
  assertConforms(tools.abtest_start, value, 'start');
});

test('正向：abtest_list_tests 真实返回过自己的 schema（非空分支：tests 数组非空）', async () => {
  const { tools } = start();
  await tools.abtest_start.execute({
    variantA: { promptId: 'sys-prompt', version: 'v1' },
    variantB: { promptId: 'sys-prompt', version: 'v2' },
    taskSuite: taskSuite(10),
  });
  const value = await tools.abtest_list_tests.execute({});
  assert.ok(Array.isArray(value.tests) && value.tests.length > 0, `listTests 没产出真行：${JSON.stringify(value)}`);
  assert.equal(value.tests[0].status, 'running');
  assertConforms(tools.abtest_list_tests, value, 'list');
});

test('正向：abtest_report 真实返回过自己的 schema（非空分支：20 条样本 → 真统计）', async () => {
  const { ctx, tools } = start();
  const started = await tools.abtest_start.execute({
    variantA: { promptId: 'sys-prompt', version: 'v1' },
    variantB: { promptId: 'sys-prompt', version: 'v2' },
    taskSuite: taskSuite(10),
  });
  // 注入 20 条样本（A=0.9 / B=0.5），让 report 走「有样本」分支而不是空样本分支。
  await (await ctx.storageDomain.open({})).table('samples');
  const samples = ctx._tables.samples;
  assert.ok(samples, 'samples 表未创建');
  for (let i = 0; i < 10; i++) {
    samples.set(`s-A-${i}`, { id: `s-A-${i}`, kind: 'sample', testId: started.testId, variant: 'A', score: 0.9, taskId: `t${i}`, createdAt: new Date().toISOString() });
    samples.set(`s-B-${i}`, { id: `s-B-${i}`, kind: 'sample', testId: started.testId, variant: 'B', score: 0.5, taskId: `t${i}`, createdAt: new Date().toISOString() });
  }
  const value = await tools.abtest_report.execute({ testId: started.testId });
  assert.equal(value.samples, 20, `report 没读到注入的 20 条样本：${JSON.stringify(value)}`);
  assert.ok(['A', 'B', 'inconclusive'].includes(value.winner), `winner 非法：${JSON.stringify(value)}`);
  assert.equal(typeof value.pValue, 'number');
  assert.equal(typeof value.effectSize, 'number');
  assertConforms(tools.abtest_report, value, 'report');
});
