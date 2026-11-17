#!/usr/bin/env node
// agint-mutator / W6 worktree 隔离单测 — `node test/worktree-isolation.test.mjs` 一行能跑。
//
// 这份用例的重点不是「happy path 能过」，而是**阴性对照**：
//   证明「主工作区在验证期间不变」这条不变量真的被守住了 —— 拿掉隔离就会红。
//   本仓的规矩：没证明过会红的护栏等于没有护栏。
//
// 分成两组：
//   A. runIsolatedWrite 纯单元（假 ctx + 假 worktrees，不碰真 git）
//      —— 覆盖四条边界：cwd 还原 / head 不匹配 / 无 remove 自清 / 路径越界
//   B. commit() 集成（真 git 仓库）
//      —— 覆盖：隔离开启 → 验证期间主工作区文件**还是 preimage**（阴性对照）
//             降级 → 开关开了但工作树服务缺 → 仍能 commit，audit 记 reason

import test from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from '../lib/index.js';
import { runIsolatedWrite, resolveInside, readHead } from '../lib/worktree-isolation.js';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const clone = (x) => JSON.parse(JSON.stringify(x));

const FIX_PROMPT = {
  source: 'attribution-driven', failureId: 'f-wt', rootCause: 'PROMPT_DEFICIENCY',
  expectedEffect: 'baseline 通过率 >= 95% 在 7 天', rollbackCondition: 'regression -> rollback',
  atomicScope: 'prompt',
  promptPayload: { promptId: 'sys-prompt', oldText: 'OLD', newText: 'NEW POSTIMAGE', diffStrategy: 'unified_diff' },
};

