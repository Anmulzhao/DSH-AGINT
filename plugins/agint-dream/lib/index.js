/**
 * agint-dream: host service plugin (provides `agint.dream`).
 *
 * HOST plane, single instance. The dreaming sweep is background memory
 * consolidation: it reads recent DSH session logs, extracts durable
 * candidates, scores them with the OpenClaw-adapted six-signal formula,
 * optionally promotes them into `agint.memory`, and writes a human-readable
 * dream diary under the configured root (default ${HOME}/projects/agint-dsh/dreams).
 *
 * Scheduling lives in agint-cron (job `night-dream`, daily 03:00 — OpenClaw default), which calls
 * `sweep({ apply: true })`. The preset tools (dream_status / dream_run_now /
 * dream_diary) call the same service for inspection and manual runs.
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-dream
 *         name: ./plugins/agint-dream/lib/index.js
 *         config:
 *           root: .../agint-dsh/dreams
 *           sessionsRoot: ${HOME}/.dsh/sessions
 */

import { resolve } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { runSweep, DEFAULTS } from './sweep.js';
import { defaultRecallPath } from './recall-store.js';
import { runVerification } from './verify.js';
// v0.2 (task 2 / C1): qualityEval bridge meta — status() 用来显示 qualityEvaluator 状态
import { getBridgeDefaults, DREAM_BASELINE_TARGETS } from './quality-bridge.js';
// 2026-09-18：零命中健康度（status() 透出 + sweep 传参）
import {
  DEFAULT_ZERO_HIT_THRESHOLD,
  evaluateZeroHitHealth,
  readHealthState,
} from './health.js';

const name = 'agint-dream';
// `agint.memory` is a soft dependency: read via ctx.get so a sweep still
// writes the diary (preview mode) when the memory service is unavailable.
const inject = [];

const Config = z.object({
  root: z.string().min(1, 'agint-dream: config.root is required'),
  sessionsRoot: z.string().default(() => (process.env.DSH_HOME || (process.env.HOME + '/.dsh')) + '/sessions'),
  // Three lookback windows mirror OpenClaw dreaming phases: Light 2d (candidate
  // extraction), REM 7d (cross-day reinforcement), Deep 30d (recovery backfill).
  lookbackDays: z.number().int().positive().default(DEFAULTS.lookbackDays),
  remLookbackDays: z.number().int().positive().default(DEFAULTS.remLookbackDays),
  deepRecoveryDays: z.number().int().positive().default(DEFAULTS.deepRecoveryDays),
  recover: z.boolean().default(true),
  minScore: z.number().min(0).max(1).default(DEFAULTS.minScore),
  minRecall: z.number().int().positive().default(DEFAULTS.minRecall),
  minUniqueSessions: z.number().int().positive().default(DEFAULTS.minUniqueSessions),
  // 2026-09-18：零命中告警。连续 N 次 sweep 扫不到会话 → health.status=degraded。
  // 动机：09-10 起宿主改会话日志命名，Light 7 天零命中而 dream_status 仍报
  // validation=OK —— "没扫到"和"扫到了没过关"在返回里长一样。
  // 默认开、不阻断 sweep；要临时静音设 zeroHitAlert=false。
  zeroHitAlert: z.boolean().default(true),
  zeroHitAlertThreshold: z.number().int().positive().default(DEFAULT_ZERO_HIT_THRESHOLD),
  // ── 2026-09-21：分级去重（方案 B，proposals/agint-dream-dedupe-lineage.md）──
  // 「同源闭包」修复：候选与 existing 共享同一份会话来源，单一 0.6 阈值下 existing
  // 越全命中率越高，实测生产 406 条记忆把 83 条过门候选 100% 吃掉。
  // 出厂即开（K51 四件套：默认开 + 降级回落 + 审计 + 一键可关）。
  // kill-switch：dedupeTieredEnabled=false → 完全回退到现状的单一阈值布尔判定。
  dedupeTieredEnabled: z.boolean().default(DEFAULTS.dedupeTieredEnabled),
  dedupeHigh: z.number().min(0).max(1).default(DEFAULTS.dedupeHigh),
  dedupeMid: z.number().min(0).max(1).default(DEFAULTS.dedupeMid),
});

/**
 * 2026-09-21（K51：kill-switch ≠ 默认关 —— 出厂即开，但必须一键可关）。
 * 可在运行时改的配置子集（内存态，重启还原为 patch.yml 的值）。
 * 一致性由 test/runtime-config.test.js 守护：此表必须与 Config schema 的同名键对齐。
 */
