/**
 * agint-restart — 重启检测与消息构建的纯函数（无 ctx 依赖，便于单元测试）。
 *
 * 设计来源：nickkkkkk123123/dsh-resume-on-restart/lib/detect.js（逐字 1:1 移植，
 *   仅 import 路径微调，行为 0 变化）；上游 MIT License。
 */

/**
 * 将中断时长格式化为可读文本（如 "1 小时 5 分"）。
 * @param {number} ms 毫秒数
 * @returns {string}
 */
export function humanizeDowntime(ms) {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h} 小时${m > 0 ? ` ${m} 分` : ''}`;
  if (m > 0) return `${m} 分${s > 0 ? ` ${s} 秒` : ''}`;
  return `${s} 秒`;
}

/**
 * 从 marker 判断是否发生了重启。
 * @param {object|null} marker 上次写入的 marker（含 lastBootAt/pid）
 * @param {number} nowMs 当前时间戳
 * @param {number} pid 当前进程 pid
 * @returns {{wasRestart: boolean, downtimeMs: number}}
 */
export function detectRestart(marker, nowMs, pid) {
  if (!marker || typeof marker.lastBootAt !== 'string' || typeof marker.pid !== 'number') {
    return { wasRestart: false, downtimeMs: 0 };
  }
  // pid 相同 = 同一进程（不是重启）；pid 不同 = 发生了重启
  if (marker.pid === pid) return { wasRestart: false, downtimeMs: 0 };
  const prev = Date.parse(marker.lastBootAt);
  const downtimeMs = Number.isFinite(prev) && prev > 0 ? Math.max(0, nowMs - prev) : 0;
  return { wasRestart: true, downtimeMs };
}

/**
 * 抖动判定：相邻两次启动间隔 < debounceMs 则视为同一次重启的"再投"，
 * 跳过通知投递（防止老板连续 restart 反复唤醒 agent）。语义：
 *   - downtimeMs < debounceMs → 抖动，不投
 *   - downtimeMs >= debounceMs → 真重启，照常投
 *   - downtimeMs === 0（如 marker 缺失）→ 不算抖动，照常判定上游 wasRestart
 *
 * @param {object} detect  detectRestart(...) 的返回值
 * @param {number} debounceMs 防抖窗口（毫秒）；<=0 视为关闭
 * @returns {{debounced: boolean, reason: 'within-debounce'|'normal'|null}}
 */
export function shouldNotify({ wasRestart, downtimeMs }, debounceMs) {
  if (!wasRestart) return { debounced: false, reason: null };
  if (!Number.isFinite(debounceMs) || debounceMs <= 0) return { debounced: false, reason: null };
  if (downtimeMs < debounceMs) return { debounced: true, reason: 'within-debounce' };
  return { debounced: false, reason: null };
}

/**
 * 构建信息性提示文本 —— **纯状态陈述，不含任何行动指令**（v0.7.1）。
 *
 * 断环教训（2026-09-10 重启环，见 restart-loop-incident-20260910.md）：
 * 任何「请自主决定下一步 / 如需继续之前的工作」式措辞，都会把一条**状态消息**变成**工作指令**——
 * 被唤醒的会话会把上下文里未完成的老板旧指令当成新指令再执行一遍
 * （实测两次重启的 reason 逐字相同：「老板要求重启 DSH，重启后主动问好」）。
 * 老板 2026-09-11 拍板：「重启后注入『已重启』就行了」。
 *
 * 因此消息体只保留 brand 前缀 + 「已重启」。中断时长 / 会话 id / 是否自触发等细节不再进消息，
 * 它们本来就有各自落点：`restart_status`、`wake.log`、`restart-history.json`。
 *
 * @param {object} [opts]
 * @param {string} [opts.customNotice] 配置里的 `notice`，唯一仍会进消息体的附加文本。
 *   其余参数（bootAt / prevBootAt / downtimeMs / lastSessionId / lastActiveAt / selfRestart）
 *   保留仅为兼容既有调用方，**不再影响文本**。
 * @returns {string}
 */
export function buildNotice({ customNotice } = {}) {
  const lines = [`[agint-restart] DSH 已重启。`];
  if (customNotice) lines.push(String(customNotice));
  return lines.join('\n');
}
