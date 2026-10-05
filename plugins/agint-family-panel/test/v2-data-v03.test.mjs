/**
 * v2-data v0.3.0 新导出单测：isRepoRoot / classifyPlugins / resolveV2Dirs
 * 三级回退 / readManifestConsumes 身份优先级。
 *
 * 夹具自建于 test/fixtures/v2-data-v03/（每次运行重建）：⛔ 绝不碰
 * test/fixtures/v2-home/ 与 v2-repo/ —— 既有 v2-data.test.mjs 在用，改了连坐。
 *
 * 判据全部来自结构事实（目录有无 lib/、子目录有无 manifest.json、main 字段
 * 形状），不来自人工名单。每个导出都配了 negative control：实现一旦退化成
 * 「更宽」（只看 plugins/、nested 不认 manifest、unmounted 覆盖所有 kind）或
 * 「更窄」（tool-only 认根级 tools.js、library 不认 package.json）就会红。
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeStorages } from './fixtures/make-storages.mjs';
import { isRepoRoot, classifyPlugins, classifyPluginsWithMount, readMountedFromPatch, resolveV2Dirs, collectV2Data } from '../lib/v2-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures', 'v2-data-v03');
const PLUGINS = join(FIX, 'plugins');
const norm = (p) => String(p).replace(/\\/g, '/');

// ── 夹具生成 ────────────────────────────────────────────────────────────
// 本文件独占 v2-data-v03/。刻意**不做** rm -rf 重建：整树递归删既踩环境的
// 批量删除保护（>50 文件即拦），也让「跑完残留半棵树」变成噪音。改为幂等覆盖
// 写 —— 每次运行都把夹具重写成本文件声明的样子，代价为零。
// 陈旧夹具（上一版用过、本版改名的目录）由下面那条「磁盘目录集合 == 声明集合」
// 断言当场逮住，红在明处，而不是静默混进 classifyPlugins 的输出里。

const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };
const mkdir = (p) => mkdirSync(p, { recursive: true });
const cordis = (o) => ({ spec: { cordis: o } });

/** 插件夹具表。tools/provides 省略即空数组；lib:true 建 lib/；nested 下的子目录带 manifest。 */
const PLUGIN_SPEC = {
  // ── checker：存在 lib/checkers/ 目录（2026-10-04 补）──
  // 判据优先于其余全部：agint-chkx 同时是「tools 非空 + provides 非空」的 host 形态，
  // 若 checker 判据缺失它就会退化成 host，面板随之把静态检查器误报「从未接线」。
  'agint-chkx': { main: 'lib/index.js', tools: ['c.a'], provides: ['agint.chkx'], lib: true, checkers: true },
  // 反向对照：只有 lib/checkers.js 单文件、没有 checkers/ 目录 ⇒ 不是 checker。
  // 判据必须是**目录**而非路径前缀包含，否则任何含 "checkers" 字样的文件都会中招。
  'agint-chkfile': { main: 'lib/index.js', tools: ['c.b'], provides: ['agint.chkfile'], lib: true, libFiles: ['checkers.js'] },

  // ── host：判据「其余」的最典型样，tools 非空 ⇒ 绝不可能是 sdk ──
  'agint-hostx': { main: 'lib/index.js', tools: ['h.a'], provides: ['agint.hostx'], lib: true },
  'agint-nodir': { main: 'lib/index.js', lib: true },
  'agint-badjson': { lib: true, brokenManifest: true },
  'agint-empty': {},

  // ── sdk：tools 为空 + provides 非空 ──
  'agint-sdky': { main: 'lib/svc.js', provides: ['agint.sdky'], lib: true },
  'agint-cordtop': { main: 'lib/svc.js', topLevelCordis: { provides: ['agint.ct'] }, lib: true },

  // ── library：main 是 index.js。agint-libx 同时 provides>0/tools=0，
  //    若实现把 library 判在 sdk 之后，它会变成 sdk ⇒ 优先级守卫。 ──
  'agint-libx': { main: 'index.js', provides: ['agint.libx'] },
  'agint-libdot': { main: './index.js' },
  'agint-libpkg': { pkgMain: 'index.js' }, // 无 manifest.json，main 来自 package.json

  // ── tool-only：main 命中 /(^|\/)lib\/tools(\.js)?$/ ──
  'agint-tools': { main: 'lib/tools.js', tools: ['t1', 't2'] },
  'agint-toolbare': { main: './lib/tools' },
  // 反向对照：根级 tools.js（无 lib/ 段）与 lib/tools/index.js（未锚定 $）
  // 都不该算 tool-only；tools 非空使其落回 host。
  'agint-toolmiss': { main: 'tools.js', tools: ['x'] },
  'agint-tooldeep': { main: 'lib/tools/index.js', tools: ['x'] },

  // ── container vs sdk：同一份「provides>0 且 tools=0」剖面，唯一差别是
  //    有没有 lib/。有嵌套子插件但**无 lib/** ⇒ container；有 lib/ ⇒ sdk。
  //    这两条必须不同，否则 container 判据形同虚设。 ──
  'agint-cont': { main: 'lib/index.js', provides: ['agint.cont'], nested: { 'agint-cont-core': { provides: ['agint.cont.core'], defaultLib: false } } },
  'agint-cont-withlib': { main: 'lib/index.js', provides: ['agint.cwl'], lib: true, nested: { 'agint-cwl-core': { provides: ['agint.cwl.core'] } } },
  // 子目录存在但**没有 manifest.json** ⇒ nested 只认带 manifest 的子目录，
  // 于是无 lib/ 也不该判成 container（落回 sdk）。
  'agint-bare-sub': { main: 'lib/index.js', provides: ['agint.bare'], bareSub: ['agint-bare-core'] },
  // SKIP_FOR_KIND 里的目录名一律不算子插件：test/ tests/ fixtures/ schemas/
  // bin/ examples/ assets/ docs/ node_modules/ 下都放了带 manifest 的孙目录。
  'agint-skipset': { provides: ['agint.skip'], skipWrapped: ['test', 'tests', 'fixtures', 'schemas', 'bin', 'examples', 'assets', 'docs', 'node_modules'] },
  // 'lib' 也在跳过集里：lib/ 内有带 manifest 的子目录，nested 仍须为空。
  // 这条只能靠 nested 数组观测（kind 上被 hasLib 掩盖）。
  // 位置很关键：子目录必须真在 lib/ **里面** —— 跳过集过滤的是插件根下的
  // 条目名，摆在根下的同名子目录根本不走这条判据，测不到东西。
  'agint-libskip': { main: 'lib/index.js', tools: ['x'], lib: true, nestedInLib: { 'agint-lib-inner': {} } },

  // ── readManifestConsumes 身份优先级用 ──
  'agint-top': { consumes: ['top.only'], lib: true },
  // 顶层与嵌套同名、consumes 不同 ⇒ 身份归顶层（v2-scan 同一套优先级）
  'agint-dup': { consumes: ['dup.top'], lib: true },
  'agint-vendor': { nested: { 'agint-dup': { consumes: ['dup.nested'] } } },
  // 门面 vs真身：顶层有 manifest 但**没有 lib/**（仓库位 quality 家族就是这形态，
  // main 指向 ../agint-quality/<name>/lib/index.js）。此时真身（有 lib）才是身份，
  // 门面的 manifest 只是 plugin-check 入口，不作数。
  'agint-facade': { consumes: ['facade.stub'], nested: { 'agint-facade-real': { consumes: ['facade.real'] } } },
  'agint-facade-real': { consumes: ['facade.real'], lib: true },
  // 仅嵌套存在的身份（agint-quality-eval 形状）⇒ 也要读得到
  'agint-quality': { nested: { 'agint-quality-eval': { consumes: ['agint.q.eval'] } } },
  // 空 consumes / 无 consumes ⇒ 不进 manifestConsumes
  'agint-noconsume': { consumes: [] },
  'agint-noconsume2': {},

  // ── 必须被忽略的目录 ──
  'not-family': { main: 'index.js' },
  'agint-gone.bak-20260101': { main: 'lib/index.js' },
};