// ── git 仓库夹具 ────────────────────────────────────────────────────
function makeGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agint-wt-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  // ⛔ 不用 `git init -b main`：本机 git 2.25 没有 -b（报「未知开关 b」）。
  //    两步走对老版本兼容。
  g('init', '-q');
  g('symbolic-ref', 'HEAD', 'refs/heads/main');
  g('config', 'user.email', 'test@agint.local');
  g('config', 'user.name', 'agint-test');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'gc.auto', '0');
  mkdirSync(join(dir, 'plugins', 'agint-mutator', 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'plugins', 'agint-mutator', 'prompts', 'sys-prompt.md'), 'OLD prompt content');
  writeFileSync(join(dir, 'README.md'), 'fixture\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return { dir, g, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── A. runIsolatedWrite 纯单元 ──────────────────────────────────────

/**
 * 假 ctx：worktrees.create 只把 branch 名和 from 记下来，真的建目录（用 fs 直接拷文件），
 * 并像真服务一样**调 workingDirectory.set**（这是必须被测到的副作用）。
 */
function makeFakeCtx({ realRepo, failCreate = false } = {}) {
  const log = { create: [], setCalls: [] };
  let currentCwd = realRepo;
  const agent = { id: 'agent-1' };
  const ctx = {
    agent,
    get(name) {
      if (name === 'workingDirectory') {
        return {
          ensure: async () => currentCwd,
          set: async (a, p) => { log.setCalls.push(p); currentCwd = p; return p; },
        };
      }
      if (name === 'worktrees') {
        return {
          create: async (a, { name, from }) => {
            log.create.push({ name, from });
            if (failCreate) throw new Error('mock create failed');
            // 真服务会 set cwd —— 这里必须照做，否则「忘记还原」的 bug 测不出来
            await ctx.get('workingDirectory').set(a, join(realRepo, '.agents', 'worktrees', name));
            return { path: join(realRepo, '.agents', 'worktrees', name), branch: name, baseCommit: from === 'HEAD' ? headAtMakeTime : from, repositoryRoot: realRepo };
          },
        };
      }
      return null;
    },
  };
  let headAtMakeTime = null;
  return { ctx, log, agent, getCwd: () => currentCwd, setHead: (h) => { headAtMakeTime = h; } };
}

test('A1 真 git 仓库里 create() 会切 cwd，runIsolatedWrite 必须还原', async () => {
  const repo = makeGitRepo();
  try {
    const head = await readHead(repo.dir);
    assert.ok(head, 'fixture 应该是 git 仓库');
    // 用真 worktree 服务逻辑太复杂（要 dsh 的 subprocess/sandbox），这里用真的 git 命令
    // 实现一个等价的最小 create：建 checkout + set cwd。
    const f = makeFakeCtx({ realRepo: repo.dir });
    f.setHead(head);
    // 覆写 create 为真 git 实现
    const realCreate = async (agent, { name }) => {
      const wtPath = join(repo.dir, '.agents', 'worktrees', name);
      mkdirSync(join(repo.dir, '.agents', 'worktrees'), { recursive: true });
      execFileSync('git', ['worktree', 'add', '-b', name, '--', wtPath, 'HEAD'], { cwd: repo.dir, encoding: 'utf8' });
      await f.ctx.get('workingDirectory').set(agent, wtPath);
      return { path: wtPath, branch: name, baseCommit: head, repositoryRoot: repo.dir };
    };
    const fakeWorktrees = { create: realCreate };
    const ctx2 = {
      agent: f.agent,
      get: (n) => (n === 'worktrees' ? fakeWorktrees : f.ctx.get(n)),
    };

    const before = f.getCwd();
    // ⛔ worktree 在 finally 里就被清了 —— 所以「worktree 里写了什么」必须在
    //    verify 回调（清理之前）断言，不能等 runIsolatedWrite 返回再读。
    let sawInWorktree = null;
    let sawMainDuringVerify = null;
    const res = await runIsolatedWrite({
      ctx: ctx2,
      repoRoot: repo.dir,
      targetPath: 'plugins/agint-mutator/prompts/sys-prompt.md',
      postimage: 'NEW POSTIMAGE',
      branchPrefix: 'agint-mut/',
      verify: async ({ absTargetInWorktree }) => {
        sawInWorktree = readFileSync(absTargetInWorktree, 'utf8');
        sawMainDuringVerify = readFileSync(join(repo.dir, 'plugins/agint-mutator/prompts/sys-prompt.md'), 'utf8');
        return { ok: true };
      },
    });
    assert.equal(res.ok, true, `隔离应成功，实际 reason=${res.reason}`);
    // ⛔ 阴性对照 1：cwd 必须还原到原处
    assert.equal(f.getCwd(), before, 'cwd 没还原 —— 整个 agent 会话会被永久困在 worktree 里');
    // ⛔ 阴性对照 2：worktree 里写的是 postimage
    assert.equal(sawInWorktree, 'NEW POSTIMAGE');
    // ⛔ 阴性对照 3：主工作区**一点没被碰** —— 这是整件事的目的
    assert.equal(sawMainDuringVerify, 'OLD prompt content',
      '主工作区在隔离期间被改了 —— 隔离等于没做');
    // ⛔ 阴性对照 4：分支和 checkout 都清干净（服务没有 remove，本模块自己清）
    assert.equal(existsSync(res.worktreePath), false, 'worktree 目录没清');
    const branches = execFileSync('git', ['branch', '--list', 'agint-mut/*'], { cwd: repo.dir, encoding: 'utf8' });
    assert.equal(branches.trim(), '', `残留分支：${branches}`);
  } finally { repo.cleanup(); }
});

test('A2 create 抛错时 cwd 也要还原（失败路径最容易忘）', async () => {
  const repo = makeGitRepo();
  try {
    // 假的 worktrees：create 里先像真服务那样自己抛错，但**已经切了 cwd**
    let cwd = repo.dir;
    const agent = { id: 'a' };
    const ctx = {
      agent,
      get(n) {
        if (n === 'workingDirectory') {
          return { ensure: async () => cwd, set: async (a, p) => { cwd = p; return p; } };
        }
        if (n === 'worktrees') {
          return {
            create: async (a) => {
              await ctx.get('workingDirectory').set(a, join(repo.dir, '.agents', 'worktrees', 'x'));
              throw new Error('git worktree add failed');
            },
          };
        }
        return null;
      },
    };
    const res = await runIsolatedWrite({ ctx, repoRoot: repo.dir, targetPath: 'README.md', postimage: 'X' });
    assert.equal(res.ok, false);
    assert.match(res.reason, /worktree-create-failed/);
    assert.equal(cwd, repo.dir, 'create 失败后 cwd 没还原 —— 这是最容易被忽略的一条路径');
  } finally { repo.cleanup(); }
});

test('A3 主工作区 HEAD ≠ worktree baseCommit ⇒ 拒绝隔离（不降级就是静默丢改动）', async () => {
  const repo = makeGitRepo();
  try {
    const head = await readHead(repo.dir);
    let cwd = repo.dir;
    const ctx = {
      agent: { id: 'a' },
      get(n) {
        if (n === 'workingDirectory') return { ensure: async () => cwd, set: async (a, p) => { cwd = p; return p; } };
        if (n === 'worktrees') {
          return {
            create: async (a, { name }) => {
              const p = join(repo.dir, '.agents', 'wt', name);
              mkdirSync(p, { recursive: true });
              return { path: p, branch: name, baseCommit: 'deadbeef'.repeat(5), repositoryRoot: repo.dir };
            },
          };
        }
        return null;
      },
    };
    const res = await runIsolatedWrite({ ctx, repoRoot: repo.dir, targetPath: 'README.md', postimage: 'X' });
    assert.equal(res.ok, false);
    assert.match(res.reason, /base-commit-mismatch/, `reason=${res.reason}`);
    // 拒绝必须发生在**写 postimage 之前**：worktree 里不该有被改过的 README
    assert.equal(existsSync(join(repo.dir, '.agents', 'wt', res.branch, 'README.md')), false);
    assert.ok(head);
  } finally { repo.cleanup(); }
});

test('A4 服务缺失 ⇒ 返回具体 reason，不抛错（降级必须可解释）', async () => {
  const repo = makeGitRepo();
  try {
    // 情况 1：没有 worktrees 服务（cordis.patch.yml 没挂那一行）
    const r1 = await runIsolatedWrite({
      ctx: { agent: { id: 'a' }, get: () => null },
      repoRoot: repo.dir, targetPath: 'README.md', postimage: 'X',
    });
    assert.equal(r1.ok, false);
    assert.equal(r1.reason, 'worktrees-service-unavailable');

    // 情况 2：有 worktrees 但没 workingDirectory ⇒ 必须放弃（建了换不回来）
    const r2 = await runIsolatedWrite({
      ctx: {
        agent: { id: 'a' },
        get: (n) => (n === 'worktrees' ? { create: async () => ({ path: '/tmp/x', branch: 'b', baseCommit: 'c' }) } : null),
      },
      repoRoot: repo.dir, targetPath: 'README.md', postimage: 'X',
    });
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'working-directory-service-unavailable');

    // 情况 3：没有 agent ⇒ 连源仓库都定位不到
    const r3 = await runIsolatedWrite({
      ctx: { get: (n) => (n === 'worktrees' ? { create: async () => ({}) } : { ensure: async () => repo.dir, set: async () => {} }) },
      repoRoot: repo.dir, targetPath: 'README.md', postimage: 'X',
    });
    assert.equal(r3.ok, false);
    assert.equal(r3.reason, 'no-agent-on-ctx');

    // 情况 4：不是 git 仓库
    const plain = mkdtempSync(join(tmpdir(), 'agint-plain-'));
    try {
      const r4 = await runIsolatedWrite({
        ctx: {
          agent: { id: 'a' },
          get: (n) => (n === 'worktrees' ? { create: async () => ({}) } : { ensure: async () => plain, set: async () => {} }),
        },
        repoRoot: plain, targetPath: 'a.txt', postimage: 'X',
      });
      assert.equal(r4.ok, false);
      assert.equal(r4.reason, 'repo-not-a-git-worktree');
    } finally { rmSync(plain, { recursive: true, force: true }); }
  } finally { repo.cleanup(); }
});

