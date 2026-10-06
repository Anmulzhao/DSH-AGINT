/**
 * check-addfailure-callers 测试：判据正确性 + 全仓现扫零违规。
 * Run: node --test bin/check-addfailure-callers.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSource, scanPluginLibs } from './check-addfailure-callers.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('越界字面量 ⇒ 判负（新增调用点绕过映射表）', () => {
  const src = `const r = await evo.addFailure({ pattern: 'x', category: 'brand-new-thing', severity: 'high' });`;
  const { violations } = checkSource(src);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'category');
  assert.equal(violations[0].value, 'brand-new-thing');
});

test('映射键字面量 ⇒ 放行（mount/self-model 等 6 项在册）', () => {
  for (const cat of ['mount', 'population', 'self-model', 'prompt', 'governance', 'harmony']) {
    const { violations } = checkSource(`evo.addFailure({ pattern: 'p', category: '${cat}', severity: 'high' })`);
    assert.equal(violations.length, 0, cat);
  }
  const { violations } = checkSource(`evo.addFailure({ pattern: 'p', category: 'integration', severity: 'critical' })`);
  assert.equal(violations.length, 0, 'critical 在 severity 映射表内');
});

test('枚举内值 ⇒ 放行；severity 越界字面量 ⇒ 判负', () => {
  assert.equal(checkSource(`a({ x: 1 }); evo.addFailure({ category: 'security', severity: 'low' })`).violations.length, 0);
  assert.equal(checkSource(`evo.addFailure({ pattern: 'p', severity: 'mega' })`).violations.length, 1);
});

test('动态值（变量/三元）⇒ 不判负，记 dynamic', () => {
  const r = checkSource(`evo.addFailure({ pattern: 'p', category: pattern.category, severity: timedOut ? 'high' : 'medium' })`);
  assert.equal(r.violations.length, 0);
  assert.ok(r.dynamics.some((d) => d.kind === 'category' && d.value.includes('pattern')));
});

test('全仓现扫：零越界字面量（现状基线锁）', () => {
  const r = scanPluginLibs(join(here, '..', 'plugins'));
  assert.equal(r.violations.length, 0, JSON.stringify(r.violations));
  assert.ok(r.files > 200, `扫描文件数 ${r.files} 不合理`);
});
