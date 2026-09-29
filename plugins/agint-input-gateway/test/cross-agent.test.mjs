/**
 * C5 跨 Agent Channel 测试（v0.3.0）。
 * 真调 crossAgentChannel.fetch(ctx)：
 *   - mock agint.ovStrategy.recall（复刻真实契约 { ok, entries, digest }）
 *   - 临时 DSH_HOME（sessions 目录 + storages 状态文件）
 * 覆盖：OV diff 信号 / 会话聚类 pattern 信号 / 全不可用软降级 / 增量去重。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { crossAgentChannel } from '../lib/channels/cross-agent.js';

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'agint-c5-'));
  mkdirSync(join(root, 'sessions'), { recursive: true });
  mkdirSync(join(root, 'storages'), { recursive: true });
  return { root, oldHome: process.env.DSH_HOME };
}

function makeCtx(ovRecall) {
  return {
    get: (key) => {
      if (key === 'agint.ovStrategy') {
        return ovRecall ? { recall: ovRecall } : null;
      }
      return null;
    },
  };
}

test('fetch: OV 检索 + 会话聚类 → 产出 diff 与 pattern 两个信号', async () => {
  const { root, oldHome } = makeEnv();
  process.env.DSH_HOME = root;
  try {
    // 造两个 workspace 的会话文件
    for (const ws of ['ws-a', 'ws-b']) {
      mkdirSync(join(root, 'sessions', ws, 'sid-' + ws), { recursive: true });
      writeFileSync(join(root, 'sessions', ws, 'sid-' + ws, 'session.v4.jsonl.zstd'), 'x');
    }
    const ctx = makeCtx(async () => ({
      ok: true,
      entries: [
        { id: 'e-ov-1', title: '跨 preset 经验：诊断链激活', source: 'preset-other' },
        { id: 'e-ov-2', title: '决策：安全门禁默认降级', source: 'preset-other' },
      ],
      digest: null,
    }));
    const signals = await crossAgentChannel.fetch(ctx);
    assert.ok(Array.isArray(signals));
    assert.ok(signals.length >= 2, `expected >=2 signals, got ${signals.length}`);
    const diff = signals.find((s) => s.signalType === 'cross.agent.diff');
    const pattern = signals.find((s) => s.signalType === 'cross.agent.pattern');
    assert.ok(diff, '应有 cross.agent.diff 信号');
    assert.ok(pattern, '应有 cross.agent.pattern 信号');
    assert.equal(diff.payload.newEntryCount, 2);
    assert.equal(diff.source, 'openviking');
    assert.equal(pattern.payload.workspaces.length, 2);
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('fetch: OV 不可用 → 只产会话聚类信号（软降级不抛）', async () => {
  const { root, oldHome } = makeEnv();
  process.env.DSH_HOME = root;
  try {
    for (const ws of ['ws-a', 'ws-b']) {
      mkdirSync(join(root, 'sessions', ws, 'sid-' + ws), { recursive: true });
      writeFileSync(join(root, 'sessions', ws, 'sid-' + ws, 'session.v4.jsonl.zstd'), 'x');
    }
    const ctx = makeCtx(async () => ({ ok: false, reason: 'search-failed:500' }));
    const signals = await crossAgentChannel.fetch(ctx);
    assert.ok(signals.length === 1, `expected 1 signal, got ${signals.length}`);
    assert.equal(signals[0].signalType, 'cross.agent.pattern');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('fetch: 全部不可用 → 空数组（不抛错）', async () => {
  const { root, oldHome } = makeEnv();
  process.env.DSH_HOME = root;
  try {
    // sessions 目录无活跃会话；OV 也未挂载
    const ctx = makeCtx(null);
    const signals = await crossAgentChannel.fetch(ctx);
    assert.ok(Array.isArray(signals));
    assert.equal(signals.length, 0);
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('fetch: 增量去重 —— 相同 OV 条目第二次不再产 diff', async () => {
  const { root, oldHome } = makeEnv();
  process.env.DSH_HOME = root;
  try {
    // 无活跃会话 → 只测 diff 增量
    const entries = [
      { id: 'e-dup-1', title: '经验', source: 'preset-x' },
      { id: 'e-dup-2', title: '决策', source: 'preset-x' },
    ];
    const ctx = makeCtx(async () => ({ ok: true, entries, digest: null }));
    const first = await crossAgentChannel.fetch(ctx);
    assert.ok(first.some((s) => s.signalType === 'cross.agent.diff'));
    // 第二次：同一 entries，无新条目 → diff 不再产出
    const second = await crossAgentChannel.fetch(ctx);
    assert.ok(!second.some((s) => s.signalType === 'cross.agent.diff'), '重复条目不应再产 diff 信号');
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
});
