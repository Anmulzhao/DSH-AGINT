/**
 * agint-dream/lib/health.js — sweep 健康度：零命中检测与告警（2026-09-18）。
 *
 * 为什么需要它（不是锦上添花）：
 *   2026-09-10 宿主改会话日志命名 → Light 通道连续 7 天扫到 0 个会话，
 *   而 dream_status 仍报 validation=OK。**"没扫到东西"和"扫到了但没过关"在
 *   返回里长得一模一样** —— 这是静默失效最舒服的温床。命名问题 09-17 已修，
 *   但"零命中不告警"这个洞还在：下次换一种失效方式（路径改了 / 权限没了 /
 *   zstd 没了）照样没人知道。
 *
 * 设计取舍（K51：可回滚 > 可审批；AGINT 自进化默认）：
 *   - 判据是**纯规则**（连续计数 ≥ 阈值），机器可判、可回放，不引入人工环节；
 *   - **不阻断** sweep —— 观察层，可观测优先于可审批，只标记 + 落盘 + warn；
 *   - 带 kill-switch（`enabled`）与可调阈值（`threshold`），均可运行时关闭；
 *   - 状态**必须落盘**：内存计数会在进程重启时归零，那就永远等不到告警，
 *     等于把告警做成了摆设；
 *   - 读写失败一律 fail-open（退回初始态 / 返回 false），绝不让告警链路
 *     自己把 sweep 搞挂 —— 告警杀死被告警对象是这类代码的经典自伤。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** 状态文件名（放在 diaryRoot 下，与 diary 同生命周期，不新增目录约定） */
export const HEALTH_STATE_FILE = '.dream-health.json';

/** 连续零命中达到该次数才告警（1 次可能是这两天没活动，3 次基本是通道坏了） */
export const DEFAULT_ZERO_HIT_THRESHOLD = 3;

/** 初始状态：字段全显式，不用 undefined 表达"没有"（便于 JSON 序列化稳定） */
export function initialHealthState() {
  return {
    consecutiveZeroHit: 0,
    totalSweeps: 0,
    totalZeroHits: 0,
    lastZeroHitAt: null,
    lastNonZeroAt: null,
    lastSweepAt: null,
  };
}

/**
 * 纯函数：把一次 sweep 的命中情况并入状态。
 *
 * @param {object|null} prev 上一次状态（首次传 undefined）
 * @param {{hit: boolean, nowIso?: string}} args hit=true 表示本次扫到了会话
 * @returns 新状态（不改入参）
 */
export function updateZeroHitState(prev, { hit, nowIso } = {}) {
  const s = { ...initialHealthState(), ...(prev ?? {}) };
  const now = nowIso ?? new Date().toISOString();
  return {
    consecutiveZeroHit: hit ? 0 : s.consecutiveZeroHit + 1,
    totalSweeps: s.totalSweeps + 1,
    totalZeroHits: s.totalZeroHits + (hit ? 0 : 1),
    lastZeroHitAt: hit ? s.lastZeroHitAt : now,
    lastNonZeroAt: hit ? now : s.lastNonZeroAt,
    lastSweepAt: now,
  };
}

/**
 * 纯函数：状态 → 健康判定。
 *
 * @param {object} state
 * @param {{threshold?: number, enabled?: boolean}} opts
 * @returns {{status:'ok'|'degraded', consecutiveZeroHit:number, threshold:number,
 *            enabled:boolean, lastNonZeroAt:string|null, reason:string|null}}
 */
export function evaluateZeroHitHealth(state, opts = {}) {
  const { threshold = DEFAULT_ZERO_HIT_THRESHOLD, enabled = true } = opts;
  const n = state?.consecutiveZeroHit ?? 0;
  const degraded = enabled === true && n >= threshold;
  return {
    status: degraded ? 'degraded' : 'ok',
    consecutiveZeroHit: n,
    threshold,
    enabled: enabled !== false,
    lastNonZeroAt: state?.lastNonZeroAt ?? null,
    reason: degraded
      ? `连续 ${n} 次 sweep 零命中（阈值 ${threshold}）—— Light 通道可能已失效，检查会话日志路径/命名/解压`
      : null,
  };
}

/**
 * 读盘。文件不存在 / JSON 损坏 → 返回初始态（fail-open）。
 * 损坏时**不抛错**：告警链路挂掉不值得让整个 sweep 失败。
 */
export async function readHealthState(diaryRoot) {
  try {
    const raw = await readFile(join(diaryRoot, HEALTH_STATE_FILE), 'utf8');
    return { ...initialHealthState(), ...JSON.parse(raw) };
  } catch {
    return initialHealthState();
  }
}

/** 写盘。失败返回 false（调用方决定是否记录 error），不抛。 */
export async function writeHealthState(diaryRoot, state) {
  try {
    await mkdir(diaryRoot, { recursive: true });
    await writeFile(join(diaryRoot, HEALTH_STATE_FILE), JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}
