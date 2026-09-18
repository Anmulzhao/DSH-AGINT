/**
 * 方案 B：authoring standard 落成可执行测试（质量门方案 §3，P0）。
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────────
 * A1 / 门 5 判「序列里有没有领域工具」，A2 / A3 判「正文有没有信息量」，
 * 都能落地、都有测试。但**「名字与描述能不能被用起来」这一层没有测试守**——
 * 而它是技能被发现的唯一入口。实测证据（2026-09-18，全量）：
 *
 *   `glob-glob-glob-glob`：正文**有真知识**（多轮 glob 的切分策略、
 *   read 抽样上限、`-ErrorAction SilentlyContinue`），A3 四条 blocker **全不命中**；
 *   但名字是工具序列拼接，描述是 `X → Y → Z` 复述 → 这条技能"内容合格、名字不可达"。
 *
 * 也就是说：**只靠 A1/A2/A3/门 5，这类产物会一路绿灯发布**。
 * 本文件把标准写成断言，让判据被放宽时立刻变红（Hermes
 * `tests/skills/test_authoring_standards.py` 同思路）。
 *
 * ── 判据的所有权 ──────────────────────────────────────────────────────
 * 「正文含具体值」的所有者是 `templates.CONCRETE_RE`（A2/A3 在用），
 * 本文件**只测它、不另立一份**——所以这里对它的断言是跨模块调用，
 * 而不是在 authoring.js 里重写一遍（重复判据 = 两处阈值迟早不一致）。
 *
 * ── 回归 fixture 的真实性 ─────────────────────────────────────────────
 * 下面的 SKILL.md 原文取自生产 skills_root
 * （`$DSH_HOME/.agent-presets/agint/skills/<name>/SKILL.md`），逐字嵌入。
 * 其中 `glob-glob-glob-glob` 那份的 mtime 是 2026-09-18 12:21:09——
 * 即**已被某个非本插件的写入者改写过**（store 里查不到它现有的正文，
 * 见当日日志的 12:21 mtime 异动项）。这恰恰是选它当 fixture 的理由：
 * 它代表"内容最好的一版"，若连它都过不了名字判据，说明判据没有虚高。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTHORING_FAMILY,
  AUTHORING_RULES,
  DESCRIPTION_MAX,
  checkName,
  checkDescription,
  checkSkillAuthoring,
  isToolChainName,
  isToolChainDescription,
  isHostSkillName,
  authoringBlockersOf,
} from '../lib/authoring.js';
import { checkSkillSemantics, blockersOf } from '../lib/semantics.js';
import { CONCRETE_RE } from '../lib/templates.js';

// ── 工具 ────────────────────────────────────────────────────────────────

/** 极简 frontmatter 解析：只为把真实 SKILL.md 原文还原成 draft（不引入 yaml 依赖）。 */
function draftFromSkillMd(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  assert.ok(m, 'fixture 必须是合法 SKILL.md（顶部 --- YAML 块 + 正文）');
  const fm = m[1];
  const body = m[2];
  const pick = (key) => {
    const line = fm.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm'));
    if (!line) return '';
    // YAML 引号标量：解析器会剥掉外层引号，这里同样剥掉（否则会把收尾的 `"` 当成正文）
    return line[1].replace(/^(["'])(.*)\1$/, '$2');
  };
  const name = pick('name');
  const description = pick('description');
  // 只收 ASCII 标识符形态的列表项（即 tools）；中文 trigger 天然不会被 \w 匹配
  const tools = [...fm.matchAll(/^\s*-\s+([A-Za-z0-9_.]+)\s*$/gm)].map((x) => x[1]);
  return { name, description, frontmatter: { name, description, tools }, body };
}

const codesOf = (findings) => findings.map((f) => f.code);

// ── 真实产物 fixture（逐字取自生产 skills_root）──────────────────────────

/** 2026-09-17 发布；mtime 2026-09-18 12:21:09（被改写过的"最佳版本"） */
const MD_GLOB = `---
name: glob-glob-glob-glob
description: 跨多目录广撒网扫文件 → 抽样读全文 → pwsh 快速验证（适用于先摸清陌生仓库结构、定位某类文件分散位置的探索场景）
triggers:
  - 摸清仓库结构
  - 跨目录找文件
  - 先扫一遍
  - 摸底
  - 文件分布在哪
tools:
  - glob
  - read
  - pwsh
---

## 适用场景
陌生代码库第一次进场时，需要快速知道某类文件分散在哪些目录、有多少个、内容大致长什么样。
典型场景：接手新项目、查某类工具/插件散落在哪、看一组配置是否一致。

## 前置条件
- 工具可用：glob / read / pwsh
- 工作目录可读（沙箱外的目录需要先 rule_check 确认）
- 没有"确切文件路径"——有的话直接 read，不要走这条

## 步骤
1. 用多次 glob（不是一次大 pattern）从不同维度扫，每轮限定一个视角：扩展名 / 目录前缀 / 文件名前缀
2. 把第一轮 glob 结果里最像样的 2-4 个文件 read 一遍全文，确认它们确实是同类（避免 pattern 匹配到意外文件）
3. 如果样本文本差异大 → 再加一轮 glob 把范围切细；如果样本一致 → 进入 pwsh 验证
4. pwsh 跑 Get-ChildItem -Recurse | Measure-Object 或类似命令，给老板一个汇总数（文件总数、平均大小、最近修改时间）

## 注意事项
- 不要试图用一次 pattern 覆盖所有可能——glob pattern 越复杂越容易漏，分多轮比一次写复杂正则可靠
- read 抽样不要超过 4 个文件，避免无意义消耗上下文
- pwsh 验证用 \`-ErrorAction SilentlyContinue\`，别因权限错误中断整次扫描
- 跑出来的清单如果超过 20 项 → 停下来问老板要不要继续展开，不要闷头把所有文件都列出来
`;

/** 2026-09-18 12:45:58 发布（内容 = store 里的 draft，即"未改写的原始产物"） */
const MD_PWSH_GLOB_WEBFETCH = `---
name: pwsh-glob-webfetch-webfetch
description: pwsh → glob → web_fetch → web_fetch（参数：command/description/pattern/url）
triggers:
  - pwsh → glob → web_fetch → web_
tools:
  - pwsh
  - glob
  - web_fetch
---

## 适用场景
pwsh → glob → web_fetch → web_fetch（参数：command/description/pattern/url）

## 前置条件
- 工具可用：pwsh、glob、web_fetch
- 运行环境与历史任务实例一致（同工作目录/同权限）

## 步骤
1. 调用 pwsh，确认输出符合预期后再进入下一步。
2. 调用 glob，确认输出符合预期后再进入下一步。
3. 调用 web_fetch，确认输出符合预期后再进入下一步。

## 注意事项
- 本技能由系统从重复任务模式自动生成（经 D-QAF 评估 + 灰度发布）。
- 首次使用如结果异常，停止并反馈，不要盲目重试。
- 涉及写操作时先确认目标路径，避免覆盖非预期文件。
`;

/** 2026-09-18 12:45:59 发布 */
const MD_AGINTSEARCH = `---
name: agintsearch-pwsh-askuserquestion-pwsh
description: agint_search → pwsh → ask_user_question → pwsh → pwsh → pwsh → pwsh → pwsh → pwsh（参数：query/sources/limit/command）
triggers:
  - agint_search → pwsh → ask_user
tools:
  - agint_search
  - pwsh
  - ask_user_question
---

## 适用场景
agint_search → pwsh → ask_user_question → pwsh → pwsh → pwsh → pwsh → pwsh → pwsh（参数：query/sources/limit/command）

## 前置条件
- 工具可用：agint_search、pwsh、ask_user_question
- 运行环境与历史任务实例一致（同工作目录/同权限）

## 步骤
1. 调用 agint_search，确认输出符合预期后再进入下一步。
2. 调用 pwsh，确认输出符合预期后再进入下一步。
3. 调用 ask_user_question，确认输出符合预期后再进入下一步。

## 注意事项
- 本技能由系统从重复任务模式自动生成（经 D-QAF 评估 + 灰度发布）。
- 首次使用如结果异常，停止并反馈，不要盲目重试。
- 涉及写操作时先确认目标路径，避免覆盖非预期文件。
`;

/** 自动生成的 5 个（= 名字与工具序列同构） */
const AUTO_NAMES = [
  'glob-glob-glob-glob',
  'askuserquestion-todowrite-edit-read',
  'pwsh-pwsh-pwsh-pwsh',
  'pwsh-glob-webfetch-webfetch',
  'agintsearch-pwsh-askuserquestion-pwsh',
];

/** 人工撰写的 6 个（同目录共存的对照组；判据必须对它们零误杀） */
const MANUAL_NAMES = [
  'causal-reasoning',
  'cordis-plugin-development',
  'editing-cordis-compositions',
  'github-push',
  'memory-discipline',
  'plugin-preflight',
];

// ══ 1. 判别力：判据必须把「工具链名」与「类级领域名」分开 ══════════════

test('判别力：5 个自动生成技能全部命中工具链名判据', () => {
  const missed = AUTO_NAMES.filter((n) => !isToolChainName(n));
  assert.deepEqual(missed, [], `这些自动命名没被判出：${missed.join(', ')}`);
});

test('判别力：6 个人工撰写技能零误杀（这是判据可用的前提）', () => {
  const falsePositives = MANUAL_NAMES.filter((n) => isToolChainName(n));
  assert.deepEqual(falsePositives, [],
    `人工技能被误判为工具链名：${falsePositives.join(', ')}。`
    + '一旦这里变红，说明判据开始误杀——比漏判更危险（好技能永不成技能且不可见）');
});

test('判别力：2 段以内的 kebab 名不算工具链（阈值是 ≥3 段，不是"带连字符"）', () => {
  for (const n of ['plugin-preflight', 'memory-discipline', 'github-push']) {
    assert.equal(isToolChainName(n), false, `${n} 只有 1-2 段，不该判红`);
  }
});

// ══ 2. 名字判据契约 ═══════════════════════════════════════════════════

test('契约：工具链名 → skill-name-tool-chain（blocker）', () => {
  const f = checkName('glob-glob-glob-glob');
  assert.equal(codesOf(f).includes('skill-name-tool-chain'), true);
  assert.equal(authoringBlockersOf(f).length, 1);
});

test('契约：合法类级名 → 零 finding', () => {
  assert.deepEqual(checkName('plugin-preflight'), []);
  assert.deepEqual(checkName('editing-cordis-compositions'), []);
});

test('契约：非 ASCII 名 → skill-name-not-ascii（blocker）', () => {
  // 宿主 SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/（@deepseek-ai/dsh-skill/lib/index.js:17），
  // 不合法时 dsh-skill-filesystem **直接忽略该技能文件** → 文件在、技能不出现。
  const f = checkName('跨目录扫文件');
  assert.equal(codesOf(f).includes('skill-name-not-ascii'), true);
  assert.equal(isHostSkillName('跨目录扫文件'), false);
  assert.equal(isHostSkillName('glob-glob-glob-glob'), true);
});

test('契约：空名 → skill-name-missing（blocker）', () => {
  assert.deepEqual(codesOf(checkName('')), ['skill-name-missing']);
  assert.deepEqual(codesOf(checkName(undefined)), ['skill-name-missing']);
});

// ══ 3. description 判据契约 ═══════════════════════════════════════════

test('契约：纯工具链 description → description-tool-chain', () => {
  assert.equal(isToolChainDescription('pwsh → glob → web_fetch → web_fetch（参数：command/description/pattern/url）'), true);
  assert.equal(isToolChainDescription('agint_search → pwsh → ask_user_question'), true);
  const f = checkDescription('pwsh → glob → web_fetch（参数：a/b）');
  assert.equal(codesOf(f).includes('description-tool-chain'), true);
});

test('契约：带箭头的自然语言 description 不算工具链复述（第一版正则的误判已修）', () => {
  // glob 那条描述正是这种：用箭头连接，但两侧是中文实词 → 有信息量，不该判红
  assert.equal(
    isToolChainDescription('跨多目录广撒网扫文件 → 抽样读全文 → pwsh 快速验证（适用于先摸清陌生仓库结构）'),
    false,
  );
  assert.equal(codesOf(checkDescription('跨多目录广撒网扫文件 → 抽样读全文 → pwsh 快速验证')).includes('description-tool-chain'), false);
});

test('契约：超长 → description-too-long（warn，不得升级为 blocker）', () => {
  const long = '把'.repeat(DESCRIPTION_MAX + 1);
  const f = checkDescription(long);
  assert.equal(codesOf(f).includes('description-too-long'), true);
  assert.equal(authoringBlockersOf(f).length, 0, '超长只许是 warn——真实数据里人工技能最长 407 字符，当门会 100% 误杀');
});

test('契约：营销词 → description-marketing', () => {
  for (const bad of ['A powerful tool for X。', '全面覆盖各类任务。']) {
    assert.equal(codesOf(checkDescription(bad)).includes('description-marketing'), true, bad);
  }
  assert.equal(codesOf(checkDescription('按工具序列复述的多步探查流程。')).includes('description-marketing'), false);
});

test('契约：空 description → description-missing（blocker）', () => {
  assert.deepEqual(codesOf(checkDescription('')), ['description-missing']);
});

// ══ 4. 回归 fixture：真实产物必须被判红（标准被放宽即此测试变红）════════

test('回归：已发布技能 glob-glob-glob-glob —— 正文合格但名字不可达', () => {
  const draft = draftFromSkillMd(MD_GLOB);
  const authoring = checkSkillAuthoring({ draft });
  assert.equal(codesOf(authoring).includes('skill-name-tool-chain'), true,
    'glob-glob-glob-glob 的核心问题就是名字：这是唯一能拦住它的判据');
  assert.equal(authoringBlockersOf(authoring).length >= 1, true);
  // 反面对照：它的正文确实合格（有具体值），所以 A1/A2/A3/门 5 都拦不住它 ——
  // 这正是"为什么必须有 authoring 判据"的硬证据
  assert.equal(CONCRETE_RE.test(draft.body), true, '正文含真实命令 → A3 的 no-concrete-value 不命中');
});

test('回归：pwsh-glob-webfetch-webfetch —— 空壳正文，语义层与创作层双双判红', () => {
  const draft = draftFromSkillMd(MD_PWSH_GLOB_WEBFETCH);
  const sem = blockersOf(checkSkillSemantics({ draft, pattern: {}, cfg: {} }));
  const semCodes = sem.map((f) => f.code);
  assert.equal(semCodes.includes('tool-recap-only'), true, '步骤全是复述形态');
  assert.equal(semCodes.includes('non-informative-body'), true, '剥掉话术与工具名后无实质内容');
  assert.equal(sem.length >= 2, true, `验收口径：判为 blocker（实际 ${JSON.stringify(semCodes)}）`);

  const authoring = codesOf(checkSkillAuthoring({ draft }));
  assert.equal(authoring.includes('skill-name-tool-chain'), true);
  assert.equal(authoring.includes('description-tool-chain'), true);
});

test('回归：agintsearch-pwsh-askuserquestion-pwsh —— 同上', () => {
  const draft = draftFromSkillMd(MD_AGINTSEARCH);
  const semCodes = blockersOf(checkSkillSemantics({ draft, pattern: {}, cfg: {} })).map((f) => f.code);
  assert.equal(semCodes.includes('tool-recap-only'), true);
  assert.equal(semCodes.length >= 2, true, `验收口径：判为 blocker（实际 ${JSON.stringify(semCodes)}）`);
  assert.equal(codesOf(checkSkillAuthoring({ draft })).includes('skill-name-tool-chain'), true);
});

test('回归：三份 fixture 都解析成功（防 fixture 自身写坏导致测试空转）', () => {
  for (const [label, raw] of [['glob', MD_GLOB], ['pwsh-glob-webfetch', MD_PWSH_GLOB_WEBFETCH], ['agintsearch', MD_AGINTSEARCH]]) {
    const d = draftFromSkillMd(raw);
    assert.equal(d.name.length > 0, true, `${label}: name 解析失败`);
    assert.equal(d.description.length > 0, true, `${label}: description 解析失败`);
    assert.equal(d.frontmatter.tools.length > 0, true, `${label}: tools 解析失败`);
    assert.equal(d.body.length > 200, true, `${label}: body 过短，可能被解析截断`);
  }
  assert.equal(draftFromSkillMd(MD_GLOB).frontmatter.tools.includes('pwsh'), true);
});

// ══ 5. 结构性约束（防漂移）═════════════════════════════════════════════

test('结构：所有产出的 code 都在 AUTHORING_RULES 登记（防"加了判据没写标准"）', () => {
  const produced = new Set([
    ...codesOf(checkName('')),
    ...codesOf(checkName('跨目录扫文件')),
    ...codesOf(checkName('glob-glob-glob-glob')),
    ...codesOf(checkDescription('')),
    ...codesOf(checkDescription('a → b → c')),
    ...codesOf(checkDescription('x'.repeat(DESCRIPTION_MAX + 1) + '。')),
    ...codesOf(checkDescription('A powerful seamless tool。')),
    ...codesOf(checkDescription('没有句末标点')),
  ]);
  const declared = new Set(AUTHORING_RULES.map(([code]) => code));
  const undeclared = [...produced].filter((c) => !declared.has(c));
  assert.deepEqual(undeclared, [], `这些判据没在 AUTHORING_RULES 登记：${undeclared.join(', ')}`);
  assert.equal(produced.size, AUTHORING_RULES.length,
    '登记表与实际判据数量不一致（多出来的是没人调的判据，少了的是没登记的）');
});

test('结构：authoring 判据不重复实现"正文具体值"（所有者是 templates.CONCRETE_RE）', () => {
  const all = AUTHORING_RULES.map(([code]) => code).join(' ');
  assert.equal(/concrete/i.test(all), false,
    'CONCRETE_RE 归 A2/A3 所有；此处再实现一份会让两处阈值迟早不一致');
});

test('结构：findings 与 semantics 同格式（可无损合并进 phase1.findings）', () => {
  const f = checkSkillAuthoring({ draft: { name: 'glob-glob-glob-glob', description: 'a → b → c' } })[0];
  assert.equal(f.family, AUTHORING_FAMILY);
  assert.deepEqual(Object.keys(f).sort(), ['code', 'family', 'location', 'message', 'severity']);
  assert.equal(['blocker', 'warn'].includes(f.severity), true);
});

test('结构：判据是纯函数（同输入两次调用结果一致，无隐藏状态）', () => {
  const a = checkSkillAuthoring({ draft: { name: 'glob-glob-glob-glob', description: 'a → b → c' } });
  const b = checkSkillAuthoring({ draft: { name: 'glob-glob-glob-glob', description: 'a → b → c' } });
  assert.deepEqual(a, b);
});
