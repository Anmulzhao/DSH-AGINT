/**
 * test/effective-delta-veto.test.mjs — D-QAF §5.3 效率护栏在**决策侧**真的咬得住
 * （2026-10-26，D2 收口）
 *
 * 为什么单独一个文件：`effectiveDelta.js` 的判定逻辑已经有 12 条单测，
 * 但「判定出来之后有没有人拦」是**另一件事** —— 本仓栽过太多次
 * 「字段落了 / 逻辑对了，主路径没接」。所以这里直接调 `decidePolicy`：
 *
 *   同一组**肯定能 AUTO_DEPLOY** 的评估结果（综合分 ≥ 90），只改 options.effectiveDelta，
 *   看 master 决策会不会被降级。
 *
 * 四条 + 一条阴性对照：
 *   1) 不传 effectiveDelta ⇒ 仍然 AUTO_DEPLOY（向后兼容，不许误伤存量调用）
 *   2) verdict='ineffective' ⇒ AUTO_DEPLOY 降为 PENDING_REVIEW + triggeredBy 留痕
 *   3) ⛔ 阴性对照：verdict='effective' ⇒ 仍 AUTO_DEPLOY（护栏不是「一律降级」）
 *   4) verdict='unknown' ⇒ 不降级，但必须留痕（护栏未生效要看得见，不是「没报错=通过」）
 *
 * Run: node --test plugins/agint-quality/agint-quality-policy/test/effective-delta-veto.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DECIDE_PATH = pathToFileURL(resolve(__dirname, '../lib/decide.js')).href;
const { decidePolicy } = await import(DECIDE_PATH);

/** 综合分 ~90 的单 target 结果：任何阈值下都该 AUTO_DEPLOY。 */
function makeStrongResults() {
  return [{
    targetId: 'plugin-x',
    kind: 'plugin',
    dimensions: [
      { key: 'safety', score: { score: 0.95, veto: false } },
      { key: 'trust', score: { score: 0.85, veto: false } },
    ],
  }];
}

const hasTag = (d, prefix) => (d.triggeredBy ?? []).some((t) => String(t).startsWith(prefix));

test('基线：不传 effectiveDelta ⇒ AUTO_DEPLOY（存量调用不受影响）', async () => {
  const d = await decidePolicy({ results: makeStrongResults() });
  assert.equal(d.kind, 'AUTO_DEPLOY');
  assert.equal(hasTag(d, 'effective-delta'), false, '没传就不该编一条证据出来');
});

test('⛔ verdict=ineffective ⇒ AUTO_DEPLOY 降为 PENDING_REVIEW（拒绝自动部署）', async () => {
  const d = await decidePolicy({
    results: makeStrongResults(),
    options: { effectiveDelta: { verdict: 'ineffective', reason: 'ok', value: -0.02, shouldBlockDeploy: true } },
  });
  assert.equal(d.kind, 'PENDING_REVIEW', '宪法 §5.3：≤0 即使 HARM 提升也拒绝部署');
  assert.ok(hasTag(d, 'effective-delta-ineffective:'), `triggeredBy=${JSON.stringify(d.triggeredBy)}`);
});

test('⛔ 阴性对照：verdict=effective ⇒ 仍然 AUTO_DEPLOY（护栏不是一律降级）', async () => {
  const d = await decidePolicy({
    results: makeStrongResults(),
    options: { effectiveDelta: { verdict: 'effective', reason: 'ok', value: 0.5, shouldBlockDeploy: false } },
  });
  assert.equal(d.kind, 'AUTO_DEPLOY');
  assert.ok(hasTag(d, 'effective-delta-effective:'));
});

test('verdict=unknown ⇒ 不降级，但必须留痕（护栏未生效可见）', async () => {
  const d = await decidePolicy({
    results: makeStrongResults(),
    options: { effectiveDelta: { verdict: 'unknown', reason: 'token-unmeasured', value: null } },
  });
  assert.equal(d.kind, 'AUTO_DEPLOY', 'unknown 不是「无效」，不该冒充拦部署');
  assert.ok(hasTag(d, 'effective-delta-unmeasured:'), '但必须留下「这次护栏没跑」的证据');
});

test('⛔ 对照：ineffective 也不能把已经 PENDING/REJECT 的决策弄得更松', async () => {
  // 低分结果（综合分 < 60）→ REJECT；效率护栏只在 AUTO_DEPLOY 上封顶，不得改写 REJECT
  const weak = [{
    targetId: 'plugin-y',
    kind: 'plugin',
    dimensions: [
      { key: 'safety', score: { score: 0.95, veto: false } },
      { key: 'trust', score: { score: 0.2, veto: false } },
    ],
  }];
  const d = await decidePolicy({
    results: weak,
    options: { effectiveDelta: { verdict: 'ineffective', reason: 'ok', value: -1 } },
  });
  assert.equal(d.kind, 'REJECT');
});
