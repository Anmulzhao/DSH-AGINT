/**
 * storages home 认标探测的回归测试（v0.3.1，2026-10-04）。
 *
 * 背景：旧实现 `resolve(pluginsDir,'..','..','..')` 写死级数，隐含假设
 * 「pluginsDir 在 <home>/profiles/web/plugins 下」。bundle 实体自 2026-10-01
 * 挪到 `<home>/.agint-bundle/plugins` 后，同样三级只到 home 的**同级**，
 * 部署位 v2 面板三源（tool_stats / cron / event_bus）全部 ENOENT。
 *
 * 修法：从 pluginsDir 逐级上溯，取第一个确有 `storages/` 的祖先（认标不猜级数）。
 * 本测试把两种布局都搭出来，锁死「home 相对 pluginsDir 深度不同也必须解析对」。
 */
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveV2Dirs, isDshHome } from '../lib/v2-data.js';

const here = dirname(fileURLToPath(import.meta.url));
const norm = (p) => String(p).replace(/\\/g, '/');

/** 搭一个含 storages/ 的假 home，pluginsDir 按 depth 级嵌在 home 下。 */
function makeHome(depth) {
  const root = mkdtempSync(join(tmpdir(), 'v2home-'));
  const home = join(root, 'home');
  mkdirSync(join(home, 'storages'), { recursive: true });
  // depth=3 → profiles/web/plugins；depth=2 → .agint-bundle/plugins
  const pluginsDir = join(home, ...Array.from({ length: depth - 1 }, (_, i) => `lvl${i}`), 'plugins');
  mkdirSync(join(pluginsDir, 'agint-family-panel', 'lib'), { recursive: true });
  return { home, pluginsDir };
}

// isDshHome：认标只看 storages/ 是不是目录
{
  const { home, pluginsDir } = makeHome(3);
  assert.equal(isDshHome(home), true, '含 storages/ → 是 home');
  assert.equal(isDshHome(pluginsDir), false, '无 storages/ → 不是 home');
  assert.equal(isDshHome(join(home, 'nope')), false, '路径不存在 → 不是 home（不抛）');
}

// 无 DSH_HOME：两种层级都要解析出同一个 home（这是本次 bug 的核心断言）
for (const depth of [3, 2]) {
  const { home, pluginsDir } = makeHome(depth);
  const selfUrl = 'file:///' + norm(join(pluginsDir, 'agint-family-panel', 'lib', 'index.js'));
  const d = resolveV2Dirs({}, selfUrl);
  assert.equal(norm(d.storagesDir), norm(join(home, 'storages')),
    `depth=${depth}：认标探测应解析出正确 storagesDir（旧实现在 depth=2 时会错）`);
  assert.equal(d.dshHomeSource, 'self-probe', `depth=${depth}：应记为自路径探测命中`);
}

// DSH_HOME 显式注入仍然最高优先（不因探测存在就被绕过）
{
  const { home, pluginsDir } = makeHome(2);
  const selfUrl = 'file:///' + norm(join(pluginsDir, 'agint-family-panel', 'lib', 'index.js'));
  const d = resolveV2Dirs({ DSH_HOME: home }, selfUrl);
  assert.equal(norm(d.storagesDir), norm(join(home, 'storages')));
  assert.equal(d.dshHomeSource, 'DSH_HOME', '显式注入优先于探测');
  assert.equal(norm(d.pluginsDir), norm(join(home, 'profiles', 'web', 'plugins')),
    'DSH_HOME 存在时 pluginsDir 仍走标准布局');
}

// 就近优先：嵌套 home（外层也有 storages/）时取最近的那层，不取外层
{
  const outer = makeHome(2);
  const inner = join(outer.home, 'nested');
  mkdirSync(join(inner, 'storages'), { recursive: true });
  const pluginsDir = join(inner, 'profiles', 'web', 'plugins');
  mkdirSync(join(pluginsDir, 'agint-family-panel', 'lib'), { recursive: true });
  const selfUrl = 'file:///' + norm(join(pluginsDir, 'agint-family-panel', 'lib', 'index.js'));
  const d = resolveV2Dirs({}, selfUrl);
  assert.equal(norm(d.storagesDir), norm(join(inner, 'storages')), '应取最近的 inner home');
}

// 推不出 home 时降级不崩：pluginsDir 兜底 + dshHomeSource=fallback，
// 三个源各自 try/catch 变 state:error（不整页 500）
{
  const bare = join(tmpdir(), 'v2-no-such-home-xyz', 'plugins');
  mkdirSync(bare, { recursive: true });
  const selfUrl = 'file:///' + norm(join(bare, 'agint-family-panel', 'lib', 'index.js'));
  const d = resolveV2Dirs({}, selfUrl);
  assert.equal(d.dshHomeSource, 'fallback', '探测不到 → fallback');
  assert.ok(typeof d.storagesDir === 'string' && d.storagesDir.length > 0, '仍给出字符串路径供各源降级');
}

console.log('v2-storages-home.test.mjs PASS');
