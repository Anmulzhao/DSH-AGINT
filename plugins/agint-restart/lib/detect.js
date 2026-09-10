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
 * 构建信息性提示文本（由 agent 自主决定下一步）。
 * @param {object} opts
 * @returns {string}
 */
export function buildNotice({
  bootAt,
  prevBootAt,
  downtimeMs,
  lastSessionId,
  lastActiveAt,
  customNotice,
}) {
  const lines = [];
  lines.push(`[agint-restart] 检测到 DSH 服务已重启。`);
  if (prevBootAt) {
    lines.push(`上次运行于 ${prevBootAt}，本次于 ${bootAt} 重启完成。`);
  } else {
    lines.push(`本次于 ${bootAt} 启动。`);
  }
  if (downtimeMs > 0) {
    lines.push(`中断约 ${humanizeDowntime(downtimeMs)}。`);
  }
  if (lastSessionId) {
    lines.push(`重启前最近活跃的会话：${lastSessionId}`);
    if (lastActiveAt) lines.push(`该会话最后活跃于 ${lastActiveAt}。`);
  }
  if (customNotice) {
    lines.push(String(customNotice));
  }
  lines.push(`如需继续之前的工作，或启动新任务，请自主决定下一步。`);
  return lines.join('\n');
}
