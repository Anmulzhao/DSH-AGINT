/**
 * agint-upstream-watch —— 上游判读器（2026-10-28）。
 *
 * ## 它补的是哪个洞
 *
 * AGINT 有五类信息 Channel，`external` 那一类是空的（只挂了一个读本地 git 的源）。
 * 也就是说它能感知自己（C2）、能接受挑战（C4）、能跨 agent 取经（C5），
 * **却感知不到养它的那一层在变**。dsh 的出片节奏是 1–2 天一个版本，
 * 破坏性变更直接决定 AGINT 装不装得上、起来了功能全不全。
 *
 * 本插件接在 C3 新子源（`upstream-release` 频道）后面，把「有新版本了」这条信号
 * 变成「这对 AGINT 意味着什么」+「要不要动」。
 *
 * ## 两段式（设计方案 §3 C3）
 *
 *   段 1 确定性（`facts.js`）：版本语义、条目统计、**依赖面实测**（拉 npm tarball 比 .d.ts）→ 产事实
 *   段 2 LLM（`judge.js`）：读事实下结论 → 可失败
 *
 * ⛔ 模型挂了只落事实、不落结论、不产提案。这不是「降级」（拿启发式冒充结论），
 *    而是「事实照记」—— 两者必须分清。
 *
 * ## 边界（三件事不做）
 *
 *   1. 不装、不升 dsh —— 宿主环境动作，AGENTS.md 红线
 *   2. 不自动执行 —— 所有提案 `autoExecutable: false`（v0.17.0 的语义闸不可强穿）
 *   3. 不判读未实测的包 —— 拿不到 tarball 就记 `unknown`，不猜 `compatible`
 *
 * ## 安全开关
 *
 *   AGINT_UPSTREAM_WATCH=off      —— 整体停摆（订阅保留但不处理）
 *   config.autoPropose=false      —— 只落事实，不写提案台账
 *   config.maxProposalsPerRelease —— 单版本提案上限（默认 2，防刷屏）
 */

import { collectFacts, summarizeFacts } from './facts.js';
import { judgeFacts } from './judge.js';
import { spec, emptyConfig } from './storage.js';
import { registerTools } from './tools.js';

const name = 'agint-upstream-watch';

/**
 * `agint.eventBus.subscribe` 是必填注入：订阅是这个插件的入口，
 * 没有它整套东西只能手动触发 —— 那就不叫「自己跟踪」了。
 *
 * `tools` 同样是必填：本插件注册两个工具，而 cordis 只把 inject 数组里声明过的服务
 * 接到 ctx 上 —— 没声明就去访问 `ctx.tools`，宿主直接抛
 * `cannot get property "tools" without inject`，**整个 apply 失败、插件根本没挂上**。
 *
 * ⛔ 这不是假设，是 2026-10-28 首次部署的实况：本地单测全绿（假 ctx 什么都给），
 *    真宿主一启动就红，症状只有一行 `1 required plugin did not activate`。
 *    与 2026-10-27 `agint-executor` 漏写 `timer` 是同一个坑，隔一天又踩一次。
 *    判据：**凡是 ctx.xxx 访问到的服务，inject 里必须有它** —— 哪怕访问前做了空值判断。
 */
const inject = ['storageDomain', 'agint.eventBus.subscribe', 'tools'];

const KILL_ENV = 'AGINT_UPSTREAM_WATCH';
const TOPIC_RELEASE = 'input.signal.external.release-published';
const REPO_SLUG = 'deepseek-ai/deepseek-harness';

function readConfig(raw = {}) {
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  return {
    enabled: raw.enabled !== false,
    autoPropose: raw.autoPropose !== false,
    maxProposalsPerRelease: Math.max(0, Math.trunc(num(raw.maxProposalsPerRelease, 2))),
    provider: raw.provider || undefined,
    model: raw.model || undefined,
    reasoningEffort: raw.reasoningEffort || undefined,
    agentPreset: raw.agentPreset || undefined,
    timeoutMs: Math.max(5000, Math.trunc(num(raw.timeoutMs, 90_000))),
  };
}

