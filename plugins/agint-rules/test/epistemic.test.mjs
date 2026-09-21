/**
 * agint-rules: 断言型护栏回归测试（2026-09-21）
 *
 * 直接 import 仓库那份 lib/index.js（不重写逻辑，避免"测的是副本"这类
 * 经典自欺），对 evaluateEpistemic 做双向断言：
 *   A 组 = 应当拦下（漏放 → 护栏无效）
 *   B 组 = 不应拦（误杀 → 噪音，比漏放更糟）
 *
 * Run: node --test test/epistemic.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateEpistemic, epistemicSeedRules } from '../lib/index.js';

const RULES = Object.fromEntries(epistemicSeedRules().map((r) => [r.id, r]));
const NEG = RULES['epistemic-negated-existence'];
const QUANT = RULES['epistemic-quantifier'];
const SELF = RULES['epistemic-negated-self'];

/** 对一段文本跑全部三条规则，返回命中的 ruleId */
function scan(text) {
  const hits = [];
  for (const r of [NEG, QUANT, SELF]) {
    const m = evaluateEpistemic(r, text);
    if (m) hits.push(m.ruleId);
  }
  return hits;
}

// ═══════════════════════════════════════════════════════════════════
// A 组：这些句子**必须**被拦（全部是我真实犯过的原话形态）
// ═══════════════════════════════════════════════════════════════════

test('A1 K30 型：断言接口不存在（无取证）', () => {
  assert.ok(scan('这个接口不存在，源码里没有任何定义').includes(NEG.id));
});

test('A2 K33 型：断言宿主不支持某能力', () => {
  assert.ok(scan('宿主不支持 pre-compact 钩子').includes(NEG.id));
});

test('A3 断言插件未挂载', () => {
  assert.ok(scan('这个插件还没挂载').includes(NEG.id));
});

test('A4 断言 LLM 通路不通', () => {
  assert.ok(scan('LLM 通路是不通的').includes(NEG.id));
});

test('A5 K68 型：断言信号数恒为 1', () => {
  assert.ok(scan('信号数恒为 1').includes(QUANT.id));
});

test('A6 K68 型：全称断言「全部被挡回」', () => {
  assert.ok(scan('全部候选都被去重挡回去了').includes(QUANT.id));
});

test('A7 K68 型：断言「全是回声」', () => {
  assert.ok(scan('83 条全是回声').includes(QUANT.id));
});

test('A8 断言某函数在仓库里找不到', () => {
  assert.ok(scan('仓库里没有这个函数').includes(NEG.id));
});

test('A9 否定式自述（无法自证的辩白）', () => {
  assert.ok(scan('我没有删除过任何文件').includes(SELF.id));
});

test('A10 断言能力不可用', () => {
  assert.ok(scan('这个能力不可用').includes(NEG.id));
});

// ═══════════════════════════════════════════════════════════════════
// B 组：这些句子**绝不能**被拦（误杀率是这套护栏的生死线）
// ═══════════════════════════════════════════════════════════════════

test('B1 带 grep 证据的断言 → 豁免', () => {
  assert.deepEqual(scan('我 grep 了 plugins/ 全库，命中 0 —— 这个接口不存在。'), []);
});

test('B2 带行号证据 → 豁免', () => {
  assert.deepEqual(scan('consolidation.js:157 里 gated.length === 0 就提前返回，所以走不到 provider 调用。'), []);
});

test('B3 疑问句 → 豁免', () => {
  assert.deepEqual(scan('这个接口是否存在？'), []);
});

test('B4 任务句 → 豁免', () => {
  assert.deepEqual(scan('帮我确认一下插件挂载状态'), []);
});

test('B5 已声明未查 → 豁免（诚实表述不该被罚）', () => {
  assert.deepEqual(scan('这个文件没有出现在列表里，但我还没查，需要确认'), []);
});

test('B6 日常用语中的「没有」→ 豁免（宾语非技术实体）', () => {
  assert.deepEqual(scan('今天没有别的事情了'), []);
});

test('B7 推测语气 → 豁免', () => {
  assert.deepEqual(scan('我猜这个函数可能没有调用方'), []);
});

test('B8 恒等式的正常表达 → 豁免', () => {
  assert.deepEqual(scan('这个公式对所有正整数都成立'), []);
});

test('B9 已引用 K 编号 → 豁免', () => {
  assert.deepEqual(scan('接口不存在这件事已经确认过了，证据在 K30'), []);
});

