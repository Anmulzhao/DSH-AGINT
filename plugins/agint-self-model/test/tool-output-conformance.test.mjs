/**
 * agint-self-model: 工具 execute() **运行时返回值** vs output.schema 一致性守卫。
 *
 * 为什么需要这一层（提案 1255b37a）：仓库原有护栏 `test/tool-output-schema.test.mjs`
 * 只校验 `output.schema` 能不能过 dsh 的值 schema 编译器（**编译期**）。
 * 裸返回数组的作者侧 schema `{ type: 'object' }` 编译期完全合法 —— 编译器只看
 * schema 不看返回值。于是 selfModel_calibrate 直接 `return await calibrate(...)`
 * （Service 契约是 CalibrationResult[]）时，编译通过、测试全绿，
 * 直到 host 第二道门在**运行时**校验返回值：
 *
 *     returned invalid output: "value" must be an object
 *
 * 修法（commit 2612b9a）在工具边界加 asObjectResult() 信封。本测试盯的就是这条边界：
 *   正向：5 个工具 execute() 的真实返回值都必须过自己的 output.schema。
 *   否定对照：同一 schema 下喂「包装前的裸数组」必须红 —— 证明护栏有判别力、
 *            且 asObjectResult 是承重结构（删掉它这里就红）。
 *
 * 校验走**真 dsh-tools 管线**（validateJsonSchemaValue 返回违规数组，空数组 = 通过），
 * 与 host 侧同一份实现，不是我们复述的规则。
 *
 * 注意：defineTool 注册时已完成 DSL → raw JSON Schema 编译，`tool.output.schema`
 * 已经是 raw 形态。**不能再过一遍 valueSchemaSpecToJsonSchema**：raw schema 上
 * 的根层 `required: [...]` 不是作者 DSL 形态，重编译会抛
 * `unsupported JSON schema: schema.required is not supported by the value schema DSL`。
 * 最后一条用例把这个机制坐实（避免以后有人"顺手再编一遍"）。
 *
 * Run with: node --test plugins/agint-self-model/test/tool-output-conformance.test.mjs
 *           （cwd = 仓库根 D:\DSH\project源码\DSH-AGINT）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { defineTool, validateJsonSchemaValue, valueSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools';

const require = createRequire(import.meta.url);
const plugin = require('../lib/index.js');
const toolsModule = require('../lib/tools.js');

const SERVICE_KEYS = [
  'agint.selfModel.snapshot',
  'agint.selfModel.update',
  'agint.selfModel.calibrate',
  'agint.selfModel.stats',
  'agint.selfModel.inspectSummary',
];

/**
 * mock ctx，与 test/smoke.mjs 同口径：storageDomain.open 同步抛错 ⇒ openStore 降级
 * 内存表（真实 Service 逻辑不变，只是不落盘）。数据源用真形状的假值，让
 * calibrate / update 走**非空**分支 —— 空分支会假绿（对照 dream 测试 K164 教训）。
 */
function makeCtx(services = {}) {
  const provided = new Map(Object.entries(services));
  return {
    get: (k) => provided.get(k) ?? null,
    provide: (k, v) => { provided.set(k, v); },
    effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {}; } catch { return () => {}; } },
    storageDomain: { open: () => { throw new Error('test: no real storage'); } },
    on: () => () => {},
  };
}

/** 与 smoke.mjs 相同的软降级数据源（真返回形状：数组 + 对象）。 */
function dataSources() {
  return {
    'agint.eventBus.publish': async () => ({ accepted: true }),
    'agint.eventBus.subscribe': () => () => {},
    'agint.evolution': {
      queryFailures: async () => [
        { category: 'codegen', pattern: 'pf1' },
        { category: 'codegen', pattern: 'pf2' },
        { category: 'reasoning', pattern: 'pf3' },
      ],
      queryTemplates: async () => [
        { category: 'codegen', pattern: 'pt1' },
        { category: 'codegen', pattern: 'pt2' },
      ],
      addFailure: async () => ({}),
    },
    'agint.diagnosis': {
      report: async () => ({
        rootCauseDistribution: {
          REASONING_ERROR: 1, PLANNING_FAILURE: 0, PROMPT_DEFICIENCY: 0,
          TOOL_GAP: 0, KNOWLEDGE_GAP: 0, ENVIRONMENT_SHIFT: 0, UNCERTAIN: 0,
        },
      }),
    },
    'agint.metrics': { summary: async () => ({ metrics: [] }) },
    'agint.toolStats': { summary: async () => ({ summary: [] }) },
  };
}

/** 起一个真 Service 实例（lib/index.js apply），返回按 key 取 Service 的函数。 */
function startService(overrides = {}) {
  const ctx = makeCtx({ ...dataSources(), ...overrides });
  plugin.apply(ctx, {});
  return (key) => {
    const svc = ctx.get(key);
    assert.ok(svc, `Service 未注册：${key}`);
    return svc;
  };
}

