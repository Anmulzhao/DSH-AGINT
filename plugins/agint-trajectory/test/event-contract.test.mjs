/**
 * agint-trajectory 静态契约测试：事件订阅真实性（§十验收标准）。
 *
 * 为什么要有这个文件：设计稿 v0.1 曾经订阅了 5 个**根本不存在**的事件
 * （`evolution.mutator.proposed` / `evolution.sandbox.verified` /
 * `mount.activated` / `eval.completed` / `subagent.ended`，源码 grep 命中 0）。
 * 教训表写下的护栏是「只订阅已验证存在的事件」——但护栏写在文档里没用，
 * 要能被 CI 执行（K19 schema-guard 同款模式）。
 *
 * 做法：正则从 `lib/subscribers.js` 抽出订阅清单 → 到 `plugins/` 全库
 * grep 校验存在 publish 定义 → 缺失即 FAIL（除非在已知未实施白名单里，
 * 且白名单条目必须写明依据）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const PLUGINS_ROOT = fileURLToPath(new URL('../../', import.meta.url)); // plugins/
const SELF = fileURLToPath(new URL('../', import.meta.url));

/**
 * 已知「设计稿已定义但尚未实施」的事件白名单。
 * 每条必须写明依据与解除条件——不允许用白名单掩盖真实缺失。
 */
const KNOWN_NOT_IMPLEMENTED = Object.freeze({
  'evo-orch.task-started': 'P2-3 子代理编排设计稿 §5.2 已定义 15 个事件，插件未实施（§13.2 时序依赖）',
  'evo-orch.task-completed': 'P2-3 尚未实施；解除条件：agint-evolve-orchestrator 挂载并 publish',
});

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      await walk(p, out);
    } else if (e.isFile() && e.name.endsWith('.js') && !e.name.endsWith('.test.js')) {
      out.push(p);
    }
  }
  return out;
}

/** 从源码抽订阅清单（SUBSCRIPTIONS 数组的 `{ topic: 'x' }` 形状） */
async function extractSubscribedTopics() {
  const src = await readFile(join(SELF, 'lib', 'subscribers.js'), 'utf8');
  const block = src.match(/export const SUBSCRIPTIONS[\s\S]*?\]\);/);
  assert.ok(block, '未找到 SUBSCRIPTIONS 常量');
  const topics = [...block[0].matchAll(/topic:\s*'([^']+)'/g)].map((m) => m[1]);
  return [...new Set(topics)];
}

test('订阅清单可抽出且非空（防止清单被误删后测试空转）', async () => {
  const topics = await extractSubscribedTopics();
  assert.ok(topics.length >= 4, `订阅数=${topics.length}`);
  assert.ok(topics.includes('dream.completed'));
});

test('每个订阅的事件都能在 plugins/ 里 grep 到 publish 定义', async () => {
  const topics = await extractSubscribedTopics();
  const files = (await walk(PLUGINS_ROOT)).filter((f) => !f.startsWith(SELF));
  assert.ok(files.length > 20, `扫描到 ${files.length} 个插件源码文件`);

  const missing = [];
  const knownPending = [];
  for (const topic of topics) {
    let found = false;
    for (const f of files) {
      const text = await readFile(f, 'utf8');
      // publish 定义形态：`topic: 'xxx'`（不是订阅形态 `topics: ['xxx']`）
      if (text.includes(`topic: '${topic}'`)) {
        found = true;
        break;
      }
    }
    if (found) continue;
    if (KNOWN_NOT_IMPLEMENTED[topic]) knownPending.push(`${topic} —— ${KNOWN_NOT_IMPLEMENTED[topic]}`);
    else missing.push(topic);
  }

  if (knownPending.length) {
    console.log(`[event-contract] 已知未实施（不阻断，但必须可追溯）：\n  - ${knownPending.join('\n  - ')}`);
  }
  assert.deepEqual(missing, [], `订阅了不存在的事件：${missing.join(', ')}`);
});

test('反例护栏：虚构事件必须被 grep 判为不存在（测试本身有效）', async () => {
  const files = await walk(PLUGINS_ROOT);
  const ghosts = ['evolution.mutator.proposed', 'evolution.sandbox.verified', 'mount.activated', 'eval.completed', 'subagent.ended'];
  for (const g of ghosts) {
    let found = false;
    for (const f of files) {
      const text = await readFile(f, 'utf8');
      if (text.includes(`topic: '${g}'`)) { found = true; break; }
    }
    assert.equal(found, false, `反例 ${g} 居然存在，说明 grep 逻辑坏了`);
  }
});

test('订阅清单与代码路径一致：SUBSCRIBED_TOPICS 由 SUBSCRIPTIONS 派生', async () => {
  const src = await readFile(join(SELF, 'lib', 'subscribers.js'), 'utf8');
  assert.match(src, /SUBSCRIBED_TOPICS = Object\.freeze\(SUBSCRIPTIONS\.map/);
  assert.ok(relative(PLUGINS_ROOT, SELF).startsWith('agint-trajectory'), '扫描根目录应为 plugins/');
});
