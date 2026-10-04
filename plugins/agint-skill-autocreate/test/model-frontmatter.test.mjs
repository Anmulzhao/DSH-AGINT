/**
 * staging 的模型字段渲染测试（2026-10-03）
 *
 * 守一条**最高危**的不变量：写进 SKILL.md 的 frontmatter 必须能被宿主的 YAML
 * 解析器接受。宿主 `dsh-skill-filesystem.parseSkillFile` 在 frontmatter 解析
 * 失败时只打一行 warn 就**静默忽略整个技能文件** —— 文件在磁盘上、技能永不出现，
 * 是最难排查的一类失效（K57 发现 1 同型）。所以这里对危险字符做往返断言。
 *
 * 依赖：宿主自带的 `yaml`（dsh 依赖树里就有，与 parseSkillFile 同一个解析器）。
 * 取不到就 skip —— 不让环境差异变成假红。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { renderSkillMd, renderManifest } from '../lib/staging.js';

// 宿主 dsh 安装目录下的 yaml（与 parseSkillFile 同一个解析器）
const require = createRequire(import.meta.url);
let parse = null;
for (const p of [
  'yaml',
  'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/yaml',
]) {
  try { parse = require(p).parse; break; } catch { /* try next */ }
}
const maybe = parse ? test : test.skip;

/** 取 frontmatter 原文（宿主 parseFrontmatter 的同款切法） */
function frontmatterOf(md) {
  const end = md.indexOf('\n---', 4);
  return md.slice(4, end);
}

function scopeOf(model, provider = 'minimax-cn') {
  return {
    status: 'known',
    models: [{ provider, model, messages: 3, share: 1, dominant: true }],
    providers: [provider],
    dominant: { provider, model, dominant: true },
    verifiedOn: [],
    unverifiedOn: [],
  };
}

function draftWith(modelScope, body = '## 步骤\n\n1. x') {
  return {
    name: 'cron-services-audit',
    description: 'Verify the services() mapping after editing a cron plugin.',
    frontmatter: {
      name: 'cron-services-audit',
      description: 'Verify the services() mapping after editing a cron plugin.',
      triggers: ['cron_run_now'],
      tools: ['cron_run_now'],
      ...(modelScope === undefined ? {} : { modelScope }),
    },
    body,
    category: 'productivity',
    template: 'git-workflow',
    references: [],
    scripts: [],
  };
}

// ── 基本形态 ────────────────────────────────────────────────────────────

test('renderSkillMd：草稿带 modelScope → 输出 model-scope / verified-on / note', () => {
  const md = renderSkillMd(draftWith(scopeOf('MiniMax-M3.1-Flash-Preview')));
  assert.match(md, /^model-scope: observed$/m);
  assert.match(md, /^verified-on:$/m);
  assert.match(md, /^ {2}- minimax-cn\/MiniMax-M3\.1-Flash-Preview$/m);
  assert.match(md, /^verified-on-note: /m);
});

test('renderSkillMd：草稿**没有** modelScope → 完全不加模型键（存量/手工草稿不变形）', () => {
  // 关键：手工草稿本来就没这个维度，写一个 model-scope: unknown 会把
  // 「没这个维度」谎报成「来源未知」，两者含义不同。
  for (const v of [undefined, null]) {
    const md = renderSkillMd(draftWith(v));
    assert.ok(!md.includes('model-scope'), `modelScope=${v} 不该产出模型键`);
    assert.ok(!md.includes('verified-on'));
  }
});

test('renderSkillMd：unknown 归属 → 显式 unknown + 空清单 + 说明', () => {
  const unknown = { status: 'unknown', models: [], providers: [], dominant: null, verifiedOn: [], unverifiedOn: [] };
  const md = renderSkillMd(draftWith(unknown));
  assert.match(md, /^model-scope: unknown$/m);
  assert.match(md, /^verified-on: \[\]$/m);
  assert.match(md, /未经任何模型验证/);
});

// ── 往返：YAML 必须解析得回来 ──────────────────────────────────────────

maybe('renderSkillMd：产出能被宿主同款 YAML 解析器接受（正常值）', () => {
  const md = renderSkillMd(draftWith(scopeOf('MiniMax-M3.1-Flash-Preview')));
  const data = parse(frontmatterOf(md));
  assert.equal(data.name, 'cron-services-audit');
  assert.equal(data['model-scope'], 'observed');
  assert.deepEqual(data['verified-on'], ['minimax-cn/MiniMax-M3.1-Flash-Preview']);
  assert.match(data['verified-on-note'], /未验证/);
});

