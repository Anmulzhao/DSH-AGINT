#!/usr/bin/env node
/**
 * bin/verify-event-topics.mjs —— 事件 topic 事实清单门禁（Tier A）
 *
 * 背景（设计 §5.2.5）：「事件 topic 必须在事实清单命中」。
 * ⚠️ 但仓库里**原本没有这份清单** —— 2026-10-02 实测 grep 过 docs/ 全部
 * Markdown，对 topic 注册表零命中。所以本交付物必须一并把它造出来，
 * 落点选 `docs/event-topics.json`，沿用仓库既有的 checked-in baseline 惯例
 * （`docs/l0-frozen-baseline.json` / `docs/wiring-exemptions.json` 同款）。
 *
 * 事实来源（两条，缺一不可）：
 *   1. **代码**：plugins/<name>/lib/ 与 plugins/<name>/*.js 里的 topic 字面量
 *      （publish('x' / subscribe('x' / topic: 'x'）
 *   2. **生产**：$DSH_HOME/storages/agint_event_bus.json 里真出现过的 topic
 *      —— 这一条能捞到**动态构造**的 topic（模板串/变量），静态扫不到。
 *      实测 30 个生产 topic 里有 15 个代码里扫不出来（ov.* / oracle.* / policy.* …）。
 *
 * 为什么不让「代码里有」就自动算合法：
 *   那样门禁是恒真的，等于没有。清单是**快照**，它的价值在于：
 *   新增一个 topic 必须**刻意**登记（进 review diff），避免拼错/野 topic
 *   在事件总线里静默空转（订阅了一个永远没人发的主题，不报错，只是永不触发）。
 *
 * 用法：
 *   node bin/verify-event-topics.mjs              校验（默认）
 *   node bin/verify-event-topics.mjs --update     用当前实况重建事实清单
 *   node bin/verify-event-topics.mjs --json       CI 消费
 *
 * 退出码：0 = 通过 / 1 = 有未登记 topic / 2 = 脚本自身出错
 *
 * 零依赖：只用 node:fs / node:path / node:url / node:os（不解析 12MB 存储之外的任何东西）。
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, relative, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');
const REGISTRY_PATH = join(REPO_ROOT, 'docs', 'event-topics.json');
const BUS_STORAGE = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'storages', 'agint_event_bus.json')
  : join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'storages', 'agint_event_bus.json');

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const UPDATE = argv.includes('--update');

/** topic 字面量的三种写法。刻意不做「任意字符串都算」——那会引入一堆误报。 */
const TOPIC_PATTERNS = [
  { name: 'publish', re: /\bpublish\s*\(\s*['"]([a-zA-Z0-9_.:-]+)['"]/g },
  { name: 'subscribe', re: /\bsubscribe\s*\(\s*['"]([a-zA-Z0-9_.:-]+)['"]/g },
  { name: 'topic-prop', re: /\btopic\s*:\s*['"]([a-zA-Z0-9_.:-]+)['"]/g },
];

// ── 扫描生产代码 ────────────────────────────────────────────────────────────
function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'test' || e.name === '__tests__') continue;
      walk(abs, acc);
    } else if (/\.(m?js|ts)$/.test(e.name) && !e.name.endsWith('.d.ts')) {
      acc.push(abs);
    }
  }
  return acc;
}

/**
 * 生产代码范围。⛔ 不含 plugins/<name>/test/：测试里有 evt.a / x / whatever
 * 这类占位 topic（实测 62 个候选里有一半是这种）—— 扫进来会让清单失真。
 */
function codeFiles() {
  const out = [];
  if (!existsSync(PLUGINS_DIR)) return out;
  for (const d of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const root = join(PLUGINS_DIR, d.name);
    out.push(...walk(join(root, 'lib')));
    // 插件根目录下的 *.js（有些插件入口在根，不在 lib）
    for (const f of readdirSync(root, { withFileTypes: true })) {
      if (f.isFile() && /\.(m?js)$/.test(f.name)) out.push(join(root, f.name));
    }
  }
  return [...new Set(out)];
}

/** @returns {Map<string, {files:string[], kinds:Set<string>}>} */
export function scanCodeTopics(files) {
  const found = new Map();
  for (const abs of files) {
    let src;
    try {
      src = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(REPO_ROOT, abs).split(sep).join('/');
    for (const { name, re } of TOPIC_PATTERNS) {
      for (const m of src.matchAll(re)) {
        const t = m[1];
        if (!found.has(t)) found.set(t, { files: [], kinds: new Set() });
        const e = found.get(t);
        e.kinds.add(name);
        if (!e.files.includes(rel)) e.files.push(rel);
      }
    }
  }
  return found;
}

/** @returns {Map<string, number>|null} 生产存储里 topic → 条数；不可读返回 null。 */
function scanProductionTopics() {
  if (!existsSync(BUS_STORAGE)) return null;
  try {
    const raw = JSON.parse(readFileSync(BUS_STORAGE, 'utf8'));
    const tbl = raw?.tables?.events ?? raw?.events ?? raw;
    const rows = Object.values(tbl ?? {});
    const counts = new Map();
    for (const r of rows) {
      const t = r?.envelope?.topic ?? r?.topic;
      if (typeof t !== 'string') continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    return counts;
  } catch {
    return null;
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
function main() {
  const files = codeFiles();
  const codeTopics = scanCodeTopics(files);
  const prodTopics = scanProductionTopics();

  if (UPDATE) {
    const all = new Set([...codeTopics.keys(), ...(prodTopics ? prodTopics.keys() : [])]);
    const topics = {};
    for (const t of [...all].sort()) {
      topics[t] = {
        evidence: {
          code: codeTopics.get(t)?.files ?? [],
          productionCount: prodTopics ? (prodTopics.get(t) ?? 0) : null,
        },
      };
    }
    const registry = {
      version: '1.0',
      generatedAt: new Date().toISOString(),
      generatedBy: 'bin/verify-event-topics.mjs --update',
      source: {
        code: 'plugins/<name>/lib/ + plugins/<name>/*.js（排除 test/）',
        production: relative(REPO_ROOT, BUS_STORAGE).split(sep).join('/'),
        productionAvailable: prodTopics !== null,
      },
      note:
        '事实清单 = 代码字面量 ∪ 生产实测 topic。生产侧能捞到静态扫不到的动态构造 topic ' +
        '（模板串/变量），两者缺一都会漏。新增 topic 需刻意登记：先改代码再跑 --update，' +
        '让 diff 里能看见这个新主题。',
      topicCount: all.size,
      topics,
    };
    // 无 BOM 落盘（教训 §4：带 BOM 的 JSON 下游 JSON.parse 直接拒收）
    writeRegistry(REGISTRY_PATH, registry);
    console.log(`[verify-event-topics] 已重建事实清单 ${REGISTRY_PATH}`);
    console.log(`  topic 总数 ${all.size}（代码 ${codeTopics.size} · 生产 ${prodTopics ? prodTopics.size : 'n/a'}）`);
    process.exit(0);
  }

  // ── 校验模式 ────────────────────────────────────────────────────────────
  let registry;
  try {
    registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  } catch (e) {
    console.error(
      `[verify-event-topics] 读不到事实清单 ${REGISTRY_PATH}: ${e?.message || e}\n` +
        '  首次使用请先跑：node bin/verify-event-topics.mjs --update',
    );
    process.exit(2);
  }
  const known = new Set(Object.keys(registry.topics || {}));

  const unregistered = [];
  for (const [t, e] of [...codeTopics].sort()) {
    if (!known.has(t)) {
      unregistered.push({ topic: t, kind: 'UNREGISTERED_TOPIC', files: e.files });
    }
  }

  // 清单里有、但代码和生产都找不到痕迹 ⇒ 可能已被删除
  const stale = [];
  for (const t of known) {
    if (!codeTopics.has(t) && !(prodTopics && prodTopics.has(t))) {
      stale.push({ topic: t, kind: 'STALE_ENTRY' });
    }
  }

  // 生产里有、清单里没有 ⇒ 动态发布方没登记（Tier B 才能看到）
  const prodOnly = [];
  if (prodTopics) {
    for (const [t, n] of [...prodTopics].sort()) {
      if (!known.has(t)) prodOnly.push({ topic: t, kind: 'PRODUCTION_UNREGISTERED', count: n });
    }
  }

  const failed = unregistered.length > 0;

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          scannedFiles: files.length,
          codeTopics: codeTopics.size,
          registryTopics: known.size,
          productionAvailable: prodTopics !== null,
          unregistered,
          stale,
          prodOnly,
          failed,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `[verify-event-topics] 扫描 ${files.length} 个生产代码文件 · ` +
        `代码 topic ${codeTopics.size} · 清单 ${known.size} · ` +
        `生产${prodTopics ? ` ${prodTopics.size}` : ' 不可用'}`,
    );

    if (unregistered.length > 0) {
      console.log(`\n  ✗ 未登记 topic ${unregistered.length} 个（新增主题必须刻意登记）:`);
      for (const u of unregistered) {
        console.log(`     ${u.topic}  ← ${u.files.slice(0, 2).join(', ')}`);
      }
      console.log(`\n  确认是预期的新主题后跑：node bin/verify-event-topics.mjs --update`);
    } else {
      console.log('\n  ✓ 代码里所有 topic 都在事实清单中');
    }

    if (stale.length > 0) {
      console.log(`\n  ⚠️ 清单里已无痕迹的条目 ${stale.length} 个（可能已被删除）:`);
      for (const s of stale) console.log(`     ${s.topic}`);
    }
    if (prodOnly.length > 0) {
      console.log(`\n  ⚠️ 生产存在但清单未登记 ${prodOnly.length} 个（动态发布方）:`);
      for (const p of prodOnly) console.log(`     ${p.topic} (${p.count} 条)`);
    }
  }

  process.exit(failed ? 1 : 0);
}

function writeRegistry(path, obj) {
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

// 被 import 时（单测）不执行主流程，否则 process.exit 会把测试进程一起带走。
// ⛔ 两侧必须是同一种形式（Windows 路径 vs file:/// URL 比不出相等，会静默假绿）。
const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main();
