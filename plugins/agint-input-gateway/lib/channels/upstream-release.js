/**
 * C3 外部世界 Channel — 上游发行子源（P2，2026-10-28）。
 *
 * ## 它补的是哪个洞
 *
 * C3 这个 channel 类型从 v0.1 就有，但只挂了一个 `external-git` —— 而且它读的是**本地**
 * 仓库 HEAD（`external-git.js` 明确写着「不做网络 fetch」），且从未启用。也就是说：
 * AGINT 能感知自己（C2）、能接受挑战（C4）、能跨 agent 取经（C5），
 * **却感知不到养它的那一层在变**。
 *
 * dsh 的出片节奏是 1–2 天一个版本，破坏性变更直接决定 AGINT 装不装得上、起来了功能全不全。
 * 现状是等老板读到 changelog 再转告。人是单点，且注意力不保证。
 *
 * ## 职责边界（只做两件事）
 *
 *   1. 拉：GitHub Releases（变更说了什么）+ npm dist-tags（现在装得到什么）
 *   2. 报：只发「有哪个新版本」这一条元信息信号，**不判读**
 *
 * ⛔ **不判读、不产提案** —— 那是 `agint-upstream-watch` 的事。判读需要判断力，
 *    混进频道会让「拉取失败」和「这次变动不重要」长得一样（设计方案 §3 C2）。
 * ⛔ **payload 只放元信息** —— 管线有 2 KB 上限（DEFAULTS.payloadMaxBytes），
 *    changelog 全文必然被截断，截断后的半截文本比没有更危险。全文由判读器按 url 另取。
 *
 * ## 为什么两个源都要
 *
 * 两者会不一致。2026-10-28 实测：GitHub 最新是 `0.2.2-alpha.2`，
 * 而 npm 的 `latest` 标签仍是 `0.2.1-rc.2`（alpha 走 `alpha` 轨）。
 * 只看 GitHub 会误以为「装 latest 就能拿到」；只看 npm 会漏掉刚发的预发布版。
 *
 * ## 为什么首次运行不产信号
 *
 * 与 `external-git.js` 同构：第一次跑只记基线。否则上线当天会把 20 个历史版本
 * 一次性打成新信号，把整条下游（记忆/判读/提案）淹掉。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CHANNEL_TYPES } from '../schema.js';

/** 上游仓库。要跟踪别的项目时改这里，不需要动逻辑。 */
export const UPSTREAM_REPO = 'deepseek-ai/deepseek-harness';
/** npm 上看 dist-tags 的包（dsh 主包，只取标签不下载）。 */
export const UPSTREAM_NPM_PKG = '@deepseek-ai/dsh';
/** 首次最多取多少个 release。10 个够覆盖约两周的出片节奏，也不会让首跑太慢。 */
const RELEASES_PER_PAGE = 10;
/** 单次 HTTP 超时。gateway 外层还有 30s 的 fetch 总超时，这里必须更短才有意义。 */
const HTTP_TIMEOUT_MS = 12_000;

/**
 * breaking 关键词表。
 *
 * ⛔ 只用来**提高关注度**，不用来下结论 —— 它同时是误报源。
 *    2026-10-28 实证：`0.2.2-alpha.2` 写「插件需迁移 tools.resolve/executable」，
 *    按关键词是重度风险；实测 `ctx.tools.register(def)` 只是新增一个可选第二参，
 *    `defineTool` 的 options 一字未变，140 处调用零改动。
 *    结论必须由判读器的实测段给出（设计方案 §6-1）。
 */
const BREAKING_PATTERNS = [
  /破坏性/, /BREAKING/i, /需迁移/, /不再允许/, /已移除/, /移除(了|该)/,
  /改名/, /更名/, /minimum/i, /最低/, /engines/i, /协议\s*\d/i, /必须同步升级/,
];

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function stateFile() {
  return join(dshHome(), 'storages', 'agint_input_gateway_release_state.json');
}

