#!/usr/bin/env node
/**
 * eval/run-diagnosis-eval.mjs — Sprint 7 子任务 #6 eval runner
 *
 * 读取 eval/scenarios/agint-diagnosis.scenario.json，按 scenario 顺序跑：
 *   - action=classify  → 直接调 plugins/agint-diagnosis/lib/root-cause-classifier.js
 *   - action=serviceCall → mock ctx 启动 lib/index.js，调真 annotate service
 *
 * 比对 scenario.expected，输出每条 PASS/FAIL + 汇总。
 * 退出码：0 = 全 PASS，1 = 有 FAIL（CI 友好）。
 *
 * 用法：
 *   node eval/run-diagnosis-eval.mjs
 *
 * 设计：单一文件，不引第三方依赖，纯 node 内置（readFile + dynamic import）。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGINT_ROOT = resolve(__dirname, '..');
const SCENARIO_FILE = join(__dirname, 'scenarios', 'agint-diagnosis.scenario.json');

// ── 加载 scenario JSON ───────────────────────────────────────────────────

const raw = await readFile(SCENARIO_FILE, 'utf8');
const scenarios = JSON.parse(raw);
if (!Array.isArray(scenarios) || scenarios.length < 10) {
  console.error(`[FAIL] scenario.json 必须是 ≥10 个场景的数组，实得 ${scenarios?.length}`);
  process.exit(1);
}

// ── 加载真实 lib（动态 import — ESM） ────────────────────────────────────

const { classify } = await import(`${AGINT_ROOT}/plugins/agint-diagnosis/lib/root-cause-classifier.js`);
const pluginMod = await import(`${AGINT_ROOT}/plugins/agint-diagnosis/lib/index.js`);

// ── mock ctx 工厂（annotate service 测试用） ──────────────────────────────

function makeFakeCtx({ failurePatternCount = 0, annotationsCount = 0 } = {}) {
  const services = {};
  const annotationEntries = Array.from({ length: annotationsCount }, (_, i) => ({
    id: `pre-${i}`,
    kind: 'annotation',
    failureId: `f-pre-${i}`,
    rootCause: 'TOOL_GAP',
    confidence: 0.5,
    evidence: '{}',
    createdAt: '2026-08-24T00:00:00.000Z',
  }));
  return {
    services,
    ctx: {
      storageDomain: {
        open: async () => ({
          table: (name) => ({
            entries: () => (name === 'annotations' ? annotationEntries : []),
            put: async () => undefined,
          }),
          close: async () => undefined,
        }),
      },
      get: (name) => {
        if (name === 'agint.evolution') {
          return {
            queryFailures: async () => Array.from({ length: failurePatternCount }, (_, i) => ({
              id: `seed-${i}`,
              pattern: `seed pattern ${i}`,
              evidence: '',
              severity: 'medium',
              category: 'other',
              occurrences: 1,
            })),
          };
        }
        return null;
      },
      provide(name, fn) { services[name] = fn; },
      effect() { return () => undefined; },
    },
  };
}

// ── 比对 helpers ─────────────────────────────────────────────────────────

function eqRootCause(actual, exp) {
  return actual.rootCause === exp.rootCause;
}

function assertClassify(result, exp) {
  const fails = [];
  if (result.rootCause !== exp.rootCause) {
    fails.push(`rootCause=${result.rootCause} expected=${exp.rootCause}`);
  }
  if (typeof exp.minFeatures === 'number') {
    const feats = result.evidence?.matchedFeatures ?? [];
    if (exp.minFeatures === 0) {
      if (feats.length !== 0) fails.push(`matchedFeatures.length=${feats.length} expected=0`);
    } else if (feats.length < exp.minFeatures) {
      fails.push(`matchedFeatures.length=${feats.length} < ${exp.minFeatures}`);
    }
  }
  if (typeof exp.confidence === 'number' && result.confidence !== exp.confidence) {
    fails.push(`confidence=${result.confidence} expected=${exp.confidence}`);
  }
  return fails;
}

function assertTied(result, exp) {
  const fails = [];
  if (result.rootCause !== exp.rootCause) {
    fails.push(`rootCause=${result.rootCause} expected=${exp.rootCause}`);
  }
  const tied = result.evidence?.tied ?? [];
  const wantTied = Array.isArray(exp.tied) ? [...exp.tied].sort() : [];
  const gotTied = [...tied].sort();
  if (JSON.stringify(gotTied) !== JSON.stringify(wantTied)) {
    fails.push(`tied=${JSON.stringify(gotTied)} expected=${JSON.stringify(wantTied)}`);
  }
  if (exp.noteContains && !(result.evidence?.note ?? '').includes(exp.noteContains)) {
    fails.push(`evidence.note missing '${exp.noteContains}'`);
  }
  return fails;
}

// ── 单 scenario 执行 ─────────────────────────────────────────────────────

async function runOne(scenario) {
  const input = scenario.input[0];
  const args = input.args ?? {};
  const exp = scenario.expected[0];

  // ── 路径 A：纯函数 classify ──
  if (input.action === 'classify') {
    const result = classify(args.trajectory ?? []);
    if (exp.kind === 'rootCause') {
      const fails = assertClassify(result, exp);
      return { ok: fails.length === 0, detail: fails.join('; ') || `rootCause=${result.rootCause}` };
    }
    if (exp.kind === 'rootCauseTied') {
      const fails = assertTied(result, exp);
      return { ok: fails.length === 0, detail: fails.join('; ') || `rootCause=${result.rootCause} tied=${JSON.stringify(result.evidence?.tied)}` };
    }
    return { ok: false, detail: `unsupported expected.kind=${exp.kind} for classify path` };
  }

  // ── 路径 B：真 service annotate（mock ctx） ──
  if (input.action === 'serviceCall') {
    const { ctx, services } = makeFakeCtx({
      failurePatternCount: args.failurePatternCount ?? 0,
      annotationsCount: args.annotationsCount ?? 0,
    });
    pluginMod.apply(ctx);
    const annotate = services['agint.diagnosis.annotate'];
    if (typeof annotate !== 'function') {
      return { ok: false, detail: 'annotate service 未注册' };
    }
    try {
      const result = await annotate({ failureId: args.failureId, trajectory: args.trajectory ?? [] });
      // 不期望成功——如果走到了这里说明没抛错，对 throws case 是 FAIL
      return { ok: false, detail: `未抛错，反而返回 rootCause=${result.rootCause}` };
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      if (exp.kind === 'throws' && exp.errorContains && msg.includes(exp.errorContains)) {
        return { ok: true, detail: `threw msg="${msg.slice(0, 80)}"` };
      }
      return { ok: false, detail: `threw msg="${msg.slice(0, 80)}" but expected errorContains='${exp.errorContains}'` };
    }
  }

  return { ok: false, detail: `unsupported action=${input.action}` };
}

// ── 主循环 ────────────────────────────────────────────────────────────────

const results = [];
console.log(`\n[agint-diagnosis eval] ${scenarios.length} scenarios\n`);
for (const sc of scenarios) {
  const { ok, detail } = await runOne(sc);
  const status = ok ? '✓ PASS' : '✗ FAIL';
  console.log(`${status}  ${sc.scenario.padEnd(45)} — ${detail}`);
  results.push({ name: sc.scenario, ok });
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n[summary] ${passed}/${results.length} PASS${failed > 0 ? `, ${failed} FAIL` : ''}`);

process.exit(failed === 0 ? 0 : 1);