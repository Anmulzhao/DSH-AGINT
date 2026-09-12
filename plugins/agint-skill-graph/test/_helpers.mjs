// 测试辅助：内存版 storage domain + mock ctx + 临时 presets / JSONL。
// 不挂 Cordis、不碰真实 ~/.dsh。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function fakeTable() {
  const m = new Map();
  return {
    put: async (k, v) => { if (v === undefined) m.delete(k); else m.set(k, v); },
    entries: () => [...m.entries()],
    get: (k) => m.get(k),
    del: async (k) => { m.delete(k); },
    _map: m,
  };
}

export function fakeDomain() {
  const tables = new Map();
  return {
    close: async () => {},
    table: (name) => {
      if (!tables.has(name)) tables.set(name, fakeTable());
      return tables.get(name);
    },
    _tables: tables,
  };
}

/**
 * mock ctx。
 * @param {object} services  ctx.get(key) 的返回表
 * @param {object} opts      { openFails?: boolean, capture: { subscribe } }
 */
export function mockCtx(services = {}, opts = {}) {
  const provided = {};
  const effects = [];
  const domain = fakeDomain();
  return {
    storageDomain: {
      open: async () => {
        if (opts.openFails) throw new Error('intentional domain open failure');
        return domain;
      },
    },
    get: (key) => services[key] ?? null,
    provide: (key, val) => { provided[key] = val; },
    effect: (fn) => { effects.push(fn); return () => {}; },
    _provided: provided,
    _effects: effects,
    _domain: domain,
  };
}

/** 造一个假 event-bus：记录订阅声明与 handler，支持手动投递 */
export function fakeEventBus() {
  const subs = [];
  const published = [];
  return {
    subscribe: (decl, handler) => { subs.push({ decl, handler }); return () => {}; },
    publish: async (env) => { published.push(env); return { ok: true }; },
    _subs: subs,
    _published: published,
    /** 手动投递到所有订阅了该 topic 的 handler */
    async emit(topic, payload) {
      for (const s of subs) {
        if (s.decl.topics.includes(topic)) {
          await s.handler({ topic, payload, id: `evt_${subs.length}`, source: 'test' });
        }
      }
    },
    _topics: () => [...new Set(subs.flatMap((s) => s.decl.topics))],
  };
}

/**
 * 建临时 presets 目录：{ '<preset>': [{ name, dirName?, description?, triggers?, tools?, related_skills?, body? }] }
 */
export function makePresetsDir(presets) {
  const dir = mkdtempSync(join(tmpdir(), 'skillgraph-presets-'));
  for (const [preset, skills] of Object.entries(presets)) {
    for (const s of skills) {
      mkdirSync(join(dir, preset, 'skills', s.dirName ?? s.name), { recursive: true });
      const fm = [
        '---',
        `name: ${s.name}`,
        `description: "${s.description ?? `demo ${s.name}`}"`,
        `triggers: [${(s.triggers ?? []).join(', ')}]`,
        `tools: [${(s.tools ?? []).join(', ')}]`,
        ...(s.related_skills ? [`related_skills: [${s.related_skills.join(', ')}]`] : []),
        '---',
        '',
        `# ${s.name}`,
        s.body ?? '',
      ].join('\n');
      writeFileSync(join(dir, preset, 'skills', s.dirName ?? s.name, 'SKILL.md'), fm, 'utf8');
    }
  }
  return dir;
}

export function makeStatsJsonl(records) {
  const p = join(mkdtempSync(join(tmpdir(), 'skillgraph-stats-')), 'agint_tool_stats.jsonl');
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return p;
}

/** 造一条 tool-stats 记录 */
export function rec(ts, tool, args, extra = {}) {
  return {
    ts,
    sessionId: extra.sessionId ?? 'session-test',
    turn: extra.turn ?? 1,
    step: extra.step ?? 1,
    tool,
    callId: extra.callId ?? `call_${ts}`,
    latencyMs: 5,
    ok: extra.ok ?? true,
    errorKind: null,
    argFingerprint: extra.argFingerprint ?? `fp_${ts}`,
    argsHash: 'h',
    args,
  };
}

export function cleanup(...paths) {
  for (const p of paths) rmSync(p, { recursive: true, force: true });
}
