/**
 * test/smoke.mjs — agint-quality-report smoke test（Sprint 12 / A5 顶层 stub 准入）
 *
 * 顶层 stub 模式：不依赖 Cordis host，仅验证真实 lib 文件存在 + 可加载 + 提供 reporter iface。
 * 真 smoke（render 纯函数 / persist 路径）由 monorepo 内的 test 覆盖。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_LIB = resolve(__dirname, '../../agint-quality/agint-quality-report/lib/index.js');

test('real lib exists', () => {
  assert.ok(existsSync(REAL_LIB), `monorepo lib must exist: ${REAL_LIB}`);
});

test('plugin module loads without throwing', async () => {
  const mod = await import(REAL_LIB);
  assert.equal(typeof mod.apply, 'function', 'must export apply(ctx, config)');
  assert.equal(typeof mod.name, 'string', 'must export name');
});
