/**
 * v2-scan v0.3.0 新增判据的单测（嵌套代码根 / 身份顺序 / 键前缀放开 / 间接取服务 / 浏览器半排除）。
 *
 * 夹具事实（全部自建在 test/fixtures/v2-scan-v03/，不动既有 v2-home —— 既有测试在用）：
 *   nested/plugins/agint-mono/agint-inner/lib/  顶层无 lib，只有嵌套真身
 *   order/plugins/agint-dup/                    顶层 lib(真身) + 嵌套同名 agint-dup/lib(抢身份的)
 *   fillin/plugins/agint-shell/                 扁平空壳（只有 manifest.json）+ 嵌套真身
 *   keys/plugins/agint-keys/lib/                可选链 + 宿主键 + 注释态
 *   indirect/plugins/agint-indirect/lib/        形参直传的薄包装（间接形态正例）
 *   eventbus/plugins/agint-evt/lib/             publishEvent（K133 反例：事件名不得成键）
 *   tricky/plugins/agint-tricky/lib/            形参名不直传的假包装（不得当成包装）
 *   browser/plugins/agint-browser/lib/          client.js（浏览器半，须skip）+ server.js（node 半，须扫）
 *   skipdirs/plugins/agint-skip/                test/docs/fixtures/.点目录 里的 lib 一律不算身份
 *
 * 体例对齐 v2-scan.test.mjs：node:assert/strict + 顶层断言块 + 末尾一行 PASS。
 */
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeRoots, scanPlugins } from '../lib/v2-scan.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures', 'v2-scan-v03');
/** 每个用例一个独立 plugins 根：互不污染，且能一整个目录退化成一个反例。 */
const P = (c) => join(FIX, c, 'plugins');
/** 命中筛选：按服务键取全部命中 / 只取 code 边。 */
const hit = (r, key) => r.hits.filter((h) => h[3] === key);
const codeHits = (r, key) => hit(r, key).filter((h) => h[4] === 'code');
const hasKey = (r, key) => r.hits.some((h) => h[3] === key);

// ── 1. codeRoots：身份口径的纯函数级单测 ───────────────────────────
// 判据拆成能单独验证的纯函数，才能做「故意破坏 ⇒ 变红」的对照：
// 直接对 codeRoots 断言身份(id)与层级(top)，错误发生在哪一层一眼可见。
{
  // 嵌套一层的「子目录/lib」被发现，身份取**内层目录名**，且顶层无 lib 时不产生顶层身份
  const nested = codeRoots(join(P('nested'), 'agint-mono'));
  assert.equal(nested.length, 1, '只有嵌套真身 ⇒ 一个代码根');
  assert.deepEqual(
    { id: nested[0].id, top: nested[0].top },
    { id: 'agint-inner', top: false },
    '嵌套身份=内层目录名，top=false',
  );

  // 同名冲突时**顶层项必须排在前面**：scanPlugins 靠这个顺序让顶层先注册身份。
  // 反例对照：若codeRoots 把嵌套项放前面，scanPlugins 的 top:true 分支就再也轮不到，
  // 顶层真身会被嵌套同名挤掉 ⇒ order 用例的 provided['agint.dup.top'] 会空。
  const dup = codeRoots(join(P('order'), 'agint-dup'));
  assert.equal(dup.length, 2, '顶层 lib + 嵌套同名 lib ⇒ 两个代码根');
  assert.deepEqual(dup.map((u) => ({ id: u.id, top: u.top })), [
    { id: 'agint-dup', top: true },
    { id: 'agint-dup', top: false },
  ], '顶层代码根在前、嵌套同名在后（顺序即身份优先级的来源）');

  // 扁平空壳（顶层无 lib）也归嵌套一套逻辑，不因顶层缺 lib 而整个漏掉
  const shell = codeRoots(join(P('fillin'), 'agint-shell'));
  assert.deepEqual(shell.map((u) => ({ id: u.id, top: u.top })), [
    { id: 'agint-shell', top: false },
  ], '顶层无 lib ⇒ 只有嵌套身份，且不被跳过');

  // SKIP_DIRS / '.' 开头目录都不是插件身份。反例对照：任一条被漏掉，
  // 下面的 ids 就会多出agint-skipped-* 之类，units 随之膨胀。
  const skip = codeRoots(join(P('skipdirs'), 'agint-skip'));
  assert.deepEqual(
    skip.map((u) => u.id).sort(),
    ['agint-nested-real', 'agint-skip'],
    'test/docs/fixtures/.点开头目录都不产生身份；只有顶层 lib 与真嵌套留下',
  );

  // 不可读目录降级为空数组（不抛）
  assert.deepEqual(codeRoots(join(FIX, 'no-such-dir')), [], '目录不存在 ⇒ 空数组');
}

