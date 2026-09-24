#!/usr/bin/env node
/**
 * verify-umbrella.mjs —— 伞键（namespace key）存在性硬验证
 *
 * 为什么需要它：
 *   cordis 的 service store 是**扁平的**，按确切键名查。
 *   ctx.provide('agint.mutator.propose') 之后 ctx.get('agint.mutator') 恒为 undefined 且不报错。
 *   改代码补了 provide('agint.mutator', {...})，但如果只改了一个副本、
 *   或改了 lib 忘了改 src（K78）、或部署没生效 —— 生产依旧静默降级。
 *   静态 grep 只能证明"代码里有这行"，证明不了"运行时真的注册上了"。
 *
 * 本脚本用 mock ctx 真正跑一遍每个插件的 apply()，再检查注册进来的伞键：
 *   存在 + 是对象 + 至少有一个自有方法 ⇒ PASS
 *   缺失 / undefined / 空对象        ⇒ FAIL
 *
 * 用法：
 *   node bin/verify-umbrella.mjs            # 验部署位（bundle + 镜像）
 *   node bin/verify-umbrella.mjs --repo     # 验仓库源码位
 *   node bin/verify-umbrella.mjs --json
 *
 * @author AGINT
 */

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');
const REPO = join(HOME, 'profiles/web');
const BUNDLE_DIR = join(REPO, 'node_modules/@agint/host/plugins');
const MIRROR_DIR = join(REPO, 'plugins');
const SRC_DIR = process.cwd();

/** 期望存在的伞键 —— anyOf 给出至少应有的一等方法作为"非空壳"判据 */
/** consumes：该插件声明的硬依赖全名键 —— 拿不到就会静默降级，必须一并验到 */
const EXPECT = {
  'agint-event-bus': [{ key: 'agint.eventBus', anyOf: ['publish', 'emit', 'subscribe'] }],
  'agint-mutator': [
    { key: 'agint.mutator', anyOf: ['propose', 'commit', 'rollback', 'io'] },
    { consumes: ['agint.eventBus.publish', 'agint.eventBus.subscribe'] },
  ],
  'agint-population': [
    { key: 'agint.population', anyOf: ['publishProposed', 'checkLimit', 'publishMountRequest'] },
    { consumes: ['agint.mutator'] },
  ],
  'agint-diagnosis': [{ key: 'agint.diagnosis', anyOf: ['annotate', 'cluster', 'report', 'schemas'] }],
  'agint-self-model': [{ key: 'agint.selfModel', anyOf: ['snapshot', 'inspectSummary', 'record'] }],
};

/** 依赖预载顺序：cordis 扁平 store，没有依赖先行，消费方拿到的就是 undefined */
const BOOT_ORDER = ['agint-event-bus', 'agint-diagnosis', 'agint-self-model', 'agint-mutator', 'agint-population'];

const C = {
  b: '\x1b[1m', r: '\x1b[0m', dim: '\x1b[2m',
  red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m',
};

function makeCtx() {
  const registry = new Map();
  const noopTable = () => ({
    get: async () => null,
    set: async () => undefined,
    upsert: async () => undefined,
    remove: async () => undefined,
    list: async () => [],
    query: async () => [],
    count: async () => 0,
    close: () => undefined,
  });
  const storageHandle = {
    table: (n) => noopTable(n),
    close: () => undefined,
    upsert: async () => undefined,
  };
  const ctx = {
    // cordis 风格：provide 写注册表
    provide(name, value) {
      registry.set(name, value);
    },
    get(name) {
      return registry.get(name);
    },
    'provide.has': () => false,
    storageDomain: {
      open: () => Promise.resolve(storageHandle),
      openIfExists: () => Promise.resolve(null),
    },
    on: () => () => {},
    once: () => () => {},
    emit: () => {},
    emitEvent: () => {},
    middleware: () => () => {},
    command: () => ({}),
    plugin: () => ({}),
    effect: () => () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    sleep: () => Promise.resolve(),
    config: {},
    logger: Object.assign(Object.fromEntries(
      ['debug', 'info', 'warn', 'error', 'success'].map((k) => [k, () => {}]),
    ), { child: () => ctx.logger }),
    root: { config: {} },
    events: [],
    dispose: () => {},
  };
  ctx.scope = { dispose: () => {}, config: {}, runtime: {} };
  return { ctx, registry };
}

async function loadApply(entryUrl) {
  const mod = await import(entryUrl);
  const apply = mod.apply || mod.default?.apply || (typeof mod.default === 'function' ? mod.default : null);
  return apply;
}

async function applyPlugin(rootDir, plugin, ctx, registry) {
  const entry = join(rootDir, plugin, 'lib/index.js');
  if (!existsSync(entry)) return { ok: false, why: 'entry not found' };
  let apply;
  try {
    apply = await loadApply(pathToFileURL(entry).href);
  } catch (e) {
    return { ok: false, code: 'LOAD_FAIL', why: String(e?.message || e).split('\n')[0] };
  }
  if (typeof apply !== 'function') return { ok: false, code: 'NO_APPLY', why: 'no exported apply()' };
  try {
    await apply(ctx, {});
  } catch (e) {
    const why = String(e?.message || e).split('\n')[0];
    if (!registry.size) return { ok: false, code: 'APPLY_THROW', why };
    return { ok: true, threw: why };
  }
  return { ok: true };
}

