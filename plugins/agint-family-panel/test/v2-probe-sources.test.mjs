/**
 * 探针 source 名单 + 宿主换版残留目录（*.tmp）的排除。
 *
 * 两条判据都来自 2026-10-18 的实测误报：
 *  ① live 面板把 `agint-evolution-memory-probe` 报成「运行态不在仓库」。它是 09-04
 *     的一次性手工探针（payload.origin=manual-test），仓库 git 全历史 0 次新增该目录，
 *     三处部署根 0 个同名目录。误报根源是判据用 `agint-` 前缀代替语义。
 *  ② live payload 里 `repoDirs=117`（78 个 `*.tmp` 残留）、`familyDirs` 里混进
 *     `agint-quality.tmp`。误报根源是目录过滤只排除 `.bak-`，没排除换版中转目录。
 *
 * 本文件只做**结构断言**，不读生产存储：生产行会随运行变化，断言它等于把测试
 * 绑在一次快照上。要核生产请用 deploy 探针，不在单测里做。
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROBE_EVENT_SOURCES, pluginIdentities, topLevelPluginDirs, collectV2Data,
} from '../lib/v2-data.js';
import { scanPlugins } from '../lib/v2-scan.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures', 'v2-probe-sources');
const PLUGINS = join(FIX, 'plugins');
const STORAGES = join(FIX, 'storages');
const mkdir = (p) => mkdirSync(p, { recursive: true });
const write = (p, s) => { mkdir(dirname(p)); writeFileSync(p, s); };

// ── 夹具：三个真插件 + 两种换版残留形态 + 一个备份目录（对照） ──────────
for (const name of ['agint-real-a', 'agint-real-b', 'agint-quality']) {
  mkdir(join(PLUGINS, name, 'lib'));
  write(join(PLUGINS, name, 'lib', 'index.js'), 'export const x = 1;\n');
}
// 残留形态 1：无时间戳
mkdir(join(PLUGINS, 'agint-quality.tmp', 'lib'));
write(join(PLUGINS, 'agint-quality.tmp', 'lib', 'index.js'), 'export const y = 2;\n');
// 残留形态 2：带时间戳（宿主每次换版都留一个）
mkdir(join(PLUGINS, 'agint-real-a.tmp-20261018-115959', 'lib'));
write(join(PLUGINS, 'agint-real-a.tmp-20261018-115959', 'lib', 'index.js'), 'export const z = 3;\n');
// 对照：备份目录本来就该排除（.bak- 既有行为，防我这次改动把它弄丢）
mkdir(join(PLUGINS, 'agint-real-b.bak-20260101', 'lib'));

// storages 最小形态：让 collectV2Data 的四个源各自降级，不抛
mkdir(STORAGES);

// ══ 1. PROBE_EVENT_SOURCES 形状 ════════════════════════════════════════
{
  assert.ok(Array.isArray(PROBE_EVENT_SOURCES), '必须是数组');
  assert.ok(Object.isFrozen(PROBE_EVENT_SOURCES), '必须冻结（防下游 push 污染）');
  for (const s of ['agint-evolution-memory-probe', 'verify-after-fix', 'verify-final']) {
    assert.ok(PROBE_EVENT_SOURCES.includes(s), `名单须含 ${s}`);
  }
  // 名单里的名字不得同时是真插件身份 —— 否则会把真缺口静默归到探针栏消音。
  const ids = new Set(pluginIdentities(PLUGINS).map((u) => u.id));
  for (const s of PROBE_EVENT_SOURCES) {
    assert.equal(ids.has(s), false, `探针名 ${s} 不得是真插件身份`);
  }
}

// ══ 2. 与 event-bus 的 KNOWN_EVENT_SOURCES 探针段双向比对 ══════════════
// 为什么不 import 那份文件：它顶层 import zod，面板不该为一张名单拉进别人的依赖。
// 改为读文本解析。两侧任一侧漂移（加了探针没同步 / 删了还在名单）都会红。
{
  const schemasPath = join(here, '..', '..', 'agint-event-bus', 'lib', 'schemas.js');
  const text = readFileSync(schemasPath, 'utf8');
  const block = /KNOWN_EVENT_SOURCES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(text);
  assert.ok(block, '未能在 agint-event-bus/lib/schemas.js 里定位 KNOWN_EVENT_SOURCES（解析漂移）');
  const busNames = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(busNames.length >= 3, `解析出的 source 名单过短（${busNames.length}），解析可能坏了`);
  for (const s of PROBE_EVENT_SOURCES) {
    assert.ok(busNames.includes(s), `event-bus 名单缺探针 ${s} —— 两侧漂移`);
  }
  // 反向：event-bus 里带 -probe / verify- 之名的，本名单都得有。
  // 只查这两种形态，避免把 agint-* 真插件也要求进探针名单。
  const busProbeish = busNames.filter((n) => n.includes('-probe') || n.startsWith('verify-'));
  assert.deepEqual(
    busProbeish.slice().sort(), [...PROBE_EVENT_SOURCES].sort(),
    'event-bus 的探针型 source 与本名单不一致',
  );
}

// ══ 3. *.tmp 残留不进身份表 / 顶层目录 / 扫描结果 ═══════════════════════
{
  const ids = pluginIdentities(PLUGINS).map((u) => u.id).sort();
  assert.deepEqual(ids, ['agint-quality', 'agint-real-a', 'agint-real-b'],
    'identity 集合须排除 .tmp 残留与 .bak- 备份');

  const tops = topLevelPluginDirs(PLUGINS);
  assert.equal(tops.some((d) => d.includes('.tmp')), false, 'topLevelPluginDirs 不得含 .tmp');
  assert.equal(tops.some((d) => d.includes('.bak-')), false, 'topLevelPluginDirs 不得含 .bak-');

  const scan = scanPlugins(PLUGINS, null);
  assert.equal(scan.familyDirs.some((d) => d.includes('.tmp')), false, 'familyDirs 不得含 .tmp');
  assert.equal(scan.units.some((d) => d.includes('.tmp')), false, 'units 不得含 .tmp');
  // 对照：真插件仍在（不能因为过滤过宽把功能目录也砍掉）
  assert.ok(scan.familyDirs.includes('agint-real-a'), '真插件必须仍在 familyDirs');
  assert.ok(scan.units.includes('agint-quality'), '真插件必须仍在 units');
}

// ══ 4. payload 下发 probeEventSources ══════════════════════════════════
{
  const payload = collectV2Data(
    { pluginsDir: PLUGINS, storagesDir: STORAGES, repoPluginsDir: PLUGINS },
    { cache: new Map() },
  );
  assert.ok(Array.isArray(payload.probeEventSources), 'payload 必须带 probeEventSources 数组');
  assert.deepEqual(payload.probeEventSources, [...PROBE_EVENT_SOURCES], '下发内容须与常量一致');
  // repoDirs 也吃同一条过滤（否则前端 known 集合会重新变大，差集失效）
  assert.ok(Array.isArray(payload.repoDirs), 'repoDirs 须是数组');
  assert.equal(payload.repoDirs.some((d) => d.includes('.tmp')), false, 'repoDirs 不得含 .tmp');
  assert.equal(payload.repoDirs.some((d) => d.includes('.bak-')), false, 'repoDirs 不得含 .bak-');
  assert.deepEqual(payload.repoDirs.slice(), ['agint-quality', 'agint-real-a', 'agint-real-b']);
}

// ══ 5. 前端不再硬编码第二份名单 ═════════════════════════════════════════
// 判据：panel-v2.html 里出现探针名字面量 ⇒ 说明有人在浏览器半复制了名单。
// 名单只准住在 v2-data.js；前端只读 payload。
{
  const html = readFileSync(join(here, '..', 'assets', 'panel-v2.html'), 'utf8');
  for (const s of PROBE_EVENT_SOURCES) {
    assert.equal(html.includes(s), false,
      `panel-v2.html 硬编码了探针名 ${s} —— 名单须只住在 v2-data.js`);
  }
  assert.ok(html.includes('PROBE_SOURCES'), '前端须消费 payload.probeEventSources');
}

console.log('v2-probe-sources.test.mjs PASS');