// ── 2. 嵌套子目录 lib 被扫到 ──────────────────────────────────────
{
  const r = scanPlugins(P('nested'));
  assert.deepEqual(r.familyDirs, ['agint-mono'], 'familyDirs 只记顶层插件目录');
  assert.equal(r.provided['agint.inner.svc'], 'agint-inner', '嵌套真身 provide 归属内层身份');
  assert.deepEqual(r.units, ['agint-inner'], 'units 记内层身份，不记顶层目录名');
  assert.ok(!('agint-mono' in r.provided), '顶层目录名不占身份（它没有 lib）');
  assert.equal(codeHits(r, 'agint.inner.dep').length, 1, '嵌套单元里的取服务被扫到');
  assert.deepEqual(r.errors, [], '嵌套扫描无错误');
}

// ── 3. 身份注册顺序：顶层优先，同名只留先到的 ─────────────────────
{
  const r = scanPlugins(P('order'));
  // 顶层真身胜出
  assert.equal(r.provided['agint.dup.top'], 'agint-dup', '顶层真身注册成功');
  assert.ok(!('agint.dup.nested' in r.provided), '嵌套同名没抢走身份（它的文件整个没被扫）');
  assert.ok(!hasKey(r, 'agint.dup.nested'), '嵌套同名的边也不存在');
  assert.equal(codeHits(r, 'agint.dup.top').length, 1, '顶层真身的边在');
  // 同id 只出现一次
  assert.deepEqual(r.units, ['agint-dup'], 'units 里 agint-dup 只出现一次');
  assert.equal(r.units.filter((u) => u === 'agint-dup').length, 1, '同名身份不重复登记');
}
{
  // 反方向：顶层无 lib（只有 manifest.json 的扁平空壳）时，嵌套必须能补位成功。
  // 这正是部署位agint-quality-eval（空壳）与 agint-quality/agint-quality-eval（真身）的形状。
  const r = scanPlugins(P('fillin'));
  assert.deepEqual(r.familyDirs, ['agint-shell'], '空壳目录仍进 familyDirs');
  assert.equal(r.provided['agint.shell.svc'], 'agint-shell', '嵌套补位成功：真身被扫到');
  assert.ok(r.units.includes('agint-shell'), 'units 补上了嵌套身份');
  assert.equal(codeHits(r, 'agint.shell.svc').length, 1, '嵌套真身的边在');
}

// ── 4. 键前缀放开：可选链 + 宿主服务键 ────────────────────────────
{
  const r = scanPlugins(P('keys'));
  assert.equal(codeHits(r, 'agint.optional.svc').length, 1, "ctx?.get?.(…) 可选链写法命中 code");
  assert.equal(hit(r, 'agint.optional.svc').filter((h) => h[4] === 'comment').length, 0,
    '可选链那行不是注释态');

  // 非 agint. 前缀的宿主键：不再是未知键，要照常建code 边
  const agents = codeHits(r, 'agents');
  assert.equal(agents.length, 1, "ctx.get('agents') 建code 边");
  assert.equal(agents[0][3], 'agents', 'key 原样透传，不被加工成 agint.agents');
  assert.ok(!hasKey(r, 'agint.agents'), '没有被加agint. 前缀');
  assert.equal(codeHits(r, 'subagents').length, 1, '另一个宿主键同样建 code 边');

  // 反例对照：若 KEY_RE 退回只认 `agint.`，上面两个宿主键一条都不会有。
  assert.equal(r.hits.filter((h) => h[4] === 'code').length, 3, 'code 边恰好 3 条，无多无少');
  assert.deepEqual(r.errors, []);
}

