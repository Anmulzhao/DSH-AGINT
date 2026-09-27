/**
 * test/smoke.mjs — agint-metrics smoke test（Sprint 12 / A5 顶层 stub 准入）
 *
 * 顶层 stub 模式：验证真实 lib 文件存在 + 可加载 + 提供 metrics iface。
 * 真 smoke（collect / summary / policyCounters）由 lib 内的 unit test 覆盖。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_LIB = resolve(__dirname, '../lib/index.js');

test('real lib exists', () => {
  assert.ok(existsSync(REAL_LIB), `real lib must exist: ${REAL_LIB}`);
});

test('plugin module loads without throwing', async () => {
  // Windows 下 ESM 动态 import 必须用 file:// URL（裸 D:\ 路径会抛
  // ERR_UNSUPPORTED_ESM_URL_SCHEME —— 2026-09-27 修复的存量问题）。
  const mod = await import(pathToFileURL(REAL_LIB).href);
  assert.equal(typeof mod.apply, 'function', 'must export apply(ctx, config)');
  assert.equal(typeof mod.name, 'string', 'must export name');
});