async function checkOne(rootDir, plugin, tag) {
  const entry = join(rootDir, plugin, 'lib/index.js');
  if (!existsSync(entry)) return { tag, plugin, status: 'SKIP', why: 'entry not found' };
  const { ctx, registry } = makeCtx();
  // 依赖先行：模拟 cordis 的 inject 时序，否则消费方必然拿不到依赖 —— 那是假阴性不是缺陷
  // 取 BOOT_ORDER 中位于本插件之前的全部先 boot；不在 BOOT_ORDER 里的插件按首轮顺序兜底
  const idx = BOOT_ORDER.indexOf(plugin);
  const pre = idx >= 0 ? BOOT_ORDER.slice(0, idx) : BOOT_ORDER;
  for (const dep of pre) {
    if (dep === plugin) continue;
    await applyPlugin(rootDir, dep, ctx, registry);
  }
  const r = await applyPlugin(rootDir, plugin, ctx, registry);
  if (!r.ok) return { tag, plugin, status: r.code || 'FAIL', why: r.why };
  const results = [];
  for (const spec of EXPECT[plugin] || []) {
    if (spec.consumes) {
      for (const key of spec.consumes) {
        const v = registry.get(key);
        if (v === undefined || v === null) {
          results.push({ key, ok: false, kind: 'consume', why: `硬依赖 ${key} 取不到 ⇒ 该插件会静默降级` });
        } else {
          results.push({ key, ok: true, kind: 'consume', why: `可取（${typeof v === 'function' ? 'function' : 'object'}）` });
        }
      }
      continue;
    }
    const { key, anyOf } = spec;
    const v = registry.get(key);
    if (v === undefined || v === null) {
      results.push({ key, ok: false, why: '未注册（运行时拿得到 undefined）' });
      continue;
    }
    if (typeof v !== 'object' && typeof v !== 'function') {
      results.push({ key, ok: false, why: `注册值类型异常：${typeof v}` });
      continue;
    }
    const own = typeof v === 'function' ? [] : Object.keys(v);
    const hit = anyOf.filter((m) => own.includes(m) || typeof v[m] === 'function');
    if (!own.length && hit.length === 0) {
      results.push({ key, ok: false, why: '空对象（注册了但没有任何成员）' });
      continue;
    }
    if (!hit.length) {
      results.push({ key, ok: false, why: `成员不含预期方法（有 ${own.slice(0, 6).join(',')}）` });
      continue;
    }
    results.push({ key, ok: true, members: own.length, hit });
  }
  return { tag, plugin, status: 'OK', results, registeredCount: registry.size };
}

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const USE_REPO = argv.includes('--repo');

const targets = USE_REPO
  ? [{ tag: 'repo', dir: join(SRC_DIR, 'plugins') }]
  : [{ tag: 'bundle', dir: BUNDLE_DIR }, { tag: 'mirror', dir: MIRROR_DIR }];

const rows = [];
for (const { tag, dir } of targets) {
  for (const plugin of Object.keys(EXPECT)) {
    if (!existsSync(join(dir, plugin))) continue;
    rows.push(await checkOne(dir, plugin, tag));
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
} else {
  console.log(`${C.b}── 伞键运行时验证 ──${C.r}`);
  console.log(`  ${C.dim}目标：${targets.map((t) => t.tag).join(' + ')}${C.r}\n`);
  for (const r of rows) {
    const head = `  [${r.tag}] ${r.plugin}`;
    if (r.status !== 'OK') {
      console.log(`${head}  ${C.yel}${r.status}${C.r}  ${C.dim}${r.why || ''}${C.r}`);
      continue;
    }
    console.log(`${head}  ${C.dim}注册 ${r.registeredCount} 键${C.r}`);
    for (const x of r.results) {
      const mark = x.ok ? `${C.grn}PASS${C.r}` : `${C.red}FAIL${C.r}`;
      console.log(`    ${mark} ${x.key}  ${C.dim}${x.why || `成员 ${x.members} 个，含 ${x.hit.join('/')}`}${C.r}`);
    }
  }
}

const bad = rows.filter((r) => r.status !== 'OK' || (r.results || []).some((x) => !x.ok));
if (!AS_JSON) {
  const totalSlots = rows.reduce((n, r) => n + (r.results?.length || 1), 0);
  console.log(`\n${C.b}结论${C.r}: ${bad.length === 0 ? `${C.grn}PASS${C.r}` : `${C.red}FAIL${C.r}`} — ${rows.length - bad.length}/${rows.length} 插件合格（${totalSlots} 个伞键槽位）`);
}
process.exit(bad.length > 0 ? 1 : 0);
