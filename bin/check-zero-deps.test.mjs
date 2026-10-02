// bin/check-zero-deps.test.mjs — 零第三方依赖门禁的测试
//
// 核心不是「现在通过」，而是**它该红的时候真的会红**。
// 一个从没红过的依赖门禁，等于给「随便加个 npm 包」发了通行证 ——
// 设计 §附录 C 修订说明第 3 条那条纪律（不引第三方运行时依赖）就形同虚设。
//
// 开发过程中这里抓到过一个真 bug：isMain 守卫拿 Windows 路径去比 file:///
// URL，永远不相等 ⇒ main() 从不执行 ⇒ 门禁**假绿**。所以本测试里
// 「真实仓库跑一遍」这条断言必须同时校验 stdout 非空，只看退出码会被骗过去。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'check-zero-deps.mjs');
const REPO_ROOT = join(__dirname, '..');
const ALLOWLIST_PATH = join(REPO_ROOT, 'docs', 'zero-deps-allowlist.json');

const { classify, extractSpecifiers } = await import(pathToFileURL(SCRIPT).href);

// ── 分类逻辑 ────────────────────────────────────────────────────────────────
test('本地相对路径永远合法', () => {
  assert.equal(classify('./lib/x.mjs'), 'LOCAL');
  assert.equal(classify('../y.js'), 'LOCAL');
});

test('node: 前缀合法', () => {
  assert.equal(classify('node:fs'), 'NODE_PREFIXED');
});

test('宿主提供的包走白名单（不是第三方依赖）', () => {
  assert.equal(classify('@deepseek-ai/dsh-storage-domain'), 'ALLOWLISTED');
  assert.equal(classify('zod'), 'ALLOWLISTED');
  assert.equal(classify('react'), 'ALLOWLISTED');
});

test('裸内置模块不算第三方，但要被提示补 node: 前缀', () => {
  assert.equal(classify('fs'), 'BUILTIN_NO_PREFIX');
  assert.equal(classify('path'), 'BUILTIN_NO_PREFIX');
});

test('★ 真第三方包必须被判为违规 —— 这条红了就说明门禁失效了', () => {
  // 注意：yaml 不在此列。它同样是 npm 上的通用包名，但本仓库由 dsh 宿主提供
  // （证据见 docs/zero-deps-allowlist.json 的 yaml 条目 evidence 数组）⇒ 合法豁免。
  // 豁免的代价是「同名包在本仓库合法、在别的仓库仍会被拦」，见下面那两条测试。
  for (const pkg of ['express', 'lodash', 'ajv', 'axios', 'chalk']) {
    assert.equal(classify(pkg), 'THIRD_PARTY', `未拦住第三方包：${pkg}`);
  }
  // 而白名单里的宿主提供包必须被认出来（否则白名单形同虚设 = 该拦的没拦）
  for (const pkg of ['zod', 'react', 'yaml']) {
    assert.equal(classify(pkg), 'ALLOWLISTED', `宿主提供的包被误判为第三方：${pkg}`);
  }
});

// ── 提取逻辑 ────────────────────────────────────────────────────────────────
test('四种 import 形态都要提取到', () => {
  const src = `
import x from 'a-pkg';
import 'side-effect-pkg';
const y = require('cjs-pkg');
async function f() { return import('dyn-pkg'); }
export { z } from 're-export-pkg';
`;
  const specs = extractSpecifiers(src);
  for (const s of ['a-pkg', 'side-effect-pkg', 'cjs-pkg', 'dyn-pkg', 're-export-pkg']) {
    assert.ok(specs.includes(s), `漏提取：${s}`);
  }
});

test('模板串占位不参与判定（测试文件里的假包名是已知误报源）', () => {
  const src = `import a from '${'${CONTRACT_TOKEN}'}';`;
  assert.equal(extractSpecifiers(src).length, 0);
});

