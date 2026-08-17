/**
 * agint-wiki: host service (provides `agint.wiki`) over markdown files.
 *
 * Knowledge layer (知识层) of 智进: domain-organized .md files under a
 * configured root. Principles (教训/决策/偏好) live in agint-memory; the
 * wiki holds accumulating knowledge (industry notes, company research,
 * tech references). Files are the medium so entries stay human-readable,
 * auditable, and diff-able.
 *
 * HOST plane, single instance (same pattern as agint-memory). Model-facing
 * tools are registered from the agint preset (lib/tools.js).
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-wiki
 *         name: ./plugins/agint-wiki
 *         config:
 *           root: .../agint-dsh/wiki
 */

import { readFile, writeFile, readdir, stat, mkdir, rm } from 'node:fs/promises';
import { join, resolve, dirname, relative, basename } from 'node:path';
import { z } from 'zod';

const name = 'agint-wiki';
const inject = [];

const Config = z.object({
  root: z.string().min(1, 'agint-wiki: config.root is required'),
});

function apply(ctx, config) {
  const root = resolve(config.root);

  // Path discipline: relative to root, must end in .md, must not escape root.
  const clean = (p) => {
    const trimmed = String(p ?? '').replace(/^\/+/, '');
    if (!trimmed.endsWith('.md')) throw new Error(`agint-wiki: path must end with .md (got "${p}")`);
    const abs = resolve(root, trimmed);
    if (abs !== root && !abs.startsWith(root + '/')) throw new Error(`agint-wiki: path escapes root (got "${p}")`);
    return { rel: trimmed, abs };
  };

  // Recursively collect .md files under dir, returning paths relative to root.
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
      if (entry.isDirectory()) {
        out.push(...await walk(abs));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(relative(root, abs));
      }
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

  ctx.provide('agint.wiki', {
    async read(p) {
      const { rel, abs } = clean(p);
      const content = await readMaybe(abs);
      return content === null ? null : { path: rel, content };
    },

    async write(p, content) {
      const { rel, abs } = clean(p);
      if (typeof content !== 'string' || content.trim() === '') throw new Error('agint-wiki: content must be a non-empty string');
      await mkdir(dirname(abs), { recursive: true });
      const body = content.endsWith('\n') ? content : `${content}\n`;
      await writeFile(abs, body, 'utf8');
      const info = await stat(abs);
      return { path: rel, bytes: info.size };
    },

    async remove(p) {
      const { abs } = clean(p);
      try {
        await rm(abs);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    },

    async list(domain) {
      const files = await walk(root);
      const out = [];
      for (const rel of files) {
        if (domain && !rel.startsWith(`${domain.replace(/\/$/, '')}/`)) continue;
        const info = await stat(join(root, rel));
        out.push({ path: rel, size: info.size, mtime: info.mtime.toISOString() });
      }
      return out.sort((a, b) => a.path.localeCompare(b.path));
    },

    async search(query, opts = {}) {
      const q = String(query ?? '').toLowerCase().trim();
      const files = await walk(root);
      const hits = [];
      for (const rel of files) {
        if (opts.domain && !rel.startsWith(`${opts.domain.replace(/\/$/, '')}/`)) continue;
        const content = await readMaybe(join(root, rel));
        if (content === null) continue;
        if (q && !content.toLowerCase().includes(q)) continue;
        const lines = content.split('\n');
        const lineNo = q ? lines.findIndex((l) => l.toLowerCase().includes(q)) : 0;
        hits.push({
          path: rel,
          snippet: lineNo >= 0 ? lines[lineNo].slice(0, 160) : lines[0]?.slice(0, 160) ?? '',
          line: lineNo >= 0 ? lineNo + 1 : 1,
        });
      }
      return hits.sort((a, b) => a.path.localeCompare(b.path)).slice(0, opts.limit ?? 50);
    },

    async lint() {
      const files = await walk(root);
      const contents = new Map();
      for (const rel of files) contents.set(rel, (await readMaybe(join(root, rel))) ?? '');

      const brokenLinks = [];
      const contradictions = [];
      const orphans = [];

      // index of referenced targets for orphan detection
      const referenced = new Set();
      const LINK_RE = /\]\(([^)]+)\)|\[\[([^\]]+)\]\]/g;

      for (const [rel, content] of contents) {
        if (rel === 'WIKI_SCHEMA.md') continue; // schema doc is meta, not knowledge
        if (content.includes('⚠️')) contradictions.push(rel);
        const dir = dirname(rel);
        let m;
        LINK_RE.lastIndex = 0;
        while ((m = LINK_RE.exec(content)) !== null) {
          const target = (m[1] ?? m[2] ?? '').split('#')[0].trim();
          if (!target || /^https?:|^#/.test(target)) continue;
          // normalize: relative to the referencing file's directory
          const abs = resolve(root, dir, target);
          if (abs !== root && !abs.startsWith(root + '/')) continue;
          const norm = relative(root, abs);
          if (!contents.has(norm)) brokenLinks.push({ from: rel, target: norm });
          else referenced.add(norm);
        }
      }

      for (const rel of files) {
        if (rel === 'WIKI_SCHEMA.md') continue;
        if (basename(rel) === 'README.md') continue;
        if (!referenced.has(rel)) orphans.push(rel);
      }

      return {
        checked: files.length,
        brokenLinks,
        contradictions,
        orphans,
        healthy: brokenLinks.length === 0 && contradictions.length === 0,
      };
    },
  });
}

export { Config, apply, inject, name };
