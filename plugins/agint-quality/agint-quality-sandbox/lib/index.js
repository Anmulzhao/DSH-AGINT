/**
 * agint-quality-sandbox: D-QAF Phase 2 动态沙箱（v0.3 初版）
 *
 * 桥接 dsh 的 ctx.sandbox 服务（@deepseek-ai/dsh-sandbox + dsh-sandbox-local
 * 后端）在隔离环境里执行 plugin 冒烟测试。
 *
 * ## 设计原则
 *   1. 桥接优先：真沙箱执行通过 ctx.sandbox.confine() 拿到 wrapping argv，
 *      spawn 子进程跑 lib/smoke.js。dev/test 环境 ctx.sandbox 不存在时
 *      降级为 in-process runSmoke（不走真隔离，但能验证结构）。
 *   2. 资源限制：timeout 30s / memory 512MB（ROADMAP P3 §沙箱 限定）
 *   3. 失败上报：沙箱执行结果写 agint.evolution（addFailure 触发）：
 *      沙箱跑挂 → failure-patterns（regression 时被 eval 命中预警）
 *      沙箱通过 → 不写（成功路径由 logPhase4 在 Phase 4 末尾统一记）
 *
 * ## Sprint 2.A 范围
 *   - Service 契约：runSmoke({ target, opts }) → SandboxRunResult
 *   - 桥接 ctx.sandbox.confine() 拿 wrapping argv（生产 dsh 启动时）
 *   - 降级为 in-process runSmoke（dev/CI 环境）
 *   - 5 个 eval 场景（mock ctx.sandbox + 降级路径）
 *
 * ## Sprint 3 接入
 *   - 钩到 agint-quality-eval Phase 2 调用 runSmoke
 *   - 钩到 agint-quality-policy sandbox 失败 → evo.addFailure
 *   - 钩到 agint-evolve 周复盘对 sandbox 历史做趋势
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-quality-sandbox
 *         name: ./plugins/agint-quality/agint-quality-sandbox/lib/index.js
 *         config: {}
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { runSmoke as runSmokeInProcess } from './smoke.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const name = 'agint-quality-sandbox';
const inject = ['sandbox', 'agint.evolution']; // dsh-sandbox service + evolution service for failure write

const Config = z.object({
  /** sandbox timeout in milliseconds (default 30s, ROADMAP §沙箱 限) */
  timeoutMs: z.number().int().positive().default(30_000),
  /** memory limit in MB (default 512MB) */
  memoryMb: z.number().int().positive().default(512),
  /** when ctx.sandbox is unavailable, run smoke in-process instead of failing */
  allowInProcessFallback: z.boolean().default(true),
}).optional();

const SandboxRunResultSchema = z.object({
  target: z.object({
    path: z.string(),
    name: z.string().optional(),
  }),
  ok: z.boolean(),
  mode: z.enum(['sandbox', 'in-process']),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  checks: z.array(z.object({
    name: z.string(),
    ok: z.boolean(),
    detail: z.string(),
  })).default([]),
  reason: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
});

