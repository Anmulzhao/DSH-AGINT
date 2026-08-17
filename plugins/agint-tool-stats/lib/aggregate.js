/**
 * agint-tool-stats aggregate: pure functions over JSONL records.
 *
 * Each record (one line of agint_tool_stats.jsonl):
 *   { ts, sessionId, turn, step, tool, callId, latencyMs, ok, errorKind,
 *     argFingerprint, args }
 *
 * No I/O, no side effects — pure arithmetic on the parsed array. The host
 * service reads/writes the file; this module only computes.
 */

const DAY_MS = 86400000;

export function parseSince(since, nowMs = Date.now()) {
  if (typeof since !== 'string') return 0;
  const m = /^(\d+)([smhd])$/.exec(since.trim());
  if (!m) return 0;
  const n = +m[1];
  const unit = m[2];
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : DAY_MS;
  return nowMs - n * mult;
}

/**
 * Aggregate records → per-tool summary.
 * Returns: [{ tool, calls, failRate, avgMs, p95Ms }]
 * Sorted by calls desc.
 */
export function summarize(records, opts = {}) {
  const sinceMs = opts.sinceMs ?? parseSince(opts.since);
  const filtered = sinceMs ? records.filter((r) => r.ts >= sinceMs) : records;
  const byTool = new Map();
  for (const r of filtered) {
    if (!byTool.has(r.tool)) byTool.set(r.tool, []);
    byTool.get(r.tool).push(r);
  }
  const out = [];
  for (const [tool, recs] of byTool) {
    const calls = recs.length;
    const fails = recs.filter((r) => !r.ok).length;
    const latencies = recs.map((r) => r.latencyMs ?? 0).sort((a, b) => a - b);
    const sum = latencies.reduce((a, b) => a + b, 0);
    const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : 0;
    out.push({
      tool,
      calls,
      failRate: calls ? +(fails / calls).toFixed(4) : 0,
      avgMs: calls ? +(sum / calls).toFixed(1) : 0,
      p95Ms: +p95.toFixed(1),
    });
  }
  out.sort((a, b) => b.calls - a.calls);
  return out;
}

/** Top N slowest tools by p95. */
export function slowest(summary, limit = 5) {
  return [...summary].sort((a, b) => b.p95Ms - a.p95Ms).slice(0, limit);
}

/** Top N highest failure-rate tools (with >= 3 calls to avoid noise). */
export function failureRate(summary, limit = 5, minCalls = 3) {
  return summary
    .filter((s) => s.calls >= minCalls)
    .sort((a, b) => b.failRate - a.failRate)
    .slice(0, limit);
}

/** Bucketized time series for one tool. bucket ∈ {'1h','1d'}. */
export function timeseries(records, tool, opts = {}) {
  const sinceMs = opts.sinceMs ?? parseSince(opts.since);
  const bucketMs = opts.bucket === '1h' ? 3600000 : DAY_MS;
  const filtered = records.filter((r) => r.ts >= sinceMs && r.tool === tool);
  const buckets = new Map();
  for (const r of filtered) {
    const key = Math.floor(r.ts / bucketMs) * bucketMs;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, recs]) => ({
      ts,
      calls: recs.length,
      failRate: +(recs.filter((r) => !r.ok).length / recs.length).toFixed(4),
      avgMs: +(recs.reduce((n, r) => n + (r.latencyMs ?? 0), 0) / recs.length).toFixed(1),
    }));
}

/** Detect repeated call patterns grouped by (tool + argFingerprint). */
export function repeatPatterns(records, opts = {}) {
  const minRepeats = opts.minRepeats ?? 3;
  const sinceMs = opts.sinceMs ?? parseSince(opts.since);
  const maxResults = opts.maxResults ?? 10;
  const filtered = sinceMs ? records.filter((r) => r.ts >= sinceMs) : records;
  const groups = new Map();
  for (const r of filtered) {
    const key = `${r.tool}::${r.argFingerprint}`;
    if (!groups.has(key)) {
      groups.set(key, { tool: r.tool, fingerprint: r.argFingerprint, sampleArgs: r.args, hits: [], sessions: new Set() });
    }
    const g = groups.get(key);
    g.hits.push(r.ts);
    g.sessions.add(r.sessionId);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.hits.length < minRepeats) continue;
    g.hits.sort((a, b) => a - b);
    const span = g.hits[g.hits.length - 1] - g.hits[0];
    const avgIntervalMs = span / Math.max(1, g.hits.length - 1);
    const frequency = Math.min(1, g.hits.length / 10);
    const diversity = Math.min(1, g.sessions.size / 5);
    out.push({
      fingerprint: (g.fingerprint ?? '').slice(0, 12),
      tool: g.tool,
      sampleArgs: g.sampleArgs,
      count: g.hits.length,
      sessions: [...g.sessions],
      firstSeen: g.hits[0],
      lastSeen: g.hits[g.hits.length - 1],
      avgIntervalMs: Math.round(avgIntervalMs),
      suggestedSkillName: suggestName(g.tool, g.sampleArgs),
      confidence: +(0.6 * frequency + 0.4 * diversity).toFixed(2),
    });
  }
  out.sort((a, b) => b.confidence - a.confidence || b.count - a.count);
  return out.slice(0, maxResults);
}

function suggestName(tool, args) {
  if (tool === 'bash' && typeof args?.command === 'string') {
    const m = args.command.trim().split(/\s+/);
    const verb = (m[0] ?? 'cmd').replace(/[^a-z]/gi, '');
    const target = (m[1] ?? '').split('/').filter(Boolean).pop()?.replace(/[^a-z0-9]/gi, '') ?? '';
    return `${verb}-${target}`.toLowerCase().slice(0, 32) || 'bash-utility';
  }
  if (tool && args?.provider) return `inspect-${String(args.provider).toLowerCase()}`.slice(0, 32);
  return `${tool ?? 'unknown'}-pattern`.toLowerCase().slice(0, 32);
}

/** Stable stringify: same semantic object → same string regardless of key order. */
export function stableStringify(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** Classify a tool/result into error kind. Best-effort: text scan. */
export function classifyError(tool, resultText) {
  if (!resultText) return null;
  // Specific patterns first, generic "error" last.
  if (/sandbox: file access denied/i.test(resultText)) return 'sandbox';
  if (/exit code: [1-9]/.test(resultText)) return 'exit_nonzero';
  if (/approval.*reject|denied.*approval/i.test(resultText)) return 'denied';
  // Generic check: only flag if not already classified and text starts with error-ish prefix.
  const head = resultText.slice(0, 200);
  if (/^\s*(\{?\s*"error"\s*:|Error:|TypeError:|ReferenceError:|SyntaxError:|throw\s)/i.test(head)) {
    return 'exception';
  }
  return null;
}

/** Classify ok/err from a result message. */
export function classifyOk(resultMessage) {
  if (!resultMessage) return false;
  const text = JSON.stringify(resultMessage);
  if (/sandbox: file access denied|exit code: [1-9]|approval.*reject|denied.*approval/i.test(text)) return false;
  if (/^\s*\{?\s*"error"\s*:/i.test(text)) return false;
  return true;
}