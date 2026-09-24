#!/usr/bin/env node
/**
 * check-wiring.mjs —— AGINT 接线完整性门禁（L0 静态 + 生产数据对账）
 *
 * 起源：K63「影子发布空壳识别法」+ 文档 §「通用教训」里点名要自动化的那个检查。
 * 之前每次盘点都是人肉 grep，结论写进文档后立刻开始腐坏（09-20 记的 3 个空壳服务，
 * 到 09-24 已经有 2 个被处理过，文档却还写着未处理）。
 *
 * 三查：
 *   A. 空壳服务  —— ctx.provide('agint.*') 注册了，但生产目录里没人 ctx.get 它
 *   B. 孤儿主题  —— 有订阅方、无发布方（或反之），且生产数据为 0
 *   C. 生产对账  —— 读真实事件存储，按 topic 计数，揭穿「代码有了但从未通电」
 *
 * ⚠️ 判定边界（别过度归因）：
 *   - 生产调用点剔除 /test/ 与 eval/scenarios/ —— 测试自己调自己不算接线
 *   - 「有人喊」≠「有人应」：本脚本只证明调用点存在，不证明调用真跑到了（K64 教训）
 *   - 生产数据为 0 但接线完整 = 尚未触发，不是缺口（会标 NOT_YET_FIRED 而非 FAIL）
 *
 * 用法：
 *   node bin/check-wiring.mjs              人读输出
 *   node bin/check-wiring.mjs --json       CI 消费
 *   node bin/check-wiring.mjs --strict     NOT_YET_FIRED 也算失败
 *
 * 退出码：0 = 无缺口 / 1 = 有缺口 / 2 = 脚本自身出错
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BUS_STORAGE = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'storages', 'agint_event_bus.json')
  : join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'storages', 'agint_event_bus.json');

const EXEMPTIONS_FILE = join(REPO_ROOT, 'docs', 'wiring-exemptions.json');

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const STRICT = argv.includes('--strict');

/** 读豁免清单。⛔ 清单文件缺失 = 门禁失去治理入口，直接报错而不是静默放行。 */
let exemp = { shellServices: [], topics: [], domains: [] };
try {
  exemp = JSON.parse(readFileSync(EXEMPTIONS_FILE, 'utf8'));
} catch (e) {
  console.error(`[check-wiring] 读不到豁免清单 ${EXEMPTIONS_FILE}: ${e?.message || e}`);
  process.exit(2);
}
const exempTopic = new Map((exemp.topics || []).map((t) => [t.topic, t]));
const exempDomain = new Map((exemp.domains || []).map((d) => [d.domain, d]));
const exempService = new Map((exemp.shellServices || []).map((s) => [s.name, s]));
/** 冒牌服务名：看着像 agint.* 服务，其实是配置键之类。查 F 里要排除。 */
const exempNonService = new Set((exemp.nonServiceNames || []).map((x) => x.name));

const TOPIC_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,3}$/;

/** 生产目录判定：排除测试、eval 驱动、备份、node_modules */
function isProdPath(rel) {
  const p = rel.split(sep).join('/');
  if (p.includes('/node_modules/')) return false;
  if (p.includes('/test/') || p.endsWith('.test.mjs') || p.endsWith('.test.js')) return false;
  if (p.includes('/eval/scenarios/')) return false;
  if (p.includes('/.agint-backups/') || p.includes('/fixtures/')) return false;
  return true;
}

