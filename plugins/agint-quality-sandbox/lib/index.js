/**
 * agint-quality-sandbox v0.6.3 — Sprint 10 架构解耦版
 *
 * 本文件**新增**部分（v0.6.3）：
 *   1. runVerify({ target, opts }) → VerifyRunResult
 *      verify 模式（严格约束）：timeout 30s / mem 512MB / 网络全隔离
 *   2. runExplore({ target, opts }) → ExploreRunResult
 *      explore 模式（激进探索）：timeout 60s / mem 1GB / 网络全隔离 + 放宽 syscall
 *   3. resolveProfile({ mode }) → ResolvedProfile
 *      平台路由：linux → seccomp BPF JSON / darwin → sandbox-exec SBPL / win32 → unsupported
 *   4. backendHealth() 增字段：seccompAvailable / sbplAvailable
 *   5. routeForMutation({ source, kind }) → 路由决策
 *      dream-random OR TOOL_SYNTHESIS → explore-then-verify；其他 → verify
 *
 * 本文件**保留**原 v0.3.0 全部行为：
 *   - runSmoke({ target, opts }) → SandboxRunResult（向后兼容）
 *   - 桥接 ctx.sandbox.confine() 拿 wrapping argv
 *   - 失败写 agint.evolution（addFailure）
 *
 * L0-frozen 保护（设计稿 §七 + §不做事）：
 *   - 不引用 quality-contract FROZEN 接口（详 CHANGELOG §L0-frozen）
 *   - 不修改 runSmoke 签名（向后兼容 v0.3 eval）
 *   - 不引入新的中心化服务（resolveProfile 仅平台路由）
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { runSmoke as runSmokeInProcess } from './smoke.js';
import { resolveProfile as resolveProfileImpl, probeSyscallCapability } from './profile-resolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const name = 'agint-quality-sandbox';
const inject = ['sandbox', 'agint.evolution'];

const Config = z.object({
  timeoutMs: z.number().int().positive().default(30_000),
  memoryMb: z.number().int().positive().default(512),
  allowInProcessFallback: z.boolean().default(true),
}).optional();

// v0.6.3 双模式资源矩阵（设计稿 §二.2）
const MODE_PRESETS = {
  verify:  { timeoutMs: 30_000, memoryMb: 512,  failureSafety: 0.0, policyDecision: 'REJECT' },
  explore: { timeoutMs: 60_000, memoryMb: 1024, failureSafety: 0.3, policyDecision: 'PENDING_REVIEW' },
};

function apply(ctx, config) {
  const cfg = Config.parse(config || {});
  let disposed = false;
  ctx.effect(() => () => { disposed = true; });

  // ── v0.6.3 新增：平台 profile 路由（设计稿 §二.2）
  // ── v0.6.3 新增：profile 解析透传到 lib/profile-resolver.js（设计稿 §二.2 模块化）
  function resolveProfile({ mode }) {
    return resolveProfileImpl(mode);
  }

  // ── v0.6.3 新增：变异路由（设计稿 §二.2 末尾）
  function routeForMutation({ source, kind }) {
    // source ∈ FROZEN enum: attribution-driven / dream-random / evolution-reversed
    // kind ∈ FROZEN enum: PROMPT_MUTATION / TOOL_SYNTHESIS / STRATEGY_REWRITE
    const isDreamRandom = source === 'dream-random';
    const isToolSynthesis = kind === 'TOOL_SYNTHESIS';
    return (isDreamRandom || isToolSynthesis)
      ? { mode: 'explore-then-verify', stages: ['explore', 'verify'] }
      : { mode: 'verify', stages: ['verify'] };
  }

  // ── v0.6.3 新增：runVerify / runExplore（双模式 Service 入口）
  async function runInMode({ target, opts = {}, mode }) {
    if (!target?.path) throw new Error(`run${mode}: target.path is required`);
    if (disposed) throw new Error(`run${mode}: plugin disposed`);
    if (!MODE_PRESETS[mode]) throw new Error(`runInMode: unknown mode '${mode}'`);

    const targetPath = resolve(target.path);
    const preset = MODE_PRESETS[mode];
    const merged = { ...cfg, ...preset, ...opts };
    const startedAt = Date.now();
    const sandboxService = ctx.get('sandbox');
    const profile = resolveProfile({ mode });
    const policy = {
      mode: 'workspace-write',
      workspaceRoot: targetPath,
      timeoutMs: merged.timeoutMs,
      memoryMb: merged.memoryMb,
      sandboxProfile: profile,
    };

    if (sandboxService && typeof sandboxService.confine === 'function') {
      let wrappedArgv;
      try {
        const result = sandboxService.confine(['node', resolve(__dirname, 'smoke.js'), targetPath], policy);
        // Sprint 18（2026-09-17）：校验 confine 返回 shape。
        // 契约应是 { argv: string[] }，但部分 dsh 模式返回裸对象 { ok, stdout, stderr }，
        // 直接 .slice 抛 TypeError → spawnWithTimeout 炸 → policy 收到 blocker finding
        // → releaseManager veto + REJECT → 候选全部 BUDGET_WAIT。
        // 修法：不是数组就 fail-safe 返回 sandbox-unavailable 状态（不抛、不 spawn），
        // 让 quality-eval 走 E0/provisional 路径，policy 给 PENDING_REVIEW，veto 放行。
        const candidateArgv = result?.argv ?? result;
        if (!Array.isArray(candidateArgv) || candidateArgv.length === 0 || typeof candidateArgv[0] !== 'string') {
          // Sprint 18 fix（2026-09-17）：confine() 返回非 argv 形状 → 不再盲否决（会让 policy REJECT）。
          // 降级走 in-process smoke（真实跑测试），让质量门真实生效；禁用 fallback 才 fail-closed。
          if (cfg.allowInProcessFallback) {
            const ip = await runSmokeInProcess(targetPath);
            return {
              target: { path: targetPath, name: target.name },
              ok: ip.ok, mode: `${mode}-in-process-fallback`, profile: { unsupported: profile.unsupported ?? true },
              exitCode: ip.ok ? 0 : 1, stdout: JSON.stringify(ip), stderr: '',
              checks: ip.checks, reason: ip.reason ?? 'confine-bad-shape-inprocess-fallback',
              durationMs: Date.now() - startedAt,
              safety: ip.ok ? 1.0 : preset.failureSafety, policyDecision: ip.ok ? 'PASS' : preset.policyDecision,
              fallback: 'in-process', fallbackReason: 'sandbox.confine returned non-array argv',
            };
          }
          return {
            target: { path: targetPath, name: target.name },
            ok: false, mode, profile: { unsupported: profile.unsupported ?? false },
            exitCode: null, stdout: '', stderr: `sandbox.confine 返回非数组 argv（shape=${typeof candidateArgv}）—— in-process fallback 已禁用，fail-closed。原始 result keys=${result && typeof result === 'object' ? Object.keys(result).join(',') : 'n/a'}`,
            checks: [], reason: 'sandbox-bad-shape', durationMs: Date.now() - startedAt,
            safety: preset.failureSafety, policyDecision: preset.policyDecision,
          };
        }
        wrappedArgv = candidateArgv;
      } catch (e) {
        return {
          target: { path: targetPath, name: target.name },
          ok: false, mode, profile: { unsupported: profile.unsupported ?? false },
          exitCode: null, stdout: '', stderr: `sandbox.confine failed: ${e.message}`,
          checks: [], reason: 'sandbox-confine-failed', durationMs: Date.now() - startedAt,
          safety: preset.failureSafety, policyDecision: preset.policyDecision,
        };
      }
      const { exitCode, stdout, stderr, timedOut } = await spawnWithTimeout(wrappedArgv, merged.timeoutMs);
      let parsed = {};
      try { parsed = JSON.parse(stdout || '{}'); } catch { parsed = { ok: false, reason: 'unparseable-stdout' }; }
      const ok = timedOut ? false : Boolean(parsed.ok);
      return {
        target: { path: targetPath, name: target.name }, ok,
        mode, profile: { unsupported: profile.unsupported ?? false },
        exitCode: timedOut ? null : exitCode,
        stdout, stderr: timedOut ? `timeout after ${merged.timeoutMs}ms` : stderr,
        checks: parsed.checks ?? [], reason: timedOut ? 'timeout' : parsed.reason,
        durationMs: Date.now() - startedAt,
        safety: ok ? 1.0 : preset.failureSafety, policyDecision: ok ? 'PASS' : preset.policyDecision,
      };
    }

    if (cfg.allowInProcessFallback) {
      const result = await runSmokeInProcess(targetPath);
      const ok = result.ok;
      return {
        target: { path: targetPath, name: target.name }, ok,
        mode: `${mode}-in-process`, profile: { unsupported: profile.unsupported ?? true },
        exitCode: ok ? 0 : 1, stdout: JSON.stringify(result), stderr: '',
        checks: result.checks, reason: result.reason,
        durationMs: Date.now() - startedAt,
        safety: ok ? 1.0 : preset.failureSafety, policyDecision: ok ? 'PASS' : preset.policyDecision,
        fallback: 'in-process', fallbackReason: 'ctx.sandbox unavailable',
      };
    }

    throw new Error(`agint-quality-sandbox.run${mode}: ctx.sandbox unavailable and allowInProcessFallback=false`);
  }

  // ── A3 接线（2026-09-20）：runVerify / runExplore 结果发布为 sandbox.passed / sandbox.failed ──
  // 背景：v0.6.3 把本插件从 plugins/agint-quality/agint-quality-sandbox/ 剥离为顶层插件时，
  //   publishSandboxEvent() **没有跟着迁过来**（旧目录仍有，新目录丢失）→ 生产 0 条。
  //   订阅方 agint-diagnosis 早已就位（订阅 sandbox.failed → analyzeFailedSmoke），
  //   payload 契约见 schemas/sandbox-{passed,failed}.schema.yaml。
  // 红线：**直连路径完整保留** —— publish 失败/缺失一律不抛、不改返回值。
  const runVerify = (args) => runAndPublish({ ...args, mode: 'verify' });
  const runExplore = (args) => runAndPublish({ ...args, mode: 'explore' });

  async function runAndPublish(args) {
    let result;
    try {
      result = await runInMode(args);
    } catch (err) {
      // 异常出口也算一次失败（如 ctx.sandbox 不可用且禁用 fallback）
      await publishSandboxEvent({ result: null, error: err, modeHint: args.mode, target: args.target });
      throw err;
    }
    await publishSandboxEvent({ result });
    return result;
  }

  // 新版 mode 是 verify / verify-in-process / verify-in-process-fallback 等，
  // schema 只认 [sandbox, in-process] 两值 → 归一化，否则订阅方按 enum 校验会拒。
  function normalizeMode(mode) {
    return String(mode ?? '').includes('in-process') ? 'in-process' : 'sandbox';
  }

  async function publishSandboxEvent({ result, error = null, modeHint, target }) {
    try {
      // event-bus 用 spec.provides 注册 3 个分 service，无 umbrella key；
      // 主路径 agint.eventBus.publish，兼容 umbrella 形态（部分 dispatcher 会 bridge）。
      let publish = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.publish') : null;
      if (typeof publish !== 'function') {
        const bus = typeof ctx.get === 'function' ? ctx.get('agint.eventBus') : null;
        if (bus && typeof bus.publish === 'function') publish = bus.publish.bind(bus);
      }
      if (typeof publish !== 'function') return; // 软降级：bus 不可用
      const isPass = Boolean(result?.ok) && !error;
      const topic = isPass ? 'sandbox.passed' : 'sandbox.failed';
      const allChecks = Array.isArray(result?.checks) ? result.checks : [];
      const payload = {
        target: {
          path: String(result?.target?.path ?? target?.path ?? ''),
          name: result?.target?.name ?? target?.name,
        },
        mode: normalizeMode(result?.mode ?? modeHint),
        durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : 0,
      };
      if (isPass) {
        payload.checks = allChecks.map((c) => ({
          name: String(c?.name ?? 'unknown'),
          ok: Boolean(c?.ok),
          detail: String(c?.detail ?? ''),
        }));
      } else {
        payload.reason = String(result?.reason ?? (error ? `sandbox-run-threw:${error.message}` : 'unknown'));
        payload.failedChecks = allChecks
          .filter((c) => c && c.ok === false)
          .map((c) => ({ name: String(c.name ?? 'unknown'), detail: String(c.detail ?? '') }));
      }
      await publish({ topic, version: 1, source: 'agint-quality-sandbox', payload });
    } catch (err) {
      // publish 失败 log 不抛（红线：保留原 return）
      if (!disposed) {
        try { console.error('[agint-quality-sandbox] publish failed:', err?.message ?? err); } catch { /* noop */ }
      }
    }
  }

  function spawnWithTimeout(argv, timeoutMs) {
    return new Promise((resolveP) => {
      const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (exitCode) => { clearTimeout(timer); resolveP({ exitCode, stdout, stderr, timedOut }); });
      child.on('error', (err) => { clearTimeout(timer); resolveP({ exitCode: -1, stdout, stderr: stderr + err.message, timedOut }); });
    });
  }

  async function backendHealth() {
    const sandboxService = ctx.get('sandbox');
    const cap = probeSyscallCapability();
    return {
      ctxSandboxAvailable: Boolean(sandboxService && typeof sandboxService.confine === 'function'),
      inProcessFallbackEnabled: cfg.allowInProcessFallback,
      timeoutMs: cfg.timeoutMs,
      memoryMb: cfg.memoryMb,
      seccompAvailable: cap.seccompAvailable,
      sbplAvailable: cap.sbplAvailable,
    };
  }

  // v0.3 保留：runSmoke（向后兼容现有 eval）
  async function runSmoke({ target, opts = {} }) {
    if (!target?.path) throw new Error('runSmoke: target.path is required');
    if (disposed) throw new Error('runSmoke: plugin disposed');
    const targetPath = resolve(target.path);
    const startedAt = Date.now();
    const sandboxService = ctx.get('sandbox');
    if (sandboxService && typeof sandboxService.confine === 'function') {
      const result = await runInRealSandbox({ sandboxService, targetPath, target, cfg, startedAt });
      if (!result.ok && !disposed) {
        const evo = ctx.get('agint.evolution');
        if (evo?.addFailure) {
          try { await evo.addFailure({ pattern: `sandbox-smoke-failed:${result.reason ?? 'unknown'}`, category: 'integration', severity: 'high', evidence: `target=${targetPath} reason=${result.reason ?? 'unknown'}` }); } catch { /* ignore */ }
        }
      }
      return result;
    }
    if (cfg.allowInProcessFallback) {
      const ip = await runSmokeInProcess(targetPath);
      return { target: { path: targetPath, name: target.name }, ok: ip.ok, mode: 'in-process', exitCode: ip.ok ? 0 : 1, stdout: JSON.stringify(ip), stderr: '', checks: ip.checks, reason: ip.reason, durationMs: Date.now() - startedAt };
    }
    throw new Error('agint-quality-sandbox: ctx.sandbox unavailable and allowInProcessFallback=false');
  }

  async function runInRealSandbox({ sandboxService, targetPath, target, cfg, startedAt }) {
    const policy = { mode: 'workspace-write', workspaceRoot: targetPath, timeoutMs: cfg.timeoutMs, memoryMb: cfg.memoryMb };
    let wrappedArgv;
    try {
      const r = sandboxService.confine(['node', resolve(__dirname, 'smoke.js'), targetPath], policy);
      const candidateArgv = r?.argv ?? r;
      // Sprint 18 fix（2026-09-17）：confine() 在某些 dsh 构建返回非 argv 形状
      // （裸对象 {ok,stdout,stderr} / Promise / undefined）；把非数组丢给 spawnWithTimeout
      // 会抛 argv.slice is not a function → 整条评估崩 → eval 转 safety 否决 → 全部候选 BUDGET_WAIT。
      // 修法：非数组就降级走受支持的 in-process smoke（真实跑测试，仍是正确质量门）；
      // 若禁用 in-process fallback，则干净返回 ok:false（fail-closed，不抛）。
      if (!Array.isArray(candidateArgv) || candidateArgv.length === 0 || typeof candidateArgv[0] !== 'string') {
        if (cfg.allowInProcessFallback) {
          const ip = await runSmokeInProcess(targetPath);
          return {
            target: { path: targetPath, name: target.name },
            ok: ip.ok, mode: 'in-process-fallback', exitCode: ip.ok ? 0 : 1,
            stdout: JSON.stringify(ip), stderr: '',
            checks: ip.checks, reason: ip.reason ?? 'confine-bad-shape-inprocess-fallback',
            durationMs: Date.now() - startedAt,
          };
        }
        return {
          target: { path: targetPath, name: target.name },
          ok: false, mode: 'sandbox', exitCode: null, stdout: '',
          stderr: `sandbox.confine 返回非数组 argv（shape=${typeof candidateArgv}）—— in-process fallback 已禁用，fail-closed`,
          checks: [], reason: 'sandbox-bad-shape', durationMs: Date.now() - startedAt,
        };
      }
      wrappedArgv = candidateArgv;
    } catch (e) {
      if (cfg.allowInProcessFallback) {
        const ip = await runSmokeInProcess(targetPath);
        return {
          target: { path: targetPath, name: target.name },
          ok: ip.ok, mode: 'in-process-fallback', exitCode: ip.ok ? 0 : 1,
          stdout: JSON.stringify(ip), stderr: '',
          checks: ip.checks, reason: ip.reason ?? 'confine-threw-inprocess-fallback',
          durationMs: Date.now() - startedAt,
        };
      }
      return {
        target: { path: targetPath, name: target.name },
        ok: false, mode: 'sandbox', exitCode: null, stdout: '',
        stderr: `sandbox.confine failed: ${e.message}`, checks: [], reason: 'sandbox-confine-failed',
        durationMs: Date.now() - startedAt,
      };
    }
    const { exitCode, stdout, stderr, timedOut } = await spawnWithTimeout(wrappedArgv, cfg.timeoutMs);
    let parsed = {};
    try { parsed = JSON.parse(stdout || '{}'); } catch { parsed = { ok: false, reason: 'unparseable-stdout' }; }
    return { target: { path: targetPath, name: target.name }, ok: timedOut ? false : Boolean(parsed.ok), mode: 'sandbox', exitCode: timedOut ? null : exitCode, stdout, stderr: timedOut ? `timeout after ${cfg.timeoutMs}ms` : stderr, checks: parsed.checks ?? [], reason: timedOut ? 'timeout' : parsed.reason, durationMs: Date.now() - startedAt };
  }

  ctx.provide('agint.qualitySandbox', {
    // v0.6.3 新增（设计稿 §二.2）
    runVerify, runExplore, resolveProfile, routeForMutation,
    // v0.3 保留（向后兼容）
    runSmoke, backendHealth,
    config: cfg,
  });
}

export { Config, apply, name, inject };