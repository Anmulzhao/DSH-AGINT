// proposer + templates 单元测试：模板选择 / SKILL.md 草稿格式 / 收益预估 / 自我指涉拦截。

import test from 'node:test';
import assert from 'node:assert/strict';

import { selectTemplate, renderBody, extractTriggers, hasConcreteValue, CONCRETE_RE } from '../lib/templates.js';
import { buildProposal, skillName, estimateBenefit } from '../lib/proposer.js';
import { isSelfReferential } from '../lib/schema.js';

// 注意：sampleArgs 必须是**真实路径**（含扩展名），否则过不了 A2 具体值门
// ——`docs/*.md` 这类 glob 是「参数形状」，不算具体值（见 templates.CONCRETE_RE 注释）。
const filePattern = {
  toolSequence: ['file_read', 'file_write', 'file_read', 'file_write'],
  paramSignature: { file_read: 'path:str:.md', file_write: 'path:str:.md' },
  description: '批量处理 markdown frontmatter',
  occurrenceCount: 5,
  successRate: 0.8,
  sampleArgs: {
    file_read: { path: 'docs/guides/index.md' },
    file_write: { path: 'docs/guides/index.md' },
  },
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

// ══════════════════════════════════════════════════════════════════════════
// Phase 2：A2 具体值门 + 语义窗口注入（2026-09-17）
// ══════════════════════════════════════════════════════════════════════════

test('A2：无具体值的模式 → 不生成候选，并给出精确 reason', () => {
  const noValue = {
    toolSequence: ['read', 'edit', 'pwsh'],
    paramSignature: { read: 'path:str', edit: 'path:str', pwsh: 'command:str' },
    description: 'read → edit → pwsh',
    occurrenceCount: 9,
    successRate: 1,
    sampleArgs: { read: { file_path: 'a/b' }, edit: { file_path: 'a/b' }, pwsh: {} },
  };
  const reasonOut = {};
  assert.equal(buildProposal(noValue, { reasonOut }), null);
  assert.equal(reasonOut.reason, 'no-concrete-value');
});

test('A2：kebab 标识符不算具体值（设计稿原版正则的误判，已收紧）', () => {
  // 原设计稿 `--?[a-z][\w-]{2,}` 会把 `plugin-preflight` 当 CLI 选项放行
  assert.equal(hasConcreteValue({ sampleArgs: { skill: { name: 'plugin-preflight' } } }), false);
  assert.equal(hasConcreteValue({ sampleArgs: { id: 'skill-autocreate-aggregate' } }), false);
  // 真 CLI 选项仍要放行
  assert.equal(hasConcreteValue({ sampleArgs: { pwsh: { command: 'node --test x.mjs' } } }), true);
  assert.equal(CONCRETE_RE.test('  --force'), true);
});

test('A2：具体值可来自语义窗口（sampleArgs 空但窗口有真实路径）', () => {
  const p = { toolSequence: ['read'], sampleArgs: {}, occurrenceCount: 3, successRate: 1, description: 'x' };
  assert.equal(hasConcreteValue(p), false);
  assert.equal(hasConcreteValue(p, '读取 D:\\DSH\\project\\package.json'), true);
});

test('A2：模板不匹配 → reason=no-matching-template', () => {
  const reasonOut = {};
  buildProposal({ toolSequence: ['weird_tool'], sampleArgs: {}, occurrenceCount: 3, successRate: 1 }, { reasonOut });
  assert.equal(reasonOut.reason, 'no-matching-template');
});

test('语义窗口：semanticMarkdown 注入正文，出现 `## 为什么` / `## 避坑`', () => {
  const md = ['## 为什么', '- 老板要求先 dry-run 再真正拉起（避免中断进行中的会话）', '', '## 避坑', '- 曾遇到：Error: EPERM: operation not permitted, rename', ''].join('\n');
  const p = buildProposal(filePattern, { semanticMarkdown: md });
  assert.ok(p);
  assert.ok(p.skillDraft.body.includes('## 为什么'));
  assert.ok(p.skillDraft.body.includes('## 避坑'));
  assert.ok(p.skillDraft.body.includes('dry-run'));
});

test('语义窗口：无语义时**不渲染**空段（宁缺毋滥，不拿话术凑字数）', () => {
  const p = buildProposal(filePattern, { semanticMarkdown: '' });
  assert.ok(p);
  assert.ok(!p.skillDraft.body.includes('## 为什么'));
  assert.ok(!p.skillDraft.body.includes('## 避坑'));
});

test('语义窗口：失败证据同样能解开 A2（窗口带真实值即可）', () => {
  const p = {
    toolSequence: ['read', 'edit'],
    paramSignature: { read: 'path:str', edit: 'path:str' },
    description: 'read → edit',
    occurrenceCount: 3,
    successRate: 1,
    sampleArgs: { read: {}, edit: {} },
  };
  assert.equal(buildProposal(p), null);
  const ok = buildProposal(p, { windowText: '编辑 D:\\DSH\\project源码\\DSH-AGINT\\package.json' });
  assert.ok(ok, '窗口里有真实路径 → 应放行');
});