/** 拉某个 tag 的 release 正文 */
async function fetchReleaseBody(tag, { timeoutMs = 15_000 } = {}) {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO_SLUG}/releases/tags/${encodeURIComponent(tag)}`, {
      headers: { 'user-agent': 'agint-upstream-watch', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const json = await res.json();
    return { ok: true, body: json?.body ?? '', meta: json };
  } catch (e) {
    return { ok: false, reason: e?.name === 'TimeoutError' ? `timeout ${timeoutMs}ms` : (e?.message ?? String(e)) };
  }
}

function apply(ctx, config) {
  const cfg = readConfig(config ?? {});
  const disabled = String(process.env[KILL_ENV] ?? '').toLowerCase() === 'off';

  let domain = null;
  let disposed = false;
  let unsubscribe = null;
  const stats = {
    signaled: 0,
    digested: 0,
    judged: 0,
    judgeFailed: 0,
    proposals: 0,
    skipped: 0,
    lastAt: null,
    lastError: null,
    lastTag: null,
  };

  ctx.effect(() => () => {
    disposed = true;
    if (unsubscribe) { try { unsubscribe(); } catch { /* ignore */ } }
    if (domain) { void domain.close().catch(() => {}); }
  });

  const ready = ctx.storageDomain.open(spec).then(
    (d) => { domain = d; return d; },
    (e) => {
      console.error(`[${name}] storageDomain open failed:`, e?.message ?? e);
      return null;
    },
  );

  const table = async (n) => {
    if (disposed) throw new Error(`${name}: disposed`);
    const d = await ready;
    if (!d) throw new Error(`${name}: domain unavailable`);
    return d.table(n);
  };

  const getEvolve = () => {
    try { return ctx.get('agint.evolve') || null; } catch { return null; }
  };

  /**
   * 判读一个版本。幂等：同 tag 已有 `judged` 记录时直接返回缓存，除非 force。
   */
  async function digest(tag, { body, versionTracks, force = false, via = 'unknown' } = {}) {
    if (disabled) return { ok: false, skipped: 'kill-switch' };
    if (!tag) return { ok: false, error: 'tag required' };

    const digests = await table('digests');
    const prev = digests.get(tag);
    if (prev && !force && (prev.llmStatus === 'judged' || prev.llmStatus === 'not-needed')) {
      stats.skipped += 1;
      return { ok: true, cached: true, digest: prev };
    }

    let bodyText = body;
    let meta = null;
    if (!bodyText) {
      const got = await fetchReleaseBody(tag);
      if (!got.ok) {
        stats.lastError = `fetch body failed: ${got.reason}`;
        return { ok: false, error: stats.lastError };
      }
      bodyText = got.body;
      meta = got.meta;
    }

    // ── 段 1：事实（永不失败，除非代码坏） ──
    let facts;
    try {
      facts = await collectFacts({
        signal: {
          tag,
          versionTracks: versionTracks ?? null,
        },
        body: bodyText,
        repoRoot: process.env.AGINT_REPO_ROOT || process.cwd(),
      });
    } catch (e) {
      stats.lastError = `collectFacts failed: ${e?.message ?? e}`;
      return { ok: false, error: stats.lastError };
    }

    const factsSummary = summarizeFacts(facts);

    // 释放记录（幂等，重复 fetch 不产副作用）
    try {
      const releases = await table('releases');
      await releases.put(tag, {
        tag,
        name: meta?.name ?? tag,
        publishedAt: meta?.published_at ?? null,
        prerelease: meta?.prerelease ?? null,
        url: meta?.html_url ?? null,
        entryCount: facts.body.entryCount,
        breakingHits: facts.body.breakingHits,
        versionTracks: facts.versionTracks,
        fetchedAt: new Date().toISOString(),
      });
    } catch (e) {
      // 释放记录失败不影响判读主链
      console.warn(`[${name}] releases.put failed: ${e?.message ?? e}`);
    }

    // ── 段 2：结论（可失败） ──
    let llmStatus = 'not-needed';
    let llmReason = null;
    let verdictObj = null;

    if (facts.triggered) {
      llmStatus = 'pending';
      const r = await judgeFacts(ctx, facts, {
        provider: cfg.provider,
        model: cfg.model,
        reasoningEffort: cfg.reasoningEffort,
        agentPreset: cfg.agentPreset,
        timeoutMs: cfg.timeoutMs,
        log: (m) => console.log(`[${name}] ${m}`),
      });
      if (r.ok) {
        llmStatus = 'judged';
        verdictObj = r.verdict;
        stats.judged += 1;
      } else {
        llmStatus = 'failed';
        llmReason = r.reason ?? 'unknown';
        stats.judgeFailed += 1;
        // ⛔ 不做启发式兜底。事实照落，结论留空，面板上能看出「有事实、无结论」。
        console.warn(`[${name}] judge failed for ${tag}: ${llmReason}`);
      }
    }

    // ── 产提案（只有拿到结论才产；且一律不可自动执行） ──
    const proposalIds = [];
    if (llmStatus === 'judged' && cfg.autoPropose && verdictObj?.proposals?.length) {
      const evolve = getEvolve();
      if (!evolve || typeof evolve.propose !== 'function') {
        llmReason = (llmReason ? `${llmReason}; ` : '') + 'agint.evolve 不可用，提案未落库';
      } else {
        const cap = Math.min(cfg.maxProposalsPerRelease, verdictObj.proposals.length);
        for (const p of verdictObj.proposals.slice(0, cap)) {
          try {
            const rec = await evolve.propose({
              title: String(p.title).slice(0, 120),
              body: [
                p.body,
                '',
                '## 上游事实（机器实测）',
                factsSummary,
                '',
                `- 发行版本：${tag}`,
                `- 判读结论：${verdictObj.verdict}（置信度 ${verdictObj.confidence}）`,
                `- 判读依据：${verdictObj.rationale}`,
                '',
                '## 说明',
                '本条由 agint-upstream-watch 自动产出。依赖升级属宿主环境动作，',
                'AGINT 不装不升 dsh（AGENTS.md 红线），因此本提案标记为不可自动执行，',
                '待人工判断后按流程处理。',
              ].join('\n'),
              category: p.category,
              source: `upstream-watch:${tag}`,
              // ⛔ 硬性 false：依赖升级永不自动执行
              autoExecutable: false,
              // 成立条件锚点：结论只在「dsh 就是这个版本」时成立
              assumedBy: `dsh ${tag}`,
            });
            if (rec?.id) proposalIds.push(rec.id);
          } catch (e) {
            stats.lastError = `propose failed: ${e?.message ?? e}`;
            console.warn(`[${name}] propose failed: ${e?.message ?? e}`);
          }
        }
        stats.proposals += proposalIds.length;
      }
    }

    const now = new Date().toISOString();
    const rec = {
      tag,
      targetVersion: facts.targetVersion,
      level: facts.level,
      preStageChange: facts.preStageChange,
      facts,
      factsSummary,
      llmStatus,
      llmReason,
      verdict: verdictObj?.verdict ?? null,
      confidence: verdictObj?.confidence ?? null,
      headline: verdictObj?.headline ?? null,
      rationale: verdictObj?.rationale ?? null,
      proposalIds,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    try {
      await digests.put(tag, rec);
    } catch (e) {
      stats.lastError = `digests.put failed: ${e?.message ?? e}`;
      return { ok: false, error: stats.lastError };
    }

    stats.digested += 1;
    stats.lastAt = now;
    stats.lastTag = tag;
    console.log(`[${name}] digest ${tag} (${via}): ${llmStatus} ${factsSummary}`);

    return { ok: true, digest: rec, via };
  }

  async function status() {
    const out = {
      plugin: name,
      disabled,
      config: {
        autoPropose: cfg.autoPropose,
        maxProposalsPerRelease: cfg.maxProposalsPerRelease,
        model: cfg.model ?? '(default)',
      },
      stats: { ...stats },
      digestCount: 0,
      byStatus: {},
      recent: [],
    };
    try {
      const digests = await table('digests');
      const rows = [...digests.entries()].map(([, r]) => r);
      out.digestCount = rows.length;
      for (const r of rows) {
        out.byStatus[r.llmStatus] = (out.byStatus[r.llmStatus] ?? 0) + 1;
      }
      out.recent = rows
        .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
        .slice(0, 5)
        .map((r) => ({
          tag: r.tag,
          level: r.level,
          llmStatus: r.llmStatus,
          verdict: r.verdict,
          headline: r.headline,
          factsSummary: r.factsSummary,
          updatedAt: r.updatedAt,
        }));
    } catch (e) {
      out.error = e?.message ?? String(e);
    }
    return out;
  }

  // ── 订阅上游发行信号 ──
  void ready.then(async (d) => {
    if (disposed || !d) return;

    // 加载持久化配置覆盖
    try {
      const cfgTable = d.table('config');
      const rec = cfgTable.get('config');
      if (rec) Object.assign(cfg, readConfig({ ...cfg, ...rec }));
    } catch { /* 配置表读不到就用默认 */ }

    let subscribe = null;
    try { subscribe = ctx.get('agint.eventBus.subscribe'); } catch { /* ignore */ }
    if (typeof subscribe !== 'function') {
      console.error(`[${name}] eventBus subscribe 不可用 —— 只能手动触发`);
      return;
    }

    try {
      unsubscribe = subscribe(
        { subscriber: name, topics: [TOPIC_RELEASE], mode: 'async' },
        async (envelope) => {
          if (disposed || disabled) return;
          stats.signaled += 1;
          const p = envelope?.payload ?? {};
          const tag = p.tag;
          if (!tag) return;
          try {
            await digest(tag, { versionTracks: p.versionTracks ?? null, via: 'event' });
          } catch (e) {
            stats.lastError = e?.message ?? String(e);
            console.error(`[${name}] digest on signal failed:`, stats.lastError);
          }
        },
      );
      console.log(`[${name}] subscribed ${TOPIC_RELEASE}`);
    } catch (e) {
      console.error(`[${name}] subscribe failed:`, e?.message ?? e);
    }
  });

  // ── Service ──
  ctx.provide('agint.upstreamWatch', {
    status,
    digest,
    runNow: (tag, opts) => digest(tag, { ...opts, force: true, via: 'manual' }),
    async listDigests({ limit = 20 } = {}) {
      const digests = await table('digests');
      return [...digests.entries()]
        .map(([, r]) => r)
        .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
        .slice(0, limit);
    },
  });

  // ── 工具 ──
  registerTools(ctx, {
    status,
    digest,
    runNow: (tag, opts) => digest(tag, { ...opts, force: true, via: 'manual' }),
  });
}

export { name, inject, apply };