/**
 * 捕获 tools.js 注册的 5 个工具（defineTool 产物）。ctx 同时提供 tools.register
 * 与 5 个 Service —— tools.js 用**方括号**取 Service（不是 ctx.get），必须显式挂。
 */
function captureTools(getService) {
  const registered = [];
  const ctx = { tools: { register: (t) => { registered.push(t); return () => {}; } } };
  for (const key of SERVICE_KEYS) ctx[key] = getService(key);
  toolsModule.apply(ctx);
  return { tools: Object.fromEntries(registered.map((t) => [t.name, t])), registered };
}

/**
 * host 第二道门的真调用口径：validateJsonSchemaValue 返回**违规数组**
 * （空数组 = 通过），不抛错。空数组以外的任何东西都是 bug。
 */
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

const EXPECTED_TOOLS = [
  'selfModel_snapshot', 'selfModel_update', 'selfModel_calibrate',
  'selfModel_stats', 'selfModel_inspectSummary',
];

test('前提自检：5 个 self-model 工具都被捕获（否则后面的"全绿"是空转）', () => {
  const { tools, registered } = captureTools(startService());
  assert.equal(registered.length, EXPECTED_TOOLS.length, `注册工具数 ${registered.length} ≠ 5`);
  for (const name of EXPECTED_TOOLS) assert.ok(tools[name], `缺工具 ${name}`);
  // 编译后的 raw schema 必须是 object 根（这正是裸数组过不去的原因）
  for (const name of EXPECTED_TOOLS) {
    assert.equal(tools[name].output.schema.type, 'object', `${name}.output.schema 根不是 object`);
  }
});

test('否定对照 1：护栏有判别力 —— 裸返回数组的工具产出真违规（非空、含 must be an object）', async () => {
  // 造一个和 selfModel_calibrate **同 schema** 的替身，但 execute 裸返回数组
  // （= 2612b9a 之前 selfModel_calibrate 的行为）。
  const bareTool = defineTool({
    name: 'nc_selfModel_calibrate_bare_array',
    description: 'negative control: execute() 裸返回 CalibrationResult[]',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: () => [{ type: 'text', text: 'nc' }],
    },
    execute: () => [{ domain: 'codegen', error: 0, samples: 12 }],
  });

  const raw = await bareTool.execute({});
  assert.ok(Array.isArray(raw), '前提不成立：替身没有裸返回数组，本用例什么也没测到');

  const violations = violationsOf(bareTool, raw, 'nc-bare-array');
  assert.ok(
    violations.length > 0,
    '护栏空转：裸数组竟然过了 object schema，本测试无判别力',
  );
  assert.ok(
    violations.some((v) => /must be an object/.test(v)),
    `违规信息里没有 host 的那句 "must be an object"：${JSON.stringify(violations)}`,
  );
  // 且断言 helper 自己必须红 —— 否则「全绿」可能是 helper 把违规吃掉了
  assert.throws(
    () => assertConforms(bareTool, raw, 'nc-bare-array'),
    /must be an object/,
    'assertConforms 对裸数组没有报错：断言被削弱了',
  );
});

test('否定对照 2：包装前的裸值确实红，包装后才绿 —— asObjectResult 是承重结构', async () => {
  // 注入替身 calibrate：返回**裸数组**（Service 契约 CalibrationResult[] 的真形态）。
  // 工具侧走真 tools.js（含 asObjectResult）。
  const bareArray = [{ domain: 'integration', error: 0.4, samples: 20 }];
  const { tools } = captureTools((key) => {
    if (key === 'agint.selfModel.calibrate') return async () => bareArray;
    return async () => ({ ok: true });
  });

  const tool = tools.selfModel_calibrate;
  const produced = await tool.execute({ windowDays: 7 });

  // ① 包装前的裸值过不了 schema（这是 1255b37a 的原始故障面）
  const rawViolations = violationsOf(tool, bareArray, 'calibrate-raw');
  assert.ok(rawViolations.length > 0, '护栏空转：包装前的裸数组竟然合规');
  assert.ok(rawViolations.some((v) => /must be an object/.test(v)));

  // ② 工具真实产出的信封必须绿（证明包装把裸值救回来了）
  assert.ok(produced && !Array.isArray(produced), `工具没有产出对象信封：${JSON.stringify(produced)}`);
  assertConforms(tool, produced, 'calibrate-execrete-output');

  // ③ 信封真的带着那批数据（否则「绿」可能来自空信封）
  assert.deepEqual(produced.results, bareArray, '信封里没有原始结果数组，包装失真');
  assert.equal(produced.count, bareArray.length);
});

