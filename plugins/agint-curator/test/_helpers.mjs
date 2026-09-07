// 测试辅助：内存版 storage domain + mock ctx + 临时技能目录 / JSONL。
// 不挂 Cordis、不碰真实 ~/.dsh。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function fakeTable() {
  const m = new Map();
  return {
    put: async (k, v) => { if (v === undefined) m.delete(k); else m.set(k, v); },
    entries: () => [...m.entries()],
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
  };
}

export function mockCtx(services = {}) {
  const provided = {};
  const effects = [];
  return {
    storageDomain: { open: async () => fakeDomain() },
    get: (key) => services[key] ?? null,
    provide: (key, val) => { provided[key] = val; },
    effect: (fn) => effects.push(fn),
    _provided: provided,
    _effects: effects,
  };
}

/** 建一个临时 skills 目录：{ dirName, name, tools }[] */
export function makeSkillsDir(skills) {
  const dir = mkdtempSync(join(tmpdir(), 'curator-skills-'));
  for (const s of skills) {
    mkdirSync(join(dir, s.dirName ?? s.name), { recursive: true });
    const tools = (s.tools ?? []).length ? `[${s.tools.join(', ')}]` : '[]';
    writeFileSync(
      join(dir, s.dirName ?? s.name, 'SKILL.md'),
      `---\nname: ${s.name}\ndescription: "demo ${s.name}"\ntriggers: [demo]\ntools: ${tools}\n---\n\n# ${s.name}\n`,
      'utf8',
    );
  }
  return dir;
}

/** 建一个临时 tool-stats JSONL */
export function makeStatsJsonl(records) {
  const p = join(mkdtempSync(join(tmpdir(), 'curator-stats-')), 'agint_tool_stats.jsonl');
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return p;
}

export function cleanup(...paths) {
  for (const p of paths) rmSync(p, { recursive: true, force: true });
}
