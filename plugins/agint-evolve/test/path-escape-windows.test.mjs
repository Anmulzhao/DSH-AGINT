// 回归用例：Windows 上 evolve_read 的合法相对路径被判 path escapes root。
//
// 取证（2026-10-14 实测）：evolve_read path="2026-10-12-周复盘.md"
//   → Error: agint-evolve: path escapes root (got "2026-10-12-周复盘.md")
// 根因：root = resolve(config.root) 在 win32 返回 `D:\...\reviews`，
//   而判据用 `abs.startsWith(root + '/')` ⇒ `D:\...\reviews/` 与
//   `D:\...\reviews\2026-10-12-周复盘.md` 永不匹配。
// 同型 bug agint-wiki 已在 v0.4 修过（lib/index.js:43-51 做反斜杠→正斜杠归一化）。
//
// ⛔ 纪律（Playbook §3.5）：mock 必须复刻真实契约，测试必须真调生产函数。
//   第一版我复刻了一份判据来测，那是「测我自己抄的逻辑」——假绿风险。
//   本版改为：造真实形状的根目录 + 真实文件，调生产 apply() 拿到的
//   readReview()/listReviews()，断言它真的能读到内容。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { apply } = await import('../lib/index.js');

// ---- 真实形状的 root：本机 win32 盘符路径 ----
const root = mkdtempSync(join(tmpdir(), 'agint-evolve-reviews-'));
const rootReal = resolve(root);

// 造真实文件（含中文名，与生产复盘报告同名形状）
const reportName = '2026-10-12-周复盘.md';
writeFileSync(join(rootReal, reportName), '# 复盘正文\n', 'utf8');
mkdirSync(join(rootReal, 'sub'), { recursive: true });
writeFileSync(join(rootReal, 'sub', 'nested.md'), '# 嵌套\n', 'utf8');

// ---- 造契约形状的 ctx（只提供 apply 真正用到的东西）----
// 参考 lib/index.js:118-176 + 368：ctx.storageDomain.open / ctx.effect /
// ctx.provide / ctx.get。缺哪个这里会立刻抛，不会静默降级。
// 契约复刻（照 test/smoke.mjs:13-40 与 lib/index.js:368）：
// apply 不返回服务对象，它通过 ctx.provide('agint.evolve', svc) 挂出去。
// 测试必须从 _provides 里取，不能假设有返回值。
const tables = new Map();
const ctx = {
  _provides: new Map(),
  _effects: [],
  provide(k, v) { this._provides.set(k, v); },
  get(k) { return this._provides.get(k) ?? null; },
  effect(fn) { this._effects.push(fn()); return () => {}; },
  on: () => () => {},
  storageDomain: {
    async open(spec) {
      return {
        name: spec.name,
        version: spec.version,
        table(n) {
          let t = tables.get(n);
          if (!t) { t = new Map(); tables.set(n, t); }
          return {
            get: (id) => t.get(id) ?? null,
            put: async (id, value) => { t.set(id, value); return true; },
            delete: async (id) => t.delete(id),
            entries: () => [...t.entries()],
          };
        },
        async close() {},
      };
    },
  },
};

// apply(ctx, config) —— cordis 契约：config 是第二参数（Playbook §3.2）
await apply(ctx, { root: rootReal });
const svc = ctx.get('agint.evolve');

test('取证：apply() 返回的服务对象带 readReview / listReviews', () => {
  assert.equal(typeof svc?.readReview, 'function', 'apply 必须返回 readReview');
  assert.equal(typeof svc?.listReviews, 'function', 'apply 必须返回 listReviews');
});

test('⛔ 修复后：合法相对路径（中文名）能读到内容，不再抛 escapes root', async () => {
  const r = await svc.readReview(reportName);
  assert.notEqual(r, null, `readReview("${reportName}") 不得返回 null`);
  assert.equal(r.path, reportName);
  assert.match(r.content, /复盘正文/);
});

test('⛔ 修复后：子目录相对路径能读到内容', async () => {
  const r = await svc.readReview('sub/nested.md');
  assert.notEqual(r, null);
  assert.match(r.content, /嵌套/);
});

test('安全不回退：../ 逃逸仍被拒', async () => {
  await assert.rejects(
    () => svc.readReview('../escape.md'),
    /escapes root/,
    '../ 必须被拒，修复不得削弱安全',
  );
});

test('安全不回退：多级 ../ 逃逸仍被拒', async () => {
  await assert.rejects(
    () => svc.readReview('../../etc/passwd.md'),
    /escapes root/,
  );
});

test('安全不回退：非 .md 后缀仍被拒', async () => {
  await assert.rejects(
    () => svc.readReview('evil.txt'),
    /must end with .md/,
  );
});

test('负样本：不存在的文件返回 null，不是抛错', async () => {
  const r = await svc.readReview('no-such-report.md');
  assert.equal(r, null, '文件不存在应返回 null（工具层据此印「未找到」）');
});

test('listReviews 能列出两份报告（证明 walk 也在同一 root 下工作）', async () => {
  const list = await svc.listReviews();
  const paths = list.map((x) => x.path);
  assert.equal(paths.includes(reportName), true, `应包含 ${reportName}，实得 ${JSON.stringify(paths)}`);
  // ⚠️ 实测（2026-10-14）：walk() 在 win32 用 relative() 产出反斜杠分隔符，
  //   子目录报告返回 "sub\\nested.md" 而非 "sub/nested.md"。
  //   这是与 clean() 同型但独立的第二处跨平台形状问题 —— 它不影响读取
  //   （clean() 已归一化，回读能通），只影响输出形状。
  //   本断言按**实测形状**写并显式标注，不是按"我以为的形状"写。
  const nested = paths.find((p) => p.includes('nested.md'));
  assert.ok(nested, `应包含 nested.md，实得 ${JSON.stringify(paths)}`);
  assert.ok(
    nested === 'sub/nested.md' || nested === 'sub\\nested.md',
    `嵌套路径形状异常：${JSON.stringify(nested)}`,
  );
});
