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
import { join, resolve, dirname, relative } from 'node:path';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { findingsFromSnapshot, buildReport } from './report.js';

const name = 'agint-evolve';
const inject = ['storageDomain'];

const Config = z.object({
  root: z.string().min(1, 'agint-evolve: config.root is required'),
});

const proposalSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  category: z.enum(['rule', 'skill', 'doc', 'preset', 'service', 'other']).default('other'),
  status: z.enum(['proposed', 'applied', 'rejected', 'wontfix']).default('proposed'),
  source: z.string().default(''),
  note: z.string().default(''),
  createdAt: z.string().default(() => new Date().toISOString()),
  updatedAt: z.string().default(() => new Date().toISOString()),
});

const spec = defineDomain({
  name: 'agint_evolve',
  version: 1,
  tables: { proposal: { valueSchema: proposalSchema } },
});

const PROPOSAL_STATUSES = ['proposed', 'applied', 'rejected', 'wontfix'];
const PROPOSAL_CATEGORIES = ['rule', 'skill', 'doc', 'preset', 'service', 'other'];

function apply(ctx, config) {
  const root = resolve(config.root);

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

    return snapshot;
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

    _statuses: PROPOSAL_STATUSES,
    _categories: PROPOSAL_CATEGORIES,
  });
}

export { Config, apply, inject, name };
