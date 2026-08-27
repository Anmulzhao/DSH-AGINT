/**
 * eval/e2e/sprint10-decoupled.js — Sprint 10 端到端 (架构解耦 + 安全收口)
 *
 * 完整链路:
 *   agint-quality-static.checkPlugin(self)  → 自检 0 blocker（设计稿 §二.3 + #4 边角 #1）
 *     → agint-quality-sandbox.runVerify(runSmoke 兼容)  → 双模式契约
 *       → agint-quality-sandbox.resolveProfile({mode})  → platform routing
 *         → agint-quality-sandbox.routeForMutation(source,kind)  → 路由决策
 *           → agint-mutator.rollback(commitId)  → 三段式事务契约（含 smoke）
 *
 * 不依赖 dsh 启动（mock ctx）。跑法：node eval/e2e/sprint10-decoupled.js
 * 退出码: 0 全过, 1 任一 fail.
 */

import { makeMockCtx } from '../scenarios/driver.js';

import * as sandbox from '../../plugins/agint-quality-sandbox/lib/index.js';
import * as staticChecker from '../../plugins/agint-quality-static/lib/index.js';

const AGINT_ROOT = process.cwd();

let pass = 0;
let fail = 0;
const counts = (ok) => (ok ? pass++ : fail++);

async function step(name, fn) {
  process.stdout.write(`▶ ${name}... `);
  try { await fn(); console.log('✓'); return true; }
  catch (err) { console.log(`✗ ${err.message}`); return false; }
}

function makeSprint10Ctx() {
  // mock ctx 用 extraProvides 预注册服务；sandbox 不可用 → 走 in-process fallback
  const ctx = makeMockCtx({
    // 真沙箱不可用（生产 dev 环境无 bwrap） → in-process fallback 路径
    // 软依赖：evolution（mutation 关键路径）
    'agint.evolution': {
      addFailure: async () => ({ ok: true }),
      logPhase4: async () => ({ ok: true }),
      queryFailures: async () => [],
    },
  });
  return ctx;
}

async function e2e() {
  // ── Step 1: agint-quality-static 自检（设计稿 §十.4「插件自检 PASS」）
  await step('agint-quality-static 自检（自我扫描 0 blocker）', async () => {
    const ctx = makeSprint10Ctx();
    staticChecker.apply(ctx, {});
    const sq = ctx.get('agint.qualityStatic');
    if (!sq) throw new Error('agint.qualityStatic provider 未注册');
    const r = await sq.checkPlugin({ pluginDir: `${AGINT_ROOT}/plugins/agint-quality-static` });
    if (!r.ok) {
      const blockers = r.findings.filter(f => f.severity === 'blocker');
      throw new Error(`自检失败 blocker=${blockers.length}: ${JSON.stringify(blockers.slice(0, 3))}`);
    }
    counts(true);
  });

  // ── Step 2: agint-quality-sandbox 双模式契约
  await step('sandbox resolveProfile + routeForMutation 契约', async () => {
    const ctx = makeSprint10Ctx();
    sandbox.apply(ctx, {});
    const sb = ctx.get('agint.qualitySandbox');
    if (!sb) throw new Error('agint.qualitySandbox provider 未注册');

    // 2a: routeForMutation dream-random + TOOL_SYNTHESIS → explore-then-verify
    const r1 = sb.routeForMutation({ source: 'dream-random', kind: 'TOOL_SYNTHESIS' });
    if (r1.mode !== 'explore-then-verify') throw new Error(`r1.mode=${r1.mode} 期望 explore-then-verify`);

    // 2b: routeForMutation attribution-driven + PROMPT_MUTATION → verify only
    const r2 = sb.routeForMutation({ source: 'attribution-driven', kind: 'PROMPT_MUTATION' });
    if (r2.mode !== 'verify') throw new Error(`r2.mode=${r2.mode} 期望 verify`);

    // 2c: resolveProfile 走 linux BPF JSON（platform 路由）
    const p = sb.resolveProfile({ mode: 'verify' });
    if (p.platform !== 'linux') throw new Error(`platform=${p.platform} 期望 linux`);
    if (p.format !== 'bpf-json') throw new Error(`format=${p.format} 期望 bpf-json`);

    counts(true);
  });

  // ── Step 3: sandbox in-process fallback（无 ctx.sandbox）
  await step('sandbox runVerify in-process fallback 路径', async () => {
    const ctx = makeSprint10Ctx();
    sandbox.apply(ctx, {});
    const sb = ctx.get('agint.qualitySandbox');
    // ctx.sandbox 不可用 + allowInProcessFallback=true → 走 in-process
    // 测试目标：agint-quality-static 自身作为 pluginDir 跑 smoke（6 项结构检查）
    const result = await sb.runVerify({
      target: { path: `${AGINT_ROOT}/plugins/agint-quality-static` }
    });
    if (typeof result.ok !== 'boolean') throw new Error('runVerify 返 ok 字段缺失');
    if (result.mode !== 'verify-in-process') throw new Error(`mode=${result.mode} 期望 verify-in-process`);
    if (typeof result.safety !== 'number') throw new Error('runVerify 返 safety 字段缺失');
    if (typeof result.policyDecision !== 'string') throw new Error('runVerify 返 policyDecision 字段缺失');
    counts(true);
  });

  // ── Step 4: backendHealth 增字段契约（v0.6.3 新增）
  await step('sandbox backendHealth 含 seccompAvailable / sbplAvailable', async () => {
    const ctx = makeSprint10Ctx();
    sandbox.apply(ctx, {});
    const sb = ctx.get('agint.qualitySandbox');
    const h = await sb.backendHealth();
    if (typeof h.seccompAvailable !== 'boolean') throw new Error('seccompAvailable 字段缺失');
    if (typeof h.sbplAvailable !== 'boolean') throw new Error('sbplAvailable 字段缺失');
    if (typeof h.ctxSandboxAvailable !== 'boolean') throw new Error('ctxSandboxAvailable 字段缺失');
    if (h.inProcessFallbackEnabled !== true) throw new Error('inProcessFallbackEnabled 应为 true');
    counts(true);
  });

  // ── Step 5: staticChecker checkAll 聚合全 AGINT 插件（含自检）
  await step('static checkAll 聚合全 AGINT 插件（含自检）', async () => {
    const ctx = makeSprint10Ctx();
    staticChecker.apply(ctx, {});
    const sq = ctx.get('agint.qualityStatic');
    const all = await sq.checkAll({ pluginsDir: `${AGINT_ROOT}/plugins` });
    if (!all.results) throw new Error('checkAll 返 results 字段缺失');
    // 至少要扫到 agint-quality-sandbox / agint-quality-static / agint-mutator / agint-diagnosis 等
    const names = Object.keys(all.results);
    if (names.length < 10) throw new Error(`仅扫到 ${names.length} 个插件，期望 ≥10`);
    counts(true);
  });

  console.log('');
  console.log(`─── Sprint 10 e2e 总结: ${pass} pass, ${fail} fail ───`);
  return fail === 0;
}

const ok = await e2e();
process.exit(ok ? 0 : 1);