test('正向：selfModel_calibrate 真实返回（Service calibrate() → 信封）过自己的 schema', async () => {
  const svcCalibrate = startService()('agint.selfModel.calibrate');
  const { tools } = captureTools(startService());

  const value = await tools.selfModel_calibrate.execute({ windowDays: 7 });
  assert.ok(value && !Array.isArray(value), '工具返回的不是对象信封');
  assertConforms(tools.selfModel_calibrate, value, 'calibrate');

  // 同时坐实「Service 出口仍是数组」—— 该契约不能被工具层改动破坏
  const raw = await svcCalibrate({ windowDays: 7 });
  assert.ok(Array.isArray(raw), 'Service 契约被改动：calibrate() 不再返回数组');
  assert.ok(raw.length > 0, '前置数据没生效：calibrate() 返回空数组，本用例测不到东西');
});

test('正向：selfModel_update 真实返回过自己的 schema', async () => {
  const { tools } = captureTools(startService());
  const value = await tools.selfModel_update.execute({
    trigger: 'weekly',
    evidence: { domain: 'integration', result: 'pass', challengeId: 'curriculum-nc-1' },
  });
  assert.equal(value?.ok, true, 'update 返回 ok 不为 true');
  assert.ok(Array.isArray(value.updatedDomains) && value.updatedDomains.length > 0, 'updatedDomains 为空，测不到真形状');
  assertConforms(tools.selfModel_update, value, 'update');
});

test('正向：selfModel_snapshot 真实返回过自己的 schema（含域过滤分支）', async () => {
  const { tools } = captureTools(startService());
  // 先刷一次，让 capability_map 有真行 —— 否则 snapshot 返回空数组，测不到真形状
  await tools.selfModel_update.execute({ trigger: 'weekly' });

  const all = await tools.selfModel_snapshot.execute({});
  assert.ok(Array.isArray(all.capabilities) && all.capabilities.length > 0, 'snapshot.capabilities 为空');
  assertConforms(tools.selfModel_snapshot, all, 'snapshot');

  const filtered = await tools.selfModel_snapshot.execute({ domain: 'codegen' });
  assert.ok(
    Array.isArray(filtered.capabilities) && filtered.capabilities.length > 0
      && filtered.capabilities.every((c) => c.domain === 'codegen'),
    '域过滤分支没生效或返回空，本用例没覆盖到真形状',
  );
  assertConforms(tools.selfModel_snapshot, filtered, 'snapshot(domain)');
});

test('正向：selfModel_stats 真实返回过自己的 schema', async () => {
  const { tools } = captureTools(startService());
  await tools.selfModel_update.execute({ trigger: 'weekly' }); // 先写点数据，避免全零假绿
  const value = await tools.selfModel_stats.execute({});
  assert.ok(value.capabilityMap > 0, 'stats.capabilityMap 为 0，测不到真形状');
  assertConforms(tools.selfModel_stats, value, 'stats');
});

test('正向：selfModel_inspectSummary 真实返回过自己的 schema', async () => {
  const { tools } = captureTools(startService());
  await tools.selfModel_update.execute({ trigger: 'weekly' });
  const value = await tools.selfModel_inspectSummary.execute({});
  assert.ok(value.capabilityCount > 0, 'inspectSummary.capabilityCount 为 0，测不到真形状');
  assert.ok(Array.isArray(value.calibrationSummary?.miscalibrated), 'calibrationSummary.miscalibrated 不是数组');
  assertConforms(tools.selfModel_inspectSummary, value, 'inspectSummary');
});

test('口径自检：tool.output.schema 已是 raw JSON Schema，重过一次值编译器会抛 unsupported', () => {
  // 作者侧 DSL 形态（属性上 required:true）→ defineTool 编译成 raw（父级 required 数组）
  const compiled = defineTool({
    name: 'nc_raw_shape_probe',
    description: 'probe: 编译后的 raw 形态',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { x: { type: 'string', required: true } },
      },
      render: () => [{ type: 'text', text: 'p' }],
    },
    execute: () => ({ x: 'a' }),
  });

  // 编译产物：raw 形态（required 数组落在父对象上）
  assert.deepEqual(compiled.output.schema.required, ['x']);
  // 且 raw 形态可以直接喂 validateJsonSchemaValue（不回编）
  assert.deepEqual(validateJsonSchemaValue(compiled.output.schema, { x: 'a' }, 'value(probe)'), []);
  // 不回编的理由：raw 的根层 required 数组不是作者 DSL 形态，重编译即抛
  assert.throws(
    () => valueSchemaSpecToJsonSchema(compiled.output.schema),
    /required/,
    'raw schema 重编译竟然没抛错：口径与 dsh 编译器不符',
  );

  // 本测试守卫的 5 个工具：schema 可直接校验（不需要任何二次编译）
  const { tools } = captureTools(startService());
  for (const name of EXPECTED_TOOLS) {
    assert.doesNotThrow(
      () => validateJsonSchemaValue(tools[name].output.schema, {}, `value(${name})`),
      `${name}.output.schema 不是可直接使用的 raw schema`,
    );
  }
});