mkdir(PLUGINS);
for (const [name, s] of Object.entries(PLUGIN_SPEC)) {
  const root = join(PLUGINS, name);
  mkdir(root);
  if (s.lib) mkdir(join(root, 'lib'));
  if (s.checkers) mkdir(join(root, 'lib', 'checkers'));
  for (const f of s.libFiles ?? []) writeFileSync(join(root, 'lib', f), '// fixture\n');
  if (s.bareSub) for (const b of s.bareSub) mkdir(join(root, b)); // 无 manifest ⇒ 不算 nested
  if (s.skipWrapped) {
    for (const w of s.skipWrapped) {
      mkdir(join(root, w, `agint-inner-${w}`));
      writeJson(join(root, w, `agint-inner-${w}`, 'manifest.json'), { name: `agint-inner-${w}`, spec: { cordis: { provides: ['agint.inner'] } } });
    }
  }
  for (const [sub, ss] of Object.entries(s.nested ?? {})) {
    // 嵌套子插件要有 lib/ 才算独立身份（判据与 codeRoots 统一，见下面 NESTED_WITH_LIB）。
    // defaultLib: true 让大多数嵌套项成为身份；defaultLib:false 造「有 manifest 但无
    // 代码」的子目录（现实中 quality 家族的门面目录就是这形态）。
    if (ss.defaultLib !== false) mkdir(join(root, sub, 'lib'));
    writeJson(join(root, sub, 'manifest.json'), {
      name: sub,
      main: ss.main ?? 'lib/index.js',
      ...(ss.provides ? { spec: { cordis: { provides: ss.provides } } } : {}),
      ...(ss.consumes ? { spec: { cordis: { consumes: ss.consumes } } } : {}),
    });
  }
  // 放进 lib/ 内部的带 manifest 子目录：用来验证 'lib' 在 SKIP_FOR_KIND 里
  for (const [sub, ss] of Object.entries(s.nestedInLib ?? {})) {
    writeJson(join(root, 'lib', sub, 'manifest.json'), { name: sub, main: 'lib/index.js' });
  }
  if (s.brokenManifest) { writeFileSync(join(root, 'manifest.json'), '{ this is not json'); continue; }
  if (s.pkgMain) { writeJson(join(root, 'package.json'), { name, main: s.pkgMain }); continue; }
  const c = { ...(s.tools ? { tools: s.tools } : {}), ...(s.provides ? { provides: s.provides } : {}), ...(s.consumes ? { consumes: s.consumes } : {}) };
  if (Object.keys(c).length === 0 && s.main === undefined) continue; // agint-empty / not-family 无 manifest
  writeJson(join(root, 'manifest.json'), {
    name,
    ...(s.main !== undefined ? { main: s.main } : {}),
    ...(s.topLevelCordis ? { cordis: s.topLevelCordis } : (Object.keys(c).length ? cordis(c) : {})),
  });
}

