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
  'memory_search', 'memory_write', 'memory_read', 'memory_stats', 'memory_forget_scan',
];

test('apply() 在 fake ctx 上注册全部 5 个工具且不抛', () => {
  const tools = registerAll();
  assert.equal(tools.length, EXPECTED_TOOLS.length);
  for (const n of EXPECTED_TOOLS) {
    assert.ok(tools.some(t => t.name === n), `缺少工具 ${n}`);
  }
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