test('A5 resolveInside 挡路径逃逸（targetPath 是拼出来的，不假设它干净）', () => {
  assert.equal(resolveInside('/repo', 'plugins/a/b.md'), '/repo/plugins/a/b.md');
  assert.throws(() => resolveInside('/repo', '../etc/passwd'), /越出 worktree 根/);
  assert.throws(() => resolveInside('/repo', 'plugins/../../etc/x'), /越出 worktree 根/);
  assert.throws(() => resolveInside('/repo', '/etc/passwd'), /绝对路径/);
  assert.throws(() => resolveInside('/repo', ''), /为空/);
  // 前缀骗术：/repo-evil 不能被当成 /repo 的子路径
  assert.throws(() => resolveInside('/repo', '../repo-evil/x'), /越出 worktree 根/);
});

// ── B. commit() 集成：阴性对照 + 降级 ───────────────────────────────

function makeEnv({ worktreeIsolation, worktrees = null, sandboxOk = true, policyDecision = 'AUTO_DEPLOY', inspectDuringVerify } = {}) {
  const repo = makeGitRepo();
  const tables = { proposals: new Map(), commits: new Map(), findings: new Map(), metrics_log: new Map() };
  const services = {};
  const sandboxSaw = [];
  const mockSandbox = {
    runSmoke: async ({ target }) => {
      sandboxSaw.push(target.path);
      // 让用例有机会在「验证进行中」这一刻检查主工作区的状态
      if (typeof inspectDuringVerify === 'function') inspectDuringVerify();
      return {
        target: { path: target.path, name: target.name },
        ok: sandboxOk, mode: 'in-process', exitCode: sandboxOk ? 0 : 1,
        stdout: '', stderr: '', checks: [{ name: 'mock', ok: sandboxOk, detail: 'mock' }],
        durationMs: 1,
      };
    },
  };
  const mockPolicy = {
    decide: async ({ results }) => {
      const r = results?.[0] ?? null;
      const dims = r?.dimensions ?? [];
      const keyed = dims.some((d) => d?.key === 'safety') && dims.some((d) => d?.key === 'trust');
      if (!keyed) return { kind: 'REJECT', score: 0, reason: 'unknown-veto' };
      const vetoed = dims.filter((d) => d?.score?.veto === true);
      if (vetoed.length > 0) return { kind: 'REJECT', score: 0, reason: 'policy-reject:veto' };
      return { kind: policyDecision, score: 80, reason: 'mock', triggeredBy: [] };
    },
  };
  let cwd = repo.dir;
  const ctx = {
    storageDomain: { open: async () => ({
      table: (n) => {
        const s = tables[n] || (tables[n] = new Map());
        return {
          get size() { return s.size; },
          entries: () => [...s.entries()][Symbol.iterator](),
          put: async (id, v) => { s.set(id, v); },
          close: async () => {},
        };
      },
      close: async () => {},
    }) },
    get: (n) => {
      if (n === 'agint.qualitySandbox') return mockSandbox;
      if (n === 'agint.qualityPolicy') return mockPolicy;
      if (n === 'agint.diagnosis') return { annotate: async () => [], report: async () => ({}) };
      if (n === 'agint.evolution') return { queryFailures: async () => [] };
      if (n === 'worktrees') return worktrees;
      if (n === 'workingDirectory') return { ensure: async () => cwd, set: async (a, p) => { cwd = p; return p; } };
      return null;
    },
    agent: { id: 'agent-x' },
    provide: (n, f) => { services[n] = f; },
    effect: () => () => {},
  };
  // ⛔ 必须传 config —— 这正是 W6 的开关入口
  plugin.apply(ctx, { worktreeIsolation: worktreeIsolation === true });
  return { services, tables, repo, sandboxSaw, getCwd: () => cwd, cleanup: () => repo.cleanup() };
}

