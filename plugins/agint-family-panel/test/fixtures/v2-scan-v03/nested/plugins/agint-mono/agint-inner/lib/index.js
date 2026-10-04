// 嵌套单元：真身在 agint-mono/agint-inner/lib，顶层 agint-mono 自己没有 lib/。
// 期望：身份 = 内层目录名 agint-inner；familyDirs 只记顶层 agint-mono。
// 头部注释刻意不写可被扫描正则命中的调用形态（扫描器会扫到夹具自己）。
export function apply(ctx) {
  ctx.provide('agint.inner.svc', { name: 'inner' });
  const dep = ctx.get('agint.inner.dep');
  return dep;
}