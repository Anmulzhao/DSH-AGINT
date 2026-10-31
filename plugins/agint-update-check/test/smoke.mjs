/**
 * agint-update-check 冒烟测试。
 *
 * 覆盖：
 *   1) 纯函数层（版本号 / 提交表 / 脏文件 / 变更分类 / 影响面 / 提问语 / 阻断理由）；
 *   2) 仓库根解析（只认「既有 .git 又有 plugins/」的目录）；
 *   3) 路径安全（越界路径必须被拒）；
 *   4) 插件在假 ctx 上挂载不抛、注册 3 个工具、schema 合规（K19 自检）；
 *   5) 真宿主 gate 回归：strictCtx（Proxy）复刻 cordis「未 inject 就抛」的行为，
 *      防止再次出现「假 ctx 全绿、真宿主 did not activate」。
 *
 * 不联网、不碰真仓库：所有 git 依赖都靠「临时目录 + 假 git」隔离。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LIB_URL = new URL('../lib/', import.meta.url);

const detect = await import(new URL('./detect.js', LIB_URL).href);
const repoMod = await import(new URL('./repo.js', LIB_URL).href);
const applyMod = await import(new URL('./apply.js', LIB_URL).href);
const plugin = await import(new URL('./index.js', LIB_URL).href);

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

// ── 纯函数层 ────────────────────────────────────────────────────────
check('parseRepoVersion 取矩阵表首行', () => {
  const text = [
    '| AGINT | dsh minimum | dsh tested | notes |',
    '|---|---|---|---|',
    '| v0.15.0 | 0.2.1-rc.2 | 0.2.1-rc.3 | notes |',
  ].join('\n');
  assert.equal(detect.parseRepoVersion(text), 'v0.15.0');
  assert.equal(detect.parseRepoVersion(''), null);
});

check('parseCommitLines 解析 log 行', () => {
  const rows = detect.parseCommitLines('abc1234\t2026-10-28\tsome subject\ndef5678\t2026-10-27\tanother');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sha, 'abc1234');
  assert.equal(rows[0].date, '2026-10-28');
  assert.equal(rows[1].subject, 'another');
});

check('summarizeGitStatus 统计脏文件', () => {
  const s = detect.summarizeGitStatus(' M install/install.sh\n?? _tmp.txt\n');
  assert.equal(s.count, 2);
  assert.equal(s.files[0].path, 'install/install.sh');
});

check('classifyChanges 分类变更', () => {
  const files = [
    'plugins/agint-existing/lib/index.js',
    'plugins/agint-brand-new/lib/index.js',
    'cordis.patch.yml',
    'install/install.sh',
    'docs/notes.md',
  ];
  const c = detect.classifyChanges(files, ['agint-existing']);
  assert.deepEqual(c.pluginCode, ['plugins/agint-existing/lib/index.js']);
  assert.deepEqual(c.newPlugins, ['agint-brand-new']);
  assert.equal(c.mount, true);
  assert.equal(c.installer, true);
  assert.equal(c.docsOnly, false);
});

check('classifyChanges 纯文档 → docsOnly', () => {
  const c = detect.classifyChanges(['docs/a.md', 'wiki/b.md'], []);
  assert.equal(c.docsOnly, true);
  assert.equal(c.total, 2);
});

check('deriveImpact 推出部署/重启结论', () => {
  const impact = detect.deriveImpact(detect.classifyChanges(['plugins/x/lib/a.js'], ['x']));
  assert.equal(impact.needsDeploy, true);
  assert.equal(impact.needsRestart, true);
  assert.ok(impact.reasons.length > 0);
});

check('buildQuestion 有更新才问', () => {
  const q = detect.buildQuestion({
    comparison: { behind: 3, ahead: 0 },
    local: { version: 'v0.15.0', shortSha: 'aaaaaaa' },
    upstream: { version: 'v0.16.0', shortSha: 'bbbbbbb' },
  });
  assert.ok(q.includes('是否现在更新并部署'));
  assert.equal(detect.buildQuestion({ comparison: { behind: 0 } }), null);
});

check('buildBlockers 脏工作区 + 分叉', () => {
  const b = detect.buildBlockers({
    comparison: { ahead: 1, behind: 16 },
    local: { dirty: { count: 3 } },
  });
  assert.equal(b.length, 2);
  assert.ok(b.some((x) => x.includes('未提交改动')));
  assert.ok(b.some((x) => x.includes('分叉')));
});
// ── 仓库根解析 + 路径安全 + 插件挂载 ───────────────────────────────
const tmpRoot = mkdtempSync(join(tmpdir(), 'agint-update-check-'));

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

const fakeRepo = join(tmpRoot, 'repo');
mkdirSync(join(fakeRepo, '.git'), { recursive: true });
mkdirSync(join(fakeRepo, 'plugins'), { recursive: true });
const notRepo = join(tmpRoot, 'not-repo');
mkdirSync(notRepo, { recursive: true });

check('resolveRepoRoot 只认既有 .git 又有 plugins/ 的目录', () => {
  const found = repoMod.resolveRepoRoot({ configRoot: fakeRepo, env: {} });
  assert.ok(found);
  assert.equal(found.root, fakeRepo);
  assert.equal(repoMod.resolveRepoRoot({ configRoot: notRepo, env: {} }), null);
});

check('resolveRepoRoot 认 AGINT_REPO_ROOT 环境变量', () => {
  const found = repoMod.resolveRepoRoot({ env: { AGINT_REPO_ROOT: fakeRepo } });
  assert.ok(found);
  assert.equal(found.source, 'AGINT_REPO_ROOT');
});

check('isInside 拒绝越界路径', () => {
  assert.equal(plugin.isInside(tmpRoot, join(tmpRoot, 'foo', 'bar.md')), true);
  assert.equal(plugin.isInside(tmpRoot, join(tmpRoot, '..', 'escape.md')), false);
  assert.equal(plugin.isInside(tmpRoot, tmpRoot), true);
});

check('planApply 拒绝本地有未推送提交', () => {
  const plan = applyMod.planApply({ comparison: { behind: 5, ahead: 2 }, local: { dirty: { count: 0 } } }, {});
  assert.equal(plan.allowed, false);
  assert.ok(plan.reason.includes('未推送提交'));
});

check('planApply 拒绝脏工作区', () => {
  const plan = applyMod.planApply({ comparison: { behind: 5, ahead: 0 }, local: { dirty: { count: 2 } } }, {});
  assert.equal(plan.allowed, false);
  assert.ok(plan.reason.includes('未提交改动'));
});

check('planApply 通过时给出部署步骤', () => {
  const plan = applyMod.planApply(
    { comparison: { behind: 5, ahead: 0 }, local: { dirty: { count: 0 } }, upstream: { shortSha: 'abc1234' } },
    { mode: 'deploy', profile: 'desktop' },
  );
  assert.equal(plan.allowed, true);
  assert.ok(plan.steps.some((s) => s.id === 'ff'));
  assert.ok(plan.steps.some((s) => s.id === 'deploy'));
});

// ── 插件挂载（假 ctx）────────────────────────────────────────────
const registered = [];
const fakeCtx = {
  tools: { register: (def) => registered.push(def) },
  setInterval: () => ({ dispose() {} }),
  effect: (fn) => fn(),
  inject: () => {},
};

check('apply 在假 ctx 上挂载不抛、注册 3 个工具', () => {
  plugin.apply(fakeCtx, {
    repoRoot: notRepo,
    autoCheck: false,
    notify: false,
    statePath: join(tmpRoot, 'state.json'),
  });
  assert.equal(registered.length, 3);
  const names = registered.map((d) => d.name).sort();
  assert.deepEqual(names, ['agint_update_apply', 'agint_update_check', 'agint_update_status']);
});

// ── 真宿主 gate 回归（2026-10-31 事故）──────────────────────────────
// 上面的 fakeCtx 是个普通对象：**任何属性都读得到**，所以 `ctx.setInterval`
// （cordis-plugin-timer 的糖，内部转 ctx.timer）在测试里永远绿，到真宿主里却抛
// `cannot get property "timer" without inject` —— 整个插件条目 did not activate，
// 3 个工具一起消失，启动日志只有一行 warning、界面上只显示「失败」。
// 下面这个 Proxy 复刻 cordis 的 gate：只有 tools + Context 内建成员可访问，
// 任何其它属性名一律按宿主文案抛错。以后谁再访问未 inject 的服务，这条用例会红。
function strictCtx({ services = {}, disposers = [] } = {}) {
  const base = {
    effect: (fn) => {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
      return d;
    },
    inject: () => {},
  };
  for (const [k, v] of Object.entries(services)) base[k] = v;
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'symbol') return target[prop];
      if (prop in target) return target[prop];
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
    has: (target, prop) => prop in target,
  });
}

check('真宿主 gate：未注入的服务（timer/setInterval）一次都不许碰', () => {
  const reg = [];
  const disposers = [];
  const ctx = strictCtx({
    services: { tools: { register: (def) => reg.push(def) } },
    disposers,
  });
  // autoCheck 开 = 走定时器分支（原事故点），必须在 strict ctx 上也不抛
  plugin.apply(ctx, {
    repoRoot: notRepo,
    autoCheck: true,
    notify: false,
    checkIntervalMs: 3_600_000,
    statePath: join(tmpRoot, 'state-strict.json'),
  });
  assert.equal(reg.length, 3, 'strict ctx 下三个工具都应注册');
  assert.equal(disposers.length, 1, '定时器必须注册一个 disposer（must-dispose）');
  for (const d of disposers) d();
});

check('工具 output.schema 合规（K19：object 必须显式 additionalProperties）', () => {
  for (const def of registered) {
    const schema = def.output?.schema;
    assert.ok(schema, `${def.name} 缺 output.schema`);
    assert.equal(schema.type, 'object');
    assert.equal(typeof schema.additionalProperties, 'boolean');
  }
});

await checkAsync('agint_update_check 无仓库时返回明确错误而不是抛异常', async () => {
  const def = registered.find((d) => d.name === 'agint_update_check');
  const out = await def.execute({});
  assert.equal(out.ok, false);
  assert.ok(out.error.includes('找不到 AGINT 仓库根'));
  assert.equal(typeof out.summary, 'string');
});

await checkAsync('agint_update_apply 缺 confirm 时拒绝执行', async () => {
  const def = registered.find((d) => d.name === 'agint_update_apply');
  const out = await def.execute({ confirm: false });
  assert.equal(out.applied, false);
  assert.equal(out.stage, 'confirm');
});

try {
  rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* 临时目录清理失败不影响结论 */
}

console.log(failures === 0 ? 'agint-update-check smoke: ALL PASS' : `agint-update-check smoke: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);