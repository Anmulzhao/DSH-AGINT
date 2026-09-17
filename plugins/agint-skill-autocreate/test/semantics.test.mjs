// semantics 单元测试：
//   A/B — P2-2 §六ter 建议 A（语义准入四条）+ 建议 C（命名类级约束）
//   C   — 2026-09-17 Phase 2：A3 四条信息量 blocker（质量门方案 §2 A3）
//
// 每条规则都有「命中」与「不该命中」两例——防误杀比防漏更需要先验证，
// 因为 blocker 会直接把候选打成 REJECTED_STATIC。
//
// 隔离说明：A3 四条（有没有信息量）与旧四条（危不危险）正交，用
// `semantics_quality_gate_enabled: false` 把 A3 关掉，专测旧四条；
// A3 自己有独立用例段（文件末）。生产两者默认都开。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkSkillSemantics,
  blockersOf,
  informativeText,
  stepLines,
  BOILERPLATE,
  MIN_INFORMATIVE_CHARS,
} from '../lib/semantics.js';

function draft(body, name = 'webhook-retry-strategy') {
  return { name, frontmatter: { name, description: '测试用草稿' }, body };
}

const byCode = (findings, code) => findings.find((f) => f.code === code);
const has = (findings, code) => findings.some((f) => f.code === code);

/** 关闭 A3 信息量门 → 只测旧四条 + 命名约束 */
const checkLegacy = (args = {}) => checkSkillSemantics({
  ...args,
  cfg: { semantics_quality_gate_enabled: false, ...(args.cfg ?? {}) },
});

// ── 基线 ────────────────────────────────────────────────────────────────

test('干净草稿 + 正常类级名 → 零 finding（关 A3 段）', () => {
  const f = checkLegacy({
    draft: draft('先读取配置，再按类级步骤执行。\n\n完成。'),
    pattern: { successRate: 0.9 },
    cfg: { min_pattern_success_rate: 0.6 },
  });
  assert.equal(f.length, 0);
});

// ── 规则 2：对工具能力的负面断言（blocker）──────────────────────────────

test('规则2：无版本限定的负面断言 → blocker', () => {
  const f = checkLegacy({ draft: draft('浏览器工具不能用，改用 curl 抓取。') });
  assert.ok(has(f, 'tool-capability-negative-claim'));
  assert.equal(byCode(f, 'tool-capability-negative-claim').severity, 'blocker');
});

test('规则2：英文工具名同样命中', () => {
  const f = checkLegacy({ draft: draft('The file_read 工具不支持该参数。') });
  assert.ok(has(f, 'tool-capability-negative-claim'));
});

test('规则2：带版本/条件限定 → 豁免（说的是"某版本不行"，不是永久断言）', () => {
  const f = checkLegacy({ draft: draft('浏览器工具在 v0.8 之前不能用，升级后可用。') });
  assert.ok(!has(f, 'tool-capability-negative-claim'));
});

test('规则2：带"暂时/当前"等条件限定 → 豁免', () => {
  const f = checkLegacy({ draft: draft('终端工具目前不可用，等待环境恢复。') });
  assert.ok(!has(f, 'tool-capability-negative-claim'));
});

// ── 规则 1：环境依赖失败但无解法（warn）─────────────────────────────────

test('规则1：环境失败 + 同段无修复 → warn', () => {
  const f = checkLegacy({ draft: draft('执行时提示 command not found。') });
  assert.ok(has(f, 'env-failure-without-fix'));
  assert.equal(byCode(f, 'env-failure-without-fix').severity, 'warn');
});

test('规则1：同段给出安装步骤 → 不报（这是"踩坑+解法"，值得留）', () => {
  const f = checkLegacy({ draft: draft('执行时提示 command not found，需要先安装 jq。') });
  assert.ok(!has(f, 'env-failure-without-fix'));
});

// ── 规则 3：瞬时错误但无应对（warn）─────────────────────────────────────

test('规则3：错误码 + 同段无应对 → warn', () => {
  const f = checkLegacy({ draft: draft('调用失败：Error: ENOENT\n\n流程结束。') });
  assert.ok(has(f, 'transient-error-without-handling'));
  assert.equal(byCode(f, 'transient-error-without-handling').severity, 'warn');
});

