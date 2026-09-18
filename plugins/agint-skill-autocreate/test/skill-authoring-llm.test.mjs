// LLM 撰写落地 + 本地校验测试（LLM 接入方案 §5、§10 第 3 行）。
//
// 这个文件锁的是一条**不信任模型**的边界：
//   ① 不传 llmAuthoring → 与引入本特性前**逐字一致**（默认全 off 就没行为变化）
//   ② LLM 的 name/description 合法 → 采用；不合法 → **整条回落**模板行为
//   ③ 拒绝必须留痕（reasonOut.llmAuthoringRejected），否则又变成「分不清是没有还是被拦了」
//   ④ LLM 给的 why/pitfalls 合并进正文；只给一半时用本地语义证据补齐另一半
//   ⑤ 自我指涉检查**对 LLM 产出同样执行**（且比模板产出更该严）

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProposal, validateLlmAuthoring, skillName } from '../lib/proposer.js';
import { isToolChainName, isHostSkillName } from '../lib/authoring.js';

// sampleArgs 必须是真实路径（含扩展名）才过 A2 具体值门（见 templates.CONCRETE_RE）。
const FILE_PATTERN = {
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

const OK_AUTHORING = {
  name: 'batch-frontmatter-sync',
  description: '批量同步 markdown frontmatter 字段',
  why: ['字段顺序在不同文档间必须保持一致，否则 diff 噪声大'],
  pitfalls: ['空 frontmatter 的文件要跳过，否则会写入空块'],
};

// ── ① 默认零行为变化 ────────────────────────────────────────────────────

test('不传 llmAuthoring：产出与引入本特性之前逐字一致', () => {
  const base = buildProposal(FILE_PATTERN);
  const withNull = buildProposal(FILE_PATTERN, { llmAuthoring: null });
  const withGarbage = buildProposal(FILE_PATTERN, { llmAuthoring: 'not-an-object' });
  assert.deepEqual(withNull, base);
  assert.deepEqual(withGarbage, base);
});

test('不传 llmAuthoring：正文里不出现 `## 为什么` / `## 避坑`（不凭空造段）', () => {
  const p = buildProposal(FILE_PATTERN);
  assert.ok(p);
  assert.ok(!p.skillDraft.body.includes('## 为什么'));
  assert.ok(!p.skillDraft.body.includes('## 避坑'));
});

// ── ② 合法产出被采用 ────────────────────────────────────────────────────

test('合法 LLM 产出：名/描述采用，且不算拒绝', () => {
  const reasonOut = {};
  const p = buildProposal(FILE_PATTERN, { llmAuthoring: OK_AUTHORING, reasonOut });
  assert.ok(p);
  assert.equal(p.skillDraft.name, OK_AUTHORING.name);
  assert.equal(p.skillDraft.frontmatter.name, OK_AUTHORING.name);
  assert.equal(p.skillDraft.description, OK_AUTHORING.description);
  assert.equal(reasonOut.llmAuthoringRejected, undefined, '合法产出不该留下拒绝痕迹');
});

test('合法 LLM 产出：why/pitfalls 进正文（LLM 优先于本地窗口）', () => {
  const p = buildProposal(FILE_PATTERN, {
    llmAuthoring: OK_AUTHORING,
    semanticMarkdown: '## 为什么\n- 这是本地窗口的旧理由，应被 LLM 的理由覆盖\n',
  });
  assert.ok(p);
  assert.ok(p.skillDraft.body.includes('## 为什么'));
  assert.ok(p.skillDraft.body.includes('## 避坑'));
  assert.ok(p.skillDraft.body.includes('字段顺序在不同文档间必须保持一致'));
  assert.ok(p.skillDraft.body.includes('空 frontmatter 的文件要跳过'));
  assert.ok(!p.skillDraft.body.includes('这是本地窗口的旧理由'),
    'LLM 给了 why 时不该再混入本地窗口的理由（同一段出现两套来源无法解释）');
});

test('LLM 只给 why 不给 pitfalls → 另一半用本地语义证据补齐（按字段合并，不是整段二选一）', () => {
  const p = buildProposal(FILE_PATTERN, {
    llmAuthoring: { name: OK_AUTHORING.name, why: ['LLM 给的理由'] },
    semanticEvidence: { pitfalls: ['本地窗口挖到的坑：EPERM rename'] },
  });
  assert.ok(p);
  const body = p.skillDraft.body;
  assert.ok(body.includes('LLM 给的理由'));
  assert.ok(body.includes('EPERM rename'), '缺的那一半必须由本地证据补上');
});

// ── ③ 拒绝即整条回落，且留痕 ────────────────────────────────────────────

test('中文名 → 拒（宿主 SKILL_NAME 只认 ASCII kebab），回落模板名 + 留痕', () => {
  const reasonOut = {};
  const p = buildProposal(FILE_PATTERN, {
    llmAuthoring: { name: '批量同步字段', description: '中文描述' },
    reasonOut,
  });
  assert.ok(p, '拒绝只是丢弃 LLM 产出，候选本身仍应生成');
  assert.equal(p.skillDraft.name, skillName(FILE_PATTERN), '必须回落到模板名');
  assert.equal(p.skillDraft.description, FILE_PATTERN.description, '描述也要一起回落');
  assert.equal(reasonOut.llmAuthoringRejected.reason, 'name-not-ascii-kebab');
  assert.deepEqual(reasonOut.llmAuthoringRejected.rejectedFields, ['name']);
});

test('工具序列拼接名（file-read-file-write）→ 拒，判据与 authoring.js 同源', () => {
  // 先确认判据本身：这正是 K57 发现 1 —— 描述抽不出 ASCII slug 时，回落名
  // 就是工具序列拼接，于是「技能名」退化成「工具清单」。
  const zhPattern = { ...FILE_PATTERN, description: '整理文档' };
  assert.equal(skillName(zhPattern), 'file-read-file-write');
  assert.equal(isToolChainName(skillName(zhPattern)), true);
  assert.equal(isHostSkillName(skillName(zhPattern)), true,
    '角色分工：宿主正则**放行**它，拦它的是「工具链名」这条判据');

  const reasonOut = {};
  const p = buildProposal(FILE_PATTERN, {
    llmAuthoring: { name: 'file-read-file-write', description: 'x' },
    reasonOut,
  });
  assert.ok(p);
  assert.equal(reasonOut.llmAuthoringRejected.reason, 'name-tool-chain');

  // 反例对照：类级领域名不该被这条判据误伤
  assert.equal(isToolChainName('batch-frontmatter-sync'), false);
});

test('name 缺失 → 拒（半个产出比没有更难解释）', () => {
  const reasonOut = {};
  const p = buildProposal(FILE_PATTERN, {
    llmAuthoring: { description: '只有描述没有名字' },
    reasonOut,
  });
  assert.ok(p);
  assert.equal(reasonOut.llmAuthoringRejected.reason, 'name-missing');
  assert.equal(p.skillDraft.description, FILE_PATTERN.description,
    'name 缺失时描述也必须回落 —— 不接受「只采一半」');
});

test('被拒的 why/pitfalls 一并丢弃，不混进正文', () => {
  const reasonOut = {};
  const p = buildProposal(FILE_PATTERN, {
    llmAuthoring: { name: '中文名', why: ['被拒产出里的理由'], pitfalls: ['被拒产出里的坑'] },
    reasonOut,
  });
  assert.ok(p);
  assert.ok(reasonOut.llmAuthoringRejected);
  assert.ok(!p.skillDraft.body.includes('被拒产出里的理由'));
  assert.ok(!p.skillDraft.body.includes('被拒产出里的坑'));
});

test('validateLlmAuthoring：直测三条拒绝分支与一条放行分支', () => {
  assert.equal(validateLlmAuthoring(null).authoring, null);
  assert.equal(validateLlmAuthoring(null).rejection, null, '没给产出不算「拒绝」');
  assert.equal(validateLlmAuthoring({}).rejection.reason, 'name-missing');
  assert.equal(validateLlmAuthoring({ name: '  ' }).rejection.reason, 'name-missing');
  assert.equal(validateLlmAuthoring({ name: '中文' }).rejection.reason, 'name-not-ascii-kebab');
  assert.equal(validateLlmAuthoring({ name: 'a-b-c-d' }).rejection.reason, 'name-tool-chain');
  assert.equal(validateLlmAuthoring(OK_AUTHORING).rejection, null);
  assert.equal(validateLlmAuthoring(OK_AUTHORING).authoring, OK_AUTHORING);
});

// ── ⑤ 自我指涉对 LLM 产出同样执行 ────────────────────────────────────────

test('自我指涉：LLM 写出的自指名 → 整条候选不生成（比模板产出更该严）', () => {
  const reasonOut = {};
  const p = buildProposal(FILE_PATTERN, {
    llmAuthoring: { name: 'auto-create-improver', description: '自动创建新技能' },
    reasonOut,
  });
  assert.equal(p, null);
  assert.equal(reasonOut.reason, 'self-referential');
});

test('自我指涉：名字合法但 LLM 描述自指 → 同样拦（描述也进关键词扫描）', () => {
  const reasonOut = {};
  const p = buildProposal(FILE_PATTERN, {
    llmAuthoring: { name: 'batch-frontmatter-sync', description: '用于自动创建技能的自改进流程' },
    reasonOut,
  });
  assert.equal(p, null);
  assert.equal(reasonOut.reason, 'self-referential');
});

// ── ④ 拒绝不改变既有拦截顺序（A2/模板门仍先跑）──────────────────────────

test('模板不匹配时，LLM 产出救不回候选（拦截顺序不变）', () => {
  const reasonOut = {};
  const p = buildProposal(
    { toolSequence: ['weird_tool'], sampleArgs: {}, occurrenceCount: 3, successRate: 1 },
    { llmAuthoring: OK_AUTHORING, reasonOut },
  );
  assert.equal(p, null);
  assert.equal(reasonOut.reason, 'no-matching-template');
});
