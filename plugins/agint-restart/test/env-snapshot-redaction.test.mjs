/**
 * 防回归：env 快照不得把密钥写进 restart-request.json。
 *
 * 2026-10-06 实测事故：snapshotEnv() 把整个启动环境（172 键）写进
 * $DSH_HOME/.agint-restart/restart-request.json，该文件实测权限 0644，
 * 于是 WorkBuddy 注入的 CODEBUDDY_GATEWAY_PASSWORD / WORKBUDDY_PAC_RPC_TOKEN
 * 以明文长期躺在磁盘上，每次重启覆盖重写、从不清理。
 *
 * 本组用例同时钉住另一半：**误伤比漏检更贵**。正则若放宽到 AUTH|ACCESS_KEY，
 * 会连带剥掉 SSH_AUTH_SOCK —— 那不是密钥而是 socket 路径，剥掉等于断掉
 * ssh-agent 转发。所以「该剥的剥了」和「不该剥的还在」必须各有一条判据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 直接测纯函数：它只读 process.env，注入法即可，不依赖 cordis ctx。
// （pending-notice 那组用例挂在 ctx.get is not a function 上 —— 那是既存的
//   mock 不同步问题，本组不碰它，免得把新用例的成败和旧债混在一起。）
async function loadSnapshotEnv() {
  const mod = await import('../lib/index.js');
  assert.equal(typeof mod.snapshotEnv, 'function', 'snapshotEnv 须导出供本组测试调用');
  return mod.snapshotEnv;
}

/** 在一组临时 env 下跑一次 snapshotEnv，返回 { 快照, 还原 }。 */
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('密钥类 env 不得进快照', async () => {
  const snapshotEnv = await loadSnapshotEnv();
  withEnv({
    CODEBUDDY_GATEWAY_PASSWORD: 'fjrX8HzKLd1BLjtR2DYY0VzAuD5xZnmZTlr1nJnQ1a0',
    WORKBUDDY_PAC_RPC_TOKEN: 'Gakbllxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    SOME_DB_SECRET: 's3cr3t-value',
    MY_CREDENTIAL: 'cred-value',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI',
  }, () => {
    const snap = snapshotEnv();
    for (const k of [
      'CODEBUDDY_GATEWAY_PASSWORD', 'WORKBUDDY_PAC_RPC_TOKEN',
      'SOME_DB_SECRET', 'MY_CREDENTIAL', 'AWS_SECRET_ACCESS_KEY',
    ]) {
      assert.equal(snap[k], undefined, `${k} 是密钥，不得进快照`);
    }
  });
});

test('不该剥的必须留下：SSH_AUTH_SOCK / 普通键（防误伤）', async () => {
  const snapshotEnv = await loadSnapshotEnv();
  withEnv({
    SSH_AUTH_SOCK: '/tmp/ssh-XXXX/agent.1234',
    PATH: '/usr/bin:/bin',
    HOME: '/home/kylin',
    CODEBUDDY_HOST: 'workbuddy-desktop',
    AGINT_TEST_PLAIN_KEY: 'not-a-secret-value', // 含 KEY 但不是密钥类命名
  }, () => {
    const snap = snapshotEnv();
    assert.ok(snap.SSH_AUTH_SOCK, 'SSH_AUTH_SOCK 是 socket 路径不是密钥，剥掉会断掉 ssh-agent 转发');
    assert.equal(snap.PATH, '/usr/bin:/bin');
    assert.equal(snap.HOME, '/home/kylin');
    assert.equal(snap.CODEBUDDY_HOST, 'workbuddy-desktop');
    assert.equal(snap.AGINT_TEST_PLAIN_KEY, 'not-a-secret-value');
  });
});

test('既有噪声过滤不得被这次改动破坏', async () => {
  const snapshotEnv = await loadSnapshotEnv();
  withEnv({
    OLDPWD: '/tmp', SHLVL: '2', _: '/usr/bin/node',
    npm_config_registry: 'https://registry.npmjs.org',
    npm_lifecycle_script: 'test',
    KEEP_ME: 'yes',
  }, () => {
    const snap = snapshotEnv();
    assert.equal(snap.OLDPWD, undefined);
    assert.equal(snap.SHLVL, undefined);
    assert.equal(snap._, undefined);
    assert.equal(snap.npm_config_registry, undefined);
    assert.equal(snap.npm_lifecycle_script, undefined);
    assert.equal(snap.KEEP_ME, 'yes');
  });
});

test('白名单优先级高于密钥正则（SSH_AUTH_SOCK 即便日后正则放宽也必须留下）', async () => {
  const snapshotEnv = await loadSnapshotEnv();
  // 构造一个「键名既在白名单、又会被宽松正则命中」的场景。
  // 当前窄正则不匹配它，所以这条锁的是**防御纵深**：白名单真生效时，
  // 即使日后有人把 SENSITIVE_ENV_KEY 放宽成 /AUTH|ACCESS_KEY/，这里也不会翻车。
  withEnv({ SSH_AUTH_SOCK: '/tmp/agent.sock' }, () => {
    const snap = snapshotEnv();
    assert.equal(snap.SSH_AUTH_SOCK, '/tmp/agent.sock');
  });
});

test('产物级：真实 request.json 里不得出现任何密钥值', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { snapshotEnv } = await import('../lib/index.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agint-restart-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const SECRET = 'PLAINTEXT-SECRET-MUST-NOT-PERSIST';
  // launch 对象照 snapshotLaunch() 的真实形状拼（command/args/cwd/env），
  // 它在 lib 里是私有的，不直接导出；这里只取它交给 respawn 的那个 env。
  const env = withEnv({ FAKE_GATEWAY_PASSWORD: SECRET }, () => snapshotEnv());
  const launch = { command: process.execPath, args: ['/dsh/bin.js', 'web'], cwd: dir, env };

  assert.equal(launch.env.FAKE_GATEWAY_PASSWORD, undefined, 'launch.env 不得含该键');

  // 走一遍真实的写盘路径，确认 JSON 字符串里也搜不到这个值
  const reqPath = path.join(dir, 'restart-request.json');
  fs.writeFileSync(reqPath, JSON.stringify({ launch }, null, 2));
  const raw = fs.readFileSync(reqPath, 'utf8');
  assert.equal(raw.includes(SECRET), false, '落盘后的 JSON 文本里不得出现密钥明文');
  assert.equal(raw.includes('FAKE_GATEWAY_PASSWORD'), false, '连键名都不该留下（键名也可能泄露部署信息）');
  assert.ok(raw.includes('"command"'), '对照组：非密钥字段仍应正常落盘，别把整个 env 剥空');
});