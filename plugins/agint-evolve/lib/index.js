/**
 * agint-evolve: host service plugin (provides `agint.evolve`).
 *
 * HOST plane, single instance: the review loop's data + proposal layer.
 *
 * - Reviews are markdown files under a configured root (default
 *   ${HOME}/projects/agint-dsh/reviews) — files stay human-readable and
 *   diff-able, same medium as the wiki.
 * - Proposals live in the `agint_evolve` storage domain (unique name, K12)
 *   so their status can be queried and updated across sessions.
 *
 * The intelligence stays in the model: dataSnapshot() gathers facts from the
 * agint-* services, writeReview() renders a review report with auto-detected
 * findings, and the session reads the report, proposes improvements
 * (evolve_propose), and tracks them (evolve_set_status). The Sunday cron job
 * `evolve-review` calls writeReview() automatically.
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-evolve
 *         name: ./plugins/agint-evolve/lib/index.js
 *         config:
 *           root: .../agint-dsh/reviews
 */

import { readFile, writeFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { findingsFromSnapshot, buildReport } from './report.js';

const name = 'agint-evolve';
const inject = ['storageDomain'];

const Config = z.object({
  root: z.string().min(1, 'agint-evolve: config.root is required'),
  // A4：eval 存量 FAIL 归因产物（`node bin/attribute-eval-fails.mjs --json` 的落盘产物）。
  // 可选 —— 不配就整章印「本周未采到」，⛔ 绝不印「0 个 FAIL」（K：没查 ≠ 没有）。
  // ⚠️ 路径在 apply() 里从 import.meta.url 推导（仓库根 = 插件所在 plugins/<name>/lib 的上两级），
  //    不用环境变量：cron 的 cwd 与宿主环境都不可靠（与 quality-sandbox 同款做法）。
  evalAttributionPath: z.string().min(1).optional(),
});

/**
 * 从本文件位置向上找**真实存在 `eval/` 的仓库根**。
 *
 * ⛔ 2026-10-04 部署位实测修正（A4 原实现的真缺陷）：
 *   原实现按固定层数 `new URL('../../../')` 推根，这隐含假设「插件住在**仓库**的
 *   plugins/ 下」。但宿主真正加载的是**部署位**那份：
 *     boot 源  ~/.dsh/.agint-bundle/plugins/agint-evolve/lib/index.js
 *     镜像位  ~/.dsh/profiles/web/plugins/agint-evolve/lib/index.js
 *   往上三级分别是 `.agint-bundle/` 与 `profiles/web/` —— **两处都没有 `eval/`**。
 *   ⇒ 固定层数在部署位必推错目录，周报永远印「本周未采到」，而且看不出是路径错
 *     还是真没数据（静默降级，正是本节要防的那类失败）。
 *
 * 改为**逐级向上探测 + 存在性判据**：命中含 `eval/` 的祖先才算找到。
 * 找不到就返回 null，让调用方把「路径没解析出来」当成一种**独立的可观测状态**
 * 报出来，而不是伪装成「没采到数据」。
 *
 * 不用环境变量、不用 cwd（K：cron 的 cwd 与宿主环境都不可靠）。
 * @returns {string|null} 仓库根绝对路径；探测不到返回 null
 * 导出供单测直接验「生产函数在当前所在位置的行为」——
 * ⛔ 只在测试里复算一遍算法不算数：复算的那份和生产的不是同一份代码。
 */
export function repoRootFromHere() {
  let dir = dirname(fileURLToPath(import.meta.url));
  // 最多向上 8 级：lib→插件→plugins→(仓库|bundle|profile)→…
  // 超過这个深度还没命中 eval/，基本可判定「此处不是仓库布局」，早停不空转。
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'eval'))) return dir;
    const up = dirname(dir);
    if (up === dir) break; // 到根了
    dir = up;
  }
  return null;
}

const proposalSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  category: z.enum(['rule', 'skill', 'doc', 'preset', 'service', 'plugin', 'other']).default('other'),
  status: z.enum(['proposed', 'applied', 'rejected', 'wontfix']).default('proposed'),
  source: z.string().default(''),
  note: z.string().default(''),
  createdAt: z.string().default(() => new Date().toISOString()),
  updatedAt: z.string().default(() => new Date().toISOString()),
});