/** 等价于真 worktree 服务的最小实现：建 checkout + 切 cwd。 */
function makeRealWorktrees(repoDir) {
  return {
    create: async (agentArg, { name, from }) => {
      const wtPath = join(repoDir, '.agents', 'worktrees', name);
      mkdirSync(join(repoDir, '.agents', 'worktrees'), { recursive: true });
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
      execFileSync('git', ['worktree', 'add', '-b', name, '--', wtPath, from || 'HEAD'], { cwd: repoDir, encoding: 'utf8' });
      return { path: wtPath, branch: name, baseCommit: head, repositoryRoot: repoDir };
    },
  };
}

async function proposeAndCommit(env) {
  const p = await env.services['agint.mutator.propose']({ ...clone(FIX_PROMPT), targetPlugin: 'agint-mutator' });
  return env.services['agint.mutator.commit']({ proposalId: p.id, repoRoot: env.repo.dir });
}

test('B1 ⛔ 阴性对照：隔离开启时，验证进行中主工作区仍是 preimage', async () => {
  let duringVerify = null;
  const env = makeEnv({
    worktreeIsolation: true,
    // worktrees 需要 repo 路径，先占位再补
    inspectDuringVerify: () => {
      duringVerify = readFileSync(join(env.repo.dir, 'plugins/agint-mutator/prompts/sys-prompt.md'), 'utf8');
    },
  });
  // 补上真 worktrees（env 已建好 repo）
  const origGet = env.services;
  void origGet;
  try {
    // 重开一个带 worktrees 的环境（makeEnv 里 get 闭包已固化，这里直接用真服务重建）
    env.cleanup();
    const env2 = (() => {
      const repo = makeGitRepo();
      const tables = { proposals: new Map(), commits: new Map(), findings: new Map(), metrics_log: new Map() };
      const services = {};
      let during2 = null;
      const mockSandbox = {
        runSmoke: async ({ target }) => {
          during2 = readFileSync(join(repo.dir, 'plugins/agint-mutator/prompts/sys-prompt.md'), 'utf8');
          return { target, ok: true, mode: 'in-process', exitCode: 0, stdout: '', stderr: '', checks: [], durationMs: 1 };
        },
      };
      const mockPolicy = { decide: async () => ({ kind: 'AUTO_DEPLOY', score: 80, reason: 'mock' }) };
      let cwd = repo.dir;
      const ctx = {
        storageDomain: { open: async () => ({
          table: (n) => {
            const s = tables[n] || (tables[n] = new Map());
            return { get size() { return s.size; }, entries: () => [...s.entries()][Symbol.iterator](), put: async (id, v) => { s.set(id, v); }, close: async () => {} };
          },
          close: async () => {},
        }) },
        get: (n) => {
          if (n === 'agint.qualitySandbox') return mockSandbox;
          if (n === 'agint.qualityPolicy') return mockPolicy;
          if (n === 'agint.diagnosis') return { annotate: async () => [], report: async () => ({}) };
          if (n === 'agint.evolution') return { queryFailures: async () => [] };
          if (n === 'worktrees') return makeRealWorktrees(repo.dir);
          if (n === 'workingDirectory') return { ensure: async () => cwd, set: async (a, p) => { cwd = p; return p; } };
          return null;
        },
        agent: { id: 'agent-x' },
        provide: (n, f) => { services[n] = f; },
        effect: () => () => {},
      };
      plugin.apply(ctx, { worktreeIsolation: true });
      return { services, tables, repo, getCwd: () => cwd, during: () => during2, cleanup: () => repo.cleanup() };
    })();
    try {
      const c = await proposeAndCommit(env2);
      assert.equal(c.ok, true, `commit 应成功：${JSON.stringify(c)}`);
      // ⛔ 这就是阴性对照：验证那一刻主工作区必须还是旧内容
      assert.equal(env2.during(), 'OLD prompt content',
        '验证进行中主工作区已经是 postimage 了 —— 隔离没生效（这正是 W6 要消灭的窗口）');
      // 验证完之后才写回
      assert.equal(readFileSync(join(env2.repo.dir, 'plugins/agint-mutator/prompts/sys-prompt.md'), 'utf8'), 'NEW POSTIMAGE');
      // audit 留痕
      const entry = Array.from(env2.tables.commits.values())[0];
      assert.equal(entry.audit.worktree.isolated, true);
      assert.ok(entry.audit.worktree.branch.startsWith('agint-mut/'));
      // cwd 还原
      assert.equal(env2.getCwd(), env2.repo.dir, 'commit 结束后 cwd 没还原');
      // worktree 清掉
      const branches = execFileSync('git', ['branch', '--list', 'agint-mut/*'], { cwd: env2.repo.dir, encoding: 'utf8' });
      assert.equal(branches.trim(), '', `残留分支：${branches}`);
    } finally { env2.cleanup(); }
  } finally {
    assert.ok(duringVerify === null || typeof duringVerify === 'string');
  }
});

