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
export function createSessionSource({ ctx = null, fallback, onFallback, source = 'unknown', readLocal = null }) {
  if (typeof fallback !== 'function') {
    throw new Error('createSessionSource: fallback 必须是函数（不允许没有回落通道的会话源）');
  }
  // ⚠️ 2026-10-21 修（运行态取证）：上游服务**不能在建源时取一次**。
  //
  // 现象（重启后实测）：session-source 的 `upstream` 恒为 null ⇒ 所有调用点
  // 悄悄走本地回落，"接上了 sessionQuery" 变成假话。
  // 根因：`ctx.get('sessionQuery')` 在**插件 apply 时**求值，而上游 sessionQuery
  // 插件可能在本插件之后才注册服务 ⇒ 快照恒 null。
  //   （宿主实测：`cordis_inspect_query{provider:Service, service:'sessionQuery'}`
  //     返回完整契约 ⇒ 服务确实在，只是取早了。）
  //
  // 修法：每次使用时**重新探测**。不声明 inject 硬依赖，保持软依赖。
  const getUpstream = () => probeUpstream(ctx);

  return {
    /** 本源实际走哪条路。给调用方 / 探针用，别拿它当开关。 */
    get mode() { return getUpstream() ? 'upstream' : 'fallback'; },
    get upstreamAvailable() { return Boolean(getUpstream()); },

    async listRecent(opts = {}) {
      const upstream = getUpstream();
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

    /**
     * 读一个会话的**完整事件流**。
     *
     * 这是 D1 的核心：截止 2026-10-21，AGINT 只是"列举"走上了游（而且因为上游
     * 不给磁盘路径，那条路实际走不通），"读内容"仍然全是本地 zstd 解压。
     * 上游 `sessionQuery.readSession(id)` 直接给重放校验过的事件流 ⇒ 不需要磁盘路径。
     *
     * @param {object} record  listRecent() 返回的一项（上游项靠 dir=sessionId，
     *                         回落项靠 path）
     * @returns {Promise<{events: object[], via: 'upstream'|'fallback'}>}
     *          ⛔ 拿不到就抛，不返回空数组 —— 空数组会被下游当成"这个会话没内容"。
     */
    async readEvents(record) {
      if (!record) throw new Error('session-source.readEvents: record 必需');
      const upstream = getUpstream();

      // ① 上游优先：record 带上游标记且有 sessionId 才走
      if (upstream && record.upstream && record.dir) {
        try {
          const snap = await upstream.readSession(record.dir);
          const events = Array.isArray(snap?.events) ? snap.events : null;
          if (events === null) {
            throw new Error('readSession 未返回 events 数组');
          }
          return { events, via: 'upstream' };
        } catch (err) {
          // 上游读失败 ⇒ 回落，但出声（这是"接线有洞"信号，不是正常路径）
          report(`read-upstream-failed(${record.dir}): ${err && err.message ? err.message : String(err)}`);
        }
      } else if (!upstream) {
        report('read-upstream-absent: ctx.get(sessionQuery) 不可用');
      }

      // ② 回落：本地读盘
      if (!record.path) {
        // 上游只给元数据（path 恒 null）而读又失败 ⇒ 没有可回落的东西。
        // ⛔ 这里必须抛：静默返回 [] 会让"读不到"看起来像"没内容"。
        throw new Error(
          `session-source.readEvents: 无可用内容源（upstream=${
            upstream ? 'yes' : 'no'
          }, dir=${record.dir ?? 'null'}, path=${record.path ?? 'null'}）`,
        );
      }
      return { events: await readEventsFromDisk(readLocal, record.path), via: 'fallback' };
    },
  };

  function report(reason) {
    const full = `[session-source/${source}] ${reason}`;
    if (typeof onFallback === 'function') onFallback(full);
    else throw new Error(`${full}（且未提供 onFallback ⇒ 拒绝静默降级）`);
  }
}

/**
 * 回落层：从磁盘读一个会话日志的事件流。
 *
 * ⛔ 本模块**不直接** import zstd / node:fs —— 保持零 IO 依赖，测试可用内存夹具
 * 直调生产逻辑。真正解压由调用方注入的 `readLocal(path)` 完成
 * （见 `createSessionSource({ readLocal })`）。
 *
 * 为什么单列成函数而不是塞进 readEvents 里：D1 迁移完成后，这条路径会从
 * "主路径"退化成"上游不可用时的救急通道"。它必须留在同一处、可被单独测试，
 * 否则上游一坏就没人知道它还能不能用。
 */
async function readEventsFromDisk(readLocal, path) {
  if (typeof readLocal !== 'function') {
    throw new Error(
      'session-source: 需要注入 readLocal(path) 才能走回落读盘 ' +
        '（本模块不持有 zstd 实现，避免再把上游格式知识摊到第二处）',
    );
  }
  const text = await readLocal(path);
  // 与 agint-session-extract.parseSession 同语义：坏行跳过、不抛。
  const out = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip malformed line */ }
  }
  return out;
}
/**
 * 走上游拿最近会话，输出**与回落层同形** `{ dir, path, mtimeMs }`。
 * 形状对齐是硬要求：迁一个调用点时不该牵动下游。
 *
 * ⛔ 2026-10-21 订正 —— 上游记录的真实形状与"时间"语义：
 *
 *   `listSessions()` 返回 `SessionRecord{ header, live, persisted, formatStatus? }`，
 *   时间戳只在 `record.header.createdAt`（**创建时刻**）。上游**没有"最后活跃时间"**
 *   这个字段：它自己的排序函数 `compareSessions` 就是
 *   `b.header.createdAt - a.header.createdAt || id.localeCompare(...)`
 *   （dsh-session-query/lib/index.js:compareSessions）。
 *
 *   此前本函数读 `r.updatedAt ?? r.lastEventAt ?? r.createdAt` —— 前两个在上游
 *   记录里都不存在，于是恒落空；`r.createdAt` 也是 undefined（它在 header 里）。
 *   ⇒ `mtimeMs` 恒 0 ⇒ 排序全等、时间窗过滤恒假（`mtimeMs && mtimeMs < cutoff`）。
 *   这是"看着接上了其实没接"的又一例。
 *
 *   ⚠️ 语义差异必须显式交代，不能拿创建时间冒充活跃时间：
 *   `mtimeMs` 取自 `header.createdAt` = **会话创建时刻**，不是最后写入时刻。
 *   对"最近 N 天活跃"这类判据，上游给不了答案 ⇒ 返回记录带
 *   `mtimeBasis: 'createdAt'`，调用方必须据此决定能不能用它做时间窗。
 */
