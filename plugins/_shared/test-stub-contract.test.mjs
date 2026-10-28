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
import { defineTool, assertRequiredTrue, assertToolCallable } from './test-stub-dsh-tools.mjs';

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
