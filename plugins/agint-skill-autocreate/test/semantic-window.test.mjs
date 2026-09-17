// semantic-window 单元测试（Phase 2）：
//   纯函数层 —— extractSemanticEvidence / renderSemanticSections / clipWindow
//   I/O 层   —— loadSemanticWindow 的注入与降级路径
//
// 设计依据：2026-09-17《技能生成-分治架构设计.md》§5.2（本地文本窗口填 WHY/坑）。
// 关键不变量：**只搬运、不编造**——渲染出的每一句都必须真实出现在窗口里。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractSemanticEvidence,
  renderSemanticSections,
  isHumanUtterance,
  condense,
  clipWindow,
  loadSemanticWindow,
} from '../lib/semantic-window.js';

/** withMeta 形态的窗口条目 */
const E = (text, role, kind = null) => ({ text, role, kind, type: `${role}/message`, turn: 1, step: 1 });

// ── 人类话语判定（防把系统注入当用户意图）────────────────────────────────

test('isHumanUtterance：kind=user 或 null 的 user/message 才算人话', () => {
  assert.equal(isHumanUtterance(E('老板要求先 dry-run', 'user', 'user')), true);
  assert.equal(isHumanUtterance(E('旧格式无 kind', 'user', null)), true);
  // 实测的注入来源：plugin / skill-catalog 挂在 user/message 上，但 kind 不是 user
  assert.equal(isHumanUtterance(E('你在读一份第三方代码快照', 'user', 'plugin')), false);
  assert.equal(isHumanUtterance(E('技能目录', 'user', 'skill-catalog')), false);
  assert.equal(isHumanUtterance(E('系统指令', 'user', 'agent-instructions')), false);
  assert.equal(isHumanUtterance(E('助手的话', 'assistant', null)), false);
  assert.equal(isHumanUtterance(E('工具输出', 'tool', null)), false);
});

// 回归（2026-09-17 Phase 2 验收发现）：`kind === 'user'` **不等于**「人说的话」。
// memory-consolidation 等 subagent 的提示词同样以 user/message + kind='user' 落盘，
// 结构与真人类消息无法区分 → 只能按文本形态兜住。
test('isHumanUtterance：kind=user 但实为机器提示词 → 不算人话', () => {
  const sub = 'You are a memory consolidation agent for the 智进 (Zhijin) AI worker.\nYour job: decide for each candidate…';
  assert.equal(isHumanUtterance(E(sub, 'user', 'user')), false);
  assert.equal(isHumanUtterance(E('Current runtime context. This snapshot supersedes the earlier one.', 'user', 'user')), false);
  assert.equal(isHumanUtterance(E('<skill_content name="gszx-login">', 'user', 'user')), false);
  // 真人类消息仍通过
  assert.equal(isHumanUtterance(E('帮我检查一下 skills_root 里的半成品目录', 'user', 'user')), true);
  // 空白文本不算人话
  assert.equal(isHumanUtterance(E('   ', 'user', 'user')), false);
});

test('WHY：subagent prompt 混在窗口里也不会被当成人类意图', () => {
  const win = {
    before: [E('You are a memory consolidation agent for the 智进 (Zhijin) AI worker.', 'user', 'user')],
    after: [E('因为 watcher 会读到 .tmp 目录并持有句柄，所以整目录 rename 报 EPERM。', 'assistant')],
  };
  const ev = extractSemanticEvidence(win);
  assert.equal(ev.humanTurns, 0, '机器提示词不该计入 humanTurns');
  assert.equal(ev.why.length, 1);
  assert.match(ev.why[0], /watcher|EPERM/); // 退回助手侧兜底，而不是照抄机器提示词
});

// ── WHY 抽取 ────────────────────────────────────────────────────────────

test('WHY：优先真人类消息里的意图句', () => {
  const win = {
    before: [E('你好老板！智进 在岗，准备开工。', 'assistant')],
    after: [E('老板让我们把这版技能生成的门禁补上，因为空壳技能已经落盘两次了。', 'user', 'user')],
  };
  const ev = extractSemanticEvidence(win);
  assert.equal(ev.why.length, 1);
  assert.match(ev.why[0], /门禁补上/);
  assert.equal(ev.humanTurns, 1);
});

test('WHY：plugin / skill-catalog 注入不进 why（防污染正文）', () => {
  const win = {
    before: [E('你在读一份第三方代码快照（只读，不要修改任何文件）：Hermes Agent 的 Python 源码树…', 'user', 'plugin')],
    after: [E('已挂载技能：causal-reasoning / cordis-plugin-development', 'user', 'skill-catalog')],
  };
  const ev = extractSemanticEvidence(win);
  assert.equal(ev.why.length, 0, `注入不该进 why，实际：${JSON.stringify(ev.why)}`);
  assert.equal(ev.humanTurns, 0);
});

test('WHY：无人类消息时，用助手侧的解释句兜底', () => {
  const win = {
    // 次选来源：助手侧含「为什么这么做」的句子（RATIONALE_RE 命中）
    before: [E('这条路不是 mount.request 的入口，因为它走的是 agint-mount.sh 的传统挂载流程。', 'assistant')],
    after: [],
  };
  const ev = extractSemanticEvidence(win);
  assert.equal(ev.why.length, 1);
  assert.match(ev.why[0], /传统挂载流程/);
});

test('WHY：跳过纯问句（「要不要 X？」不含可复用方法）', () => {
  const win = { before: [], after: [E('要不要我也顺手把 README 更新一下？', 'user', 'user')] };
  const ev = extractSemanticEvidence(win);
  assert.equal(ev.why.length, 0);
});