test('B2 开关打开但 worktrees 服务缺失 ⇒ 降级直写，commit 仍成功且 audit 记 reason', async () => {
  const env = makeEnv({ worktreeIsolation: true, worktrees: null });
  try {
    const c = await proposeAndCommit(env);
    assert.equal(c.ok, true, '降级不应让 commit 失败 —— worktree 是优化不是前置条件');
    const entry = Array.from(env.tables.commits.values())[0];
    assert.equal(entry.audit.worktree.isolated, false);
    assert.equal(entry.audit.worktree.reason, 'worktrees-service-unavailable');
    // 降级路径下主工作区照样写对了
    assert.equal(readFileSync(join(env.repo.dir, 'plugins/agint-mutator/prompts/sys-prompt.md'), 'utf8'), 'NEW POSTIMAGE');
  } finally { env.cleanup(); }
});

test('B3 开关关闭（默认）⇒ audit 里**没有** worktree 字段（与「开了但降级」必须可区分）', async () => {
  const env = makeEnv({ worktreeIsolation: false, worktrees: makeRealWorktrees('/tmp') });
  try {
    const c = await proposeAndCommit(env);
    assert.equal(c.ok, true);
    const entry = Array.from(env.tables.commits.values())[0];
    assert.equal('worktree' in entry.audit, false, '默认关的运行不该多出字段');
  } finally { env.cleanup(); }
});

