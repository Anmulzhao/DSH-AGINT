/**
 * lib/rollback-mutex.js — Sprint 10 v0.6.3 #5
 *
 * 进程级 rollback 互斥锁（设计稿 §二.4 末尾）：
 *   - 同 pluginName 串行执行（防止并发回滚导致状态撕裂）
 *   - 不同 pluginName 可并行
 *   - 用单进程 Map + Promise 队列，不引入文件锁 / IPC
 *
 * 行数预算（设计稿 §十.1）：≤80 行（含注释）
 */

// 记录每个 pluginName 当前在执行的 Promise；新调用 await 该 Promise（链式串行）
const _chains = new Map();

/**
 * 对同一 key 串行执行 fn；不同 key 并行。
 * @template T
 * @param {string} key - 互斥 key；设计稿用 pluginName
 * @param {() => Promise<T>} fn - 实际工作
 * @returns {Promise<T>}
 */
export async function withMutex(key, fn) {
  if (!key) throw new Error('withMutex: key is required');
  if (typeof fn !== 'function') throw new Error('withMutex: fn must be a function');

  const prev = _chains.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  // 把新 gate 接到旧 chain 末尾
  _chains.set(key, prev.then(() => gate));

  try {
    // 等前面所有调用跑完
    await prev;
    return await fn();
  } finally {
    // 释放
    release();
    // 清理：仅当当前 chain 是这个 gate（避免覆盖新的 chain）
    if (_chains.get(key) === prev.then(() => gate)) {
      _chains.delete(key);
    }
  }
}

/**
 * 测试 / 运维用：返回当前互斥状态。
 */
export function _mutexState() {
  return { keys: Array.from(_chains.keys()) };
}

/**
 * 测试用：清空所有互斥链。生产代码**不**应调用。
 */
export function _mutexReset() {
  _chains.clear();
}