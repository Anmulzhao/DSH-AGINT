/**
 * agint-rules: host service plugin (provides `agint.rules`).
 *
 * HOST plane, single instance: opens the `agint_rules` storage domain once
 * (separate from `agint` / `agint_rules` would collide on `already-open`)
 * and serves every session. Tools consumer lives in the preset.
 *
 * Two Cordis event hooks wire rule enforcement into the live tool flow:
 *   - tools/pre-execute waterfall:
 *       rules with action 'deny' / 'ask'  →  return kind: 'deny'/'ask'
 *       rules with action 'advisory'      →  fall through to next()
 *   - tools/post-execute waterfall:
 *       rules with action 'advisory'      →  attach additionalContexts that
 *                                             tell the model "this matched a
 *                                             rule, please consider X"
 *                                             (this is the design's half-
 *                                             mandatory reminder:  the card
 *                                             appears,  the call is allowed)
 *
 * Per-call audit (matched/hit counters) lives in an in-memory Map so the
 * preset tools can report "advisory rate" / "rule adherence" without
 * touching storage. No persistence: the counter resets on reload,  which
 * matches how metrics are computed fresh each session.
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-rules
 *         name: ./plugins/agint-rules/lib/index.js
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

const name = 'agint-rules';
const inject = ['storageDomain'];

const Config = z.object({}).optional();

// action 'advisory' → only a reminder (post-execute additionalContexts)
// action 'ask'      → pre-execute kind: 'ask' (user prompted for confirmation)
// action 'deny'     → pre-execute kind: 'deny' (hard block,  reserved for
//                     genuinely destructive patterns; approval stack also
//                     handles these but defense in depth is the point)
const ActionSchema = z.enum(['advisory', 'ask', 'deny']);

const ruleSchema = z.object({
  id: z.string().min(1),
  // Which tool name to scope to. '*' = any tool (pattern matches command text).
  tool: z.string().min(1).default('*'),
  // Regular expression source string. Compiled at match time (no need to
  // persist compiled RegExp — JSON-safe).
  pattern: z.string().min(1),
  // Optional flags string,  e.g. 'i' for case-insensitive. Defaults to none.
  flags: z.string().default(''),
  action: ActionSchema,
  level: z.enum(['L1', 'L2', 'L3', 'L4']).default('L2'),
  reason: z.string().min(1),
  enabled: z.boolean().default(true),
  createdAt: z.string().default(() => new Date().toISOString()),
  updatedAt: z.string().default(() => new Date().toISOString()),
});

const spec = defineDomain({
  name: 'agint_rules',
  version: 1,
  tables: { rule: { valueSchema: ruleSchema } },
});

// Seed rules — fail loud on `rm -rf /`, confirm force pushes,  advise on
// npm publish. Real deployments would load these from a file; this is the
// minimum for the first session.
const seedRules = [
  {
    id: 'bash-rm-rf-root',
    tool: 'bash',
    // Match: rm -rf (with any combo of r/f/R/F flags) followed by EITHER
    //   a bare `/` (possibly followed by `*`) or `~` (with or without slash)
    //   or `$HOME` literal, and the path ENDS there (no further path
    //   components). Negative lookahead `(?!\S)` ensures we don't trigger on
    //   `rm -rf /tmp/build` or `rm -rf /var/log`.
    pattern: '\\brm\\s+-[a-zA-Z]*[rfRF][a-zA-Z]*\\s+(/\\*?\\s*|~/\\s*|~\\s*|\\$HOME\\s*)(?!\\S)',
    flags: 'i',
    action: 'deny',
    level: 'L1',
    reason: '拒绝删除根目录或整个 $HOME 的命令 — 这是不可逆的破坏性操作，请用更精确的路径。',
  },
  {
    id: 'bash-git-push-force-main',
    tool: 'bash',
    pattern: 'git\\s+push\\s+(?:--force(?:\\b|-)|-f\\b)[^|;&]*\\b(?:origin\\s+)?(?:main|master)\\b',
    flags: 'i',
    action: 'ask',
    level: 'L2',
    reason: '强制推送到 main/master 会覆盖远端历史，先确认是受保护的分支。',
  },
  {
    id: 'bash-npm-publish',
    tool: 'bash',
    pattern: '\\bnpm\\s+publish\\b|\\bpnpm\\s+publish\\b|\\byarn\\s+publish\\b',
    flags: '',
    action: 'advisory',
    level: 'L3',
    reason: '发布到 npm 会公开当前包 — 确认版本号、registry、和 dry-run 已经核对。',
  },
];

function compilePattern(rule) {
  // pattern + flags → RegExp. Invalid patterns are dropped silently at match
  // time; lint() surfaces them.
  try {
    return new RegExp(rule.pattern, rule.flags || undefined);
  } catch {
    return null;
  }
}

function argText(name, args) {
  // Convert common arg shapes into a single text blob for regex matching.
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return args;
  if (Array.isArray(args)) {
    if (name === 'bash') {
      // bash tool typically takes { command: "..." }
      return (args.command || args.cmd || '').toString();
    }
    return JSON.stringify(args);
  }
  if (typeof args === 'object') {
    if (typeof args.command === 'string') return args.command;
    if (typeof args.cmd === 'string') return args.cmd;
    return JSON.stringify(args);
  }
  return String(args);
}

function apply(ctx) {
  let domain = null;
  let domainError = null;
  let disposed = false;

  // ctx.effect semantics: callback runs IMMEDIATELY, return value is disposer.
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
    if (disposed) throw new Error('agint-rules: disposed');
    if (domainError) throw domainError;
    const d = await ready;
    if (!d) throw new Error('agint-rules: domain unavailable');
    return d.table('rule');
  };

  const nowIso = () => new Date().toISOString();

  // In-memory audit counters. Keyed by rule id → { hits, denies, asks, advisories }.
  const audit = new Map();
  function bump(ruleId, kind) {
    const cur = audit.get(ruleId) ?? { hits: 0, denies: 0, asks: 0, advisories: 0 };
    cur.hits += 1;
    if (kind === 'deny') cur.denies += 1;
    else if (kind === 'ask') cur.asks += 1;
    else if (kind === 'advisory') cur.advisories += 1;
    audit.set(ruleId, cur);
  }

  const agintRules = {
    async add(input) {
      const t = await table();
      const id = input.id ?? `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const existing = t.get(id);
      const rule = ruleSchema.parse({
        id,
        tool: input.tool ?? '*',
        pattern: input.pattern,
        flags: input.flags ?? '',
        action: input.action,
        level: input.level ?? existing?.level ?? 'L2',
        reason: input.reason,
        enabled: input.enabled ?? existing?.enabled ?? true,
        createdAt: existing?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      });
      await t.put(id, rule);
      return { ...rule };
    },

    async remove(id) {
      const t = await table();
      const ok = await t.delete(id);
      if (ok) audit.delete(id);
      return ok;
    },

    async setEnabled(id, enabled) {
      const t = await table();
      const rec = t.get(id);
      if (!rec) return null;
      const updated = { ...rec, enabled: Boolean(enabled), updatedAt: nowIso() };
      await t.put(id, updated);
      return { ...updated };
    },

    async list(filter = {}) {
      const t = await table();
      const out = [];
      for (const [id, rec] of t.entries()) {
        if (filter.action && rec.action !== filter.action) continue;
        if (filter.tool && rec.tool !== filter.tool) continue;
        if (filter.enabled !== undefined && rec.enabled !== filter.enabled) continue;
        out.push({ id, ...rec });
      }
      out.sort((a, b) => a.id.localeCompare(b.id));
      return out;
    },

    async get(id) {
      const t = await table();
      const rec = t.get(id);
      return rec ? { ...rec } : null;
    },

    // Evaluate rules against a concrete (tool, args) call. Returns the
    // FIRST deny / ask match (so enforcement is unambiguous) plus all
    // advisory matches (so post-execute can attach them all).
    async check(tool, args, opts = {}) {
      const t = await table();
      const rules = [];
      for (const [, rec] of t.entries()) {
        if (!rec.enabled) continue;
        if (rec.tool !== '*' && rec.tool !== tool) continue;
        rules.push(rec);
      }
      const text = argText(tool, args);
      const deny = [];
      const ask = [];
      const advisory = [];
      const badPatterns = [];
      for (const rec of rules) {
        const re = compilePattern(rec);
        if (re === null) { badPatterns.push(rec.id); continue; }
        if (!re.test(text)) continue;
        if (rec.action === 'deny') deny.push({ ruleId: rec.id, action: rec.action, level: rec.level, reason: rec.reason });
        else if (rec.action === 'ask') ask.push({ ruleId: rec.id, action: rec.action, level: rec.level, reason: rec.reason });
        else if (rec.action === 'advisory') advisory.push({ ruleId: rec.id, action: rec.action, level: rec.level, reason: rec.reason });
      }
      return {
        tool,
        matched: deny.length + ask.length + advisory.length,
        deny,
        ask,
        advisory,
        invalidPatterns: badPatterns,
      };
    },

    // Audit log for the preset tools — which rules fired,  what counts.
    audit() {
      const out = [];
      for (const [id, counts] of audit.entries()) {
        out.push({ ruleId: id, ...counts });
      }
      out.sort((a, b) => b.hits - a.hits);
      const totals = out.reduce(
        (acc, r) => {
          acc.hits += r.hits; acc.denies += r.denies;
          acc.asks += r.asks; acc.advisories += r.advisories;
          return acc;
        },
        { hits: 0, denies: 0, asks: 0, advisories: 0 },
      );
      return { rules: out, totals };
    },

    // Lint the rule table for invalid patterns and duplicate-ish rules.
    async lint() {
      const t = await table();
      const issues = [];
      const all = [...t.entries()].map(([id, r]) => ({ id, ...r }));
      for (const r of all) {
        const re = compilePattern(r);
        if (re === null) issues.push({ ruleId: r.id, kind: 'invalid-pattern', detail: r.pattern });
      }
      // Pairwise: same tool + same action + overlapping pattern (rough).
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i]; const b = all[j];
          if (a.tool !== b.tool) continue;
          if (a.action !== b.action) continue;
          if (a.enabled !== b.enabled) continue;
          if (a.pattern === b.pattern) {
            issues.push({ ruleId: a.id, kind: 'duplicate-pattern', with: b.id });
          }
        }
      }
      return issues;
    },

    // Seed rules on first boot (when table is empty).
    async seedIfEmpty() {
      const t = await table();
      let any = false;
      for (const _ of t.entries()) { any = true; break; }
      if (any) return { seeded: false, count: 0 };
      const now = nowIso();
      for (const r of seedRules) {
        await t.put(r.id, ruleSchema.parse({ ...r, createdAt: now, updatedAt: now }));
      }
      return { seeded: true, count: seedRules.length };
    },

    // Internal — for boot-level diagnostics only.
    _audit: audit,
  };

  ctx.provide('agint.rules', agintRules);

  // -------- Event hooks: pre-execute (deny / ask) -------------------

  ctx.on('tools/pre-execute', async (exec, next) => {
    const rules = ctx.get('agint.rules');
    if (!rules) return next();
    let result;
    try {
      result = await rules.check(exec.name, exec.arguments);
    } catch {
      return next();
    }
    if (result.deny.length > 0) {
      const top = result.deny[0];
      bump(top.ruleId, 'deny');
      return { kind: 'deny', reason: `agint-rules [${top.ruleId}] ${top.reason}` };
    }
    if (result.ask.length > 0) {
      const top = result.ask[0];
      bump(top.ruleId, 'ask');
      return { kind: 'ask', reason: `agint-rules [${top.ruleId}] ${top.reason}` };
    }
    // Advisory: pass through, post-execute will attach reminders.
    return next();
  });

  // -------- Event hooks: post-execute (advisory additionalContexts) -

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const rules = ctx.get('agint.rules');
    if (!rules) return next();
    let check;
    try {
      check = await rules.check(exec.name, exec.arguments);
    } catch {
      return next();
    }
    if (check.advisory.length === 0) return next();
    // Build one user message listing every matched advisory.
    const lines = check.advisory.map(
      (a) => `• [${a.ruleId}] (${a.level}) ${a.reason}`,
    );
    const message = {
      source: { kind: 'plugin', plugin: 'agint-rules', form: 'advisory' },
      content: [{
        type: 'text',
        text: `agint-rules advisory: tool=${exec.name} matched ${check.advisory.length} rule(s).\n${lines.join('\n')}\n(请在执行下一步前确认是否要继续；这是系统规则提醒，不是阻断。)`,
      }],
    };
    for (const a of check.advisory) bump(a.ruleId, 'advisory');
    return { kind: 'accept', value: result.value, content: result.content, additionalContexts: [message] };
  });
}

export { Config, apply, inject, name };