function loadState() {
  try {
    if (!existsSync(stateFile())) return { seenTags: [], lastCheckedAt: null };
    const raw = JSON.parse(readFileSync(stateFile(), 'utf8'));
    return {
      seenTags: Array.isArray(raw.seenTags) ? raw.seenTags : [],
      lastCheckedAt: raw.lastCheckedAt ?? null,
    };
  } catch {
    // 状态文件坏了不阻断：当作从没跑过（下次仍按基线处理，不会误报）
    return { seenTags: [], lastCheckedAt: null, stateCorrupted: true };
  }
}

function saveState(state) {
  try {
    const dir = join(dshHome(), 'storages');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // 只留最近 200 个 tag，防止无限增长
    const trimmed = {
      seenTags: [...new Set(state.seenTags)].slice(-200),
      lastCheckedAt: state.lastCheckedAt ?? new Date().toISOString(),
    };
    writeFileSync(stateFile(), JSON.stringify(trimmed, null, 2), 'utf8');
  } catch { /* 软降级：状态写不进去最多让下次重复报同一个版本，不会丢数据 */ }
}

/** 带超时的 GET。返回 { ok, status, json, error }，从不抛。 */
async function httpJson(url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: {
        // ⛔ GitHub API 强制要求 User-Agent，缺了直接 403
        'user-agent': 'agint-input-gateway/upstream-release',
        accept: 'application/vnd.github+json',
        ...headers,
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, json: await res.json() };
  } catch (e) {
    // 网络不可用 / DNS 失败 / 超时，一律落到这里
    const msg = e?.name === 'TimeoutError'
      ? `timeout after ${HTTP_TIMEOUT_MS}ms`
      : (e?.message ?? String(e));
    return { ok: false, status: 0, error: msg };
  }
}

/**
 * 统计 release body 里的条目数与 breaking 命中数。
 *
 * body 是**双语**的（中文段 + 英文段，同一个 release 在页面里重复一遍），
 * 直接全篇统计会把每个条目数成两倍 —— 所以切在英文段起点。切不到就说明只有单语，全篇算。
 */
