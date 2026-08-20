/**
 * eval/scenarios/driver.js — Sprint 1.3 测试驱动
 *
 * 用途：
 *   - 加载 eval/scenarios/*.scenario.json
 *   - 用 mock ctx 启动目标 plugin 的 apply(ctx, config)
 *   - 调真实 service 方法（或核心纯函数）
 *   - 与 scenario.expected 比对，输出 pass/fail
 *
 * 设计约束（来自 README §"运行机制"）：
 *   - 不依赖 dsh 启动，直接 import plugin lib
 *   - 不引入第三方依赖（用 JSON 而非 YAML 避免 yaml npm 依赖）
 *   - 优先测纯函数（compileJobs / sweep / computeMetrics），
 *     service apply() 调用走 plugin 的 lib 子模块 + mock ctx
 *
 * 运行：
 *   node eval/scenarios/driver.js
 *   node eval/scenarios/driver.js --file=agint-memory
 *
 * Sprint 1.3 状态：
 *   - mock ctx 已实现，覆盖 5 个核心 plugin
 *   - 5 个 .scenario.json（memory/rules/metrics/cron/dream）
 *   - 通过 case 数 / 失败数 写到 process exit code（CI 友好）
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Resolve dsh packages from the global install. AGINT plugins are dsh
// extensions and must not bundle their runtime; node's module resolver
// needs NODE_PATH set to the global dsh node_modules.
function ensureNodePath() {
  if (process.env.NODE_PATH && process.env.NODE_PATH.includes('dsh')) return;
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const dshNm = join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules');
    if (existsSync(dshNm)) {
      process.env.NODE_PATH = process.env.NODE_PATH
        ? `${process.env.NODE_PATH}:${dshNm}`
        : dshNm;
      // Module._initPaths() refreshes internal search list after NODE_PATH change.
      // (CJS-only hook, but works for plain require; ESM resolves via --import or
      // Module.register. We'll use a CJS shim in a child process if needed.)
    }
  } catch {
    // npm not found or failed — let the actual require/import surface the error.
  }
}
ensureNodePath();

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGINT_ROOT = resolve(__dirname, '../..');

// ─────────────────────────────────────────────────────────────
// Mock ctx — 最小 Cordis ctx，足够 5 个核心 plugin 启动
// ─────────────────────────────────────────────────────────────

export function makeMockCtx(extraProvides = {}) {
  const provides = new Map();
  const effectDisposers = [];
  const intervals = [];
  const listeners = { 'tools/pre-execute': [], 'tools/post-execute': [] };
  let id = 0;

  for (const [k, v] of Object.entries(extraProvides)) provides.set(k, v);

  const ctx = {
    effect(fn) { effectDisposers.push(fn()); },
    provide(key, value) { provides.set(key, value); },
    get(key) { return provides.get(key) ?? null; },
    on(event, fn) { (listeners[event] ??= []).push(fn); },
    setInterval(fn, ms) {
      const handle = { fn, ms, dispose: () => {} };
      intervals.push(handle);
      return handle;
    },
    storageDomain: makeMockStorageDomain(),
    _state: { effectDisposers, intervals, listeners },
  };
  return ctx;
}

// In-memory storage domain — 满足 plugin 启动路径，不写磁盘。
export function makeMockStorageDomain() {
  const tables = new Map(); // tableName → Map<id, value>

  return {
    async open(spec) {
      const domain = {
        name: spec.name,
        version: spec.version,
        table(name) {
          let t = tables.get(name);
          if (!t) { t = new Map(); tables.set(name, t); }
          return {
            get: (id) => t.get(id) ?? null,
            put: async (id, value) => { t.set(id, value); return true; },
            delete: async (id) => t.delete(id),
            entries: () => [...t.entries()],
          };
        },
        async close() {},
      };
      return domain;
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Scenario runner
// ─────────────────────────────────────────────────────────────

const results = [];

export function recordResult(name, ok, detail) {
  results.push({ name, ok, detail });
  const status = ok ? '✓ PASS' : '✗ FAIL';
  console.log(`${status}  ${name}${detail ? ` — ${detail}` : ''}`);
}

export function deepEqualSubset(actual, expected) {
  if (expected === null || expected === undefined) return actual === expected;
  if (typeof expected !== 'object') return actual === expected;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    if (actual.length !== expected.length) return false;
    return expected.every((e, i) => deepEqualSubset(actual[i], e));
  }
  for (const [k, v] of Object.entries(expected)) {
    if (!deepEqualSubset(actual?.[k], v)) return false;
  }
  return true;
}

// Plugin-specific scenario dispatchers.
// Each takes (scenario, mockCtx) → { ok, detail }

const dispatchers = {
  'agint-memory': async (scenario, ctx) => {
    const mod = await import(`${AGINT_ROOT}/plugins/agint-memory/lib/index.js`);
    mod.apply(ctx, {});
    const memory = ctx.get('agint.memory');
    const input = scenario.input[0].args;
    const written = await memory.write(input);
    const read = await memory.read(written.id);
    const match = read && read.content === input.content && read.type === input.type;
    return { ok: !!match, detail: `id=${written.id} content_match=${!!match}` };
  },

  'agint-rules': async (scenario, ctx) => {
    const mod = await import(`${AGINT_ROOT}/plugins/agint-rules/lib/index.js`);
    mod.apply(ctx, {});
    const rules = ctx.get('agint.rules');
    await rules.seedIfEmpty();
    const input = scenario.input[0].args;
    const check = await rules.check(input.tool, input.args);
    const exp = scenario.expected[0];
    if (exp.action === 'deny') {
      const top = check.deny[0];
      const ok = check.deny.length >= 1 && top.ruleId === exp.ruleId;
      return { ok, detail: `deny[0]=${top?.ruleId} expected=${exp.ruleId}` };
    }
    return { ok: false, detail: `unsupported expected action ${exp.action}` };
  },

  'agint-metrics': async (scenario, ctx) => {
    // metrics service apply() 需要 storageDomain；测 computeMetrics 纯函数即可。
    const { computeMetrics } = await import(`${AGINT_ROOT}/plugins/agint-metrics/lib/metrics.js`);
    const input = scenario.input[0].args;
    // JSON 不能直接传函数；支持 _fn + _returns 这种"伪函数"约定。
    const sources = {};
    for (const [k, v] of Object.entries(input.sources ?? {})) {
      if (v && typeof v === 'object' && v._fn) {
        sources[k] = { [v._fn]: () => v._returns };
      } else {
        sources[k] = v;
      }
    }
    const records = await computeMetrics(sources);
    const exp = scenario.expected[0];
    if (exp.kind === 'no-sources-returns-empty') {
      return { ok: records.length === 0, detail: `records.length=${records.length}` };
    }
    if (exp.kind === 'cron-source-yields-cron-metrics') {
      const cronKeys = records.filter((r) => r.key.startsWith('cron.')).map((r) => r.key);
      const want = exp.expectedKeys;
      const ok = want.every((k) => cronKeys.includes(k));
      return { ok, detail: `cron_keys=${cronKeys.join(',')}` };
    }
    return { ok: false, detail: `unsupported expected.kind ${exp.kind}` };
  },

  'agint-cron': async (scenario, ctx) => {
    const { parseCron, nextFire } = await import(`${AGINT_ROOT}/plugins/agint-cron/lib/cron.js`);
    const { defaultJobs } = await import(`${AGINT_ROOT}/plugins/agint-cron/lib/jobs.js`);
    const input = scenario.input[0].args;
    const exp = scenario.expected[0];

    if (exp.kind === 'parse-then-nextFire' || exp.kind === 'parse-then-nextFire-dynamic') {
      const parsed = parseCron(input.expr);
      const next = nextFire(parsed, new Date(input.from));
      // For dynamic mode, assert properties instead of hardcoded ISO:
      // - dow=0 (Sunday) and time 04:30 local
      // For static mode, compare ISO minute.
      if (exp.kind === 'parse-then-nextFire-dynamic') {
        const ok = next.getDay() === 0 && next.getHours() === 4 && next.getMinutes() === 30;
        return { ok, detail: `next=${next.toString().slice(0, 24)} day=${next.getDay()} hh=${next.getHours()} mm=${next.getMinutes()}` };
      }
      const got = next.toISOString().slice(0, 16); // yyyy-mm-ddThh:mm
      const ok = got === exp.expectedIso;
      return { ok, detail: `expr=${input.expr} → ${got} expected ${exp.expectedIso}` };
    }
    if (exp.kind === 'default-jobs-registered') {
      const ids = defaultJobs.map((j) => j.id).sort();
      const ok = JSON.stringify(ids) === JSON.stringify(exp.expectedIds.sort());
      return { ok, detail: `ids=${ids.join(',')}` };
    }
    return { ok: false, detail: `unsupported expected.kind ${exp.kind}` };
  },

  'agint-dream': async (scenario, ctx) => {
    const { gateCandidates } = await import(`${AGINT_ROOT}/plugins/agint-dream/lib/sweep.js`);
    const input = scenario.input[0].args;
    const exp = scenario.expected[0];

    if (exp.kind === 'gate-thresholds') {
      const gated = gateCandidates(input.candidates, input.existing ?? [], {
        minScore: input.minScore ?? 0.75,
        minRecall: input.minRecall ?? 3,
        minUniqueSessions: input.minUniqueSessions ?? 2,
      });
      const gotTexts = gated.map((c) => c.text).sort();
      const wantTexts = exp.expectedTexts.sort();
      const ok = JSON.stringify(gotTexts) === JSON.stringify(wantTexts);
      return { ok, detail: `gated=${gotTexts.length}/${input.candidates.length}` };
    }
    return { ok: false, detail: `unsupported expected.kind ${exp.kind}` };
  },
};

// ─────────────────────────────────────────────────────────────
// Loader + main
// ─────────────────────────────────────────────────────────────

async function loadScenarios(filterFile) {
  const dir = join(__dirname);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.scenario.json'));
  const out = [];
  for (const f of files) {
    if (filterFile && !f.startsWith(filterFile)) continue;
    const text = await readFile(join(dir, f), 'utf8');
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) out.push({ file: f, scenario: item });
  }
  return out;
}

export async function runScenario(entry) {
  const dispatch = dispatchers[entry.scenario.plugin];
  if (!dispatch) {
    recordResult(entry.scenario.scenario, false, `no dispatcher for ${entry.scenario.plugin}`);
    return;
  }
  const ctx = makeMockCtx();
  try {
    const { ok, detail } = await dispatch(entry.scenario, ctx);
    recordResult(entry.scenario.scenario, ok, detail);
  } catch (error) {
    recordResult(entry.scenario.scenario, false, `threw: ${error.message}`);
  }
}

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--file='));
  const filterFile = arg ? arg.slice('--file='.length) : null;
  const scenarios = await loadScenarios(filterFile);
  if (scenarios.length === 0) {
    console.error('no scenarios found');
    process.exit(1);
  }
  for (const s of scenarios) await runScenario(s);

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n=== ${pass} passed, ${fail} failed (of ${results.length}) ===`);
  process.exit(fail === 0 ? 0 : 1);
}

// Run when invoked directly (not when imported).
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main();