// ── 5. 间接取服务：形参直传的薄包装 ───────────────────────────────
{
  const r = scanPlugins(P('indirect'));
  // dep 的形参 n 直传到 ctx.get(n) ⇒ 认定为包装 ⇒ dep('agint.indirect.svc') 计 code 边。
  // 反例对照：若包装判据坏掉（本条边消失）或退化成「函数体任意位置有取服务」
  // （publishEvent 用例会多出假边），两边都会红。
  assert.equal(codeHits(r, 'agint.indirect.svc').length, 1, '经薄包装取的键计code 边');
  assert.equal(hit(r, 'agint.indirect.svc')[0][0], 'agint-indirect', '归属正确身份');
}

// ── 6. 反向用例（K133 自证）：非包装函数的事件名不得成为服务键 ──────
{
  const r = scanPlugins(P('eventbus'));
  // publishEvent 的形参没直传，ctx.get 取的是字面量 ⇒ 不是包装。
  // 它的实参是事件名，绝不能被记成服务键。
  assert.ok(!hasKey(r, 'some.event.name'), "publishEvent('some.event.name') 的事件名没被当成服务键");
  assert.ok(!hasKey(r, 'other.event.name'), '同上，多参数形态也不产生边');
  assert.equal(r.hits.filter((h) => h[3].includes('.event.')).length, 0,
    '任何 *.event.* 键都不该出现');
  // 反例对照：若判据退回「函数体任意位置出现取服务调用」，这里会多出 1 条事件名假边。
  assert.equal(r.hits.length, 1, '整个文件只有 publishEvent 内部那次真取服务');
  assert.equal(r.hits[0][3], 'agint.bus.publish', '唯一命中是字面量那个真服务键');
  assert.equal(r.hits[0][4], 'code', '真服务键计 code 边');
}

// ── 7. 形参名不匹配的包装不算包装 ───────────────────────────────
{
  const r = scanPlugins(P('tricky'));
  // dep 形参是 n，但 ctx.get 的实参是**字面量**，形参没直传 ⇒ dep 不是包装。
  assert.ok(!hasKey(r, 'agint.tricky.svc'), '非包装函数经包装名调用不产生边');
  assert.equal(codeHits(r, 'agint.tricky.svc').length, 0, 'agint.tricky.svc 不是 code 边');
  // 字面量那次是真的
  assert.equal(codeHits(r, 'agint.literal.svc').length, 1, '字面量取服务照常计 code 边');
  // 反例对照：若判据只看「函数体里有没有取服务调用」，agint.tricky.svc 会变成 code 边。
  assert.equal(r.hits.length, 1, '只有字面量那一条边');
}
{
  // 上一条的反例强度不够：实参是**字面量**时，包装识别的正则压根不命中，
  // 于是判据「放宽」与「收紧」测不出差别（放宽实现后测试仍绿）。
  // k133 夹具改用**标识符**实参（EVENT_BUS / UPSTREAM_BUS 模块常量），
  // 正则会真的命中，唯一拦住它的是「形参直传」这一条 ⇒ 放宽实现必红。
  const r = scanPlugins(P('k133'));
  assert.deepEqual(r.hits, [], '标识符实参形态下：非包装函数的事件名一条边都不产生');
  assert.ok(!hasKey(r, 'some.event.name'), "emit('some.event.name') 事件名没被当成服务键");
  assert.ok(!hasKey(r, 'some.other.event'), "relay('some.other.event') 事件名没被当成服务键");
  assert.ok(!hasKey(r, 'agint.bus.publish'), '标识符实参不被当作字面量键');
  assert.ok(!hasKey(r, 'agint.bus.upstream'), '同上（箭头函数版）');
  assert.deepEqual(r.errors, [], 'k133 夹具无错误');
}