function apply(ctx, config) {
  const cfg = Config.parse(config || {});
  let disposed = false;

  ctx.effect(() => () => {
    disposed = true;
  });

  /**
   * Run plugin smoke test in a sandboxed subprocess.
   * Tries ctx.sandbox.confine() first; falls back to in-process if
   * allowInProcessFallback=true and ctx.sandbox missing.
   */
  async function runSmoke({ target, opts = {} }) {
    if (!target?.path) throw new Error('runSmoke: target.path is required');
    if (disposed) throw new Error('runSmoke: plugin disposed');

    const targetPath = resolve(target.path);
    const startedAt = Date.now();
    const sandboxService = ctx.get('sandbox');

    // Path 1: real sandbox via ctx.sandbox.confine()
    if (sandboxService && typeof sandboxService.confine === 'function') {
      return await runInRealSandbox({ sandboxService, targetPath, target, cfg, startedAt });
    }

    // Path 2: dev fallback — in-process
    if (cfg.allowInProcessFallback) {
      return await runInProcess({ targetPath, target, startedAt });
    }

    // Path 3: refuse
    throw new Error('agint-quality-sandbox: ctx.sandbox unavailable and allowInProcessFallback=false');
  }

  async function runInRealSandbox({ sandboxService, targetPath, target, cfg, startedAt }) {
    // Build argv: ['node', '<smoke.js>', '<plugin-path>']
    const smokeScript = resolve(__dirname, 'smoke.js');
    const baseArgv = ['node', smokeScript, targetPath];

    // Sandbox policy: workspace-write to the plugin's directory only
    const policy = {
      mode: 'workspace-write',
      workspaceRoot: targetPath,
      timeoutMs: cfg.timeoutMs,
      memoryMb: cfg.memoryMb,
    };

    // Ask dsh-sandbox to wrap argv with confinement
    let wrappedArgv;
    try {
      const result = sandboxService.confine(baseArgv, policy);
      // result may be { argv: [...] } or just argv
      wrappedArgv = result.argv ?? result;
    } catch (e) {
      return SandboxRunResultSchema.parse({
        target: { path: targetPath, name: target.name },
        ok: false,
        mode: 'sandbox',
        exitCode: null,
        stdout: '',
        stderr: `sandbox.confine() failed: ${e.message}`,
        checks: [],
        reason: 'sandbox-confine-failed',
        durationMs: Date.now() - startedAt,
      });
    }

    // Spawn the confined process and collect output with timeout
    const { exitCode, stdout, stderr, timedOut } = await spawnWithTimeout(wrappedArgv, cfg.timeoutMs);

    // Parse smoke output (smoke.js emits JSON on stdout)
    let checks = [];
    let ok = false;
    let reason;
    try {
      const parsed = JSON.parse(stdout || '{}');
      checks = parsed.checks ?? [];
      ok = Boolean(parsed.ok);
      reason = parsed.reason;
    } catch {
      ok = false;
      reason = 'unparseable-stdout';
    }

    const result = SandboxRunResultSchema.parse({
      target: { path: targetPath, name: target.name },
      ok,
      mode: 'sandbox',
      exitCode: timedOut ? null : exitCode,
      stdout,
      stderr: timedOut ? `timeout after ${cfg.timeoutMs}ms` : stderr,
      checks,
      reason: timedOut ? 'timeout' : reason,
      durationMs: Date.now() - startedAt,
    });

    // Sandbox 失败 → 写 evolution failure-pattern（Sprint 3 接入 policy 后改由 policy 触发）
    if (!ok && !disposed) {
      const evo = ctx.get('agint.evolution');
      if (evo && typeof evo.addFailure === 'function') {
        try {
          await evo.addFailure({
            pattern: `sandbox-smoke-failed:${reason ?? 'unknown'}`,
            category: 'integration',
            severity: timedOut ? 'medium' : 'high',
            evidence: `target=${targetPath} reason=${reason ?? 'unknown'}`,
          });
        } catch { /* evolution unavailable — ignore */ }
      }
    }

    return result;
  }

  async function runInProcess({ targetPath, target, startedAt }) {
    // Dev fallback: call runSmoke directly (no isolation)
    const result = await runSmokeInProcess(targetPath);
    const out = SandboxRunResultSchema.parse({
      target: { path: targetPath, name: target.name },
      ok: result.ok,
      mode: 'in-process',
      exitCode: result.ok ? 0 : 1,
      stdout: JSON.stringify(result),
      stderr: '',
      checks: result.checks,
      reason: result.reason,
      durationMs: Date.now() - startedAt,
    });
    return out;
  }

  function spawnWithTimeout(argv, timeoutMs) {
    return new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ exitCode, stdout, stderr, timedOut });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ exitCode: -1, stdout, stderr: stderr + err.message, timedOut });
      });
    });
  }

  // ── Health check (used by agint-rules / metrics) ─────────────────────────

  async function backendHealth() {
    const sandboxService = ctx.get('sandbox');
    return {
      ctxSandboxAvailable: Boolean(sandboxService && typeof sandboxService.confine === 'function'),
      inProcessFallbackEnabled: cfg.allowInProcessFallback,
      timeoutMs: cfg.timeoutMs,
      memoryMb: cfg.memoryMb,
    };
  }

  ctx.provide('agint.qualitySandbox', {
    runSmoke,
    backendHealth,
    config: cfg,
  });
}

export { Config, apply, inject, name };
