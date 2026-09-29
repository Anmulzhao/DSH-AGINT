/**
 * plugin-check.sh 维度 11（observability-reachability）的自测。
 *
 * 背景：2026-09-29 evolution-cycle 首次真跑通 commit 后，AGINT 自改产出给
 * bin/plugin-check.sh 加了维度 11 —— 抓「service 把字段挂到返回值上、但没有任何
 * tool render 消费它」这种观测侧假绿。review 时确认它能工作（造探针插件能被报出），
 * 但**那段 134 行内嵌在 bash heredoc 里的 Node 代码没有任何测试保护**：靠的是
 * 「跑一次看对不对」。谁改坏它，CI 不会红，而它本来就是抓静默失败的门禁 ——
 * 门禁自己静默失效，比没有门禁更危险（这与 check-wiring.test.mjs 头注释是同一条道理）。
 *
 * 本测试把三件事钉死：
 *   1. 正向：service 产出高危字段但 render 不消费 → 必须报出该字段（维度 11 真的在工作）
 *   2. 负向：render 消费了该字段 → 不得报出（防误报，否则警告会被无视）
 *   3. 判据：维度 11 是 soft warning，**不得**把 lint 变成 fail（否则一次误报就能阻断 CI）
 *
 * 跑法：node --test bin/plugin-check-dim11.test.mjs
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = dirname(HERE);
const SCRIPT = join(HERE, 'plugin-check.sh');
const PROBE_NAME = 'agint-dim11probe';

function makeProbe(libSource) {
  const dir = join(REPO, 'plugins', PROBE_NAME);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'),
    JSON.stringify({ name: PROBE_NAME, version: '0.0.1', type: 'module', main: 'lib/index.js' }), 'utf8');
  writeFileSync(join(dir, 'manifest.json'),
    JSON.stringify({ name: PROBE_NAME, version: '0.0.1' }), 'utf8');
  writeFileSync(join(dir, 'README.md'), '# dim11 probe\n', 'utf8');
  writeFileSync(join(dir, 'CHANGELOG.md'), '# dim11 probe\n', 'utf8');
  writeFileSync(join(dir, 'lib', 'index.js'), libSource, 'utf8');
  return dir;
}

function runCheck(dir) {
  const r = spawnSync('bash', [SCRIPT, dir], { encoding: 'utf8', timeout: 120_000 });
  // plugin-check.sh 在 lint 模式下 exit 0；万一非 0 也要把输出带出来，否则测的是崩溃不是判据
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

afterEach(() => {
  rmSync(join(REPO, 'plugins', PROBE_NAME), { recursive: true, force: true });
});

describe('维度 11 observability-reachability（2026-09-29 evolution-cycle 自改产出）', () => {
  test('正向：service 产出高危字段但无 render 消费 → 必须报出该字段', () => {
    const dir = makeProbe(`export function apply(ctx) {
  ctx.provide('agint.dim11probe', {
    run: async () => {
      const result = { ok: true };
      result.initError = null;
      return result;
    },
  });
}
export function defineTool() {
  return {
    name: 'dim11probe_status',
    render: (v) => [{ type: 'text', text: 'ok=' + v.ok }],
  };
}
`);
    const out = runCheck(dir);
    assert.match(out.stdout + out.stderr, /维度 11 observability-reachability/,
      '维度 11 必须被触发 —— 若这里红，说明那段检测逻辑被改坏或静默失效了');
    assert.match(out.stdout + out.stderr, /initError/,
      '未消费的 initError 必须被点名报出');
  });

  test('负向：render 消费了该字段 → 不得报出（否则警告会被无视）', () => {
    const dir = makeProbe(`export function apply(ctx) {
  ctx.provide('agint.dim11probe', {
    run: async () => {
      const result = { ok: true };
      result.initError = null;
      return result;
    },
  });
}
export function defineTool() {
  return {
    name: 'dim11probe_status',
    render: (v) => [{ type: 'text', text: 'ok=' + v.ok + ' initError=' + v.initError }],
  };
}
`);
    const out = runCheck(dir);
    assert.doesNotMatch(out.stdout + out.stderr, /initError <-/,
      'render 已消费 initError 却仍被报出 —— 误报会让这个维度变成噪声');
  });

  test('判据：维度 11 只能是 soft warning，不得把 lint 变成 fail', () => {
    const dir = makeProbe(`export function apply(ctx) {
  ctx.provide('agint.dim11probe', {
    run: async () => {
      const result = { ok: true };
      result.diagnostics = { a: 1 };
      return result;
    },
  });
}
export function defineTool() {
  return {
    name: 'dim11probe_status',
    render: (v) => [{ type: 'text', text: 'ok=' + v.ok }],
  };
}
`);
    const out = runCheck(dir);
    assert.doesNotMatch(out.stdout + out.stderr, /\[FAIL\]/,
      '维度 11 报出漏检时不得产生 FAIL —— 它定位是「抓明显的漏」，不是完备证明');
    assert.equal(out.status, 0, 'lint 模式退出码必须是 0');
  });
});
