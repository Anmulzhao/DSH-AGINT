/**
 * agint-tool-stats: D2 — 工具使用统计服务（提供 `agint.toolStats`）。
 *
 * HOST plane, single instance. 监听 tools/result waterfall，追加写
 * ~/.dsh/storages/agint_tool_stats.jsonl；提供 5 个读取方法 + 1 个
 * model-visible 工具。
 *
 * 设计依据：wiki/AGINT/d2-dream-evolve-linkage.md Step 1。
 * 模型可见工具：tool_stats_summary（仅 1 个，最小可用）。
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-tool-stats
 *         name: ./plugins/agint-tool-stats/lib/index.js
 *         config:
 *           jsonlPath: .../agint_tool_stats.jsonl
 */

/**
 * 懒取上游服务的小工具（导出以便单测）。
 *
 * ⛔ 为什么不能 `const svc = ctx.get(key)` 在 apply 时取一次：
 *   插件 apply 与上游服务注册**没有顺序保证** —— 取早了就恒为 null，
 *   表现是"字段落了、值恒空"，看起来接上了其实没接（2026-10-21 运行态取证：
 *   重启后 20 条记录的 deltaTokens 全 null、tokenSource 19/20 为 null）。
 *   每次使用时重新取，才能覆盖"上游晚于本插件注册"的情况。
 *
 * @param {object} ctx  cordis context
 * @param {string} key  服务键
 * @returns {() => (object|null)}
 */
export function lazyService(ctx, key) {
  return () => {
    try { return (ctx.get && ctx.get(key)) || null; } catch { return null; }
  };
}

import { resolve as resolvePath } from 'node:path';
import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
// 会话解析统一走中立提取器（双格式 v3/jsonl + 去重）——修 backfill 只认
// session.jsonl.zstd、漏读全部 v3 会话的历史 bug（Phase 1，2026-09-17）。
import {
  listSessionLogs,
  loadSession,
  extractToolCalls,
  decompressSession,
} from '../../agint-session-extract/index.js';
import { createSessionSource } from '../../agint-session-source/lib/index.mjs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  stableStringify,
  classifyError,
  classifyOk,
  summarize,
  slowest,
  failureRate,
  timeseries,
  repeatPatterns,
} from './aggregate.js';

const name = 'agint-tool-stats';
// tools 必须在 inject 里：要注册 model-visible 工具。
const inject = ['tools'];

const Config = z.object({
  jsonlPath: z.string().default(
    () => (process.env.DSH_HOME || (process.env.HOME + '/.dsh')) + '/storages/agint_tool_stats.jsonl',
  ),
  sessionsRoot: z.string().default(
    () => (process.env.DSH_HOME || (process.env.HOME + '/.dsh')) + '/sessions',
  ),
});

