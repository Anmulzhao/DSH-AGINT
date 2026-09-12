#!/usr/bin/env node
// agint-compress-guard smoke — `node test/smoke.mjs` 一行能跑。
//
// 不挂 Cordis、不真打开 storage domain。只验证：
//   - 导出契约（name / inject / apply / ConfigSchema 默认值）
//   - FROZEN 枚举（类型 / 保留级 / 双 id 空间 / 档位 / 状态机 4 态）
//   - storage spec shape（域名 / 4 表 / schemaVersion 1）
//   - 不变量 1 validate（raw 先于洞察：缺 ref 拒绝 / pending 放行 / id 空串拒绝）
//   - 不变量 7 静态核实：订阅/监听的事件名在源码与宿主包 grep 命中（K19 同款）

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as schema from '../lib/schema.js';
import * as storage from '../lib/storage.js';
import * as plugin from '../lib/index.js';
import * as tools from '../lib/tools.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const libDir = join(here, '..', 'lib');
const read = (p) => readFileSync(p, 'utf8');

test('导出契约：name / inject / apply / ConfigSchema', () => {
  assert.equal(plugin.name, 'agint-compress-guard');
  assert.deepEqual(plugin.inject, ['storageDomain', 'agint.memory']);
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(plugin.ConfigSchema);
  const c = plugin.ConfigSchema.parse({});
  assert.equal(c.enabled, true);            // 全局熔断默认开
  assert.equal(c.shadowMode, true);         // §七挂载策略：shadow 观察档默认
  assert.equal(c.llmExtractEnabled, false); // Q1 默认关
  assert.equal(c.maxInsightsPerCompress, 20);
  assert.equal(c.fallbackEnabled, true);    // §6.2 兜底默认开
  assert.equal(c.extractTimeoutMs, 3000);   // §3.2 软超时
  assert.equal(c.recoveryProbeMs, 300000);  // 不变量 8：300s 冷却（Hermes 同构）
});

test('FROZEN 枚举：洞察三类型 / 保留级 / 双 id 空间 / 提取器版本', () => {
  assert.deepEqual([...schema.INSIGHT_TYPES], ['decision', 'fact', 'preference']);
  assert.deepEqual([...schema.RETENTION_LEVELS], ['normal', 'highRetention']);
  assert.deepEqual([...schema.CHECKPOINT_REF_KINDS], ['p1-checkpoint', 'host-compaction']);
  assert.deepEqual([...schema.EXTRACTOR_VERSIONS], ['rule-v1', 'llm-v1']);
});

test('FROZEN 枚举：guard_log 状态机 4 态 + 档位 3 值（A 保留枚举但永不产出）', () => {
  assert.deepEqual([...schema.GUARD_STATUSES], [
    'PASSED', 'DEGRADED_INSIGHT', 'BLOCKED_CHECKPOINT', 'NO_SOURCE_REACHED',
  ]);
  assert.deepEqual([...schema.GUARD_TIERS], ['A', 'B', 'C']);
});

test('事件 topic 常量：发布 2 / 订阅 2 / 宿主 compaction 4（设计稿 §5.1-5.2）', () => {
  assert.deepEqual([...schema.TOPICS_PUBLISHED], ['compress-guard.blocked', 'compress-guard.checkpointed']);
  assert.deepEqual([...schema.TOPICS_SUBSCRIBED], ['memory.pre-compress-checkpoint', 'memory.provider-activated']);
  assert.deepEqual([...schema.SESSION_COMPACTION_EVENTS], [
    'compaction/start', 'compaction/summary', 'compaction/end', 'compaction/prune',
  ]);
});

test('storage spec：独立域 agint_compress_guard / 4 表 / schemaVersion 1', () => {
  assert.equal(storage.spec.name, 'agint_compress_guard');
  assert.equal(storage.spec.version, 1);
  const tables = Object.keys(storage.spec.tables);
  assert.deepEqual(tables.sort(), ['config', 'counters', 'guard_log', 'insights']);
});

