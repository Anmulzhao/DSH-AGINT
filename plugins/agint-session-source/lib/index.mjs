/**
 * agint-session-source —— 会话日志发现的唯一入口（P0，2026-10-19）
 *
 * # 为什么要有它
 *
 * AGINT 有 **4 处**各自手搓会话日志发现，其中 2 处连后缀兜底都没有：
 *
 *   | 位置 | 形状 | 兜底 |
 *   |---|---|---|
 *   | `agint-dream/lib/sweep.js:125` | 候选名 + 后缀兜底 | ✅ 有 |
 *   | `agint-session-extract/index.js` | 后缀 + 版本秩 | ✅ 有 |
 *   | `agint-input-gateway/.../cross-agent.js:54` | 三名字硬编码 | ⛔ 无 |
 *   | `agint-input-gateway/.../self-observation.js:312` | 三名字硬编码（第二份副本） | ⛔ 无 |
 *
 * 已知事故：2026-09-22 宿主把会话日志改名为 `session.v4.jsonl.zstd` ⇒
 * `agint-session-extract` 发现层瞎了 12 天，autocreate 供料归零（M1 断链）。
 *
 * dsh 0.2.1-rc.2 给出了官方答案：service `sessionQuery`
 * （`searchSessions` / `searchEvents` / `listSessions` / `readSession` / `observeSession`）。
 *
 * ⇒ 本模块把「怎么找到会话」收敛成一处：**上游可用走上游，不可用回落现有发现层，
 *   且回落必须出声**（静默 skip 是这个项目最坏的一类失败）。
 *
 * # 用法
 *
 *   const src = createSessionSource({ ctx, onFallback });
 *   const sessions = await src.listRecent({ lookbackDays: 2, maxSessions: 500 });
 *
 * `onFallback(reason)` 由调用方决定怎么出声（写审计 / 写指标 / 记日志）。
 * 本模块**不自己吞掉**降级：不传 onFallback 就抛错 —— 防止又造一个静默降级点。
 */

import { join } from 'node:path';

/** 上游 sessionQuery 服务的能力面（只列 AGINT 实际要用的）。 */
const UPSTREAM_METHODS = ['listSessions', 'searchSessions', 'searchEvents', 'readSession'];

/**
 * 会话日志文件名的唯一真相源（F5 收口，2026-10-19）。
 *
 * 背景：input-gateway 的 cross-agent.js 与 self-observation.js 曾**各持一份**
 * 候选名表（且无后缀兜底）—— 宿主 09-22 改 v4 命名那次的同类断供风险。
 * 现在两份本地副本都删了，统一走 `findSessionLogFile`：
 *   1. 先精确匹配候选名（版本秩 v4 > v3 > 无版本，同 dream/sweep.js:125 先例）；
 *   2. 候选名全不匹配再按 `.jsonl.zstd` 后缀兜底 —— 宿主下次改名（v5/v6）
 *      发现层不归零，最多是排序退化，不会静默失明。
 *  fs 函数注入（statSync/readdirSync 由调用方给）⇒ 本模块零 node:fs 依赖，
 *  测试可用内存夹具直调生产函数（不 mock 逻辑本身）。
 * 返回命中文件的绝对路径；目录内无会话日志返回 null。mtime 判断留给调用方。
 */
export const SESSION_LOG_NAMES_BY_RANK = Object.freeze([
  'session.v4.jsonl.zstd',
  'session.v3.jsonl.zstd',
  'session.jsonl.zstd',
]);
export const SESSION_LOG_SUFFIX = '.jsonl.zstd';

export function findSessionLogFile(dirPath, { statSync, readdirSync }) {
  for (const name of SESSION_LOG_NAMES_BY_RANK) {
    const p = join(dirPath, name);
    try { statSync(p); return p; } catch { /* 试下一个 */ }
  }
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const e = entries.find((x) => x.isFile() && x.name.endsWith(SESSION_LOG_SUFFIX));
    return e ? join(dirPath, e.name) : null;
  } catch { return null; }
}

/**
 * 探测上游 sessionQuery 服务。
 * 返回 null 表示不可用（未挂载 / 挂载但不完整）—— 由调用方决定如何出声。
 */
export function probeUpstream(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return null;
  const svc = ctx.get('sessionQuery');
  if (!svc) return null;
  const missing = UPSTREAM_METHODS.filter((m) => typeof svc[m] !== 'function');
  // 部分可用也算不可用：半截实现比没有更危险（调用方会以为拿到了完整能力）
  return missing.length === 0 ? svc : null;
}

/**
 * 建一个会话源。
 *
 * @param {object}  opts
 * @param {object}  opts.ctx            Cordis context（可为 null ⇒ 直接走回落）
 * @param {Function} opts.fallback      回落发现层：(opts) => Promise<SessionLog[]>|SessionLog[]
 * @param {Function} [opts.onFallback]  回落时出声的回调，收到 reason 字符串。
 *                                      ⛔ 不传则回落到抛错 —— 不允许静默降级。
 * @param {string}  [opts.source]        标识调用方（如 'dream' / 'input-gateway'），便于定位
 */
export function createSessionSource({ ctx = null, fallback, onFallback, source = 'unknown' }) {
  if (typeof fallback !== 'function') {
    throw new Error('createSessionSource: fallback 必须是函数（不允许没有回落通道的会话源）');
  }
  const upstream = probeUpstream(ctx);

  return {
    /** 本源实际走哪条路。给调用方 / 探针用，别拿它当开关。 */
    mode: upstream ? 'upstream' : 'fallback',
    upstreamAvailable: Boolean(upstream),

    async listRecent(opts = {}) {
      if (upstream) {
        try {
          return await listViaUpstream(upstream, opts);
        } catch (err) {
          // 上游报错也要回落，但**必须出声**：上游有却用不了 = 接线有洞
          report(`upstream-failed: ${err && err.message ? err.message : String(err)}`);
        }
      } else {
        report('upstream-absent: ctx.get(sessionQuery) 不可用');
      }
      return await fallback(opts);
    },
  };

  function report(reason) {
    const full = `[session-source/${source}] ${reason}`;
    if (typeof onFallback === 'function') onFallback(full);
    else throw new Error(`${full}（且未提供 onFallback ⇒ 拒绝静默降级）`);
  }
}

/**
 * 走上游拿最近会话，输出**与回落层同形** `{ dir, path, mtimeMs }`。
 * 形状对齐是硬要求：迁一个调用点时不该牵动下游。
 */
async function listViaUpstream(svc, { lookbackDays = 2, maxSessions, maxCount } = {}) {
  // 参数名两个都认：调用点惯用 maxCount（input-gateway），语义同 maxSessions
  const limit = maxSessions ?? maxCount ?? 500;
  const records = await svc.listSessions();
  const cutoff = Date.now() - lookbackDays * 86400000;
  const out = [];
  for (const r of records ?? []) {
    const id = r.id ?? r.sessionId;
    if (!id) continue;
    // 上游给的是记录，不是路径。要路径得再问一次 —— 但它未必给磁盘路径，
    // 所以这里**不强求 path**：拿不到就留 null，由调用方按自己的读法处理。
    let mtimeMs = 0;
    const t = r.updatedAt ?? r.lastEventAt ?? r.createdAt;
    if (t) {
      const ms = typeof t === 'number' ? t : Date.parse(t);
      if (Number.isFinite(ms)) mtimeMs = ms;
    }
    if (mtimeMs && mtimeMs < cutoff) continue;
    out.push({ dir: id, path: r.path ?? null, mtimeMs, upstream: true });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}
