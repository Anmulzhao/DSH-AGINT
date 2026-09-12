// semantics 单元测试：P2-2 §六ter 建议 A（语义准入四条）+ 建议 C（命名类级约束）。
//
// 每条规则都有「命中」与「不该命中」两例——防误杀比防漏更需要先验证，
// 因为 blocker 会直接把候选打成 REJECTED_STATIC。

import test from 'node:test';
import assert from 'node:assert/strict';

import { checkSkillSemantics, blockersOf } from '../lib/semantics.js';

function draft(body, name = 'webhook-retry-strategy') {
  return { name, frontmatter: { name, description: '测试用草稿' }, body };
}

const byCode = (findings, code) => findings.find((f) => f.code === code);
const has = (findings, code) => findings.some((f) => f.code === code);

// ── 基线 ────────────────────────────────────────────────────────────────

test('干净草稿 + 正常类级名 → 零 finding', () => {
  const f = checkSkillSemantics({
    draft: draft('先读取配置，再按类级步骤执行。\n\n完成。'),
    pattern: { successRate: 0.9 },
    cfg: { min_pattern_success_rate: 0.6 },
  });
  assert.equal(f.length, 0);
});

// ── 规则 2：对工具能力的负面断言（blocker）──────────────────────────────

test('规则2：无版本限定的负面断言 → blocker', () => {
  const f = checkSkillSemantics({ draft: draft('浏览器工具不能用，改用 curl 抓取。') });
  assert.ok(has(f, 'tool-capability-negative-claim'));
  assert.equal(byCode(f, 'tool-capability-negative-claim').severity, 'blocker');
});

test('规则2：英文工具名同样命中', () => {
  const f = checkSkillSemantics({ draft: draft('The file_read 工具不支持该参数。') });
  assert.ok(has(f, 'tool-capability-negative-claim'));
});

test('规则2：带版本/条件限定 → 豁免（说的是"某版本不行"，不是永久断言）', () => {
  const f = checkSkillSemantics({ draft: draft('浏览器工具在 v0.8 之前不能用，升级后可用。') });
  assert.ok(!has(f, 'tool-capability-negative-claim'));
});

test('规则2：带"暂时/当前"等条件限定 → 豁免', () => {
  const f = checkSkillSemantics({ draft: draft('终端工具目前不可用，等待环境恢复。') });
  assert.ok(!has(f, 'tool-capability-negative-claim'));
});

// ── 规则 1：环境依赖失败但无解法（warn）─────────────────────────────────

test('规则1：环境失败 + 同段无修复 → warn', () => {
  const f = checkSkillSemantics({ draft: draft('执行时提示 command not found。') });
  assert.ok(has(f, 'env-failure-without-fix'));
  assert.equal(byCode(f, 'env-failure-without-fix').severity, 'warn');
});

test('规则1：同段给出安装步骤 → 不报（这是"踩坑+解法"，值得留）', () => {
  const f = checkSkillSemantics({ draft: draft('执行时提示 command not found，需要先安装 jq。') });
  assert.ok(!has(f, 'env-failure-without-fix'));
});

// ── 规则 3：瞬时错误但无应对（warn）─────────────────────────────────────

test('规则3：错误码 + 同段无应对 → warn', () => {
  const f = checkSkillSemantics({ draft: draft('调用失败：Error: ENOENT\n\n流程结束。') });
  assert.ok(has(f, 'transient-error-without-handling'));
  assert.equal(byCode(f, 'transient-error-without-handling').severity, 'warn');
});

test('规则3：同段有重试 → 不报', () => {
  const f = checkSkillSemantics({ draft: draft('调用失败：Error: ENOENT，重试一次即可。') });
  assert.ok(!has(f, 'transient-error-without-handling'));
});

// ── 规则 4：把失败包装成推荐流程（blocker）──────────────────────────────

test('规则4：声称最佳实践 + 成功率低于门槛 → blocker', () => {
  const f = checkSkillSemantics({
    draft: draft('推荐做法：先清理缓存再重试。'),
    pattern: { successRate: 0.3 },
    cfg: { min_pattern_success_rate: 0.6 },
  });
  assert.ok(has(f, 'failure-dressed-as-best-practice'));
  assert.equal(byCode(f, 'failure-dressed-as-best-practice').severity, 'blocker');
});

test('规则4：成功率达标 → 不报', () => {
  const f = checkSkillSemantics({
    draft: draft('推荐做法：先清理缓存再重试。'),
    pattern: { successRate: 0.9 },
    cfg: { min_pattern_success_rate: 0.6 },
  });
  assert.ok(!has(f, 'failure-dressed-as-best-practice'));
});

test('规则4：成功率缺失 → 不报（缺数据不猜）', () => {
  const f = checkSkillSemantics({
    draft: draft('推荐做法：先清理缓存再重试。'),
    pattern: {},
    cfg: { min_pattern_success_rate: 0.6 },
  });
  assert.ok(!has(f, 'failure-dressed-as-best-practice'));
});

// ── 建议 C：候选命名类级约束（blocker，family: skill-format）────────────

test('建议C：fix- 前缀 → blocker（会话产物名）', () => {
  const f = checkSkillSemantics({ draft: draft('正文。', 'fix-webhook-timeout') });
  const hit = byCode(f, 'skill-name-session-artifact');
  assert.ok(hit);
  assert.equal(hit.severity, 'blocker');
  assert.equal(hit.family, 'skill-format'); // 复用既有族名，不自造
});

test('建议C：名字含日期 → blocker', () => {
  const f = checkSkillSemantics({ draft: draft('正文。', 'webhook-fix-20260913') });
  assert.ok(has(f, 'skill-name-date'));
});

test('建议C：名字含 issue 号 → blocker', () => {
  const f = checkSkillSemantics({ draft: draft('正文。', 'handle-issue-1234') });
  // 用 #1234 形态验证更准（issue 号规则匹配 #\d+）
  const f2 = checkSkillSemantics({ draft: draft('正文。', 'webhook-handling-#1234') });
  assert.ok(!has(f, 'skill-name-issue-ref'));
  assert.ok(has(f2, 'skill-name-issue-ref'));
});

test('建议C：类级名 → 通过', () => {
  const f = checkSkillSemantics({ draft: draft('正文。', 'webhook-timeout-handling') });
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
  const f = checkSkillSemantics({
    draft: draft('浏览器工具不能用。\n\n执行时提示 command not found。'),
  });
  assert.equal(blockersOf(f).length, 1);
  assert.equal(f.length, 2);
});
