/**
 * agint-upstream-watch v0.2 — 语义差异检测单测。
 *
 * 全部离线、纯函数：`package.json` 文本与文件表都是手工构造的。
 *
 * ⛔ 每条判据都配**阴性对照**：证明「该绿的绿了」不够，还要证明「该红的会红」。
 *    上一期（v0.1）的实测事故就是「判据只绿不红」——基准拿错了一份旧副本，
 *    所有比对都"通过"，结论全假。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMeta, lowerBound, diffMeta, extractConstValues, diffConstValues,
  diffDeprecations, collectSemanticDeltas, directImpact, readMetaFromFiles,
} from '../lib/semantics.js';

const meta = (o) => JSON.stringify(o, null, 2);

const files = (entries) => new Map(Object.entries(entries));

// ── 1. lowerBound：各种写法都要取到「最高下限」──
test('lowerBound 解析常见写法', () => {
  assert.equal(lowerBound('>=24.9'), '24.9.0');
  assert.equal(lowerBound('>=24.9.0'), '24.9.0');
  assert.equal(lowerBound('^22.0.0'), '22.0.0');
  assert.equal(lowerBound('~24.21.0'), '24.21.0');
  assert.equal(lowerBound('24'), '24.0.0');
  assert.equal(lowerBound('24.x'), '24.0.0');
  // 多个条件：上界不参与，取下界里最高的
  assert.equal(lowerBound('>=22.0.0 <25'), '22.0.0');
  // ⛔ 阴性对照：纯上界 / 通配 / 空 —— 没有下限就返回 null，不猜 0
  assert.equal(lowerBound('<25'), null);
  assert.equal(lowerBound('*'), null);
  assert.equal(lowerBound(''), null);
  assert.equal(lowerBound(undefined), null);
});

// ── 2. parseMeta：字段缺失按空对象，不炸 ──
test('parseMeta 容错', () => {
  assert.equal(parseMeta(''), null);
  assert.equal(parseMeta('{ bad json'), null);
  const p = parseMeta(meta({ name: 'x', version: '1.0.0' }));
  assert.deepEqual(p.engines, {});
  assert.deepEqual(p.dependencies, {});
  assert.equal(p.type, null);
  // ⛔ 阴性对照：数组不是合法元信息形态
  assert.equal(parseMeta('[1,2,3]') !== null, true); // JSON 数组能解析成对象形态，但字段全空
});

// ── 3. engines 抬高 ──
test('engine-raised：本机满足 ⇒ warn；本机不满足 ⇒ blocker', () => {
  const oldText = meta({ engines: { node: '>=22.0.0' } });
  const newText = meta({ engines: { node: '>=24.9.0' } });

  const ok = diffMeta(oldText, newText, { localEngines: { node: '24.21.0' } });
  assert.equal(ok.status, 'ok');
  const raised = ok.deltas.find((d) => d.kind === 'engine-raised');
  assert.ok(raised, '必须识别为抬高');
  assert.equal(raised.severity, 'warn', '本机满足 ⇒ 不阻断');
  assert.match(raised.note, /满足/);

  const bad = diffMeta(oldText, newText, { localEngines: { node: '22.22.2' } });
  const b = bad.deltas.find((d) => d.kind === 'engine-raised');
  assert.equal(b.severity, 'blocker', '本机不满足 ⇒ 必须判阻断');
  assert.match(b.note, /不满足/);
});

test('engine 无变化时不产 delta（阴性对照）', () => {
  const same = meta({ engines: { node: '>=24.9.0' } });
  const r = diffMeta(same, same, { localEngines: { node: '24.21.0' } });
  assert.equal(r.deltas.length, 0);
});

test('从无约束到有下限，也记 engine-raised', () => {
  const r = diffMeta(meta({}), meta({ engines: { node: '>=24.9' } }), { localEngines: { node: '24.21.0' } });
  const d = r.deltas.find((x) => x.symbol === 'engines.node');
  assert.equal(d.kind, 'engine-raised', '口径统一：无 → 有 就是抬高');
  assert.equal(d.before, '(unset)');
});

// ── 4. 依赖面 ──
test('依赖新增 / 移除 / 范围变化分别归类', () => {
  const r = diffMeta(
    meta({ dependencies: { a: '1.0.0', b: '1.0.0' } }),
    meta({ dependencies: { a: '1.0.0', c: '2.0.0' } }),
  );
  const kinds = r.deltas.map((d) => `${d.kind}:${d.symbol}`).sort();
  assert.deepEqual(kinds, ['dep-added:c', 'dep-removed:b']);
  // 范围变化单独一类
  const r2 = diffMeta(meta({ dependencies: { a: '1.0.0' } }), meta({ dependencies: { a: '1.1.0' } }));
  assert.equal(r2.deltas[0].kind, 'dep-range-changed');
});

test('peerDependencies 与 dependencies 分开记（阴性对照：不能混为一类）', () => {
  const r = diffMeta(meta({ peerDependencies: { cordis: '~4.0.5' } }), meta({ peerDependencies: { cordis: '~4.0.6' } }));
  assert.equal(r.deltas[0].kind, 'peer-dep-range-changed');
});

// ── 5. 模块形态 ──
test('type 变化判 blocker', () => {
  const r = diffMeta(meta({ type: 'commonjs' }), meta({ type: 'module' }));
  const d = r.deltas.find((x) => x.kind === 'module-type-changed');
  assert.equal(d.severity, 'blocker');
});

// ── 6. 常量值变化（API 面看不到的那一类）──
test('const 字面量值变化能被抓到', () => {
  const oldFiles = files({
    'lib/types/index.d.ts': 'export declare const SAFETY_VETO_THRESHOLD = 0.5;\nexport declare const NAME = "a";',
  });
  const newFiles = files({
    'lib/types/index.d.ts': 'export declare const SAFETY_VETO_THRESHOLD = 0.6;\nexport declare const NAME = "a";',
  });
  const d = diffConstValues(oldFiles, newFiles);
  assert.equal(d.length, 1);
  assert.equal(d[0].symbol, 'SAFETY_VETO_THRESHOLD');
  assert.equal(d[0].before, '0.5');
  assert.equal(d[0].after, '0.6');
});

test('表达式不展开（阴性对照：不假装能算）', () => {
  const m = extractConstValues(files({
    'lib/types/index.d.ts': 'export declare const X = 1 << 3;',
  }));
  assert.equal(m.size, 0, '非字面量不进表 —— 展开就等于自己实现解释器');
});

test('字符串/布尔/数组字面量都收', () => {
  const m = extractConstValues(files({
    'lib/types/index.d.ts': [
      "export declare const A = 'x';",
      'export declare const B = true;',
      "export declare const C = ['a', 'b'];",
    ].join('\n'),
  }));
  assert.equal(m.size, 3);
});

// ── 7. @deprecated 新增 ──
test('新增 @deprecated 记为提示，不是破坏', () => {
  const oldFiles = files({ 'lib/types/index.d.ts': 'export declare function f(): void;' });
  const newFiles = files({
    'lib/types/index.d.ts': '/**\n * @deprecated use g instead\n */\nexport declare function f(): void;',
  });
  const d = diffDeprecations(oldFiles, newFiles);
  assert.equal(d.length, 1);
  assert.equal(d[0].kind, 'deprecated-added');
  assert.equal(d[0].severity, 'info', '本版还能用 ⇒ 不能报成破坏');
  assert.match(d[0].after, /use g instead/);
});