test('规则3：同段有重试 → 不报', () => {
  const f = checkLegacy({ draft: draft('调用失败：Error: ENOENT，重试一次即可。') });
  assert.ok(!has(f, 'transient-error-without-handling'));
});

// ── 规则 4：把失败包装成推荐流程（blocker）──────────────────────────────

test('规则4：声称最佳实践 + 成功率低于门槛 → blocker', () => {
  const f = checkLegacy({
    draft: draft('推荐做法：先清理缓存再重试。'),
    pattern: { successRate: 0.3 },
    cfg: { min_pattern_success_rate: 0.6 },
  });
  assert.ok(has(f, 'failure-dressed-as-best-practice'));
  assert.equal(byCode(f, 'failure-dressed-as-best-practice').severity, 'blocker');
});

test('规则4：成功率达标 → 不报', () => {
  const f = checkLegacy({
    draft: draft('推荐做法：先清理缓存再重试。'),
    pattern: { successRate: 0.9 },
    cfg: { min_pattern_success_rate: 0.6 },
  });
  assert.ok(!has(f, 'failure-dressed-as-best-practice'));
});

test('规则4：成功率缺失 → 不报（缺数据不猜）', () => {
  const f = checkLegacy({
    draft: draft('推荐做法：先清理缓存再重试。'),
    pattern: {},
    cfg: { min_pattern_success_rate: 0.6 },
  });
  assert.ok(!has(f, 'failure-dressed-as-best-practice'));
});

// ── 建议 C：候选命名类级约束（blocker，family: skill-format）────────────

test('建议C：fix- 前缀 → blocker（会话产物名）', () => {
  const f = checkLegacy({ draft: draft('正文。', 'fix-webhook-timeout') });
  const hit = byCode(f, 'skill-name-session-artifact');
  assert.ok(hit);
  assert.equal(hit.severity, 'blocker');
  assert.equal(hit.family, 'skill-format'); // 复用既有族名，不自造
});

test('建议C：名字含日期 → blocker', () => {
  const f = checkLegacy({ draft: draft('正文。', 'webhook-fix-20260913') });
  assert.ok(has(f, 'skill-name-date'));
});

test('建议C：名字含 issue 号 → blocker', () => {
  const f = checkLegacy({ draft: draft('正文。', 'handle-issue-1234') });
  // 用 #1234 形态验证更准（issue 号规则匹配 #\d+）
  const f2 = checkLegacy({ draft: draft('正文。', 'webhook-handling-#1234') });
  assert.ok(!has(f, 'skill-name-issue-ref'));
  assert.ok(has(f2, 'skill-name-issue-ref'));
});

test('建议C：类级名 → 通过', () => {
  const f = checkLegacy({ draft: draft('正文。', 'webhook-timeout-handling') });
  assert.equal(f.filter((x) => x.family === 'skill-format').length, 0);
});

// ── 总开关 ──────────────────────────────────────────────────────────────

test('semantics_check_enabled:false → 全部关闭（退回旧行为）', () => {
  const f = checkSkillSemantics({
    draft: draft('浏览器工具不能用。', 'fix-something'),
    pattern: { successRate: 0.1 },
    cfg: { semantics_check_enabled: false },
  });
  assert.equal(f.length, 0);
});

test('默认（不传 cfg）→ 开启', () => {
  const f = checkSkillSemantics({ draft: draft('浏览器工具不能用。') });
  assert.ok(f.length > 0);
});

// ── blockersOf ──────────────────────────────────────────────────────────

test('blockersOf：只取 blocker，warn 不计入', () => {
  const f = checkLegacy({
    draft: draft('浏览器工具不能用。\n\n执行时提示 command not found。'),
  });
  assert.equal(blockersOf(f).length, 1);
  assert.equal(f.length, 2);
});

// ══════════════════════════════════════════════════════════════════════════
// A3（Phase 2）：四条信息量 blocker —— 2026-09-17 自动发布 2 个空壳技能后新增
// ══════════════════════════════════════════════════════════════════════════

