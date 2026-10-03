/**
 * storage schema 向后兼容测试（v0.1.1 契约修复回归）。
 * 背景：CountersSchema/ConfigSchema 新增字段一度为必填，导致 dsh-storage-domain
 * open 时对生产旧记录（无 security* 字段）整体校验失败 → gateway 初始化中断
 * （真实运行验收抓出：input_gateway_status 返回 fallback channels=0）。
 * 修复：新增字段改 optional。本测试用真实生产记录形状断言兼容。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigSchema, CountersSchema } from '../lib/storage.js';

// 真实生产 counters 记录形状（2026-09-29 从 agint_input_gateway.json 提取）
const OLD_COUNTERS = {
  channelId: 'self-observation',
  fetchCount: 2,
  signalsEmitted: 0,
  signalsFiltered: 0,
  signalsDeduplicated: 0,
  errorCount: 0,
  lastFetchAt: '2026-09-28T18:11:24.581Z',
  createdAt: '2026-09-28T17:47:39.804Z',
};

const NEW_COUNTERS = {
  ...OLD_COUNTERS,
  securityScanned: 1,
  securityFlagged: 0,
  securityDropped: 0,
};

// 真实生产 counters 记录形状（2026-10-03 从 agint_input_gateway.json 提取）。
// adversarial 通道在 v0.3.0 开发期间曾把 security* 三字段写成 null（不是缺失），
// .optional() 只认 undefined 不认 null → 整域 open 失败（本 bug 的现场）。
const NULL_SECURITY_COUNTERS = {
  channelId: 'adversarial',
  fetchCount: 4,
  signalsEmitted: 0,
  signalsFiltered: 0,
  signalsDeduplicated: 0,
  securityScanned: null,
  securityFlagged: null,
  securityDropped: null,
  errorCount: 0,
  lastFetchAt: '2026-09-29T19:30:24.175Z',
  createdAt: '2026-09-28T17:54:21.853Z',
};

const OLD_CONFIG = {
  id: 'config',
  enabled: true,
  confidenceThreshold: 0.3,
  relevanceLowQueue: 0.2,
  noiseMaxPerSource: 5,
  createdAt: '2026-09-28T17:47:39.804Z',
  updatedAt: '2026-09-28T17:47:39.804Z',
};

test('CountersSchema: 生产旧记录（无 security*）可解析（v0.1.1 向后兼容）', () => {
  const r = CountersSchema.safeParse(OLD_COUNTERS);
  assert.equal(r.success, true, JSON.stringify(r.success ? null : r.error.issues));
});

test('CountersSchema: 新记录（含 security*）可解析', () => {
  const r = CountersSchema.safeParse(NEW_COUNTERS);
  assert.equal(r.success, true, JSON.stringify(r.success ? null : r.error.issues));
});

test('CountersSchema: 生产 adversarial 旧记录（security* 为 null）可解析（v0.3.1 向后兼容）', () => {
  const r = CountersSchema.safeParse(NULL_SECURITY_COUNTERS);
  assert.equal(r.success, true, JSON.stringify(r.success ? null : r.error.issues));
});

test('ConfigSchema: 旧配置（无 securityAction/forwardEmptyDiagnosis）可解析', () => {
  const r = ConfigSchema.safeParse(OLD_CONFIG);
  assert.equal(r.success, true, JSON.stringify(r.success ? null : r.error.issues));
});

test('CountersSchema: 缺必填旧字段仍拒绝（不误放非法数据）', () => {
  const bad = { ...OLD_COUNTERS };
  delete bad.channelId;
  const r = CountersSchema.safeParse(bad);
  assert.equal(r.success, false);
});