test('WHY：上限 maxWhy 生效', () => {
  const win = {
    before: [],
    after: [
      E('请把 A 补上。', 'user', 'user'),
      E('请把 B 补上。', 'user', 'user'),
      E('请把 C 补上。', 'user', 'user'),
      E('请把 D 补上。', 'user', 'user'),
    ],
  };
  assert.equal(extractSemanticEvidence(win).why.length, 3);
  assert.equal(extractSemanticEvidence(win, { maxWhy: 2 }).why.length, 2);
});

// ── 坑抽取 ──────────────────────────────────────────────────────────────

test('坑：从 tool/result 里抓错误行', () => {
  const win = {
    before: [],
    after: [
      E('1: { "name": "x" }\nError: EPERM: operation not permitted, rename C:\\x\\.tmp-a\n退出码 1', 'tool'),
    ],
  };
  const ev = extractSemanticEvidence(win);
  assert.equal(ev.pitfalls.length, 1);
  assert.match(ev.pitfalls[0], /EPERM/);
});

test('坑：只从 tool 角色里取，助手自己说「坑」不算工具错误', () => {
  const win = { before: [], after: [E('这里有个坑，注意 EPERM。', 'assistant')] };
  assert.equal(extractSemanticEvidence(win).pitfalls.length, 0);
});

test('坑：正常输出不误报', () => {
  const win = {
    before: [],
    after: [E('Saved 3 files. Tests: 78 passed, 0 failed.', 'tool')],
  };
  assert.equal(extractSemanticEvidence(win).pitfalls.length, 0);
});

test('坑：条数上限 + 去重', () => {
  const win = {
    before: [],
    after: [
      E('Error: ENOENT: no such file', 'tool'),
      E('Error: ENOENT: no such file', 'tool'),
      E('Error: EACCES: permission denied', 'tool'),
      E('Error: EPERM: operation not permitted', 'tool'),
    ],
  };
  const ev = extractSemanticEvidence(win);
  // 4 条输入 → 去重后 3 条；上限 3 不裁
  assert.equal(ev.pitfalls.length, 3, `去重生效，实际 ${JSON.stringify(ev.pitfalls)}`);
  assert.equal(ev.pitfalls[0], 'Error: ENOENT: no such file');
  assert.equal(extractSemanticEvidence(win, { maxPitfalls: 2 }).pitfalls.length, 2);
});

// ── 渲染 ────────────────────────────────────────────────────────────────

test('renderSemanticSections：有空内容才渲段，无内容返回空串', () => {
  assert.equal(renderSemanticSections({}), '');
  assert.equal(renderSemanticSections({ why: [], pitfalls: [] }), '');
  const md = renderSemanticSections({ why: ['老板要求先 dry-run'], pitfalls: ['曾遇到的坑'] });
  assert.match(md, /^## 为什么\n- 老板要求先 dry-run/);
  assert.match(md, /## 避坑\n- 曾遇到：曾遇到的坑/);
});

test('renderSemanticSections：只有 why 时不出现空避坑段', () => {
  const md = renderSemanticSections({ why: ['甲'], pitfalls: [] });
  assert.ok(!md.includes('## 避坑'));
});

test('condense：折叠空白 + 超长截断', () => {
  assert.equal(condense('  a\n\nb   c  '), 'a b c');
  const long = 'x'.repeat(300);
  assert.equal(condense(long, 20).length, 20);
  assert.ok(condense(long, 20).endsWith('…'));
});

test('extractSemanticEvidence：空窗口 → 全空且 hasWindow=false', () => {
  const ev = extractSemanticEvidence({ before: [], after: [] });
  assert.deepEqual(ev.why, []);
  assert.deepEqual(ev.pitfalls, []);
  assert.equal(ev.hasWindow, false);
});

// ── clipWindow 字符预算 ──────────────────────────────────────────────────

test('clipWindow：超预算时优先保住紧邻锚点的文本', () => {
  const entries = [E('A'.repeat(100), 'user'), E('B'.repeat(100), 'user'), E('C'.repeat(100), 'user')];
  const out = clipWindow({ before: entries, after: [] }, 250);
  assert.equal(out.before.length, 2);
  // 反向取 → 保留离锚点最近的两条（B、C），顺序还原
  assert.equal(out.before[0].text[0], 'B');
  assert.equal(out.before[1].text[0], 'C');
  assert.equal(out.chars, 200);
});

// ── I/O 降级路径 ────────────────────────────────────────────────────────

test('loadSemanticWindow：无锚点 → ok:false，不抛', async () => {
  const r = await loadSemanticWindow({ sessionsRoot: '/nope', anchor: null });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-anchor');
});

test('loadSemanticWindow：会话日志找不到 → ok:false（降级，不阻断提案）', async () => {
  const r = await loadSemanticWindow({
    sessionsRoot: '/definitely/not/here',
    anchor: { sessionId: 'session-00000000-nope', turn: 1 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'session-log-not-found');
});

test('loadSemanticWindow：loader 注入路径（测试替身）', async () => {
  const r = await loadSemanticWindow({
    sessionsRoot: '/x',
    anchor: { sessionId: 's1', turn: 3 },
    loader: async (anchor, { radius }) => ({
      ok: true, sessionId: anchor.sessionId, turn: anchor.turn,
      before: [E('帮我确认一下 skills_root 下有没有半成品目录', 'user', 'user')], after: [], radius,
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.before.length, 1);
  const ev = extractSemanticEvidence(r);
  assert.equal(ev.why.length, 1);
  assert.match(ev.why[0], /半成品目录/);
});