/** 今天 14:04 被自动发布的技能正文（glob-glob-glob-glob，逐字原文） */
const PUBLISHED_SHELL_BODY = [
  '## 适用场景',
  'glob → glob → glob → glob',
  '',
  '## 前置条件',
  '- 工具可用：glob、read、pwsh',
  '- 运行环境与历史任务实例一致（同工作目录/同权限）',
  '',
  '## 步骤',
  '1. 调用 glob，确认输出符合预期后再进入下一步。',
  '2. 调用 read，确认输出符合预期后再进入下一步。',
  '3. 调用 pwsh，确认输出符合预期后再进入下一步。',
  '',
  '## 注意事项',
  '- 本技能由系统从重复任务模式自动生成（经 D-QAF 评估 + 灰度发布）。',
  '- 首次使用如结果异常，停止并反馈，不要盲目重试。',
  '- 涉及写操作时先确认目标路径，避免覆盖非预期文件。',
].join('\n');

/** 一条「合格」的技能正文（有具体值 + 有实质知识） */
const GOOD_BODY = [
  '## 适用场景',
  '排查 dsh 技能未挂载：确认 SKILL.md 是否落在 skills_root 一层深目录内。',
  '',
  '## 为什么',
  '- 宿主用 dsh-skill-filesystem 扫技能根，只认 <root>/<name>/SKILL.md，嵌套 **/SKILL.md 不会被发现。',
  '',
  '## 步骤',
  '1. 调用 glob：**/*/SKILL.md（在 .agent-presets/agint/skills 下扫）',
  '2. 调用 read：.agent-presets/agint/skills/<name>/SKILL.md，检查 frontmatter 是否含 name 与 description 两个必填键',
  '3. 调用 pwsh：node bin/plugin-check.sh --strict',
  '',
  '## 避坑',
  '- 曾遇到：Error: EPERM: operation not permitted, rename ...skills_root\\.tmp-xxx',
  '',
  '## 注意事项',
  '- 本技能由系统从重复任务模式自动生成（经 D-QAF 评估 + 灰度发布）。',
].join('\n');

test('A3-1：已发布空壳技能（glob-glob-glob-glob 原文）→ non-informative-body blocker', () => {
  const f = checkSkillSemantics({
    draft: { name: 'glob-glob-glob-glob', frontmatter: { tools: ['glob', 'read', 'pwsh'] }, body: PUBLISHED_SHELL_BODY },
    pattern: { successRate: 1 },
    cfg: {},
  });
  const hit = byCode(f, 'non-informative-body');
  assert.ok(hit, '空壳正文必须被判 blocker');
  assert.equal(hit.severity, 'blocker');
});

test('A3-1：已发布空壳技能 → 四条 A3 判据至少命中 3 条（同尺互证）', () => {
  const f = checkSkillSemantics({
    draft: { name: 'glob-glob-glob-glob', frontmatter: { tools: ['glob', 'read', 'pwsh'] }, body: PUBLISHED_SHELL_BODY },
    pattern: { successRate: 1 },
    cfg: {},
  });
  const codes = ['non-informative-body', 'no-concrete-value', 'tool-recap-only', 'one-off-narrative'];
  const hits = codes.filter((c) => has(f, c));
  assert.ok(hits.length >= 3, `期望 ≥3 条命中，实际命中：${hits.join(', ') || '无'}`);
});

test('A3-1：有实质知识的正文 → 不报 non-informative-body', () => {
  const f = checkSkillSemantics({
    draft: { name: 'skill-mount-diagnosis', frontmatter: { tools: ['glob', 'read', 'pwsh'] }, body: GOOD_BODY },
    pattern: { successRate: 1 },
    cfg: {},
  });
  assert.ok(!has(f, 'non-informative-body'), `不该命中，实际 findings：${f.map((x) => x.code).join(',')}`);
});

test('A3-2：正文零具体值 → no-concrete-value blocker', () => {
  const f = checkSkillSemantics({
    draft: draft('先确认环境，再按步骤执行。完成后确认输出符合预期。', 'some-workflow'),
    pattern: { successRate: 1 },
    cfg: {},
  });
  const hit = byCode(f, 'no-concrete-value');
  assert.ok(hit);
  assert.equal(hit.severity, 'blocker');
});