export function summarizeBody(body) {
  const text = String(body ?? '');
  if (!text.trim()) return { entryCount: 0, breakingHits: 0, sectionCount: 0 };

  // 英文段标志：<h3 id="en-..."> 。取最早出现的那个位置。
  const enIdx = text.search(/<h3[^>]*id="en-/i);
  const cnPart = enIdx > 0 ? text.slice(0, enIdx) : text;

  const lines = cnPart.split(/\r?\n/);
  let entryCount = 0;
  let breakingHits = 0;
  let sectionCount = 0;
  for (const line of lines) {
    if (/^<h3[^>]*>/i.test(line.trim())) { sectionCount += 1; continue; }
    const t = line.trim();
    if (!t.startsWith('- ')) continue;
    entryCount += 1;
    const content = t.slice(2);
    if (BREAKING_PATTERNS.some((re) => re.test(content))) breakingHits += 1;
  }
  return { entryCount, breakingHits, sectionCount };
}

/** 从 release body 里抽一句摘要（第一个条目的前 120 字），日志与面板用。 */
function firstEntry(body) {
  const text = String(body ?? '');
  const enIdx = text.search(/<h3[^>]*id="en-/i);
  const cnPart = enIdx > 0 ? text.slice(0, enIdx) : text;
  for (const line of cnPart.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('- ')) {
      return t.slice(2).replace(/[*`<>]/g, '').slice(0, 120);
    }
  }
  return '';
}

export const upstreamReleaseChannel = {
  id: 'upstream-release',
  type: CHANNEL_TYPES.EXTERNAL,
  cron: '0 6 * * *',

  async fetch(_ctx) {
    const prev = loadState();
    const seen = new Set(prev.seenTags);
    const firstRun = seen.size === 0;

    // ── 源 1：GitHub Releases ────────────────────────────────────────────
    const rel = await httpJson(
      `https://api.github.com/repos/${UPSTREAM_REPO}/releases?per_page=${RELEASES_PER_PAGE}`,
    );

    // ── 源 2：npm dist-tags ──────────────────────────────────────────────
    // 失败只降级本字段：GitHub 成功就还能报「有什么新版本」，
    // 只是不知道「现在装得到哪个」。⛔ 不因此整体失败。
    const npm = await httpJson(
      `https://registry.npmjs.org/${encodeURIComponent(UPSTREAM_NPM_PKG).replace('%40', '@')}`,
      { accept: 'application/json' },
    );
    const versionTracks = npm.ok && npm.json?.['dist-tags']
      ? {
          latest: npm.json['dist-tags'].latest ?? null,
          next: npm.json['dist-tags'].next ?? null,
          alpha: npm.json['dist-tags'].alpha ?? null,
        }
      : null;

    // 两个源都拿不到 ⇒ 抛错，由管线记 lastError。
    // ⛔ 绝不返回 [] 冒充「没有新版本」—— 那是 C5「无网必须声张」的反面。
    if (!rel.ok) {
      throw new Error(
        `upstream-release: GitHub releases 拉取失败（${rel.error}）`
        + (npm.ok ? '' : `；npm dist-tags 同样失败（${npm.error}）`),
      );
    }

    const releases = Array.isArray(rel.json) ? rel.json : [];
    const signals = [];
    const newTags = [];

    for (const r of releases) {
      const tag = String(r?.tag_name ?? '').trim();
      if (!tag) continue;
      newTags.push(tag);
      if (seen.has(tag)) continue;

      // 首次运行：只建基线，不产信号（与 external-git.js:127 同构）
      if (firstRun) continue;

      const sum = summarizeBody(r?.body);
      signals.push({
        signalId: `release-${tag}`,
        source: 'upstream:dsh',
        signalType: 'release.published',
        payload: {
          tag,
          name: String(r?.name ?? tag).slice(0, 80),
          // 预发布标记很关键：alpha/rc 与正式版的处置策略不同
          prerelease: r?.prerelease === true,
          publishedAt: r?.published_at ?? null,
          url: String(r?.html_url ?? '').slice(0, 200),
          entryCount: sum.entryCount,
          breakingHits: sum.breakingHits,
          sectionCount: sum.sectionCount,
          headline: firstEntry(r?.body),
          versionTracks,
        },
        // 信号本身几乎不会错（版本号是事实），但「值不值得管」是判读器的事
        confidence: 0.95,
        relevance: 0.8,
        occurredAt: r?.published_at ?? new Date().toISOString(),
        rawRef: r?.html_url ?? `${UPSTREAM_REPO}@${tag}`,
      });
    }

    saveState({
      seenTags: [...seen, ...newTags],
      lastCheckedAt: new Date().toISOString(),
    });

    return signals;
  },

  async health() {
    const state = loadState();
    // 探一次 npm，只为回答「网络通不通」，不产副作用
    const npm = await httpJson(
      `https://registry.npmjs.org/${encodeURIComponent(UPSTREAM_NPM_PKG).replace('%40', '@')}`,
      { accept: 'application/json' },
    );
    const tracks = npm.ok && npm.json?.['dist-tags']
      ? npm.json['dist-tags']
      : null;
    return {
      channelId: this.id,
      status: state.seenTags.length === 0 ? 'baseline-pending' : (tracks ? 'ok' : 'degraded'),
      upstream: UPSTREAM_REPO,
      seenTagCount: state.seenTags.length,
      lastCheckedAt: state.lastCheckedAt,
      latestSeen: state.seenTags.slice(-1)[0] ?? null,
      versionTracks: tracks,
      npmReachable: npm.ok,
      stateCorrupted: state.stateCorrupted === true,
      note: 'P2：只发「有新版本」元信息，不判读；首次运行只建基线不产信号',
    };
  },
};
