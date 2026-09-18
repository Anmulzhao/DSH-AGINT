/**
 * A1 特异性门（质量门方案 §2 A1；2026-09-18 落地）。
 *
 * 为什么要有这道门：次数门槛（occurrenceCount ≥ 3）只证明「经常发生」，
 * 不证明「值得沉淀」。`glob → read → pwsh` 这种纯脚手架序列频次最高，
 * 因为**任何任务**都要读写执行；把它固化成技能，得到的正文只能是
 * 「调用 glob、调用 read」——即今天已上线的 `glob-glob-glob-glob`。
 *
 * 设计取舍（K51 可回滚 > 可审批 + 2026-09-18 定为黑名单判据）：
 *   - 判据是**黑名单**：序列里全是通用脚手架（读/写/搜/执行/待办）才拦。
 *     不用白名单是因为领域工具是开放集合，每加一个插件就多一批 —— 用它当
 *     准入门槛等于要求「每长出新工具就来登记一次」，那是人工参与而非自动化；
 *     且白名单误杀（好模式永不成技能）没有任何下游能救，是最难观测的死法。
 *   - 只维护一个封闭小集合（SCAFFOLD_TOOLS），新增通用动作时才动。
 *   - 被拦的模式**照常入库**，另开 `blockedByLowSpecificity` 桶留痕。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPatterns,
  classifySpecificity,
  passesSpecificityGate,
  DOMAIN_TOOLS,
  SCAFFOLD_TOOLS,
} from '../lib/detector.js';

const mkTask = (toolSequence, extra = {}) => ({
  toolSequence,
  paramSignature: Object.fromEntries(toolSequence.map((t) => [t, 'x:s'])),
  sampleArgs: Object.fromEntries(toolSequence.map((t) => [t, { x: 'v' }])),
  durationMs: 100,
  successRate: 1,
  ...extra,
});

const repeat = (seq, n = 3, extra = {}) => Array.from({ length: n }, () => mkTask(seq, extra));

// ── 1. 纯函数判据 ──────────────────────────────────────────────────────

test('classify: 纯脚手架序列 → scaffoldOnly', () => {
  const r = classifySpecificity(['glob', 'read', 'pwsh']);
  assert.equal(r.domain.length, 0);
  assert.equal(r.scaffoldOnly, true);
});

test('classify: 今日两个真实垃圾技能序列均为纯脚手架', () => {
  // releases 表里已上线的两个技能，来源序列
  assert.equal(classifySpecificity(['glob', 'glob', 'glob', 'glob']).scaffoldOnly, true);
  assert.equal(
    classifySpecificity(['ask_user_question', 'todo_write', 'edit', 'read', 'pwsh']).scaffoldOnly,
    true,
  );
});

test('classify: 含领域工具 → 不算 scaffoldOnly', () => {
  // ⚠️ 2026-09-18 换例：原先用 web_search 当"领域工具"，但它已归脚手架（见文末回归测试）。
  // 换 wiki_write —— 现行判据里"业务**写**动作"才是领域语义（查询类算通用）。
  const r = classifySpecificity(['read', 'wiki_write', 'write']);
  assert.deepEqual(r.domain, ['wiki_write']);
  assert.equal(r.scaffoldOnly, false);
});

test('classify: 未知工具按「非脚手架」处理（判据是黑名单，不必登记）', () => {
  const r = classifySpecificity(['read', 'some_new_mcp_tool']);
  assert.deepEqual(r.unknown, ['some_new_mcp_tool']);
  assert.equal(r.scaffoldOnly, false, '不在黑名单里就是有专属语义');
  assert.equal(passesSpecificityGate(['read', 'some_new_mcp_tool']), true);
});

test('classify: 空序列/undefined 视为无特异性', () => {
  assert.equal(classifySpecificity([]).scaffoldOnly, true);
  assert.equal(classifySpecificity(undefined).scaffoldOnly, true);
});

test('classify: scaffoldTools 可扩展黑名单（新通用动作无需改代码）', () => {
  const seq = ['read', 'zsh'];
  assert.equal(classifySpecificity(seq).scaffoldOnly, false, '未登记的 shell 工具默认算领域');
  const r = classifySpecificity(seq, ['zsh']);
  assert.deepEqual(r.scaffold, ['read', 'zsh'], '补进黑名单后视为通用动作');
  assert.equal(r.scaffoldOnly, true, '全脚手架 → 拦下');
  assert.equal(passesSpecificityGate(seq, { scaffoldTools: ['zsh'] }), false);
});

test('白名单与脚手架名单不相交（否则判定自相矛盾）', () => {
  const overlap = [...DOMAIN_TOOLS].filter((t) => SCAFFOLD_TOOLS.has(t));
  assert.deepEqual(overlap, []);
});

// ── 2. detectPatterns 集成 ─────────────────────────────────────────────

test('detect: 纯脚手架模式被拦下，不进 newRepeat', () => {
  const { newRepeat, blockedByLowSpecificity } = detectPatterns(repeat(['glob', 'read', 'pwsh']), {
    minOccurrence: 3,
  });
  assert.equal(newRepeat.length, 0);
  assert.equal(blockedByLowSpecificity.length, 1);
  assert.deepEqual(blockedByLowSpecificity[0].toolSequence, ['glob', 'read', 'pwsh']);
});

test('detect: 被拦模式仍进 upserts（可观测，不静默丢弃）', () => {
  const { upserts, blockedByLowSpecificity } = detectPatterns(repeat(['glob', 'read', 'pwsh']), {
    minOccurrence: 3,
  });
  assert.equal(blockedByLowSpecificity.length, 1);
  const stored = upserts.find((p) => p.toolSequence.join() === 'glob,read,pwsh');
  assert.ok(stored, '被拦的模式必须照常入库，否则审计无从取证');
  assert.equal(stored.occurrenceCount, 3);
});

test('detect: 含领域工具的序列正常放行', () => {
  const { newRepeat, blockedByLowSpecificity } = detectPatterns(
    repeat(['read', 'wiki_write', 'write']),
    { minOccurrence: 3 },
  );
  assert.equal(newRepeat.length, 1);
  assert.equal(blockedByLowSpecificity.length, 0);
});

test('回归：通用"查询"动作归脚手架（2026-09-18 生产证据驱动的判据收紧）', () => {
  // 来源：生产审计 + 04:45 cron 真实发布。web_search / web_fetch / agint_search
  // 曾被 DOMAIN_TOOLS 当「领域工具」→ A1 门判 scaffoldOnly=false →
  // 纯脚手架序列只要带一个 web_fetch 就能逃过门，实际发布了两个空壳
  // （agintsearch-pwsh-askuserquestion-pwsh / pwsh-glob-webfetch-webfetch）。
  //
  // 判据是「查询 ≠ 领域」：跟已在黑名单的 memory_search / wiki_search 同性质。
  // 领域语义留给**业务写动作**（wiki_write / memory_write）与真正的外部系统动作（ssh_*）。
  //
  // ⚠️ 这条是新语义（与当日 10:34 记录的"放行 2 条确有领域动作"相反），
  // 由老板复核后可一行改回：把它们挪回 DOMAIN_TOOLS 并同步本测试。
  for (const t of ['web_search', 'web_fetch', 'agint_search']) {
    assert.equal(SCAFFOLD_TOOLS.has(t), true, `${t} 应归脚手架（通用查询动作）`);
    assert.equal(DOMAIN_TOOLS.has(t), false, `${t} 不应同时留在领域工具名单里`);
  }
  // 反例：业务写动作必须仍在领域侧，否则会拦掉真正有价值的模式
  for (const t of ['wiki_write', 'memory_write', 'ssh_exec']) {
    assert.equal(SCAFFOLD_TOOLS.has(t), false, `${t} 是业务动作，误进黑名单会误杀好模式`);
  }
  // 全查询序列 → 判为纯脚手架（旧判据会放行）
  assert.equal(classifySpecificity(['pwsh', 'glob', 'web_fetch', 'web_fetch']).scaffoldOnly, true);
});

test('detect: specificityGate=false 可整门关闭（回滚通道有效）', () => {
  const { newRepeat, blockedByLowSpecificity } = detectPatterns(repeat(['glob', 'read', 'pwsh']), {
    minOccurrence: 3,
    specificityGate: false,
  });
  assert.equal(newRepeat.length, 1, '关掉门后退回旧行为');
  assert.equal(blockedByLowSpecificity.length, 0);
});

test('detect: scaffoldTools 是追加而非替换（配错也不会清空内置黑名单）', () => {
  // 危险写法是「传了 scaffoldTools 就只用传入值」——那样配置写错会全量放行。
  // 这里钉死语义：内置黑名单永远生效，传入项只做补充。
  const r = detectPatterns(repeat(['read', 'zsh']), {
    minOccurrence: 3,
    scaffoldTools: ['zsh'],
  });
  assert.equal(r.blockedByLowSpecificity.length, 1, 'read 仍在内置黑名单 → 全脚手架 → 拦下');
  assert.equal(r.newRepeat.length, 0);
});

test('detect: 未登记的通用动作不误拦（黑名单判据的容错方向）', () => {
  // 宿主新出了一种 shell 工具还没收录 → 应放行并进 unknown 审计，而不是拦下。
  const r = detectPatterns(repeat(['read', 'brand_new_tool']), { minOccurrence: 3 });
  assert.equal(r.newRepeat.length, 1);
  assert.equal(r.blockedByLowSpecificity.length, 0);
});

test('detect: 三个桶互斥（一个模式不会被重复记账）', () => {
  const { newRepeat, blockedBySuccessRate, blockedByLowSpecificity } = detectPatterns(
    repeat(['glob', 'read', 'pwsh']),
    { minOccurrence: 3 },
  );
  const total = newRepeat.length + blockedBySuccessRate.length + blockedByLowSpecificity.length;
  assert.equal(total, 1, `应恰好落在某一个桶，实际 ${total}`);
});

test('detect: 低成功率优先于低特异性（成功率是更硬的否决）', () => {
  const { blockedBySuccessRate, blockedByLowSpecificity } = detectPatterns(
    repeat(['read', 'web_search'], 3, { successRate: 0.1 }),
    { minOccurrence: 3 },
  );
  assert.equal(blockedBySuccessRate.length, 1);
  assert.equal(blockedByLowSpecificity.length, 0, '已因成功率被拦，不再重复计入特异性桶');
});