/** 递归收集 .js/.mjs 文件 */
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(m?js|ts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** 剔除注释行（K76 同源坑：注释里的包名会造误报） */
function stripComments(src) {
  return src
    .split('\n')
    .map((l) => {
      const t = l.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
      return l;
    })
    .join('\n');
}

const allFiles = walk(join(REPO_ROOT, 'plugins')).map((f) => ({
  abs: f,
  rel: relative(REPO_ROOT, f),
}));

// ─────────────────────────── 查 A：空壳服务 ───────────────────────────
const provided = new Map(); // name -> [{file,line}]
const consumed = new Map(); // name -> [{file,line}]

for (const { abs, rel } of allFiles) {
  let src;
  try {
    src = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const code = stripComments(src);
  const lines = code.split('\n');

  lines.forEach((line, i) => {
    // 本行是不是「取不到就走默认值」的可选注入（含 ?? 兜底）—— 是则不算断链
    const HAS_FALLBACK = /\?\?/.test(line);
    // 注册：ctx.provide('agint.xxx', ...)
    for (const m of line.matchAll(/ctx\.provide\(\s*['"`](agint\.[a-zA-Z0-9_.:-]+)['"`]/g)) {
      if (!provided.has(m[1])) provided.set(m[1], []);
      provided.get(m[1]).push({ file: rel, line: i + 1 });
    }
    // 消费形态 1：ctx.get('agint.xxx') / ctx.get?.('agint.xxx')
    for (const m of line.matchAll(/ctx\.get\??\(\s*['"`](agint\.[a-zA-Z0-9_.:-]+)['"`]/g)) {
      addConsumed(m[1], rel, i + 1, 'get', HAS_FALLBACK);
    }
    // 消费形态 2：方括号访问 ctx['agint.mutator.stats']（tools.js 里的主流写法）
    for (const m of line.matchAll(/ctx(?:\[|\?\.\s*)\[?\s*['"`](agint\.[a-zA-Z0-9_.:-]+)['"`]\s*\]/g)) {
      addConsumed(m[1], rel, i + 1, 'bracket', HAS_FALLBACK);
    }
    // 消费形态 3：cordis inject 声明 —— `inject = ['tools', 'agint.curator']`
    for (const m of line.matchAll(/['"`](agint\.[a-zA-Z0-9_.:-]+)['"`]/g)) {
      if (/inject/.test(line)) addConsumed(m[1], rel, i + 1, 'inject', HAS_FALLBACK);
    }
    // 消费形态 4：任意字符串字面量出现在生产代码里（弱证据，仅用于排除"完全没人提"）
    for (const m of line.matchAll(/['"`](agint\.[a-zA-Z0-9_.:-]+)['"`]/g)) {
      if (isProdPath(rel)) addConsumed(m[1], rel, i + 1, 'literal', HAS_FALLBACK);
    }
  });

  // inject 数组可能跨多行：`const inject = [\n  'storageDomain',\n  'agint.curator',\n];`
  const injectBlock = code.match(/inject\s*(?::\s*)?=?\s*\[([\s\S]{0,400}?)\]/);
  if (injectBlock) {
    for (const m of injectBlock[1].matchAll(/['"`](agint\.[a-zA-Z0-9_.:-]+)['"`]/g)) {
      addConsumed(m[1], rel, 0, 'inject', false);
    }
  }
}

function addConsumed(name, file, line, via, hasFallback = false) {
  if (!consumed.has(name)) consumed.set(name, []);
  const list = consumed.get(name);
  // 同一处若已有记录，保留「无兜底」的那条（无兜底 = 更硬的证据）
  const prev = list.find((c) => c.file === file && c.line === line && c.via === via);
  if (prev) {
    if (!hasFallback) prev.hasFallback = false;
    return;
  }
  list.push({ file, line, via, hasFallback, name });
}

/**
 * 判定某服务是否有生产消费点。
 * 证据强度分两级（避免「命名空间拿到了」被当成「方法真被调」）：
 *   DIRECT         —— 精确名字被 ctx.get/inject 引用
 *   NAMESPACE_ONLY —— 只拿到父命名空间（如注入 'agint.mutator' 后调 .propose()）
 *                     静态分析到此为止：无法确证子键被访问，标为弱证据，不判 FAIL
 */
function evidenceOf(name) {
  const all = consumed.get(name) || [];
  const strong = all.filter((c) => isProdPath(c.file) && c.via !== 'literal');
  if (strong.length) return { level: 'DIRECT', calls: strong };
  const parts = name.split('.');
  for (let i = parts.length - 1; i > 1; i--) {
    const ns = parts.slice(0, i).join('.');
    const nsCalls = (consumed.get(ns) || []).filter((c) => isProdPath(c.file) && c.via !== 'literal');
    if (nsCalls.length) return { level: 'NAMESPACE_ONLY', calls: nsCalls, via: ns };
  }
  const mentioned = all.filter((c) => isProdPath(c.file) && c.via === 'literal');
  if (mentioned.length) return { level: 'MENTIONED', calls: mentioned };
  return { level: 'NONE', calls: [] };
}

const shellServices = [];
const weakServices = [];
for (const [name, regs] of [...provided].sort()) {
  const ev = evidenceOf(name);
  const testOnly = (consumed.get(name) || []).filter((c) => !isProdPath(c.file));
  if (ev.level === 'NONE') shellServices.push({ name, registeredAt: regs, testOnlyCallers: testOnly });
  else weakServices.push({ name, registeredAt: regs, evidence: ev, level: ev.level });
}

// ─────────────────────────── 查 B：主题发布/订阅 ───────────────────────────
const publishers = new Map(); // topic -> [{file,line}]
const subscribers = new Map(); // topic -> [{file,line}]

for (const { abs, rel } of allFiles) {
  let src;
  try {
    src = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const code = stripComments(src);
  const lines = code.split('\n');

  lines.forEach((line, i) => {
    // 订阅形态 1（强）：SubscriptionSchema 的复数 topics —— `topics: ['a', 'b']`
    for (const m of line.matchAll(/topics:\s*\[([^\]]*)\]/g)) {
      for (const t of m[1].matchAll(/['"`]([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,3})['"`]/g)) {
        if (!TOPIC_RE.test(t[1])) continue;
        if (!subscribers.has(t[1])) subscribers.set(t[1], []);
        subscribers.get(t[1]).push({ file: rel, line: i + 1, via: 'topics-array' });
      }
    }
    // 订阅形态 2：subscribe(...) 调用附近（跨行配置表，窗口 15 行）
    //   ⚠️ 窗口内只认 `topic:` / `topics:` 键后的字符串 —— 全抓会把 inject 的服务名
    //      （如 'agint.evolution'）误当 topic，制造假缺口。
    if (/subscribe\s*\(/.test(line)) {
      const chunk = lines.slice(i, i + 15).join('\n');
      for (const m of chunk.matchAll(/topics?:\s*['"`\[]?\s*['"`]?([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,3})['"`]/g)) {
        if (!TOPIC_RE.test(m[1])) continue;
        if (!subscribers.has(m[1])) subscribers.set(m[1], []);
        subscribers.get(m[1]).push({ file: rel, line: i + 1, via: 'subscribe-call' });
      }
    }
    // 发布 / 订阅二分：单数 `topic: 'x'` —— 以 **payload 是否存在** 为准
    //   EventEnvelope 必有 payload；订阅配置表（如 trajectory 的 {topic,source,role}）没有。
    const pubMatch = line.match(/topic:\s*['"`]([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,3})['"`]/);
    if (pubMatch && TOPIC_RE.test(pubMatch[1])) {
      const chunk = lines.slice(i, i + 5).join('\n');
      const isEnvelope = /\bpayload\b|correlationId/.test(chunk);
      const bucket = isEnvelope ? publishers : subscribers;
      if (!bucket.has(pubMatch[1])) bucket.set(pubMatch[1], []);
      bucket.get(pubMatch[1]).push({ file: rel, line: i + 1, via: isEnvelope ? 'envelope' : 'topic-only' });
    }
  });
}

// ─────────────────────────── 查 C：生产数据对账 ───────────────────────────
let prodCounts = null;
let prodTotal = 0;
let prodDead = 0;
let prodError = null;
try {
  if (!existsSync(BUS_STORAGE)) throw new Error(`not found: ${BUS_STORAGE}`);
  const raw = JSON.parse(readFileSync(BUS_STORAGE, 'utf8'));
  // 存储形态：{ unit, global, tables: { events: { <uuid>: { envelope: { topic, ... } } }, deadletter: {...} } }
  const eventsTbl = raw?.tables?.events ?? raw?.events ?? raw;
  const rows = Array.isArray(eventsTbl) ? eventsTbl : Object.values(eventsTbl ?? {});
  prodCounts = new Map();
  for (const r of rows) {
    const t = r?.envelope?.topic ?? r?.topic;
    if (typeof t !== 'string') continue;
    prodTotal++;
    prodCounts.set(t, (prodCounts.get(t) || 0) + 1);
  }
  prodDead = (raw?.tables?.deadletter ? Object.keys(raw.tables.deadletter).length : 0);
} catch (e) {
  prodError = e?.message || String(e);
}

const allTopics = new Set([...publishers.keys(), ...subscribers.keys(), ...(prodCounts?.keys() ?? [])]);
const topicRows = [];
for (const t of [...allTopics].sort()) {
  const pubs = (publishers.get(t) || []).filter((p) => isProdPath(p.file));
  const subs = (subscribers.get(t) || []).filter((s) => isProdPath(s.file));
  const n = prodCounts ? (prodCounts.get(t) || 0) : null;
  let verdict;
  // ⚠️ 生产数据是「有没有人真在发」的最高判据，高于静态扫描：
  //    静态找不到发布方但生产有 N 条 ⇒ 发布方是动态构造（模板串/变量），不是缺口。
  if (pubs.length === 0 && subs.length > 0) verdict = n > 0 ? 'PUBLISHER_DYNAMIC' : 'ORPHAN_TOPIC';
  else if (pubs.length > 0 && subs.length === 0) verdict = n > 0 ? 'NO_SUBSCRIBER' : 'NOT_YET_FIRED';
  else if (pubs.length === 0 && subs.length === 0) verdict = n > 0 ? 'PUBLISHER_DYNAMIC' : 'DATA_ONLY';
  else if (n === 0) verdict = 'NOT_YET_FIRED';
  else verdict = 'OK';
  const ex = exempTopic.get(t);
  topicRows.push({
    topic: t,
    publishers: pubs,
    subscribers: subs,
    prodCount: n,
    verdict: ex ? 'EXEMPTED' : verdict,
    rawVerdict: verdict,
    exemption: ex || null,
  });
}

// ─────────────── 查 D：存储域通电（挂载了但从没写过 = 从未真正运行） ───────────────
// 判据：插件用 defineDomain({ name: 'agint_xxx' }) 声明了独占存储域，
//       但 $DSH_HOME/storages/ 里连 agint_xxx.json 都没有 —— 说明这个插件挂上后
//       一次都没被真正调用过（存储域是「首次写」才落盘的）。
//       ⚠️ 与「挂载了 ≠ 跑过」同族，但这是**外部可观测**的那一条：
//       不需要进宿主进程，看磁盘就知道。
const STORAGE_DIR = BUS_STORAGE.slice(0, BUS_STORAGE.lastIndexOf(sep));
const domains = new Map(); // domain -> {plugin, file, line}
for (const { abs, rel } of allFiles) {
  let src;
  try {
    src = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  stripComments(src)
    .split('\n')
    .forEach((line, i) => {
      const m = line.match(/name:\s*['"`](agint_[a-z0-9_]+)['"`]/);
      if (!m) return;
      const plugin = rel.split(sep)[1] || rel;
      if (!domains.has(m[1])) domains.set(m[1], { plugin, file: rel, line: i + 1 });
    });
}

const energized = [];
const neverEnergized = [];
for (const [dom, info] of [...domains].sort()) {
  const f = join(STORAGE_DIR, `${dom}.json`);
  const size = existsSync(f) ? statSync(f).size : null;
  const ex = exempDomain.get(dom) || null;
  (size === null ? neverEnergized : energized).push({ domain: dom, ...info, size, exemption: ex });
}
const deadReal = neverEnergized.filter((d) => !d.exemption);
const deadExempt = neverEnergized.filter((d) => d.exemption);

// ───────── 查 F：命名空间错配（取了「没注册过的名字」= 恒 undefined） ─────────
// ⭐⭐⭐ 本仓最隐蔽的一类断链，机制见 plugins/agint-curriculum/lib/index.js:121-124：
//   cordis 的 service store 是**扁平的**（按确切键名查），
//   所以 ctx.provide('agint.mutator.propose') 之后，
//   ctx.get('agint.mutator') 恒为 undefined —— 不会报错，只会软降级。
// 于是出现一种「代码对、运行错」的状态：调用点写得很正常，
//   拿到的永远是 null，走 degrade/skipped 分支，日志里连一条 error 都没有。
const missingServices = [];
for (const [name, calls] of [...consumed].sort()) {
  if (!name.startsWith('agint.')) continue; // 宿主内建（storageDomain/tools 等）不在本仓注册
  if (provided.has(name)) continue; // 精确注册了，没问题
  // 这里**不排除 literal**：softDep(ctx, 'agint.mutator')、NAMES 数组里
  // 'agint.mutator.stats' 这类都是真实取用，漏掉它们就漏掉真错配。
  //
  // 但要排除**有兜底的可选注入**：`ctx.getService?.('agint.probeFn') ?? probeStaging`
  // 这种取不到就走默认，是设计上的可选项，不是断链 —— 报出来只会淹没真信号。
  const prodCalls = calls.filter(
    (c) => isProdPath(c.file) && !c.hasFallback && !exempNonService.has(name),
  );
  if (!prodCalls.length) continue;
  // 父键也没注册 ⇒ 真错配。父键注册了 ⇒ 是子键访问（如 agint.cron.xxx），合法。
  const parts = name.split('.');
  let parentProvided = false;
  for (let i = parts.length - 1; i > 1; i--) {
    if (provided.has(parts.slice(0, i).join('.'))) {
      parentProvided = true;
      break;
    }
  }
  if (parentProvided) continue;
  missingServices.push({ name, calls: prodCalls });
}

// ─────── 查 G：TS 源与产物一致性（只改 lib/*.js 会被下次 build 静默回退） ──────
// K78：有 src/*.ts 的插件，lib/*.js 是 tsc 产物。只改产物 = 改动活到下次 build 为止。
// 这里对账两边 provide 出来的服务键集合 —— 源里少了哪把钥匙，build 后就会消失。
const tsDrift = [];
{
  const pluginsRoot = join(REPO_ROOT, 'plugins');
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const srcDir = join(pluginsRoot, entry.name, 'src');
    const libDir = join(pluginsRoot, entry.name, 'lib');
    if (!existsSync(srcDir) || !existsSync(libDir)) continue;

    const keysIn = (dir) => {
      const set = new Set();
      for (const f of walk(dir)) {
        let s;
        try {
          s = readFileSync(f, 'utf8');
        } catch {
          continue;
        }
        for (const m of stripComments(s).matchAll(/ctx\.provide\(\s*['"`]([a-zA-Z0-9_.:-]+)['"`]/g)) {
          set.add(m[1]);
        }
      }
      return set;
    };
    const srcKeys = keysIn(srcDir);
    const libKeys = keysIn(libDir);
    const onlyLib = [...libKeys].filter((k) => !srcKeys.has(k)).sort();
    const onlySrc = [...srcKeys].filter((k) => !libKeys.has(k)).sort();
    if (onlyLib.length || onlySrc.length) {
      tsDrift.push({ plugin: entry.name, onlyInLib: onlyLib, onlyInSrc: onlySrc });
    }
  }
}

// ───────────── 查 E：双副本一致性（bundle 位 vs 兼容镜像位） ─────────────
// 背景：bundle 化后插件有两份落盘 ——
//   bundle 位  $DSH_HOME/profiles/web/node_modules/@agint/host/plugins/
//   镜像位     $DSH_HOME/profiles/web/plugins/
// preset 的 tools 行仍指向镜像位（相对路径 ../../profiles/web/plugins/...），
// 服务插件则走 bundle 位。install.sh 双目标同步，所以正常情况两份逐字节相同。
// ⚠️ 一旦走偏（只同步了一处 / 手工改了一处），preset 加载的 tools.js 与
//    bundle 里的服务插件就是两个模块实例，模块级状态不共享 —— 且不会报错。
const PROFILE_DIR = join(STORAGE_DIR, '..', 'profiles', 'web');
const BUNDLE_PLUGINS = join(PROFILE_DIR, 'node_modules', '@agint', 'host', 'plugins');
const MIRROR_PLUGINS = join(PROFILE_DIR, 'plugins');

function sha(s) {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}

const dup = { checked: 0, identical: 0, divergent: [], mirrorMissing: [], presetRefs: 0 };
if (existsSync(BUNDLE_PLUGINS) && existsSync(MIRROR_PLUGINS)) {
  for (const dir of readdirSync(BUNDLE_PLUGINS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const sub of ['lib/tools.js', 'lib/index.js']) {
      const bPath = join(BUNDLE_PLUGINS, dir.name, sub);
      const mPath = join(MIRROR_PLUGINS, dir.name, sub);
      if (!existsSync(bPath)) continue;
      dup.checked++;
      if (!existsSync(mPath)) {
        dup.mirrorMissing.push(`${dir.name}/${sub}`);
        continue;
      }
      let a;
      let b;
      try {
        a = readFileSync(bPath);
        b = readFileSync(mPath);
      } catch {
        continue;
      }
      if (sha(a) === sha(b)) dup.identical++;
      else dup.divergent.push(`${dir.name}/${sub}`);
    }
  }
  // preset 实际引用了多少条镜像位路径（= 双实例风险面的大小）
  const presetsDir = join(STORAGE_DIR, '..', '.agent-presets');
  if (existsSync(presetsDir)) {
    for (const p of readdirSync(presetsDir, { withFileTypes: true })) {
      if (!p.isDirectory()) continue;
      const yml = join(presetsDir, p.name, 'agent.cordis.yml');
      if (!existsSync(yml)) continue;
      dup.presetRefs += (readFileSync(yml, 'utf8').match(/plugins\/[a-z0-9-]+\/lib\/tools\.js/g) || []).length;
    }
  }
}
const dupOk = dup.divergent.length === 0 && dup.mirrorMissing.length === 0;

// ───────────── 查 H：仓库 ↔ 部署位漂移（改了没上线 / 线上比仓库新） ─────────
// MEMORY 三层之痛：仓库有代码 ≠ 部署到宿主 ≠ 挂载生效。
// 查 E 只对比两份部署位，覆盖不到「改了仓库但忘了跑 install」——
// 而 umbrella 键那次就是这么差点漏验收的（02:20 部署，宿主 00:35 就起来了）。
//
// 这类漂移在开发中是**常态**（改完还没部署），所以默认只报清单、不进退出码；
// --strict 下才视为缺口。目的是让"上线前还有什么没同步"一眼可见。
const REPO_PLUGINS = join(fileURLToPath(new URL('..', import.meta.url)), 'plugins');

function listLibFiles(root) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const libDir = join(root, d.name, 'lib');
    if (!existsSync(libDir)) continue;
    const walk = (cur, rel) => {
      for (const e of readdirSync(cur, { withFileTypes: true })) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(cur, e.name), p);
        else if (e.name.endsWith('.js')) out.push(`${d.name}/lib/${p}`);
      }
    };
    walk(libDir, '');
  }
  return out;
}

const drift = { checked: 0, repoNewer: [], hostNewer: [], repoOnly: [], hostOnly: [] };
if (existsSync(BUNDLE_PLUGINS) && existsSync(REPO_PLUGINS)) {
  const repoFiles = new Set(listLibFiles(REPO_PLUGINS));
  const hostFiles = new Set(listLibFiles(BUNDLE_PLUGINS));
  for (const rel of repoFiles) {
    drift.checked++;
    const rp = join(REPO_PLUGINS, rel);
    const hp = join(BUNDLE_PLUGINS, rel);
    if (!hostFiles.has(rel)) {
      drift.repoOnly.push(rel);
      continue;
    }
    try {
      const a = readFileSync(rp);
      const b = readFileSync(hp);
      if (sha(a) !== sha(b)) drift.repoNewer.push(rel);
    } catch {
      /* ignore */
    }
  }
  // 反方向：部署位有、仓库没有 —— 更危险，说明宿主被本地改过而仓库不知情
  for (const rel of hostFiles) {
    if (!repoFiles.has(rel)) drift.hostOnly.push(rel);
  }
}
const driftOk = drift.repoNewer.length === 0 && drift.hostOnly.length === 0;

// ─────────────────────────── 输出 ────────────────────────────────────────
const fails = [
  ...shellServices.filter((s) => !exempService.has(s.name)).map((s) => ({ kind: 'SHELL_SERVICE', name: s.name })),
  ...topicRows
    .filter((r) => r.verdict === 'ORPHAN_TOPIC' || r.verdict === 'NO_SUBSCRIBER')
    .map((r) => ({ kind: r.verdict, name: r.topic })),
];
const soft = topicRows.filter((r) => r.verdict === 'NOT_YET_FIRED');
const exitCode =
  fails.length > 0 || (STRICT && soft.length > 0) || !dupOk || tsDrift.length > 0 ? 1 : 0;

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        busStorage: BUS_STORAGE,
        prodTotal,
        prodDead,
        prodError,
        shellServices: shellServices.map((s) => ({
          name: s.name,
          registeredAt: s.registeredAt,
          testOnlyCallers: s.testOnlyCallers,
        })),
        weakServices: weakServices.map((s) => ({
          name: s.name,
          level: s.level,
          registeredAt: s.registeredAt,
          evidence: s.evidence.calls,
        })),
        topics: topicRows.map((r) => ({
          topic: r.topic,
          verdict: r.verdict,
          rawVerdict: r.rawVerdict,
          exemption: r.exemption,
          prodCount: r.prodCount,
          publishers: r.publishers,
          subscribers: r.subscribers,
        })),
        missingServices: missingServices.map((m) => ({
          name: m.name,
          callers: m.calls.map((c) => `${c.file}:${c.line}(${c.via})`),
        })),
        tsDrift,
        dualCopy: dup,
        drift: {
          checked: drift.checked,
          repoNewer: drift.repoNewer,
          repoOnly: drift.repoOnly,
          hostOnly: drift.hostOnly,
          ok: driftOk,
        },
        domains: {
          energized: energized.map((d) => ({ domain: d.domain, plugin: d.plugin, bytes: d.size })),
          neverEnergized: neverEnergized.map((d) => ({
            domain: d.domain,
            plugin: d.plugin,
            declaredAt: `${d.file}:${d.line}`,
            exemption: d.exemption,
          })),
        },
        exitCode,
      },
      null,
      2,
    ),
  );
  process.exit(exitCode);
}

const C = { red: '\x1b[31m', grn: '\x1b[32m', yel: '\x1b[33m', dim: '\x1b[2m', b: '\x1b[1m', r: '\x1b[0m' };
console.log(`${C.b}AGINT 接线完整性门禁${C.r}  ${C.dim}${new Date().toISOString()}${C.r}`);
console.log(`${C.dim}生产存储: ${BUS_STORAGE}${C.r}`);
if (prodError) console.log(`${C.yel}⚠ 生产存储读不到：${prodError}${C.r}\n`);
else console.log(`生产事件总数: ${prodTotal}（死信 ${prodDead}）\n`);

console.log(`${C.b}── 查 A：空壳服务（注册了但生产无人调用）──${C.r}`);
if (shellServices.length === 0) {
  console.log(`  ${C.dim}无${C.r}`);
} else {
  for (const s of shellServices) {
    console.log(`  ${C.red}SHELL${C.r} ${s.name}`);
    console.log(`    ${C.dim}注册: ${s.registeredAt.map((r) => `${r.file}:${r.line}`).join(', ')}${C.r}`);
    if (s.testOnlyCallers.length)
      console.log(`    ${C.dim}仅测试调用: ${s.testOnlyCallers.map((r) => `${r.file}:${r.line}`).join(', ')}${C.r}`);
  }
}

const nsOnly = weakServices.filter((s) => s.level === 'NAMESPACE_ONLY');
const mentioned = weakServices.filter((s) => s.level === 'MENTIONED');
if (nsOnly.length) {
  console.log(`\n${C.b}── 查 A'：弱证据服务（只拿到父命名空间，子键调用无法静态确证）──${C.r}`);
  for (const s of nsOnly) {
    const ev = s.evidence.calls[0];
    console.log(`  ${C.yel}WEAK${C.r} ${s.name}  ${C.dim}← ${ev.file}:${ev.line}${C.r}`);
  }
}
if (mentioned.length) {
  console.log(`\n${C.b}── 查 A''：仅字面量提及（生产代码里出现过名字，但无真实取用）──${C.r}`);
  for (const s of mentioned) {
    const ev = s.evidence.calls[0];
    console.log(`  ${C.dim}MENTION ${s.name}  ← ${ev.file}:${ev.line}${C.r}`);
  }
}

console.log(`\n${C.b}── 查 B/C：主题接线 × 生产数据 ──${C.r}`);
console.log(`  ${C.dim}${'TOPIC'.padEnd(30)}${'VERDICT'.padEnd(16)}PUB/SUB   PROD${C.r}`);
for (const r of topicRows) {
  const mark =
    r.verdict === 'OK' ? ' ' : r.verdict === 'NOT_YET_FIRED' ? `${C.yel}!${C.r}` : `${C.red}x${C.r}`;
  const v =
    r.verdict === 'OK' ? r.verdict : r.verdict === 'NOT_YET_FIRED' ? `${C.yel}${r.verdict}${C.r}` : `${C.red}${r.verdict}${C.r}`;
  console.log(
    `  ${mark} ${r.topic.padEnd(30)}${v.padEnd(16 + (v.length - r.verdict.length))}${r.publishers.length}/${r.subscribers.length}       ${r.prodCount ?? '-'}`,
  );
}

console.log(`\n${C.b}── 查 D：存储域通电（挂载了但从没写过 = 从未真正运行）──${C.r}`);
console.log(`  ${C.dim}已通电 ${energized.length} / 从未通电 ${neverEnergized.length}（其中豁免 ${deadExempt.length}）${C.r}`);
for (const d of deadReal) {
  console.log(`  ${C.red}DEAD${C.r} ${d.domain}  ${C.dim}(${d.plugin}) 声明于 ${d.file}:${d.line}${C.r}`);
}
for (const d of deadExempt) {
  console.log(`  ${C.dim}EXEMPT ${d.domain} (${d.plugin}) — ${d.exemption.reason}${C.r}`);
}

console.log(`\n${C.b}── 查 F：命名空间错配（取了没注册的名字 ⇒ 恒 undefined，不报错只软降级）──${C.r}`);
if (missingServices.length === 0) {
  console.log(`  ${C.dim}无${C.r}`);
} else {
  for (const m of missingServices) {
    console.log(`  ${C.red}MISSING${C.r} ${m.name}`);
    for (const c of m.calls.slice(0, 3)) console.log(`    ${C.dim}← ${c.file}:${c.line} (${c.via})${C.r}`);
  }
}

console.log(`\n${C.b}── 查 G：TS 源/产物漂移（只改 lib 会被下次 build 静默回退，K78）──${C.r}`);
if (tsDrift.length === 0) {
  console.log(`  ${C.dim}无漂移${C.r}`);
} else {
  for (const d of tsDrift) {
    console.log(`  ${C.red}DRIFT${C.r} ${d.plugin}`);
    if (d.onlyInLib.length) console.log(`    ${C.red}仅在 lib（build 后丢失）: ${d.onlyInLib.join(', ')}${C.r}`);
    if (d.onlyInSrc.length) console.log(`    ${C.yel}仅在 src（产物未重建）: ${d.onlyInSrc.join(', ')}${C.r}`);
  }
}

console.log(`\n${C.b}── 查 E：双副本一致性（bundle 位 vs 兼容镜像位）──${C.r}`);
if (!dup.checked) {
  console.log(`  ${C.dim}跳过：未检出双副本布局（非 bundle 部署）${C.r}`);
} else {
  console.log(
    `  ${dupOk ? C.dim : C.red}${dup.identical}/${dup.checked} 一致${C.r}  ${C.dim}preset 引用镜像位 ${dup.presetRefs} 条${C.r}`,
  );
  for (const d of dup.divergent) console.log(`  ${C.red}DIVERGED${C.r} ${d}`);
  for (const d of dup.mirrorMissing) console.log(`  ${C.yel}MIRROR-MISSING${C.r} ${d}`);
}

console.log(`\n${C.b}── 查 H：仓库 ↔ 部署位漂移 ──${C.r}`);
if (!drift.checked) {
  console.log(`  ${C.dim}跳过：未检出 bundle 部署布局${C.r}`);
} else {
  console.log(
    `  ${C.dim}比对 ${drift.checked} 个 lib 文件${C.r}  ` +
      `${drift.repoNewer.length ? `${C.yel}待上线 ${drift.repoNewer.length}${C.r}  ` : `${C.grn}已全部同步${C.r}  `}` +
      `${drift.hostOnly.length ? `${C.red}部署位多出 ${drift.hostOnly.length}${C.r}  ` : ''}` +
      `${drift.repoOnly.length ? `${C.dim}仓库独有 ${drift.repoOnly.length}${C.r}` : ''}`,
  );
  const VERBOSE = argv.includes('--verbose');
  const show = (label, arr, color) => {
    if (!arr.length) return;
    const head = VERBOSE ? arr : arr.slice(0, 8);
    console.log(`  ${color}${label}${C.r}`);
    for (const f of head) console.log(`    ${C.dim}${f}${C.r}`);
    if (!VERBOSE && arr.length > head.length) console.log(`    ${C.dim}… 另 ${arr.length - head.length} 条（--verbose 展开）${C.r}`);
  };
  show('待上线（仓库已改，部署位还是旧的 —— 需跑 install 才生效）', drift.repoNewer, C.yel);
  show('部署位独有（宿主被本地改过，仓库不知情 —— 下次 install 会被覆盖）', drift.hostOnly, C.red);
  show('仓库独有（新文件尚未部署）', drift.repoOnly, C.dim);
}

console.log(`\n${C.b}结论${C.r}: ${fails.length} 硬缺口 / ${soft.length} 未触发 / ${deadReal.length} 域从未通电${dupOk ? '' : ' / 双副本已走偏'}${driftOk ? '' : ' / 存在待上线改动'}`);
if (fails.length) console.log(`${C.red}FAIL${C.r} — ${fails.map((f) => `${f.kind}(${f.name})`).join(', ')}`);
else if (STRICT && soft.length) console.log(`${C.red}FAIL(strict)${C.r} — 存在从未触发的主题`);
else console.log(`${C.dim}PASS${C.r}`);
process.exit(exitCode);
