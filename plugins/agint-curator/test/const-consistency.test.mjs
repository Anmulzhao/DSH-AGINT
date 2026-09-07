// D4：三处「数据来源黑名单」副本一致性断言（Sprint14 §2.1）。
//
// 冗余是有意的：AGINT 存储域互斥，跨插件共享运行时常量会引入耦合，所以
// curator / skill-autocreate / (未来) curriculum 各持一份副本，由本测试守住
// 一致性。扫描是**自动发现**的——新插件加一份副本会被自动纳入，不需要改这里。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as curatorSchema from '../lib/schema.js';

const PLUGINS_ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function findSchemaFiles() {
  const out = [];
  for (const entry of readdirSync(PLUGINS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = join(PLUGINS_ROOT, entry.name, 'lib', 'schema.js');
    try {
      readFileSync(p, 'utf8');
      out.push({ plugin: entry.name, path: p });
    } catch { /* 无 schema.js */ }
  }
  return out;
}

function extract(text) {
  const prefixes = /sessionIdPrefixes:\s*Object\.freeze\(\[([^\]]*)\]\)/.exec(text);
  const tags = /sourceTags:\s*Object\.freeze\(\[([^\]]*)\]\)/.exec(text);
  const version = /DATA_SOURCE_BLACKLIST_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(text);
  if (!prefixes || !tags) return null;
  const norm = (s) => s.split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort();
  return {
    sessionIdPrefixes: norm(prefixes[1]),
    sourceTags: norm(tags[1]),
    version: version ? version[1] : null,
  };
}

test('D4：所有插件 schema.js 里的黑名单副本完全一致（自动发现）', () => {
  const found = [];
  for (const { plugin, path } of findSchemaFiles()) {
    const c = extract(readFileSync(path, 'utf8'));
    if (c) found.push({ plugin, ...c });
  }
  assert.ok(found.length >= 2, `应至少有 2 处副本（curator + skill-autocreate），实际 ${found.length}`);

  const base = found[0];
  for (const f of found.slice(1)) {
    assert.deepEqual(f.sessionIdPrefixes, base.sessionIdPrefixes, `${f.plugin} 与 ${base.plugin} 的 sessionIdPrefixes 不一致`);
    assert.deepEqual(f.sourceTags, base.sourceTags, `${f.plugin} 与 ${base.plugin} 的 sourceTags 不一致`);
    assert.equal(f.version, base.version, `${f.plugin} 与 ${base.plugin} 的 DATA_SOURCE_BLACKLIST_VERSION 不一致（改副本必须同步 bump）`);
  }
});

test('D4：curator 副本内容符合 D1 决策（curriculum- 前缀 + curriculum 标签）', () => {
  assert.deepEqual([...curatorSchema.EXCLUDED_DATA_SOURCES.sessionIdPrefixes], ['curriculum-']);
  assert.deepEqual([...curatorSchema.EXCLUDED_DATA_SOURCES.sourceTags], ['curriculum']);
  assert.equal(curatorSchema.DATA_SOURCE_BLACKLIST_VERSION, '2026-09-14.v1');
});

test('D4：过滤语义一致 —— 黑名单记录被丢、普通记录保留', () => {
  // curator 侧
  assert.equal(curatorSchema.isExcludedRecord({ sessionId: 'curriculum-x' }), true);
  assert.equal(curatorSchema.isExcludedRecord({ sessionId: 's1' }), false);
});
