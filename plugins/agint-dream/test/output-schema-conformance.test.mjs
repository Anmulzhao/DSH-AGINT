/**
 * agint-dream: 工具 output schema 与实际返回形状一致性守卫（2026-09-27）。
 *
 * 背景（提案 0f91c868 问题 1）：sweep.js / index.js 陆续给返回值加了
 * dedupeStats / health / dedupe 等字段，但 tools.js 的 output schema 是
 * additionalProperties:false —— 字段一多就整体校验失败，工具直接不可用
 * （前科：2026-09-11 evolutionTemplates 漏同步，dream_status 全挂）。
 *
 * 本测试固定三件事：
 *   1. dream_status 实际返回（lib/index.js status()）能过 dream_status schema；
 *   2. dream_run_now 实际返回（lib/sweep.js runSweep）能过 dream_run_now schema；
 *   3. 校验走的是**真 dsh-tools 管线**（valueSchemaSpecToJsonSchema 编译 +
 *      validateJsonSchemaValue 断言），与 host 侧两道门一致。
 *
 * 以后给 sweep 返回值加任何顶层 / counts 字段，先改 tools.js schema，
 * 再跑本测试 —— 否则这里红。
 *
 * Run with: node --test plugins/agint-dream/test/output-schema-conformance.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

const require = createRequire(import.meta.url);
const plugin = require('../lib/index.js');
const toolsModule = require('../lib/tools.js');

/** 捕获 tools.js 注册的全部工具（defineTool 产物），按名字索引 */
function captureTools(dreamService) {
  const registered = [];
  const ctx = {
    tools: { register: (t) => registered.push(t) },
    'agint.dream': dreamService,
  };
  toolsModule.apply(ctx);
  return Object.fromEntries(registered.map((t) => [t.name, t]));
}

/**
 * 真 host 第二道门（对齐 dsh-tools lib/index.js:3543 的用法）：
 * validateJsonSchemaValue 返回**违规数组**（空数组 = 通过），不是抛错。
 * 注意：defineTool 注册时已完成 DSL→raw JSON Schema 编译（author 形态的
 * 属性级 required 已转成父级 required 数组），此处**不能再过一遍
 * valueSchemaSpecToJsonSchema**，否则报 schema.required unsupported。
 * author 形态的方言合规由 bin/check-tool-schemas.mjs 负责。
 */
function assertConforms(tool, value, label) {
  const violations = validateJsonSchemaValue(tool.output.schema, value, `value(${label})`);
  assert.deepEqual(
    violations,
    [],
    `${label} 过不了 ${tool.name} 的 output schema：\n${violations.join('\n')}`,
  );
}

async function makeDirs(prefix) {
  const base = await mkdtemp(join(tmpdir(), `dream-schema-${prefix}-`));
  const sessions = join(base, 'sessions');
  const diary = join(base, 'diary');
  await mkdir(sessions, { recursive: true });
  await mkdir(diary, { recursive: true });
  return { base, sessions, diary };
}

/**
 * 贴生产路径：host 会先用插件导出的 Config（zod）parse 配置填默认值，
 * 再调 apply。测试若跳过这步，status() 里的 lookbackDays/recover 等是
 * undefined —— 那是脚手架失真，不是 schema 问题。
 */
function makeDream(prefix) {
  const { base, sessions, diary } = dirsByPrefix.get(prefix);
  const services = {};
  const ctx = {
    get: () => null, // 无 bus / 无 memory：走空会话路径，形状与真实一致
    provide: (n, f) => { services[n] = f; },
    effect: () => () => undefined,
  };
  const config = plugin.Config.parse({ root: diary, sessionsRoot: sessions });
  plugin.apply(ctx, config);
  return services['agint.dream'];
}

const dirsByPrefix = new Map();

test('dream_status 实际返回过得了自己的 output schema', async () => {
  dirsByPrefix.set('status', await makeDirs('status'));
  const dream = makeDream('status');

  const value = await dream.status();
  assertConforms(captureTools(dream).dream_status, value, 'status()');

  await rm(dirsByPrefix.get('status').base, { recursive: true, force: true });
});

test('dream_run_now 实际返回（dry-run sweep）过得了自己的 output schema', async () => {
  dirsByPrefix.set('sweep', await makeDirs('sweep'));
  const dream = makeDream('sweep');

  const value = await dream.sweep({ apply: false });
  assertConforms(captureTools(dream).dream_run_now, value, 'sweep(apply:false)');

  await rm(dirsByPrefix.get('sweep').base, { recursive: true, force: true });
});

/**
 * K164 第四次咬人的那条路径（2026-10-05 修 dream_status 时补的）。
 *
 * 为什么上面那条 status 用例抓不到本bug：
 *   status() 返回 `counts: last?.counts ?? {兜底}`。
 *   「还没跑过 sweep」时 last 为 null ⇒ 走兜底 ⇒ **碰不到 dedupeStats**；
 *   跑过 sweep 后 last.counts 才带上 dedupeStats（sweep.js:1401）。
 *   前者永远绿，后者红 —— 而生产上宿主重启前必然是后者。
 * 所以必须显式先 sweep 一次再查 status，让它走真分支。
 */
test('dream_status 在**跑过 sweep 之后**仍过得了自己的 output schema（counts 带 dedupeStats）', async () => {
  dirsByPrefix.set('after-sweep', await makeDirs('after-sweep'));
  const dream = makeDream('after-sweep');

  // 先跑一次，让 state.lastResult 有真counts
  await dream.sweep({ apply: false });

  const value = await dream.status();
  // 先坐实前提：这条路径真的带上了 dedupeStats（否则本用例是假绿）
  assert.ok(
    value.counts.dedupeStats,
    '前提不成立：sweep 后 status().counts.dedupeStats 仍缺失，本用例什么也没测到',
  );
  assertConforms(captureTools(dream).dream_status, value, 'status() after sweep');

  await rm(dirsByPrefix.get('after-sweep').base, { recursive: true, force: true });
});
