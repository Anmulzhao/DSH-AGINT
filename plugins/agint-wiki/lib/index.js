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
  // Normalize root to forward slashes for consistent startsWith checks across
  // platforms (Windows `resolve()` returns backslash paths, but user-supplied
  // paths from model/tools are typically forward-slash). v0.4 fix: previous
  // version did `abs.startsWith(root + '/')`, which fails on Windows because
  // root ends without `/` and `root + '/'` becomes `D:\foo\` while abs is
  // `D:\foo\hello.md` — both real, but `'D:\\foo\\hello.md'.startsWith('D:\\foo\\/')`
  // is false. Symptom: every wiki_write/read rejected with "path escapes root".
  // Compare on forward-slash-normalized forms; resolves win-backslash vs forward-
  // slash mismatch without weakening security (still rejects ../).
  const normRoot = root.replace(/\\/g, '/');

  // Path discipline: relative to root, must end in .md, must not escape root.
  const clean = (p) => {
    const trimmed = String(p ?? '').replace(/^\/+/, '');
    if (!trimmed.endsWith('.md')) throw new Error(`agint-wiki: path must end with .md (got "${p}")`);
    const abs = resolve(root, trimmed);
    const normAbs = abs.replace(/\\/g, '/');
    if (normAbs !== normRoot && !normAbs.startsWith(normRoot + '/')) throw new Error(`agint-wiki: path escapes root (got "${p}")`);
    return { rel: trimmed, abs };
  };

  // ── wiki.updated 发布（2026-10-26）────────────────────────────────────
  // 背景：agint-wiki 此前对事件总线零感知（check-wiring 查 E' 的 UNWIRED），
  //   知识层的写入在总线上完全无痕迹 ⇒ 没有任何插件能对 wiki 变化做反应。
  //
  // 语义：只有**真实发生的变更**才发 —— write 落盘成功、remove 删掉实际存在的文件。
  //   remove 返 false（ENOENT）时不发，否则「删除一个不存在的文件」也会产生事件，
  //   把 wiki.updatedCount 变成调用计数而不是变更计数。
  //
  // 红线（沿用 agint-rules / agint-mount 的接线纪律，K63/K64 教训）：
  //   1. **文件读写是主契约** —— 返回值、抛错语义一律不变；发布失败只告警。
  //   2. **三形态探测** —— event-bus 用 spec.provides 注册的是三个分服务名
  //      （`agint.eventBus.publish` 等），**没有伞键**；部分 host 变体是伞键。
  //      只查伞键会恒 undefined 并静默降级（gap 文档 §6.4 的 K63 同族事故）。
  //   3. 不切 T2：主路径仍是文件系统直写，本条是影子广播。
  function resolveBusPublish() {
    const bind = (bus) => (bus && typeof bus.publish === 'function' ? bus.publish.bind(bus) : null);
    const probes = [
      () => (typeof ctx.get === 'function' ? ctx.get('agint.eventBus.publish') : null),
      () => bind(typeof ctx.getService === 'function' ? ctx.getService('agint.eventBus') : null),
      () => bind(typeof ctx.get === 'function' ? ctx.get('agint.eventBus') : null),
    ];
    for (const probe of probes) {
      try {
        const fn = probe();
        if (typeof fn === 'function') return fn;
      } catch { /* 试下一种形态 */ }
    }
    return null;
  }

  async function publishWikiUpdated(payload) {
    const publish = resolveBusPublish();
    if (!publish) return { published: false, reason: 'eventBus-unavailable' };
    try {
      const result = await publish({
        topic: 'wiki.updated',
        version: 1,
        source: 'agint-wiki',
        payload,
      });
      return { published: true, envelopeId: result?.envelopeId, deliveredTo: result?.deliveredTo ?? 0 };
    } catch (err) {
      try {
        ctx.logger?.warn?.('wiki: wiki.updated publish failed', {
          path: payload?.path,
          action: payload?.action,
          error: err instanceof Error ? err.message : String(err ?? 'unknown'),
        });
      } catch { /* noop */ }
      return { published: false, reason: 'publish-failed' };
    }
  }

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
        // 归一化成正斜杠：链接索引（referenced）用的是正斜杠，若这里留反斜杠，
        // `contents.has(norm)` 在 Windows 上永远 false → 全部误报 orphan。
        // （2026-09-10 与逃逸检查同批修复；join() 接受正斜杠，读写路径不受影响）
        out.push(relative(root, abs).replace(/\\/g, '/'));
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
      // 影子广播：知识层变了。落盘之后才发 —— 写失败的路径不应产生变更事件。
      await publishWikiUpdated({ action: 'write', path: rel, bytes: info.size });
      return { path: rel, bytes: info.size };
    },

    async remove(p) {
      const { rel, abs } = clean(p);
      try {
        await rm(abs);
        // 只在真的删掉东西时发；下面 ENOENT 分支返回 false 表示无变更。
        await publishWikiUpdated({ action: 'remove', path: rel });
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
      const warnings = [];
      const orphans = [];

      // index of referenced targets for orphan detection
      const referenced = new Set();
      const LINK_RE = /\]\(([^)]+)\)|\[\[([^\]]+)\]\]/g;

      /**
       * 「条目自相矛盾」 vs 「作者警告」的分桶判据（smoke 1fc201c 钉死的规格）：
       *   ⚠️ 行里带着**修正/冲突词汇**（更正/勘误/矛盾/推翻…）= 作者在宣布
       *   本条目内有两条互斥的认定 → contradiction，红。
       *   ⚠️ 行只是作者的排查告诫（如「不要用 grep 判断报错」），无任何冲突
       *   语义 → warnings 桶，黄。它曾经被一刀切算成矛盾，造成误报。
       * 索引页（README.md）是 meta 不是知识，两个桶都豁免；
       * 但它的**链接照常解析**（README 的链接必须计入 referenced）。
       */
      const CONFLICT_WORD_RE = /(更正|勘误|矛盾|冲突|推翻|作废|不再成立|过时)/;
      for (const [rel, content] of contents) {
        if (rel === 'WIKI_SCHEMA.md') continue; // schema doc is meta, not knowledge
        const lines = content.split('\n');
        // 索引页只豁免 ⚠️ 判定（矛盾/警告两桶都不记）；
        // 链接解析必须照常执行 —— 否则 README 的链接不进入 referenced，
        // 「登记到索引却仍报孤立」的自相矛盾会一直存在（2026-10-28 修复）。
        if (basename(rel) !== 'README.md') {
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.includes('⚠️')) continue;
            // 带 path/line/snippet 而不是裸文件名：裸 rel 让复核者还得自己开文件找行
            const hit = { path: rel, line: i + 1, snippet: line.trim().slice(0, 160) };
            if (CONFLICT_WORD_RE.test(line)) contradictions.push(hit);
            else warnings.push(hit);
          }
        }
        const dir = dirname(rel);
        let m;
        LINK_RE.lastIndex = 0;
        while ((m = LINK_RE.exec(content)) !== null) {
          const target = (m[1] ?? m[2] ?? '').split('#')[0].trim();
          if (!target || /^https?:|^#/.test(target)) continue;
          // normalize: relative to the referencing file's directory
          const abs = resolve(root, dir, target);
          // Windows: resolve/relative 返回反斜杠，root 可能是正斜杠。
          // 必须归一化后再比较，否则 `abs.startsWith(root + '/')` 永远 false
          // → 每个链接都被当成"逃出根目录"跳过 → referenced 恒空 →
          // 所有条目误报 orphan、brokenLinks 恒 0。
          // （v0.4 只修了 clean()，漏修了这里 —— 2026-09-10 修复）
          const normAbs = abs.replace(/\\/g, '/');
          if (normAbs !== normRoot && !normAbs.startsWith(normRoot + '/')) continue;
          const norm = relative(root, abs).replace(/\\/g, '/');
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
        warnings, // 疑似 ⚠️ 命中：进 lint 报告供人复核，不计入 healthy（疑似 ≠ 定罪）
        orphans,
        healthy: brokenLinks.length === 0 && contradictions.length === 0,
      };
    },
  });
}

export { Config, apply, inject, name };
