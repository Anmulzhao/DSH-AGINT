/**
 * C5 跨 Agent Channel（v0.3.0）。
 *
 * 三个子源（全部软依赖，失败互不连坐，不抛错不阻塞）：
 *   a) OpenViking 跨 Agent 检索 — 经 agint.ovStrategy.recall（R1 单缝原则，
 *      不直连 openvikingMemory），检索 OV 中其他 Agent/preset 的知识，
 *      对比本地已见条目 → 增量差异信号 cross-agent.diff。
 *   b) 会话聚类 — 扫描 DSH_HOME/sessions/<workspace>/ 近 7 天会话，
 *      按 workspace 聚类：多 workspace 同时活跃 / 单 workspace 会话激增
 *      → 模式信号 cross-agent.pattern（跨 preset 协同/重复劳动可见化）。
 *   c) 跨 preset 同步差异 — 结合 OV 检索结果（entries 的 source 字段）
 *      与本机 workspace 列表，输出"有哪些外部 preset 知识可同步"的
 *      只读概览（不写 OV，不写 preset —— 同步动作留给 agent 决策）。
 *
 * 约束：
 *   - R1 单缝：OV 访问只经 agint.ovStrategy（软依赖 ctx.get，调用时取）。
 *   - 会话聚类只读 ~/.dsh/sessions，不做任何修改。
 *   - 增量状态存 DSH_HOME/storages/agint_input_gateway_cross_agent_state.json。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CHANNEL_IDS, CHANNEL_TYPES, C5_CRON } from '../schema.js';

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function stateFile() {
  return join(dshHome(), 'storages', 'agint_input_gateway_cross_agent_state.json');
}

function loadState() {
  try {
    if (!existsSync(stateFile())) return {};
    return JSON.parse(readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    const dir = join(dshHome(), 'storages');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8');
  } catch { /* 软降级 */ }
}

// ── 会话文件命名（v3/v4 双格式并存时都收，jsonl 兜底）───────────────────
const SESSION_FILE_NAMES = Object.freeze([
  'session.v4.jsonl.zstd',
  'session.v3.jsonl.zstd',
  'session.jsonl.zstd',
]);

/** 扫描 sessions root，返回近 recentDays 天有会话的 workspace 统计 */
function scanWorkspaces(recentDays = 7) {
  const root = join(dshHome(), 'sessions');
  let workspaces;
  try { workspaces = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const cutoff = Date.now() - recentDays * 24 * 60 * 60 * 1000;
  const out = [];
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const wsDir = join(root, ws.name);
    let dirs;
    try { dirs = readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    let recentSessions = 0;
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dirPath = join(wsDir, d.name);
      for (const fname of SESSION_FILE_NAMES) {
        const p = join(dirPath, fname);
        try {
          if (statSync(p).mtimeMs > cutoff) { recentSessions += 1; break; }
        } catch { /* 该格式不存在 */ }
      }
    }
    if (recentSessions > 0) out.push({ workspace: ws.name, recentSessions });
  }
  return out;
}

// ── 子源 a：OpenViking 跨 Agent 检索（软依赖 agint.ovStrategy）───────────
async function ovCrossAgentDiff(ctx, state) {
  const ov = typeof ctx?.get === 'function' ? ctx.get('agint.ovStrategy') : null;
  if (!ov || typeof ov.recall !== 'function') {
    return { skipped: true, reason: 'agint.ovStrategy not mounted' };
  }
  const query = '其他 Agent preset 近期沉淀的经验 决策 教训 知识 待办';
  const res = await ov.recall(query);
  if (!res?.ok || !Array.isArray(res.entries) || res.entries.length === 0) {
    return { skipped: true, reason: res?.reason || 'ov-recall-empty' };
  }
  const seenIds = Array.isArray(state.seenEntryIds) ? new Set(state.seenEntryIds) : new Set();
  const fresh = res.entries.filter((e) => {
    const id = e?.id ?? e?.uri ?? e?.hash ?? JSON.stringify(e).slice(0, 64);
    return !seenIds.has(id);
  }).slice(0, 5);
  // 更新已见集合（保留最近 100 条，防无限增长）
  const nowIds = res.entries
    .map((e) => e?.id ?? e?.uri ?? e?.hash ?? JSON.stringify(e).slice(0, 64))
    .filter(Boolean);
  state.seenEntryIds = [...new Set([...(seenIds.size > 80 ? [] : seenIds), ...nowIds])].slice(-100);
  if (fresh.length === 0) return { skipped: true, reason: 'no-new-entries' };
  return {
    entries: fresh,
    topHits: fresh.slice(0, 3).map((e) => ({
      id: e?.id ?? e?.uri ?? null,
      title: typeof e?.title === 'string' ? e.title.slice(0, 200) : null,
      source: typeof e?.source === 'string' ? e.source.slice(0, 80) : null,
    })),
  };
}

