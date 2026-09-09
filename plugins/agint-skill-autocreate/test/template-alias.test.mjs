// 模板匹配的「工具名归一化」回归测试。
//
// 背景（2026-09-09）：模板库 requiredTools 用的是设计稿抽象名
// （terminal / file_read / file_write），而生产 tool-stats 记录的是宿主
// 真实工具名（pwsh / read / write / edit / glob / grep / ssh_exec）。
// 两者零交集 → selectTemplate() 在全部真实模式上恒返回 null → [5] 提案
// 生成 100% 落空。本测试锁死归一化行为，防止回退。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selectTemplate,
  canonicalTool,
  canonicalToolSet,
  renderBody,
} from '../lib/templates.js';

test('canonicalTool：真实工具名 → 模板语义名', () => {
  assert.equal(canonicalTool('pwsh'), 'terminal');
  assert.equal(canonicalTool('bash'), 'terminal');
  assert.equal(canonicalTool('ssh_exec'), 'terminal');
  assert.equal(canonicalTool('read'), 'file_read');
  assert.equal(canonicalTool('glob'), 'file_read');
  assert.equal(canonicalTool('grep'), 'file_read');
  assert.equal(canonicalTool('write'), 'file_write');
  assert.equal(canonicalTool('edit'), 'file_write');
  // 未列出的原样返回（不吞掉未知工具）
  assert.equal(canonicalTool('web_search'), 'web_search');
});

test('canonicalToolSet：去重后的语义工具集', () => {
  assert.deepEqual([...canonicalToolSet(['pwsh', 'read', 'write'])].sort(), ['file_read', 'file_write', 'terminal']);
  assert.deepEqual([...canonicalToolSet(['read', 'read', 'glob'])], ['file_read']);
});

test('向后兼容：设计稿抽象工具名仍可匹配（不被归一化改坏）', () => {
  assert.equal(selectTemplate(['terminal'])?.template.templateId, 'shell-automation');
  assert.equal(selectTemplate(['file_read', 'file_write'])?.template.templateId, 'file-processing');
  assert.equal(selectTemplate(['terminal', 'file_read'])?.template.templateId, 'code-lint');
});

test('修复验证：生产真实工具名现在能匹配到模板（修复前恒 null）', () => {
  const cases = [
    [['pwsh', 'read', 'write'], 'file-processing'],
    [['read', 'write'], 'file-processing'],
    [['read', 'edit'], 'file-processing'],
    [['glob', 'read', 'edit', 'write'], 'file-processing'],
    [['pwsh', 'read'], 'code-lint'],
  ];
  for (const [seq, expected] of cases) {
    const got = selectTemplate(seq)?.template.templateId ?? null;
    assert.equal(got, expected, `${seq.join(' > ')} → ${got}`);
  }
});

test('生产回放 7 个真实模式：归一化后仍无模板匹配（无参数长度的单工具序列）', () => {
  // 这 7 个是单工具序列，归一化后也只有一个语义工具，
  // 除 shell-automation 外都缺必需工具；[4] 会先在更前面把它们拦掉。
  for (const seq of [['pwsh'], ['pwsh', 'pwsh'], ['pwsh', 'pwsh', 'pwsh']]) {
    assert.equal(selectTemplate(seq)?.template.templateId, 'shell-automation');
  }
  // memory_write / skill / autocreate_stats 不在映射表 → 原样，无模板匹配
  assert.equal(selectTemplate(['memory_write']), null);
  assert.equal(selectTemplate(['skill']), null);
  assert.equal(selectTemplate(['autocreate_stats']), null);
});

test('renderBody 用原始工具名（归一化不污染渲染产物）', () => {
  const pattern = {
    toolSequence: ['pwsh', 'read', 'write'],
    paramSignature: {},
    description: '跑脚本处理文件',
    sampleArgs: { pwsh: { command: 'ls' } },
  };
  const body = renderBody(pattern, selectTemplate(['pwsh', 'read', 'write']).template);
  assert.ok(body.includes('pwsh'), '原始工具名 pwsh 应出现在 body');
  assert.ok(body.includes('read'), '原始工具名 read 应出现在 body');
  assert.ok(body.includes('ls'), '参数参考值应出现在 body');
});