// Sprint 12 B3: baseline_history 表由 cron `baseline-regression-suite` 写入，
// 由 `agint.evolve.baselineGate(channel)` 读取上一周期 frozen 状态。
// 一行 = 一次 cron 跑的结果。id = ISO 时间戳（毫秒精度）。
const baselineHistorySchema = z.object({
  id: z.string().min(1),
  channel: z.string().min(1), // 当前固定 'mount'，预留扩展
  passRate: z.number().min(0).max(1),
  passed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  frozen: z.boolean(),
  source: z.string().default('cron:baseline-regression-suite'),
  ranAt: z.string(),
});

const spec = defineDomain({
  name: 'agint_evolve',
  version: 2,
  tables: {
    proposal: { valueSchema: proposalSchema },
    baseline_history: { valueSchema: baselineHistorySchema },
  },
});

const PROPOSAL_STATUSES = ['proposed', 'applied', 'rejected', 'wontfix'];
const PROPOSAL_CATEGORIES = ['rule', 'skill', 'doc', 'preset', 'service', 'plugin', 'other'];

function apply(ctx, config) {
  const root = resolve(config.root);
  // A4：归因 JSON 路径。两级来源，优先级 config > 自动探测。
  // 不依赖 cwd / 环境变量（cron 的 cwd 不保证是仓库根，宿主环境变量也没约定）。
  //
  // ⛔ 自动探测在**部署位**多半解析不出仓库根（插件住在 ~/.dsh/.agint-bundle/plugins/
  //    或 ~/.dsh/profiles/web/plugins/ 下，祖先里没有 eval/）。此时 pathResolved=false
  //    会进快照，由周报明确印「路径没解析出来」——
  //    这与「解析出来了但文件不存在」「文件坏了」是三件不同的事，不能混成一个「未采到」。
  const autoRoot = config.evalAttributionPath ? null : repoRootFromHere();
  const pathResolved = Boolean(config.evalAttributionPath) || autoRoot !== null;
  const evalAttributionPath = config.evalAttributionPath
    ? resolve(config.evalAttributionPath)
    : autoRoot
      ? resolve(autoRoot, 'eval', 'attribution', 'fail-attribution.json')
      : null;

  // ---- storage domain (double-sentinel pattern, K4/K8) ----
  let domain = null;
  let domainError = null;
  let disposed = false;

  ctx.effect(() => {
    return () => {
      disposed = true;
      if (domain) return domain.close();
    };
  });

  const ready = ctx.storageDomain.open(spec).then(
    (d) => {
      if (disposed) {
        void d.close().catch(() => {});
        return null;
      }
      domain = d;
      return d;
    },
    (error) => {
      domainError = error;
      return null;
    },
  );

  const table = async () => {
    if (disposed) throw new Error('agint-evolve: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-evolve: domain unavailable');
    return d.table('proposal');
  };

  const historyTable = async () => {
    if (disposed) throw new Error('agint-evolve: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-evolve: domain unavailable');
    return d.table('baseline_history');
  };

  const nowIso = () => new Date().toISOString();
  const randomId = () => {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  };

  // ---- review files: path discipline + walk (same as agint-wiki) ----
  const clean = (p) => {
    const trimmed = String(p ?? '').replace(/^\/+/, '');
    if (!trimmed.endsWith('.md')) throw new Error(`agint-evolve: path must end with .md (got "${p}")`);
    const abs = resolve(root, trimmed);
    if (abs !== root && !abs.startsWith(root + '/')) throw new Error(`agint-evolve: path escapes root (got "${p}")`);
    return { rel: trimmed, abs };
  };

  const walk = async (dir) => {
    const out = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return out;
      throw error;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...await walk(abs));
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(relative(root, abs));
    }
    return out;
  };

  const readMaybe = async (abs) => {
    try {
      return await readFile(abs, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };

  // ---- live data snapshot from the sibling agint-* services ----
  const safe = async (fn) => {
    try {
      const v = fn();
      return v && typeof v.then === 'function' ? await v : v;
    } catch {
      return null;
    }
  };

  async function dataSnapshot() {
    const memory = ctx.get('agint.memory');
    const wiki = ctx.get('agint.wiki');
    const cron = ctx.get('agint.cron');
    const rules = ctx.get('agint.rules');
    const metrics = ctx.get('agint.metrics');
    const sessionQuery = ctx.get('sessionQuery');
    const inputGateway = ctx.get('agint.inputGateway');

    const snapshot = { collectedAt: nowIso() };

    if (memory && typeof memory.stats === 'function') snapshot.memory = await safe(() => memory.stats());

    if (wiki && typeof wiki.lint === 'function') {
      snapshot.wiki = await safe(() => wiki.lint());
    }

    if (cron && typeof cron.health === 'function') snapshot.cron = await safe(() => cron.health());

    if (rules) {
      const audit = rules.audit ? await safe(() => rules.audit()) : null;
      const lintIssues = rules.lint ? await safe(() => rules.lint()) : null;
      if (audit || lintIssues) {
        snapshot.rules = {
          totals: audit?.totals ?? null,
          fired: audit?.rules ?? [],
          lintIssues: Array.isArray(lintIssues) ? lintIssues : [],
        };
      }
    }

    if (metrics && typeof metrics.summary === 'function') snapshot.metrics = await safe(() => metrics.summary());

    if (sessionQuery && typeof sessionQuery.listSessions === 'function') {
      snapshot.sessions = await safe(async () => {
        const list = await sessionQuery.listSessions();
        const arr = Array.isArray(list) ? list : [];
        return { count: arr.length, latest: arr[0] ? (arr[0].title ?? arr[0].id ?? '') : '' };
      });
    }

    // v0.7.2：多源输入网关（外部信号 Channel 状态 + security 门禁计数）
    if (inputGateway && typeof inputGateway.getStatus === 'function') {
      snapshot.inputGateway = await safe(() => inputGateway.getStatus());
    }

    // A4：eval 存量 FAIL 归因。⛔ 读不到 ⇒ 整个键缺席，让周报印「本周未采到」，
    //   绝不塞一个 { total: 0 } —— 「没采到」与「真的 0 个 fail」含义相反。
    //
    //   ⛔⛔ 2026-10-04 部署位实测：三种失败态必须各自可观测，不能都退化成「未采到」——
    //     ① pathUnresolved 路径没解析出来（部署位插件不在仓库布局里，祖先无 eval/）
    //     ② 文件不存在        （路径对，产物没生成）
    //     ③ parseError        （路径对，文件坏）
    //   ①②③ 混成一个「未采到」时，运维会去查归因脚本，而真因是插件根本找不到仓库。
    if (!pathResolved) {
      // 状态①：显式带上，让周报说清是「路径没解析出来」而不是「没数据」。
      snapshot.evalFailAttributionUnresolved = true;
      try {
        ctx.logger?.warn?.('evolve: eval 归因路径未解析（不在仓库布局内，需在 config 显式给 evalAttributionPath）', {
          pluginLocation: fileURLToPath(import.meta.url),
        });
      } catch { /* noop */ }
    } else if (evalAttributionPath) {
      const raw = await safe(() => readFile(evalAttributionPath, 'utf8'));
      if (typeof raw === 'string' && raw.trim() !== '') {
        try {
          const parsed = JSON.parse(raw);
          // 只取白名单字段：周报是给人读的，不该被产物文件里的额外键带偏。
          snapshot.evalFailAttribution = {
            total: Number(parsed.total) || 0,
            attributed: Number(parsed.attributed) || 0,
            coverage: typeof parsed.coverage === 'number' ? parsed.coverage : null,
            coverageMin: typeof parsed.coverageMin === 'number' ? parsed.coverageMin : null,
            byCategory: parsed.byCategory && typeof parsed.byCategory === 'object' ? parsed.byCategory : {},
            realDefects: Number(parsed.realDefects) || 0,
            generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null,
            unattributedUnitIds: Array.isArray(parsed.results)
              ? parsed.results.filter((r) => r?.category === 'NOT_ATTRIBUTED').map((r) => r.unitId).filter(Boolean)
              : [],
          };
        } catch (parseErr) {
          // 产物文件坏了也要如实说，不能静默当 0。
          snapshot.evalFailAttribution = {
            total: null, attributed: null, coverage: null, coverageMin: null,
            byCategory: {}, realDefects: 0, generatedAt: null,
            parseError: parseErr?.message ?? String(parseErr),
            unattributedUnitIds: [],
          };
        }
      }
    }

    return snapshot;
  }

  // ── evolution.proposed 发布（Sprint 12 A1 接线，2026-09-20） ──────────────
  // 背景：本主题此前**只有订阅方、没有生产发布方** —— agint.population.publishProposed
  //   注册了但生产调用点为 0，生产数据只剩 3 条 09-04 的历史探针。真正的提案源
  //   （生产 55 条）是这里的 propose()，所以发布方接在此处。
  //   取证与判据见 docs/known-limitations/event-bus-shadow-publish-gap.md。
  // 订阅方：agint-evolution-memory（影子写 evolution_log）/ agint-quality-eval /
  //   agint-trajectory（count-only 标定期）。
  // 红线：**直连路径完整保留** —— 落库与返回值不因发布失败而改变；
  //   bus 缺失或 publish 抛错只告警，不阻断 propose。
  async function publishProposed(rec) {
    const publish = typeof ctx.get === 'function' ? ctx.get('agint.eventBus.publish') : null;
    if (typeof publish !== 'function') {
      try {
        ctx.logger?.warn?.('evolve: evolution.proposed publish skipped', {
          proposalId: rec.id, reason: 'agint.eventBus.publish unavailable',
        });
      } catch { /* noop */ }
      return { published: false, reason: 'eventBus-unavailable' };
    }
    try {
      const result = await publish({
        topic: 'evolution.proposed',
        version: 1,
        source: 'agint-evolve',
        payload: {
          proposalId: rec.id,
          kind: rec.category || 'other',
          payload: rec,
          origin: 'agint-evolve',
        },
      });
      return { published: true, envelopeId: result?.envelopeId, deliveredTo: result?.deliveredTo ?? 0 };
    } catch (err) {
      try {
        ctx.logger?.warn?.('evolve: evolution.proposed publish failed', {
          proposalId: rec.id, error: err instanceof Error ? err.message : String(err ?? 'unknown'),
        });
      } catch { /* noop */ }
      return { published: false, reason: `publish-threw:${err?.message || err}` };
    }
  }

  // ---- service ----
  ctx.provide('agint.evolve', {
    dataSnapshot,

    /** Collect snapshot, detect findings, write reviews/<date>-周复盘.md. */
    async writeReview(opts = {}) {
      const snapshot = await dataSnapshot();
      const findings = findingsFromSnapshot(snapshot);
      const date = String(opts.date ?? new Date().toISOString().slice(0, 10));
      const markdown = buildReport({ date, snapshot, findings, notes: opts.notes });

      await mkdir(root, { recursive: true });
      const base = `${date}-周复盘.md`;
      let rel = base;
      let n = 2;
      while (await readMaybe(join(root, rel)) !== null) {
        rel = `${date}-周复盘-${n}.md`;
        n += 1;
      }
      await writeFile(join(root, rel), markdown, 'utf8');
      const info = await stat(join(root, rel));
      return { path: rel, bytes: info.size, findings, snapshotCollectedAt: snapshot.collectedAt };
    },

    async listReviews() {
      const files = await walk(root);
      const out = [];
      for (const rel of files) {
        const info = await stat(join(root, rel));
        out.push({ path: rel, size: info.size, mtime: info.mtime.toISOString() });
      }
      return out.sort((a, b) => b.path.localeCompare(a.path));
    },

    async readReview(p) {
      const { rel, abs } = clean(p);
      const content = await readMaybe(abs);
      return content === null ? null : { path: rel, content };
    },

    async propose(input) {
      const t = await table();
      const rec = proposalSchema.parse({
        id: input.id ?? randomId(),
        title: input.title,
        body: input.body,
        category: input.category ?? 'other',
        status: 'proposed',
        source: input.source ?? '',
        note: input.note ?? '',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      await t.put(rec.id, rec);
      // A1 接线：落库后发布 evolution.proposed（失败不影响返回值）
      await publishProposed(rec);
      return { ...rec };
    },

    async listProposals(filter = {}) {
      const t = await table();
      const out = [];
      for (const [id, rec] of t.entries()) {
        if (filter.status && rec.status !== filter.status) continue;
        if (filter.category && rec.category !== filter.category) continue;
        out.push({ id, ...rec });
      }
      out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return out;
    },

    async getProposal(id) {
      const t = await table();
      const rec = t.get(id);
      return rec ? { ...rec } : null;
    },

    async setStatus(id, status, note = '') {
      const t = await table();
      const rec = t.get(id);
      if (!rec) return null;
      if (!PROPOSAL_STATUSES.includes(status)) throw new Error(`agint-evolve: invalid status "${status}"`);
      const updated = { ...rec, status, note: note ?? rec.note ?? '', updatedAt: nowIso() };
      await t.put(id, updated);
      return { ...updated };
    },

    async removeProposal(id) {
      const t = await table();
      const ok = await t.delete(id);
      return Boolean(ok);
    },

    async stats() {
      const t = await table();
      let total = 0;
      const byStatus = {};
      const byCategory = {};
      for (const [, rec] of t.entries()) {
        total += 1;
        byStatus[rec.status] = (byStatus[rec.status] ?? 0) + 1;
        byCategory[rec.category] = (byCategory[rec.category] ?? 0) + 1;
      }
      return { total, byStatus, byCategory };
    },

    /**
     * Sprint 12 B3: baselineGate(channel, opts)
     *
     * Input:
     *   channel: string  —— 当前固定 'mount'，预留多通道扩展
     *   opts:
     *     since?: string (ISO) —— 只看此时间之后的最近一次；缺省 = 全部
     *     now?:   Date   —— 测试注入；缺省 = new Date()
     *
     * Output:
     *   { frozen: boolean, lastRunAt: string|null, since: string|null, source: string }
     *
     * 副作用：
     *   - 读 baseline_history 表（filter by channel + since）
     *   - 不写任何字段 —— "只读 + 写 status" 中的只读部分
     *
     * 缺数据时返回 { frozen:false, lastRunAt:null, since, source:'empty' }，
     * 让 driver dispatcher 与 cron 调用方都有稳定空值语义。
     */
    async baselineGate(channel = 'mount', opts = {}) {
      const t = await historyTable();
      const since = typeof opts.since === 'string' ? opts.since : null;
      let latest = null;
      for (const [id, rec] of t.entries()) {
        if (rec.channel !== channel) continue;
        if (since && rec.ranAt < since) continue;
        if (!latest || rec.ranAt > latest.ranAt) latest = { id, ...rec };
      }
      if (!latest) {
        return { frozen: false, lastRunAt: null, since, source: 'empty' };
      }
      return {
        frozen: latest.frozen === true,
        lastRunAt: latest.ranAt,
        since,
        source: latest.source ?? 'cron:baseline-regression-suite',
      };
    },

    /**
     * Sprint 12 B3: 由 `agint-cron` 的 `baseline-regression-suite` job 调用，
     * 写一行 baseline_history。返回写入的记录 id。
     *
     * Input:
     *   channel:    string        —— 'mount'（预留扩展）
     *   passRate:   number 0..1
     *   passed:     int
     *   total:      int
     *   source?:    string        —— 默认 'cron:baseline-regression-suite'
     *
     * 副作用：
     *   - 写 baseline_history 一行（id = ranAt ISO 字符串）
     *   - 不动 mutation / 不动 policy
     */
    async recordBaselineRun(input) {
      const channel = String(input?.channel ?? 'mount');
      const passRate = Number(input?.passRate ?? 0);
      const passed = Number(input?.passed ?? 0);
      const total = Number(input?.total ?? 0);
      const source = String(input?.source ?? 'cron:baseline-regression-suite');
      const ranAt = nowIso();
      const rec = baselineHistorySchema.parse({
        id: ranAt,
        channel,
        passRate,
        passed,
        total,
        frozen: passRate < 0.95,
        source,
        ranAt,
      });
      const t = await historyTable();
      await t.put(rec.id, rec);
      return { id: rec.id, ...rec };
    },

    /**
     * Sprint 12 B3: 列出 baseline_history 全部行，按 ranAt 倒序。
     * 调试 / 报告 / 测试用。
     */
    async listBaselineHistory(filter = {}) {
      const t = await historyTable();
      const out = [];
      for (const [id, rec] of t.entries()) {
        if (filter.channel && rec.channel !== filter.channel) continue;
        out.push({ id, ...rec });
      }
      out.sort((a, b) => b.ranAt.localeCompare(a.ranAt));
      return out;
    },

    _statuses: PROPOSAL_STATUSES,
    _categories: PROPOSAL_CATEGORIES,
  });
}

export { Config, apply, inject, name };
