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

import { resolve as resolvePath } from 'node:path';
import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
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
  ctx.on('session/created', (session) => {
    currentSessionId = session?.id ?? session?.sessionId ?? null;
  });

  // ── 核心：监听 tools/result（emit 模式，只追加写） ──
  // 签名：'(exec: ToolExecution, result: ToolExecutionResult) => undefined'
  // emit 模式无 next()，不能修改结果。Listener failures are contained.
  ctx.on('tools/result', (exec, result) => {
    writeQueue = writeQueue
      .then(() => persist(exec, result, currentSessionId, jsonlPath))
      .catch((err) => {
        console.error('agint-tool-stats: persist failed', err.message);
      });
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
      return backfill(root, jsonlPath);
    },
  };

  ctx.provide('agint.toolStats', toolStats);

  // ── 注册 model-visible 工具（让模型能在会话中调 summary） ──
  ctx.tools.register(defineTool({
    name: 'tool_stats_summary',
    description:
      '查询最近一段时间内 DSH 工具使用画像：每个工具的调用次数、失败率、平均延迟、p95 延迟。' +
      '数据来源：~/.dsh/storages/agint_tool_stats.jsonl（由 agint-tool-stats 插件持续追加）。' +
      '典型用法：会话结束看一眼本周的工具表现，定位失败率高/延迟高的工具。' +
      `限速：${5}/小时（防失控）。超限会抛错，可直接读 JSONL 文件获取原始数据。`,
    parameters: {
      since: { type: 'string', description: '时间窗口，支持 s/m/h/d 后缀（如 "1h"、"7d"）；省略 = 全部' },
      limit: { type: 'number', description: '返回最多多少条（默认 20，按 calls 降序）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          summary: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
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

async function persist(exec, result, sessionId, jsonlPath) {
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
const execFileAsync = promisify(execFile);

async function readSessionEvents(zstdPath) {
  try {
    const { stdout } = await execFileAsync('zstd', ['-dc', zstdPath], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
    const out = [];
    for (const line of stdout.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function buildCallIndex(events) {
  const idx = new Map();
  for (const e of events) {
    if (e?.type !== 'tool/call') continue;
    const d = e.data || {};
    const cid = d.callId;
    if (!cid) continue;
    if (!idx.has(cid)) {
      idx.set(cid, {
        callTs: e.time ?? null,
        turn: d.turn ?? null,
        step: d.step ?? null,
        sessionId: idx.sessionId ?? null,
      });
    }
  }
  return idx;
}

async function listSessionLogs(sessionsRoot) {
  const { readdir } = await import('node:fs/promises');
  const logs = [];
  try {
    const workspaces = await readdir(sessionsRoot, { withFileTypes: true });
    for (const ws of workspaces) {
      if (!ws.isDirectory()) continue;
      const wsDir = `${sessionsRoot}/${ws.name}`;
      let sessionDirs;
      try {
        sessionDirs = await readdir(wsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dir of sessionDirs) {
        if (!dir.isDirectory()) continue;
        const zstdPath = `${wsDir}/${dir.name}/session.jsonl.zstd`;
        try {
          await stat(zstdPath);
          logs.push({ path: zstdPath, sessionId: dir.name });
        } catch {
          continue;
        }
      }
    }
  } catch {
    return [];
  }
  return logs;
}

async function backfill(sessionsRoot, jsonlPath) {
  const records = await readAllRecords(jsonlPath);
  if (records.length === 0) return { records: 0, updated: 0, unmatched: 0, sessions: 0 };

  // 1. 索引所有 session log
  const callIdx = new Map();
  const logs = await listSessionLogs(sessionsRoot);
  for (const log of logs) {
    const events = await readSessionEvents(log.path);
    const local = buildCallIndex(events);
    for (const [cid, meta] of local) {
      if (!callIdx.has(cid)) {
        callIdx.set(cid, { ...meta, sessionId: log.sessionId });
      }
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