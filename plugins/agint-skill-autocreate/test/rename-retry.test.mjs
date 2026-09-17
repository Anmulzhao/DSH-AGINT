// test/rename-retry.test.mjs — 整目录 rename 退避重试（2026-09-17 EPERM 事故回归）
//
// 背景：真实 skills_root 上「新建目录+写文件 → 整目录 rename」实测约 5% 概率
// 抛 EPERM（宿主/杀软瞬时占用），导致约 5% 的技能白挂一次。
// 本测试用注入的假 rename 模拟该抖动，验证 renameWithRetry 能跨过瞬时占用、
// 且对确定性错误不浪费重试预算。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOD_PATH = pathToFileURL(resolve(__dirname, '../lib/release-manager.js')).href;
const { renameWithRetry } = await import(MOD_PATH);

const FAST = { delays: [0, 1, 2, 3, 4] };   // 测试用极短退避

const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });

test('一次成功 → attempts=1，不进入退避', async () => {
  let calls = 0;
  const attempts = await renameWithRetry('a', 'b', {
    ...FAST,
    _rename: async () => { calls++; },
  });
  assert.equal(attempts, 1);
  assert.equal(calls, 1);
});

test('前 2 次瞬时 EPERM，第 3 次成功 → 跨过占用（核心回归）', async () => {
  let calls = 0;
  const attempts = await renameWithRetry('a', 'b', {
    ...FAST,
    _rename: async () => {
      calls++;
      if (calls <= 2) throw eperm();
    },
  });
  assert.equal(attempts, 3, '应在第 3 次尝试成功');
  assert.equal(calls, 3);
});

test('EBUSY / EACCES 同样按瞬时错误重试', async () => {
  for (const code of ['EBUSY', 'EACCES']) {
    let calls = 0;
    const attempts = await renameWithRetry('a', 'b', {
      ...FAST,
      _rename: async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error(code), { code });
      },
    });
    assert.equal(attempts, 2, `${code} 应重试后成功`);
  }
});

test('确定性错误（EEXIST/ENOENT）立即抛出，不浪费重试', async () => {
  for (const code of ['EEXIST', 'ENOENT']) {
    let calls = 0;
    await assert.rejects(
      () => renameWithRetry('a', 'b', {
        ...FAST,
        _rename: async () => { calls++; throw Object.assign(new Error(code), { code }); },
      }),
      (e) => e.code === code,
    );
    assert.equal(calls, 1, `${code} 只应尝试 1 次`);
  }
});

test('持续 EPERM → 用尽重试后抛出，且错误信息含重试次数与源路径（便于取证）', async () => {
  let calls = 0;
  await assert.rejects(
    () => renameWithRetry('SRC-PATH', 'DST-PATH', {
      ...FAST,
      _rename: async () => { calls++; throw eperm(); },
    }),
    (e) => {
      assert.equal(e.code, 'EPERM');
      assert.match(e.message, /已重试 5 次/);
      assert.match(e.message, /SRC-PATH/);
      return true;
    },
  );
  assert.equal(calls, 5, '应尝试满 5 次');
});