// 仓库位 / 部署位对照目录（给 isRepoRoot 与 resolveV2Dirs 的 self-path 回退）
const REPO_OK = join(FIX, 'repo-ok');            // plugins/ + cordis.patch.yml ⇒ 仓库根
const REPO_ALT = join(FIX, 'repo-alt');          // 同上，第二个合法仓库根
const REPO_SELF = join(FIX, 'repo-self');        // 同上，自身路径回退的落点
const DEPLOY_WEB = join(FIX, 'deploy-like', 'profiles', 'web'); // 只有 plugins/ ⇒ 不是仓库根
const PATCH_ONLY = join(FIX, 'patch-only');      // 只有 cordis.patch.yml
const NEITHER = join(FIX, 'neither');            // 两者都没有
const DSH = join(FIX, 'v03-home');
for (const r of [REPO_OK, REPO_ALT, REPO_SELF]) {
  mkdir(join(r, 'plugins', 'agint-family-panel', 'lib'));
  writeFileSync(join(r, 'cordis.patch.yml'), '# patch\n');
}
mkdir(join(DEPLOY_WEB, 'plugins', 'agint-family-panel', 'lib'));
mkdir(PATCH_ONLY); writeFileSync(join(PATCH_ONLY, 'cordis.patch.yml'), '# patch\n');
mkdir(NEITHER);
mkdir(DSH);