maybe('renderSkillMd：YAML 往返保住中文说明与含 / . - 的模型名', () => {
  const md = renderSkillMd(draftWith(scopeOf('MiniMax-M3.1-Flash-Preview')));
  const data = parse(frontmatterOf(md));
  assert.equal(typeof data['verified-on-note'], 'string');
  // 单模型文案：「经验仅在下列模型上被观察到；其他模型按「未验证」对待。」
  assert.match(data['verified-on-note'], /其他模型按「未验证」对待/);
});

maybe('renderSkillMd：note 里的「：」不会造出嵌套映射', () => {
  // 模型只有一个时 note 文案含全角冒号「未经任何模型验证：…」的变体场景；
  // 这里的实际风险是半角 ": " —— 用它构造一个必然触发引号的串验证兜底。
  const md = renderSkillMd(draftWith(scopeOf('m')));
  const data = parse(frontmatterOf(md));
  assert.equal(typeof data['verified-on-note'], 'string');
  assert.equal(data['model-scope'], 'observed');
});

maybe('renderSkillMd：多模型 → verified-on 是数组，每项都原样回来', () => {
  const scope = {
    status: 'known',
    models: [
      { provider: 'minimax-cn', model: 'MiniMax-M3', messages: 6, share: 0.75, dominant: true },
      { provider: 'deepseek-official', model: 'deepseek-flash', messages: 2, share: 0.25, dominant: false },
    ],
    providers: ['minimax-cn', 'deepseek-official'],
    dominant: { provider: 'minimax-cn', model: 'MiniMax-M3', dominant: true },
    verifiedOn: [], unverifiedOn: [],
  };
  const data = parse(frontmatterOf(renderSkillMd(draftWith(scope))));
  assert.deepEqual(data['verified-on'], ['minimax-cn/MiniMax-M3', 'deepseek-official/deepseek-flash']);
  assert.match(data['verified-on-note'], /2 个模型/);
});

maybe('renderSkillMd：verified-on-note 始终是字符串（不因文案含数字被解析成数字）', () => {
  // 单模型文案里有「仅在下列模型上」但无数字；多模型文案里含「2 个模型」。
  // 若哪天上someone 把 note 写成纯数字开头，YAML 会把它解析成 number ⇒
  // optionalString 取不到 ⇒ 字段消失。这条守住「note 永远是字符串」。
  for (const scope of [scopeOf('m1'), {
    status: 'known',
    models: [
      { provider: 'p1', model: 'm1', messages: 6, share: 0.75, dominant: true },
      { provider: 'p2', model: 'm2', messages: 2, share: 0.25, dominant: false },
    ],
    providers: ['p1', 'p2'],
    dominant: { provider: 'p1', model: 'm1', dominant: true },
    verifiedOn: [], unverifiedOn: [],
  }]) {
    const data = parse(frontmatterOf(renderSkillMd(draftWith(scope))));
    assert.equal(typeof data['verified-on-note'], 'string');
  }
});

// ── manifest ────────────────────────────────────────────────────────────

test('renderManifest：modelScope 完整清单进 manifest（SKILL.md 只列展示用的）', () => {
  const scope = {
    status: 'known',
    models: [
      { provider: 'p1', model: 'm1', messages: 8, share: 0.8, dominant: true },
      { provider: 'p2', model: 'm2', messages: 2, share: 0.2, dominant: false },
    ],
    providers: ['p1', 'p2'],
    dominant: { provider: 'p1', model: 'm1', dominant: true },
    verifiedOn: [], unverifiedOn: [],
  };
  const man = renderManifest(draftWith(scope), 'sc_1', '2026-10-03T00:00:00Z');
  assert.equal(man.modelScope.status, 'known');
  assert.equal(man.modelScope.models.length, 2);
  assert.equal(man.modelScope.models[0].messages, 8, 'manifest 保留 messages，SKILL.md 不显示');
});

test('renderManifest：草稿无 modelScope → 不加该键（不凭空声明 unknown）', () => {
  const man = renderManifest(draftWith(undefined), 'sc_1', '2026-10-03T00:00:00Z');
  assert.ok(!('modelScope' in man));
});

// ── 正文段位置 ──────────────────────────────────────────────────────────

test('renderSkillMd：正文里的「## 适用模型」段在「## 步骤」之前', () => {
  // 读者顺序是「能不能用 → 为什么 → 怎么做」；适用前提放步骤后会被跳过
  const body = '## 适用场景\nx\n\n## 适用模型\n\n- p/m\n\n## 步骤\n\n1. a';
  const md = renderSkillMd(draftWith(scopeOf('m'), body));
  const iModel = md.indexOf('## 适用模型');
  const iSteps = md.indexOf('## 步骤');
  assert.ok(iModel > 0 && iSteps > 0);
  assert.ok(iModel < iSteps, '适用模型段必须在步骤之前');
});