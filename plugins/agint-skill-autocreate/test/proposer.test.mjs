// proposer + templates 单元测试：模板选择 / SKILL.md 草稿格式 / 收益预估 / 自我指涉拦截。

import test from 'node:test';
import assert from 'node:assert/strict';

import { selectTemplate, renderBody, extractTriggers } from '../lib/templates.js';
import { buildProposal, skillName, estimateBenefit } from '../lib/proposer.js';
import { isSelfReferential } from '../lib/schema.js';

const filePattern = {
  toolSequence: ['file_read', 'file_write', 'file_read', 'file_write'],
  paramSignature: { file_read: 'path:str:.md', file_write: 'path:str:.md' },
  description: '批量处理 markdown frontmatter',
  occurrenceCount: 5,
  successRate: 0.8,
  sampleArgs: { file_read: { path: 'docs/*.md' }, file_write: { path: 'docs/*.md' } },
};

test('selectTemplate：file_read+file_write → file-processing', () => {
  const sel = selectTemplate(filePattern.toolSequence);
  assert.ok(sel);
  assert.equal(sel.template.templateId, 'file-processing');
});

test('selectTemplate：必需工具不全 → 不匹配', () => {
  assert.equal(selectTemplate(['file_read']), null);
});

test('selectTemplate：terminal 单工具 → shell-automation 优先于 git-workflow（噪声更少）', () => {
  const sel = selectTemplate(['terminal', 'terminal']);
  assert.ok(sel);
  assert.equal(sel.template.templateId, 'shell-automation');
});

test('buildProposal：草稿结构完整，SKILL.md 正文含四段结构', () => {
  const p = buildProposal(filePattern);
  assert.ok(p);
  const { skillDraft, estimatedBenefit } = p;
  assert.equal(skillDraft.template, 'file-processing');
  assert.match(skillDraft.name, /^[a-z0-9-]+$/);
  assert.equal(skillDraft.frontmatter.name, skillDraft.name);
  assert.equal(skillDraft.frontmatter.tools.join(','), 'file_read,file_write');
  assert.ok(skillDraft.frontmatter.triggers.length >= 1);
  for (const section of ['## 适用场景', '## 前置条件', '## 步骤', '## 注意事项']) {
    assert.ok(skillDraft.body.includes(section), `body 应包含 ${section}`);
  }
  // estimatedBenefit 四字段且在 [0,1]
  for (const v of Object.values(estimatedBenefit)) {
    assert.ok(v >= 0 && v <= 1);
  }
});

test('buildProposal：自我指涉 → 返回 null（设计稿 §9.4）', () => {
  assert.equal(buildProposal({
    ...filePattern,
    description: '优化 autocreate 流程',
  }), null);
});

test('isSelfReferential 命中中英文关键词', () => {
  assert.equal(isSelfReferential('auto-create-helper', ''), true);
  assert.equal(isSelfReferential('', '自动创建技能'), true);
  assert.equal(isSelfReferential('batch-rename', '批量重命名'), false);
});

test('estimateBenefit：高成功率模式收益趋零；工具越多耗时节省越高', () => {
  const hi = estimateBenefit({ ...filePattern, successRate: 1 });
  const lo = estimateBenefit({ ...filePattern, successRate: 0.3 });
  assert.equal(hi.successRateImprovement, 0);
  assert.ok(lo.successRateImprovement > hi.successRateImprovement);
});

test('skillName：中文描述回退到工具序列 slug', () => {
  const n = skillName({ description: '批量处理 frontmatter（5 次）', toolSequence: ['file_read', 'file_write'] });
  assert.ok(/^[a-z0-9-]+$/.test(n));
  const fallback = skillName({ description: '整理文档', toolSequence: ['file_read', 'file_write'] });
  assert.equal(fallback, 'file-read-file-write');
});

test('renderBody 步骤数 = 去重后工具数', () => {
  const tpl = selectTemplate(filePattern.toolSequence).template;
  const body = renderBody(filePattern, tpl);
  assert.match(body, /1\. 调用 file_read/);
  assert.match(body, /2\. 调用 file_write/);
  assert.doesNotMatch(body, /3\. 调用/);
});

test('extractTriggers：最多 3 个', () => {
  const t = extractTriggers(filePattern);
  assert.ok(t.length >= 1 && t.length <= 3);
});
