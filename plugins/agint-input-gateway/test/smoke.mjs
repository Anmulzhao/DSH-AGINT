#!/usr/bin/env node
// agint-input-gateway smoke — `node test/smoke.mjs` 一行能跑。
//
// 不挂 Cordis、不真打开 storage domain。只验证：
//   - 导出契约（name / inject / apply）
//   - schema 常量（CHANNEL_TYPES / DEFAULT_QUOTAS / KNOWN_TOPICS / DEFAULTS）
//   - storage spec shape（域名 / 4 表 / schemaVersion 1）
//   - tools 契约（inject + 6 个工具）
//   - 插件源码自洽（index.js 提供 agint.inputGateway，tools.js 引用它）

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

test('导出契约：name / inject / apply', () => {
  assert.equal(plugin.name, 'agint-input-gateway');
  assert.deepEqual(plugin.inject, ['storageDomain']);
  assert.equal(typeof plugin.apply, 'function');
});

test('schema 常量：CHANNEL_TYPES 5 类', () => {
  assert.equal(schema.CHANNEL_TYPES.HUMAN, 'human');
  assert.equal(schema.CHANNEL_TYPES.SELF_OBSERVATION, 'self-observation');
  assert.equal(schema.CHANNEL_TYPES.EXTERNAL, 'external');
  assert.equal(schema.CHANNEL_TYPES.ADVERSARIAL, 'adversarial');
  assert.equal(schema.CHANNEL_TYPES.CROSS_AGENT, 'cross-agent');
});

test('schema 常量：DEFAULT_QUOTAS 合理', () => {
  assert.equal(schema.DEFAULT_QUOTAS['self-observation'], 50);
  assert.equal(schema.DEFAULT_QUOTAS['external'], 20);
  assert.equal(schema.DEFAULT_QUOTAS['adversarial'], 10);
  assert.equal(schema.DEFAULT_QUOTAS['cross-agent'], 15);
});

test('schema 常量：DEFAULTS 阈值', () => {
  assert.equal(schema.DEFAULTS.confidenceThreshold, 0.3);
  assert.equal(schema.DEFAULTS.relevanceLowQueue, 0.2);
  assert.equal(schema.DEFAULTS.noiseMaxPerSource, 5);
  assert.equal(schema.DEFAULTS.payloadMaxBytes, 2048);
});

test('schema 常量：KNOWN_TOPICS 预定义集合', () => {
  assert.ok(Array.isArray(schema.KNOWN_TOPICS));
  assert.ok(schema.KNOWN_TOPICS.length >= 5);
  for (const t of schema.KNOWN_TOPICS) {
    assert.ok(t.startsWith('input.signal.'), `topic ${t} 前缀不对`);
  }
});

test('storage spec：独立域 agint_input_gateway / 4 表 / schemaVersion 1', () => {
  assert.equal(storage.spec.name, 'agint_input_gateway');
  assert.equal(storage.spec.version, 1);
  const tables = Object.keys(storage.spec.tables);
  assert.deepEqual(tables.sort(), ['channel_state', 'config', 'counters', 'dedup']);
});

test('tools 契约：inject + 6 个工具注册', () => {
  assert.equal(tools.name, 'agint-input-gateway-tools');
  assert.deepEqual(tools.inject, ['tools', 'agint.inputGateway']);
  assert.equal(typeof tools.apply, 'function');

  // 验证 tools.js 源码注册了 6 个工具
  const src = read(join(libDir, 'tools.js'));
  const toolNames = [
    'input_gateway_status',
    'input_gateway_channel_status',
    'input_gateway_force_fetch',
    'input_gateway_set_quota',
    'input_gateway_channel_enable',
    'input_gateway_channel_disable',
  ];
  for (const name of toolNames) {
    assert.ok(src.includes(name), `tools.js 未注册 ${name}`);
  }
  // 写操作必须标注
  assert.ok(src.includes('⚠️ 写操作'), '写操作工具必须标注 ⚠️ 写操作');
});

test('本插件源码自洽：index.js provide agint.inputGateway', () => {
  const src = read(join(libDir, 'index.js'));
  assert.ok(src.includes("ctx.provide('agint.inputGateway'"), '必须 provide agint.inputGateway');
  assert.ok(src.includes('startScheduler'), '必须启动调度');
  assert.ok(src.includes('selfObservationChannel'), '必须注册 C2 Channel');
});

test('本插件源码自洽：gateway.js 检查 publish accepted', () => {
  const src = read(join(libDir, 'gateway.js'));
  assert.ok(src.includes('accepted'), '必须检查 eventBus publish 返回值 accepted');
  assert.ok(src.includes('confidenceThreshold'), '必须实现置信度过滤');
  assert.ok(src.includes('dedupKey'), '必须实现去重');
  assert.ok(src.includes('quota'), '必须实现配额');
});

test('本插件源码自洽：C2 Channel 5 个子源', () => {
  const src = read(join(libDir, 'channels', 'self-observation.js'));
  assert.ok(src.includes('detectToolAnomaly'), '子源 1: toolStats');
  assert.ok(src.includes('detectMetricRegression'), '子源 2: metrics');
  assert.ok(src.includes('detectRuleHotspot'), '子源 3: rules');
  assert.ok(src.includes('detectCompressLoss'), '子源 4: compress-guard');
  assert.ok(src.includes('detectSessionIntegrity'), '子源 5: session');
});
