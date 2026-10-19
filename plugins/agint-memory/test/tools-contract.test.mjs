/**
 * agint-memory tools 契约测试（2026-10-03 新增）。
 *
 * 起因：`memory_write` 的 replacedBy 参数在 service 层早就实现了
 * （lib/index.js:142 `input.replacedBy ?? existing?.replacedBy`），
 * 但工具参数表（lib/tools.js）一直没暴露，导致「本条已被 X 取代」
 * 这类关系无法写入，只能改 content —— 而改 content 不是合法路径。
 *
 * 本文件锁住这条契约：参数表必须暴露 replacedBy，且 output schema 也要声明它。
 * 注意：断言工具参数表属于「改常量后必然自证通过」的类型，
 * 真正的运行时证据是宿主重启后真实调一次 memory_write 并 memory_read 核对落库。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/tools.js';

function registerAll() {
  const registered = [];
  const ctx = {
    'agint.memory': {}, // 注册期不调用 service，只在 execute 时用
    tools: { register(def) { registered.push(def); } },
  };
  apply(ctx);
  return registered;
}

const EXPECTED_TOOLS = [
  'memory_search', 'memory_write', 'memory_read', 'memory_stats', 'memory_forget_scan', 'memory_remove',
];

test('apply() 在 fake ctx 上注册全部 6 个工具且不抛', () => {
  const tools = registerAll();
  assert.equal(tools.length, EXPECTED_TOOLS.length);
  for (const n of EXPECTED_TOOLS) {
    assert.ok(tools.some(t => t.name === n), `缺少工具 ${n}`);
  }
});

// 2026-10-19：记忆只能写不能删 —— service 有 remove(id)，工具面没暴露。
// 后果是「原始报错残骸进了长期记忆就出不去」。
test('memory_remove：id 与 reason 必填，execute 走 service.remove 并回传被删内容', async () => {
  const registered = [];
  const removedIds = [];
  const ctx = {
    'agint.memory': {
      async read(id) { return { id, content: '工具执行报错：Error: invalid arguments …', type: 'lesson' }; },
      async remove(id) { removedIds.push(id); return true; },
    },
    tools: { register(def) { registered.push(def); } },
  };
  const { apply } = await import('../lib/tools.js');
  apply(ctx);
  const t = registered.find(x => x.name === 'memory_remove');
  assert.ok(t, '未注册 memory_remove');
  assert.ok(t.parameters.required.includes('id'), 'id 必须必填');
  assert.ok(t.parameters.required.includes('reason'), 'reason 必须必填（删除要留痕）');
  assert.ok(t.output.schema.properties.content, 'output schema 未声明 content（被删内容要回传）');

  const out = await t.execute({ id: 'abc123', reason: '原始报错残骸，不是教训' });
  assert.deepEqual(removedIds, ['abc123'], '必须走 service.remove(id)');
  assert.equal(out.removed, true);
  assert.equal(out.id, 'abc123');
  assert.match(out.content, /invalid arguments/, '被删内容必须回传，便于复查');
  assert.match(out.reason, /残骸/);
});

test('memory_write 参数表暴露 replacedBy（本次改动的核心断言）', () => {
  // defineTool 会把 { a: { type, description } } 规范成 JSON Schema
  // 形态 { type, properties, required } —— 所以断言 properties。
  const w = registerAll().find(t => t.name === 'memory_write');
  const p = w.parameters.properties.replacedBy;
  assert.ok(p, 'memory_write.parameters.properties.replacedBy 未暴露');
  assert.equal(p.type, 'string');
  // 不应标 required：绝大多数写入不涉及取代关系
  assert.ok(!w.parameters.required.includes('replacedBy'),
    'replacedBy 不应是 required');
});

test('memory_write 其余既有参数未被改动（防回归）', () => {
  const w = registerAll().find(t => t.name === 'memory_write');
  const props = w.parameters.properties;
  for (const k of ['content', 'type', 'id', 'evidence', 'level', 'confidence']) {
    assert.ok(props[k], `参数 ${k} 丢失`);
  }
  assert.ok(w.parameters.required.includes('content'));
  assert.ok(w.parameters.required.includes('type'));
});

test('memory_write output schema 声明 replacedBy（否则 strict-mode 会丢字段）', () => {
  const w = registerAll().find(t => t.name === 'memory_write');
  assert.ok(w.output.schema.properties.replacedBy, 'output schema 未声明 replacedBy');
});