test('不变量 1 validate：缺 checkpointRef 拒绝 / linkPending 放行 / id 空串拒绝', () => {
  const base = {
    type: 'decision',
    content: 'x',
    source: { checkpointRef: { kind: 'p1-checkpoint', id: 'pcc_x', extractedAt: 't', extractor: 'rule-v1' } },
    retention: 'normal', recallCount: 0, lastRecalledAt: null, supersededBy: null, linkPending: false,
  };
  // 正常：kind + id
  assert.equal(schema.validateInsight(base).ok, true);
  // 缺 ref → 拒
  assert.equal(schema.validateInsight({ ...base, source: {} }).ok, false);
  // id 空且无 pending → 拒
  const noId = JSON.parse(JSON.stringify(base));
  noId.source.checkpointRef.id = null;
  assert.equal(schema.validateInsight(noId).ok, false);
  // id 空 + linkPending → 放行（P1-1 载荷缺口回填窗口）
  assert.equal(schema.validateInsight({ ...noId, linkPending: true }).ok, true);
  // id 空串 → 拒（空串不是合法 id）
  const emptyId = JSON.parse(JSON.stringify(base));
  emptyId.source.checkpointRef.id = '';
  assert.equal(schema.validateInsight(emptyId).ok, false);
  // 非法 kind → 拒
  const badKind = JSON.parse(JSON.stringify(base));
  badKind.source.checkpointRef.kind = 'unknown';
  assert.equal(schema.validateInsight(badKind).ok, false);
});

test('packInsight：ins_<date>_<8hash> id + preference 默认 highRetention 由 engine 负责', () => {
  const rec = storage.packInsight({
    type: 'fact',
    content: '端口 3080 是 web 服务',
    source: {
      checkpointRef: {
        kind: 'host-compaction', id: 'cp_1', extractedAt: '2026-09-13T00:00:00.000Z', extractor: 'rule-v1',
      },
    },
    linkPending: false,
  });
  assert.match(rec.id, /^ins_20260913_[0-9a-f]{8}$/);
  assert.equal(rec.recallCount, 0);
  assert.equal(rec.supersededBy, null);
  // 同内容同日 → 同 id（内容寻址，天然去重）
  const again = storage.packInsight(JSON.parse(JSON.stringify({
    type: 'fact', content: '端口 3080 是 web 服务',
    source: { checkpointRef: { kind: 'host-compaction', id: 'cp_1', extractedAt: '2026-09-13T00:00:00.000Z', extractor: 'rule-v1' } },
    linkPending: false,
  })));
  assert.equal(again.id, rec.id);
});

test('不变量 7 静态核实（K19 同款）：订阅事件名在 P1-1 源码 grep 命中', () => {
  // P1-1 管理器真实发布这两个 topic
  const managerSrc = read(join(here, '..', '..', 'agint-memory-provider', 'lib', 'manager.js'));
  for (const topic of schema.TOPICS_SUBSCRIBED) {
    assert.ok(
      managerSrc.includes(`'${topic}'`) || managerSrc.includes(`"${topic}"`),
      `P1-1 manager.js 未发布 ${topic}（命中 0 = 不存在，不许凭印象订阅）`,
    );
  }
});

test('不变量 7 静态核实：B 档 compaction 事件名在宿主 dsh-session 包 grep 命中', () => {
  // 宿主源码位置：D:\DSH\node_modules（或 dsh 主包嵌套）；找到哪份都算命中
  const candidates = [
    'D:/DSH/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js',
    'D:/DSH/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js',
  ];
  let src = null;
  for (const p of candidates) {
    try { src = read(p); break; } catch { /* try next */ }
  }
  if (src === null) {
    // 宿主不可达的环境（如 CI）跳过宿主断言，但本插件源码内仍需自洽
    assert.ok(true, '宿主 dsh-session 包不可达，跳过（本插件源码自洽断言在下一测）');
    return;
  }
  for (const evt of schema.SESSION_COMPACTION_EVENTS) {
    assert.ok(src.includes(`'${evt}'`), `宿主 known-event-types 缺少 ${evt}`);
  }
});

test('本插件源码自洽：session/event 与 compaction/summary 消费点存在于 lib/index.js', () => {
  const src = read(join(libDir, 'index.js'));
  assert.ok(src.includes("ctx.on('session/event'"), 'B 档必须走 session/event post-commit feed');
  assert.ok(src.includes('compaction/summary'), 'B 档主力必须消费 compaction/summary');
  const engineSrc = read(join(libDir, 'engine.js'));
  assert.ok(engineSrc.includes('runPreCompressCheckpoint'), 'C 档 raw 快照必须委托 P1-1 既有服务（分层不重建）');
  const bridgeSrc = read(join(libDir, 'provider-bridge.js'));
  assert.ok(bridgeSrc.includes('preCompressCheckpointApiVersion'), 'Q6 单一入口必须是 provider 形态');
});

test('tools 契约：inject + 两个只读工具', () => {
  assert.equal(tools.name, 'agint-compress-guard-tools');
  assert.deepEqual(tools.inject, ['tools', 'agint.compressGuard']);
  assert.equal(typeof tools.apply, 'function');
});
