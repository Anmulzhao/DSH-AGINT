/**
 * test/deploy-budget.test.mjs — Sprint 13 §3.3 weekly hook 部署预算护栏
 *
 * 覆盖（设计稿 §3.3 + 遗留 TODO T2 + 风险 R1 幂等前置）：
 *   1) isAutoDeployEntry 三种 audit 形态识别（tags / decision / scores.policyKind）
 *   2) countAutoDeploys 滚动 7 天窗口过滤（窗口外的不计）
 *   3) countAutoDeploys 软降级（evolution 不可用 → degraded 而非抛错）
 *   4) checkDeployBudget 未超预算 → forcedDecision=null + 状态行
 *   5) checkDeployBudget 超预算 → forcedDecision=PENDING_REVIEW + 告警行 + audit 写
 *   6) 幂等（R1）：重复调用不累加计数、不产生重复决策
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Windows 上 ESM 动态 import 必须走 file:// URL（裸绝对路径会抛
// ERR_UNSUPPORTED_ESM_URL_SCHEME）；用 pathToFileURL 保持跨平台上可跑。
const modUrl = (p) => pathToFileURL(resolve(__dirname, p)).href;
const {
  isAutoDeployEntry,
  countAutoDeploys,
  checkDeployBudget,
  DEFAULT_DEPLOY_BUDGET,
  DEFAULT_WINDOW_DAYS,
} = await import(modUrl('../lib/deployBudget.js'));

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-03T12:00:00.000Z');

function makeEvolution(entries, failures = []) {
  return {
    async getLogRange({ fromDate, toDate }) {
      const from = Date.parse(fromDate);
      const to = Date.parse(toDate);
      return entries.filter((e) => {
        const ts = Date.parse(e.ts);
        return ts >= from && ts <= to;
      });
    },
    async addFailure(rec) { failures.push(rec); return { id: `f${failures.length}`, ...rec }; },
  };
}

function makeCtx({ entries = [], memoryFails = false } = {}) {
  const memoryWrites = [];
  const failures = [];
  const evolution = makeEvolution(entries, failures);
  return {
    memoryWrites,
    failures,
    ctx: {
      get(key) {
        if (key === 'agint.evolution') return evolution;
        if (key === 'agint.memory') {
          return {
            async write(rec) {
              if (memoryFails) throw new Error('memory down');
              memoryWrites.push(rec);
              return { id: `m${memoryWrites.length}`, ...rec };
            },
          };
        }
        return null;
      },
    },
  };
}

function deployEntry(offsetDays, kind = 'AUTO_DEPLOY') {
  return {
    id: `e-${offsetDays}-${kind}`,
    targetId: `policy-batch-2026-09-0${Math.abs(offsetDays) || 1}`,
    decision: kind,
    scores: { policyKind: kind, policyScore: 88 },
    tags: ['policy-decision', `decision:${kind}`],
    ts: new Date(NOW - offsetDays * DAY_MS).toISOString(),
  };
}

// ─── 1) audit 形态识别 ───────────────────────────────────────────
test('isAutoDeployEntry: recognizes all three policy audit shapes', () => {
  assert.equal(isAutoDeployEntry({ decision: 'AUTO_DEPLOY' }), true, 'decision field');
  assert.equal(isAutoDeployEntry({ scores: { policyKind: 'AUTO_DEPLOY' } }), true, 'scores.policyKind');
  assert.equal(isAutoDeployEntry({ tags: ['policy-decision', 'decision:AUTO_DEPLOY'] }), true, 'tags');
  assert.equal(isAutoDeployEntry({ decision: 'PENDING_REVIEW' }), false, 'PENDING_REVIEW must not count');
  assert.equal(isAutoDeployEntry(null), false, 'null safe');
});

// ─── 2) 滚动窗口过滤 ─────────────────────────────────────────────
test('countAutoDeploys: rolling 7d window excludes older deploys', async () => {
  const entries = [
    deployEntry(0), deployEntry(1), deployEntry(2), deployEntry(3), // 4 within window
    deployEntry(9), deployEntry(20),                                 // 2 outside window
    deployEntry(1, 'PENDING_REVIEW'),                                // wrong kind
  ];
  const r = await countAutoDeploys({
    evolution: makeEvolution(entries),
    windowDays: 7,
    nowMs: NOW,
  });
  assert.equal(r.count, 4, `expected 4 in-window AUTO_DEPLOY, got ${r.count}`);
  assert.equal(r.windowDays, 7);
  assert.equal(r.degraded, null);
});

// ─── 3) 软降级 ───────────────────────────────────────────────────
test('countAutoDeploys: degrades (not throws) when evolution unavailable', async () => {
  const r = await countAutoDeploys({ evolution: null, nowMs: NOW });
  assert.equal(r.count, 0);
  assert.match(r.degraded, /getLogRange unavailable/);
});

test('countAutoDeploys: degrades when getLogRange throws', async () => {
  const r = await countAutoDeploys({
    evolution: { async getLogRange() { throw new Error('boom'); } },
    nowMs: NOW,
  });
  assert.equal(r.count, 0);
  assert.match(r.degraded, /boom/);
});

// ─── 4) 未超预算 ─────────────────────────────────────────────────
test('checkDeployBudget: under budget → forcedDecision null, no audit side effects', async () => {
  const { ctx, memoryWrites, failures } = makeCtx({
    entries: [deployEntry(1), deployEntry(2)],
  });
  const r = await checkDeployBudget({ ctx, nowMs: NOW });
  assert.equal(r.used, 2);
  assert.equal(r.budget, DEFAULT_DEPLOY_BUDGET);
  assert.equal(r.exceeded, false);
  assert.equal(r.forcedDecision, null);
  assert.equal(r.remaining, 1);
  assert.equal(memoryWrites.length, 0, 'no audit write when under budget');
  assert.equal(failures.length, 0);
  assert.match(r.reviewLine, /部署预算：/);
  assert.doesNotMatch(r.reviewLine, /⚠️/);
});

// ─── 5) 超预算 ───────────────────────────────────────────────────
test('checkDeployBudget: over budget → force PENDING_REVIEW + audit + failure_pattern', async () => {
  const { ctx, memoryWrites, failures } = makeCtx({
    entries: [deployEntry(0), deployEntry(1), deployEntry(2), deployEntry(3), deployEntry(4)],
  });
  const r = await checkDeployBudget({ ctx, nowMs: NOW });
  assert.equal(r.used, 5);
  assert.equal(r.exceeded, true);
  assert.equal(r.forcedDecision, 'PENDING_REVIEW');
  assert.equal(r.remaining, 0);
  assert.equal(r.auditWritten, true);
  assert.equal(r.failureLogged, true);
  assert.equal(memoryWrites.length, 1);
  assert.match(memoryWrites[0].content, /deploy-budget/);
  assert.match(failures[0].pattern, /deploy-budget-exceeded/);
  assert.match(r.reviewLine, /⚠️ 部署预算超支/);
});

// ─── 6) 幂等（R1 / T2-b 硬前置）──────────────────────────────────
test('checkDeployBudget: idempotent — repeated calls do not accumulate count', async () => {
  const { ctx } = makeCtx({ entries: [deployEntry(1), deployEntry(2), deployEntry(3), deployEntry(4)] });
  const a = await checkDeployBudget({ ctx, nowMs: NOW });
  const b = await checkDeployBudget({ ctx, nowMs: NOW });
  const c = await checkDeployBudget({ ctx, nowMs: NOW });
  assert.equal(a.used, 4);
  assert.equal(b.used, 4, 'second call must not count extra deploys');
  assert.equal(c.used, 4, 'third call must not count extra deploys');
  assert.equal(a.forcedDecision, b.forcedDecision);
  assert.equal(a.forcedDecision, 'PENDING_REVIEW');
});

test('checkDeployBudget: writeAudit=false is pure computation (no side effects)', async () => {
  const { ctx, memoryWrites, failures } = makeCtx({
    entries: [deployEntry(0), deployEntry(1), deployEntry(2), deployEntry(3)],
  });
  const r = await checkDeployBudget({ ctx, nowMs: NOW, writeAudit: false });
  assert.equal(r.exceeded, true);
  assert.equal(r.forcedDecision, 'PENDING_REVIEW');
  assert.equal(memoryWrites.length, 0);
  assert.equal(failures.length, 0);
});

test('checkDeployBudget: audit write failure does not break the guard result', async () => {
  const { ctx } = makeCtx({
    entries: [deployEntry(0), deployEntry(1), deployEntry(2), deployEntry(3)],
    memoryFails: true,
  });
  const r = await checkDeployBudget({ ctx, nowMs: NOW });
  assert.equal(r.exceeded, true);
  assert.equal(r.forcedDecision, 'PENDING_REVIEW');
  assert.equal(r.auditWritten, false, 'audit failure must be visible, not silent');
});

test('checkDeployBudget: custom budget/window honored', async () => {
  const { ctx } = makeCtx({ entries: [deployEntry(1), deployEntry(2)] });
  const r = await checkDeployBudget({ ctx, nowMs: NOW, budget: 1, windowDays: 3 });
  assert.equal(r.budget, 1);
  assert.equal(r.windowDays, 3);
  assert.equal(r.used, 2);
  assert.equal(r.exceeded, true);
});

test('defaults match AGENTS.md guardrail (3 deploys / rolling 7 days)', () => {
  assert.equal(DEFAULT_DEPLOY_BUDGET, 3);
  assert.equal(DEFAULT_WINDOW_DAYS, 7);
});