test('B10 实证型结论（带实测/取证字样）→ 豁免', () => {
  assert.deepEqual(scan('实测：宿主三样都有，取证见 K33'), []);
});

test('B11 已知未接线的诚实描述 → 豁免', () => {
  assert.deepEqual(scan('这个能力目前还没有接入，我还没查具体原因'), []);
});

// ── B12–B15：E2E 实测暴露的误杀，逐个钉死（2026-09-21）──────────────

test('B12 条件/假设句不是断言 → 豁免', () => {
  assert.deepEqual(scan('如果接口不存在，我们就需要换一条路径'), []);
});

test('B13 权限类「没有」是事实陈述 → 豁免', () => {
  assert.deepEqual(scan('我没有权限访问那个目录，需要你确认一下'), []);
});

test('B14 报错/异常类「没有」→ 豁免', () => {
  assert.deepEqual(scan('这个进程没有报错'), []);
});

test('B15 全称一般性陈述（无封闭信号）→ 豁免', () => {
  assert.deepEqual(scan('所有插件都必须声明 manifest.json'), []);
});

test('B16 数学/逻辑上的「都已经成立」→ 豁免（不因「已经」误杀）', () => {
  assert.deepEqual(scan('这个公式对所有正整数都已经成立'), []);
});

// ── B17–B22：单字动词「无/未/没」的抗误杀（这是本轮最激进的改动）──────
// 补「无」是为了拦住"宿主无 pre-compact 钩子"这类真实漏放，
// 但单字匹配极易泛滥。下面每条都必须放行，否则要回退这个改动。

test('B17 「无以复加」这类成语 → 豁免', () => {
  assert.deepEqual(scan('这个设计已经无以复加地复杂了'), []);
});

test('B18 无 + 非技术宾语 → 豁免', () => {
  assert.deepEqual(scan('无论如何我们都要做完'), []);
});

test('B19 「未」在正常叙述里 → 豁免', () => {
  assert.deepEqual(scan('未来的扩展点先留着'), []);
});

test('B20 「没」在日常对话里 → 豁免', () => {
  assert.deepEqual(scan('没关系，可以下次再改'), []);
});

test('B21 无 + 技术宾语但带取证 → 豁免', () => {
  assert.deepEqual(scan('grep 确认该函数无生产调用者，命中仅 test/smoke.mjs'), []);
});

test('B22 「非」在正常表述里 → 豁免', () => {
  assert.deepEqual(scan('这是非常正常的现象'), []);
});

// ── B23–B24：单字动词的**正向**能力（漏放补丁必须真的有效）─────────

test('B23 「无生产调用者」是断言 → 拦下（补该动词的目的）', () => {
  assert.ok(scan('runPreCompressCheckpoint 无生产调用者').includes(NEG.id));
});

test('B24 「宿主无 pre-compact 钩子」→ 拦下', () => {
  assert.ok(scan('宿主无 pre-compact 钩子').includes(NEG.id));
});

test('B25 「无数据行」→ 拦下', () => {
  assert.ok(scan('pre_compress_checkpoints 表无数据行').includes(NEG.id));
});

// ═══════════════════════════════════════════════════════════════════
// 结构不变量
// ═══════════════════════════════════════════════════════════════════

test('C1 非 claim 规则不进断言通道', () => {
  const actionRule = { id: 'x', claim: false, pattern: 'foo', action: 'deny', level: 'L1', reason: 'r' };
  assert.equal(evaluateEpistemic(actionRule, '这个接口不存在'), null);
});

test('C2 disabled 规则不触发', () => {
  assert.equal(evaluateEpistemic({ ...NEG, enabled: false }, '这个接口不存在'), null);
});

test('C3 空文本不触发', () => {
  assert.equal(evaluateEpistemic(NEG, ''), null);
  assert.equal(evaluateEpistemic(NEG, null), null);
});

test('C4 三种 claimKind 齐备', () => {
  assert.deepEqual(
    epistemicSeedRules().map((r) => r.claimKind).sort(),
    ['existence', 'negated-self', 'quantifier'],
  );
});

test('C5 种子规则全部声明 action=advisory（首版不做硬拦）', () => {
  for (const r of epistemicSeedRules()) {
    assert.equal(r.action, 'advisory', `${r.id} 首版必须是 advisory`);
    assert.equal(r.claim, true, `${r.id} 必须标记 claim`);
  }
});
