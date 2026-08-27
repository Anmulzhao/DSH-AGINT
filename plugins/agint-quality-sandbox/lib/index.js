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
        wrappedArgv = result.argv ?? result;
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

  const runVerify = (args) => runInMode({ ...args, mode: 'verify' });
  const runExplore = (args) => runInMode({ ...args, mode: 'explore' });

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
    try { const r = sandboxService.confine(['node', resolve(__dirname, 'smoke.js'), targetPath], policy); wrappedArgv = r.argv ?? r; } catch (e) {
      return { target: { path: targetPath, name: target.name }, ok: false, mode: 'sandbox', exitCode: null, stdout: '', stderr: `sandbox.confine failed: ${e.message}`, checks: [], reason: 'sandbox-confine-failed', durationMs: Date.now() - startedAt };
    }
    const { exitCode, stdout, stderr, timedOut } = await spawnWithTimeout(wrappedArgv, cfg.timeoutMs);
    let parsed = {};
    try { parsed = JSON.parse(stdout || '{}'); } catch { parsed = { ok: false, reason: 'unparseable-stdout' }; }
    return { target: { path: targetPath, name: target.name }, ok: timedOut ? false : Boolean(parsed.ok), mode: 'sandbox', exitCode: timedOut ? null : exitCode, stdout, stderr: timedOut ? `timeout after ${merged?.timeoutMs ?? cfg.timeoutMs}ms` : stderr, checks: parsed.checks ?? [], reason: timedOut ? 'timeout' : parsed.reason, durationMs: Date.now() - startedAt };
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