/**
 * lib/log-buffer.js — Sprint 10 v0.6.4 #7 骨架
 *
 * EvolutionLogBuffer 异步批量写入（设计稿 §二.5）：
 *   - flush 策略：计数触发（≥10 条）+ 时间触发（≥5s 定时器）+ 退出触发（process.on('beforeExit'/'SIGTERM')）
 *   - 并发控制：flush 操作加异步锁（Promise 队列），防止重入导致日志重复落盘
 *   - 丢失兜底：flush 失败写 `agint.memory` 一条 `buffer-lost:<count>`，不丢日志元数据
 *   - 读时合并：触发查询时走「buffer + storage 合并视图」，不污染 storage
 *
 * 行数预算（设计稿 §十.1）：≤120 行
 *
 * ## L0-frozen 保护（设计稿 §七 + §不做事）
 *   - 不引用 quality-contract FROZEN 接口（注释里也不许直接写）
 *   - 不修改 evolution-memory 已有的 5 个 Service 签名
 *   - 不引入新的中心化服务（仅本地 buffer 抽象）
 */

import { setTimeout } from 'node:timers';

export const DEFAULT_FLUSH_COUNT = 10;
export const DEFAULT_FLUSH_MS = 5000;

/**
 * 创建 LogBuffer 实例。
 * @param {object} args
 * @param {object} args.storage - agint_evolution storage domain
 * @param {object} args.memFallback - agint.memory 服务（flush 失败时写 buffer-lost）
 * @param {number} [args.flushCount=10]
 * @param {number} [args.flushMs=5000]
 */
export function createLogBuffer({ storage, memFallback, flushCount = DEFAULT_FLUSH_COUNT, flushMs = DEFAULT_FLUSH_MS }) {
  if (!storage) throw new Error('createLogBuffer: storage is required');
  if (!memFallback) throw new Error('createLogBuffer: memFallback is required');

  /** @type {Array<object>} */
  const buffer = [];
  let timer = null;
  let flushing = null;
  let disposed = false;

  function ensureTimer() {
    if (timer || disposed) return;
    // ⚠️ 必须用 `node:timers` 的 setTimeout（返回 Timeout 句柄），不能用
    //   `node:timers/promises` 的版本：后者返回 **Promise**，而 shutdown() 里的
    //   `clearTimeout(timer)` 对 Promise 是空操作 —— 定时器照旧挂着，
    //   进程被它吊住最长 flushMs 秒才退出。
    //   实测取证（2026-10-03）：test/smoke.mjs 13 个用例合计 0.5s，进程却跑
    //   60.2s —— 正好等于用例里 flushMs: 60_000，于是 bin/check-wiring.mjs 的
    //   smoke 门禁（60s 超时）恒红。改句柄后 clearTimeout 生效，那个名为
    //   「shutdown 强制 flush + 清理 timer」的用例也才真的在它测的名字上。
    timer = setTimeout(() => {
      timer = null;
      doFlush('timer').catch(() => { /* doFlush 自带 buffer-lost 兜底 */ });
    }, flushMs);
  }

  async function doFlush(reason = 'manual') {
    if (flushing) return flushing;
    if (buffer.length === 0) return { flushed: 0, lost: 0 };
    // 定时器存在的唯一理由是「别让已入队的条目等太久」。
    // 批已被取空 ⇒ 没有待办 ⇒ 句柄必须撤掉，否则一次计数 flush 之后
    // 那条 flushMs 定时器还在空挂（生产 flushMs=5s 无所谓，但测试与
    // 一次性进程里它就是把进程拖满 5s/60s 的元凶）。下一次 enqueue 会重新 arm。
    if (timer) { clearTimeout(timer); timer = null; }

    flushing = (async () => {
      const batch = buffer.splice(0, buffer.length);
      let flushed = 0, lost = 0;
      try {
        const t = await storage.table('evolution_log');
        for (const entry of batch) {
          await t.put(entry.id, entry);
          flushed += 1;
        }
      } catch (e) {
        lost = batch.length;
        try {
          await memFallback.write({
            type: 'lesson',
            content: `EvolutionLogBuffer flush 失败: lost=${lost} reason=${reason} err=${e.message}`,
            evidence: `Sprint 10 v0.6.4 #7 buffer-lost:${lost}`,
            confidence: 0.5,
          });
        } catch { /* memFallback 不可用时静默——不丢元数据即可 */ }
      }
      return { flushed, lost };
    })();
    const r = await flushing;
    flushing = null;
    return r;
  }

  function enqueue(entry) {
    if (disposed) throw new Error('enqueue: LogBuffer disposed');
    if (!entry || !entry.id) throw new Error('enqueue: entry.id is required');
    buffer.push(entry);
    if (buffer.length >= flushCount) {
      void doFlush('count');
    } else {
      ensureTimer();
    }
  }

  async function readMerged(query) {
    const t = await storage.table('evolution_log');
    const stored = t.entries();
    const seen = new Set();
    const merged = [];
    for (const e of buffer) {
      if (!seen.has(e.id)) { seen.add(e.id); merged.push(e); }
    }
    for (const e of stored) {
      if (!seen.has(e.id)) { seen.add(e.id); merged.push(e); }
    }
    if (!query) return merged;
    const q = String(query).toLowerCase();
    return merged.filter((e) => {
      const haystack = ((e.evidence ?? '') + ' ' + (e.pattern ?? '') + ' ' + (e.reason ?? '')).toLowerCase();
      return haystack.includes(q);
    });
  }

  async function shutdown() {
    disposed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    return doFlush('shutdown');
  }

  return { enqueue, flush: doFlush, readMerged, shutdown, _size: () => buffer.length, _hasTimer: () => timer !== null };
}