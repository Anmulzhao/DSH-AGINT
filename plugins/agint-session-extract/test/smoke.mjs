#!/usr/bin/env node
// agint-session-extract smoke — `node test/smoke.mjs` 一行能跑。
//
// 根入口纯函数模块，不挂 Cordis、不真解压。只验证：
//   - 导出契约（发现层 / 解析层 / 提取层关键函数在位）
//   - 发现层按「后缀 + 版本秩」排序（09-22 改名断供教训的固化断言）
//   - parseSession 坏行跳过不抛
//   - resolveZstdBin 的 ZSTD_BIN 覆盖（机器私有装位唯一入口）

import test from 'node:test';
import assert from 'node:assert/strict';

import * as mod from '../index.js';

test('导出契约：发现 / 解析 / 提取关键函数在位', () => {
  for (const fn of [
    'resolveZstdBin', 'sessionLogRank', 'sessionLogFormat', 'listSessionLogs',
    'findSessionLog', 'decompressSession', 'parseSession', 'loadSession',
    'extractToolCalls', 'extractModels', 'readSessionRecords',
  ]) {
    assert.equal(typeof mod[fn], 'function', `缺导出 ${fn}`);
  }
});

test('发现层版本秩：v4 > v3 > 无版本 > 杂项（不按名字表认文件）', () => {
  assert.ok(mod.sessionLogRank('session.v4.jsonl.zstd') > mod.sessionLogRank('session.v3.jsonl.zstd'));
  assert.ok(mod.sessionLogRank('session.v3.jsonl.zstd') > mod.sessionLogRank('session.jsonl.zstd'));
  assert.ok(mod.sessionLogRank('session.jsonl.zstd') > mod.sessionLogRank('README.md'));
  assert.equal(mod.sessionLogFormat('session.v4.jsonl.zstd'), 'v4');
  assert.equal(mod.sessionLogFormat('session.jsonl.zstd'), 'jsonl');
});

test('parseSession：坏行跳过不抛，空输入返空数组', () => {
  const events = [{ type: 'tool/call', seq: 1 }, { type: 'tool/result', seq: 2 }];
  const text = events.map((e) => JSON.stringify(e)).join('\n');
  assert.deepEqual(mod.parseSession(`${text}\n{bad json}\n\n`), events);
  assert.deepEqual(mod.parseSession(''), []);
});

test('resolveZstdBin：ZSTD_BIN 覆盖优先（机器私有装位唯一入口）', () => {
  const saved = process.env.ZSTD_BIN;
  try {
    process.env.ZSTD_BIN = '/custom/path/zstd';
    assert.equal(mod.resolveZstdBin(), '/custom/path/zstd');
  } finally {
    if (saved === undefined) delete process.env.ZSTD_BIN;
    else process.env.ZSTD_BIN = saved;
  }
});