test('已存在的 @deprecated 不重复报（阴性对照）', () => {
  const t = '/**\n * @deprecated old\n */\nexport declare function f(): void;';
  assert.equal(diffDeprecations(files({ 'lib/types/index.d.ts': t }), files({ 'lib/types/index.d.ts': t })).length, 0);
});

// ── 8. 整包联动噪声过滤 ──
test('依赖范围恰好等于本包 from→to 时不报（整包联动噪声）', () => {
  const oldFiles = files({
    'package.json': meta({ dependencies: { '@deepseek-ai/dsh-brand': '0.2.1-rc.3' } }),
  });
  const newFiles = files({
    'package.json': meta({ dependencies: { '@deepseek-ai/dsh-brand': '0.2.2-alpha.2' } }),
  });
  const r = collectSemanticDeltas({
    oldFiles, newFiles, selfFrom: '0.2.1-rc.3', selfTo: '0.2.2-alpha.2',
  });
  assert.equal(r.deltas.length, 0, 'monorepo 整包抬版本不该产出语义差异');

  // ⛔ 阴性对照：同样的变化，若不属于本次跃迁（第三方包），必须报
  const r2 = collectSemanticDeltas({
    oldFiles, newFiles, selfFrom: '0.2.1-rc.3', selfTo: '0.3.0',
  });
  assert.ok(r2.deltas.length > 0, '不匹配 self 的依赖变化要照报');
});

// ── 9. 缺元信息 ⇒ unknown，不装 compatible ──
test('元信息缺失时状态是 unknown 且说出原因', () => {
  const r = collectSemanticDeltas({
    oldFiles: files({ 'lib/types/index.d.ts': 'export declare function f(): void;' }),
    newFiles: files({ 'lib/types/index.d.ts': 'export declare function f(): void;' }),
  });
  assert.equal(r.status, 'unknown');
  assert.match(r.reason, /package\.json/);
  assert.equal(r.deltas.length, 0);
});

test('任一端接口面为空 ⇒ unknown（阴性对照：不是 none）', () => {
  const r = collectSemanticDeltas({ oldFiles: new Map(), newFiles: files({ 'package.json': '{}' }) });
  assert.equal(r.status, 'unknown');
});

// ── 10. directImpact：哪些语义变化与「用没用到」无关 ──
test('directImpact 只收「必然阻断」的那两条', () => {
  const deltas = [
    { kind: 'engine-raised', severity: 'blocker' }, { kind: 'dep-added', severity: 'warn' },
    { kind: 'module-type-changed', severity: 'blocker' }, { kind: 'const-value-changed', severity: 'warn' },
  ];
  const got = directImpact(deltas).map((d) => d.kind);
  assert.deepEqual(got, ['engine-raised', 'module-type-changed']);
  assert.deepEqual(directImpact([]), []);
  assert.deepEqual(directImpact(undefined), []);
});

test('engine-raised 在本机满足（severity=warn）时不算阻断（阴性对照）', () => {
  // 2026-10-28 实测踩到：只按 kind 判会把「本机完全能满足的引擎抬高」标成 blocking。
  const warnOnly = [{ kind: 'engine-raised', severity: 'warn' }];
  assert.equal(directImpact(warnOnly).length, 0);
  // 同一条变化，本机不满足时才是 blocker
  const blocked = [{ kind: 'engine-raised', severity: 'blocker' }];
  assert.equal(directImpact(blocked).length, 1);
});

// ── 11. readMetaFromFiles 取最浅的那个 ──
test('多个 package.json 时取层级最浅的（monorepo 子包不误取）', () => {
  const f = files({
    'package/package.json': meta({ name: 'root' }),
    'package/packages/x/package.json': meta({ name: 'nested' }),
  });
  assert.match(readMetaFromFiles(f), /"root"/);
  assert.equal(readMetaFromFiles(new Map()), null);
});
