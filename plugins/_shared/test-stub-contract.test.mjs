/**
 * 共用契约替身的判据测试（含阴性对照）。
 *
 * 这个文件钉的是「替身自身是否比真宿主宽松」—— 替身一旦放宽，
 * 所有用它跑出来的"全绿"都会一起失去判据价值（提案 `846f4fbb` 的元根因）。
 *
 * 三条阴性对照（改回旧写法 ⇒ 必须红，不红说明替身已经松了）：
 *   ① 入口写成 `handler`        ⇒ execute 必须抛 `userExecute is not a function`
 *   ② 只写 schema、不写 render  ⇒ render 必须抛 `userRender is not a function`
 *   ③ schema 里 `required:false` ⇒ 注册时就该拒（真宿主 dsh-tools:602 authorError）
 *
 * 运行：node --test plugins/_shared/test-stub-contract.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defineTool,
  assertRequiredTrue,
  assertSchemaSubset,
  assertToolCallable,
} from './test-stub-dsh-tools.mjs';

const GOOD = {
  name: 'demo_tool',
  description: 'demo',
  parameters: { type: 'object', properties: {} },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean', required: true } } },
    render: () => [{ type: 'text', text: 'ok' }],
  },
  execute: async () => ({ ok: true }),
};

test('替身不是原样透传：返回的 execute/render 是包装过的（否则缺陷照样溜过去）', () => {
  const tool = defineTool({ ...GOOD });
  assert.equal(typeof tool.execute, 'function');
  assert.equal(typeof tool.output.render, 'function');
  assert.equal(tool.handler, undefined, '旧替身会把 handler 之类原样带出去 —— 那正是"测试全绿真宿主必炸"的形状');
});

test('阳性：写对入口 ⇒ execute + output.render 都能真调一次', async () => {
  const tool = defineTool({ ...GOOD });
  const { value, rendered, error, renderError } = await assertToolCallable(tool);
  assert.equal(error, null);
  assert.equal(renderError, null);
  assert.deepEqual(value, { ok: true });
  assert.equal(rendered[0].type, 'text');
});

test('阴性对照①：入口写成 handler ⇒ 真调抛 userExecute is not a function', async () => {
  const wrong = defineTool({
    name: 'bad_entry',
    output: { schema: { type: 'object' }, render: () => [] },
    handler: async () => ({}), // ⛔ 插件把入口写成 handler 的形状
  });
  await assert.rejects(
    () => assertToolCallable(wrong),
    /userExecute is not a function/,
    '入口写错必须由替身在**测试期**就报出来（真宿主的原话），不能等到上线后真调',
  );
});

test('阴性对照②：只写 schema 不写 render ⇒ 真调抛 userRender is not a function', async () => {
  const noRender = defineTool({
    name: 'no_render',
    output: { schema: { type: 'object' } }, // ⛔ 没有 render
    execute: async () => ({}),
  });
  await assert.rejects(
    () => assertToolCallable(noRender),
    /userRender is not a function/,
    'render 缺失必须由替身在测试期报出来（真宿主是「先校验 schema、再调 render」）',
  );
});

test('阴性对照③：schema 里 required:false ⇒ 注册即拒（真宿主 authorError）', () => {
  assert.throws(
    () => defineTool({
      name: 'bad_required',
      output: { schema: { type: 'object', properties: { a: { type: 'string', required: false } } }, render: () => [] },
      execute: async () => ({}),
    }),
    /required 只能是 true/,
  );
});

test('assertRequiredTrue：嵌套与数组也要查（只查顶层等于留了个洞）', () => {
  assert.throws(
    () => assertRequiredTrue(
      { type: 'object', properties: { list: { type: 'array', items: { type: 'string', required: false } } } },
      'nested',
    ),
    /required 只能是 true/,
  );
});

// ── schema 子集（2026-11-03 v0.20.0 上线事故的护栏）────────────────────────────
// 事故形状：`mandate: { type: ['object','null'], properties: {...} }`。
// assertRequiredTrue 只查 required、不看 type ⇒ 全部用例全绿；
// 真宿主 tools.register() 里 assertSupportedJsonSchema 抛 UNSUPPORTED_SCHEMA
// ⇒ 整行 tools 插件挂载失败 ⇒ agint preset 的 agent 全部「加载失败」。

test('阴性对照④：type 写成数组 ⇒ 注册即拒（v0.20.0 真事故形状）', () => {
  assert.throws(
    () => defineTool({
      name: 'bad_type_array',
      output: {
        schema: {
          type: 'object',
          properties: { mandate: { type: ['object', 'null'], properties: { a: { type: 'string' } } } },
        },
        render: () => [],
      },
      execute: async () => ({}),
    }),
    /type 必须是单个类型字符串/,
    'type 数组正是 dsh-tools 拒收的形状；替身不拒就等于给这类 bug 发绿灯',
  );
});

test('阴性对照⑤：type 写成未知字符串 ⇒ 注册即拒（拼错也要拦）', () => {
  assert.throws(
    () => assertSchemaSubset({ type: 'object', properties: { a: { type: 'str' } } }, 'typo'),
    /type 必须是单个类型字符串/,
  );
});

test('阴性对照⑥：type 与 oneOf 并存 ⇒ 注册即拒（真宿主 :219）', () => {
  assert.throws(
    () => assertSchemaSubset({ type: 'object', oneOf: [{ type: 'string' }, { type: 'null' }] }, 'both'),
    /不能同时声明 type 与 oneOf/,
  );
});

test('阴性对照⑦：oneOf 同级写 properties ⇒ 注册即拒（真宿主 :175）', () => {
  assert.throws(
    () => assertSchemaSubset({
      oneOf: [{ type: 'object' }, { type: 'null' }],
      properties: { a: { type: 'string' } },
    }, 'sibling'),
    /不能与 oneOf 同级/,
  );
});

test('阳性：required:true 与 oneOf 同级是合法的（DSL 作者层标记，编译期提到父级）', () => {
  // 真宿主实测（dsh 0.2.1-rc.5 valueSchemaSpecToJsonSchema）：
  //   { required: true, oneOf: [...] } ⇒ 产物 properties.x = { oneOf: [...] }
  //   + 父级 required: ["x"]，子节点无残留。
  // 替身若把这条判红，就是在拒绝一个真宿主接受的写法（比真宿主严 = 另一种失真）。
  assert.doesNotThrow(() => assertSchemaSubset({
    type: 'object',
    additionalProperties: false,
    properties: {
      x: { required: true, oneOf: [{ type: 'object', additionalProperties: false, properties: {} }, { type: 'null' }] },
    },
  }, 'required-with-oneof'));
});

test('阳性：可空对象的正确写法（oneOf + object 分支内 properties）能过', () => {
  const ok = {
    type: 'object',
    additionalProperties: false,
    properties: {
      mandate: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: { proposalId: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } },
          },
          { type: 'null' },
        ],
      },
    },
  };
  assert.doesNotThrow(() => assertSchemaSubset(ok, 'nullable-ok'));
});