// ── 8. 浏览器半排除：按 basename精确到文件 ───────────────────────
{
  const r = scanPlugins(P('browser'));
  // client.js 里的 ctx 来自组件 props，取的是宿主 GUI 壳层布局服务 ⇒ 整文件skip。
  assert.ok(!hasKey(r, 'layout'), "client.js 的 ctx.get('layout') 不建边");
  assert.equal(hit(r, 'layout').length, 0, '连comment 边也没有（文件根本没被读）');
  // 反例对照：skip 必须是按 basename 精确到文件；若泛化成「这个插件不扫」，
  // 下面 server.js 的真边也会一起消失。
  assert.equal(codeHits(r, 'agint.browser.svc').length, 1, '同目录的 node 半照常扫');
  assert.equal(r.hits[0][1], 'lib/server.js', 'node 半的 relFile 正常产出');
  assert.deepEqual(r.errors, []);
}

// ── 9. 注释态：kind=comment，不建 code 边 ─────────────────────────
{
  const r = scanPlugins(P('keys'));
  const cmt = hit(r, 'agint.cmt.svc');
  assert.equal(cmt.length, 1, '注释里的取服务被记录');
  assert.equal(cmt[0][4], 'comment', '注释态⇒ kind=comment');
  assert.equal(codeHits(r, 'agint.cmt.svc').length, 0, '注释态不建 code 边（沿用 commentMask 语义）');
}

// ── 10. 错误降级：目录不存在 ────────────────────────────────────
{
  const r = scanPlugins(join(FIX, 'no-such-dir'));
  assert.deepEqual(r.hits, [], '命中为空');
  assert.deepEqual(r.familyDirs, [], 'familyDirs 为空');
  assert.equal(r.errors.length, 1, '恰好一条降级错误');
  assert.equal(r.errors[0].file, join(FIX, 'no-such-dir'), '错误指回不可读目录');
  assert.ok(!('units' in r), '降级路径不返回 units（面板侧 D.scan.units??[] 已容错）');
}

// ── 11. relFile 路径规范（面板证据列直接渲染这个串） ─────────────
{
  // 收集本文件所有夹具的命中，统一校验分隔符：绝不能出现反斜杠。
  const all = ['nested', 'order', 'fillin', 'keys', 'indirect', 'eventbus', 'tricky', 'k133', 'browser', 'skipdirs']
    .flatMap((c) => scanPlugins(P(c)).hits);
  assert.ok(all.length > 0, '夹具确实产出了命中（否则下面的循环是空转）');
  for (const h of all) {
    assert.ok(!h[1].includes('\\'), `relFile 不得含反斜杠：${h[1]}`);
    assert.ok(!h[1].includes('//'), `relFile 不得有双斜杠：${h[1]}`);
    assert.ok(h[1].includes('lib/'), `relFile 必须落在 lib 下：${h[1]}`);
  }

  // 顶层单元：relBase 就是 'lib' ⇒ 恰好以 lib/ 开头（与既有 v2-scan.test.mjs 同约束）
  const top = scanPlugins(P('order')).hits;
  assert.deepEqual(top.map((h) => h[1]), ['lib/index.js'], '顶层单元 relFile = lib/…');
  assert.ok(top.every((h) => h[1].startsWith('lib/')), '顶层单元以 lib/ 开头');

  // 嵌套单元：relFile 带内层目录前缀（agint-inner/lib/index.js），仍以 / 分隔、无反斜杠。
  // 记录实测口径：relFile 相对**插件顶层目录**，故嵌套项含内层目录名，不是裸 lib/…。
  const nested = scanPlugins(P('nested')).hits.map((h) => h[1]);
  assert.deepEqual(nested, ['agint-inner/lib/index.js'], '嵌套单元 relFile 带内层目录前缀');
  assert.ok(!nested[0].includes('\\') && nested[0].includes('lib/'), '嵌套 relFile 分隔符合规');
  // 证据列渲染成`<file>:<line>`，所以必须是相对路径、不能是绝对路径
  assert.ok(!/^[A-Za-z]:/.test(nested[0]) && !nested[0].startsWith('/'), 'relFile 是相对路径');
}

console.log('v2-scan-v03.test.mjs PASS');