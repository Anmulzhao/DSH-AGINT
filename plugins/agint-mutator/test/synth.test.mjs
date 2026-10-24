/**
 * test/synth.test.mjs — TOOL_SYNTHESIS 合成器
 *
 * 钉的是三件事：
 *   1. 骨架固定（import / name / inject / 存储域 / apply / provide 收尾）
 *   2. 方法体 = stubs 原样（保留换行，不净化、不审查）
 *   3. 命名派生合法 + 保留词拒绝（fail-closed）
 *
 * 每条负控都能自证：拿掉对应实现，测试必须变红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  synthPluginPackage,
  deriveSynthNames,
  renderTemplate,
  sanitizeForJsonString,
  sanitizeForBlockComment,
} from '../lib/synth.js';

const STUB = [
  'async record(input) {\n      const parsed = InputSchema.parse(input);\n      const t = await table();\n      await t.put(parsed.input, parsed);\n      return parsed;\n    },',
];

const goodPayload = () => ({
  toolName: 'note',
  signature: '{"type":"object","properties":{"input":{"type":"string"}}}',
  stubs: [...STUB],
  intent: '把短文本存进自己的域，供后续检索。',
});

const fileOf = (files, path) => files.find((f) => f.path === path);

test('快乐路径：产出 5 个文件且 meta 正确', () => {
  const r = synthPluginPackage({ payload: goodPayload() });
  assert.equal(r.ok, true, r.reason);
  const paths = r.files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    'README.md',
    'cordis.patch.yml',
    'manifest.json',
    'package.json',
    'src/index.js',
  ]);
  assert.equal(r.meta.pluginId, 'agint-synth-note');
  assert.equal(r.meta.serviceKey, 'agint.synth.note');
  assert.equal(r.meta.domain, 'agint_synth_note');
  assert.equal(r.meta.table, 'note');
  assert.equal(r.meta.codegen, 'skeleton + stubs');
});

test('命名派生：连字符工具名 → 下划线域名与表名', () => {
  const n = deriveSynthNames('my-note');
  assert.equal(n.domain, 'agint_synth_my_note');
  assert.equal(n.table, 'my_note');
  assert.equal(n.pluginId, 'agint-synth-my-note');
  assert.equal(n.serviceKey, 'agint.synth.my-note');
});

test('骨架固定：产物含 import / name / inject / 存储域 / apply / provide 收尾', () => {
  const src = fileOf(synthPluginPackage({ payload: goodPayload() }).files, 'src/index.js').content;
  for (const needle of [
    "import { defineDomain } from '@deepseek-ai/dsh-storage-domain';",
    "import { z } from 'zod';",
    "const name = 'agint-synth-note';",
    "const inject = ['storageDomain'];",
    "name: 'agint_synth_note',",
    'function apply(ctx) {',
    "ctx.provide('agint.synth.note', service);",
    'export { Config, apply, inject, name };',
  ]) {
    assert.ok(src.includes(needle), `骨架缺失：${needle}`);
  }
});

test('方法体 = stubs 原样拼进（多行完整保留）', () => {
  const src = fileOf(synthPluginPackage({ payload: goodPayload() }).files, 'src/index.js').content;
  for (const line of STUB[0].split('\n')) {
    assert.ok(src.includes(line.trim()), `stub 行丢失：${line.trim()}`);
  }
  assert.ok(src.includes('async record(input) {'));
  // 负控自证：stubs 若被去换行压成一行，下面的多行结构就不成立
  assert.ok(src.split('\n').length > 40, 'stubs 被压成单行 ⇒ 代码不可读');
});

test('manifest.json 恒为合法 JSON（intent 含引号与换行也不撑坏）', () => {
  const evil = goodPayload();
  evil.intent = '他说"要能用"，还要\n换行 + 反斜杠 \\ 结尾';
  const raw = fileOf(synthPluginPackage({ payload: evil }).files, 'manifest.json').content;
  const parsed = JSON.parse(raw);
  assert.equal(parsed.name, 'agint-synth-note');
  assert.equal(parsed.spec.storage.domains[0], 'agint_synth_note');
  assert.equal(parsed.spec.cordis.provides[0], 'agint.synth.note');
  assert.equal(parsed.synth.codegen, 'skeleton + stubs');
  assert.ok(!parsed.description.includes('\n'), 'intent 的换行漏进了 JSON 字符串');
});

test('块注释净化：intent/signature 里的 */ 与换行被压掉', () => {
  const p = goodPayload();
  p.intent = '闭合注释尝试 */ 然后换行\n第二行';
  p.signature = '{"a":1} */';
  const src = fileOf(synthPluginPackage({ payload: p }).files, 'src/index.js').content;
  assert.ok(!src.includes('*/ 然后'), 'intent 的 */ 漏进了块注释');
  assert.ok(src.includes('agint-synth-note'), '净化不该删掉正常内容');
});

test('保留词：toolName 撞 L0 签名空间一律拒', () => {
  for (const bad of ['quality', 'note-quality', 'quality-note', 'mount', 'synth']) {
    const r = synthPluginPackage({ payload: { ...goodPayload(), toolName: bad } });
    assert.equal(r.ok, false, `${bad} 应被拒`);
    assert.equal(r.code, 'RESERVED_TOOL_NAME');
  }
});

test('非法 payload 一律拒（契约复用 ToolSynthesisPayloadSchema，不新造）', () => {
  const cases = [
    [{ ...goodPayload(), toolName: 'A' }, 'INVALID_PAYLOAD'],
    [{ ...goodPayload(), toolName: 'a' }, 'INVALID_PAYLOAD'],
    [{ ...goodPayload(), stubs: [] }, 'INVALID_PAYLOAD'],
    [{ ...goodPayload(), intent: '' }, 'INVALID_PAYLOAD'],
    [{ ...goodPayload(), intent: 'x'.repeat(501) }, 'INVALID_PAYLOAD'],
  ];
  for (const [payload, code] of cases) {
    const r = synthPluginPackage({ payload });
    assert.equal(r.ok, false);
    assert.equal(r.code, code, `期望 ${code}，实得 ${r.code}`);
  }
});

test('模板不可读 → TEMPLATE_UNREADABLE，不产出半成品', () => {
  const badFs = {
    readFileSync: () => { throw new Error('ENOENT'); },
  };
  const r = synthPluginPackage({ payload: goodPayload(), fs: badFs });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TEMPLATE_UNREADABLE');
  assert.equal(r.files, undefined);
});

test('renderTemplate：未提供的变量保持原样（便于发现漏替）', () => {
  assert.equal(renderTemplate('{{A}}', { A: '1' }), '1');
  assert.equal(renderTemplate('{{A}}{{B}}', { A: '1' }), '1{{B}}');
});

test('净化函数：单独可验', () => {
  assert.equal(sanitizeForJsonString('a"b'), 'a\\"b');
  assert.equal(sanitizeForJsonString('a\nb'), 'a b');
  assert.equal(sanitizeForBlockComment('a*/b'), 'ab');
});