test('A3-2：正文含真实路径/命令 → 不报 no-concrete-value', () => {
  const f = checkSkillSemantics({
    draft: draft('读取 D:\\DSH\\project源码\\DSH-AGINT\\package.json 后执行 node --test。', 'some-workflow'),
    pattern: { successRate: 1 },
    cfg: {},
  });
  assert.ok(!has(f, 'no-concrete-value'));
});

test('A3-3：步骤全是「调用 X…确认输出符合预期」→ tool-recap-only blocker', () => {
  const body = ['## 步骤', '1. 调用 glob，确认输出符合预期后再进入下一步。', '2. 调用 read，确认输出符合预期后再进入下一步。'].join('\n');
  const f = checkSkillSemantics({ draft: draft(body, 'x-y-z'), pattern: { successRate: 1 }, cfg: {} });
  assert.ok(has(f, 'tool-recap-only'));
});

test('A3-3：步骤带真实参数 → 不报 tool-recap-only', () => {
  const body = [
    '## 步骤',
    '1. 调用 glob：在 plugins/*/test 下找 *.test.mjs',
    '2. 调用 pwsh：node --test plugins/agint-skill-autocreate/test/*.test.mjs',
  ].join('\n');
  const f = checkSkillSemantics({ draft: draft(body, 'x-y-z'), pattern: { successRate: 1 }, cfg: {} });
  assert.ok(!has(f, 'tool-recap-only'));
});

test('A3-4：≥3 处 PR/issue/日期 → one-off-narrative blocker', () => {
  const body = '修复 PR #1234、issue #5678，参考 2026-09-17 的复盘记录。此外还看了 20260913 那份。';
  const f = checkSkillSemantics({ draft: draft(body, 'x-y-z'), pattern: { successRate: 1 }, cfg: {} });
  assert.ok(has(f, 'one-off-narrative'));
});

test('A3-4：类级描述（无编号/日期）→ 不报 one-off-narrative', () => {
  const body = '挂载失败时先看 skills_root 下有没有半成品目录，再检查 patch.yml 是否加载了 loader。';
  const f = checkSkillSemantics({ draft: draft(body, 'x-y-z'), pattern: { successRate: 1 }, cfg: {} });
  assert.ok(!has(f, 'one-off-narrative'));
});

test('A3 独立开关：semantics_quality_gate_enabled:false → A3 四条全关，旧四条仍在', () => {
  const f = checkSkillSemantics({
    draft: { name: 'glob-glob-glob-glob', frontmatter: { tools: ['glob'] }, body: `${PUBLISHED_SHELL_BODY}\n\n浏览器工具不能用。` },
    pattern: { successRate: 1 },
    cfg: { semantics_quality_gate_enabled: false },
  });
  assert.ok(!has(f, 'non-informative-body'));
  assert.ok(!has(f, 'no-concrete-value'));
  assert.ok(!has(f, 'tool-recap-only'));
  assert.ok(!has(f, 'one-off-narrative'));
  assert.ok(has(f, 'tool-capability-negative-claim'), '旧四条不受 A3 开关影响');
});

test('informativeText：剥净 boilerplate / 工具名 / 参数键名', () => {
  const rest = informativeText(PUBLISHED_SHELL_BODY, ['glob', 'read', 'pwsh']);
  for (const b of BOILERPLATE) assert.ok(!rest.includes(b), `boilerplate 未剥净: ${b}`);
  assert.ok(!rest.includes('glob'));
  assert.ok(rest.length < MIN_INFORMATIVE_CHARS);
});

test('informativeText：实质内容不被误剥', () => {
  const rest = informativeText(GOOD_BODY, ['glob', 'read', 'pwsh']);
  assert.ok(rest.length >= MIN_INFORMATIVE_CHARS, `实质字符不足: ${rest.length}`);
  assert.ok(rest.includes('dsh-skill-filesystem'));
});

test('stepLines：只认数字编号开头的行', () => {
  assert.equal(stepLines('## 步骤\n1. 甲\n2) 乙\n- 丙\n没有编号').length, 2);
});