// 上一版夹具残留守卫：磁盘上的插件目录集合必须与本文件声明的完全一致。
// 少了 ⇒ 声明里有插件没生成（构造漏了）；多了 ⇒ 有陈旧目录（改名后没清），
// 它会混进 classifyPlugins 的输出让断言在错误的输入上假绿。
assert.deepEqual(
  readdirSync(PLUGINS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(),
  Object.keys(PLUGIN_SPEC).sort(),
  '夹具目录集合与声明不一致（残留或漏建）',
);

// ══ 1. isRepoRoot ═══════════════════════════════════════════════════════
// 标记必须同时是 plugins/ 与 cordis.patch.yml。
{
  assert.equal(isRepoRoot(REPO_OK), true, 'plugins/ + cordis.patch.yml ⇒ 仓库根');

  // ⛔ 回归守卫：部署位 <home>/profiles/web/plugins 的父目录 web/ 同样有
  // plugins/。只看 plugins/ 的旧实现会把部署目录误认成仓库 —— 那正是
  // resolveV2Dirs 自身路径回退要躲的坑（selfRepoCandidate 取的是 plugins 的
  // 上上级）。此条红了就说明判据退化成「只看 plugins/」。
  assert.equal(isRepoRoot(DEPLOY_WEB), false, '只有 plugins/（部署位 web/ 形状）⇒ 不是仓库根');

  // 另两个方向各一条：实现若只看 cordis.patch.yml，或把两个标记都放行，一样会红。
  assert.equal(isRepoRoot(PATCH_ONLY), false, '只有 cordis.patch.yml ⇒ 不是仓库根');
  assert.equal(isRepoRoot(NEITHER), false, '两个标记都没有 ⇒ 不是仓库根');

  // 目录不存在 ⇒ false 且不抛（existsSync 天然不抛，但要求是「不抛」不是「恰好不抛」）
  const missing = join(FIX, 'no-such-dir', 'deeper');
  assert.equal(existsSync(missing), false, '前提：目标目录确实不存在');
  assert.doesNotThrow(() => isRepoRoot(missing), '目录不存在不得抛');
  assert.equal(isRepoRoot(missing), false, '目录不存在 ⇒ false');
}

// ══ 2. classifyPlugins ═════════════════════════════════════════════════
const K = classifyPlugins(PLUGINS);
{
  // 值域与形状
  // 身份集合 = 顶层 agint-* 目录（聚合容器/门面也算，它们要能被判形态）
  //          **加**有 lib/ 的嵌套子插件身份（2026-10-04 契约变更）：
  // 只分类顶层会让 quality-contract 这类嵌套服务库查不到形态，于是落进「真僵尸
  // 候选」——而它正被 quality-policy 消费，不是死代码。
  // ⛔ 嵌套目录**没有 lib/** 时不算身份（判据统一到 codeRoots）：
  //    有 manifest 但无代码的子目录不产生代码边，让它进表只会虚增形态行。
  const TOP_IDS = Object.keys(PLUGIN_SPEC).filter((k) => k.startsWith('agint-') && !k.includes('.bak-'));
  const NESTED_WITH_LIB = new Set(['agint-quality-eval', 'agint-cwl-core']);
  assert.deepEqual(Object.keys(K).filter((k) => !TOP_IDS.includes(k) && !NESTED_WITH_LIB.has(k)), [],
    '键集合 = 顶层 agint-* 目录 + 有 lib 的嵌套子插件，无其它');
  for (const id of NESTED_WITH_LIB) {
    assert.ok(id in K, `有 lib 的嵌套身份 ${id} 必须被分类`);
  }
  // 无 lib 的嵌套目录（有 manifest 但无代码）不得进表
  assert.ok(!('agint-cont-core' in K), '嵌套目录无 lib/ ⇒ 不算独立身份（否则虚增形态行）');
  assert.ok(!('not-family' in K), '非 agint- 前缀忽略');
  assert.ok(!('agint-gone.bak-20260101' in K), '.bak- 目录忽略');
  for (const [k, v] of Object.entries(K)) {
    // checker 字段 2026-10-04 补：判「存在 lib/checkers/ 目录的静态检查器」，
    // 它扫别的插件源码里的字面量 token、自己 ctx.get 为 0 是职责不是断线。
    assert.deepEqual(Object.keys(v).sort(), ['checker', 'kind', 'main', 'nested', 'provides', 'tools'], `${k} 字段形状`);
    assert.ok(['container', 'tool-only', 'library', 'sdk', 'host', 'unmounted', 'checker'].includes(v.kind), `${k} kind 在值域内`);
    assert.equal(typeof v.checker, 'boolean', `${k} checker 是布尔`);
  }

  // checker（判据 = 存在 lib/checkers/ 目录，优先于其余全部）
  assert.equal(K['agint-chkx'].kind, 'checker', '有 lib/checkers/ 目录 ⇒ checker（即使本形态上是 host）');
  assert.equal(K['agint-chkx'].checker, true, 'checker 标志为 true');
  assert.equal(K['agint-chkfile'].kind, 'host', '只有 lib/checkers.js 单文件、目录不存在 ⇒ 不是 checker');
  assert.equal(K['agint-chkfile'].checker, false, 'checker 标志为 false');
  for (const [k, v] of Object.entries(K)) {
    if (k === 'agint-chkx') continue;
    assert.equal(v.checker, false, `${k} 非checker：标志必须为 false（否则判据放宽到了全仓）`);
  }

  // host
  assert.equal(K['agint-hostx'].kind, 'host', 'tools 非空 ⇒ host');
  assert.equal(K['agint-nodir'].kind, 'host', '无 cordis 段 ⇒ host');
  assert.equal(K['agint-empty'].kind, 'host', '空目录：main 未知 ⇒ host');
  assert.equal(K['agint-badjson'].main, null, '坏 manifest：main 未知而非抛');
  assert.equal(K['agint-badjson'].kind, 'host', '坏 manifest 仍给出形态');

  // sdk
  assert.equal(K['agint-sdky'].kind, 'sdk', 'tools 空 + provides 非空 ⇒ sdk');
  assert.deepEqual({ t: K['agint-sdky'].tools, p: K['agint-sdky'].provides }, { t: 0, p: 1 });
  assert.equal(K['agint-cordtop'].kind, 'sdk', '顶层 cordis.provides 同样算 provides');
  assert.equal(K['agint-cordtop'].provides, 1, 'm.cordis 分支被读到');

  // library（两种 index.js 写法 + package.json 来源）
  assert.equal(K['agint-libx'].kind, 'library', "main 'index.js' ⇒ library");
  assert.equal(K['agint-libdot'].kind, 'library', "main './index.js' ⇒ library");
  assert.equal(K['agint-libpkg'].kind, 'library', '无 manifest 时 main 取自 package.json');
  assert.equal(K['agint-libpkg'].main, 'index.js');
  // 优先级守卫：agint-libx 的剖面（tools=0/provides>0）与 sdk 一模一样，
  // 只有 main 不同。library 必须先判，否则它会退化成 sdk。
  assert.equal(K['agint-libx'].provides, 1, '前提：agint-libx 的 provides 确实非空');
  assert.notEqual(K['agint-libx'].kind, 'sdk', 'library 优先于 sdk');

  // tool-only（两种 main 形状）+ 两条反向对照
  assert.equal(K['agint-tools'].kind, 'tool-only', "main 'lib/tools.js' ⇒ tool-only");
  assert.deepEqual({ t: K['agint-tools'].tools, m: K['agint-tools'].main }, { t: 2, m: 'lib/tools.js' });
  assert.equal(K['agint-toolbare'].kind, 'tool-only', "main './lib/tools'（无 .js）⇒ tool-only");
  assert.equal(K['agint-toolmiss'].kind, 'host', "根级 'tools.js' 缺 lib/ 段 ⇒ 不是 tool-only");
  assert.equal(K['agint-tooldeep'].kind, 'host', "'lib/tools/index.js' 未锚定 ⇒ 不是 tool-only");
  assert.notEqual(K['agint-toolmiss'].kind, K['agint-tools'].kind, '放宽正则会把根级 tools.js 误判成 tool-only');

  // ── container vs sdk：核心区分 ──
  assert.equal(K['agint-cont'].kind, 'container', '无 lib/ + 子插件目录 ⇒ container');
  assert.deepEqual(K['agint-cont'].nested, ['agint-cont-core']);
  assert.equal(K['agint-cont'].provides, 1, '前提：container 的 provides 也非空（否则区分无意义）');
  assert.equal(K['agint-cont-withlib'].kind, 'sdk', '有 lib/ ⇒ 即使有子插件也不是 container');
  assert.deepEqual(K['agint-cont-withlib'].nested, ['agint-cwl-core'], 'nested 与 hasLib 无关');
  assert.notEqual(K['agint-cont'].kind, K['agint-cont-withlib'].kind, '有/无 lib/ 必须分出两种形态');
  assert.equal(K['agint-cont'].provides, K['agint-cont-withlib'].provides, '两者 provides 剖面相同，唯一差别是 lib/');

  // nested 只认「带 manifest.json 的子目录」
  assert.deepEqual(K['agint-bare-sub'].nested, [], '子目录无 manifest.json ⇒ 不算 nested');
  assert.equal(K['agint-bare-sub'].kind, 'sdk', '子目录无 manifest ⇒ 不判 container（落回 sdk）');
  assert.equal(existsSync(join(PLUGINS, 'agint-bare-sub', 'agint-bare-core')), true, '前提：子目录确实存在');
  assert.notEqual(K['agint-bare-sub'].kind, 'container', '放宽 nested 会把它误判成 container');

  // SKIP_FOR_KIND：跳过集里的目录名不产生 nested
  assert.deepEqual(K['agint-skipset'].nested, [], 'SKIP_FOR_KIND 内的目录不算子插件');
  assert.equal(K['agint-skipset'].kind, 'sdk', '无有效 nested ⇒ 不判 container');
  assert.ok(existsSync(join(PLUGINS, 'agint-skipset', 'test', 'agint-inner-test', 'manifest.json')), '前提：跳过集里的孙目录确实带 manifest');
  assert.deepEqual(K['agint-libskip'].nested, [], "'lib' 在跳过集里 ⇒ lib/ 下的带 manifest 子目录也不算 nested");
}

// ── unmounted：只在传入 mounted Set 时出现，且只改原形态为 host 的行 ──
{
  const none = classifyPlugins(PLUGINS);
  const withEmpty = classifyPlugins(PLUGINS, new Set());
  const withHostx = classifyPlugins(PLUGINS, new Set(['agint-hostx']));

  // 同一插件，两次结果必须不同：不传 ⇒ host，传入且不含它 ⇒ unmounted
  assert.equal(none['agint-nodir'].kind, 'host', '不传 mounted ⇒ host');
  assert.equal(withEmpty['agint-nodir'].kind, 'unmounted', '传入且不含它 ⇒ unmounted');
  assert.notEqual(none['agint-nodir'].kind, withEmpty['agint-nodir'].kind, 'unmounted 判据必须真的生效');

  // 形态原非 host 的行不受 mounted 影响（实现只改 host ⇒ unmounted）
  assert.equal(withEmpty['agint-hostx'].kind, 'unmounted', 'host 行在空 Set 下转 unmounted');
  assert.equal(withEmpty['agint-cont'].kind, 'container', 'container 不被 unmounted 覆盖');
  assert.equal(withEmpty['agint-sdky'].kind, 'sdk', 'sdk 不被 unmounted 覆盖');
  assert.equal(withEmpty['agint-tools'].kind, 'tool-only', 'tool-only 不被 unmounted 覆盖');
  assert.equal(withEmpty['agint-libx'].kind, 'library', 'library 不被 unmounted 覆盖');
  // 扩大判据（对所有 kind 改写）会让上面四条一起红
  assert.notEqual(withEmpty['agint-sdky'].kind, 'unmounted', 'unmounted 只改 host，不改 sdk');

  // 命中 Set ⇒ 保持 host
  assert.equal(withHostx['agint-hostx'].kind, 'host', '在 mounted Set 内 ⇒ 保持 host');
  assert.equal(withHostx['agint-nodir'].kind, 'unmounted', '不在 Set 内 ⇒ unmounted');
  // 非 Set 的第二参数（误传数组）不触发改写，且不抛
  const withArray = classifyPlugins(PLUGINS, ['agint-nodir']);
  assert.equal(withArray['agint-nodir'].kind, 'host', '第二参数非 Set ⇒ 不改写');
  assert.equal(withArray['agint-cont'].kind, 'container', '第二参数非 Set ⇒ 分类仍照常');
}

// 目录不存在 ⇒ 空对象且不抛
assert.deepEqual(classifyPlugins(join(FIX, 'no-such-plugins')), {}, '目录不存在 ⇒ {}');

// ══ 3. resolveV2Dirs 三级回退 ═══════════════════════════════════════════
{
  const env = (o) => ({ DSH_HOME: DSH, ...o });
  const SENTINEL = 'sentinel::unresolvable'; // fileURLToPath 抛 ⇒ selfRepoCandidate 返回 null

  // ① AGINT_HOME 指向真实存在的目录
  const a = resolveV2Dirs(env({ AGINT_HOME: REPO_OK }), SENTINEL);
  assert.equal(norm(a.repoPluginsDir), norm(join(REPO_OK, 'plugins')), '① AGINT_HOME 命中');
  assert.equal(a.repoPluginsSource, 'AGINT_HOME', '① source 标 AGINT_HOME');
  assert.equal(norm(a.pluginsDir), norm(join(DSH, 'profiles', 'web', 'plugins')), 'pluginsDir 由 DSH_HOME 推导');
  assert.equal(norm(a.storagesDir), norm(join(DSH, 'storages')), 'storagesDir 由 DSH_HOME 推导');

  // ② AGINT_REPO_ROOT（且不给 AGINT_HOME）
  const b = resolveV2Dirs(env({ AGINT_REPO_ROOT: REPO_ALT }), SENTINEL);
  assert.equal(norm(b.repoPluginsDir), norm(join(REPO_ALT, 'plugins')), '② AGINT_REPO_ROOT 命中');
  assert.equal(b.repoPluginsSource, 'AGINT_REPO_ROOT', '② source 标 AGINT_REPO_ROOT');

  // 两者都给 ⇒ AGINT_HOME 优先
  const both = resolveV2Dirs(env({ AGINT_HOME: REPO_OK, AGINT_REPO_ROOT: REPO_ALT }), SENTINEL);
  assert.equal(norm(both.repoPluginsDir), norm(join(REPO_OK, 'plugins')), 'AGINT_HOME 优先于 AGINT_REPO_ROOT');
  assert.equal(both.repoPluginsSource, 'AGINT_HOME', '两者都给时 source 仍是 AGINT_HOME');

  // ③ 自身路径：<repo>/plugins/agint-family-panel/lib/ 上溯两级
  const selfUrl = pathToFileURL(join(REPO_SELF, 'plugins', 'agint-family-panel', 'lib', 'v2-data.js')).href;
  const c = resolveV2Dirs(env({}), selfUrl);
  assert.equal(norm(c.repoPluginsDir), norm(join(REPO_SELF, 'plugins')), '③ 自身路径推导命中仓库根');
  assert.equal(c.repoPluginsSource, 'self-path', '③ source 标 self-path');

  // ③ 的 negative control：同一段自身路径，但落在部署位形状的树上
  // （候选=web/，有 plugins/ 无 cordis.patch.yml）⇒ 必须解析不出来。
  // 这条正是 isRepoRoot 收紧要防的那次误认。
  const deploySelfUrl = pathToFileURL(join(DEPLOY_WEB, 'plugins', 'agint-family-panel', 'lib', 'v2-data.js')).href;
  const d = resolveV2Dirs(env({}), deploySelfUrl);
  assert.equal(d.repoPluginsDir, null, '③ 部署位形状不得把自己认成仓库位');
  assert.equal(d.repoPluginsSource, 'unresolved', '部署位形状 ⇒ unresolved');

  // 哨兵 selfUrl（不可解析）⇒ null + unresolved，且不抛。
  // DSH_HOME 已设，故 pluginsDir 走 env 分支；selfRepoCandidate 兜底返回 null。
  let e;
  assert.doesNotThrow(() => { e = resolveV2Dirs(env({}), SENTINEL); }, 'selfUrl 不可解析不得抛');
  assert.equal(e.repoPluginsDir, null, '哨兵 selfUrl ⇒ repoPluginsDir null');
  assert.equal(e.repoPluginsSource, 'unresolved', '哨兵 selfUrl ⇒ source unresolved');
  assert.equal(norm(e.pluginsDir), norm(join(DSH, 'profiles', 'web', 'plugins')), '哨兵不影响 pluginsDir');

  // 已知实现缺陷（v0.3.0 未修，只报告不冻结）：AGINT_HOME 存在但其 plugins/
  // 缺失时，目录会回退到 AGINT_REPO_ROOT，source 却仍标 AGINT_HOME ——
  // provenance 撒谎。下面只断言「取到了某个目录」，不断言错标值，
  // 以免把缺陷冻进测试；期望值与复现步骤见交付简报。
  const partial = join(FIX, 'partial-home');
  mkdir(partial); // 故意不建 plugins/
  const f = resolveV2Dirs(env({ AGINT_HOME: partial, AGINT_REPO_ROOT: REPO_ALT }), SENTINEL);
  assert.equal(norm(f.repoPluginsDir), norm(join(REPO_ALT, 'plugins')), 'AGINT_HOME 无 plugins/ ⇒ 回退到 AGINT_REPO_ROOT');
  assert.ok(['AGINT_HOME', 'AGINT_REPO_ROOT'].includes(f.repoPluginsSource), 'source 落在两种标签之一（当前实现错标为 AGINT_HOME）');
}

// ══ 3b. resolveV2Dirs 候选 ⓪：cordis config.repoRoot ════════════════════
// 本机既有做法：HOME cordis.patch.yml 按插件 id 配 config.repoRoot
// （agint-cron / agint-evolution-driver / agint-evolution-memory 三家已这么配）。
// env 在进程内 restart 链上不可靠（respawn 继承老进程启动那一刻的环境），
// config 由宿主加载时求值 ⇒ 面板必须优先吃它。
{
  const env = (o) => ({ DSH_HOME: DSH, ...o });
  const SENTINEL = 'sentinel::unresolvable';

  // ⓪ 命中：给 config 就用自己的根，且 source 标 config
  const g = resolveV2Dirs(env({}), SENTINEL, REPO_OK);
  assert.equal(norm(g.repoPluginsDir), norm(join(REPO_OK, 'plugins')), '⓪ config.repoRoot 命中');
  assert.equal(g.repoPluginsSource, 'config', '⓪ source 标 config');

  // ⓪ 优先级高于两个环境变量（三者都给 ⇒ config 赢）
  const h = resolveV2Dirs(env({ AGINT_HOME: REPO_ALT, AGINT_REPO_ROOT: REPO_ALT }), SENTINEL, REPO_OK);
  assert.equal(norm(h.repoPluginsDir), norm(join(REPO_OK, 'plugins')), 'config 优先于 AGINT_HOME/AGINT_REPO_ROOT');
  assert.equal(h.repoPluginsSource, 'config', 'config 赢时 source 必须是 config');

  // 空串/空白/非字符串 ⇒ 等于没配，回落 env（不得当成命中标 config）
  for (const bad of [null, undefined, '', '   ', 42, {}]) {
    const r = resolveV2Dirs(env({ AGINT_REPO_ROOT: REPO_ALT }), SENTINEL, bad);
    assert.equal(r.repoPluginsSource, 'AGINT_REPO_ROOT', `非法 config 值 ${JSON.stringify(bad)} 必须被忽略`);
  }

  // config 指到没有 plugins/ 的目录 ⇒ 不得标 config，必须回落到下一候选
  const partial = join(FIX, 'partial-home');
  mkdir(partial);
  const i = resolveV2Dirs(env({ AGINT_REPO_ROOT: REPO_ALT }), SENTINEL, partial);
  assert.equal(norm(i.repoPluginsDir), norm(join(REPO_ALT, 'plugins')), 'config 无 plugins/ ⇒ 回落 AGINT_REPO_ROOT');
  assert.equal(i.repoPluginsSource, 'AGINT_REPO_ROOT', 'config 落空时 source 不得谎标 config');
}

// ══ 4. readManifestConsumes：顶层优先、嵌套补位 ════════════════════════
// ⛔ readManifestConsumes 未导出（lib/v2-data.js:217 是内部函数），
// 只能经 collectV2Data().manifestConsumes 观测。
const payload = collectV2Data(
  { pluginsDir: PLUGINS, storagesDir: join(DSH, 'storages'), repoPluginsDir: join(REPO_OK, 'plugins'), repoPluginsSource: 'AGINT_HOME' },
  { now: Date.now(), cache: new Map() },
);
const MC = payload.manifestConsumes;
{
  assert.equal(payload.ok, true, '夹具数据下聚合不报错');

  // 身份优先级守卫：**有 lib/ 的真身**优先于无 lib 的门面
  // （部署位扁平时顶层有 lib ⇒ 顶层赢；仓库位门面无 lib ⇒ 同名真身赢）。
  assert.deepEqual(MC['agint-dup'], ['dup.top'], '同名且两侧都有 lib ⇒ 顶层目录赢');
  assert.ok(!MC['agint-dup'].includes('dup.nested'), '嵌套版本不得覆盖顶层');
  assert.deepEqual(MC['agint-facade-real'], ['facade.real'], '门面无 lib ⇒ 顶层同名真身赢');
  assert.ok(!('agint-facade' in MC), '纯门面（有 manifest 无 lib、无同名真身）不产生身份');

  // 嵌套补位：仅嵌套存在的身份也要读得到（agint-quality-eval 形状）
  assert.deepEqual(MC['agint-quality-eval'], ['agint.q.eval'], '仅嵌套存在的身份可读');

  // 顶层独有身份不受嵌套影响
  assert.deepEqual(MC['agint-top'], ['top.only'], '顶层身份照常');
  assert.ok(!('agint-vendor' in MC), '无 manifest 的容器不进 consumes');

  // 空 / 缺 consumes 不收
  assert.ok(!('agint-noconsume' in MC), '空 consumes 不收');
  assert.ok(!('agint-noconsume2' in MC), '缺 consumes 不收');
  assert.ok(!('agint-badjson' in MC), '坏 manifest 跳过而不带崩整源');
  assert.ok(!('agint-empty' in MC), '无 manifest 不收');

  // 新导出确实接进了 payload（不是各自测通、聚合时忘挂）
  assert.deepEqual(Object.keys(payload.pluginKinds).sort(), Object.keys(K).sort(), 'pluginKinds 来自 classifyPlugins');
  assert.equal(payload.pluginKinds['agint-cont'].kind, 'container', '聚合里的形态与直接调用一致');
}

// ══ 5. readMountedFromPatch：REMOVED 的唯一判据是 patch 行被注释 ══════════
{
  //夹具：patch 里 agint-on 在役、agint-off 整行注释掉（REMOVED 的真实表示）
  const PATCH_HOME = join(FIX, 'patch-home');
  const PATCH_PLUGINS = join(PATCH_HOME, 'profiles', 'web', 'plugins');
  mkdir(PATCH_PLUGINS);
  writeFileSync(join(PATCH_HOME, 'cordis.patch.yml'), [
    '# 家族 patch',
    '  - id: agint-on',
    '    name: ./plugins/agint-on/lib/index.js',
    '  # - id: agint-off',
    '  #   name: ./plugins/agint-off/lib/index.js',
    '    - id: agint-nested-on',
    '',
  ].join('\n'));

  const mounted = readMountedFromPatch(PATCH_PLUGINS);
  assert.notEqual(mounted, null, 'patch 可读时不得返回 null');
  assert.ok(mounted.has('agint-on'), '在役行须被读出');
  assert.ok(mounted.has('agint-nested-on'), '缩进不同的在役行也要读出');
  // ⛔ 核心保证：注释掉的 - id: 行绝不进在役集合。实现里有两道防线
  //   （① 行首 # 直接跳过；② id 正则以 `-` 锚定开头，`# - id: x` 天然不命中）。
  //   断言只观测**可观测契约**（注释行不在集合里），不绑定具体由哪道防线保证 ——
  //   否则删掉其中一道就会假红，而那不是行为退化。
  assert.ok(!mounted.has('agint-off'), '注释掉的 - id: 行= REMOVED，不得算在役');
  assert.ok(![...mounted].some((id) => /off/.test(id)), 'REMOVED 插件不得出现在在役集合');

  // 读不到 patch ⇒ null（挂载态未知，不猜）
  const NO_PATCH = join(FIX, 'no-patch', 'profiles', 'web', 'plugins');
  mkdir(NO_PATCH);
  assert.equal(readMountedFromPatch(NO_PATCH), null, '无 patch ⇒ null（挂载态未知）');

  // unmounted 判据：kind 为 host 且不在 mounted 里 ⇒ unmounted
  const MOUNT_HOME = join(FIX, 'mount-home');
  const MOUNT_PLUGINS = join(MOUNT_HOME, 'profiles', 'web', 'plugins');
  writeJson(join(MOUNT_PLUGINS, 'agint-live', 'manifest.json'), { name: 'agint-live', main: 'lib/index.js', spec: { cordis: { tools: ['a'] } } });
  writeJson(join(MOUNT_PLUGINS, 'agint-gone', 'manifest.json'), { name: 'agint-gone', main: 'lib/index.js', spec: { cordis: { tools: ['b'] } } });
  mkdir(join(MOUNT_PLUGINS, 'agint-live', 'lib'));
  mkdir(join(MOUNT_PLUGINS, 'agint-gone', 'lib'));
  writeFileSync(join(MOUNT_HOME, 'cordis.patch.yml'), '  - id: agint-live\n');
  const withMount = classifyPluginsWithMount(MOUNT_PLUGINS);
  assert.equal(withMount.mountSource, 'cordis.patch.yml', '挂载态来源应标出');
  assert.equal(withMount.kinds['agint-live'].kind, 'host', '在役 ⇒ host');
  assert.equal(withMount.kinds['agint-gone'].kind, 'unmounted', 'patch 里没有 ⇒ unmounted（REMOVED）');
}

console.log('v2-data-v03.test.mjs PASS');
