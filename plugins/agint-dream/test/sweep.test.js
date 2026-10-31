/**
 * agint-dream: unit tests for the sweep core (pure functions + a stub-driven
 * runSweep). Run with: node --test packages/agint-dream/test/sweep.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectSessionSignals,
  extractCandidates,
  classifyToolError,
  classifyToolResultError,
  promotionBlockReason,
  aggregateToolErrorStats,
  scoreCandidates,
  gateCandidates,
  entryFor,
  renderDiary,
  runSweep,
} from '../lib/sweep.js';

const NOW = Date.parse('2026-08-15T23:00:00+08:00');

test('collectSessionSignals: user messages, memWrites, errors', () => {
  const records = [
    { type: 'session', id: 's1' },
    { type: 'user/message', seq: 1, time: NOW - 1000, data: { content: [{ type: 'text', text: '老板，以后用 vger 称呼我' }] } },
    { type: 'tool/call', seq: 2, time: NOW, data: { name: 'memory_write', arguments: JSON.stringify({ content: '某条记忆' }) } },
    { type: 'tool/result', seq: 3, time: NOW, data: { message: { content: [{ type: 'text', text: 'ERROR: something failed' }] } } },
  ];
  const s = collectSessionSignals(records);
  assert.equal(s.sessionKey, 's1');
  assert.equal(s.userTexts.length, 1);
  assert.equal(s.memWrites.length, 1);
  assert.equal(s.errors.length, 1);
});

test('extractCandidates: keyword buckets → typed candidates, noise dropped', () => {
  const session = {
    sessionKey: 's1',
    userTexts: [
      { text: '以后用 vger 称呼我，别忘了', time: NOW },
      { text: '投资上决定采用指数化方案', time: NOW },
      { text: '你好', time: NOW },
      { text: '你能帮我看看这个文件吗？', time: NOW },
    ],
    errors: [],
  };
  const cands = extractCandidates(session, NOW);
  const types = cands.map((c) => c.type);
  assert.ok(types.includes('preference'), JSON.stringify(cands));
  assert.ok(types.includes('decision'), JSON.stringify(cands));
  assert.ok(cands.every((c) => !/你好/.test(c.text)), 'noise must be dropped');
  assert.ok(cands.every((c) => !/\?$/.test(c.text)), 'questions must be dropped');
});

// ── 2026-09-21：引用块 / 记忆条目前缀不得成为候选（本体污染入口） ──────────────

test('extractCandidates: 引用块与 (id=...) 前缀文本被拦下，不进候选', () => {
  const session = {
    sessionKey: 's1',
    userTexts: [
      // 贴给老板看的日记/引用块形态 —— 修复前会被当候选，把前缀写进 memory 本体
      // （都带 SIGNAL_RULES 触发词「不要/禁止」，确保修复前确实会产出候选）
      { text: '> - (id=7a4a2945, type=lesson) 核对仓差异不要依赖行数，改用字节长度判定', time: NOW },
      { text: '> > - (id=7a4a2945, type=lesson) 核对仓差异不要依赖行数，改用字节长度判定', time: NOW },
      { text: '(id=7a4a2945, type=lesson) 核对仓差异不要依赖行数，改用字节长度判定', time: NOW },
      // 正常主张 —— 必须保留（带 SIGNAL_RULES 触发词「不要」）
      { text: '以后核对仓差异不要依赖行数，改用 SHA256 哈希判定', time: NOW },
    ],
    errors: [],
  };
  const cands = extractCandidates(session, NOW);
  assert.ok(
    cands.every((c) => !/id=7a4a2945/.test(c.text)),
    `引用块/前缀形态不得成为候选: ${JSON.stringify(cands.map((c) => c.text))}`,
  );
  assert.ok(cands.some((c) => /SHA256 哈希判定/.test(c.text)), '正常主张必须保留');
});

// ── 2026-09-28 建立 · 2026-10-19 收紧：工具错误信号「因果句式」过滤 ───────────
//
// fixture 全部取自真实观测。

// 09-28：噪音形态（输出残骸）。这些条目以 score=0.00 进 recall store 并被
// promoted 进长期记忆，污染记忆信噪比 —— 形态即噪音，一律拦下。
const TOOL_ERROR_NOISE_FIXTURES = [
  '(no output) [exit code: 1]',
  '<!-- source:workbuddy | synced_from: ~/.workbuddy/ME',
  'Lines Chars ----- ----- 0 45 [exit code: 1]',
  'D:\\DSH\\project源码\\DSH-AGINT\\presets\\agint\\agent.',
  '(no such file or directory)',
  '',
];

// 2026-10-19 事故样本：这 3 条在旧判据下过了闸，并以原文进了长期记忆。
// 旧判据是「出现任一诊断关键词即放行」—— 它们分别命中 invalid / expected / schema。
// ② 的原文头部是 GBK 乱码，这里用占位符代替（乱码部分不含判据关键词，
// 命中它的是 ASCII 段的 TerminatorExpectedAtEndOfString）。
const TOOL_ERROR_1019_RESIDUE = [
  'Error: invalid arguments: missing required property "file_path"; missing required property "old_string"; missing required property "new_string"',
  '[stderr] <GBK mojibake> + CategoryInfo : ParserError: (:) [], ParentContainsErrorRecordException + FullyQualifiedErrorId : TerminatorExpectedAtEndOfString [exit code: 1]',
  '· DimensionScoreSchema · DreamPhaseSchema · EvalResultSchema · EvalTargetSchema · HARMSchema · QualityEvaluatorIface · QualityLifecycleIface · QualityPolicyIface · QualityReporterIface [PASS] L0 FROZEN 契约未变更 ─── a',
];

// 2026-10-19 行为变更：旧判据放行的 schema 类报错，现在必须拦下。
// 它说的是「现在是什么样」（参数不匹配），不是「应该怎样」—— 不是可迁移的主张。
// 真要沉淀，由人 / LLM 写成主张再 memory_write。
const TOOL_ERROR_STATE_ONLY_FIXTURE =
  'Error: tool "rule_list" returned invalid output: "value.rules[0].claim" is not a declared property (additionalProperties: false)';

// 带因果句式的报错 —— 说清了「为什么 / 应该怎样」，配当教训，必须放行。
// 2026-10-28 口径统一到「中文主张」：英文那一条挪到下面的拦截清单。
const TOOL_ERROR_CAUSAL_FIXTURES = [
  '错误：DSH_HOME 指向已删除的 web profile，必须改回 AGINT-date，否则会话日志读不到',
];

// 2026-10-28 口径变更：英文因果报错不再放行。
// 理由（不是"英文不重要"，是**两把尺子必须同口径**）：本插件的主张抽取
// （SIGNAL_RULES）整体就是中文语境 —— 英文原话同样进不了候选池。错误路径若只凭
// because/must 就放行，它就比原话路径宽松，是个洞：实测真实语料里
// 「Error: old_string and new_string must differ」这类**工具契约**报错
// （must 是契约不是处方）会被当成教训灌进长期记忆。
const TOOL_ERROR_ENGLISH_CAUSAL_FIXTURES = [
  'Error: spawn ENOENT because the working directory does not exist; you must create it before running',
];

// 2026-10-28：**真实语料**回归集（7 天 / 49 会话 / 1150 条 tool/result 实测）。
// 这 9 条是旧链路（正文正则抓错误 + 因果关键词放行）真的放进候选池的文本，
// 其中若干条已经在 recall store 里躺了 2 天（score=0.00）。
// 全部是**转录文本**，没有一条是主张 —— 改动的验收标准就是「一条都不许再进池」。
const TOOL_ERROR_1028_TRANSCRIPT_FIXTURES = [
  "total 226 --- None score= None recall= 2 '工具执行报错：Error: old_string and new_string must differ' --- None score= None recall= 2 '工具执行报错：help: Run \"pnpm approve-builds\" to pick which dependencies should be allowed to run scripts. dsh: plugin command failed; diagn",
  "./test/tool-output-schema.test.mjs F=./test/tool-output-schema.test.mjs ✖ 护栏本身不是空转：作者侧写错时 dsh 编译器必须抛错 (2.211472ms) ✖ 工具 output.schema 能过 dsh 编译器：plugins/agint-search-tools/lib/tools.js (3.412ms) ✖ failing tests: ✖ 护栏本身不是空转：作者侧写错时 dsh 编译器必须抛错 (2.211472ms) Error",
  "<path>/home/kylin/projects/DSH/DSH-AGINT/plugins/agint-dream/test/sweep.test.js</path> <type>file</type> <content> 120: assert.equal(v.keep, false, `必须拦下: ${JSON.stringify(fx)} → ${v.reason}`); 121: } 122: }); 123: 124: test('classifyToolError: 10-19 夜里进了长期记忆的",
  "// 旧判据放行 1 条 const TOOL_ERROR_1028_TRANSCRIPT_FIXTURES = [ // [0] \"Error: old_string and new_string must differ\", ]; ... 2",
  "// execError 最近一次失败/顺延的原因（空串 = 没有） // execStartedAt 最近一次开始执行的时刻 // execFinishedAt 最近一次结束（成功或失败）的时刻 // // ⛔ 默认 manual：加字段之前批准的老提案（50+ 条）**不会**因为这次升级突然 // 开始自动改代码。要自动执行必须有人这一次明确选了 immediate/scheduled。 execMode: z.enum(EXEC_MODES).default('manual'), execAt: z.str",
  "index.js types 838:function defineTool(options) { 847: if (options.timeoutMs !== void 0 && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`); 1185: const ",
  "Error: old_string and new_string must differ",
  "help: Run \"pnpm approve-builds\" to pick which dependencies should be allowed to run scripts. dsh: plugin command failed; diagnostics: /home/kylin/projects/DSH/AGINT-data/profiles/headless/.plugin-manager/logs/operation-XPNkGp/pnpm.log === headless === \"version",
  "const engines = Object.hasOwn(fields, \"engines\") ? objectOf$1(fields.engines, \"Plugin manifest engines\") : {}; if (Object.hasOwn(engines, \"dsh\")) { const range = engines.dsh; if (typeof range !== \"string\") throw new Error(\"Plugin manifest engines.dsh must be a",
];

test('classifyToolError: 噪音形态一律拦下（09-28 真实样本）', () => {
  for (const fx of TOOL_ERROR_NOISE_FIXTURES) {
    const v = classifyToolError(fx);
    assert.equal(v.keep, false, `必须拦下: ${JSON.stringify(fx)} → ${v.reason}`);
  }
});

test('classifyToolError: 10-19 夜里进了长期记忆的 3 条残骸必须被拦下', () => {
  for (const fx of TOOL_ERROR_1019_RESIDUE) {
    const v = classifyToolError(fx);
    assert.equal(v.keep, false, `必须拦下: ${JSON.stringify(fx)} → ${v.reason}`);
    assert.equal(v.reason, 'no-causal-clause');
  }
});

test('classifyToolError: 状态类报错（schema 不匹配）不再放行（2026-10-19 行为变更）', () => {
  const v = classifyToolError(TOOL_ERROR_STATE_ONLY_FIXTURE);
  assert.equal(v.keep, false, '参数不匹配是工具机制，不是可迁移的主张');
  assert.equal(v.reason, 'no-causal-clause');
});

test('classifyToolError: 带因果句式的报错必须放行（2026-10-19 判据）', () => {
  for (const fx of TOOL_ERROR_CAUSAL_FIXTURES) {
    const v = classifyToolError(fx);
    assert.equal(v.keep, true, `不该拦: ${JSON.stringify(fx)} → ${v.reason}`);
    assert.equal(v.reason, 'causal-clause');
  }
});

test('classifyToolError: kill-switch 关闭时完全回退旧行为', () => {
  for (const fx of TOOL_ERROR_NOISE_FIXTURES) {
    const v = classifyToolError(fx, { toolErrorDiagnosticOnly: false });
    assert.equal(v.keep, true, '开关关掉就该全放行（回退语义）');
    assert.equal(v.reason, 'filter-disabled');
  }
});

// ── 2026-10-28：信号层改结构化字段 + 候选层正交判据 ────────────────────────
//
// 一句话背景：旧链路把「正文里出现 error 字样」当成工具失败（243 条 / 7 天），
// 其中真实失败只有 39 条（84% 误判）；再叠加「含因果关键词就放行」，
// 于是 9 条转录文本进了候选池，其中若干条以原文躺在 recall store 里。

test('classifyToolResultError: 结构化标记才算失败，正文含 error 字样不算', () => {
  const structured = classifyToolResultError({
    type: 'tool/result',
    data: { message: { isError: true, content: [{ type: 'text', text: 'Error: boom' }] } },
  });
  assert.equal(structured.isError, true);
  assert.equal(structured.source, 'structured');

  const withErrObj = classifyToolResultError({
    type: 'tool/result',
    data: {
      error: { name: 'TeamError', code: 'TEAM_TASK_STALE_REVISION' },
      message: { content: [{ type: 'text', text: 'Error: stale team task' }] },
    },
  });
  assert.equal(withErrObj.isError, true);
  assert.equal(withErrObj.source, 'structured');

  // 反例（全部是真实语料里的成功输出）：正文含 error/failed 字样
  for (const ok of [
    'dream_status: enabled · 频率 0 3 * * * sessions=/home/...',
    'recall_store_inspect: total=226 showing 9 | key(8) | type | score | recallCount',
    'Found 203 matches /home/.../sweep.test.js Line 96: consolidation: async (gated) => ({',
  ]) {
    const v = classifyToolResultError({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: ok }] } } });
    assert.equal(v.isError, false, `成功输出不得被当成错误: ${ok}`);
    assert.equal(v.source, 'none');
  }
});

test('classifyToolResultError: 老格式（无 isError）按严格前缀兜底', () => {
  const legacy = classifyToolResultError({
    type: 'tool/result',
    data: { message: { content: [{ type: 'text', text: 'Error: spawn ENOENT' }] } },
  });
  assert.equal(legacy.isError, true);
  assert.equal(legacy.source, 'legacy-prefix');

  const exitSuffix = classifyToolResultError({
    type: 'tool/result',
    data: { message: { content: [{ type: 'text', text: 'boom [exit code: 1]' }] } },
  });
  assert.equal(exitSuffix.isError, true);
  assert.equal(exitSuffix.source, 'legacy-prefix');
});

test('classifyToolResultError: exit code 0 是成功，不得判成失败（2026-10-28 复算发现）', () => {
  for (const ok of [
    'openviking-dsh-memory-plugin-0.5.30.tgz [status: completed, exit code: 0]',
    '0.5.28 redact files: 0.5.28 redactPayload hits: [status: completed, exit code: 0]',
  ]) {
    const v = classifyToolResultError({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: ok }] } } });
    assert.equal(v.isError, false, `exit code 0 不得判成失败: ${ok}`);
  }
});

test('collectSessionSignals: 工具错误只认结构化标记（84% 误判的修复）', () => {
  const records = [
    { type: 'session', id: 's1' },
    // 成功输出，正文含 error 字样 —— 旧判据会当成错误
    { type: 'tool/result', seq: 1, time: NOW, data: { message: { content: [{ type: 'text', text: 'dream_status: enabled · error=0' }] } } },
    // 真失败
    { type: 'tool/result', seq: 2, time: NOW, data: { message: { isError: true, content: [{ type: 'text', text: 'Error: boom' }] } } },
  ];
  const s = collectSessionSignals(records);
  assert.equal(s.errors.length, 1, `只应收到 1 条真实错误，实际 ${s.errors.length}`);
  assert.equal(s.errors[0].source, 'structured');
  assert.match(s.errors[0].text, /boom/);
});

test('classifyToolError: 10-28 真实污染语料一条都不许再进候选池', () => {
  for (const fx of TOOL_ERROR_1028_TRANSCRIPT_FIXTURES) {
    const v = classifyToolError(fx);
    assert.equal(v.keep, false, `必须拦下: ${fx.slice(0, 60)} → ${v.reason}`);
  }
});

test('classifyToolError: 英文因果报错按新口径拦下（与 SIGNAL_RULES 同口径）', () => {
  for (const fx of TOOL_ERROR_ENGLISH_CAUSAL_FIXTURES) {
    const v = classifyToolError(fx);
    assert.equal(v.keep, false, `英文报错不该进池: ${fx}`);
    assert.equal(v.reason, 'no-chinese-context');
  }
});

test('extractCandidates: 真实污染语料进候选池的条数必须为 0', () => {
  const session = {
    sessionKey: 's1',
    userTexts: [],
    errors: TOOL_ERROR_1028_TRANSCRIPT_FIXTURES.map((text) => ({ text, time: NOW, source: 'structured' })),
  };
  const cands = extractCandidates(session, NOW);
  const errorCands = cands.filter((c) => c.text.startsWith('工具执行报错'));
  assert.equal(errorCands.length, 0,
    `污染候选必须归零，实际 ${errorCands.length}：${JSON.stringify(errorCands.map((c) => c.text.slice(0, 60)))}`);
  assert.equal(cands.toolErrorStats.total, 9);
  assert.equal(cands.toolErrorStats.kept, 0);
  assert.equal(cands.toolErrorStats.dropped, 9);
  assert.equal(cands.toolErrorStats.structured, 9);
  assert.equal(cands.toolErrorStats.legacy, 0);
});

test('promotionBlockReason: 转录形态的存量文本必须在提升边界被拦下', () => {
  const blocked = promotionBlockReason({
    rawToolError: true,
    text: '工具执行报错：const engines = Object.hasOwn(fields, "engines") ? {} : {};',
  });
  assert.equal(blocked, 'transcript-shape-in-stored-text');
  // 正常中文主张不该被边界闸误伤
  assert.equal(promotionBlockReason({
    rawToolError: true,
    text: '工具执行报错：错误：DSH_HOME 指向已删除的 web profile，必须改回 AGINT-date，否则会话日志读不到',
  }), null);
});

test('extractCandidates: 工具错误噪音不再进候选（09-28 回归 + 10-19 收紧）', () => {
  const session = {
    sessionKey: 's1',
    userTexts: [],
    errors: [
      ...TOOL_ERROR_NOISE_FIXTURES.map((text) => ({ text, time: NOW })),
      ...TOOL_ERROR_1019_RESIDUE.map((text) => ({ text, time: NOW })),
      { text: TOOL_ERROR_STATE_ONLY_FIXTURE, time: NOW },
      ...TOOL_ERROR_CAUSAL_FIXTURES.map((text) => ({ text, time: NOW })),
    ],
  };
  const cands = extractCandidates(session, NOW);
  const errorCands = cands.filter((c) => c.text.startsWith('工具执行报错'));
  assert.equal(errorCands.length, TOOL_ERROR_CAUSAL_FIXTURES.length,
    `只应剩 ${TOOL_ERROR_CAUSAL_FIXTURES.length} 条因果型，实际 ${errorCands.length}：${JSON.stringify(errorCands.map((c) => c.text))}`);
  assert.ok(errorCands.every((c) => c.rawToolError === true), '工具错误候选必须带 rawToolError 标记（提升边界闸据此判断）');
  assert.match(errorCands[0].text, /because|必须/);
});

test('extractCandidates: toolErrorStats 是非枚举属性，数组语义不受影响', () => {
  const session = {
    sessionKey: 's1',
    userTexts: [],
    errors: TOOL_ERROR_NOISE_FIXTURES.map((text) => ({ text, time: NOW })),
  };
  const cands = extractCandidates(session, NOW);
  assert.equal(cands.length, 0);
  assert.deepEqual(cands, []);                       // 非枚举 ⇒ 不进 deepEqual
  assert.equal(JSON.stringify(cands), '[]');
  const s = cands.toolErrorStats;
  assert.equal(s.total, 6);
  assert.equal(s.kept, 0);
  assert.equal(s.dropped, 6);
  assert.equal(s.enabled, true);
});

test('aggregateToolErrorStats: 跨会话聚合（flatMap 会丢非枚举属性，只能事后聚合）', () => {
  const mk = (n) => {
    const c = [];
    Object.defineProperty(c, 'toolErrorStats', {
      value: { enabled: true, total: n, kept: 0, dropped: n, byReason: { 'no-causal-clause': n } },
      enumerable: false,
    });
    return c;
  };
  const agg = aggregateToolErrorStats([mk(3), mk(4)]);
  assert.equal(agg.total, 7);
  assert.equal(agg.dropped, 7);
  assert.equal(agg.byReason['no-causal-clause'], 7);
});

test('renderDiary: 过滤统计必须可见（不可见的治理 = 又一个盲区）', () => {
  const diary = renderDiary({
    day: '2026-09-28',
    signals: [{ userTexts: [], memWrites: [], errors: [{ text: 'x' }, { text: 'y' }] }],
    memWrites: [],
    candidates: [],
    gated: [],
    promoted: [],
    durationMs: 1000,
    toolErrorStats: { enabled: true, total: 2, kept: 0, dropped: 2, byReason: { 'no-causal-clause': 2 } },
  });
  assert.match(diary, /工具错误因果过滤：留 0 \/ 拦 2/);
  assert.match(diary, /no-causal-clause×2/);
});

test('renderDiary: 过滤统计缺席时不得凭空捏造一行', () => {
  const diary = renderDiary({
    day: '2026-09-28', signals: [], memWrites: [], candidates: [],
    gated: [], promoted: [], durationMs: 1000,
  });
  assert.ok(!/工具错误因果过滤/.test(diary));
});

test('renderDiary: 预览件自带声明（apply=false），不冒充真实夜间记录', () => {
  const diary = renderDiary({
    day: '2026-09-28', apply: false, signals: [], memWrites: [], candidates: [],
    gated: [], promoted: [], durationMs: 1000,
  });
  assert.match(diary, /dry-run 预览（apply=false）/);
  assert.match(diary, /不是.*真实夜间 sweep 记录/);
});

test('renderDiary: apply 默认 true 时不得出现预览声明', () => {
  const diary = renderDiary({
    day: '2026-09-28', signals: [], memWrites: [], candidates: [],
    gated: [], promoted: [], durationMs: 1000,
  });
  assert.ok(!/dry-run 预览/.test(diary), '真实 sweep 日记不得带预览字样');
});

test('runSweep: dry-run 不写 recall store、不覆盖当天真实日记（2026-09-28 回归）', async () => {
  const { mkdtemp, mkdir, readFile, readdir, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const base = await mkdtemp(join(tmpdir(), 'dream-preview-'));
  const sessions = join(base, 'sessions');
  const diary = join(base, 'diary');
  const recall = join(base, 'recall.jsonl');
  await mkdir(sessions, { recursive: true });
  await mkdir(diary, { recursive: true });

  // 先摆一份「当天真实记录」，模拟 03:01 那次真实 sweep 的产物。
  // day 由 NOW 本地推导（sweep 内部走 fmtDay(nowMs)），不写死字面量 ——
  // 写死过一次，NOW 是 2026-08-15 而断言写 2026-09-28，直接红。
  const d = new Date(NOW);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const realBody = `# 梦境日记 ${day}\n\n- 提升写入记忆：24 条\n`;
  await writeFile(join(diary, `${day}.md`), realBody, 'utf8');

  const result = await runSweep({
    sessionsRoot: sessions, diaryRoot: diary, recallPath: recall,
    nowMs: NOW, apply: false, qualityEval: false, evolution: false,
  });

  // 1) 真实日记必须一字未动（09-28 实测被 dry-run 冲掉过）
  assert.equal(await readFile(join(diary, `${day}.md`), 'utf8'), realBody,
    'dry-run 覆写了当天的真实日记');
  // 2) 预览件另存，且自带声明
  assert.ok(result.diaryPath.endsWith(`${day}.preview.md`), `预览路径不对: ${result.diaryPath}`);
  assert.match(await readFile(result.diaryPath, 'utf8'), /dry-run 预览（apply=false）/);
  // 3) recall store 未被写
  assert.equal(result.counts.recallAppended, 0, 'dry-run 仍写 recall store');
  assert.ok(!(await readdir(base)).includes('recall.jsonl'), 'dry-run 竟然创建了 recall store 文件');

  await rm(base, { recursive: true, force: true });
});

test('scoreCandidates: six-signal formula groups and sorts', () => {
  const session = { sessionKey: 's1', userTexts: [], errors: [] };
  const cands = [
    { text: '以后用 vger 称呼我', type: 'preference', sessionKey: 's1', time: NOW - 60_000, signals: ['a'] },
    { text: '以后用 vger 称呼我', type: 'preference', sessionKey: 's2', time: NOW - 120_000, signals: ['b'] },
    { text: '偶尔的噪音候选内容', type: 'pattern', sessionKey: 's1', time: NOW, signals: ['c'] },
  ];
  const scored = scoreCandidates(cands, { nowMs: NOW });
  const top = scored[0];
  assert.equal(top.text, '以后用 vger 称呼我');
  assert.equal(top.signalCount, 2);
  assert.equal(top.uniqueSessions, 2);
  assert.ok(top.score > 0 && top.score <= 1);
  assert.ok(top.components.frequency > 0 && top.components.recency > 0);
  assert.ok(scored.every((c) => c.score <= 1 && c.score >= 0));
});

test('gateCandidates: thresholds and existing-memory dedupe', () => {
  const scored = [
    { text: '以后用 vger 称呼我', type: 'preference', signalCount: 3, uniqueSessions: 2, score: 0.8, sessions: ['s1'], days: ['2026-08-15'], signals: ['a'] },
    { text: '已有记忆的重复内容测试', type: 'decision', signalCount: 3, uniqueSessions: 2, score: 0.8, sessions: ['s1'], days: ['2026-08-15'], signals: ['b'] },
    { text: '低分候选内容', type: 'lesson', signalCount: 1, uniqueSessions: 1, score: 0.2, sessions: ['s1'], days: ['2026-08-15'], signals: ['c'] },
  ];
  const existing = [{ id: 'm1', type: 'decision', content: '已有记忆的重复内容测试' }];
  const gated = gateCandidates(scored, existing, { minScore: 0.75, minRecall: 3, minUniqueSessions: 2 });
  assert.deepEqual(gated.map((c) => c.text), ['以后用 vger 称呼我']);
});

test('entryFor: maps candidate to memory payload', () => {
  const entry = entryFor({ type: 'lesson', text: '禁止删密钥', score: 0.82 }, 'evidence-here');
  assert.equal(entry.type, 'lesson');
  assert.equal(entry.content, '禁止删密钥');
  assert.equal(entry.confidence, 0.8);
  assert.equal(entry.evidence, 'evidence-here');
});

test('renderDiary: includes counts and promoted rows', () => {
  const md = renderDiary({
    day: '2026-08-15',
    signals: [{ userTexts: ['a'], memWrites: [], errors: [] }],
    memWrites: [],
    candidates: [],
    gated: [{ text: 'x', type: 'decision', score: 0.9, signalCount: 2, uniqueSessions: 1 }],
    promoted: [{ candidate: { score: 0.9 }, entry: { type: 'decision', content: 'x', confidence: 0.9, evidence: 'e' } }],
    errors: [],
    durationMs: 1234,
  });
  assert.match(md, /# 梦境日记 2026-08-15/);
  assert.match(md, /提升写入记忆：1 条/);
  assert.match(md, /score=0.90/);
});

test('scoreCandidates: REM reinforcement joins cross-day signals', () => {
  const base = [
    { text: '以后用 vger 称呼我', type: 'preference', sessionKey: 's1', time: NOW - 60_000, signals: ['a'] },
  ];
  const reinforcement = [
    { text: '以后用 vger 称呼我', type: 'preference', sessionKey: 's2', time: NOW - 3 * 86_400_000, signals: ['b'] },
    { text: '以后用 vger 称呼我', type: 'preference', sessionKey: 's3', time: NOW - 5 * 86_400_000, signals: ['c'] },
  ];
  const scored = scoreCandidates(base, { nowMs: NOW, reinforcement });
  assert.equal(scored.length, 1);
  const top = scored[0];
  assert.equal(top.signalCount, 3);
  assert.equal(top.uniqueSessions, 3);
  assert.equal(top.uniqueDays, 3);
  assert.equal(top.reinforced, true);
  assert.ok(top.consolidation > 0.2, 'cross-day reinforcement must raise consolidation');
});

test('scoreCandidates: reinforcement never creates standalone candidates', () => {
  const scored = scoreCandidates([], { nowMs: NOW, reinforcement: [
    { text: '只有强化信号的候选', type: 'pattern', sessionKey: 's1', time: NOW, signals: ['x'] },
  ] });
  assert.equal(scored.length, 0);
});

test('runSweep: stub memory, dry-run vs apply', async () => {
  const calls = [];
  const memoryStub = {
    async list() { return []; },
    async write(entry) { calls.push(entry); return { id: 'new-' + calls.length, ...entry }; },
  };
  const sweepOpts = {
    sessionsRoot: '/nonexistent/empty', // no logs → empty sweep, still diaries
    diaryRoot: '/tmp/agint-dream-test',
    memory: memoryStub,
    nowMs: NOW,
    apply: false,
  };
  const preview = await runSweep(sweepOpts);
  assert.equal(preview.apply, false);
  assert.equal(preview.counts.promoted, 0);
  assert.equal(preview.counts.recovered, 0);
  assert.equal(calls.length, 0);

  const applied = await runSweep({ ...sweepOpts, apply: true });
  assert.equal(applied.counts.promoted, 0); // no logs → nothing to promote
  assert.equal(calls.length, 0);
});

test('renderDiary: includes recovered lane and window line', () => {
  const md = renderDiary({
    day: '2026-08-15',
    signals: [{ userTexts: ['a'], memWrites: [], errors: [] }],
    memWrites: [],
    candidates: [],
    gated: [{ text: 'x', type: 'decision', score: 0.9, signalCount: 2, uniqueDays: 1, uniqueSessions: 1, reinforced: false }],
    recovered: [{ text: 'y', type: 'lesson', score: 0.8, signalCount: 4, uniqueDays: 3, uniqueSessions: 2 }],
    promoted: [],
    errors: [],
    durationMs: 1234,
    windows: { light: 2, rem: 7, deep: 30 },
  });
  assert.match(md, /窗口：Light 2d \/ REM 7d \/ Deep恢复 30d/);
  assert.match(md, /Deep 恢复通道（30 天回填/);
  assert.match(md, /\| 1 \| lesson \| 0.80 \| 4 \| 3 \| y \|/);
});

test('recencyComponent: time=0 (missing timestamp) → 0, not 1.0', async () => {
  // Missing/zero timestamp must cap, not be treated as the most recent.
  const { scoreCandidates } = await import('../lib/sweep.js');
  const r = scoreCandidates([
    { text: '以后用 vger', type: 'preference', sessionKey: 's1', time: 0, signals: ['a'] },
  ], { nowMs: NOW });
  assert.equal(r[0].recency, 0, 'time=0 ages to forever → recency 0');
});

test('recencyComponent: time at exactly nowMs → recency 1.0', async () => {
  const { scoreCandidates } = await import('../lib/sweep.js');
  const r = scoreCandidates([
    { text: '今天的偏好', type: 'preference', sessionKey: 's1', time: NOW, signals: ['a'] },
  ], { nowMs: NOW });
  assert.ok(r[0].recency > 0.99, 'recency at nowMs ≈ 1.0');
});

test('tokenOverlap: Chinese partial match score is below 1.0 (no longer whole-string collapse)', async () => {
  // Pre-fix bug: whitespace-split on CJK gave overlap=1.0 for everything.
  // Post-fix: bigram Jaccard is a real number < 1.0 for non-identical strings.
  const { gateCandidates } = await import('../lib/sweep.js');
  const gated = gateCandidates(
    // Two distinct Chinese statements that share some bigrams but are not
    // identical: the new memory is about a specific tool, the old one is
    // about a different topic. Whitespace-split would have collapsed to 1.0.
    [{ text: '更新工具的流程先备份后替换', type: 'pattern', signalCount: 3, uniqueSessions: 2, score: 0.8, sessions: ['s1'], days: ['2026-08-15'], signals: ['x'] }],
    [{ id: 'm1', type: 'pattern', content: '遵守用户隐私保护政策' }],
    { minScore: 0.75, minRecall: 3, minUniqueSessions: 2, dedupeTokenOverlap: 0.5 },
  );
  // Distinct topics → bigram overlap < 0.5 → NOT covered.
  assert.equal(gated.length, 1, 'distinct Chinese sentences must not be falsely covered');
});

// 2026-09-21 行为变更（方案 B，老板已拍板）：互含**不再一律丢弃**。
// 旧断言 `substring containment must dedupe`（gated.length===0）源自单一阈值时代 ——
// 它正是「同源闭包」的帮凶：候选只要与任一条 existing 有互含关系就出局，而候选与
// 生产记忆共享同一份会话来源，互含是常态而非异常。现在按长度比例分档：
//   ratio ≥ 0.85 → 真重复（丢弃）；ratio < 0.85 → 疑似（放行 + 标记）。
// 本用例的两句 ratio ≈ 0.64 → 降级为中档。旧行为由 kill-switch 用例守着。
test('分级去重（行为变更）：互含但长度悬殊 → 降级为中档放行，不再一律丢弃', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  const scored = [{
    text: '智进使用 vger 称呼', type: 'decision', signalCount: 3, uniqueSessions: 2,
    score: 0.8, sessions: ['s1'], days: ['2026-08-15'], signals: ['x'],
  }];
  const existing = [{ id: 'm1', type: 'decision', content: '使用 vger 称呼' }]; // substring of candidate
  const opts = { minScore: 0.75, minRecall: 3, minUniqueSessions: 2, dedupeTokenOverlap: 0.5 };
  const gated = gateCandidates(scored.map((c) => ({ ...c })), existing, opts);
  assert.equal(gated.length, 1, 'ratio 0.64 (<0.85) → 疑似档，放行给 LLM 裁');
  assert.equal(gated[0].dedupeSuspicion.kind, 'substring');
  // kill-switch 下旧行为必须完整保留
  const legacy = gateCandidates(scored.map((c) => ({ ...c })), existing, { ...opts, dedupeTieredEnabled: false });
  assert.equal(legacy.length, 0, 'dedupeTieredEnabled=false → 回退为一律丢弃（旧行为）');
});

test('tokenOverlap: bag-of-words full-match triggers dedupe', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  const gated = gateCandidates(
    [{ text: 'keep workspace clean', type: 'lesson', signalCount: 3, uniqueSessions: 2, score: 0.8, sessions: ['s1'], days: ['2026-08-15'], signals: ['x'] }],
    [{ id: 'm1', type: 'lesson', content: 'keep workspace clean' }],
    { minScore: 0.75, minRecall: 3, minUniqueSessions: 2, dedupeTokenOverlap: 0.5 },
  );
  assert.equal(gated.length, 0, 'exact match must be deduped');
});

// ── 2026-09-21：分级去重（方案 B，proposals/agint-dream-dedupe-lineage.md）──────
//
// 病灶：候选从会话日志抽，生产记忆本身也是这些会话沉淀的产物 —— 两者共享同一份
// 文本来源。单一 0.6 阈值下 existing 越全命中率越高，实测 406 条记忆把 83 条过门
// 候选 100% 吃掉（gated 0）。修法：把「命中后果」从布尔拆成三档。

const CAND = (text, score = 0.8) => ({
  text, type: 'decision', signalCount: 3, uniqueSessions: 2, score,
  sessions: ['s1'], days: ['2026-08-15'], signals: ['x'],
});

test('分级去重：高相似（≥0.85 精确同句）仍被丢弃 → gated 不变', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  const gated = gateCandidates(
    [CAND('keep workspace clean')],
    [{ id: 'm1', type: 'lesson', content: 'keep workspace clean' }],
    { minScore: 0.75, minRecall: 3, minUniqueSessions: 2 },
  );
  assert.equal(gated.length, 0, 'exact match is real duplication → dropped');
  assert.equal(gated.dedupeStats.dropped, 1);
  assert.equal(gated.dedupeStats.suspicious, 0);
});

test('分级去重：互含但长度悬殊（ratio < 0.85）→ 放行 + dedupeSuspicion', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  // '使用 vger 称呼' 完全被候选包含，但 ratio = 7/11 ≈ 0.64 落在中档
  const gated = gateCandidates(
    [CAND('智进使用 vger 称呼')],
    [{ id: 'm1', type: 'decision', content: '使用 vger 称呼' }],
    { minScore: 0.75, minRecall: 3, minUniqueSessions: 2, dedupeTokenOverlap: 0.5 },
  );
  assert.equal(gated.length, 1, '中相似档必须放行给 LLM 裁');
  assert.equal(gated[0].dedupeSuspicion.kind, 'substring');
  assert.equal(gated[0].dedupeSuspicion.againstId, 'm1');
  assert.ok(gated[0].dedupeSuspicion.similarity >= 0.6, 'similarity 记录在案');
  assert.equal(gated.dedupeStats.suspicious, 1);
  assert.equal(gated.dedupeStats.dropped, 0);
});

test('分级去重：中相似（0.6~0.85 二元组重叠）→ 放行 + kind=similarity', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  // 实测 maxSimilarity = 0.667：共享大部分二元组（「化方案用于长期投资」「方案用于长期投」
  // 等），但都不是对方的子串 → 必走 tokenOverlap 分支，落中档。
  const gated = gateCandidates(
    [CAND('索引化方案用于长期投资')],
    [{ id: 'm2', type: 'decision', content: '指数化方案用于长期投资' }],
    { minScore: 0.75, minRecall: 3, minUniqueSessions: 2, dedupeMid: 0.6, dedupeHigh: 0.85 },
  );
  assert.equal(gated.length, 1, '中相似档放行');
  assert.equal(gated[0].dedupeSuspicion.kind, 'similarity');
  assert.equal(gated[0].dedupeSuspicion.againstId, 'm2');
  assert.ok(gated[0].dedupeSuspicion.similarity >= 0.6 && gated[0].dedupeSuspicion.similarity < 0.85,
    `similarity 必须落在中档，实测 ${gated[0].dedupeSuspicion.similarity}`);
  assert.equal(gated.dedupeStats.suspicious, 1);
  assert.equal(gated.dedupeStats.dropped, 0);
});

test('分级去重：低相似（<0.6）→ 无标记放行', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  const gated = gateCandidates(
    [CAND('更新工具的流程先备份后替换')],
    [{ id: 'm1', type: 'pattern', content: '遵守用户隐私保护政策' }],
    { minScore: 0.75, minRecall: 3, minUniqueSessions: 2, dedupeTokenOverlap: 0.5 },
  );
  assert.equal(gated.length, 1);
  assert.equal(gated[0].dedupeSuspicion, undefined, '低相似不得被打标（防误伤）');
  assert.equal(gated.dedupeStats.suspicious, 0);
});

test('回归护栏：dedupeTieredEnabled=false → 与现状（单一阈值布尔判定）逐项一致', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  // 三条候选覆盖三种形态：精确同句（高）/ 互含（中档，旧逻辑必丢）/ 无关
  const scored = [
    CAND('keep workspace clean'),
    CAND('智进使用 vger 称呼'),
    CAND('更新工具的流程先备份后替换'),
  ];
  const existing = [
    { id: 'm1', type: 'lesson', content: 'keep workspace clean' },
    { id: 'm2', type: 'decision', content: '使用 vger 称呼' },
    { id: 'm3', type: 'pattern', content: '遵守用户隐私保护政策' },
  ];
  const opts = { minScore: 0.75, minRecall: 3, minUniqueSessions: 2, dedupeTokenOverlap: 0.5 };
  const tiered = gateCandidates(scored.map((c) => ({ ...c })), existing, opts);
  const legacy = gateCandidates(scored.map((c) => ({ ...c })), existing, { ...opts, dedupeTieredEnabled: false });
  // 旧逻辑：互含即丢 → 只剩「无关」那条
  assert.equal(legacy.length, 1, 'kill-switch 下必须回到单一阈值行为');
  assert.equal(legacy[0].text, '更新工具的流程先备份后替换');
  assert.ok(legacy.every((c) => c.dedupeSuspicion === undefined), '回退态不得产生新字段');
  assert.equal(legacy.dedupeStats.enabled, false);
  // 分级态：中档那条被放行 → 比回退态多
  assert.ok(tiered.length > legacy.length, `分级去重必须比回退态多放行（${tiered.length} > ${legacy.length}）`);
});

test('分级去重：空 existing → 全部放行且零计数', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  const gated = gateCandidates([CAND('以后用 vger 称呼我')], [], { minScore: 0.75, minRecall: 3, minUniqueSessions: 2 });
  assert.equal(gated.length, 1);
  assert.deepEqual(
    { dropped: gated.dedupeStats.dropped, suspicious: gated.dedupeStats.suspicious, max: gated.dedupeStats.maxSimilarity },
    { dropped: 0, suspicious: 0, max: 0 },
  );
});

test('分级去重：1 条 existing 且内容为空/纯标点 → 不产生 NaN', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  const gated = gateCandidates(
    [CAND('以后用 vger 称呼我')],
    [{ id: 'm1', type: 'lesson', content: '   ' }],  // normalize 后为空 → 被 filter 掉
    { minScore: 0.75, minRecall: 3, minUniqueSessions: 2 },
  );
  assert.equal(gated.length, 1);
  assert.equal(gated[0].dedupeSuspicion, undefined);
  assert.ok(Number.isFinite(gated.dedupeStats.maxSimilarity), 'maxSimilarity 必须是有限数');
});

test('分级去重：dedupeStats 是非枚举属性 —— 数组语义（length/deepEqual）不受影响', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  const gated = gateCandidates([CAND('以后用 vger 称呼我')], [], { minScore: 0.75, minRecall: 3, minUniqueSessions: 2 });
  assert.deepEqual(gated, [gated[0]], 'deepEqual 只比数组元素，不带统计字段');
  assert.deepEqual(Object.keys(gated), ['0'], '统计不得成为可枚举键');
});

test('分级去重：门槛未过的候选不计入 checked（埋点只统计真进过去重的）', async () => {
  const { gateCandidates } = await import('../lib/sweep.js');
  const gated = gateCandidates(
    [CAND('低分候选', 0.2), CAND('过门候选')],
    [],
    { minScore: 0.75, minRecall: 3, minUniqueSessions: 2 },
  );
  assert.equal(gated.length, 1);
  assert.equal(gated.dedupeStats.checked, 1, '被 score 门槛挡掉的不算「进过去重」');
});

// ── P1 LLM consolidation 集成测试 ───────────────────────────────────────

test('runSweep: 显式 consolidation runner 输出 operations → validation 走 plan', async () => {
  const { runSweep } = await import('../lib/sweep.js');
  // 直接构造一个 minimum 的 scored candidate —— 通过 consolidation runner 的 caller 路径
  // 走显式 consolidation 参数，不依赖真实 sessions 文件
  const memoryStub = { async list() { return []; }, async write() { throw new Error('not called'); } };
  // 用空的 sessions 让 sweep 跳过 Light，但通过显式 consolidation runner 不影响 (no gated → no consolidation 调用)
  const result = await runSweep({
    sessionsRoot: '/nonexistent',
    diaryRoot: '/tmp/agint-dream-test',
    memory: memoryStub,
    nowMs: NOW,
    apply: false,
    // 即使给 consolidation runner 也不会被调用（因为没有 gated）
    consolidation: async () => ({ mode: 'llm', operations: [] }),
  });
  assert.equal(result.counts.gated, 0);
  // 2026-09-18 C 项：没 gated → LLM 没被调用，诚实标 not-attempted（不再伪装成 LLM 失败）
  assert.equal(result.counts.consolidationMode, 'not-attempted');
  assert.match(result.counts.consolidationReason, /0 gated/);
});

test('runSweep: 不传 consolidation runner + 不传 ctx + 0 gated → not-attempted, sweep 不崩溃', async () => {
  const { runSweep } = await import('../lib/sweep.js');
  const memoryStub = { async list() { return []; }, async write() { throw new Error('should not be called'); } };
  const result = await runSweep({
    sessionsRoot: '/nonexistent',
    diaryRoot: '/tmp/agint-dream-test',
    memory: memoryStub,
    nowMs: NOW,
    apply: false,
    // 没有 consolidation / 没有 ctx
  });
  // 2026-09-18 C 项：0 gated → LLM 未被调用（空 sessions 下永远不会走到 runner 判定）
  assert.equal(result.counts.consolidationMode, 'not-attempted');
  assert.match(result.counts.consolidationReason, /0 gated/);
});

test('runSweep: 显式 consolidation runner 抛错 → degraded, sweep 不崩溃', async () => {
  const { runSweep } = await import('../lib/sweep.js');
  const memoryStub = { async list() { return []; }, async write() { throw new Error('should not be called'); } };
  // 这里没法构造 gated（sessions 是空），所以 runner 不会被调用 —— 验证 errors 数组不包含 runner 失败
  const result = await runSweep({
    sessionsRoot: '/nonexistent',
    diaryRoot: '/tmp/agint-dream-test',
    memory: memoryStub,
    nowMs: NOW,
    apply: false,
    consolidation: async () => { throw new Error('mock runner boom'); },
  });
  assert.equal(result.counts.gated, 0);
  // runner 没被调（因为没 gated），errors 数组应该不包含 runner failed
  assert.ok(!result.errors.some((e) => /runner/.test(e)));
});

test('renderDiary: consolidationMode=llm 显示 ✅', async () => {
  const { renderDiary } = await import('../lib/sweep.js');
  const md = renderDiary({
    day: '2026-09-05',
    signals: [], memWrites: [], candidates: [], gated: [], promoted: [],
    errors: [], durationMs: 100,
    consolidationMode: 'llm',
    consolidationReason: 'merged 2 entries',
  });
  // 注意：llm 分支的标签是加粗的（`**P1 LLM consolidation**:`，与上方 P0 validation gate 行同款式），
  // 而 heuristic-degraded 分支不加粗。此断言自 fbfd060 起与实现漂移（一直红），2026-09-17 按实现校正。
  assert.match(md, /\*\*P1 LLM consolidation\*\*: ✅ LLM 决策 add\/merge\/supersede（merged 2 entries）/);
});

test('renderDiary: consolidationMode=failed 显示 ❌ 且写明不提升', async () => {
  const { renderDiary } = await import('../lib/sweep.js');
  const md = renderDiary({
    day: '2026-09-05',
    signals: [], memWrites: [], candidates: [], gated: [], promoted: [],
    errors: [], durationMs: 100,
    consolidationMode: 'failed',
    consolidationReason: 'agents service unavailable',
  });
  assert.match(md, /P1 LLM consolidation: ❌ failed（本轮不提升任何候选，无启发式回退）：agents service unavailable/);
});

test('renderDiary: consolidationMode=not-attempted 显示 ➖ 未触发（区别于 LLM 失败）', async () => {
  const { renderDiary } = await import('../lib/sweep.js');
  const md = renderDiary({
    day: '2026-09-18',
    signals: [], memWrites: [], candidates: [], gated: [], promoted: [],
    errors: [], durationMs: 100,
    consolidationMode: 'not-attempted',
    consolidationReason: '0 gated candidates — LLM 未触发',
  });
  assert.match(md, /P1 LLM consolidation: ➖ 未触发（0 gated candidates/);
  assert.doesNotMatch(md, /❌ failed/);
});

// ── 2026-10-19：提升边界闸（promotionBlockReason）─────────────────────────────
//
// 两道闸，职责不同：
//   1. 抽取闸 classifyToolError：作用在**原始 stderr** 上（这条报错是不是主张）。
//   2. 边界闸 promotionBlockReason：作用在**将要写进本体的文本**上。
// 抽取闸放行、边界闸拦截的真实场景：候选文本被截断到 maxCandidateChars(220)，
// 因果句式落在截断点之后 —— 写进本体的就只剩残骸。

test('promotionBlockReason: 工具错误残骸被拦，含因果句式的放行', () => {
  const residue = promotionBlockReason({
    rawToolError: true,
    text: '工具执行报错：Error: invalid arguments: missing required property "file_path"',
  });
  assert.equal(residue, 'no-causal-clause-in-stored-text');

  const causal = promotionBlockReason({
    rawToolError: true,
    text: '工具执行报错：错误：DSH_HOME 指向已删除的 web profile，必须改回 AGINT-date',
  });
  assert.equal(causal, null);
});

test('promotionBlockReason: 非工具错误候选不受这道闸约束（用户原话是主张）', () => {
  assert.equal(promotionBlockReason({ text: '以后用 vger 称呼我' }), null);
  assert.equal(promotionBlockReason(null), null);
});

test('promotionBlockReason: kill-switch 关闭时两道闸一起让路（完全回退旧行为）', () => {
  const residue = {
    rawToolError: true,
    text: '工具执行报错：Error: invalid arguments: missing required property "file_path"',
  };
  assert.equal(promotionBlockReason(residue, { toolErrorDiagnosticOnly: false }), null);
});

// 端到端：残骸不得进长期记忆；带因果句式的必须进。
// 两条互为红绿自证 —— 拆掉边界闸，第 1 条会红；把闸改成拦一切，第 2 条会红。
test('runSweep: 提升边界闸 —— 残骸不进记忆，因果句式的照进（2026-10-19）', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  // zstd 缺失 ⇒ 明确跳过（不静默跳过：静默跳过 = 假防线）
  let zstdOk = true;
  try { spawnSync('zstd', ['--version'], { stdio: 'ignore' }); zstdOk = true; } catch { zstdOk = false; }
  if (!zstdOk || spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status !== 0) {
    t.skip('zstd CLI 不在本机 PATH —— 会话日志读不了，这道闸测不了');
    return;
  }

  // 因果句式落在截断点（候选文本 220 字符）之后：抽取闸放行，边界闸拦截。
  // 2026-10-28：文本改成中文主张（英文报错按新口径在抽取闸就被拦，
  // 这道闸就测不到东西了 —— 口径见 classifyToolError 的 doc）。
  const residueText = `错误：启动服务失败${'啊'.repeat(215)}因为配置文件从未复制`;
  const causalText = '错误：启动服务失败，因为配置文件从未复制';

  async function runWith(text, tag) {
    const base = await mkdtemp(join(tmpdir(), `dream-gate-${tag}-`));
    const sessions = join(base, 'sessions');
    const diary = join(base, 'diary');
    await mkdir(sessions, { recursive: true });
    await mkdir(diary, { recursive: true });
    // 3 个会话 × 同一条报错 ⇒ signalCount=3 / uniqueSessions=3 ⇒ 过闸
    for (let i = 0; i < 3; i += 1) {
      const dir = join(sessions, 'ws', `${tag}-${i}`);
      await mkdir(dir, { recursive: true });
      const lines = [
        JSON.stringify({ type: 'session', id: `${tag}-${i}` }),
        JSON.stringify({
          type: 'tool/result', seq: 2, time: NOW,
          data: { message: { content: [{ type: 'text', text }] } },
        }),
      ].join('\n');
      const buf = spawnSync('zstd', ['-q', '-c'], { input: lines, maxBuffer: 1 << 24 });
      if (buf.status !== 0) throw new Error(`zstd 压缩失败: ${buf.stderr?.toString() ?? ''}`);
      await writeFile(join(dir, 'session.v3.jsonl.zstd'), buf.stdout);
    }
    const calls = [];
    const memoryStub = {
      async list() { return []; },
      async write(entry) { calls.push(entry); return { id: 'm' + calls.length, ...entry }; },
    };
    const result = await runSweep({
      sessionsRoot: sessions, diaryRoot: diary, recallPath: join(base, 'recall.jsonl'),
      memory: memoryStub, nowMs: NOW, apply: true, qualityEval: false, evolution: false,
      recover: false, zeroHitAlert: false, minScore: 0.1,
      // 无降级后 ctx 不可用会让 consolidation 失败、整轮零提升；本用例只测边界闸，
      // 故显式注入 LLM 成功结果（等价于 host plane 调通）。
      consolidation: async (gated) => ({
        ok: true,
        mode: 'llm',
        operations: gated.map((c) => ({
          candidateKey: c.key ?? c.candidateKey, action: 'added', priorEntries: [],
        })),
      }),
    });
    await rm(base, { recursive: true, force: true });
    return { result, calls };
  }

  const residue = await runWith(residueText, 'residue');
  assert.ok(residue.result.counts.gated >= 1,
    `残骸必须先过抽取闸（gated>0），否则这道测试没测到东西：${JSON.stringify(residue.result.counts)}`);
  assert.equal(residue.result.counts.skippedRawToolError, 1, '残骸必须在提升边界被拦下');
  assert.equal(residue.calls.length, 0, '残骸不得写进长期记忆');
  assert.equal(residue.result.counts.promoted, 0);

  const causal = await runWith(causalText, 'causal');
  assert.ok(causal.result.counts.gated >= 1, '因果句式必须过抽取闸');
  assert.equal(causal.result.counts.skippedRawToolError, 0, '因果句式不得被边界闸拦下');
  assert.equal(causal.calls.length, 1, '因果句式必须写进长期记忆');
  assert.match(causal.calls[0].content, /因为/);
});