test('B4 隔离开启但 sandbox 判 fail ⇒ REJECT + preimage 恢复（恢复语义不受隔离影响）', async () => {
  const repo = makeGitRepo();
  try {
    const tables = { proposals: new Map(), commits: new Map(), findings: new Map(), metrics_log: new Map() };
    const services = {};
    let cwd = repo.dir;
    const ctx = {
      storageDomain: { open: async () => ({
        table: (n) => {
          const s = tables[n] || (tables[n] = new Map());
          return { get size() { return s.size; }, entries: () => [...s.entries()][Symbol.iterator](), put: async (id, v) => { s.set(id, v); }, close: async () => {} };
        },
        close: async () => {},
      }) },
      get: (n) => {
        if (n === 'agint.qualitySandbox') {
          return { runSmoke: async ({ target }) => ({ target, ok: false, reason: 'mock-fail', mode: 'in-process', exitCode: 1, stdout: '', stderr: '', checks: [], durationMs: 1 }) };
        }
        if (n === 'agint.qualityPolicy') {
          return { decide: async () => ({ kind: 'REJECT', score: 0, reason: 'veto' }) };
        }
        if (n === 'agint.diagnosis') return { annotate: async () => [], report: async () => ({}) };
        if (n === 'agint.evolution') return { queryFailures: async () => [] };
        if (n === 'worktrees') return makeRealWorktrees(repo.dir);
        if (n === 'workingDirectory') return { ensure: async () => cwd, set: async (a, p) => { cwd = p; return p; } };
        return null;
      },
      agent: { id: 'agent-x' },
      provide: (n, f) => { services[n] = f; },
      effect: () => () => {},
    };
    plugin.apply(ctx, { worktreeIsolation: true });
    const p = await services['agint.mutator.propose']({ ...clone(FIX_PROMPT), targetPlugin: 'agint-mutator' });
    await assert.rejects(
      () => services['agint.mutator.commit']({ proposalId: p.id, repoRoot: repo.dir }),
      /policyDecision=REJECT/,
    );
    // ⛔ 关键：REJECT 后主工作区必须是 preimage（隔离 + 恢复叠在一起不能出岔子）
    assert.equal(readFileSync(join(repo.dir, 'plugins/agint-mutator/prompts/sys-prompt.md'), 'utf8'), 'OLD prompt content');
    // 也没有残留 worktree 分支
    const branches = execFileSync('git', ['branch', '--list', 'agint-mut/*'], { cwd: repo.dir, encoding: 'utf8' });
    assert.equal(branches.trim(), '');
    assert.equal(cwd, repo.dir, 'cwd 没还原');
  } finally { rmSync(repo.dir, { recursive: true, force: true }); }
});
