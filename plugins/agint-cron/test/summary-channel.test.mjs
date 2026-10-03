/**
 * cron summarizeResult 的约定式 summary 通道（2026-09-29）。
 *
 * 为什么需要测这个：evolution-cycle 的 commit 阶段 policyDecision 曾经完全不可见 ——
 * cron 持久化只写 Object.keys(result)，值全丢；而顶层那个 policyDecision 是**提案阶段**
 * 的 variant.policy_decision，抄它会得到误导性答案。修法是给 summarizeResult 加一条
 * 「只搬显式约定结构、不猜任何字段」的 summary 通道。
 *
 * 这里盯的是**判据**而不是实现：
 *   - summary 会被搬进 lastResultSummary（值可见，而不只是 keys）
 *   - 没放 summary 的 job 行为不变（向后兼容：仍退化成 keys）
 *   - 含循环引用的 summary 不能把已摘好的 scanned/counts 一起拖成 null
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// 本文件在 plugins/agint-cron/test/ 下，所以 lib/ 就在同级上一层的 lib/
const HERE = fileURLToPath(new URL('.', import.meta.url));
const CRON_LIB = join(HERE, '..', 'lib', 'index.js');

// summarizeResult 是模块内私有函数，不导出。用源码级提取把它跑起来：
// 取函数体，构造一个自包含的求值环境。这比导出只为测试更保守 —— 不改生产模块接口。
const src = readFileSync(CRON_LIB, 'utf8');
const start = src.indexOf('function summarizeResult(');
assert.ok(start > 0, '找不到 summarizeResult —— 改它之前先确认函数名没变');

const bodyStart = src.indexOf('{', start);
// 找到函数结尾：从 bodyStart 起做花括号配平
let depth = 0;
let end = -1;
for (let i = bodyStart; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') {
    depth--;
    if (depth === 0) { end = i + 1; break; }
  }
}
assert.ok(end > bodyStart, 'summarizeResult 花括号配平失败');
const fnSource = src.slice(start, end);

const SUMMARY_MAX_BYTES = 2000;
const PREVIEW_MAX = 10;
const summarizeResult = new Function(
  'SUMMARY_MAX_BYTES', 'PREVIEW_MAX', `return (${fnSource});`,
)(SUMMARY_MAX_BYTES, PREVIEW_MAX);

describe('cron summarizeResult · 约定式 summary 通道', () => {
  test('result.summary 的值被搬进 lastResultSummary，而不只是 keys', () => {
    const out = summarizeResult({
      proposalId: 'p-1',
      policyDecision: 'AUTO_DEPLOY',
      summary: { policyDecision: 'AUTO_DEPLOY', verifyMode: 'syntax:.sh', reverted: false },
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.result.policyDecision, 'AUTO_DEPLOY',
      'commit 阶段的 policyDecision 必须以值落盘，否则重启后无从查证');
    assert.equal(parsed.result.verifyMode, 'syntax:.sh');
    assert.equal(parsed.result.reverted, false);
  });

  test('没放 summary 的 job：keys 保留，顶层标量值同时带上（2026-10-04 行为变更）', () => {
    const out = summarizeResult({ alpha: 1, beta: 2 });
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.keys, ['alpha', 'beta'], 'keys 行为保留（旧读者不破）');
    assert.equal(parsed.alpha, 1, '标量值必须落盘 —— 只剩键名等于没读数');
    assert.equal(parsed.beta, 2);
    assert.equal(parsed.result, undefined, '没 summary 就不能凭空造 result 键');
  });

  test('anchor 形状：anchored/code/commit 字符串值带上，对象只进 keys', () => {
    const longX = 'x'.repeat(200);
    const out = summarizeResult({
      anchored: true, code: 'ANCHORED', row: { seq: 7 }, commit: '0e0fe65abc',
      writeback: { ok: true }, anchorFile: longX,
    });
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.keys.sort(), ['anchorFile', 'anchored', 'code', 'commit', 'row', 'writeback'].sort());
    assert.equal(parsed.anchored, true);
    assert.equal(parsed.code, 'ANCHORED');
    assert.equal(parsed.commit, '0e0fe65abc');
    assert.equal(parsed.row, undefined, '对象/数组不带值，留给约定通道');
    assert.equal(parsed.writeback, undefined);
    assert.equal(parsed.anchorFile.length, 121, '长字符串截到 120 + 省略号');
  });

  test('summary 与 report/actions 共存，互不覆盖', () => {
    const out = summarizeResult({
      report: { scanned: 7, counts: { ok: 3 } },
      actions: [{ id: 'a1', action: 'do', from: 'x', to: 'y', reason: 'r' }],
      summary: { policyDecision: 'PENDING_REVIEW' },
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.scanned, 7);
    assert.equal(parsed.actionsTotal, 1);
    assert.equal(parsed.result.policyDecision, 'PENDING_REVIEW');
  });

  test('summary 含循环引用时，不把已摘好的 report 一起拖成 null', () => {
    const cyclic = { policyDecision: 'X' };
    cyclic.self = cyclic;                       // 循环引用
    const out = summarizeResult({ report: { scanned: 4, counts: {} }, summary: cyclic });
    const parsed = JSON.parse(out);
    assert.equal(parsed.scanned, 4, 'report 是干净的，不能被 job 的坏 summary 连累');
    assert.equal(parsed.result, '[unserializable]');
  });

  test('summary 是数组或 null 时不当作摘要（保持 nothing is inferred）', () => {
    const a = JSON.parse(summarizeResult({ summary: [1, 2, 3] }));
    assert.equal(a.result, undefined, '数组不是约定的摘要对象');
    const b = JSON.parse(summarizeResult({ summary: 'text' }));
    assert.equal(b.result, undefined, '字符串同理');
  });

  test('超出 SUMMARY_MAX_BYTES 时标记 truncated，不截半个 JSON', () => {
    const huge = { policyDecision: 'AUTO_DEPLOY', blob: 'x'.repeat(SUMMARY_MAX_BYTES * 2) };
    const out = JSON.parse(summarizeResult({ summary: huge }));
    assert.equal(out.truncated, true, '超限必须整体标记，不能产出半截不可解析的 JSON');
    assert.equal(typeof out.bytes, 'number');
  });
});

// ── runNow 出口的 lastError 形状守卫（源码级，同 services-map 风格）────────
// 2026-10-04 实测：runNow 原样返回 job.lastError（{ startedAt, message } 对象），
// 工具输出 schema 声明 oneOf [string, null] ⇒ matched 0，失败原因整条被吞。
test('runNow 出口把 lastError 转成字符串后才返回（⛔ 不许原样返回对象）', () => {
  const i = src.indexOf('async runNow(');
  assert.ok(i > 0, '找不到 runNow');
  const seg = src.slice(i, i + 900);
  assert.match(seg, /err\.message \?\? String\(err\)/, 'runNow 必须做 message 转换');
  assert.doesNotMatch(seg, /lastError: job\.lastError \}/, '不许原样返回 lastError 对象');
});
