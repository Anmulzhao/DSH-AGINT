/**
 * test/self-model-isolation.test.mjs — Sprint 13 §4.7 self-model-isolation 规则组
 *
 * 6/6：happy path（agint-self-model 真实插件 0 blocker）+ 4 个故意破坏注入
 * + 1 个「非 self-model 插件跳过」校验。
 *
 * 跑法：node --test test/self-model-isolation.test.mjs（cwd = 插件根目录）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGINT_ROOT = resolve(__dirname, '../../..');
const { checkSelfModelIsolation } = await import(
  pathToFileURL(resolve(__dirname, '../lib/checkers/self-model-isolation.js')).href
);

const SELF_MODEL_DIR = resolve(AGINT_ROOT, 'plugins/agint-self-model');
const FIX = (n) => resolve(AGINT_ROOT, `plugins/agint-self-model/test/fixtures/${n}`);

const blockersOf = (findings) => findings.filter((f) => f.severity === 'blocker');

test('happy path: 真实 agint-self-model 插件 0 blocker', async () => {
  const findings = await checkSelfModelIsolation({ pluginDir: SELF_MODEL_DIR });
  assert.equal(blockersOf(findings).length, 0,
    `self-model 不应有 blocker（findings=${JSON.stringify(findings)}）`);
});

test('broken-policy: 引用 agint.qualityPolicy → blocker', async () => {
  const findings = await checkSelfModelIsolation({ pluginDir: FIX('broken-policy') });
  const blockers = blockersOf(findings);
  assert.ok(blockers.length >= 1, '应拦截 qualityPolicy 引用');
  assert.ok(findings.some((f) => f.message.includes('agint.qualityPolicy')), 'message 含 token');
});

test('broken-mutator: 引用 agint.mutator → blocker', async () => {
  const findings = await checkSelfModelIsolation({ pluginDir: FIX('broken-mutator') });
  const blockers = blockersOf(findings);
  assert.ok(blockers.length >= 1, '应拦截 mutator 引用');
  assert.ok(findings.some((f) => f.message.includes('agint.mutator')), 'message 含 token');
});

test('broken-population: 引用 agint.population → blocker', async () => {
  const findings = await checkSelfModelIsolation({ pluginDir: FIX('broken-population') });
  const blockers = blockersOf(findings);
  assert.ok(blockers.length >= 1, '应拦截 population 引用');
  assert.ok(findings.some((f) => f.message.includes('agint.population')), 'message 含 token');
});

test('broken-domain: 写既有 agint_* 域 → blocker', async () => {
  const findings = await checkSelfModelIsolation({ pluginDir: FIX('broken-domain') });
  const blockers = blockersOf(findings);
  assert.ok(blockers.length >= 1, '应拦截非 agint_self_model 域写入');
  assert.ok(findings.some((f) => f.message.includes('agint_rules')), 'message 含越权域名');
});

test('skip: 非 agint-self-model 插件直接跳过（不误伤 mutator/population）', async () => {
  const findings = await checkSelfModelIsolation({ pluginDir: resolve(AGINT_ROOT, 'plugins/agint-event-bus') });
  assert.equal(findings.length, 0, '非 self-model 插件不应被扫描');
});