// ── 子源 b：会话聚类（跨 workspace / 跨 preset 模式）──────────────────────
function sessionClustering(recentDays = 7) {
  const workspaces = scanWorkspaces(recentDays);
  if (workspaces.length === 0) return { skipped: true, reason: 'no-sessions' };
  const active = workspaces.filter((w) => w.recentSessions > 0);
  const total = active.reduce((s, w) => s + w.recentSessions, 0);
  const patterns = [];
  if (active.length >= 2) {
    patterns.push(`近 ${recentDays} 天有 ${active.length} 个 workspace 同时活跃（${active.map((w) => `${w.workspace}×${w.recentSessions}`).join('、')}）`);
  }
  const max = active.reduce((a, b) => (b.recentSessions > a.recentSessions ? b : a), active[0]);
  if (max && max.recentSessions >= 5) {
    patterns.push(`workspace ${max.workspace} 近 ${recentDays} 天会话 ${max.recentSessions} 个（偏高）`);
  }
  if (patterns.length === 0) return { skipped: true, reason: 'no-pattern' };
  return { workspaces: active, totalSessions: total, patterns };
}

// ── 子源 c：跨 preset 同步差异概览（只读）─────────────────────────────────
function crossPresetDiff(ovDiff) {
  if (!ovDiff || ovDiff.skipped) return null;
  const sources = {};
  for (const e of ovDiff.entries) {
    const src = typeof e?.source === 'string' ? e.source : '(unknown)';
    sources[src] = (sources[src] || 0) + 1;
  }
  return { sources, note: 'OV 检索到外部 preset 知识条目，同步动作由 agent 决策（本通道只读）' };
}

export const crossAgentChannel = {
  id: CHANNEL_IDS.CROSS_AGENT,
  type: CHANNEL_TYPES.CROSS_AGENT,
  cron: C5_CRON,

  async fetch(ctx) {
    const state = loadState();
    const signals = [];

    // a) OV 跨 Agent 差异
    let ovDiff;
    try {
      ovDiff = await ovCrossAgentDiff(ctx, state);
    } catch {
      ovDiff = { skipped: true, reason: 'ov-recall-error' };
    }
    if (!ovDiff.skipped) {
      signals.push({
        signalId: `cross-agent-diff-${Date.now()}`,
        source: 'openviking',
        signalType: 'cross.agent.diff',
        payload: {
          newEntryCount: ovDiff.entries.length,
          topHits: ovDiff.topHits,
          note: `OpenViking 检索到 ${ovDiff.entries.length} 条跨 Agent 新知识（来源: ${(ovDiff.topHits || []).map((t) => t.source ?? '?').filter(Boolean).join('、') || '多源'}）`,
        },
        confidence: 0.5,
        relevance: 0.6,
        occurredAt: new Date().toISOString(),
        rawRef: 'openviking://search',
      });
    }

    // b) 会话聚类
    let cluster;
    try {
      cluster = sessionClustering(7);
    } catch {
      cluster = { skipped: true, reason: 'cluster-error' };
    }
    if (!cluster.skipped) {
      signals.push({
        signalId: `cross-agent-pattern-${Date.now()}`,
        source: 'sessions',
        signalType: 'cross.agent.pattern',
        payload: {
          workspaces: cluster.workspaces,
          totalSessions: cluster.totalSessions,
          patterns: cluster.patterns,
          note: cluster.patterns.join('；'),
        },
        confidence: 0.6,
        relevance: 0.6,
        occurredAt: new Date().toISOString(),
        rawRef: join(dshHome(), 'sessions'),
      });
    }

    // c) 跨 preset 同步差异概览（只读；随 diff 信号附带）
    const sync = crossPresetDiff(ovDiff);
    if (sync && signals.length > 0) {
      signals[0].payload.syncOverview = sync;
    }

    saveState(state);
    return signals;
  },

  async health() {
    const ov = null; // fetch 时经 ctx 取；health 无法拿 ctx，如实标 unknown
    return {
      channelId: this.id,
      status: 'ok',
      subSources: 3,
      note: `v0.3: OV 检索(soft) + 会话聚类 + 跨 preset 只读差异；OV 可用性见 fetch 结果（health 无法取 ctx）`,
      ovAvailableAtHealth: Boolean(ov),
    };
  },
};