async function listViaUpstream(svc, { lookbackDays = 2, maxSessions, maxCount } = {}) {
  // 参数名两个都认：调用点惯用 maxCount（input-gateway），语义同 maxSessions
  const limit = maxSessions ?? maxCount ?? 500;
  const records = await svc.listSessions();
  const cutoff = Date.now() - lookbackDays * 86400000;
  const out = [];
  for (const r of records ?? []) {
    const id = r.header?.id ?? r.id ?? r.sessionId;
    if (!id) continue;
    // 上游给的是记录，不是路径（SessionRecord 里没有磁盘路径这个概念）。
    // 内容要靠 readEvents() → readSession(id) 拿。
    // 时间取 header.createdAt —— 这是上游唯一提供的时间，且它是**创建**时刻。
    const rawCreated = r.header?.createdAt ?? r.createdAt;
    const ms = typeof rawCreated === 'number' ? rawCreated : Date.parse(rawCreated);
    const mtimeMs = Number.isFinite(ms) ? ms : 0;
    if (mtimeMs && mtimeMs < cutoff) continue;
    out.push({
      dir: id,
      path: r.path ?? null,
      mtimeMs,
      upstream: true,
      // 明确标注时间基准：调用方若需要"最后活跃"不能直接用它
      mtimeBasis: 'createdAt',
      live: r.live === true,
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}