// ── 白名单治理（G5：没门禁的排除名单就是后门）──────────────────────────────
test('白名单每一条都必须写明 reason', () => {
  const list = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  const entries = [...(list.allowPrefixes || []), ...(list.allowExact || [])];
  assert.ok(entries.length > 0, '白名单为空 = 门禁没被校准过');
  for (const e of entries) {
    assert.ok(e.reason && e.reason.length > 20, `白名单条目缺少充分理由：${e.prefix || e.name}`);
  }
});

test('白名单不得包含典型 npm 第三方包（否则门禁形同虚设）', () => {
  const list = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  const names = new Set((list.allowExact || []).map((x) => x.name));
  for (const bad of ['express', 'lodash', 'ajv', 'axios', 'chalk']) {
    assert.ok(!names.has(bad), `白名单里混进了第三方包：${bad}`);
  }
});

// ── 白名单治理升级：通用 npm 包名要豁免，必须留下可核的证据 ────────────────
// 为什么加这条：`yaml` 这类名字在 npm 上是通用第三方包，本仓库却由 dsh 宿主提供。
// 一旦允许"看起来像 npm 的包"进白名单，最容易的滥用就是顺手加一个进去 ——
// 所以豁免的门槛不是"我记得它是宿主提供的"，而是**把证据写进 checked-in 文件**。
test('★ 每条白名单都必须声明 providedBy（谁在提供它）', () => {
  const list = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  const entries = [...(list.allowPrefixes || []), ...(list.allowExact || [])];
  const HOST_PROVIDERS = new Set(['dsh-runtime', 'dsh-bootstrap', 'dsh-browser-module-table']);
  for (const e of entries) {
    const id = e.prefix || e.name;
    assert.ok(
      e.providedBy,
      `白名单条目「${id}」没写 providedBy —— 无法判断它由谁提供，这条就是后门`,
    );
    assert.ok(
      HOST_PROVIDERS.has(e.providedBy),
      `白名单条目「${id}」的 providedBy="${e.providedBy}" 不是宿主来源（${[...HOST_PROVIDERS].join(' / ')}）` +
        ` —— 若答案是 npm，就该让门禁红而不是进白名单`,
    );
  }
});

test('★ 通用 npm 包名进白名单时必须带 evidence 数组（豁免要留下可核的凭据）', () => {
  const list = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  // 这些是 npm 上的通用第三方包名。它们在本仓库合法，只因为宿主提供 —— 那就必须说清。
  const GENERIC_NPM_NAMES = new Set(['yaml', 'chalk', 'lodash', 'axios', 'express', 'ajv', 'uuid', 'dayjs']);
  for (const e of list.allowExact || []) {
    if (!GENERIC_NPM_NAMES.has(e.name)) continue;
    assert.ok(
      Array.isArray(e.evidence) && e.evidence.length > 0,
      `白名单条目「${e.name}」是 npm 通用包名却没有 evidence 数组 ——` +
        `豁免必须可核，不能只靠 reason 里的一句话`,
    );
  }
});

// ── 端到端：真实仓库 ────────────────────────────────────────────────────────
test('当前仓库跑门禁：退出码 0 且 stdout 非空（两条都要验，只验退出码会被假绿骗过）', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `门禁红了，stderr: ${r.stderr}`);
  assert.ok(
    (r.stdout || '').includes('扫描'),
    `stdout 没有内容 —— main() 可能没执行（isMain 守卫回归）: ${JSON.stringify(r.stdout)}`,
  );
});

test('--strict 下裸内置模块也应导致失败', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--strict'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  // 当前仓库有 2 处裸内置（bin/_verify-dim9.js），strict 应红。
  // 若哪天这两处补上了 node: 前缀，本断言会变成 0 —— 那时应当改成断言 0，
  // 而不是删掉这条测试。
  assert.equal(r.status, 1, 'strict 模式没有把裸内置模块算作失败');
});

test('--json 输出可解析且含必需字段', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--json'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0);
  const j = JSON.parse(r.stdout);
  assert.ok(typeof j.scannedFiles === 'number' && j.scannedFiles > 0);
  assert.ok(Array.isArray(j.violations));
  assert.ok(Array.isArray(j.builtinNoPrefix));
  assert.equal(j.violations.length, 0, '当前仓库不应有第三方依赖违规');
});
