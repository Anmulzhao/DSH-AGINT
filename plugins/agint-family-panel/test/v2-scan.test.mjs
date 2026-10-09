/**
 * v2-scan 单测：三分类（code/comment/umbrella）、注释状态解析、路径规范、错误降级。
 * 夹具事实（test/fixtures/v2-home/profiles/web/plugins/）：
 *  - agint-alpha: L3 get agint.beta.svc=code；L4 注释 get agint.alpha=comment；
 *    L5 get agint.alpha=code（精确键无子键）；L6 get agint.beta=umbrella（只有子键）；
 *    L7 provide agint.alpha
 *  - agint-beta: index L3 注释 get agint.alpha=comment；extra L2 get agint.alpha=code
 *  - not-family: 非 agint- 前缀，必须不扫
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commentMask, scanPlugins } from '../lib/v2-scan.js';

const here = dirname(fileURLToPath(import.meta.url));
const HOME = join(here, 'fixtures', 'v2-home');
const PLUGINS = join(HOME, 'profiles', 'web', 'plugins');

// commentMask：行注释、字符串里的 // 不算注释、块注释跨行
{
  const a = commentMask("const x = 1; // ctx.get('agint.a')", { block: false, tick: false });
  assert.equal(a.mask[20], true, '// 之后是注释');
  assert.equal(a.mask[10], false, '代码区不是注释');
  const b = commentMask("const s = 'http://x';", { block: false, tick: false });
  assert.equal(b.mask[14], false, '字符串里的 // 不触发注释');
  const c1 = commentMask('/* start', { block: false, tick: false });
  assert.equal(c1.state.block, true, '块注释状态跨行携带');
  const c2 = commentMask('still comment */ code(1)', c1.state);
  assert.equal(c2.mask[5], true);
  assert.equal(c2.mask[20], false);
  assert.equal(c2.state.block, false);
}

// scanPlugins：夹具全量断言
{
  const r = scanPlugins(PLUGINS);
  assert.deepEqual(r.familyDirs, ['agint-alpha', 'agint-beta'], 'non-agint 目录不扫');
  assert.equal(r.provided['agint.alpha'], 'agint-alpha');
  assert.equal(r.provided['agint.beta.svc'], 'agint-beta');
  assert.ok(!('agint.beta' in r.provided), '裸键未被 provide');
  const at = (pl, key) => r.hits.filter((h) => h[0] === pl && h[3] === key);
  assert.equal(at('agint-alpha', 'agint.beta.svc').filter((h) => h[4] === 'code').length, 1);
  assert.equal(at('agint-alpha', 'agint.beta').filter((h) => h[4] === 'umbrella').length, 1);
  assert.equal(at('agint-alpha', 'agint.alpha').filter((h) => h[4] === 'code').length, 1);
  assert.equal(r.hits.filter((h) => h[4] === 'comment').length, 2, 'alpha L4 + beta index L3');
  assert.equal(at('agint-beta', 'agint.alpha').filter((h) => h[4] === 'code').length, 1, 'extra.js 多层 glob 命中');
  assert.equal(r.hits.length, 3 + 2 + 1, 'code 3 + comment 2 + umbrella 1');
  for (const h of r.hits) {
    assert.match(h[1], /^lib\//, 'relFile 用 / 分隔且相对插件根');
    assert.ok(!h[1].includes('\\'));
  }
  assert.deepEqual(r.errors, []);
}

// 目录不存在 → 降级不抛
{
  const r = scanPlugins(join(HOME, 'nope'));
  assert.deepEqual(r.hits, []);
  assert.equal(r.errors.length, 1);
}

// 基线回归（仓库位扫描，容差 ±2；漂移超限 → 人工对账后重新冻结基线）
//
// 2026-10-09 改判据：守卫只数**agint.* 家族键**，宿主键不再计入。
//
// 为什么：宿主键（profileContext / commands / agents …）由 dsh 宿主提供，
// 它们的增减反映的是**宿主演进 + 各插件顺手接了一下**，与本仓插件之间的
// 依赖结构无关。混进守卫会让基线对「插件重构」这件事失去敏感度——
// 2026-10-05 冻结后 46 次提交里，真正新增的 9 条 code 边中有 6 条是宿主键。
//
// 判据用**前缀**而非 HOST_KEYS 清单，沿用 q3-verdicts.test.mjs 已确立的口径
// （见该文件 L80-81：「只按 HOST_KEYS 清单排除会随宿主加键而失真，
// 所以这里直接用前缀判家族键，HOST_KEYS 留作双保险」）。
// 家族键的前缀是本仓自己定的（ctx.provide 只发布 agint.*），
// 不会因宿主加键而失真；HOST_KEYS 清单已三处重复，再加第四处不如用前缀。
//
// 宿主键计数仍记进基线文件（hostCounts），作为**信息**留档而不参与断言：
// 它是有用的观察量，但没有「漂移即异常」的含义。
{
  const base = JSON.parse(readFileSync(join(here, 'fixtures', 'v2-scan-baseline.json'), 'utf8'));
  const r = scanPlugins(join(here, '..', '..'));
  const c = { code: 0, comment: 0, umbrella: 0 };
  for (const h of r.hits) c[h[4]] += 1;
  const isFamily = (svc) => svc.startsWith('agint.');
  const fam = { code: 0, comment: 0, umbrella: 0 };
  const host = { code: 0, comment: 0, umbrella: 0 };
  for (const h of r.hits) (isFamily(h[3]) ? fam : host)[h[4]] += 1;

  for (const k of ['code', 'comment', 'umbrella'])
    assert.ok(
      Math.abs(fam[k] - base.counts[k]) <= 2,
      `${k} 家族键计数漂移超容差：${fam[k]} vs 基线 ${base.counts[k]}，重新对账冻结`,
    );
  // 宿主键只报不拦：漂了要在提示里看得见，但不因此判红。
  for (const k of ['code', 'comment'])
    assert.ok(
      Math.abs(host[k] - (base.hostCounts?.[k] ?? host[k])) <= 40,
      `宿主键 ${k} 变化异常（${host[k]} vs 基线 ${base.hostCounts?.[k]}）：守卫口径可能跑偏`,
    );
  assert.ok(Math.abs(Object.keys(r.provided).length - base.providedKeys) <= 2, 'provided 漂移超容差');
  assert.ok(r.familyDirs.length >= base.familyDirs, '家族目录只增不减（新插件不应让基线变小）');
}

console.log('v2-scan.test.mjs PASS');
