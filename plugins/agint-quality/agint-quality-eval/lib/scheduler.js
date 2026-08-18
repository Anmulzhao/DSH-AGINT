/**
 * agint-quality-eval: 轻量周期调度器
 *
 * 自持一个 setInterval（5 分钟一次），检查下一个触发时间；到点后跑
 * evaluateAll(targets) 批量评估所有 AGINT 已注册的 Skills + Plugins。
 *
 * 时间表：每周日 04:30（metrics-collect 04:00 之后、evolve-review 03:45 不重叠；
 *          选择 04:30 是为了在 metrics 指标稳定后再做评估）。
 */

import { parseCron, nextFire } from './cron.js';

const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟检查一次
const SCHEDULE = '30 4 * * 0'; // Sun 04:30

export class WeeklyScheduler {
  /**
   * @param {object} ctx  cordis context（用于 setInterval / dispose）
   * @param {Function} taskFn  触发时执行的任务：async () => any
   */
  constructor(ctx, taskFn) {
    this.ctx = ctx;
    this.taskFn = taskFn;
    this.parsed = parseCron(SCHEDULE);
    this.nextFireAt = nextFire(this.parsed);
    this.running = false; // 防止重叠执行
    this.lastRun = null; // { at, result, error }

    const handle = ctx.setInterval(() => this.tick(), TICK_INTERVAL_MS);
    ctx.effect(() => handle.dispose);
  }

  /** tick：检查是否到点，到点就跑 taskFn */
  async tick() {
    const now = Date.now();
    if (now < this.nextFireAt.getTime()) return;
    if (this.running) return; // 已经在跑

    this.running = true;
    const at = new Date();
    try {
      const result = await this.taskFn();
      this.lastRun = { at, result, error: null };
    } catch (err) {
      this.lastRun = { at, result: null, error: err };
      // 不抛错 — 周日后台任务，失败就静默记 stderr
      console.error('agint-quality-eval: weekly task failed', err.message);
    } finally {
      this.running = false;
      this.nextFireAt = nextFire(this.parsed);
    }
  }

  /** 强制跑一次（用于 boot 时立刻评估，或调试） */
  async runNow() {
    if (this.running) throw new Error('agint-quality-eval: task already running');
    this.running = true;
    const at = new Date();
    try {
      const result = await this.taskFn();
      this.lastRun = { at, result, error: null };
      return result;
    } catch (err) {
      this.lastRun = { at, result: null, error: err };
      throw err;
    } finally {
      this.running = false;
      this.nextFireAt = nextFire(this.parsed);
    }
  }

  /** 下次触发时间 */
  getNextFire() {
    return this.nextFireAt;
  }

  /** 最近一次跑的结果 */
  getLastRun() {
    return this.lastRun;
  }
}