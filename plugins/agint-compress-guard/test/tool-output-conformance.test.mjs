
/**
 * agint-compress-guard: 工具 execute() **运行时返回值** vs output.schema 一致性守卫。
 *
 * 样板来源：plugins/agint-self-model/test/tool-output-conformance.test.mjs
 * （提案 1255b37a 后续动作第 1 条：把本文件的模式抄给其余工具模块）。
 * 本文件满足样板列出的 4 条硬要求：
 *   ① fixture 是本模块真实形状 —— 起**真实 provider**（lib/index.js apply）+ 内存 storage
 *      domain，洞察行用本插件 lib/storage.js 的 packInsight() 打包（真实形状）；
 *   ② 至少一条否定对照（见「否定对照」用例）；
 *   ③ 正向用例走到非空分支（insights 非空 / coverage.insights >= 1）；
 *   ④ 断言口径 = validateJsonSchemaValue(tool.output.schema, await tool.execute(...))
 *      返回空数组；tool.output.schema 已是 raw JSON Schema，不再过 valueSchemaSpecToJsonSchema。
 *
 * 取证：
 *   - 工具形状：plugins/agint-compress-guard/lib/tools.js（2 个只读工具
 *     compress_recall / compress_guard_stats；两者 schema 均为 { type: object, additionalProperties: true }）；
 *   - 服务契约：plugins/agint-compress-guard/lib/index.js:190 ctx.provide('agint.compressGuard', ...)：
 *     recall() 返回 { insights, rawRefs, status }（lib/engine.js:425）；
 *     stats() 返回 { status, noSourceReached, byType, byStatus, recallHitRate, counters,
 *       coverage, tiers, sourceHealth, config, recovery }（lib/engine.js:506-532）；
 *   - 脚手架：内存 storage domain + mock ctx 抄自同插件既有测试
 *     plugins/agint-compress-guard/test/_helpers.mjs（不新造形状）。
 *
 * Run with: node --test plugins/agint-compress-guard/test/tool-output-conformance.test.mjs
 *           （cwd = 仓库根）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

import * as plugin from '../lib/index.js';
import * as toolsModule from '../lib/tools.js';
import { packInsight } from '../lib/storage.js';
import { makeCtx, makeMemory, makeEventBus } from './_helpers.mjs';

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

/**
 * 起真实 agint.compressGuard provider + 捕获 tools.js 注册的 2 个工具。
 * tools.js 用方括号取服务（ctx['agint.compressGuard']），必须显式挂。
 */
async function start() {
  const ctx = makeCtx({ memory: makeMemory(() => []), eventBus: makeEventBus() });
  plugin.apply(ctx, {});
  const svc = ctx.services['agint.compressGuard'];
  assert.ok(svc, 'agint.compressGuard provider 未注册');
  const registered = [];
  const toolCtx = { tools: { register: (t) => { registered.push(t); return () => {}; } } };
  toolCtx['agint.compressGuard'] = svc;
  toolsModule.apply(toolCtx);
  const tools = Object.fromEntries(registered.map((t) => [t.name, t]));
  return { ctx, svc, tools, registered };
}

/** 用本插件 lib/storage.js 的 packInsight() 打包一条**真实形状**的洞察行。 */
function makeInsight() {
  return packInsight({
    type: 'fact',
    content: '端口 3080 是 web 服务端口',
    source: {
      checkpointRef: {
        kind: 'host-compaction',
        id: 'cp_3080',
        extractedAt: '2026-09-13T00:00:00.000Z',
        extractor: 'rule-v1',
      },
    },
    linkPending: false,
  });
}

const EXPECTED_TOOLS = ['compress_recall', 'compress_guard_stats'];

test('前提自检：2 个 compress-guard 工具都被捕获，schema 根是 object（否则后面的全绿是空转）', async () => {
  const { tools, registered } = await start();
  assert.equal(registered.length, EXPECTED_TOOLS.length, `注册工具数 ${registered.length} ≠ 2`);
  for (const name of EXPECTED_TOOLS) {
    assert.ok(tools[name], `缺工具 ${name}`);
    assert.equal(tools[name].output.schema.type, 'object', `${name}.output.schema 根不是 object`);
  }
});

test('否定对照：同一 schema 下喂必然违规的值（裸数组）⇒ 违规数组非空 + assertConforms 抛错', async () => {
  const { tools } = await start();
  const tool = tools.compress_recall;
  const bare = [{ type: 'fact', content: 'x' }];
  const violations = violationsOf(tool, bare, 'nc-bare-array');
  assert.ok(violations.length > 0, '护栏空转：裸数组竟然过了 object schema，本测试无判别力');
  assert.match(violations.join('\n'), /object/, `违规信息里没有提到 object：${JSON.stringify(violations)}`);
  assert.throws(
    () => assertConforms(tool, bare, 'nc-bare-array'),
    /output schema/,
    'assertConforms 对裸数组没有报错：断言被削弱了',
  );
});

test('正向：compress_recall 真实返回过自己的 schema（非空分支：insights 非空 + status=HIT）', async () => {
  const { ctx, tools } = await start();
  const insights = await ctx.domain.table('insights');
  const rec = makeInsight();
  await insights.put(rec.id, rec);
  const value = await tools.compress_recall.execute({ query: '3080' });
  assert.ok(Array.isArray(value.insights) && value.insights.length > 0, `recall 没命中洞察（测不到真形状）：${JSON.stringify(value)}`);
  assert.equal(value.status, 'HIT');
  assert.equal(value.insights[0].type, 'fact');
  assertConforms(tools.compress_recall, value, 'recall');
});

test('正向：compress_guard_stats 真实返回过自己的 schema（非空分支：coverage.insights >= 1）', async () => {
  const { ctx, tools } = await start();
  const insights = await ctx.domain.table('insights');
  const rec = makeInsight();
  await insights.put(rec.id, rec);
  const value = await tools.compress_guard_stats.execute({});
  assert.ok(value.coverage && value.coverage.insights >= 1, `stats 没统计到洞察行：${JSON.stringify(value.coverage)}`);
  assert.equal(value.byType.fact, 1, `byType.fact 不等于 1：${JSON.stringify(value.byType)}`);
  assert.equal(value.coverage.pendingInsights, 0);
  assertConforms(tools.compress_guard_stats, value, 'stats');
});
