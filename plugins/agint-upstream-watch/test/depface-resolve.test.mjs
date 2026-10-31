/**
 * 包定位（`resolveDshRoot` / `resolveInstalledPackage`）的布局测试。
 *
 * 为什么单独一组：这两个函数在单测里"看起来对"，在真实机器上却错过了整个安装树 ——
 * 2026-10-28 实测了两次同类事故：
 *   ① v0.1：兄弟 hoist 路径对 scoped 包多拼了一层（`.../@deepseek-ai/@deepseek-ai/dsh-tools`），
 *      全局安装布局下**从未命中真实安装树**，于是永远退回 `profiles/node_modules` 里的
 *      遗留副本（0.1.1-rc.2），得出「45 个导出被移除」的全假结论。
 *   ② v0.2：`@deepseek-ai/dsh` 主包自身走「版本最大」兜底，同样选中遗留副本，
 *      `engines` 变成「(unset) → >=24.9」这种没法处置的结论。
 *
 * 教训：夹具必须照**真实布局**造（`<prefix>/lib/node_modules/@scope/<pkg>` 兄弟并列），
 * 而不是照「主包 node_modules 里套一层」这种单测里方便的形状。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveDshRoot, resolveInstalledPackage, readInstalledSymbols } from '../lib/depface.js';

/** 造全局安装布局：<prefix>/lib/node_modules/@deepseek-ai/{dsh,dsh-tools,...} 兄弟并列 */
function globalLayout({ dshVersion = '0.2.1-rc.3', extra = {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'upw-resolve-'));
  const nm = join(base, 'prefix', 'lib', 'node_modules', '@deepseek-ai');
  const mk = (name, version, dts) => {
    const dir = join(nm, name);
    mkdirSync(join(dir, 'lib', 'types'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version }));
    writeFileSync(join(dir, 'lib', 'types', 'index.d.ts'), dts ?? '');
    return dir;
  };
  const dshDir = mk('dsh', dshVersion);
  for (const [name, spec] of Object.entries(extra)) mk(name, spec.version ?? dshVersion, spec.dts);
  return { base, nm, dshDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('全局布局：主包与兄弟包都能定位到真实安装树', () => {
  const g = globalLayout({ extra: { 'dsh-tools': {} } });
  try {
    const env = { DSH_ROOT: g.dshDir };
    const root = resolveDshRoot(env);
    assert.equal(root?.version, '0.2.1-rc.3');

    const tools = resolveInstalledPackage('@deepseek-ai/dsh-tools', env);
    assert.ok(tools, '兄弟 hoist 位必须命中 —— 旧写法在这里拼错一层，永远落空');
    assert.equal(tools.version, '0.2.1-rc.3');
    assert.equal(tools.versionMismatch, false);
  } finally { g.cleanup(); }
});

test('主包自身 ⇒ 直取 resolveDshRoot，不参与「版本最大」兜底', () => {
  const g = globalLayout();
  try {
    const env = { DSH_ROOT: g.dshDir };
    const self = resolveInstalledPackage('@deepseek-ai/dsh', env);
    assert.equal(self?.dir, g.dshDir);
    assert.equal(self?.version, '0.2.1-rc.3');
    assert.equal(self?.versionMismatch, false);
  } finally { g.cleanup(); }
});

test('主包自身：profiles 里的旧副本不能把它顶掉（阴性对照）', () => {
  const g = globalLayout();
  try {
    // 造一个 App 升级甩下的遗留副本
    const stale = join(g.base, 'home', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.2' }));

    const env = { DSH_ROOT: g.dshDir, DSH_HOME: join(g.base, 'home') };
    const self = resolveInstalledPackage('@deepseek-ai/dsh', env);
    assert.equal(self?.version, '0.2.1-rc.3', '必须给真实安装树，不是版本号最大的副本');
  } finally { g.cleanup(); }
});

test('readInstalledSymbols 能读出真实布局下的导出名', () => {
  const g = globalLayout({
    extra: { 'dsh-tools': { dts: 'export declare function defineTool(): void;\nexport declare interface ToolDefinition {}' } },
  });
  try {
    const dir = join(g.nm, 'dsh-tools');
    const syms = readInstalledSymbols(dir);
    assert.ok(syms.has('defineTool'));
    assert.ok(syms.has('ToolDefinition'));
  } finally { g.cleanup(); }
});

test('定位不到时返回 null，不猜（阴性对照）', () => {
  const g = globalLayout();
  try {
    const env = { DSH_ROOT: g.dshDir, DSH_HOME: join(g.base, 'nohome') };
    assert.equal(resolveInstalledPackage('@deepseek-ai/nonexistent-pkg', env), null);
  } finally { g.cleanup(); }
});