function apply(ctx, config) {
  const jsonlPath = resolvePath(config.jsonlPath);
  const sessionsRoot = resolvePath(config.sessionsRoot);
  // sessionId 缓存：tools/result 不带 sessionId，要从 session/event 维护。
  let currentSessionId = null;
  let writeQueue = Promise.resolve();

  // ── token 计量（2026-10-21 接上游 ctx.tokenMeter，见 capability-boundary.md §4 F3）──
  //
  // 为什么在这里接：D-QAF Phase 3 的「有效进化增量 = Δ(任务完成率) / Δ(Token消耗 +
  // 步数 + 时间)」里，token 项此前**恒缺** —— 全仓 grep token 只有 13 行「恒 null」
  // 占位注释。dsh 0.2.1 已提供确定性计量（replay-aware，不调模型），AGINT 只该消费。
  //
  // 口径（必须写清楚，否则这个数字会变成新的假读数）：
  //   ① 这是**一次工具调用前后**会话累计 token 的差值，不是这次调用本身的计费额。
  //      会话级的模型回复、压缩、重放都可能改变累计值。
  //   ② 上游缺席 ⇒ 该字段 null（不填 0）。0 会被下游当成「测得零」，
  //      而 null 是「没测」—— 两者在 D-QAF 里含义完全不同。
  //   ③ 测量失败不阻断工具统计本身（catch 后置 null）。
  // ⚠️ 2026-10-21 修（运行态取证）：上游服务**不能在 apply 时取一次**。
  //
  // 现象（重启后实测）：tool-stats 落盘的 20 条记录里 deltaTokens 恒 null、
  // tokenSource 19 条 null（仅 1 条 'tokenMeter'）⇒ "接上了 tokenMeter" 是假话。
  // 根因：`ctx.get('tokenMeter')` 在**插件 apply 时**求值，而 tokenMeter 服务
  // 可能在本插件之后才注册 ⇒ 快照恒 null。
  //   （宿主实测：`cordis_inspect_query{provider:Service, service:'tokenMeter'}`
  //     返回完整契约 ⇒ 服务确实在，只是取早了。）
  //
  // 修法：每次测量时**重新取**。不声明 inject 硬依赖，保持软依赖。
  const getTokenMeter = lazyService(ctx, 'tokenMeter');

  /** 取会话当前累计 token；拿不到返回 null（绝不返回 0 冒充）。 */
  function readTotalTokens(session, requestHeader) {
    const tm = getTokenMeter();
    if (!tm || typeof tm.measure !== 'function') return null;
    if (!session) return null;
    try {
      const m = tm.measure(session, requestHeader);
      const v = m?.totalTokens;
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }

  /** 当前活跃 session 对象（session/created 时留一份引用，measure 要的是 Session 而非 id）。 */
  let currentSession = null;
  /** 每次工具调用开始前的累计值，供 tools/result 时算 delta。 */
  let tokensBeforeCall = null;

  // ── Throttle：tool_stats_summary 一小时最多 N 次，防失控 ──
  // 内部计数器：按 1 小时桶滚动清零。
  const THROTTLE_PER_HOUR = 5;
  let throttleWindowStart = Date.now();
  let throttleCount = 0;
  function checkThrottle() {
    const now = Date.now();
    if (now - throttleWindowStart > 3600_000) {
      throttleWindowStart = now;
      throttleCount = 0;
    }
    if (throttleCount >= THROTTLE_PER_HOUR) {
      const waitMin = Math.ceil((3600_000 - (now - throttleWindowStart)) / 60_000);
      throw new Error(
        `tool_stats_summary: throttled (${THROTTLE_PER_HOUR}/hour reached). ` +
        `Wait ~${waitMin} min, or read ~/.dsh/storages/agint_tool_stats.jsonl directly for raw data.`,
      );
    }
    throttleCount++;
  }

  // ── 维护当前 session id（监听 session/created 拿 id） ──
  // 2026-10-21：同时留一份 session 对象引用 —— tokenMeter.measure() 要的是 Session
  // 实例而不是 id，只存 id 会让 token 计量恒 null（那是"看起来接上了其实没接"）。
  ctx.on('session/created', (session) => {
    currentSessionId = session?.id ?? session?.sessionId ?? null;
    currentSession = session ?? null;
    tokensBeforeCall = readTotalTokens(currentSession);
  });

  // ── 核心：监听 tools/result（emit 模式，只追加写） ──
  // 签名：'(exec: ToolExecution, result: ToolExecutionResult) => undefined'
  // emit 模式无 next()，不能修改结果。Listener failures are contained.
  ctx.on('tools/result', (exec, result) => {
    // token 增量：调用后测一次，减去调用前那次。两次都拿到了才有意义；
    // 任一为 null 就写 null（"没测"），不写 0（那是"测得零"，会被下游当成真值）。
    const tokensAfter = readTotalTokens(currentSession);
    const deltaTokens =
      tokensBeforeCall !== null && tokensAfter !== null
        ? tokensAfter - tokensBeforeCall
        : null;
    // 下一次调用的基线 = 本次的终点
    tokensBeforeCall = tokensAfter;
    // 供下游区分「读不到 tokenMeter」与「这次恰好增量为 0」
    // ⚠️ 这里必须在**每次**记录时重新判定上游在不在 —— 不能用 apply 时的快照
    //   （那条快照恒为 null，会让 tokenSource 永远说"上游缺席"）。
    const tokenSource = getTokenMeter() ? 'tokenMeter' : null;

    writeQueue = writeQueue
      .then(() => persist(exec, result, currentSessionId, jsonlPath, { deltaTokens, tokenSource }))
      .catch((err) => {
        console.error('agint-tool-stats: persist failed', err.message);
      });
  });

  // ── D1 迁移：会话内容读优先走上游 sessionQuery ──────────────────────────
  // 2026-10-21：backfill 原先 `loadSession(log.path)` 走本地 zstd 解压。
  // 上游 `sessionQuery.readSession(id)` 直接给重放校验过的事件流 ⇒ 不碰磁盘。
  // 上游缺席时回落本地（经 session-source 注入的 readLocal = decompressSession）。
  //
  // ⚠️ onFallback 必须传 —— session-source 的纪律是"回落要出声"。
  //   这里传的是工具（backfill），没有现成的审计出口，所以出声到 console。
  //   这不是静默降级：上游缺席时 backfill 仍在本地读，只是留了痕迹。
  const sessionSource = createSessionSource({
    ctx,
    fallback: async () => [],
    onFallback: (reason) => console.warn(`[agint-tool-stats] ${reason}`),
    source: 'tool-stats/backfill',
    readLocal: (path) => decompressSession(path),
  });

  // ── 读取：暴露 agint.toolStats Service ──
  const toolStats = {
    async summary(args = {}) {
      const records = await readAllRecords(jsonlPath);
      return summarize(records, { since: args.since });
    },
    async slowest(args = {}) {
      const records = await readAllRecords(jsonlPath);
      const limit = args.limit ?? 5;
      return slowest(summarize(records, { since: args.since }), limit);
    },
    async failureRate(args = {}) {
      const records = await readAllRecords(jsonlPath);
      const limit = args.limit ?? 5;
      return failureRate(summarize(records, { since: args.since }), limit);
    },
    async timeseries(args = {}) {
      if (!args.tool) throw new Error('agint.toolStats.timeseries: tool required');
      const records = await readAllRecords(jsonlPath);
      return timeseries(records, args.tool, { since: args.since, bucket: args.bucket });
    },
    async repeatPatterns(args = {}) {
      const records = await readAllRecords(jsonlPath);
      return repeatPatterns(records, {
        since: args.since,
        minRepeats: args.minRepeats ?? 3,
        maxResults: args.maxResults ?? 10,
      });
    },
    /** 用 session log 给 JSONL 补 callTs/latencyMs/turn/step/sessionId。幂等。 */
    async backfill(args = {}) {
      const root = args.sessionsRoot ? resolvePath(args.sessionsRoot) : sessionsRoot;
      // D1：优先用本 apply 里创建的 sessionSource（上游优先）
      return backfill(root, jsonlPath, sessionSource);
    },
  };

  ctx.provide('agint.toolStats', toolStats);

  // ── 注册 model-visible 工具（让模型能在会话中调 summary） ──
  ctx.tools.register(defineTool({
    name: 'tool_stats_summary',
    description:
      '查询工具使用画像：每个工具的调用次数、失败率、平均延迟、p95 延迟。' +
      '数据来源：~/.dsh/storages/agint_tool_stats.jsonl。' +
      '典型用法：会话结束看一眼本周的工具表现，定位失败率高/延迟高的工具。' +
      `限速：${5}/小时（防失控）。超限抛错，此时可直接读上述 JSONL 取原始数据。`,
    parameters: {
      since: { type: 'string', description: '时间窗口，支持 s/m/h/d 后缀（如 "1h"、"7d"）；省略 = 全部' },
      limit: { type: 'number', description: '返回最多多少条（默认 20，按 calls 降序）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          summary: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_a, v) => {
        if (!v.summary?.length) return [{ type: 'text', text: 'tool_stats_summary: no data yet' }];
        const lines = v.summary.map((s) =>
          `  ${s.tool.padEnd(28)} ${String(s.calls).padStart(4)} calls · ${(s.failRate * 100).toFixed(1)}% fail · avg ${s.avgMs}ms · p95 ${s.p95Ms}ms`
        );
        return [{ type: 'text', text: `tool_stats_summary: ${v.summary.length} tools\n${lines.join('\n')}` }];
      },
    },
    async execute(args) {
      checkThrottle();
      const records = await readAllRecords(jsonlPath);
      const all = summarize(records, { since: args.since });
      const limit = args.limit ?? 20;
      return { summary: all.slice(0, limit) };
    },
  }));
}

async function persist(exec, result, sessionId, jsonlPath, tokenInfo = {}) {
  // emit 事件传过来的是展开对象（exec.name / exec.arguments），
  // 不是 Session Log 里那种嵌套的 {data: {...}} 结构。
  // 两种形态都兼容：直接属性优先，回退到 .data.xxx。
  const e = exec?.data ?? exec;
  const r = result?.data ?? result;
  const tool = e?.name ?? e?.tool ?? 'unknown';
  const args = e?.arguments ?? {};
  const execTime = e?.time ?? exec?.time ?? null;
  const resultTime = r?.time ?? result?.time ?? execTime;
  const latencyMs = (resultTime && execTime) ? (resultTime - execTime) : null;
  const resultText = r?.message?.content ?? r?.message ?? result?.message ?? result;
  const ok = classifyOk(r?.message ?? result);
  const errorKind = ok ? null : classifyError(tool, JSON.stringify(resultText).slice(0, 500));
  const argFingerprint = createHash('sha256')
    .update(`${tool}::${stableStringify(args)}`)
    .digest('hex');
  // ─── D-QAF 字段 (提案 42b038aa 组合级 C-HARM) ────────────────
  // argsHash: 纯 args 的 hash(不含 tool 名),用于 C-Reuse 检测同类调用
  // parentIdx: 调用依赖树父节点,用于 C-Alignment 并行/串行检测
  // 两者默认 null,LLM 不传也能正常 append(向后兼容)
  const argsHash = createHash('sha256')
    .update(stableStringify(args))
    .digest('hex')
    .slice(0, 16);
  const parentIdx = e?.parentIdx ?? exec?.parentIdx ?? null;
  const record = {
    ts: resultTime ?? Date.now(),
    sessionId,
    turn: e?.turn ?? null,
    step: e?.step ?? null,
    tool,
    callId: e?.callId ?? null,
    latencyMs,
    ok,
    errorKind,
    argFingerprint,
    argsHash,
    parentIdx,
    // ── token 计量（2026-10-21，消费上游 ctx.tokenMeter）──
    // deltaTokens: 本次调用前后会话累计 token 的差值。null = 没测到（不是 0）。
    // tokenSource: 'tokenMeter' = 上游在位；null = 上游缺席，全部记 null。
    // ⚠️ 口径：这是"调用前后的累计差"，含该轮模型回复，不等于本次工具调用本身的计费额。
    deltaTokens: tokenInfo.deltaTokens ?? null,
    tokenSource: tokenInfo.tokenSource ?? null,
    args,
  };
  await appendFile(jsonlPath, JSON.stringify(record) + '\n', 'utf8');
}

async function readAllRecords(jsonlPath) {
  try {
    await stat(jsonlPath);
  } catch {
    return [];
  }
  let text;
  try {
    text = await readFile(jsonlPath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed lines */
    }
  }
  return out;
}

// ── 回填：用 session log 给 JSONL 补 callTs / latencyMs / turn / step / sessionId ──
//
// D1 迁移（2026-10-21）：原先 `loadSession(log.path)` 走本地 zstd 解压。
// 上游 `sessionQuery.readSession(id)` 直接给重放校验过的事件流 ⇒ 不碰磁盘。
// 上游缺席时回落本地（经 session-source 注入的 readLocal）。
async function backfill(sessionsRoot, jsonlPath, sessionSource = null) {
  const records = await readAllRecords(jsonlPath);
  if (records.length === 0) return { records: 0, updated: 0, unmatched: 0, sessions: 0 };

  // 1. 索引所有 session log（中立提取器：v3 + jsonl 双格式、同会话去重）
  const callIdx = new Map();
  const logs = await listSessionLogs(sessionsRoot);
  for (const log of logs) {
    let events;
    // 优先走 sessionSource.readEvents（上游优先）；没有则回落 loadSession
    if (sessionSource) {
      const read = await sessionSource.readEvents({
        dir: log.sessionId, path: log.path, upstream: true,
      });
      events = read.events;
    } else {
      try { events = await loadSession(log.path); } catch { continue; }
    }
    for (const rec of extractToolCalls(events, { sessionId: log.sessionId })) {
      const cid = rec.callId;
      if (!cid || callIdx.has(cid)) continue;
      callIdx.set(cid, {
        callTs: rec.ts ?? null,
        turn: rec.turn ?? null,
        step: rec.step ?? null,
        sessionId: log.sessionId,
      });
    }
  }

  // 2. 关联 + 回填
  let updated = 0;
  let unmatched = 0;
  for (const r of records) {
    const cid = r.callId;
    if (!cid || !callIdx.has(cid)) {
      unmatched++;
      continue;
    }
    const meta = callIdx.get(cid);
    let changed = false;
    if (r.callTs == null && meta.callTs != null) { r.callTs = meta.callTs; changed = true; }
    if (r.latencyMs == null && r.callTs != null && r.ts != null && r.ts >= r.callTs) {
      r.latencyMs = r.ts - r.callTs;
      changed = true;
    }
    if (r.turn == null && meta.turn != null) { r.turn = meta.turn; changed = true; }
    if (r.step == null && meta.step != null) { r.step = meta.step; changed = true; }
    if (!r.sessionId && meta.sessionId) { r.sessionId = meta.sessionId; changed = true; }
    if (changed) updated++;
  }

  // 3. 写回（tmp + rename，atomic）
  const tmpPath = jsonlPath + '.tmp';
  const lines = records.map((r) => JSON.stringify(r));
  await writeFile(tmpPath, lines.join('\n') + '\n', 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmpPath, jsonlPath);

  return { records: records.length, updated, unmatched, sessions: logs.length };
}

export { Config, apply, inject, name, backfill };