export const RUNTIME_CONFIG_KEYS = Object.freeze([
  'dedupeTieredEnabled',
  'dedupeHigh',
  'dedupeMid',
]);

const DAY_MS = 24 * 60 * 60 * 1000;

async function readLatestDiaryMtime(diaryRoot) {
  try {
    const files = await readdir(diaryRoot).catch(() => []);
    const dated = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
    if (dated.length === 0) return null;
    let latest = 0;
    for (const f of dated) {
      const st = await stat(join(diaryRoot, f)).catch(() => null);
      if (st && st.mtimeMs > latest) latest = st.mtimeMs;
    }
    return latest > 0 ? latest : null;
  } catch {
    return null;
  }
}

function apply(ctx, config) {
  const cfg = config;
  const root = resolve(cfg.root);
  const sessionsRoot = resolve(cfg.sessionsRoot);
  const state = { lastSweep: null, lastResult: null, lastError: null };
  // 2026-09-21（K51）：运行时配置覆盖（内存态，重启还原 patch.yml 的值）。
  const runtimeOverrides = new Map();
  const effectiveConfig = () => {
    const merged = { ...cfg };
    for (const [k, v] of runtimeOverrides) merged[k] = v;
    return merged;
  };
  // Recover the last-known sweep time from on-disk diary mtime so a freshly
  // booted host does not look like it has never run. Result counts remain
  // unknown (state.lastResult stays null) until the next real sweep.
  readLatestDiaryMtime(root).then((mtimeMs) => {
    if (mtimeMs && !state.lastSweep) state.lastSweep = mtimeMs;
  }).catch(() => { /* ignore — keep state.lastSweep null */ });

  ctx.provide('agint.dream', {
    /** Run a full sweep. opts.apply=false → preview + diary only. */
    async sweep(opts = {}) {
      const nowMs = Date.now();
      const eff = effectiveConfig();
      // P0 (Sprint 13 / 2026-09-05)：publishReject 钩子
      // validation gate 拒整批时 publish dream.rejected 事件（软降级：bus 不可用静默）
      const publishFn = (typeof ctx.get === 'function') ? ctx.get('agint.eventBus.publish') : null;
      const publishReject = typeof publishFn === 'function'
        ? async (info) => {
            try {
              await publishFn({
                topic: 'dream.rejected',
                version: 1,
                source: 'agint-dream',
                payload: {
                  rejectedAt: new Date(info.nowMs).toISOString(),
                  day: info.day,
                  reason: info.reason,
                  gatedCount: info.gatedCount,
                  stats: info.stats,
                },
              });
            } catch (err) {
              // 软降级：不阻断 sweep
              console.warn(`agint-dream: dream.rejected publish failed: ${err.message}`);
            }
          }
        : null;
      try {
        const result = await runSweep({
          sessionsRoot,
          diaryRoot: root,
          memory: ctx.get('agint.memory') ?? null,
          // P1 LLM consolidation: host-plane ctx 让 sweep 内部能 ctx.get('agents')
          // 建临时 subagent（路径 Y，见 计划-agint-dream升级三方向.md）
          ctx,
          nowMs,
          apply: Boolean(opts.apply),
          lookbackDays: opts.lookbackDays ?? eff.lookbackDays,
          remLookbackDays: opts.remLookbackDays ?? eff.remLookbackDays,
          deepRecoveryDays: opts.deepRecoveryDays ?? eff.deepRecoveryDays,
          recover: opts.recover ?? eff.recover,
          minScore: opts.minScore ?? eff.minScore,
          minRecall: opts.minRecall ?? eff.minRecall,
          minUniqueSessions: opts.minUniqueSessions ?? eff.minUniqueSessions,
          // 2026-09-21：分级去重旋钮（kill-switch 走运行时覆盖，见 config() API）
          dedupeTieredEnabled: opts.dedupeTieredEnabled ?? eff.dedupeTieredEnabled,
          dedupeHigh: opts.dedupeHigh ?? eff.dedupeHigh,
          dedupeMid: opts.dedupeMid ?? eff.dedupeMid,
          publishReject,
          // 2026-09-18：零命中告警（默认开；配置可关 / 可调阈值）
          zeroHitAlert: opts.zeroHitAlert ?? eff.zeroHitAlert,
          zeroHitAlertThreshold: opts.zeroHitAlertThreshold ?? eff.zeroHitAlertThreshold,
        });
        state.lastSweep = nowMs;
        state.lastResult = result;
        state.lastError = null;
        // Sprint 12 / A8 — T1 影子期：sweep 成功后 publish dream.completed。
        // 软降级：bus 不可用静默；不阻断 sweep 返回（主路径保留）。
        // 单 service 接口 ctx.get('agint.eventBus.publish')（不用伞键）。
        try {
          const publishFn = (typeof ctx.get === 'function') ? ctx.get('agint.eventBus.publish') : null;
          if (typeof publishFn === 'function') {
            await publishFn({
              topic: 'dream.completed',
              version: 1,
              source: 'agint-dream',
              payload: {
                sweepId: `${nowMs}`,
                completedAt: new Date(nowMs).toISOString(),
                apply: Boolean(opts.apply),
                durationMs: result.durationMs ?? null,
                countCandidates: result.counts?.candidates ?? 0,
                countGated: result.counts?.gated ?? 0,
                countPromoted: result.counts?.promoted ?? result.promoted?.length ?? 0,
                diaryPath: result.diaryPath ?? null,
                // 2026-09-21（方案 B）：去重分档遥测。此前该事件只报 countGated，
                // 「gated=0」既可能是没候选也可能是全被去重吃了 —— 分不清。
                // shape: { enabled, dropped, suspicious, checked, maxSimilarity }
                dedupeStats: result.counts?.dedupeStats ?? null,
              },
            });
          }
        } catch (err) {
          if (state.lastError === null) {
            // 影子侧副作用失败不改变 lastError（主路径错误语义保持）
          }
          // 不抛：dream.completed 影子发布失败不影响 sweep 结果
        }
        return result;
      } catch (error) {
        state.lastError = error && error.message ? error.message : String(error);
        state.lastSweep = nowMs;
        throw error;
      }
    },

    /** Dreaming service status (no side effects). */
    async status() {
      const last = state.lastResult;
      const eff = effectiveConfig();
      // 2026-09-18：健康度**直接读盘**，不用 state.lastResult —— 否则进程一重启
      // 计数就丢了，而"连续零命中"恰恰是要跨重启才能攒够次数的信号。
      const healthState = await readHealthState(root).catch(() => null);
      const health = evaluateZeroHitHealth(healthState ?? {}, {
        threshold: eff.zeroHitAlertThreshold,
        enabled: eff.zeroHitAlert,
      });
      return {
        enabled: true,
        frequency: '0 3 * * *', // nightly 03:00 (OpenClaw default), wired in agint-cron jobs
        sessionsRoot,
        diaryRoot: root,
        lookbackDays: eff.lookbackDays,
        windows: {
          light: eff.lookbackDays,
          rem: eff.remLookbackDays,
          deep: eff.deepRecoveryDays,
        },
        recover: eff.recover,
        thresholds: {
          minScore: eff.minScore,
          minRecall: eff.minRecall,
          minUniqueSessions: eff.minUniqueSessions,
        },
        // 2026-09-21（方案 B）：分级去重旋钮透出 —— 排查「gated 为什么是 0」
        // 时第一眼要看的就是这三个值 + 下方 lastResult 里的 dedupeStats。
        dedupe: {
          tieredEnabled: eff.dedupeTieredEnabled,
          high: eff.dedupeHigh,
          mid: eff.dedupeMid,
          overrides: Object.fromEntries(runtimeOverrides),
        },
        // P2 (Sprint 13 / 2026-09-05)：recall store 路径
        recallPath: defaultRecallPath(),
        // 2026-09-18：零命中健康度。status=degraded 时必须排查 Light 通道，
        // 别再被 "validation=OK" 骗过去 —— 那个只说明"没丢已有记忆"。
        health,
        lastSweepAt: state.lastSweep ? new Date(state.lastSweep).toISOString() : null,
        lastError: state.lastError,
        // v0.2 (task 2 / C1 → C2 → C3 / 2026-09-06)：qualityEvaluator 桥接
        // C1: status() 透出配置 + target 列表（meta only）
        // C2: sweep.js REM 阶段 evaluate 真接入，compositeScore 用 safety?.score?.score 代理
        // C3: compositeScore 真值接入（0 行上游改动，直接调 evaluator.score() service）
        qualityEval: {
          bridgeVersion: 'C3 (REM integrated; real compositeScore via evaluator.score(); 0-100 scale)',
          targetsPlanned: DREAM_BASELINE_TARGETS.length,
          targets: DREAM_BASELINE_TARGETS.map((t) => t.id),
          bridgeDefaults: getBridgeDefaults(),
          serviceKey: 'agint.qualityEvaluator',
          note: 'C3 改调 quality-eval evaluator.score() 拿真 composite (0-100) · boost 阈值 ±0.02 在 70/30 · safety veto 时 composite=null → degraded',
        },
        counts: last?.counts ?? {
          sessions: 0, userMessages: 0, memWrites: 0, toolErrors: 0,
          candidates: 0, gated: 0, skippedPromoted: 0, validationOk: true,
          validationReason: null, recovered: 0, promoted: 0,
          recallAppended: 0, recallPruned: 0,
          // P1 LLM consolidation mode 兜底（与 lib/sweep.js result.counts 对齐）
          consolidationMode: 'n/a', consolidationReason: null,
          // v0.2 (task 2 / C2 / 2026-09-06)：REM qualityEval 摘要兜底
          qualityEval: { status: 'unavailable', compositeMean: null, harmMean: null, targetCount: 0, okCount: 0 },
          // v0.3 (task 3 / 2026-09-06)：Deep 阶段 evolution 摘要兜底
          evolutionTemplates: { status: 'unavailable', count: 0, topConfidence: null, boost: 0 },
        },
      };
    },

    /**
     * P2：查 recall store 内容。debug / 验证时方便。
     * opts: { key, type, since, until, limit, json }.
     */
    async inspectRecall(opts = {}) {
      const { inspectStore } = await import('./recall-store.js');
      return inspectStore(defaultRecallPath(), opts);
    },

    /**
     * P1: 跑一次 minimal LLM consolidation 验证。
     * 在 host plane 真调 ctx.agents.create() + ctx.subagents.start('spawn', {outputSchema})，
     * 不依赖 sweep 主体，不写 agint.memory（仅返回 schema-validated structured result）。
     * 验证 host 端 DSH subagent runtime 通路是否真可用 —— 设计文档第一步。
     *
     * opts: { provider, model, timeoutMs }
     * 返回 JSON-safe：{ mode, operations, operationsLength, gatedLength, reason, ... }
     */
    async verifyConsolidation(opts = {}) {
      return runVerification({
        ctx,
        provider: opts.provider,
        model: opts.model,
        timeoutMs: opts.timeoutMs,
      });
    },

    /** Read one dream diary file (default: most recent). */
    async diary(date) {
      const dir = root;
      const files = await readdir(dir).catch(() => []);
      const target = date ? `${date}.md` : null;
      let name = null;
      if (target && files.includes(target)) {
        name = target;
      } else {
        const mds = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
        const withTime = await Promise.all(mds.map(async (f) => ({ f, t: (await stat(join(dir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs ?? 0 })));
        withTime.sort((a, b) => b.t - a.t);
        name = withTime[0]?.f ?? null;
      }
      if (!name) return { path: null, content: null };
      return { path: join(dir, name), content: await readFile(join(dir, name), 'utf8') };
    },

    /**
     * 2026-09-21（K51 kill-switch）：读 / 改运行时配置子集（内存态）。
     * 无参 = 读当前生效值 + 已改的 override；带 patch = 白名单内覆盖。
     * 动机：分级去重上线后若 `gated` 量级异常（放行过多 → LLM 调用暴涨，
     * 或误伤），老板要能**一键回到现状**而不用改代码、不用重启。
     *
     * 用法：
     *   agint.dream.config()                              → 读
     *   agint.dream.config({ dedupeTieredEnabled: false }) → 回退单一阈值
     * ⚠️ 重启后 override 丢失，还原为 cordis.patch.yml 的值。
     */
    config(patch) {
      if (patch == null) {
        return {
          ...effectiveConfig(),
          overrides: Object.fromEntries(runtimeOverrides),
        };
      }
      // 白名单过滤：子集外字段静默忽略（不报错，防误伤）
      const allowed = new Set(RUNTIME_CONFIG_KEYS);
      const applied = {};
      for (const [k, v] of Object.entries(patch)) {
        if (!allowed.has(k) || v === undefined) continue;
        runtimeOverrides.set(k, v);
        applied[k] = v;
      }
      return { ...effectiveConfig(), overrides: Object.fromEntries(runtimeOverrides), applied };
    },
  });
}

export { Config, apply, inject, name };
